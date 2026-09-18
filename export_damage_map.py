#!/usr/bin/env python3
"""
CTE2 PoB - the stat -> multiplier map, which was the last thing blocking DPS.

`BaseDamageIncreaseEffect.activate`, read out of the jar, does two things for
every damage-increase stat:

    dmg.getLayer(ADDITIVE_DMG, NUMBER, side).add(statData.getValue());
    if (stat.getMultiUseType() == MULTIPLICATIVE_DAMAGE)
        dmg.addMoreMulti(stat, NUMBER, statData.getMoreStatTypeMulti());

So a stat contributes in up to two places at once:

  * its VALUE (base + flat, times 1 + percent/100) is summed into the
    `additive_damage` layer, which is a single MULTIPLY at priority 3
  * its MORE component - the running product of (1 + v/100) over every MORE
    mod, which resolve.py already tracks as `Sheet.more` - is pushed onto
    DamageEvent.getMoreMultis(), the parallel list `damage.py` never read

That second list is the piece MnSDummy pointed at. It is not a mystery table:
the stats that reach it are exactly those whose `multiUseType` is
MULTIPLICATIVE_DAMAGE, and the pack declares which stats have the effect at all
via `_additive_damage_number_add_stat_data`.

Whether a given stat applies to a given hit is decided by its `ifs` - named
entries in mmorpg_stat_condition, and they are declarative rather than code:
spell_has_tag (120 of 319), string_matches, is_bool_true, ele_match_stat,
wep_type_match. All of them can be evaluated against a spell plus the hit's
element and attack type.

This emits the whole map so the damage engine can be finished against data
instead of guesses.

    python export_damage_map.py --out out214
"""
import argparse, json, os
from collections import Counter

EFFECT = '_additive_damage_number_add_stat_data'

# The additive layer is not the only one that changes a hit. mmorpg_stat_effect
# is the authoritative table - every effect declares the LAYER it writes to and
# where its number comes from - and filtering on one hardcoded effect name meant
# anything on another layer was invisible to the engine. Archmage is the case
# that exposed it: `_flat_damage_number_add_stat_percent` adds 6% of MANA as
# flat damage, and the planner had never seen the stat.
#
# Layers that change the player's outgoing damage. damage_reduction and
# damage_suppression are target-side and belong to the Target config, so they
# are exported separately rather than folded into the player's stack.
DAMAGE_LAYERS = {'flat_damage', 'additive_damage', 'crit_damage',
                 'dot_dmg_multi', 'double_damage'}
TARGET_LAYERS = {'damage_reduction', 'damage_suppression'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214')
    ap.add_argument('--dest', default=None)
    args = ap.parse_args()
    dest = args.dest or os.path.join(args.out, 'damage_map.json')

    def L(n):
        p = os.path.join(args.out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    stats = L('mmorpg_stat.json')
    conds = L('mmorpg_stat_condition.json')
    layers = L('mmorpg_stat_layer.json')
    effects = L('mmorpg_stat_effect.json')

    def effect_shape(name):
        """Where an effect writes, and where its number comes from."""
        e = effects.get(name)
        if not isinstance(e, dict):
            return None
        prov = e.get('number_provider') or {}
        return {
            'layer': e.get('layer'),
            'mod': e.get('modification'),
            'provider': prov.get('type'),
            # STAT_PERCENT reads a percentage OF this stat - mana for archmage,
            # energy for imbuement - rather than using the stat's own value.
            'of': prov.get('calc') or None,
            'mods': [m.get('type') for m in (e.get('number_modifiers') or [])],
        }

    entries = {}
    # `_flat_damage_number_add_stat_data` is declared in Java, not the
    # datapack, so no stat in mmorpg_stat.json references it and the scan below
    # cannot find its users. flat_physical_added_damage is one: its own value
    # goes onto the flat layer, multiplied by the spell's damage
    # effectiveness. Verified against the game - with mana 8450.26 the sheet
    # reports flat_physical_added_damage 507.02, which is exactly 6% of it.
    other_layers = {
        'flat_physical_added_damage': {
            'layer': 'flat_damage', 'provider': 'STAT_DATA', 'of': None,
            'effectiveness': True,
            'ele': 'Physical', 'order': 'data_modification', 'side': 'Source',
            'ifs': ['is_is_bonus_element_damage_true_is_false'], 'target': False,
        },
    }
    for sid, v in stats.items():
        if not isinstance(v, dict):
            continue
        # Stats writing to a damage layer other than the additive one. These
        # are what the single-name filter used to drop on the floor.
        for e in v.get('effect') or []:
            if 'on_damage' not in (e.get('events') or []):
                continue
            for name in e.get('effects') or []:
                shape = effect_shape(name)
                if not shape or shape['layer'] == 'additive_damage':
                    continue
                if shape['layer'] not in DAMAGE_LAYERS | TARGET_LAYERS:
                    continue
                other_layers[sid] = dict(
                    shape, ele=v.get('ele'), order=e.get('order'),
                    side=e.get('side'), ifs=e.get('ifs') or [],
                    # SPELL_DAMAGE_EFFECTIVENESS_MULTI scales the contribution
                    # by the SPELL's dmg_effectiveness, which is a per-rank
                    # LeveledValue - so the same stat is worth more on a
                    # higher-ranked skill. Ignoring it understated the flat
                    # layer by roughly half.
                    effectiveness=any(
                        m.get('type') == 'SPELL_DAMAGE_EFFECTIVENESS_MULTI'
                        for m in (effects.get(name) or {}).get('number_modifiers') or []),
                    target=shape['layer'] in TARGET_LAYERS,
                    effect=name)
                break
        for e in v.get('effect') or []:
            if EFFECT not in (e.get('effects') or []):
                continue
            # The same effect is reused on other events. `threat_generated`
            # carries it on `on_gen_threat` and never touches a damage hit, so
            # filtering on the effect alone puts 41 stats in the map that do
            # not belong there.
            if 'on_damage' not in (e.get('events') or []):
                continue
            entries[sid] = {
                # MULTIPLICATIVE_DAMAGE also reaches getMoreMultis(); everything
                # else only ever lands in the additive layer.
                'more': v.get('multiUseType') == 'MULTIPLICATIVE_DAMAGE',
                'ele': v.get('ele'),
                'order': e.get('order'),
                'side': e.get('side'),
                'ifs': e.get('ifs') or [],
                'events': e.get('events') or [],
            }
            break

    # Cast speed works exactly like damage: a family of stats, each gated on a
    # spell tag, all feeding one accumulator. `faster_attacks` grants
    # weapon_skill_cast_time, not the two stats a hand-written list would have
    # guessed - 39 of them in total, so enumerate rather than enumerate badly.
    speed = {}
    for sid, v in stats.items():
        if not isinstance(v, dict):
            continue
        for e in v.get('effect') or []:
            if 'add_cast_speed_perc' not in (e.get('effects') or []):
                continue
            speed[sid] = {'ifs': e.get('ifs') or []}
            break

    # Cooldown reduction works exactly like cast speed: 47 stats declare
    # `decrease_cd_ticks_num` on on_spell_stat_calc, each gated on a spell tag
    # (projectile_cdr, melee_cdr, fire_cdr...), plus a plain `cdr` gated on
    # nothing. Only one hardcoded `cooldown_reduction` was being read, and that
    # stat does not even exist - so cooldown reduction did nothing at all.
    cdr = {}
    for sid, v in stats.items():
        if not isinstance(v, dict):
            continue
        for e in v.get('effect') or []:
            if 'decrease_cd_ticks_num' not in (e.get('effects') or []):
                continue
            cdr[sid] = {'ifs': e.get('ifs') or [], 'max': v.get('max')}
            break

    used = sorted({c for x in list(entries.values()) + list(speed.values())
                   + list(cdr.values())
                   for c in x['ifs']})
    cond_out = {}
    for cid in used:
        c = conds.get(cid)
        if not isinstance(c, dict):
            cond_out[cid] = {'ser': 'UNKNOWN'}
            continue
        out = {'ser': c.get('ser')}
        for k in ('tag', 'string_id', 'string_key', 'bool_key', 'number',
                  'wep_type', 'effect_id', 'is_false'):
            if k in c:
                out[k] = c[k]
        if isinstance(out.get('tag'), dict):
            out['tag'] = out['tag'].get('id')
        cond_out[cid] = out

    layer_out = {k: {'priority': v.get('priority'), 'action': v.get('action'),
                     'min': v.get('min_multi'), 'max': v.get('max_multi')}
                 for k, v in layers.items() if isinstance(v, dict)}

    # Four damage stats are declared in Java, not the datapack, so scanning
    # mmorpg_stat.json alone misses them. Their conditions come from
    # canActivate() on each Effect class:
    #   SkillDamage   `spell_damage`  -> event.isSpell()
    #   HitDamage     `hit_damage`    -> the hit carries no ailment
    #   AilmentDamage `<x>_damage`    -> that ailment only
    # All four extend BaseDamageIncreaseEffect, so they behave exactly like the
    # datapack ones: value into the additive layer, MORE into getMoreMultis().
    code = {
        'spell_damage': {'more': True, 'ele': 'ALL', 'when': 'is_spell'},
        'hit_damage': {'more': True, 'ele': 'ALL', 'when': 'is_hit'},
        'ailment_damage': {'more': True, 'ele': 'ALL', 'when': 'is_ailment'},
        'all_ailment_damage': {'more': True, 'ele': 'ALL', 'when': 'is_ailment'},
    }
    # Flat elemental adds. BonusFlatElementalDamage routes through
    # DamageEvent.addBonusEleDmg, so the added amount becomes its own
    # bonus-element hit with its own multiplier stack - the same path
    # conversion takes, which is why it is not simply "+N damage".
    flat = {}
    for el in ('fire', 'water', 'lightning', 'chaos', 'physical'):
        flat['flat_%s_added_damage' % el] = el

    out = {'effect': EFFECT, 'stats': entries, 'speed': speed, 'cdr': cdr,
           'code': code,
           'flatAdds': flat, 'conditions': cond_out, 'layers': layer_out,
           # Stats on a damage layer other than the additive one, with the
           # layer and number source each writes through.
           'otherLayers': other_layers}
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))

    more = sum(1 for v in entries.values() if v['more'])
    sers = Counter(v.get('ser') for v in cond_out.values())
    uncond = sum(1 for v in entries.values() if not v['ifs'])
    print('damage map -> %s  (%.0f KB)' % (dest, os.path.getsize(dest) / 1024))
    print('  %d stats feed the damage stack' % len(entries))
    print('     %d also produce a MORE multiplier (MULTIPLICATIVE_DAMAGE)' % more)
    print('     %d are additive only' % (len(entries) - more))
    print('     %d apply unconditionally, %d are gated' % (uncond, len(entries) - uncond))
    print('  %d stats feed cast speed' % len(speed))
    print('  %d code-defined damage stats, %d flat elemental adds'
          % (len(code), len(flat)))
    print('  %d distinct conditions, by kind:' % len(cond_out))
    for k, n in sers.most_common():
        print('     %-28s %d' % (k, n))


if __name__ == '__main__':
    main()
