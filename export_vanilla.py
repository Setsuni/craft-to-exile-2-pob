#!/usr/bin/env python3
"""
CTE2 PoB - vanilla and modded gear, and the stats it quietly grants.

Mine & Slash does not ignore a Botania chestplate. `mmorpg_stat_compat` converts
vanilla item ATTRIBUTES into MnS stats, which is why people craft on top of
Terrasteel: the knockback resistance and armour toughness on those pieces turn
into real sheet stats that no MnS affix line mentions.

Attributes live in each mod's Java, not in any datapack, so they come from the
in-game KubeJS dump (`kubejs/item_attributes.json`). This joins that dump to the
conversion rules and keeps only the items that actually convert into something.

One thing worth being precise about: StatCompat reads
LivingEntity.getAttributeValue(attr) - the ENTITY total across everything worn -
then converts once. Converting per item and adding up is NOT the same, because
the integer truncation and the caps would apply repeatedly. So this file ships
each item's raw attribute contribution and the rules, and the page sums first.

    python export_vanilla.py --out out214
"""
import argparse, json, os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214')
    ap.add_argument('--dest', default=None)
    args = ap.parse_args()
    dest = args.dest or os.path.join(args.out, 'vanilla_gear.json')

    def L(n):
        p = os.path.join(args.out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    attrs = L('item_attributes.json')
    compat = L('mmorpg_stat_compat.json')

    rules, by_attr = {}, {}
    for cid, c in compat.items():
        if not isinstance(c, dict) or not c.get('attribute_id'):
            continue
        rules[cid] = {
            'attr': c['attribute_id'], 'stat': c['mns_stat_id'],
            'mod': c.get('mod_type', 'FLAT'), 'conv': c['conversion'],
            'min_cap': c.get('minimum_cap'), 'max_cap': c.get('maximum_cap'),
            'per_min': c.get('per_item_min'), 'per_max': c.get('per_item_max'),
            'scaling': c.get('scaling') or 'NONE',
        }
        by_attr.setdefault(c['attribute_id'], []).append(cid)

    # Keep every attribute, not just the convertible ones. Terrasteel's
    # knockback resistance has NO conversion rule - it stays a pure vanilla
    # effect and never reaches the MnS sheet. Hiding it would answer the
    # question "what does this piece secretly do" wrongly.
    items, mods, unconverted = {}, {}, set()
    for iid, slots in attrs.items():
        keep, useful = {}, False
        for slot, mp in (slots or {}).items():
            got = {}
            for a, v in mp.items():
                if str(v.get('op', 'ADDITION')).upper() not in ('ADDITION', '0'):
                    continue
                got[a] = round(float(v['amount']), 4)
                if a in by_attr:
                    useful = True
                else:
                    unconverted.add(a)
            if got:
                keep[slot] = got
        if keep and useful:
            items[iid] = keep
            mods[iid.split(':', 1)[0]] = mods.get(iid.split(':', 1)[0], 0) + 1

    out = {'items': items, 'rules': rules, 'byAttr': by_attr,
           'unconverted': sorted(unconverted)}
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))

    print('vanilla gear -> %s  (%.0f KB)' % (dest, os.path.getsize(dest) / 1024))
    print('  %d items convert into MnS stats, from %d mods' % (len(items), len(mods)))
    print('  %d conversion rules over %d attributes' % (len(rules), len(by_attr)))
    top = sorted(mods.items(), key=lambda kv: -kv[1])[:6]
    print('  most: ' + ', '.join('%s %d' % (m, n) for m, n in top))
    print('  attributes with NO conversion rule (vanilla-only effects): %s'
          % ', '.join(a.split('.')[-1] for a in sorted(unconverted)))


if __name__ == '__main__':
    main()
