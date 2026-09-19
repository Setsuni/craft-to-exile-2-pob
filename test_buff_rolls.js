/* Buff strength, against numbers read off the game's own screen.
 *
 *   node test_buff_rolls.js [testsaves/pob_export.dat] [docs/index.html]
 *
 * An effect's value scales with the RANK of the spell granting it. The save
 * names that spell, but only for effects that were RUNNING when it was
 * written - so a buff the player had switched off had no known source and fell
 * back to a 100% roll, which made it too strong.
 *
 * Sharpen is the case that caught it: rank 85% was being treated as 100%, so
 * attack speed read 205.91 where the game shows 202.03.
 *
 * The three figures below were read off the character screen in game, so this
 * is a check against the game itself rather than against our own arithmetic.
 */
const fs = require('fs');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');
const noop = () => {};

const datPath = process.argv[2] || 'testsaves/pob_export.dat';
const page = process.argv[3] || 'docs/index.html';
const html = fs.readFileSync(page, 'utf8');
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
const ok = (name, got, want, tol) => {
  const good = Math.abs(got - want) <= (tol === undefined ? 0.01 : tol);
  console.log((good ? '  ok   ' : '  FAIL ') + name.padEnd(34) +
    'ours ' + got.toFixed(2).padStart(8) + '   game ' + String(want).padStart(7));
  if (!good) fail++;
};

setTimeout(async () => {
  let bytes = fs.readFileSync(datPath);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const ch = await w.eval('IMPORTER.loadFile')({ arrayBuffer: async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  w.__ch = ch;
  w.eval('IMPORTER.apply(window.__ch)');
  await new Promise(r => setTimeout(r, 900));

  const withBuffs = async on => {
    w.eval('Object.keys(effectStacks).forEach(k => effectStacks[k] = 0)');
    Object.entries(on).forEach(([k, v]) => w.eval("effectStacks['" + k + "']=" + v));
    /* Hunter's Focus was genuinely up when the save was written. */
    w.eval("effectStacks['hunters_focus']=1");
    w.eval('applyNow()');
    await new Promise(r => setTimeout(r, 250));
    return w.eval("live.total('attack_speed')");
  };

  /* The defaults the planner picks on its own, before anything is touched:
     a binary buff from an equipped skill is assumed up, anything that stacks
     starts at zero because how many you are holding is a choice. */
  const onAtLoad = JSON.parse(w.eval(
    "JSON.stringify(Object.entries(effectStacks).filter(([k,v])=>v).map(([k,v])=>k).sort())"));
  const expected = ['focus', 'hunters_focus', 'mirror_image', 'sharpen'];
  console.log((JSON.stringify(onAtLoad) === JSON.stringify(expected) ? '  ok   ' : '  FAIL ') +
    'skill buffs default on'.padEnd(34) + onAtLoad.join(', '));
  if (JSON.stringify(onAtLoad) !== JSON.stringify(expected)) fail++;
  /* Spirit stacks to 20 and must NOT default on, or the character silently
     gains +20 move speed it may never be holding. */
  ok('move speed, Spirit not assumed',
     w.eval("live.total('move_speed')"), 4.84);
  ok('attack speed as the planner opens',
     w.eval("live.total('attack_speed')"), 275, 0.5);

  ok('unbuffed', await withBuffs({}), 141.33);
  ok('Sharpen only', await withBuffs({ sharpen: 1 }), 202.03);
  /* Smoke Bomb grants no attack speed - it is not in the effect list at all -
     so the player's 275 is Sharpen plus Mirror Image, and the game's tooltip
     rounds to a whole number. */
  ok('Sharpen + Mirror Image', await withBuffs({ sharpen: 1, mirror_image: 1 }), 275, 0.5);

  console.log(fail ? '\nbuff rolls: ' + fail + ' FAILED'
                   : '\nbuff rolls: 6 checks passed, against in-game readings');
  process.exit(fail ? 1 : 0);
}, 1200);
