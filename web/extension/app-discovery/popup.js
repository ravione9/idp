const idpEl = document.getElementById('idp');
const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scan');
const previewBtn = document.getElementById('preview');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

chrome.storage.sync.get({ idpBaseUrl: 'https://idp.lenskart.com' }, (cfg) => {
  idpEl.value = cfg.idpBaseUrl || 'https://idp.lenskart.com';
});

idpEl.addEventListener('change', () => {
  const v = idpEl.value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ idpBaseUrl: v || 'https://idp.lenskart.com' });
});

scanBtn.addEventListener('click', () => {
  const v = idpEl.value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ idpBaseUrl: v || 'https://idp.lenskart.com' }, () => {
    scanBtn.disabled = true;
    previewBtn.disabled = true;
    setStatus('Scanning history and reporting to IdP…');
    chrome.runtime.sendMessage({ type: 'RUN_SCAN' }, (res) => {
      scanBtn.disabled = false;
      previewBtn.disabled = false;
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'err');
        return;
      }
      const r = res?.result || {};
      if (r.ok) {
        setStatus(
          `OK — scanned ${res.domains || 0} domains.\nAccepted: ${r.accepted ?? 0}, skipped: ${r.skipped ?? 0}.\nRun “Discovery Scan” in Admin → Applications → Discovery to refresh inventory.`,
          'ok',
        );
      } else {
        setStatus(r.error || 'Scan failed', 'err');
      }
    });
  });
});

previewBtn.addEventListener('click', () => {
  previewBtn.disabled = true;
  setStatus('Reading history…');
  chrome.runtime.sendMessage({ type: 'PREVIEW_HISTORY' }, (res) => {
    previewBtn.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, 'err');
      return;
    }
    const domains = res?.domains || [];
    const top = domains.slice(0, 15).map((d) => `${d.domain} (${d.hitCount})`).join('\n');
    setStatus(`Found ${domains.length} domains (top 15):\n${top || '(none)'}`, 'ok');
  });
});
