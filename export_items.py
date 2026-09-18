#!/usr/bin/env python3
"""
CTE2 PoB - item catalog for the gear configurator.

Three levels, matching how the game builds an item:

    gear slot  ->  base gear type  ->  affixes legal on that base

The third level is the one that needs real work. An affix carries a list of
tag requirements, and each is checked against the BASE TYPE's tag list, not
against the slot:

    HAS_ALL       every included tag must be on the base
    INCLUDES_ANY  at least one included tag must be on the base
    excluded      none of these may be on the base

So `plate_helmet` (tags: armor_family, strength, helmet, armor_stat, plate...)
and `cloth_helmet` (armor_family, helmet, magic_shield_stat, intelligence...)
occupy the same slot but draw from measurably different affix pools.

Infusions are the `enchant` affix type, gated on the base's tag exactly like a
prefix - `INCLUDES_ANY [enchantment, boots]` matches any boots base. One per
item, and the save records only `{en, rar}` with no roll percent, so an infusion
lands at full value.

Affix TIERS are real, and they are not a separate list of affixes. Every rolled
affix carries its own GearRarity (AffixData.rar, defaulting to "common"), rolled
by AffixData.randomizeTier(). That rarity's `stat_percents` is the band the roll
percentage must land in:

    common 0-17   uncommon 18-34   rare 35-51
    epic 52-68    legendary 69-85  mythic 86-100

AffixData.getMinMax() returns exactly getRarity().stat_percents, so the tier is
what decides how much of an affix's min-max range you actually get. Verified
against 205 rolled affixes on real items: every one lands inside its own tier's
band, and the tier never naturally exceeds the item's rarity tier (two of 205
sat above it, which is what upgradeRarity() - crafting - is for).

Item level is a separate axis: FLAT stats are multiplied by the stat's scaling
at ITEM level, PERCENT and MORE are not scaled at all. So a +3-15% mana prefix
is decided purely by tier and roll, while a flat armour prefix grows with ilvl.

    python export_items.py --out out214
"""
import argparse, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve as R

# Which base stat marks a base as "armour" / "dodge" / "magic shield" flavoured.
# Read off base_stats rather than tags: the tags carry _half variants and
# duplicated family names, the stats are unambiguous.
DEFENCE_LABEL = {
    'armor': 'armour', 'dodge': 'dodge', 'magic_shield': 'magic shield',
    'health': 'health', 'weapon_damage': 'weapon damage',
    'resource_on_basic_hit': 'resource on hit',
}
AFFIX_KINDS = ('prefix', 'suffix', 'implicit', 'chaos_stat', 'enchant')


def base_label(base):
    """The bracket text: what this base actually gives you."""
    seen = []
    for mod in base.get('base_stats') or []:
        name = DEFENCE_LABEL.get(mod['stat'], mod['stat'].replace('_', ' '))
        if name not in seen:
            seen.append(name)
    return ' / '.join(seen)


def satisfies(affix, tags):
    """Whether an affix can roll on a base with this tag set."""
    for req in (affix.get('requirements') or {}).get('tag_requirements') or []:
        if req.get('type') != 'GearSlot':
            return False
        inc = set(req.get('included') or [])
        exc = set(req.get('excluded') or [])
        if exc & tags:
            return False
        if req.get('req_type') == 'HAS_ALL':
            if not inc <= tags:
                return False
        else:                                   # INCLUDES_ANY
            if not (inc & tags):
                return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214')
    ap.add_argument('--dest', default=None)
    args = ap.parse_args()
    dest = args.dest or os.path.join(args.out, 'item_catalog.json')

    def L(n):
        p = os.path.join(args.out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    bases = L('mmorpg_base_gear_types.json')
    affixes = L('mmorpg_affixes.json')
    slots = L('mmorpg_gear_slot.json')
    rarities = L('mmorpg_gear_rarity.json')
    stats = L('mmorpg_stat.json')
    core = L('core_stats.json')
    balance = L('mmorpg_game_balance.json')['original_balance']

    rules = R.Rules({'balance': balance, 'stats': stats, 'core': core,
                     'affixes': affixes, 'bases': bases, 'perks': {}})

    # Slots, in the order a character sheet reads.
    ORDER = ['helmet', 'chest', 'pants', 'boots', 'necklace', 'ring',
             'sword', 'axe', 'hammer', 'dagger', 'spear', 'scythe',
             'greatsword', 'gauntlet', 'bow', 'crossbow', 'staff', 'trident',
             'shield', 'tome', 'totem', 'elytra', 'head']
    slot_out = {}
    for sid, s in slots.items():
        slot_out[sid] = {'fam': s.get('fam'), 'order': ORDER.index(sid) if sid in ORDER else 99}

    # Bases, with the generated descriptor and their affix pool.
    base_out, pools = {}, {}
    for bid, b in bases.items():
        tags = set((b.get('tags') or {}).get('tags') or [])
        base_out[bid] = {
            'slot': b.get('gear_slot'),
            'label': base_label(b),
            'style': b.get('style'),
            'tags': sorted(tags),
            'base_stats': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                            'type': m.get('type', 'FLAT')} for m in b.get('base_stats') or []],
            'req': (b.get('req') or {}).get('scaling_req') or {},
            'weapon_type': b.get('weapon_type'),
        }
        pool = defaultdict(list)
        for aid, a in affixes.items():
            if a.get('type') not in AFFIX_KINDS:
                continue
            if satisfies(a, tags):
                pool[a['type']].append(aid)
        pools[bid] = {k: sorted(v) for k, v in pool.items()}
    for bid in base_out:
        base_out[bid]['pool'] = pools[bid]

    # Only the affixes that some base can actually roll.
    used = {aid for p in pools.values() for v in p.values() for aid in v}
    affix_out = {}
    for aid in sorted(used):
        a = affixes[aid]
        affix_out[aid] = {
            'type': a['type'],
            'weight': a.get('weight', 0),
            'one_per': bool(a.get('only_one_per_item')),
            'stats': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                       'type': m.get('type', 'FLAT')} for m in a.get('stats') or []],
        }

    # Everything the page needs to turn a range + roll% + item level into a value.
    # ExactStatData.fromStatModifier then Stat.scale: FLAT scales, PERCENT/MORE do not.
    scaling_of = {}
    for aid, a in affix_out.items():
        for m in a['stats']:
            scaling_of.setdefault(m['stat'], rules.scaling_of(m['stat']))
    for bid, b in base_out.items():
        for m in b['base_stats']:
            scaling_of.setdefault(m['stat'], rules.scaling_of(m['stat']))

    scalings = {}
    for name, key in R.SCALING_KEY.items():
        cfg = balance.get(key)
        if cfg:
            scalings[name] = {'base': cfg['base_scaling'],
                              'per_level': cfg['per_level_scaling'],
                              'cap': bool(cfg.get('cap_to_max_lvl'))}

    # Corruption outcomes (mmorpg_chaos_stat). Corrupting rolls one of these
    # tiers by weight; the tier says how many chaos_stat affixes land and
    # whether the item gains a socket. The affixes themselves are tag-gated to
    # the base exactly like prefixes are, so they live in the base's pool.
    chaos = L('mmorpg_chaos_stat.json')
    tiers = {}
    total_w = {}
    for cid, c in chaos.items():
        if not isinstance(c, dict):
            continue
        for r in c.get('for_item_rarities') or []:
            total_w[r] = total_w.get(r, 0) + c.get('weight', 0)
    for cid, c in chaos.items():
        if not isinstance(c, dict):
            continue
        rars = c.get('for_item_rarities') or []
        w = c.get('weight', 0)
        denom = total_w.get(rars[0], 0) if rars else 0
        tiers[cid] = {
            'name': c.get('name'), 'affixes': c.get('affix_number', 0),
            'sockets': c.get('bonus_sockets', 0), 'weight': w,
            'rarities': rars,
            'chance': round(100.0 * w / denom, 2) if denom else None,
        }

    # ---- jewels ----------------------------------------------------------
    # Every `jewel_socket` node on the talent tree grants one socket, and each
    # socket takes a jewel with its own rolled affixes. The pool is gated the
    # same way gear affixes are, but on the JEWEL's style: `any_jewel` rolls on
    # all three, and jewel_str / jewel_dex / jewel_int are style-locked.
    JEWEL_STYLES = ['str', 'dex', 'int']
    jewel_pool = {st: [] for st in JEWEL_STYLES}
    jewel_affixes, jewel_corrupt = {}, {}
    # `crafted_jewel_unique` is a third kind - fire/cold resist lines that come
    # from a unique recipe rather than the normal roll pool. Skipping the type
    # left those affixes out of the catalogue entirely, so an imported jewel
    # carrying one showed a blank row and contributed nothing.
    for aid, a in affixes.items():
        t = a.get('type')
        if t not in ('jewel', 'jewel_corruption', 'crafted_jewel_unique'):
            continue
        entry = {'weight': a.get('weight', 0),
                 'stats': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                            'type': m.get('type', 'FLAT')} for m in a.get('stats') or []]}
        if t == 'jewel_corruption':
            jewel_corrupt[aid] = entry
            continue
        jewel_affixes[aid] = entry
        if t == 'crafted_jewel_unique':
            # No style tags on these, and they are not style-locked in game.
            for st in JEWEL_STYLES:
                jewel_pool[st].append(aid)
            continue
        for st in JEWEL_STYLES:
            tags = {'any_jewel', 'jewel_' + st}
            if satisfies(a, tags):
                jewel_pool[st].append(aid)
    for st in JEWEL_STYLES:
        jewel_pool[st].sort()

    # Affix count per rarity, MEASURED on 14 real jewels - it is not the gear
    # rule (gear rare is 3, a rare jewel carries 2) and the blueprint does not
    # state it plainly, so treat this as a default the user can override.
    jewel_counts = {'common': 1, 'uncommon': 1, 'rare': 2, 'epic': 3,
                    'legendary': 3, 'mythic': 4}
    for a in list(jewel_affixes.values()) + list(jewel_corrupt.values()):
        for m in a['stats']:
            scaling_of.setdefault(m['stat'], rules.scaling_of(m['stat']))

    # ---- uniques ---------------------------------------------------------
    # A unique replaces the whole affix roll: it has a fixed stat list, each
    # with its own min-max, rolled by one percent per stat (GearItemData stores
    # only an array of roll percents). It still sits on a normal base gear type,
    # so it inherits that base's base_stats and its slot.
    uniques = L('mmorpg_unique_gears.json')
    uniq_out = {}
    for uid, u in uniques.items():
        if not isinstance(u, dict) or not u.get('base_gear'):
            continue
        uniq_out[uid] = {
            'base': u['base_gear'],
            'stats': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                       'type': m.get('type', 'FLAT')} for m in u.get('unique_stats') or []],
            'lvl': u.get('min_drop_lvl'),
            'league': u.get('league') or '',
            'item': u.get('force_item_id') or '',
        }

    # Which set, if any, a unique belongs to, and what the set grants.
    sets = L('mmorpg_sets.json')
    set_out = {}
    for sid, sd in sets.items():
        if not isinstance(sd, dict):
            continue
        set_out[sid] = {
            'uniques': sd.get('uniques') or [],
            'bonuses': [{'pieces': b.get('pieces'),
                         'stats': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                                    'type': m.get('type', 'FLAT')} for m in b.get('stats') or []]}
                        for b in sd.get('bonuses') or []],
        }
    for sid, sd in set_out.items():
        for uid in sd['uniques']:
            if uid in uniq_out:
                uniq_out[uid]['set'] = sid

    # ---- equip slots -----------------------------------------------------
    # The rail should read like a character sheet, not like a list of every
    # weapon type. Curios sizes come from the curios slot json in the jar:
    # necklace 1, omen 1, ring 2.
    def bases_tagged(*tags):
        out = []
        for bid, b in base_out.items():
            t = set(b['tags'])
            if t & set(tags):
                out.append(bid)
        return sorted(out)

    weapons = bases_tagged('weapon_family')
    offhands = [b for b in bases_tagged('offhand_family') if b not in weapons]
    equip = [
        {'id': 'weapon', 'name': 'Weapon', 'bases': weapons},
        {'id': 'offhand', 'name': 'Offhand', 'bases': offhands},
        {'id': 'head', 'name': 'Helmet', 'bases': [b for b in base_out if base_out[b]['slot'] == 'helmet']},
        {'id': 'chest', 'name': 'Chest', 'bases': [b for b in base_out if base_out[b]['slot'] == 'chest']},
        {'id': 'legs', 'name': 'Pants', 'bases': [b for b in base_out if base_out[b]['slot'] == 'pants']},
        {'id': 'feet', 'name': 'Boots', 'bases': [b for b in base_out if base_out[b]['slot'] == 'boots']},
        {'id': 'necklace', 'name': 'Necklace', 'bases': ['necklace']},
        {'id': 'ring1', 'name': 'Ring 1', 'bases': ['ring']},
        {'id': 'ring2', 'name': 'Ring 2', 'bases': ['ring']},
        {'id': 'codex', 'name': 'Codex', 'bases': [], 'kind': 'codex'},
    ]
    for e in equip:
        e['bases'] = sorted(b for b in e['bases'] if b in base_out)

    # ---- codexes (the pack's name for Omens) -----------------------------
    # OmenData.getStatPercent:
    #     pct = (sum(satisfied counts) * 10 + specific_slot_reqs * 10) * stat_multi
    # and that percent is the roll into the codex's own mod ranges. The counts
    # required are rolled per item from the rarity's OmenDifficulty block.
    omens = L('mmorpg_omen.json')
    codex = {}
    for oid, o in omens.items():
        if not isinstance(o, dict):
            continue
        codex[oid] = {
            'name': 'Codex of ' + oid.replace('_', ' ').title(),
            'lvl_req': o.get('lvl_req'),
            'mods': [{'stat': m['stat'], 'min': m['min'], 'max': m['max'],
                      'type': m.get('type', 'FLAT')} for m in o.get('mods') or []],
            'affix_types': o.get('affix_types') or [],
        }
    difficulty = {}
    for rid, r in rarities.items():
        om = r.get('omens')
        if om:
            difficulty[rid] = om

    rarity_out = {}
    for rid, r in rarities.items():
        if r.get('is_unique_item') or rid == 'runeword':
            continue
        rarity_out[rid] = {
            'tier': r.get('item_tier'), 'affixes': r.get('min_affixes'),
            'base_floor': (r.get('base_stat_percents') or {}).get('min', 0),
            'roll_band': [(r.get('stat_percents') or {}).get('min', 0),
                          (r.get('stat_percents') or {}).get('max', 100)],
            'min_lvl': r.get('min_lvl', 0),
            'max_gems': r.get('max_gems'), 'max_runes': r.get('max_runes'),
        }

    # Whether a bigger number is better. 38 stats say otherwise - aura costs,
    # damage received - so colouring on sign alone would paint "-20 mana cost"
    # red when it is the good outcome.
    minus_good = sorted(k for k, v in stats.items()
                        if isinstance(v, dict) and v.get('minus_is_good'))

    out = {
        'slots': slot_out, 'bases': base_out, 'affixes': affix_out,
        'minusGood': minus_good,
        'rarities': rarity_out, 'corruption': tiers,
        'equip': equip, 'codex': codex, 'codexDifficulty': difficulty,
        'uniques': uniq_out, 'sets': set_out,
        'jewel': {'styles': JEWEL_STYLES, 'pool': jewel_pool,
                  'affixes': jewel_affixes, 'corrupt': jewel_corrupt,
                  'counts': jewel_counts},
        'scalings': scalings, 'statScaling': scaling_of,
        'maxLevel': balance.get('MAX_LEVEL', 100),
    }
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))

    size = os.path.getsize(dest)
    print('item catalog -> %s  (%.0f KB)' % (dest, size / 1024))
    print('  %d slots, %d bases, %d affixes in pools, %d corruption tiers' %
          (len(slot_out), len(base_out), len(affix_out), len(tiers)))
    print('  %d equip slots, %d codexes, %d uniques, %d sets'
          % (len(equip), len(codex), len(uniq_out), len(set_out)))
    print('  jewels: %d affixes, %d corruptions, pools %s'
          % (len(jewel_affixes), len(jewel_corrupt),
             {k: len(v) for k, v in jewel_pool.items()}))
    wide = sorted(((len(p.get('prefix', [])) + len(p.get('suffix', [])), b)
                   for b, p in pools.items()), reverse=True)
    print('  widest pools: ' + ', '.join('%s %d' % (b, n) for n, b in wide[:4]))
    print('  narrowest:    ' + ', '.join('%s %d' % (b, n) for n, b in wide[-4:]))


if __name__ == '__main__':
    main()
