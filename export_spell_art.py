#!/usr/bin/env python3
"""
CTE2 PoB - the spell school screen's real artwork.

The Class tab draws a grid of text cards. The game draws a framed panel with
each skill's own icon in a socket, and all of it ships with the pack. Layout
constants come straight out of SpellSchoolScreen / LearnClassPointButton:

    panel        250 x 233 on gui/asc_classes/background.png
    slot spacing 21 px
    button       18 x 18, icon 16 x 16 inside
    position     x = 12  + perk.x * 21
                 y = 178 - perk.y * 21          <-- minus: y grows UPWARD

so row 0 is at the BOTTOM and row 6 (level 30) at the top. Columns 1-6 hold the
skills and 8-9 the passives, with column 7 the gap between them.

Two sources, layered. Six classes ship in the jar (hunter, minstrel, shaman,
sorcerer, warlock, warrior) and the other six only in the pack's openloader
resources, which also overrides the panel background - so reading the jar alone
silently gives you half the classes.

    python export_spell_art.py --out out214
"""
import argparse, base64, io, json, os, zipfile

from PIL import Image

CLIENT_DEFAULT = (r'C:\Users\shawn\curseforge\minecraft\Instances'
                  r'\Craft to Exile 2 - 2.0 Atlas Update')
JAR_NAME = 'Mine_and_Slash-1.20.1-6.4.13.jar'

CELL = 32           # icons are 16 or 32; normalise up so the atlas is uniform

# Straight from the bytecode, so the page can lay out exactly as the game does.
LAYOUT = {
    'panelW': 250, 'panelH': 233,
    'spacing': 21, 'button': 18, 'icon': 16,
    'originX': 12, 'originY': 178,
    'skillCols': [1, 2, 3, 4, 5, 6],
    'passiveCols': [8, 9],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--client', default=CLIENT_DEFAULT)
    ap.add_argument('--out', default='out214')
    args = ap.parse_args()

    jar = os.path.join(args.client, 'mods', JAR_NAME)
    pack = os.path.join(args.client, 'config', 'openloader', 'resources')
    z = zipfile.ZipFile(jar)

    def load(rel):
        """`textures/gui/x.png` under assets/mmorpg, pack overriding the jar."""
        p = os.path.join(pack, 'resources', 'assets', 'mmorpg', *rel.split('/'))
        if os.path.exists(p):
            return Image.open(p).convert('RGBA')
        try:
            return Image.open(io.BytesIO(
                z.read('assets/mmorpg/' + rel))).convert('RGBA')
        except KeyError:
            return None

    def datauri(img):
        if img is None:
            return None
        buf = io.BytesIO()
        img.save(buf, 'PNG', optimize=True)
        return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

    schools = json.load(open(os.path.join(args.out, 'skills.json'),
                             encoding='utf-8'))['schools']

    # ---- every icon the Class tab can need ------------------------------
    wanted = {}          # key -> relative texture path
    for cid, sc in schools.items():
        for pid, p in sc['perks'].items():
            if p.get('learn'):
                # The perk's own icon field already names it; fall back to the
                # conventional path when it is blank.
                spec = p.get('icon') or ''
                rel = (spec.split(':', 1)[1] if ':' in spec
                       else 'textures/gui/spells/icons/%s.png' % p['learn'])
                wanted[pid] = rel
            else:
                wanted[pid] = 'textures/gui/spells/passives/%s.png' % pid

    icons, missing = {}, []
    for key, rel in sorted(wanted.items()):
        img = load(rel)
        if img is None:
            missing.append(key)
            continue
        icons[key] = img.resize((CELL, CELL), Image.NEAREST)

    cols = 16
    rows = (len(icons) + cols - 1) // cols
    atlas = Image.new('RGBA', (cols * CELL, max(1, rows) * CELL), (0, 0, 0, 0))
    index = {}
    for i, (key, img) in enumerate(sorted(icons.items())):
        cx, cy = i % cols, i // cols
        atlas.paste(img, (cx * CELL, cy * CELL))
        index[key] = [cx, cy]

    art_dir = os.path.join(args.out, 'art')
    os.makedirs(art_dir, exist_ok=True)
    atlas_path = os.path.join(art_dir, 'spell_icons.png')
    atlas.save(atlas_path, optimize=True)

    # ---- frames, panel and per-class art --------------------------------
    frames = {
        'spell': datauri(load('textures/gui/spells/slots/spell.png')),
        'passive': datauri(load('textures/gui/spells/slots/passive.png')),
        'overlay': datauri(load('textures/gui/spells/slots/overlay.png')),
    }
    panel = datauri(load('textures/gui/asc_classes/background.png'))
    portraits, backgrounds = {}, {}
    for cid in schools:
        portraits[cid] = datauri(load('textures/gui/asc_classes/class/%s.png' % cid))
        backgrounds[cid] = datauri(load('textures/gui/asc_classes/background/%s.png' % cid))

    out = {
        'cell': CELL, 'cols': cols, 'rows': rows,
        'atlas': 'spell_icons.png',
        'index': index,
        'frames': frames,
        'panel': panel,
        'portraits': portraits,
        'backgrounds': backgrounds,
        'layout': LAYOUT,
    }
    dest = os.path.join(args.out, 'spell_art.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))

    print('spell art -> %s  (%.0f KB)' % (dest, os.path.getsize(dest) / 1024))
    print('atlas     -> %s  (%dx%d, %d icons, %.0f KB)'
          % (atlas_path, atlas.width, atlas.height, len(icons),
             os.path.getsize(atlas_path) / 1024))
    print('portraits %d/%d, backgrounds %d/%d'
          % (sum(1 for v in portraits.values() if v), len(portraits),
             sum(1 for v in backgrounds.values() if v), len(backgrounds)))
    if missing:
        print('MISSING %d icons: %s' % (len(missing), ', '.join(missing[:8])))


if __name__ == '__main__':
    main()
