#!/usr/bin/env python3
"""Every rule table the resolver READS is actually LOADED.

    python test_rules_loader.py [out214]

This exists because of a bug that cost sixteen stats and reported nothing.
`Rules.__init__` reads each table as `data.get(name) or {}`, and every consumer
skips a definition it cannot find. So a table nobody loads is not an error - it
is an empty dict, and the feature it drives silently produces zero. The codex
resolved to nothing on every character for as long as `mmorpg_omen.json` went
unloaded, and `spirit_cost` read exactly 100 low because `skills.json` did too.

There were two loaders at the time, this one and batch.py's, and they had
drifted. batch.py now calls this one, and this test checks the remaining half:
that the single loader actually populates every field, and that each field
found a non-empty file.
"""
import json, os, sys, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out214'

# Fields Rules sets from somewhere other than the table dict, so an empty one
# here is not evidence of a missing file.
SET_LATER = {'cfg', 'compat', 'item_attrs', 'graphs', 'base_profiles',
             'health_system', 'newbie_resists', 'support_gems_global'}

fail = []


def check(name, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + name.ljust(46) + detail)
    if not cond:
        fail.append(name)


rules = resolve.load_rules(OUT)

# 1. Every dict field of Rules that came from the table argument is populated.
#    A table that loads empty means the filename is wrong or the file is gone,
#    and either way the feature it drives is silently dead.
empty = [k for k, v in sorted(vars(rules).items())
         if k not in SET_LATER and isinstance(v, dict) and not v]
check('every rule table loaded non-empty', not empty, ', '.join(empty))

# 2. The tables the codex, aura capacity and exile effects need - the three
#    that were actually missing - by name, so a rename cannot quietly drop one.
for field in ('omens', 'skills', 'effects', 'spells'):
    check('rules.%s is populated' % field,
          bool(getattr(rules, field, None)),
          '%d entries' % len(getattr(rules, field, {}) or {}))

# 3. Nothing reads a Rules attribute that the loader never sets. This is the
#    general form of the bug: `rules.omens` was read for months and assigned
#    only from an argument nobody passed.
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        'resolve.py'), encoding='utf-8').read()
read = set(re.findall(r'\brules\.([a-z_]+)', src))
have = set(vars(rules))
# Methods are attributes too - `rules.exact(...)` is not a missing table.
# Excluded by asking the object, rather than by keeping a list that would
# go stale the first time someone adds a method.
methods = {k for k in dir(rules) if callable(getattr(rules, k, None))}
missing = sorted(read - have - methods)
check('nothing reads a field the loader never sets', not missing,
      ', '.join(missing))

# 4. batch.py must not carry its own copy. Two loaders is how the first one
#    fell behind, and a duplicate would pass every check above.
batch = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          'batch.py'), encoding='utf-8').read()
check('batch.py shares the one loader',
      'def load_rules' not in batch, 'no second copy')

print('\nrules loader: ' + ('%d FAILED' % len(fail) if fail
                            else 'all checks passed'))
sys.exit(1 if fail else 0)
