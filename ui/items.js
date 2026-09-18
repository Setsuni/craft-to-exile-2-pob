/* ---- items: the gear configurator ---------------------------------------

   The order the game builds an item in, and the order the bench asks for it:

     equip slot -> Normal or Unique
       Normal -> base type -> base roll (implicit) -> prefixes/suffixes -> corruption
       Unique -> which unique (its base comes with it) -> one roll per stat

   Three things worth stating because they are easy to get wrong:

   * A ring has no base_stats at all. What reads as its base stat is an
     IMPLICIT affix, and it is a real choice - hp_ring, mana_ring, ms_ring,
     ene_ring, and the gem rings. Implicits carry no tier: real items store
     only {imp, p} and the observed rolls span the full 0-100.

   * Every rolled prefix and suffix DOES carry a tier - its own GearRarity -
     and that tier fixes the roll band (common 0-17 ... mythic 86-100).

   * A base roll's span depends on the item's rarity as well as its level. A
     rare ilvl 100 bow rolls weapon damage 219-337 because rare's floor is 30%;
     the same base at common could roll as low as 168.5. */
const CAT = __CATALOG__;
const IE = makeItemEngine(CAT);

const TIERS = Object.keys(CAT.rarities).sort(
  (a, b) => CAT.rarities[a].tier - CAT.rarities[b].tier);
const band = t => CAT.rarities[t].roll_band;
const RAR_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/* Everything on the sheet that is not a tree node: gear is rebuilt from the
   Items tab and the class grid from the Class tab, so both of the save's
   static copies are dropped here rather than double-counted. */
const BASE_CONTRIBS = B.calc.contribs.filter(c => {
  const src = String(c[3]);
  /* Enchantments are recomputed live too - the editor can change them - so the
     resolver's copy is dropped here rather than counted twice. */
  /* Jewels are rebuilt from the Items tab too. */
  return !src.startsWith('gear:') && !src.startsWith('asc:') &&
         !src.startsWith('enchant:') && !src.startsWith('jewel:');
});

/* Jewel sockets are a tree outcome, not a fixed slot list: every allocated
   `jewel_socket` node grants one, so the rail grows and shrinks with the tree. */
function socketCount() {
  let n = 0;
  Object.keys(TREES).forEach(k => {
    TREES[k].alloc.forEach(key => {
      const nd = TREES[k].byKey.get(key);
      if (nd && nd.p === 'jewel_socket') n++;
    });
  });
  return n;
}
const JEWEL = CAT.jewel || { styles: [], pool: {}, affixes: {}, corrupt: {}, counts: {} };
const isJewel = id => String(id).indexOf('jewel') === 0;

const EQUIP = CAT.equip;
const SLOT_LIST = () => {
  const out = EQUIP.map(e => e.id);
  /* Equipped gear whose type no catalog slot claims still has to be visible,
     or it silently stops existing on the planner. */
  if (typeof EXTRA_SLOTS !== 'undefined') {
    EXTRA_SLOTS.forEach(id => { if (out.indexOf(id) < 0) out.push(id); });
  }
  for (let i = 0; i < socketCount(); i++) out.push('jewel' + i);
  return out;
};
const slotDef = id => EQUIP.filter(e => e.id === id)[0] || { bases: [] };
const slotName = id => isJewel(id)
  ? 'Jewel ' + (+id.slice(5) + 1)
  : (slotDef(id).name || label(id));
const basesFor = slot => slotDef(slot).bases;
const isCodex = slot => slotDef(slot).kind === 'codex';
const uniquesFor = slot => Object.keys(CAT.uniques)
  .filter(u => basesFor(slot).indexOf(CAT.uniques[u].base) >= 0).sort();

/* The save names the held weapon slot "weapon"; the catalog keys bases by
   their own gear type. Map through the base so a configured staff replaces the
   equipped one instead of stacking on it. */
/* Each equipped item gets its own slot, chosen from the slots that accept its
   gear type - so two rings land in ring1 and ring2 rather than one overwriting
   the other. An item whose type no equip slot claims (the elytra is a curio
   with its own gear type) keeps its own id and gets a slot of its own. */
function freeSlotFor(gtype, taken) {
  const fam = EQUIP.filter(e => (e.bases || []).indexOf(gtype) >= 0).map(e => e.id);
  for (const id of fam) if (!taken.has(id)) return id;
  return fam[0] || gtype;
}
const SAVE_SLOT = {};
const EXTRA_SLOTS = [];
{
  const taken = new Set();
  B.gear.forEach(it => {
    const id = freeSlotFor(it.gtype, taken);
    taken.add(id);
    SAVE_SLOT[it.slot] = id;
    if (!EQUIP.some(e => e.id === id) && EXTRA_SLOTS.indexOf(id) < 0) {
      EXTRA_SLOTS.push(id);
    }
  });
}
const SLOT_CONTRIBS = {};
B.calc.contribs.forEach(c => {
  const src = String(c[3]);
  if (src.startsWith('gear:')) {
    const sl = SAVE_SLOT[src.slice(5)] || src.slice(5);
    (SLOT_CONTRIBS[sl] = SLOT_CONTRIBS[sl] || []).push(c);
  } else if (src.startsWith('jewel:')) {
    /* `jewel:<socket>:<affix>` - the socket is what makes it a slot. */
    const sl = 'jewel' + src.slice(6).split(':')[0];
    (SLOT_CONTRIBS[sl] = SLOT_CONTRIBS[sl] || []).push(c);
  }
});
const custom = {};                       // equip slot -> configured item

/* A two-handed weapon leaves the offhand inert: the game lets you equip one,
   but none of its stats are inherited. Counting them would quietly inflate
   every defensive number on a greatsword build. */
const TWO_H = ['greatsword', 'scythe', 'spear'];
function twoHandedEquipped() {
  const w = custom.weapon;
  if (w) {
    return w.kind === 'unique'
      ? TWO_H.indexOf((CAT.uniques[w.unique] || {}).base) >= 0
      : TWO_H.indexOf(w.base) >= 0;
  }
  const eq = equippedBySlot.weapon;
  return !!eq && TWO_H.indexOf(eq.gtype) >= 0;
}

const pretty = id => nameOf('gear_type', id);
const affixName = id => (LANG.affix && LANG.affix[id]) ||
  titleCase(String(id).replace(/^gear_corrupt/, ''));
const uniqueName = id => nameOf('unique_gear', id);

const equippedBySlot = {};
B.gear.forEach(it => { equippedBySlot[SAVE_SLOT[it.slot] || it.slot] = it; });

const slot3 = () => [0, 1, 2].map(() => ({ id: '', tier: 'rare', pct: 50 }));
/* A seeded item can carry a rarity the crafting table has no entry for -
   `runeword` and `unique` are real on a character but are not craftable tiers -
   so every lookup goes through here and falls back rather than throwing. */
const rarityDef = r => CAT.rarities[r] || CAT.rarities.mythic || CAT.rarities.rare;

/* Which corruption outcomes an item can take. The table lists `unique` and
   `runeword` as rarities of their own, so the key is the item's KIND first and
   its tier only for ordinary gear. */
function corruptionKey(it) {
  if (it.kind === 'unique') return 'unique';
  if (it.kind === 'runeword') return 'runeword';
  return it.rarity;
}
const corruptionsFor = it => Object.keys(CAT.corruption)
  .filter(t => (CAT.corruption[t].rarities || []).indexOf(corruptionKey(it)) >= 0)
  .sort((a, b) => CAT.corruption[b].weight - CAT.corruption[a].weight);

/* Keep a corruption only while the derived rarity still allows it. */
function pruneCorruption() {
  const c = CAT.corruption[cur.corruption];
  if (c && c.rarities && c.rarities.indexOf(corruptionKey(cur)) < 0) {
    cur.corruption = ''; cur.cor = slot3();
  }
}

/* Rarity is not a choice, it is a consequence: an item carrying six affixes IS
   mythic. Asking for the tier and then the affixes separately let you build a
   common with six mods, which is not a thing. So the tier is read back off how
   many affixes are actually filled. */
function derivedRarity(it) {
  if (it.kind === 'unique') return 'mythic';
  const order = Object.keys(CAT.rarities)
    .sort((a, b) => CAT.rarities[a].tier - CAT.rarities[b].tier);

  /* A jewel has no prefixes or suffixes - its affixes are `jaff`, and a jewel
     rarity allows a different count from gear. Counting the wrong list made
     every seeded jewel collapse to Common, which allows one affix, so three of
     a mythic jewel's four vanished from the form. */
  if (isJewel(it.slot)) {
    const n = (it.jaff || []).filter(a => a && a.id).length;
    let byCount = order[order.length - 1];
    for (const r of order) if ((JEWEL.counts[r] || 2) >= n) { byCount = r; break; }
    /* Several jewel rarities allow the same affix count - epic and legendary
       both allow three - so counting alone cannot name the tier. Keep what the
       item arrived as unless the player has added past what it permits. */
    const seeded = it.seedRarity;
    if (seeded && CAT.rarities[seeded] &&
        CAT.rarities[seeded].tier >= CAT.rarities[byCount].tier) {
      return seeded;
    }
    return byCount;
  }

  const n = (it.pre || []).filter(a => a && a.id).length +
            (it.suf || []).filter(a => a && a.id).length;
  for (const r of order) if (CAT.rarities[r].affixes >= n) return r;
  return order[order.length - 1];
}
const slotN = n => Array.from({ length: n }, () => ({ id: '', tier: 'rare', pct: 50 }));
const noImp = () => ({ id: '', pct: 100 });
let cur = {
  slot: 'head',
  kind: 'normal', unique: '', uniqueRolls: [],
  base: null, rarity: 'rare', ilvl: B.meta.level, basePct: 100, quality: 0,
  codex: '', codexRarity: 'rare', codexPct: 60,
  style: 'int', jaff: slotN(4), jcor: slotN(2),
  imp: noImp(), pre: slot3(), suf: slot3(), corruption: '', cor: slot3(),
  inf: noImp(),
};

/* Turn an equipped item into an editor draft.

   Opening a slot used to hand you a blank form: the rail knew what was
   equipped but the editor never read it, so every real item looked like an
   empty rare of the wrong base. The bundle now carries each affix's roll
   percentage, which is what makes seeding possible at all. */
function draftFromGear(sl, g) {
  const d = Object.assign({}, cur, {
    slot: sl,
    /* Sockets alone do not make a runeword - any item can carry gems. Only a
       completed word, or the game calling the item one, does. */
    kind: g.unique ? 'unique'
      : (g.runeword || g.rarity === 'runeword') ? 'runeword' : 'normal',
    unique: g.unique || '',
    vanilla: g.item || '',
    vench: (g.ench2 || []).map(e => ({ id: e.id, lvl: e.lvl })),
    sockets: (g.sockets || []).slice(0, 6),
    socketPcts: (g.socketPcts || []).slice(0, 6),
    rwPct: g.runewordPct === undefined ? 100 : g.runewordPct,
    socketCount: g.socketCount === undefined
      ? (g.sockets || []).length : g.socketCount,
    uniqueRolls: [],
    base: g.gtype || null,
    rarity: g.rarity || 'rare',
    ilvl: g.ilvl || B.meta.level,
    basePct: g.basePct === undefined ? 100 : g.basePct,
    corruption: '',
    imp: noImp(), inf: noImp(), pre: slot3(), suf: slot3(), cor: slot3(),
  });
  const put = (arr, i, e) => {
    if (i < arr.length) { arr[i] = { id: e.id, tier: 'rare', pct: e.p || 0 }; }
  };
  let np = 0, ns = 0, nc = 0;
  (g.lines || []).forEach(l => {
    if (l.kind === 'implicit') d.imp = { id: l.id, pct: l.p === undefined ? 100 : l.p };
    else if (l.kind === 'infusion') d.inf = { id: l.id, pct: l.p === undefined ? 100 : l.p };
    else if (l.kind === 'prefix') put(d.pre, np++, l);
    else if (l.kind === 'suffix') put(d.suf, ns++, l);
    else if (l.kind === 'corrupt') put(d.cor, nc++, l);
  });
  if (g.unique && CAT.uniques[g.unique]) {
    d.base = CAT.uniques[g.unique].base;
    /* The rolls the item actually got, not the best it could have got. */
    const pc = g.uniquePercs || [];
    d.uniqueRolls = CAT.uniques[g.unique].stats.map(
      (_, i) => (pc[i] === undefined ? 100 : pc[i]));
  }
  return d;
}

/* An empty slot. Every field an item can carry is cleared, because the draft
   for the slot you are leaving is the starting point - and listing only the
   fields that existed when this was written is how an empty slot kept the last
   item's runes, enchantments and vanilla base. */
function blankDraft(sl) {
  return Object.assign({}, cur, {
    slot: sl, kind: 'normal', unique: '', uniqueRolls: [], base: null,
    rarity: 'rare', corruption: '', vanilla: '', vench: [],
    sockets: [], socketPcts: [], socketCount: 0, runeword: '', rwPct: 100,
    basePct: 100, quality: 0,
    imp: noImp(), inf: noImp(), pre: slot3(), suf: slot3(), cor: slot3(),
    jaff: slotN(4), jcor: slotN(2),
  });
}

/* A jewel from the save. Jewels have no base type - they are a style plus
   rolled affixes - so they seed differently from gear. */
function draftFromJewel(sl, j) {
  const d = Object.assign({}, cur, {
    slot: sl, kind: 'normal', unique: '', uniqueRolls: [], base: null,
    rarity: j.rar || 'rare', seedRarity: j.rar || '',
    ilvl: j.lvl || B.meta.level,
    jaff: slotN(4), jcor: slotN(2),
    /* Without this the jewel inherits the last gear item's implicit and
       infusion, which is how a jewel ended up claiming a helmet's enchant -
       and, once the vanilla sections existed, a crossbow's eight enchantments. */
    imp: noImp(), inf: noImp(), pre: slot3(), suf: slot3(), cor: slot3(),
    corruption: '', vanilla: '', vench: [], sockets: [], socketPcts: [],
    socketCount: 0, runeword: '', rwPct: 100, basePct: 100, quality: 0,
  });
  (j.affixes || []).forEach((a, i) => {
    if (i < d.jaff.length) {
      d.jaff[i] = { id: a.id || a, tier: 'rare', pct: a.p || 0 };
    }
  });
  (j.cor || []).forEach((c, i) => {
    if (i < d.jcor.length) d.jcor[i] = { id: c.id || c, tier: 'rare', pct: c.p || 0 };
  });
  return d;
}

/* Open on the item the character is actually wearing. The panel used to start
   on a blank draft, so the Items tab greeted you with a default Brigandine
   Helmet rather than the unique on your head - only clicking a slot seeded it.
   Deferred because equippedBySlot and the draft helpers are defined below. */
function seedInitialSlot() {
  const eqp = equippedBySlot[cur.slot];
  if (eqp) cur = draftFromGear(cur.slot, eqp);
}

const filled = it => [it.imp, it.inf].concat(it.pre, it.suf, it.cor)
  .filter(a => a && a.id);
const asItem = it => ({ base: it.base, ilvl: it.ilvl, basePct: it.basePct,
                        quality: it.quality || 0, affixes: filled(it) });

/* --- formatting: the game shows one decimal, so this does too ------------ */
const round1 = v => Math.round(v * 10) / 10;
const sign = v => (v > 0 ? '+' : '') + round1(v);
const unitOf = t => t === 'PERCENT' ? '%' : t === 'MORE' ? '% more' : '';
/* The game has two kinds of modifier and players plan around the
   difference. An INCREASE is additive into a pool and reads with a sign
   ("+21%"); a MORE is its own multiplier and reads as "21% more".
   Signing a multiplier - "+21% more" - blurs the two, so the sign is
   dropped there. */
const valText = (v, type) =>
  (type === 'MORE' ? round1(v) : sign(v)) + unitOf(type);
/* Good is green, bad is red - and "good" is not the same as "positive". The
   game flags 38 stats where lower is better (aura costs, damage received), so
   a -20 mana cost is an improvement and should read green. */
const MINUS_GOOD = new Set(CAT.minusGood || []);
function goodBad(stat, v) {
  if (!v) return '';
  const better = MINUS_GOOD.has(stat) ? v < 0 : v > 0;
  return better ? 'up' : 'down';
}
const modText = m => '<span class="' + goodBad(m.stat, m.value) + '">' +
  valText(m.value, m.type) + '</span> ' + label(m.stat);
const spanOf = (m, lo, hi, ilvl) => {
  const a = IE.exact(m, lo, ilvl).value, b = IE.exact(m, hi, ilvl).value;
  return Math.abs(b - a) < 0.05 ? sign(b) : sign(a) + '–' + round1(b);
};
const spanText = (def, tier, ilvl) => def.stats.map(m =>
  spanOf(m, band(tier)[0], band(tier)[1], ilvl) + unitOf(m.type) + ' ' + label(m.stat)).join(', ');
const fullRange = (def, ilvl) => def.stats.map(m =>
  spanOf(m, 0, 100, ilvl) + unitOf(m.type) + ' ' + label(m.stat)).join(', ');

/* --- slot rail ----------------------------------------------------------- */
/* A roll slider, wired the way every one of them wants to behave: while you
   drag, the character sheet on the left follows you; when you let go, the
   panel that owns the slider and the item card catch up too.

   They used to repaint only their own panel and the card, so moving a roll
   changed the item preview while the sheet beside it stayed on the old value
   until you pressed Equip. */
function rollSlider(el, set, repaint) {
  if (!el) return;
  bindSlider(el, v => { set(v); repaint(); paintCard(); applyNow(); });
  const readout = el.oninput;
  let queued = false;
  el.oninput = e => {
    if (readout) readout.call(el, e);
    set(+el.value);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; applyLive(); });
  };
}

function paintRail() {
  const el = document.getElementById('slots');
  const locked = twoHandedEquipped();
  el.innerHTML = SLOT_LIST().map(sl => {
    /* A socketed jewel is worn gear too, but it does not live in
       equippedBySlot - so every filled socket read "empty" on the rail. */
    const c = custom[sl];
    const eq = isJewel(sl) ? (B.jewels || [])[+sl.slice(5)] : equippedBySlot[sl];
    const dead = sl === 'offhand' && locked;
    const sub = dead ? 'inert, two-handed weapon'
      : c
        ? (isCodex(sl) ? CAT.codex[c.codex].name
           : isJewel(sl) ? label(c.style) + ' · ' + label(c.rarity)
           : c.kind === 'unique' ? uniqueName(c.unique)
           : pretty(c.base) + ' · ilvl ' + c.ilvl)
        : eq ? (isJewel(sl)
            ? label(eq.rar || 'rare') + ' · ' +
              ((eq.affixes || []).length + (eq.cor || []).length) + ' affixes'
            : gearLabel(eq))
        : 'empty';
    return '<button class="slotbtn' + (c ? ' custom' : '') + (dead ? ' locked' : '') +
      '" data-sl="' + sl + '" aria-current="' + (sl === cur.slot) + '">' + slotName(sl) +
      '<small>' + sub + '</small></button>';
  }).join('');
  el.querySelectorAll('.slotbtn').forEach(b => b.onclick = () => {
    const sl = b.dataset.sl, c = custom[sl];
    /* Your own item first, then a configured override, then a blank form. */
    const eqp = equippedBySlot[sl];
    const jw = isJewel(sl) ? (B.jewels || [])[+sl.slice(5)] : null;
    cur = c ? JSON.parse(JSON.stringify(Object.assign({ slot: sl }, c)))
      : isJewel(sl) ? draftFromJewel(sl, jw || {})
      : eqp ? draftFromGear(sl, eqp)
      : blankDraft(sl);
    applyNow();
  });
}

function selectUnique(uid) {
  cur.unique = uid || '';
  const u = CAT.uniques[uid];
  if (u) { cur.base = u.base; cur.uniqueRolls = u.stats.map(() => 100); }
  cur.pre = slot3(); cur.suf = slot3();
  /* keep the implicit if the new unique's base can still roll it */
  const pool = ((CAT.bases[cur.base] || {}).pool || {}).implicit || [];
  if (cur.imp.id && pool.indexOf(cur.imp.id) < 0) cur.imp = noImp();
}

/* --- slot / type / base / rarity / level --------------------------------- */
function paintSelectors() {
  document.getElementById('f-slot').innerHTML = SLOT_LIST().map(sl =>
    '<option value="' + sl + '"' + (sl === cur.slot ? ' selected' : '') + '>' +
    slotName(sl) + '</option>').join('');

  const jew = isJewel(cur.slot);
  document.getElementById('benchhd').innerHTML = slotName(cur.slot) +
    '<em>' + (jew ? 'from a tree socket'
      : isCodex(cur.slot) ? 'curio'
      : (slotDef(cur.slot).bases || []).length + ' base types') + '</em>';
  const codexSlot = isCodex(cur.slot);
  const uni = codexSlot ? [] : uniquesFor(cur.slot);
  const kindSel = document.getElementById('f-kind');
  const words = codexSlot || jew ? [] : runewordsForSlot(cur.slot);
  kindSel.innerHTML =
    '<option value="normal"' + (cur.kind === 'normal' ? ' selected' : '') + '>Normal</option>' +
    '<option value="unique"' + (cur.kind === 'unique' ? ' selected' : '') + '>Unique' +
    (uni.length ? ' — ' + uni.length + ' for this slot' : ' — none') + '</option>' +
    (words.length || cur.kind === 'runeword'
      ? '<option value="runeword"' + (cur.kind === 'runeword' ? ' selected' : '') +
        '>Runeword — ' + words.length + ' for this base</option>' : '');
  kindSel.disabled = codexSlot || jew || (!uni.length && !words.length);
  document.getElementById('kindrow').hidden = codexSlot || jew;

  const isUni = cur.kind === 'unique' && !codexSlot && !jew;
  /* A ring or necklace has exactly one base type - a dropdown with a single
     option is a control that cannot be operated, so it goes away. */
  const oneBase = basesFor(cur.slot).length <= 1;
  document.getElementById('baserow').hidden = codexSlot || jew || isUni || oneBase;
  document.getElementById('unirow').hidden = codexSlot || jew || !isUni;
  paintSockets(!codexSlot && !jew && !!cur.base);


  if (isUni) {
    if (!cur.unique || uni.indexOf(cur.unique) < 0) selectUnique(uni[0]);
    document.getElementById('f-uni').innerHTML = uni.map(u =>
      '<option value="' + u + '"' + (u === cur.unique ? ' selected' : '') + '>' +
      uniqueName(u) + '  [' + pretty(CAT.uniques[u].base) + ']</option>').join('');
  } else if (!codexSlot) {
    const list = basesFor(cur.slot);
    if (!cur.base || list.indexOf(cur.base) < 0) cur.base = list[0] || null;
    const bSel = document.getElementById('f-base');
    bSel.innerHTML = list.length
      ? list.map(b => '<option value="' + b + '"' + (b === cur.base ? ' selected' : '') + '>' +
          pretty(b) + '  [' + (CAT.bases[b].label || 'no base stats') + ']</option>').join('')
      : '<option value="">no bases for this slot</option>';
    bSel.disabled = !list.length;
  }

  /* Shown, not chosen. A runeword has no affixes to count, so it says so. */
  cur.rarity = cur.kind === 'runeword' ? 'runeword' : derivedRarity(cur);
  pruneCorruption();
  const rOut = document.getElementById('f-rar-out');
  if (rOut) {
    rOut.textContent = cur.kind === 'runeword' ? 'Runeword'
      : cur.kind === 'unique' ? 'Unique'
      : label(cur.rarity);
  }

  document.getElementById('f-ilvl').value = cur.ilvl;
  document.getElementById('f-bpct').value = cur.basePct;
}

/* --- base stats, with the span this rarity can actually roll -------------- */
function paintBaseStats() {
  const el = document.getElementById('basestats');
  const b = CAT.bases[cur.base];
  if (!b) { el.innerHTML = '<span class="req">no base selected</span>'; return; }
  const isUni = cur.kind === 'unique';
  const floor = isUni ? rarityDef('mythic').base_floor : rarityDef(cur.rarity).base_floor;
  const rname = isUni ? 'Unique' : label(cur.rarity);
  const lines = b.base_stats.map(m =>
    '<div><b>' + sign(IE.exact(m, cur.basePct, cur.ilvl).value) + '</b> ' + label(m.stat) +
    ' <span class="basespan">' + spanOf(m, floor, 100, cur.ilvl) + ' at ' + rname +
    ' · ' + spanOf(m, 0, 100, cur.ilvl) + ' over all rarities</span></div>').join('');
  const req = Object.keys(b.req || {})
    .map(k => Math.ceil(b.req[k] * cur.ilvl) + ' ' + label(k)).join(', ');
  el.innerHTML = (lines ||
      '<span class="req">this type has no base stats — its base roll is the implicit below</span>') +
    '<span class="req">' + (req ? 'requires ' + req + ' · ' : '') + b.style +
    ' · ' + rname + ' rolls base stats at ' + floor + '–100%</span>';
}

/* --- implicit: the base roll on jewellery -------------------------------- */
function paintImplicit() {
  const box = document.getElementById('implicitbox');
  const b = CAT.bases[cur.base];
  const pool = (b && b.pool.implicit) || [];
  /* A unique keeps its base's implicit - measured on the corpus, 7 of 13
     unique items carried one (hp_ring, blood_amulet, mind_cage...). */
  if (!pool.length) { box.innerHTML = ''; return; }
  const e = cur.imp;
  const opts = ['<option value="">— none —</option>'].concat(
    pool.map(id => '<option value="' + id + '"' + (id === e.id ? ' selected' : '') + '>' +
      affixName(id) + '  (' + fullRange(CAT.affixes[id], cur.ilvl) + ')</option>')).join('');
  let body = '';
  if (e.id) {
    const def = CAT.affixes[e.id];
    body = '<div class="afctl" style="grid-template-columns:minmax(0,1fr) 38px">' +
      '<input type="range" id="imp-r" min="0" max="100" value="' + e.pct +
      '" aria-label="Implicit roll percent"><b>' + e.pct + '%</b></div>' +
      '<div class="afval">' + def.stats.map(m => modText(IE.exact(m, e.pct, cur.ilvl))).join(', ') +
      '<span class="afspan">full range ' + fullRange(def, cur.ilvl) +
      ' · implicits carry no tier, they roll 0–100%</span></div>';
  }
  box.innerHTML = '<div class="implicit"><h4>Base roll (implicit) <em>' + pool.length +
    ' possible</em></h4><select id="f-imp" aria-label="Implicit">' + opts + '</select>' +
    body + '</div>';
  document.getElementById('f-imp').onchange = ev => {
    cur.imp = { id: ev.target.value, pct: 100 }; applyNow();
  };
  if (e.id) rollSlider(document.getElementById('imp-r'),
    v => { cur.imp.pct = v; }, paintImplicit);
}

/* --- unique: a fixed stat list, one roll each ---------------------------- */
function paintUnique() {
  const box = document.getElementById('uniquebox');
  if (cur.kind !== 'unique') { box.innerHTML = ''; return; }
  const u = CAT.uniques[cur.unique];
  if (!u) { box.innerHTML = '<div class="empty">No uniques for this slot.</div>'; return; }
  let setInfo = '';
  if (u.set && CAT.sets[u.set]) {
    setInfo = '<span class="req">Part of the <b>' + titleCase(u.set) + '</b> set: ' +
      CAT.sets[u.set].bonuses.map(bn => bn.pieces + '-piece → ' +
        bn.stats.map(m => valText(m.max, m.type) + ' ' + label(m.stat)).join(', '))
        .join(' · ') + '</span>';
  }
  box.innerHTML = '<div class="implicit"><h4>Unique stats <em>' +
    (u.lvl ? 'drops from level ' + u.lvl : '') + (u.league ? ' · ' + u.league : '') +
    '</em></h4>' +
    u.stats.map((m, i) => {
      const pct = cur.uniqueRolls[i] === undefined ? 100 : cur.uniqueRolls[i];
      return '<div class="afrow"><div class="afval" style="margin:0">' +
        modText(IE.exact(m, pct, cur.ilvl)) +
        '<span class="afspan">range ' + spanOf(m, 0, 100, cur.ilvl) + unitOf(m.type) +
        '</span></div><div class="afctl" style="grid-template-columns:minmax(0,1fr) 38px">' +
        '<input type="range" data-u="' + i + '" min="0" max="100" value="' + pct +
        '" aria-label="Roll for ' + label(m.stat) + '"><b>' + pct + '%</b></div></div>';
    }).join('') +
    (u.item ? '<span class="req">forces item ' + u.item + '</span>' : '') + setInfo + '</div>';
  box.querySelectorAll('input[data-u]').forEach(r => rollSlider(r,
    v => { cur.uniqueRolls[+r.dataset.u] = v; }, paintUnique));
}

/* --- one affix row: affix, tier, roll ------------------------------------ */
function affixRow(kind, i, entry, pool, disabled) {
  const taken = filled(cur).filter(a => a !== entry).map(a => a.id);
  const opts = ['<option value="">— empty —</option>'].concat(
    pool.map(id => '<option value="' + id + '"' +
      (id === entry.id ? ' selected' : '') +
      (taken.indexOf(id) >= 0 && id !== entry.id ? ' disabled' : '') + '>' +
      affixName(id) + '  (' + fullRange(CAT.affixes[id], cur.ilvl) + ')</option>')).join('');
  let body = '';
  if (entry.id) {
    const def = CAT.affixes[entry.id];
    const lo = band(entry.tier)[0], hi = band(entry.tier)[1];
    const maxTier = rarityDef(cur.rarity).tier;
    const tierOpts = TIERS.map(t =>
      '<option value="' + t + '"' + (t === entry.tier ? ' selected' : '') + '>T' +
      (CAT.rarities[t].tier + 1) + ' ' + label(t) + ' ' + band(t)[0] + '–' +
      band(t)[1] + '%' + (CAT.rarities[t].tier > maxTier ? ' ↑craft' : '') +
      '</option>').join('');
    body = '<div class="afctl">' +
      '<select class="tiersel" data-kind="' + kind + '" data-i="' + i +
      '" data-tier="1" aria-label="Tier">' + tierOpts + '</select>' +
      '<input type="range" min="' + lo + '" max="' + hi + '" value="' + entry.pct +
      '" data-kind="' + kind + '" data-i="' + i +
      '" aria-label="Roll percent within tier"><b>' + entry.pct + '%</b></div>' +
      '<div class="afval">' +
      def.stats.map(m => modText(IE.exact(m, entry.pct, cur.ilvl))).join(', ') +
      '<span class="afspan">tier span ' + spanText(def, entry.tier, cur.ilvl) + '</span></div>';
  }
  return '<div class="afrow"><select data-kind="' + kind + '" data-i="' + i +
    '" aria-label="' + label(kind) + ' ' + (i + 1) + '"' +
    (disabled ? ' disabled' : '') + '>' + opts + '</select>' + body + '</div>';
}


/* Corruption, for every kind of item. This used to live inside
   paintAffixes, after an early return that skips a unique - so a unique
   showed an empty Corruption dropdown that never populated. */
function paintCorruption() {
  const b = CAT.bases[cur.base];
  const tiers = Object.keys(CAT.corruption)
    .filter(t => CAT.corruption[t].rarities.indexOf(corruptionKey(cur)) >= 0)
    .sort((a, b2) => CAT.corruption[b2].weight - CAT.corruption[a].weight);
  document.getElementById('f-cor').innerHTML =
    '<option value="">Uncorrupted</option>' + tiers.map(t => {
      const c = CAT.corruption[t];
      return '<option value="' + t + '"' + (t === cur.corruption ? ' selected' : '') + '>' +
        c.name + ' — ' + c.affixes + ' mod' + (c.affixes > 1 ? 's' : '') +
        (c.sockets ? ', +' + c.sockets + ' socket' : '') +
        ' (' + c.chance + '% of corruptions)</option>';
    }).join('');

  const tier = CAT.corruption[cur.corruption];
  const mods = document.getElementById('cormods');
  const pool = (b && b.pool.chaos_stat) || [];
  if (!tier) {
    mods.innerHTML = '';
    document.getElementById('ccount').textContent = pool.length + ' possible on this base';
  } else {
    const n = cur.cor.filter(a => a.id).length;
    document.getElementById('ccount').textContent =
      n + '/' + tier.affixes + ' chosen · ' + pool.length + ' possible' +
      (tier.sockets ? ' · +' + tier.sockets + ' socket' : '');
    mods.innerHTML = pool.length
      ? cur.cor.slice(0, tier.affixes).map((e, i) => affixRow('cor', i, e, pool, false)).join('')
      : '<div class="empty">this base has no corruption outcomes</div>';
  }
}

/* Infusion, likewise - a unique carries one too. */
function paintInfusion() {
  const b = CAT.bases[cur.base];
  /* Infusions: the `enchant` affix type, one per item, gated on the base's tag
     the same way a prefix is. The save records only {en, rar} - no roll
     percent - so the game takes them at full value; the slider is here because
     a planner wants to ask "what if this rolled low", not because the game
     rolls it. */
  const ipool = (b && b.pool.enchant) || [];
  document.getElementById('infblock').hidden = !ipool.length;
  if (ipool.length) {
    document.getElementById('icount').textContent = ipool.length + ' for this base';
    document.getElementById('f-inf').innerHTML =
      '<option value="">\u2014 none \u2014</option>' + ipool.map(id =>
        '<option value="' + id + '"' + (id === cur.inf.id ? ' selected' : '') + '>' +
        affixName(id) + '  (' + fullRange(CAT.affixes[id], cur.ilvl) + ')</option>').join('');
    const e = cur.inf;
    document.getElementById('infmods').innerHTML = e.id
      ? '<div class="afctl" style="grid-template-columns:minmax(0,1fr) 38px">' +
        '<input type="range" id="inf-r" min="0" max="100" value="' + e.pct +
        '" aria-label="Infusion roll"><b>' + e.pct + '%</b></div>' +
        '<div class="afval">' +
        CAT.affixes[e.id].stats.map(m => modText(IE.exact(m, e.pct, cur.ilvl))).join(', ') +
        '<span class="afspan">full range ' + fullRange(CAT.affixes[e.id], cur.ilvl) +
        ' \u00b7 the game applies infusions at 100%</span></div>'
      : '';
    document.getElementById('f-inf').onchange = ev => {
      cur.inf = { id: ev.target.value, pct: 100 }; applyNow();
    };
    if (e.id) rollSlider(document.getElementById('inf-r'),
      v => { cur.inf.pct = v; }, paintAffixes);
  }
}
function paintAffixes() {
  const uni = cur.kind === 'unique';
  /* A runeword's runes REPLACE its affixes - it has no prefixes or suffixes at
     all - so the pools go away entirely rather than sit there empty. */
  /* A runeword has no prefixes or suffixes; a normal item does, and can still
     carry runes alongside them. */
  const rw = cur.kind === 'runeword';
  document.getElementById('affixpools').hidden = uni || rw;
  /* Corruption applies to EVERYTHING - a unique can be corrupted, and doing so
     is how it gains an extra socket. Hiding it for uniques removed the one
     mechanic that changes their socket count. */
  document.getElementById('corblock').hidden = false;
  /* A unique carries an infusion too - the player's helmet reads Infused(9/10)
     in game - so this is not a normal-item-only control either. */
  document.getElementById('infblock').hidden = false;
  if (uni) { paintCorruption(); paintInfusion(); return; }

  const b = CAT.bases[cur.base];
  const budget = rarityDef(cur.rarity).affixes;
  const used = cur.pre.filter(a => a.id).length + cur.suf.filter(a => a.id).length;

  [['prefix', 'pre', 'list-pre', 'pcount'],
   ['suffix', 'suf', 'list-suf', 'scount2']].forEach(spec => {
    const kind = spec[0], key = spec[1];
    const pool = (b && b.pool[kind]) || [];
    const n = cur[key].filter(a => a.id).length;
    document.getElementById(spec[3]).textContent =
      n + '/3 chosen · ' + pool.length + ' rollable';
    document.getElementById(spec[2]).innerHTML = pool.length
      ? cur[key].map((e, i) => affixRow(key, i, e, pool, !e.id && used >= budget)).join('')
      : '<div class="empty">this base rolls no ' + kind + 'es</div>';
  });

  paintCorruption();
  paintInfusion();

  document.querySelectorAll('#affixpools select[data-kind], #corblock select[data-kind]')
    .forEach(sel => {
      sel.onchange = () => {
        const arr = cur[sel.dataset.kind], i = +sel.dataset.i;
        if (sel.dataset.tier) {
          arr[i].tier = sel.value;
          arr[i].pct = Math.round((band(sel.value)[0] + band(sel.value)[1]) / 2);
        } else {
          const t = arr[i].id ? arr[i].tier : cur.rarity;
          arr[i] = { id: sel.value, tier: t,
                     pct: Math.round((band(t)[0] + band(t)[1]) / 2) };
        }
        applyNow();
      };
    });
  document.querySelectorAll('#affixpools input[type=range][data-kind], #corblock input[type=range][data-kind]')
    .forEach(r => rollSlider(r, v => {
      cur[r.dataset.kind][+r.dataset.i].pct = v;
    }, paintAffixes));
}

/* --- codex --------------------------------------------------------------- */
function paintCodex() {
  const box = document.getElementById('codexbox');
  const on = isCodex(cur.slot);
  box.hidden = !on;
  document.getElementById('basestats').hidden = on;
  if (on) {
    document.getElementById('affixpools').hidden = true;
    document.getElementById('corblock').hidden = true;
    document.getElementById('infblock').hidden = true;
  }
  if (!on) return;

  const ids = Object.keys(CAT.codex).sort();
  if (!cur.codex || !CAT.codex[cur.codex]) cur.codex = ids[0];
  const c = CAT.codex[cur.codex];
  const diff = CAT.codexDifficulty[cur.codexRarity] || {};
  const mult = diff.stat_multi || 1;
  const maxPct = Math.round(((diff.normal ? diff.normal.max : 0) +
    (diff.unique ? diff.unique.max : 0) + (diff.runed ? diff.runed.max : 0) +
    (diff.specific_slots ? diff.specific_slots.max : 0)) * 10 * mult);

  box.innerHTML = '<div class="cdx">' +
    '<h4>Codex <em>curio · 1 slot · drops from level 50</em></h4>' +
    '<div class="row"><label for="f-cdx">Codex</label><select id="f-cdx">' +
      ids.map(i => '<option value="' + i + '"' + (i === cur.codex ? ' selected' : '') + '>' +
        CAT.codex[i].name + '</option>').join('') + '</select></div>' +
    '<div class="row"><label for="f-cdxr">Rarity</label><select id="f-cdxr">' +
      RAR_ORDER.filter(r => CAT.codexDifficulty[r]).map(r =>
        '<option value="' + r + '"' + (r === cur.codexRarity ? ' selected' : '') + '>' +
        label(r) + ' — stat multi ' + CAT.codexDifficulty[r].stat_multi +
        '</option>').join('') + '</select></div>' +
    '<div class="row"><label for="f-cdxp">Diversity</label>' +
      '<input type="range" id="f-cdxp" min="0" max="' + Math.max(maxPct, 10) +
      '" value="' + cur.codexPct + '"><b class="pts">' + cur.codexPct + '%</b></div>' +
    '<div class="basestats">' +
      c.mods.map(m => '<div><b>' +
        valText(m.min + (m.max - m.min) * Math.min(cur.codexPct, 100) / 100, m.type) +
        '</b> ' + label(m.stat) + ' <span class="basespan">range ' + valText(m.min) +
        '–' + round1(m.max, m.type) + '</span></div>').join('') +
      '<span class="req">Requires, at ' + label(cur.codexRarity) + ': ' +
      ['normal', 'unique', 'runed'].filter(k => diff[k])
        .map(k => diff[k].min + '–' + diff[k].max + ' ' + k).join(', ') +
      (diff.specific_slots ? ', ' + diff.specific_slots.min + '–' +
        diff.specific_slots.max + ' named slots' : '') +
      '. Each satisfied requirement is worth 10%, times ' + mult +
      ', so this Codex tops out at ' + maxPct + '%.</span></div>' +
    wornCodex() + '</div>';

  document.getElementById('f-cdx').onchange = e => {
    cur.codex = e.target.value;
    cur.codexEquipped = !!e.target.value;
    applyNow();
  };
  document.getElementById('f-cdxr').onchange = e => { cur.codexRarity = e.target.value; applyNow(); };
  rollSlider(document.getElementById('f-cdxp'),
    v => { cur.codexPct = v; }, paintCodex);
}

/* The codex you are actually wearing, tier by tier.

   A codex is not one bonus: it is a ladder. The registry's own mods sit at the
   TOP tier - the full requirement total - and each ROLLED affix sits one tier
   below, in order. So a codex needing {NORMAL 2, UNIQUE 2, RUNED 3} tops out at
   7 and reads 5 Piece / 6 Piece / 7 Piece.

   Derived from four in-game tooltips and consistent with all of them. The
   planner previously showed only the registry mods, so the rolled affixes - the
   magic find on this character's Codex of Spite - were invisible. */
function wornCodex() {
  const list = B.codex || [];
  if (!list.length) return '';
  return list.map(c => {
    const reqs = Object.keys(c.reqs).map(k =>
      '<span class="' + ((c.worn[k] || 0) >= c.reqs[k] ? 'up' : 'down') + '">' +
      (c.worn[k] || 0) + '/' + c.reqs[k] + ' ' + titleCase(k.toLowerCase()) +
      '</span>').join(' · ');
    return '<div class="pool"><h4>Equipped: ' +
      ((CAT.codex[c.id] || {}).name || titleCase(c.id)) +
      '<em>' + label(c.rarity) + ' · ' + c.met + '/' + c.total + ' pieces</em></h4>' +
      '<div class="afval">' + reqs +
      (c.slotReq && c.slotReq.length
        ? '<span class="afspan">named slots: ' + c.slotReq.join(', ') + '</span>'
        : '') + '</div>' +
      c.tiers.map(t =>
        '<div class="afrow' + (t.active ? '' : ' dim') + '">' +
        '<div class="afval"><b>' + t.pieces + ' Piece</b> ' +
        (t.active ? '<span class="up">active</span>'
                  : '<span class="down">needs ' + (t.pieces - c.met) + ' more</span>') +
        (t.id ? '<span class="afspan">' + affixName(t.id) + '</span>' : '') +
        '</div>' +
        '<div class="afval">' + (t.stats || []).map(m =>
          valText(m.value, m.type) + ' ' + label(m.stat)).join(', ') + '</div></div>'
      ).join('') + '</div>';
  }).join('');
}

/* --- jewels --------------------------------------------------------------
   A jewel is not gear: no base type, no implicit, no prefix/suffix split. It
   has a style (str / dex / int) which decides its affix pool, a rarity which
   decides how many affixes it carries, a level, and one optional corruption.
   Affixes carry tiers exactly as gear affixes do. */
function jewelPool() { return (JEWEL.pool[cur.style] || []); }
function jewelCount() { return JEWEL.counts[cur.rarity] || 2; }

function jewelRow(kind, i, entry, pool) {
  const taken = cur.jaff.filter(a => a !== entry && a.id).map(a => a.id);
  /* A runeword jewel's affixes are not in the craftable pool - `firejewel_res`
     exists on the item but in no style's list - so the row shows what is there
     and skips the editor rather than throwing on a missing definition. */
  if (entry.id && !defOf(entry.id)) {
    /* Not in the craftable pool, but the affix is real and has stats - a
       crafted jewel's `firejewel_res` grants 3-15 fire resist. Read the
       definition straight from the affix table and show what it gives. */
    const def = CAT.affixes[entry.id];
    const lines = def
      ? def.stats.map(m => modText(IE.exact(m, entry.pct, cur.ilvl))).join(', ')
      : '';
    return '<div class="afrow"><select disabled><option>' +
      affixName(entry.id) + '</option></select>' +
      '<div class="afval">' + lines +
      '<span class="afspan">crafted jewel affix \u2014 not rollable here, ' +
      'shown as it is on the item</span></div></div>';
  }
  const opts = ['<option value="">— empty —</option>'].concat(
    pool.map(id => '<option value="' + id + '"' +
      (id === entry.id ? ' selected' : '') +
      (taken.indexOf(id) >= 0 && id !== entry.id ? ' disabled' : '') + '>' +
      affixName(id) + '  (' + fullRange(defOf(id), cur.ilvl) + ')</option>')).join('');
  let body = '';
  if (entry.id) {
    const def = defOf(entry.id);
    const lo = band(entry.tier)[0], hi = band(entry.tier)[1];
    const tierOpts = TIERS.map(t =>
      '<option value="' + t + '"' + (t === entry.tier ? ' selected' : '') + '>T' +
      (CAT.rarities[t].tier + 1) + ' ' + titleCase(t) + ' ' + band(t)[0] + '–' +
      band(t)[1] + '%</option>').join('');
    body = '<div class="afctl">' +
      '<select class="tiersel" data-jk="' + kind + '" data-i="' + i +
      '" data-tier="1" aria-label="Tier">' + tierOpts + '</select>' +
      '<input type="range" min="' + lo + '" max="' + hi + '" value="' + entry.pct +
      '" data-jk="' + kind + '" data-i="' + i + '" aria-label="Roll"><b>' +
      entry.pct + '%</b></div>' +
      '<div class="afval">' +
      def.stats.map(m => modText(IE.exact(m, entry.pct, cur.ilvl))).join(', ') +
      '<span class="afspan">tier span ' + spanText(def, entry.tier, cur.ilvl) +
      '</span></div>';
  }
  return '<div class="afrow"><select data-jk="' + kind + '" data-i="' + i +
    '" aria-label="Jewel affix ' + (i + 1) + '">' + opts + '</select>' + body + '</div>';
}
const defOf = id => JEWEL.affixes[id] || JEWEL.corrupt[id] || CAT.affixes[id];

function paintJewel() {
  const box = document.getElementById('jewelbox');
  const on = isJewel(cur.slot);
  box.hidden = !on;
  if (!on) return;
  document.getElementById('affixpools').hidden = true;
  document.getElementById('corblock').hidden = true;
  document.getElementById('infblock').hidden = true;
  document.getElementById('basestats').hidden = true;

  const pool = jewelPool();
  /* Room for the most any rarity allows, so a seeded mythic is not truncated
     by a form sized for a lesser one. */
  const most = Math.max.apply(null, Object.keys(JEWEL.counts || {})
    .map(r => JEWEL.counts[r]).concat([4]));
  if (cur.jaff.length < most) {
    cur.jaff = cur.jaff.concat(slotN(most - cur.jaff.length));
  }
  const n = Math.max(jewelCount(),
                     cur.jaff.filter(a => a && a.id).length);
  const corIds = Object.keys(JEWEL.corrupt).sort();
  const corOpts = sel => ['<option value="">— uncorrupted —</option>'].concat(
    corIds.map(id =>
      '<option value="' + id + '"' + (id === sel ? ' selected' : '') + '>' +
      affixName(id) + '  (' + fullRange(JEWEL.corrupt[id], cur.ilvl) + ')</option>')).join('');

  box.innerHTML = '<div class="cdx">' +
    '<div class="row"><label for="f-jst">Style</label><select id="f-jst">' +
      JEWEL.styles.map(st => '<option value="' + st + '"' +
        (st === cur.style ? ' selected' : '') + '>' + st.toUpperCase() +
        ' — ' + (JEWEL.pool[st] || []).length + ' affixes</option>').join('') +
      '</select></div>' +
    '<div class="pool"><h4>Affixes <em>' +
      cur.jaff.slice(0, n).filter(a => a.id).length + '/' + n + ' · ' +
      pool.length + ' rollable</em></h4>' +
      cur.jaff.slice(0, n).map((e, i) => jewelRow('jaff', i, e, pool)).join('') +
    '</div>' +
    '<div class="pool corblock"><h4>Corruption <em>' +
      corIds.length + ' possible</em></h4>' +
      /* One row per corruption the jewel carries, plus one empty row to add
         another while there is room. */
      cur.jcor.map((e, i) => (e.id || i === cur.jcor.filter(x => x.id).length)
        ? '<select data-jcs="' + i + '" aria-label="Jewel corruption ' + (i + 1) +
          '">' + corOpts(e.id) + '</select>' +
          (e.id ? jewelRow('jcor', i, e, corIds) : '')
        : '').join('') +
    '</div></div>';

  document.getElementById('f-jst').onchange = e => {
    cur.style = e.target.value;
    const p2 = jewelPool();
    cur.jaff = cur.jaff.map(a => (a.id && p2.indexOf(a.id) < 0)
      ? { id: '', tier: cur.rarity, pct: 50 } : a);
    applyNow();
  };
  box.querySelectorAll('select[data-jcs]').forEach(sel => sel.onchange = () => {
    cur.jcor[+sel.dataset.jcs] = { id: sel.value, tier: cur.rarity,
      pct: Math.round((band(cur.rarity)[0] + band(cur.rarity)[1]) / 2) };
    /* Clearing one closes the gap, so the empty row stays at the end. */
    cur.jcor = cur.jcor.filter(e => e.id)
      .concat(slotN(2)).slice(0, 2);
    applyNow();
  });
  box.querySelectorAll('select[data-jk]').forEach(sel => sel.onchange = () => {
    const i = +sel.dataset.i;
    const tgt = sel.dataset.jk === 'jcor' ? cur.jcor[i] : cur.jaff[i];
    if (sel.dataset.tier) {
      tgt.tier = sel.value;
      tgt.pct = Math.round((band(sel.value)[0] + band(sel.value)[1]) / 2);
    } else if (sel.dataset.jk === 'jaff') {
      cur.jaff[i] = { id: sel.value, tier: cur.rarity,
                      pct: Math.round((band(cur.rarity)[0] + band(cur.rarity)[1]) / 2) };
    }
    applyNow();
  });
  box.querySelectorAll('input[type=range][data-jk]').forEach(r => rollSlider(r, v => {
    const tgt = r.dataset.jk === 'jcor' ? cur.jcor[+r.dataset.i]
      : cur.jaff[+r.dataset.i];
    tgt.pct = v;
  }, paintJewel));
}

function jewelStats(it) {
  /* The rarity decides how many affixes a jewel can be CRAFTED with, but an
     imported jewel already has what it has - a runeword jewel carries three
     where the table allows two, and capping it here silently deleted the
     third. */
  const n = Math.max(JEWEL.counts[it.rarity] || 2,
                     (it.jaff || []).filter(a => a && a.id).length);
  const out = [];
  (it.jaff || []).slice(0, n).forEach(a => {
    if (!a.id) return;
    const def = defOf(a.id);
    if (def) def.stats.forEach(m => out.push(IE.exact(m, a.pct, it.ilvl)));
  });
  (it.jcor || []).forEach(c => {
    if (!c || !c.id) return;
    const def = defOf(c.id);
    if (def) def.stats.forEach(m => out.push(IE.exact(m, c.pct, it.ilvl)));
  });
  return out;
}

/* --- randomiser ---------------------------------------------------------- */
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function pickWeighted(ids) {
  const total = ids.reduce((s, id) => s + (CAT.affixes[id].weight || 1), 0);
  let r = Math.random() * total;
  for (const id of ids) { r -= (CAT.affixes[id].weight || 1); if (r <= 0) return id; }
  return ids[ids.length - 1];
}
function rollTier() {
  const maxT = CAT.rarities[cur.rarity].tier;
  return pick(TIERS.filter(t => CAT.rarities[t].tier <= maxT));
}
function rollAffixes(kind, key, n) {
  const pool = (CAT.bases[cur.base] || { pool: {} }).pool[kind] || [];
  const out = slot3(), chosen = [];
  for (let i = 0; i < Math.min(n, 3, pool.length); i++) {
    let id, guard = 0;
    do { id = pickWeighted(pool); } while (chosen.indexOf(id) >= 0 && ++guard < 40);
    if (chosen.indexOf(id) >= 0) break;
    chosen.push(id);
    const t = rollTier(), lo = band(t)[0], hi = band(t)[1];
    out[i] = { id: id, tier: t, pct: lo + Math.floor(Math.random() * (hi - lo + 1)) };
  }
  cur[key] = out;
}
function randomise() {
  if (isJewel(cur.slot)) {
    const pool = jewelPool();
    const n = jewelCount(), chosen = [];
    cur.jaff = slotN(4);
    for (let i = 0; i < Math.min(n, pool.length); i++) {
      let id, guard = 0;
      do { id = pool[Math.floor(Math.random() * pool.length)]; }
      while (chosen.indexOf(id) >= 0 && ++guard < 40);
      if (chosen.indexOf(id) >= 0) break;
      chosen.push(id);
      const t = rollTier(), lo = band(t)[0], hi = band(t)[1];
      cur.jaff[i] = { id: id, tier: t, pct: lo + Math.floor(Math.random() * (hi - lo + 1)) };
    }
    applyNow(); return;
  }
  if (isCodex(cur.slot)) {
    cur.codex = pick(Object.keys(CAT.codex));
    cur.codexPct = Math.floor(Math.random() * 101);
    applyNow(); return;
  }
  if (cur.kind === 'unique') {
    const uni = uniquesFor(cur.slot);
    if (!uni.length) return;
    selectUnique(pick(uni));
    cur.uniqueRolls = cur.uniqueRolls.map(() => Math.floor(Math.random() * 101));
    const f = rarityDef('mythic').base_floor;
    cur.basePct = f + Math.floor(Math.random() * (100 - f + 1));
    applyNow(); return;
  }
  const list = basesFor(cur.slot);
  if (!list.length) return;
  if (!cur.base) cur.base = list[0];
  const budget = rarityDef(cur.rarity).affixes;
  const nPre = Math.min(3, Math.max(budget - 3, Math.round(Math.random() * budget)));
  rollAffixes('prefix', 'pre', nPre);
  rollAffixes('suffix', 'suf', budget - nPre);
  const floor = rarityDef(cur.rarity).base_floor;
  cur.basePct = floor + Math.floor(Math.random() * (100 - floor + 1));
  const ipool = (CAT.bases[cur.base] || { pool: {} }).pool.implicit || [];
  cur.imp = ipool.length
    ? { id: pickWeighted(ipool), pct: Math.floor(Math.random() * 101) }
    : noImp();
  if (cur.corruption) rollAffixes('chaos_stat', 'cor', CAT.corruption[cur.corruption].affixes);
  applyNow();
}
document.getElementById('roll').onclick = randomise;
document.getElementById('rollbase').onclick = () => {
  if (cur.kind === 'unique' || isCodex(cur.slot)) return randomise();
  const list = basesFor(cur.slot);
  if (list.length) { cur.base = pick(list); randomise(); }
};

/* --- what the item is, and what equipping it would do -------------------- */
function codexStats(it) {
  const c = CAT.codex[it.codex];
  if (!c) return [];
  const pct = Math.min(it.codexPct, 100);
  return c.mods.map(m => ({ stat: m.stat, type: m.type,
    value: m.min + (m.max - m.min) * pct / 100 }));
}
function uniqueStats(it) {
  const u = CAT.uniques[it.unique];
  if (!u) return [];
  /* A unique still sits on a normal base gear type, so it keeps that base's
     stats and adds its own fixed list, each rolled by its own percent. */
  /* A unique carries everything a normal item can except prefixes and
     suffixes: its base, its implicit, an infusion, a corruption, and whatever
     is socketed into it. Only the implicit was being counted, so an infused,
     corrupted or gemmed unique lost those stats entirely. */
  /* A unique's own stat line can be a gear_defense bonus, and so can a rune -
     both fold into armour, dodge and magic shield exactly as an affix's does,
     or the item reports the bonus while showing none of its effect. */
  const rest = u.stats.map((m, i) =>
      IE.exact(m, it.uniqueRolls[i] === undefined ? 100 : it.uniqueRolls[i], it.ilvl))
    .concat(runeStats(Object.assign({}, it, { base: u.base })));
  return IE.statsOf({ base: u.base, ilvl: it.ilvl, basePct: it.basePct,
                      quality: 0, affixes: filled(it) }, rest);
}
/* --- runewords -----------------------------------------------------------

   A runeword is an ordered rune sequence plus the slots it works in, so the
   word is found by matching a runeword's `runes` against the START of what is
   socketed: Venom is fey/daw/ano, and a crossbow carrying fey/daw/ano/eno/toq/
   yun is a Venom crossbow whose last three runes simply add their own stats. */
const RUNES = () => B.calc.runes || {};
const RUNEWORDS = () => B.calc.runewords || {};
const GEMS = () => B.calc.gems || {};
/* How many sockets an item has is a property of the ITEM - the player's boots
   have one, holding a gem; their crossbow has six, holding a runeword. Six was
   a guess that made every armour piece look like a weapon. */
function baseSockets(it) {
  return it.socketCount === undefined ? (it.sockets || []).length : it.socketCount;
}
/* A corruption can grant an extra socket - "Ascended" does, for normal items
   and for uniques alike - so the count is the item's own plus whatever the
   corruption added. */
function corruptionSockets(it) {
  const c = CAT.corruption[it.corruption];
  return c ? (c.sockets || 0) : 0;
}
const socketsOn = it => Math.max(0, Math.min(6,
  baseSockets(it) + corruptionSockets(it)));

/* Which stat list a rune grants here - the base's family tag decides, exactly
   as it does for socketed gems. */
function runeFamily(baseId) {
  const tags = (CAT.bases[baseId] || {}).tags || [];
  if (tags.indexOf('weapon_family') >= 0) return 'weapon';
  if (tags.indexOf('jewelry_family') >= 0) return 'jewelry';
  return 'armor';
}
/* A runeword names its slots generically - `pants`, `helmet`, `boots` - while
   a base type is specific: `vest_pants`, `cloth_helmet`. Weapons happen to
   match outright (a crossbow is a `crossbow`), which is why weapons worked and
   every piece of armour silently found nothing. The generic name is the part
   after the last underscore. */
function runewordSlotOf(baseId) {
  const id = String(baseId || '');
  const i = id.lastIndexOf('_');
  return i < 0 ? id : id.slice(i + 1);
}
function runewordsFor(baseId) {
  const rw = RUNEWORDS();
  const want = runewordSlotOf(baseId);
  return Object.keys(rw)
    .filter(k => {
      const slots = rw[k].slots || [];
      return slots.indexOf(baseId) >= 0 || slots.indexOf(want) >= 0;
    })
    .sort();
}
/* Every runeword any base in this slot can take. The type dropdown has to ask
   this rather than `runewordsFor(cur.base)`: a Normal item has no base chosen
   yet, so that returned nothing and the Runeword option was only ever offered
   after picking Unique. */
function runewordsForSlot(slot) {
  const seen = new Set();
  (basesFor(slot) || []).forEach(b => runewordsFor(b).forEach(k => seen.add(k)));
  return [...seen].sort();
}
/* The word the socketed runes actually spell, or '' for none. */
function matchRuneword(it) {
  const socks = (it.sockets || []).filter(Boolean);
  if (!socks.length) return '';
  const rw = RUNEWORDS();
  let best = '';
  runewordsFor(it.base).forEach(k => {
    const want = rw[k].runes || [];
    if (!want.length || want.length > socks.length) return;
    for (let i = 0; i < want.length; i++) if (socks[i] !== want[i]) return;
    if (!best || want.length > (rw[best].runes || []).length) best = k;
  });
  return best;
}
function runeStats(it) {
  const fam = runeFamily(it.base);
  const runes = RUNES(), gems = GEMS();
  const out = [];
  (it.sockets || []).forEach((sid, i) => {
    /* A socket takes a gem or a rune. A gem's numbers are fixed (`v1`), so the
       socket's roll percentage does not apply to it. */
    const gem = gems[sid];
    if (gem) {
      (gem[fam] || []).forEach(m => {
        out.push({ stat: m.stat, type: m.type || 'FLAT', value: m.v1 || 0 });
      });
      return;
    }
    const r = runes[sid];
    if (!r) return;
    /* Each socket rolled separately, so each keeps its own percentage. Taking
       them all at 100% quietly made every imported runeword better than the
       real item - which is why equipping an item you already had raised your
       DPS. */
    const pct = (it.socketPcts || [])[i];
    (r[fam] || []).forEach(m => {
      out.push(IE.exact(m, pct === undefined ? 100 : pct, it.ilvl));
    });
  });
  const word = matchRuneword(it);
  if (word) {
    (RUNEWORDS()[word].stats || []).forEach(m => {
      out.push(IE.exact(m, it.rwPct === undefined ? 100 : it.rwPct, it.ilvl));
    });
  }
  return out;
}

/* Six socket pickers, and the word they currently spell. Order matters: a
   runeword matches against the START of the sequence, so moving a rune changes
   the word. */
function paintSockets(show) {
  const row = document.getElementById('rwrow');
  if (!row) return;
  row.hidden = !show || !socketsOn(cur);
  if (row.hidden) return;
  if (!cur.sockets) cur.sockets = [];

  const runes = RUNES();
  const fam = runeFamily(cur.base);
  const words = runewordsFor(cur.base);
  const socketCount = socketsOn(cur);
  /* The runeword picker only means anything when the item is actually being
     built into a word. Thirteen runewords are only two runes long, so any
     two-socket item technically "fits" one - which put a Runeword row on a
     corrupted helmet whose sockets hold gems. Offer it once a rune is in, or
     when the item already is a runeword. */
  const gemSet = GEMS();
  const hasRune = (cur.sockets || []).some(x => x && !gemSet[x]);
  const fits = (cur.kind === 'runeword' || hasRune)
    ? words.filter(k => (RUNEWORDS()[k].runes || []).length <= socketCount)
    : [];

  /* A runeword picker above the sockets: choose the word and it fills in the
     runes that spell it. Only words this base can take are offered - Venom
     works on a crossbow and not on leg armour. */
  const word = matchRuneword(cur);
  const rwSel = document.getElementById('f-rw');
  rwSel.innerHTML = '<option value="">\u2014 none \u2014</option>' +
    fits.map(k => {
      const seq = (RUNEWORDS()[k].runes || []);
      return '<option value="' + k + '"' + (k === word ? ' selected' : '') + '>' +
        nameOf('runeword', k) + ' \u2014 ' +
        seq.map(titleCase).join(', ') + '</option>';
    }).join('');
  document.getElementById('rw-pickrow').hidden = !fits.length;
  const head = document.querySelector('#rwrow .subhd');
  if (head) {
    head.childNodes[0].nodeValue = socketCount + ' socket' +
      (socketCount === 1 ? ' ' : 's ') +
      (corruptionSockets(cur) ? '(+' + corruptionSockets(cur) +
        ' from corruption) ' : '');
  }
  rwSel.onchange = () => {
    const k = rwSel.value;
    /* Filling a word REPLACES the sequence it needs and leaves any sockets
       past it alone, so the extra runes a player added stay put. */
    const seq = k ? (RUNEWORDS()[k].runes || []) : [];
    const next = (cur.sockets || []).slice();
    const n = socketsOn(cur);
    for (let i = 0; i < n; i++) {
      if (i < seq.length) next[i] = seq[i];
      else if (seq.indexOf(next[i]) >= 0) next[i] = '';   // no duplicates
    }
    cur.sockets = next;
    apply();
    applyNow();
  };

  /* One rune TYPE per item: a rune already socketed is not offered again, so
     it cannot be placed twice. Its own socket still lists it, or the control
     could not show what it currently holds. */
  const used = new Set((cur.sockets || []).filter(Boolean));
  const gems = GEMS();
  const runeIds = Object.keys(runes).sort((a, b) =>
    titleCase(a).localeCompare(titleCase(b)));
  /* Gems are tiered - emerald0 through emerald7 - so they sort by family then
     tier rather than alphabetically, which would scatter the tiers. */
  const gemIds = Object.keys(gems).sort((a, b) => {
    const ga = gems[a].type || a, gb = gems[b].type || b;
    return ga === gb ? a.localeCompare(b, undefined, { numeric: true })
                     : ga.localeCompare(gb);
  });
  const statLine = (def) => (def[fam] || [])
    .map(m => valText(m.v1 === undefined ? m.max : m.v1, m.type || 'FLAT') +
      ' ' + label(m.stat)).join(', ');
  const gemName = id => {
    const t = gems[id].type || id;
    const tier = String(id).replace(/^\D+/, '');
    return titleCase(t) + (tier === '' ? '' : ' ' + (+tier + 1));
  };

  const opts = i => {
    const free = id => !used.has(id) || cur.sockets[i] === id;
    const sel = id => (cur.sockets[i] === id ? ' selected' : '');
    return '<option value="">\u2014 empty \u2014</option>' +
      '<optgroup label="Gems">' +
      gemIds.filter(free).map(g => '<option value="' + g + '"' + sel(g) + '>' +
        gemName(g) + ' \u2014 ' + statLine(gems[g]) + '</option>').join('') +
      '</optgroup><optgroup label="Runes">' +
      runeIds.filter(free).map(r => '<option value="' + r + '"' + sel(r) + '>' +
        titleCase(r) + ' \u2014 ' + statLine(runes[r]) + '</option>').join('') +
      '</optgroup>';
  };

  document.getElementById('rw-sockets').innerHTML =
    Array.from({ length: socketsOn(cur) }, (_, i) =>
      '<select data-sock="' + i + '" aria-label="Socket ' + (i + 1) + '">' +
      opts(i) + '</select>').join('');

  const el = document.getElementById('rw-word');
  /* Only mention a missing word when one was actually possible. */
  el.textContent = word
    ? nameOf('runeword', word) + ' \u2014 ' +
      (RUNEWORDS()[word].stats || []).map(m =>
        valText(m.max, m.type) + ' ' + label(m.stat)).join(', ')
    : !fits.length
      ? 'gem or rune'
      : (cur.sockets || []).filter(Boolean).length
        ? 'these runes spell no word'
        : 'empty';

  document.querySelectorAll('#rw-sockets [data-sock]').forEach(sel => {
    sel.onchange = () => {
      const i = +sel.dataset.sock;
      cur.sockets[i] = sel.value;
      if (!cur.socketPcts) cur.socketPcts = [];
      /* A rune you choose has not rolled yet, so it is shown at its best -
         the question is what it WOULD give. */
      cur.socketPcts[i] = 100;
      apply();
      applyNow();
    };
  });
}

/* --- the item underneath -------------------------------------------------

   Every piece of MnS gear sits on a real Minecraft item, and that item's
   vanilla ATTRIBUTES convert into sheet stats - which is why people craft onto
   Terrasteel rather than iron. Its ENCHANTMENTS convert too: Fire Protection
   is fire resist, Sharpness is physical damage, Piercing is armour
   penetration.

   Both were read off the save but neither could be changed, so a planner could
   not answer "what if I based this on netherite" or "what if I added Power V".
*/
const VANILLA = () => (typeof VAN === 'undefined' ? { items: {} } : VAN);
const ENCHANTS = () => B.calc.enchants || {};

/* Which vanilla slot a gear slot reads as. The attribute dump is keyed by the
   equipment slot the game asks about, not by the planner's slot names. */
const VAN_SLOT = {
  weapon: 'mainhand', offhand: 'offhand', head: 'head',
  chest: 'chest', legs: 'legs', feet: 'feet',
};
function vanillaFor(slot) {
  const want = VAN_SLOT[slot];
  if (!want) return [];
  const items = VANILLA().items || {};
  return Object.keys(items).filter(id => items[id][want]).sort();
}

/* An enchantment only converts if a compat rule names it, and only some apply
   to a given slot in practice - but the game does not gate them, so every rule
   is offered and the value speaks for itself. */
function enchantValue(id, lvl) {
  const r = ENCHANTS()[id];
  if (!r) return null;
  let v = (lvl || 0) * (r.per || 0);
  if (r.itemMax !== null && r.itemMax !== undefined) {
    v = Math.max(-Math.abs(r.itemMax), Math.min(r.itemMax, v));
  }
  return { stat: r.stat, type: r.type || 'FLAT', value: v, cap: r.cap };
}

function paintVanillaBase() {
  const box = document.getElementById('vanblock');
  const list = vanillaFor(cur.slot);
  box.hidden = !list.length || ENCHANTABLE.indexOf(cur.slot) < 0;
  if (box.hidden) return;
  const items = VANILLA().items || {};
  const want = VAN_SLOT[cur.slot];
  document.getElementById('vancount').textContent = list.length + ' for this slot';
  document.getElementById('f-van').innerHTML =
    '<option value="">\u2014 none \u2014</option>' + list.map(id =>
      '<option value="' + id + '"' + (id === cur.vanilla ? ' selected' : '') + '>' +
      pretty(id.split(':')[1] || id) + '  (' + (id.split(':')[0]) + ')</option>').join('');

  const mp = (items[cur.vanilla] || {})[want] || {};
  document.getElementById('vanmods').innerHTML = Object.keys(mp).length
    ? '<div class="afval">' + Object.keys(mp).map(a =>
        valText(mp[a], 'FLAT') + ' ' + titleCase(String(a).replace(/^.*[.:]/, '')))
        .join(', ') +
      '<span class="afspan">converted with everything else you wear \u2014 MnS ' +
      'pools the attributes first, then converts once</span></div>'
    : (cur.vanilla
        ? '<div class="empty">no attributes on this item</div>'
        : '<div class="empty">pick the Minecraft item this gear is built on</div>');

  document.getElementById('f-van').onchange = e => {
    cur.vanilla = e.target.value; apply(); applyNow();
  };
}

/* Vanilla enchantments exist on the five slots that take a real Minecraft
   item: the weapon and the four armour pieces. A jewel, a codex or a curio has
   no Minecraft item underneath to enchant. */
const ENCHANTABLE = ['weapon', 'head', 'chest', 'legs', 'feet'];

function paintEnchants() {
  const box = document.getElementById('enchblock');
  box.hidden = ENCHANTABLE.indexOf(cur.slot) < 0;
  if (box.hidden) return;
  if (!cur.vench) cur.vench = [];
  const rules = ENCHANTS();
  const ids = Object.keys(rules).sort((a, b) =>
    enchName(a).localeCompare(enchName(b)));

  document.getElementById('enchcount').textContent =
    cur.vench.length + ' on this item \u00b7 ' + ids.length + ' convert';

  document.getElementById('enchlist').innerHTML = cur.vench.map((e, i) => {
    const r = rules[e.id];
    const v = enchantValue(e.id, e.lvl);
    return '<div class="enchrow">' +
      '<span class="en">' + enchName(e.id) +
        '<span class="ev"> \u2014 ' + (v ? valText(v.value, v.type) + ' ' +
          label(v.stat) : 'no conversion') +
        (r && r.itemMax && v && Math.abs(v.value) >= r.itemMax
          ? ' (at the ' + r.itemMax + ' per-item cap)' : '') + '</span></span>' +
      '<input type="number" min="0" max="10" value="' + e.lvl +
        '" data-elvl="' + i + '" aria-label="Level">' +
      '<button class="rm" data-erm="' + i + '" aria-label="Remove">\u00d7</button>' +
      '</div>';
  }).join('') || '<div class="empty">none</div>';

  const have = new Set(cur.vench.map(e => e.id));
  document.getElementById('f-ench-add').innerHTML =
    '<option value="">add an enchantment\u2026</option>' +
    ids.filter(id => !have.has(id)).map(id => {
      const r = rules[id];
      return '<option value="' + id + '">' + enchName(id) + '  (' +
        valText(r.per, r.type) + ' ' + label(r.stat) + ' per level)</option>';
    }).join('');

  document.getElementById('f-ench-add').onchange = e => {
    if (!e.target.value) return;
    cur.vench.push({ id: e.target.value, lvl: 1 });
    apply(); applyNow();
  };
  document.querySelectorAll('[data-elvl]').forEach(inp => inp.onchange = () => {
    cur.vench[+inp.dataset.elvl].lvl = Math.max(0, Math.min(10, +inp.value || 0));
    apply(); applyNow();
  });
  document.querySelectorAll('[data-erm]').forEach(b => b.onclick = () => {
    cur.vench.splice(+b.dataset.erm, 1);
    apply(); applyNow();
  });
}

const enchName = id => titleCase(String(id).split(':')[1] || id);

function statsFor(it) {
  if (isJewel(it.slot)) return jewelStats(it);
  if (isCodex(it.slot)) return codexStats(it);
  if (it.kind === 'unique') return uniqueStats(it);
  /* Sockets belong to the item, not to the runeword type - a mythic pair of
     boots with an emerald in it is still socketed. */
  const socketed = runeStats(it);
  return CAT.bases[it.base] ? IE.statsOf(asItem(it), socketed) : socketed;
}

/* The same stats, but split by where they came from, so a crafted item reads
   the way the in-game tooltip does: base, then implicit, then each prefix and
   suffix named, then corruption. The base group has to come out of statsOf
   rather than be recomputed, because gear_defense and gear_damage affixes fold
   INTO the base numbers - the armour line on a helmet already includes them. */
function groupsFor(it) {
  if (isCodex(it.slot)) {
    return [{ label: 'Codex stats', note: it.codexPct + '% diversity', mods: codexStats(it) }];
  }
  const b = CAT.bases[it.base];
  if (!b) return [];
  const groups = [];

  if (it.kind === 'unique') {
    const base = IE.statsOf({ base: it.base, ilvl: it.ilvl,
                              basePct: it.basePct, quality: 0, affixes: [] });
    if (base.length) groups.push({ label: 'Base', note: pretty(it.base), mods: base });
    if (it.imp && it.imp.id) {
      const def = CAT.affixes[it.imp.id];
      if (def) {
        groups.push({ label: 'Implicit', note: affixName(it.imp.id) + ' · ' + it.imp.pct + '%',
                      mods: def.stats.map(m => IE.exact(m, it.imp.pct, it.ilvl)) });
      }
    }
    const u = CAT.uniques[it.unique];
    if (u) {
      groups.push({ label: 'Unique stats', note: uniqueName(it.unique),
        mods: u.stats.map((m, i) =>
          IE.exact(m, it.uniqueRolls[i] === undefined ? 100 : it.uniqueRolls[i], it.ilvl)) });
    }
    return groups;
  }

  const all = IE.statsOf(asItem(it));
  const nBase = b.base_stats.length;
  if (nBase) {
    groups.push({ label: 'Base', note: pretty(it.base) + ' @ ' + it.basePct + '%',
                  mods: all.slice(0, nBase) });
  }
  /* One heading per KIND, not per affix: three prefixes read as one Prefixes
     block with three named lines, which is how the tooltip groups them. */
  const block = (entries, label_, kind) => {
    const live_ = entries.filter(e => e && e.id);
    if (!live_.length) return;
    groups.push({
      label: label_ + (live_.length > 1 ? 's' : ''),
      kind: kind,
      note: live_.length + ' of 3',
      lines: live_.map(e => {
        const def = CAT.affixes[e.id];
        return {
          name: affixName(e.id),
          meta: (e.tier ? 'T' + (CAT.rarities[e.tier].tier + 1) + ' ' +
                 titleCase(e.tier) + ' \u00b7 ' : '') + e.pct + '%',
          mods: def.stats.map(m => IE.exact(m, e.pct, it.ilvl)),
        };
      }),
    });
  };
  block([it.imp], 'Implicit');
  block(it.pre, 'Prefix');
  block(it.suf, 'Suffix');
  block(it.cor, 'Corrupted', 'corrupt');
  block([it.inf], 'Infusion');
  return groups;
}

function paintCard() {
  const el = document.getElementById('itemcard');
  const note = document.getElementById('forgenote');
  let head;
  if (isJewel(cur.slot)) {
    head = '<div class="itemname r-' + cur.rarity + '">' + cur.style.toUpperCase() +
      ' Jewel</div><div class="sub">' + slotName(cur.slot) + ' · ' +
      label(cur.rarity) + ' · ilvl ' + cur.ilvl + '</div>';
  } else if (isCodex(cur.slot)) {
    head = '<div class="itemname r-' + cur.codexRarity + '">' + CAT.codex[cur.codex].name +
      '</div><div class="sub">Codex · ' + label(cur.codexRarity) + ' · ' +
      cur.codexPct + '% diversity</div>';
  } else if (cur.kind === 'unique') {
    const u = CAT.uniques[cur.unique];
    if (!u) { el.innerHTML = '<p class="note">No uniques for this slot.</p>';
              note.textContent = ''; return; }
    head = '<div class="itemname r-legendary">' + uniqueName(cur.unique) + '</div>' +
      '<div class="sub">' + slotName(cur.slot) + ' · Unique · ' + pretty(u.base) +
      ' · ilvl ' + cur.ilvl + (u.set ? ' · ' + titleCase(u.set) + ' set' : '') + '</div>';
  } else {
    if (!CAT.bases[cur.base]) {
      el.innerHTML = '<p class="note">This slot has no configurable bases.</p>';
      note.textContent = ''; return;
    }
    const tier = CAT.corruption[cur.corruption];
    head = '<div class="itemname r-' + cur.rarity + '">' + (tier ? tier.name + ' ' : '') +
      pretty(cur.base) + '</div><div class="sub">' + slotName(cur.slot) + ' · ' +
      label(cur.rarity) + ' · ilvl ' + cur.ilvl +
      (tier && tier.sockets ? ' · +' + tier.sockets + ' socket' : '') + '</div>';
  }
  el.innerHTML = head + groupsFor(cur).map(g =>
    '<div class="grouphd' + (g.kind === 'corrupt' ? ' corrupt' : '') + '">' +
    g.label + (g.note ? '<em>' + g.note + '</em>' : '') + '</div>' +
    (g.mods
      ? g.mods.map(m => '<div class="aff">' + modText(m) + '</div>').join('')
      : g.lines.map(l =>
          '<div class="affline"><span class="an">' + l.name +
          '<em>' + l.meta + '</em></span>' +
          l.mods.map(m => '<div class="aff">' + modText(m) + '</div>').join('') +
          '</div>').join(''))).join('');

  /* The character sheet already follows the draft, so what this panel has to
     answer is what changes against the item ACTUALLY equipped in this slot.
     That means comparing the draft to a sheet built WITHOUT it - comparing it
     to `live` compared the draft against itself, so every row cancelled and
     the handful that survived were only the auras this call had forgotten to
     pass. */
  const cBefore = contribsWith(null), cAfter = contribsWith(cur);
  const before = recompute(perkList(alloc), cBefore, charLevel, liveAuras());
  const after = recompute(perkList(alloc), cAfter, charLevel, liveAuras());
  const watch = ['health', 'magic_shield', 'armor', 'dodge', 'weapon_damage',
                 'mana', 'energy', 'critical_hit', 'critical_damage',
                 'attack_speed', 'cast_speed', 'block_chance', 'strength',
                 'dexterity', 'intelligence', 'fire_resist', 'water_resist',
                 'lightning_resist', 'chaos_resist', 'aura_effect',
                 'magic_find', 'increased_quantity'];
  const rows = watch.map(k => {
    const d = after.total(k) - before.total(k);
    return Math.abs(d) < 0.05 ? ''
      : '<div class="aff">' + label(k) + ' <b class="' + (d > 0 ? 'up' : 'down') + '">' +
        sign(d) + '</b></div>';
  }).filter(Boolean).join('');

  /* Damage first - it is the reason most gear choices get made, and no list of
     stat deltas answers "is this an upgrade" on its own. */
  let dps = '';
  if (typeof dpsUnder === 'function') {
    const a = dpsUnder(after, null, 'slot' + cur.slot + 'a', cAfter);
    const b = dpsUnder(before, null, 'slot' + cur.slot + 'b', cBefore);
    const d = a - b;
    if (b && Math.abs(d) >= 0.5) {
      dps = '<div class="tipdps ' + (d > 0 ? 'up' : 'down') + '">' +
        (d > 0 ? '+' : '') + fmt(d) + ' DPS <span class="k">' +
        (d > 0 ? '+' : '') + (Math.round((d / b) * 10000) / 100) + '%</span></div>';
    }
  }
  note.innerHTML = (dps || rows)
    ? '<b>Against the equipped item</b>' + dps + rows
    : 'Same as what is equipped in this slot.';
}

/* What to call a piece of equipped gear. Its base type is not its name: a
   unique has one, and "vest_helmet" tells you nothing about Mind of the
   Council. */
function gearLabel(g) {
  if (g.unique) return uniqueName(g.unique);
  if (g.runeword) return nameOf('runeword', g.runeword) + ' ' + pretty(g.gtype);
  return pretty(g.gtype || g.item || '');
}

function contribsWith(draft) {
  const out = BASE_CONTRIBS.slice();
  const slots = {};
  Object.keys(SLOT_CONTRIBS).forEach(sl => { slots[sl] = 'orig'; });
  Object.keys(custom).forEach(sl => { slots[sl] = 'custom'; });
  /* An empty codex slot contributes nothing. The picker defaults to the first
     codex so the form has something to show, but merely LOOKING at the slot
     must not equip it. */
  if (draft && (draft.base || draft.unique ||
                (isCodex(draft.slot) && draft.codex && draft.codexEquipped) ||
                isJewel(draft.slot))) {
    slots[draft.slot] = 'draft';
  }
  const locked = twoHandedEquipped();
  Object.keys(slots).forEach(sl => {
    if (sl === 'offhand' && locked) return;      // inert under a two-hander
    if (slots[sl] === 'orig') { out.push.apply(out, SLOT_CONTRIBS[sl]); return; }
    const src = slots[sl] === 'draft' ? draft : custom[sl];
    statsFor(src).forEach(m => out.push([m.stat, m.type, m.value, 'gear:' + sl]));
  });
  /* Enchantments convert per item and then cap in TOTAL, so they cannot be
     folded in per slot like an affix - they are pooled across everything worn
     and converted once, the way StatCompat does it. */
  out.push.apply(out, enchantContribs(draft));
  if (typeof classContribs === 'function') out.push.apply(out, classContribs());
  if (typeof buffContribs === 'function') out.push.apply(out, buffContribs());
  /* Whatever the player typed into Custom modifiers, fed in like any other
     source so the sheet, the DPS headline and the tree hover deltas all see
     it without special handling. */
  if (typeof customContribs === 'function') out.push.apply(out, customContribs());
  return out;
}
/* Every enchantment on everything worn, converted once with the caps applied
   in the right order: clamp each item's contribution to `per_item_max`, sum,
   then clamp the total to `maximum_cap`. Capping only at the end overstates a
   full set; capping only per item never reaches the ceiling. */
function enchantContribs(draft) {
  const rules = ENCHANTS();
  if (!Object.keys(rules).length) return [];
  const slots = {};
  Object.keys(SLOT_CONTRIBS).forEach(sl => { slots[sl] = null; });
  (B.gear || []).forEach(g => {
    const sl = SAVE_SLOT[g.slot] || g.slot;
    slots[sl] = { vench: (g.ench2 || []).map(e => ({ id: e.id, lvl: e.lvl })) };
  });
  Object.keys(custom).forEach(sl => { slots[sl] = custom[sl]; });
  if (draft && draft.slot) slots[draft.slot] = draft;

  const locked = twoHandedEquipped();
  const pool = {};
  Object.keys(slots).forEach(sl => {
    if (sl === 'offhand' && locked) return;
    const it = slots[sl];
    if (!it || !it.vench) return;
    if (ENCHANTABLE.indexOf(sl) < 0) return;
    it.vench.forEach(e => {
      const v = enchantValue(e.id, e.lvl);
      if (!v || !v.value) return;
      const key = v.stat + '|' + v.type + '|' + (v.cap === undefined ? '' : v.cap);
      pool[key] = (pool[key] || 0) + v.value;
    });
  });

  const out = [];
  Object.keys(pool).forEach(key => {
    const [stat, type, capRaw] = key.split('|');
    let v = pool[key];
    const cap = capRaw === '' ? null : +capRaw;
    if (cap) v = Math.max(-Math.abs(cap), Math.min(cap, v));
    if (v) out.push([stat, type, v, 'enchant:' + stat]);
  });
  return out;
}

/* The sheet on the left reflects the item you are LOOKING at, not only the
   ones you have pressed Equip on. Editing a roll and watching the character
   sheet move is the whole point of a planner; a separate "if equipped" panel
   on the right made you read the consequence in two places and made the item
   you imported look unequipped until you pressed a button. */
const currentContribs = () => contribsWith(cur);

document.getElementById('equip').onclick = () => {
  if (isCodex(cur.slot) || isJewel(cur.slot)) { /* always valid */ }
  else if (cur.kind === 'unique') { if (!CAT.uniques[cur.unique]) return; }
  else if (!CAT.bases[cur.base]) return;
  custom[cur.slot] = JSON.parse(JSON.stringify(cur));
  apply();
};
document.getElementById('restore').onclick = () => {
  delete custom[cur.slot];
  cur = Object.assign({}, cur, { kind: 'normal', unique: '', uniqueRolls: [],
    base: null, corruption: '', imp: noImp(), inf: noImp(),
    pre: slot3(), suf: slot3(), cor: slot3() });
  apply();
};

['f-slot', 'f-kind', 'f-uni', 'f-base', 'f-ilvl', 'f-bpct', 'f-cor']
  .forEach(id => {
    document.getElementById(id).onchange = e => {
      const v = e.target.value;
      if (id === 'f-slot') {
        cur.slot = v; cur.kind = 'normal'; cur.unique = ''; cur.uniqueRolls = [];
        cur.base = null; cur.corruption = ''; cur.imp = noImp(); cur.inf = noImp();
        cur.pre = slot3(); cur.suf = slot3(); cur.cor = slot3();
      } else if (id === 'f-kind') {
        cur.kind = v;
        if (v === 'unique') {
          selectUnique(uniquesFor(cur.slot)[0]);
        } else if (v === 'runeword') {
          cur.unique = ''; cur.uniqueRolls = [];
          cur.sockets = cur.sockets || [];
          /* Runes replace affixes rather than sitting alongside them. */
          cur.pre = slot3(); cur.suf = slot3();
        } else {
          cur.unique = ''; cur.uniqueRolls = []; cur.base = null;
          cur.sockets = [];
        }
      } else if (id === 'f-uni') {
        selectUnique(v);
      } else if (id === 'f-base') {
        cur.base = v;
        const impPool = CAT.bases[v].pool.implicit || [];
        if (cur.imp.id && impPool.indexOf(cur.imp.id) < 0) cur.imp = noImp();
        const encPool = CAT.bases[v].pool.enchant || [];
        if (cur.inf.id && encPool.indexOf(cur.inf.id) < 0) cur.inf = noImp();
        ['pre', 'suf', 'cor'].forEach(k => {
          cur[k] = cur[k].map(a => {
            if (!a.id) return a;
            const pool = CAT.bases[v].pool[CAT.affixes[a.id].type] || [];
            return pool.indexOf(a.id) >= 0 ? a : { id: '', tier: cur.rarity, pct: 50 };
          });
        });
      } else if (id === 'f-cor') {
        cur.corruption = v;
        if (!v) cur.cor = slot3();
      } else if (id === 'f-ilvl') {
        cur.ilvl = Math.max(1, Math.min(100, +v || 1));
      } else {
        cur.basePct = Math.max(0, Math.min(100, +v || 0));
      }
      applyNow();
    };
  });

function paintAll() {
  paintRail(); paintSelectors(); paintCodex(); paintJewel();
  paintVanillaBase(); paintEnchants();
  if (isJewel(cur.slot)) {
    document.getElementById('implicitbox').innerHTML = '';
    document.getElementById('uniquebox').innerHTML = '';
    paintCard();
    return;
  }
  if (isCodex(cur.slot)) {
    document.getElementById('implicitbox').innerHTML = '';
    document.getElementById('uniquebox').innerHTML = '';
  } else {
    paintBaseStats(); paintImplicit(); paintUnique(); paintAffixes();
  }
  paintCard();
}

/* Start on what is equipped rather than a blank form. */
seedInitialSlot();
