#!/bin/zsh
# Opens an HTTPS tunnel to the local server (iPhone GPS + compass need HTTPS)
# and prints your personal link. Keep this running while you use the phone app.
# The quick-tunnel URL changes every time; see README for a permanent one.
cd "$(dirname "$0")/.." || exit 1
PORT=${PORT:-8000}
KEY=$(grep '^UBIKE_KEY=' .env | cut -d= -f2)
LOG=$(mktemp)
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" > "$LOG" 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null; rm -f $LOG" EXIT
for i in {1..30}; do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [[ -n "$URL" ]] && break
  sleep 1
done
if [[ -z "$URL" ]]; then echo "Tunnel did not start:"; cat "$LOG"; exit 1; fi
echo "\n  Open this on your iPhone (Safari), then Share → Add to Home Screen:\n"
echo "  $URL/app/?key=$KEY\n"
echo "  (Ctrl-C closes the tunnel)"
wait $PID
