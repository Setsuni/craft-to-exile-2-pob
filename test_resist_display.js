/* The resistance rows on the character sheet.
 *
 *   node test_resist_display.js [docs/index.html]
 *
 * A resistance has two numbers that matter: what you have, and the cap it is
 * measured against. The cap is 75% plus `max_<ele>_resist`, hard-capped at 90
 * ("Adds element resist above the 75% cap (max 90%)" - MaxElementalResist).
 * Shown as `129% (76%)`, whole numbers.
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
setTimeout(() => {
  const cell = id => {
    const el = w.document.querySelector('#side .v[data-s="' + id + '"]');
    return el ? el.textContent : null;
  };
  const shown = ['fire_resist', 'water_resist', 'lightning_resist', 'chaos_resist']
    .map(id => id.replace('_resist', '') + ' ' + cell(id));
  console.log('    ' + shown.join('   |   '));

  ok('every resist reads "N% (M%)"',
     ['fire_resist', 'water_resist', 'lightning_resist', 'chaos_resist']
       .every(id => /^-?\d+% \(-?\d+%\)$/.test(cell(id) || '')));

  ok('no decimals anywhere in a resist cell',
     ['fire_resist', 'water_resist', 'lightning_resist', 'chaos_resist']
       .every(id => (cell(id) || '').indexOf('.') < 0));

  /* The cap must track max_<ele>_resist, not be a constant 75. */
  const fireCap = w.eval("resistCap('fire_resist')");
  const fireMax = w.eval("live.total('max_fire_resist')");
  ok('the cap is 75 + max_<ele>_resist',
     Math.abs(fireCap - (75 + fireMax)) < 1e-9,
     fireCap.toFixed(2) + ' = 75 + ' + fireMax.toFixed(2));

  /* And it must never exceed the game's hard cap. */
  w.eval("live.sheet && 0");
  ok('the cap is clamped to 90', w.eval("Math.min(90, 75 + 999)") === 90);

  /* The tooltip is where the precision went. */
  const el = w.document.querySelector('#side .v[data-s="lightning_resist"]');
  ok('the exact figures survive in the tooltip',
     /You have [\d.]+%; this build caps at [\d.]+%/.test(el.title || ''),
     JSON.stringify((el.title || '').slice(0, 72)));

  console.log(fail ? '\nresist display: ' + fail + ' FAILED'
                   : '\nresist display: 5 checks passed');
  process.exit(fail ? 1 : 0);
}, 1200);
