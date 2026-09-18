#!/usr/bin/env python3
"""
CTE2 PoB - re-run the whole pipeline against a new pack version.

Version drift is the project's biggest risk: a solo planner rots within a patch
or two unless every input is re-derived rather than hand-maintained. This is the
one command to run when the server or client updates.

    python update.py                      # rebuild from the configured paths
    python update.py --out out215 --client "D:/.../Craft to Exile 2"
    python update.py --check              # report drift, change nothing

It runs, in order:

    extract.py           jar + datapacks  -> mmorpg_*.json
    extract_config.py    pack toml        -> pack_config.json
    extract_core_stats.py  bytecode       -> core_stats.json
    build_graph.py       grids            -> talent_graphs.json
    export_lang.py       lang files       -> lang.json
    export_items.py                       -> item_catalog.json
    export_skills.py                      -> skills.json
    export_damage_map.py                  -> damage_map.json
    export_vanilla.py                     -> vanilla_gear.json
    export_tree_art.py   textures         -> art/tree_icons.png
    export_build.py      a save           -> build_bundle.json
    build_ui.py                           -> the page
    test_regression.py   fixtures         -> pass/fail
    smoke.js             the built page   -> pass/fail
    perf.js              the built page   -> per-paint timings

then diffs the new manifest against the old and prints what moved. A category
that changed size, an id that appeared or vanished, a formula constant that
shifted - those are the things that silently break a calculator, so they are
reported rather than left for someone to notice in a wrong number.
"""
import argparse, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CLIENT = (r'C:\Users\shawn\curseforge\minecraft\Instances'
                  r'\Craft to Exile 2 - 2.0 Atlas Update')
DEFAULT_SERVER = r'C:\CTE2'


def find_jar(root, stem):
    """Newest jar under <root>/mods whose name starts with stem."""
    mods = os.path.join(root, 'mods')
    if not os.path.isdir(mods):
        return None
    hits = [os.path.join(mods, f) for f in os.listdir(mods)
            if f.startswith(stem) and f.endswith('.jar')]
    return max(hits, key=os.path.getmtime) if hits else None


def run(cmd, label):
    t0 = time.time()
    argv = ([sys.executable] + cmd) if cmd[0].endswith('.py') else cmd
    r = subprocess.run(argv, cwd=HERE, capture_output=True, text=True)
    ok = r.returncode == 0
    tail = (r.stdout or r.stderr or '').strip().splitlines()
    note = tail[-1] if tail else ''
    print('  %-22s %-4s %5.1fs  %s' % (label, 'ok' if ok else 'FAIL',
                                       time.time() - t0, note[:80]))
    if not ok:
        print('    ' + '\n    '.join((r.stderr or r.stdout).strip().splitlines()[-8:]))
    return ok


def load(path):
    return json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}


def diff_manifest(old, new):
    """What changed between two extraction manifests."""
    lines = []
    osrc = {s['name']: s.get('entries', 0) for s in old.get('sources', [])}
    nsrc = {s['name']: s.get('entries', 0) for s in new.get('sources', [])}
    for name in sorted(set(osrc) | set(nsrc)):
        if name not in osrc:
            lines.append('  + source %s (%d entries)' % (name, nsrc[name]))
        elif name not in nsrc:
            lines.append('  - source %s gone' % name)
        elif osrc[name] != nsrc[name]:
            lines.append('  ~ source %s %d -> %d' % (name, osrc[name], nsrc[name]))

    ocat = old.get('categories', {})
    ncat = new.get('categories', {})
    for cat in sorted(set(ocat) | set(ncat)):
        a, b = ocat.get(cat), ncat.get(cat)
        if a is None:
            lines.append('  + category %s (%d)' % (cat, b))
        elif b is None:
            lines.append('  - category %s gone (was %d)' % (cat, a))
        elif a != b:
            lines.append('  ~ %-28s %5d -> %-5d (%+d)' % (cat, a, b, b - a))
    return lines


def diff_formulas(old_dir, new_dir):
    """Constants the engine depends on. A change here rewrites every number."""
    keys = ['NORMAL_STAT_SCALING', 'SLOW_STAT_SCALING', 'CORE_STAT_SCALING',
            'MAX_LEVEL', 'MAX_BONUS_SPELL_LEVELS', 'player_points']
    a = (load(os.path.join(old_dir, 'mmorpg_game_balance.json')) or {}).get('original_balance', {})
    b = (load(os.path.join(new_dir, 'mmorpg_game_balance.json')) or {}).get('original_balance', {})
    out = []
    for k in keys:
        if a.get(k) != b.get(k):
            out.append('  ~ balance.%s\n      was %s\n      now %s' % (k, a.get(k), b.get(k)))
    ra = load(os.path.join(old_dir, 'mmorpg_gear_rarity.json'))
    rb = load(os.path.join(new_dir, 'mmorpg_gear_rarity.json'))
    for rid in sorted(set(ra) | set(rb)):
        for f in ('stat_percents', 'base_stat_percents', 'min_affixes'):
            x, y = (ra.get(rid) or {}).get(f), (rb.get(rid) or {}).get(f)
            if x != y:
                out.append('  ~ rarity %s.%s %s -> %s' % (rid, f, x, y))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214', help='output dir for the new version')
    ap.add_argument('--prev', default=None, help='previous output dir to diff against')
    ap.add_argument('--client', default=DEFAULT_CLIENT)
    ap.add_argument('--server', default=DEFAULT_SERVER)
    ap.add_argument('--save', default='naked214/dmg_bolt_lvl100.dat')
    ap.add_argument('--check', action='store_true', help='report drift only')
    args = ap.parse_args()

    out = os.path.join(HERE, args.out)
    prev = args.prev and os.path.join(HERE, args.prev)

    mns = find_jar(args.client, 'Mine_and_Slash') or find_jar(args.server, 'Mine_and_Slash')
    lox = find_jar(args.client, 'Library_of_Exile') or find_jar(args.server, 'Library_of_Exile')
    print('pack sources')
    print('  mine and slash : %s' % (os.path.basename(mns) if mns else 'NOT FOUND'))
    print('  library of exile: %s' % (os.path.basename(lox) if lox else 'NOT FOUND'))
    print('  client         : %s' % args.client)
    print('  server         : %s' % args.server)
    if not mns:
        print('\nCannot continue without the Mine_and_Slash jar.')
        return 1

    # Version drift shows up in the jar name before anything else.
    old_manifest = load(os.path.join(out, 'manifest.json'))
    old_jars = [s['name'] for s in old_manifest.get('sources', []) if s.get('type') == 'jar']
    if old_jars and os.path.basename(mns) not in old_jars:
        print('\n  ! jar changed: %s -> %s' % (', '.join(old_jars), os.path.basename(mns)))

    if args.check:
        print('\n--check: nothing rebuilt.')
        return 0

    # Keep the previous manifest to diff against, even when writing in place.
    snapshot = None
    if old_manifest and not prev:
        snapshot = os.path.join(out, '_manifest_prev.json')
        os.makedirs(out, exist_ok=True)
        shutil.copyfile(os.path.join(out, 'manifest.json'), snapshot)

    print('\nrebuilding into %s' % args.out)
    # --pack must be the CLIENT instance, not the server root. The server ships
    # an older Mine_and_Slash, and silently extracting from it is exactly how
    # this project once spent a day validating 2.1.4 saves against 2.0.4 data.
    pack = args.client if os.path.isdir(os.path.join(args.client, 'mods')) else args.server
    steps = [
        (['extract.py', '--pack', pack, '--out', args.out], 'extract'),
        (['extract_config.py', '--pack', pack, '--out', args.out], 'pack config'),
        (['extract_core_stats.py', '--pack', pack, '--jar', mns, '--out', args.out], 'core stats'),
        (['build_graph.py', '--out', args.out], 'talent graphs'),
        (['export_lang.py', '--out', args.out], 'display names'),
        (['export_items.py', '--out', args.out], 'item catalog'),
        (['export_skills.py', '--out', args.out], 'skills'),
        (['export_damage_map.py', '--out', args.out], 'damage map'),
        (['export_vanilla.py', '--out', args.out], 'vanilla gear'),
        (['export_tree_art.py', '--out', args.out, '--jar', mns], 'tree art'),
        (['export_build.py', '--out', args.out, '--save', args.save], 'build bundle'),
        (['build_ui.py'], 'page'),
    ]
    failed = [lbl for cmd, lbl in steps if not run(cmd, lbl)]

    print('\nverification')
    run(['test_regression.py'], 'regression')
    built = os.path.join(os.environ.get('TEMP', HERE), 'cte2-pob.html')
    if os.path.exists(built):
        r = subprocess.run(['node', 'smoke.js', built], cwd=HERE,
                           capture_output=True, text=True)
        print('  %-22s %-4s        %s' % ('page smoke test',
                                          'ok' if r.returncode == 0 else 'FAIL',
                                          (r.stdout or '').strip().splitlines()[-1:] or ''))

    base = prev or snapshot
    if base:
        old = load(base) if base.endswith('.json') else load(os.path.join(base, 'manifest.json'))
        new = load(os.path.join(out, 'manifest.json'))
        changes = diff_manifest(old, new)
        print('\ndata drift')
        print('\n'.join(changes) if changes else '  nothing moved')
        if prev:
            f = diff_formulas(prev, out)
            print('\nformula drift')
            print('\n'.join(f) if f else '  no engine constants changed')
        if snapshot:
            os.remove(snapshot)

    print('\n%s' % ('FAILED: ' + ', '.join(failed) if failed else 'all steps ok'))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
