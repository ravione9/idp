# Lenskart IdP — App Discovery (browser extension)

Browsers **cannot** expose HTTP disk cache to websites or extensions. This extension uses the **History API** (sites visited in this browser) — the closest capable signal for shadow-IT discovery.

## Install (Chrome / Edge)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this folder (`web/extension/app-discovery`).
4. Sign in to the IdP portal in the same browser.
5. Open the extension popup → set IdP URL if needed → **Scan history (90 days)**.
6. In Admin → **Applications → Discovery** → **Run Discovery Scan**.

## Permissions

- `history` — read visited hosts (not HTTP cache bytes)
- `scripting` / `tabs` — post results using your IdP session
- Host access — call your IdP API
