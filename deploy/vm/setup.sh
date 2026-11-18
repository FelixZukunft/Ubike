#!/usr/bin/env bash
# Runs ON a fresh Ubuntu 22.04/24.04 VM (Oracle Cloud Always Free or Google Cloud e2-micro).
# Called by deploy/vm/push.sh — you normally don't run it by hand.
# Installs Python + Caddy, runs the app as a systemd service on 127.0.0.1:8000 and
# serves it over HTTPS at https://<public-ip-with-dashes>.sslip.io (free Let's Encrypt cert).
set -euo pipefail
APP="$HOME/Ubike"
cd "$APP"

echo "== packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv python3-pip caddy curl >/dev/null

echo "== swap (1 GB VMs need it for pip + DuckDB)"
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== python env"
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -e .

echo "== firewall (Oracle images block 80/443 in iptables by default)"
if sudo iptables -S INPUT 2>/dev/null | grep -q "REJECT"; then
  sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT || true
  sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT || true
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null && sudo netfilter-persistent save >/dev/null || true
fi

echo "== app service"
sudo tee /etc/systemd/system/ubike.service >/dev/null <<EOF
[Unit]
Description=YouBike optimizer (API, phone app, poller)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$APP
Environment=TZ=Asia/Taipei
ExecStart=$APP/.venv/bin/python -m ubike serve --host 127.0.0.1 --port 8000
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now ubike
sudo systemctl restart ubike

echo "== https"
IP=$(curl -s -4 https://ifconfig.me)
DOMAIN="${IP//./-}.sslip.io"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:8000
}
EOF
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy

sleep 8
KEY=$(grep '^UBIKE_KEY=' .env | cut -d= -f2)
echo
echo "  Phone:      https://$DOMAIN/app/?key=$KEY"
echo "  Logs:       journalctl -u ubike -f"
