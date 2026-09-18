#!/usr/bin/env python3
"""
CTE2 PoB - Step 1b: turn the talent-tree grid into a real graph.

Mirrors Mine & Slash's TalentGrid/GridPoint parser:
  - every non-empty cell is a GridPoint; adjacency is 8-way
    (getEligibleSurroundingPoints scans -1..+1 on both axes)
  - a cell whose token is a known perk id is a *node*; anything else is a
    *connector*, and the token labels the wire so crossing wires don't splice
  - GridPoint.MAX_DISTANCE = 12 bounds how far a wire may be followed

Nodes are never adjacent to each other in this data - every link runs through
connectors - so all edges come from walking wires.

Roots are the perks of type START (one per class), not [CENTER]; [CENTER] is a
layout origin and is deliberately left unconnected in the source grid.
"""
import argparse, json, os
from collections import defaultdict, deque

NEIGHBOURS = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx, dy) != (0, 0)]
CENTER = '[CENTER]'
MAX_DISTANCE = 12


def build(tree, perks, max_distance=MAX_DISTANCE):
    cells = {(n['x'], n['y']): n['token'] for n in tree['nodes']}

    def is_node(tok):
        return tok == CENTER or tok in perks

    nodes = {p: t for p, t in cells.items() if is_node(t)}
    edges = set()
    # The wire's actual cells, keyed by edge. A connector run bends around other
    # nodes, so drawing an edge as a straight line between the two node centres
    # cuts a diagonal clean across the tree. Keeping the path makes the render
    # follow the same route the game does.
    paths = {}

    for a in nodes:
        # Step onto each adjacent connector and follow that wire only.
        for dx, dy in NEIGHBOURS:
            first = (a[0] + dx, a[1] + dy)
            tok = cells.get(first)
            if tok is None or is_node(tok):
                continue
            dq = deque([(first, 1)])
            seen = {first}
            parent = {first: None}
            while dq:
                cur, dist = dq.popleft()
                for ex, ey in NEIGHBOURS:
                    q = (cur[0] + ex, cur[1] + ey)
                    tq = cells.get(q)
                    if tq is None:
                        continue
                    if is_node(tq):
                        if q != a:
                            key = tuple(sorted((a, q)))
                            edges.add(key)
                            # Shortest wire wins if two runs reach the same pair.
                            run = []
                            back = cur
                            while back is not None:
                                run.append(back)
                                back = parent[back]
                            run.reverse()
                            route = [a] + run + [q]
                            if key[0] != a:
                                route.reverse()
                            if key not in paths or len(route) < len(paths[key]):
                                paths[key] = route
                    elif tq == tok and q not in seen and dist < max_distance:
                        seen.add(q)
                        parent[q] = cur
                        dq.append((q, dist + 1))
    return cells, nodes, edges, paths


def analyse(name, tree, perks, max_distance):
    cells, nodes, edges, paths = build(tree, perks, max_distance)

    adj = defaultdict(set)
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)

    starts = {k for k, v in perks.items() if v.get('type') == 'START'}
    roots = [p for p, t in nodes.items() if t in starts]

    reached = set(roots)
    dq = deque(roots)
    while dq:
        cur = dq.popleft()
        for nb in adj[cur]:
            if nb not in reached:
                reached.add(nb)
                dq.append(nb)

    # Connected components, to see whether the tree is one piece.
    comps, unvisited = [], set(nodes)
    while unvisited:
        seed = unvisited.pop()
        comp = {seed}
        dq = deque([seed])
        while dq:
            cur = dq.popleft()
            for nb in adj[cur]:
                if nb not in comp:
                    comp.add(nb)
                    unvisited.discard(nb)
                    dq.append(nb)
        comps.append(comp)
    comps.sort(key=len, reverse=True)

    degrees = sorted((len(adj[p]) for p in nodes), reverse=True)
    print('\n== {} =='.format(name))
    print('  cells {:<6} nodes {:<5} connectors {:<6} edges {}'.format(
        len(cells), len(nodes), len(cells) - len(nodes), len(edges)))
    print('  start nodes: {}  {}'.format(
        len(roots), sorted({nodes[p] for p in roots})))
    print('  reachable from starts: {}/{} ({:.1f}%)'.format(
        len(reached), len(nodes), 100.0 * len(reached) / max(1, len(nodes))))
    print('  components: {}  sizes {}'.format(len(comps), [len(c) for c in comps[:6]]))
    print('  degree  max {}  median {}'.format(
        degrees[0] if degrees else 0, degrees[len(degrees) // 2] if degrees else 0))

    return {
        'id': name,
        'size': tree['size'],
        'max_distance': max_distance,
        'nodes': [
            {'x': p[0], 'y': p[1], 'perk': t,
             'type': perks.get(t, {}).get('type'),
             'is_start': t in starts,
             'reachable': p in reached}
            for p, t in sorted(nodes.items())
        ],
        'edges': [{'a': list(a), 'b': list(b),
                   'path': [list(c) for c in paths.get((a, b), [a, b])]}
                  for a, b in sorted(edges)],
        'stats': {
            'cells': len(cells), 'nodes': len(nodes), 'edges': len(edges),
            'starts': len(roots), 'reachable': len(reached),
            'components': len(comps),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    ap.add_argument('--max-distance', type=int, default=MAX_DISTANCE)
    args = ap.parse_args()

    trees = json.load(open(os.path.join(args.out, 'talent_trees_decoded.json'), encoding='utf-8'))
    perks = json.load(open(os.path.join(args.out, 'mmorpg_perk.json'), encoding='utf-8'))

    result = {n: analyse(n, t, perks, args.max_distance) for n, t in trees.items()}
    dest = os.path.join(args.out, 'talent_graphs.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(result, fh, indent=1)
    print('\n  -> {}'.format(dest))


if __name__ == '__main__':
    main()
