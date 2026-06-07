#!/usr/bin/env bash
# Lenskart IdP — device-context agent installer for Linux
# Tries systemd user service first (most distros), then XDG autostart as fallback.
# No sudo required.
#
# Usage:
#   chmod +x scripts/install-device-agent-linux.sh
#   ./scripts/install-device-agent-linux.sh
#
# Verify:
#   curl http://127.0.0.1:17891/device-context

set -euo pipefail

AGENT_SCRIPT="$(cd "$(dirname "$0")" && pwd)/device-context-agent.mjs"
SERVICE_NAME="lenskart-idp-device-agent"

# Locate node
NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE" ]]; then
  for p in /usr/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin/node" "$HOME/.volta/bin/node"; do
    [[ -x "$p" ]] && NODE="$p" && break
  done
fi
if [[ -z "$NODE" ]]; then
  echo "ERROR: node not found. Install Node.js 18+ (e.g. sudo apt install nodejs)" >&2
  exit 1
fi
echo "Using node: $NODE"

if [[ ! -f "$AGENT_SCRIPT" ]]; then
  echo "ERROR: agent script not found at: $AGENT_SCRIPT" >&2
  exit 1
fi
echo "Agent script: $AGENT_SCRIPT"

# ── Option A: systemd user service (preferred) ───────────────────────────────
if command -v systemctl &>/dev/null && systemctl --user daemon-reload &>/dev/null 2>&1; then
  echo ""
  echo "Installing systemd user service..."

  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"

  cat > "$UNIT_DIR/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Lenskart IdP device-context agent
After=network.target

[Service]
Type=simple
ExecStart=${NODE} ${AGENT_SCRIPT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.service"

  sleep 1
  echo ""
  echo "✓ systemd user service enabled: ${SERVICE_NAME}.service"
  echo "  Starts automatically at every user login."
  echo ""
  echo "  Manage with:"
  echo "    systemctl --user status ${SERVICE_NAME}"
  echo "    systemctl --user restart ${SERVICE_NAME}"
  echo "    journalctl --user -u ${SERVICE_NAME} -f"

else
  # ── Option B: XDG autostart (GNOME, KDE, XFCE without systemd --user) ──────
  echo ""
  echo "systemd --user not available; falling back to XDG autostart..."

  XDG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
  mkdir -p "$XDG_DIR"

  cat > "$XDG_DIR/${SERVICE_NAME}.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Lenskart IdP Device Agent
Comment=Serves hostname and local IP to the IdP login page
Exec=${NODE} ${AGENT_SCRIPT}
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=false
DESKTOP

  echo "✓ XDG autostart entry created: $XDG_DIR/${SERVICE_NAME}.desktop"
  echo "  Starts at next graphical login."

  # Start it now in background
  nohup "$NODE" "$AGENT_SCRIPT" &>/tmp/idp-device-agent.log &
  sleep 1
fi

# ── Verify ────────────────────────────────────────────────────────────────────
echo ""
if curl -sf http://127.0.0.1:17891/device-context 2>/dev/null | python3 -m json.tool 2>/dev/null \
   || curl -sf http://127.0.0.1:17891/device-context 2>/dev/null; then
  echo ""
  echo "✓ Agent is running."
else
  echo "Agent not responding yet — wait a few seconds and retry:"
  echo "  curl http://127.0.0.1:17891/device-context"
fi
