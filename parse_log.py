#!/usr/bin/env python3
"""
CTE2 PoB - reconstruct a DPS parse from the game's combat chat.

The MnSDummy panel gives one averaged number per skill; the chat log gives every
individual hit with a timestamp. Parsing the log ourselves is the cross-check:
if a 60s window over the same fight reproduces the dummy's DPS, then the log is
being read correctly and can be used as a regression target on its own - which
matters, because the dummy panel has to be screenshotted by hand.

Two traps the format sets:

* the chat carries Minecraft colour codes (section sign + one char) mid-line, so
  the element name has to be stripped before it is read;
* "dealt" is a hit, "applied" is an ailment being placed. Counting both double
  counts damage-over-time.

    python parse_log.py                       # best 60s window in latest.log
    python parse_log.py --window 60 --top 5   # the five best windows
"""
import argparse, collections, os, re

CLIENT = (r'C:\Users\shawn\curseforge\minecraft\Instances'
          r'\Craft to Exile 2 - 2.0 Atlas Update')
LOG = os.path.join(CLIENT, 'logs', 'latest.log')

# [15:08:57] [Render thread/INFO]: [CHAT] [Name] dealt 9939.31 <colour>Element<colour> Damage with Wolf Attack
LINE = re.compile(
    r'^\[(\d{2}):(\d{2}):(\d{2})\].*?\[CHAT\].*?\b(dealt|applied)\s+'
    r'([\d,]+\.?\d*)\s+(.*?)\s+Damage with\s+(.+?)\s*$')
COLOUR = re.compile('\u00a7.|\ufffd.')


def parse(path):
    """Every hit in the log as (seconds, amount, element, skill)."""
    hits = []
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            m = LINE.match(line.rstrip('\n'))
            if not m:
                continue
            hh, mm, ss, kind, amount, element, skill = m.groups()
            if kind != 'dealt':          # "applied" is the ailment landing
                continue
            t = int(hh) * 3600 + int(mm) * 60 + int(ss)
            ele = COLOUR.sub('', element).strip().strip('?').strip() or 'Unknown'
            hits.append((t, float(amount.replace(',', '')), ele,
                         COLOUR.sub('', skill).strip()))
    hits.sort(key=lambda h: h[0])
    return hits


def best_windows(hits, window, top):
    """Highest-damage windows, one candidate per distinct start second."""
    out = []
    n = len(hits)
    j = 0
    total = 0.0
    starts = sorted({h[0] for h in hits})
    for s in starts:
        # advance a simple two-pointer sum over [s, s+window)
        lo = next((i for i, h in enumerate(hits) if h[0] >= s), n)
        hi = next((i for i, h in enumerate(hits) if h[0] >= s + window), n)
        if hi <= lo:
            continue
        chunk = hits[lo:hi]
        out.append((sum(h[1] for h in chunk), s, chunk))
    out.sort(key=lambda x: -x[0])
    # Keep windows that do not overlap, so "top 5" is five different fights.
    picked = []
    for tot, s, chunk in out:
        if any(abs(s - p[1]) < window for p in picked):
            continue
        picked.append((tot, s, chunk))
        if len(picked) >= top:
            break
    return picked


def report(tot, start, chunk, window):
    hhmmss = '%02d:%02d:%02d' % (start // 3600, start // 60 % 60, start % 60)
    span = max(1, (chunk[-1][0] - chunk[0][0]) or window)
    print('\nwindow starting %s   %d hits   %.2f M total   %s s span'
          % (hhmmss, len(chunk), tot / 1e6, span))
    print('  DPS over %ds window : %s' % (window, '{:,.0f}'.format(tot / window)))
    print('  DPS over active span: %s' % '{:,.0f}'.format(tot / span))

    by = collections.defaultdict(lambda: [0.0, 0])
    for _, amt, _, skill in chunk:
        by[skill][0] += amt
        by[skill][1] += 1
    print('  %-22s %>12s %8s %10s %7s' .replace('%>', '%')
          % ('skill', 'damage', 'hits', 'avg hit', 'share'))
    for skill, (dmg, n) in sorted(by.items(), key=lambda kv: -kv[1][0]):
        print('  %-22s %12s %8d %10s %6.1f%%'
              % (skill, '{:,.0f}'.format(dmg), n,
                 '{:,.0f}'.format(dmg / n), 100 * dmg / tot))

    ele = collections.defaultdict(float)
    for _, amt, e, _ in chunk:
        ele[e] += amt
    print('  by element:', ', '.join(
        '%s %.1f%%' % (e, 100 * v / tot)
        for e, v in sorted(ele.items(), key=lambda kv: -kv[1])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--log', default=LOG)
    ap.add_argument('--window', type=int, default=60)
    ap.add_argument('--top', type=int, default=1)
    args = ap.parse_args()

    hits = parse(args.log)
    print('parsed %d hits from %s' % (len(hits), os.path.basename(args.log)))
    if not hits:
        return
    for tot, start, chunk in best_windows(hits, args.window, args.top):
        report(tot, start, chunk, args.window)


if __name__ == '__main__':
    main()
