/**
 * Shared app icon upload field for SAML / OIDC admin forms.
 */
import { api } from './api-admin.js';
import { esc } from './ui.js';

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * @param {object} opts
 * @param {string} opts.prefix — DOM id prefix (e.g. csp, sp, e)
 * @param {string} [opts.iconUrl]
 * @param {boolean} [opts.hasUpload]
 */
export function appIconFieldHtml(opts) {
  const prefix = opts.prefix;
  const iconUrl = opts.iconUrl || '';
  const preview = iconUrl
    ? `<img id="${prefix}-icon-prev" src="${esc(iconUrl)}" alt="" style="width:40px;height:40px;border-radius:8px;object-fit:cover;border:1px solid var(--border)">`
    : `<div id="${prefix}-icon-prev" style="width:40px;height:40px;border-radius:8px;background:var(--surface-2,#f1f5f9);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:var(--muted)">—</div>`;

  return `
    <div class="form-group span2">
      <label class="form-label">App icon <span class="muted" style="font-weight:400">(optional)</span></label>
      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem">
        ${preview}
        <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">
          Upload image
          <input type="file" id="${prefix}-icon-file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" style="display:none">
        </label>
        <button type="button" class="btn btn-secondary btn-sm" id="${prefix}-icon-clear" ${iconUrl ? '' : 'disabled'}>Remove</button>
        <span class="muted" id="${prefix}-icon-status" style="font-size:0.78rem"></span>
      </div>
      <input class="form-input" id="${prefix}-icon" value="${esc(iconUrl)}" placeholder="https://…/logo.png or leave blank after upload">
      <p class="muted" style="font-size:0.72rem;margin-top:0.25rem">PNG, JPEG, WebP, or GIF · max 400 KB. Shown on the user portal app tile.</p>
      <input type="hidden" id="${prefix}-icon-pending" value="">
    </div>`;
}

/**
 * Bind upload / clear / preview for an icon field.
 * When `resolveTarget` returns identifiers, upload goes to the API immediately.
 * Otherwise the file is kept in `#${prefix}-icon-pending` for post-create upload.
 *
 * @param {ParentNode} root
 * @param {object} opts
 * @param {string} opts.prefix
 * @param {() => ({ samlAppId?: string, oidcClientId?: string, appId?: string, slug?: string } | null)} [opts.resolveTarget]
 * @param {(msg: string) => void} [opts.onError]
 * @param {(msg: string) => void} [opts.onStatus]
 */
export function bindAppIconField(root, opts) {
  const prefix = opts.prefix;
  const fileInput = root.querySelector(`#${prefix}-icon-file`);
  const urlInput = root.querySelector(`#${prefix}-icon`);
  const pendingInput = root.querySelector(`#${prefix}-icon-pending`);
  const clearBtn = root.querySelector(`#${prefix}-icon-clear`);
  const statusEl = root.querySelector(`#${prefix}-icon-status`);
  const prevEl = root.querySelector(`#${prefix}-icon-prev`);

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg || '';
    if (opts.onStatus) opts.onStatus(msg || '');
  };

  const setPreview = (url) => {
    if (!prevEl) return;
    if (url) {
      if (prevEl.tagName === 'IMG') {
        prevEl.src = url;
        prevEl.style.display = '';
      } else {
        const img = document.createElement('img');
        img.id = `${prefix}-icon-prev`;
        img.alt = '';
        img.src = url;
        img.style.cssText = 'width:40px;height:40px;border-radius:8px;object-fit:cover;border:1px solid var(--border)';
        prevEl.replaceWith(img);
      }
    } else if (prevEl.tagName === 'IMG') {
      const ph = document.createElement('div');
      ph.id = `${prefix}-icon-prev`;
      ph.style.cssText = 'width:40px;height:40px;border-radius:8px;background:var(--surface-2,#f1f5f9);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:var(--muted)';
      ph.textContent = '—';
      prevEl.replaceWith(ph);
    }
    if (clearBtn) clearBtn.disabled = !url;
  };

  urlInput?.addEventListener('input', () => {
    if (pendingInput) pendingInput.value = '';
    setStatus('');
    setPreview(urlInput.value.trim());
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 400 * 1024) {
      const msg = 'Icon must be 400 KB or smaller.';
      if (opts.onError) opts.onError(msg);
      else setStatus(msg);
      return;
    }

    try {
      const dataUrl = String(await readFileAsDataUrl(file));
      const target = opts.resolveTarget ? opts.resolveTarget() : null;
      if (target && (target.samlAppId || target.oidcClientId || target.appId || target.slug)) {
        setStatus('Uploading…');
        let r;
        if (target.samlAppId) {
          r = await api.uploadSamlAppIcon(target.samlAppId, {
            imageBase64: dataUrl,
            mimeType: file.type || undefined,
            fileName: file.name,
          });
        } else if (target.oidcClientId) {
          r = await api.uploadOidcClientIcon(target.oidcClientId, {
            imageBase64: dataUrl,
            mimeType: file.type || undefined,
            fileName: file.name,
          });
        } else {
          r = await api.uploadAppIcon({
            ...target,
            imageBase64: dataUrl,
            mimeType: file.type || undefined,
            fileName: file.name,
          });
        }
        if (urlInput) urlInput.value = r.icon_url || '';
        if (pendingInput) pendingInput.value = '';
        setPreview(r.icon_url || '');
        setStatus('Uploaded');
      } else {
        if (pendingInput) pendingInput.value = dataUrl;
        if (urlInput) urlInput.value = '';
        setPreview(dataUrl);
        setStatus('Will upload when you save');
      }
    } catch (err) {
      setStatus('');
      const msg = err?.message || 'Upload failed';
      if (opts.onError) opts.onError(msg);
      else setStatus(msg);
    }
  });

  clearBtn?.addEventListener('click', async () => {
    const target = opts.resolveTarget ? opts.resolveTarget() : null;
    try {
      if (target?.samlAppId) {
        await api.deleteSamlAppIcon(target.samlAppId);
      } else if (target?.oidcClientId) {
        await api.deleteOidcClientIcon(target.oidcClientId);
      } else if (target?.appId || target?.slug) {
        await api.deleteAppIcon(target);
      }
    } catch {
      /* still clear local fields */
    }
    if (urlInput) urlInput.value = '';
    if (pendingInput) pendingInput.value = '';
    setPreview('');
    setStatus('');
  });
}

/** After create — upload pending data-URL icon if present. */
export async function uploadPendingAppIcon(prefix, root, target) {
  const pending = root?.querySelector?.(`#${prefix}-icon-pending`)?.value
    || (typeof root === 'object' && root?.pending)
    || '';
  if (!pending || !target) return null;
  if (target.samlAppId) {
    return api.uploadSamlAppIcon(target.samlAppId, { imageBase64: pending });
  }
  if (target.oidcClientId) {
    return api.uploadOidcClientIcon(target.oidcClientId, { imageBase64: pending });
  }
  return api.uploadAppIcon({ ...target, imageBase64: pending });
}
