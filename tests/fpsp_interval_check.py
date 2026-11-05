"""LTP time axis without a PatchMaster protocol: the sweep interval comes
from the sweeps' recorded start times (ABF, NWB), robust to a pause or a
missing sweep. Run: python tests/fpsp_interval_check.py → "OK"."""
import sys
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from readers.models import Series, Sweep, Trace   # noqa: E402
from api.fpsp import _interval_from_sweep_times    # noqa: E402

fail = []


def series(times):
    s = Series(index=0)
    for k, t in enumerate(times):
        s.sweeps.append(Sweep(index=k, time=t, traces=[Trace(np.zeros(10), 1000.0, 'mV')]))
    return s


t0 = 1_700_000_000.0
regular = [t0 + 15 * k for k in range(40)]
gapped = regular[:10] + regular[11:] + [regular[-1] + 300]   # one missing, one pause
cases = [(regular, 15.0), (gapped, 15.0), ([t0], 0.0), ([None, None], 0.0), ([], 0.0)]
for times, want in cases:
    got = _interval_from_sweep_times(series(times))
    if abs(got - want) > 1e-9:
        fail.append(f'{len(times)} sweeps: {got} != {want}')

print('\n'.join(fail) if fail else 'OK')
sys.exit(1 if fail else 0)
