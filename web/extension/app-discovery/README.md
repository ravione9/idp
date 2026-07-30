# Lenskart IdP — App Discovery (browser extension)

Browsers **cannot** expose HTTP disk cache to websites or extensions. This extension uses the **History API** (sites visited in this browser) — the closest capable signal for shadow-IT discovery.

## Install (Chrome / Edge)

**From the portal (recommended):** Home or Account → **App Discovery** → **Download extension**, then:

1. Unzip `lilg-app-discovery-extension.zip`.
2. Open `chrome://extensions` (or `edge://extensions`) → enable **Developer mode**.
3. **Load unpacked** → select the extracted folder.
4. Stay signed in to the IdP portal → extension popup → **Scan history (90 days)**.
5. Admin runs **Applications → Discovery → Run Discovery Scan**.

Direct download URL (must be signed in): `/extension/app-discovery.zip`

## Permissions

- `history` — read visited hosts (not HTTP cache bytes)
- `scripting` / `tabs` — post results using your IdP session
- Host access — call your IdP API
