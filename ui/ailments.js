/* Ailments - the damage a hit leaves behind.
 *
 * Five of them, and they are not in any registry: `Ailments.java` constructs
 * all five in Java, which is why nothing extracted them for so long and why
 * `ailment_damage` read zero on a character that poisons, electrifies and
 * freezes. `export_build.py` now ships the table as `B.ailments`.
 *
 * ## An ailment is a second damage event
 *
 * `AilmentChance.activate` builds a whole new `DamageEvent` with
 * `disableActivation = true`: it runs the entire pipeline purely to arrive at
 * a number and never deals that damage itself. The number then goes to
 * `onAilmentCausingDamage`, which is where duration and stacking happen.
 *
 * ## A tick is not a hit
 *
 * `EntityAilmentData.onTick` fires with
 * `calcSourceEffects = calcTargetEffects = false` - a tick skips the stat
 * sweep entirely, so neither the attacker's damage stats nor the target's
 * mitigation apply a second time. They were already applied when the ailment
 * was inflicted. That is why this takes the MITIGATED hit as its input and
 * then leaves it alone.
 *
 * ## Two kinds
 *
 * Burn, poison and bleed TICK: they spread their share of the hit over a
 * duration. Freeze and electrify do not tick at all - they ACCUMULATE into a
 * pool that a Shatter or Shock proc releases in one event, losing 10% a second
 * while it waits. Listing a stored pool as continuous DPS would be a lie, so
 * they are reported as a pool with its decay and the chance to release it.
 *
 * What this does NOT model, and says so rather than guessing: whether a second
 * application stacks, refreshes or is ignored. That decides uptime, and uptime
 * decides how much of the per-application figure a fight actually sees.
 */

/* `Ailments.java` argument order: (id, element, isDot, isStrength,
   damageEffectivenessMulti, percentLostEveryXSeconds, durationTicks). The
   table ships in the bundle; this only names the stats that scale it. */
function ailmentTable() {
  const t = B.ailments || {};
  return Object.keys(t).map(id => Object.assign({ id: id }, t[id]));
}

/* The chance a hit of this element inflicts this ailment. The stat is
   `<id>_chance` and it is a percentage. */
function ailmentChance(id, sheet) {
  return Math.max(0, (sheet || live).total(id + '_chance') || 0) / 100;
}

/* One ailment, given the mitigated damage of the hit that inflicted it. */
function ailmentFrom(ail, hitDamage, sheet) {
  const s = sheet || live;
  const strength = 1 + (s.total(ail.id + '_strength') || 0) / 100;
  const speed = 1 + (s.total('dot_speed') || 0) / 100;
  const duration = 1 + (s.total(ail.id + '_duration') || 0) / 100;
  /* `ailment_damage` and its per-ailment sibling are ordinary increases on
     the number the inflicting event produced. */
  const inc = 1 + ((s.total('ailment_damage') || 0) +
                   (s.total(ail.id + '_damage') || 0)) / 100;

  let dmg = hitDamage * (ail.effectiveness || 1) * strength * inc;

  if (!ail.dot) {
    /* A pool, not a tick. `decayPerSecond` is
       clamp(percentLostEveryXSeconds / max(0.01, durMulti), 0, 1), so slowing
       the decay is the only thing duration buys an ailment that never ticks. */
    return {
      id: ail.id, element: ail.element, dot: false,
      dps: 0, total: dmg, seconds: 0,
      pool: dmg,
      decayPerSecond: Math.max(0, Math.min(1,
        (ail.lostPerSec || 0) / Math.max(0.01, duration))),
      procChance: Math.max(0, Math.min(1,
        (s.total(ail.id + '_proc_chance') || 0) / 100)),
    };
  }

  /* Spread the hit's worth over the whole duration, then let dot_speed
     compress it: the same total arrives sooner, so the rate goes up. */
  dmg *= 1 / ((ail.durationTicks || 20) / 20);
  dmg *= speed;

  /* Java truncates `int ticks` at every step, and floors the result at 21. */
  let ticks = ail.durationTicks || 20;
  ticks = Math.trunc(ticks / speed);
  ticks = Math.trunc(ticks * duration);
  if (ticks < 21) ticks = 21;
  const seconds = ticks / 20;

  return {
    id: ail.id, element: ail.element, dot: true,
    dps: dmg, total: dmg * seconds, seconds: seconds,
    pool: 0, decayPerSecond: 0, procChance: 0,
  };
}

/* Every ailment a skill can inflict, with the chance it does.
 *
 * `hitRate` is how often the skill lands, so `applied` is applications per
 * second. It is NOT multiplied into `dps`: a DoT that is already running does
 * not obviously stack, and pretending otherwise would turn an unverified
 * mechanic into a headline number. `applied` is reported so the reader can see
 * how often it is refreshed. */
function ailmentsForHit(hitDamage, hitRate, sheet) {
  const s = sheet || live;
  return ailmentTable().map(ail => {
    const chance = ailmentChance(ail.id, s);
    if (chance <= 0) return null;
    const out = ailmentFrom(ail, hitDamage, s);
    out.chance = chance;
    out.applied = chance * (hitRate || 0);
    return out;
  }).filter(Boolean);
}

/* The ailment damage a skill is responsible for, as a rate.
 *
 * For a DoT this is its own DPS while it runs, weighted by how likely it is to
 * be running at all - which, absent a verified stacking rule, is taken as the
 * chance that at least one application landed within its duration. That is an
 * UPTIME estimate and is labelled as one.
 *
 * For freeze and electrify the honest rate is what the pool releases: the
 * accumulated damage times how often a proc fires, net of decay. */
function ailmentDps(rows) {
  let dot = 0, released = 0;
  (rows || []).forEach(r => {
    if (r.dot) {
      /* Applications land at `applied` per second and each lasts `seconds`, so
         the expected number inside one duration window is their product. Treat
         them as arriving independently: the chance none did is exp(-that), and
         uptime is the complement.

         This assumes a fresh application REFRESHES rather than stacks. If it
         stacks, this understates a high-chance build; if a running ailment
         blocks reapplication, it overstates one. That rule is not verified,
         which is why the figure is labelled an estimate. */
      const expected = r.applied * r.seconds;
      const uptime = expected > 0 ? 1 - Math.exp(-expected) : 0;
      dot += r.dps * uptime;
    } else {
      released += r.pool * r.applied * r.procChance;
    }
  });
  return { dot: dot, released: released, total: dot + released };
}
