#!/usr/bin/env python3
"""
CTE2 PoB - item textures, so a crossbow looks like a crossbow.

Every item id in the planner maps to a real Minecraft item with a real texture
somewhere in the pack. Finding it is not quite "assets/<ns>/textures/item/<path>":
an item's model decides which texture it uses, and plenty of gear points at a
name that does not match its own id. So this reads the model first and falls
back to the conventional path.

Textures are packed into one atlas with a JSON index, the same as the talent
and spell icons - hundreds of 16x16 files are far too many to publish singly.

    python export_item_art.py --out out214
"""
import argparse, base64, io, json, os, zipfile, glob

from PIL import Image

CLIENT_DEFAULT = (r'C:\Users\shawn\curseforge\minecraft\Instances'
                  r'\Craft to Exile 2 - 2.0 Atlas Update')
CELL = 32          # icons are 16 or 32; normalise so the atlas is uniform


def res_path(spec, kind):
    """`ns:path` -> `assets/ns/<kind>/path.png`, defaulting the namespace."""
    spec = str(spec)
    ns, _, rest = spec.partition(':')
    if not rest:
        ns, rest = 'minecraft', spec
    return 'assets/%s/%s/%s.png' % (ns, kind, rest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--client', default=CLIENT_DEFAULT)
    ap.add_argument('--out', default='out214')
    args = ap.parse_args()

    jars = sorted(glob.glob(os.path.join(args.client, 'mods', '*.jar')))
    zips = []
    for j in jars:
        try:
            zips.append(zipfile.ZipFile(j))
        except Exception:
            pass
    packs = glob.glob(os.path.join(args.client, 'config', 'openloader',
                                   'resources', '*', ''))

    def read(name):
        """Pack resources win, exactly as the game layers them."""
        for base in packs:
            p = os.path.join(base, *name.split('/'))
            if os.path.exists(p):
                return open(p, 'rb').read()
        for z in zips:
            try:
                return z.read(name)
            except KeyError:
                pass
            # Some mods ship their textures under a nested resource pack -
            # Blue Skies keeps all 93 of its items in `legacy_pack` - so a
            # straight lookup finds the model and none of the art.
            alt = name.replace('assets/', '', 1)
            ns = alt.split('/', 1)[0]
            try:
                return z.read('assets/%s/legacy_pack/%s' % (ns, name))
            except KeyError:
                continue
        return None

    def as_image(raw):
        if not raw:
            return None
        try:
            img = Image.open(io.BytesIO(raw)).convert('RGBA')
        except Exception:
            return None
        # An animated texture is a vertical strip of frames; keep the first.
        if img.height > img.width and img.height % img.width == 0:
            img = img.crop((0, 0, img.width, img.width))
        return img

    def texture_for(item_id):
        """The sprite an item actually shows.

        Not one file in general: a model can stack layers, and Blue Skies
        builds every tool that way - layer0 is the handle and layer1 the head,
        with no combined texture anywhere. Reading layer0 alone gave a bare
        handle; ignoring the model gave nothing at all. So the layers are
        composited in order, exactly as the game draws them.
        """
        raw = read(res_path(item_id, 'models/item'))
        if raw:
            try:
                model = json.loads(raw.decode('utf-8'))
                tex = model.get('textures') or {}
                layers = sorted((k for k in tex if k.startswith('layer')),
                                key=lambda k: int(k[5:] or 0))
                out = None
                for k in layers:
                    img = as_image(read(res_path(tex[k], 'textures')))
                    if img is None:
                        continue
                    if out is None:
                        out = img
                    else:
                        if img.size != out.size:
                            img = img.resize(out.size, Image.NEAREST)
                        out.alpha_composite(img)
                if out is not None:
                    return out
                for key in ('all', 'particle', 'texture'):
                    if tex.get(key):
                        img = as_image(read(res_path(tex[key], 'textures')))
                        if img is not None:
                            return img
            except ValueError:
                pass
        return as_image(read(res_path(item_id, 'textures/item')))

    # Everything the planner might want to draw: the attribute dump covers the
    # gear the pack ships, and the build adds whatever this character wears.
    ids = set()
    dump = os.path.join(args.out, 'item_attributes.json')
    if os.path.exists(dump):
        ids |= set(json.load(open(dump, encoding='utf-8')).keys())
    bundle = os.path.join(args.out, 'build_bundle.json')
    if os.path.exists(bundle):
        for g in json.load(open(bundle, encoding='utf-8')).get('gear') or []:
            if g.get('item'):
                ids.add(g['item'])

    icons, missing = {}, []
    for item in sorted(ids):
        img = texture_for(item)
        if img is None:
            missing.append(item)
            continue
        icons[item] = img.resize((CELL, CELL), Image.NEAREST)

    cols = 24
    rows = (len(icons) + cols - 1) // cols
    atlas = Image.new('RGBA', (cols * CELL, max(1, rows) * CELL), (0, 0, 0, 0))
    index = {}
    for i, (item, img) in enumerate(sorted(icons.items())):
        cx, cy = i % cols, i // cols
        atlas.paste(img, (cx * CELL, cy * CELL))
        index[item] = [cx, cy]

    art_dir = os.path.join(args.out, 'art')
    os.makedirs(art_dir, exist_ok=True)
    atlas_path = os.path.join(art_dir, 'item_icons.png')
    atlas.save(atlas_path, optimize=True)

    dest = os.path.join(args.out, 'item_art.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        _buf = io.BytesIO()
        atlas.save(_buf, format='PNG', optimize=True)
        _uri = 'data:image/png;base64,' + base64.b64encode(_buf.getvalue()).decode()
        # Inlined: one self-contained page, so a bare filename loads nothing.
        json.dump({'cell': CELL, 'cols': cols, 'rows': rows,
                   'atlas': _uri, 'index': index},
                  fh, separators=(',', ':'))

    print('item art -> %s  (%.0f KB)' % (dest, os.path.getsize(dest) / 1024))
    print('atlas    -> %s  (%dx%d, %d icons, %.0f KB)'
          % (atlas_path, atlas.width, atlas.height, len(icons),
             os.path.getsize(atlas_path) / 1024))
    print('resolved %d of %d ids' % (len(icons), len(ids)))
    if missing:
        print('no texture for %d: %s' % (len(missing), ', '.join(missing[:6])))


if __name__ == '__main__':
    main()
