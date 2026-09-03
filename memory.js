'use strict';
/**
 * Keeping Chromium honest about memory.
 *
 * The bot itself is small. WhatsApp Web is not: it holds a model of every chat
 * on the account, and every avatar, thumbnail and preview it has ever drawn,
 * inside one long-lived renderer. On an account with hundreds of chats that
 * climbs for days and never really comes back down, because nothing on the
 * page is under memory pressure — a headless tab is never backgrounded, never
 * discarded, and never asked to give anything up.
 *
 * So we ask, on a timer:
 *
 *   • Above the soft mark, force a garbage collection in the page. This is the
 *     same collection Chrome runs when a device is low on memory, and it is
 *     free — nothing is discarded that the page still refers to.
 *   • Above the hard mark, purge V8's caches as well. Heavier, and the page
 *     rebuilds what it needs, but the alternative at this point is a restart.
 *   • Still above the hard mark, and nothing in flight: exit, and let the
 *     supervisor start a clean process. The login lives on disk, so this costs
 *     a few seconds of downtime and nothing else.
 *
 * What this deliberately does NOT do is set a memory limit on the container.
 * A cgroup cap kills Chromium's renderer outright; the page reloads, the
 * library re-authenticates, and after enough of that WhatsApp unlinks the
 * device. Reclaiming early beats being killed late.
 */
const fs = require('fs');
const os = require('os');

const MB = 1024 * 1024;

/* ── Reading what we are actually using ──────────────────────────────────── */

/**
 * The container's own accounting, cgroup v2 first and then v1.
 *
 * `memory.current` counts the page cache too, which is reclaimable and would
 * make an idle bot look enormous, so the clean-file part is taken back off.
 */
function parseCgroup(currentText, statText) {
  const total = Number(String(currentText).trim());
  if (!Number.isFinite(total) || total <= 0) return 0;

  let cache = 0;
  for (const line of String(statText || '').split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    // v2 calls it inactive_file; v1 prefixes it with the hierarchy total.
    if (key === 'inactive_file' || key === 'total_inactive_file') cache = Number(value) || 0;
  }
  return Math.max(0, total - cache);
}

function cgroupBytes() {
  for (const [file, statFile] of [
    ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.stat'],
    ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.stat'],
  ]) {
    let current;
    try { current = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let stat = '';
    try { stat = fs.readFileSync(statFile, 'utf8'); } catch { /* the raw number is close enough */ }
    const bytes = parseCgroup(current, stat);
    if (bytes) return bytes;
  }
  return 0;
}

/**
 * Fallback for a bot running straight on a host under PM2, where there is no
 * cgroup to read: add up this process and every Chromium it started.
 */
function processTreeBytes() {
  const pageSize = 4096;
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return process.memoryUsage().rss; }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
    const mine = Number(entry) === process.pid;
    if (!mine && !cmd.includes('chrom')) continue;
    try {
      const resident = Number(fs.readFileSync(`/proc/${entry}/statm`, 'utf8').split(' ')[1]);
      if (Number.isFinite(resident)) total += resident * pageSize;
    } catch { /* it exited while we looked */ }
  }
  return total || process.memoryUsage().rss;
}

/** What the bot and its browser are using right now, in bytes. */
function usedBytes() {
  return cgroupBytes() || processTreeBytes();
}

const asMb = (bytes) => Math.round(bytes / MB);

/* ── Asking the page to give memory back ─────────────────────────────────── */

/**
 * One CDP session, reused. It dies with the page, so a failure here is a
 * reason to drop it and open a new one next time, never a reason to stop.
 */
function sweeper({ client, log }) {
  let session = null;

  async function connect() {
    if (session) return session;
    const page = client.pupPage;
    if (!page || page.isClosed()) return null;
    session = await page.target().createCDPSession();
    return session;
  }

  async function send(method) {
    try {
      const cdp = await connect();
      if (!cdp) return false;
      await cdp.send(method);
      return true;
    } catch (e) {
      // A closed session, a navigated page, a method this Chromium does not
      // have — all the same answer: forget it and try again next time.
      session = null;
      log(`memory: ${method} did not run (${e.message})`);
      return false;
    }
  }

  return {
    collect: () => send('HeapProfiler.collectGarbage'),
    purge: () => send('Memory.forciblyPurgeJavaScriptMemory'),
  };
}

/* ── How much room there is ──────────────────────────────────────────────── */

/**
 * What this container is allowed to use.
 *
 * The cgroup limit if one is set, otherwise the whole machine. An unlimited
 * cgroup reports a number the size of the address space, so anything absurd is
 * treated as "no limit" and the host total is used instead.
 */
function availableBytes() {
  for (const file of [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ]) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { continue; }
    const limit = Number(raw);
    if (Number.isFinite(limit) && limit > 0 && limit < os.totalmem() * 4) return limit;
  }
  return os.totalmem();
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Where to sweep and where to give up, for THIS machine.
 *
 * These were hardcoded at 650MB and 1000MB, which is about right for the 1-2GB
 * VPS the bot was written on and plainly wrong anywhere else: on a 6GB box it
 * meant a garbage collection every five minutes, forever, over a browser that
 * was using an eighth of the machine and bothering nobody. The marks are the
 * machine's size now, with floors so a tiny box still gets swept and ceilings
 * so a big one does not sit on two gigabytes of dead chat list.
 */
function defaultMarks(total = availableBytes()) {
  const mb = total / MB;
  const soft = Math.round(clamp(mb * 0.30, 400, 1500));
  const hard = Math.round(clamp(mb * 0.50, 650, 2500));
  // A hard mark at or below the soft one would restart on the first sweep.
  return { soft, hard: Math.max(hard, soft + 250) };
}

/* ── The watcher ─────────────────────────────────────────────────────────── */

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Watch memory and act on it.
 *
 * @param client   the whatsapp-web.js client, for its page
 * @param log      plain logger
 * @param note     dashboard-visible logger, used only when something happens
 * @param isIdle   () => boolean — false while anything is mid-send
 * @param read     how to measure; injected by the tests, real reading by default
 * @param exit     how to leave; injected by the tests
 * @param settleMs how long to let the renderer hand pages back before judging
 */
function watchMemory({
  client, log, note,
  isIdle = () => true,
  read = usedBytes,
  exit = (code) => process.exit(code),
  settleMs = 5000,
}) {
  const marks = defaultMarks();
  const softMb = num(process.env.MEM_SOFT_MB, marks.soft);
  const hardMb = Math.max(num(process.env.MEM_HARD_MB, marks.hard), softMb + 100);
  const everyMs = num(process.env.MEM_CHECK_MINUTES, 5) * 60_000;
  const mayRestart = String(process.env.MEM_RESTART || 'on').toLowerCase() !== 'off';

  const sweep = sweeper({ client, log });
  let last = { bytes: 0, at: 0, sweptAt: 0 };
  let checking = false;
  let complainedAt = 0;
  const COMPLAIN_EVERY = 60 * 60_000;

  async function tick() {
    // A sweep settles for a few seconds; on a slow box the next timer could
    // otherwise land on top of it and measure a page mid-collection.
    if (checking) return;
    checking = true;
    try {
      await run();
    } finally {
      checking = false;
    }
  }

  async function run() {
    const before = read();
    last = { ...last, bytes: before, at: Date.now() };
    if (asMb(before) < softMb) return;

    await sweep.collect();
    if (asMb(read()) >= hardMb) await sweep.purge();

    // Give the renderer a moment to hand the pages back before judging it.
    await new Promise((r) => setTimeout(r, settleMs));
    const after = read();
    last = { bytes: after, at: Date.now(), sweptAt: Date.now() };
    log(`memory: ${asMb(before)}MB -> ${asMb(after)}MB after a sweep`);

    if (asMb(after) < hardMb) return;

    if (!mayRestart) {
      // Once an hour. Every five minutes would be the whole activity list.
      if (Date.now() - complainedAt > COMPLAIN_EVERY) {
        complainedAt = Date.now();
        note(`Memory is at ${asMb(after)}MB and a sweep did not bring it down. MEM_RESTART is off, so nothing was done about it.`);
      }
      return;
    }
    if (!isIdle()) {
      log('memory: over the hard mark, but something is mid-send — leaving it for the next check');
      return;
    }

    note(`Memory reached ${asMb(after)}MB and would not come down. Restarting clean — the login is saved, so this only costs a few seconds.`);
    // Exit rather than reload: re-initialising in place leaves the old
    // Chromium behind, and two of those is the problem twice over.
    client.destroy().catch(() => {}).finally(() => exit(0));
  }

  log(`memory: ${asMb(availableBytes())}MB available — sweeping above ${softMb}MB, `
    + `${mayRestart ? `restarting above ${hardMb}MB` : 'restarts disabled'}, every ${everyMs / 60_000}min`);

  const timer = setInterval(() => {
    tick().catch((e) => log('memory check failed:', e.message));
  }, everyMs);
  timer.unref?.();

  return {
    /** Run a check now rather than waiting for the timer. */
    check: tick,
    /** For the dashboard. Cheap — no CDP, just a file read. */
    status: () => ({
      usedMb: asMb(last.bytes || read()),
      softMb,
      hardMb,
      lastSweep: last.sweptAt || null,
    }),
    stop: () => clearInterval(timer),
  };
}

module.exports = { watchMemory, usedBytes, asMb, parseCgroup, defaultMarks, availableBytes };
