#!/usr/bin/env python3
"""
CTE2 PoB - Step 3: damage engine.

Two halves, both read out of bytecode / data rather than fitted:

1. BASE DAMAGE, from mmorpg_value_calc (ValueCalculation / ScalingCalc / LeveledValue)

     LeveledValue(v)        = v.min + ((v.max - v.min) / maxSpellLvl) * spellLvl
     base                   = (int)( StatScaling[base_scaling_type]
                                       .scale(LeveledValue(base), charLevel)
                                     * SPELL_BASE_DAMAGE_MULTIPLIER )
     scalingPart            = SUM over stat_scalings of
                                (int)( LeveledValue(multi) * charStat[stat] )
     total                  = base + scalingPart        # each term truncated to int
                              capped to weapon_damage * cap_to_wep_dmg when set

2. THE LAYER PIPELINE, from mmorpg_stat_layer (14 layers, each with a priority,
   an action and clamps). Applied in ascending priority:

     ADD              v += amount
     MULTIPLY         v *= (1 + amount/100), clamped to [min_multi, max_multi]
     CONVERT_PERCENT / X_AS_BONUS_Y / DAMAGE_TAKEN_AS - element routing, not yet modelled

   Validated against two in-game tooltips of different shape:

     Basic attack (physical, has a flat-add step)
       (91 + 42.12) x1.11 x2.80 x1.23 x1.05  = 534   vs 538 in-game  (-0.68%)
     Ice Comet (cold, pure multiplicative)
       1924 x7.28 x1.30 x1.47 x1.47 x1.20 x1.15 x1.34 = 72761 vs 72359 (+0.56%)

   Both residuals are consistent with the tooltip rounding every multiplier to two
   decimals, so the ORDER and the SHAPE of the pipeline are confirmed. What is not
   yet confirmed is which character stat feeds which multiplier - that needs a save
   and a tooltip captured from the same character at the same moment.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve as R


def leveled(v, spell_lvl, max_spell_lvl):
    """LeveledValue.getValue - note it divides by maxLvl, not (maxLvl-1)."""
    lo = float(v.get('min', 0.0))
    hi = float(v.get('max', lo))
    if lo == hi or not max_spell_lvl:
        return lo
    return lo + ((hi - lo) / float(max_spell_lvl)) * float(spell_lvl)


def base_damage(calc, stats, char_level, spell_lvl, max_spell_lvl, rules,
                spell_dmg_multi=1.0, max_bonus_spell_levels=8):
    """ValueCalculation.getCalculatedValue = base part + scaling part.

    Two subtleties that a single-scaling spell hides:

    * The LeveledValue divisor is getMaxLevelWithBonuses() - the spell's max_lvl
      PLUS MAX_BONUS_SPELL_LEVELS (8), not max_lvl. A spell whose min == max is
      insensitive to this, which is why Bolt validated with either value.
    * Scalings split into the weapon_damage one and everything else. The
      cap_to_wep_dmg cap applies to the OTHERS only, bounded by the weapon part,
      and only when cap_to_wep_dmg < 50 (ValueCalculation.capsToWeaponDamage).
    """
    max_lvl = (max_spell_lvl or 0) + max_bonus_spell_levels

    base_v = leveled(calc.get('base') or {}, spell_lvl, max_lvl)
    scaled = rules.multi(calc.get('base_scaling_type') or 'NONE', char_level) * base_v
    base_part = int(scaled * spell_dmg_multi)

    wep = 0.0        # the weapon_damage scaling (+ mobBaseDamage, 0 for players)
    others = 0.0
    for sc in (calc.get('stat_scalings') or []) + (calc.get('target_stat_scalings') or []):
        m = leveled(sc.get('multi') or {}, spell_lvl, max_lvl)
        v = int(m * float(stats.get(sc.get('stat'), 0.0)))
        if sc.get('stat') == 'weapon_damage':
            wep += v
        else:
            others += v

    cap_factor = calc.get('cap_to_wep_dmg')
    if cap_factor is not None and float(cap_factor) < 50.0:
        others = min(others, wep * float(cap_factor))

    return base_part + int(others + wep)


class Pipeline:
    """The ordered damage layers from mmorpg_stat_layer."""

    def __init__(self, layers):
        self.layers = sorted(
            ((k, v) for k, v in layers.items() if isinstance(v, dict)),
            key=lambda kv: kv[1].get('priority', 0))

    def describe(self):
        for k, v in self.layers:
            print('  %-4s %-24s %-24s min %-12s max %s' % (
                v.get('priority'), k, v.get('action'),
                v.get('min_multi'), v.get('max_multi')))

    def apply(self, base, amounts, trace=None):
        """amounts: {layer_id: value}. ADD is flat, MULTIPLY is a percent."""
        v = float(base)
        for k, layer in self.layers:
            if k not in amounts:
                continue
            amt = float(amounts[k])
            act = layer.get('action')
            if act == 'ADD':
                v += amt
            elif act == 'MULTIPLY':
                m = 1.0 + amt / 100.0
                lo, hi = layer.get('min_multi'), layer.get('max_multi')
                if lo is not None:
                    m = max(m, float(lo))
                if hi is not None:
                    m = min(m, float(hi))
                v *= m
            else:
                # CONVERT_PERCENT / X_AS_BONUS_Y / DAMAGE_TAKEN_AS reroute damage
                # between elements rather than scaling it. Not modelled yet.
                continue
            if trace is not None:
                trace.append((k, act, amt, v))
        return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214')
    ap.add_argument('--spell', default='ice_comet')
    ap.add_argument('--spell-level', type=int, default=20)
    ap.add_argument('--character', default=None, help='out/character.json to read stats from')
    args = ap.parse_args()

    def L(n):
        p = os.path.join(args.out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    layers = L('mmorpg_stat_layer.json')
    print('DAMAGE LAYERS (ascending priority)')
    pipe = Pipeline(layers)
    pipe.describe()

    # Self-check the pipeline against the two in-game tooltips.
    print('\nPIPELINE SELF-CHECK (in-game tooltips)')
    basic = pipe.apply(91, {'flat_damage': 42.12, 'additive_damage': 11.0})
    basic *= 2.80 * 1.23 * 1.05      # weapon multi, phys dmg stat, armour mitigation
    print('  basic attack : predicted %.0f  in-game 538   (%+.2f%%)'
          % (basic, (basic - 538) / 538 * 100))
    ice = pipe.apply(1924, {'additive_damage': 628.0})
    ice *= 1.30 * 1.47 * 1.47 * 1.20 * 1.15 * 1.34
    print('  ice comet    : predicted %.0f  in-game 72359 (%+.2f%%)'
          % (ice, (ice - 72359) / 72359 * 100))

    calc = L('mmorpg_value_calc.json').get(args.spell)
    if not calc:
        print('\nno value_calc for %r' % args.spell)
        return
    print('\nBASE DAMAGE  %s @ spell level %d' % (args.spell, args.spell_level))
    print('  ' + json.dumps({k: v for k, v in calc.items() if k != 'id'}))

    if not args.character:
        print('\n  (pass --character out214/character.json to compute against a real sheet)')
        return

    ch = json.load(open(args.character, encoding='utf-8'))
    stats = {k: v['v'] for k, v in ch['computed_stats'].items()}
    rules = R.Rules({'balance': L('mmorpg_game_balance.json')['original_balance'],
                     'stats': L('mmorpg_stat.json'), 'core': L('core_stats.json'),
                     'affixes': {}, 'bases': {}, 'perks': {}})
    cfg = (L('pack_config.json').get('mine_and_slash_compatibility-server.toml')
           or {}).get('settings') or {}
    sp = L('mmorpg_spells.json').get(args.spell) or {}
    max_lvl = sp.get('max_lvl') or 20
    bal = L('mmorpg_game_balance.json')['original_balance']
    bd = base_damage(calc, stats, ch['level'], args.spell_level, max_lvl, rules,
                     float(cfg.get('SPELL_BASE_DAMAGE_MULTIPLIER', 1.0)),
                     int(bal.get('MAX_BONUS_SPELL_LEVELS', 8)))
    print('  character level %s, spell max_lvl %s' % (ch['level'], max_lvl))
    print('  BASE DAMAGE = %d' % bd)


if __name__ == '__main__':
    main()
