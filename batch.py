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


# One rules loader, in resolve.py. This file used to carry its own copy, and
# the two drifted: batch loaded the codex and aura capacity, resolve.py did
# not, so the same character scored 135 here and 129 there with nothing
# reporting a problem. A missing table reads as an empty dict and its consumer
# skips quietly, which is exactly the kind of gap a duplicate hides.
load_rules = R.load_rules


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('saves', help='folder of .dat files')
    # `out214` is the registry the rest of the project builds against.
    # This defaulted to `out`, a stale dump that is still on disk, so the
    # corpus silently scored against the wrong data: 288/527 instead of
    # 407/527, with aura_effect reading 0.792x purely from the mismatch.
    ap.add_argument('--out', default='out214')
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
