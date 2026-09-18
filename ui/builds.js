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

/* Which SAVED build each store currently has open, so Save updates that one
   instead of silently making a second copy under whatever the name field says.
   Empty means "not saved yet". */
const openBuild = { character: '', atlas: '' };
const nameField = kind => document.getElementById(kind === 'atlas' ? 'atlasname' : 'profile');
const currentName = kind => ((nameField(kind) || {}).value || '').trim();

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

/* A build travels as a CODE: the JSON deflated and base64'd into one line you
   can paste into Discord. A file works too, but asking someone to find a
   download, attach it and send it is friction where a paste is not - and the
   artifact sandbox blocks downloads entirely.

   The code is prefixed so a wrong paste fails loudly instead of decoding into
   nonsense. */
const CODE_PREFIX = { character: 'CTE2C~', atlas: 'CTE2A~' };

function b64encode(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64decode(str) {
  const t = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encodeBuild(kind) {
  const json = JSON.stringify(SER[kind]());
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'undefined') {
    /* No compression here - still a valid code, just a longer one. */
    return CODE_PREFIX[kind] + '0' + b64encode(bytes);
  }
  const cs = new CompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs))
    .arrayBuffer();
  return CODE_PREFIX[kind] + '1' + b64encode(new Uint8Array(buf));
}

async function decodeBuild(kind, code) {
  const text = String(code).trim();
  const want = CODE_PREFIX[kind];
  if (text.startsWith('{')) return JSON.parse(text);        // raw JSON pasted
  const other = Object.keys(CODE_PREFIX).find(k => text.startsWith(CODE_PREFIX[k]));
  if (other && other !== kind) {
    throw new Error('that is ' + (other === 'atlas' ? 'an Atlas plan' : 'a character build')
      + ', not ' + (kind === 'atlas' ? 'an Atlas plan' : 'a character build'));
  }
  if (!text.startsWith(want)) throw new Error('that does not look like a build code');
  const body = text.slice(want.length);
  const bytes = b64decode(body.slice(1));
  if (body[0] === '0') return JSON.parse(new TextDecoder().decode(bytes));
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds))
    .arrayBuffer();
  return JSON.parse(new TextDecoder().decode(buf));
}

/* The share panel: the code to copy out, and a box to paste one in. */
async function openShare(kind) {
  const host = document.getElementById(kind === 'atlas' ? 'atlasshare' : 'buildshare');
  if (!host) return;
  if (!host.hidden && host.dataset.mode === 'out') { host.hidden = true; return; }
  let code = '';
  try { code = await encodeBuild(kind); }
  catch (e) { note(kind, 'Could not build a code: ' + e.message); return; }
  host.dataset.mode = 'out';
  host.hidden = false;
  host.innerHTML =
    '<label>Send this to a friend — ' + code.length + ' characters</label>' +
    '<textarea readonly rows="3" spellcheck="false"></textarea>' +
    '<div class="brow"><button class="mini primary" data-copy>Copy</button>' +
    '<button class="mini" data-file>Save as file</button>' +
    '<button class="mini" data-close>Close</button></div>';
  const ta = host.querySelector('textarea');
  ta.value = code;
  ta.onclick = () => ta.select();
  host.querySelector('[data-copy]').onclick = () => {
    ta.select();
    try {
      navigator.clipboard.writeText(code);
      note(kind, 'Copied — paste it to a friend.');
    } catch (e) {
      try { document.execCommand('copy'); note(kind, 'Copied.'); }
      catch (e2) { note(kind, 'Select the text and copy it manually.'); }
    }
  };
  host.querySelector('[data-file]').onclick = () => exportBuild(kind);
  host.querySelector('[data-close]').onclick = () => { host.hidden = true; };
}

function openPaste(kind) {
  const host = document.getElementById(kind === 'atlas' ? 'atlasshare' : 'buildshare');
  if (!host) return;
  if (!host.hidden && host.dataset.mode === 'in') { host.hidden = true; return; }
  host.dataset.mode = 'in';
  host.hidden = false;
  host.innerHTML =
    '<label>Paste a build code (or open a .json file)</label>' +
    '<textarea rows="3" spellcheck="false" placeholder="CTE2' +
      (kind === 'atlas' ? 'A' : 'C') + '~…"></textarea>' +
    '<div class="brow"><button class="mini primary" data-load>Load</button>' +
    '<button class="mini" data-file>Open a file…</button>' +
    '<button class="mini" data-close>Close</button></div>';
  const ta = host.querySelector('textarea');
  ta.focus();
  host.querySelector('[data-load]').onclick = async () => {
    const v = ta.value.trim();
    if (!v) { note(kind, 'Paste a code first.'); return; }
    try {
      const b = await decodeBuild(kind, v);
      applyImported(kind, b);
      host.hidden = true;
    } catch (e) { note(kind, 'Could not read that: ' + e.message); }
  };
  host.querySelector('[data-file]').onclick = () => {
    const f = document.getElementById((kind === 'atlas' ? 'atlas' : 'build') + 'file');
    if (f) f.click();
  };
  host.querySelector('[data-close]').onclick = () => { host.hidden = true; };
}

/* A plain .json file, for anyone who would rather send an attachment. */
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
  applyImported(kind, b);
}

function applyImported(kind, b) {
  if (b.kind !== kind) {
    note(kind, 'That is a ' + (b.kind || 'unknown') + ' build, not ' + kind + '.');
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
  if (el) { el.textContent = msg; el.dataset.sticky = '1'; }
}

/* ---- the controls ------------------------------------------------------- */

/* "3 minutes ago" beats a timestamp for telling whether you saved since that
   last change. */
function ago(iso) {
  if (!iso) return '';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(secs >= 0)) return '';
  if (secs < 90) return 'just now';
  const mins = secs / 60;
  if (mins < 90) return Math.round(mins) + ' min ago';
  const hrs = mins / 60;
  if (hrs < 36) return Math.round(hrs) + ' hr ago';
  return Math.round(hrs / 24) + ' days ago';
}

function buildBarHtml(kind, names, store) {
  const pre = kind === 'atlas' ? 'atlas' : 'build';
  const open = openBuild[kind];
  const dirty = open && open !== currentName(kind);
  const saved = open && store[open] ? ago(store[open].savedAt) : '';
  const btn = (id, txt, title, cls) =>
    '<button class="mini' + (cls ? ' ' + cls : '') + '" id="' + pre + id + '"' +
    (title ? ' title="' + title + '"' : '') + '>' + txt + '</button>';

  return '<select id="' + pre + 'sel" aria-label="Saved ' + kind + ' builds">' +
      '<option value="">' + (names.length ? '— open a saved build —'
                                          : '— nothing saved yet —') + '</option>' +
      names.map(n => '<option value="' + n.replace(/"/g, '&quot;') + '"' +
        (n === open ? ' selected' : '') + '>' + n + '</option>').join('') +
    '</select>' +
    '<div class="brow">' +
      btn('save', open ? 'Save' : 'Save as…',
          open ? 'Update "' + open + '"' : 'Save under the name above', 'primary') +
      (dirty ? btn('ren', 'Rename', 'Rename "' + open + '" to "'
                   + currentName(kind) + '"') : '') +
      (open ? btn('dup', 'Duplicate', 'Save a copy under the name above') : '') +
      btn('new', 'New', 'Start fresh') +
      (open ? btn('del', 'Delete', 'Delete "' + open + '"', 'danger') : '') +
    '</div>' +
    '<div class="brow">' +
      btn('exp', 'Export', 'Save a .json you can send to someone') +
      btn('imp', 'Import', 'Open a .json someone sent you') +
      (kind === 'character'
        ? btn('char', 'Load character…',
              'Read pob_export.dat straight from your game folder') : '') +
    '</div>' +
    (kind === 'character'
      ? '<input type="file" id="buildcharfile" accept=".dat" hidden>' : '') +
    '<input type="file" id="' + pre + 'file" accept=".json,application/json" hidden>' +
    '<div class="bnote" id="' + (kind === 'atlas' ? 'atlasnote' : 'buildnote') + '">' +
      (open ? ('Open: <b>' + open + '</b>' + (saved ? ' · saved ' + saved : '') +
               (dirty ? ' · <i>renaming to "' + currentName(kind) + '"</i>' : ''))
            : '') +
    '</div>';
}

function wireBuildBar(kind) {
  const pre = kind === 'atlas' ? 'atlas' : 'build';
  const $ = id => document.getElementById(pre + id);
  const store = () => readStore(kind);

  const sel = $('sel');
  if (sel) sel.onchange = () => {
    if (!sel.value) return;
    if (loadBuild(kind, sel.value)) {
      openBuild[kind] = sel.value;
      note(kind, 'Opened "' + sel.value + '".');
      paintBuildBars();
    }
  };

  /* The name field drives everything, so the bar has to repaint as you type -
     that is what makes Rename appear the moment the name differs. */
  const nf = nameField(kind);
  if (nf && !nf.dataset.bound) {
    nf.dataset.bound = '1';
    nf.addEventListener('input', () => paintBuildBars());
  }

  const guard = () => {
    if (storageWorks) return true;
    note(kind, 'This browser will not let the page store data, so saving is '
      + 'unavailable - use Export instead.');
    return false;
  };

  const save = $('save');
  if (save) save.onclick = () => {
    const n = openBuild[kind] || currentName(kind);
    if (!n) { note(kind, 'Give it a name first.'); return; }
    if (!guard()) return;
    const existed = !!store()[n];
    saveBuild(kind, n);
    openBuild[kind] = n;
    note(kind, (existed ? 'Saved over "' : 'Saved "') + n + '".');
    paintBuildBars();
  };

  /* Rename moves the stored entry rather than leaving a copy behind - which is
     what Save used to do when you edited the name. */
  const ren = $('ren');
  if (ren) ren.onclick = () => {
    const from = openBuild[kind], to = currentName(kind);
    if (!from || !to || from === to) return;
    if (!guard()) return;
    const all = store();
    if (all[to] && !confirm('"' + to + '" already exists. Replace it?')) return;
    all[to] = Object.assign({}, all[from], { name: to });
    delete all[from];
    writeStore(kind, all);
    openBuild[kind] = to;
    note(kind, 'Renamed to "' + to + '".');
    paintBuildBars();
  };

  const dup = $('dup');
  if (dup) dup.onclick = () => {
    let n = currentName(kind);
    if (!guard()) return;
    const all = store();
    if (!n || all[n]) {
      let i = 2;
      const base = (n || openBuild[kind] || 'Build').replace(/ \d+$/, '');
      while (all[base + ' ' + i]) i++;
      n = base + ' ' + i;
      const f = nameField(kind);
      if (f) f.value = n;
    }
    saveBuild(kind, n);
    openBuild[kind] = n;
    note(kind, 'Copied to "' + n + '".');
    paintBuildBars();
  };

  const nw = $('new');
  if (nw) nw.onclick = () => {
    if (kind === 'atlas') {
      setTreeAlloc('atlas_passives', []);
      const nm = nameField(kind);
      if (nm) nm.value = 'Atlas plan';
      if (typeof applyNow === 'function') applyNow();
      draw();
    } else {
      /* A new character build starts from the imported character - that is the
         useful blank page here, not an empty tree. */
      setTreeAlloc('talents', [...(TREES.talents.saved || [])]);
      setTreeAlloc('ascendancy', [...(TREES.ascendancy.saved || [])]);
      if (typeof custom !== 'undefined') Object.keys(custom).forEach(k => delete custom[k]);
      const nm = nameField(kind);
      if (nm) nm.value = 'New build';
      if (typeof applyNow === 'function') applyNow();
    }
    openBuild[kind] = '';
    note(kind, 'Started a new one.');
    paintBuildBars();
  };

  const del = $('del');
  if (del) del.onclick = () => {
    const n = openBuild[kind];
    if (!n || !store()[n]) { note(kind, 'Nothing open to delete.'); return; }
    if (!confirm('Delete "' + n + '"? This cannot be undone.')) return;
    deleteBuild(kind, n);
    openBuild[kind] = '';
    note(kind, 'Deleted "' + n + '".');
    paintBuildBars();
  };

  const exp = $('exp');
  if (exp) exp.onclick = () => openShare(kind);
  const imp = $('imp');
  if (imp) imp.onclick = () => openPaste(kind);

  const file = $('file');
  if (file) file.onchange = () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => importBuild(kind, String(r.result));
    r.readAsText(f);
    file.value = '';
  };

  /* Straight from the game's own export - no Python, no moving files. */
  if (kind === 'character') {
    const btn = $('char'), cf = document.getElementById('buildcharfile');
    if (btn && cf) {
      btn.onclick = () => cf.click();
      cf.onchange = async () => {
        const f = cf.files && cf.files[0];
        cf.value = '';
        if (!f) return;
        note(kind, 'Reading ' + f.name + '…');
        try {
          const ch = await IMPORTER.loadFile(f);
          IMPORTER.apply(ch);
          const t = Object.entries(ch.allocated || {})
            .map(([k, v]) => v.length + ' ' + k.toLowerCase()).join(', ');
          const nm = nameField(kind);
          if (nm) nm.value = 'My character';
          openBuild[kind] = '';
          note(kind, 'Loaded level ' + ch.level + ' · ' + (ch.gear || []).length
            + ' items, ' + (ch.jewels || []).length + ' jewels, ' + t
            + '. Give it a name and Save.');
          paintBuildBars();
        } catch (e) {
          note(kind, 'Could not read that file: ' + e.message);
        }
      };
    }
  }
}

function paintBuildBars() {
  [['character', 'buildbar'], ['atlas', 'atlasbar']].forEach(([kind, hostId]) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    const store = readStore(kind);
    const keep = host.querySelector('.bnote');
    const msg = keep && keep.dataset.sticky ? keep.innerHTML : '';
    host.innerHTML = buildBarHtml(kind, Object.keys(store).sort(), store);
    wireBuildBar(kind);
    if (msg) {
      const n = host.querySelector('.bnote');
      if (n) { n.innerHTML = msg; n.dataset.sticky = '1'; }
    }
  });
}

/* Everything above is definitions; this is the one line that starts it. It
   runs last because builds.js is inlined after the modules it reads. */
paintBuildBars();
