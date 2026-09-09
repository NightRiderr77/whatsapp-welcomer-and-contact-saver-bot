/**
 * The rules the panel enforces on what an operator types.
 *
 *   node tools/check-settings.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sanitise } = require(path.join(__dirname, '..', 'dashboard.js'));
const { shouldWelcome, saveDueAt } = require(path.join(__dirname, '..', 'rules.js'));

let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

const current = {
  enabled: true,
  autoSaveContacts: true,
  contactNextNumber: 7,
  contactSaveDelayMinutes: 5,
  invite: { enabled: true, message: 'hi' },
  forward: { enabled: false, group: 'forward-all', trigger: 'x', limit: 40, gapMs: 900, groupId: 'g@g.us', groupName: 'forward-all' },
  noReply: { enabled: true, minutes: 10, message: 'm', firstContactOnly: true },
};

console.log('save delay');

{
  const out = sanitise({ ...current, contactSaveDelayMinutes: 30 }, current);
  assert.strictEqual(out.contactSaveDelayMinutes, 30);
  ok('a plain number is kept');
}
{
  const out = sanitise({ ...current, contactSaveDelayMinutes: 0 }, current);
  assert.strictEqual(out.contactSaveDelayMinutes, 0, 'zero must survive, it means "save now"');
  ok('zero survives — it is a real setting, not a missing one');
}
{
  for (const bad of [-5, 'soon', null, undefined, 1441, NaN, {}]) {
    const out = sanitise({ ...current, contactSaveDelayMinutes: bad }, current);
    assert.strictEqual(out.contactSaveDelayMinutes, 5, 'kept the old value for ' + JSON.stringify(bad));
  }
  ok('nonsense and out-of-range values leave the current setting alone');
}
{
  const out = sanitise({ ...current, contactSaveDelayMinutes: 1440 }, current);
  assert.strictEqual(out.contactSaveDelayMinutes, 1440);
  ok('a full day is allowed, and is the ceiling');
}
{
  // An older settings.json has no delay at all; the panel must not crash on it.
  const older = { ...current };
  delete older.contactSaveDelayMinutes;
  const out = sanitise({ ...older, contactSaveDelayMinutes: 'x' }, older);
  assert.strictEqual(out.contactSaveDelayMinutes, 0);
  ok('a settings file written before this feature existed defaults to 0');
}

console.log('');
console.log('who gets the welcome message');

{
  const invite = { enabled: true, message: 'hi' };
  assert.strictEqual(
    shouldWelcome({ invite, alreadyKnown: false, alreadyGreeted: false }), true);
  ok('a brand-new customer is welcomed');
}
{
  const invite = { enabled: true, message: 'hi' };
  assert.strictEqual(
    shouldWelcome({ invite, alreadyKnown: true, alreadyGreeted: false }), false,
    'somebody already in the address book must not be welcomed');
  ok('someone already in your contacts is left alone — the whole point');
}
{
  const invite = { enabled: true, message: 'hi' };
  assert.strictEqual(
    shouldWelcome({ invite, alreadyKnown: false, alreadyGreeted: true }), false);
  ok('nobody is welcomed twice');
}
{
  assert.strictEqual(shouldWelcome({
    invite: { enabled: false, message: 'hi' }, alreadyKnown: false, alreadyGreeted: false }), false);
  assert.strictEqual(shouldWelcome({
    invite: { enabled: true, message: '' }, alreadyKnown: false, alreadyGreeted: false }), false);
  assert.strictEqual(shouldWelcome({
    invite: { enabled: true, message: '   ' }, alreadyKnown: false, alreadyGreeted: false }), false);
  assert.strictEqual(shouldWelcome({
    invite: null, alreadyKnown: false, alreadyGreeted: false }), false);
  ok('switched off, empty, blank or missing sends nothing');
}

/* The trap this feature dies of: `alreadyKnown` has to be read before the
   contact is saved, because saving is what makes it true. Get the order wrong
   and every new customer reads as an old one and nobody is welcomed again.
   Nothing at runtime would say so, hence checking the source itself. */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'owner-bot.js'), 'utf8');
  const read = src.indexOf('const alreadyKnown =');
  const save = src.indexOf('await queueSave(chatId, name)');
  const use  = src.indexOf('shouldWelcome({ invite: s.invite');
  assert.ok(read > -1 && save > -1 && use > -1, 'the handler no longer looks like this');
  assert.ok(read < save, 'alreadyKnown is read AFTER the save — every new customer now reads as known');
  assert.ok(save < use, 'the welcome check moved above the save');
  ok('the handler still reads alreadyKnown before it saves anyone');
}

console.log('');
console.log('when the contact gets saved');

{
  assert.strictEqual(saveDueAt(0), null);
  assert.strictEqual(saveDueAt(undefined), null);
  assert.strictEqual(saveDueAt('nonsense'), null);
  assert.strictEqual(saveDueAt(-5), null);
  ok('no delay set means save now');
}
{
  const now = 1000000;
  assert.strictEqual(saveDueAt(5, now), now + 5 * 60000);
  assert.strictEqual(saveDueAt('30', now), now + 30 * 60000);
  ok('a delay pushes the save out by that many minutes');
}
{
  const now = 1000000;
  assert.strictEqual(saveDueAt(99999, now), now + 1440 * 60000, 'capped at a day');
  ok('an absurd delay is capped at a day rather than parked forever');
}

console.log('\n' + passed + ' checks passed.');
