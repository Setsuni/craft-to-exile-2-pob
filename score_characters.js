/* Score the planner against every reference character we have.
 *
 *   node score_characters.js [docs/index.html]
 *
 * A reference character is an exported build whose `context.computed` holds
 * the stats the GAME reported for it. Scoring against several at once is the
 * point: an error that shows on one character and not another is build
 * specific, and that is the strongest clue available short of the bytecode.
 *
 * Drop more of them in testsaves/others/ as people send them.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const page = process.argv[2] || 'docs/index.html';
const dir = 'testsaves/others';
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f))
  : [];

if (!files.length) {
  console.log('no reference characters in ' + dir);
  process.exit(0);
}

const noop = () => {};
function load() {
  const html = fs.readFileSync(page, 'utf8');
  return new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.org/',
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = function () {
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
      w.Image = class { set src(_) {} };
      w.confirm = () => true;
    },
  });
}

/* Stats the sheet excludes on purpose: Atlas perks are farming outcomes and
   never reach character power, so counting them as misses understates the
   model. They are reported separately rather than hidden. */
const ATLAS_ONLY = /^(currency_find|map_find|map_rarity_bias|pack_size|omen_find|relic_find|watcher_eye_find|uber_fragment_find|boss_loot_quantity|additional_boss_chance|double_event_chance|duplicate_map_chance|mob_modifier_density|imprisoned_monster|strongbox_|harvest_|extra_drop_from_|mythic_monster_chance|event_focus_penalty|increased_quantity|magic_find|bonus_exp|prophecy_)/;

function scoreOne(file, done) {
  const dom = load();
  const w = dom.window;
  setTimeout(() => {
    const build = JSON.parse(fs.readFileSync(file, 'utf8'));
    w.__b = build;
    try { w.eval('applyImported("character", window.__b)'); }
    catch (e) { console.log(path.basename(file) + ': could not apply - ' + e.message); return done(); }
    setTimeout(() => {
      const ref = (build.context || {}).computed || {};
      const rows = Object.keys(ref).map(id => {
        const game = ref[id].v;
        const ours = w.eval("live.total('" + id + "')");
        return { id, game, ours, ok: Math.abs(game - ours) <= 0.01 };
      });
      const atlas = rows.filter(r => !r.ok && ATLAS_ONLY.test(r.id));
      const real = rows.filter(r => !ATLAS_ONLY.test(r.id));
      const ok = real.filter(r => r.ok).length;
      console.log('');
      console.log(path.basename(file) + '  (' + (build.classes || []).join('/') + ')');
      console.log('   ' + ok + '/' + real.length + ' exact (' +
        (ok / real.length * 100).toFixed(1) + '%)   plus ' + atlas.length +
        ' atlas-only stats excluded by design');
      real.filter(r => !r.ok)
        .sort((a, b) => Math.abs(b.game - b.ours) - Math.abs(a.game - a.ours))
        .slice(0, 8)
        .forEach(r => console.log('      ' + r.id.padEnd(26) +
          ('game ' + r.game.toFixed(2)).padStart(16) +
          ('  ours ' + r.ours.toFixed(2)).padStart(17) +
          (r.game ? '   ' + (r.ours / r.game).toFixed(3) + 'x' : '')));
      done();
    }, 600);
  }, 1000);
}

let i = 0;
(function next() {
  if (i >= files.length) { console.log(''); return; }
  scoreOne(files[i++], next);
})();
