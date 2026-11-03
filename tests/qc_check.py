"""QC engine check: verdicts from existing Resistance / Cursor results.

Synthetic sidecars cover both ways the lab measures Rs (test pulse in
the data sweeps, or a separately tagged test-pulse series), missing
results, several series per tag, conditions a cell didn't record,
current-clamp Vm, both cell rules, overrides and the folder I/O.
Run from the repo root:  python tests/qc_check.py
"""

import copy
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from analysis import qc  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    if not ok:
        failures.append(f"{name}{' — ' + detail if detail else ''}")


def rs_rows(rs, holding=-50.0, n=3):
    return [{'rs': rs, 'rin': 300.0, 'cm': 20.0, 'baseline': holding, 'source': f'sweep {i + 1}'}
            for i in range(n)]


def cursor(vm, n=3, slots=2):
    return {'traceUnit': 'mV', 'measurements': [
        {'slot': s, 'sweep': i, 'baseline': vm, 'amplitude': 1.0} for i in range(n) for s in range(slots)]}


def sidecar(series_tags, resistance=None, cursors=None):
    return {'format': 'tracer-sidecar', 'version': 4,
            'meta': {'group_tags': ['WT'], 'series_tags': series_tags},
            'analyses': {'resistance': resistance or {}, 'cursor_analyses': cursors or {}}}


def config(conditions, reference=0, cell_rule='exclude-condition', overrides=None):
    c = qc.default_config()
    c['conditions'] = conditions
    c['reference'] = reference
    c['cell_rule'] = cell_rule
    c['overrides'] = overrides or {}
    return c


BASE_DRUG = [{'name': 'Baseline', 'tag': 'baseline'}, {'name': 'Drug 1', 'tag': 'drug1'}]


def cond(cell, name):
    return next(c for c in cell['conditions'] if c['name'] == name)


# 1. Test pulse inside the data sweeps: Rs 15 → 17 MΩ (+13 %) passes.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(17.0)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'a.dat')
check('in-sweep: matched', cell['matched'])
check('in-sweep: pass', cell['verdict'] == 'pass', str(cell['reasons']))
check('in-sweep: Rs change', abs(cond(cell, 'Drug 1')['changes']['rs_change_pct'] - 13.333) < 0.01,
      str(cond(cell, 'Drug 1')['changes']))
check('in-sweep: Vm not applicable on a VC cell',
      not any(ch['metric'] == 'vm_mv' for c in cell['conditions'] for ch in c['checks']))

# 2. Rs change +27 % fails the drug condition only.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(19.0)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'b.dat')
check('change fail: drug fails', cond(cell, 'Drug 1')['verdict'] == 'fail')
check('change fail: baseline passes', cond(cell, 'Baseline')['verdict'] == 'pass')
check('change fail: reason', any('Rs change' in r and '> 20' in r for r in cell['reasons']), str(cell['reasons']))
check('change fail: baseline row kept', qc.row_status(cell, '0:1', ['baseline'], 'exclude-condition')['status'] == 'pass')
check('change fail: drug row out', qc.row_status(cell, '0:2', ['drug1'], 'exclude-condition')['status'] == 'fail')
check('change fail: strict rule drops baseline too',
      qc.row_status(cell, '0:1', ['baseline'], 'exclude-cell')['status'] == 'fail')

# 3. Absolute Rs above 25 MΩ fails even without a change.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(26.0), '0:2': rs_rows(26.0)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'c.dat')
check('absolute Rs: fail', cond(cell, 'Baseline')['verdict'] == 'fail' and cell['verdict'] == 'fail')

# 4. Separate test-pulse series: condition measured on 'tp_drug1',
#    judging the data series tagged 'drug1'.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1'], '0:3': ['tp_drug1']},
             resistance={'0:1': rs_rows(15.0), '0:3': rs_rows(20.0)})
conds = [{'name': 'Baseline', 'tag': 'baseline'},
         {'name': 'Drug 1', 'tag': 'tp_drug1', 'applies_to': ['drug1']}]
cell = qc.evaluate_cell(sc, config(conds), 'd.dat')
check('separate TP: measured on tp series', cond(cell, 'Drug 1')['series'] == ['0:3'])
check('separate TP: fails', cond(cell, 'Drug 1')['verdict'] == 'fail')
check('separate TP: judges the drug1 data series',
      qc.row_status(cell, '0:2', ['drug1'], 'exclude-condition')['status'] == 'fail')
check('separate TP: a series no condition judges stays in',
      qc.row_status(cell, '0:9', ['iv'], 'exclude-condition')['status'] == 'not judged')

# 4b. Mixed methods in one folder: a condition measured in 'drug1' OR
#     'tp_drug1' takes whichever the cell has, and judges both tags.
mixed = [{'name': 'Baseline', 'tags': ['baseline']}, {'name': 'Drug 1', 'tags': ['drug1', 'tp_drug1']}]
in_sweep = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
                   resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(16.0)})
separate = sidecar({'0:1': ['baseline'], '0:2': ['drug1'], '0:3': ['tp_drug1']},
                   resistance={'0:1': rs_rows(15.0), '0:3': rs_rows(16.0)})
for label, sc_ in (('in-sweep', in_sweep), ('separate', separate)):
    cell = qc.evaluate_cell(sc_, config(mixed), 'mixed.dat')
    check(f'mixed {label}: pass', cell['verdict'] == 'pass', str(cell['reasons']))
    check(f'mixed {label}: drug row judged',
          qc.row_status(cell, '0:2', ['drug1'], 'exclude-condition')['status'] == 'pass')
cell = qc.evaluate_cell(separate, config(mixed), 'mixed.dat')
check('mixed: uses the series that has results', abs(cond(cell, 'Drug 1')['values']['rs_mohm'] - 16.0) < 1e-9)

# 5. Tagged series without a Resistance result → missing → warn.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']}, resistance={'0:1': rs_rows(15.0)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'e.dat')
d = cond(cell, 'Drug 1')
check('missing: warn', d['verdict'] == 'warn', str(d['checks']))
check('missing: tells what to run', any("no Resistance result — run Resistance on the series tagged 'drug1'" in r for r in cell['reasons']),
      str(cell['reasons']))
cfg = config(BASE_DRUG)
cfg['missing'] = 'fail'
check('missing: reported once per analysis', sum('Drug 1:' in r for r in cell['reasons']) == 1, str(cell['reasons']))
check('missing: level is configurable', cond(qc.evaluate_cell(sc, cfg, 'e.dat'), 'Drug 1')['verdict'] == 'fail')

# 6. No Rs anywhere: Rs is required → missing, not a silent pass.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'f.dat')
check('no Rs anywhere: warn', cell['verdict'] == 'warn', str(cell['reasons']))

# 7. Two series with the same tag are averaged.
sc = sidecar({'0:1': ['baseline'], '0:4': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(14.0), '0:4': rs_rows(16.0), '0:2': rs_rows(16.0)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'g.dat')
b = cond(cell, 'Baseline')
check('two series: averaged', abs(b['values']['rs_mohm'] - 15.0) < 1e-9 and b['series'] == ['0:1', '0:4'])

# 8. A condition the cell didn't record doesn't count against it.
conds = BASE_DRUG + [{'name': 'Washout', 'tag': 'washout'}]
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(16.0)})
cell = qc.evaluate_cell(sc, config(conds), 'h.dat')
check('not recorded: status', cond(cell, 'Washout')['status'] == 'not recorded')
check('not recorded: cell still passes', cell['verdict'] == 'pass')

# 9. Current clamp: Vm from the Cursor baseline (once per sweep, not per slot).
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(15.0)},
             cursors={'0:1': cursor(-65.0), '0:2': cursor(-52.0)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'i.dat')
check('Vm: value', abs(cond(cell, 'Baseline')['values']['vm_mv'] + 65.0) < 1e-9)
check('Vm: depolarised fails', cond(cell, 'Drug 1')['verdict'] == 'fail', str(cond(cell, 'Drug 1')['checks']))
check('Vm: change', abs(cond(cell, 'Drug 1')['changes']['vm_change_mv'] - 13.0) < 1e-9)
sc2 = copy.deepcopy(sc)
del sc2['analyses']['cursor_analyses']['0:2']
cell = qc.evaluate_cell(sc2, config(BASE_DRUG), 'i2.dat')
check('Vm: missing in one condition of a CC cell → warn',
      any("no Cursor result — run Cursor on the series tagged 'drug1'" in r for r in cell['reasons']), str(cell['reasons']))

# 10. Holding current below −200 pA fails.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(15.0, holding=-80), '0:2': rs_rows(15.0, holding=-250)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG), 'j.dat')
check('holding: fail', cond(cell, 'Drug 1')['verdict'] == 'fail')
check('holding: change', abs(cond(cell, 'Drug 1')['changes']['holding_change_pa'] + 170) < 1e-9)

# 11. The reference can be any condition.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(10.0), '0:2': rs_rows(20.0)})
cell = qc.evaluate_cell(sc, config(BASE_DRUG, reference=1), 'k.dat')
check('reference: change vs drug', abs(cond(cell, 'Baseline')['changes']['rs_change_pct'] + 50) < 1e-9
      and cond(cell, 'Drug 1')['changes']['rs_change_pct'] is None)

# 12. Overrides: per condition and per cell, with reasons.
sc = sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
             resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(19.0)})
ov = {'l.dat': {'conditions': {'Drug 1': {'verdict': 'pass', 'reason': 'Rs re-compensated', 'date': '2026-11-03'}}}}
cell = qc.evaluate_cell(sc, config(BASE_DRUG, overrides=ov), 'l.dat')
check('override: condition', cond(cell, 'Drug 1')['verdict'] == 'pass'
      and cond(cell, 'Drug 1')['auto_verdict'] == 'fail' and cell['verdict'] == 'pass')
check('override: reason listed', any('Rs re-compensated' in r for r in cell['reasons']))
ov = {'l.dat': {'cell': {'verdict': 'fail', 'reason': 'seal lost', 'date': '2026-11-03'}}}
cell = qc.evaluate_cell(sc, config(BASE_DRUG, overrides=ov), 'l.dat')
check('override: cell', cell['verdict'] == 'fail' and cell['reasons'][0].startswith('Cell set to fail'))
check('override: other files unaffected', qc.evaluate_cell(sc, config(BASE_DRUG, overrides=ov), 'x.dat')['override'] is None)

# 13. Tags match case-insensitively; warn levels work.
sc = sidecar({'0:1': ['Baseline'], '0:2': ['DRUG1']},
             resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(22.0)})
cfg = config(BASE_DRUG)
cfg['rules'][0]['warn'] = {'op': '>', 'value': 20}
cell = qc.evaluate_cell(sc, cfg, 'm.dat')
check('case-insensitive tags', cell['matched'])
check('warn level', cond(cell, 'Drug 1')['verdict'] == 'fail'  # +47 % change fails
      and any(ch['metric'] == 'rs_mohm' and ch['level'] == 'warn' for ch in cond(cell, 'Drug 1')['checks']))

# 14. Inclusion switch.
check('include all', qc.included('fail', 'all'))
check('include pass', not qc.included('warn', 'pass') and qc.included('pass', 'pass'))
check('include pass+warn', qc.included('warn', 'pass_warn') and not qc.included('fail', 'pass_warn'))
check('unjudged rows always included', qc.included('not checked', 'pass') and qc.included('not judged', 'pass'))

# 15. Folder level: tags, evaluation, unmatched files, missing list, rules file.
with tempfile.TemporaryDirectory() as d:
    files = {
        'c1.dat': sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
                          resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(16.0)}),
        'c2.dat': sidecar({'0:1': ['baseline'], '0:2': ['drug1']},
                          resistance={'0:1': rs_rows(15.0), '0:2': rs_rows(25.0)}),
        'c3.dat': sidecar({'0:1': ['baseline'], '0:2': ['drug1']}, resistance={'0:1': rs_rows(15.0)}),
        'other.dat': sidecar({'0:1': ['iv']}),
    }
    for name, s in files.items():
        (Path(d) / name).touch()
        (Path(d) / (name + '.tracer')).write_text(json.dumps(s))
    tags = {t['tag']: t for t in qc.available_tags(d)}
    check('tags: listed with counts', tags.get('baseline', {}).get('n_resistance') == 3
          and tags.get('drug1', {}).get('n_resistance') == 2 and 'iv' not in tags, str(tags))
    res = qc.evaluate_folder(d, config(BASE_DRUG))
    verdicts = {c['file_name']: c['verdict'] for c in res['cells']}
    check('folder: verdicts', verdicts == {'c1.dat': 'pass', 'c2.dat': 'fail', 'c3.dat': 'warn'}, str(verdicts))
    check('folder: unmatched listed', [u['file_name'] for u in res['unmatched']] == ['other.dat'])
    check('folder: missing listed', res['missing'] and res['missing'][0]['files'] == ['c3.dat']
          and res['missing'][0]['analysis'] == 'Resistance', str(res['missing']))
    check('folder: summary', res['summary'] == {'pass': 1, 'warn': 1, 'fail': 1, 'judged': 3, 'not_checked': 1},
          str(res['summary']))
    check('rules file: absent', qc.load_config(d) is None)
    cfg = config(BASE_DRUG)
    qc.save_config(d, cfg)
    back = qc.load_config(d)
    check('rules file: round trip', back is not None and back['conditions'] == BASE_DRUG
          and (Path(d) / 'tracer_qc.json').exists())

if failures:
    print('FAILED')
    for f in failures:
        print('  -', f)
    sys.exit(1)
print('OK')
