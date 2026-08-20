'use strict';

/**
 * PXN OWNER BOT
 *
 * A small WhatsApp bot that runs on the owner's own number and does three
 * things, none of which involve answering anybody:
 *
 *   1. Saves a new customer to the phone's address book as "Cus <N>".
 *   2. Sends the group invite once, on their first ever message.
 *   3. Chases a customer you haven't replied to within N minutes.
 *
 * It is deliberately not the AI agent: no model, no prompt, no Supabase.
 *
 * Settings live in state/settings.json and are re-read on every message, so a
 * change applies immediately with no restart. The dashboard (dashboard.js) is
 * a view onto that same file — anything it can do, editing the file by hand
 * can do too.
 *
 *   Start:  node owner-bot.js
 *   Login:  scan the QR printed in the log, or set PAIR_NUMBER=<owner number>
 *           to link with an 8-digit code instead.
 *   Panel:  http://<host>:8091, requires DASH_PASSWORD to be set.
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { startDashboard } = require('./dashboard');

const SESSION_PATH  = process.env.WWEBJS_PATH   || path.join(__dirname, '.wwebjs_auth');
const STATE_DIR     = process.env.STATE_DIR     || path.join(__dirname, 'state');
const QR_FILE       = path.join(__dirname, 'qr.png');
const PAIR_NUMBER   = String(process.env.PAIR_NUMBER || '').replace(/\D/g, '');

const DASH_PORT     = Number(process.env.DASH_PORT || 8091);
const DASH_HOST     = process.env.DASH_HOST || '0.0.0.0';
const DASH_PASSWORD = process.env.DASH_PASSWORD || '';

const log = (...a) => console.log(`[${new Date().toISOString()}] [owner]`, ...a);

/* The last few things the bot did, for the dashboard. A ring buffer, because
   this process is meant to run for months and nobody is reading past the top
   of the list anyway. */
const ACTIVITY_MAX = 40;
const activity = [];
function note(text) {
  activity.unshift({ ts: Date.now(), text });
  if (activity.length > ACTIVITY_MAX) activity.length = ACTIVITY_MAX;
  log(text);
}

/**
 * Anything that arrived before we connected is history, not news.
 *
 * WhatsApp replays unread messages when a client links, so a conversation from
 * this morning — one the owner may already have answered from their phone —
 * arrives as a fresh `message` event. Treating those as new is what once put
 * "sorry for the wait" into a few hundred old chats at once.
 */
const STARTED_AT = Math.floor(Date.now() / 1000);

/**
 * Settings live in the state directory, not next to the code.
 *
 * They used to sit at ./settings.json and be bind-mounted into the container as
 * a single *file*. Docker creates a directory when the mount source doesn't
 * exist yet, so one missing file turned every read into EISDIR, the bot fell
 * back to defaults, and every customer was saved as "Cus 1" with a message
 * nobody wrote. Directories are safe to auto-create; files are not.
 */
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(STATE_DIR, 'settings.json');
const LEGACY_SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ─── Settings ────────────────────────────────────────────────────────────────
//
// The defaults carry no real group link or phone number on purpose: this repo
// should be safe to clone without shipping anyone's live details. Copy
// settings.example.json to settings.json and fill it in.
const DEFAULTS = {
  enabled          : true,
  autoSaveContacts : true,
  contactNextNumber: 1,
  invite: {
    enabled: false,       // stays off until a real invite message is configured
    message: '',
  },
  noReply: {
    enabled: true,
    minutes: 10,
    /* Only chase someone the bot itself watched arrive as a brand-new
       customer. Without this, every existing chat the owner had not answered
       yet is fair game, which is not what "message a new customer" means. */
    firstContactOnly: true,
    message: 'Hi! Sorry for the wait — we have seen your message and will reply as soon as we can.',
  },
};

/**
 * Read the settings file, and be loud when it can't be read.
 *
 * The previous version returned defaults on any error, silently. That is how a
 * broken mount became a live incident instead of a log line: the bot cheerfully
 * ran with `contactNextNumber: 1` and a message nobody had written. A config
 * file that exists but cannot be used is a fault, and it says so — once per
 * minute rather than per message, because this is called on every message.
 */
let _lastSettingsComplaint = 0;
/* Surfaced at the top of the dashboard. The whole point of showing it there is
   that the last time this went wrong, nothing said so. */
const settingsHealth = { ok: true, error: null };

function complain(msg) {
  settingsHealth.ok = false;
  settingsHealth.error = msg;
  const now = Date.now();
  if (now - _lastSettingsComplaint < 60_000) return;
  _lastSettingsComplaint = now;
  log('SETTINGS:', msg, '— running on defaults until this is fixed');
}

function loadSettings() {
  let text;
  try {
    text = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch (e) {
    // ENOENT on first run is normal — ensureSettingsFile() writes one.
    if (e.code !== 'ENOENT') complain(`cannot read ${SETTINGS_FILE}: ${e.message}`);
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  try {
    const raw = JSON.parse(text);
    settingsHealth.ok = true;
    settingsHealth.error = null;
    // A shallow merge would wipe half of a nested block when the file sets only
    // one field of it, so the two nested blocks are merged in their own right.
    return {
      ...DEFAULTS, ...raw,
      invite : { ...DEFAULTS.invite,  ...(raw.invite  || {}) },
      noReply: { ...DEFAULTS.noReply, ...(raw.noReply || {}) },
    };
  } catch (e) {
    complain(`${SETTINGS_FILE} is not valid JSON: ${e.message}`);
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

/**
 * Make sure there is a settings file before a single message is handled, and
 * refuse to start rather than run on defaults nobody chose.
 */
function ensureSettingsFile() {
  let st = null;
  try { st = fs.statSync(SETTINGS_FILE); } catch { /* not there yet */ }

  if (st && st.isDirectory()) {
    log(`FATAL: ${SETTINGS_FILE} is a directory, not a file.`);
    log('Docker creates a directory when a bind-mounted file is missing on the host.');
    log(`Remove it, put a real settings.json there, and start again.`);
    process.exit(1);
  }

  if (!st) {
    // Carry a file over from the old layout rather than silently ignoring it.
    try {
      if (fs.statSync(LEGACY_SETTINGS_FILE).isFile()) {
        fs.copyFileSync(LEGACY_SETTINGS_FILE, SETTINGS_FILE);
        log(`moved settings from ${LEGACY_SETTINGS_FILE} to ${SETTINGS_FILE}`);
        return;
      }
    } catch { /* no legacy file either */ }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULTS, null, 2));
    log(`no settings file — wrote defaults to ${SETTINGS_FILE}. Edit it; changes apply immediately.`);
  }
}

/** Persist one change without clobbering hand edits to the other keys. */
function patchSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    log('could not write settings:', e.message);
  }
  return next;
}

// ─── Who we have already handled ─────────────────────────────────────────────
//
// Held in memory and mirrored to disk. The previous build re-read a JSON array
// from disk on *every incoming message* — fine for ten customers, not for ten
// thousand.
function loadIdSet(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(raw.ids) ? raw.ids : []);
  } catch {
    return new Set();
  }
}

fs.mkdirSync(STATE_DIR, { recursive: true });
ensureSettingsFile();
const GREETED_FILE = path.join(STATE_DIR, 'greeted.json');
const SAVED_FILE   = path.join(STATE_DIR, 'saved-contacts.json');
const greeted = loadIdSet(GREETED_FILE);
const saved   = loadIdSet(SAVED_FILE);

function remember(set, file, id) {
  if (set.has(id)) return;
  set.add(id);
  try {
    fs.writeFileSync(file, JSON.stringify({ ids: [...set] }));
  } catch (e) {
    // Losing the file means re-greeting somebody after a restart. Annoying;
    // not worth crashing the bot over.
    log('could not write', path.basename(file) + ':', e.message);
  }
}

// ─── WhatsApp client ─────────────────────────────────────────────────────────
// Chromium flags tuned for a small VPS; this may be sharing a box.
const LOW_MEM_CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu',
  '--disable-extensions', '--disable-background-networking', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-default-apps', '--disable-sync', '--disable-translate', '--mute-audio',
  '--no-default-browser-check', '--metrics-recording-only',
  '--disable-features=site-per-process,TranslateUI,BlinkGenPropertyTrees',
  '--js-flags=--max-old-space-size=512',
];

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
  pairWithPhoneNumber: { phoneNumber: PAIR_NUMBER, showNotification: false },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: LOW_MEM_CHROME_ARGS,
  },
});

client.on('code', (code) => {
  const pretty = String(code).replace(/(.{4})(.{4})/, '$1-$2');
  log(
    `Link +${PAIR_NUMBER}: WhatsApp -> Linked Devices -> Link a Device -> ` +
    `"Link with phone number instead" -> code: ${pretty} (regenerates every ~3 min)`,
  );
});

client.on('qr', async (qr) => {
  try { console.log(await QRCode.toString(qr, { type: 'terminal', small: true })); } catch { /* terminal cannot draw it */ }
  try { await QRCode.toFile(QR_FILE, qr, { scale: 8, margin: 2 }); } catch { /* disk is read-only */ }
  log('Scan the QR above (also written to qr.png) with the OWNER phone.');
});

/* whatsapp-web.js re-injects into the page on every frame navigation, and each
   injection re-emits `authenticated` and `ready`. So a burst of these is not a
   burst of logins — it is the WhatsApp tab reloading over and over, which in a
   container almost always means Chromium's renderer is being killed for
   memory. Worth saying out loud, because the symptom that follows is WhatsApp
   unlinking the device, which looks like a login fault instead of a RAM one. */
let reloads = 0;
let warnedAboutReloads = false;

client.on('authenticated', () => {
  reloads++;
  if (reloads === 1) log('authenticated');
  else if (reloads >= 3 && !warnedAboutReloads) {
    warnedAboutReloads = true;
    note(`WhatsApp Web has reloaded ${reloads} times — Chromium is probably running out of memory. Give the container more RAM; a memory limit here will end in WhatsApp unlinking this device.`);
  }
  try { fs.unlinkSync(QR_FILE); } catch { /* already gone */ }
});

let announced = '';
client.on('ready', () => {
  const s = loadSettings();
  const summary = [
    `contacts=${s.autoSaveContacts ? 'on' : 'off'}`,
    `invite=${s.invite.enabled && s.invite.message ? 'on' : 'off'}`,
    `no-reply=${s.noReply.enabled ? s.noReply.minutes + 'm' : 'off'}`,
  ].join(' ');
  // Only when something actually changed — see the reload note above.
  if (summary === announced) return;
  announced = summary;
  log('ready.', summary);
  if (s.invite.enabled && !s.invite.message) {
    log('invite is enabled but has no message — nothing will be sent. Set invite.message in settings.json.');
  }
});

client.on('disconnected', (reason) => {
  /* LOGOUT is not a hiccup: WhatsApp has unlinked this device and the library
     has already deleted the stored session, so restarting only produces
     another QR. Say that plainly instead of "restarting clean", because a
     supervisor looping on a QR looks like a crash and is really a request. */
  if (String(reason) === 'LOGOUT') {
    log('WhatsApp unlinked this device. The saved session is gone — the next start will show a QR to scan.');
    log('If this keeps happening within minutes of pairing, it is memory: see the reload warning above.');
  } else {
    // Re-initialising on the same client leaves the old Chromium behind, and a
    // few disconnects later the box is out of memory. Exit instead and let the
    // supervisor (PM2 / Docker restart policy) start a clean process.
    log('disconnected:', reason, '— exiting so the supervisor restarts us clean');
  }
  client.destroy().catch(() => {}).finally(() => process.exit(1));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The customer's phone number, as the address book wants it.
 *
 * WhatsApp hands out `@lid` ids for people whose number is hidden from you, and
 * those cannot be saved as a contact — `getContactLidAndPhone` is the only way
 * back to a real number, and it does not always have one.
 */
async function resolvePhoneNumber(chatId) {
  const ser = String(chatId || '');
  if (ser.endsWith('@c.us')) return ser.replace(/@c\.us$/, '').replace(/\D/g, '');
  if (ser.endsWith('@lid')) {
    try {
      const r = await client.getContactLidAndPhone([ser]);
      const pn = r && r[0] && r[0].pn;
      if (pn) return String(pn).replace(/@c\.us$/, '').replace(/\D/g, '');
    } catch { /* no mapping available */ }
    return '';
  }
  try {
    const c = await client.getContactById(ser);
    if (c && c.number) return String(c.number).replace(/\D/g, '');
  } catch { /* unknown id shape */ }
  return '';
}

/* Messages this bot sent, so its own sends are not mistaken for the owner
   replying. Bounded: an id matters only between sending it and seeing it echo
   back, and an unbounded Set here is a slow leak. */
const botSentIds = new Set();
function rememberOwnSend(sent) {
  const id = sent && sent.id && sent.id._serialized;
  if (!id) return;
  botSentIds.add(id);
  if (botSentIds.size > 500) botSentIds.delete(botSentIds.values().next().value);
}

async function send(chatId, text) {
  const sent = await client.sendMessage(chatId, text);
  rememberOwnSend(sent);
  return sent;
}

/** Customers waiting on the owner: chatId -> { ts, name, notified }. */
const pending = new Map();

// ─── 1 + 2. Save the contact, send the invite ────────────────────────────────
client.on('message', async (msg) => {
  try {
    if (msg.from === 'status@broadcast' || msg.fromMe) return;
    if (typeof msg.from === 'string' && msg.from.endsWith('@g.us')) return; // groups are not customers

    /* History, not news. WhatsApp replays unread messages when a client links,
       so without this every old unanswered chat looks like it just arrived —
       and gets saved, greeted and chased all over again. */
    const sentAt = Number(msg.timestamp) || 0;
    if (sentAt && sentAt < STARTED_AT) return;

    const s = loadSettings();
    if (!s.enabled) return;

    const chatId = msg.from;
    let contact = null;
    try { contact = await msg.getContact(); } catch { /* deleted account */ }
    const name = (contact && (contact.pushname || contact.name)) || chatId.replace(/@c\.us$/, '');

    // Never seen before by either half of the bot: this is a first contact.
    const isFirstContact = !saved.has(chatId) && !greeted.has(chatId);

    /* Start (or refresh) the reply clock. Refreshed only while we have not
       chased them yet — otherwise a customer who keeps typing resets the timer
       forever and never gets the message. */
    const cur = pending.get(chatId);
    if (!cur) pending.set(chatId, { ts: Date.now(), name, notified: false, isFirstContact });
    else if (!cur.notified) { cur.ts = Date.now(); cur.name = name; }

    if (s.autoSaveContacts && !saved.has(chatId)) {
      const n = Number(s.contactNextNumber) || 1;
      const number = await resolvePhoneNumber(chatId);
      if (number) {
        try {
          await client.saveOrEditAddressbookContact(number, 'Cus ' + n, '', true);
          remember(saved, SAVED_FILE, chatId);
          patchSettings({ contactNextNumber: n + 1 });
          note(`saved ${name} as "Cus ${n}"`);
        } catch (e) {
          // Left unsaved on purpose, so the next message retries.
          note(`could not save ${name} to contacts: ${e.message}`);
        }
      } else {
        // Hidden number: there is nothing to save and there never will be.
        remember(saved, SAVED_FILE, chatId);
      }
    }

    if (s.invite.enabled && s.invite.message && !greeted.has(chatId)) {
      // Marked before sending: a send that half-succeeds must not invite them
      // a second time on their next message.
      remember(greeted, GREETED_FILE, chatId);
      try {
        await send(chatId, s.invite.message);
        note(`invite sent to ${name}`);
      } catch (e) {
        note(`invite to ${name} failed: ${e.message}`);
      }
    }
  } catch (e) {
    log('message handler error:', e.message);
  }
});

// ─── The owner replying stops the clock ──────────────────────────────────────
client.on('message_create', (msg) => {
  if (!msg.fromMe) return;
  if (typeof msg.to === 'string' && msg.to.endsWith('@g.us')) return;
  const id = msg.id && msg.id._serialized;
  if (id && botSentIds.has(id)) { botSentIds.delete(id); return; } // our own send, not a reply
  pending.delete(msg.to);
});

// ─── 3. Chase anyone still waiting ───────────────────────────────────────────
const SWEEP_MS  = 30_000;
const FORGET_MS = 24 * 60 * 60 * 1000; // drop chased chats after a day

setInterval(async () => {
  const s = loadSettings();
  const waitMs = Math.max(1, Number(s.noReply.minutes) || 10) * 60_000;
  const now = Date.now();

  for (const [chatId, info] of pending) {
    if (info.notified) {
      // Already chased. Kept a while so a late reply still clears it, then
      // dropped — otherwise this map grows for the life of the process.
      if (now - info.ts > FORGET_MS) pending.delete(chatId);
      continue;
    }
    if (!s.enabled || !s.noReply.enabled || !s.noReply.message) continue;
    if (s.noReply.firstContactOnly && !info.isFirstContact) { pending.delete(chatId); continue; }
    if (now - info.ts < waitMs) continue;

    /* Last look before speaking. The owner replying from their phone normally
       reaches us as a message_create event, but that event is missed if it
       lands while we are reconnecting — and the cost of getting this wrong is
       telling a customer we haven't answered them when we have. */
    try {
      const chat = await client.getChatById(chatId);
      const [last] = await chat.fetchMessages({ limit: 1 });
      if (last && last.fromMe) { pending.delete(chatId); continue; }
    } catch (e) {
      // Couldn't check: stay quiet rather than risk a wrong message.
      log('could not verify chat before chasing:', e.message);
      continue;
    }

    info.notified = true;
    info.ts = now;
    try {
      await send(chatId, s.noReply.message);
      note(`no-reply message sent to ${info.name}`);
    } catch (e) {
      note(`no-reply to ${info.name} failed: ${e.message}`);
    }
  }
}, SWEEP_MS);

// ─── Stale profile locks ─────────────────────────────────────────────────────
//
// Chromium will not open a profile it believes another Chromium is using, and
// records that claim as a `SingletonLock` symlink naming `<hostname>-<pid>`.
//
// In a container that claim outlives the process that made it. The container's
// hostname is a fresh random id on every `docker compose up --build`, so the
// lock left behind by yesterday's container names a machine that no longer
// exists, and Chromium refuses to start with:
//
//   The profile appears to be in use by another Chromium process (15)
//   on another computer (6d8331c9a2d0)
//
// which, with a restart policy in front of it, is an infinite crash loop.
//
// Clearing the lock is only safe when it is genuinely dead, so this checks
// rather than assumes: a lock from a different machine cannot be live here, and
// a lock from this machine is only cleared once its pid is gone.
/**
 * Is `pid` a Chromium that currently has `profile` open?
 *
 * Asked of /proc rather than of `process.kill(pid, 0)`, which only answers
 * "does something with this number exist" — true far too often in a container,
 * where pid numbering starts again at 1 for every run.
 *
 * Anything we cannot read counts as "no". This is called before our own
 * browser starts, so a lock we cannot attribute to a running Chromium is one
 * nobody is holding.
 */
function isChromiumUsing(pid, profile) {
  let cmdline;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false; // process gone, or no /proc (not Linux)
  }
  const args = cmdline.split('\0').join(' ');
  if (!/chrome|chromium/i.test(args)) return false;
  return args.includes(profile) || args.includes(path.basename(profile));
}

function clearStaleProfileLock() {
  let entries;
  try {
    entries = fs.readdirSync(SESSION_PATH, { withFileTypes: true });
  } catch {
    return; // no session yet — first run
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session')) continue;
    const profile = path.join(SESSION_PATH, entry.name);
    const lock = path.join(profile, 'SingletonLock');

    let owner = null;               // "<hostname>-<pid>", when we can read it
    try {
      owner = fs.readlinkSync(lock);
    } catch (e) {
      if (e.code === 'ENOENT') continue;             // nothing to clear
      owner = '';                                    // present but not a symlink
    }

    if (owner) {
      const split = owner.lastIndexOf('-');
      const host = split > 0 ? owner.slice(0, split) : owner;
      const pid  = Number(owner.slice(split + 1));

      if (host === os.hostname() && Number.isInteger(pid) && pid > 0) {
        /* Same machine, so the holder *could* still be alive — but "the pid
           exists" is not the question, and inside a container it is a badly
           misleading one. Pids restart from 1 in every new container, and the
           hostname is now pinned, so a lock left by yesterday's container reads
           as `pxn-owner-bot-14` and pid 14 in today's container is simply
           whatever started fourteenth. That collision makes a dead lock look
           held, and the bot then refuses to clear the very thing stopping it.

           The real question is whether that pid is a Chromium holding *this*
           profile. Nothing of ours can be: this runs before we launch one. */
        if (isChromiumUsing(pid, profile)) {
          log(`profile ${entry.name} really is open in pid ${pid} — leaving its lock alone`);
          continue;
        }
      }
    }

    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.rmSync(path.join(profile, name), { force: true, recursive: true }); }
      catch (e) { log(`could not clear ${name}:`, e.message); }
    }
    log(`cleared a stale Chromium lock on ${entry.name}` + (owner ? ` (left by ${owner})` : ''));
  }
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
const dashboard = startDashboard({
  port: DASH_PORT,
  host: DASH_HOST,
  password: DASH_PASSWORD,
  readSettings: loadSettings,
  writeSettings: (next) => patchSettings(next),
  log,
  status: () => {
    const s = loadSettings();
    return {
      // `client.info` is only populated once WhatsApp has actually linked.
      ready            : client.info != null,
      settingsOk       : settingsHealth.ok,
      settingsError    : settingsHealth.error,
      settingsFile     : SETTINGS_FILE,
      contactNextNumber: s.contactNextNumber,
      saved            : saved.size,
      greeted          : greeted.size,
      // Only those still owed a reply; the chased ones linger for a day.
      pending          : [...pending.values()].filter((p) => !p.notified).length,
      activity,
    };
  },
});

// ─── Go ──────────────────────────────────────────────────────────────────────
clearStaleProfileLock();
log('starting owner WhatsApp client…');
client.initialize().catch((e) => {
  console.error('[owner] init error:', e.message);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(sig, '— shutting down');
    if (dashboard) dashboard.close();
    await client.destroy().catch(() => {});
    process.exit(0);
  });
}
