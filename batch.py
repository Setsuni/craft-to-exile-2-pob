#!/usr/bin/env python3
"""
CTE2 PoB - run the resolver across a folder of saves and aggregate failures.

One character tells you whether a rule fires; six tell you which rules are
systematically wrong. Stats are ranked by how many characters they fail on,
because a stat wrong everywhere is one missing rule, while a stat wrong on one
character is usually that character's gear.
"""
import argparse, glob, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import read_character
import resolve as R


def load_rules(out):
    def L(n):
        p = os.path.join(out, n)
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    rules = R.Rules({
        'balance': L('mmorpg_game_balance.json')['original_balance'],
        'stats': L('mmorpg_stat.json'),
        'core': L('core_stats.json'),
        'affixes': L('mmorpg_affixes.json'),
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
    return rules


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('saves', help='folder of .dat files')
    ap.add_argument('--out', default='out')
    ap.add_argument('--tol', type=float, default=0.01)
    ap.add_argument('--top', type=int, default=30)
    args = ap.parse_args()

    rules = load_rules(args.out)
    fail = defaultdict(list)     # stat -> [(char, game, ours)]
    seen = defaultdict(int)      # stat -> how many characters have it
    per_char = []

    for path in sorted(glob.glob(os.path.join(args.saves, '*.dat'))):
        name = os.path.basename(path)[:8]
        ch = read_character.read(path)
        sheet = R.resolve(ch, rules)
        target = {k: v['v'] for k, v in ch['computed_stats'].items()}
        ours = {s: sheet.total(s, rules) for s in sheet.keys()}
        good = 0
        for k, t in target.items():
            seen[k] += 1
            v = ours.get(k)
            if v is None and abs(t) <= args.tol:
                good += 1          # game reports 0, we produce nothing: agree
            elif v is not None and abs(t - v) <= args.tol:
                good += 1
            else:
                fail[k].append((name, t, v))
        per_char.append((name, ch['level'], good, len(target)))

    print('CHARACTER            LVL   EXACT')
    for name, lvl, good, tot in per_char:
        pct = 100.0 * good / max(1, tot)
        print('  {:<18} {:>3}   {:>3}/{:<3}  {:5.1f}%'.format(name, lvl, good, tot, pct))
    tot_good = sum(g for _, _, g, _ in per_char)
    tot_all = sum(t for _, _, _, t in per_char)
    print('  {:<18} {:>3}   {:>3}/{:<3}  {:5.1f}%'.format(
        'TOTAL', '', tot_good, tot_all, 100.0 * tot_good / max(1, tot_all)))

    print('\nMOST SYSTEMATIC FAILURES (fails / characters that have the stat)')
    ranked = sorted(fail.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    for stat, rows in ranked[:args.top]:
        miss = sum(1 for _, _, v in rows if v is None)
        # Ratio game/ours where we produced something - a constant ratio means one rule.
        ratios = [t / v for _, t, v in rows if v not in (None, 0)]
        rs = ''
        if ratios:
            lo, hi = min(ratios), max(ratios)
            rs = ' ratio {:.3f}'.format(lo) if abs(hi - lo) < 0.02 else \
                 ' ratio {:.2f}-{:.2f}'.format(lo, hi)
        tag = ' NOT PRODUCED' if miss == len(rows) else ''
        print('  {:<36} {}/{}{}{}'.format(stat, len(rows), seen[stat], rs, tag))


if __name__ == '__main__':
    main()
