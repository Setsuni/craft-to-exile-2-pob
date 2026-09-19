/* Ailments - the damage a hit leaves behind.
 *
 *   node test_ailments.js [docs/index.html]
 *
 * The five are constructed in Java, not registered in any datapack, so the
 * table was transcribed by hand and the arithmetic on top of it is what can be
 * checked. These cases are written from `Ailments.java` and
 * `EntityAilmentData`, not from the engine, so agreeing with them is evidence.
 *
 * What is NOT settled, and is deliberately not asserted here: whether a second
 * application stacks, refreshes, or is ignored. That decides uptime, and
 * uptime is why the reported figure is labelled an estimate.
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const noop = () => {};

const html = fs.readFileSync(process.argv[2] || 'docs/index.html', 'utf8');
const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.org/',
  beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
      get: (t, k) => k === 'canvas' ? { width: 800, height: 600 }
        : k === 'measureText' ? () => ({ width: 10 })
        : k === 'createPattern' ? () => ({}) : (t[k] === undefined ? noop : t[k]),
      set: (t, k, v) => { t[k] = v; return true; } });
    w.Image = class { set src(_) {} };
    w.confirm = () => true;
  },
});
const w = dom.window;
let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name.padEnd(54) + (extra || ''));
  if (!cond) fail++;
};
const near = (name, got, want, tol) => {
  const good = Math.abs(got - want) <= (tol === undefined ? 0.01 : tol);
  ok(name, good, good ? '' : got.toFixed(3) + ' want ' + want);
};

function sheetOf(stats) {
  w.__stats = stats;
  return w.eval('(function(s){ return { total: function(k){ return s[k] || 0; },' +
                ' moreOf: function(){ return 1; } }; })(window.__stats)');
}
function rows(hit, rate, stats) {
  w.__sheet = sheetOf(stats || {});
  return JSON.parse(w.eval('JSON.stringify(ailmentsForHit(' + hit + ', ' + rate +
                           ', window.__sheet))'));
}
const one = (hit, rate, stats, id) => rows(hit, rate, stats).find(r => r.id === id);

setTimeout(() => {
  /* ---- the table itself ------------------------------------------------ */
  const table = JSON.parse(w.eval('JSON.stringify(B.ailments || {})'));
  ok('all five ailments ship', Object.keys(table).length === 5,
     Object.keys(table).join(', '));
  ok('burn, poison and bleed tick',
     table.burn.dot && table.poison.dot && table.bleed.dot);
  ok('freeze and electrify do not',
     !table.freeze.dot && !table.electrify.dot);

  /* ---- a damage-over-time ailment -------------------------------------- */

  /* Poison is 150% of the hit spread over 200 ticks = 10 seconds. A hit of
     1000 therefore leaves 1500 over 10s, which is 150 a second. */
  const p = one(1000, 1, { poison_chance: 100 }, 'poison');
  near('poison spreads 150% of the hit over its duration', p.dps, 150);
  near('...for ten seconds', p.seconds, 10);
  near('...totalling 150% of the hit', p.total, 1500);

  /* Bleed is 120% over 100 ticks = 5s, so a 1000 hit is 240/s. */
  near('bleed is 120% over five seconds',
       one(1000, 1, { bleed_chance: 100 }, 'bleed').dps, 240);

  /* Burn is 100% over 60 ticks = 3s. The tick floor is 21, which does not
     bind here. */
  near('burn is 100% over three seconds',
       one(1000, 1, { burn_chance: 100 }, 'burn').dps, 1000 / 3, 0.001);

  /* `dot_speed` compresses the same total into less time, so the RATE rises
     and the total does not. */
  const fast = one(1000, 1, { poison_chance: 100, dot_speed: 100 }, 'poison');
  near('dot_speed doubles the rate', fast.dps, 300);
  near('...and halves the duration', fast.seconds, 5);
  near('...leaving the total alone', fast.total, 1500);

  /* Duration stretches the ticks, which lowers the rate but not the total. */
  const slow = one(1000, 1, { poison_chance: 100, poison_duration: 100 }, 'poison');
  near('duration stretches without changing the rate', slow.dps, 150);
  near('...so the total doubles', slow.total, 3000);

  /* ---- an accumulating ailment ----------------------------------------- */

  /* Freeze stores 85% of the hit and never ticks. Reporting a stored pool as
     continuous DPS would be a lie, so its dps is zero by construction. */
  const f = one(1000, 1, { freeze_chance: 100 }, 'freeze');
  near('freeze stores 85% of the hit', f.pool, 850);
  ok('a stored pool is not reported as DPS', f.dps === 0);
  near('and it decays 10% a second', f.decayPerSecond, 0.1);

  /* Duration slows the decay - the only thing it buys an ailment that never
     ticks. */
  near('duration slows the decay',
       one(1000, 1, { freeze_chance: 100, freeze_duration: 100 }, 'freeze')
         .decayPerSecond, 0.05);

  /* Electrify stores the whole hit. */
  near('electrify stores 100%',
       one(1000, 1, { electrify_chance: 100 }, 'electrify').pool, 1000);

  /* ---- chance and uptime ------------------------------------------------ */
  ok('an ailment with no chance is not listed',
     rows(1000, 1, { poison_chance: 0 }).length === 0);

  /* Uptime approaches 1 as applications become frequent, and the DPS with it,
     but never exceeds the ailment's own rate. */
  w.__sheet = sheetOf({ poison_chance: 100 });
  const dpsAt = rate => JSON.parse(w.eval(
    'JSON.stringify(ailmentDps(ailmentsForHit(1000, ' + rate + ', window.__sheet)))'));
  const rare = dpsAt(0.01).total, often = dpsAt(100).total;
  ok('more frequent application raises ailment DPS', often > rare,
     Math.round(rare) + ' -> ' + Math.round(often));
  ok('...but never past the ailment\'s own rate', often <= 150 + 1e-6,
     Math.round(often) + ' vs 150');

  console.log(fail ? '\nailments: ' + fail + ' FAILED'
                   : '\nailments: all checks passed');
  process.exit(fail ? 1 : 0);
}, 1200);
