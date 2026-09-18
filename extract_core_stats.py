#!/usr/bin/env python3
"""
CTE2 PoB - Step 2b: recover the code-defined stats from Mine & Slash.

About 40% of a character's stats (health, mana, armor, resistances, regen,
weapon_damage...) are not in the datapack at all - they are Java singletons.
This walks the stat class tree and pulls, per class:

  GUID()        -> the stat id used everywhere else
  scaling       -> which StatScaling the constructor assigns (default NONE)
  IsPercent()   -> display/aggregation flag
  min / max     -> clamps assigned in the constructor

Everything is read straight from the bytecode, so it stays correct across
pack updates as long as the jar is re-scanned.
"""
import argparse, json, os, re, struct, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import javap


def parse_class(raw):
    r = javap.R(raw)
    assert r.u4() == 0xCAFEBABE
    r.u2(); r.u2()
    cp = javap.CP(r)
    r.u2()
    this_i = r.u2()
    r.u2()
    for _ in range(r.u2()):
        r.u2()

    def attrs():
        out = []
        for _ in range(r.u2()):
            nm = cp.utf(r.u2())
            out.append((nm, r.take(r.u4())))
        return out

    # Static fields often hold the stat id as a ConstantValue (public static
    # final String GUID = "armor"), with GUID() just returning the field.
    consts = {}
    for _ in range(r.u2()):
        r.u2()
        fname = cp.utf(r.u2())
        r.u2()
        for an, ab in attrs():
            if an == 'ConstantValue' and len(ab) >= 2:
                e = cp.e.get(struct.unpack('>H', ab[:2])[0])
                if e and e[0] == 'String':
                    consts[fname] = cp.utf(e[1])
                elif e and e[0] in ('Int', 'Float', 'Double'):
                    consts[fname] = e[1]

    methods = {}
    for _ in range(r.u2()):
        r.u2()
        nm = cp.utf(r.u2())
        desc = cp.utf(r.u2())
        for an, ab in attrs():
            if an == 'Code':
                cr = javap.R(ab)
                cr.u2(); cr.u2()
                methods.setdefault(nm + desc, []).append(cr.take(cr.u4()))
    return cp, cp.cls(this_i), methods, consts


def ops(code, cp):
    i = 0
    while i < len(code):
        pc = i
        op = code[i]; i += 1
        n = javap.OPLEN.get(op, 0)
        operand = code[i:i + n]; i += n
        yield pc, op, operand


def scan(code, cp):
    """Return (scaling, floats, strings) seen in a method body."""
    scaling, floats, strings = None, [], []
    for _pc, op, operand in ops(code, cp):
        if op == 0xb2 and operand:  # getstatic
            ref = cp.ref(struct.unpack('>H', operand[:2])[0])
            m = re.match(r'StatScaling\.([A-Z_]+?)L[a-z]', ref)
            if m:
                scaling = m.group(1)
        elif op in (0x12, 0x13, 0x14):
            idx = operand[0] if op == 0x12 else struct.unpack('>H', operand)[0]
            e = cp.e.get(idx)
            if e and e[0] in ('Float', 'Double', 'Int'):
                floats.append(round(float(e[1]), 6))
            elif e and e[0] == 'String':
                strings.append(cp.utf(e[1]))
        elif op == 0x0b:
            floats.append(0.0)
        elif op == 0x0c:
            floats.append(1.0)
        elif op == 0x0d:
            floats.append(2.0)
        elif op == 0x10 and operand:
            floats.append(float(struct.unpack('>b', operand)[0]))
        elif op == 0x11 and operand:
            floats.append(float(struct.unpack('>h', operand)[0]))
    return scaling, floats, strings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--jar', default=None)
    ap.add_argument('--pack', default='C:/CTE2')
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    args = ap.parse_args()

    jar = args.jar
    if not jar:
        mods = os.path.join(args.pack, 'mods')
        for fn in sorted(os.listdir(mods)):
            if re.search(r'Mine_and_Slash.*\.jar$', fn, re.I):
                jar = os.path.join(mods, fn)
    if not jar:
        print('Mine_and_Slash jar not found', file=sys.stderr)
        return 1

    prefix = 'com/robertx22/mine_and_slash/database/data/stats/types/'
    found = {}
    with zipfile.ZipFile(jar) as z:
        for info in z.infolist():
            n = info.filename
            if not (n.startswith(prefix) and n.endswith('.class')):
                continue
            try:
                cp, cls, methods, consts = parse_class(z.read(info))
            except Exception:
                continue

            guid = None
            for key, bodies in methods.items():
                if key.startswith('GUID()'):
                    for b in bodies:
                        _s, _f, strs = scan(b, cp)
                        if strs:
                            guid = strs[0]
            if not guid:
                for fname in ('GUID', 'ID', 'STAT_ID'):
                    v = consts.get(fname)
                    if isinstance(v, str):
                        guid = v
                        break
            if not guid:
                for key, bodies in methods.items():
                    if key.startswith('<clinit>'):
                        for b in bodies:
                            _s, _f, strs = scan(b, cp)
                            if strs:
                                guid = strs[0]
            if not guid:
                continue

            scaling, floats = None, []
            for key, bodies in methods.items():
                if key.startswith('<init>'):
                    for b in bodies:
                        s, f, _ = scan(b, cp)
                        scaling = scaling or s
                        floats += f
            is_perc = None
            for key, bodies in methods.items():
                if key.startswith('IsPercent()'):
                    for b in bodies:
                        _s, f, _ = scan(b, cp)
                        if f:
                            is_perc = bool(f[0])

            found[guid] = {
                'id': guid,
                'class': n[len(prefix):-6],
                'scaling': scaling or 'NONE',
                'is_percent': is_perc,
                'const_floats': sorted(set(floats)),
            }

    dest = os.path.join(args.out, 'core_stats.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(found, fh, indent=1, sort_keys=True)

    print('recovered {} code-defined stats from {}'.format(
        len(found), os.path.basename(jar)))
    by = {}
    for v in found.values():
        by[v['scaling']] = by.get(v['scaling'], 0) + 1
    print('  scaling: {}'.format(by))

    # How many of the character's previously-unexplained stats does this cover?
    chp = os.path.join(args.out, 'character.json')
    stp = os.path.join(args.out, 'mmorpg_stat.json')
    if os.path.exists(chp) and os.path.exists(stp):
        ch = json.load(open(chp, encoding='utf-8'))
        data = json.load(open(stp, encoding='utf-8'))
        gaps = [s for s in ch['computed_stats'] if s not in data]
        cov = [s for s in gaps if s in found]
        print('  character stats missing from datapack: {}'.format(len(gaps)))
        print('  now recovered from code            : {}'.format(len(cov)))
        still = [s for s in gaps if s not in found]
        if still:
            print('  still unexplained: {}'.format(', '.join(still)))
    print('  -> {}'.format(dest))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
