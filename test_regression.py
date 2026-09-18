#!/usr/bin/env python3
"""
CTE2 PoB - regression tests.

Version drift is the thing most likely to silently break this project, and the
failure mode is quiet: numbers stay plausible, they just stop matching the game.
These fixtures are the tripwire. Run after any pack update or engine change.

Each case pins a save file to an expected exact-match count against a specific
extraction directory. The naked level-100 character is the important one: it has
no gear at all, so it isolates base profile + level scaling + talents +
ascendancy + core-stat transfers + derived feeders. If that case regresses, the
engine core broke, not a gear layer.

    python test_regression.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import read_character
import resolve as R
import batch

HERE = os.path.dirname(os.path.abspath(__file__))

# Differential fixtures: each adds exactly one layer to the naked baseline, so a
# failure names the broken layer instead of just lowering a percentage.
CASES = [
    # (label, save, extraction dir, expected exact, expected total)
    ('naked lvl100 (base layer only)',
     'naked214/naked_bare_lvl100.dat', 'out214', 57, 57),
    ('naked + 1 rare chest (gear base + affixes)',
     'naked214/plus1_chest_lvl100.dat', 'out214', 58, 58),
    ('naked + chest + aura (aura rolls)',
     'naked214/plus_aura_lvl100.dat', 'out214', 59, 59),
    ('naked + 2-piece Jubbans (set bonuses)',
     'naked214/plus_jubbans2_lvl100.dat', 'out214', 63, 63),
    ('naked + runeword item w/ 2 runes (runes + runeword)',
     'naked214/plus_runed_lvl100.dat', 'out214', 64, 64),
    ('naked + socketed gem (gem fixed values)',
     'naked214/plus_gem_lvl100.dat', 'out214', 59, 59),
    ('naked + talent jewel socket + jewel (jewel affixes)',
     'naked214/plus_jewel_lvl100.dat', 'out214', 61, 61),
    ('naked + aura_effect talents (aura effect scaling)',
     'naked214/plus_aura_effect_lvl100.dat', 'out214', 62, 62),
    # Same character, same code, wrong pack version - pinned deliberately so a
    # drop here proves the suite is actually sensitive to version mismatch.
    ('naked lvl100 vs MISMATCHED 2.0.4 data',
     'naked214/naked_bare_lvl100.dat', 'out', None, None),
]

BATCH = ('2.0.4 character corpus', '2.0.4chardataexamples', 'out')


def run_one(save, outdir, tol=0.01):
    rules = batch.load_rules(os.path.join(HERE, outdir))
    ch = read_character.read(os.path.join(HERE, save))
    sheet = R.resolve(ch, rules)
    target = {k: v['v'] for k, v in ch['computed_stats'].items()}
    good = 0
    for k, t in target.items():
        v = sheet.total(k, rules) if k in sheet.keys() else None
        if v is None:
            # The game lists some stats at 0; producing nothing is agreement.
            good += 1 if abs(t) <= tol else 0
        elif abs(t - v) <= tol:
            good += 1
    return good, len(target)


def main():
    failures = 0
    print('REGRESSION')
    for label, save, outdir, want, want_tot in CASES:
        if not os.path.exists(os.path.join(HERE, save)):
            print('  SKIP  {:<44} (fixture missing)'.format(label))
            continue
        good, tot = run_one(save, outdir)
        if want is None:
            print('  info  {:<44} {}/{}'.format(label, good, tot))
            continue
        ok = (good == want and tot == want_tot)
        failures += 0 if ok else 1
        print('  {}  {:<44} {}/{}  (expected {}/{})'.format(
            'PASS' if ok else 'FAIL', label, good, tot, want, want_tot))

    label, folder, outdir = BATCH
    path = os.path.join(HERE, folder)
    if os.path.isdir(path):
        import glob
        tot_good = tot_all = 0
        for f in sorted(glob.glob(os.path.join(path, '*.dat'))):
            g, t = run_one(os.path.relpath(f, HERE), outdir)
            tot_good += g
            tot_all += t
        pct = 100.0 * tot_good / max(1, tot_all)
        print('  info  {:<44} {}/{}  {:.1f}%'.format(label, tot_good, tot_all, pct))

    print('\n{} failing case(s)'.format(failures))
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
