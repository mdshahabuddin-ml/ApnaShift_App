#!/usr/bin/env bash
# ApnaShift daily Postgres backup (pg_dump + 7-day rotation).
# Cron me: 0 2 * * * /opt/apnashift/apnashift-backend/deploy/backup.sh >> /var/log/apnashift-backup.log 2>&1
# Password script me NAHI hai — app ki .env se DATABASE_URL padha jata hai.
set -euo pipefail # koi command fail / khaali variable ho to turant ruko (aadha backup nahi)

APP_DIR="/opt/apnashift/apnashift-backend" # git clone wali jagah (apne path se match karo)
BACKUP_DIR="/var/backups/apnashift" # root-owned backup folder (sudo se banta hai)
KEEP_DAYS=7 # isse purani .dump.gz files delete hongi

mkdir -p "$BACKUP_DIR" # folder na ho to banao (cron me har baar safe)

# shellcheck disable=SC1091
set -a # .env ki har line auto-export ho taaki pg_dump DATABASE_URL dekh sake
# shellcheck source=/dev/null
source "$APP_DIR/.env" # secrets yahin se aate hain (file chmod 600 honi chahiye)
set +a

: "${DATABASE_URL:?DATABASE_URL .env me khaali hai — backup ruko}" # URL bina dump bekaar hai

STAMP="$(date +%F_%H-%M)" # file naam me date-time (roz ek nayi file)
OUT="$BACKUP_DIR/apnashift-$STAMP.dump" # pehle plain dump, phir gzip

pg_dump --no-owner --no-privileges -Fc -f "$OUT" "$DATABASE_URL" # custom format dump (restore fast + chhota)
gzip -f "$OUT" # .dump.gz banao (disk bachao, free tier me jagah kam hai)

test -s "$OUT.gz" # khaali backup pakda gaya to fail karo (cron mail/log me dikhega)

find "$BACKUP_DIR" -name 'apnashift-*.dump.gz' -mtime +"$KEEP_DAYS" -delete # 7 din se purani files hatao (disk full na ho)

echo "[backup] ok: $OUT.gz ($(du -h "$OUT.gz" | cut -f1))" # cron log me success line
