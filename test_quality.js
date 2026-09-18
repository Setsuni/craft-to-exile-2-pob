/* Gear quality.
 *
 *   node test_quality.js [docs/index.html]
 *
 * Quality is applied by the game as a straight addition to the base-stat ROLL
 * PERCENTILE, not as a multiplier on the result:
 *
 *   BaseStatsData.GetAllStats:  int p = (int)(this.p + gear.getQualityBaseStatsBonus(stack));
 *   ExactStatData.fromStatModifier: v1 = min + (max - min) * percent / 100F;
 *
 * Note the second line has no clamp. A 95% roll with 20 quality is evaluated
 * at 115%, which lands ABOVE the best natural roll - so quality is not just a
 * way to reach the maximum, it is a way past it. Anything that clamps the
 * percentile to 100 silently caps geared characters.
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
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};
const wd = (pct, q) => w.eval(
  "IE.statsOf({base:'crossbow',ilvl:100,basePct:" + pct + ",quality:" + q +
  ",affixes:[]}).find(s=>s.stat==='weapon_damage').value");

setTimeout(() => {
  const at0 = wd(0, 0), at100 = wd(100, 0), span = at100 - at0;
  ok('a base stat spans its roll range', span > 0, at0.toFixed(2) + ' .. ' + at100.toFixed(2));

  /* Quality N must equal rolling N percentile points higher. */
  ok('quality 20 on a 50% roll == a 70% roll',
     Math.abs(wd(50, 20) - wd(70, 0)) < 1e-6,
     wd(50, 20).toFixed(4) + ' vs ' + wd(70, 0).toFixed(4));

  /* The uncapped case: this is the one a clamp would break. */
  const past = wd(95, 20);
  ok('quality pushes a 95% roll PAST the natural maximum',
     past > at100, past.toFixed(2) + ' > ' + at100.toFixed(2));
  ok('...by exactly the right amount (115% of the range)',
     Math.abs(past - (at0 + span * 1.15)) < 1e-6,
     past.toFixed(4) + ' vs ' + (at0 + span * 1.15).toFixed(4));

  ok('quality 0 changes nothing', wd(80, 0) === wd(80, undefined));

  /* It has to survive a save/load round trip, or it silently resets. */
  w.eval("cur.base = 'crossbow'; cur.blank = false; cur.quality = 17;");
  const saved = w.eval("JSON.stringify(captureItems()[cur.slot] || {})");
  ok('quality is captured into the saved build', /"quality":17/.test(saved),
     saved.slice(0, 70));

  console.log(fail ? '\nquality: ' + fail + ' FAILED' : '\nquality: 6 checks passed');
  process.exit(fail ? 1 : 0);
}, 1200);
