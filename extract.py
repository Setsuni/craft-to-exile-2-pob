#!/usr/bin/env python3
"""
CTE2 PoB - Step 1: data extractor.

Merges Mine & Slash's base game data (shipped inside the mod jars) with the
Craft to Exile 2 datapack overrides, and emits one normalized JSON bundle.

Precedence: datapack (OpenLoader) beats jar. Later datapacks beat earlier ones.
Nothing here interprets game rules - this layer only collects and normalizes.
"""
import argparse, json, os, re, sys, zipfile
from collections import defaultdict

DATA_RE = re.compile(r'^data/([a-z0-9_.-]+)/(mmorpg_[a-z0-9_]+)/(.+)\.json$')


def load_json(raw, origin):
    """MnS data contains raw control characters in strings; strict=False tolerates them."""
    for enc in ('utf-8-sig', 'utf-8', 'latin-1'):
        try:
            text = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        try:
            return json.loads(text, strict=False)
        except json.JSONDecodeError as e:
            raise ValueError('{}: {}'.format(origin, e))
    raise ValueError('{}: undecodable'.format(origin))


def entry_id(obj, fallback):
    """Prefer the object's own id so jar/datapack entries collide correctly."""
    if isinstance(obj, dict):
        for key in ('id', 'identifier', 'guid'):
            v = obj.get(key)
            if isinstance(v, str) and v:
                return v
        d = obj.get('data')
        if isinstance(d, dict) and isinstance(d.get('id'), str):
            return d['id']
    return fallback


class Collector:
    def __init__(self):
        # category -> id -> {"obj":..., "source":..., "path":...}
        self.cat = defaultdict(dict)
        self.overrides = []
        self.collisions = []
        self.errors = []
        self.sources = []

    def add(self, category, ident, obj, source, path):
        bucket = self.cat[category]
        prev = bucket.get(ident)
        if prev is not None:
            rec = {
                'category': category,
                'id': ident,
                'replaced': prev['source'],
                'replaced_path': prev['path'],
                'by': source,
                'by_path': path,
            }
            self.overrides.append(rec)
            # A collision *within one source* is not an override - two files in the
            # same pack claim one id, so the game keeps whichever loads last and the
            # other is dead data. Identical content is a harmless duplicate; differing
            # content almost always means a copy-pasted file whose id was never changed.
            if prev['source'] == source:
                identical = (json.dumps(prev['obj'], sort_keys=True)
                             == json.dumps(obj, sort_keys=True))
                rec['same_source'] = True
                rec['identical'] = identical
                self.collisions.append(rec)
        bucket[ident] = {'obj': obj, 'source': source, 'path': path}

    def ingest_jar(self, jar_path):
        name = os.path.basename(jar_path)
        n = 0
        with zipfile.ZipFile(jar_path) as z:
            for info in z.infolist():
                m = DATA_RE.match(info.filename)
                if not m:
                    continue
                _ns, category, rest = m.groups()
                try:
                    obj = load_json(z.read(info), name + '!' + info.filename)
                except ValueError as e:
                    self.errors.append(str(e))
                    continue
                self.add(category, entry_id(obj, rest.split('/')[-1]), obj, name, info.filename)
                n += 1
        self.sources.append({'type': 'jar', 'name': name, 'entries': n})
        return n

    def ingest_dir(self, root, label):
        n = 0
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.endswith('.json'):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root).replace(os.sep, '/')
                m = DATA_RE.match(rel)
                if not m:
                    continue
                _ns, category, rest = m.groups()
                try:
                    with open(full, 'rb') as fh:
                        obj = load_json(fh.read(), rel)
                except ValueError as e:
                    self.errors.append(str(e))
                    continue
                self.add(category, entry_id(obj, rest.split('/')[-1]), obj, label, rel)
                n += 1
        self.sources.append({'type': 'datapack', 'name': label, 'entries': n})
        return n


def decode_tree(obj):
    """Talent trees ship as a comma/newline grid string. Turn it into real nodes."""
    grid = obj.get('perks')
    if not isinstance(grid, str):
        return None
    rows = grid.split('\n')
    nodes = []
    width = 0
    for y, row in enumerate(rows):
        cells = row.split(',')
        if len(cells) > width:
            width = len(cells)
        for x, tok in enumerate(cells):
            tok = tok.strip()
            if tok and tok != 'E':
                nodes.append({'x': x, 'y': y, 'token': tok})
    counts = defaultdict(int)
    for nd in nodes:
        counts[nd['token']] += 1
    return {
        'id': obj.get('identifier'),
        'school_type': obj.get('school_type'),
        'icon': obj.get('icon'),
        'order': obj.get('order'),
        'size': {'width': width, 'height': len(rows)},
        'nodes': nodes,
        'token_counts': dict(sorted(counts.items(), key=lambda kv: -kv[1])),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', default='C:/CTE2', help='modpack/server root')
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    args = ap.parse_args()

    pack = args.pack
    out = args.out
    os.makedirs(out, exist_ok=True)
    c = Collector()

    mods = os.path.join(pack, 'mods')
    jars = []
    if os.path.isdir(mods):
        for fn in sorted(os.listdir(mods)):
            if fn.endswith('.jar') and re.search(r'Mine_and_Slash|Library_of_Exile', fn, re.I):
                jars.append(os.path.join(mods, fn))
    if not jars:
        print('WARNING: no Mine_and_Slash / Library_of_Exile jar found', file=sys.stderr)
    for j in jars:
        print('  jar      {:<45} {:>5} entries'.format(os.path.basename(j), c.ingest_jar(j)))

    # OpenLoader datapacks override the jars; walk each pack dir in sorted order.
    ol = os.path.join(pack, 'config', 'openloader', 'data')
    if os.path.isdir(ol):
        for dp in sorted(os.listdir(ol)):
            full = os.path.join(ol, dp)
            if os.path.isdir(full):
                n = c.ingest_dir(full, dp)
                if n:
                    print('  datapack {:<45} {:>5} entries'.format(dp, n))

    # Write one file per category.
    suspect = [x for x in c.collisions if not x['identical']]
    manifest = {
        'sources': c.sources,
        'categories': {},
        'overrides': len(c.overrides),
        'same_source_collisions': len(c.collisions),
        'suspected_pack_bugs': len(suspect),
        'errors': c.errors,
    }
    total = 0
    for category, bucket in sorted(c.cat.items()):
        payload = {ident: e['obj'] for ident, e in sorted(bucket.items())}
        with open(os.path.join(out, category + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, indent=1, sort_keys=True)
        manifest['categories'][category] = len(payload)
        total += len(payload)

    # Talent trees get a decoded companion file.
    trees = {}
    for ident, e in c.cat.get('mmorpg_talent_tree', {}).items():
        d = decode_tree(e['obj'])
        if d:
            trees[ident] = d
    if trees:
        with open(os.path.join(out, 'talent_trees_decoded.json'), 'w', encoding='utf-8') as fh:
            json.dump(trees, fh, indent=1)
        manifest['talent_trees'] = {
            k: {'size': v['size'], 'nodes': len(v['nodes'])} for k, v in trees.items()
        }

    with open(os.path.join(out, 'overrides.json'), 'w', encoding='utf-8') as fh:
        json.dump(c.overrides, fh, indent=1)
    with open(os.path.join(out, 'collisions.json'), 'w', encoding='utf-8') as fh:
        json.dump(c.collisions, fh, indent=1)
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=1)

    print('\n  {} entries across {} categories -> {}'.format(total, len(c.cat), out))
    print('  {} datapack overrides, {} parse errors'.format(len(c.overrides), len(c.errors)))
    if suspect:
        print('  {} suspected pack bugs (two files, one id, different content):'.format(len(suspect)))
        for x in suspect:
            print('     {:<24} id={}'.format(x['category'].replace('mmorpg_', ''), x['id']))
            print('        kept    {}'.format(x['by_path']))
            print('        shadowed {}'.format(x['replaced_path']))
    for t, v in (manifest.get('talent_trees') or {}).items():
        print('  tree {:<16} {}x{}  {} nodes'.format(
            t, v['size']['width'], v['size']['height'], v['nodes']))


if __name__ == '__main__':
    main()
