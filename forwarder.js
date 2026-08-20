'use strict';

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

function createForwarder({ client, loadSettings, note, log, onSent }) {
  let groupCache = null;               // { id, name, at }
  let templateCache = null;            // { messages, at }
  const busy = new Set();              // chats mid-broadcast
  const lastSentTo = new Map();        // chatId -> when, to swallow double-taps

  const GROUP_TTL = 10 * 60_000;
  const TEMPLATE_TTL = 5 * 60_000;
  const REPEAT_GUARD_MS = 60_000;

  const settings = () => {
    const s = loadSettings();
    return { ...DEFAULTS, ...(s.forward || {}) };
  };

  /**
   * The template group, found once and remembered.
   *
   * Every call below runs inside the WhatsApp page, so when one fails it fails
   * with the page's own minified message — a bare "r" tells nobody anything.
   * Each step therefore names itself, because the first time this broke the
   * only evidence was `broadcast failed: r`.
   */
  async function findGroup(name) {
    const wanted = normalise(name);
    if (groupCache && groupCache.name === wanted && Date.now() - groupCache.at < GROUP_TTL) {
      return groupCache;
    }

    let chats;
    try {
      // The one expensive call, and only when the trigger is actually used.
      chats = await client.getChats();
    } catch (e) {
      throw new Error(`could not list your chats (${e.message || e}). WhatsApp may still be loading — try again in a minute.`);
    }

    const groups = chats.filter((ch) => ch.isGroup);
    const hit = groups.find((ch) => normalise(ch.name) === wanted);
    if (!hit) {
      groupCache = null;
      const names = groups.map((g) => g.name).filter(Boolean).slice(0, 8);
      throw new Error(
        `no group called "${name}". ` +
        (names.length ? `Your groups: ${names.join(', ')}` : 'You are not in any groups.'),
      );
    }

    groupCache = { id: hit.id._serialized, chat: hit, name: wanted, at: Date.now() };
    templateCache = null;              // a different group means a new template
    return groupCache;
  }

  /** What the template group holds, oldest first. */
  async function templateMessages(group, limit) {
    if (templateCache && Date.now() - templateCache.at < TEMPLATE_TTL) {
      return templateCache.messages;
    }
    let raw;
    try {
      // The Chat object from getChats() already knows how to do this; asking
      // the client for the chat again is a second trip and a second thing that
      // can fail.
      raw = await group.chat.fetchMessages({ limit });
    } catch (e) {
      throw new Error(`could not read the "${group.name}" group (${e.message || e}).`);
    }
    const messages = raw
      // Only what the owner put there, and only if it carries something.
      .filter((m) => m.fromMe && (m.body || m.hasMedia))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    templateCache = { messages, at: Date.now() };
    return messages;
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

      let sent = 0;
      let lastError = null;
      for (const m of messages) {
        try {
          const out = await m.forward(chatId);
          if (onSent) onSent(out);
          sent++;
        } catch (e) {
          // One bad message must not abandon the rest of the sequence — but if
          // every one fails, that is not a success with a low count.
          lastError = e.message || String(e);
          log('one broadcast message failed:', lastError);
        }
        // WhatsApp throttles bursts and will drop messages sent too fast.
        await new Promise((r) => setTimeout(r, Number(s.gapMs) || DEFAULTS.gapMs));
      }

      if (!sent) {
        note(`Broadcast failed: none of the ${messages.length} messages could be forwarded (${lastError}).`);
        return { ok: false, reason: lastError || 'nothing sent' };
      }

      lastSentTo.set(chatId, Date.now());
      if (lastSentTo.size > 500) {
        for (const [k, v] of lastSentTo) if (Date.now() - v > REPEAT_GUARD_MS) lastSentTo.delete(k);
      }
      return { ok: true, sent, of: messages.length };
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
