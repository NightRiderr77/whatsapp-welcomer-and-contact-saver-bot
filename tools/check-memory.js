/**
 * What the memory watcher must do, checked without a browser.
 *
 *   node tools/check-memory.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { watchMemory, usedBytes, asMb, parseCgroup, defaultMarks } = require(path.join(__dirname, '..', 'memory.js'));

const MB = 1024 * 1024;
let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

/** A watcher fed a scripted series of readings, with a fake page. */
function harness({ series, idle = true, restart = 'on', pageBroken = false, keepEnv = false }) {
  const calls = [];
  const notes = [];
  const logs = [];
  const exits = [];
  let i = 0;

  const client = {
    pupPage: {
      isClosed: () => false,
      target: () => ({
        createCDPSession: async () => ({
          send: async (method) => {
            if (pageBroken) throw new Error('Session closed');
            calls.push(method);
          },
        }),
      }),
    },
    destroy: async () => { calls.push('destroy'); },
  };

  if (!keepEnv) {
    process.env.MEM_SOFT_MB = '650';
    process.env.MEM_HARD_MB = '1000';
  }
  process.env.MEM_RESTART = restart;

  const w = watchMemory({
    client,
    log: (...a) => logs.push(a.join(' ')),
    note: (t) => notes.push(t),
    isIdle: () => idle,
    read: () => (series[Math.min(i++, series.length - 1)]) * MB,
    exit: (code) => exits.push(code),
    settleMs: 0,
  });
  return { w, calls, notes, logs, exits };
}

(async () => {
  console.log('memory watcher');

  /* Quiet: nothing is touched. */
  {
    const h = harness({ series: [400] });
    await h.w.check();
    assert.deepStrictEqual(h.calls, []);
    assert.deepStrictEqual(h.exits, []);
    assert.strictEqual(h.w.status().usedMb, 400);
    h.w.stop();
    ok('below the soft mark it does nothing at all');
  }

  /* Over soft, comes back down: collect only, no purge, no restart. */
  {
    const h = harness({ series: [800, 500, 500] });
    await h.w.check();
    assert.deepStrictEqual(h.calls, ['HeapProfiler.collectGarbage']);
    assert.deepStrictEqual(h.exits, []);
    assert.deepStrictEqual(h.notes, []);
    h.w.stop();
    ok('over the soft mark it collects garbage and stops there');
  }

  /* Over hard, comes back down: collect + purge, still no restart. */
  {
    const h = harness({ series: [1200, 1100, 700] });
    await h.w.check();
    assert.deepStrictEqual(h.calls,
      ['HeapProfiler.collectGarbage', 'Memory.forciblyPurgeJavaScriptMemory']);
    assert.deepStrictEqual(h.exits, []);
    h.w.stop();
    ok('over the hard mark it purges, and a purge that works avoids a restart');
  }

  /* Over hard and it will not come down: restart, cleanly. */
  {
    const h = harness({ series: [1200, 1200, 1200] });
    await h.w.check();
    await new Promise((r) => setImmediate(r));
    assert.ok(h.calls.includes('Memory.forciblyPurgeJavaScriptMemory'));
    assert.ok(h.calls.includes('destroy'), 'the client must be destroyed first');
    assert.deepStrictEqual(h.exits, [0], 'exit 0 so the supervisor restarts us');
    assert.ok(/Restarting clean/.test(h.notes.join(' ')), 'the owner is told why');
    h.w.stop();
    ok('memory that will not come down restarts the process');
  }

  /* Busy: never restart mid-send, however bad it looks. */
  {
    const h = harness({ series: [1500, 1500, 1500], idle: false });
    await h.w.check();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.exits, [], 'a broadcast must never be cut in half');
    assert.ok(/mid-send/.test(h.logs.join(' ')));
    h.w.stop();
    ok('it will not restart while something is mid-send');
  }

  /* MEM_RESTART=off: say so, do nothing. */
  {
    const h = harness({ series: [1500, 1500, 1500], restart: 'off' });
    await h.w.check();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.exits, []);
    assert.ok(/MEM_RESTART is off/.test(h.notes.join(' ')));
    h.w.stop();
    ok('MEM_RESTART=off reports the problem instead of acting on it');
  }

  /* A dead page must not take the bot with it. */
  {
    const h = harness({ series: [800, 800, 800], pageBroken: true });
    await h.w.check();
    await new Promise((r) => setImmediate(r));
    assert.ok(/did not run/.test(h.logs.join(' ')), 'the failure is logged');
    h.w.stop();
    ok('a CDP failure is logged and swallowed, never thrown');
  }

  /* The same complaint every five minutes would be the whole activity list. */
  {
    const h = harness({ series: [1500], restart: 'off' });
    await h.w.check();
    await h.w.check();
    await h.w.check();
    assert.strictEqual(h.notes.length, 1, 'got ' + h.notes.length + ' notes');
    h.w.stop();
    ok('a standing memory complaint is said once an hour, not every check');
  }

  /* Two checks must never overlap. */
  {
    const h = harness({ series: [1200, 1100, 700] });
    await Promise.all([h.w.check(), h.w.check()]);
    const sweeps = h.calls.filter((c) => c === 'HeapProfiler.collectGarbage').length;
    assert.strictEqual(sweeps, 1, 'the second check should have been skipped');
    h.w.stop();
    ok('a check that lands on top of a running one is skipped');
  }

  /* The marks follow the machine. They used to be 650/1000 everywhere, which
     on a 6GB box meant a garbage collection every five minutes forever. */
  {
    const small = defaultMarks(1 * 1024 * MB);
    const mid = defaultMarks(2 * 1024 * MB);
    const big = defaultMarks(5.786 * 1024 * MB);

    assert.deepStrictEqual(small, { soft: 400, hard: 650 }, JSON.stringify(small));
    assert.ok(mid.soft > small.soft && big.soft > mid.soft, 'bigger box, higher marks');
    assert.ok(big.soft >= 1500, 'a 6GB box should not sweep at 807MB: ' + big.soft);

    for (const total of [0.25, 0.5, 1, 2, 4, 8, 64]) {
      const m = defaultMarks(total * 1024 * MB);
      assert.ok(m.hard > m.soft, total + 'GB gave hard <= soft');
      assert.ok(m.soft >= 400 && m.hard <= 2500, total + 'GB left the bounds');
    }
    ok('the marks are read off the machine, with floors and ceilings that hold');
  }

  /* A hard mark set below the soft one would restart on the very first sweep. */
  {
    process.env.MEM_SOFT_MB = "900";
    process.env.MEM_HARD_MB = "300";
    const h = harness({ series: [100], keepEnv: true });
    await h.w.check();
    const st = h.w.status();
    assert.ok(st.hardMb > st.softMb, 'hard ' + st.hardMb + ' soft ' + st.softMb);
    h.w.stop();
    ok('a hard mark set below the soft one is pushed back above it');
  }

  /* Reading the cgroup: reclaimable page cache must not count against us. */
  {
    const v2 = parseCgroup('900000000\n',
      'anon 500000000\nfile 400000000\ninactive_file 300000000\n');
    assert.strictEqual(v2, 600000000);
    const v1 = parseCgroup('900000000\n', 'cache 400000000\ntotal_inactive_file 300000000\n');
    assert.strictEqual(v1, 600000000);
    assert.strictEqual(parseCgroup('900000000\n', ''), 900000000, 'no stat file: use the raw number');
    assert.strictEqual(parseCgroup('max\n', ''), 0, 'an unlimited cgroup is not an answer');
    ok('page cache is not counted as memory in use (cgroup v1 and v2)');
  }

  /* The real reader, on this machine. */
  {
    const bytes = usedBytes();
    assert.ok(bytes > 0, 'usedBytes returned ' + bytes);
    ok('the real reader returns something (' + asMb(bytes) + 'MB here)');
  }

  console.log('\n' + passed + ' checks passed.');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
