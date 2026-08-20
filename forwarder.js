'use strict';

const { MessageMedia } = require('whatsapp-web.js');

/**
 * Preset broadcast: the owner types one short phrase to a customer, and the
 * whole contents of a template group go out to them.
 *
 * The group ("forward-all" by default) is a normal WhatsApp group the owner
 * keeps to themselves, holding the price list, the photos, the terms — whatever
 * gets sent to every new customer. Typing the trigger phrase into a chat sends
 * all of it, in order, with media intact.
 *
 * This existed in the old AI agent and was expensive: it called
 * `client.getChats()` on every single send, which serialises every chat on the
 * account, then re-read the template group's history each time. On a phone with
 * hundreds of chats that is seconds of CPU and a lot of memory per trigger.
 *
 * Three things fix that here:
 *
 *   • The group is resolved once and its id cached. `getChats()` runs at most
 *     once per process, and only if the trigger is actually used.
 *   • The template's messages are cached for a few minutes. Sending to five
 *     customers in a row reads the group once, not five times.
 *   • A chat already receiving a broadcast is skipped rather than queued twice,
 *     so a double-tap on the trigger cannot send everything twice.
 */

const DEFAULTS = {
  enabled: false,
  group: 'forward-all',
  trigger: '',
  limit: 40,      // most messages to take from the template group
  gapMs: 900,     // pause between sends; WhatsApp rate-limits bursts
};

/** Loose comparison: case, spacing and stray punctuation should not decide
    whether the owner's message counts as the trigger. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s​]+/g, ' ')
    .replace(/[.!?،,;:]+$/g, '')
    .trim();
}

function createForwarder({ client, loadSettings, note, log, onSent, rememberGroup }) {
  let groupCache = null;               // { id, name, at }
  let templateCache = null;            // { messages, at }
  const busy = new Set();              // chats mid-broadcast
  const lastSentTo = new Map();        // chatId -> when, to swallow double-taps
  /* Once forwarding has failed on this account it will keep failing — it is a
     WhatsApp capability, not a per-message accident. Remembering that saves
     one dead round trip per message for the rest of the run. */
  let forwardingWorks = true;

  const GROUP_TTL = 10 * 60_000;
  const TEMPLATE_TTL = 5 * 60_000;
  const REPEAT_GUARD_MS = 60_000;

  const settings = () => {
    const s = loadSettings();
    return { ...DEFAULTS, ...(s.forward || {}) };
  };

  /**
   * Just the groups: their ids and their names, nothing else.
   *
   * `client.getChats()` cannot be used here. It runs every chat on the account
   * through the library's full chat serialiser inside a Promise.all, so a
   * single chat that fails to model — a channel, a community, a contact that
   * no longer resolves — rejects the whole call, and what comes back is one
   * minified letter. On a live account with hundreds of chats that is not an
   * edge case; it is what happens. It reported `could not list your chats (r)`
   * for fifteen minutes straight.
   *
   * This asks the page for the two fields actually needed. Nothing is
   * serialised, so nothing can poison the batch, and it is far cheaper than
   * modelling every chat to read a name off one of them.
   */
  async function listGroups() {
    try {
      const groups = await client.pupPage.evaluate(() => {
        const all = window.require('WAWebCollections').Chat.getModelsArray();
        return all
          .filter((c) => c && c.id && String(c.id._serialized || '').endsWith('@g.us'))
          .map((c) => ({
            id: c.id._serialized,
            name: c.formattedTitle || c.name || (c.contact && c.contact.name) || '',
          }));
      });
      if (Array.isArray(groups) && groups.length) return groups;
    } catch (e) {
      log('light group listing failed, falling back:', e.message || e);
    }

    // Fallback for a WhatsApp Web whose internals have moved. Same fragility
    // as before, but now it is the second choice rather than the only one.
    const chats = await client.getChats();
    return chats
      .filter((c) => c.isGroup)
      .map((c) => ({ id: c.id._serialized, name: c.name || '' }));
  }

  /**
   * The template group, found once and remembered — in settings, so a restart
   * does not have to go looking again.
   */
  async function findGroup(name) {
    const wanted = normalise(name);
    if (groupCache && groupCache.name === wanted && Date.now() - groupCache.at < GROUP_TTL) {
      return groupCache;
    }

    // An id we resolved on a previous run, for this same group name.
    const saved = loadSettings().forward || {};
    if (saved.groupId && normalise(saved.groupName || '') === wanted) {
      groupCache = { id: saved.groupId, name: wanted, at: Date.now() };
      templateCache = null;
      return groupCache;
    }

    let groups;
    try {
      groups = await listGroups();
    } catch (e) {
      throw new Error(`could not read your group list (${e.message || e}).`);
    }

    const hit = groups.find((g) => normalise(g.name) === wanted);
    if (!hit) {
      groupCache = null;
      const names = groups.map((g) => g.name).filter(Boolean).slice(0, 8);
      throw new Error(
        `no group called "${name}". ` +
        (names.length ? `Your groups: ${names.join(', ')}` : 'You are not in any groups.'),
      );
    }

    groupCache = { id: hit.id, name: wanted, at: Date.now() };
    templateCache = null;              // a different group means a new template
    if (rememberGroup) rememberGroup(hit.id, name);
    return groupCache;
  }

  /**
   * What the template group holds, oldest first — as ids, not objects.
   *
   * `client.getChatById()` cannot be used, for the same reason `getChats()`
   * could not be: both go through the library's chat serialiser, and on this
   * WhatsApp Web that serialiser throws. It reported
   * `could not open the group (r)` on a group that was plainly there.
   *
   * The page is asked for the raw chat instead — `getAsModel: false`, the same
   * path the library's own fetchMessages uses — and only the handful of fields
   * needed to decide what to send. Ids are enough, because forwarding takes an
   * id too.
   */
  async function templateMessages(group, limit) {
    if (templateCache && Date.now() - templateCache.at < TEMPLATE_TTL) {
      return templateCache.messages;
    }

    let raw;
    try {
      raw = await client.pupPage.evaluate(async (chatId, want) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat || !chat.msgs) return null;

        const keep = (m) => m && m.id && !m.isNotification;
        let msgs = chat.msgs.getModelsArray().filter(keep);

        /* WhatsApp only keeps a chat's messages in memory once that chat has
           been opened. For a group the owner has not looked at since this
           session began — which is the normal case for a template group — the
           collection is empty, and reading it straight off reports a group
           with nothing in it. Pull the history in first, the same way the
           library's own fetchMessages does. */
        let rounds = 0;
        while (msgs.length < want && rounds < 10) {
          rounds++;
          const older = await window
            .require('WAWebChatLoadMessages')
            .loadEarlierMsgs({ chat });
          if (!older || !older.length) break;
          msgs = [...older.filter(keep), ...msgs];
        }

        return msgs.map((m) => ({
          id: m.id._serialized,
          fromMe: !!m.id.fromMe,
          text: m.body || m.caption || '',
          // How the library itself decides a message carries media.
          hasMedia: Boolean(m.mediaKey && m.directPath),
          t: m.t || 0,
        }));
      }, group.id, Number(limit) || 40);
    } catch (e) {
      throw new Error(`could not read the group (${e.message || e}).`);
    }

    if (raw === null) {
      // The stored id no longer resolves — the group was left, or renamed away.
      groupCache = null;
      if (rememberGroup) rememberGroup('', '');
      throw new Error('that group could not be opened. Trying again will look it up afresh.');
    }

    const messages = raw
      // Only what the owner put there, and only if it carries something.
      .filter((m) => m.fromMe && (m.text || m.hasMedia))
      .sort((a, b) => a.t - b.t)
      .slice(-limit);

    /* Deliberately not cached when empty. An empty read is far more likely to
       mean "the history had not loaded yet" than "the group is empty", and
       caching it made every retry for the next five minutes fail the same way
       without touching WhatsApp again. */
    if (messages.length) templateCache = { messages, at: Date.now() };
    return messages;
  }

  /**
   * Forward one message by id, saying which step failed when one does.
   *
   * This is what `Message.forward()` does internally, minus building a Message
   * object first — building one means serialising a chat, and that is the step
   * that does not work here. Written out rather than called so that a failure
   * names itself: the library's version surfaces every one of these as the same
   * bare minified letter.
   */
  async function forwardById(msgId, toChatId) {
    return client.pupPage.evaluate(async (chatId, id) => {
      const Coll = window.require('WAWebCollections');
      const msg = Coll.Msg.get(id) ||
        (await Coll.Msg.getMessagesById([id]))?.messages?.[0];
      if (!msg) throw new Error('the message is no longer in the page');

      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) throw new Error('the destination chat could not be opened');

      try {
        return await window.require('WAWebChatForwardMessage').forwardMessages({
          chat, msgs: [msg], multicast: true, includeCaption: true,
          appendedText: undefined,
        });
      } catch (e) {
        throw new Error('the forward call itself failed: ' + (e && e.message ? e.message : e));
      }
    }, toChatId, msgId);
  }

  /**
   * The media on a message, fetched by id.
   *
   * Every route into this library has failed on this account in turn — the
   * chat list, the chat, the message model, the forward — each with the same
   * single minified letter, and each fix has been too narrow by exactly one
   * layer. So this stops guessing which internal still works and tries all of
   * them, keeping what each one said when it did not.
   *
   * Two routes, cheapest first. WhatsApp usually still holds the decrypted
   * blob on the message after a download; reading that costs nothing and
   * avoids the network entirely. Failing that, the download manager, which is
   * what the library itself calls.
   *
   * On failure the error names every route and its reason, so the next report
   * is a map rather than a letter.
   */
  async function mediaOf(msgId) {
    const result = await client.pupPage.evaluate(async (id) => {
      const problems = [];
      const say = (where, e) => problems.push(`${where}: ${(e && e.message) || e}`);

      let msg;
      try {
        const Coll = window.require('WAWebCollections');
        msg = Coll.Msg.get(id) || (await Coll.Msg.getMessagesById([id]))?.messages?.[0];
      } catch (e) { say('finding the message', e); }
      if (!msg) return { error: problems.join('; ') || 'the message is not in the page' };

      const about = {
        mimetype: msg.mimetype || (msg.type ? `${msg.type}/*` : undefined),
        filename: msg.filename,
        filesize: msg.size,
      };

      // Ask WhatsApp to resolve the media if it has not already.
      try {
        if (!msg.mediaData || msg.mediaData.mediaStage !== 'RESOLVED') {
          await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
        }
      } catch (e) { say('asking WhatsApp to fetch it', e); }

      const asBase64 = (blob) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.onerror = () => reject(new Error('the file could not be read'));
        fr.readAsDataURL(blob);
      });

      // 1. The copy WhatsApp already has in hand.
      try {
        const md = msg.mediaData || {};
        const blob = (md.mediaBlob && (md.mediaBlob._blob || md.mediaBlob)) || md.blob;
        if (blob && typeof blob.size === 'number') {
          const data = await asBase64(blob);
          if (data) return { ...about, data, via: 'the copy already downloaded' };
        }
        say('the copy already downloaded', 'not held in memory');
      } catch (e) { say('the copy already downloaded', e); }

      // 2. Fetch and decrypt it ourselves, as the library does.
      try {
        const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
        const decrypted = await window.require('WAWebDownloadManager')
          .downloadManager.downloadAndMaybeDecrypt({
            directPath: msg.directPath, encFilehash: msg.encFilehash,
            filehash: msg.filehash, mediaKey: msg.mediaKey,
            mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type,
            signal: new AbortController().signal, downloadQpl: mockQpl,
          });
        const toB64 = window.WWebJS.arrayBufferToBase64Async || window.WWebJS.arrayBufferToBase64;
        const data = await toB64(decrypted);
        if (data) return { ...about, data, via: 'a fresh download' };
        say('downloading it', 'came back empty');
      } catch (e) { say('downloading it', e); }

      return { error: problems.join('; ') };
    }, msgId);

    if (!result || result.error) {
      throw new Error(result ? result.error : 'no answer from the page');
    }
    if (result.via) log('media fetched via', result.via);
    return new MessageMedia(result.mimetype, result.data, result.filename, result.filesize);
  }

  /**
   * Send the same content as a new message.
   *
   * The fallback for when forwarding is unavailable — which, on a WhatsApp Web
   * newer than the library, it can be. Ordinary sending demonstrably still
   * works (it is how the welcome message goes out), so the customer gets the
   * price list either way. The only visible difference is the absence of the
   * "forwarded" tag.
   */
  async function resendOne(m, toChatId) {
    if (m.hasMedia) {
      try {
        const media = await mediaOf(m.id);
        return client.sendMessage(toChatId, media, { caption: m.text || undefined });
      } catch (e) {
        /* A video that will not download is not a reason to drop the words
           that came with it — the caption on these is usually the part that
           explains what the customer is looking at. */
        log('media could not be sent:', e.message);
        if (!m.text) throw e;
        note(`one item is a file that could not be sent — its caption went instead (${e.message})`);
      }
    }
    if (m.text) return client.sendMessage(toChatId, m.text);
    throw new Error('there was nothing in it that could be sent');
  }

  /**
   * Did this outgoing message ask for a broadcast? Returns false for everything
   * else, cheaply — this runs on every message the owner sends.
   */
  function isTrigger(body) {
    const s = settings();
    if (!s.enabled || !s.trigger) return false;
    return normalise(body) === normalise(s.trigger);
  }

  /** Send the template group's contents to one chat. */
  async function broadcastTo(chatId) {
    const s = settings();

    if (busy.has(chatId)) {
      log(`broadcast already running for ${chatId} — ignoring the repeat`);
      return { ok: false, reason: 'already running' };
    }
    const last = lastSentTo.get(chatId);
    if (last && Date.now() - last < REPEAT_GUARD_MS) {
      log('broadcast sent to this chat moments ago — ignoring the repeat');
      return { ok: false, reason: 'just sent' };
    }

    busy.add(chatId);
    try {
      let group, messages;
      try {
        group = await findGroup(s.group);
        messages = await templateMessages(group, Number(s.limit) || DEFAULTS.limit);
      } catch (e) {
        note(`Broadcast failed: ${e.message}`);
        return { ok: false, reason: e.message };
      }

      if (!messages.length) {
        note(`Broadcast failed: you have not posted anything in "${s.group}" yet. Only messages you sent there are forwarded.`);
        return { ok: false, reason: 'template empty' };
      }

      /* Marked before the first send, not after: the messages we forward come
         back as our own outgoing messages, and one of them matching the
         trigger must not start the whole thing again. */
      lastSentTo.set(chatId, Date.now());

      let sent = 0;
      let resent = 0;
      let lastError = null;
      for (const m of messages) {
        try {
          if (!forwardingWorks) throw new Error('forwarding is unavailable on this account');
          await forwardById(m.id, chatId);
          sent++;
        } catch (e) {
          const why = e.message || String(e);
          forwardingWorks = false;
          try {
            /* Forwarding is a WhatsApp feature and it can be unavailable to us;
               the content is ours either way. Better a message without the
               "forwarded" tag than a customer with no price list. */
            await resendOne(m, chatId);
            sent++;
            resent++;
            if (resent === 1) log('forwarding unavailable, sending the content instead:', why);
          } catch (e2) {
            // One bad message must not abandon the rest of the sequence — but
            // if every one fails, that is not a success with a low count.
            lastError = `forward: ${why} / send: ${e2.message || e2}`;
            log('one broadcast message failed:', lastError);
          }
        }
        // WhatsApp throttles bursts and will drop messages sent too fast.
        await new Promise((r) => setTimeout(r, Number(s.gapMs) || DEFAULTS.gapMs));
      }

      if (!sent) {
        note(`Broadcast failed: none of the ${messages.length} messages could be forwarded (${lastError}).`);
        return { ok: false, reason: lastError || 'nothing sent' };
      }

      if (lastSentTo.size > 500) {
        for (const [k, v] of lastSentTo) if (Date.now() - v > REPEAT_GUARD_MS) lastSentTo.delete(k);
      }
      return { ok: true, sent, of: messages.length, resent };
    } finally {
      busy.delete(chatId);
    }
  }

  return {
    isTrigger,
    broadcastTo,
    /** For the dashboard: what the bot currently knows, without asking WhatsApp. */
    status: () => ({
      groupResolved: !!groupCache,
      templateCached: templateCache ? templateCache.messages.length : null,
      running: busy.size,
    }),
    /** Called when the group or trigger changes, so nothing stale is reused. */
    reset: () => { groupCache = null; templateCache = null; },
    DEFAULTS,
  };
}

module.exports = { createForwarder, DEFAULTS, normalise };
