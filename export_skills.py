#!/usr/bin/env python3
"""
CTE2 PoB - skills, support gems and augments.

Three registries feed the Skills tab:

    mmorpg_spells        what you can slot on the eight-key hotbar
    mmorpg_support_gem   what you link to a slotted spell
    mmorpg_aura          what the pack calls AUGMENTS in its lang file

Augment capacity, worked out from a real build rather than assumed: the
`spirit_cost` stat is `spirit/AuraCapacity` in the bytecode, with constants
0 / 100 / 250 - a base of 100 and a hard cap of 250. Each aura carries a
`reservation` (0.25 to 0.4), and a character with three 0.4 auras equipped
showed spirit_cost 123. 3 x 0.4 x 100 = 120 reserved out of 123 available,
which is exactly where an optimised build sits. So:

    capacity = spirit_cost stat        reserved = sum(reservation) * 100

One sample, so the page labels it as inferred. The damage side of skills is
still open (see NOTES 8d) - this ships the loadout, not the DPS.

    python export_skills.py --out out214
"""
import argparse, json, os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214')
    ap.add_argument('--dest', default=None)
    args = ap.parse_args()
    dest = args.dest or os.path.join(args.out, 'skills.json')

    def L(n):
        p = os.path.join(args.out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    spells = L('mmorpg_spells.json')
    supports = L('mmorpg_support_gem.json')
    auras = L('mmorpg_aura.json')
    calcs = L('mmorpg_value_calc.json')

    sp = {}
    for sid, v in spells.items():
        if not isinstance(v, dict):
            continue
        cfg = v.get('config') or {}
        tags = (cfg.get('tags') or {}).get('tags') or []
        # The pack keeps 116 `*_deprecated` spells and 50 deprecated uniques in
        # its registries for old saves. They are not obtainable, so offering
        # them in a picker is noise at best and a trap at worst.
        if sid.endswith('_deprecated'):
            continue
        sp[sid] = {
            'max_lvl': v.get('max_lvl'), 'min_lvl': v.get('min_lvl'),
            'style': cfg.get('style'), 'weapon': cfg.get('castingWeapon'),
            'tags': tags,
            'mana': cfg.get('mana_cost'), 'energy': cfg.get('ene_cost'),
            'cooldown': cfg.get('cooldown_ticks'),
            # A triggered skill runs on its OWN internal lockout, which is a
            # different number from the cast cooldown - Fan of Knives has no
            # cast cooldown at all but cannot proc more than twice a second.
            # 422 spells disagree between the two, so they cannot be conflated.
            'procCooldown': cfg.get('proc_cooldown_ticks') or 0,
            # SPELL_DAMAGE_EFFECTIVENESS_MULTI: how much of a flat-damage stat
            # this skill actually gets. A LeveledValue over the spell's rank,
            # so the same archmage stat is worth more on a higher-ranked skill.
            'dmgEffectiveness': ((calcs.get(sid) or {})
                                 .get('dmg_effectiveness') or {}).get('multi'),
            # The rate model: SpellStatsCalculationEvent divides cast_speed_ticks
            # by (1 + castSpeedPct/100) and floors it at GLOBAL_COOLDOWN_TICKS.
            # times_to_cast is how many hits one cast actually lands.
            'castTicks': cfg.get('cast_speed_ticks'),
            'castTime': cfg.get('cast_time_ticks'),
            'times': cfg.get('times_to_cast') or 1,
            'channel': bool(cfg.get('channel_skill')),
            'charges': cfg.get('charges') or 0,
            'damage': sid in calcs,
            # A spell with no damage tag is a buff, aura or utility cast.
            'kind': 'damage' if 'damage' in tags else (
                'summon' if 'summon' in tags else 'utility'),
        }

    su = {}
    for gid, v in supports.items():
        if not isinstance(v, dict):
            continue
        su[gid] = {
            'style': v.get('style'), 'min_lvl': v.get('min_lvl'),
            'manaMulti': v.get('manaMulti'),
            'one_of_a_kind': v.get('one_of_a_kind') or '',
            'stats': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                       'type': m.get('type', 'FLAT')} for m in v.get('stats') or []],
        }

    au = {}
    for aid, v in auras.items():
        if not isinstance(v, dict):
            continue
        au[aid] = {
            'style': v.get('style'), 'min_lvl': v.get('min_lvl'),
            'reservation': v.get('reservation'),
            'stats': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                       'type': m.get('type', 'FLAT')} for m in v.get('stats') or []],
        }

    # Everything needed to recompute base damage at an arbitrary rank, rather
    # than shipping one precomputed number per equipped skill.
    balance = L('mmorpg_game_balance.json')['original_balance']
    calc = {}
    for sid in sp:
        c = calcs.get(sid)
        if not c:
            continue
        calc[sid] = {
            'base': c.get('base') or {},
            'scaling': c.get('base_scaling_type') or 'NONE',
            'cap': c.get('cap_to_wep_dmg'),
            'scalings': [{'stat': x['stat'], 'multi': x.get('multi') or {}}
                         for x in (c.get('stat_scalings') or []) +
                                  (c.get('target_stat_scalings') or [])],
        }

    # MaxSpellLevel is generated per SpellTag, so `plus_lvl_fire_spells` raises
    # any spell tagged fire and `plus_lvl_all_spells` raises everything. The
    # total is capped at MAX_BONUS_SPELL_LEVELS.
    plus_by_tag = {}
    affixes = L('mmorpg_affixes.json')
    seen = set()
    for unique in L('mmorpg_unique_gears.json').values():
        for mod in unique.get('unique_stats') or []:
            if mod['stat'].startswith('plus_lvl_'):
                seen.add(mod['stat'])
    for a in affixes.values():
        for m in a.get('stats') or []:
            if m['stat'].startswith('plus_lvl_'):
                seen.add(m['stat'])
    for stat in sorted(seen):
        mid = stat[len('plus_lvl_'):]
        if mid.endswith('_spells'):
            mid = mid[:-len('_spells')]
        plus_by_tag[mid] = stat

    scal = {}
    for name, key in (('NORMAL', 'NORMAL_STAT_SCALING'), ('SLOW', 'SLOW_STAT_SCALING'),
                      ('CORE', 'CORE_STAT_SCALING'), ('MOB_DAMAGE', 'MOB_DAMAGE_SCALING'),
                      ('STAT_REQ', 'STAT_REQ_SCALING')):
        cfg = balance.get(key)
        if cfg:
            scal[name] = {'base': cfg['base_scaling'],
                          'per_level': cfg['per_level_scaling'],
                          'cap': bool(cfg.get('cap_to_max_lvl'))}

    # Which class can actually pick which skill. A spell school is a perk grid,
    # and the perks that grant a spell carry a `learn_<spell>` stat - so the
    # school's spell list falls out of its own grid. 200 spells across 12
    # schools; the handful outside them (Bolt) are the universal starters every
    # character already knows.
    # A spell school is the class grid. Points invested in one of its perks ARE
    # the skill's rank - a save with `allocated_lvls.double_strike = 3` reads
    # Double Strike at rank 3 - and the passive perks scale their stats by the
    # same count. So the grid is exported whole, not just its spell list.
    schools = {}
    sch = L('mmorpg_spell_school.json')
    perks_all = L('mmorpg_perk.json')
    for scid, scv in sch.items():
        grid = {}
        spells_of = []
        for pid, xy in (scv.get('perks') or {}).items():
            p = perks_all.get(pid) or {}
            learn = None
            for m in p.get('stats') or []:
                if m['stat'].startswith('learn_'):
                    learn = m['stat'][len('learn_'):]
                    break
            if learn:
                spells_of.append(learn)
            grid[pid] = {
                'x': xy.get('x'), 'y': xy.get('y'),
                'max': p.get('max_lvls', 1),
                'type': p.get('type'),
                'learn': learn,
                'icon': p.get('icon'),
                # Passive perks scale linearly with points, exactly as
                # resolve.py applies them: mod.v1 * levels.
                'stats': [{'stat': m['stat'], 'type': m.get('type', 'FLAT'),
                           'v1': m.get('v1', 0.0),
                           'scale': 1 if m.get('scale_to_lvl') else 0}
                          for m in p.get('stats') or []
                          if not m['stat'].startswith('learn_')],
            }
        schools[scid] = {'perks': grid, 'lvl_reqs': scv.get('lvl_reqs') or [],
                         'spells': sorted(set(spells_of))}

    out = {'spells': sp, 'supports': su, 'auras': au, 'schools': schools,
           'capacity': {'base': 100, 'cap': 250, 'perReservation': 100},
           'hotbarSlots': 8,
           'calc': calc, 'plusByTag': plus_by_tag, 'scalings': scal,
           'maxBonusLevels': balance.get('MAX_BONUS_SPELL_LEVELS', 8),
           'linkLevels': [balance.get('link_%d_lvl' % i) for i in range(1, 6)],
           'spellPoints': (balance.get('player_points') or {}).get('SPELLS') or {},
           'globalCooldownTicks': balance.get('GLOBAL_COOLDOWN_TICKS', 2),
           'channelSpeedTransfer': balance.get('CHANNEL_GENERAL_SPEED_TRANSFER', 1.0),
           'minCooldownMulti': balance.get('MIN_SPELL_COOLDOWN_MULTI', 0.2),
           'spellDmgMulti': float(((L('pack_config.json')
               .get('mine_and_slash_compatibility-server.toml') or {})
               .get('settings') or {}).get('SPELL_BASE_DAMAGE_MULTIPLIER', 1.0))}
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))

    print('skills -> %s  (%.0f KB)' % (dest, os.path.getsize(dest) / 1024))
    dmg = sum(1 for v in sp.values() if v['damage'])
    print('  %d spells (%d with a damage formula), %d supports, %d augments'
          % (len(sp), dmg, len(su), len(au)))
    print('  %d schools, %d spells, %d perks total'
          % (len(schools),
             len(set(x for v in schools.values() for x in v['spells'])),
             sum(len(v['perks']) for v in schools.values())))
    print('  %d value calcs, plus-level stats for %d tags, spell multi %s'
          % (len(calc), len(plus_by_tag), out['spellDmgMulti']))


if __name__ == '__main__':
    main()
