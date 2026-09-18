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
STORE.characterRecovery = 'cte2pob.characterRecovery';
STORE.atlasRecovery = 'cte2pob.atlasRecovery';
STORE.characterDraft = 'cte2pob.characterDraft';
STORE.atlasDraft = 'cte2pob.atlasDraft';
const FORMAT = 2;
const DEFAULT_CONFIG = Object.assign({}, cfg);
var characterContext = {};
const cloneBuild = x => JSON.parse(JSON.stringify(x));
let autosaveReady = false, autosaveTimer = null;
let autosaveEnabled = false;
try { autosaveEnabled = localStorage.getItem('cte2pob.autosave') === 'true'; } catch (e) { }
const savedFingerprint = {};

function fingerprint(kind) { return JSON.stringify(SER[kind]()); }
function rememberOpenBuilds() {
  try { localStorage.setItem('cte2pob.open', JSON.stringify(openBuild)); } catch (e) { }
}
function settleAutosave(kind) {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  for (const k of (kind ? [kind] : ['character', 'atlas'])) {
    savedFingerprint[k] = fingerprint(k);
    writeStore(k + 'Draft', {});
  }
  autosaveReady = true;
  rememberOpenBuilds();
  if (kind) queueAutosave();
}
function queueAutosave() {
  if (!autosaveReady) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, 600);
}
function flushAutosave() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  if (!autosaveReady) return true;
  for (const kind of ['character', 'atlas']) {
    if (fingerprint(kind) === savedFingerprint[kind]) continue;
    if (!autosaveEnabled) {
      if (!writeStore(kind + 'Draft', { build: SER[kind](), open: openBuild[kind] })) {
        note(kind, 'Recovery could not be stored. Keep this page open and Export a backup.');
        return false;
      }
      note(kind, 'Unsaved changes · recovery draft kept in this browser. Save keeps this version; Revert discards edits.');
      continue;
    }
    let name = openBuild[kind];
    if (!name) {
      const all = readStore(kind), base = currentName(kind) || (kind === 'atlas' ? 'Atlas plan' : 'New build');
      name = base;
      let i = 2;
      while (Object.hasOwn(all, name)) name = base + ' ' + i++;
      nameField(kind).value = name;
    }
    if (!saveBuild(kind, name)) {
      note(kind, 'Not saved: browser storage is unavailable or full. Keep this page open and Export a backup.');
      return false;
    }
    openBuild[kind] = name;
    savedFingerprint[kind] = fingerprint(kind);
    writeStore(kind + 'Draft', {});
    note(kind, 'Autosaved in this browser.');
  }
  rememberOpenBuilds();
  paintBuildBars();
  return true;
}

function saveCurrent(kind) {
  let name = openBuild[kind] || currentName(kind);
  const all = readStore(kind);
  if (!openBuild[kind] && Object.hasOwn(all, name)) {
    const base = name; let i = 2;
    while (Object.hasOwn(all, name)) name = base + ' ' + i++;
    nameField(kind).value = name;
  }
  if (!saveBuild(kind, name)) {
    note(kind, 'Could not save. Keep this page open and Export a backup.');
    return false;
  }
  openBuild[kind] = name;
  settleAutosave(kind);
  paintBuildBars();
  note(kind, 'Saved in this browser.');
  return true;
}

/* Save is a checkpoint. Recovery drafts never silently overwrite it. */
function confirmPending(kind) {
  if (!autosaveReady || fingerprint(kind) === savedFingerprint[kind]) return Promise.resolve(true);
  if (autosaveEnabled) return Promise.resolve(flushAutosave());
  flushAutosave();
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'build-confirm';
    dialog.setAttribute('aria-label', 'Unsaved build changes');
    dialog.innerHTML = '<h3>Keep your changes?</h3><p>This build has unsaved edits.</p>' +
      '<button data-save>Save changes</button> <button data-discard>Discard changes</button> <button data-cancel autofocus>Cancel</button>';
    document.body.appendChild(dialog);
    const finish = answer => { dialog.remove(); resolve(answer); };
    dialog.querySelector('[data-save]').onclick = () => { if (saveCurrent(kind)) finish(true); };
    dialog.querySelector('[data-discard]').onclick = () => {
      if (!recordRecovery(kind, SER[kind](), 'discarded edits')) {
        note(kind, 'Could not retain a recovery copy. Export before discarding.'); return;
      }
      finish(true);
    };
    dialog.querySelector('[data-cancel]').onclick = () => finish(false);
    dialog.oncancel = e => { e.preventDefault(); finish(false); };
    dialog.showModal();
  });
}
function recordRecovery(kind, build, reason) {
  const old = readStore(kind + 'Recovery');
  const entries = Array.isArray(old) ? old : [];
  entries.unshift({ build, reason, date: new Date().toISOString() });
  return writeStore(kind + 'Recovery', entries.slice(0, 20));
}
function openRecovery(kind) {
  if (!flushAutosave()) return;
  const entries = readStore(kind + 'Recovery');
  if (!Array.isArray(entries) || !entries.length) { note(kind, 'No recoverable versions yet.'); return; }
  const host = document.getElementById(kind === 'atlas' ? 'atlasshare' : 'buildshare');
  host.hidden = false; host.dataset.mode = 'recovery';
  host.innerHTML = '<label>Recover as a separate build</label><select data-recovery>' +
    entries.map((e, i) => '<option value="' + i + '">' + esc(e.build.name) + ' · ' + esc(e.reason) + ' · ' + esc(e.date) + '</option>').join('') +
    '</select><button class="mini" data-restore>Restore copy</button><button class="mini" data-close>Close</button>';
  host.querySelector('[data-restore]').onclick = () => {
    const b = cloneBuild(entries[+host.querySelector('select').value].build);
    b.name += ' recovered';
    applyImported(kind, b);
    host.hidden = true;
  };
  host.querySelector('[data-close]').onclick = () => { host.hidden = true; };
}

addEventListener('pagehide', () => flushAutosave());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAutosave();
});
addEventListener('beforeunload', e => {
  const dirty = autosaveReady && ['character', 'atlas'].some(k => fingerprint(k) !== savedFingerprint[k]);
  if (!flushAutosave() || (!autosaveEnabled && dirty)) { e.preventDefault(); e.returnValue = ''; }
});

function emptyCharacter() {
  return { format: FORMAT, kind: 'character', name: 'New build', level: 1,
    talents: [], ascendancy: [], classes: [], classAlloc: {}, items: {},
    loadout: [], augments: [], manualSpells: [], effects: {},
    config: Object.assign({}, DEFAULT_CONFIG), customModifiers: '', context: {} };
}

function validateBuild(b, kind) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.kind !== kind) throw new Error('Not a ' + kind + ' build.');
  if (b.format > FORMAT) throw new Error('This build needs a newer planner.');
  const walk = (value, key = '', depth = 0) => {
    if (depth > 20) throw new Error('Build data is nested too deeply.');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid number in build.');
    if (typeof value === 'string' && !['name', 'customModifiers'].includes(key) && /[<>"'&]/.test(value)) {
      throw new Error('Invalid text in build field: ' + key);
    }
    if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => {
      if (['__proto__', 'constructor', 'prototype'].includes(k) || /[<>"'&]/.test(k)) throw new Error('Invalid build field.');
      walk(v, k, depth + 1);
    });
  };
  walk(b);
  for (const key of ['talents', 'ascendancy', 'classes', 'loadout', 'augments', 'manualSpells', 'atlas']) {
    if (b[key] !== undefined && !Array.isArray(b[key])) throw new Error(key + ' must be a list.');
  }
  for (const key of ['items', 'classAlloc', 'effects', 'config', 'context']) {
    if (b[key] !== undefined && (!b[key] || typeof b[key] !== 'object' || Array.isArray(b[key]))) throw new Error(key + ' must be an object.');
  }
  if (b.level !== undefined && (typeof b.level !== 'number' || b.level < 1 || b.level > 100)) throw new Error('Level must be 1–100.');
  for (const c of b.classes || []) if (!SCHOOLS[c]) throw new Error('Unknown class: ' + c);
  for (const l of b.loadout || []) {
    if (!l || typeof l !== 'object' || (l.supports !== undefined && !Array.isArray(l.supports))) throw new Error('Invalid skill slot.');
    if (l.spell && !SK.spells[l.spell]) throw new Error('Unknown skill: ' + l.spell);
  }
  Object.entries(b.items || {}).forEach(([slot, item]) => {
    if (!item || typeof item !== 'object' || !Array.isArray(item.pre) || !Array.isArray(item.suf) || !Array.isArray(item.cor)) throw new Error('Incomplete item in ' + slot);
    if (!item.imp || !item.inf) throw new Error('Incomplete item modifiers in ' + slot);
    for (const a of [item.imp, item.inf, ...item.pre, ...item.suf, ...item.cor]) {
      if (!a || typeof a.id !== 'string' || (a.id && !CAT.affixes[a.id])) throw new Error('Unknown item modifier in ' + slot);
    }
    if (item.base && !CAT.bases[item.base]) throw new Error('Unknown item base: ' + item.base);
    if (item.unique && !CAT.uniques[item.unique]) throw new Error('Unknown unique: ' + item.unique);
    if (item.codex && !CAT.codex[item.codex]) throw new Error('Unknown codex: ' + item.codex);
    if (item.rarity && !CAT.rarities[item.rarity] && !['unique', 'runeword'].includes(item.rarity)) throw new Error('Unknown rarity.');
    if (item.slot !== slot) throw new Error('Item slot does not match its equipment slot.');
  });
}

/* A build owns every character-dependent input. Registry data stays shared. */
function resetCharacterState() {
  clearEquippedBaseline();
  Object.keys(SAVE_SLOT).forEach(k => delete SAVE_SLOT[k]);
  EXTRA_SLOTS.length = 0;
  BASE_CONTRIBS.length = 0;
  B.gear = []; B.jewels = []; B.codex = []; B.ascendancy = {};
  for (const obj of [custom, classAlloc, effectStacks, effectSeeded, ranks, cfg]) {
    Object.keys(obj).forEach(k => delete obj[k]);
  }
  Object.assign(cfg, DEFAULT_CONFIG);
  classes.length = 0; augments.length = 0; manualSpells.clear();
  loadout.forEach((l, i) => { loadout[i] = { spell: '', supports: [], use: 'cast', procPct: 10 }; });
  usageSeeded = true;
  availCache = null; effectsOnly = false;
  characterContext = {};
  CUSTOM_MODS.text = ''; CUSTOM_MODS.parsed = []; CUSTOM_MODS.errors = [];
  document.getElementById('custbox').value = '';
  cur = blankDraft('head');
}

function captureItems() {
  const items = cloneBuild(custom);
  if (cur && !cur.blank && (cur.base || cur.unique || isJewel(cur.slot) || cur.codexEquipped)) {
    items[cur.slot] = cloneBuild(cur);
  }
  return items;
}

function referenceAccuracy() {
  const ref = characterContext.computed || {};
  const entries = Object.entries(ref);
  const exact = entries.filter(([id, s]) => Math.abs(live.total(id) - s.v) <= 0.01).length;
  return { exact, total: entries.length };
}

function wornVanillaAttributes(draft) {
  const worn = Object.assign({}, custom);
  if (draft && !draft.blank) worn[draft.slot] = draft;
  const attrs = {};
  Object.entries(worn).forEach(([slot, item]) => {
    if (slot === 'offhand' && twoHandedEquipped()) return;
    const mods = ((VAN.items || {})[item.vanilla] || {})[VAN_SLOT[slot]] || {};
    Object.entries(mods).forEach(([id, v]) => { attrs[id] = (attrs[id] || 0) + v; });
  });
  return attrs;
}

function characterContribs(draft) {
  if (!characterContext) return [];
  const c = characterContext, out = [];
  const worn = Object.assign({}, custom);
  if (draft && !draft.blank) worn[draft.slot] = draft;
  const gearAttrs = wornVanillaAttributes(draft);
  const attrs = Object.assign({ 'minecraft:generic.max_health': 20,
    'minecraft:generic.attack_damage': 1 }, c.entityAttrs || {});
  Object.entries(gearAttrs).forEach(([id, v]) => { attrs[id] = (attrs[id] || 0) + v; });
  // Runtime totals already include equipped items. Preserve only the residual
  // beyond the imported gear, then apply the current gear's additive changes.
  Object.entries(c.runtimeAttrs || {}).forEach(([id, v]) => {
    if (Number.isFinite(v)) attrs[id] = v - ((c.importedGearAttrs || {})[id] || 0) + (gearAttrs[id] || 0);
  });
  const liveHealth = Number.isFinite((c.runtimeAttrs || {})['minecraft:generic.max_health']);
  const count = Math.max(0, Math.min(100, Math.trunc(Number(cfg.heartContainers) || 0)));
  const hearts = liveHealth
    ? (Number.isFinite(c.heartContainers) ? 2 * (count - c.heartContainers) : 0)
    : 2 * count;
  attrs['minecraft:generic.max_health'] += hearts;
  B.calc.attrTotals = attrs;
  const hp = liveHealth ? attrs['minecraft:generic.max_health']
    : (c.vanillaHp === undefined ? 20 : c.vanillaHp) + hearts;
  out.push(['health', 'FLAT', Math.max(0, Math.min(500, hp)), 'vanilla_hp']);
  Object.entries(c.points || {}).forEach(([id, n]) => out.push([id, 'FLAT', n, 'points']));
  /* Aura capacity has a base of 100 that the game counts INSIDE the
     spirit_cost stat. The sheet only carried what gear and perks add, so it
     read exactly 100 low on every character - confirmed on two: 186.58 vs
     86.58, and 232.97 vs 132.97. capacity() used to add the base back on its
     own, which kept the Skills tab right while the sheet stayed wrong. */
  if (SK.capacity && SK.capacity.base) {
    out.push(['spirit_cost', 'FLAT', SK.capacity.base, 'base']);
  }
  Object.entries(c.buffs || {}).forEach(([kind, buff]) => {
    (buff.stats || []).forEach(m => out.push([m.stat, m.type || 'FLAT',
      (m.v1 || 0) * (m.scaled ? scaleMulti(m.stat, charLevel) : 1), 'buff:' + kind]));
  });
  const rarities = {};
  Object.entries(worn).forEach(([slot, item]) => {
    if (isJewel(slot) || isCodex(slot) || item.blank || !item.base) return;
    if (slot === 'offhand' && twoHandedEquipped()) return;
    const rar = item.kind === 'unique' ? 'UNIQUE' : item.kind === 'runeword' ? 'RUNED' : 'NORMAL';
    rarities[rar] = (rarities[rar] || 0) + 1;
  });
  B.codex = [];
  const activeOmens = worn.codex ? (worn.codex.codexOmen ? [worn.codex.codexOmen] : []) : (c.omens || []);
  activeOmens.forEach(omen => {
    const def = CAT.codex[omen.id];
    if (!def) return;
    const reqs = omen.rarities || {}, aff = omen.aff || [];
    const total = Object.values(reqs).reduce((a, b) => a + b, 0);
    const met = Object.entries(reqs).reduce((n, [r, need]) => n + Math.min(rarities[r] || 0, need), 0);
    const tiers = aff.map((a, i) => ({ pieces: total - aff.length + i, id: a.id,
      stats: ((CAT.affixes[a.id] || {}).stats || []).map(m => IE.exact(m, a.p || 0, omen.lvl || charLevel)) }));
    tiers.push({ pieces: total, stats: def.mods.map(m => IE.exact(m, (aff[0] || {}).p || 0, omen.lvl || charLevel)) });
    tiers.forEach(t => {
      t.active = met >= t.pieces;
      if (t.active) t.stats.forEach(m => out.push([m.stat, m.type, m.value, 'codex:' + omen.id]));
    });
    B.codex.push({ id: omen.id, rarity: omen.rar, reqs, worn: rarities, met, total, tiers });
  });
  return out;
}

/* Called only after every module and its DOM have been initialized. */
function startLocalPlanner() {
  let last = {};
  const drafts = { character: readStore('characterDraft'), atlas: readStore('atlasDraft') };
  try { last = JSON.parse(localStorage.getItem('cte2pob.open') || '{}'); } catch (e) { }
  applyCharacter(emptyCharacter());
  setTreeAlloc('atlas_passives', []);
  TREES.atlas_passives.saved = new Set();
  paintBuildBars();
  note('character', 'Start a build or load your character. Saved builds stay in this browser. Export a copy for backup or another device.');
  for (const kind of ['character', 'atlas']) {
    const saved = readStore(kind)[last[kind]];
    if (saved) {
      try { APP[kind](saved); openBuild[kind] = last[kind]; }
      catch (e) { note(kind, 'Could not reopen that build. Your saved copy is still available.'); }
    }
  }
  settleAutosave();
  for (const kind of ['character', 'atlas']) {
    const draft = drafts[kind];
    if (!draft.build) continue;
    try {
      APP[kind](draft.build);
      openBuild[kind] = draft.open || '';
      writeStore(kind + 'Draft', draft);
      note(kind, 'Recovered unsaved edits. Your saved version is unchanged; Save or Revert when ready.');
    } catch (e) { note(kind, 'Could not restore the recovery draft.'); }
  }
  paintBuildBars();
}

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
    items: captureItems(),
    bonusPoints: bonusPts,
    damageFocus: dpsFocus,
    context: cloneBuild(characterContext),
    customModifiers: document.getElementById('custbox').value,
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
  validateBuild(b, 'character');
  b = Object.assign(emptyCharacter(), cloneBuild(b));
  resetCharacterState();
  bonusPts = b.bonusPoints === undefined ? (PTS.max_bonus_points || 25) : b.bonusPoints;
  dpsFocus = b.damageFocus || '';
  characterContext = b.context || {};
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
    Object.keys(custom).filter(sl => !isJewel(sl) && !EQUIP.some(e => e.id === sl))
      .forEach(sl => EXTRA_SLOTS.push(sl));
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
  Object.keys(effectStacks).forEach(k => { effectSeeded[k] = 1; });
  CUSTOM_MODS.text = b.customModifiers || '';
  Object.assign(CUSTOM_MODS, parseCustom(CUSTOM_MODS.text));
  document.getElementById('custbox').value = CUSTOM_MODS.text;
  paintCustomNote();
  cur = custom.head ? cloneBuild(custom.head) : blankDraft('head');
  cur.slot = 'head';
  ['talents', 'ascendancy'].forEach(k => { TREES[k].saved = new Set(TREES[k].alloc); });
  B.ascendancy = { school_order: classes.slice(), allocated_lvls: Object.assign({}, classAlloc) };
  if (TREES[view]) useTree(view);
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
  validateBuild(b, 'atlas');
  setTreeAlloc('atlas_passives', b.atlas);
  TREES.atlas_passives.saved = new Set(TREES.atlas_passives.alloc);
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
  if (Object.hasOwn(all, name) && !recordRecovery(kind, all[name], 'before edit')) return false;
  Object.defineProperty(all, name, { value: data, enumerable: true, configurable: true, writable: true });
  if (!writeStore(kind, all)) return false;
  if (kind === 'character') {
    B.ascendancy = { school_order: classes.slice(), allocated_lvls: Object.assign({}, classAlloc) };
    ['talents', 'ascendancy'].forEach(k => { TREES[k].saved = new Set(TREES[k].alloc); });
  } else TREES.atlas_passives.saved = new Set(TREES.atlas_passives.alloc);
  if (TREES[view]) useTree(view);
  paintBuildBars();
  return true;
}
async function loadBuild(kind, name) {
  if (!await confirmPending(kind)) return false;
  const b = readStore(kind)[name];
  if (!b) return false;
  try { APP[kind](b); }
  catch (e) { note(kind, 'Could not open: ' + e.message); return false; }
  openBuild[kind] = name;
  settleAutosave(kind);
  paintBuildBars();
  return true;
}
function deleteBuild(kind, name) {
  const all = readStore(kind);
  if (all[name] && !recordRecovery(kind, all[name], 'deleted')) return false;
  delete all[name];
  if (!writeStore(kind, all)) return false;
  paintBuildBars();
  return true;
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
      await applyImported(kind, b);
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

async function importBuild(kind, text) {
  let b;
  try { b = JSON.parse(text); }
  catch (e) { note(kind, 'That is not a build file - ' + e.message); return; }
  await applyImported(kind, b);
}

async function applyImported(kind, b) {
  try { validateBuild(b, kind); }
  catch (e) { note(kind, 'Could not apply: ' + e.message); return false; }
  if (!await confirmPending(kind)) return false;
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
  try {
    APP[kind](b);
    openBuild[kind] = '';
    flushAutosave();
  } catch (e) { note(kind, 'Could not apply: ' + e.message); }
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
    (title ? ' title="' + esc(title) + '"' : '') + '>' + txt + '</button>';

  return '<select id="' + pre + 'sel" aria-label="Saved ' + kind + ' builds">' +
      '<option value="">' + (names.length ? '— open a saved build —'
                                          : '— nothing saved yet —') + '</option>' +
      names.map(n => '<option value="' + esc(n) + '"' +
        (n === open ? ' selected' : '') + '>' + esc(n) + '</option>').join('') +
    '</select>' +
    '<div class="brow">' +
      btn('save', 'Save now',
          open ? 'Update "' + open + '"' : 'Save under the name above', 'primary') +
      (dirty ? btn('ren', 'Rename', 'Rename "' + open + '" to "'
                   + currentName(kind) + '"') : '') +
      (open ? btn('dup', 'Duplicate', 'Save a copy under the name above') : '') +
      btn('new', 'New', 'Start fresh') +
      btn('revert', 'Revert to saved', 'Discard edits and reopen your last saved version') +
      (open ? btn('del', 'Delete', 'Delete "' + open + '"', 'danger') : '') +
    '</div>' +
    (kind === 'character' ? '<label><input id="buildautosave" type="checkbox"' +
      (autosaveEnabled ? ' checked' : '') + '> Autosave edits to saved builds</label>' : '') +
    '<div class="brow">' +
      btn('exp', 'Export', 'Save a .json you can send to someone') +
      btn('imp', 'Import', 'Open a .json someone sent you') +
      btn('recover', 'Recover…', 'Restore a deleted build or a recent saved version') +
      (kind === 'character'
        ? btn('char', 'Load character…',
              'Read pob_export.dat straight from your game folder') : '') +
    '</div>' +
    (kind === 'character'
      ? '<input type="file" id="buildcharfile" accept=".dat" hidden>' : '') +
    '<input type="file" id="' + pre + 'file" accept=".json,application/json" hidden>' +
    '<div class="bnote" id="' + (kind === 'atlas' ? 'atlasnote' : 'buildnote') + '">' +
      (open ? ('Open: <b>' + esc(open) + '</b>' + (saved ? ' · saved ' + saved : '') +
               (dirty ? ' · <i>renaming to "' + esc(currentName(kind)) + '"</i>' : ''))
            : '') +
    '</div>';
}

function wireBuildBar(kind) {
  const pre = kind === 'atlas' ? 'atlas' : 'build';
  const $ = id => document.getElementById(pre + id);
  const store = () => readStore(kind);

  const sel = $('sel');
  if (sel) sel.onchange = async () => {
    if (!sel.value) return;
    const selected = sel.value;
    if (await loadBuild(kind, selected)) {
      openBuild[kind] = selected;
      note(kind, 'Opened "' + selected + '".');
      if ((readStore(kind)[selected].format || 1) < FORMAT && kind === 'character') {
        note(kind, 'Opened an older build. Equipment that was never saved cannot be recovered from it; re-import your .dat for a complete character.');
      }
      paintBuildBars();
    } else paintBuildBars();
  };

  /* The name field drives everything, so the bar has to repaint as you type -
     that is what makes Rename appear the moment the name differs. */
  const nf = nameField(kind);
  if (nf && !nf.dataset.bound) {
    nf.dataset.bound = '1';
    nf.addEventListener('input', () => { paintBuildBars(); queueAutosave(); });
  }

  const guard = () => {
    if (storageWorks) return true;
    note(kind, 'This browser will not let the page store data, so saving is '
      + 'unavailable - use Export instead.');
    return false;
  };

  const save = $('save');
  if (save) save.onclick = () => {
    saveCurrent(kind);
  };
  /* Kept alongside Save so the two persistence modes are explicit. */
  const auto = document.getElementById('buildautosave');
  if (kind === 'character' && auto) auto.onchange = () => {
    autosaveEnabled = auto.checked;
    try { localStorage.setItem('cte2pob.autosave', String(autosaveEnabled)); } catch (e) { }
    queueAutosave();
  };
  const revert = $('revert');
  if (revert) revert.onclick = () => {
    if (!confirm('Discard edits and return to the last saved version?')) return;
    if (!recordRecovery(kind, SER[kind](), 'before revert')) { note(kind, 'Could not retain a recovery copy. Export first.'); return; }
    const b = readStore(kind)[openBuild[kind]];
    APP[kind](b || (kind === 'character' ? emptyCharacter() : { kind: 'atlas', name: 'Atlas plan', atlas: [] }));
    settleAutosave(kind); paintBuildBars();
    note(kind, 'Reverted to the saved version.');
  };
  /* Rename moves the stored entry rather than leaving a copy behind - which is
     what Save used to do when you edited the name. */
  const ren = $('ren');
  if (ren) ren.onclick = () => {
    if (!flushAutosave()) return;
    const from = openBuild[kind], to = currentName(kind);
    if (!from || !to || from === to) return;
    if (!guard()) return;
    const all = store();
    if (all[to] && !confirm('"' + to + '" already exists. Replace it?')) return;
    if (all[to] && !recordRecovery(kind, all[to], 'before replace')) return;
    all[to] = Object.assign(SER[kind](), { name: to, savedAt: new Date().toISOString() });
    delete all[from];
    if (!writeStore(kind, all)) { note(kind, 'Could not rename. Use Export to keep a copy.'); return; }
    openBuild[kind] = to;
    settleAutosave(kind);
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
    if (!saveBuild(kind, n)) { note(kind, 'Could not save the copy. Use Export to keep a copy.'); return; }
    openBuild[kind] = n;
    settleAutosave(kind);
    note(kind, 'Copied to "' + n + '".');
    paintBuildBars();
  };

  const nw = $('new');
  if (nw) nw.onclick = async () => {
    if (!await confirmPending(kind)) return;
    if (kind === 'atlas') {
      setTreeAlloc('atlas_passives', []);
      const nm = nameField(kind);
      if (nm) nm.value = 'Atlas plan';
      if (typeof applyNow === 'function') applyNow();
      draw();
    } else {
      applyCharacter(emptyCharacter());
    }
    openBuild[kind] = '';
    settleAutosave(kind);
    note(kind, 'Started a new one.');
    paintBuildBars();
  };

  const del = $('del');
  if (del) del.onclick = async () => {
    if (!await confirmPending(kind)) return;
    const n = openBuild[kind];
    if (!n || !store()[n]) { note(kind, 'Nothing open to delete.'); return; }
    if (!confirm('Delete "' + n + '"? A copy will remain under Recover.')) return;
    if (!deleteBuild(kind, n)) { note(kind, 'Could not delete. Browser storage is unavailable.'); return; }
    openBuild[kind] = '';
    if (kind === 'character') applyCharacter(emptyCharacter());
    else applyAtlas({ kind: 'atlas', name: 'Atlas plan', atlas: [] });
    settleAutosave(kind);
    note(kind, 'Deleted "' + n + '".');
    paintBuildBars();
  };

  const exp = $('exp');
  const recover = $('recover');
  if (recover) recover.onclick = () => openRecovery(kind);
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
          if (!await confirmPending('character') || !await confirmPending('atlas')) return;
          IMPORTER.apply(ch);
          const t = Object.entries(ch.allocated || {})
            .map(([k, v]) => v.length + ' ' + k.toLowerCase()).join(', ');
          const nm = nameField(kind);
          if (nm) nm.value = 'My character';
          openBuild[kind] = '';
          openBuild.atlas = '';
          nameField('atlas').value = 'Imported atlas';
          flushAutosave();
          note(kind, 'Loaded level ' + ch.level + ' · ' + (ch.gear || []).length
            + ' items, ' + (ch.jewels || []).length + ' jewels, ' + t
            + '. Give it a name and Save.'
            + (!Number.isFinite((ch.runtimeAttrs || {})['minecraft:generic.max_health'])
              ? ' This export lacks live attributes, including Heart Container bonuses. Update pob_export.js and export again.' : ''));
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
