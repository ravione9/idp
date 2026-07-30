/**
 * Runs on the IdP portal. Lets Admin → Discovery trigger a history scan
 * without opening the extension popup.
 */
(function () {
  function relay(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: 'No response from extension' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== 'lilg-idp') return;

    if (data.type === 'LILG_DISCOVERY_PING') {
      window.postMessage({ source: 'lilg-extension', type: 'LILG_DISCOVERY_PONG', version: chrome.runtime.getManifest().version }, '*');
      return;
    }

    if (data.type === 'LILG_DISCOVERY_SCAN') {
      relay({ type: 'RUN_SCAN' }).then((res) => {
        window.postMessage({ source: 'lilg-extension', type: 'LILG_DISCOVERY_SCAN_RESULT', payload: res }, '*');
      });
      return;
    }

    if (data.type === 'LILG_DISCOVERY_PREVIEW') {
      relay({ type: 'PREVIEW_HISTORY' }).then((res) => {
        window.postMessage({ source: 'lilg-extension', type: 'LILG_DISCOVERY_PREVIEW_RESULT', payload: res }, '*');
      });
    }
  });

  // Announce presence so the portal can enable Scan buttons
  window.postMessage({
    source: 'lilg-extension',
    type: 'LILG_DISCOVERY_PONG',
    version: chrome.runtime.getManifest().version,
  }, '*');
})();
