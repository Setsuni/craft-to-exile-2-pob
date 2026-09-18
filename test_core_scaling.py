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
