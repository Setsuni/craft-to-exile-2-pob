# CTE2 Path of Building — working notes

Handoff state as of 2026-09-11. Goal: a Path of Building clone for Craft to Exile 2
where people enter talents, ascendancies, items, skills and support gems and get
accurate stat and DPS numbers.

**Current state: every stat layer is individually verified.** `python test_regression.py`

```
PASS  naked lvl100 (base layer only)                       57/57
PASS  naked + 1 rare chest (gear base + affixes)           58/58
PASS  naked + chest + aura (aura rolls)                    59/59
PASS  naked + 2-piece Jubbans (set bonuses)                63/63
PASS  naked + runeword item w/ 2 runes (runes + runeword)  64/64
PASS  naked + socketed gem (gem fixed values)              59/59
PASS  naked + talent jewel socket + jewel (jewel affixes)  61/61
info  2.0.4 character corpus                               458/687  66.7%
```

Also 62/62 on the level-5 character. The corpus gap is now concentrated in
stacking - many sockets, multiple sets, augments - not in any unimplemented layer.

### The method that got us here: differential saves

One in-game character, saved repeatedly, adding **exactly one mechanic at a time**
from a naked baseline. Each save isolates one layer, so a mismatch names the broken
rule instead of lowering a percentage. Six of the seven fixtures found a real bug on
first run. This is drastically more effective than staring at a full build, where a
hundred contributions land in one number - I spent multiple sessions stuck on
"armour is wrong" before the first differential save, and it was solved in minutes
once isolated.

To add a fixture: unequip to the baseline, add one thing, `/save-all`, copy the
`.dat` into `naked214/`, add a line to `CASES` in `test_regression.py`.

### THE LESSON OF THIS PROJECT: match the version first

For most of the first session I extracted from the **server** (`C:\CTE2`, pack 2.0.4 /
MnS 6.4.7) and validated against a **client** save (pack 2.1.4 / MnS 6.4.13). That single
mismatch accounted for **17 of 19** unresolved stats. Re-extracting against the matching
version took the score from 43/62 to 60/62 with no code change at all. I had written up
the base-gear-scaling problem as "underdetermined, blocked on more data". It was not.
It was version drift.

Check the version of every save before treating any mismatch as an engine bug:
```
python -c "import re;print(re.search(r'modpackVersion = \"(.*)\"', open(r'<inst>/config/bcc-common.toml').read()).group(1))"
```
Known installs: `C:\CTE2` = 2.0.4 / MnS 6.4.7; the CurseForge instance
`Craft to Exile 2 - 2.0 Atlas Update` = 2.1.4 / MnS 6.4.13. Extract into a matching
`out` dir per version (`out` = 2.0.4, `out214` = 2.1.4) and pass `--out`.

Running a 2.1.4 character against 2.0.4 data still scores 44/62 — keep that as a
regression test for drift sensitivity.

---

## 1. Pipeline and where things live

Everything is re-runnable from the pack with no hand-edited data. That is a hard
rule: the project dies to version drift the moment someone hand-patches a value.

```
cd C:\CTE2\cte2-pob
python extract.py             # jar + datapack -> out/mmorpg_*.json      (5721 entries)
python extract_config.py      # pack configs   -> out/pack_config.json
python extract_core_stats.py  # jar bytecode   -> out/core_stats.json    (88 stats)
python build_graph.py         # grid -> nodes/edges -> out/talent_graphs.json
python render_tree.py         # graphs -> out/tree_*.svg
python scan_materials.py      # armour materials + weapon tiers -> out/materials.json
python scan_hidden_attrs.py   # items that override getAttributeModifiers
python read_character.py "<path to playerdata\<uuid>.dat>"   # -> out/character.json
python resolve.py             # rebuild stats, diff vs game
python resolve.py --why health   # per-stat contribution trace
```

`javap.py` is a constant-pool-resolving disassembler written for this project.
The earlier version only printed pushed constants, which hid every method call —
that is why the gear formulas were invisible for so long. Use `javap.py`.

`nbt.py` reads Minecraft NBT. Note the bug that cost an hour: in
`out[self.string()] = self.payload(tt)` Python evaluates the **right side first**,
so it read every tag's payload before its name. Always split that into two lines.

### Source data precedence

1. `Mine_and_Slash-*.jar` `data/mmorpg/**` — base game data (3182 entries)
2. `config/openloader/data/cte_mns/**` — CTE2 overrides (4638 entries, 2099 overrides)
3. `defaultconfigs/mine_and_slash*.toml` — pack configuration
4. Java bytecode — the ~25 code-defined core stats and all the formulas

`Library_of_Exile.jar` ships **zero** `mmorpg_*` data. It is pure engine code.

---

## 2. Formulas recovered from bytecode

All read from the jar, not fitted to data.

```java
// ExactStatData.fromStatModifier(mod, int percent, float level)
v = mod.min + (mod.max - mod.min) * percent / 100;

// Stat.scale(ModType type, float v, float level)
if (type.isFlat()) v *= stat.getScaling().getMultiFor(level);   // PERCENT/MORE never scale

// LevelScalingConfig.getMultiFor(float level)
lvl = cap_to_max_lvl ? Mth.clamp(level, 1, MAX_LEVEL) : level;
return base_scaling + per_level_scaling * (lvl - 1);
// NORMAL at level 5 = 1.0 + 0.2*4 = 1.8. Proven exactly by energy: 50 * 1.8 = 90.

// InCalcStatData.calcValue()
v = clamp((stat.base + Flat) * (1 + Percent/100) * [Multi if MULTIPLY_STAT],
          stat.min, stat.getHardCap());

// BaseStatsData.GetAllStats
percent = baseStats.p + gear.getQualityBaseStatsBonus();   // QUALITY int from mmorpg_custom_data, usually 0
// base gear stats scale at the ITEM's level, not the player's
// then IBaseStatModifier entries fold into the base stats they cover:
//   gear_defense -> armor, dodge_rating, magic_shield
//   gear_damage  -> weapon_damage

// GearData.<init>  — stat utilization
percentStatUtilization defaults to 100; if < 100 every stat on that item is
multiplied by percentStatUtilization/100. Only ever reduces. NOT implemented.
// CORRECTION: I originally wrote that this fires when you miss an item's stat
// requirements. It cannot - the game refuses to equip such items at all
// (confirmed in-game). Whatever triggers it is something else; mercenary gear
// (`mercgear` in player_data) is the likely candidate. Do not assume.

// CoreStat.affectStats — the attribute is TRUNCATED
int amount = (int) statData.getValue();       // 14.295 intelligence -> 14
getMods(amount) -> ExactStatData.levelScaled(amount * v1, stat, type, 1);
// Missing this skews every derived stat slightly high.

// InCalcStatData.add — MORE is MULTIPLICATIVE
Multi = Multi * (1 + v/100);   // starts at 1.0; two +50% MOREs give 2.25x
// Stat.<init> defaults multiUseType to MULTIPLY_STAT, so code-defined stats
// (mana, health, armor) honour MORE even though no datapack field says so.

// StatCompat.getResult — entity-level, integer-truncated
int v = (int)(entity.getAttributeValue(attr) * conversion);
v = clamp(v, minimum_cap, maximum_cap);       // GLOBAL caps, not per_item
// Reads the ENTITY total, not a per-item modifier. generic.max_health = 20
// -> magic_shield +10% on every character. Missing this was a silent 10%.

// CoreStat.affectStats
int amount = (int) statValue;                       // truncated
getMods(amount) -> ExactStatData.levelScaled(amount * v1, stat, type, 1);
// level 1 => core-stat transfers are deliberately unscaled

// PlayerStatUtils.addNewbieElementalResists
if (!newbieResists()) return empty;
amount = lvl<=24 ? 50 : lvl<=49 ? 25 : lvl<=74 ? 0 : -25;
for each single element except Physical: add(amount, FLAT, unscaled)

// InCalc.addVanillaHpToStats
Vanilla max health folded into `health` as already-scaled flat, clamped [0,500],
but ONLY when HEALTH_SYSTEM == VANILLA_HEALTH. This pack uses IMAGINARY, so off.
```

### Calculation order (`StatCalculation.calc`)

```
clearStats -> collectGemStats -> collectSpellStats -> + gear/perk/base contexts
-> CtxStats.addStatCtxModifierStats -> applyToInCalc -> addVanillaHpToStats
-> InCalc.modify (core-stat transfers only) -> calculate()
```

### Damage pipeline (`mmorpg_stat_layer`, 14 entries, all data)

| Priority | Layer | Action | Clamp |
|---|---|---|---|
| 0 | flat_damage | ADD | — |
| 1 | damage_conversion | CONVERT_PERCENT | 0–100 |
| 2 | ele_as_extra_flat | X_AS_BONUS_Y | 0–100 |
| 3 | additive_damage | MULTIPLY | min −1 |
| 5 | dot_dmg_multi | MULTIPLY | min −1 |
| 7 | crit_damage | MULTIPLY | min −1 |
| 9 | double_damage | MULTIPLY | fixed 2.0 |
| 99 | damage_taken_as | DAMAGE_TAKEN_AS | 0–100 |
| 100–102 | armor / physical / elemental mitigation | MULTIPLY | min 0.1 |
| 103 | damage_reduction | MULTIPLY | min 0.5 |
| 104 | damage_suppression | MULTIPLY | 0.5–1.0 |
| 200 | flat_damage_reduction | ADD | min −1000 |

Not implemented yet — this is the damage engine, step 3.

---

## 3. Pack configuration (this is a real input — read it first)

`defaultconfigs/mine_and_slash_compatibility-server.toml` sets
`COMPATIBILITY_PRESETS = "ORIGINAL_MODE"`, and that block decides:

| Setting | Value | Consequence |
|---|---|---|
| `BASE_STATS_DATAPACK` | ORIGINAL_BALANCE | use `original_mode_player` profile |
| `BALANCE_DATAPACK` | ORIGINAL_BALANCE | use `original_balance` |
| `HEALTH_SYSTEM` | IMAGINARY_MINE_AND_SLASH_HEALTH | vanilla hearts NOT added |
| `ENABLE_MINUS_RESISTS_PER_LEVEL` | true | the newbie resist ladder |
| `VANILLA_TO_WEAPON_DAMAGE_PERCENT` | 10.0 | vanilla damage feeds weapon_damage |
| `STAT_REQUIREMENTS_MULTIPLIER` | 1.0 | stat utilization |
| `SPELL_BASE_DAMAGE_MULTIPLIER` | 1.0 | damage engine |
| `DAMAGE_CONVERSION_LOSS` | 100 | damage engine |

**Lesson learned:** two of five stuck stat families were sitting in this TOML while
I reverse-engineered bytecode. Read configs before decompiling.

---

## 4. Talent trees — solved and verified

Trees are a **grid**, not a graph, which makes this much easier than PoE.

- `talents` 173x138, 4033 cells, **1322 nodes / 1609 edges**
- `ascendancy` 173x139, **244 nodes, 17 components**
- `atlas_passives` 173x138, **223 nodes**

Encoding: a cell holding a known perk id is a node; any other token is a
**connector-chain label** (`o` is the default wire; `k`/`p`/`u`/`n`/`i`/`j`… exist
so crossing wires don't splice). Adjacency is 8-way. `GridPoint.MAX_DISTANCE = 12`
bounds a wire walk. `[CENTER]` is a layout origin, deliberately unconnected —
the real roots are the 7 perks of type `START`.

There are **zero** direct node-to-node adjacencies; every link runs through a wire.

Verification that the parse is right:
- 1321/1322 nodes reachable from the 6 class starts (orphan is `[CENTER]`)
- ascendancy resolves to exactly **16 named classes** of 15–17 nodes each
  (gladiator, juggernaut, jester, chieftain, guardian, champion, hunter, trickster,
  necromancer, assassin, arcanist, lich, battlemage, ascendant, elementalist, raider),
  matching the 16 `ASC` perks

---

## 5. Character data

Mine & Slash stores everything as **Forge capabilities inside the player's own file**.
Verified: no `mmorpg_*` SavedData in `world/data/`.

```
<server or save>/world/playerdata/<uuid>.dat
  ForgeCaps:
    mmorpg:entity_data   level, exp, hp, and the 62 computed stats (mmorpg_unit)
    mmorpg:player_data   talents (grid coords), ascendancy, spells, stat points
    curios:inventory     equipped jewelry, gear NBT rides along
  Inventory              armor slots 100-103, held weapon, offhand -106
```

Gotchas:
- Forge only writes playerdata on **logout or world save**. Run `/save-all` first.
- `<uuid>.dat_old` is the previous rotation, useful as a fallback.
- `usercache.json` in the server root maps names to UUIDs.
- Backpack items also carry `mmorpg_gear` NBT — filter by slot or you inflate everything.

Item gear NBT shape:
```json
{"baseStats":{"p":45},"imp":{"p":5,"imp":"dusk_blade"},
 "affixes":{"pre":[{"p":26,"id":"crit_prefix"}],"suf":[{"p":52,"id":"of_gluttony"}],"cor":[]},
 "sockets":{"so":[],"sl":1,"rw":"","rp":0},"rar":"rare","lvl":3,"gtype":"sword"}
```
`p` is the 0–100 roll used in the lerp.

Test character currently used:
`C:/Users/shawn/curseforge/minecraft/Instances/Craft to Exile 2 - 2.0 Atlas Update/saves/Tester/playerdata/3e282e14-2520-49aa-988a-2a7f496a2976.dat`
Level 5 mage, 6 talent points, weapon + shield + ring, **no armour, no sockets,
no ascendancy, no supports**.

---

## 5b. Batch validation

`2.0.4chardataexamples/` holds six real 2.0.4 characters (levels 41–100, 7–10 gear
pieces, 63–219 talent points, 12–19 ascendancy allocations, 88–150 stats each).

```
python batch.py 2.0.4chardataexamples --out out
```
Runs every save and ranks failures by how many characters they fail on — a stat wrong
everywhere is one missing rule; a stat wrong on one character is usually that
character's gear. It also prints the game/ours ratio, and a *constant* ratio across
characters points straight at a single missing multiplier.

Current: 417/687 (60.7%). Per character: 46/82/64/73/62/50 %.
The level-100 builds score worst because they carry the most unimplemented layers.

### Implemented from this data
- **Socketed gems** — `mmorpg_gems`, with `on_armor_stats` / `on_jewelry_stats` /
  `on_weapons_stats` chosen by the base type's family tag
  (`weapon_family` / `jewelry_family` / else armour). Fixed values, no roll.
- **Runewords** — `mmorpg_runeword[sockets.rw].stats`, rolled with `sockets.rp`.
- **Unique gear** — `mmorpg_unique_gears[*].unique_stats`, rolled per-stat from
  `uniqueStats.perc[i]`. The item stores no unique id, so match on
  `base_gear == gtype`, disambiguated by `len(unique_stats) == len(perc)` and by
  `force_item_id` when set. 40 base_gear values have multiple uniques (ring has 40).
- **Infusions** — `ench: {en, rar}` resolves to an affix id; no roll is stored so it
  is taken at 100. **Unverified guess** — check this.

### MORE mods are multiplicative (fixed)

`InCalcStatData.add` for `ModType.MORE` does `Multi = Multi * (1 + v/100)`, starting
at 1.0 — a **product**, not a sum, so two +50% MOREs give 2.25x and not 2.0x.
And `Stat.<init>` defaults `multiUseType` to **MULTIPLY_STAT**, so code-defined stats
(mana, health, armor) honour MORE even though nothing in the datapack says so. I had
MORE summed and gated on a field those stats don't carry, so it never applied.

### Blood characters

`blood` is a MAJOR talent node, `blood_mage`:
```
blood_user                FLAT  1
hp_resto_to_blood         FLAT  100
blood_per_perc_of_health  FLAT  60
mana                      MORE  -100     <- zeroes the mana pool
```
With MORE fixed, `mana` is now **exact (0.000) on all five** blood characters.
`blood` is then a `one_to_other` derived stat: `blood = health * blood_per_perc_of_health/100`.
Verified: character 3e282e14 has health 12763.148 and blood 7657.889 = exactly 60%.

### The dependency chain to attack next

```
armor  ->  health  ->  blood
```
`health_per_perc_of_armor` feeds health from armor, and `blood_per_perc_of_health`
feeds blood from health. Armor fails on 6/6, so it poisons both downstream stats on
five characters. **Fix armor first — it is worth ~16 stat-checks on its own.**

On 5c6b388a (the cleanest character, 82.8%): armor game 348.775 vs ours 301.756.
`gear_defense` is nearly exact (3.1422 vs 3.122), and the percent side looks right,
so the gap is ~33 of **flat** armour that no equipped piece is currently supplying.
Suspect an unimplemented flat-armour source rather than a wrong multiplier.

### Sockets hold gems OR runes - and runewords are ordered

A socket entry `{g: <id>, p: <roll>}` may reference either registry:

- **gems** (`mmorpg_gems`) - stats are **fixed** `v1`, so `p` is *not* a roll
- **runes** (`mmorpg_runes`) - stats are **min/max ranges rolled by `p`**

Both split by the base type's family tag into `on_armor_stats` /
`on_jewelry_stats` / `on_weapons_stats`. Runeword items take runes only, never gems.

`mmorpg_runeword[rw]` carries an **ordered** `runes` list plus a `slots`
restriction (e.g. `stealth` = `[ita, fey]`, boots/chest only). A save only stores
`rw` when the game already validated the sequence, so *reading* a character is safe.
But when the planner lets someone **build** an item it must validate order and slot
itself, or it will display runewords that cannot exist. Distribution: 13 runewords
need 2 runes, 18 need 3, 16 need 4, 10 need 5, 3 need 6.

### CORRECTION: set bonuses ARE in the data

An earlier version of these notes claimed set bonuses were code-defined and absent
from the datapack. Wrong - they are in **`mmorpg_sets.json`**, extracted all along,
I had simply never read that file. I checked `mmorpg_unique_gears` and the registry
type list and concluded too early.

```json
{"id":"jubbans_legacy",
 "uniques":["jubbans_dream","jubbans_embrace","jubbans_comfort","jubbans_path"],
 "bonuses":[{"pieces":2,"stats":[{"stat":"increase_healing","type":"FLAT","min":20,"max":20}]},
            {"pieces":3,...},{"pieces":4,...}]}
```
Bonuses are **cumulative**: 3 pieces grants both the 2- and 3-piece tiers. Matching
is by counting equipped uniques whose guid is in the set's `uniques` list.
`increase_healing` is the stat the game calls **Heal Strength**.

### Held items are not automatically weapons

`SelectedItemSlot` tells you what is in hand, but a chestplate carried in the hotbar
contributes nothing. Only count a held item when its base gear type carries
`weapon_family` or `offhand_family`. Trusting the slot alone double-counts armour -
this silently inflated stats across the whole corpus.

### Still missing (ranked by systematic failure)
`armor`, `health`, `magic_shield`, `mana_regen`, `blood`, `chaos_resist`,
`critical_hit`, `energy_regen`, `fire_resist`, `increase_healing`, `lightning_resist`,
`summon_damage` all fail on 5–6 of 6.

### player_data holds four more stat sources beyond gear

`read_character.py` now extracts these; all four were populated on the level-100
characters and completely absent from the level-5 test character.

| Field | Shape | Status |
|---|---|---|
| `buffs.map` | `{TYPE: {id, stats:[{v1,type,stat,scaled}], ticks}}` | **implemented** — literal stats, POTION/MEAL/FISH etc. |
| `jewels` | items with `mmorpg_jewel` = `{affixes:[{p,id}], cor, uniq, style, lvl, rar}` | **implemented** — same rolled-affix machinery as gear, at the jewel's own level |
| `auras` | items with `mmorpg_skill_gem` = `{id, type:AURA, perc, rar, links}` | **implemented** — `mmorpg_aura[id].stats` rolled by `perc`; `reservation` is spirit cost, not a stat |
| `gems` | same shape, `type:SUPPORT` | extracted; **deliberately NOT applied globally** |

**Support gems are spell-scoped, not global — measured, not assumed.** Applying their
stats to the unit sheet drops accuracy from 64.2% to 61.9% across six characters, so
`resolve.py` keeps `Rules.support_gems_global = False`. This fits `StatCalculation.calc`
taking a `Spell` argument: the sheet is computed per-spell, and the stored
`mmorpg_unit` is the spell-independent one. They will matter for the damage engine.

**All input sources are now extracted.** Remaining error is calculation correctness,
not missing data.

Score progression across this work: 56.9% -> 60.7% (gems/runewords/uniques)
-> 61.4% (MORE fix) -> 63.5% (buffs + jewels) -> **64.2%** (auras).

### Spell schools

`mmorpg_spell_school` holds each school's perk grid (`perks: {id: {x,y}}`) plus
`lvl_reqs`. The allocations live in `player_data.asc.allocated_lvls` and every one
resolves against `mmorpg_perk` — already implemented and verified
(`p_armor_per_mana` -> `armor_per_perc_of_mana` 1.0, exact).

`phys_to_chaos` is **still unexplained**: the game reports exactly **50** on four
characters where we produce 0, and 151.86 vs our 100 on the fifth. It is a generated
stat (`PhysicalToElement`, scaling NONE, min 0, no base), so the 50 is an external
source. Ruled out so far: the stat's own base/min, dimension stats (those are
mob-side), spell-school perks, and gear affixes. Still unchecked: `mmorpg_exile_effect`
(active buffs), `mmorpg_aura`, and support gems.

Leads worth chasing first:
- `phys_to_chaos` ratio is a **constant 1.519** across all 5 — one missing multiplier.
- `mana` ratio 0.000 on 5 of 6: the game reports ~0 while we produce a large value.
  Several characters have a `blood` stat, so MnS has alternate resource types
  (blood/energy instead of mana) that presumably zero the unused pool. Not modelled.
- Ratios spanning <1 and >1 on resists suggest a missing per-character source
  (auras? buffs? `mmorpg_aura`, `mmorpg_exile_effect` and support gems are all
  still unimplemented).

## 5c. In-game test protocol (the decisive one)

The `.dat` **already contains the game's computed sheet** (`mmorpg:entity_data` ->
`mmorpg_unit`). No screenshots or written expected values are needed — the save is
self-validating. Just label it with the pack version.

Aggregate saves have a structural problem: a level-100 character stacks eight gear
pieces, jewels, auras and buffs, so one wrong rule is indistinguishable from another.
The fix is a **differential pair** on one character:

**A — naked baseline.** Unequip everything: armour, weapon, offhand, all curios,
jewels, auras. `/save-all` (or log out). Send the `.dat`.
> Isolates base + talents + ascendancy + buffs. Anything still wrong here is
> non-gear. Critically, it settles `phys_to_chaos`: if it still reads 50 with no
> gear on, the source is base/talents, and if it drops to 0 it was gear after all.

**B — plus exactly one item.** From naked, equip **one** piece (a plain rare
chestplate is ideal — no sockets, no runeword, no unique). `/save-all`. Send it.
> B minus A is that single item's exact contribution. That converts the armour
> problem from "8 items aggregate to the wrong number" into "this one item should
> give X and gives Y", which is directly checkable against `gear_stats()`.

**C — optional third.** From B, add a second item with a socket + gem.
> Isolates the socket path the same way.

Nothing needs to be created or edited by hand — these are ordinary in-game actions on
an existing character, and the save can be copied back afterwards to undo.

## 6. What's blocked, and why

**Base gear stat scaling is underdetermined with two items.** Affixes and implicits
reconcile *exactly* (`accuracy`, `mana`), so item-level + NORMAL scaling is right for
those. Base gear stats need a different multiplier per item and no config rule
produces both:

- shield (ilvl 4, common): `block_chance` needs ×2.0, NORMAL@4 = 1.6
- sword (ilvl 3, rare): `weapon_damage` needs ×1.89, NORMAL@3 = 1.4

Rarity doesn't reconcile them (2.0/1.0 vs 1.89/1.3). A consistent factor of two
appears pointing in inconsistent directions: `block_chance` 2× low, `gear_defense`
2× high, `crit_prefix` 2× high. Two samples cannot distinguish the candidate rules.

**Do not fit a curve to this.** Get more gear.

### Remaining 19, grouped

| Group | Stats | Notes |
|---|---|---|
| Base gear scaling | armor, block_chance, weapon_damage, gear_defense | needs armour pieces |
| Regen | health_regen, magic_shield_regen, mana_regen, energy_regen | `health_regen` fits *exactly* as `2.5×1.8×1.8 + str(8×0.2) = 9.7`; same double-scale fits magic_shield_regen. Hypothesis: verify in bytecode |
| Offence residue | critical_damage (+6.08), elemental_attack_damage, total_damage (+0.8) | `total_damage`: vanilla conversion alone gives exactly 3.0 = game, but strength independently adds 0.8. One of the two is wrong |
| Derived | attack_cast_speed, weapon_skill_cdr_per_attack_speed (25 vs 80) | cdr is upstream; fix it and attack_cast_speed follows (1.5×0.8=1.2) |
| Misc | health (−16.64), elemental_resist (clamp?), health_leech_cap, max_beast_summons, attack_damage, resource_on_basic_hit | |

`health_on_kill` is produced but absent from the game sheet — a real lead on the
offence group, since the same weapon's prefixes clearly do apply.

---

## 7. What to collect next

In priority order. Two or three *different* characters beat one maxed character,
because the differences isolate variables.

1. **All armour slots filled** — four more base-stat samples. Most likely to crack
   the factor-of-2 outright.
2. **Sockets with gems, and a runeword** — three untested container paths.
3. **Ascendancy points spent** — graph parsed but unverified against real allocation.
4. **Support gems on a skill** — completely untested, and it's the damage half.
5. **High level** — a wrong per-level term is invisible at 5, enormous at 100.
6. **A second class (str-based)** — isolates the core-stat transfer tables.

**Also run the KubeJS dump.** `kubejs/server_scripts/dump_item_attributes.js` →
copy to `<pack>/kubejs/server_scripts/`, `/reload`, then `/kubejs_dump_item_attributes`.
Output goes to `kubejs/exported/item_attributes.json`; copy into `out/`.
This is a **required** input — `total_damage` and `gear_defense` cannot be computed
without vanilla item attributes, and those live in each mod's Java, not in any file.
`out/item_attributes.json` currently holds one hand-seeded entry (the test sword,
read from bytecode) purely to exercise the code path. Replace it with the real dump.

If characters come from the public server rather than this install, **check the pack
version matches** before treating id mismatches as engine bugs.

---

## 8. Vanilla ↔ MnS conversions (`mmorpg_stat_compat`, 72 entries)

Only five vanilla attributes ever reach the MnS sheet:

| Attribute | → stat | Rate |
|---|---|---|
| `generic.attack_damage` | total_damage | ×0.5 FLAT |
| `generic.armor` | gear_defense | ×0.1 PERCENT |
| `generic.armor_toughness` | gear_defense | ×0.1 PERCENT |
| `generic.max_health` | magic_shield | ×0.5 PERCENT |
| `generic.luck` | magic_find | ×3.0 FLAT |

**The conversion is integer-truncated.** `StatCompat.getResult`:

```java
int v = (int)(en.getAttributeValue(attr) * conversion);   // truncated
v = MathHelper.clamp(v, minimum_cap, maximum_cap);        // GLOBAL caps, not per_item
if (v != 0) v = (int) scaling.scale(v, level);
```

It reads `getAttributeValue` — the entity **total**, not per-item — so all equipped
gear counts. But the cast changes everything:

- `generic.armor` at 0.1 needs **10 total vanilla armour per 1** of `gear_defense`.

  **UNRESOLVED.** Swapping a 10-armour/5-toughness chest for a 3-armour leather chest
  left the in-game Armor stat identical at 3328. Two hypotheses both fit and are not
  yet separated:
  1. the contribution is genuinely below display resolution (truncation, plus
     `gear_defense` folding only into the base-gear slice that affixes dominate);
  2. the sheet was stale — `CachedPlayerStats` holds three `DirtySync` caches
     (`ALLOCATED`, `ENCHANT_COMPAT`, `STAT_COMPAT`) plus an `equipmentCache`, each
     recalculated only via `onTickTrySync` when marked dirty.

  **Test to settle it:** equip chest A, `/save-all`, `read_character.py` the .dat and
  note `armor`; swap to chest B, `/save-all`, re-read, diff. That reads the stored
  capability instead of the tooltip. Also try full set vs naked for a large delta.
- Sword ATTACK_DAMAGE is `3 + tier bonus`, so after truncation:
  wood/gold 3.0→**1**, stone 4.0→**2**, iron 5.0→**2**, diamond 6.0→**3**,
  netherite 7.0→**3**. Netherite and diamond are identical; so are stone and iron.

An earlier version of these notes claimed netherite gave +3.5 vs iron's +2.5. That was
wrong — it ignored the cast. The test sword (6.0 → 3.0) happened to land on an integer,
which is why it matched exactly and hid the truncation.

Which items can be which gear type is fixed by `gear_compatibility` in
`mine_and_slash-server.toml`.

27 enchantments also convert, each with a per-item and a global cap
(e.g. `fire_protection` → `fire_resist` FLAT 2.0/level, per-item cap 12 so level VI
is the last useful one, global cap 36). Full table in `out/mmorpg_stat_compat.json`.

**Knockback resistance, movement speed and attack knockback do NOT convert.** Every
genuinely hidden gear side effect in this pack is one of those three, so they are
real in play but invisible to any build planner. 11 armour materials carry knockback
resistance; Terrasteel computes it as `defense/20` in the item class instead.

Published references:
- Enchantment conversions — https://claude.ai/code/artifact/c8dc4615-800b-472d-9002-26ce74cb2815
- Gear side effects — https://claude.ai/code/artifact/44891dfa-0fe3-421b-b690-030fd0129a4b

---

## 8b. The planner UI (step 4, done)

Published: https://claude.ai/code/artifact/031b83eb-962f-404e-bfa6-57ce84eed767

Layout is deliberately Path of Building's: persistent left stat sidebar, top tab
strip (Tree / Items / Skills / Calcs), tree as the dominant pan/zoom canvas. The
first attempt was a tabbed document-style report and was rejected on exactly that
point - "this isnt really like path of building at all though".

    export_build.py  ->  out214/build_bundle.json   (198 KB)
    engine.js        ->  browser port of resolve.py's tail
    ui/page.html     ->  template with __ENGINE__ / __BUNDLE__ placeholders
    build_ui.py      ->  inlines both, emits the 226 KB page

### Why the browser needs an engine at all

Clicking a talent node has to move the whole sheet, so the page cannot ship
resolved totals. `engine.js` re-runs only the ORDER-SENSITIVE tail of `resolve()`:

    perk contributions  ->  aura_effect read  ->  auras x mult
    ->  elemental_resist transfer + clear
    ->  core-stat transfer (with the int truncation)
    ->  derived stats in priority order

Everything the tree cannot change - gear, buffs, jewels, attribute compat, set
bonuses, newbie resists - arrives pre-resolved as a flat contribution list,
harvested from `sheet.why` by excluding the sources the tail recreates
(`perk:`, `aura:`, `transfer:`, `cleared`, `core:`, `derived:`).

### Verified, not assumed

Recomputing the shipped allocation in JS reproduces all 69 Python stats to 1e-6.

That check earned its keep immediately. **Perk ids repeat across many nodes** - the
same "+1 intelligence" perk sits on dozens of them. Keying allocation by perk id
(a Set) instead of by grid coordinate collapsed the duplicates and silently lost
9 intelligence plus everything downstream. `recompute()` therefore takes a LIST of
perk ids, one entry per allocated node, duplicates intact.

### Allocation rules enforced in the page

* a node must connect back to a `START` node through allocated nodes
* removing a node may not orphan the rest (BFS from the starts each time)
* point budget from `player_points.TALENTS`: base 1 + 1.0/level, cap 200
  -> 101 at level 100. The reference save spends 15.

### Not done

* tree edits are live-only; there is no write-back to a `.dat`
* Items tab is read-only - gear is pre-baked into the contribution list, so
  editing gear means porting `gear_stats()` to the browser too
* DPS is not in the sidebar: the damage engine is validated but the
  stat -> pipeline-multiplier mapping is still unknown (see section 6)

---

## 8c. Version updates - the one command

    python update.py --check          # what version is on disk, change nothing
    python update.py                  # rebuild everything, then report drift
    python update.py --out out215 --prev out214    # side by side, with formula diff

Runs extract -> config -> core stats -> talent graphs -> lang -> item catalog ->
vanilla gear -> tree art -> build bundle -> page, then the regression fixtures
and the page smoke test, then diffs the new manifest against the old.

**`--pack` must be the CLIENT instance.** The server at `C:\CTE2` runs an older
Mine_and_Slash (6.4.7 / pack 2.0.4) than the client (6.4.13 / 2.1.4). The first
version of update.py let extract.py fall back to its default and silently
downgraded `out214` to 2.0.4 data - the same mismatch that once cost a day of
debugging. The drift report caught it immediately, which is the point of having
one; update.py now passes the client path explicitly.

What a real update looks like in the report:

    + source Mine_and_Slash-1.20.1-6.4.13.jar (3270 entries)
    - source Mine_and_Slash-1.20.1-6.4.7.jar gone
    ~ mmorpg_value_calc   253 -> 312   (+59)
    + category mmorpg_sets (10)

`--prev` additionally diffs the engine constants - the scaling configs,
MAX_LEVEL, MAX_BONUS_SPELL_LEVELS, player_points, and every rarity's
stat_percents / base_stat_percents / min_affixes. Those are the values that
rewrite every number in the planner without changing any file count.

### Point budgets, measured not assumed

| Pool | Rule | Evidence |
|---|---|---|
| Talents | `1 + level + quest points`, quest points 0-25 | six saves; gap over base+level ran 10-24, never above `max_bonus_points` 25 |
| Ascendancy | **9**: `base 0 + max_bonus 9` | both level-100 saves allocate exactly 9 ASC-grid nodes |

Two traps. A TALENTS start node is free - every character has exactly one and it
is not paid for - so spend is `allocated - 1`. An ASCENDANCY entry node is NOT
free: it costs one of the 9, so it is 1 into the class node and 8 outward, which
is what the saves show. And the config's `max_total_points` (200 talents,
10 ascendancy) is a ceiling, not the grant.

---

## 8d. MnSDummy - a third-party lead on the damage engine

`mods/MnSDummy-1.20.1-1.0.3.jar` is a community addon, not part of CTE2 and not
authoritative about anything. Its value is that it is an in-game DPS parser, so
it had to find the MnS API that exposes a hit's breakdown - and it names two
methods this project had not used:

    DamageEvent.getSortedLayers()   -> List<StatLayerData>, the layer stack
    DamageEvent.getMoreMultis()     -> List<EffectEvent$MoreMultiData>

**`getMoreMultis()` is the gap in our damage model.** `damage.py` walks
`mmorpg_stat_layer` and nothing else, but MORE multipliers are a SEPARATE
parallel list, each carrying its own `multi` float and a display label, fed by
`DamageEvent.addMoreMulti(Supplier, String, float)`. The datapack layer table
never mentions them. That is very likely why the stat -> multiplier mapping has
stayed unsolved: half the multipliers were never in the table being read.

`DamageCapture.collectLines` shows the shape of a full breakdown:

    for (StatLayerData l : ev.getSortedLayers())
        if (!l.numberID.equals(EventData.NUMBER)) continue;
        line(l.getLayer().getTooltip(ev, l), l.getMultiplier());
    for (MoreMultiData m : ev.getMoreMultis())
        if (!m.numberid.equals(EventData.NUMBER)) continue;
        line(m.getText(), m.multi);

Both lists are filtered to `numberID == NUMBER`, i.e. the main damage number
rather than a side channel. Next damage session should start by disassembling
`addMoreMulti` and `MoreMultiData`, and by finding every caller of
`addMoreMulti` - each one is a stat feeding a multiplier.

The mod also confirms two testing facts worth knowing before capturing tooltips:
vanilla grants 10 ticks of invulnerability after a hit, so hits closer than that
only land their excess over the previous one; and its config defaults the dummy
to the placing player's level.

---

## 8e. The stat -> multiplier map (step 1, SOLVED)

`python export_damage_map.py` -> `out214/damage_map.json`

MnSDummy pointed at `DamageEvent.getMoreMultis()`. Following it to the four
classes that call `addMoreMulti` landed on the one that matters,
`BaseDamageIncreaseEffect.activate`, which does BOTH halves in one place:

    dmg.getLayer(StatLayers.Offensive.ADDITIVE_DMG, EventData.NUMBER, side)
       .add(statData.getValue());
    if (stat.getMultiUseType() == MultiUseType.MULTIPLICATIVE_DAMAGE)
        dmg.addMoreMulti(stat, EventData.NUMBER, statData.getMoreStatTypeMulti());

So a damage stat contributes in up to two places at once:

| part | where it goes | how it combines |
|---|---|---|
| `StatData.getValue()` — base + flat, times 1 + percent/100 | the `additive_damage` layer, one MULTIPLY at priority 3 | summed with every other such stat, then applied once |
| `StatData.getMoreStatTypeMulti()` — the running product of (1 + v/100) over the stat's MORE mods | `getMoreMultis()`, the parallel list | multiplied in separately |

The second column is what `damage.py` was missing. It is not a hidden table:
the stats that reach it are exactly those whose `multiUseType` is
MULTIPLICATIVE_DAMAGE, which is a field already in `mmorpg_stat.json` and
already tracked by `resolve.py` as `Sheet.more`.

**Which stats participate at all** is declared in the datapack: any stat whose
effect list contains `_additive_damage_number_add_stat_data`.

    219 stats feed the damage stack
      179 also produce a MORE multiplier
       40 are additive only
        3 apply unconditionally, 216 are gated

**Whether one applies to a given hit** is its `ifs` - named entries in
`mmorpg_stat_condition`, and they are declarative, not code:

| condition kind | n | evaluated against |
|---|---|---|
| `spell_has_tag` | 46 | the spell's `config.tags` — already in `skills.json` |
| `effect_has_tag` | 12 | active exile effects on the caster |
| `wep_type_match` | 12 | the equipped weapon's `weapon_type` |
| `string_matches` | 11 | an event field, e.g. `attack_type == dot` |
| `ele_match_stat` | 2 | the stat's `ele` vs the hit's element |
| the rest | 1-4 each | day/night, dual wield, target hp, combat state |

Every one of those is answerable from data the planner already holds, except
the runtime ones (target hp, day/night, in combat) which belong in a Config tab
the way Path of Building handles them.

### What is left

1. Evaluate the conditions per (spell, element) pair - a pure function over
   `skills.json` + `damage_map.json` + the sheet.
2. Sum the values of every passing stat into the additive layer; multiply the
   MOREs of every passing MULTIPLICATIVE_DAMAGE stat.
3. Run the existing `Pipeline` in priority order with the additive layer filled.
4. Validate against MnSDummy: it prints the labelled layer list AND the MORE
   list for a single hit, so one dummy hit per skill is a complete fixture.
5. Model the routing layers still stubbed in `damage.py`: CONVERT_PERCENT,
   X_AS_BONUS_Y, DAMAGE_TAKEN_AS. Conversion is already understood (section on
   Venom/Brutality); the other two are not.

The sidebar Damage block is already shaped to receive the result - it shows
exact base damage per skill and the stats feeding the stack, with Total DPS
held at em dash until the above lands.

---

## 8f. Generating test characters

    python nbt_rw.py                       # prove the writer, 16/16 byte-identical
    python make_save.py --list             # the recipes
    python make_save.py --recipe naked --install

`nbt_rw.py` is a typed NBT reader/writer. `nbt.py` reads into plain dicts, which
cannot be written back: a Python int cannot say whether it was BYTE, SHORT, INT
or LONG, and an empty list has lost its element type. The contract is not "it
parses" but **read then write returns the original bytes**, asserted over every
save here before `make_save.py` is allowed to run at all.

What makes this cheap: Mine & Slash stores its player data as JSON strings
inside the NBT - `mmorpg:player_data/tals`, `/casting`, `/asc`, and
`mmorpg:entity_data/level` - so a save is edited precisely without re-encoding
anything the mod owns.

`--install` backs up the existing playerdata with a timestamp before copying.
Log OUT before installing; the server writes the character on logout and would
overwrite it.

### The damage protocol

Each recipe isolates one term of `damage = base x (1 + additive/100) x MORE...`:

| recipe | what it adds | what the hit proves |
|---|---|---|
| `naked` | nothing past the class start | base damage with an empty stack |
| `one_more_node` | `summoner`: total_damage MORE -25 | one MORE multiplier, x0.75 |
| `two_more_nodes` | + `tormentor`: total_damage MORE -10 | **whether MOREs multiply or add** |
| `elemental` | Bolt instead of Double Strike | element routing, ele_match_stat |
| `level_60` | level 60 baseline | level scaling of base damage |

`two_more_nodes` is the one that matters: multiplying gives 0.75 x 0.90 =
**0.675**, adding gives 1 - 0.35 = **0.65**. A 3.8% gap, unambiguous in a
tooltip.

Node selection is condition-aware. A candidate perk is rejected if it grants any
damage stat whose conditions cannot be evaluated for the test skill, so the
delta between two saves is always attributable. The routes deliberately run
through plain attribute nodes (int/dex/str), which add no damage stats.

### Two bugs this shook out

**`threat_generated` was in the damage map.** It carries
`_additive_damage_number_add_stat_data` like a real damage stat, but on the
`on_gen_threat` EVENT, not `on_damage`. Filtering on the effect alone put 41
stats in the map that never touch a hit - 219 fell to 178, and the conditions
needing modelling fell from 103 to 75. Always check `events`, not just
`effects`.

**The first node picker chose `minion_catapult` and `curse_master`** - MORE
stats gated on minions and curses, which a plain Double Strike would not move at
all. A recipe that changes nothing proves nothing.

---

## 8g. Code review - correctness and speed

`python perf.js <built.html>` times each paint separately. Run it after any UI
change; the engine has never been the bottleneck and probably still is not.

### Bugs found

**Cast speed was a hand-written list of two stats.** 39 stats declare
`add_cast_speed_perc`, one per spell tag. `faster_attacks` grants
`weapon_skill_cast_time`, which was in neither of the two, so the gem did
nothing. Enumerated from the data now, like damage. Double Strike rank 20:
2.15 -> 3.35 hits/sec with the gem linked.

**Negated conditions were unhandled.** Every one of those 39 is gated on
`spell_has_tag_not_affected_by_cast_speed_is_false`. Any condition can take an
`_is_false` form with the same serialiser, so negation is handled once, by id,
rather than per case.

**`string_matches` on `style` fell through to false.** `style_is_int_is_false`
then negated to true - the right answer for a dex skill by accident and the
wrong one for an int skill. `attack_damage` now correctly applies to Double
Strike and not to Charged Bomb, where `int_dmg` applies instead.

**Four damage stats are declared in Java, not the datapack**, so scanning
`mmorpg_stat.json` missed them: `spell_damage` (SkillDamage, when isSpell),
`hit_damage` (HitDamage, when the hit carries no ailment), `ailment_damage` and
`all_ailment_damage`. All extend BaseDamageIncreaseEffect and behave exactly
like the datapack ones.

**Flat elemental adds were ignored entirely.** `flat_fire_added_damage` and its
siblings route through `DamageEvent.addBonusEleDmg`, so the added amount becomes
its OWN bonus-element hit with its own multiplier stack - the same path
conversion takes. They are extra parts of the hit, not a bigger main number.
`chaos_flat_dmg` linked to Double Strike is +17 DPS as a separate chaos hit.

**`threat_generated` was in the damage map.** It carries the damage effect on
the `on_gen_threat` event, not `on_damage`. 219 stats fell to 178 once events
were checked.

### Speed

A dragged slider queued a 64ms rebuild per input event, which is what the input
lag was. Frame cost now 20ms, and coalesced:

| | before | after |
|---|---|---|
| paintSidebar | 29.8ms | 1.6ms |
| paintSkills | 15.2ms | 7.3ms |
| paintCalcs | 7.1ms | 4.3ms |
| apply() per event | 64.5ms | one rAF |

* `paintSidebar` ran a `document.querySelector` per stat, every repaint - 69
  lookups over a large DOM. The nodes never change, so they are cached.
* `apply()` is coalesced into one animation frame, so a burst of input events
  collapses into a single repaint.
* The rank slider repaints only the skill cards while dragging and does the
  full recompute on release.
* `paintSkills` bound handlers with document-wide selectors; scoped to `#skills`.
* The augment dropdown is rebuilt only when the augment set changes.

The engine itself: a full sheet recompute is **0.10ms**, `damageStack` 0.02ms,
`skillDps` 0.06ms. Nothing there needs optimising.

---

## 9. Roadmap

1. **Finish the stat engine** — unblock with the saves above, target 62/62.
2. **Damage engine** — base damage is exact (Charged Bomb 220, Bolt 107), the layer
   order is confirmed, and as of section 8e the stat -> multiplier map is solved and
   exported. Remaining: evaluate the conditions per skill, fill the additive layer,
   multiply the MOREs, and validate against MnSDummy.
3. **App** — done as a planner, see section 8b. Remaining: editable gear, ascendancy
   allocation, live DPS, import/export build codes.
4. **Version-update drill** — point the extractors at the new pack and diff manifests.
   The user has a newer version ready to test this with. Worth doing early-ish: if an
   update moved a formula, better to learn that before building more on top.

### Known pack bugs found along the way

Five files share an id with another file, so the second silently shadows the first
(the game loses the same data the extractor does). Full detail in `out/collisions.json`.

| Category | Duplicated id | Dead file |
|---|---|---|
| affixes | `necromancers_scythe` | `implicit/necromancers_scythe.json` |
| entity | `undergarden` | `all_mobs_in_mod/mowziesmobs.json` |
| entity | `minecraft:zombie` | `specific_mobs/minecraft_husk.json` |
| stat | `fishing_bar_size` | `mmorpg_stat/fishing_bar_size.json` |
| stat_condition | `spell_has_tag_not_pull` | `spell_has_tag_not_pedipalps.json` |

### Biggest project risk

Version drift. PoB survives on a large community; a solo CTE2 clone rots within a
patch or two unless every input stays automated. Nothing in `out/` is hand-written
except the placeholder `item_attributes.json`. Keep it that way.

---

## 10. Where to pick up (as of Version 27)

### State

Published: `https://claude.ai/code/artifact/031b83eb-962f-404e-bfa6-57ce84eed767`

Tabs are Tree / Class / Items / Skills / Vanilla gear / Config / Calcs. The Class
tab is new and is now the source of truth for which skills exist and at what rank:
points in a school's skill perk *are* that skill's rank, passives feed the sheet as
`v1 * points`, row `y` is gated by the school's `lvl_reqs[y]`, and the save's static
`asc:` contributions are filtered out of `BASE_CONTRIBS` so nothing is counted twice.

Health with the save's own allocation is bit-identical to before the change
(1771.245); deselecting Fighter drops it to 1703.1 as `p_health_war` stops applying.
`node smoke.js <built.html>` is 14 checks. `node perf.js <built.html>` for timings.

### Next, in the order worth doing them

1. **Validate the damage stack in game.** This is the big one and everything else is
   guesswork until it is done. Base damage is exact (Bolt 107, Charged Bomb 220) but
   no multiplier has ever been checked against a real hit. `make_save.py` has the
   recipes (`naked`, `elemental`, `bolt_physical`, `level_60`); `--install` backs up
   first and `--restore` puts it back. Method: install a recipe, hit MnSDummy, read
   the number, compare to `skillDps`. One skill, one support at a time.
2. **`magic_shield_regen`, 101.56 vs 259.18.** New find, browser-only: `resolve.py`
   gets this stat exact and the JS port does not, so it is a gap in `engine.js`'s
   port rather than a rules question. Cheapest real bug on the list.
3. **`weapon_damage`, 64.07 vs 64.48** (0.64%). Long-standing. It makes Bolt read
   106 instead of 107 through integer truncation, so it is visible, not cosmetic.
4. **Class buffs on the skills themselves.** The Class tab currently applies passive
   perk stats. Skill perks may also carry non-`learn_` modifiers; confirm against
   `mmorpg_perk.json` and fold any in.
5. **Mob rarity mitigation.** Boss / uber / pinnacle currently apply no resistance at
   all, so DPS against them reads high.
6. **Three unmodelled condition kinds** in the damage map: `effect_has_tag`,
   `either_is_true`, `is_under_exile_effect`.
7. **Ailments and damage over time.** Not modelled at all.
8. **Build export / import.** The profile name and level are already stored for this;
   the codes are not written yet. Wants the Class tab's `classes` + `classAlloc` in
   the payload now, not just tree and gear.

### UI rebuild: make the Class tab look like the game

Requested after Version 27 - the current grid of text cards is hard to read. The
in-game screen is `SpellSchoolScreen`, and everything needed to reproduce it is
already on disk. Layout constants, straight out of the bytecode:

| Thing | Value | Where |
|---|---|---|
| panel size | 250 x 233 | `SpellSchoolScreen.sizeX/sizeY` |
| panel background | `gui/asc_classes/background.png` | `SpellSchoolScreen.BACKGROUND` |
| slot spacing | 21 px | `SpellSchoolScreen.SLOT_SPACING` |
| button size | 18 x 18, icon 16 x 16 inside | `LearnClassPointButton.BUTTON_SIZE_X/Y` |
| skill frame | `gui/spells/slots/spell.png` | `LearnClassPointButton.SPELL_SLOT` |
| passive frame | `gui/spells/slots/passive.png` | `LearnClassPointButton.PASSIVE` |
| allocated overlay | `gui/spells/slots/overlay.png` | `LearnClassPointButton.OVERLAY` |

The position formula, and the part the current UI gets wrong:

```
x = guiLeft + 12  + perk.x * 21
y = guiTop  + 178 - perk.y * 21          <-- minus: y grows UPWARD
```

So row 0 sits at the BOTTOM and row 6 (level 30) at the top - it reads as a tree
growing upward, not a table. The present tab sorts y ascending top-down, which
inverts it. It is also one single panel, not two: columns 1-6 are the skills and
8-9 the passives (column 7 is the gap between them), so splitting them into two
labelled sections is wrong too.

Icons, all already in place and keyed by the ids the exporter emits:

* skills - `gui/spells/icons/<spell id>.png`, 370 files
* passives - `gui/spells/passives/<perk id>.png`, matches `p_health_war` etc. exactly
* class art - `gui/asc_classes/class/<school>.png` and `background/<school>.png`

Note the class art is split across both sources: six schools ship in the jar
(hunter, minstrel, shaman, sorcerer, warlock, warrior) and the other six only in
the pack's openloader resources (brawler, chronomancer, crusader, cryolancer,
rogue, sanguimancer), which also overrides `background.png`. Same jar-then-pack
layering `export_lang.py` already does - do not read one without the other.

The render code also uses alpha 0.7 / 0.5 / 0.3, which is presumably the dim for
locked and unaffordable slots; worth confirming before copying the numbers.

Plan: a new `export_spell_art.py` modelled on `export_tree_art.py` (which already
does exactly this job for the talent tree - base64 the PNGs into a JSON the page
inlines, since the artifact host serves no images), then rewrite `ui/classes.js`
to draw the real panel. The data model behind it does not need to change; this is
presentation only.

### Character import: the user plays on a SERVER

Settled 2026-09-14. The user plays Craft to Exile 2 multiplayer, so the obvious
path - drag `saves/<world>/playerdata/<uuid>.dat` onto the planner - is dead for
them. Their character never touches their own disk.

The way in is the CLIENT copy, and it turns out to be complete enough:

```
PlayerData.buildNBT()        = writeCommon + writeCharacterItems + uniquecoll
PlayerData.buildClientNBT()  = writeCommon                       <-- sent to client
```

and `writeCommon` writes `tals` (talents), `asc` (school order + allocated_lvls),
`casting` (spell loadout), `stats` (stat points), `points`, `gems`, `jewels`,
`auras`, `buffs`, `config`, `profs`, `proph`, `teams`, `mercs`, `atlas`, `favor`.

So the entire CHOSEN side of a build is already in the client's memory on any
server. Only `writeCharacterItems` (character-slot items) and `uniquecoll` are
server-only, and neither feeds the stat sheet. Equipped gear is not in the
capability at all - it rides on the inventory item stacks as `mmorpg_gear` NBT,
which the client obviously has - so `read_character.py`'s existing two-part read
(capabilities + walk the inventory) maps straight onto the client too.

Accessors, both public statics:

```
Load.player(player) -> PlayerData   .serializeNBT() / .buildClientNBT()
Load.Unit(player)   -> EntityData   .serializeNBT()
```

`serializeNBT()` returns exactly the .dat structure, so whatever the exporter
emits is consumed by the existing pipeline with no new parsing.

### Delivery: a client-side KubeJS script, not a mod

The pack already ships kubejs-forge 2001.6.5, rhino and architectury, and
`kubejs/server_scripts/dump_item_attributes.js` in this repo is a working
precedent for `Java.loadClass` + `JsonIO.write`.

The one constraint found: KubeJS client events are only `init`, `lang` and
`tick` - there is NO client command registration and no keybind binding. Two
workable triggers:

* `onForgeEvent('net.minecraftforge.client.event.ClientChatEvent', ...)` to
  intercept a typed sentinel like `!pob` before it reaches the server. KubeJS
  exposes generic Forge events via ForgeEventWrapper.
* Simpler and probably better UX: a `ClientEvents.tick` handler that re-exports
  whenever `DirtySync.getVersion()` changes, writing `kubejs/pob_export.json`.
  The file is then always current and there is nothing to remember to type.

A real Forge mod buys a one-click "copy build code" button and costs a build
toolchain plus a re-release every pack version. Not worth it - version drift is
the project's stated biggest risk.

Still to verify before building: that a KubeJS CLIENT script can actually reach
the MnS capability on `Minecraft.getInstance().player` (the capability is
attached client-side - the in-game GUI renders from it - but KubeJS's client
sandbox bindings have not been tested against it).

### Conversion: NOT the Path of Exile rule

Settled 2026-09-15 from bytecode, after the user reported damage dropping when
converting physical to chaos.

Two stats that read alike and behave nothing alike:

| stat | class | description string | effect |
|---|---|---|---|
| `plus_phys_to_<ele>` | BonusPhysicalAsElemental | "Grants % of physical attack damage as extra elemental damage" | ADDITIVE - physical untouched |
| `phys_to_<ele>` | PhysicalToElement | "Turns % of phys atk dmg into ele" | REAL conversion - physical is gone |

Venom's 40 is the first kind. The rogue talent is the second. The planner used
to treat the first as conversion and subtract it, understating every Venom build.

Layer order: BonusPhysicalAsElemental is BEFORE_DAMAGE_LAYERS, PhysicalToElement
is DAMAGE_LAYERS - so "gain as extra" is computed off the FULL physical base
before any conversion runs. Conversion also carries a `conversionDepth < 2`
guard against chains.

**The rule that matters, and it is the opposite of PoE.** Element-matched
increases (`all_physical_damage`, `all_chaos_damage`, ... all gated
`ifs: ["ele_match_stat"]`) apply ONLY to the unconverted share.
`ElementMatchesStat.can()`:

```java
if (damageEvent.unconvertedDamagePercent <= 0) return false;
if (damageEvent.unconvertedDamageTakenAsPercent <= 0) return false;
return event.getElement().elementsMatch(stat.getElement());
```

The event tracks how much of the hit is still unconverted. So converting
lightning to fire LOSES your increased-lightning on the converted portion - PoE
would keep it. Convert 100% and the source element's increases contribute
exactly nothing.

Consequence: conversion only pays if the DESTINATION element is already scaled.
Bolting the rogue chaos conversion onto a physical build trades (in the user's
case) 65.6% increased physical for 5% increased chaos, which is why Magic
Missile went to near-zero. Not a mod bug - working as designed.

Over 100%: `Conversion.normalizeNumbersToCapTo100()` scales every source by
100/total so the shares sum to exactly 100. No overflow, but no warning either,
and it guarantees zero physical remains.

Separately, Brutality (`all_physical_damage` +9..27 MORE,
`all_elemental_damage` -100 MORE, `all_chaos_damage` -100 MORE) zeroes converted
chaos entirely - but it is a SUPPORT GEM, so it only affects the skill it is
linked to. Do not generalise it across the loadout.

### Damage validation, 2026-09-15 - where it actually stands

First real validation against the game. Ground truth is `testsaves/parse_2026-09-15.json`
(a 58.5s MnSDummy parse) and `parse_log.py`, which reconstructs a parse from the
combat chat and reproduces that panel to within 114 damage out of 71.2M. The log
is trustworthy on its own - no screenshots needed to get a new target.

**Read the log per PROJECTILE, not per cast.** 415 Magic Missile "hits" over
53.9s is not 7.7 casts/sec; the game counts each projectile. 415 / 4.6162
projectile_count = 89.9 casts = 1.67/sec, which the planner already gets within
8%. Rate is close to right; the per-hit number is what is wrong.

Fixed this session, each verified against the parse or the stat diff:

* uniques - the guid is `mmorpg_custom_data -> data.map.uq`, NOT in mmorpg_gear;
  the old length-matching heuristic could never match anything (85 -> 98 exact)
* `all_attributes` was never transferred - the other ITransferToOtherStats
  beside elemental_resist
* crit - `is_crit_true` always read false, so `non_crit_damage -75% MORE` hit
  every crit too. Crit and non-crit now get separate stacks
* rank cap - baseDamage clamped to max_lvl, discarding every +level from gear
  (Mara's Kaleidoscope gives +3 to all skills, legitimately exceeding 20)
* projectile_count was not modelled at all
* the damage map was built by filtering on ONE hardcoded effect name, so every
  stat on another layer was invisible. It now builds from mmorpg_stat_effect,
  which declares each effect's layer and number source. That recovered 20 stats
  including `archmage` (flat_damage layer, STAT_PERCENT of mana)

Remaining gap after all of that: still ~6x low per hit on Magic Missile and Fan
of Knives. Two open leads.

**Lead 1 - coupled stats resolve in the wrong order.** mana reads 50% of
magic_shield and ~20.9% of dodge via `one_to_other`; `mana_battery` feeds mana
back into magic shield. All the one_to_other entries share `priority: 25`, so
their order among themselves is arbitrary, and each reads the other's output.

    mana ours 10154.94   game 7137.24     (+42%)

    derived reads adder TOTAL  -> mana 10155   (+42%)
    derived reads adder FLAT   -> mana  6396   (-10%)
    game                                 7137

Neither extreme matches, so the answer is not "use flat" or "use total" - read
OneToOtherStat in the bytecode and find what snapshot it actually takes, and
when. This matters for damage, not just display: Mantra converts 6% of mana to
flat physical and archmage adds another 6% of mana on the flat_damage layer, so
mana being 42% high inflates damage twice over.

**Lead 2 - buffs are not modelled at all.** The exporter caught exactly one buff
(FISH, a loot buff), so the bundle describes the character UNBUFFED while the
parse is fully buffed. The log itself measures the difference: the same Fan of
Knives averages 93,783 in the buffed window and 34,335 in a near-unbuffed one,
a 2.7x swing. Buffs to model, all of them the player's own supportive skills:
sharpen, hunters_focus (grants projectile_count 1-3 AND dmg_reduction_chance),
battle_orders, mirror_image. Plus charges - power_charge is +25% crit to 3
stacks, which is why the parse shows 100% crit - and the two "game changer"
talents the player flagged: Brutalizer (+25% MORE physical at max stacks, held
by weaving autos) and Marauder (applies Shred, 15-20 stacks on the target).

Match the near-unbuffed window FIRST. Chasing the buffed 1.5M while buffs are
unmodelled conflates two unknowns.

### Tooling added

* `parse_log.py` - reconstruct a DPS parse from latest.log, any 60s window
* `audit_coverage.py` - every stat the content grants, minus what the engine
  models, split by whether the effect fires on a damage event. 182 damage-path
  stats unmodelled. This is the systematic replacement for finding gaps by
  noticing a number looks wrong; it flags `projectile_count` and `archmage`
  without being told to look

### Terminology

Increases are additive and read with a sign ("+21%"); MORE is its own
multiplier and reads "21% more". `valText(v, type)` in ui/items.js is the single
formatter - do not hand-build "+" + value + unit anywhere else.

### Runes and sockets - settled

All five items from the previous pickup list are done (Version 42). Two traps
worth keeping:

* A runeword names its slots GENERICALLY - `pants`, `helmet`, `boots`, `chest`
  - while a base type is specific (`vest_pants`, `cloth_helmet`). Weapons match
  outright because a crossbow is a `crossbow`, which is exactly why weapons
  worked and every piece of armour silently found nothing. `runewordSlotOf`
  takes the part after the last underscore.
* Sockets belong to the ITEM, not to the runeword type - a normal or unique
  item takes runes too. The type dropdown must ask `runewordsForSlot(slot)`,
  not `runewordsFor(cur.base)`: a Normal item has no base selected yet, so the
  latter returned nothing and the Runeword option only appeared after picking
  Unique.

One rune TYPE per item: a socketed rune is filtered out of every OTHER socket's
list, but stays in its own so the control can show what it holds.

### Things not to re-derive

* Talent budget is `1 + level + quest points (0-25)`, start nodes free.
* Ascendancy is 9 points, and the entry node costs one of them.
* Support links come from the skill's *rank*, one per 4, five max - not from
  character level, except the `linkLevels` clamp which only bites below 40.
* Perk ids are unique across all twelve schools; zero collisions, so a flat map is
  safe.
* School display names are `mmorpg.asc_class.*`, not the ids and not
  `mmorpg.talent.*`.

## Reconstruction traps (found 2026-09-15)

The planner rebuilds every equipped item from the save. The invariant that
catches every failure at once: **opening a slot must not change any number.**
`statsFor(draftFromGear(...))` must equal that slot's saved contributions.

Things that silently broke it:

- **Per-roll percentages.** Runes (`sockets.so[].p`), unique stats
  (`uniqueStats.perc`, a fixed 10-slot buffer read in declaration order) and
  the runeword (`sockets.rp`) each roll separately. Defaulting to 100% made
  every imported item better than the real one.
- **`ui/page.html` carried a full duplicate of `engine.js`.** `__ENGINE__` was
  never in the template, so `build_ui.py`'s `page.replace('__ENGINE__', ...)`
  was a no-op and edits to `engine.js` did nothing. Now there is one copy.
  Third name-collision of this kind in this project - check for a second
  definition before concluding a change "did not take effect".
- **Jewel contributions were keyed `jewel:<affix>`**, so they could not be
  attributed to a socket and stayed in BASE_CONTRIBS; opening a jewel socket
  then added it a second time. Now `jewel:<socket>:<affix>`.
- **`crafted_jewel_unique`** is a third jewel affix type (firejewel_res,
  waterjewel_res) that `export_items.py` skipped entirely.
- **Jewels carry up to two corruptions**, and `jewelStats` capped affixes at
  the rarity's craftable count - a runeword jewel has three.
- **Uniques** need `filled(it)` (implicit + infusion + corruption), their
  socketed gems, and their own `gear_defense` line folded into armour/dodge/
  magic shield. `statsOf(item, extra)` takes non-affix modifiers for this.
- **Aura stats scale with level** (`IE.exact`, not raw min/max): the magic
  shield aura rolls 25 and grants 520 at level 100.

## Still open

- `weapon_damage` is 61.89 short. The compat rule `kube_weapon_damage` maps a
  `kubejs:weapon_damage` attribute 1:1 (cap 100); modded weapons like
  `roe_weapons:crossbow_5` carry it and it can only be read from the in-game
  dump. **`pob_dump_items.js` has not been run yet** - no `kubejs/exported/`.
- `magic_shield` 4904 vs game 8416, `dodge` 4985 vs 4074, `mana` 10340 vs 7137.
- Atlas-only stats (map_find, pack_size, mythic_monster_chance, ...) read 0 by
  design.

## Damage reconciliation, 2026-09-16

Against testsaves/parse_2026-09-15.json, with every available effect maxed
(the parse was fully buffed) and the rotation described by the player:

| skill          | model     | parse     | ratio |
|----------------|-----------|-----------|-------|
| magic_missile  | 1,838,486 | 1,218,373 | 1.51x |
| fan_of_knives  |   319,718 |   123,128 | 2.60x |
| mirror_image   |    10,671 |    43,387 | 0.25x |
| TOTAL          | 2,168,875 | 1,435,373 | 1.51x |

Was 3.35x before this session's work.

**Every remaining error is in hits/sec, not in damage per hit.**
Magic Missile's average hit is 149,257 against the parse's 171,600 (13% low)
and crit matches at 100%, but the rate is 12.32 hits/s against 7.09 - 1.74x
too fast, and 1.74 x 0.87 = 1.51 exactly.

Two open questions, both domain rather than code:

1. **Do all of Magic Missile's projectiles register?** The game reports
   projectile_count 4.6162 (so 5.6 projectiles) and our cast rate is 2.46/s.
   The parse implies 2.88 hits per cast, about half of what is fired.
2. **Does the Fan of Knives proc have an internal cooldown?** The boots roll
   `proc_fan_of_knives_on_hit` at 30 (not the 10 the fixture note assumed).
   30% of 7.09 hits/s is 2.13 procs/s; the parse measured 1.32 (77 hits /
   58.5s), which is close to one per 0.76s. Neither skills.json cooldown
   (0) nor the global cooldown (2 ticks) explains that.

### Fixed this session
- Skills are rated by HOW THEY ARE USED (`loadout[i].use`): cast on cooldown,
  proc on hit at a chance, or not used. Fan of Knives was being rated as
  though spammed - 9.36x its measured damage - and Ricochet Shot, which the
  player never casts, was taking the DPS headline at 1.8M.
- Proc skills seed themselves from the gear that triggers them: the stat
  `proc_<spell>_on_hit` IS the chance, so no manual setup.
- `all_attributes` never transferred to the core stats in the BROWSER engine
  (resolve.py had it). Attributes went 18/131/63 -> 59/173/104 against the
  game's 58/181/103.
- The "Against the equipped item" panel compared the draft to `live`, which
  IS the draft, so everything cancelled; the few rows that survived were auras
  the call had forgotten to pass.
- An empty codex slot invented a codex just by being opened.

## Proc cooldowns, 2026-09-16

`proc_cooldown_ticks` is a SEPARATE field from `cooldown_ticks` in every
spell's config, and 422 spells disagree between the two. Fan of Knives has no
cast cooldown at all but a 10-tick (0.5s) proc lockout. Distribution across the
registry: 10 ticks on 273 spells, 20 on 122, then 1/5/15/30/200/900/6000.

The proc stat itself names the gate - `proc_fan_of_knives_on_hit` carries
`ifs: [..., "is_fan_of_knives_not_on_cd"]`, alongside conditions that the hit
was not dodged and was not itself Fan of Knives.

**The lockout is dead time, not a cap.** After a proc the skill is unavailable
for the lockout, and hits landing inside that window are wasted, so

    rate = 1 / (lockout + 1 / (driverHitsPerSec * chance))

Taking `min(rate, 1/lockout)` overstates it - that assumes a hit is always
waiting the instant the lockout ends. Modelled properly: 1.30/s against the
parse's measured 1.32/s.

### This settles the Magic Missile rate question

The proc rate depends on NOTHING except Magic Missile's hit rate, so it is an
independent measurement of it:

    MM 12.32/s (our model)      -> FoK 1.30/s
    MM  7.09/s (parse 415/58.5) -> FoK 1.03/s
    measured                       1.32/s

So our hit rate is right and the parse's "415 hits" for magic_missile is not
one row per projectile. That relocates the whole remaining 1.51x error from the
rate model to DAMAGE PER HIT: 721 hits into 71,213,880 total damage is an
average hit of 98,809, where the model says 149,257.

Next: find the 1.51x in the hit calculation, not the rate.

## Cooldown reduction, 2026-09-16

**Cast cooldowns ARE reduced; proc lockouts are NOT.** The two paths are
different code.

`decrease_cd_ticks_num` -> `DecreaseNumberByPercentEffect.activate`, verbatim
from the bytecode:

    number = number - originalNumber * statValue / 100

It always scales the ORIGINAL, so multiple reductions stack ADDITIVELY: 30%
and 20% take half off, not 0.7 x 0.8 = 44%.

39 stats declare that effect, each gated on a spell tag exactly like the cast
speed family - `projectile_cdr`, `melee_cdr`, `fire_cdr`, `area_cdr` - plus a
plain `cdr` gated on nothing. Each carries its OWN ceiling (`cdr` 75,
`cast_speed_to_cooldown_cdr` 50), and the cap belongs to the stat, not the sum.

`cast_speed_to_cooldown_cdr` is real but narrow: it is gated on
`spell_has_tag_cast_speed_to_cooldown`, so cast speed only converts into
cooldown reduction on spells carrying that tag.

The old code read one stat named `cooldown_reduction`, which does not exist in
this game - so cooldown reduction did nothing at all. Now: Mirror Image 12s ->
9.96s (cdr 15 from a support + projectile_cdr 2).

**Procs bypass all of it.** `ProcSpellEffect.activate`:

    setOnCooldown(procCooldownKey(spell.GUID()), spell.config.proc_cooldown_ticks)

- raw config value, no stat calc, so no CDR, attack speed or skill speed.

### Also found in ProcSpellEffect (relevant to the sustain work)

A proc SPENDS mana and energy, and if `hasEnoughForBoth` fails it returns
without firing. So a build that cannot pay silently loses its procs - which is
exactly the sustainability question already queued.

## Unbuffed control parse, 2026-09-16 (43.3s window)

Magic Missile, no buffs, standing still. Prediction was recorded BEFORE the
numbers arrived.

| | predicted | measured | |
|---|---|---|---|
| hits/sec | 2.75 | 2.47 (107/43.3s) | model 11% high |
| average hit | 29,235 | 72,400 | model 2.48x LOW |
| crit chance | 63.7% | 71.0% | model low |
| DPS | 80,400 | 174,720 | model 2.17x LOW |

**The sign flips.** Buffed the model was 1.51x HIGH; unbuffed it is 2.17x LOW.
So the base hit is under-modelled and the buff stack is over-modelled - our
buffs multiply damage 22.9x where the real ones multiply it 7.0x. Chasing a
single scalar was always going to fail.

The rate model is fine. Everything below is the per-hit calculation.

### What the in-game damage log gives us

The Damage Breakdown "Last Hit" panel itemises a hit completely. One physical
hit read:

    Base Damage: 890
    Flat Damage: +1949.44
    Plus Physical as Extra: Fire 5%, Cold 5%, Chaos 40%, Lightning 5%
    Additive Damage: x2.99        Armor Mitigation: x0.89
    Attack Skill x1.25, Projectile Skill x0.80, Physical x1.55,
    Non Critical x0.25, Ranged Skill x1.25, Ranged Skill x1.25
    Final: 4247

and each bonus element is a SEPARATE hit with its own stack and its own crit
roll. This is the ground truth to build against - far better than a parse
total.

### Confirmed defects, in size order

1. **base damage 158 vs the game's 890.** `weapon_damage` reads 42.6 on the
   unbuffed browser sheet where the game reports 323.5. base_damage is
   `int(1.82 * weapon_damage) + base_part`, so this is most of the gap.
2. **flat_damage layer 572.5 vs 1949.44.** Two causes:
   - `SPELL_DAMAGE_EFFECTIVENESS_MULTI` is a `number_modifier` on the archmage
     effect and we ignore it. It comes from the spell's value calc,
     `dmg_effectiveness` (a LeveledValue, 1.4 to 2.0 for magic_missile).
   - `archmage_mana_cost` and `imbuement_energy_cost` also write flat_damage
     and are missing from the map - they declare differently-NAMED effects
     (`mana_inc__flat_damage_number_add_stat_percent`).
3. **Skill-gem stats are never applied.** `statsForSkillGem` on the spell -
   magic_missile grants plus_phys_to_fire / _lightning / _water - appears
   nowhere in export_skills.py, damage.js or skills.js. The log shows exactly
   those three at 5% each, and the parse shows them as 0.5-0.6% of total.
4. **mana 9541 vs the game's 6384** (49% over) - feeds archmage directly.
5. **Each bonus element rolls its own crit.** In the logged hit, physical and
   fire were non-crit (x0.25) while lightning, chaos and cold took Crit Damage
   x4.58. We apply one crit outcome to the whole hit.
6. **Two different target mitigations**: Armor x0.89 on physical, Elemental
   x0.55 on the elements. Check the enemy config models both.
7. **The dummy dodges.** 17 dodged of 168 attempts (~10%). Not modelled.
