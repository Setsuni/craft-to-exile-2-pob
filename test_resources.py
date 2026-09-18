"""Run the shared, hand-calculated conversion cases through the Python engine."""
import json
import subprocess
import resolve

cases = json.loads(subprocess.check_output(['node', 'test_resources.js', '--cases'], text=True))
for case in cases:
    for reverse in (False, True):
        definitions = {}
        for row in (reversed(case['derived']) if reverse else case['derived']):
            sid, source, target, priority, *tail = row
            definitions[sid] = {'ser': tail[0] if tail else 'one_to_other', 'data': {
                'adder_stat': source, 'add_to': target, 'priority': priority,
                'per_amount': tail[1] if len(tail) > 1 else 1, 'perc': True}}

        class Rules:
            stats = definitions

            def stat_def(self, sid):
                return {'multiUseType': 'MULTIPLY_STAT', **case.get('limits', {}).get(sid, {})}

        rules = Rules()
        sheet = resolve.Sheet()
        for sid, kind, value in case['mods']:
            sheet.add(sid, kind, value, 'test')
        resolve.apply_derived(sheet, rules)
        for sid, expected in case['expected'].items():
            assert sheet.total(sid, rules) == expected, (case['name'], sid, sheet.total(sid, rules), expected)
    print('PASS ' + case['name'])
