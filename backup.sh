#!/usr/bin/env bash
#
# Pack everything this bot cannot be rebuilt from into one file.
#
# That is three things: the WhatsApp login, which is the only reason a move
# doesn't mean scanning a QR again; the settings, including the customer
# counter; and the record of who has already been greeted and saved, without
# which every existing customer is invited to the group a second time.
#
#   ./backup.sh              stop the bot, pack, start it again
#   ./backup.sh --live       pack without stopping (see the warning below)
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

STAMP="$(date +%Y-%m-%d-%H%M)"
OUT="welcomer-bot-backup-${STAMP}.tar.gz"
LIVE=0
if [ "${1:-}" = "--live" ]; then LIVE=1; fi

# Asked of compose rather than by container name: a rename of the service
# must not quietly turn 'is it running?' into a permanent no.
running() { [ -n "$(docker compose ps -q 2>/dev/null)" ]; }

# Chromium writes to the profile continuously. Copying it while the browser is
# running can capture a half-written session that restores as a logged-out one,
# and the failure only shows up on the new machine — which is the worst place
# to find out. So the default is to stop first.
STOPPED=0
if running; then
  if [ "$LIVE" -eq 1 ]; then
    echo "! packing while the bot runs — the session may restore as logged out"
  else
    echo "==> stopping the bot so the WhatsApp session is copied intact"
    docker compose stop
    STOPPED=1
  fi
fi

# .env only exists on a Docker install; state/ only after a first run.
PARTS=()
for p in .wwebjs_auth state .env; do
  [ -e "$p" ] && PARTS+=("$p")
done

if [ ${#PARTS[@]} -eq 0 ]; then
  echo "Nothing to back up — no session, settings or .env in $(pwd)." >&2
  exit 1
fi

echo "==> packing: ${PARTS[*]}"
# sudo: the container runs as root, so state/ and the profile are root-owned.
$SUDO tar czf "$OUT" "${PARTS[@]}"
$SUDO chown "$(id -u):$(id -g)" "$OUT"

if [ "$STOPPED" -eq 1 ]; then
  echo "==> starting the bot again"
  docker compose start
fi

echo
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "This file contains a live WhatsApp login and your dashboard password."
echo "Treat it like a password: move it, restore it, then delete it."
echo
echo "Copy it to the new machine with:"
echo "  scp $OUT <user>@<new-vps>:~/"
