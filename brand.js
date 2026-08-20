'use strict';

/**
 * One place for who made this and who it belongs to.
 *
 * Every surface — the terminal banner, the dashboard header, the backup
 * scripts — reads its wording from here, so the branding cannot drift out of
 * step with itself.
 */

const BRAND = {
  name: 'WhatsApp Welcomer & Contact Saver Bot',
  short: 'Welcomer Bot',
  tagline: 'Saves every new customer, welcomes them once, and never lets one wait unanswered.',
  developer: 'NightRiderr77',
  developerUrl: 'https://github.com/NightRiderr77',
  company: 'PXN STORES LK',
  companyUrl: 'https://pxnstores.lk',
  repoUrl: 'https://github.com/NightRiderr77/whatsapp-welcomer-and-contact-saver-bot',
};

// ANSI colours, dropped when the output is not a terminal (a log file, a
// `docker compose logs` pipe) so nobody ends up reading escape codes.
const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, s) => (useColour ? `[${code}m${s}[0m` : s);

const c = {
  green: (s) => paint('38;5;41', s),
  dim: (s) => paint('2', s),
  bold: (s) => paint('1', s),
  white: (s) => paint('97', s),
  gold: (s) => paint('38;5;179', s),
};

/** The banner printed once at startup. */
function banner() {
  const line = c.dim('─'.repeat(58));
  return [
    '',
    line,
    '  ' + c.green('██╗    ██╗') + '  ' + c.bold(c.white(BRAND.name)),
    '  ' + c.green('██║ █╗ ██║') + '  ' + c.dim(BRAND.tagline),
    '  ' + c.green('██║███╗██║'),
    '  ' + c.green('╚███╔███╔╝') + '  ' + c.dim('Built by ') + c.gold(BRAND.developer),
    '  ' + c.green(' ╚══╝╚══╝ ') + '  ' + c.dim('Property of ') + c.gold(BRAND.company) + c.dim(' · ' + BRAND.companyUrl),
    line,
    '',
  ].join('\n');
}

module.exports = { BRAND, banner, c };
