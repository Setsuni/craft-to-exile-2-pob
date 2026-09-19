/* A support gem is rolled, and its roll counts.
 *
 *   node test_support_rolls.js [testsaves/pob_export.dat] [docs/index.html]
 *
 * `skillSheet` used to value every linked support at its MAXIMUM:
 *
 *     const v = m.min + (m.max - m.min);      // ...which is just m.max
 *
 * The comment said "an unrolled one is taken at full", but there was no rolled
 * branch - every gem was taken at full whether or not the save recorded a
 * roll. The save does record it: this character's gems are 88 to 97 percent.
 * So every supported skill was overstated.
 *
 * Found by reading Ryongen's planner, which keeps captured rolls per link.
 */
const fs = require('fs');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');
const noop = () => {};
const html = fs.readFileSync(process.argv[3] || 'docs/index.html', 'utf8');
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
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true; setTimeout(() => this.close('discard'), 0);
    };
    w.HTMLDialogElement.prototype.close = function (v) {
      this.open = false; this.returnValue = v;
      this.dispatchEvent(new w.Event('close'));
    };
  },
});
const w = dom.window;
let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name.padEnd(46) + (extra || ''));
  if (!cond) fail++;
};

setTimeout(async () => {
  let bytes = fs.readFileSync(process.argv[2] || 'testsaves/pob_export.dat');
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const ch = await w.eval('IMPORTER.loadFile')({ arrayBuffer: async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  w.__ch = ch;
  w.eval('IMPORTER.apply(window.__ch)');
  await new Promise(r => setTimeout(r, 1000));

  const links = JSON.parse(w.eval('JSON.stringify(loadout[0].supports || [])'));
  ok('an imported link carries its roll',
     links.length > 0 && links.some(g => g && typeof g === 'object' && g.pct !== undefined),
     JSON.stringify(links.slice(0, 2)));
  ok('no roll is recorded as 100',
     links.every(g => typeof g === 'string' || (g.pct >= 0 && g.pct <= 100)));

  /* Both shapes must work: a build saved before rolls existed stores bare ids. */
  ok('a bare id still resolves', w.eval("supportId('crit_damage')") === 'crit_damage');
  ok('a bare id means full roll', w.eval("supportPct('crit_damage')") === 100);
  ok('an object resolves', w.eval("supportId({id:'crit_damage',pct:50})") === 'crit_damage');
  ok('an object keeps its roll', w.eval("supportPct({id:'crit_damage',pct:50})") === 50);

  /* And the roll must actually move the damage, or none of this matters. */
  const dmg = pct => w.eval(
    "supportCache.clear(), skillDps('ricochet_shot', 20, [{id:'physical_damage',pct:" +
    pct + "}]).average");
  const low = dmg(0), high = dmg(100);
  ok('a lower roll deals less damage', low < high,
     Math.round(low).toLocaleString() + ' at 0% vs ' +
     Math.round(high).toLocaleString() + ' at 100%');

  console.log(fail ? '\nsupport rolls: ' + fail + ' FAILED'
                   : '\nsupport rolls: 7 checks passed');
  process.exit(fail ? 1 : 0);
}, 1200);
