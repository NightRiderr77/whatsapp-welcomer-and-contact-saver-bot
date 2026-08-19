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
 * It is deliberately not the AI agent. No model, no Supabase, no dashboard, no
 * HTTP server. Configuration is `settings.json`, re-read on every message, so
 * editing that file takes effect immediately with no restart — that is what
 * replaces the dashboard the old build had.
 *
 *   Start:  node owner-bot.js
 *   Login:  scan the QR printed in the log, or set PAIR_NUMBER=<owner number>
 *           to link with an 8-digit code instead.
 */

const path   = require('path');
const fs     = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const SESSION_PATH  = process.env.WWEBJS_PATH   || path.join(__dirname, '.wwebjs_auth');
const STATE_DIR     = process.env.STATE_DIR     || path.join(__dirname, 'state');
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(__dirname, 'settings.json');
const QR_FILE       = path.join(__dirname, 'qr.png');
const PAIR_NUMBER   = String(process.env.PAIR_NUMBER || '').replace(/\D/g, '');

const log = (...a) => console.log(`[${new Date().toISOString()}] [owner]`, ...a);

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
    message: 'Hi! Sorry for the wait — we have seen your message and will reply as soon as we can.',
  },
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // A shallow merge would wipe half of a nested block when the file sets only
    // one field of it, so the two nested blocks are merged in their own right.
    return {
      ...DEFAULTS, ...raw,
      invite : { ...DEFAULTS.invite,  ...(raw.invite  || {}) },
      noReply: { ...DEFAULTS.noReply, ...(raw.noReply || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
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

client.on('authenticated', () => {
  log('authenticated');
  try { fs.unlinkSync(QR_FILE); } catch { /* already gone */ }
});

client.on('ready', () => {
  const s = loadSettings();
  log('ready.',
    `contacts=${s.autoSaveContacts ? 'on' : 'off'}`,
    `invite=${s.invite.enabled && s.invite.message ? 'on' : 'off'}`,
    `no-reply=${s.noReply.enabled ? s.noReply.minutes + 'm' : 'off'}`);
  if (s.invite.enabled && !s.invite.message) {
    log('invite is enabled but has no message — nothing will be sent. Set invite.message in settings.json.');
  }
});

client.on('disconnected', (reason) => {
  // Re-initialising on the same client leaves the old Chromium behind, and a
  // few disconnects later the box is out of memory. Exit instead and let the
  // supervisor (PM2 / Docker restart policy) start a clean process.
  log('disconnected:', reason, '— exiting so the supervisor restarts us clean');
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

    const s = loadSettings();
    if (!s.enabled) return;

    const chatId = msg.from;
    let contact = null;
    try { contact = await msg.getContact(); } catch { /* deleted account */ }
    const name = (contact && (contact.pushname || contact.name)) || chatId.replace(/@c\.us$/, '');

    /* Start (or refresh) the reply clock. Refreshed only while we have not
       chased them yet — otherwise a customer who keeps typing resets the timer
       forever and never gets the message. */
    const cur = pending.get(chatId);
    if (!cur) pending.set(chatId, { ts: Date.now(), name, notified: false });
    else if (!cur.notified) { cur.ts = Date.now(); cur.name = name; }

    if (s.autoSaveContacts && !saved.has(chatId)) {
      const n = Number(s.contactNextNumber) || 1;
      const number = await resolvePhoneNumber(chatId);
      if (number) {
        try {
          await client.saveOrEditAddressbookContact(number, 'Cus ' + n, '', true);
          remember(saved, SAVED_FILE, chatId);
          patchSettings({ contactNextNumber: n + 1 });
          log(`saved ${name} as "Cus ${n}"`);
        } catch (e) {
          // Left unsaved on purpose, so the next message retries.
          log('contact save failed:', e.message);
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
        log(`invite sent to ${name}`);
      } catch (e) {
        log('invite send failed:', e.message);
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
    if (now - info.ts < waitMs) continue;

    info.notified = true;
    info.ts = now;
    try {
      await send(chatId, s.noReply.message);
      log(`no-reply message sent to ${info.name}`);
    } catch (e) {
      log('no-reply send failed:', e.message);
    }
  }
}, SWEEP_MS);

// ─── Go ──────────────────────────────────────────────────────────────────────
log('starting owner WhatsApp client…');
client.initialize().catch((e) => {
  console.error('[owner] init error:', e.message);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(sig, '— shutting down');
    await client.destroy().catch(() => {});
    process.exit(0);
  });
}
