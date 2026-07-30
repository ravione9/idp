/* ============================================================
   Inline SVG icon library — Lucide / Phosphor style.
   Used by admin sidebar, stat cards, page headers.
   24x24 viewBox, 1.6 stroke, currentColor, round caps/joins.
   ============================================================ */

const S = (paths) =>
  `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  // Navigation
  home:        S('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  grid:        S('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  dashboard:   S('<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 12l5-5"/><path d="M3 12h3"/><path d="M12 18v3"/>'),

  // People
  user:        S('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  users:       S('<circle cx="9" cy="9" r="3.5"/><path d="M3 19c1-3 3.5-4.5 6-4.5s5 1.5 6 4.5"/><circle cx="17" cy="8" r="3"/><path d="M19 19c-.4-2-1.6-3.4-3-4.2"/>'),
  userShield:  S('<circle cx="9" cy="8" r="3.5"/><path d="M3 19c.7-2.6 3-4.3 6-4.3"/><path d="M19 11l-3 1v3c0 2 1.4 3.6 3 4 1.6-.4 3-2 3-4v-3l-3-1z"/>'),
  userCog:     S('<circle cx="9" cy="8" r="3.5"/><path d="M3 19c.7-2.6 3-4.3 6-4.3"/><circle cx="18" cy="16" r="2.5"/><path d="M18 11.5v1.5M18 19v1.5M22.5 16H21M15 16h-1.5"/>'),
  identityCard:S('<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="8" cy="12" r="2.5"/><path d="M3.5 17c.6-1.6 2.4-2.5 4.5-2.5s3.9.9 4.5 2.5"/><path d="M14 10h5M14 13h5M14 16h3"/>'),

  // Auth & security
  shield:      S('<path d="M12 3l8 3v6c0 5-3.6 8.4-8 9-4.4-.6-8-4-8-9V6l8-3z"/>'),
  shieldCheck: S('<path d="M12 3l8 3v6c0 5-3.6 8.4-8 9-4.4-.6-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>'),
  key:         S('<circle cx="8" cy="15" r="4"/><path d="M11 13l9-9"/><path d="M16 8l3 3"/><path d="M18 6l2.5 2.5"/>'),
  keyCircle:   S('<circle cx="9" cy="12" r="4"/><path d="M13 12h8"/><path d="M19 10v4"/><path d="M16 11v2"/>'),
  lock:        S('<rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>'),
  fingerprint: S('<path d="M5 11a7 7 0 0 1 13.4-3"/><path d="M19 13a7 7 0 0 1-7 7"/><path d="M9 14a3 3 0 0 1 6 0"/><path d="M12 11v3"/><path d="M8 19c2-1.5 2.5-3.5 2.5-5"/>'),
  adaptive:    S('<path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0z"/><path d="M8 12h8"/><path d="M12 8v8"/><circle cx="12" cy="12" r="2"/>'),

  // Apps
  app:         S('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M3.5 9h17"/><path d="M9 3.5v17"/>'),
  saml:        S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2"/><path d="M14 14h3"/>'),
  oidc:        S('<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>'),
  search:      S('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  catalog:     S('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16"/><path d="M11 9h7M11 13h7M11 17h5"/>'),

  // Connections
  plug:        S('<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v5"/>'),
  refresh:     S('<path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/>'),
  link:        S('<path d="M9.5 14.5a4 4 0 0 1 0-5l3-3a4 4 0 0 1 5.7 5.7l-1.5 1.5"/><path d="M14.5 9.5a4 4 0 0 1 0 5l-3 3a4 4 0 0 1-5.7-5.7l1.5-1.5"/>'),

  // Access
  tag:         S('<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z"/><circle cx="8" cy="8" r="1.5"/>'),
  triangle:    S('<path d="M12 4l9 16H3z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.8" fill="currentColor" stroke="none"/>'),

  // PAM
  server:      S('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="0.8" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="0.8" fill="currentColor" stroke="none"/><path d="M11 7.5h7M11 16.5h7"/>'),
  activity:    S('<path d="M3 12h4l2-7 4 14 2-7h6"/>'),
  vault:       S('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="14" cy="12" r="3.5"/><path d="M14 8.5v1M14 14.5v1M17.5 12h1M9.5 12h1"/>'),

  // Governance
  certificate: S('<rect x="3" y="4" width="14" height="11" rx="1.5"/><path d="M7 9h6M7 12h4"/><circle cx="17" cy="17" r="3.5"/><path d="M14 19l1 4 2-1.5 2 1.5 1-4"/>'),
  split:       S('<path d="M6 3v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4"/><circle cx="6" cy="3" r="1.5"/><circle cx="18" cy="19" r="1.5"/><path d="M6 19l3-3-3-3"/>'),
  alert:       S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5"/><circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none"/>'),

  // Workflow
  flow:        S('<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="9" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M9 6h3a3 3 0 0 1 3 3v3"/><path d="M9 18h3a3 3 0 0 0 3-3"/>'),
  bolt:        S('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  bell:        S('<path d="M6 8a6 6 0 0 1 12 0v4l1.5 3h-15L6 12V8z"/><path d="M10 19a2 2 0 0 0 4 0"/>'),

  // Reports
  list:        S('<path d="M8 5h13M8 12h13M8 19h13"/><circle cx="4" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="19" r="1.2" fill="currentColor" stroke="none"/>'),
  chart:       S('<path d="M3 21h18"/><rect x="6" y="11" width="3" height="8"/><rect x="11" y="6" width="3" height="13"/><rect x="16" y="14" width="3" height="5"/>'),

  // Settings
  cog:         S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  paint:       S('<rect x="3" y="3" width="18" height="14" rx="2"/><circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="11.5" r="1" fill="currentColor" stroke="none"/><path d="M3 17l4 4 4-4"/>'),
  ticket:      S('<path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8z"/><path d="M9 6v12"/>'),
  pulse:       S('<path d="M3 12h4l2-7 4 14 2-7h6"/><circle cx="20" cy="12" r="2"/>'),

  // Common UI
  arrowRight:  S('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  chevronLeft: S('<path d="M15 6l-6 6 6 6"/>'),
  chevronRight:S('<path d="M9 6l6 6-6 6"/>'),
  menu:        S('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  plus:        S('<path d="M12 5v14M5 12h14"/>'),
  close:       S('<path d="M6 6l12 12M18 6L6 18"/>'),
  check:       S('<path d="M5 12.5l4 4 10-10"/>'),
  trash:       S('<path d="M4 7h16"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>'),
  edit:        S('<path d="M4 20h4l11-11-4-4L4 16v4z"/><path d="M14 6l4 4"/>'),
  external:    S('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>'),
  download:    S('<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>'),
  filter:      S('<path d="M3 5h18"/><path d="M6 12h12"/><path d="M10 19h4"/>'),
  star:        S('<path d="M12 3l2.6 5.6 6.4.6-4.8 4.4 1.4 6.4L12 17l-5.6 3 1.4-6.4L3 9.2l6.4-.6z"/>'),
  palette:     S('<circle cx="13.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-2.8-5.2L12 12 7.8 9.8C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>'),
};

export function icon(name) {
  return ICONS[name] || '';
}
