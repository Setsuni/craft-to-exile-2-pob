// CTE2 PoB - browser-side stat recalc.
//
// A port of the order-sensitive tail of resolve.py, and only that tail. Anything
// the talent tree cannot change (gear, buffs, jewels, attribute compat, set
// bonuses, newbie resists) arrives pre-resolved as a flat contribution list; the
// perks and the auras arrive unapplied, because allocating a node changes both
// the perk contributions and the aura_effect multiplier that scales the auras.
//
// Verified against resolve.py: recomputing the shipped allocation reproduces
// every stat of the Python sheet to 1e-6.

function makeEngine(calc, defaultLevel) {
  const D = calc.defs;
  const DEFAULT_LEVEL = defaultLevel || 100;

  function Sheet() {
    this.flat = Object.create(null);
    this.perc = Object.create(null);
    this.more = Object.create(null);
    this.why  = Object.create(null);
  }
  Sheet.prototype.add = function (stat, kind, v, src) {
    if (!stat || !v && kind !== 'MORE') { if (!stat) return; }
    if (kind === 'PERCENT') this.perc[stat] = (this.perc[stat] || 0) + v;
    else if (kind === 'MORE') this.more[stat] = (this.more[stat] === undefined ? 1 : this.more[stat]) * (1 + v / 100);
    else this.flat[stat] = (this.flat[stat] || 0) + v;
    (this.why[stat] || (this.why[stat] = [])).push([src, kind, v]);
  };
  Sheet.prototype.total = function (stat) {
    const d = D[stat] || {};
    let v = (d.base || 0) + (this.flat[stat] || 0);
    v *= 1 + (this.perc[stat] || 0) / 100;
    if (d.more) v *= (this.more[stat] === undefined ? 1 : this.more[stat]);
    if (d.min !== undefined) v = Math.max(v, d.min);
    if (d.max !== undefined) v = Math.min(v, d.max);
    return v;
  };
  /* The MORE component on its own. `total()` deliberately does NOT fold this in
     for MULTIPLICATIVE_DAMAGE stats - BaseDamageIncreaseEffect sends it to
     DamageEvent.getMoreMultis() instead of the stat's own value, so the damage
     engine needs it separately. */
  Sheet.prototype.moreOf = function (stat) {
    return this.more[stat] === undefined ? 1 : this.more[stat];
  };
  Sheet.prototype.clear = function (stat) {
    this.flat[stat] = 0; this.perc[stat] = 0; this.more[stat] = 1;
  };

  // LevelScalingConfig.getMultiFor, for the inputs that scale with CHARACTER
  // level rather than item level.
  function multi(scaling, level) {
    const c = calc.scalings[scaling];
    if (!c) return 1;
    const lvl = c.cap ? Math.max(1, Math.min(level, 100)) : level;
    return c.base + c.per_level * (lvl - 1);
  }

  // allocated: a LIST of perk ids, one entry per allocated node. Duplicates are
  // meaningful - the same small perk sits on many nodes and each one counts.
  // contribs: optional replacement for the pre-resolved contribution list, so
  // the gear configurator can swap one slot's stats without touching the rest.
  // level: the character level to evaluate at; defaults to the save's.
  // auras: [stat, type, value, src] entries to be scaled by aura_effect and
  //   applied AFTER the perks, because aura_effect comes from the tree. Pass
  //   nothing to keep whatever the save had equipped.
  return function recompute(allocated, contribs, level, auras) {
    const lvl = level || DEFAULT_LEVEL;
    const s = new Sheet();
    for (const c of (contribs || calc.contribs)) s.add(c[0], c[1], c[2], c[3]);

    // Base profile: flagged mods scale with character level.
    for (const m of calc.baseProfile) {
      s.add(m[0], m[1], m[3] ? m[2] * multi(calc.scalingOf[m[0]] || 'NORMAL', lvl) : m[2],
            'base');
    }
    for (const pid of allocated) {
      const mods = calc.nodeMods[pid];
      if (!mods) continue;
      for (const m of mods) {
        s.add(m[0], m[1],
              m[3] ? m[2] * multi(calc.scalingOf[m[0]] || 'NORMAL', lvl) : m[2],
              'perk:' + pid);
      }
    }
    // aura_effect is read off the sheet before auras land, exactly as the game does.
    const auraMult = 1 + s.total('aura_effect') / 100;
    for (const a of (auras || calc.auraMods)) s.add(a[0], a[1], a[2] * auraMult, a[3]);

    // PlayerStatUtils.addNewbieElementalResists - a flat band by level,
    // deliberately unscaled, and it goes NEGATIVE past 74.
    if (calc.newbieResists) {
      const amount = lvl <= 24 ? 50 : lvl <= 49 ? 25 : lvl <= 74 ? 0 : -25;
      for (const e of calc.singles) s.add(e + '_resist', 'FLAT', amount, 'newbie_resists');
    }

    // Vanilla attribute conversion: convert the ENTITY total once, then scale.
    for (const r of calc.attrRules) {
      const raw = calc.attrTotals[r.attr];
      if (!raw) continue;
      let v = Math.trunc(raw * r.conv);
      v = Math.max(r.min, Math.min(v, r.max));
      if (v) v = Math.trunc(multi(r.scaling, lvl) * v);
      if (v) s.add(r.stat, r.mod, v, 'attr:' + r.attr);
    }

    const el = s.total('elemental_resist');
    if (el) {
      for (const e of calc.elements) s.add(e + '_resist', 'FLAT', el, 'transfer:elemental_resist');
      s.clear('elemental_resist');
    }
    /* AllAttributes is the other ITransferToOtherStats: it feeds every core
       attribute and then zeroes itself, which is why the game reports
       all_attributes as 0 on a character wearing curios that grant it. Only
       the elemental transfer was ported, so a necklace granting +41 to all
       attributes moved nothing - and since the core-stat pass runs right
       below, everything those attributes feed came out low as well. */
    const allAttr = s.total('all_attributes');
    if (allAttr) {
      for (const core of ['strength', 'dexterity', 'intelligence']) {
        s.add(core, 'FLAT', allAttr, 'transfer:all_attributes');
      }
      s.clear('all_attributes');
    }
    // CoreStat.affectStats truncates the attribute before transferring.
    for (const sid in calc.core) {
      const amount = Math.trunc(s.total(sid));
      if (!amount) continue;
      for (const m of calc.core[sid]) s.add(m[0], m[1], m[2] * amount, 'core:' + sid);
    }
    for (const d of calc.derived) {
      const rate = s.total(d.id), src = s.total(d.from);
      if (!rate || !src) continue;
      if (d.ser === 'one_to_other') {
        s.add(d.to, 'FLAT', d.perc ? src * rate / 100 : src * rate, 'derived:' + d.id);
      } else {
        s.add(d.to, d.perc ? 'PERCENT' : 'FLAT', (src / d.per) * rate, 'derived:' + d.id);
      }
    }
    return s;
  };
}
if (typeof module !== 'undefined') module.exports = { makeEngine };

// ---------------------------------------------------------------------------
// Item builder: a port of resolve.py's gear_stats() for the configurator.
//
// Only the parts a hand-built item needs - base stats, implicit, prefixes and
// suffixes. Sockets, runewords and uniques stay pre-resolved on the equipped
// items, because a configured item has none of them.
function makeItemEngine(cat) {
  const MAXL = cat.maxLevel || 100;

  // LevelScalingConfig.getMultiFor
  function multi(scaling, level) {
    const c = cat.scalings[scaling];
    if (!c) return 1;
    const lvl = c.cap ? Math.max(1, Math.min(level, MAXL)) : level;
    return c.base + c.per_level * (lvl - 1);
  }
  // ExactStatData.fromStatModifier + Stat.scale: FLAT scales, PERCENT/MORE don't.
  function exact(mod, pct, level) {
    let v = mod.min + (mod.max - mod.min) * pct / 100;
    const kind = mod.type || 'FLAT';
    if (kind === 'FLAT') v *= multi(cat.statScaling[mod.stat] || 'NONE', level);
    return { stat: mod.stat, type: kind, value: v };
  }

  // IBaseStatModifier - these fold into the base stats they cover.
  const COVERS = {
    gear_defense: ['armor', 'dodge_rating', 'dodge', 'magic_shield'],
    gear_damage: ['weapon_damage'],
  };

  /* `extra` is stats the item grants that are not affixes - a unique's own
     fixed lines, a socketed rune or gem. They belong in the same pass as the
     affixes: anything granting gear_defense raises armour, dodge and magic
     shield, and folding has to happen against the BASE stats only, never
     against the other modifiers standing beside them. */
  return { multi, exact, statsOf(item, extra) {
    const base = cat.bases[item.base];
    if (!base) return (extra || []).slice();
    const lvl = item.ilvl, pct = item.basePct + (item.quality || 0);
    const out = base.base_stats.map(m => exact(m, pct, lvl));   // mutable
    const rest = [];
    for (const a of item.affixes || []) {
      const def = cat.affixes[a.id];
      if (!def) continue;
      for (const m of def.stats) rest.push(exact(m, a.pct, lvl));
    }
    for (const e of extra || []) rest.push(e);
    for (const e of rest) {
      const covers = COVERS[e.stat];
      if (!covers) continue;
      for (const b of out) {
        if (!covers.includes(b.stat)) continue;
        if (e.type === 'FLAT') b.value += e.value;
        else if (e.type === 'PERCENT') b.value *= (1 + e.value / 100);
      }
    }
    return out.concat(rest);   // the modifier is reported as its own stat too
  } };
}
if (typeof module !== 'undefined') module.exports.makeItemEngine = makeItemEngine;
