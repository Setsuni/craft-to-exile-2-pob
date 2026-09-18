"""Infusion rolls come from their rarity, not the item's rarity or a fixed 100%."""
import math
import batch
import resolve

rules = batch.load_rules('out214')
for rarity, roll in [('common',17), ('legendary',85), ('mythic',100)]:
    ench = {'en':'ench_necklace_all_flat', 'rar':rarity}
    assert resolve.infusion_percent(ench, rules) == roll
    stats = resolve.gear_stats({'lvl':100, 'rar':'unique', 'ench':ench}, rules)
    expected = 5.95 * (1 + 2 * roll / 100)
    value = next(v for sid, kind, v in stats if sid == 'all_attributes')
    assert math.isclose(value,expected), (rarity,value,expected)
print('PASS common, legendary, and mythic infusion rolls use their own rarity')
