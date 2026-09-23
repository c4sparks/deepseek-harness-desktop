//! dsh desktop shell (M1 + 侧车模式).
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
//! Two modes share the same sidecar lifecycle, selected by the persisted
//! setting `$DSH_HOME/desktop-settings.json` (`trayMode`) and switchable live
//! from the tray menu: the default window mode embeds the dsh UI in the
//! WebView; tray mode keeps the window hidden and the tray icon/menu open the
//! original dsh in the default browser (`http://127.0.0.1:<port>`), with an
//! optional 打开桌面窗口 action that navigates the embedded window on demand.
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
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
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

/// Parse `dsh web: http://127.0.0.1:<port>?token=<launchToken>` into the local URL.
///
/// 必须保留完整的 URL（含 `?token=` 认证参数）：dsh 0.1.2-alpha.1 起用浏览器认证——客户端
/// 打开带 launch token 的根 URL 才会被签发 session cookie；缺 token 会收到 401
/// 「authentication required; reopen the URL printed by dsh web」。
fn readiness_url(line: &str) -> Option<String> {
    let marker = "http://127.0.0.1:";
    let idx = line.find(marker)?;
    let url = line[idx..].trim();
    if url.starts_with("http://127.0.0.1:") {
        Some(url.to_string())
    } else {
        None
    }
}

/// Absolute path to the deployed host bundle root (`.../dsh-host/app`), if present.
///
/// Resolution order:
/// 1. bundled layout: `resource_dir()/dsh-host/app`
/// 2. dev fallback: `exe_dir()/../../../resources/app` — the staged host bundle
///    under `resources/app`. `pnpm deploy` materializes it (the M1 standalone
///    test verified it runs), whereas tauri-build's copy into `target/` does not
///    preserve pnpm's symlinked node_modules.
fn host_app_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("dsh-host").join("app"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("..").join("..").join("..").join("resources").join("app"));
        }
    }
    candidates.into_iter().find(|base| host_entry_in(base).exists())
}

/// Host entry (`@deepseek-ai/dsh/lib/bin.js`) inside a deployed bundle root.
fn host_entry_in(app_dir: &std::path::Path) -> std::path::PathBuf {
    app_dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

/// Absolute path to the deployed host entry (see `host_app_dir`).
fn host_entry_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    host_app_dir(app).map(|dir| host_entry_in(&dir))
}

/// Holds the live sidecar handle and lifecycle flags.
struct ShellState {
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
    /// Bumped by a manual restart; watchers of a superseded chain stand down.
    generation: AtomicU32,
    /// The ready dsh URL (`http://127.0.0.1:<port>`), set once the sidecar
    /// reports its readiness line; tray browser-open actions read it.
    url: Mutex<Option<String>>,
    /// Tray-only (sidecar) mode: the main window stays hidden and tray actions
    /// open the original dsh web UI in the default browser instead of the
    /// embedded window. Controlled by the persisted setting
    /// (`$DSH_HOME/desktop-settings.json`, `trayMode`) and switchable at
    /// runtime from the tray menu. The sidecar and the rest of the lifecycle
    /// are shared between the two modes.
    tray_mode: AtomicBool,
    /// The dsh profile the shell boots (persisted `profile` setting). Read at
    /// sidecar spawn; switching it persists + restarts the sidecar.
    profile: Mutex<String>,
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

/// Persisted shell settings (launch behavior), stored as
/// `$DSH_HOME/desktop-settings.json` next to dsh's own data so the desktop
/// shell and the dsh CLI share one home (设计文档 §6.7「启动行为写入 DSH_HOME」).
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    /// Sidecar/tray mode: window hidden, tray opens dsh in the browser.
    #[serde(default)]
    tray_mode: bool,
    /// The dsh profile the shell boots (`$DSH_HOME/profiles/<profile>`).
    /// `web` is dsh's official profile (the `dsh web` alias); the shell's own
    /// desktop profile is [`DESKTOP_PROFILE`]. The bare name `desktop` is
    /// reserved by upstream's Electron app and must never reach the sidecar
    /// (see [`normalize_profile`]). Runtime-switchable via the tray menu.
    #[serde(default = "default_profile")]
    profile: String,
}

fn default_profile() -> String {
    WEB_PROFILE.into()
}

/// 上游官方 web profile（`dsh web` 别名）。
const WEB_PROFILE: &str = "web";

/// 壳自定义的桌面 profile（`$DSH_HOME/profiles/desktop-local`）。
///
/// **不能叫 `desktop`**：dsh 0.1.5 起该名字由上游官方 Electron 应用独占——
/// `apps/cli/src/args.ts` 的 `rejectElectronProfile` 对 `--profile desktop`
/// 直接报错退出（`profile "desktop" is managed exclusively by the Electron
/// application`），壳若传它，sidecar 立即 exit 1、桌面壳卡在错误页。
/// 上游该 profile 的目录也是 `$DSH_HOME/profiles/desktop`，改名可避免与其互相覆盖。
const DESKTOP_PROFILE: &str = "desktop-local";

/// 上游保留给官方 Electron 应用的 profile 名（大小写不敏感），壳不可启动。
const UPSTREAM_RESERVED_PROFILE: &str = "desktop";

/// 归一化 settings 里的 profile：残留的旧值 `desktop`（0.1.5 之前壳用的名字）
/// 回退到 [`DESKTOP_PROFILE`]，避免 sidecar 启动即失败导致桌面壳打不开。
fn normalize_profile(profile: String) -> String {
    if profile.eq_ignore_ascii_case(UPSTREAM_RESERVED_PROFILE) {
        eprintln!(
            "deepseek-harness-desktop: profile \"{profile}\" 已被上游保留，回退到 \"{DESKTOP_PROFILE}\""
        );
        DESKTOP_PROFILE.into()
    } else {
        profile
    }
}

impl Default for DesktopSettings {
    fn default() -> Self {
        DesktopSettings { tray_mode: false, profile: default_profile() }
    }
}

/// Settings file name inside DSH_HOME.
const SETTINGS_FILENAME: &str = "desktop-settings.json";

/// Resolve DSH_HOME: the `DSH_HOME` env var, else `~/.dsh`.
fn dsh_home(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(home) = std::env::var("DSH_HOME") {
        if !home.is_empty() {
            return Some(std::path::PathBuf::from(home));
        }
    }
    app.path().home_dir().ok().map(|home| home.join(".dsh"))
}

/// Absolute path of the settings file, if DSH_HOME resolves.
fn settings_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    dsh_home(app).map(|home| home.join(SETTINGS_FILENAME))
}

/// Load persisted settings; a missing/corrupt file falls back to defaults.
fn load_settings(app: &tauri::AppHandle) -> DesktopSettings {
    let Some(path) = settings_path(app) else { return DesktopSettings::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<DesktopSettings>(&text) {
            Ok(mut settings) => {
                settings.profile = normalize_profile(settings.profile);
                settings
            }
            Err(e) => {
                eprintln!("deepseek-harness-desktop: settings parse failed ({path:?}): {e}");
                DesktopSettings::default()
            }
        },
        Err(_) => DesktopSettings::default(),
    }
}

/// Persist settings (best-effort; creates DSH_HOME when missing).
fn save_settings(app: &tauri::AppHandle, settings: &DesktopSettings) {
    let (Some(path), Some(home)) = (settings_path(app), dsh_home(app)) else {
        return
    };
    if let Err(e) = std::fs::create_dir_all(&home) {
        eprintln!("deepseek-harness-desktop: failed to create DSH_HOME ({home:?}): {e}");
        return;
    }
    match serde_json::to_string_pretty(settings) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&path, text) {
                eprintln!("deepseek-harness-desktop: failed to write settings ({path:?}): {e}");
            }
        }
        Err(e) => eprintln!("deepseek-harness-desktop: settings serialize failed: {e}"),
    }
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

/// Open a URL in the system default browser (fire-and-forget, detached).
fn open_url_in_browser(url: &str) {
    let spawned = {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(url).spawn()
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open").arg(url).spawn()
        }
    };
    match spawned {
        Ok(_) => eprintln!("deepseek-harness-desktop: opened browser at {url}"),
        Err(e) => eprintln!("deepseek-harness-desktop: failed to open browser at {url}: {e}"),
    }
}

/// The ready dsh URL, if the sidecar has reported it yet.
fn current_dsh_url(app: &tauri::AppHandle) -> Option<String> {
    let state = app.try_state::<ShellState>()?;
    let guard = state.url.lock().ok()?;
    guard.clone()
}

/// Open the live dsh UI (the original dsh web surface) in the default browser.
fn open_dsh_in_browser(app: &tauri::AppHandle) {
    match current_dsh_url(app) {
        Some(url) => open_url_in_browser(&url),
        None => eprintln!("deepseek-harness-desktop: dsh 尚未就绪，无法打开浏览器"),
    }
}

/// Show the embedded window and navigate it to the live dsh URL (tray mode's
/// "打开桌面窗口"); before readiness it falls back to the loading page.
fn show_dsh_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(url) = current_dsh_url(app) {
            match url.parse() {
                Ok(u) => {
                    let _ = window.navigate(u);
                    eprintln!("deepseek-harness-desktop: navigated to {url}");
                }
                Err(e) => eprintln!("deepseek-harness-desktop: bad URL {url}: {e}"),
            }
        }
        show_main_window(app);
    }
}

/// 把 `~/.dsh/bin` 前置到 PATH（给 sidecar 进程用）。
/// fetch-claude 下载的 claude 在这里，dsh-subagent-claude-code 从 PATH 解析——
/// 这样普通用户无需配置系统 PATH，claude 也能被找到。
fn sidecar_path_prefixed(app: &tauri::AppHandle) -> String {
    let dsh_bin = dsh_home(app)
        .map(|h| h.join("bin"))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let cur = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    if dsh_bin.is_empty() { return cur }
    if cur.is_empty() { return dsh_bin }
    format!("{dsh_bin}{sep}{cur}")
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
        let profile = app
            .try_state::<ShellState>()
            .map(|s| s.profile.lock().expect("sidecar state poisoned").clone())
            .unwrap_or_else(default_profile);
        // `--no-open`: dsh-web-app auto-opens the UI in the default browser on
        // ready unless told not to; the shell embeds its own WebView, so the
        // browser must never pop up.
        let spawned = sidecar
            // 把 ~/.dsh/bin 前置到 sidecar 的 PATH：fetch-claude 下载的 claude 在这里，
            // dsh-subagent-claude-code 从 PATH 解析——无需用户配置系统 PATH。
            .env("PATH", sidecar_path_prefixed(&app))
            // CODEX_BIN：dsh-subagent-codex 经 patch 优先用它（fetch-codex 下载的 codex）。
            .env("CODEX_BIN", codex_bin_path(&app))
            .args([
                host_arg,
                "--profile".to_string(),
                profile,
                "--no-open".to_string(),
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
                        if let Some(state) = app.try_state::<ShellState>() {
                            *state.url.lock().expect("sidecar state poisoned") = Some(url.clone());
                        }
                        let tray_mode = app
                            .try_state::<ShellState>()
                            .map(|state| state.tray_mode.load(Ordering::SeqCst))
                            .unwrap_or(false);
                        if tray_mode {
                            // Tray-only mode: no embedded window — the tray
                            // actions open the original dsh in the browser.
                            // If the window is visible (opened via 打开桌面窗口)
                            // while the sidecar restarted, re-navigate it to the
                            // fresh port so it stays live.
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_visible().unwrap_or(false) {
                                    if let Ok(u) = url.parse() {
                                        let _ = win.navigate(u);
                                        eprintln!("deepseek-harness-desktop: navigated to {url}");
                                    }
                                }
                            }
                            eprintln!("deepseek-harness-desktop: tray mode ready at {url}");
                        } else if let Some(win) = app.get_webview_window("main") {
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

/// A tray submenu to switch the dsh profile the shell boots (persisted
/// `profile` setting; selecting one persists it and restarts the sidecar).
fn build_profile_submenu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let web = MenuItem::with_id(app, "profile-web", "Web profile（官方）", true, None::<&str>)?;
    let desktop = MenuItem::with_id(app, "profile-desktop", "Desktop profile（local）", true, None::<&str>)?;
    Submenu::with_items(app, "切换 Profile", true, &[&web, &desktop])
}

/// Build the tray menu for one mode: window mode shows 显示/隐藏主窗口 +
/// 在浏览器中打开 + 切换为侧车模式 + 退出; tray mode shows 打开 dsh（浏览器）/
/// 打开桌面窗口 + 切换为窗口模式 + 退出. Both modes carry the 切换 Profile
/// submenu.
fn build_tray_menu(app: &tauri::AppHandle, tray_mode: bool) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let profile_submenu = build_profile_submenu(app)?;
    if tray_mode {
        let open_dsh = MenuItem::with_id(app, "open-browser", "打开 dsh（浏览器）", true, None::<&str>)?;
        let show_win = MenuItem::with_id(app, "show-window", "打开桌面窗口", true, None::<&str>)?;
        let toggle = MenuItem::with_id(app, "toggle-mode", "切换为窗口模式", true, None::<&str>)?;
        Menu::with_items(
            app,
            &[
                &open_dsh,
                &show_win,
                &toggle,
                &profile_submenu,
                &PredefinedMenuItem::separator(app)?,
                &quit_item,
            ],
        )
    } else {
        let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
        let hide_item = MenuItem::with_id(app, "hide", "隐藏主窗口", true, None::<&str>)?;
        let open_item = MenuItem::with_id(app, "open-browser", "在浏览器中打开", true, None::<&str>)?;
        let toggle = MenuItem::with_id(app, "toggle-mode", "切换为侧车模式", true, None::<&str>)?;
        Menu::with_items(
            app,
            &[
                &show_item,
                &hide_item,
                &PredefinedMenuItem::separator(app)?,
                &open_item,
                &toggle,
                &profile_submenu,
                &PredefinedMenuItem::separator(app)?,
                &quit_item,
            ],
        )
    }
}

/// Apply a mode change live: update state, persist the setting, rebuild the
/// tray menu, and adjust window visibility (window mode navigates to the live
/// dsh URL when available, else shows the loading page).
fn apply_tray_mode(app: &tauri::AppHandle, tray_mode: bool) {
    if let Some(state) = app.try_state::<ShellState>() {
        state.tray_mode.store(tray_mode, Ordering::SeqCst);
    }
    let profile = app
        .try_state::<ShellState>()
        .map(|s| s.profile.lock().expect("sidecar state poisoned").clone())
        .unwrap_or_else(default_profile);
    save_settings(app, &DesktopSettings { tray_mode, profile });
    if let Some(tray) = app.tray_by_id("main-tray") {
        match build_tray_menu(app, tray_mode) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
                let _ = tray.set_tooltip(Some(if tray_mode {
                    "DeepSeek Harness Desktop（侧车模式）"
                } else {
                    "DeepSeek Harness Desktop"
                }));
            }
            Err(e) => eprintln!("deepseek-harness-desktop: failed to rebuild tray menu: {e}"),
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        if tray_mode {
            let _ = window.hide();
        } else {
            show_dsh_window(app);
        }
    }
    eprintln!(
        "deepseek-harness-desktop: tray mode {}",
        if tray_mode { "on" } else { "off" }
    );
}

/// Toggle the sidecar/tray mode and persist it (invoked from the tray menu).
#[tauri::command]
fn set_tray_mode(app: tauri::AppHandle, tray_mode: bool) {
    apply_tray_mode(&app, tray_mode);
}

/// Switch the dsh profile the shell boots, persist it, and restart the sidecar
/// under the new profile (invoked from the tray menu).
#[tauri::command]
fn set_profile(app: tauri::AppHandle, profile: String) {
    eprintln!("deepseek-harness-desktop: switch profile -> {profile}");
    let tray_mode = app
        .try_state::<ShellState>()
        .map(|state| state.tray_mode.load(Ordering::SeqCst))
        .unwrap_or(false);
    if let Some(state) = app.try_state::<ShellState>() {
        *state.profile.lock().expect("sidecar state poisoned") = profile.clone();
    }
    save_settings(&app, &DesktopSettings { tray_mode, profile });
    // Bump the generation so the old child's watcher stands down, then relaunch.
    if let Some(state) = app.try_state::<ShellState>() {
        state.generation.fetch_add(1, Ordering::SeqCst);
    }
    kill_sidecar(&app);
    start_sidecar(app, 0);
}

/// Versions shown in the loading page's bottom-right corner.
///
/// `dsh` comes from the **deployed host bundle** (`@deepseek-ai/dsh/package.json`)
/// rather than the build-time closure — that is the code actually running, and it
/// stays truthful if a user swaps the host bundle. `None` when the bundle is not
/// deployed (broken install), so the page falls back to the shell version alone.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Versions {
    app: String,
    dsh: Option<String>,
}

fn host_dsh_version(app: &tauri::AppHandle) -> Option<String> {
    let pkg = host_app_dir(app)?
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(pkg).ok()?).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// Version info for the loading page (invoked from `src/shell.js`).
#[tauri::command]
fn versions(app: tauri::AppHandle) -> Versions {
    Versions {
        app: app.package_info().version.to_string(),
        dsh: host_dsh_version(&app),
    }
}

/// System tray icon + menu (M2 + 侧车模式): window mode shows 显示/隐藏/退出
/// plus 在浏览器中打开; tray mode (`trayMode` setting) shows
/// 打开 dsh（浏览器）/打开桌面窗口/退出 and left-click opens the original dsh in
/// the default browser. Built in setup; skipped if no window icon is available.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let tray_mode = app
        .try_state::<ShellState>()
        .map(|state| state.tray_mode.load(Ordering::SeqCst))
        .unwrap_or(false);
    let tray_menu = build_tray_menu(app.handle(), tray_mode)?;
    let Some(icon) = app.default_window_icon() else {
        eprintln!("deepseek-harness-desktop: no default window icon, tray skipped");
        return Ok(());
    };
    TrayIconBuilder::with_id("main-tray")
        .icon(icon.clone())
        .tooltip(if tray_mode {
            "DeepSeek Harness Desktop（侧车模式）"
        } else {
            "DeepSeek Harness Desktop"
        })
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "open-browser" => open_dsh_in_browser(app),
            "show-window" => show_dsh_window(app),
            "toggle-mode" => {
                let tray_mode = app
                    .try_state::<ShellState>()
                    .map(|state| state.tray_mode.load(Ordering::SeqCst))
                    .unwrap_or(false);
                apply_tray_mode(app, !tray_mode);
            }
            "profile-web" => set_profile(app.clone(), "web".into()),
            "profile-desktop" => set_profile(app.clone(), DESKTOP_PROFILE.into()),
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
                let handle = tray.app_handle();
                let tray_mode = handle
                    .try_state::<ShellState>()
                    .map(|state| state.tray_mode.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if tray_mode {
                    open_dsh_in_browser(handle);
                } else {
                    toggle_main_window(handle);
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Handle a `dsh://` deep link: in window mode focus the main window; in tray
/// mode open the dsh UI in the browser. Forwarding the URL into the SPA for
/// session navigation needs a SPA bridge (the SPA is a registry package, not
/// editable here) — deferred.
fn handle_deep_link(app: &tauri::AppHandle, url: &str) {
    eprintln!("deepseek-harness-desktop: deep link: {url}");
    let tray_mode = app
        .try_state::<ShellState>()
        .map(|state| state.tray_mode.load(Ordering::SeqCst))
        .unwrap_or(false);
    if tray_mode {
        open_dsh_in_browser(app);
    } else {
        show_main_window(app);
    }
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

/// UTC 时间戳（ISO），用于运行日志。
fn utc_stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86400, secs % 86400);
    let (hh, mi, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y0 = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let (y, m) = if mp < 10 { (y0, mp + 3) } else { (y0 + 1, mp - 9) };
    format!("{y:04}-{m:02}-{d:02} {hh:02}:{mi:02}:{ss:02}")
}

/// 追加一行运行日志到 `~/.dsh/logs/desktop.log`（best-effort，与 fetch 脚本同一文件）。
fn append_shell_log(msg: &str) {
    use std::io::Write;
    let home = std::env::var("DSH_HOME").ok().filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok()))
        .map(std::path::PathBuf::from);
    let Some(home) = home else { return };
    let log = home.join(".dsh").join("logs").join("desktop.log");
    if let Some(dir) = log.parent() { let _ = std::fs::create_dir_all(dir); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(f, "[{}] [INFO] desktop: {msg}", utc_stamp());
    }
}

/// 后台静默按需安装 claude / codex（best-effort，失败不影响主程序）。
/// 安装包内带 `fetch-claude.mjs` / `fetch-codex.mjs`（bundle.resources），启动时用 sidecar 自带
/// node 跑 `--auto`：脚本自探测——已有（claude 在 PATH、codex 在 CODEX_BIN/~/.dsh/bin）就跳过，
/// 没有才下载到 `~/.dsh/bin`。无网络 / 下载失败仅意味着对应子 agent 暂不可用，主程序照常。
fn maybe_fetch_tools(app: &tauri::AppHandle) {
    for script_name in ["fetch-claude.mjs", "fetch-codex.mjs", "fetch-libreoffice.mjs"] {
        let script = match app.path().resource_dir() {
            Ok(d) => d.join(script_name),
            Err(_) => continue,
        };
        if !script.exists() {
            continue; // 旧安装包未带脚本 → 跳过
        }
        append_shell_log(&format!("后台检查 {} 可用性", script_name.strip_suffix(".mjs").unwrap_or(&script_name)));
        let lossy = script.to_string_lossy();
        let script_arg = lossy.strip_prefix(r"\\?\").unwrap_or(&lossy).to_string();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            // sidecar 是重命名的 node.exe：`dsh-host <script> --auto` 即以 node 运行该脚本。
            if let Ok(cmd) = app2.shell().sidecar("dsh-host") {
                let _ = cmd.args([script_arg.as_str(), "--auto"]).spawn();
            }
        });
    }
}

/// 平台 triple（与 fetch-codex 的 vendor/<triple>/ 目录一致）。
fn codex_triple() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => "",
    }
}

/// `~/.dsh/codex/vendor/<triple>/bin/codex(.exe)`，注入 sidecar 的 CODEX_BIN
/// （dsh-subagent-codex 经 patch 优先用它；fetch-codex 复制完整平台包到 ~/.dsh/codex/）。 */
fn codex_bin_path(app: &tauri::AppHandle) -> String {
    let Some(home) = dsh_home(app) else { return String::new() };
    let bin = if cfg!(windows) { "codex.exe" } else { "codex" };
    home.join("codex").join("vendor").join(codex_triple()).join("bin").join(bin).to_string_lossy().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let tray_mode = app
                .try_state::<ShellState>()
                .map(|state| state.tray_mode.load(Ordering::SeqCst))
                .unwrap_or(false);
            if tray_mode {
                open_dsh_in_browser(app);
            } else {
                show_main_window(app);
            }
            // On Windows a deep link while the app is running launches a second
            // instance; the single-instance plugin forwards its args here.
            if let Some(url) = args.iter().find(|a| a.starts_with("dsh://")) {
                handle_deep_link(app, url);
            }
        }))
        .invoke_handler(tauri::generate_handler![restart_sidecar, set_tray_mode, set_profile, versions])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let tray_mode = window
                        .app_handle()
                        .try_state::<ShellState>()
                        .map(|state| state.tray_mode.load(Ordering::SeqCst))
                        .unwrap_or(false);
                    if tray_mode {
                        // Tray mode: closing the (occasionally shown) window
                        // only hides it; the app keeps running from the tray.
                        let _ = window.hide();
                        api.prevent_close();
                        return;
                    }
                    if let Some(state) = window.app_handle().try_state::<ShellState>() {
                        state.shutting_down.store(true, Ordering::SeqCst);
                    }
                    kill_sidecar(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            // Tray-only (sidecar) mode is a persisted setting
            // (`$DSH_HOME/desktop-settings.json`), not a CLI flag: the window
            // stays hidden and the tray opens the original dsh in the default
            // browser. Window mode is the default.
            let settings = load_settings(app.handle());
            let tray_mode = settings.tray_mode;
            app.manage(ShellState {
                child: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
                generation: AtomicU32::new(0),
                url: Mutex::new(None),
                tray_mode: AtomicBool::new(tray_mode),
                profile: Mutex::new(settings.profile.clone()),
            });
            build_tray(app)?;
            setup_deep_link(app);
            if let Some(window) = app.get_webview_window("main") {
                if tray_mode {
                    // Sidecar mode: no embedded window — keep it hidden.
                    let _ = window.hide();
                } else {
                    fit_window_to_screen(&window);
                    let _ = window.show();
                }
            }
            start_sidecar(app_handle, 0);
            maybe_fetch_tools(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
