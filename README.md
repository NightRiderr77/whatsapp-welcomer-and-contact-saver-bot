# PXN Owner Bot

A small WhatsApp bot for the **owner's own number**. It does three things and
nothing else:

1. **Saves new customers to your contacts** as `Cus 1`, `Cus 2`, … so a name
   shows up instead of a bare number.
2. **Sends the group invite once**, on someone's first ever message.
3. **Chases a customer you haven't replied to** after N minutes.

It is not the AI agent and shares nothing with it: no model, no Supabase, no
database, no dashboard, no HTTP server. One file, two dependencies.

---

## Setup

```bash
npm install
cp settings.example.json settings.json   # then edit it
node owner-bot.js
```

Scan the QR printed in the terminal with the **owner's phone**
(WhatsApp → Linked Devices → Link a Device). To link with an 8-digit code
instead, start it with `PAIR_NUMBER=947XXXXXXXX` and use *"Link with phone
number instead"*.

### Running it for real

Docker:

```bash
cp settings.example.json settings.json    # must exist before the first up
docker compose up -d --build
docker compose logs -f                    # scan the QR here
```

PM2:

```bash
pm2 start ecosystem.config.js && pm2 save
```

---

## Configuration

Everything lives in **`settings.json`**, which is re-read on every message —
**edit it and the change applies immediately, no restart.** That is what
replaces the old dashboard.

| Key | What it does |
|---|---|
| `enabled` | Master switch. `false` and the bot does nothing at all. |
| `autoSaveContacts` | Save new customers as `Cus <N>`. |
| `contactNextNumber` | The next number to use. The bot increments it itself. |
| `invite.enabled` | Send the group invite on a first message. |
| `invite.message` | What to send. **No message means nothing is sent**, whatever `enabled` says. |
| `noReply.enabled` | Chase customers you haven't answered. |
| `noReply.minutes` | How long to wait first. |
| `noReply.message` | What to send them. |

`settings.json` is git-ignored: it holds your live group link and your customer
counter, and belongs on the machine that runs the bot.

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
| `SETTINGS_FILE` | `./settings.json` | Config location. |

---

## Moving off the old combined repo

The bot was `owner_bot.js` inside the AI agent repo. To move it without asking
the owner to scan a QR again or re-greeting every existing customer:

```bash
# from the old agent folder, onto the new one
cp -r .wwebjs_auth_owner            <new>/.wwebjs_auth
cp    owner_settings.json           <new>/settings.json
mkdir -p                            <new>/state
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

## What was dropped, and why

- **The dashboard** (`:8091`) — an unauthenticated-by-default HTTP server
  exposed on the VPS just to toggle three booleans. `settings.json` does the
  same job with nothing listening on a port.
- **Everything AI** — the model, the prompt, the escalations, the learned Q&A,
  the Supabase sync. That's the agent, and it isn't this.

Two real bugs were fixed on the way across:

- The "who has already been greeted" list was re-read from disk on **every
  incoming message**, and rewritten whole on every new contact. It's now loaded
  once and kept in memory.
- The pending-reply map never dropped anyone it had already chased, so it grew
  for the life of the process. Chased chats are now forgotten after a day.
