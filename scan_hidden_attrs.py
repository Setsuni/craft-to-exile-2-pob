#!/usr/bin/env python3
"""
CTE2 PoB - inventory of items with custom attribute modifiers.

Some gear carries attributes beyond the ones its material implies - Botania's
Terrasteel armour adds KNOCKBACK_RESISTANCE = defense/20, for instance. Those
are invisible in-game and split into two classes that matter very differently:

  * attributes listed in mmorpg_stat_compat convert into Mine & Slash stats
  * everything else works as plain vanilla and never reaches your MnS sheet

This scans every mod jar for classes that override getAttributeModifiers
(srg m_7167_) or build an attribute Multimap, and reports which attributes each
one touches. It is a best-effort inventory, not a complete one: mods add
attributes through materials, Curios and item components too, and those are
invisible here. The in-game KubeJS dump is the authoritative source; this tells
you where to look and works without launching the game.
"""
import argparse, json, os, re, struct, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import javap

# net.minecraft.world.entity.ai.attributes.Attributes, 1.20.1 srg names.
ATTRS = {
    'f_22276_': 'generic.max_health',
    'f_22277_': 'generic.follow_range',
    'f_22278_': 'generic.knockback_resistance',
    'f_22279_': 'generic.movement_speed',
    'f_22280_': 'generic.flying_speed',
    'f_22281_': 'generic.attack_damage',
    'f_22282_': 'generic.attack_knockback',
    'f_22283_': 'generic.attack_speed',
    'f_22284_': 'generic.armor',
    'f_22285_': 'generic.armor_toughness',
    'f_22286_': 'generic.luck',
}
# Vanilla attributes Mine & Slash converts (from mmorpg_stat_compat).
CONVERTS = {
    'generic.attack_damage': 'total_damage x0.5',
    'generic.armor': 'gear_defense x0.1%',
    'generic.armor_toughness': 'gear_defense x0.1%',
    'generic.max_health': 'magic_shield x0.5%',
    'generic.luck': 'magic_find x3.0',
}

# Item.getAttributeModifiers(EquipmentSlot). Mobs build attributes through
# AttributeSupplier instead, so requiring this srg keeps the scan to gear.
MARKERS = (b'm_7167_', b'getAttributeModifiers')
# Must also look like an item, not an entity that merely mentions the method.
ITEM_MARKERS = (b'net/minecraft/world/item/', b'EquipmentSlot')


def constants_near_attrs(raw):
    """Attribute srg names plus any numeric constants in the same class."""
    hits = set()
    for srg, name in ATTRS.items():
        if srg.encode() in raw:
            hits.add(name)
    if not hits:
        return hits, []
    nums = []
    try:
        r = javap.R(raw)
        if r.u4() != 0xCAFEBABE:
            return hits, []
        r.u2(); r.u2()
        cp = javap.CP(r)
        for e in cp.e.values():
            if e[0] in ('Float', 'Double') and 0 < abs(e[1]) < 1e6:
                nums.append(round(float(e[1]), 4))
    except Exception:
        pass
    return hits, sorted(set(nums))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', default='C:/CTE2')
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    ap.add_argument('--max-jar-mb', type=float, default=120.0)
    args = ap.parse_args()

    mods = os.path.join(args.pack, 'mods')
    results = {}
    scanned_jars = 0
    skipped = []

    for fn in sorted(os.listdir(mods)):
        if not fn.endswith('.jar'):
            continue
        path = os.path.join(mods, fn)
        if os.path.getsize(path) > args.max_jar_mb * 1024 * 1024:
            skipped.append(fn)
            continue
        try:
            z = zipfile.ZipFile(path)
        except Exception:
            skipped.append(fn)
            continue
        scanned_jars += 1
        with z:
            for info in z.infolist():
                if not info.filename.endswith('.class'):
                    continue
                if info.file_size > 400_000:
                    continue
                try:
                    raw = z.read(info)
                except Exception:
                    continue
                if not any(m in raw for m in MARKERS):
                    continue
                if not all(m in raw for m in ITEM_MARKERS):
                    continue
                hits, nums = constants_near_attrs(raw)
                if not hits:
                    continue
                cls = info.filename[:-6].replace('/', '.')
                results.setdefault(fn, []).append({
                    'class': cls,
                    'attributes': sorted(hits),
                    'constants': nums[:8],
                })

    dest = os.path.join(args.out, 'hidden_attributes.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(results, fh, indent=1, sort_keys=True)

    total = sum(len(v) for v in results.values())
    print('scanned {} jars ({} skipped), found {} classes across {} mods\n'.format(
        scanned_jars, len(skipped), total, len(results)))

    # Rank mods by how many classes touch attributes.
    for jar in sorted(results, key=lambda k: -len(results[k])):
        rows = results[jar]
        allattrs = {}
        for r in rows:
            for a in r['attributes']:
                allattrs[a] = allattrs.get(a, 0) + 1
        interesting = {a: n for a, n in allattrs.items() if a not in
                       ('generic.attack_damage', 'generic.attack_speed')}
        if not interesting:
            continue
        print('{:<50} {:>3} classes'.format(jar, len(rows)))
        for a, n in sorted(interesting.items(), key=lambda kv: -kv[1]):
            tag = '-> ' + CONVERTS[a] if a in CONVERTS else '   vanilla-only'
            print('    {:<34} x{:<4} {}'.format(a, n, tag))
    print('\n  -> {}'.format(dest))


if __name__ == '__main__':
    main()
