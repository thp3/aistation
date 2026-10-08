#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
if [[ -f data/aistation.sqlite ]]; then
 node -e "require('node:sqlite').DatabaseSync;const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/aistation.sqlite');db.exec(\"VACUUM INTO 'backups/backup-$stamp.sqlite'\");db.close()"
fi
if [[ -d .git ]]; then git pull --ff-only; else echo 'No git repository; update source files manually.'; fi
npm ci
npm run build
if command -v systemctl >/dev/null && systemctl list-unit-files aistation.service --no-legend 2>/dev/null | grep -q aistation; then sudo systemctl restart aistation; fi
echo "Updated. Backup: backups/backup-$stamp.sqlite (if present)."
