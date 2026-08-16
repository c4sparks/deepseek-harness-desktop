// dsh desktop shell — loading page lifecycle (M1).
//
// Listens for `sidecar-status` events emitted by the Rust shell and switches
// between the loading spinner and an error panel. On terminal failure the
// error panel offers a manual retry that resets the backoff counter.
//
// `window.__TAURI__` is injected because `app.withGlobalTauri` is enabled in
// native/tauri.conf.json.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const errorMsgEl = document.getElementById('error-msg');
const retryBtn = document.getElementById('retry-btn');

function showLoading() {
  errorEl.hidden = true;
  loadingEl.hidden = false;
}

function showError(message) {
  loadingEl.hidden = true;
  errorMsgEl.textContent = message;
  errorEl.hidden = false;
}

retryBtn.addEventListener('click', () => {
  showLoading();
  invoke('restart_sidecar').catch((err) => {
    showError(`重试请求失败：${err}`);
  });
});

listen('sidecar-status', (event) => {
  const s = event.payload;
  switch (s.status) {
    case 'starting':
    case 'retrying':
      showLoading();
      break;
    case 'ready':
      // The window is about to be navigated to the host — nothing to do.
      break;
    case 'error':
      showError(
        s.message || '宿主启动失败',
      );
      break;
    default:
      break;
  }
}).catch((err) => {
  // Listen failed (e.g. IPC unavailable) — leave the spinner as-is.
  console.error('dsh shell: failed to listen for sidecar-status', err);
});
