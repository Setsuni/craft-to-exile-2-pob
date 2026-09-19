/* Where the page actually spends its time.
 *
 * The engine turned out not to be the problem - a full sheet recompute is
 * 0.1ms. What costs is repainting, so this times each paint separately.
 *
 *   node perf.js [docs/index.html]
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(process.argv[2] || 'docs/index.html', 'utf8');
const t0 = Date.now();
const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
      get: (t, k) => k === 'canvas' ? { width: 900, height: 600 }
        : k === 'createPattern' ? () => ({})
        : k === 'measureText' ? () => ({ width: 10 })
        : (t[k] === undefined ? () => {} : t[k]),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    w.Image = class { set src(_) {} };
  },
});

setTimeout(() => {
  const w = dom.window;
  console.log('initial load'.padEnd(24), (Date.now() - t0) + 'ms');

  function time(label, expr, n) {
    n = n || 20;
    const t = Date.now();
    w.eval('(function(){for(let i=0;i<' + n + ';i++){' + expr + '}})()');
    const ms = (Date.now() - t) / n;
    console.log(label.padEnd(24), ms.toFixed(2) + 'ms');
  }

  console.log('\n--- engine ---');
  time('recompute full sheet', 'recompute(perkList(), currentContribs(), charLevel, auraContribs());', 20);
  time('damageStack', 'damageStack(SK.spells.double_strike, "physical", live);', 100);
  time('skillDps', 'skillDps("double_strike", 20, []);', 50);

  console.log('\n--- paints ---');
  time('paintSidebar', 'paintSidebar();', 20);
  time('paintPoints', 'paintPoints();', 50);
  time('paintCalcs', 'paintCalcs();', 20);
  time('paintAll (items)', 'paintAll();', 10);
  time('paintSkills', 'paintSkills();', 10);
  time('paintClasses', 'paintClasses();', 20);
  time('paintBreakdown', 'paintBreakdown();', 20);
  time('draw (tree)', 'draw();', 20);
  time('apply (everything)', 'apply();', 10);

  console.log('\n--- sizes ---');
  console.log('spell options per card  ', w.eval('document.querySelectorAll(".spellsel")[0].options.length'));
  console.log('slot cards              ', w.eval('document.querySelectorAll("#skills .slotcard").length'));
  console.log('affix options (prefix)  ', w.eval('document.querySelectorAll("#list-pre select")[0].options.length'));
  console.log('calcs rows              ', w.eval('document.querySelectorAll("#t tbody tr.row").length'));
  console.log('tree nodes / damage stats',
    w.eval('T.nodes.length') + ' / ' + w.eval('Object.keys(DMG.stats).length'));
}, 1200);
