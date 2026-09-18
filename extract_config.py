#!/usr/bin/env python3
"""
CTE2 PoB - Step 1e: ingest the pack's configs.

Two of the five stat families I was reverse-engineering from bytecode turned out
to be plain pack configuration. Configs are a first-class input, not an
afterthought, so they get extracted alongside the datapack and the jar.

The compat preset is the important one: a single COMPATIBILITY_PRESETS key
selects a block that decides the balance datapack, the base-stat profile, the
health system, the resist ladder, and several damage multipliers.
"""
import argparse, json, os, re

# Keys inside the selected compatibility preset that change stat math.
PRESET_KEYS = (
    'DAMAGE_SYSTEM', 'HEALTH_SYSTEM', 'DISABLE_VANILLA_HEALTH_REGEN',
    'ENERGY_PENALTY', 'IGNORE_WEAPON_REQUIREMENTS_FOR_SPELLS',
    'BALANCE_DATAPACK', 'BASE_STATS_DATAPACK', 'ENABLE_MINUS_RESISTS_PER_LEVEL',
    'MOB_FLAT_DAMAGE_BONUS', 'MOB_PERCENT_DAMAGE_AS_BONUS',
    'STAT_REQUIREMENTS_MULTIPLIER', 'SPELL_BASE_DAMAGE_MULTIPLIER',
    'DAMAGE_CONVERSION_LOSS', 'VANILLA_TO_WEAPON_DAMAGE_PERCENT',
    'ITEM_DAMAGE_CAP_PER_HIT', 'CAP_ITEM_DAMAGE', 'DISABLE_MOB_IFRAMES',
)


def coerce(raw):
    raw = raw.strip()
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    if raw in ('true', 'false'):
        return raw == 'true'
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        return raw


def read_preset(path):
    """Pull the active compatibility preset and its settings out of the TOML."""
    txt = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'^\s*COMPATIBILITY_PRESETS\s*=\s*"([A-Z_]+)"', txt, re.M)
    preset = m.group(1) if m else None
    out = {'active_preset': preset, 'settings': {}, 'all_presets': []}

    for pm in re.finditer(r'^\s*\[compatibility_configs\.([A-Z_]+)\]', txt, re.M):
        out['all_presets'].append(pm.group(1))

    if not preset:
        return out
    sec = re.search(r'\[compatibility_configs\.' + preset + r'\](.*?)(?=^\s*\[|\Z)',
                    txt, re.S | re.M)
    if sec:
        for key in PRESET_KEYS:
            km = re.search(r'^\s*' + key + r'\s*=\s*(.+)$', sec.group(1), re.M)
            if km:
                out['settings'][key] = coerce(km.group(1))
    return out


def read_flat_toml(path, wanted=None):
    """Flat key=value scrape. Enough for the server/common configs we care about."""
    out = {}
    section = ''
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.rstrip('\n')
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        if s.startswith('[') and s.endswith(']'):
            section = s[1:-1]
            continue
        if '=' not in s:
            continue
        k, v = s.split('=', 1)
        k = k.strip()
        if wanted and k not in wanted:
            continue
        # Skip the giant list values (gear_compatibility etc.) - not stat math.
        if v.strip().startswith('['):
            continue
        out[(section + '.' if section else '') + k] = coerce(v)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', default='C:/CTE2')
    ap.add_argument('--out', default='C:/CTE2/cte2-pob/out')
    args = ap.parse_args()

    bundle = {}
    # defaultconfigs is what a fresh world copies from; config/ wins if present.
    for folder in ('config', 'defaultconfigs'):
        base = os.path.join(args.pack, folder)
        if not os.path.isdir(base):
            continue
        for fn in sorted(os.listdir(base)):
            low = fn.lower()
            if not low.endswith(('.toml', '.txt')):
                continue
            if 'mine_and_slash' not in low and 'lightmanscurrency' not in low:
                continue
            path = os.path.join(base, fn)
            key = fn
            if 'compatibility' in low:
                bundle[key] = read_preset(path)
            else:
                bundle[key] = read_flat_toml(path)

    dest = os.path.join(args.out, 'pack_config.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(bundle, fh, indent=1, sort_keys=True)

    print('config files ingested: {}'.format(len(bundle)))
    for name, val in sorted(bundle.items()):
        if isinstance(val, dict) and 'active_preset' in val:
            print('  {}'.format(name))
            print('     active preset : {}  (of {})'.format(
                val['active_preset'], ', '.join(val['all_presets'])))
            for k, v in val['settings'].items():
                print('       {:<38} {}'.format(k, v))
        else:
            print('  {:<52} {} keys'.format(name, len(val)))
    print('  -> {}'.format(dest))


if __name__ == '__main__':
    main()
