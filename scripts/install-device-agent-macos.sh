#!/usr/bin/env bash
# Lenskart IdP — device-context agent installer for macOS
# Registers a LaunchAgent so the agent starts automatically at every login.
# No sudo required.
#
# Usage:
#   chmod +x scripts/install-device-agent-macos.sh
#   ./scripts/install-device-agent-macos.sh
#
# Verify:
#   curl http://127.0.0.1:17891/device-context

set -euo pipefail

AGENT_SCRIPT="$(cd "$(dirname "$0")" && pwd)/device-context-agent.mjs"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/com.lenskart.idp-device-agent.plist"
LABEL="com.lenskart.idp-device-agent"

# Locate node
NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE" ]]; then
  # Try common Homebrew / nvm / volta paths
  for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin/node" "$HOME/.volta/bin/node"; do
    [[ -x "$p" ]] && NODE="$p" && break
  done
fi
if [[ -z "$NODE" ]]; then
  echo "ERROR: node not found. Install Node.js 18+ from https://nodejs.org" >&2
  exit 1
fi
echo "Using node: $NODE"

# Validate agent script
if [[ ! -f "$AGENT_SCRIPT" ]]; then
  echo "ERROR: agent script not found at: $AGENT_SCRIPT" >&2
  exit 1
fi
echo "Agent script: $AGENT_SCRIPT"

# Create LaunchAgents dir if needed
mkdir -p "$PLIST_DIR"

# Unload existing agent if running
if launchctl list "$LABEL" &>/dev/null; then
  echo "Stopping existing agent..."
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
fi

# Write plist
cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE}</string>
        <string>${AGENT_SCRIPT}</string>
    </array>

    <!-- Start at login and restart if it crashes -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <!-- Redirect output for debugging: ~/Library/Logs/idp-device-agent.log -->
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/idp-device-agent.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/idp-device-agent.log</string>
</dict>
</plist>
PLIST

# Load agent now
launchctl load "$PLIST_FILE"
sleep 1

echo ""
echo "✓ LaunchAgent registered: $PLIST_FILE"
echo "  Auto-starts at every macOS login."
echo ""

# Verify
if curl -sf http://127.0.0.1:17891/device-context | python3 -m json.tool 2>/dev/null; then
  echo ""
  echo "✓ Agent is running."
else
  echo "Agent not responding yet. Check: ~/Library/Logs/idp-device-agent.log"
fi
