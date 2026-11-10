// Nazar, safe access to the extension runtime from a content script.
//
// After the extension reloads or auto-updates, a content script from the old
// version keeps running in already-open tabs, but its chrome.* calls throw
// "Extension context invalidated". Everything here fails quietly instead.
(() => {
  const N = (globalThis.Nazar = globalThis.Nazar || {});

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }

  // Fire-and-forget message to the background worker.
  function send(message) {
    if (!alive()) return;
    try { chrome.runtime.sendMessage(message).catch(() => {}); } catch { /* context gone */ }
  }

  // Message the background worker and wait for its answer; null if the
  // worker is gone or answers nothing.
  async function request(message) {
    if (!alive()) return null;
    try {
      return (await chrome.runtime.sendMessage(message)) ?? null;
    } catch {
      return null;
    }
  }

  async function getSettings() {
    if (!alive()) return {};
    try {
      const { settings = {} } = await chrome.storage.local.get('settings');
      return settings;
    } catch {
      return {};
    }
  }

  N.ext = Object.freeze({ alive, send, request, getSettings });
})();
