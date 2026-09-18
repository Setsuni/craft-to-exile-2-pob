#!/usr/bin/env python3
"""
CTE2 PoB - assemble the planner page.

ui/page.html is the template; engine.js is the browser port of resolve.py's
order-sensitive tail. This inlines both plus the build bundle, because the
artifact host only serves scripts from a CDN allowlist.

    python build_ui.py
"""
import argparse, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(os.environ.get('TEMP', HERE), 'cte2-pob.html')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bundle', default=os.path.join(HERE, 'out214', 'build_bundle.json'))
    ap.add_argument('--catalog', default=os.path.join(HERE, 'out214', 'item_catalog.json'))
    ap.add_argument('--art', default=os.path.join(HERE, 'out214', 'tree_art.json'))
    ap.add_argument('--spellart',
                    default=os.path.join(HERE, 'out214', 'spell_art.json'))
    ap.add_argument('--vanilla', default=os.path.join(HERE, 'out214', 'vanilla_gear.json'))
    ap.add_argument('--lang', default=os.path.join(HERE, 'out214', 'lang.json'))
    ap.add_argument('--skills', default=os.path.join(HERE, 'out214', 'skills.json'))
    ap.add_argument('--dmgmap', default=os.path.join(HERE, 'out214', 'damage_map.json'))
    ap.add_argument('--dest', default=DEST)
    args = ap.parse_args()

    page = open(os.path.join(HERE, 'ui', 'page.html'), encoding='utf-8').read()
    engine = open(os.path.join(HERE, 'engine.js'), encoding='utf-8').read()
    items = open(os.path.join(HERE, 'ui', 'items.js'), encoding='utf-8').read()
    bundle = open(args.bundle, encoding='utf-8').read().strip()
    catalog = open(args.catalog, encoding='utf-8').read().strip()
    art = open(args.art, encoding='utf-8').read().strip()
    spellart = open(args.spellart, encoding='utf-8').read().strip()
    vanjs = open(os.path.join(HERE, 'ui', 'vanilla.js'), encoding='utf-8').read()
    vandata = open(args.vanilla, encoding='utf-8').read().strip()
    langdata = open(args.lang, encoding='utf-8').read().strip()
    skjs = open(os.path.join(HERE, 'ui', 'skills.js'), encoding='utf-8').read()
    cljs = open(os.path.join(HERE, 'ui', 'classes.js'), encoding='utf-8').read()
    skdata = open(args.skills, encoding='utf-8').read().strip()
    dmgjs = open(os.path.join(HERE, 'ui', 'damage.js'), encoding='utf-8').read()
    dmgdata = open(args.dmgmap, encoding='utf-8').read().strip()

    # </script> inside a JSON string would close the tag early.
    def esc(t):
        return t.replace('</', '<\\/')

    out = (page.replace('__ENGINE__', engine)
               .replace('__ITEMS__', items)
               .replace('__CATALOG__', esc(catalog))
               .replace('__LANG__', esc(langdata))
               .replace('__DAMAGEJS__', dmgjs)
               .replace('__DMGMAP__', esc(dmgdata))
               .replace('__SKILLSJS__', skjs)
               .replace('__CLASSESJS__', cljs)
               .replace('__SKILLS__', esc(skdata))
               .replace('__VANILLAJS__', vanjs)
               .replace('__VANILLA__', esc(vandata))
               .replace('__SPELLART__', esc(spellart))
               .replace('__TREEART__', esc(art))
               .replace('__BUNDLE__', esc(bundle)))
    with open(args.dest, 'w', encoding='utf-8') as fh:
        fh.write(out)
    print('page -> %s  (%.0f KB)' % (args.dest, len(out.encode('utf-8')) / 1024))

    # GitHub Pages serves docs/ straight off the default branch, so the build
    # writes the hosted copy itself. Keeping it as a step you have to remember
    # is how a published site quietly falls a dozen versions behind.
    pages = os.path.join(HERE, 'docs', 'index.html')
    os.makedirs(os.path.dirname(pages), exist_ok=True)
    with open(pages, 'w', encoding='utf-8') as fh:
        fh.write(out)
    print('pages -> %s' % pages)


if __name__ == '__main__':
    main()
