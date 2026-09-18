#!/usr/bin/env python3
"""
CTE2 PoB - the game's own display names.

The planner has been showing raw registry ids: `mana_ms_percent_big`,
`glimmering`, `brigandine_helmet`. The game has real names for all of them, and
the pack overrides a good number (Omen -> Codex, Nature -> Lightning), so the
names have to come from the pack's lang file layered over the mod's.

Two wrinkles:

* Stat names carry an in-game markdown link syntax - `[Gear's Defense](defences)`
  points at a wiki anchor. Strip to the visible text.
* Unique gear is keyed `mmorpg.unique_gear.<guid>.name`, not `.<guid>`.

    python export_lang.py --out out214
"""
import argparse, json, os, re, zipfile

CLIENT = (r'C:\Users\shawn\curseforge\minecraft\Instances'
          r'\Craft to Exile 2 - 2.0 Atlas Update')
JAR = os.path.join(CLIENT, 'mods', 'Mine_and_Slash-1.20.1-6.4.13.jar')
PACK = os.path.join(CLIENT, 'config', 'openloader', 'resources', 'resources',
                    'assets', 'mmorpg', 'lang', 'en_us.json')

LINK = re.compile(r'\[([^\]]*)\]\([^)]*\)')
FMT = re.compile(r'%\d*\$?[sd]')
# Minecraft colour codes, and the mod's own value placeholders. 417 of 1441
# stat names carry at least one, and left in they render as literal junk:
# "§7§a[VAL1]%§7 Chance to Gain an Endurance Charge on Kill".
COLOR = re.compile(r'§[0-9a-fk-or]', re.IGNORECASE)
PLACEHOLDER = re.compile(r'\[VAL\d*\]%?')

# prefix in the lang file -> key in the emitted map
GROUPS = {
    'stat': 'mmorpg.stat.',
    'talent': 'mmorpg.talent.',
    'affix': 'mmorpg.affix.',
    'gear_type': 'mmorpg.gear_type.',
    'effect': 'mmorpg.effect.',
    'aura': 'mmorpg.aura.',
    'runeword': 'mmorpg.runeword.',
    'support_gem': 'mmorpg.support_gem.',
    'spell': 'mmorpg.spell.',
    'omen': 'mmorpg.omen.',
    # The spell schools - the classes. Their display names are not the ids:
    # `sorcerer` is Elementalist and `warrior` is Fighter, and `mmorpg.talent.
    # warrior` is a different thing entirely (a tree node called The Axe).
    'asc_class': 'mmorpg.asc_class.',
}


def clean(v):
    if not isinstance(v, str):
        return None
    v = LINK.sub(r'\1', v)
    v = COLOR.sub('', v)
    v = PLACEHOLDER.sub('', v)
    v = FMT.sub('', v)
    v = re.sub(r'\s{2,}', ' ', v).strip(' :-')
    return v or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--jar', default=JAR)
    ap.add_argument('--pack', default=PACK)
    ap.add_argument('--out', default='out214')
    args = ap.parse_args()

    merged = {}
    with zipfile.ZipFile(args.jar) as z:
        merged.update(json.loads(z.read('assets/mmorpg/lang/en_us.json')))
    if os.path.exists(args.pack):
        # The pack wins: it is what the player actually sees.
        merged.update(json.load(open(args.pack, encoding='utf-8')))

    out = {}
    for name, prefix in GROUPS.items():
        m = {}
        for k, v in merged.items():
            if not k.startswith(prefix):
                continue
            rest = k[len(prefix):]
            if '.' in rest:
                continue
            c = clean(v)
            if c:
                m[rest] = c
        out[name] = m

    # Uniques are keyed <guid>.name.
    uniq = {}
    for k, v in merged.items():
        if k.startswith('mmorpg.unique_gear.') and k.endswith('.name'):
            c = clean(v)
            if c:
                uniq[k[len('mmorpg.unique_gear.'):-len('.name')]] = c
    out['unique_gear'] = uniq

    dest = os.path.join(args.out, 'lang.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'), ensure_ascii=False)

    print('lang -> %s  (%.0f KB)' % (dest, os.path.getsize(dest) / 1024))
    for k in sorted(out):
        print('  %-12s %d' % (k, len(out[k])))


if __name__ == '__main__':
    main()
