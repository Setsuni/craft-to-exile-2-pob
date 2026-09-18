/* ---- saving, loading and sharing builds ---------------------------------

   Builds live in this browser's localStorage, so everyone who opens the page
   has their own set. Nothing is shared until someone exports a file and sends
   it; there is no server and no common dataset.

   Two separate stores, because they answer different questions:

     character  tree + classes + ascendancy + items + skills + config
     atlas      the Atlas tree alone

   The Atlas tree is a farming plan rather than a character - it changes no
   stat on the sheet - so mixing it into a character build would mean you could
   not send someone your mapping strategy without also sending your gear.
*/
const STORE = { character: 'cte2pob.builds', atlas: 'cte2pob.atlas' };
const FORMAT = 1;

/* localStorage throws in a private window and returns nothing when site data
   is cleared, so every read and write is guarded and the page keeps working
   without it - you simply cannot save. */
function readStore(kind) {
  try { return JSON.parse(localStorage.getItem(STORE[kind]) || '{}') || {}; }
  catch (e) { return {}; }
}
function writeStore(kind, obj) {
  try { localStorage.setItem(STORE[kind], JSON.stringify(obj)); return true; }
  catch (e) { return false; }
}
const storageWorks = (() => {
  try {
    localStorage.setItem('cte2pob.probe', '1');
    localStorage.removeItem('cte2pob.probe');
    return true;
  } catch (e) { return false; }
})();

/* ---- what a build IS ---------------------------------------------------- */

const treeAlloc = name => [...((TREES[name] || {}).alloc || [])];
function setTreeAlloc(name, keys) {
  const t = TREES[name];
  if (!t) return;
  t.alloc = new Set(keys || []);
  /* `alloc` is a live binding into the active tree, so swapping the set on the
     object is not enough - the view has to be re-pointed at it. */
  if (view === name) useTree(name);
}

function serializeCharacter() {
  return {
    format: FORMAT,
    kind: 'character',
    pack: B.meta.pack,
    name: document.getElementById('profile').value || 'Unnamed build',
    level: charLevel,
    talents: treeAlloc('talents'),
    ascendancy: treeAlloc('ascendancy'),
    classes: (typeof classes === 'undefined' ? [] : classes).slice(),
    classAlloc: Object.assign({}, typeof classAlloc === 'undefined' ? {} : classAlloc),
    items: JSON.parse(JSON.stringify(typeof custom === 'undefined' ? {} : custom)),
    loadout: (typeof loadout === 'undefined' ? [] : loadout).map(l => ({
      spell: l.spell, supports: (l.supports || []).slice(),
      use: l.use || 'cast', procPct: l.procPct,
      rank: l.rank, linkOverride: l.linkOverride,
    })),
    augments: (typeof augments === 'undefined' ? [] : augments).map(a => ({
      id: a.id, perc: a.perc,
    })),
    manualSpells: typeof manualSpells === 'undefined' ? [] : [...manualSpells],
    effects: Object.assign({}, typeof effectStacks === 'undefined' ? {} : effectStacks),
    config: Object.assign({}, typeof cfg === 'undefined' ? {} : cfg),
  };
}

function applyCharacter(b) {
  if (!b || b.kind !== 'character') throw new Error('not a character build');
  if (b.name) document.getElementById('profile').value = b.name;
  if (b.level) {
    charLevel = Math.max(1, Math.min(100, b.level));
    const num = document.getElementById('clevel'), rng = document.getElementById('clevelr');
    if (num) num.value = charLevel;
    if (rng) rng.value = charLevel;
  }
  setTreeAlloc('talents', b.talents);
  setTreeAlloc('ascendancy', b.ascendancy);

  if (typeof classes !== 'undefined' && b.classes) {
    classes.length = 0;
    b.classes.forEach(c => classes.push(c));
  }
  if (typeof classAlloc !== 'undefined' && b.classAlloc) {
    Object.keys(classAlloc).forEach(k => delete classAlloc[k]);
    Object.assign(classAlloc, b.classAlloc);
  }
  if (typeof custom !== 'undefined' && b.items) {
    Object.keys(custom).forEach(k => delete custom[k]);
    Object.assign(custom, JSON.parse(JSON.stringify(b.items)));
  }
  if (typeof loadout !== 'undefined' && b.loadout) {
    b.loadout.forEach((l, i) => {
      if (i >= loadout.length) return;
      loadout[i].spell = l.spell || '';
      loadout[i].supports = (l.supports || []).slice();
      loadout[i].use = l.use || 'cast';
      if (l.procPct !== undefined) loadout[i].procPct = l.procPct;
      if (l.rank !== undefined) loadout[i].rank = l.rank;
      if (l.linkOverride !== undefined) loadout[i].linkOverride = l.linkOverride;
    });
  }
  if (typeof augments !== 'undefined' && b.augments) {
    augments.length = 0;
    b.augments.forEach(a => augments.push({ id: a.id, perc: a.perc }));
  }
  if (typeof manualSpells !== 'undefined' && b.manualSpells) {
    manualSpells.clear();
    b.manualSpells.forEach(s => manualSpells.add(s));
  }
  if (typeof effectStacks !== 'undefined' && b.effects) {
    Object.keys(effectStacks).forEach(k => delete effectStacks[k]);
    Object.assign(effectStacks, b.effects);
  }
  if (typeof cfg !== 'undefined' && b.config) Object.assign(cfg, b.config);
  if (typeof applyNow === 'function') applyNow();
}

function serializeAtlas() {
  return {
    format: FORMAT,
    kind: 'atlas',
    pack: B.meta.pack,
    name: (document.getElementById('atlasname') || {}).value || 'Atlas plan',
    atlas: treeAlloc('atlas_passives'),
  };
}

function applyAtlas(b) {
  if (!b || b.kind !== 'atlas') throw new Error('not an atlas plan');
  setTreeAlloc('atlas_passives', b.atlas);
  const nm = document.getElementById('atlasname');
  if (nm && b.name) nm.value = b.name;
  if (typeof applyNow === 'function') applyNow();
  draw();
}

const SER = { character: serializeCharacter, atlas: serializeAtlas };
const APP = { character: applyCharacter, atlas: applyAtlas };

/* ---- the store ---------------------------------------------------------- */

function saveBuild(kind, name) {
  const all = readStore(kind);
  const data = SER[kind]();
  data.name = name;
  data.savedAt = new Date().toISOString();
  all[name] = data;
  if (!writeStore(kind, all)) return false;
  paintBuildBars();
  return true;
}
function loadBuild(kind, name) {
  const b = readStore(kind)[name];
  if (!b) return false;
  APP[kind](b);
  paintBuildBars();
  return true;
}
function deleteBuild(kind, name) {
  const all = readStore(kind);
  delete all[name];
  writeStore(kind, all);
  paintBuildBars();
}

/* ---- sharing ------------------------------------------------------------ */

/* A build travels as a plain .json file. Downloads are blocked inside the
   Claude artifact sandbox but work normally on a real site, so the button
   falls back to copying the text when the download cannot start. */
function exportBuild(kind) {
  const data = SER[kind]();
  const text = JSON.stringify(data, null, 1);
  const safe = (data.name || kind).replace(/[^\w.-]+/g, '_').slice(0, 40);
  const fname = 'cte2-' + kind + '-' + safe + '.json';
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    note(kind, 'Exported ' + fname);
  } catch (e) {
    copyText(text, kind, fname);
  }
}

function copyText(text, kind, fname) {
  try {
    navigator.clipboard.writeText(text);
    note(kind, 'Download blocked here - copied ' + fname + ' to the clipboard instead');
  } catch (e) {
    note(kind, 'Could not export: ' + e.message);
  }
}

function importBuild(kind, text) {
  let b;
  try { b = JSON.parse(text); }
  catch (e) { note(kind, 'That is not a build file - ' + e.message); return; }
  if (b.kind !== kind) {
    note(kind, 'That file is a ' + (b.kind || 'unknown') + ' build, not ' + kind + '.');
    return;
  }
  /* A build from a different pack version can still be loaded - ids mostly
     survive - but say so rather than pretend it is a clean import. */
  if (b.pack && b.pack !== B.meta.pack) {
    note(kind, 'Loaded, but this build was made on "' + b.pack + '".');
  } else {
    note(kind, 'Loaded ' + (b.name || 'build') + '.');
  }
  try { APP[kind](b); } catch (e) { note(kind, 'Could not apply: ' + e.message); }
  paintBuildBars();
}

function note(kind, msg) {
  const el = document.getElementById(kind === 'atlas' ? 'atlasnote' : 'buildnote');
  if (el) el.textContent = msg;
}

/* ---- the controls ------------------------------------------------------- */

function buildBarHtml(kind, names, current) {
  const pre = kind === 'atlas' ? 'atlas' : 'build';
  return '<select id="' + pre + 'sel" aria-label="Saved ' + kind + ' builds">' +
      '<option value="">' + (names.length ? '— saved builds —'
                                          : '— nothing saved yet —') + '</option>' +
      names.map(n => '<option value="' + n.replace(/"/g, '&quot;') + '"' +
        (n === current ? ' selected' : '') + '>' + n + '</option>').join('') +
    '</select>' +
    '<button class="mini" id="' + pre + 'save">Save</button>' +
    '<button class="mini" id="' + pre + 'new">New</button>' +
    '<button class="mini" id="' + pre + 'del">Delete</button>' +
    '<button class="mini" id="' + pre + 'exp">Export</button>' +
    '<button class="mini" id="' + pre + 'imp">Import</button>' +
    '<input type="file" id="' + pre + 'file" accept=".json,application/json" hidden>' +
    '<div class="bnote" id="' + (kind === 'atlas' ? 'atlasnote' : 'buildnote') + '"></div>';
}

function wireBuildBar(kind) {
  const pre = kind === 'atlas' ? 'atlas' : 'build';
  const $ = id => document.getElementById(pre + id);
  const nameOfNow = () => kind === 'atlas'
    ? ((document.getElementById('atlasname') || {}).value || 'Atlas plan')
    : (document.getElementById('profile').value || 'New build');

  const sel = $('sel');
  if (sel) sel.onchange = () => { if (sel.value) loadBuild(kind, sel.value); };

  const save = $('save');
  if (save) save.onclick = () => {
    const n = nameOfNow().trim();
    if (!n) { note(kind, 'Give it a name first.'); return; }
    if (!storageWorks) {
      note(kind, 'This browser will not let the page store data, so saving is '
        + 'unavailable - use Export instead.');
      return;
    }
    const existed = !!readStore(kind)[n];
    saveBuild(kind, n);
    note(kind, (existed ? 'Updated "' : 'Saved "') + n + '".');
  };

  const nw = $('new');
  if (nw) nw.onclick = () => {
    if (kind === 'atlas') {
      setTreeAlloc('atlas_passives', []);
      const nm = document.getElementById('atlasname');
      if (nm) nm.value = 'Atlas plan';
      if (typeof applyNow === 'function') applyNow();
      draw();
    } else {
      /* A new character build starts from the imported character rather than
         from nothing - that is the useful blank page here. */
      setTreeAlloc('talents', [...(TREES.talents.saved || [])]);
      setTreeAlloc('ascendancy', [...(TREES.ascendancy.saved || [])]);
      if (typeof custom !== 'undefined') Object.keys(custom).forEach(k => delete custom[k]);
      document.getElementById('profile').value = 'New build';
      if (typeof applyNow === 'function') applyNow();
    }
    note(kind, 'Started a new one.');
    paintBuildBars();
  };

  const del = $('del');
  if (del) del.onclick = () => {
    const n = (sel && sel.value) || nameOfNow();
    if (!readStore(kind)[n]) { note(kind, 'Nothing saved under "' + n + '".'); return; }
    deleteBuild(kind, n);
    note(kind, 'Deleted "' + n + '".');
  };

  const exp = $('exp');
  if (exp) exp.onclick = () => exportBuild(kind);

  const imp = $('imp'), file = $('file');
  if (imp && file) {
    imp.onclick = () => file.click();
    file.onchange = () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => importBuild(kind, String(r.result));
      r.readAsText(f);
      file.value = '';
    };
  }
}

function paintBuildBars() {
  [['character', 'buildbar'], ['atlas', 'atlasbar']].forEach(([kind, hostId]) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    const names = Object.keys(readStore(kind)).sort();
    const cur = kind === 'atlas'
      ? (document.getElementById('atlasname') || {}).value
      : document.getElementById('profile').value;
    const keep = host.querySelector('.bnote');
    const msg = keep ? keep.textContent : '';
    host.innerHTML = buildBarHtml(kind, names, cur);
    wireBuildBar(kind);
    const n = host.querySelector('.bnote');
    if (n && msg) n.textContent = msg;
  });
}

/* Everything above is definitions; this is the one line that starts it. It
   runs last because builds.js is inlined after the modules it reads. */
paintBuildBars();
