#!/usr/bin/env bash
#
# Unpack a backup into this folder, on a fresh machine.
#
#   ./restore.sh welcomer-bot-backup-2026-08-20-1243.tar.gz
#   ./restore.sh <file> --force     overwrite what is already here
#
# Afterwards: docker compose up -d --build
#
set -euo pipefail
cd "$(dirname "$0")"
# Branding, drawn without colour codes so it reads the same in a terminal, in
# `docker compose logs`, and in a log file somebody opens six months from now.
banner() {
  cat <<'BANNER'

  +--------------------------------------------------------+
  |   WhatsApp Welcomer & Contact Saver Bot                 |
  |   Built by NightRiderr77                                |
  |   Property of PXN STORES LK  .  https://pxnstores.lk    |
  +--------------------------------------------------------+

BANNER
}
banner

# Root-owned files (the container writes as root) need sudo to read — but a
# minimal image or a root shell may not have sudo at all, and assuming it does
# turns a backup into "sudo: command not found".
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

ARCHIVE="${1:-}"
FORCE=0
if [ "${2:-}" = "--force" ]; then FORCE=1; fi

if [ -z "$ARCHIVE" ]; then
  echo "Usage: ./restore.sh <backup.tar.gz> [--force]" >&2
  exit 1
fi
if [ ! -f "$ARCHIVE" ]; then
  echo "No such file: $ARCHIVE" >&2
  exit 1
fi

# Restoring over a running bot gives two clients one profile, which corrupts
# the session — the one thing a backup exists to protect.
if [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
  echo "==> stopping the running bot first"
  docker compose stop
fi

# An existing session or settings here means this is not the fresh machine the
# operator thinks it is. Say so rather than quietly overwriting a live install.
if [ "$FORCE" -eq 0 ] && { [ -e .wwebjs_auth ] || [ -e state ]; }; then
  echo "There is already a session or settings in $(pwd)." >&2
  echo "Restoring would overwrite them. Re-run with --force if that is what you want:" >&2
  echo "  ./restore.sh $ARCHIVE --force" >&2
  exit 1
fi

echo "==> restoring from $ARCHIVE"
$SUDO tar xzf "$ARCHIVE"

# The stale Chromium lock inside the copied profile names the machine that made
# it, which is now a different machine entirely. The bot clears that itself at
# startup, so nothing to do here — but say so, because the alternative is
# someone seeing "in use by another computer" and assuming the restore failed.
echo
echo "Restored:"
for p in .wwebjs_auth state .env; do
  [ -e "$p" ] && echo "  $p"
done

echo
if [ ! -e .env ]; then
  echo "! No .env in the backup — the dashboard needs one before it will start:"
  echo "    cp .env.example .env && nano .env"
  echo
fi
echo "Now start it:"
echo "    docker compose up -d --build && docker compose logs -f"
echo
echo "Expect 'cleared a stale Chromium lock' then 'ready.' — and no QR."
echo "A QR means the session did not come across; check the backup had .wwebjs_auth in it."
echo
echo "Once it is up, delete the backup — it holds a live WhatsApp login:"
echo "    shred -u $ARCHIVE 2>/dev/null || rm -f $ARCHIVE"
