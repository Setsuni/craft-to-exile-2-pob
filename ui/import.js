/* ---- loading a character straight from pob_export.dat --------------------

   So a player can point the page at their own export instead of installing
   Python and running the toolchain by hand. A port of read_character.py's
   extraction, producing exactly the shapes the bundle already ships - which is
   what makes this tractable: 95% of the character sheet is already rebuilt in
   the page from gear, jewels, ascendancy and enchantments, so feeding those in
   from a different save recomputes the rest for free.

   What it CANNOT recompute is the small shipped remainder: the stat points
   spent, the vanilla max-health attribute, and any buff that happened to be up
   when the file was written. Those are read straight out of the file too.
*/
const IMPORTER = (() => {
  const ARMOR_SLOTS = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head' };
  const jl = NBT.jload;

  /* Curios nest items several levels down and the shape varies by mod, so the
     whole capability is walked for anything item-shaped rather than assuming a
     path. */
  function* walkItems(o) {
    if (Array.isArray(o)) {
      for (const v of o) yield* walkItems(v);
    } else if (o && typeof o === 'object') {
      if (typeof o.id === 'string' && o.tag && typeof o.tag === 'object') yield o;
      for (const k of Object.keys(o)) yield* walkItems(o[k]);
    }
  }

  /* A unique's guid is NOT in mmorpg_gear - UniqueStatsData reads it from
     CustomItemData's UNIQUE_ID, stored as mmorpg_custom_data -> data.map.uq. */
  /* CustomItemData's key/value map: mmorpg_custom_data -> data -> map. Every
     key in it is short - `uq` unique id, `ql` quality, `cr` corrupted - so
     reading it by the Java constant's name finds nothing and fails silently
     as a zero. One reader, so the call sites cannot drift apart. */
  function customData(stack) {
    const cd = jl((stack.tag || {}).mmorpg_custom_data);
    if (!cd || typeof cd !== 'object') return {};
    return (cd.data || {}).map || {};
  }

  function uniqueId(stack) {
    return customData(stack).uq || null;
  }

  function collectGear(root) {
    const caps = root.ForgeCaps || {};
    const held = root.SelectedItemSlot || 0;
    const out = [];

    const take = (stack, where) => {
      const tag = stack.tag || {};
      const g = jl(tag.mmorpg_gear);
      if (!g || typeof g !== 'object') return;
      g._slot = where;
      g._item = stack.id;
      /* CustomItemData.KEYS.QUALITY is the SHORT key `ql`, under data.map
         beside `uq` - where uniqueId() already looks. This read the top level
         for a key named QUALITY, which never exists, so every imported item
         arrived at quality 0. */
      g._quality = (+customData(stack).ql) || 0;   /* stored as a string */
      g._uniq = uniqueId(stack);
      g._ench = (tag.Enchantments || [])
        .filter(e => e && e.id)
        .map(e => ({ id: e.id, lvl: e.lvl || 0 }));
      out.push(g);
    };

    (root.Inventory || []).forEach(stack => {
      const s = stack.Slot;
      if (ARMOR_SLOTS[s]) take(stack, ARMOR_SLOTS[s]);
      else if (s === -106) take(stack, 'offhand');
      else if (s === held) take(stack, 'weapon');
    });
    for (const stack of walkItems(caps['curios:inventory'] || {})) take(stack, 'curio');

    /* Curios calls every slot "curio", so a necklace, an elytra and two rings
       all arrive under one name and anything keyed by slot keeps only the last.
       Number the duplicates. */
    const seen = {};
    out.forEach(g => {
      const sl = g._slot;
      seen[sl] = (seen[sl] || 0) + 1;
      if (seen[sl] > 1) g._slot = sl + seen[sl];
    });
    return out;
  }

  /* A codex is not gear: it sits in a curio slot carrying mmorpg_omen. */
  function collectOmens(root) {
    const caps = root.ForgeCaps || {};
    const out = [];
    for (const stack of walkItems(caps['curios:inventory'] || {})) {
      const o = jl((stack.tag || {}).mmorpg_omen);
      if (o && typeof o === 'object') { o._item = stack.id; out.push(o); }
    }
    return out;
  }

  const skillGems = lst => (lst || []).map(e => {
    const g = jl((e.tag || {}).mmorpg_skill_gem);
    if (!g || typeof g !== 'object') return null;
    g._item = e.id;
    /* The inventory SLOT is the only thing tying a support gem to a skill. */
    g._slot = e.Slot;
    return g;
  }).filter(Boolean);

  function read(root) {
    const caps = root.ForgeCaps || {};
    const pd = {}, ed = {};
    Object.keys(caps['mmorpg:player_data'] || {}).forEach(k => {
      pd[k] = jl(caps['mmorpg:player_data'][k]);
    });
    Object.keys(caps['mmorpg:entity_data'] || {}).forEach(k => {
      ed[k] = jl(caps['mmorpg:entity_data'][k]);
    });

    const stats = {};
    Object.values((ed.mmorpg_unit || {})).forEach(slot => {
      if (slot && typeof slot === 'object' && slot.i) {
        stats[slot.i] = { v: slot.v, m: slot.m };
      }
    });

    const allocated = {};
    Object.entries(((pd.tals || {}).perks) || {}).forEach(([school, payload]) => {
      allocated[school] = ((payload || {}).list || [])
        .filter(p => p && p.x !== undefined && p.y !== undefined)
        .map(p => [p.x, p.y]);
    });

    let vanillaHp = 20;
    const entityAttrs = {};
    (root.Attributes || []).forEach(a => {
      if (a && a.Name) entityAttrs[a.Name] = a.Base || 0;
      if (a && a.Name === 'minecraft:generic.max_health') vanillaHp = a.Base || 20;
    });

    return {
      level: ed.level,
      gear: collectGear(root),
      omens: collectOmens(root),
      jewels: (pd.jewels || []).map(e => {
        const j = jl((e.tag || {}).mmorpg_jewel);
        return j && typeof j === 'object' ? j : null;
      }).filter(Boolean),
      auras: skillGems(pd.auras),
      supportGems: skillGems(pd.gems),
      casting: pd.casting,
      ascendancy: pd.asc,
      allocated: allocated,
      points: (pd.stats || {}).map || {},
      buffs: ((pd.buffs || {}).map) || {},
      statusEffects: Object.fromEntries(Object.entries((ed.statuses || {}).exileMap || {}).map(([id,s]) =>
        [id,{spell:s.spell_id || '',stacks:Math.max(0,Math.trunc(s.stacks || 0))}])),
      vanillaHp: vanillaHp,
      entityAttrs: entityAttrs,
      runtimeAttrs: root.PobRuntimeAttributes || {},
      heartContainers: Number.isFinite(root.PobHeartContainers)
        ? Math.max(0, Math.min(100, Math.trunc(root.PobHeartContainers))) : null,
      arcs: {
        items: (((root.ForgeCaps || {})['blue_skies:player_capability'] || {}).ArcInventory || [])
          .filter(a => a && /^blue_skies:[a-z_]+_arc$/.test(a.id))
          .map(a => ({ id: a.id, level: Math.max(0, Math.min(3, Math.trunc(Number((a.tag || {}).ArcLevel) || 0))) })),
        natureHealth: Number((((root.ForgeCaps || {})['blue_skies:player_capability'] || {}).NatureHealth)) || 0,
      },
      computed: stats,
    };
  }

  /* Coordinates in the save are per-school; the page keys nodes "x,y". */
  const SAVE_TREE = { TALENTS: 'talents', ASCENDANCY: 'ascendancy', ATLAS: 'atlas_passives' };

  async function loadFile(file) {
    const buf = await file.arrayBuffer();
    const root = await NBT.parse(buf);
    if (!(root.ForgeCaps || {})['mmorpg:player_data']) {
      throw new Error('No Mine & Slash data in that file - is it pob_export.dat?');
    }
    return read(root);
  }

  /* Push an imported character into the page. Gear and jewels become the
     equipped set, the trees take its allocation, and everything derived
     recomputes from there. */
  function apply(ch) {
    resetCharacterState();
    characterContext = {
      points: ch.points || {}, buffs: ch.buffs || {}, omens: ch.omens || [],
      statusEffects: ch.statusEffects || {},
      vanillaHp: ch.vanillaHp === undefined ? 20 : ch.vanillaHp,
      entityAttrs: ch.entityAttrs || {}, computed: ch.computed || {},
      runtimeAttrs: ch.runtimeAttrs || {},
      heartContainers: ch.heartContainers,
      arcs: ch.arcs || { items: [], natureHealth: 0 },
    };
    if (Number.isFinite(ch.heartContainers)) cfg.heartContainers = ch.heartContainers;
    /* The save lists what was RUNNING when it was written and says nothing
       about the rest, so "absent" does not mean "off". Seeding every effect
       here disables seedDefaults(), which means a skill buff you always play
       with - Sharpen - comes back switched off.

       Shawn wants the opposite: a buff from an equipped skill assumed up. That
       is NOT done here yet, deliberately. Turning it on doubles this
       character's attack_speed (141.33 -> 283.39) against the 141.33 the game
       recorded, because the game's snapshot is unbuffed - so it changes what
       the accuracy figure means, and it is his call to make. There is also an
       unexplained repaint dependency: with defaults on, the sheet still moved
       between load and the first Config paint even after seeding was made
       deterministic. Both need settling together. See NEXT_STEPS item 2. */
    Object.keys(EFFECTS).forEach(id => { delete effectSeeded[id]; effectStacks[id]=0; });
    Object.entries(ch.statusEffects || {}).forEach(([id,s]) => {
      if (EFFECTS[id]) { effectStacks[id]=s.stacks; effectSeeded[id]=1; }
    });
    Object.values(SAVE_TREE).forEach(name => {
      setTreeAlloc(name, []);
      TREES[name].saved = new Set();
    });
    if (ch.level) {
      charLevel = Math.max(1, Math.min(100, ch.level));
      const n = document.getElementById('clevel'), r = document.getElementById('clevelr');
      if (n) n.value = charLevel;
      if (r) r.value = charLevel;
    }
    Object.entries(ch.allocated || {}).forEach(([school, coords]) => {
      const name = SAVE_TREE[school];
      if (!name || !TREES[name]) return;
      const keys = coords.map(c => c[0] + ',' + c[1])
        .filter(k => TREES[name].byKey.has(k));
      TREES[name].alloc = new Set(keys);
      TREES[name].saved = new Set(keys);
      if (view === name) useTree(name);
    });
    if (ch.ascendancy && typeof classes !== 'undefined') {
      B.ascendancy = JSON.parse(JSON.stringify(ch.ascendancy));
      classes.length = 0;
      (ch.ascendancy.school_order || []).slice(0, 2).forEach(c => classes.push(c));
      if (typeof classAlloc !== 'undefined') {
        Object.keys(classAlloc).forEach(k => delete classAlloc[k]);
        Object.assign(classAlloc, ch.ascendancy.allocated_lvls || {});
      }
    }
    /* Gear, jewels and skills replace the shipped ones wholesale; everything
       derived from them recomputes, which is 95% of the sheet. */
    B.gear = (ch.gear || []).map(toBundleGear);
    B.jewels = (ch.jewels || []).map(j => ({
      lvl: j.lvl, rar: j.rar,
      affixes: (j.affixes || []).map(a => ({ id: a.id, p: a.p || 0 })),
      cor: (j.cor || []).map(a => ({ id: a.id, p: a.p || 0 })),
    }));
    /* Every imported piece becomes a CONFIGURED item rather than an equipped
       one, and the shipped baseline is dropped first.

       Drafting only the slots the import FILLS is not enough: contribsWith()
       falls back to the shipped SLOT_CONTRIBS for anything un-drafted, so a
       character wearing fewer items than the page was built with silently kept
       the originals. Importing a naked save left 157 gear and jewel
       contributions in place. */
    if (typeof custom !== 'undefined' && typeof draftFromGear === 'function') {
      Object.keys(custom).forEach(k => delete custom[k]);
      if (typeof clearEquippedBaseline === 'function') clearEquippedBaseline();
      Object.keys(SAVE_SLOT).forEach(k => delete SAVE_SLOT[k]);
      EXTRA_SLOTS.length = 0;
      const taken = new Set();
      B.gear.forEach(g => {
        const sl = freeSlotFor(g.gtype, taken);
        taken.add(sl);
        SAVE_SLOT[g.slot] = sl;
        if (!EQUIP.some(e => e.id === sl)) EXTRA_SLOTS.push(sl);
        equippedBySlot[sl] = g;
        try { custom[sl] = draftFromGear(sl, g); } catch (e) { /* skip odd slots */ }
      });
      if (typeof draftFromJewel === 'function') {
        (B.jewels || []).forEach((j, i) => {
          try { custom['jewel' + i] = draftFromJewel('jewel' + i, j); }
          catch (e) { /* skip */ }
        });
      }
    }

    characterContext.importedGearAttrs = wornVanillaAttributes();
    const omen = (ch.omens || []).find(o => CAT.codex[o.id]);
    if (omen) custom.codex = Object.assign(blankDraft('codex'), {
      blank:false, codex:omen.id, codexRarity:omen.rar, ilvl:omen.lvl || charLevel,
      codexPct:((omen.aff || [])[0] || {}).p || 0, codexEquipped:true,
      /* The codex's ROLLED affixes, so an imported one opens in the editor
         with what it actually has rather than looking bare. The sheet keeps
         taking them from `codexOmen` - these are for showing and editing. */
      codexAff:((omen.aff || []).map(a => ({ id: a.id, pct: a.p || 0 }))),
      codexOmen:JSON.parse(JSON.stringify(omen))
    });
    const hb = (ch.casting || {}).hotbar || {};
    if (typeof loadout !== 'undefined') {
      const GEM_COLS = 6;
      const links = {};
      (ch.supportGems || []).forEach(g => {
        if (g._slot === undefined || g._slot === null) return;
        const row = Math.floor(g._slot / GEM_COLS), col = g._slot % GEM_COLS;
        if (col === 0) return;                 // the skill's own gem
        (links[row] = links[row] || []).push([col, g.id]);
      });
      loadout.forEach((l, i) => {
        l.spell = hb[String(i)] || '';
        l.supports = (links[i] || []).sort((a, b) => a[0] - b[0]).map(x => x[1]);
      });
      if (typeof usageSeeded !== 'undefined') usageSeeded = false;
    }
    if (typeof augments !== 'undefined') {
      augments.length = 0;
      (ch.auras || []).forEach(a => augments.push({ id: a.id, perc: a.perc === undefined ? 100 : a.perc }));
    }

    /* The editor draft is part of the sheet - currentContribs() is
       contribsWith(cur) - so a draft left over from the previous character
       keeps contributing after the import. Reseed it from what was just
       loaded, or empty it if that slot is now bare. */
    clearEquippedBaseline();
    B.gear = []; B.jewels = [];
    if (typeof seedInitialSlot === 'function') seedInitialSlot();

    if (typeof applyNow === 'function') {
      /* First pass builds the sheet from gear, trees and skills. It has to
         come first: availableEffects() -> knownSpells() reads `learn_*` OFF
         THE SHEET, so asking which effects this character can have before the
         sheet exists returns none, and nothing gets seeded.

         That ordering is what made the numbers move by themselves - the
         seeding then happened on whichever repaint came first, so attack speed
         changed between opening the build and opening the Config tab, with no
         edit in between. Seed here, deterministically, then recompute so the
         defaults are actually in the sheet. */
      applyNow();
      if (typeof availableEffects === 'function') availableEffects(true);
      seedUsage();
      applyNow();
    }
    if (typeof draw === 'function') draw();
  }

  /* The raw NBT gear shape is not the bundle's. draftFromGear wants affix
     LINES - kind, id and roll percent - which is exactly what the NBT holds,
     so no stat resolution is needed here: the page resolves them itself. */
  const SAVE_SLOT_IN = { curio: 'elytra', curio2: 'necklace', curio3: 'ring1',
                         curio4: 'ring2', codex: 'codex' };
  function toBundleGear(g) {
    const lines = [];
    const imp = g.imp || {};
    if (imp.imp) lines.push({ kind: 'implicit', id: imp.imp, p: imp.p || 0 });
    [['pre', 'prefix'], ['suf', 'suffix'], ['cor', 'corrupt']].forEach(([k, lbl]) => {
      ((g.affixes || {})[k] || []).forEach(e => {
        lines.push({ kind: lbl, id: e.id, p: e.p || 0 });
      });
    });
    if ((g.ench || {}).en) {
      const rarity = CAT.rarities[g.ench.rar || 'common'];
      const roll = rarity && rarity.roll_band ? rarity.roll_band[1] : 100;
      lines.push({ kind: 'infusion', id: g.ench.en, p: roll });
    }
    const socks = g.sockets || {};
    return {
      slot: g._slot, item: g._item, gtype: g.gtype, rarity: g.rar,
      ilvl: g.lvl || 1,
      sockets: (socks.so || []).map(x => x.g),
      socketPcts: (socks.so || []).map(x => x.p || 0),
      socketCount: socks.sl || 0,
      runeword: socks.rw || null,
      runewordPct: socks.rp === undefined ? 100 : socks.rp,
      unique: g._uniq || null,
      uniquePercs: (g.uniqueStats || {}).perc || [],
      ench2: g._ench || [],
      basePct: (g.baseStats || {}).p === undefined ? 100 : g.baseStats.p,
      quality: g._quality || 0,
      lines: lines,
    };
  }

  return { read, loadFile, apply, toBundleGear, SAVE_TREE };
})();

if (typeof module !== 'undefined') module.exports = IMPORTER;
