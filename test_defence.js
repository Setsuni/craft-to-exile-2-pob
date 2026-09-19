/* Defence, checked against an independent oracle.
 *
 *   node test_defence.js [docs/index.html]
 *
 * Shawn cannot test this in game. Every mob hits for a different amount with a
 * different mix of elements, and nothing in the client reports the RAW size of
 * an incoming hit before mitigation - so there is no measurement to compare a
 * maximum-hit figure against, the way a dummy parse anchors DPS.
 *
 * That leaves two things that are still worth more than an opinion:
 *
 *   1. ANALYTICAL CASES. Situations whose answer is arithmetic, not
 *      observation: 100 health and nothing else dies to a hit of 100. These
 *      are written from the mechanics, not from the engine, so agreeing with
 *      them is evidence rather than a tautology.
 *
 *   2. PROPERTIES. Things that must hold for EVERY build, whatever the
 *      numbers - more resistance never lowers your maximum hit, the unavoided
 *      figure is never larger than the average one. These catch the errors
 *      that a handful of examples walk straight past, and they are checked
 *      over randomised sheets rather than chosen ones.
 *
 * What this cannot do is prove the LAYER ORDER or the stat set is right. Those
 * come from the installed 6.4.13 bytecode, and if that reading is wrong the
 * oracle inherits the mistake. It is stated here so nobody mistakes a green
 * run for a validated model.
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

function ok(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name.padEnd(52) + (extra || ''));
  if (!cond) fail++;
}
function near(name, got, want, tol) {
  const good = Math.abs(got - want) <= (tol === undefined ? 0.01 : tol);
  ok(name, good, good ? '' : got.toFixed(3) + ' want ' + want);
}

/* A sheet with only the stats a case names. Everything else is zero, so each
   case states its whole world and nothing leaks in from a real character. */
function sheetOf(stats) {
  w.__stats = stats;
  return w.eval('(function(s){ return { total: function(k){ return s[k] || 0; },' +
                ' moreOf: function(){ return 1; } }; })(window.__stats)');
}
function rows(stats, attacker) {
  w.__sheet = sheetOf(stats);
  w.__att = attacker || { level: 100 };
  return JSON.parse(w.eval(
    'JSON.stringify(defenceRows({ sheet: window.__sheet, attacker: window.__att }))'));
}
const row = (stats, element, attacker) =>
  rows(stats, attacker).find(r => r.element === element);

setTimeout(() => {
  /* ---- analytical cases ------------------------------------------------ */

  near('bare 100 health dies to a hit of 100',
       row({ health: 100 }, 'fire').maxHit, 100);

  /* 75% resistance quarters the hit, so it takes four times as much to kill. */
  near('100 health at 75% fire resist survives 400',
       row({ health: 100, fire_resist: 75 }, 'fire').maxHit, 400);

  /* Resistance is capped at 75 unless max_<ele>_resist raises it, so 200%
     resistance is worth exactly the same as 75%. */
  near('resistance above the cap is wasted',
       row({ health: 100, fire_resist: 200 }, 'fire').maxHit, 400);
  near('max_fire_resist raises the cap',
       row({ health: 100, fire_resist: 200, max_fire_resist: 5 }, 'fire').maxHit, 500);
  /* And the cap itself stops at 90. */
  near('the cap stops at 90',
       row({ health: 100, fire_resist: 200, max_fire_resist: 50 }, 'fire').maxHit, 1000);

  /* The shield absorbs before health, so it simply adds to the pool... */
  near('the shield adds to the pool',
       row({ health: 100, magic_shield: 900 }, 'fire').maxHit, 1000);

  /* ...except against chaos, where CHAOS_BYPASS_PERCENT = 50 sends half the
     hit straight past it. Health runs out first, so the pool is 2 x health. */
  near('half of chaos bypasses the shield',
       row({ health: 100, magic_shield: 900 }, 'chaos').maxHit, 200);
  near('chaos_doesnt_bypass_magic_shield restores the full pool',
       row({ health: 100, magic_shield: 900, chaos_doesnt_bypass_magic_shield: 1 },
           'chaos').maxHit, 1000);
  /* With a small shield the bypass does not bind - the shield empties first. */
  near('a shield smaller than health is not capped by the bypass',
       row({ health: 100, magic_shield: 50 }, 'chaos').maxHit, 150);

  /* A chance to reduce damage does nothing for the hit that lands. */
  const supp = row({ health: 100, dmg_reduction_chance: 100 }, 'fire');
  near('a suppression CHANCE never raises the maximum hit', supp.maxHit, 100);
  near('...but it does raise effective health', supp.effectiveHealth, 200);

  /* ---- properties, over randomised sheets ------------------------------ */

  let monotonic = true, ordered = true, finite = true;
  const ELEMENTS = ['physical', 'fire', 'water', 'lightning', 'chaos'];
  for (let i = 0; i < 300; i++) {
    const stats = {
      health: 1 + Math.random() * 5000,
      magic_shield: Math.random() < 0.3 ? 0 : Math.random() * 20000,
      dmg_reduction: Math.random() * 60,
      dmg_reduction_chance: Math.random() * 100,
      armor: Math.random() < 0.5 ? 0 : Math.random() * 5000,
    };
    ELEMENTS.forEach(e => { stats[e + '_resist'] = Math.random() * 120 - 20; });
    const all = rows(stats);
    all.forEach(r => {
      /* Avoidance can only help on average, never on the landed hit. */
      if (!(r.takenUnavoided >= r.taken - 1e-9)) ordered = false;
      if (!(r.effectiveHealth >= r.maxHit - 1e-6)) ordered = false;
      if (!Number.isFinite(r.maxHit) || r.maxHit <= 0) finite = false;
      /* More resistance must never make you die to a smaller hit. */
      const more = Object.assign({}, stats);
      more[r.element + '_resist'] = (stats[r.element + '_resist'] || 0) + 10;
      const after = row(more, r.element);
      if (after.maxHit < r.maxHit - 1e-6) monotonic = false;
    });
  }
  ok('more resistance never lowers the maximum hit', monotonic);
  ok('unavoided is never better than the average', ordered);
  ok('every maximum hit is finite and positive', finite);

  /* ---- the guard -------------------------------------------------------- */
  ok('nothing in this pack writes flat damage reduction',
     row({ health: 100 }, 'fire').unsupported === false,
     'so the closed form is exact');

  console.log(fail ? '\ndefence: ' + fail + ' FAILED'
                   : '\ndefence: all checks passed (analytical + 300 random sheets)');
  process.exit(fail ? 1 : 0);
}, 1200);
