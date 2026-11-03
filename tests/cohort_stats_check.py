"""Cohort statistics: the normality gate and degenerate data.

Identical values must never be called "normal" (Shapiro-Wilk returns
p = 1 on them) and must never get a t-test (t = ∞, p = 0). Paired
designs are judged on the paired differences.
Run from the repo root:  python tests/cohort_stats_check.py
"""

import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
warnings.simplefilter("ignore")
import numpy as np  # noqa: E402
from analysis import cohort_stats as cs, cohort_export  # noqa: E402

failures: list[str] = []


def check(name, ok, detail=''):
    if not ok:
        failures.append(f"{name}{' — ' + str(detail) if detail else ''}")


def run(a, b, kind, override='auto'):
    return cs.run_test([{'tag': 'A', 'values': a}, {'tag': 'B', 'values': b}], kind, override)


same_a, same_b = [11.683] * 6, [10.969] * 6

# Six identical copies: paired differences all equal.
r = run(same_a, same_b, 'paired_2')
check('identical paired: not called normal', r['normality']['A']['verdict'] == 'no variation', r['normality'])
check('identical paired: differences no variation', r.get('normality_differences', {}).get('verdict') == 'no variation', r)
check('identical paired: no t-test', r.get('branch') == 'nonparametric' and r.get('test') != 'Paired t-test', r.get('test'))
check('identical paired: finite statistic', r.get('statistic') is None or np.isfinite(r['statistic']), r.get('statistic'))
check('identical paired: explained', 'rank-based' in (r.get('note') or ''), r.get('note'))
r = run(same_a, same_b, 'paired_2', 'parametric')
check('identical paired, forced parametric: refused', 'undefined' in (r.get('error') or ''), r)

# Unpaired, each group constant but different.
r = run(same_a[:3], same_b[:3], 'unpaired_2')
check('identical unpaired: no t-test', r.get('branch') == 'nonparametric', r.get('branch'))
check('identical unpaired: finite statistic', r.get('statistic') is None or np.isfinite(r['statistic']), r.get('statistic'))

# Everything identical: nothing to test.
check('all identical unpaired: error', 'nothing to compare' in (run([5.0] * 4, [5.0] * 4, 'unpaired_2').get('error') or ''))
check('zero differences paired: error', 'nothing to test' in (run([5.0, 6, 7, 8], [5.0, 6, 7, 8], 'paired_2').get('error') or ''))

# Normal data still gets the parametric test; paired judged on differences.
rng = np.random.default_rng(1)
a = list(rng.normal(10, 2, 12)); b = list(np.array(a) + rng.normal(1, 0.5, 12))
r = run(a, b, 'paired_2')
check('normal paired: t-test', r.get('test') == 'Paired t-test', r.get('test'))
check('normal paired: differences tested', r.get('normality_differences', {}).get('verdict') == 'normal', r.get('normality_differences'))
# Skewed differences on otherwise normal-looking groups → Wilcoxon.
a = list(rng.normal(50, 5, 20)); d = rng.exponential(1, 20) ** 3
r = run(a, list(np.array(a) + d), 'paired_2')
check('skewed differences: Wilcoxon', r.get('branch') == 'nonparametric', (r.get('normality_differences'), r.get('test')))
r = run(list(rng.normal(10, 2, 10)), list(rng.normal(12, 2, 10)), 'unpaired_2')
check('normal unpaired: t-test', r.get('branch') == 'parametric', r.get('test'))

# Export label: non-normal groups are reported (it used to say "all normal").
import openpyxl, io  # noqa: E402
skew = list(rng.exponential(1, 20) ** 3)
stats = {'m': run(skew, list(rng.normal(5, 1, 20)), 'unpaired_2')}
wb = openpyxl.load_workbook(io.BytesIO(cohort_export.write_excel_summary({'cells': []}, stats, ['m'])))
rows = [r for r in wb['Stats summary'].iter_rows(values_only=True)]
hdr = rows[0]; row = rows[1]
label = row[hdr.index('normality')]
check('export: non-normal reported', isinstance(label, str) and label.startswith('not normal'), label)

if failures:
    print('FAILED'); [print('  -', f) for f in failures]; sys.exit(1)
print('OK')
