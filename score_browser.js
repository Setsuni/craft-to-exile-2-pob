/* Score the BROWSER against a real .dat, the way a player actually loads one.
 *
 *   node score_browser.js [testsaves/pob_export.dat] [docs/index.html]
 *
 * This exists because measuring the browser is easy to get wrong. The page
 * opens as an EMPTY LEVEL-1 CHARACTER by design, so probing `live.total(...)`
 * straight after load reports that blank character: magic_find 0, resists 25%,
 * every gear stat absent. None of that is a bug, and it has been mistaken for
 * one more than once.
 *
 * So the harness does what a player does - feeds the .dat through
 * IMPORTER.loadFile and IMPORTER.apply - and only then compares against the
 * stats the game itself recorded in that same file.
 */
const fs = require('fs');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');

const datPath = process.argv[2] || 'testsaves/pob_export.dat';
const page = process.argv[3] || 'docs/index.html';
const noop = () => {};

/* Atlas perks are farming outcomes and never reach character power, so they
   are reported separately rather than counted as misses. `prophecy_*` belongs
   here too - prophecy coin find and double curse come from Atlas skills and
   passives and do not touch the character. */
const ATLAS_ONLY = /^(currency_find|map_find|map_rarity_bias|pack_size|omen_find|relic_find|watcher_eye_find|uber_fragment_find|boss_loot_quantity|additional_boss_chance|double_event_chance|duplicate_map_chance|mob_modifier_density|imprisoned_monster|strongbox_|harvest_|extra_drop_from_|mythic_monster_chance|event_focus_penalty|increased_quantity|magic_find|bonus_exp|prophecy_|jewel_find)/;

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
  },
});
const w = dom.window;

setTimeout(async () => {
  /* `nbt.js` un-gzips with DecompressionStream, which jsdom does not have -
     but its gunzip() passes plain data straight through, so decompressing
     here exercises exactly the same parse path a browser takes. */
  let bytes = fs.readFileSync(datPath);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  /* jsdom has File, but not always arrayBuffer() on it - hand the importer the
     smallest thing that satisfies the one method it calls. */
  const fakeFile = { arrayBuffer: async () => bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  let ch;
  try {
    ch = await w.eval('IMPORTER.loadFile')(fakeFile);
  } catch (e) {
    console.log('could not read ' + datPath + ': ' + e.message);
    process.exit(1);
  }
  w.__ch = ch;
  w.eval('IMPORTER.apply(window.__ch)');
  await new Promise(r => setTimeout(r, 900));
  if (w.eval('typeof applyNow === "function"')) w.eval('applyNow()');
  await new Promise(r => setTimeout(r, 400));

  const ref = ch.computed || {};
  const rows = Object.keys(ref).map(id => {
    const game = ref[id].v;
    const ours = w.eval("live.total('" + id + "')");
    return { id, game, ours, ok: Math.abs(game - ours) <= 0.01 };
  });
  const real = rows.filter(r => !ATLAS_ONLY.test(r.id));
  const atlas = rows.filter(r => !r.ok && ATLAS_ONLY.test(r.id));
  const ok = real.filter(r => r.ok).length;

  console.log('');
  console.log(datPath + '  (level ' + ch.level + ', loaded the way a player does)');
  console.log('   ' + ok + '/' + real.length + ' exact (' +
    (ok / real.length * 100).toFixed(1) + '%)   plus ' + atlas.length +
    ' atlas-only stats excluded by design');
  console.log('');
  real.filter(r => !r.ok)
    .sort((a, b) => Math.abs(b.game - b.ours) - Math.abs(a.game - a.ours))
    .forEach(r => console.log('      ' + r.id.padEnd(30) +
      ('game ' + r.game.toFixed(2)).padStart(17) +
      ('  ours ' + r.ours.toFixed(2)).padStart(18) +
      (r.game ? '   ' + (r.ours / r.game).toFixed(4) + 'x' : '')));
  /* Named explicitly because they are the ones that only appear once an
     active exile effect is applied - if these regress, the status-effect
     import path has broken. */
  ['projectile_count', 'dmg_reduction_chance'].forEach(id => {
    if (!ref[id]) return;
    const ours = w.eval("live.total('" + id + "')");
    console.log('   effect-driven: ' + id.padEnd(22) +
      ('game ' + ref[id].v.toFixed(2)).padStart(16) +
      ('  ours ' + ours.toFixed(2)).padStart(17) +
      (Math.abs(ref[id].v - ours) <= 0.01 ? '   exact' : '   MISS'));
  });
  console.log('');
  process.exit(0);
}, 1200);
