"""Cohort reports amplitudes as magnitudes (the convention).

Events (amplitude, charge), Paired (response amplitude) and Bursts (peak
amplitude) come out positive whichever way the trace went; Cursor
measurements stay signed (their direction can be the result).
Run from the repo root:  python tests/cohort_amplitude_check.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from analysis import cohort  # noqa: E402

failures = []


def check(name, ok, detail=''):
    if not ok:
        failures.append(f"{name}{' — ' + str(detail) if detail else ''}")


ev = cohort.extract_events({'totalLengthS': 10.0, 'events': [
    {'peakTimeS': 1.0, 'sweep': 0, 'amplitude': -20.0, 'auc': -150.0},
    {'peakTimeS': 2.0, 'sweep': 0, 'amplitude': -30.0, 'auc': -250.0}]}, {})
check('events amp_mean positive', ev.scalars['amp_mean'] == 25.0, ev.scalars['amp_mean'])
check('events auc positive', ev.scalars['auc_mean'] == 200.0, ev.scalars['auc_mean'])
check('events distribution positive', ev.distributions['amp'] == [20.0, 30.0], ev.distributions['amp'])

pr = cohort.extract_paired({'perTrial': [{'amplitude': -40.0, 'success': True},
                                         {'amplitude': -60.0, 'success': True}]}, {})
amp = pr.scalars.get('mean_amplitude')
check('paired amplitude positive', amp is not None and amp > 0, pr.scalars)

cur = cohort.extract_cursors({'measurements': [{'slot': 0, 'sweep': 0, 'amplitude': -5.0, 'baseline': 0.0}]}, {})
check('cursor amplitude stays signed', cur.scalars.get('slot0__amp_mean') == -5.0, cur.scalars)

if failures:
    print('FAILED'); [print('  -', f) for f in failures]; sys.exit(1)
print('OK')
