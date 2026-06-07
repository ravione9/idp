#!/usr/bin/env bash
# Lenskart IdP — cross-platform device-context agent installer
# Detects OS and delegates to the right platform script.
#
# Usage:
#   chmod +x scripts/install-device-agent.sh
#   ./scripts/install-device-agent.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)" in
  Darwin)
    exec bash "$DIR/install-device-agent-macos.sh" "$@"
    ;;
  Linux)
    exec bash "$DIR/install-device-agent-linux.sh" "$@"
    ;;
  *)
    echo "On Windows, run the PowerShell installer instead:"
    echo "  powershell -ExecutionPolicy Bypass -File scripts\\install-device-agent.ps1"
    exit 1
    ;;
esac
