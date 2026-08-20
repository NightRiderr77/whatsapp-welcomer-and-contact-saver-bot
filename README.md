# PXN Owner Bot

A small WhatsApp bot for the **owner's own number**. It does three things and
nothing else:

1. **Saves new customers to your contacts** as `Cus 1`, `Cus 2`, … so a name
   shows up instead of a bare number.
2. **Sends the group invite once**, on someone's first ever message.
3. **Chases a customer you haven't replied to** after N minutes.

It is not the AI agent and shares nothing with it: no model, no prompt, no
Supabase, no database. Two files, two dependencies, and a password-protected
panel for changing its mind.

---

## Setup

```bash
npm install
mkdir -p state && cp settings.example.json state/settings.json   # then edit it
node owner-bot.js
```

Scan the QR printed in the terminal with the **owner's phone**
(WhatsApp → Linked Devices → Link a Device). To link with an 8-digit code
instead, start it with `PAIR_NUMBER=947XXXXXXXX` and use *"Link with phone
number instead"*.

### Running it for real

Docker:

```bash
mkdir -p state && cp settings.example.json state/settings.json
cp .env.example .env && nano .env         # set DASH_PASSWORD
docker compose up -d --build
docker compose logs -f                    # scan the QR here
```

The panel is then on `http://<your-vps>:8091`.

PM2:

```bash
pm2 start ecosystem.config.js && pm2 save
```

---

## Configuration

Everything lives in **`state/settings.json`**, which is re-read on every message —
**a change applies immediately, no restart.** Edit it from the dashboard, or by
hand with `nano`; they are the same file and neither one wins.

| Key | What it does |
|---|---|
| `enabled` | Master switch. `false` and the bot does nothing at all. |
| `autoSaveContacts` | Save new customers as `Cus <N>`. |
| `contactNextNumber` | The next number to use. The bot increments it itself. |
| `invite.enabled` | Send the group invite on a first message. |
| `invite.message` | What to send. **No message means nothing is sent**, whatever `enabled` says. |
| `noReply.enabled` | Chase customers you haven't answered. |
| `noReply.minutes` | How long to wait first. |
| `noReply.firstContactOnly` | **Default `true`.** Only ever chase someone the bot watched arrive as a brand-new customer. Set `false` and it will chase any unanswered chat. |
| `noReply.message` | What to send them. |

The file lives at **`state/settings.json`** and is git-ignored: it holds your
live group link and your customer counter, and belongs on the machine that runs
the bot. The bot writes `contactNextNumber` back to it as it saves people, so
the counter survives restarts.

Nothing is ever sent to a conversation that existed before the bot started.
WhatsApp replays unread messages when a client links, and treating that replay
as new traffic is how an earlier build sent "sorry for the wait" into a few
hundred old chats at once.

> **Check `noReply.message` before you go live.** If it points customers at
> another WhatsApp number, make sure that number is still answered. The old
> build's default sent people to the AI agent, which has been decommissioned.

### Environment

| Variable | Default | Use |
|---|---|---|
| `PAIR_NUMBER` | — | Owner's number, to link with a code instead of a QR. |
| `PUPPETEER_EXECUTABLE_PATH` | Puppeteer's own | Path to Chromium, when it isn't bundled. |
| `WWEBJS_PATH` | `./.wwebjs_auth` | Where the WhatsApp session is kept. |
| `STATE_DIR` | `./state` | Where "already greeted / already saved" is kept. |
| `SETTINGS_FILE` | `<STATE_DIR>/settings.json` | Config location. |
| `DASH_PASSWORD` | — | **Required for the dashboard.** No password, no panel. |
| `DASH_PORT` | `8091` | Panel port. |
| `DASH_HOST` | `0.0.0.0` | Bind address. `127.0.0.1` to require an SSH tunnel. |

---


## Moving to another VPS

Three things cannot be rebuilt and must travel: the **WhatsApp login** (or you
scan a QR again), **settings.json** (including the customer counter — lose it
and the next customer is `Cus 1`), and the **greeted / saved lists** (lose them
and every existing customer is invited to the group a second time).

`backup.sh` packs all three plus your `.env`. `restore.sh` puts them back.

### On the old machine

```bash
cd ~/pxn-owner-bot && ./backup.sh
```

It stops the bot first, on purpose: Chromium writes to the profile constantly
and copying it live can capture a half-written session that restores as a
logged-out one. It starts the bot again when it's done. Use `./backup.sh --live`
only if you accept that risk.

You get `pxn-owner-bot-backup-<date>.tar.gz`. Send it over:

```bash
scp pxn-owner-bot-backup-*.tar.gz ubuntu@<new-vps>:~/
```

> That file is a **live WhatsApp login and your dashboard password**. Treat it
> like a password — move it, restore it, delete it. Never commit it; `*.tar.gz`
> is git-ignored for that reason.

### On the new machine

Docker and the compose plugin first, if it's a bare box:

```bash
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker
```

Get the code:

```bash
git clone https://github.com/NightRiderr77/pxn-owner-bot.git ~/pxn-owner-bot
```

Restore and start:

```bash
cd ~/pxn-owner-bot && mv ~/pxn-owner-bot-backup-*.tar.gz . && ./restore.sh pxn-owner-bot-backup-*.tar.gz
```

```bash
docker compose up -d --build && docker compose logs -f
```

You want `cleared a stale Chromium lock` (the profile remembers the old
machine — that is expected and handled) then `ready.` — **and no QR**. A QR
means the session didn't come across.

### Then

```bash
shred -u pxn-owner-bot-backup-*.tar.gz
```

And stop the old one, so two bots aren't on the same number:

```bash
cd ~/pxn-owner-bot && docker compose down     # on the OLD machine
```

Check the dashboard at `http://<new-vps>:8091` shows your real **Next no.**, not 1.

### Requirements for the new box

| | |
|---|---|
| RAM | **2 GB or more.** Chromium running WhatsApp Web wants roughly a gigabyte to itself. Do not put a `memory` limit on the container — the renderer gets killed, the page reloads, and WhatsApp eventually unlinks the device. |
| Disk | ~2 GB for the image, Chromium and the profile. |
| Ports | `8091` for the dashboard, if you want to reach it. |

### If the repo is private

`git clone` will ask for a username and password. GitHub stopped accepting
account passwords — the "password" is a **personal access token**, created at
*Settings → Developer settings → Personal access tokens → Fine-grained*, with
**Contents: Read-only** on this repository.

Type it at the prompt. Do not put it in this file, in a script, or in a clone
URL: anything committed here is in the git history permanently, and a repo is
the one place a credential must never live. If you want cloning to need no
token at all, make the repository public — there are no secrets in it (the
group link, the counter and the password live in `settings.json` and `.env`,
both git-ignored).

---

## The dashboard

`http://<your-vps>:8091`. It shows, in this order:

1. **Whether the settings file is actually being read.** A red banner with the
   path and the reason when it isn't. This is first because the alternative is
   what happened in production: the bot ran on defaults for a day, saved every
   customer as "Cus 1", and nothing anywhere said so.
2. **Next number, saved, greeted, waiting** — a counter stuck at 1 is now
   something you can see rather than something you deduce from your contacts.
3. Every setting, editable.
4. The last 40 things it did.

A **password is required**: with no `DASH_PASSWORD` the panel does not start and
the bot logs why. The old build made auth optional, which on a public port means
off. Sessions are random tokens (not a hash of the password, which never
rotated), expire after 12 hours, and five wrong guesses locks logins for 15
minutes.

To keep it off the internet entirely, publish it on loopback in
`docker-compose.yml` — `"127.0.0.1:8091:8091"` — and reach it through
`ssh -L 8091:127.0.0.1:8091 <your-vps>`.

## What was dropped, and why

- **Everything AI** — the model, the prompt, the escalations, the learned Q&A,
  the Supabase sync. That's the agent, and it isn't this.

Bugs fixed on the way across:

- The "who has already been greeted" list was re-read from disk on **every
  incoming message**, and rewritten whole on every new contact. It's now loaded
  once and kept in memory.
- The pending-reply map never dropped anyone it had already chased, so it grew
  for the life of the process. Chased chats are now forgotten after a day.
- `settings.json` was bind-mounted as a single *file*. Docker creates a
  directory when the source is missing, every read failed, and the failure was
  swallowed. Config moved into the `state/` directory mount, and an unreadable
  settings file is now fatal at startup instead of silent.
- Unread history replayed at link time was treated as new traffic, so old
  answered chats got chased. Anything older than the process start is ignored.
- A `memory` cap on the container unlinked the phone. Chromium's renderer is
  killed by the cgroup long before Node feels anything, the WhatsApp tab
  reloads, whatsapp-web.js re-injects on every navigation and re-emits
  `authenticated`, and after enough of that WhatsApp drops the device with
  `disconnected: LOGOUT`. It reads as a login fault and is a RAM one. The cap
  is gone; repeated reloads now say so in the log.
- Chromium stamps `<hostname>-<pid>` into a `SingletonLock` in the profile and
  refuses to open a profile it thinks another Chromium holds. A container's
  hostname is a new random id on every rebuild, so every rebuild inherited a
  lock naming a machine that no longer existed — `Failed to launch the browser
  process: Code: 21`, forever, behind a restart policy. The hostname is now
  pinned in `docker-compose.yml`, and a lock is cleared at startup when it is
  provably dead (different machine, or same machine with a dead pid). A lock
  whose owner is still running is left alone.
