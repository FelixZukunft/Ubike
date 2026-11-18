#!/bin/zsh
# Copy the app (and, the first time, your data) to the VM and (re)start it.
#   deploy/vm/push.sh ubuntu@<vm-ip>            # Oracle Cloud (user "ubuntu")
#   deploy/vm/push.sh <you>@<vm-ip>             # Google Cloud
# Needs SSH access with your key (ssh-add the key you gave the cloud console).
set -e
HOST=${1:?usage: deploy/vm/push.sh user@host}
cd "$(dirname "$0")/../.."

echo "== upload code + .env (secrets: CWA_API_KEY, UBIKE_KEY)"
rsync -az --delete \
  --exclude .venv --exclude data --exclude deploy/static-build --exclude __pycache__ --exclude '.DS_Store' \
  ./ "$HOST:~/Ubike/"

if ! ssh "$HOST" 'test -f ~/Ubike/data/ubike.duckdb'; then
  echo "== first deploy: copying your local database (places, rides, collected history)"
  if pgrep -f "ubike serve" >/dev/null; then
    echo "   stop the local server first (it locks the database): launchctl bootout gui/\$(id -u)/com.ubike.server"; exit 1
  fi
  ssh "$HOST" 'mkdir -p ~/Ubike/data'
  rsync -az data/ubike.duckdb "$HOST:~/Ubike/data/"
fi

echo "== install / restart"
ssh "$HOST" 'bash ~/Ubike/deploy/vm/setup.sh'
