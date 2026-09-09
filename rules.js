'use strict';
/**
 * The two decisions that changed on a live account, kept where they can be
 * read and tested on their own.
 *
 * Both used to be expressions buried in the message handler, which is a fine
 * place for them right up until the order of two lines around them decides
 * whether a customer is treated as new. That is not a thing to leave to
 * whoever edits the handler next.
 */

/**
 * Does this person get the welcome message?
 *
 * The rule the owner asked for: **only people they do not already know**.
 * Someone in the phone's address book is an existing customer whatever they
 * are saved as, and welcoming them to a shop they have been buying from for
 * months reads as a bot that has forgotten them.
 *
 * `alreadyKnown` must be read BEFORE the contact is saved. Saving is what
 * makes it true, so asking afterwards makes every new customer look like an
 * old one and nobody is ever welcomed again. The caller does that; this
 * function only decides.
 *
 * @param invite        settings.invite — { enabled, message }
 * @param alreadyKnown  in the address book, or previously handled by the bot
 * @param alreadyGreeted already had the welcome once
 */
function shouldWelcome({ invite, alreadyKnown, alreadyGreeted }) {
  if (!invite || !invite.enabled) return false;
  // An enabled welcome with nothing written in it is not a welcome.
  if (!String(invite.message || '').trim()) return false;
  if (alreadyGreeted) return false;
  return !alreadyKnown;
}

/**
 * When a customer who just messaged should be written into the address book.
 *
 * Zero means now, which is what the bot always did. A wait means only people
 * still there after it get a slot: a wrong number who says "sorry" and leaves
 * never takes one.
 *
 * @returns a timestamp, or null for "now"
 */
function saveDueAt(delayMinutes, now = Date.now()) {
  const minutes = Number(delayMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  // A day is the panel's ceiling; anything past it is a typo, not a policy.
  return now + Math.min(minutes, 1440) * 60_000;
}

module.exports = { shouldWelcome, saveDueAt };
