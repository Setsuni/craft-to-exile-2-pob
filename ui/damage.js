/* ---- damage: the stat stack, and who you are hitting ---------------------

   BaseDamageIncreaseEffect.activate, read out of the jar, is the whole rule:

       dmg.getLayer(ADDITIVE_DMG, NUMBER, side).add(statData.getValue());
       if (stat.multiUseType == MULTIPLICATIVE_DAMAGE)
           dmg.addMoreMulti(stat, NUMBER, statData.getMoreStatTypeMulti());

   So each of the 219 damage stats contributes its VALUE into one shared
   additive layer, and - if it is MULTIPLICATIVE_DAMAGE - its MORE product into
   a separate list that multiplies in afterwards. Which stats count for a given
   hit is decided by their `ifs`, and those are declarative conditions that can
   be answered from the spell, the element, and a handful of situational
   toggles the player sets.

   NOT YET VALIDATED against the game. Base damage is exact; this stack is read
   correctly from the bytecode but has never been checked against a real hit.
   MnSDummy prints exactly this breakdown, so one dummy hit per skill settles
   it - until then the UI says so rather than implying precision. */
const DMG = __DMGMAP__;

/* Situational state. Path of Building calls this Config; the conditions that
   cannot be answered from the build alone live here. */
const cfg = {
  enemy: 'boss',
  targetLowHp: false, targetFullHp: false, targetCursed: false,
  targetUndead: false, selfLowHp: false, inCombat: true, isDay: true,
  dualWield: false, fullyCharged: false,
};

/* Mob rarity drives everything about the target: MnS multiplies a mob's stats
   by `stat_multi` for its rarity. MnSDummy's presets are these same rarities,
   plus a Max Resist dummy it builds at 90% elemental / 15% physical and enough
   armour for 0.75 mitigation. */
/* A target is the `mob` base profile scaled to its level, times its rarity's
   stat_multi. Both come from the game's own registries rather than being
   guessed - the old table was all zeros, which quietly assumed every enemy in
   the game had no resistance whatsoever and made every DPS figure optimistic.

   Level-scaled entries use the same scaling curve the player's sheet uses, so
   `mobStat` goes through the engine rather than reimplementing it. */
function mobStat(stat, lvl, rarity) {
  const prof = (B.calc.mobProfile || []).filter(r => r[0] === stat);
  if (!prof.length) return 0;
  const mult = ((B.calc.mobRarity || {})[rarity] || {}).stat || 1;
  let v = 0;
  prof.forEach(r => {
    const scaled = r[3] ? r[2] * scaleMulti(stat, lvl) : r[2];
    v += scaled;
  });
  return v * mult;
}
/* The player engine exposes its level curve; reuse it so a mob at level 100
   scales the same way a player's gear does. */
function scaleMulti(stat, lvl) {
  const kind = (B.calc.scalingOf || {})[stat] || 'NONE';
  const c = (B.calc.scalings || {})[kind];
  if (!c) return 1;
  /* The curve is LINEAR - `base + per_level * (lvl - 1)` - exactly as the
     player engine computes it. Treating it as compound growth put a level 100
     mob's armour in the billions. */
  const L = c.cap ? Math.max(1, Math.min(lvl, 100)) : lvl;
  return c.base + c.per_level * (L - 1);
}

/* The picker's list. Ids that name a rarity are priced from the registry;
   `naked` and `maxres` are MnSDummy's own presets rather than mob rarities. */
const ENEMY_ORDER = ['naked', 'common', 'rare', 'boss', 'uber', 'pinnacle', 'maxres'];
const ENEMIES = ENEMY_ORDER.map(id => ({
  id: id,
  name: id === 'naked' ? 'Naked dummy'
    : id === 'maxres' ? 'Max resist dummy'
    : ((B.calc.mobRarity || {})[id] || {}).name || titleCase(id),
}));
function enemyDef() {
  const id = cfg.enemy || 'common';
  if (id === 'naked') {
    return { id: id, name: 'Naked dummy', res: 0, phys: 0, armourMit: 0 };
  }
  if (id === 'maxres') {
    /* MnSDummy's own Max Res preset, not a rarity. */
    return { id: id, name: 'Max resist dummy', res: 90, phys: 15, armourMit: 0.75 };
  }
  const r = (B.calc.mobRarity || {})[id] || {};
  const lvl = cfg.enemyLevel || charLevel;
  return {
    id: id,
    name: (r.name || titleCase(id)) + ' lvl ' + lvl,
    res: mobStat('elemental_resist', lvl, id),
    phys: mobStat('physical_resist', lvl, id),
    chaos: mobStat('chaos_resist', lvl, id),
    armour: mobStat('armor', lvl, id),
    dodge: mobStat('dodge', lvl, id),
    spellDodge: mobStat('spell_dodge', lvl, id),
    /* The curve is known now - see armourMitigation() - so armour is applied
       from `armour` above rather than suppressed. */
    statMulti: r.stat || 1,
  };
}

/* --- conditional effects: buffs, charges, stances -------------------------

   A planner cannot read these off a save. Whether you are holding three power
   charges, or maintaining Sharpen, is a question about how you play rather than
   what you wear - so they ship unapplied and the Config tab switches them on.

   Only what THIS build can produce is offered. A charge appears if something
   on the character actually generates it (the Power Charge on Crit support, a
   perk, an affix); a buff appears if the character knows the skill. Listing all
   176 effects would bury the handful that matter. */
const EFFECTS = B.effects || (B.calc && B.calc.effects) || {};
const effectStacks = {};          // effect id -> stacks currently assumed

/* Anything on this build that can generate an effect. Generators announce
   themselves in the stat NAME - `power_charge_on_crit`, `shred_on_attack_hit`,
   `proc_venom` - so matching the effect id inside a stat id finds them.

   Support gems have to be searched separately: their stats apply to the linked
   skill's sheet, not the character's, so `live.total('power_charge_on_crit')`
   is zero even with Power Charge on Crit socketed. */
function effectSources(id) {
  const out = [];
  const short = id.replace(/_charge$/, '').replace(/_effect$/, '');
  const hits = sid => sid !== id &&
    (sid.indexOf(id) >= 0 || sid.indexOf(short) >= 0);

  const raw = [];
  Object.keys(B.calc.defs || {}).forEach(sid => {
    /* An immunity is not a generator: `weak_immunity` names the effect only to
       say you cannot get it, and offering Elemental Weakness as something to
       switch on is exactly backwards. */
    if (/_immunity$|^immune_/.test(sid)) return;
    if (hits(sid) && Math.abs(live.total(sid) || 0) > 0.005) {
      out.push(label(sid));
      raw.push(sid);
    }
  });
  out.raw = raw;
  const seen = new Set(out);
  (typeof loadout === 'undefined' ? [] : loadout).forEach(l => {
    (l.supports || []).forEach(g => {
      const d = (SK.supports || {})[g];
      if (!d) return;
      if ((d.stats || []).some(m => hits(m.stat))) {
        const n = gemName(g);
        if (!seen.has(n)) { seen.add(n); out.push(n); }
      }
    });
  });
  return out;
}

/* Where a conditional belongs. A buff you cast is a question for the Skills
   tab - "am I still maintaining it?" - while a charge or a talent's stance
   comes from gear and passives and belongs on Config.

   The id is not always the spell's: Hunter's Focus applies an effect called
   `focus`. So an effect also counts as a skill buff when the thing that
   generates it is a `learn_<spell>` for a spell you actually know - which is
   how the buff reaches you in the first place. */
function effectKind(id, sources) {
  const known = typeof knownSpells === 'function' ? knownSpells() : new Set();
  if (known.has(id)) return 'skill';
  const fromSkill = (sources || []).some(sid => /^learn_/.test(sid) &&
    known.has(sid.slice(6)));
  return fromSkill ? 'skill' : 'build';
}

/* A buff you have equipped is assumed to be up - that is how it is played -
   so skill buffs default to active and you switch them OFF. Charges start at
   zero, because how many you are holding is a real choice. Seeded once per
   effect so unchecking one does not get undone on the next repaint. */
const effectSeeded = {};
function seedDefaults(list) {
  list.forEach(x => {
    if (effectSeeded[x.id]) return;
    effectSeeded[x.id] = 1;
    if (x.kind === 'skill') effectStacks[x.id] = EFFECTS[x.id].stacks;
  });
}

/* Which effects are OFFERED must not depend on which are switched ON.

   Availability is read off the sheet, and the sheet includes whatever buffs
   are active - so toggling one could add or remove rows and reshuffle the
   list underneath the cursor. The visible result was a toggle that appeared to
   invert: you clicked one row, the list re-ordered, and you read another row's
   number. So a buff toggle repaints the rows but never recomputes which rows
   exist; only a real build change (gear, tree, class, links) does that. */
let availCache = null;
let effectsOnly = false;
function invalidateEffects() { if (!consumeEffectsOnly()) availCache = null; }

function availableEffects() {
  if (availCache) return availCache;
  const known = typeof knownSpells === 'function' ? knownSpells() : new Set();
  const out = [];
  Object.keys(EFFECTS).forEach(id => {
    const why = [];
    if (known.has(id)) why.push('you know ' + spellName(id));
    const gen = effectSources(id);
    if (gen.length) why.push('from ' + gen.join(', '));
    if (why.length) {
      out.push({ id: id, why: why.join(' \u00b7 '),
                 kind: effectKind(id, gen.raw) });
    }
  });
  out.sort((a, b) => (EFFECTS[b.id].stacks - EFFECTS[a.id].stacks) ||
    EFFECTS[a.id].name.localeCompare(EFFECTS[b.id].name));
  seedDefaults(out);
  availCache = out;
  return out;
}

/* What the switched-on effects contribute. Stacks multiply a stat only when
   the effect says `stacks_affect_stats`; otherwise three stacks is still one
   application. Rolls are taken at maximum, which is right for a maxed buff
   skill and optimistic for a low one - flagged in the UI rather than hidden. */
/* A buff toggle must not re-derive WHICH effects exist. apply() only queues a
   frame, so a flag cleared in a `finally` was already false by the time that
   frame ran - it protected nothing. The flag is instead left standing for the
   next repaint to consume. */
function withEffectsOnly(fn) {
  effectsOnly = true;
  fn();
}
function consumeEffectsOnly() {
  const was = effectsOnly;
  effectsOnly = false;
  return was;
}

function buffContribs() {
  const out = [];
  Object.keys(effectStacks).forEach(id => {
    const n = effectStacks[id] || 0;
    const d = EFFECTS[id];
    if (!n || !d) return;
    /* A `negative` effect is a DEBUFF YOU APPLY, so its stats belong to the
       thing you are hitting. Shred is `armor -8% per stack`: pooling it into
       your own sheet reduced your armour and did nothing to your damage, which
       is the opposite of what it does in game. Target effects are read by
       enemyDef() instead. */
    if (d.negative) return;
    const mult = d.byStack ? n : 1;
    d.stats.forEach(m => {
      out.push([m[0], m[1], m[3] * mult, 'buff:' + id]);
    });
  });
  return out;
}

/* What the debuffs you are maintaining do to the target. Shred is applied by
   attacking, so on any real target it is simply up - there is no version of
   this build that fights something unshredded. */
function targetDebuff(stat) {
  let flat = 0, perc = 0;
  Object.keys(effectStacks).forEach(id => {
    const n = effectStacks[id] || 0;
    const d = EFFECTS[id];
    if (!n || !d || !d.negative) return;
    const mult = d.byStack ? n : 1;
    d.stats.forEach(m => {
      if (m[0] !== stat) return;
      if (m[1] === 'PERCENT') perc += m[3] * mult;
      else flat += m[3] * mult;
    });
  });
  return { flat: flat, perc: perc };
}

/* --- condition evaluation ------------------------------------------------
   Each kind is answered from the spell, the hit's element, or cfg. Anything
   this does not understand is treated as NOT met, so an unknown condition can
   only ever understate damage - never invent it. */
const ELEMENTS = ['physical', 'fire', 'water', 'lightning', 'chaos'];

/* `water` is the internal id and the game has never shown it - Elements.Cold
   carries the guid "water" but displays as Cold, and the pack's lang file
   agrees (water_resist reads "Cold Resistance"). Anywhere a bare element id
   reaches the screen it has to go through this. */
const ELEMENT_NAME = {
  physical: 'Physical', fire: 'Fire', water: 'Cold',
  lightning: 'Lightning', chaos: 'Chaos',
};
const elName = e => ELEMENT_NAME[e] || titleCase(e);

/* A damage stat's `ele` is the Elements ENUM NAME, not the id the stats use.
   Cold is what the pack calls water, Nature is lightning, Shadow is chaos, and
   Elemental and ALL are umbrellas. Comparing the raw string against the hit's
   element silently excluded everything except Physical and Fire - which is why
   Brutality looked like a flat x1.27 instead of zeroing an elemental hit. */
const ELE_ENUM = {
  Physical: ['physical'],
  Fire: ['fire'],
  Cold: ['water'],
  Nature: ['lightning'],
  Shadow: ['chaos'],
  Elemental: ['fire', 'water', 'lightning'],
  ALL: ELEMENTS,
};
const eleMatches = (statEle, element) => {
  const set = ELE_ENUM[statEle];
  return set ? set.indexOf(element) >= 0 : false;
};

/* Any condition can appear in a negated form - the id gains `_is_false` and
   the serialiser stays the same. `spell_has_tag_not_affected_by_cast_speed_is_false`
   gates all 39 cast-speed stats, so getting this wrong turns every speed stat
   off. Handled once, here, rather than per case. */
function condMet(cid, ctx) {
  const neg = cid.indexOf('_is_false') >= 0;
  const v = condMetRaw(cid, ctx);
  return neg ? !v : v;
}
function condMetRaw(cid, ctx) {
  const c = DMG.conditions[cid];
  if (!c) return false;
  const spell = ctx.spell || {};
  const tags = spell.tags || [];
  switch (c.ser) {
    case 'spell_has_tag':      return tags.indexOf(c.tag) >= 0;
    case 'is_spell':           return true;   // everything slotted here is a spell
    case 'ele_match_stat':  return eleMatches(ctx.statEle, ctx.element);
    case 'is_elemental_damage':
      return ['fire', 'water', 'lightning'].indexOf(ctx.element) >= 0;
    case 'string_matches':
      /* `style_is_int_is_false` is a string_matches on the spell's style,
         negated. Leaving it unhandled returned false and the negation made it
         true - the right answer for a dex skill purely by accident, and the
         wrong one for an int skill. */
      if (c.string_key === 'style') return c.string_id === spell.style;
      if (c.string_key === 'attack_type') {
        return c.string_id === (ctx.isBonus ? 'bonus_dmg' : tags.indexOf('dot') >= 0 ? 'dot' : 'hit');
      }
      if (c.string_key === 'summon_type') return c.string_id === spell.summonType;
      return false;
    case 'wep_type_match':     return ctx.weaponType && c.wep_type === ctx.weaponType;
    case 'is_day':             return cfg.isDay;
    case 'is_in_combat':       return cfg.inCombat;
    case 'is_dual_wielding':   return cfg.dualWield;
    case 'is_target_cursed':   return cfg.targetCursed;
    case 'is_undead':          return cfg.targetUndead;
    case 'is_target_low':      return cfg.targetLowHp;
    case 'is_hp_under':        return cfg.selfLowHp;
    case 'is_hp_above':        return !cfg.selfLowHp;
    case 'is_bool_true':
      /* The condition json carries no bool_key for these, so the id is the
         only thing that names them. `is_crit_true` decides whether a stat
         belongs to the crit branch or the non-crit branch, and answering it
         wrongly is expensive: Increased Critical Damage / Less Non-Critical
         Damage carries non_crit_damage -75% MORE, which used to be applied to
         EVERY hit including crits. */
      if (cid.indexOf('is_crit_true') === 0) return !!ctx.isCrit;
      if (cid.indexOf('is_is_bonus_element_damage_true') === 0) return !!ctx.isBonus;
      return c.bool_key === 'is_attack_fully_charged' ? cfg.fullyCharged : false;
    default:                   return false;
  }
}
const allMet = (ifs, ctx) => (ifs || []).every(c => condMet(c, ctx));

/* What is actually in the weapon hand, for wep_type_match. Reads the bench's
   configured weapon first, then whatever the save had equipped. */
function weaponType() {
  const w = (typeof custom !== 'undefined') && custom.weapon;
  let baseId = null;
  if (w) baseId = w.kind === 'unique' ? (CAT.uniques[w.unique] || {}).base : w.base;
  else if (typeof equippedBySlot !== 'undefined' && equippedBySlot.weapon) {
    baseId = equippedBySlot.weapon.gtype;
  }
  const b = baseId && CAT.bases[baseId];
  return (b && b.weapon_type) || null;
}

/* --- the stack ----------------------------------------------------------- */
function damageStack(spell, element, sheet, isCrit, isBonus) {
  const s = sheet || live;
  let additive = 0, more = 1;
  const adds = [], mores = [], skipped = [];
  const ctx = { spell: spell, element: element, weaponType: weaponType(),
                isCrit: !!isCrit, isBonus: !!isBonus };

  const take = (sid, d) => {
    const v = s.total(sid);
    if (Math.abs(v) > 0.005) { additive += v; adds.push([sid, v]); }
    if (d.more) {
      const m = s.moreOf(sid);
      if (Math.abs(m - 1) > 0.0005) { more *= m; mores.push([sid, m]); }
    }
  };
  Object.keys(DMG.stats).forEach(sid => {
    const d = DMG.stats[sid];
    ctx.statEle = d.ele;
    if (!allMet(d.ifs, ctx)) return;
    take(sid, d);
  });
  /* The four Java-declared ones. Their conditions live in canActivate() rather
     than an `ifs` list, so they are checked here by name. */
  const isAilment = (spell.tags || []).indexOf('dot') >= 0;
  Object.keys(DMG.code || {}).forEach(sid => {
    const d = DMG.code[sid];
    const ok = d.when === 'is_spell' ? true
      : d.when === 'is_hit' ? !isAilment
      : d.when === 'is_ailment' ? isAilment
      : false;
    if (ok) take(sid, d);
  });
  return { additive: additive, more: more, adds: adds, mores: mores, skipped: skipped };
}

/* Target mitigation. A resist of R cuts damage to (1 - R/100); armour is
   expressed by MnSDummy as a flat mitigation fraction, which is the honest
   thing to model until the armour curve itself is confirmed. */
/* Armour, read out of ArmorEffect + IUsableStat.getUsableValue:

       armour  = target armour - event penetration
       usable  = armour / (armour + needed)           needed = 100, level-scaled
       mitigation = clamp(usable, 0, 0.9)

   Penetration is subtracted from the TARGET'S ARMOUR before the curve - it is
   not a resistance term - which is why `armor_penetration` did nothing while
   only `<element>_penetration` was read. Shred reduces that armour too.

   This used to be hardcoded to zero, so every physical hit skipped the game's
   own Armor Mitigation term entirely and read about 12% high. */
function armourMitigation(sheet) {
  const e = enemyDef();
  /* The two MnSDummy presets state a mitigation outright rather than an armour
     value, so they bypass the curve. */
  if (e.armourMit !== undefined) return e.armourMit;
  let armour = e.armour || 0;
  const deb = targetDebuff('armor');
  armour = (armour + deb.flat) * (1 + deb.perc / 100);
  armour -= (sheet || live).total('armor_penetration') || 0;
  if (!(armour > 0)) return 0;
  const needed = 100 * scaleMulti('armor', cfg.enemyLevel || charLevel);
  return Math.max(0, Math.min(0.9, armour / (armour + needed)));
}

function mitigation(element, sheet) {
  const e = enemyDef();
  const res = element === 'physical' ? e.phys
    : element === 'chaos' ? (e.chaos === undefined ? e.res : e.chaos)
    : e.res;
  const pen = (sheet || live).total(element + '_penetration') || 0;
  const eff = Math.max(-100, res - pen);
  /* Armour applies to physical only; the elements are mitigated by resistance,
     which the game reports as a separate "Elemental Mitigation" term. */
  const armour = element === 'physical' ? armourMitigation(sheet) : 0;
  return (1 - eff / 100) * (1 - armour);
}

/* The flat_damage layer: stats that ADD to the hit's base before any of the
   percentage stack runs. mmorpg_stat_effect names the source of each number -
   archmage is STAT_PERCENT of mana, imbuement of energy - so a character with
   6 archmage and 7137 mana gets 428 flat damage on top of the skill's own base.
   None of this reached the engine before, because the damage map was built by
   filtering on a single hardcoded effect name. */
/* How much of a flat-damage stat this skill receives. The game calls it
   SPELL_DAMAGE_EFFECTIVENESS_MULTI and reads it off the spell's value
   calculation as a LeveledValue over rank, so the same archmage stat is worth
   more on a higher-ranked skill. Confirmed against two skills at different
   ranks: the observed flat ratio was 1.01132 and this predicts 1.01176. */
function dmgEffectiveness(spell, rank) {
  const m = spell && spell.dmgEffectiveness;
  if (!m) return 1;
  const max = (spell.max_lvl || 20) + (SK.maxBonusLevels || 8);
  return leveled(m, rank, max);
}

function flatLayerAdd(spell, element, sh, rank) {
  const map = DMG.otherLayers || {};
  const ctx = { spell: spell, element: element, weaponType: weaponType() };
  const eff = dmgEffectiveness(spell, rank || 1);
  let add = 0;
  Object.keys(map).forEach(sid => {
    const d = map[sid];
    if (d.target || d.layer !== 'flat_damage') return;
    ctx.statEle = d.ele;
    if (!allMet(d.ifs, ctx)) return;
    const v = sh.total(sid) || 0;
    if (Math.abs(v) < 0.005) return;
    /* STAT_PERCENT reads v% OF another stat; STAT_DATA is the value itself. */
    const raw = d.provider === 'STAT_PERCENT' && d.of
      ? (sh.total(d.of) || 0) * v / 100
      : v;
    add += d.effectiveness ? raw * eff : raw;
  });
  return add;
}

/* Evaluate a prepared elemental portion. Flat damage belongs to the original
   hit, before routing; adding it here would duplicate it in every bonus hit. */
function hitDamage(skill, element, sheet, isBonus) {
  const base = skill.base_damage;
  if (base === null || base === undefined) return null;
  const sh = sheet || live;
  /* Crits and non-crits do not share a multiplier stack - stats gated on
     is_crit_true belong to one branch or the other - so the two are computed
     separately and averaged by crit chance rather than multiplying one stack
     by an average crit factor. */
  const spell = skill.spell || {};
  const stN = damageStack(spell, element, sh, false, isBonus);
  const stC = damageStack(spell, element, sh, true, isBonus);
  const crit = 1 + (sh.total('critical_damage') || 0) / 100;
  const critChance = Math.max(0, Math.min(100, sh.total('critical_hit') || 0)) / 100;
  const hitN = base * (1 + stN.additive / 100) * stN.more;
  const hitC = base * (1 + stC.additive / 100) * stC.more * crit;
  const average = (1 - critChance) * hitN + critChance * hitC;
  return {
    base: base, additive: stN.additive, more: stN.more,
    critAdditive: stC.additive, critMore: stC.more, critMulti: crit,
    critChance: critChance,
    hit: hitN, crit: hitC,
    average: average,
    mitigated: average * mitigation(element, sh),
    adds: stN.adds, mores: stN.mores,
  };
}

/* The element a skill deals. Its tags name it; physical is the fallback. */
function elementOf(spell) {
  const tags = (spell && spell.tags) || [];
  for (const e of ['fire', 'water', 'lightning', 'chaos']) {
    if (tags.indexOf(e) >= 0) return e;
  }
  if (tags.indexOf('cold') >= 0) return 'water';
  return 'physical';
}

/* ---- base damage at an arbitrary rank ------------------------------------
   A port of ValueCalculation.getCalculatedValue, which damage.py already
   reproduces exactly (Charged Bomb 220, Bolt 107). Shipping one precomputed
   number per equipped skill was fine for a viewer; a planner has to answer
   "what if this were rank 20" and "what if this item gave +2 levels". */
function leveled(v, lvl, maxLvl) {
  const lo = v.min === undefined ? 0 : v.min;
  const hi = v.max === undefined ? lo : v.max;
  if (lo === hi || !maxLvl) return lo;
  return lo + ((hi - lo) / maxLvl) * lvl;
}
function skillMulti(scaling, level) {
  const c = (SK.scalings || {})[scaling];
  if (!c) return 1;
  const l = c.cap ? Math.max(1, Math.min(level, 100)) : level;
  return c.base + c.per_level * (l - 1);
}

/* MaxSpellLevel is generated per SpellTag: plus_lvl_fire_spells raises any
   spell tagged fire, plus_lvl_all_spells raises everything. Capped. */
function bonusLevels(spellId, sheet) {
  const sp = (SK.spells || {})[spellId];
  if (!sp) return 0;
  const s = sheet || live;
  let n = s.total(SK.plusByTag.all || 'plus_lvl_all_spells') || 0;
  (sp.tags || []).forEach(t => {
    const stat = SK.plusByTag[t];
    if (stat) n += s.total(stat) || 0;
  });
  return Math.max(0, Math.min(Math.floor(n), SK.maxBonusLevels || 8));
}

function baseDamage(spellId, rank, sheet) {
  const calc = (SK.calc || {})[spellId];
  const sp = (SK.spells || {})[spellId];
  if (!calc || !sp) return null;
  const s = sheet || live;
  /* The LeveledValue divisor is max_lvl PLUS the bonus cap, not max_lvl - a
     spell whose min equals max hides this, which is why Bolt validated either
     way and Charged Bomb did not. */
  const maxLvl = (sp.max_lvl || 0) + (SK.maxBonusLevels || 8);
  /* Bonus ranks from gear go PAST max_lvl - the sample save carries
     magic_missile at rank 23 against a max_lvl of 20 - so the ceiling is
     max_lvl plus the bonus cap, the same figure the divisor already uses.
     Capping at max_lvl threw away every +level the character was wearing. */
  const lvl = Math.min(rank + bonusLevels(spellId, s), maxLvl);

  const scaled = skillMulti(calc.scaling, charLevel) * leveled(calc.base, lvl, maxLvl);
  let out = Math.trunc(scaled * (SK.spellDmgMulti || 1));

  let wep = 0, others = 0;
  (calc.scalings || []).forEach(sc => {
    const m = leveled(sc.multi || {}, lvl, maxLvl);
    const v = Math.trunc(m * (s.total(sc.stat) || 0));
    if (sc.stat === 'weapon_damage') wep += v; else others += v;
  });
  /* cap_to_wep_dmg bounds the NON-weapon scalings, and only when under 50. */
  if (calc.cap !== null && calc.cap !== undefined && calc.cap < 50) {
    others = Math.min(others, wep * calc.cap);
  }
  return out + Math.trunc(others + wep);
}

/* ---- support gems --------------------------------------------------------
   Support stats are scoped to the spell they are linked to, not the character
   - measured early on: applying them globally dropped sheet accuracy from
   64.2% to 61.9%. So a supported skill gets its own sheet: the normal
   contributions plus that link group's gems, recomputed. */
const supportCache = new Map();
/* While a hypothetical is being measured - "what would this tree node do to my
   damage" - `live` points at the alternative sheet and these say which perk
   allocation produced it. The tag keeps those cache entries apart from the
   real ones so measuring a node does not throw away the real sheets. */
let hypoPerks = null, hypoTag = '', hypoContribs = null;
function skillSheet(supports) {
  if (!supports || !supports.length) return live;
  const key = hypoTag + supports.join('|') + '@' + charLevel;
  if (supportCache.has(key)) return supportCache.get(key);
  const extra = (hypoContribs || currentContribs()).slice();
  supports.forEach(gid => {
    const g = (SK.supports || {})[gid];
    if (!g) return;
    g.stats.forEach(m => {
      /* A gem's roll is stored per item; an unrolled one is taken at full. */
      const v = m.min + (m.max - m.min);
      extra.push([m.stat, m.type, v, 'support:' + gid]);
    });
  });
  const sheet = recompute(hypoPerks || perkList(), extra, charLevel, auraContribs());
  supportCache.set(key, sheet);
  return sheet;
}

/* The headline DPS a given sheet would produce. Every damage helper reads the
   globals, so they are swapped and put back rather than threaded through a
   dozen signatures; `tag` keeps the hypothetical's cached sheets separate. */
function dpsUnder(sheet, perks, tag, contribs) {
  const wasLive = live, wasPerks = hypoPerks, wasTag = hypoTag;
  const wasContribs = hypoContribs;
  live = sheet; hypoPerks = perks; hypoTag = tag + '#'; hypoContribs = contribs || null;
  const wasAvail = typeof availCache === 'undefined' ? undefined : availCache;
  if (typeof availCache !== 'undefined') availCache = null;
  try {
    const hits = (typeof loadout === 'undefined' ? [] : loadout)
      .map((l, i) => ((l.spell && (l.use || 'cast') !== 'off')
        ? skillDps(l.spell, rankOf(i), l.supports) : null))
      .filter(Boolean)
      .sort((a, b) => b.dps - a.dps);
    const best = hits.find(h => h.id === dpsFocus) || hits[0];
    return best ? best.dpsMitigated : 0;
  } finally {
    live = wasLive; hypoPerks = wasPerks; hypoTag = wasTag;
    hypoContribs = wasContribs;
    if (typeof availCache !== 'undefined') availCache = wasAvail;
  }
}

/* ---- rate, and therefore DPS --------------------------------------------
   Read out of SpellStatsCalculationEvent:

       multi  = 1 + max(-99, castSpeedPercent) / 100
       ticks  = max(GLOBAL_COOLDOWN_TICKS, cast_speed_ticks / multi)

   castSpeedPercent accumulates from `cast_speed` (spells tagged magic) and
   `attack_cast_speed` (anything whose style is not int) - both declare
   add_cast_speed_perc on on_spell_stat_calc. `attack_speed` is NOT in this:
   it is a vanilla attribute (minecraft:generic.attack_speed) governing the
   weapon swing, not MnS cast ticks.

   times_to_cast matters too - Double Strike lands two hits per cast, which is
   the difference between 1 and 2 hits a second. */
/* 39 stats declare add_cast_speed_perc, each gated on a spell tag - melee,
   area, fire, weapon_skill and so on - plus `attack_cast_speed` on style and
   `skill_speed` on everything. Faster Attacks grants weapon_skill_cast_time,
   which a hand-written list of two stats missed entirely. */
function castSpeedParts(spell, sheet) {
  const s = sheet || live;
  const ctx = { spell: spell, element: elementOf(spell), weaponType: weaponType() };
  const parts = [];
  Object.keys(DMG.speed || {}).forEach(sid => {
    if (!allMet(DMG.speed[sid].ifs, ctx)) return;
    const v = s.total(sid) || 0;
    if (Math.abs(v) > 0.005) parts.push([sid, v]);
  });
  return parts;
}
function castSpeedPct(spell, sheet) {
  let pct = castSpeedParts(spell, sheet).reduce((n, p) => n + p[1], 0);
  if (spell.channel) {
    pct = pct * (SK.channelSpeedTransfer || 1) +
      ((sheet || live).total('channel_speed') || 0);
  }
  return pct;
}

/* Cooldown reduction, the same shape as cast speed: 47 stats declare
   `decrease_cd_ticks_num`, each gated on a spell tag - projectile_cdr,
   melee_cdr, fire_cdr - plus a plain `cdr` that applies to everything.

   DecreaseNumberByPercentEffect reads

       number = number - originalNumber * statValue / 100

   so it always scales the ORIGINAL cooldown. Several reductions therefore
   stack ADDITIVELY (30% and 20% take half off, not 0.7 x 0.8 = 44%).

   The old code read a single stat called `cooldown_reduction`, which does not
   exist in this game, so cooldown reduction did nothing whatsoever. */
function cdrParts(spell, sheet) {
  const s = sheet || live;
  const ctx = { spell: spell, element: elementOf(spell), weaponType: weaponType() };
  const parts = [];
  Object.keys(DMG.cdr || {}).forEach(sid => {
    if (!allMet(DMG.cdr[sid].ifs, ctx)) return;
    let v = s.total(sid) || 0;
    /* Each of these stats carries its own ceiling - plain `cdr` caps at 75,
       cast_speed_to_cooldown_cdr at 50 - and the cap belongs to the stat, not
       to the sum. */
    const cap = DMG.cdr[sid].max;
    if (cap !== null && cap !== undefined && v > cap) v = cap;
    if (Math.abs(v) > 0.005) parts.push([sid, v]);
  });
  return parts;
}
function cdrPct(spell, sheet) {
  return cdrParts(spell, sheet).reduce((n, p) => n + p[1], 0);
}

function rateOf(spellId, sheet) {
  const sp = (SK.spells || {})[spellId];
  if (!sp) return null;
  const s = sheet || live;
  const pct = castSpeedPct(sp, s);
  const multi = 1 + Math.max(-99, pct) / 100;
  const gcd = SK.globalCooldownTicks || 2;
  let ticks = Math.max(gcd, (sp.castTicks || 20) / multi);

  /* A skill on cooldown is limited by whichever is slower. Cooldown reduction
     is floored at MIN_SPELL_COOLDOWN_MULTI. */
  let cdTicks = 0;
  if (sp.cooldown) {
    const cdMulti = Math.max(SK.minCooldownMulti || 0.2, 1 - cdrPct(sp, s) / 100);
    cdTicks = sp.cooldown * cdMulti;
  }
  const interval = Math.max(ticks, cdTicks);
  const castsPerSec = 20 / interval;
  /* Every projectile is its own hit, and the game counts them that way: a
     58.5s parse logged 415 Magic Missile hits over ~90 casts. `projectile_count`
     is additive extra projectiles on top of the one the skill fires, and only
     applies to a skill tagged `projectile` - matching the stat's own
     `ifs: ["spell_has_tag_projectile"]`. */
  const projectile = (sp.tags || []).indexOf('projectile') >= 0;
  const extraProj = projectile ? Math.max(0, s.total('projectile_count') || 0) : 0;
  const projectiles = 1 + extraProj;
  const hits = (sp.times || 1) * projectiles;
  return {
    speedPct: pct, parts: castSpeedParts(sp, s),
    ticks: interval, castsPerSec: castsPerSec,
    projectiles: projectiles,
    hitsPerCast: hits, hitsPerSec: castsPerSec * hits,
    cooldownTicks: cdTicks,
    cdrPct: sp.cooldown ? cdrPct(sp, s) : 0,
    cdrParts: sp.cooldown ? cdrParts(sp, s) : [],
  };
}

/* Which skill drives the rotation - the one a proc is triggered BY. It is the
   fastest thing actually being cast, because that is what is generating hits. */
function drivingSkill() {
  let best = null, rate = 0;
  (typeof loadout === 'undefined' ? [] : loadout).forEach((l, i) => {
    if (!l.spell || (l.use || 'cast') !== 'cast') return;
    const r = rateOf(l.spell, skillSheet(l.supports));
    if (r && r.hitsPerSec > rate) { rate = r.hitsPerSec; best = l.spell; }
  });
  return { id: best, hitsPerSec: rate };
}

/* A proc does not have a cast rate of its own - it fires when something else
   hits. Fan of Knives at 10% on hit, behind Magic Missile's hits, lands a bit
   over once a second; rating it as though it were cast on cooldown made it
   worth nine times its measured damage. */
function procRate(sp, pct) {
  const driver = drivingSkill();
  const chance = (pct === undefined ? 10 : pct) / 100;
  const perHit = driver.hitsPerSec * chance;      // if nothing blocked it
  /* The lockout is not a cap, it is dead time. After a proc the skill is
     unavailable for `proc_cooldown_ticks`, and hits landing during that window
     are simply wasted - so the cycle is the lockout PLUS the expected wait for
     the next successful roll, and the rate is one proc per cycle.
     Taking min(rate, 1/lockout) instead would overstate it, because it assumes
     a hit is always waiting the instant the lockout ends. */
  /* ProcSpellEffect.activate calls
         setOnCooldown(key, spell.config.proc_cooldown_ticks)
     with the RAW config value - it never runs the spell stat calc, so no
     cooldown reduction, attack speed or skill speed touches a proc lockout.
     Only the cast cooldown goes through on_spell_stat_calc. */
  const lock = (sp.procCooldown || 0) / 20;
  let per = perHit;
  if (lock > 0 && perHit > 0) per = 1 / (lock + 1 / perHit);
  const hits = sp.times || 1;
  return {
    speedPct: 0, parts: [], ticks: 0,
    castsPerSec: per, projectiles: 1,
    hitsPerCast: hits, hitsPerSec: per * hits,
    cooldownTicks: sp.procCooldown || 0, proc: true, driver: driver.id,
    uncapped: perHit,
  };
}

/* One calculation for the headline, skill cards, breakdown and comparisons.
   MnS 6.4.13 layer priorities: flat (0), conversion (1), extra (2), then
   multipliers. Extra reads NUMBER after conversion, not BEFORE_CONVERSION_NUMBER.
   Bonus events receive their routed base without another flat-damage layer. */
function skillDps(spellId, rank, supports) {
  const sp = (SK.spells || {})[spellId];
  if (!sp) return null;
  const sheet = skillSheet(supports);
  let base = baseDamage(spellId, rank, sheet);
  if (base === null) return null;
  const element = elementOf(sp);
  const bonus = bonusLevels(spellId, sheet);
  const effectiveRank = Math.min(rank + bonus, (sp.max_lvl || 20) + (SK.maxBonusLevels || 8));
  const flats = [];
  let flatSameEl = 0;
  Object.keys(DMG.flatAdds || {}).forEach(sid => {
    const value = sheet.total(sid) || 0;
    if (value <= 0) return;
    const el = DMG.flatAdds[sid];
    if (el === element) flatSameEl += value;
    else flats.push({ element: el, flat: value, added: true });
  });
  base += flatSameEl;
  const flatLayer = flatLayerAdd(sp, element, sheet, effectiveRank);
  const effectiveBase = base + flatLayer;
  const conversion = [];
  let converted = 0;
  if (element === 'physical' && !(sp.tags || []).includes('dot')) {
    ELEMENTS.filter(el => el !== element).forEach(el => {
      // PhysicalToElement passes StatData.getValue() through an integer cast.
      const percent = Math.max(0, Math.trunc(sheet.total('phys_to_' + el) || 0));
      if (percent) { conversion.push({ element: el, percent, converted: true }); converted += percent; }
    });
  }
  if (converted > 100) conversion.forEach(p => { p.percent *= 100 / converted; });
  const remaining = 100 - Math.min(100, converted);
  const mainBase = effectiveBase * remaining / 100;
  const routed = [{ element, percent: remaining, base: mainBase, main: true }];
  conversion.forEach(p => routed.push(Object.assign(p, { base: effectiveBase * p.percent / 100 })));
  if (element === 'physical' && !(sp.tags || []).includes('dot')) {
    ELEMENTS.filter(el => el !== element).forEach(el => {
      const percent = Math.max(0, Math.trunc(sheet.total('plus_phys_to_' + el) || 0));
      if (percent && mainBase > 0) routed.push({ element: el, percent, extra: true,
        base: mainBase * percent / 100 });
    });
  }
  flats.forEach(p => routed.push(Object.assign(p, { base: p.flat })));

  // DamageEvent.addBonusEleDmg stores integer bases. Portions targeting the
  // same element share its multiplier stack, so summing their expected damage
  // is equivalent to the game's aggregated bonus event (including crit).
  const slot = (typeof loadout === 'undefined' ? [] : loadout).find(l => l.spell === spellId);
  const use = (slot && slot.use) || 'cast';
  const rate = use === 'proc' ? procRate(sp, slot.procPct) : rateOf(spellId, sheet);
  const parts = routed.map(p => {
    if (!p.main) p.base = Math.max(0, Math.trunc(p.base));
    const hit = hitDamage({ base_damage: p.base, spell: sp }, p.element, sheet, !p.main);
    return Object.assign({}, p, hit, { dps: hit.average * rate.hitsPerSec,
      dpsMitigated: hit.mitigated * rate.hitsPerSec });
  });
  const sum = key => parts.reduce((total, p) => total + p[key], 0);
  return {
    id: spellId, spell: sp, sheet, element, rank, bonus, effectiveRank,
    base, flatSameEl, flatLayer, effectiveBase, parts, rate, use,
    average: sum('average'), nonCrit: sum('hit'), allCrit: sum('crit'), mitigated: sum('mitigated'),
    critChance: parts[0].critChance, critMulti: parts[0].critMulti,
    dps: sum('dps'), dpsMitigated: sum('dpsMitigated'),
  };
}

function damageSplit(spellId, rank, supports) {
  const result = skillDps(spellId, rank, supports);
  return result ? result.parts : [];
}
