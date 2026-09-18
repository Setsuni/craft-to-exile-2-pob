#!/usr/bin/env python3
"""
CTE2 PoB - Step 2: stat resolver.

Rebuilds a character's stat sheet from its inputs and diffs against the sheet
the game itself computed, so every rule is verified rather than assumed.

Formulas below were read out of Mine & Slash's bytecode, not fitted:

  ExactStatData.fromStatModifier(mod, percent, level):
      v = mod.min + (mod.max - mod.min) * percent / 100
  Stat.scale(type, v, level):
      FLAT scales by the stat's StatScaling; PERCENT/MORE never scale
  LevelScalingConfig.getMultiFor(level):
      lvl = cap_to_max_lvl ? clamp(level, 1, MAX_LEVEL) : level
      return base_scaling + per_level_scaling * (lvl - 1)
  BaseStatsData.GetAllStats:
      percent = baseStats.p + gear.getQualityBaseStatsBonus()
      base gear stats scale at the ITEM's level, not the player's;
      then gear_defense / gear_damage (IBaseStatModifier) are folded into the
      base stats they cover - gear_defense -> armor, dodge_rating, magic_shield
                              gear_damage  -> weapon_damage
"""
import argparse, json, os, re
from collections import defaultdict

import read_character

SCALING_KEY = {
    'NORMAL': 'NORMAL_STAT_SCALING',
    'SLOW': 'SLOW_STAT_SCALING',
    'CORE': 'CORE_STAT_SCALING',
    'MOB_DAMAGE': 'MOB_DAMAGE_SCALING',
    'STAT_REQ': 'STAT_REQ_SCALING',
}

# Elements.getAllSingle() minus Physical.
SINGLE_ELEMENTS = ('fire', 'water', 'lightning', 'chaos')
# The subset that counts as "elemental" for the umbrella resist.
ELEMENTAL_ELEMENTS = ('fire', 'water', 'lightning')

# IBaseStatModifier.canModifyBaseStat, read from bytecode.
# Stat.<init> assigns this before any subclass overrides it.
DEFAULT_MULTI_USE = 'MULTIPLY_STAT'

BASE_STAT_MODIFIERS = {
    'gear_defense': ('armor', 'dodge_rating', 'dodge', 'magic_shield'),
    'gear_damage': ('weapon_damage',),
    'gear_weapon_damage': ('weapon_damage',),
}


class Rules:
    def __init__(self, data):
        self.balance = data['balance']
        self.stats = data['stats']
        self.core = data['core']
        self.affixes = data['affixes']
        self.rarities = data.get('rarities') or {}
        self.bases = data['bases']
        self.perks = data['perks']
        self.gems = data.get('gems') or {}
        self.runewords = data.get('runewords') or {}
        self.uniques = data.get('uniques') or {}
        self.auras = data.get('auras') or {}
        self.supports = data.get('supports') or {}
        self.omens = data.get('omens') or {}
        self.sets = data.get('sets') or {}
        self.runes = data.get('runes') or {}
        # Measured: applying support-gem stats to the global sheet drops accuracy
        # from 64.2% to 61.9% across six characters, so they are scoped to the
        # spell they are linked to and do not belong on the unit sheet.
        # StatCalculation.calc takes a Spell argument, which fits.
        self.support_gems_global = False

    def stat_def(self, stat_id):
        d = self.stats.get(stat_id)
        if isinstance(d, dict):
            inner = d.get('data') if isinstance(d.get('data'), dict) else d
            return {
                'base': inner.get('base', 0.0),
                'min': inner.get('min'),
                'max': inner.get('max'),
                'multiUseType': (inner.get('multiUseType')
                                 or d.get('multiUseType') or DEFAULT_MULTI_USE),
            }
        # Stat.<init> defaults multiUseType to MULTIPLY_STAT, so code-defined
        # stats (mana, health, armor...) still honour MORE mods.
        return {'multiUseType': DEFAULT_MULTI_USE}

    def scaling_of(self, stat_id):
        d = self.stats.get(stat_id)
        if isinstance(d, dict) and d.get('scaling'):
            return d['scaling']
        if isinstance(d, dict) and isinstance(d.get('data'), dict) and d['data'].get('scale'):
            return d['data']['scale']
        c = self.core.get(stat_id)
        if isinstance(c, dict) and c.get('scaling'):
            return c['scaling']
        return 'NONE'

    def multi(self, scaling, level):
        key = SCALING_KEY.get(scaling)
        if not key:
            return 1.0
        cfg = self.balance.get(key)
        if not cfg:
            return 1.0
        lvl = float(level)
        if cfg.get('cap_to_max_lvl'):
            lvl = max(1.0, min(lvl, float(self.balance.get('MAX_LEVEL', 100))))
        return cfg['base_scaling'] + cfg['per_level_scaling'] * (lvl - 1.0)

    def exact(self, mod, percent, level):
        """One StatMod -> its rolled, level-scaled value."""
        lo = mod.get('min', mod.get('v1', 0.0))
        hi = mod.get('max', mod.get('v1', 0.0))
        v = lo + (hi - lo) * float(percent) / 100.0
        kind = mod.get('type', 'FLAT')
        if kind == 'FLAT':
            v *= self.multi(self.scaling_of(mod['stat']), level)
        return mod['stat'], kind, v


class Sheet:
    def __init__(self):
        self.flat = defaultdict(float)
        self.perc = defaultdict(float)
        # InCalcStatData.Multi starts at 1.0 and MORE mods multiply into it:
        #   Multi = Multi * (1 + v/100)
        # so two +50% MOREs give 2.25x, not 2.0x.
        self.more = defaultdict(lambda: 1.0)
        self.why = defaultdict(list)
        self.final = {}

    def add(self, stat, kind, value, source):
        if kind == 'PERCENT':
            self.perc[stat] += value
        elif kind == 'MORE':
            self.more[stat] *= (1.0 + value / 100.0)
        else:
            self.flat[stat] += value
        self.why[stat].append((source, kind, round(value, 4)))

    def total(self, stat, rules=None):
        """InCalcStatData.calcValue(), read from bytecode:
             v = stat.base + Flat
             v *= 1 + Percent/100
             v *= Multi   (only when multiUseType == MULTIPLY_STAT)
             v  = clamp(v, stat.min, stat.getHardCap())
        """
        if stat in self.final:
            return self.final[stat]
        d = rules.stat_def(stat) if rules else {}
        v = float(d.get('base') or 0.0) + self.flat[stat]
        v *= (1.0 + self.perc[stat] / 100.0)
        if d.get('multiUseType') == 'MULTIPLY_STAT':
            v *= self.more[stat]
        lo, hi = d.get('min'), d.get('max')
        if lo is not None:
            v = max(v, float(lo))
        if hi is not None:
            v = min(v, float(hi))
        return v

    def add_final(self, stat, value, source, rules):
        d = rules.stat_def(stat)
        v = self.total(stat, rules) + value
        if d.get('min') is not None:
            v = max(v, d['min'])
        if d.get('max') is not None:
            v = min(v, d['max'])
        self.final[stat] = v
        self.why[stat].append((source, 'FINAL', round(value, 4)))

    def clear(self, stat):
        """ITransferToOtherStats implementations zero themselves after
        distributing - AllAttributes and ElementalStat both end transferStats
        with InCalcStatData.clear(), so the umbrella stat reads 0."""
        self.flat[stat] = 0.0
        self.final.pop(stat, None)
        self.perc[stat] = 0.0
        self.more[stat] = 1.0
        self.why[stat].append(('cleared after transfer', 'FLAT', 0.0))

    def keys(self):
        return (set(self.flat) | set(self.perc) | set(self.final)
                | {k for k, v in self.more.items() if v != 1.0})


def apply_derived(sheet, rules):
    # AddToAfterCalcEnd modifies final totals. Source values are snapshotted
    # per priority group; MoreXPerYOf runs last and truncates completed units.
    derived = [(sid, s) for sid, s in rules.stats.items()
               if isinstance(s, dict) and s.get('ser') in ('one_to_other', 'more_x_per_y')]
    def priority(sdef):
        return (2147483647 if sdef['ser'] == 'more_x_per_y'
                else (sdef.get('data') or {}).get('priority', 0))
    derived.sort(key=lambda kv: priority(kv[1]))
    previous = None
    snapshot = {}
    for sid, sdef in derived:
        d = sdef.get('data') or {}
        if previous != priority(sdef):
            keys = sheet.keys() | {key for stat_id, definition in derived
                                   for key in (stat_id, definition['data']['adder_stat'])}
            snapshot = {key: sheet.total(key, rules) for key in keys}
            previous = priority(sdef)
        rate = snapshot.get(sid, 0)
        src = snapshot.get(d.get('adder_stat', ''), 0)
        if not rate or not src:
            continue
        if sdef['ser'] == 'one_to_other':
            amt = src * rate / 100.0
            sheet.add_final(d['add_to'], amt, 'derived:' + sid, rules)
        else:
            per = d.get('per_amount') or 1
            amt = int(src / float(per)) * rate
            sheet.add_final(d['add_to'], amt, 'derived:' + sid, rules)



def match_unique(item, rules):
    """Which unique an item is.

    The guid is on the stack, not in mmorpg_gear: UniqueStatsData.getUnique()
    reads CustomItemData's UNIQUE_ID, stored as `mmorpg_custom_data` ->
    data.map.uq, which read_character carries through as `_uniq`.

    This used to guess - base_gear plus `len(unique_stats) == len(perc)`. That
    can never match anything: `perc` is a fixed 10-slot roll buffer on every
    item while real uniques carry 1 to 9 stats, so EVERY unique silently
    contributed zero stats. A guess is not worth having here; if the id is
    missing, say so by returning None rather than picking a plausible wrong one.
    """
    uq = item.get('_uniq')
    if uq:
        u = rules.uniques.get(uq)
        if isinstance(u, dict):
            return u
    # Older exports predate `_uniq`; force_item_id is the only other hard link.
    return next((u for u in rules.uniques.values()
                 if isinstance(u, dict)
                 and u.get('force_item_id')
                 and u.get('force_item_id') == item.get('_item')), None)


def infusion_percent(ench, rules):
    rarity = rules.rarities.get(ench.get('rar', 'common')) or {}
    return (rarity.get('stat_percents') or {}).get('max', 100)


def gear_stats(item, rules):
    """All stats one equipped item contributes, with base-stat modifiers folded in."""
    ilvl = item.get('lvl', 1)
    base_pct = (item.get('baseStats') or {}).get('p', 0) + (item.get('_quality') or 0)
    gtype = rules.bases.get(item.get('gtype')) or {}

    base = []   # [stat, kind, value] - the item's base stats, mutable
    for mod in gtype.get('base_stats', []):
        base.append(list(rules.exact(mod, base_pct, ilvl)))

    others = []
    imp = item.get('imp') or {}
    if imp.get('imp'):
        a = rules.affixes.get(imp['imp'])
        if a:
            for mod in a.get('stats', []):
                others.append(list(rules.exact(mod, imp.get('p', 0), ilvl)))
    for group in ('pre', 'suf', 'cor'):
        for entry in (item.get('affixes') or {}).get(group, []) or []:
            a = rules.affixes.get(entry.get('id'))
            if not a:
                continue
            for mod in a.get('stats', []):
                others.append(list(rules.exact(mod, entry.get('p', 0), ilvl)))

    # Socketed gems. A gem grants a different stat list depending on what it is
    # socketed into, chosen by the base type's family tag. Gem stats are fixed
    # values, not min/max rolls, so the socket's own `p` is not a roll percent.
    tags = set((gtype.get('tags') or {}).get('tags') or [])
    if 'weapon_family' in tags:
        gem_key = 'on_weapons_stats'
    elif 'jewelry_family' in tags or item.get('gtype') == 'elytra':
        gem_key = 'on_jewelry_stats'
    else:
        gem_key = 'on_armor_stats'      # armor_family and offhand_family
    for sock in ((item.get('sockets') or {}).get('so') or []):
        sid = sock.get('g')
        gem = rules.gems.get(sid)
        if gem:
            # Gem stats are fixed values, so the socket's `p` is not a roll.
            for mod in gem.get(gem_key, []):
                v = mod.get('v1', 0.0)
                if mod.get('scale_to_lvl'):
                    v *= rules.multi(rules.scaling_of(mod['stat']), ilvl)
                others.append([mod['stat'], mod.get('type', 'FLAT'), v])
            continue
        # A socket can also hold a rune. Same per-family stat split as a gem,
        # but rune stats are min/max ranges rolled by the socket's `p`.
        rune = rules.runes.get(sid)
        if rune:
            for mod in rune.get(gem_key, []):
                others.append(list(rules.exact(mod, sock.get('p', 0), ilvl)))

    # Runeword. The socket block carries the runeword id and its own roll (`rp`).
    sockets = item.get('sockets') or {}
    rw = rules.runewords.get(sockets.get('rw'))
    if rw:
        for mod in rw.get('stats', []):
            others.append(list(rules.exact(mod, sockets.get('rp', 0), ilvl)))

    # Unique gear. The item stores only an array of roll percents, one per stat
    # in declaration order against `perc`, a fixed 10-slot roll buffer - so a
    # unique with 4 stats reads perc[0..3] and the rest of the buffer is unused.
    perc = (item.get('uniqueStats') or {}).get('perc')
    if perc:
        match = match_unique(item, rules)
        if match:
            for i, mod in enumerate(match.get('unique_stats') or []):
                others.append(list(rules.exact(mod, perc[i] if i < len(perc) else 0, ilvl)))

    # GearInfusionData.getPercent uses the infusion rarity's maximum roll.
    ench = item.get('ench') or {}
    if ench.get('en'):
        a = rules.affixes.get(ench['en'])
        if a:
            for mod in a.get('stats', []):
                others.append(list(rules.exact(mod, infusion_percent(ench, rules), ilvl)))

    # Fold IBaseStatModifier entries into the base stats they cover.
    rest = []
    for stat, kind, val in others:
        covers = BASE_STAT_MODIFIERS.get(stat)
        if not covers:
            rest.append((stat, kind, val))
            continue
        applied = False
        for b in base:
            if b[0] in covers:
                applied = True
                if kind == 'FLAT':
                    b[2] += val
                elif kind == 'PERCENT':
                    b[2] *= (1.0 + val / 100.0)
        # Keep the modifier visible as its own stat too (the game reports it).
        rest.append((stat, kind, val))
        if not applied:
            pass
    return [tuple(b) for b in base] + rest


def codex_pieces(omen, worn_rar):
    """How many "pieces" of a codex are satisfied, and how many it has.

    The tooltip's "5 Piece / 6 Piece / 7 Piece" counts REQUIREMENT UNITS, not
    requirement kinds: a codex asking for {NORMAL 2, UNIQUE 2, RUNED 3} tops out
    at 7, and wearing two normals contributes 2 toward it. Counting kinds - the
    first cut at this - happened to be right only for a codex whose every
    requirement was 1.
    """
    reqs = omen.get('rarities') or {}
    total = sum(reqs.values())
    met = sum(min(worn_rar.get(k, 0), need) for k, need in reqs.items())
    return met, total


def codex_tiers(omen, odef):
    """The codex's bonuses, each with the piece count that unlocks it.

    Derived from four in-game tooltips (Spite epic, Blood rare, Blood
    legendary, Echoes mythic) and consistent with all of them: the registry's
    `mods` sit at the TOP tier, which is the full requirement total, and each
    rolled affix sits one tier lower in order. A codex with three affixes and
    a total of 5 therefore reads 2 / 3 / 4 / 5.
    """
    affs = omen.get('aff') or []
    total = sum((omen.get('rarities') or {}).values())
    out = []
    for i, a in enumerate(affs):
        out.append((total - len(affs) + i, 'affix', a))
    out.append((total, 'mods', odef.get('mods') or []))
    return out


def codex_stats(omen, odef, worn_rar, rules, level):
    """Every stat an equipped codex is currently granting."""
    met, _total = codex_pieces(omen, worn_rar)
    olvl = omen.get('lvl', level)
    src = 'codex:%s' % omen.get('id')
    out = []
    for tier, kind, payload in codex_tiers(omen, odef):
        if met < tier:
            continue
        if kind == 'affix':
            adef = rules.affixes.get(payload.get('id'))
            if not adef:
                continue
            for mod in adef.get('stats', []):
                st, k, v = rules.exact(mod, payload.get('p', 0), olvl)
                out.append((st, k, v, src))
        else:
            # The codex's own roll percentage is recorded on its affix entries.
            pct = 0
            for a in omen.get('aff') or []:
                pct = a.get('p', 0)
                break
            for mod in payload:
                st, k, v = rules.exact(mod, pct, olvl)
                out.append((st, k, v, src))
    return out


def resolve(ch, rules, profile='original_mode_player'):
    level = ch['level']
    sheet = Sheet()

    for mod in rules_profile(rules, profile):
        v = mod.get('v1', 0.0)
        if mod.get('scale_to_lvl'):
            v *= rules.multi('NORMAL', level)
        sheet.add(mod['stat'], mod.get('type', 'FLAT'), v, 'base')

    graphs = rules.graphs
    for school, coords in ch['allocated'].items():
        # Never guess a tree. The save says ATLAS; the graph is called
        # `atlas_passives`, so `graphs.get(school.lower())` finds nothing and
        # the `or graphs['talents']` fallback resolved 104 atlas coordinates
        # against the TALENT tree - every one that happened to land on a talent
        # node was applied as a real perk. That is how `mage` came out doubled
        # and intelligence read 12 high.
        #
        # Atlas perks are farming stats and deliberately excluded from the
        # character sheet, exactly as the browser excludes them.
        name = read_character.GRAPH_OF.get(school)
        if name is None or name == 'atlas_passives':
            continue
        g = graphs.get(name)
        if not g:
            continue
        pos = {(n['x'], n['y']): n['perk'] for n in g['nodes']}
        for c in coords:
            pid = pos.get(tuple(c))
            perk = rules.perks.get(pid) if pid else None
            if not perk:
                continue
            for mod in perk.get('stats', []):
                v = mod.get('v1', 0.0)
                if mod.get('scale_to_lvl'):
                    v *= rules.multi('NORMAL', level)
                sheet.add(mod['stat'], mod.get('type', 'FLAT'), v, 'perk:' + pid)

    for stat, n in (ch.get('stat_points') or {}).items():
        sheet.add(stat, 'FLAT', float(n), 'points')

    # Ascendancy / spell passives allocated outside the grid.
    for pid, lvls in ((ch.get('ascendancy') or {}).get('allocated_lvls') or {}).items():
        perk = rules.perks.get(pid)
        if not perk:
            continue
        for mod in perk.get('stats', []):
            sheet.add(mod['stat'], mod.get('type', 'FLAT'),
                      mod.get('v1', 0.0) * lvls, 'asc:' + pid)

    worn_items = []
    for item in ch.get('gear', []):
        # An item merely *held* in the hotbar only counts if it is actually a
        # weapon or offhand. A chestplate carried in hand contributes nothing,
        # so trusting SelectedItemSlot alone double-counts armour.
        if item.get('_slot') == 'weapon':
            tags = set(((rules.bases.get(item.get('gtype')) or {})
                        .get('tags') or {}).get('tags') or [])
            if not (tags & {'weapon_family', 'offhand_family'}):
                continue
        worn_items.append(item)
        for stat, kind, val in gear_stats(item, rules):
            sheet.add(stat, kind, val, 'gear:' + item['_slot'])

    # InCalc.addVanillaHpToStats - vanilla max health is folded into the health
    # stat as already-scaled flat, clamped to [0, 500].
    # Gated on the pack's compat preset: ORIGINAL_MODE uses
    # HEALTH_SYSTEM = IMAGINARY_MINE_AND_SLASH_HEALTH, so vanilla hearts are
    # NOT folded in. Only VANILLA_HEALTH enables this term.
    # HealthSystem.addBonusHealthFromVanillaHearts() returns true for
    # IMAGINARY_MINE_AND_SLASH_HEALTH, not for VANILLA_HEALTH. With an imaginary
    # MnS pool the vanilla hearts fold in on top; under VANILLA_HEALTH MnS writes
    # the hearts directly, so adding them again would double-count.
    vanilla_hp = (ch.get('vanilla_max_health')
                  if rules.health_system == 'IMAGINARY_MINE_AND_SLASH_HEALTH' else 0)
    if vanilla_hp:
        sheet.add('health', 'FLAT', max(0.0, min(float(vanilla_hp), 500.0)), 'vanilla_hp')

    # Active buffs (potion / meal / fish / ...) carry literal stat lists.
    for kind, buff in (ch.get('buffs') or {}).items():
        for mod in (buff or {}).get('stats', []) or []:
            v = mod.get('v1', 0.0)
            if mod.get('scaled'):
                v *= rules.multi(rules.scaling_of(mod['stat']), level)
            sheet.add(mod['stat'], mod.get('type', 'FLAT'), v,
                      'buff:%s:%s' % (kind.lower(), buff.get('id')))

    # Jewels use the same rolled-affix machinery as gear, at the jewel's level.
    # The source carries WHICH jewel, not just which affix. Keyed by affix id
    # alone, the planner could not tell a jewel's contribution apart from the
    # rest of the sheet, so opening a jewel socket added its stats a second
    # time on top of the ones already counted.
    for ji, jw in enumerate(ch.get('jewels') or []):
        jlvl = jw.get('lvl', level)
        for entry in (jw.get('affixes') or []) + (jw.get('cor') or []):
            a = rules.affixes.get(entry.get('id'))
            if not a:
                continue
            for mod in a.get('stats', []):
                st, kind, v = rules.exact(mod, entry.get('p', 0), jlvl)
                sheet.add(st, kind, v, 'jewel:%d:%s' % (ji, entry.get('id')))

    # Equipped aura skill gems. The gem stores its roll as `perc`; the aura's
    # stats are min/max like an affix. Reservation is the spirit cost, not a stat.
    # `aura_effect` (from talents) scales everything an aura grants. Verified by
    # differential save: aura gave magic_shield_regen 154.752, and spending into
    # aura effect for +7 raised it by exactly 154.752 * 0.07 = 10.8326.
    # Read it before applying auras - it comes from perks, which are already in.
    aura_mult = 1.0 + sheet.total('aura_effect', rules) / 100.0
    for gem in (ch.get('auras') or []):
        aura = rules.auras.get(gem.get('id'))
        if not aura:
            continue
        for mod in aura.get('stats', []):
            st, kind, v = rules.exact(mod, gem.get('perc', 0), level)
            sheet.add(st, kind, v * aura_mult, 'aura:' + str(gem.get('id')))

    # Support skill gems. These are socketed against spells, so it is not obvious
    # they belong on the global sheet - measured below rather than assumed.
    if rules.support_gems_global:
        for gem in (ch.get('support_gems') or []):
            sg = rules.supports.get(gem.get('id'))
            if not sg:
                continue
            for mod in sg.get('stats', []):
                st, kind, v = rules.exact(mod, gem.get('perc', 0), level)
                sheet.add(st, kind, v, 'support:' + str(gem.get('id')))

    # mmorpg_stat_compat: vanilla/modded item attributes and enchantments convert
    # into MnS stats. Attributes live in each mod's Java, so they come from the
    # in-game KubeJS dump (kubejs/exported/item_attributes.json) when available.
    by_attr = {}
    by_ench = {}
    for c in rules.compat.values():
        if not isinstance(c, dict):
            continue
        if c.get('attribute_id'):
            by_attr.setdefault(c['attribute_id'], []).append(c)
        if c.get('enchant_id'):
            by_ench.setdefault(c['enchant_id'], []).append(c)

    def convert(rule, raw):
        v = raw * rule['conversion']
        v = max(float(rule['per_item_min']), min(v, float(rule['per_item_max'])))
        return v

    # Vanilla attribute -> MnS stat conversions.
    #
    # StatCompat.getResult reads LivingEntity.getAttributeValue(attr): the
    # entity TOTAL, which is the player's base plus every equipped item's
    # modifier. So build that total first, then convert once - converting
    # per-item would apply the integer truncation and caps repeatedly.
    #
    #   int v = (int)(total * conversion);
    #   v = clamp(v, minimum_cap, maximum_cap);      // global caps
    #   if (v != 0) v = (int) scaling.scale(v, level);
    SLOT_TO_DUMP = {'chest': 'chest', 'head': 'head', 'legs': 'legs',
                    'feet': 'feet', 'offhand': 'offhand',
                    'weapon': 'mainhand', 'curio': 'mainhand'}
    totals = dict(ch.get('entity_attrs') or {})
    for item in worn_items:
        by_slot = rules.item_attrs.get(item.get('_item')) or {}
        mods = by_slot.get(SLOT_TO_DUMP.get(item.get('_slot'), '')) or {}
        for attr_id, mod in mods.items():
            # Only additive modifiers sum into the base value.
            if str(mod.get('op', 'ADDITION')).upper() not in ('ADDITION', '0'):
                continue
            totals[attr_id] = totals.get(attr_id, 0.0) + float(mod.get('amount', 0.0))

    # Effective runtime values already include gear and transient modifiers.
    totals.update(ch.get('runtime_attrs') or {})
    for attr_id, raw in totals.items():
        for rule in by_attr.get(attr_id, []):
            v = int(float(raw) * rule['conversion'])
            v = max(int(rule['minimum_cap']), min(v, int(rule['maximum_cap'])))
            if v:
                v = int(rules.multi(rule.get('scaling') or 'NONE', level) * v)
            if v:
                sheet.add(rule['mns_stat_id'], rule['mod_type'], float(v),
                          'attr:' + attr_id)

    # PlayerStatUtils.addNewbieElementalResists - flat resist granted by level
    # band to every single element except Physical, gated on the compat preset's
    # ENABLE_MINUS_RESISTS_PER_LEVEL. Deliberately unscaled (noScaling).
    if rules.newbie_resists:
        lv = level
        amount = 50 if lv <= 24 else 25 if lv <= 49 else 0 if lv <= 74 else -25
        for el in SINGLE_ELEMENTS:
            sheet.add(el + '_resist', 'FLAT', float(amount), 'newbie_resists')

    # Vanilla enchantments. mmorpg_stat_compat converts each by level:
    #
    #     v = level * conversion, clamped to per_item_max on that ONE item,
    #     and the total across every item clamped to maximum_cap
    #
    # so Fire Protection IV is 8 fire resist, and stacking it on six pieces
    # still stops at 36. Capping only at the end would overstate a full set;
    # capping only per item would understate the ceiling.
    ench_rules = {}
    for rule in rules.compat.values():
        if isinstance(rule, dict) and rule.get('enchant_id'):
            ench_rules[rule['enchant_id']] = rule
    ench_total = {}
    for item in ch.get('gear', []):
        for e in item.get('_ench') or []:
            rule = ench_rules.get(e.get('id'))
            if not rule:
                continue
            v = (e.get('lvl') or 0) * float(rule.get('conversion', 0.0))
            per = rule.get('per_item_max')
            if per is not None:
                v = max(-abs(per), min(per, v))
            key = (rule['mns_stat_id'], rule.get('mod_type', 'FLAT'),
                   rule.get('maximum_cap'))
            ench_total[key] = ench_total.get(key, 0.0) + v
    for (stat, kind, cap), v in ench_total.items():
        if cap is not None and cap:
            v = max(-abs(cap), min(cap, v))
        if v:
            sheet.add(stat, kind, v, 'enchant:' + stat)

    # ElementalStat implements ITransferToOtherStats: the umbrella
    # elemental_resist feeds each elemental single resist.
    el_resist = sheet.total('elemental_resist', rules)
    if el_resist:
        for el in ELEMENTAL_ELEMENTS:
            sheet.add(el + '_resist', 'FLAT', el_resist, 'transfer:elemental_resist')
        sheet.clear('elemental_resist')

    # AllAttributes is the other ITransferToOtherStats: it feeds each core
    # attribute and then zeroes itself, which is why the game reports
    # all_attributes as 0 even on a character wearing two curios that grant it.
    # This transfer was missing entirely, so the attributes it should have fed
    # all read low.
    all_attr = sheet.total('all_attributes', rules)
    if all_attr:
        for core in ('strength', 'dexterity', 'intelligence'):
            sheet.add(core, 'FLAT', all_attr, 'transfer:all_attributes')
        sheet.clear('all_attributes')

    # Item set bonuses (mmorpg_sets). Count equipped uniques per set and apply
    # every tier whose piece requirement is met - they are cumulative, so a
    # 3-piece set grants both the 2- and 3-piece bonuses.
    worn = []
    for item in ch.get('gear', []):
        if item.get('_slot') == 'weapon':
            tags = set(((rules.bases.get(item.get('gtype')) or {})
                        .get('tags') or {}).get('tags') or [])
            if not (tags & {'weapon_family', 'offhand_family'}):
                continue
        u = match_unique(item, rules)
        if u:
            worn.append(u.get('guid'))
    # Codices (omens). Not gear: they sit in a curio slot carrying `mmorpg_omen`
    # and their stats are CONDITIONAL on what else is equipped. `rarities` is a
    # requirement map - {RUNED: 1, UNIQUE: 1, NORMAL: 1} means one runeword,
    # one unique and one normal item worn - and the number of requirements met
    # is the tier the tooltip calls "2 Piece" / "3 Piece". Meeting them all
    # grants the registry's `mods`; meeting one fewer grants the `aff` list.
    #
    # Rarity buckets, from the rarity each equipped item reports: a runeword is
    # RUNED, a unique is UNIQUE, anything else is NORMAL.
    worn_rar = {'RUNED': 0, 'UNIQUE': 0, 'NORMAL': 0}
    for item in ch.get('gear', []):
        r = str(item.get('rar') or '').lower()
        if r == 'runeword':
            worn_rar['RUNED'] += 1
        elif r == 'unique':
            worn_rar['UNIQUE'] += 1
        else:
            worn_rar['NORMAL'] += 1

    for omen in ch.get('omens') or []:
        odef = (rules.omens or {}).get(omen.get('id'))
        if not isinstance(odef, dict):
            continue
        for st, kind, v, src in codex_stats(omen, odef, worn_rar, rules, level):
            sheet.add(st, kind, v, src)

    for sid, sdef in (rules.sets or {}).items():
        if not isinstance(sdef, dict):
            continue
        members = set(sdef.get('uniques') or [])
        n = sum(1 for g in worn if g in members)
        if not n:
            continue
        for bonus in sdef.get('bonuses') or []:
            if n >= bonus.get('pieces', 99):
                for mod in bonus.get('stats', []):
                    st, kind, v = rules.exact(mod, 100, level)
                    sheet.add(st, kind, v, 'set:%s(%d)' % (sid, bonus['pieces']))

    # Core stats (strength/dexterity/intelligence) transfer into other stats at a
    # fixed rate per point. They use the "core_stat" serializer, so the table
    # lives at data.core_stat_data.stats rather than the usual top-level "stats".
    # This must run last: the attribute totals have to be final first.
    for sid, sdef in rules.stats.items():
        if not isinstance(sdef, dict) or sdef.get('ser') != 'core_stat':
            continue
        # CoreStat.affectStats: `int amount = (int) statData.getValue();`
        # The attribute is TRUNCATED before transferring, so 14.295 intelligence
        # transfers as 14. Without this every derived stat drifts slightly high.
        amount = int(sheet.total(sid, rules))
        if not amount:
            continue
        table = ((sdef.get('data') or {}).get('core_stat_data') or {}).get('stats') or []
        for mod in table:
            sheet.add(mod['stat'], mod.get('type', 'FLAT'),
                      mod.get('v1', 0.0) * amount, 'core:' + sid)

    apply_derived(sheet, rules)

    return sheet


def rules_profile(rules, profile):
    return rules.base_profiles[profile]['base_stats']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    ap.add_argument('--tol', type=float, default=0.01)
    ap.add_argument('--why', help='explain one stat')
    args = ap.parse_args()
    o = args.out

    def L(n):
        p = os.path.join(o, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    ch = L('character.json')
    rules = Rules({
        'balance': L('mmorpg_game_balance.json')['original_balance'],
        'stats': L('mmorpg_stat.json'),
        'core': L('core_stats.json'),
        'affixes': L('mmorpg_affixes.json'),
        'rarities': L('mmorpg_gear_rarity.json'),
        'bases': L('mmorpg_base_gear_types.json'),
        'perks': L('mmorpg_perk.json'),
        'gems': L('mmorpg_gems.json'),
        'runewords': L('mmorpg_runeword.json'),
        'uniques': L('mmorpg_unique_gears.json'),
        'auras': L('mmorpg_aura.json'),
        'supports': L('mmorpg_support_gem.json'),
        'sets': L('mmorpg_sets.json'),
        'runes': L('mmorpg_runes.json'),
    })
    cfgb = L('pack_config.json')
    preset = (cfgb.get('mine_and_slash_compatibility-server.toml') or {}).get('settings') or {}
    rules.cfg = preset
    rules.health_system = preset.get('HEALTH_SYSTEM', 'IMAGINARY_MINE_AND_SLASH_HEALTH')
    rules.newbie_resists = bool(preset.get('ENABLE_MINUS_RESISTS_PER_LEVEL'))
    rules.compat = L('mmorpg_stat_compat.json')
    rules.item_attrs = L('item_attributes.json')
    rules.graphs = L('talent_graphs.json')
    rules.base_profiles = L('mmorpg_base_stats.json')

    sheet = resolve(ch, rules)

    if args.why:
        print('{}  ours={:.4f}  game={}'.format(
            args.why, sheet.total(args.why, rules),
            ch['computed_stats'].get(args.why, {}).get('v')))
        for src, kind, val in sheet.why[args.why]:
            print('   {:<22} {:<8} {}'.format(src, kind, val))
        return

    target = {k: v['v'] for k, v in ch['computed_stats'].items()}
    ours = {s: sheet.total(s, rules) for s in sheet.keys()}

    exact, wrong, missing, extra = [], [], [], []
    for k in sorted(set(target) | set(ours)):
        t, v = target.get(k), ours.get(k)
        if t is None:
            if abs(v) > 1e-9:
                extra.append((k, v))
        elif v is None:
            # The game lists some stats at 0; producing nothing is agreement.
            if abs(t) <= args.tol:
                exact.append(k)
            else:
                missing.append((k, t))
        elif abs(t - v) <= args.tol:
            exact.append(k)
        else:
            wrong.append((k, t, v))

    print('LEVEL {}   exact {}/{}'.format(ch['level'], len(exact), len(target)))
    print('\nEXACT ({}):\n  {}'.format(len(exact), ', '.join(exact)))
    if wrong:
        print('\nMISMATCH ({}):'.format(len(wrong)))
        for k, t, v in wrong:
            print('  {:<34} game={:<13.4f} ours={:<13.4f} d={:+.4f}'.format(k, t, v, v - t))
    if missing:
        print('\nNOT PRODUCED ({}):'.format(len(missing)))
        for k, t in missing:
            print('  {:<34} game={:.4f}'.format(k, t))
    if extra:
        print('\nEXTRA ({}):'.format(len(extra)))
        for k, v in extra:
            print('  {:<34} ours={:.4f}'.format(k, v))


if __name__ == '__main__':
    main()
