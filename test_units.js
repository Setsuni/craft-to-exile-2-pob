/* Every number on an item card says what kind of number it is.
 *
 *   node test_units.js [docs/index.html]
 *
 * A modifier's type says PERCENT or MORE. A FLAT one says nothing, and for
 * most stats in the game that is misleading, because the STAT is itself a
 * percentage. Two flags in the registry mark that, and they are different:
 *
 *   is_perc      on an ordinary stat  - `archmage`
 *   data.perc    on a CONVERSION      - `magic_shield_per_perc_of_mana`
 *
 * The second was missed on the first pass, which left the tome reading
 * "+5 Gain of your Mana as Magic Shield" where it grants five PERCENT.
 *
 * And this is not a licence to add % everywhere: the game prints "+10
 * Electrify Chance" and "+30 Lightning Resistance" bare, and neither stat is
 * flagged, so they must stay bare here too.
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
const ok = (name, got, want) => {
  const good = got === want;
  console.log((good ? '  ok   ' : '  FAIL ') + name.padEnd(46) +
    JSON.stringify(got) + (good ? '' : '   want ' + JSON.stringify(want)));
  if (!good) fail++;
};

setTimeout(() => {
  const v = (n, type, sid) => w.eval('valText(' + n + ',' + JSON.stringify(type) +
    ',' + JSON.stringify(sid) + ')');

  /* Conversions - the ones Shawn caught on his tome. */
  ok('Gain of your Mana as Magic Shield',
     v(5, 'FLAT', 'magic_shield_per_perc_of_mana'), '+5%');
  ok('Gain of your Heal Strength as Skill Damage',
     v(20.6, 'FLAT', 'spell_damage_per_perc_of_increase_healing'), '+20.6%');

  /* An ordinary stat that IS a percentage. */
  ok('archmage, percent of mana as damage', v(6, 'FLAT', 'archmage'), '+6%');

  /* Stats the GAME prints bare must stay bare. */
  ok('electrify chance stays bare', v(10, 'FLAT', 'electrify_chance'), '+10');
  ok('lightning resistance stays bare', v(30, 'FLAT', 'lightning_resist'), '+30');
  /* "per 10" says its own unit in its name. */
  ok('armor per 10 mana stays bare', v(2, 'FLAT', 'armor_per_10_mana'), '+2');

  /* The two modifier types players plan around stay distinguishable: an
     increase is additive and signed, a MORE is its own multiplier. */
  ok('an increase reads signed', v(17.3, 'PERCENT', 'mana'), '+17.3%');
  ok('a more reads as more', v(25, 'MORE', 'magic_shield'), '25% more');

  console.log(fail ? '\nunits: ' + fail + ' FAILED' : '\nunits: 8 checks passed');
  process.exit(fail ? 1 : 0);
}, 1200);
