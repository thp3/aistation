#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null || ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)"; then echo 'Node.js 24+ required. Install it before running.' >&2; exit 1; fi
if [[ ! -f .env ]]; then
  cp .env.example .env
  node -e "const fs=require('fs'),crypto=require('crypto');let s=fs.readFileSync('.env','utf8');for(const k of ['SESSION_SECRET','DATA_ENCRYPTION_KEY'])s=s.replace(new RegExp('^'+k+'=.*$','m'),k+'='+crypto.randomBytes(48).toString('hex'));fs.writeFileSync('.env',s);"
  chmod 600 .env
  echo 'IMPORTANT: Edit .env and change ADMIN_PASSWORD to a strong unique password.'
fi
mkdir -p data;chmod 700 data
npm ci
npm run build
if [[ "${EUID:-$(id -u)}" -eq 0 ]] && command -v systemctl >/dev/null; then
  SERVICE_USER="${SUDO_USER:-root}"
  APP_DIR="$(pwd)"
  cat >/etc/systemd/system/aistation.service <<EOF
[Unit]
Description=Private AI Station
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$(command -v node) $APP_DIR/server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR/data
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
 systemctl daemon-reload
 systemctl enable aistation
 if grep -q 'replace-with-a-long-random-password' .env; then echo 'Edit .env first; start using: sudo systemctl start aistation'; else systemctl restart aistation; fi
else echo 'Run: npm start (or use sudo bash scripts/install.sh to install systemd service)'; fi
