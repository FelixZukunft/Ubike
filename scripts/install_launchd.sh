#!/bin/zsh
# Install the background service on macOS: runs `ubike serve` at login and restarts it if it stops.
# Stop/remove:  launchctl bootout gui/$(id -u)/com.ubike.server && rm ~/Library/LaunchAgents/com.ubike.server.plist
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=~/Library/LaunchAgents/com.ubike.server.plist
sed "s|__ROOT__|$ROOT|g" "$ROOT/scripts/launchd/com.ubike.server.plist" > "$DEST"
launchctl bootout gui/$(id -u)/com.ubike.server 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$DEST"
echo "Installed. Phone app: http://localhost:8000/app/  (key: UBIKE_KEY in .env)"
