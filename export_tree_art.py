#!/usr/bin/env python3
"""
CTE2 PoB - pull the talent tree's real artwork out of the mod jar.

The planner was drawing coloured circles. The game draws a framed node with the
perk's own icon inside it, and every one of those textures ships in the jar:

    gui/skill_tree/borders/{stat,special,major,start,asc}_{on,off}.png
    gui/skill_tree/background.png, bar.png
    each perk's `icon` field, e.g. mmorpg:textures/gui/talent_icons/...

613 loose icons is far too many files to publish individually, so they are
packed into one atlas PNG with a JSON index. The frames are few and small
enough to inline as data URIs.

    python export_tree_art.py --out out214
"""
import argparse, base64, io, json, os, zipfile

from PIL import Image

JAR_DEFAULT = (r'C:\Users\shawn\curseforge\minecraft\Instances'
               r'\Craft to Exile 2 - 2.0 Atlas Update\mods'
               r'\Mine_and_Slash-1.20.1-6.4.13.jar')

FRAMES = ['stat', 'special', 'major', 'start', 'asc']
CELL = 32          # every icon is normalised to this; the largest source is 32


def res_path(spec):
    """`mmorpg:textures/gui/x.png` -> `assets/mmorpg/textures/gui/x.png`."""
    if ':' in spec:
        ns, rest = spec.split(':', 1)
    else:
        ns, rest = 'minecraft', spec
    return 'assets/%s/%s' % (ns, rest)


def load(z, name):
    try:
        return Image.open(io.BytesIO(z.read(name))).convert('RGBA')
    except KeyError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--jar', default=JAR_DEFAULT)
    ap.add_argument('--out', default='out214')
    args = ap.parse_args()

    z = zipfile.ZipFile(args.jar)
    perks = json.load(open(os.path.join(args.out, 'mmorpg_perk.json'), encoding='utf-8'))
    graphs = json.load(open(os.path.join(args.out, 'talent_graphs.json'), encoding='utf-8'))

    # Only the perks the tree actually places, so the atlas stays small.
    wanted = []
    seen = set()
    for g in graphs.values():
        for n in g.get('nodes') or []:
            pid = n.get('perk')
            if pid and pid not in seen and pid in perks:
                seen.add(pid)
                wanted.append(pid)
    wanted.sort()

    # Some perks point at textures that are not in the jar - `dagger_damage`
    # asks for stat_icons/weapon/, a folder that does not exist, while
    # talent_icons/dagger_damage.png does. Fall back on basename so those nodes
    # still get their art instead of a blank frame.
    by_name = {}
    for n in z.namelist():
        if n.endswith('.png'):
            by_name.setdefault(n.rsplit('/', 1)[-1], n)

    # Pack into a square-ish grid.
    cols = 24
    rows = (len(wanted) + cols - 1) // cols
    atlas = Image.new('RGBA', (cols * CELL, rows * CELL), (0, 0, 0, 0))
    index, missing = {}, []
    for i, pid in enumerate(wanted):
        spec = perks[pid].get('icon')
        img = load(z, res_path(spec)) if spec else None
        if img is None and spec:
            alt = by_name.get(spec.rsplit('/', 1)[-1])
            if alt:
                img = load(z, alt)
        if img is None:
            missing.append(pid)
            continue
        if img.size != (CELL, CELL):
            # Minecraft GUI art is pixel art; nearest keeps it crisp.
            img = img.resize((CELL, CELL), Image.NEAREST)
        x, y = (i % cols) * CELL, (i // cols) * CELL
        atlas.paste(img, (x, y))
        index[pid] = [i % cols, i // cols]

    art_dir = os.path.join(args.out, 'art')
    os.makedirs(art_dir, exist_ok=True)
    atlas_path = os.path.join(art_dir, 'tree_icons.png')
    atlas.save(atlas_path, optimize=True)

    def data_uri(name):
        img = load(z, name)
        if img is None:
            return None
        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

    frames = {}
    for f in FRAMES:
        for state in ('off', 'on'):
            u = data_uri('assets/mmorpg/textures/gui/skill_tree/borders/%s_%s.png' % (f, state))
            if u:
                frames['%s_%s' % (f, state)] = u

    art = {
        'cell': CELL, 'cols': cols, 'rows': rows,
        'atlas': 'tree_icons.png',
        'index': index,
        'frames': frames,
        'background': data_uri('assets/mmorpg/textures/gui/skill_tree/background.png'),
    }
    meta = os.path.join(args.out, 'tree_art.json')
    with open(meta, 'w', encoding='utf-8') as fh:
        json.dump(art, fh, separators=(',', ':'))

    print('atlas -> %s  (%dx%d, %.0f KB)' %
          (atlas_path, atlas.width, atlas.height, os.path.getsize(atlas_path) / 1024))
    print('meta  -> %s  (%.0f KB)' % (meta, os.path.getsize(meta) / 1024))
    print('  %d perk icons packed, %d frames, %d icons missing'
          % (len(index), len(frames), len(missing)))
    if missing:
        print('  missing: ' + ', '.join(missing[:8]))


if __name__ == '__main__':
    main()
