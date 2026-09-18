/* Load the built page in jsdom and fail on any runtime error.
 *
 * A stale `document.getElementById('bname')` once shipped a page that parsed
 * cleanly and then threw on load, blanking every panel. Syntax checks do not
 * catch that; actually running the page does.
 *
 *   node smoke.js <path-to-built-html>
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const file = process.argv[2];
if (!file) { console.error('usage: node smoke.js <built.html>'); process.exit(2); }
const html = fs.readFileSync(file, 'utf8');

const errors = [];

/* Canvas is not implemented in bare jsdom, and the stub has to be in place
   BEFORE the page's scripts run - they call getContext at parse time. */
const noop = () => {};
function stubCanvas(window) {
  window.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, {
      get: (t, k) => {
        if (k === 'canvas') return { width: 800, height: 600 };
        if (k === 'createPattern') return () => ({});
        if (k === 'measureText') return () => ({ width: 10 });
        return t[k] === undefined ? noop : t[k];
      },
      set: (t, k, v) => { t[k] = v; return true; },
    });
  };
  window.Image = class { set src(_) { /* never fires onload in jsdom */ } };
  window.addEventListener('error', e => errors.push('window error: ' + e.message));
}

const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse: stubCanvas,
  virtualConsole: new (require('jsdom').VirtualConsole)()
    .on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e).toString()))
    .on('error', (...a) => errors.push('console.error: ' + a.join(' '))),
});

const { window } = dom;

setTimeout(() => {
  const w = window, d = window.document;
  const checks = [
    ['sidebar stats rendered', d.querySelectorAll('#side .stat').length > 20],
    ['talent point counter', /talent points/.test(d.getElementById('pts').textContent)],
    ['calcs rows', d.querySelectorAll('#t tbody tr.row').length > 40],
    ['accuracy banner', /\d+\/\d+/.test(d.getElementById('vnum').textContent)],
    ['item slot rail', d.querySelectorAll('#slots .slotbtn').length >= 10],
    ['item card', d.getElementById('itemcard').innerHTML.length > 40],
    // The panel opens on whatever is equipped, which may be a unique or a
    // runeword - neither has affix pools. Select a normal item first so the
    // check tests the pools rather than the starting slot.
    ['affix dropdowns', (() => {
      /* Open the tab first: hidden tabs are now marked stale rather than
         repainted, and a slot can only be clicked while Items is on screen. */
      [...d.querySelectorAll('.tabs button')].find(b => b.dataset.v === 'items').click();
      const sl = [...d.querySelectorAll('.slotbtn')]
        .find(b => w.eval('(equippedBySlot["' + b.dataset.sl + '"]||{}).rarity') === 'mythic');
      if (sl) sl.click();
      return d.querySelectorAll('#list-pre select').length >= 3;
    })()],
    ['vanilla list', d.querySelectorAll('#van-list .card').length > 10],
    ['skills rendered', (() => {
      [...d.querySelectorAll('.tabs button')].find(b => b.dataset.v === 'skills').click();
      return d.querySelectorAll('#skills .card').length > 0;
    })()],
    /* A tab hidden while the build changes must catch up when it is opened. */
    ['hidden tabs catch up', (() => {
      [...d.querySelectorAll('.tabs button')].find(b => b.dataset.v === 'tree').click();
      w.eval('charLevel = 90; applyNow();');
      const stale = w.eval('staleTabs.size');
      [...d.querySelectorAll('.tabs button')].find(b => b.dataset.v === 'items').click();
      return stale > 0 && w.eval("!staleTabs.has('items')");
    })()],
    ['profile + level controls', !!d.getElementById('profile') && !!d.getElementById('clevel')],
    /* The save/load bar replaced the build-source line in the header. */
    ['build bar', !!d.getElementById('buildsel') && !!d.getElementById('buildsave')],
    ['custom modifiers box', !!d.getElementById('custbox')],
    // The class grid only renders once its tab is shown, so show it first.
    ['class grid', (() => {
      w.eval('paintClasses()');
      return d.querySelectorAll('#classgrids .cpanel .sock').length > 0 &&
             d.querySelectorAll('#classpick .classbtn').length === 12;
    })()],
    // Not a named skill: the bundle is built from whatever character was
    // exported, so assert the mechanism, not one build's spell list.
    ['skill ranks come from the class',
      w.eval('[...classSpells()].some(id => classRank(id) > 0)')],
    ['manual skill escape hatch', !!d.getElementById('manualadd')],
  ];

  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) { console.log('FAIL  ' + name); bad++; }
  }
  if (errors.length) {
    bad += errors.length;
    errors.slice(0, 6).forEach(e => console.log('ERROR ' + e));
  }
  console.log(bad
    ? '\nsmoke: ' + bad + ' problem(s) in ' + path.basename(file)
    : 'smoke: ' + checks.length + ' checks passed, no runtime errors');
  process.exit(bad ? 1 : 0);
}, 600);
