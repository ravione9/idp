const idpEl = document.getElementById('idp');
const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scan');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function formatScanResult(res) {
  const r = res?.result || {};
  if (!r.ok) return { text: r.error || 'Scan failed', kind: 'err' };
  const created = r.inventoryCreated ?? 0;
  const updated = r.inventoryUpdated ?? 0;
  const matched = r.catalogMatched ?? 0;
  const lines = [
    `Found ${res.domains || 0} domains in this browser.`,
    `Uploaded ${r.accepted ?? 0} (noise skipped: ${r.skipped ?? 0}).`,
    `Discovery inventory: ${created} new · ${updated} updated.`,
  ];
  if (matched) lines.push(`${matched} already sanctioned in catalog.`);
  if (!(created + updated) && (res.domains || 0) > 0) {
    lines.push('Nothing new for shadow-IT — history matched sanctioned apps or noise filters.');
  }
  if (r.empty) lines.push(r.error || 'No history/tabs found.');
  lines.push('Open Applications → Discovery to review.');
  return { text: lines.join('\n'), kind: 'ok' };
}

chrome.storage.sync.get({ idpBaseUrl: 'https://idp.lenskart.com' }, (cfg) => {
  idpEl.value = cfg.idpBaseUrl || 'https://idp.lenskart.com';
});

idpEl.addEventListener('change', () => {
  const v = idpEl.value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ idpBaseUrl: v || 'https://idp.lenskart.com' });
});

// Auto-preview when popup opens (replaces separate Preview button)
chrome.runtime.sendMessage({ type: 'PREVIEW_HISTORY' }, (res) => {
  if (chrome.runtime.lastError) {
    setStatus(chrome.runtime.lastError.message, 'err');
    return;
  }
  const domains = res?.domains || [];
  if (!domains.length) {
    setStatus(
      'No domains found yet in Chrome history/tabs.\nVisit a few SaaS sites, stay signed in to the IdP, then click Scan & sync.',
      'err',
    );
    return;
  }
  const top = domains.slice(0, 12).map((d) => `• ${d.domain} (${d.hitCount})`).join('\n');
  setStatus(`Ready — ${domains.length} domains detected:\n${top}\n\nClick Scan & sync to upload.`, 'ok');
});

scanBtn.addEventListener('click', () => {
  const v = idpEl.value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ idpBaseUrl: v || 'https://idp.lenskart.com' }, () => {
    scanBtn.disabled = true;
    setStatus('Scanning and uploading to IdP…');
    chrome.runtime.sendMessage({ type: 'RUN_SCAN' }, (res) => {
      scanBtn.disabled = false;
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'err');
        return;
      }
      const formatted = formatScanResult(res);
      setStatus(formatted.text, formatted.kind);
    });
  });
});
