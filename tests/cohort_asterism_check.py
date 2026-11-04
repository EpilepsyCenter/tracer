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

# Distribution metrics (many values per cell) and time courses.
def _cells(mu, n_cells, n_events, prefix):
    return [{'label': f'{prefix}{i + 1}', 'values': list(rng.lognormal(np.log(mu), 0.4, n_events))}
            for i in range(n_cells)]


dist_cases = {
    'unpaired_2': {'tags': ['WT', 'KO'], 'cells': [_cells(20, 6, 80, 'w'), _cells(26, 7, 80, 'k')]},
    'paired_2': {'tags': ['baseline', 'drug'], 'cells': [_cells(20, 6, 60, 'c'), _cells(24, 6, 60, 'c')]},
}
dist_cases['paired_2']['cells'][1][2] = {'label': 'c3', 'values': []}      # a cell missing in drug
ts_between = [[{'label': f'c{i}', 'values': list(1 + 0.04 * np.arange(12) + rng.normal(0, 0.08, 12) + rng.normal(0, 0.1))}
               for i in range(6)],
              [{'label': f'd{i}', 'values': list(1 + 0.015 * np.arange(12) + rng.normal(0, 0.08, 12) + rng.normal(0, 0.1))}
               for i in range(5)]]
_off = rng.normal(0, 0.1, 6)
ts_within = [[{'label': f'c{i}', 'values': list(1 + 0.02 * np.arange(12) + rng.normal(0, 0.06, 12) + _off[i])} for i in range(6)],
             [{'label': f'c{i}', 'values': list(1 + 0.05 * np.arange(12) + rng.normal(0, 0.06, 12) + _off[i])} for i in range(6)]]
dist_files = {}
with tempfile.TemporaryDirectory() as d2:
    for kind, dc in dist_cases.items():
        payload = {'design_kind': kind, 'tables': [], 'distributions': [
            {'metric': 'amplitude', 'kind': 'distribution', 'tags': dc['tags'], 'cells': dc['cells']},
            {'metric': 'ltp_norm', 'kind': 'timeseries', 'tags': dc['tags'],
             'cells': ts_between if kind == 'unpaired_2' else ts_within, 'bin_width_s': 60.0}]}
        proj = cohort_asterism.build_project(payload)
        names = [(t['name'], t['type']) for t in proj['tables']]
        check(f'dist {kind}: five tables', names == [
            ('amplitude — per-cell mean', 'column'), ('amplitude — by cell', 'nested'),
            ('amplitude — cumulative distribution', 'xy'), ('amplitude — pooled events', 'column'),
            ('ltp_norm — time course', 'xy')], names)
        path = Path(d2) / f'dist_{kind}.asterism'
        path.write_bytes(cohort_asterism.write_asterism(payload))
        # Cohort's own numbers for the same data.
        means = [[float(np.mean(c['values'])) if c['values'] else None for c in g] for g in dc['cells']]
        if kind == 'unpaired_2':
            means = [[m for m in g if m is not None] for g in means]
        r_mean = cohort_stats.run_test([{'tag': t, 'values': v} for t, v in zip(dc['tags'], means)], kind)
        pooled = [np.array([v for c in g for v in c['values']]) for g in dc['cells']]
        r_ks = cohort_stats._pooled_ks_2(pooled[0], pooled[1]) if kind == 'unpaired_2' else None
        # Two-way ANOVA reference (pingouin): time × group, cells as subjects.
        import pandas as pd
        import pingouin as pg
        tsg = ts_between if kind == 'unpaired_2' else ts_within
        long = pd.DataFrame([{'subj': c['label'], 'g': tag, 'time': t, 'v': v}
                             for g, tag in zip(tsg, dc['tags']) for c in g for t, v in enumerate(c['values'])])
        if kind == 'unpaired_2':
            ref = pg.mixed_anova(long, dv='v', within='time', between='g', subject='subj')
            src = 'g'
        else:
            ref = pg.rm_anova(long, dv='v', within=['time', 'g'], subject='subj')
            src = 'g'
        pcol = 'p_unc' if 'p_unc' in ref else 'p-unc'
        group_p = float(ref.loc[ref['Source'] == src, pcol].iloc[0])
        dist_files[str(path)] = {'kind': kind, 'mean_p': r_mean.get('p'), 'ks_p': (r_ks or {}).get('p'),
                                 'anova_group_p': group_p}

    if ASTERISM_PY.exists():
        script = r'''
import json, sys, warnings
warnings.simplefilter("ignore")
from asterism.doc import fileformat
from asterism.analysis import engine
out = {}
for path in json.loads(sys.argv[1]):
    p = fileformat.load(path, engine)
    res = {}
    for a in p.analyses:
        r = engine.run(a)
        sections, cur = {}, None
        for label, vals, style in (r.pages[0].rows if r.pages else []):
            if style == "section":
                cur = label
            elif label == "P value" and cur:
                sections[cur] = vals[0] if vals else ""
        res[a.table.name] = {"p": r.p, "error": r.error, "type": a.analysis_type, "sections": sections}
    out[path] = {"tables": [(t.name, t.table_type, t.ncols, t.width()) for t in p.tables],
                 "graphs": len(p.graphs), "analyses": res}
print(json.dumps(out))
'''
        proc = subprocess.run([str(ASTERISM_PY), '-c', script, json.dumps(list(dist_files))],
                              cwd=str(ASTERISM), capture_output=True, text=True,
                              env={'PYTHONPATH': str(ASTERISM), 'PATH': '/usr/bin:/bin'})
        if proc.returncode != 0:
            failures.append('ASTERISM could not open the distribution files:\n' + proc.stderr[-2000:])
        else:
            got = json.loads(proc.stdout.strip().splitlines()[-1])
            for path, e in dist_files.items():
                g = got[path]
                kind = e['kind']
                check(f'dist {kind}: opens, a graph per table', g['graphs'] == 5 and len(g['tables']) == 5, g)
                a = g['analyses']
                m = a.get('amplitude — per-cell mean') or {}
                print(f"  dist {kind:11s} per-cell mean  Cohort p={e['mean_p']:.6g}  ASTERISM p={m.get('p')}")
                check(f'dist {kind}: per-cell mean same p', m.get('p') is not None
                      and abs(m['p'] - e['mean_p']) < 1e-6 + 1e-3 * e['mean_p'], (m, e['mean_p']))
                av = a.get('ltp_norm — time course') or {}
                gp = (av.get('sections') or {}).get('Condition' if kind == 'paired_2' else 'Group', '')
                print(f"  dist {kind:11s} two-way ANOVA  group effect: pingouin p={e['anova_group_p']:.4f}  ASTERISM p={gp}")
                check(f'dist {kind}: two-way ANOVA group effect same p', gp not in ('', None)
                      and (gp == '<0.0001' and e['anova_group_p'] < 1e-4 or
                           gp != '<0.0001' and abs(float(gp) - e['anova_group_p']) < 6e-5), (gp, e['anova_group_p'], av))
                if kind == 'unpaired_2':
                    ks = a.get('amplitude — pooled events') or {}
                    nest = a.get('amplitude — by cell') or {}
                    print(f"  dist {kind:11s} pooled K-S     Cohort p={e['ks_p']:.6g}  ASTERISM p={ks.get('p')}")
                    print(f"  dist {kind:11s} nested t test  ASTERISM p={nest.get('p')}")
                    check('dist unpaired: pooled K-S same p', ks.get('p') is not None
                          and abs(ks['p'] - e['ks_p']) < 1e-6 + 1e-3 * e['ks_p'], (ks, e['ks_p']))
                    check('dist unpaired: nested test runs', nest.get('p') is not None and not nest.get('error'), nest)
                else:
                    check('dist paired: no unpaired-only tests', 'amplitude — by cell' not in a
                          and 'amplitude — pooled events' not in a, list(a))
                    check('dist paired: time course matched in every cell',
                          (av.get('type') == 'anova2'), av)

proj = cohort_asterism.build_project({'design_kind': 'unpaired_2', 'tables': [
    {'metric': 'n_bins', 'tags': ['a', 'b'], 'values': [[60.0] * 5, [60.0] * 5]}]})
check('untestable metric: table and graph, no test', len(proj['tables']) == 1 and len(proj['graphs']) == 1
      and not proj['analyses'], proj['analyses'])

if failures:
    print('FAILED')
    for f in failures:
        print('  -', f)
    sys.exit(1)
print('OK')
