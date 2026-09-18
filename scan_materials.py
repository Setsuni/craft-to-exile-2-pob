#!/usr/bin/env python3
"""
CTE2 PoB - full inventory of armour materials and weapon tiers.

The item-override scan only catches mods that hand-roll getAttributeModifiers.
Most gear gets its attributes from an ArmorMaterial or a Tier instead, which is
where toughness and knockback resistance actually live - so that is where the
"hidden side effects" really are.

ArmorMaterial (1.20.1 srg):
  m_266425_ durabilityForType   m_7366_ defenseForType   m_6646_ enchantmentValue
  m_6082_   name                m_6651_ toughness        m_6649_ knockbackResistance
Tier:
  m_6609_ uses   m_6624_ speed   m_6631_ attackDamageBonus
  m_6604_ level  m_6601_ enchantmentValue

What matters for Mine & Slash: armour and toughness convert into gear_defense,
knockback resistance does not convert at all.
"""
import argparse, json, os, struct, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import javap

ARMOR_METHODS = {
    'm_266425_': 'durability', 'm_7366_': 'defense', 'm_6646_': 'enchantability',
    'm_6082_': 'name', 'm_6651_': 'toughness', 'm_6649_': 'knockback_resistance',
}
TIER_METHODS = {
    'm_6609_': 'uses', 'm_6624_': 'mining_speed', 'm_6631_': 'attack_damage_bonus',
    'm_6604_': 'mining_level', 'm_6601_': 'enchantability',
}
PUSH = {0x02: -1, 0x03: 0, 0x04: 1, 0x05: 2, 0x06: 3, 0x07: 4, 0x08: 5,
        0x0b: 0.0, 0x0c: 1.0, 0x0d: 2.0, 0x0e: 0.0, 0x0f: 1.0}


def parse(raw):
    r = javap.R(raw)
    if r.u4() != 0xCAFEBABE:
        return None
    r.u2(); r.u2()
    cp = javap.CP(r)
    r.u2(); this_i = r.u2(); r.u2()
    for _ in range(r.u2()):
        r.u2()

    def attrs():
        out = []
        for _ in range(r.u2()):
            nm = cp.utf(r.u2())
            out.append((nm, r.take(r.u4())))
        return out

    for _ in range(r.u2()):
        r.u2(); r.u2(); r.u2(); attrs()
    methods = {}
    for _ in range(r.u2()):
        r.u2(); nm = cp.utf(r.u2()); r.u2()
        for an, ab in attrs():
            if an == 'Code':
                cr = javap.R(ab)
                cr.u2(); cr.u2()
                methods[nm] = cr.take(cr.u4())
    return cp, cp.cls(this_i), methods


def values(code, cp):
    """Numbers and strings a method body pushes, in order."""
    nums, strs = [], []
    i = 0
    while i < len(code):
        op = code[i]; i += 1
        n = javap.OPLEN.get(op, 0)
        operand = code[i:i + n]; i += n
        if op in PUSH:
            nums.append(PUSH[op])
        elif op == 0x10 and operand:
            nums.append(struct.unpack('>b', operand)[0])
        elif op == 0x11 and operand:
            nums.append(struct.unpack('>h', operand)[0])
        elif op in (0x12, 0x13, 0x14):
            idx = operand[0] if op == 0x12 else struct.unpack('>H', operand)[0]
            e = cp.e.get(idx)
            if not e:
                continue
            if e[0] in ('Float', 'Double', 'Int', 'Long'):
                nums.append(round(float(e[1]), 4))
            elif e[0] == 'String':
                strs.append(cp.utf(e[1]))
    return nums, strs


def int_array(code, cp):
    """Decode `new int[]{a,b,c,d}` by simulating the push/iastore sequence."""
    stack, arr = [], {}
    i = 0
    while i < len(code):
        op = code[i]; i += 1
        n = javap.OPLEN.get(op, 0)
        operand = code[i:i + n]; i += n
        if op in PUSH:
            stack.append(PUSH[op])
        elif op == 0x10 and operand:
            stack.append(struct.unpack('>b', operand)[0])
        elif op == 0x11 and operand:
            stack.append(struct.unpack('>h', operand)[0])
        elif op in (0x12, 0x13, 0x14):
            idx = operand[0] if op == 0x12 else struct.unpack('>H', operand)[0]
            e = cp.e.get(idx)
            if e and e[0] in ('Float', 'Double', 'Int', 'Long'):
                stack.append(round(float(e[1]), 4))
        elif op == 0x4f:                      # iastore: ..., index, value
            if len(stack) >= 2:
                val = stack.pop()
                key = stack.pop()
                arr[int(key)] = val
        elif op == 0xbc:                      # newarray - size already consumed
            if stack:
                stack.pop()
        elif op == 0x59:                      # dup
            pass
        else:
            stack = []
    return [arr[k] for k in sorted(arr)] if arr else []


def one(nums, default=None):
    return nums[0] if nums else default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', default='C:/CTE2')
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    args = ap.parse_args()

    armors, tiers = [], []
    for fn in sorted(os.listdir(os.path.join(args.pack, 'mods'))):
        if not fn.endswith('.jar'):
            continue
        path = os.path.join(args.pack, 'mods', fn)
        try:
            z = zipfile.ZipFile(path)
        except Exception:
            continue
        with z:
            for info in z.infolist():
                if not info.filename.endswith('.class') or info.file_size > 300_000:
                    continue
                try:
                    raw = z.read(info)
                except Exception:
                    continue
                is_armor = b'm_6651_' in raw and b'm_6649_' in raw
                is_tier = b'm_6631_' in raw and b'm_6604_' in raw
                if not (is_armor or is_tier):
                    continue
                try:
                    parsed = parse(raw)
                except Exception:
                    continue
                if not parsed:
                    continue
                cp, cls, methods = parsed
                cname = info.filename[:-6].replace('/', '.')

                if is_armor:
                    rec = {'mod': fn, 'class': cname}
                    for srg, label in ARMOR_METHODS.items():
                        if srg not in methods:
                            continue
                        nums, strs = values(methods[srg], cp)
                        if label == 'name':
                            rec['name'] = strs[0] if strs else None
                        elif label == 'defense':
                            rec['defense'] = int_array(methods[srg], cp)
                        elif label == 'durability':
                            rec['durability'] = int_array(methods[srg], cp)
                        else:
                            rec[label] = one(nums)
                    if rec.get('toughness') is not None or rec.get('knockback_resistance') is not None:
                        armors.append(rec)

                if is_tier:
                    rec = {'mod': fn, 'class': cname}
                    for srg, label in TIER_METHODS.items():
                        if srg in methods:
                            nums, _ = values(methods[srg], cp)
                            rec[label] = one(nums)
                    tiers.append(rec)

    out = {'armor_materials': armors, 'weapon_tiers': tiers}
    dest = os.path.join(args.out, 'materials.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1)
    print('armour materials: {}   weapon tiers: {}'.format(len(armors), len(tiers)))
    print('  -> {}'.format(dest))


if __name__ == '__main__':
    main()
