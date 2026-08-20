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

## Moving off the old combined repo

The bot was `owner_bot.js` inside the AI agent repo. To move it without asking
the owner to scan a QR again or re-greeting every existing customer:

```bash
# from the old agent folder, onto the new one
mkdir -p                            <new>/state
cp -r .wwebjs_auth_owner            <new>/.wwebjs_auth
cp    owner_settings.json           <new>/state/settings.json
cp    owner_greeted.json            <new>/state/greeted.json
cp    owner_saved_contacts.json     <new>/state/saved-contacts.json
```

The file names changed (they no longer need an `owner_` prefix — the whole repo
is the owner bot), but the contents are the same shape.

Then stop the old one so two bots aren't on the same number:

```bash
docker compose stop pxn-owner       # in the old agent folder
```

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
- Chromium stamps `<hostname>-<pid>` into a `SingletonLock` in the profile and
  refuses to open a profile it thinks another Chromium holds. A container's
  hostname is a new random id on every rebuild, so every rebuild inherited a
  lock naming a machine that no longer existed — `Failed to launch the browser
  process: Code: 21`, forever, behind a restart policy. The hostname is now
  pinned in `docker-compose.yml`, and a lock is cleared at startup when it is
  provably dead (different machine, or same machine with a dead pid). A lock
  whose owner is still running is left alone.
