//! dsh desktop shell (M1).
//!
//! M1 scope: spawn the Node sidecar (the dsh host, packaged by
//! `scripts/package-sidecar.mjs`) from `native/binaries/`, read its readiness
//! line `dsh web: http://127.0.0.1:<port>`, then navigate the main window to
//! that URL. The shell keeps watching the sidecar after navigation, so a crash
//! (before or after readiness) triggers an exponential-backoff restart; after
//! `MAX_ATTEMPTS` failures the loading page is told to show an error panel.
//! A second instance focuses the existing window instead of starting again.
//! On window close the sidecar is terminated so no orphan host process is left
//! behind.
//!
//! Packaging (scripts/package-sidecar.mjs → native/binaries +
//! bundle.resources → dsh-host/app) is verified locally.
//!
//! See 项目设计文档/dsh桌面版桌面壳设计文档.md 决策一/三/五.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tauri::Emitter;
use tauri::{LogicalSize, Size};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Ready timeout after which we give up waiting for the readiness line.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Max consecutive sidecar start attempts before showing the error page.
const MAX_ATTEMPTS: u32 = 5;
/// Exponential backoff between attempts (seconds), one entry per wait
/// (`MAX_ATTEMPTS - 1`); index `attempt` is guaranteed in range by the caller.
const BACKOFF_SECS: [u64; 4] = [1, 2, 4, 8];
/// Event name sent to the loading page (sidecar lifecycle).
const STATUS_EVENT: &str = "sidecar-status";
/// Window size as a fraction of the monitor's work area when fitting to
/// screen at startup (see `fit_window_to_screen`).
const SCREEN_RATIO: f64 = 0.90;

/// Payload broadcast to the main window describing shell lifecycle state.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarStatus {
    /// "starting" | "retrying" | "ready" | "error"
    status: &'static str,
    attempt: u32,
    max_attempts: u32,
    message: Option<String>,
}

impl SidecarStatus {
    fn starting(attempt: u32) -> Self {
        SidecarStatus { status: "starting", attempt, max_attempts: MAX_ATTEMPTS, message: None }
    }
    fn retrying(attempt: u32, message: String) -> Self {
        SidecarStatus { status: "retrying", attempt, max_attempts: MAX_ATTEMPTS, message: Some(message) }
    }
    fn ready(attempt: u32) -> Self {
        SidecarStatus { status: "ready", attempt, max_attempts: MAX_ATTEMPTS, message: None }
    }
    fn error(attempt: u32, message: String) -> Self {
        SidecarStatus { status: "error", attempt, max_attempts: MAX_ATTEMPTS, message: Some(message) }
    }
}

fn emit_status(app: &tauri::AppHandle, status: SidecarStatus) {
    let _ = app.emit_to("main", STATUS_EVENT, status);
}

/// Parse `dsh web: http://127.0.0.1:<port>` into the local URL.
fn readiness_url(line: &str) -> Option<String> {
    let marker = "http://127.0.0.1:";
    let idx = line.find(marker)?;
    let rest = &line[idx + marker.len()..];
    let port: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if port.is_empty() {
        None
    } else {
        Some(format!("http://127.0.0.1:{port}"))
    }
}

/// Absolute path to the deployed host entry.
///
/// Resolution order:
/// 1. bundled layout: `resource_dir()/dsh-host/app/node_modules/@deepseek-ai/dsh/lib/bin.js`
/// 2. dev fallback: `exe_dir()/../../../resources/app/...` — the staged host bundle
///    under `resources/app`. `pnpm deploy` materializes it (the M1 standalone
///    test verified it runs), whereas tauri-build's copy into `target/` does not
///    preserve pnpm's symlinked node_modules.
fn host_entry_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("dsh-host").join("app"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("..").join("..").join("..").join("resources").join("app"));
        }
    }
    for base in candidates {
        let entry = base
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        if entry.exists() {
            return Some(entry);
        }
    }
    None
}

/// Holds the live sidecar handle and lifecycle flags.
struct ShellState {
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
    /// Bumped by a manual restart; watchers of a superseded chain stand down.
    generation: AtomicU32,
}

/// Terminate the sidecar (if any) and log the outcome.
fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        if let Some(child) = state.child.lock().expect("sidecar state poisoned").take() {
            match child.kill() {
                Ok(()) => eprintln!("deepseek-harness-desktop: sidecar killed"),
                Err(e) => eprintln!("deepseek-harness-desktop: failed to kill sidecar: {e}"),
            }
        }
    }
}

/// True once the main window's close has been requested (no auto-restart).
fn shutting_down(app: &tauri::AppHandle) -> bool {
    app.try_state::<ShellState>()
        .map(|s| s.shutting_down.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// Current sidecar-launch generation; bumped on manual restart so watchers of a
/// superseded attempt chain stand down instead of scheduling their own restart.
fn current_generation(app: &tauri::AppHandle) -> u32 {
    app.try_state::<ShellState>()
        .map(|s| s.generation.load(Ordering::SeqCst))
        .unwrap_or(0)
}

/// Show / focus / unminimize the main window (tray & menu actions).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Fit the main window to the monitor's work area so it adapts to any screen:
/// on large screens it grows to `SCREEN_RATIO` of the work area instead of
/// staying at the 1280×800 default, on small screens it shrinks so nothing is
/// clipped, and it is never smaller than the configured minimum size (800×600,
/// matching `tauri.conf.json`). The window is centered afterwards.
fn fit_window_to_screen(window: &tauri::WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    // `SCREEN_RATIO` of the work area, converted to logical pixels, floored at
    // the minimum size so the UI never becomes unusably small.
    let w = (work.size.width as f64 * SCREEN_RATIO / scale).max(800.0);
    let h = (work.size.height as f64 * SCREEN_RATIO / scale).max(600.0);
    let _ = window.set_size(Size::Logical(LogicalSize::new(w, h)));
    let _ = window.center();
}

/// Toggle main window visibility (tray left-click).
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

/// Quit cleanly: mark shutting down, kill the sidecar, then exit. `app.exit`
/// bypasses the window-close event, so the sidecar must be terminated here.
fn quit_app(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        state.shutting_down.store(true, Ordering::SeqCst);
    }
    kill_sidecar(app);
    app.exit(0);
}

/// Spawn the sidecar (the `attempt`-th try, 0-based), wait for the readiness
/// line, navigate the main window, then keep watching so a crash after
/// navigation can also be recovered. On failure and when the app is not
/// shutting down, restarts with exponential backoff; after `MAX_ATTEMPTS`
/// tries emits an `error` status so the loading page can show the error panel.
fn start_sidecar(app: tauri::AppHandle, attempt: u32) {
    emit_status(&app, SidecarStatus::starting(attempt));
    tauri::async_runtime::spawn(async move {
        // Generation this attempt chain belongs to; a manual restart bumps it
        // so a superseded watcher (whose child was just killed) stands down.
        let gen = current_generation(&app);
        let host_entry = match host_entry_path(&app) {
            Some(p) => p,
            None => {
                eprintln!("deepseek-harness-desktop: cannot resolve resource dir");
                emit_status(&app, SidecarStatus::error(attempt, "无法定位宿主资源目录".into()));
                return;
            }
        };
        let sidecar = match app.shell().sidecar("dsh-host") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("deepseek-harness-desktop: sidecar not found: {e}");
                emit_status(&app, SidecarStatus::error(attempt, format!("sidecar 未找到: {e}")));
                return;
            }
        };
        // `resource_dir()` on Windows can yield `\\?\`-prefixed (extended-length)
        // paths; Node does not resolve those as a main-module path, so strip the
        // prefix before handing the entry to the sidecar.
        let lossy = host_entry.to_string_lossy();
        let host_arg = lossy.strip_prefix(r"\\?\").unwrap_or(&lossy).to_string();
        let spawned = sidecar
            .args([
                host_arg,
                "web".to_string(),
                "--port".to_string(),
                "0".to_string(),
            ])
            .spawn();
        let (mut rx, child) = match spawned {
            Ok(ok) => ok,
            Err(e) => {
                eprintln!("deepseek-harness-desktop: failed to spawn sidecar: {e}");
                emit_status(&app, SidecarStatus::error(attempt, format!("sidecar 启动失败: {e}")));
                return;
            }
        };
        if let Some(state) = app.try_state::<ShellState>() {
            *state.child.lock().expect("sidecar state poisoned") = Some(child);
        }

        let deadline = std::time::Instant::now() + READY_TIMEOUT;
        let mut navigated = false;

        // Watches the sidecar until the ready line arrives (then navigates and
        // keeps watching for a later crash) or until it fails. The loop value
        // is the failure reason; all exits carry one.
        let fail_reason: Option<String> = 'watch: loop {
            // Timeout only applies before the ready line arrives.
            if !navigated && std::time::Instant::now() >= deadline {
                break 'watch Some(format!("就绪超时（{READY_TIMEOUT:?}）"));
            }
            match rx.recv().await {
                Some(CommandEvent::Stdout(bytes)) => {
                    if navigated {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = readiness_url(&line) {
                        if let Some(win) = app.get_webview_window("main") {
                            match url.parse() {
                                Ok(u) => {
                                    let _ = win.navigate(u);
                                    eprintln!("deepseek-harness-desktop: navigated to {url}");
                                }
                                Err(e) => eprintln!("deepseek-harness-desktop: bad URL {url}: {e}"),
                            }
                        }
                        navigated = true;
                        emit_status(&app, SidecarStatus::ready(attempt));
                    }
                }
                Some(CommandEvent::Stderr(bytes)) => {
                    // Surface the host's stderr in the shell log for diagnostics
                    // (this is what reveals startup failures like exit code 1).
                    let line = String::from_utf8_lossy(&bytes);
                    if !line.trim().is_empty() {
                        eprintln!("deepseek-harness-desktop: [sidecar] {}", line.trim());
                    }
                }
                Some(CommandEvent::Terminated(payload)) => {
                    break 'watch Some(format!("sidecar 进程退出: {payload:?}"));
                }
                Some(_) => { /* other events */ }
                None => break 'watch Some("sidecar 事件通道关闭".into()),
            }
        };

        // User-initiated close or a manual restart superseded this chain: stand down.
        if shutting_down(&app) || current_generation(&app) != gen {
            return;
        }
        let reason = fail_reason.unwrap_or_else(|| "未知错误".into());
        if attempt + 1 >= MAX_ATTEMPTS {
            eprintln!("deepseek-harness-desktop: sidecar failed after {MAX_ATTEMPTS} attempts: {reason}");
            emit_status(&app, SidecarStatus::error(attempt, reason.clone()));
            notify_error(&app, &reason);
            return;
        }
        // The old process may still be alive on a timeout path — terminate it.
        kill_sidecar(&app);
        let backoff = BACKOFF_SECS[attempt as usize];
        eprintln!("deepseek-harness-desktop: sidecar restarting in {backoff}s (attempt {})…", attempt + 1);
        emit_status(&app, SidecarStatus::retrying(attempt + 1, reason));
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        if shutting_down(&app) || current_generation(&app) != gen {
            return;
        }
        start_sidecar(app, attempt + 1);
    });
}

/// Manual retry from the loading-page error panel: reset the backoff counter
/// and relaunch the sidecar.
#[tauri::command]
fn restart_sidecar(app: tauri::AppHandle) {
    eprintln!("deepseek-harness-desktop: manual restart requested");
    // Bump the generation first so the killed child's watcher stands down
    // instead of treating the kill as a crash and scheduling its own restart.
    if let Some(state) = app.try_state::<ShellState>() {
        state.generation.fetch_add(1, Ordering::SeqCst);
    }
    kill_sidecar(&app);
    start_sidecar(app, 0);
}

/// System tray icon + menu (M2): 显示/隐藏主窗口 + 退出; left-click toggles
/// window visibility. Built in setup; skipped if no window icon is available.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let tray_menu = Menu::with_items(
        app,
        &[
            &show_item,
            &hide_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;
    let Some(icon) = app.default_window_icon() else {
        eprintln!("deepseek-harness-desktop: no default window icon, tray skipped");
        return Ok(());
    };
    TrayIconBuilder::with_id("main-tray")
        .icon(icon.clone())
        .tooltip("DeepSeek Harness Desktop")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Handle a `dsh://` deep link: focus the main window and log the URL.
/// Forwarding the URL into the SPA for session navigation needs a SPA bridge
/// (the SPA is a registry package, not editable here) — deferred.
fn handle_deep_link(app: &tauri::AppHandle, url: &str) {
    eprintln!("deepseek-harness-desktop: deep link: {url}");
    show_main_window(app);
}

/// Set up the `dsh://` deep-link scheme (M2): register it on Windows, handle a
/// deep link that started this instance, and listen for later activations.
fn setup_deep_link(app: &tauri::App) {
    match app.deep_link().register("dsh") {
        Ok(()) => eprintln!("deepseek-harness-desktop: deep-link scheme 'dsh' registered"),
        Err(e) => eprintln!("deepseek-harness-desktop: deep-link register failed: {e}"),
    }
    // A fresh launch may have been triggered by `dsh://…`; the plugin stored it
    // in `get_current` during its own setup (before our listener existed).
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(url) = urls.first() {
            handle_deep_link(app.handle(), url.as_str());
        }
    }
    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        if let Some(url) = event.urls().first() {
            let url = url.as_str().to_string();
            handle_deep_link(&app_handle, &url);
        }
    });
}

/// Send a native notification (M2). On Windows, toasts only display for a
/// packaged app with a registered AUMID; failures here are logged, not fatal.
fn notify_error(app: &tauri::AppHandle, message: &str) {
    match app
        .notification()
        .builder()
        .title("dsh 启动失败")
        .body(message.to_string())
        .show()
    {
        Ok(()) => eprintln!("deepseek-harness-desktop: notification sent"),
        Err(e) => eprintln!("deepseek-harness-desktop: notification failed: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main_window(app);
            // On Windows a deep link while the app is running launches a second
            // instance; the single-instance plugin forwards its args here.
            if let Some(url) = args.iter().find(|a| a.starts_with("dsh://")) {
                handle_deep_link(app, url);
            }
        }))
        .invoke_handler(tauri::generate_handler![restart_sidecar])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                if let Some(state) = window.app_handle().try_state::<ShellState>() {
                    state.shutting_down.store(true, Ordering::SeqCst);
                }
                kill_sidecar(window.app_handle());
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            app.manage(ShellState {
                child: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
                generation: AtomicU32::new(0),
            });
            build_tray(app)?;
            setup_deep_link(app);
            if let Some(window) = app.get_webview_window("main") {
                fit_window_to_screen(&window);
            }
            start_sidecar(app_handle, 0);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
