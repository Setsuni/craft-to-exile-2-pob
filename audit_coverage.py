#!/usr/bin/env python3
"""
CTE2 PoB - which stats does the content use that the damage engine ignores?

Every gap found so far was found reactively: a number looked wrong, and the
cause turned out to be a stat the engine had never heard of (projectile_count,
non_crit_damage, the is_crit_true condition). That is a bad way to find them -
it only surfaces the ones that happen to be large on the character being
looked at.

This walks it the other way round. Collect every stat id that any piece of
content a player can actually equip or allocate refers to, then subtract the
ones the engine models. What is left is the backlog, ordered by how many
different things grant it - because a stat twenty items grant matters more than
one only a single unique carries.

    python audit_coverage.py --out out214
    python audit_coverage.py --damage-only     # only stats on the damage path
"""
import argparse, collections, json, os, re

# Registries a player's build can draw from, and the field each keeps its
# modifier list under. Perks cover both the talent tree and the class grids.
SOURCES = {
    'mmorpg_support_gem.json': 'stats',
    'mmorpg_aura.json': 'stats',
    'mmorpg_perk.json': 'stats',
    'mmorpg_runeword.json': 'stats',
    'mmorpg_affixes.json': 'stats',
    'mmorpg_exile_effect.json': 'stats',
    'mmorpg_unique_gears.json': 'unique_stats',
    'mmorpg_sets.json': None,        # nested per tier, walked generically
    'mmorpg_runes.json': None,       # on_armor_stats / on_weapons_stats / ...
    'mmorpg_gems.json': None,
}


def walk_stats(obj):
    """Every {"stat": ...} modifier anywhere in a registry entry."""
    if isinstance(obj, dict):
        sid = obj.get('stat')
        if isinstance(sid, str):
            yield sid
        for v in obj.values():
            for s in walk_stats(v):
                yield s
    elif isinstance(obj, list):
        for v in obj:
            for s in walk_stats(v):
                yield s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214')
    ap.add_argument('--damage-only', action='store_true',
                    help='only report stats the damage map knows are damage-ish')
    ap.add_argument('--top', type=int, default=40)
    args = ap.parse_args()

    def L(n):
        p = os.path.join(args.out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    # ---- what the content refers to -------------------------------------
    used = collections.Counter()
    where = collections.defaultdict(set)
    for fname in SOURCES:
        data = L(fname)
        if not isinstance(data, dict):
            continue
        for key, entry in data.items():
            for sid in set(walk_stats(entry)):
                used[sid] += 1
                where[sid].add(fname.replace('mmorpg_', '').replace('.json', ''))

    # ---- what the engine models -----------------------------------------
    dmg = L('damage_map.json')
    modelled = set()
    for section in ('stats', 'speed', 'code', 'flatAdds'):
        modelled |= set((dmg.get(section) or {}).keys())
    # Stats the sheet resolves even though they never touch a damage layer:
    # core attributes, resources, resists, and anything with a base profile.
    core = L('core_stats.json')
    modelled |= set(core.keys() if isinstance(core, dict) else [])
    for row in (L('mmorpg_base_stats.json') or {}).values():
        for sid in walk_stats(row):
            modelled.add(sid)
    stat_reg = L('mmorpg_stat.json')
    # A stat with no effect block cannot change a damage number, so treat it as
    # accounted for - it is a display or resource stat, not a missing rule.
    inert = {k for k, v in stat_reg.items()
             if isinstance(v, dict) and not v.get('effect')}

    missing = {}
    for sid, n in used.items():
        if sid in modelled:
            continue
        if sid.startswith('learn_'):      # grants a skill, not a number
            continue
        if args.damage_only and sid in inert:
            continue
        missing[sid] = n

    print('stats referenced by content : %d' % len(used))
    print('modelled by the engine      : %d' % len(set(used) & set(modelled)))
    print('NOT modelled                : %d' % len(missing))

    # A stat carrying an effect block is a real rule the engine is skipping;
    # one without is almost certainly inert. Separate them, because the first
    # group is the actual backlog.
    active = {s: n for s, n in missing.items() if s not in inert}
    passive = {s: n for s, n in missing.items() if s in inert}
    print('  of those, with an effect block (real rules) : %d' % len(active))
    print('  of those, inert / display only              : %d' % len(passive))

    # The sheet totals any stat handed to it, so "absent from damage_map" does
    # not mean broken - fire_resist resolves fine. What matters is whether the
    # stat's effect fires on a damage event, because those are the ones that
    # change a hit and are being silently dropped.
    def effect_info(sid):
        v = stat_reg.get(sid)
        orders, events = set(), set()
        if isinstance(v, dict):
            for eff in v.get('effect') or []:
                if eff.get('order'):
                    orders.add(eff['order'])
                for ev in eff.get('events') or []:
                    events.add(ev)
        return orders, events

    DAMAGE_EVENTS = {'on_damage', 'on_spell_stat_calc', 'on_hit'}
    on_dmg, elsewhere = {}, {}
    for sid, n in active.items():
        orders, events = effect_info(sid)
        (on_dmg if (events & DAMAGE_EVENTS) else elsewhere)[sid] = (n, orders, events)

    print('')
    print('=== A. unmodelled AND on the damage path - these change hits ===')
    print('%-32s %6s  %-20s %s' % ('stat', 'grants', 'order', 'events'))
    for sid, (n, o, e) in sorted(on_dmg.items(), key=lambda kv: -kv[1][0])[:args.top]:
        print('%-32s %6d  %-20s %s'
              % (sid, n, ','.join(sorted(o))[:20], ','.join(sorted(e))))
    print('   %d stats total on the damage path' % len(on_dmg))

    print('')
    print('=== B. unmodelled, off the damage path - defence, utility, loot ===')
    top_else = sorted(elsewhere.items(), key=lambda kv: -kv[1][0])[:12]
    print('   %d stats. top: %s' % (len(elsewhere), ', '.join(k for k, _ in top_else)))

    # Conditions are the other half: a stat can be modelled and still be applied
    # at the wrong time because its gate is unhandled.
    print('\n--- conditions used by modelled stats ---')
    conds = collections.Counter()
    for sid, d in (dmg.get('stats') or {}).items():
        for c in d.get('ifs') or []:
            conds[c] += 1
    for sid, d in (dmg.get('speed') or {}).items():
        for c in d.get('ifs') or []:
            conds[c] += 1
    known_ser = {
        'spell_has_tag', 'is_spell', 'ele_match_stat', 'is_elemental_damage',
        'string_matches', 'wep_type_match', 'is_day', 'is_in_combat',
        'is_dual_wielding', 'is_target_cursed', 'is_undead', 'is_target_low',
        'is_hp_under', 'is_hp_above', 'is_bool_true',
    }
    cond_defs = dmg.get('conditions') or {}
    for cid, n in conds.most_common():
        ser = (cond_defs.get(cid) or {}).get('ser')
        mark = '   ' if ser in known_ser else '!! '
        if mark == '!! ' or args.top > 900:
            print('%s%-44s %4d gates   ser=%s' % (mark, cid, n, ser))


if __name__ == '__main__':
    main()
