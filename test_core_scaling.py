"""Core stats use nested datapack scaling, including rolled jewel attributes."""
import math
import batch

rules = batch.load_rules('out214')
for stat in ('strength', 'dexterity', 'intelligence'):
    assert rules.scaling_of(stat) == 'CORE'
    for level, expected in [(1, 2), (100, 11.9), (200, 11.9)]:
        assert math.isclose(rules.exact({'stat':stat,'min':2,'max':2,'type':'FLAT'},0,level)[2],expected)
    assert rules.exact({'stat':stat,'min':2,'max':2,'type':'PERCENT'},0,100)[2] == 2
mod = rules.affixes['jewel_dex']['stats'][0]
assert math.isclose(sum(rules.exact(mod,pct,100)[2] for pct in (20,86)),11.1384)
print('PASS nested core scaling, level bounds, unscaled percentages and rolled Dexterity jewels')

def test_trees_resolve_by_name():
    """Atlas coordinates must never be looked up in the talent tree.

    `graphs.get(school.lower()) or graphs['talents']` silently resolved the
    save's ATLAS coordinates against the TALENT graph, because the graph is
    called `atlas_passives`. Every atlas node that happened to land on a talent
    node was applied as a real perk - `mage` came out doubled and intelligence
    read 12 high. This is the second time that fallback has been written.
    """
    import batch, read_character, resolve as R
    rules = batch.load_rules('out214')
    ch = read_character.read('testsaves/pob_export.dat')
    sheet = R.resolve(ch, rules)

    # No contribution may come from an atlas perk.
    atlas_graph = rules.graphs['atlas_passives']
    atlas_perks = {n['perk'] for n in atlas_graph['nodes'] if n.get('perk')}
    talent_perks = {n['perk'] for n in rules.graphs['talents']['nodes'] if n.get('perk')}
    only_atlas = atlas_perks - talent_perks
    seen = {str(src).split(':', 1)[1] for rows in sheet.why.values()
            for src, _t, _v in rows if str(src).startswith('perk:')}
    leaked = seen & only_atlas
    assert not leaked, 'atlas perks reached the character sheet: %s' % sorted(leaked)

    # And the attributes this bug inflated are exact.
    game = {k: v['v'] for k, v in ch['computed_stats'].items()}
    for stat in ('strength', 'dexterity', 'intelligence'):
        ours = sheet.total(stat, rules)
        assert abs(ours - game[stat]) <= 0.01, (
            '%s %.4f vs game %.4f' % (stat, ours, game[stat]))
    print('PASS trees resolve by name; no atlas perk reaches the character sheet')


test_trees_resolve_by_name()
