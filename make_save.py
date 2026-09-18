#!/usr/bin/env python3
"""
CTE2 PoB - build a test character, so validating the engine is a login not a
chore.

The stat engine reached 69/69 by differential testing: a naked level 100, then
the same character with exactly one thing changed. The damage stack needs the
same treatment, and hand-building those characters in game is the slow part.

Mine & Slash stores its player data as JSON strings inside the NBT
(`mmorpg:player_data/tals`, `/casting`, `/asc`, `mmorpg:entity_data/level`), so
a save can be edited precisely without re-encoding anything the mod owns. The
NBT layer underneath is byte-identical on round trip - `python nbt_rw.py`
asserts that over every save here before this script is allowed to run.

    python make_save.py --list                     # what recipes exist
    python make_save.py --recipe naked             # write it
    python make_save.py --recipe one_more_node --install

`--install` copies into the live world's playerdata, backing up what was there.
Nothing is overwritten without a backup, ever.

WHY THESE RECIPES: each isolates one term of

    damage = base x (1 + additive/100) x MORE...

so the in-game tooltip difference between two of them names that term directly.
"""
import argparse, json, os, shutil, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nbt_rw as N

DEFAULT_BASE = os.path.join(HERE, 'naked214', 'dmg_bolt_lvl100.dat')
DEFAULT_WORLD = (r'C:\Users\shawn\curseforge\minecraft\Instances'
                 r'\Craft to Exile 2 - 2.0 Atlas Update\saves')
OUT_DIR = os.path.join(HERE, 'testsaves')
BACKUP_DIR = os.path.join(HERE, 'testsaves', 'backups')


def restore(world_root, uuid):
    """Put the newest backup back over the live character."""
    import glob as _glob
    chars = find_characters(world_root)
    if uuid:
        chars = [c for c in chars if c[1] == uuid]
    if not chars:
        print('no character saves found under %s' % world_root)
        return 1
    world, u, path = chars[0]
    baks = sorted(_glob.glob(os.path.join(BACKUP_DIR, '%s.*.dat' % u)))
    baks = [b for b in baks if not b.endswith('.dat_old')]
    if not baks:
        print('no backup for %s in %s' % (u, BACKUP_DIR))
        return 1
    newest = baks[-1]
    shutil.copyfile(newest, path)
    old_bak = newest.replace('.dat', '.dat_old')
    if os.path.exists(old_bak):
        shutil.copyfile(old_bak, path + '_old')
    print('restored %s' % path)
    print('    from %s' % newest)
    return 0


# ---------------------------------------------------------------- recipes
# Each is (description, what to do to the base save, what to do in game).
RECIPES = {
    'naked': {
        'desc': 'Level 100, no talents beyond the class start, one skill slotted.',
        'level': 100,
        'talents': 'clear',
        'hotbar': {'0': 'double_strike'},
        'todo': 'Hit the dummy once with Double Strike. Screenshot the breakdown. '
                'This is the baseline: base damage with an empty stack.',
    },
    'one_additive_node': {
        'desc': 'Naked plus ONE talent that is additive-only (MULTIPLY_STAT).',
        'level': 100,
        'talents': 'clear',
        'add_stat': ('additive', 1),
        'hotbar': {'0': 'double_strike'},
        'todo': 'Same hit as `naked`. The difference is one additive term, so it '
                'tells us whether additive really is (1 + sum/100).',
    },
    'one_more_node': {
        'desc': 'Naked plus ONE talent that is MULTIPLICATIVE_DAMAGE.',
        'level': 100,
        'talents': 'clear',
        'add_stat': ('more', 1),
        'hotbar': {'0': 'double_strike'},
        'todo': 'Same hit again. Against `naked` this isolates a single MORE '
                'multiplier - the term the engine has never seen proven.',
    },
    'two_more_nodes': {
        'desc': 'Naked plus TWO MULTIPLICATIVE_DAMAGE talents.',
        'level': 100,
        'talents': 'clear',
        'add_stat': ('more', 2),
        'hotbar': {'0': 'double_strike'},
        'todo': 'Proves whether two MOREs multiply (x1.1 x1.1 = 1.21) or add '
                '(1.20). This is the single most valuable capture.',
    },
    'elemental': {
        'desc': 'Naked with Charged Bomb - a genuinely lightning hit.',
        'level': 100,
        'talents': 'clear',
        # Bolt looks like the obvious choice and is the wrong one: its tags are
        # ['projectile','damage','magic','physical','bolt'], so it deals
        # PHYSICAL damage and would not exercise element routing at all.
        # lightning_nova is tagged lightning, and its base damage is already
        # confirmed at 220 against the game.
        'hotbar': {'0': 'lightning_nova'},
        'todo': 'Hit the dummy with Charged Bomb. Base damage should read 220 - '
                'if it does, element routing and ele_match_stat are confirmed '
                'in the same shot.',
    },
    'bolt_physical': {
        'desc': 'Naked with Bolt, which is a PHYSICAL hit despite being a spell.',
        'level': 100,
        'talents': 'clear',
        'hotbar': {'0': 'bolt'},
        'todo': 'Base damage should read 107. Pairs with `elemental` to show a '
                'spell and an attack hitting the same physical stack.',
    },
    'level_60': {
        'desc': 'The naked baseline at level 60 instead of 100.',
        'level': 60,
        'talents': 'clear',
        'hotbar': {'0': 'double_strike'},
        'todo': 'Confirms the level scaling of base damage in one shot.',
    },
}


# ---------------------------------------------------------------- helpers
def load_graph():
    p = os.path.join(HERE, 'out214', 'talent_graphs.json')
    return json.load(open(p, encoding='utf-8'))['talents']


def spell_profile(spell_id):
    """A spell's tags and the element it deals, for filtering test nodes."""
    p = os.path.join(HERE, 'out214', 'skills.json')
    if not spell_id or not os.path.exists(p):
        return [], 'physical'
    sk = json.load(open(p, encoding='utf-8'))['spells'].get(spell_id) or {}
    tags = sk.get('tags') or []
    for e in ('fire', 'water', 'lightning', 'chaos'):
        if e in tags:
            return tags, e
    return tags, 'physical'


def load_damage_map():
    p = os.path.join(HERE, 'out214', 'damage_map.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {'stats': {}}


def applies_to(dmap, stat, spell_tags, element):
    """Would this stat contribute to a hit by this spell?

    Mirrors the condition evaluation in ui/damage.js. Anything not understood
    counts as NOT met, so a recipe never claims a node matters when it might
    not - the whole point is that the two saves differ by a known amount.
    """
    d = dmap['stats'].get(stat)
    if not d:
        return False
    for cid in d.get('ifs') or []:
        c = (dmap.get('conditions') or {}).get(cid) or {}
        ser = c.get('ser')
        if ser == 'spell_has_tag':
            if c.get('tag') not in spell_tags:
                return False
        elif ser == 'ele_match_stat':
            # `ele` is the Elements enum name: Cold is water, Nature is
            # lightning, Shadow is chaos, Elemental and ALL are umbrellas.
            ENUM = {'Physical': ['physical'], 'Fire': ['fire'], 'Cold': ['water'],
                    'Nature': ['lightning'], 'Shadow': ['chaos'],
                    'Elemental': ['fire', 'water', 'lightning'],
                    'ALL': ['physical', 'fire', 'water', 'lightning', 'chaos']}
            hits = ENUM.get(d.get('ele'), [])
            if ('is_false' in cid) == (element in hits):
                return False
        elif ser == 'is_elemental_damage':
            if element not in ('fire', 'water', 'lightning'):
                return False
        elif ser == 'is_spell':
            continue
        elif ser == 'string_matches':
            if c.get('string_key') == 'attack_type':
                want = 'dot' if 'dot' in spell_tags else 'hit'
                if c.get('string_id') != want:
                    return False
            else:
                return False
        else:
            # is_day, in_combat, target state, weapon type, exile effects:
            # situational, so not something a clean differential should rely on.
            return False
    return True


def pick_nodes(graph, dmap, kind, count, start_coords, spell_tags, element):
    """Find `count` nodes granting a damage stat of the given kind, as close to
    an already-allocated node as possible, and return the path to each."""
    perks = json.load(open(os.path.join(HERE, 'out214', 'mmorpg_perk.json'),
                           encoding='utf-8'))
    pos = {(n['x'], n['y']): n['perk'] for n in graph['nodes']}
    adj = {}
    for n in graph['nodes']:
        adj[(n['x'], n['y'])] = []
    for e in graph['edges']:
        a, b = tuple(e['a']), tuple(e['b'])
        if a in adj and b in adj:
            adj[a].append(b)
            adj[b].append(a)

    def wanted(pid):
        perk = perks.get(pid) or {}
        mods = perk.get('stats') or []
        if not mods:
            return False
        # Stats that are not damage stats cannot move the hit, so they are
        # allowed. What is NOT allowed is a damage stat we cannot evaluate:
        # that would put an unknown term into the delta being measured.
        hit = False
        for mod in mods:
            d = dmap['stats'].get(mod['stat'])
            if d is None:
                continue                       # not a damage stat at all
            if not applies_to(dmap, mod['stat'], spell_tags, element):
                return False                   # a damage stat we cannot predict
            if kind == 'more' and d['more'] and mod.get('type') == 'MORE':
                hit = True
            if kind == 'additive' and not d['more'] and \
                    mod.get('type') in ('FLAT', 'PERCENT'):
                hit = True
        return hit

    taken = set(start_coords)
    out = []
    for _ in range(count):
        # breadth-first from the current tree to the nearest wanted node
        seen, prev = set(taken), {}
        queue = list(taken)
        head, found = 0, None
        while head < len(queue) and not found:
            cur = queue[head]
            head += 1
            for nb in adj.get(cur, []):
                if nb in seen:
                    continue
                seen.add(nb)
                prev[nb] = cur
                if wanted(pos.get(nb, '')):
                    found = nb
                    break
                queue.append(nb)
        if not found:
            break
        route = []
        at = found
        while at not in taken:
            route.append(at)
            at = prev[at]
        route.reverse()
        taken.update(route)
        # The nodes walked THROUGH also grant stats, so name them: the expected
        # delta is the whole path, not just the node at the end.
        via = [pos[c] for c in route[:-1]]
        out.append((pos[found], route, via))
    return sorted(taken), out


def build(recipe, base_path):
    name, root, how = N.load(base_path)
    fc = root['ForgeCaps'].v
    pdata = fc['mmorpg:player_data'].v
    edata = fc['mmorpg:entity_data'].v
    notes = []

    if recipe.get('level'):
        edata['level'].v = int(recipe['level'])
        notes.append('level -> %d' % recipe['level'])

    tals = json.loads(pdata['tals'].v)
    graph = load_graph()
    pos = {(n['x'], n['y']): n for n in graph['nodes']}
    starts = [(n['x'], n['y']) for n in graph['nodes'] if n.get('type') == 'START']

    if recipe.get('talents') == 'clear':
        current = [tuple(c.values()) if isinstance(c, dict) else tuple(c)
                   for c in tals['perks']['TALENTS']['list']]
        kept = [c for c in [(p['x'], p['y']) for p in
                            tals['perks']['TALENTS']['list']] if c in starts]
        if not kept and current:
            kept = [c for c in [(p['x'], p['y']) for p in
                                tals['perks']['TALENTS']['list']]][:1]
        tals['perks']['TALENTS']['list'] = [{'x': c[0], 'y': c[1]} for c in kept]
        notes.append('talents cleared to %d start node(s)' % len(kept))

    if recipe.get('add_stat'):
        kind, count = recipe['add_stat']
        have = [(p['x'], p['y']) for p in tals['perks']['TALENTS']['list']]
        spell = list(recipe.get('hotbar', {}).values())[:1]
        tags, element = spell_profile(spell[0] if spell else None)
        allc, picked = pick_nodes(graph, load_damage_map(), kind, count, have,
                                  tags, element)
        tals['perks']['TALENTS']['list'] = [{'x': c[0], 'y': c[1]} for c in allc]
        for pid, route, via in picked:
            notes.append('allocated %s' % pid)
            if via:
                notes.append('  reached through: %s' % ', '.join(via))
        if not picked:
            notes.append('WARNING: found no %s node that affects this skill' % kind)
    pdata['tals'].v = json.dumps(tals, separators=(',', ':'))

    if recipe.get('hotbar'):
        casting = json.loads(pdata['casting'].v)
        casting['hotbar'] = dict(recipe['hotbar'])
        pdata['casting'].v = json.dumps(casting, separators=(',', ':'))
        notes.append('hotbar -> %s' % ', '.join(recipe['hotbar'].values()))

    return name, root, how, notes


def find_characters(world_root):
    """Every character save under every world. -> [(world, uuid, path)]"""
    out = []
    if not os.path.isdir(world_root):
        return out
    for world in sorted(os.listdir(world_root)):
        pd = os.path.join(world_root, world, 'playerdata')
        if not os.path.isdir(pd):
            continue
        for f in sorted(os.listdir(pd)):
            if f.endswith('.dat'):
                out.append((world, f[:-4], os.path.join(pd, f)))
    return out


def resolve_target(world_root, uuid):
    """Which save to write over. One character means no question to ask."""
    chars = find_characters(world_root)
    if uuid:
        chars = [c for c in chars if c[1] == uuid]
    return chars


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--recipe')
    ap.add_argument('--base', default=DEFAULT_BASE)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--install', action='store_true',
                    help='copy into the live world, backing up what is there')
    ap.add_argument('--world', default=DEFAULT_WORLD)
    ap.add_argument('--uuid', default=None,
                    help='character to write over; auto-detected if there is one')
    ap.add_argument('--restore', action='store_true',
                    help='put the most recent backup back')
    args = ap.parse_args()

    if args.restore:
        return restore(args.world, args.uuid)

    if args.list or not args.recipe:
        print('recipes (each isolates one term of the damage formula)\n')
        for k, v in RECIPES.items():
            print('  %-18s %s' % (k, v['desc']))
            print('  %-18s in game: %s\n' % ('', v['todo']))
        print('base save: %s' % args.base)
        return 0

    if args.recipe not in RECIPES:
        print('unknown recipe %r' % args.recipe)
        return 1

    # The writer has to be proven on this machine's saves before it edits one.
    import glob
    files = glob.glob(os.path.join(HERE, 'naked214', '*.dat'))
    if not N.selftest(files):
        print('NBT round trip failed - refusing to write a save.')
        return 1

    # Template from the LIVE character unless told otherwise: position,
    # inventory, dimension and every other mod's capability data are then
    # already correct for this world, and only the MnS fields get rewritten.
    base = args.base
    if base == 'live' or (base == DEFAULT_BASE and args.install):
        chars = resolve_target(args.world, args.uuid)
        if len(chars) == 1:
            base = chars[0][2]
            print('templating from the live character %s' % chars[0][1])
        elif base == 'live':
            print('could not pick a live character to template from')
            return 1

    r = RECIPES[args.recipe]
    name, root, how, notes = build(r, base)

    os.makedirs(OUT_DIR, exist_ok=True)
    uuid = args.uuid or os.path.splitext(os.path.basename(args.base))[0]
    dest = os.path.join(OUT_DIR, '%s.dat' % args.recipe)
    N.save(dest, name, root, how)

    print('\nrecipe   %s' % args.recipe)
    print('what     %s' % r['desc'])
    for n in notes:
        print('  - %s' % n)
    print('written  %s  (%.0f KB)' % (dest, os.path.getsize(dest) / 1024))

    if args.install:
        targets = resolve_target(args.world, args.uuid)
        if not targets:
            print('\nno character saves found under %s' % args.world)
            print('pass --world <saves folder>, or --uuid if you know it')
            return 1
        if len(targets) > 1 and not args.uuid:
            print('\nmore than one character - pass --uuid to choose:')
            for w, u, _ in targets:
                print('  %s  %s' % (u, w))
            return 1
        world, u, path = targets[0]
        stamp = time.strftime('%Y%m%d-%H%M%S')
        bak = os.path.join(BACKUP_DIR, '%s.%s.dat' % (u, stamp))
        os.makedirs(BACKUP_DIR, exist_ok=True)
        shutil.copyfile(path, bak)
        shutil.copyfile(dest, path)
        # Minecraft keeps .dat_old as a fallback and will silently load it if
        # the .dat looks wrong, which would quietly undo the test. Write both
        # so there is no version of the character that is not the one asked for.
        old_path = path + '_old'
        if os.path.exists(old_path):
            shutil.copyfile(old_path, bak.replace('.dat', '.dat_old'))
        shutil.copyfile(dest, old_path)
        print('\ninstalled  %s  (world %s)' % (u, world))
        print('backup     %s' % bak)
        print('\nBe logged OUT before loading - the game writes the character on '
              'exit and would overwrite this.')
        print('To undo:   python make_save.py --restore')

    print('\nIN GAME: %s' % r['todo'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
