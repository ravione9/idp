/* Portal colour themes — persisted in localStorage, applied via data-theme on <html>. */

export const THEMES = [
  { id: 'light',    label: 'Light' },
  { id: 'dark',     label: 'Dark' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'ocean',    label: 'Ocean' },
  { id: 'slate',    label: 'Slate' },
  { id: 'sand',     label: 'Sand' },
  { id: 'violet',   label: 'Violet' },
];

const STORAGE_KEY = 'idp_theme';

const META_COLORS = {
  light:    '#0a1628',
  dark:     '#020617',
  midnight: '#030510',
  ocean:    '#134e4a',
  slate:    '#1e293b',
  sand:     '#3d3428',
  violet:   '#2e1065',
};

export function getTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return THEMES.some((t) => t.id === saved) ? saved : 'light';
}

export function setTheme(id) {
  if (!THEMES.some((t) => t.id === id)) return;
  localStorage.setItem(STORAGE_KEY, id);
  applyTheme(id);
}

export function applyTheme(id) {
  const theme = THEMES.some((t) => t.id === id) ? id : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = META_COLORS[theme] || META_COLORS.light;
  document.querySelectorAll('[data-theme-option]').forEach((el) => {
    el.classList.toggle('active', el.dataset.themeOption === theme);
    el.setAttribute('aria-checked', el.dataset.themeOption === theme ? 'true' : 'false');
  });
}

export function initTheme() {
  applyTheme(getTheme());
}

export function themeOptionsHtml() {
  const current = getTheme();
  return THEMES.map((t) => `
    <button type="button" class="theme-option${t.id === current ? ' active' : ''}"
      data-theme-option="${t.id}" title="${t.label}" aria-label="${t.label} theme"
      aria-checked="${t.id === current}">
      <span class="theme-swatch" aria-hidden="true"></span>
      <span class="theme-label">${t.label}</span>
    </button>`).join('');
}

export function wireThemePicker(root = document) {
  root.querySelectorAll('[data-theme-option]').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeOption));
  });
}

export function mountThemeMenu(root) {
  const trigger = root.querySelector('#theme-picker-btn');
  const menu = root.querySelector('#theme-picker-menu');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    const wrap = trigger.closest('.theme-picker');
    if (wrap && !wrap.contains(e.target)) menu.classList.remove('open');
  });
  wireThemePicker(menu);
}
