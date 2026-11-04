"""Cohort ignores dual-site propagation results once dual-site is off.

Turning dual-site off in the Burst window used to leave the old partner
and propagation blocks in place, and Cohort kept reporting them.
Run from the repo root:  python tests/cohort_dual_off_check.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from analysis import cohort  # noqa: E402

failures = []
burst = {'sweepIndex': 0, 'startS': 1.0, 'endS': 1.3, 'peakTimeS': 1.1, 'durationMs': 300,
         'peakAmplitude': -1.0, 'integral': 1.0}
slice_data = {'group': 0, 'series': 2, 'bursts': [burst], 'partner': {'channel': 1, 'bursts': [burst]},
              'propagation': {'result': {'summary': {'nPairs': 7, 'fraction': 0.8,
                                                     'lagMs': {'xcorr': {'median': 4.2}}}}}}
for enabled, expect in ((True, True), (False, False), (None, True)):
    sidecar = {'burst_dual_form': {'0:2': {'enabled': enabled}}} if enabled is not None else {}
    ex = cohort.extract_bursts(slice_data, sidecar)
    has = any(k.startswith('prop_') for k in ex.scalars)
    if has != expect:
        failures.append(f'dual enabled={enabled}: propagation metrics present={has}, expected {expect}')
if failures:
    print('FAILED'); [print('  -', f) for f in failures]; sys.exit(1)
print('OK')
