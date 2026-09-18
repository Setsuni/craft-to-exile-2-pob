#!/usr/bin/env python3
"""
CTE2 PoB - Step 1c: render the parsed talent graphs to SVG.

A visual sanity check on the parse: if the wires and node classes line up with
the in-game tree, the grid decoding and edge-walking are right.
No dependencies - SVG is written by hand.
"""
import argparse, json, os

CELL = 16
PAD = 40

# Perk type -> (fill, radius). START and MAJOR are the landmarks you can
# recognise against the in-game tree at a glance.
STYLE = {
    'START':   ('#ffd24a', 9.5),
    'MAJOR':   ('#ff8a3d', 7.0),
    'SPECIAL': ('#c07bff', 6.0),
    'ASC':     ('#4ad6ff', 6.5),
    'STAT':    ('#8fa6c4', 3.4),
    None:      ('#6b7a90', 3.0),
}

BG = '#11151c'
EDGE = '#3a4657'


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def render(tree, title):
    nodes = tree['nodes']
    edges = tree['edges']
    xs = [n['x'] for n in nodes]
    ys = [n['y'] for n in nodes]
    for e in edges:
        xs += [e['a'][0], e['b'][0]]
        ys += [e['a'][1], e['b'][1]]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)

    def px(x):
        return (x - minx) * CELL + PAD

    def py(y):
        return (y - miny) * CELL + PAD

    w = (maxx - minx) * CELL + PAD * 2
    h = (maxy - miny) * CELL + PAD * 2 + 70

    out = []
    out.append('<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" '
               'viewBox="0 0 {} {}">'.format(w, h, w, h))
    out.append('<rect width="100%" height="100%" fill="{}"/>'.format(BG))
    out.append('<style>text{font-family:ui-monospace,Consolas,monospace}</style>')

    out.append('<g stroke="{}" stroke-width="1.6" stroke-linecap="round">'.format(EDGE))
    for e in edges:
        out.append('<line x1="{:.0f}" y1="{:.0f}" x2="{:.0f}" y2="{:.0f}"/>'.format(
            px(e['a'][0]), py(e['a'][1]), px(e['b'][0]), py(e['b'][1])))
    out.append('</g>')

    # Draw small nodes first so landmarks sit on top.
    order = {'STAT': 0, None: 0, 'SPECIAL': 1, 'ASC': 2, 'MAJOR': 3, 'START': 4}
    for n in sorted(nodes, key=lambda n: order.get(n.get('type'), 0)):
        fill, r = STYLE.get(n.get('type'), STYLE[None])
        stroke = '' if n.get('reachable', True) else ' stroke="#ff4d4d" stroke-width="2"'
        out.append('<circle cx="{:.0f}" cy="{:.0f}" r="{}" fill="{}"{}/>'.format(
            px(n['x']), py(n['y']), r, fill, stroke))
    # Label the landmarks.
    for n in nodes:
        if n.get('type') in ('START', 'ASC'):
            out.append('<text x="{:.0f}" y="{:.0f}" fill="#e8eef7" font-size="11" '
                       'text-anchor="middle">{}</text>'.format(
                           px(n['x']), py(n['y']) - 13, esc(n['perk'])))

    y0 = h - 40
    st = tree['stats']
    out.append('<text x="{}" y="{}" fill="#e8eef7" font-size="17">{}</text>'.format(
        PAD, y0, esc(title)))
    out.append('<text x="{}" y="{}" fill="#9fb0c6" font-size="12">'
               '{} nodes · {} edges · {} connectors · {} components · '
               'reachable {}/{}</text>'.format(
                   PAD, y0 + 20, st['nodes'], st['edges'],
                   st['cells'] - st['nodes'], st['components'],
                   st['reachable'], st['nodes']))
    lx = PAD
    for label in ('START', 'MAJOR', 'SPECIAL', 'ASC', 'STAT'):
        fill, r = STYLE[label]
        out.append('<circle cx="{}" cy="{}" r="{}" fill="{}"/>'.format(lx + 6, y0 - 22, r, fill))
        out.append('<text x="{}" y="{}" fill="#9fb0c6" font-size="12">{}</text>'.format(
            lx + 18, y0 - 18, label))
        lx += 95
    out.append('</svg>')
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    args = ap.parse_args()
    graphs = json.load(open(os.path.join(args.out, 'talent_graphs.json'), encoding='utf-8'))
    for name, tree in graphs.items():
        svg = render(tree, 'CTE2 / Mine & Slash - {} tree'.format(name))
        dest = os.path.join(args.out, 'tree_{}.svg'.format(name))
        with open(dest, 'w', encoding='utf-8') as fh:
            fh.write(svg)
        print('  {:<16} {:>7} KB  -> {}'.format(name, len(svg) // 1024, dest))


if __name__ == '__main__':
    main()
