/* Opening a slot must not change a single number.
 *
 *   node test_reconstruction.js [testsaves/pob_export.dat] [docs/index.html]
 *
 * This is the invariant that "Equip to slot" has been quietly protecting. An
 * imported character's stats come from the resolved save; the moment you open
 * a slot in the editor, that slot's numbers come from `draftFromGear()`
 * rebuilding the item from its affix lines instead. If the rebuild is not
 * exact, looking at an item silently changes your build.
 *
 * We have had two of those already - the rune-family bug and the jewel
 * double-count - and both were invisible for exactly this reason. So before
 * Equip/Unequip can go, every slot has to survive being opened.
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

setTimeout(async () => {
  let bytes = fs.readFileSync(datPath);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const ch = await w.eval('IMPORTER.loadFile')({ arrayBuffer: async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  w.__ch = ch;
  w.eval('IMPORTER.apply(window.__ch)');
  await new Promise(r => setTimeout(r, 900));

  const sheet = () => JSON.parse(w.eval(
    'JSON.stringify(Object.fromEntries(' +
    '  Array.from(new Set([].concat(Object.keys(live.flat), Object.keys(live.perc),' +
    '    Object.keys(live.more), Object.keys(live.final))))' +
    '    .map(k => [k, live.total(k)])))'));

  const before = sheet();
  const slots = JSON.parse(w.eval('JSON.stringify(Object.keys(custom))'));
  console.log('  ' + slots.length + ' configured slots, ' +
    Object.keys(before).length + ' stats on the sheet');

  for (const sl of slots) {
    /* Exactly what clicking the slot button does. */
    w.eval('keepEditorDraft(); cur = JSON.parse(JSON.stringify(' +
           'Object.assign({slot:' + JSON.stringify(sl) + '}, custom[' +
           JSON.stringify(sl) + '])));');
    w.eval('applyNow()');
    await new Promise(r => setTimeout(r, 30));
    const after = sheet();
    const moved = Object.keys(before).filter(k =>
      Math.abs((before[k] || 0) - (after[k] || 0)) > 0.005);
    if (moved.length) {
      fail++;
      console.log('  FAIL opening ' + sl + ' moved ' + moved.length + ' stats');
      moved.slice(0, 6).forEach(k => console.log('         ' + k.padEnd(28) +
        before[k].toFixed(4).padStart(14) + ' -> ' + after[k].toFixed(4)));
    } else {
      console.log('  ok   ' + sl.padEnd(10) + ' opened, nothing moved');
    }
  }

  /* The roll display, on a real item. The crafted roll is 0-100 on the base;
     quality is added on top and lifts the whole range, so the printed value
     must sit INSIDE the range shown beside it - that was wrong in the first
     cut, with 558 printed against a range ending at 505. */
  w.eval("cur = JSON.parse(JSON.stringify(Object.assign({slot:'chest'}, custom.chest))); paintCard();");
  const card = w.document.getElementById('itemcard');
  const rolls = Array.from(card.querySelectorAll('.roll'));
  const ok2 = (name, cond) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + name);
    if (!cond) fail++;
  };
  ok2('rolled stats show their range', rolls.length > 0);
  ok2('every roll has a bar',
      rolls.every(r => r.querySelector('.rollbar i')));

  let outside = 0, checked = 0;
  card.querySelectorAll('.aff').forEach(row => {
    const r = row.querySelector('.roll');
    if (!r) return;
    const m = /(-?[0-9.]+)–(-?[0-9.]+)/.exec(r.textContent);
    const val = parseFloat(String(row.textContent).replace(/^\s*\+?/, ''));
    if (!m || !Number.isFinite(val)) return;
    checked++;
    if (val < parseFloat(m[1]) - 0.05 || val > parseFloat(m[2]) + 0.05) outside++;
  });
  ok2('every value sits inside its own range (' + checked + ' checked)', outside === 0);

  console.log(fail ? '\nreconstruction: ' + fail + ' FAILED'
                   : '\nreconstruction: every slot survives being opened, rolls render');
  process.exit(fail ? 1 : 0);
}, 1200);
