/* What it takes to kill you.
 *
 * Defence is the offensive walk with the sheets swapped: the character is the
 * target, the attacker is whatever Config points at, and the question is what
 * fraction of a raw incoming hit reaches the pools. Nothing here re-derives
 * mitigation - it runs the same layers through the same `layerMulti()` clamps,
 * off the same stat map. Only the pools are new.
 *
 * ## Two numbers, not one
 *
 * `taken` folds avoidance in as an expectation - the only form an average can
 * take - and answers "how much raw damage do I survive on average".
 *
 * `takenUnavoided` assumes every avoidable roll FAILS, and answers "what is
 * the biggest single hit that does not kill me". A chance to reduce damage
 * does nothing about the hit that lands, so a build can have a comfortable
 * effective pool and still be one unlucky boss slam from dead. The gap between
 * the two is exactly that risk, and one number would hide it.
 *
 * ## Why this is a closed form and not a solver
 *
 * Mitigation in this pack is entirely PROPORTIONAL: every layer that touches
 * an incoming hit multiplies it. `flat_damage_reduction` exists as a layer but
 * NOTHING writes to it - zero stats, checked in the damage map and in the raw
 * registry - and the same holds for `damage_block` and `damage_taken_as`.
 *
 * That matters, because with flat reduction in play `pool / taken` is NOT the
 * survival boundary. Ryongen's planner uses that shortcut and is wrong in that
 * case: pool 100, 50% mitigation, flat reduction 10 - a reference hit of 100
 * takes 40, so the shortcut says 250, while the real boundary solves
 * 0.5x - 10 = 100 and is 220.
 *
 * With no flat reduction the shortcut IS exact, so this uses it, and
 * `flatReductionPresent()` guards it: if a pack update adds such a stat the
 * result is reported unsupported rather than quietly wrong.
 *
 * ## The chaos bypass
 *
 * `MagicShield.modifyEntityDamage` lets CHAOS_BYPASS_PERCENT = 50 of chaos
 * damage walk past the shield into health, unless
 * `chaos_doesnt_bypass_magic_shield` is above zero. So the chaos pool is
 * `min(health + shield, 2 x health)`: once the shield is larger than health,
 * the bypassing half kills you before the shield empties.
 */

const DEFENCE_ELEMENTS = ['physical', 'fire', 'water', 'lightning', 'chaos'];

/* Nothing in this pack produces flat reduction. If that ever changes, say so
   rather than reporting a number the closed form cannot produce. */
function flatReductionPresent(sheet) {
  const s = sheet || live;
  const map = DMG.otherLayers || {};
  return Object.keys(map).some(sid =>
    map[sid].layer === 'flat_damage_reduction' && (s.total(sid) || 0) !== 0);
}

/* Every damage_reduction stat that applies to this element, summed.
 *
 * Which ones those are is decided by each stat's own CONDITIONS, not by its
 * `ele` field. `ele` is a default that every stat carries - plain
 * `dmg_reduction` says `Physical` while having no conditions at all, and it
 * reduces every element. The stats that genuinely care declare
 * `ele_match_stat`, which `allMet` already evaluates against `statEle`.
 *
 * Filtering on `ele` as well looked like belt and braces and was simply wrong:
 * it let physical keep its 13.8% reduction and silently denied it to fire,
 * cold, lightning and chaos. */
function reductionFor(element, sheet) {
  const s = sheet || live;
  const map = DMG.otherLayers || {};
  const ctx = { element: element, spell: {}, weaponType: weaponType() };
  let total = 0;
  Object.keys(map).forEach(sid => {
    const d = map[sid];
    if (!d.target || d.layer !== 'damage_reduction') return;
    ctx.statEle = d.ele;
    if (!allMet(d.ifs, ctx)) return;
    total += s.total(sid) || 0;
  });
  return total;
}

/* The resistance actually usable, which is not the stat:
   ElementalResist.getUsableValue clamps it to 75 plus `max_<ele>_resist`,
   itself capped at 90. Penetration comes off before the clamp. */
function usableResist(element, attacker, sheet) {
  const s = sheet || live;
  const raw = (s.total(element + '_resist') || 0) - ((attacker && attacker.penetration) || 0);
  const cap = Math.min(90, 75 + (s.total('max_' + element + '_resist') || 0));
  return Math.min(cap, raw);
}

/* How much of a raw hit of this element reaches the pools. */
function takenFraction(element, opts) {
  const o = opts || {};
  const s = o.sheet || live;
  const attacker = o.attacker || {};
  const steps = [];

  const res = usableResist(element, attacker, s);
  const resLayer = element === 'physical' ? 'physical_mitigation' : 'elemental_mitigation';
  steps.push({ id: resLayer, multi: layerMulti(resLayer, -res),
               note: round1(res) + '% resistance' });

  /* Armour protects against physical only, on the same curve the offensive
     side uses - but read off the DEFENDER, against the attacker's level. */
  if (element === 'physical') {
    const armour = Math.max(0, (s.total('armor') || 0) - (attacker.armourPenetration || 0));
    let mit = 0;
    if (armour > 0) {
      const needed = 100 * scaleMulti('armor', attacker.level || charLevel);
      const floor = (LAYERS.armor_mitigation || {}).min;
      const cap = floor === undefined || floor === null ? 0.9 : 1 - floor;
      mit = Math.max(0, Math.min(cap, armour / (armour + needed)));
    }
    steps.push({ id: 'armor_mitigation', multi: 1 - mit,
                 note: Math.round(armour) + ' armour' });
  }

  const red = reductionFor(element, s);
  if (red) {
    steps.push({ id: 'damage_reduction', multi: layerMulti('damage_reduction', -red),
                 note: round1(red) + '% reduction' });
  }

  /* Suppression is a CHANCE, so it belongs in the average and must be absent
     from the unavoided figure - that is the whole point of the two numbers. */
  if (!o.unavoided) {
    const chance = Math.max(0, Math.min(100, s.total('dmg_reduction_chance') || 0));
    if (chance) {
      /* The stat is SPECIFIC_NUMBER 50: when it fires it halves the hit. */
      const whenItFires = layerMulti('damage_suppression', -50);
      steps.push({ id: 'damage_suppression',
                   multi: 1 - (chance / 100) * (1 - whenItFires),
                   note: round1(chance) + '% chance to suppress' });
    }
  }

  let taken = 1;
  steps.forEach(st => { taken *= st.multi; });
  return { taken: taken, steps: steps };
}

/* The pool this element has to chew through. */
function poolFor(element, sheet) {
  const s = sheet || live;
  const health = Math.max(0, s.total('health') || 0);
  const shield = Math.max(0, s.total('magic_shield') || 0);
  const bypassOff = (s.total('chaos_doesnt_bypass_magic_shield') || 0) > 0;
  if (element !== 'chaos' || bypassOff) {
    return { pool: health + shield, health: health, shield: shield, bypass: false };
  }
  return { pool: Math.min(health + shield, 2 * health),
           health: health, shield: shield, bypass: true };
}

/* Mana absorbs a percentage of each post-mitigation hit, but only while mana
   is above half its maximum and only down to that half - a buffer of
   maxMana/2, not a pool. Reported with both numbers rather than folded in,
   because folding it needs a regeneration model to say how full mana was when
   the hit landed, and no build document states that. */
function manaAbsorb(sheet) {
  const s = sheet || live;
  const pct = Math.max(0, s.total('damage_absorbed_by_mana') || 0);
  const mana = Math.max(0, s.total('mana') || 0);
  return { percent: pct, buffer: pct > 0 ? mana / 2 : 0 };
}

/* Every element, ready to render. */
function defenceRows(opts) {
  const o = opts || {};
  const unsupported = flatReductionPresent(o.sheet);
  return DEFENCE_ELEMENTS.map(element => {
    const avg = takenFraction(element, Object.assign({}, o, { unavoided: false }));
    const worst = takenFraction(element, Object.assign({}, o, { unavoided: true }));
    const p = poolFor(element, o.sheet);
    return {
      element: element,
      taken: avg.taken, takenUnavoided: worst.taken,
      steps: worst.steps, avgSteps: avg.steps,
      pool: p.pool, health: p.health, shield: p.shield, chaosBypass: p.bypass,
      maxHit: unsupported ? null
        : (worst.taken > 0 ? p.pool / worst.taken : Infinity),
      effectiveHealth: unsupported ? null
        : (avg.taken > 0 ? p.pool / avg.taken : Infinity),
      unsupported: unsupported,
    };
  });
}
