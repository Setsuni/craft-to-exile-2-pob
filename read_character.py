#!/usr/bin/env python3
"""
CTE2 PoB - Step 1d: read a character out of a single-player save.

Mine & Slash keeps its player state in Forge capabilities on the player's own
.dat, and most fields are JSON strings inside NBT (the mod serializes with Gson).

Two capabilities matter:
  mmorpg:player_data  - what the player CHOSE (talents, ascendancy, stat points)
  mmorpg:entity_data  - what the game COMPUTED (the final stat sheet)

That pairing is the whole point: the chosen side is the engine's input, the
computed side is the expected output. Any calculator we write has to reproduce
the second from the first.
"""
import argparse, json, os, sys

import nbt


def jload(v):
    """Many capability fields are JSON text stored as an NBT string."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (ValueError, TypeError):
            return v
    return v


ARMOR_SLOTS = {100: 'feet', 101: 'legs', 102: 'chest', 103: 'head'}

# The save names a tree one way and talent_graphs.json another: the save says
# ATLAS, the graph is called atlas_passives. This used to be
# `graphs.get(name) or graphs.get('talents')`, which silently resolved atlas
# coordinates against the TALENT tree - 15 of 104 landed on a talent node by
# coincidence and were reported as real allocations. Never guess a tree.
GRAPH_OF = {
    'TALENTS': 'talents',
    'ASCENDANCY': 'ascendancy',
    'ATLAS': 'atlas_passives',
}


def _walk_items(o):
    """Yield every item-shaped compound in an arbitrary NBT tree (for curios)."""
    if isinstance(o, dict):
        if isinstance(o.get('id'), str) and isinstance(o.get('tag'), dict):
            yield o
        for v in o.values():
            yield from _walk_items(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk_items(v)


def custom_data(item):
    """CustomItemData's key/value map: `mmorpg_custom_data` -> data -> map.

    Every key in it is short - `uq` for the unique id, `ql` for quality, `cr`
    for corrupted - so reading it by the Java constant's name finds nothing and
    fails silently as a zero.
    """
    raw = (item.get('tag') or {}).get('mmorpg_custom_data')
    cd = jload(raw) if raw else None
    if not isinstance(cd, dict):
        return {}
    return ((cd.get('data') or {}).get('map') or {}) or {}


def unique_id(item):
    """The unique's guid, which does NOT live in mmorpg_gear.

    UniqueStatsData.getUnique() reads CustomItemData's UNIQUE_ID key, stored on
    the stack as `mmorpg_custom_data` -> data.map.uq. Identifying a unique any
    other way does not work: `uniqueStats.perc` is a fixed 10-slot roll buffer
    on every item, while real uniques carry 1-9 stats, so matching on array
    length (as this used to) can never succeed for anything.
    """
    return custom_data(item).get('uq') or None


def collect_gear(root):
    """Equipped Mine & Slash gear only: worn armor, held weapon, offhand, curios.

    Items sitting in the backpack carry mmorpg_gear too, so filtering by slot
    matters - counting them would inflate every stat.
    """
    caps = root.get('ForgeCaps', {})
    held = root.get('SelectedItemSlot', 0)
    out = []

    def take(stack, where):
        tag = stack.get('tag') or {}
        raw = tag.get('mmorpg_gear')
        if not raw:
            return
        g = jload(raw)
        if not isinstance(g, dict):
            return
        g['_slot'] = where
        g['_item'] = stack.get('id')
        # CustomItemData.KEYS.QUALITY is the SHORT key `ql`, and it sits under
        # data.map beside `uq` - exactly where unique_id() looks. This read the
        # top level for a key named QUALITY, which never exists, so every item
        # came back at quality 0 and the base stats were undercounted.
        # The map stores its values as strings, so coerce rather than
        # hand the resolver something it will try to add to an int.
        try:
            g['_quality'] = int(custom_data(stack).get('ql') or 0)
        except (TypeError, ValueError):
            g['_quality'] = 0
        g['_uniq'] = unique_id(stack)
        # Vanilla enchantments convert into MnS stats via mmorpg_stat_compat -
        # Fire Protection is fire resist, Sharpness is physical damage, Piercing
        # is armour penetration - so they are part of the sheet, not flavour.
        g['_ench'] = [{'id': e.get('id'), 'lvl': e.get('lvl', 0)}
                      for e in (tag.get('Enchantments') or [])
                      if isinstance(e, dict) and e.get('id')]
        out.append(g)

    for stack in root.get('Inventory', []):
        s = stack.get('Slot')
        if s in ARMOR_SLOTS:
            take(stack, ARMOR_SLOTS[s])
        elif s == -106:
            take(stack, 'offhand')
        elif s == held:
            take(stack, 'weapon')

    for stack in _walk_items(caps.get('curios:inventory', {})):
        take(stack, 'curio')

    # The curios capability calls every slot "curio", so a necklace, an elytra
    # and two rings all arrive under one name. Anything keyed by slot then keeps
    # only the last of them - which lost three items off the planner and pooled
    # four items' stats under one heading. Number the duplicates.
    seen = {}
    for g in out:
        sl = g['_slot']
        seen[sl] = seen.get(sl, 0) + 1
        if seen[sl] > 1:
            g['_slot'] = '%s%d' % (sl, seen[sl])

    return out


def read_omens(root):
    """The Codex, which is not gear.

    A codex is an OMEN: it sits in a curio slot but carries `mmorpg_omen`
    rather than `mmorpg_gear`, so the gear reader skipped it entirely and the
    planner showed an empty Codex slot on a character wearing one.

    Its stats are conditional. `rarities` is a requirement map - RUNED 1,
    UNIQUE 1, NORMAL 1 means "one runeword, one unique and one normal item
    equipped" - and the number of requirements MET is the tier the tooltip
    calls "2 Piece" / "3 Piece". The registry's `mods` are the full-tier
    bonus; the `aff` list is the lesser one.
    """
    caps = root.get('ForgeCaps', {})
    out = []
    for stack in _walk_items(caps.get('curios:inventory', {})):
        tag = stack.get('tag') or {}
        raw = tag.get('mmorpg_omen')
        if not raw:
            continue
        o = jload(raw)
        if not isinstance(o, dict):
            continue
        o['_item'] = stack.get('id')
        out.append(o)
    return out


def read(path):
    root = nbt.load(path)
    caps = root.get('ForgeCaps', {})
    pd = {k: jload(v) for k, v in caps.get('mmorpg:player_data', {}).items()}
    ed = {k: jload(v) for k, v in caps.get('mmorpg:entity_data', {}).items()}
    gear = collect_gear(root)

    # Player-data sources beyond gear: active buffs carry literal stats, jewels
    # carry rolled affixes like gear, and skill gems are aura/support entries.
    def _skillgems(lst):
        out = []
        for e in lst or []:
            raw = ((e.get('tag') or {}).get('mmorpg_skill_gem'))
            g = jload(raw) if raw else None
            if isinstance(g, dict):
                g['_item'] = e.get('id')
                # The inventory SLOT is the only thing that says which skill a
                # support gem is linked to - the gem itself names no spell.
                g['_slot'] = e.get('Slot')
                out.append(g)
        return out

    def _jewels(lst):
        out = []
        for e in lst or []:
            raw = ((e.get('tag') or {}).get('mmorpg_jewel'))
            j = jload(raw) if raw else None
            if isinstance(j, dict):
                j['_item'] = e.get('id')
                out.append(j)
        return out
    # StatCompat.getResult reads LivingEntity.getAttributeValue(), i.e. the
    # ENTITY's total for a vanilla attribute - not a per-item modifier. Item
    # modifiers are applied at runtime and are not in this NBT, so what we can
    # read here is the player's own base value, which is exactly right for
    # generic.max_health (20) and understates gear-derived ones like armor.
    entity_attrs = {}
    vanilla_hp = 20.0
    for a in root.get('Attributes', []) or []:
        nm = a.get('Name')
        if nm:
            entity_attrs[nm] = a.get('Base', 0.0)
        if nm == 'minecraft:generic.max_health':
            vanilla_hp = a.get('Base', 20.0)

    runtime_attrs = {k: float(v) for k, v in (root.get('PobRuntimeAttributes') or {}).items()
                     if isinstance(v, (int, float))}
    vanilla_hp = runtime_attrs.get('minecraft:generic.max_health', vanilla_hp)
    unit = ed.get('mmorpg_unit', {})
    stats = {}
    for slot in unit.values():
        if isinstance(slot, dict) and 'i' in slot:
            stats[slot['i']] = {'v': slot.get('v'), 'm': slot.get('m')}

    tals = pd.get('tals', {}) or {}
    allocated = {}
    for school, payload in (tals.get('perks') or {}).items():
        pts = (payload or {}).get('list') or []
        allocated[school] = [(p['x'], p['y']) for p in pts if 'x' in p and 'y' in p]

    return {
        'level': ed.get('level'),
        'exp': ed.get('exp'),
        'hp': ed.get('hp'),
        'rarity': ed.get('rarity'),
        'resources': ed.get('res_loc'),
        'area_lvl': (pd.get('minfo') or {}).get('area_lvl'),
        'stat_points': (pd.get('stats') or {}).get('map', {}),
        'ascendancy': pd.get('asc'),
        'casting': pd.get('casting'),
        'allocated': allocated,
        'gear': gear,
        'omens': read_omens(root),
        'buffs': ((pd.get('buffs') or {}).get('map') or {}),
        'jewels': _jewels(pd.get('jewels')),
        'auras': _skillgems(pd.get('auras')),
        'support_gems': _skillgems(pd.get('gems')),
        'vanilla_max_health': vanilla_hp,
        'entity_attrs': entity_attrs,
        'runtime_attrs': runtime_attrs,
        'computed_stats': stats,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('save', help='path to playerdata/<uuid>.dat')
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    args = ap.parse_args()

    ch = read(args.save)
    graphs = json.load(open(os.path.join(args.out, 'talent_graphs.json'), encoding='utf-8'))
    perks = json.load(open(os.path.join(args.out, 'mmorpg_perk.json'), encoding='utf-8'))

    print('CHARACTER  level {}  exp {}  hp {}  rarity {}  area_lvl {}'.format(
        ch['level'], ch['exp'], ch['hp'], ch['rarity'], ch['area_lvl']))
    print('  manual stat points : {}'.format(ch['stat_points']))
    asc = ch['ascendancy'] or {}
    print('  school order       : {}'.format(asc.get('school_order')))
    print('  ascendancy levels  : {}'.format(asc.get('allocated_lvls')))
    print('  computed stats     : {}'.format(len(ch['computed_stats'])))
    print('  equipped gear      : {}'.format(len(ch['gear'])))
    for g in ch['gear']:
        pre = [a['id'] for a in (g.get('affixes') or {}).get('pre', [])]
        suf = [a['id'] for a in (g.get('affixes') or {}).get('suf', [])]
        print('     {:<8} {:<34} {:<9} ilvl {:<3} imp={:<14} pre={} suf={}'.format(
            g['_slot'], g['_item'], g.get('rar'), g.get('lvl'),
            (g.get('imp') or {}).get('imp') or '-', pre, suf))

    # Cross-check the allocated talents against the parsed graph.
    for school, coords in ch['allocated'].items():
        g = graphs.get(GRAPH_OF.get(school, school.lower()))
        if g is None:
            print('\nALLOCATED [%s] %d points - NO GRAPH for this tree' %
                  (school, len(coords)))
            continue
        pos = {(n['x'], n['y']): n for n in g['nodes']}
        adj = {}
        for e in g['edges']:
            adj.setdefault(tuple(e['a']), set()).add(tuple(e['b']))
            adj.setdefault(tuple(e['b']), set()).add(tuple(e['a']))

        hit = [c for c in coords if c in pos]
        miss = [c for c in coords if c not in pos]
        print('\nALLOCATED [{}] {} points'.format(school, len(coords)))
        print('  resolve to graph nodes : {}/{}'.format(len(hit), len(coords)))
        if miss:
            print('  UNRESOLVED: {}'.format(miss[:10]))

        # Is the allocation a connected blob touching a class start?
        chosen = set(hit)
        starts = {c for c in chosen if pos[c].get('is_start')}
        seen, frontier = set(starts), list(starts)
        while frontier:
            cur = frontier.pop()
            for nb in adj.get(cur, ()):
                if nb in chosen and nb not in seen:
                    seen.add(nb)
                    frontier.append(nb)
        print('  start nodes taken      : {}'.format(
            sorted(pos[c]['perk'] for c in starts) or 'none'))
        print('  connected to a start   : {}/{}'.format(len(seen), len(chosen)))

        counts = {}
        for c in hit:
            counts[pos[c]['perk']] = counts.get(pos[c]['perk'], 0) + 1
        print('  perks taken:')
        for pid, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
            ptype = perks.get(pid, {}).get('type')
            print('     {:<34} x{:<3} {}'.format(pid, n, ptype))

    dest = os.path.join(args.out, 'character.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(ch, fh, indent=1)
    print('\n  -> {}'.format(dest))


if __name__ == '__main__':
    main()
