#!/usr/bin/env python3
"""
CTE2 PoB - Step 4: export a self-contained build bundle for the viewer.

The full extracted dataset is ~6 MB, far too heavy to ship inside a page. This
emits only what one build needs: the character, the stats with both our computed
value and the game's, the talent tree topology, the perks actually allocated, the
equipped gear with affixes resolved to readable stats, and per-skill damage.

    python export_build.py --out out214 --save naked214/dmg_bolt_lvl100.dat
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import read_character, resolve as R, batch, damage as D


def affix_text(affix, percent, ilvl, rules):
    """Human-readable stat lines for one rolled affix."""
    out = []
    for mod in (affix or {}).get('stats', []):
        st, kind, v = rules.exact(mod, percent, ilvl)
        out.append({'stat': st, 'type': kind, 'value': round(v, 2)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out214')
    ap.add_argument('--save', default='naked214/dmg_bolt_lvl100.dat')
    ap.add_argument('--dest', default='out214/build_bundle.json')
    args = ap.parse_args()

    def L(n):
        p = os.path.join(args.out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    rules = batch.load_rules(args.out)
    ch = read_character.read(args.save)
    sheet = R.resolve(ch, rules)

    game = {k: v['v'] for k, v in ch['computed_stats'].items()}
    ours = {}
    for k in set(game) | set(sheet.keys()):
        ours[k] = round(sheet.total(k, rules), 4) if k in sheet.keys() else 0.0

    stats = []
    for k in sorted(set(game) | {x for x in ours if ours[x]}):
        g = game.get(k)
        o = ours.get(k, 0.0)
        stats.append({
            'id': k,
            'game': None if g is None else round(g, 4),
            'ours': round(o, 4),
            'ok': g is not None and abs(g - o) <= 0.01,
            'sources': [{'src': s, 'type': t, 'v': round(v, 3)}
                        for s, t, v in sheet.why.get(k, [])][:12],
        })

    # Talent tree: full topology so unallocated nodes are visible for context.
    graphs = L('talent_graphs.json')
    perks = L('mmorpg_perk.json')
    trees = {}
    # The save names a tree one way and the graph file another - the save says
    # ATLAS, the graph is atlas_passives - so the mapping is explicit. Guessing
    # it (`graphs.get(name.lower())`) silently resolved atlas coordinates
    # against the talent tree and reported the collisions as real perks.
    SAVE_KEY = {'talents': 'TALENTS', 'ascendancy': 'ASCENDANCY',
                'atlas_passives': 'ATLAS'}
    for name in ('talents', 'ascendancy', 'atlas_passives'):
        g = graphs.get(name)
        if not g:
            continue
        taken = {tuple(c) for c in (ch['allocated'].get(SAVE_KEY[name]) or [])}
        trees[name] = {
            'size': g['size'],
            'nodes': [{'x': n['x'], 'y': n['y'], 'p': n['perk'], 't': n.get('type'),
                       'a': 1 if (n['x'], n['y']) in taken else 0}
                      for n in g['nodes']],
            # Flat [x,y,...] path per edge: half of them bend, and drawing a
            # bent wire as a straight line slashes a diagonal across the tree.
            'edges': [[c for cell in (e.get('path') or [e['a'], e['b']]) for c in cell]
                      for e in g['edges']],
        }

    # Only the perks this build actually allocated.
    used = {}
    GRAPH_OF = {v: k for k, v in SAVE_KEY.items()}
    for name, coords in ch['allocated'].items():
        g = graphs.get(GRAPH_OF.get(name, name.lower()))
        if not g:
            continue
        pos = {(n['x'], n['y']): n['perk'] for n in g['nodes']}
        for c in coords:
            pid = pos.get(tuple(c))
            if pid and pid in perks:
                used[pid] = {'type': perks[pid].get('type'),
                             'stats': perks[pid].get('stats', [])}
    for pid in ((ch.get('ascendancy') or {}).get('allocated_lvls') or {}):
        if pid in perks:
            used[pid] = {'type': perks[pid].get('type'),
                         'stats': perks[pid].get('stats', [])}

    lang_effect = {}
    _lang_path = os.path.join(args.out, 'lang.json')
    if os.path.exists(_lang_path):
        lang_effect = (json.load(open(_lang_path, encoding='utf-8'))
                       .get('effect') or {})

    # Gear, with affixes resolved to actual stat lines.
    gear = []
    for it in ch['gear']:
        ilvl = it.get('lvl', 1)
        lines = []
        imp = it.get('imp') or {}
        # `p` is the roll percentage. Without it the planner can show an item's
        # stats but cannot seed its editor, so opening a slot gave a blank form
        # instead of the item actually equipped there.
        if imp.get('imp'):
            lines.append({'kind': 'implicit', 'id': imp['imp'],
                          'p': imp.get('p', 0),
                          'stats': affix_text(rules.affixes.get(imp['imp']),
                                              imp.get('p', 0), ilvl, rules)})
        for grp, lbl in (('pre', 'prefix'), ('suf', 'suffix'), ('cor', 'corrupt')):
            for e in (it.get('affixes') or {}).get(grp) or []:
                lines.append({'kind': lbl, 'id': e.get('id'),
                              'p': e.get('p', 0),
                              'stats': affix_text(rules.affixes.get(e.get('id')),
                                                  e.get('p', 0), ilvl, rules)})
        ench = it.get('ench') or {}
        if ench.get('en'):
            lines.append({'kind': 'infusion', 'id': ench['en'], 'p': 100,
                          'stats': affix_text(rules.affixes.get(ench['en']),
                                              100, ilvl, rules)})
        socks = (it.get('sockets') or {})
        gear.append({
            'slot': it.get('_slot'), 'item': it.get('_item'),
            'gtype': it.get('gtype'), 'rarity': it.get('rar'), 'ilvl': ilvl,
            'sockets': [s.get('g') for s in socks.get('so') or []],
            # Every rune rolls its own value - this crossbow carries fey at 84%
            # and daw at 16% - so a single percentage for the whole item would
            # reconstruct it wrong.
            'socketPcts': [s.get('p', 0) for s in socks.get('so') or []],
            'socketCount': socks.get('sl', 0),
            'runeword': socks.get('rw') or None,
            'runewordPct': socks.get('rp', 100),
            'unique': it.get('_uniq') or None,
            # Each of a unique's fixed stats rolled its own percentage, held in
            # a 10-slot buffer read in declaration order. Without it the
            # planner showed every unique at its best possible roll.
            'uniquePercs': ((it.get('uniqueStats') or {}).get('perc') or []),
            'ench2': it.get('_ench') or [],
            'basePct': (it.get('baseStats') or {}).get('p', 100),
            'lines': lines,
        })

    # Damage per equipped skill.
    vc = L('mmorpg_value_calc.json')
    spells = L('mmorpg_spells.json')
    bal = L('mmorpg_game_balance.json')['original_balance']
    cfg = (L('pack_config.json').get('mine_and_slash_compatibility-server.toml')
           or {}).get('settings') or {}
    lang = {}
    for p in (os.path.join(args.out, 'spell_names.json'),):
        if os.path.exists(p):
            lang = json.load(open(p, encoding='utf-8'))
    ranks = {s['id']: s.get('rank', 0)
             for s in ((ch.get('casting') or {}).get('spells') or [])}
    hotbar = (ch.get('casting') or {}).get('hotbar') or {}
    # Which support gems are linked to which skill. The gem inventory is a grid
    # laid out one row per hotbar slot: column 0 is the skill itself and columns
    # 1-5 are its five support sockets, which is why the row is 6 wide -
    # SUPPORT_GEMS_PER_SKILL is 5. So row = hotbar slot, and a gem's inventory
    # slot is the ONLY thing tying it to a skill; the gem names no spell.
    #
    # This used to hand every skill the same list of every support gem the
    # player owned, which inflated every skill's damage.
    GEM_COLS = 5 + 1
    links = {}
    for g in (ch.get('support_gems') or []):
        sl = g.get('_slot')
        if sl is None:
            continue
        row, col = divmod(int(sl), GEM_COLS)
        if col == 0:            # the skill's own gem, not a support
            continue
        links.setdefault(row, []).append((col, g['id']))
    links = {r: [gid for _, gid in sorted(v)] for r, v in links.items()}

    skills = []
    for slot, sid in sorted(hotbar.items(), key=lambda kv: int(kv[0])):
        calc = vc.get(sid)
        sp = spells.get(sid) or {}
        rank = ranks.get(sid, 0)
        bd = None
        if calc:
            bd = D.base_damage(calc, game, ch['level'], rank, sp.get('max_lvl') or 20,
                               rules, float(cfg.get('SPELL_BASE_DAMAGE_MULTIPLIER', 1.0)),
                               int(bal.get('MAX_BONUS_SPELL_LEVELS', 8)))
        skills.append({
            'slot': int(slot), 'id': sid,
            'name': lang.get(sid, sid.replace('_', ' ').title()),
            'rank': rank, 'max_lvl': sp.get('max_lvl'),
            'base_damage': bd,
            'scalings': [{'stat': s['stat'], 'multi': s.get('multi')}
                         for s in (calc or {}).get('stat_scalings', [])],
            'supports': links.get(int(slot), []),
        })

    # ---- interactive recalc payload -------------------------------------
    #
    # The page has to recompute the whole sheet when a tree node is toggled, so
    # it needs the engine's inputs rather than its outputs. Everything that does
    # NOT depend on the tree is shipped as a flat contribution list; the tree's
    # perks and the auras are shipped unapplied; and the order-sensitive tail of
    # resolve() (aura_effect scaling, elemental transfer, core-stat transfer,
    # derived stats) is small enough to re-run in the browser.
    STATIC_SKIP = ('perk:', 'aura:', 'transfer:', 'cleared', 'core:', 'derived:',
                   'base', 'newbie_resists', 'attr:', 'set:')
    contribs = []
    for stat, entries in sheet.why.items():
        for src, kind, val in entries:
            if src.startswith(STATIC_SKIP):
                continue
            contribs.append([stat, kind, round(val, 6), src])

    def perk_mods(pid):
        """Raw, not pre-scaled: [stat, type, v1, scales_with_level]."""
        out = []
        for mod in (perks.get(pid) or {}).get('stats', []):
            out.append([mod['stat'], mod.get('type', 'FLAT'),
                        round(mod.get('v1', 0.0), 6),
                        1 if mod.get('scale_to_lvl') else 0])
        return out

    # Every node on the tree, not just the allocated ones - the planner needs to
    # price a node before it is taken.
    node_mods = {}
    for name, g in graphs.items():
        for n in g.get('nodes') or []:
            pid = n.get('perk')
            if pid and pid not in node_mods and pid in perks:
                m = perk_mods(pid)
                if m:
                    node_mods[pid] = m

    # Level-dependent inputs, shipped raw.
    base_profile = [[m['stat'], m.get('type', 'FLAT'), m.get('v1', 0.0),
                     1 if m.get('scale_to_lvl') else 0]
                    for m in R.rules_profile(rules, 'original_mode_player')]

    attr_rules = []
    for c in rules.compat.values():
        if isinstance(c, dict) and c.get('attribute_id'):
            attr_rules.append({'attr': c['attribute_id'], 'stat': c['mns_stat_id'],
                               'mod': c['mod_type'], 'conv': c['conversion'],
                               'min': c['minimum_cap'], 'max': c['maximum_cap'],
                               'scaling': c.get('scaling') or 'NONE'})
    # The entity attribute totals this character actually has, gear included.
    SLOT_TO_DUMP = {'chest': 'chest', 'head': 'head', 'legs': 'legs', 'feet': 'feet',
                    'offhand': 'offhand', 'weapon': 'mainhand', 'curio': 'mainhand'}
    attr_totals = dict(ch.get('entity_attrs') or {})
    for item in ch.get('gear', []):
        by_slot = rules.item_attrs.get(item.get('_item')) or {}
        mods_ = by_slot.get(SLOT_TO_DUMP.get(item.get('_slot'), '')) or {}
        for aid, mod in mods_.items():
            if str(mod.get('op', 'ADDITION')).upper() in ('ADDITION', '0'):
                attr_totals[aid] = attr_totals.get(aid, 0.0) + float(mod.get('amount', 0.0))

    # Every stat these raw mods can touch needs its scaling type.
    scaling_of = {}
    for row in base_profile:
        scaling_of.setdefault(row[0], rules.scaling_of(row[0]))
    scal_cfg = {}
    for nm, key in R.SCALING_KEY.items():
        cfg = rules.balance.get(key)
        if cfg:
            scal_cfg[nm] = {'base': cfg['base_scaling'],
                            'per_level': cfg['per_level_scaling'],
                            'cap': bool(cfg.get('cap_to_max_lvl'))}

    aura_mods = []
    for gem in (ch.get('auras') or []):
        a = rules.auras.get(gem.get('id'))
        if not a:
            continue
        for mod in a.get('stats', []):
            st, kind, v = rules.exact(mod, gem.get('perc', 0), ch['level'])
            aura_mods.append([st, kind, round(v, 6), 'aura:' + str(gem.get('id'))])

    for mods_ in node_mods.values():
        for m in mods_:
            scaling_of.setdefault(m[0], rules.scaling_of(m[0]))

    core_tables = {}
    for sid, sdef in rules.stats.items():
        if not isinstance(sdef, dict) or sdef.get('ser') != 'core_stat':
            continue
        tbl = ((sdef.get('data') or {}).get('core_stat_data') or {}).get('stats') or []
        core_tables[sid] = [[m['stat'], m.get('type', 'FLAT'), m.get('v1', 0.0)]
                            for m in tbl]

    derived = []
    for sid, sdef in sorted(
            ((k, v) for k, v in rules.stats.items()
             if isinstance(v, dict) and v.get('ser') in ('one_to_other', 'more_x_per_y')),
            key=lambda kv: (kv[1].get('data') or {}).get('priority', 0)):
        d = sdef.get('data') or {}
        derived.append({'id': sid, 'ser': sdef['ser'], 'from': d.get('adder_stat'),
                        'to': d.get('add_to'), 'perc': bool(d.get('perc')),
                        'per': d.get('per_amount') or 1})

    # Stat definitions for every stat that can now appear.
    touched = {c[0] for c in contribs} | {a[0] for a in aura_mods}
    for m in node_mods.values():
        touched |= {x[0] for x in m}
    for sid, tbl in core_tables.items():
        touched.add(sid)
        touched |= {x[0] for x in tbl}
    for d in derived:
        touched |= {d['id'], d['from'], d['to']}
    touched |= set(game)
    defs = {}
    for sid in touched:
        if not sid:
            continue
        d = rules.stat_def(sid)
        e = {}
        if d.get('base'):
            e['base'] = d['base']
        if d.get('min') is not None:
            e['min'] = d['min']
        if d.get('max') is not None:
            e['max'] = d['max']
        if d.get('multiUseType') == 'MULTIPLY_STAT':
            e['more'] = 1
        defs[sid] = e

    # Talent point budget: PlayerPoints config, base + per-level, hard-capped.
    pp = (bal.get('player_points') or {}).get('TALENTS') or {}
    budget = min(pp.get('base_points', 0) + pp.get('points_per_lvl', 1.0) * ch['level'],
                 pp.get('max_total_points', 200))

    exact = sum(1 for s in stats if s['ok'] and s['game'] is not None)
    total = sum(1 for s in stats if s['game'] is not None)
    bundle = {
        'meta': {'level': ch['level'], 'exact': exact, 'total': total,
                 'source': os.path.basename(args.save), 'pack': args.out,
                 'points': int(budget)},
        'stats': stats,
        'trees': trees,
        'perks': used,
        'gear': gear,
        'skills': skills,
        'calc': {'contribs': contribs, 'nodeMods': node_mods, 'auraMods': aura_mods,
                 'core': core_tables, 'derived': derived, 'defs': defs,
                 'elements': list(R.ELEMENTAL_ELEMENTS),
                 'singles': list(R.SINGLE_ELEMENTS),
                 'baseProfile': base_profile,
                 'attrRules': attr_rules, 'attrTotals': attr_totals,
                 'newbieResists': bool(rules.newbie_resists),
                 'scalings': scal_cfg, 'scalingOf': scaling_of,
                 'points': (bal.get('player_points') or {}).get('TALENTS') or {},
                 'ascPoints': (bal.get('player_points') or {}).get('ASCENDANCY') or {},
                 'atlasPoints': (bal.get('player_points') or {}).get('ATLAS') or {},
                 # What a target actually is. MnS builds a mob from the `mob`
                 # base profile scaled to its level, then multiplies the lot by
                 # its rarity's `stat_multi` - boss 3.5, uber 4.0, pinnacle 5.0.
                 # The Target config used to be hardcoded zeros, which silently
                 # assumed every enemy had no resistance at all.
                 'mobProfile': [[m['stat'], m.get('type', 'FLAT'), m.get('v1', 0.0),
                                 1 if m.get('scale_to_lvl') else 0]
                                for m in (L('mmorpg_base_stats.json')
                                          .get('mob') or {}).get('base_stats') or []],
                 # Vanilla enchantment conversions, with their caps. Level
                 # times `conversion`, clamped per item and then in total.
                 'enchants': {r['enchant_id']: {
                     'stat': r['mns_stat_id'], 'type': r.get('mod_type', 'FLAT'),
                     'per': r.get('conversion', 0.0),
                     'itemMax': r.get('per_item_max'),
                     'cap': r.get('maximum_cap')}
                     for r in (L('mmorpg_stat_compat.json') or {}).values()
                     if isinstance(r, dict) and r.get('enchant_id')},
                 # Gems. A socket takes a gem OR a rune: the player's boots
                 # carry `emerald6`, which is the +18% Chaos Resistance line on
                 # the in-game tooltip. Gem values are fixed (`v1`), not rolled.
                 'gems': {k: {'type': v.get('gem_type', ''),
                              'weapon': v.get('on_weapons_stats') or [],
                              'armor': v.get('on_armor_stats') or [],
                              'jewelry': v.get('on_jewelry_stats') or []}
                          for k, v in (L('mmorpg_gems.json') or {}).items()
                          if isinstance(v, dict)},
                 # Runes and runewords. A runeword is an ORDERED rune
                 # sequence plus the gear slots it works in: Venom is
                 # fey/daw/ano on a weapon. A rune grants a different stat list
                 # depending on the family it is socketed into, which is why all
                 # three lists ship.
                 'runes': {k: {'weapon': v.get('on_weapons_stats') or [],
                               'armor': v.get('on_armor_stats') or [],
                               'jewelry': v.get('on_jewelry_stats') or [],
                               'tier': v.get('tier', 1)}
                           for k, v in (L('mmorpg_runes.json') or {}).items()
                           if isinstance(v, dict)},
                 'runewords': {k: {'runes': v.get('runes') or [],
                                   'slots': v.get('slots') or [],
                                   'stats': v.get('stats') or []}
                               for k, v in (L('mmorpg_runeword.json') or {}).items()
                               if isinstance(v, dict)},
                 'mobRarity': {k: {'stat': v.get('stat_multi', 1.0),
                                   'dmg': v.get('dmg_multi', 1.0),
                                   'hp': v.get('extra_hp_multi', 1.0),
                                   'name': v.get('name', k)}
                               for k, v in (L('mmorpg_mob_rarity.json') or {}).items()
                               if isinstance(v, dict)},
                 # Every perk id that lives on the atlas tree. Atlas is purely a
                 # farming tree - drop rates, pack size, map find - and changes
                 # no character power, so the sheet must exclude these rather
                 # than fold map_find into the stat totals.
                 'atlasPerks': sorted({n['perk'] for n in
                                       (graphs.get('atlas_passives') or {}).get('nodes', [])
                                       if n.get('perk')})},
        # The class: `school_order` is the one or two spell schools picked and
        # `allocated_lvls` the points put into their perk grids. Points in a
        # skill perk ARE that skill's rank, so this seeds the Class tab and,
        # through it, the Skills tab.
        'ascendancy': {
            'school_order': (ch.get('ascendancy') or {}).get('school_order') or [],
            'allocated_lvls': (ch.get('ascendancy') or {}).get('allocated_lvls') or {},
        },
        # Conditional effects - buffs, charges, ailments. A planner cannot read
        # these off a save: whether you are holding three power charges or a
        # Sharpen buff is a question about how you play, not what you wear. So
        # they are shipped unapplied for the Config tab to switch on.
        'effects': {k: {'name': lang_effect.get(k, k.replace('_', ' ').title()),
                        'stacks': v.get('max_stacks', 1),
                        'byStack': bool(v.get('stacks_affect_stats')),
                        'negative': 'negative' in ((v.get('tags') or {})
                                                   .get('tags') or []),
                        'stats': [[m['stat'], m.get('type', 'FLAT'),
                                   m.get('min', 0.0), m.get('max', 0.0)]
                                  for m in v.get('stats') or []]}
                    for k, v in (L('mmorpg_exile_effect.json') or {}).items()
                    if isinstance(v, dict) and (v.get('stats') or [])},
        'auras': ch.get('auras') or [],
        # Jewels are corrupted like any other item - most of this character's
        # are - and the corruption was being dropped on export, so the editor
        # could not show what the sheet was already counting.
        'jewels': [{'lvl': j.get('lvl'), 'rar': j.get('rar'),
                    'affixes': [{'id': a.get('id'), 'p': a.get('p', 0)}
                                for a in j.get('affixes') or []],
                    'cor': [{'id': a.get('id'), 'p': a.get('p', 0)}
                            for a in j.get('cor') or []]}
                   for j in ch.get('jewels') or []],
        'layers': [{'id': k, **{x: v[x] for x in ('priority', 'action', 'name')
                                if x in v}}
                   for k, v in sorted(L('mmorpg_stat_layer.json').items(),
                                      key=lambda kv: kv[1].get('priority', 0))
                   if isinstance(v, dict)],
    }
    with open(args.dest, 'w', encoding='utf-8') as fh:
        json.dump(bundle, fh, separators=(',', ':'))
    size = os.path.getsize(args.dest)
    print('build bundle -> %s  (%.0f KB)' % (args.dest, size / 1024))
    print('  level %s, %d/%d stats exact, %d gear, %d skills, %d tree nodes'
          % (ch['level'], exact, total, len(gear), len(skills),
             len(trees.get('talents', {}).get('nodes', []))))


if __name__ == '__main__':
    main()
