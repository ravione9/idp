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
    setStatus('Scanning history/tabs and uploading to IdP…');
    chrome.runtime.sendMessage({ type: 'RUN_SCAN' }, (res) => {
      scanBtn.disabled = false;
      previewBtn.disabled = false;
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'err');
        return;
      }
      const r = res?.result || {};
      if (r.ok) {
        const created = r.inventoryCreated ?? 0;
        const updated = r.inventoryUpdated ?? 0;
        const matched = r.catalogMatched ?? 0;
        const lines = [
          `Scanned ${res.domains || 0} domains.`,
          `Uploaded: ${r.accepted ?? 0} (skipped noise: ${r.skipped ?? 0}).`,
          `Inventory: ${created} new, ${updated} updated.`,
        ];
        if (matched) {
          lines.push(`${matched} already in your SAML/catalog (not listed as shadow IT).`);
        }
        if (!(created + updated) && (res.domains || 0) > 0) {
          lines.push('No new shadow-IT apps — history matched sanctioned apps only, or was filtered as noise.');
        }
        if (r.empty) lines.push(r.error || 'No history found.');
        lines.push('Open Admin → Applications → Discovery to review.');
        setStatus(lines.join('\n'), 'ok');
      } else {
        setStatus(r.error || 'Scan failed', 'err');
      }
    });
  });
});

previewBtn.addEventListener('click', () => {
  previewBtn.disabled = true;
  setStatus('Reading history + open tabs…');
  chrome.runtime.sendMessage({ type: 'PREVIEW_HISTORY' }, (res) => {
    previewBtn.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, 'err');
      return;
    }
    const domains = res?.domains || [];
    const top = domains.slice(0, 20).map((d) => `${d.domain} (${d.hitCount})`).join('\n');
    setStatus(
      domains.length
        ? `Found ${domains.length} domains (top 20):\n${top}`
        : 'Found 0 domains. Chrome history may be empty — visit SaaS sites, then Preview again.',
      domains.length ? 'ok' : 'err',
    );
  });
});
