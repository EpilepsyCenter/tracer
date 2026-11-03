"""Cohort → ASTERISM project export.

Writes projects for the four Cohort designs and checks the file layout.
When the ASTERISM repo sits next to TRACER (../asterism, with its
.venv), each project is also opened with ASTERISM's own reader, every
analysis is recomputed by ASTERISM, and its p-value is compared with
Cohort's for the same data — so the file opens and means the same thing.
Run from the repo root:  python tests/cohort_asterism_check.py
"""

import json
import subprocess
import sys
import tempfile
import warnings
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
warnings.simplefilter("ignore")
import numpy as np  # noqa: E402
from analysis import cohort_asterism, cohort_stats  # noqa: E402

ASTERISM = ROOT.parent / "asterism"
ASTERISM_PY = ASTERISM / ".venv" / "bin" / "python"

failures: list[str] = []


def check(name, ok, detail=''):
    if not ok:
        failures.append(f"{name}{' — ' + str(detail) if detail else ''}")


rng = np.random.default_rng(7)
n = 8
base = rng.normal(15, 2, n)
cases = {
    'unpaired_2': [list(rng.normal(15, 2, 7)), list(rng.normal(18, 2, 9))],
    'paired_2': [list(base), list(base + rng.normal(2, 1, n))],
    'oneway_n': [list(rng.normal(m, 2, 8)) for m in (15, 17, 20)],
    'rm_n': [list(base), list(base + rng.normal(1, 1, n)), list(base + rng.normal(3, 1, n))],
}
expected: dict[str, dict] = {}
with tempfile.TemporaryDirectory() as d:
    for kind, groups in cases.items():
        tags = [f'c{i + 1}' for i in range(len(groups))]
        for branch in ('parametric', 'nonparametric'):
            r = cohort_stats.run_test([{'tag': t, 'values': v} for t, v in zip(tags, groups)], kind, branch)
            payload = {
                'design_kind': kind, 'branches': {'rs_mohm': branch},
                'tables': [{'metric': 'rs_mohm', 'label': 'Rs (MΩ)', 'tags': tags, 'values': groups,
                            'row_titles': [f'cell{i + 1}' for i in range(len(groups[0]))]}],
                'stats': {'rs_mohm': r}, 'folder': '/data/CA1 PN', 'analysis_type': 'resistance',
                'design': {'comparison_shape': 'within' if kind in ('paired_2', 'rm_n') else 'between',
                           'selected_tags': tags, 'n_unit': 'cell'},
                'qc': {'active': True, 'include': 'pass_warn',
                       'excluded': [{'file_name': 'x.dat', 'series_key': '0:1', 'status': 'fail', 'reason': 'Rs > 25 MΩ'}]},
                'skipped_metrics': ['amp_distribution'], 'app_version': '1.2.0',
            }
            data = cohort_asterism.write_asterism(payload)
            path = Path(d) / f'{kind}_{branch}.asterism'
            path.write_bytes(data)
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
                check(f'{kind}/{branch}: mimetype first, stored', names[:2] == ['mimetype', 'project.json']
                      and z.getinfo('mimetype').compress_type == zipfile.ZIP_STORED, names)
                proj = json.loads(z.read('project.json'))
            check(f'{kind}/{branch}: one table, graph, analysis',
                  len(proj['tables']) == len(proj['graphs']) == len(proj['analyses']) == 1, proj.keys())
            check(f'{kind}/{branch}: before-after for paired',
                  proj['graphs'][0]['spec']['connect_rows'] == (kind in ('paired_2', 'rm_n')))
            expected[str(path)] = {'p': r.get('p'), 'test': r.get('test'), 'kind': kind, 'branch': branch}

    if ASTERISM_PY.exists():
        script = r'''
import json, sys, warnings
warnings.simplefilter("ignore")
from asterism.doc import fileformat
from asterism.analysis import engine
out = {}
for path in json.loads(sys.argv[1]):
    p = fileformat.load(path, engine)
    a = p.analyses[0]
    res = engine.run(a)
    out[path] = {"tables": len(p.tables), "graphs": len(p.graphs), "infos": len(p.infos),
                 "p": res.p, "error": res.error, "title": res.pages[0].title if res.pages else "",
                 "notes": p.infos[0].notes[:80] if p.infos else ""}
print(json.dumps(out))
'''
        proc = subprocess.run([str(ASTERISM_PY), '-c', script, json.dumps(list(expected))],
                              cwd=str(ASTERISM), capture_output=True, text=True,
                              env={'PYTHONPATH': str(ASTERISM), 'PATH': '/usr/bin:/bin'})
        if proc.returncode != 0:
            failures.append('ASTERISM could not open the files:\n' + proc.stderr[-2000:])
        else:
            got = json.loads(proc.stdout.strip().splitlines()[-1])
            for path, e in expected.items():
                g = got[path]
                label = f"{e['kind']}/{e['branch']}"
                check(f'{label}: ASTERISM opens it', g['tables'] == 1 and g['graphs'] == 1 and g['infos'] == 1, g)
                check(f'{label}: ASTERISM analysis ran', not g['error'] and g['p'] is not None, g)
                if g['p'] is not None and e['p'] is not None:
                    rel = abs(g['p'] - e['p']) / max(e['p'], 1e-12)
                    ok = rel < 1e-3 or abs(g['p'] - e['p']) < 1e-6
                    print(f"  {label:28s} Cohort {e['test']:<32s} p={e['p']:.6g}   "
                          f"ASTERISM {g['title']:<36s} p={g['p']:.6g}{'' if ok else '   ← differs'}")
                    check(f'{label}: same p', ok, (e['p'], g['p']))
    else:
        print('  (ASTERISM repo not found next to TRACER: skipped opening the files in ASTERISM)')

def _normal(mu, sd, n=12):
    """Evenly spread normal quantiles: passes Shapiro-Wilk every time."""
    from scipy.stats import norm
    return list(mu + sd * norm.ppf((np.arange(n) + 0.5) / n))


# Without Cohort's statistics, the export still picks Cohort's test:
# identical paired values must not get a t-test.
proj = cohort_asterism.build_project({
    'design_kind': 'paired_2', 'tables': [{'metric': 'm', 'tags': ['a', 'b'],
                                           'values': [[11.683] * 6, [10.969] * 6]}]})
check('no stats run, identical pairs: Wilcoxon', proj['analyses'][0]['params'].get('test') == 'wilcoxon',
      proj['analyses'][0]['params'])
proj = cohort_asterism.build_project({
    'design_kind': 'unpaired_2', 'tables': [{'metric': 'm', 'tags': ['a', 'b'],
                                             'values': [_normal(10, 2), _normal(13, 2)]}]})
check('no stats run, normal data: Welch', proj['analyses'][0]['params'].get('test') == 'welch',
      proj['analyses'][0]['params'])
check('no stats run: Cohort result in the info sheet', 'Welch' in proj['infos'][0]['notes'], proj['infos'][0]['notes'])

if failures:
    print('FAILED')
    for f in failures:
        print('  -', f)
    sys.exit(1)
print('OK')
