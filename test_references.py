# -*- coding: utf-8 -*-
"""Nothing the page ships may point at a skill the page does not ship.

    python test_references.py

`export_skills.py` drops every `*_deprecated` spell and `export_items.py`
drops every `*_deprecated` unique. That is right - the pack keeps old versions
of skills beside their replacements - but it is only right for as long as the
things that GRANT skills agree.

Uniques grant skills through their stats: `proc_gong_strike_on_block`,
`cast_<spell>`, and so on, with the spell's own id embedded in the stat id.
So a unique that granted a dropped spell would leave a stat naming a skill the
planner no longer has, and the symptom would be an aura quietly missing from
somebody's build - reported, if at all, weeks later and as "my DPS is wrong".

This fails the moment that happens.
"""
import io
import json
import os

OUT = 'out214'


def load(name):
    return json.load(io.open(os.path.join(OUT, name), encoding='utf-8'))


def strings(obj, out):
    """Every string and key anywhere in a structure."""
    if isinstance(obj, str):
        out.add(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            out.add(k)
            strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            strings(v, out)
    return out


def names_spell(stat_id, spell_id):
    """Does `stat_id` embed `spell_id` as a whole token?

    Whole-token, not substring: `proc_ice_shot_on_hit` names `ice_shot`, but
    `spell_damage` must not be read as naming a spell called `damage`.
    """
    return (stat_id == spell_id
            or stat_id.startswith(spell_id + '_')
            or stat_id.endswith('_' + spell_id)
            or ('_' + spell_id + '_') in stat_id)


def main():
    raw = load('mmorpg_spells.json')
    all_spells = set(raw.keys())
    shipped_skills = load('skills.json')
    shipped = set((shipped_skills.get('spells') or shipped_skills).keys())
    dropped = all_spells - shipped

    fails = []

    # 1. A dropped spell must be an old version of one we kept, never the only
    #    copy of something. This is what makes dropping them safe at all.
    for d in sorted(dropped):
        if not d.endswith('_deprecated'):
            fails.append('dropped %r, which is not marked deprecated' % d)
        elif d[:-len('_deprecated')] not in shipped:
            fails.append('dropped %r with no live replacement' % d)

    # 2. Collect every id the page actually ships, then check what it names.
    refs = set()
    for fn in ('item_catalog.json', 'build_bundle.json'):
        strings(load(fn), refs)

    # A stat id that is itself deprecated is not a reference to a deprecated
    # SPELL - `proc_blood_explosion_deprecated` fires the live blood explosion.
    # Those are checked separately below.
    live_refs = sorted(r for r in refs if not r.endswith('_deprecated'))

    for r in live_refs:
        for d in dropped:
            if names_spell(r, d):
                fails.append('%r names the dropped spell %r' % (r, d))

    # 3. Nothing worn should carry a deprecated stat either. Checked against the
    #    gear catalogue rather than the bundle, which ships stat DEFINITIONS -
    #    a definition nobody grants is dead weight, not a broken reference.
    gear = set()
    strings(load('item_catalog.json'), gear)
    for g in sorted(gear):
        if g.endswith('_deprecated'):
            fails.append('gear carries the deprecated stat %r' % g)

    for f in fails:
        print('  FAIL ' + f)
    print('references: %d spells shipped, %d dropped, %d ids checked - %s'
          % (len(shipped), len(dropped), len(live_refs),
             '%d FAILED' % len(fails) if fails else 'all resolve'))
    assert not fails, '%d dangling skill reference(s)' % len(fails)


main()
