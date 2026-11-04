"""Readable metric names: every metric the demo cohorts produce gets a
label without raw key syntax, and known keys get the expected label/unit.
Run: python tests/metric_labels_check.py  → "OK"."""
import sys, warnings
from pathlib import Path
warnings.filterwarnings('ignore')
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from analysis import cohort                       # noqa: E402
from analysis.metric_labels import label_metric, with_unit  # noqa: E402

EXPECT = {
    ('amp_mean', 'pA'): 'Amplitude, mean (pA)',
    ('iei_median_ms', 'pA'): 'Inter-event interval, median (ms)',
    ('amp_cv', 'pA'): 'Amplitude, CV',
    ('auc_mean', 'pA'): 'Charge (area), mean (pA·s)',
    ('slot0__max_rise_slope_mean', 'mV'): 'Slot 1 · Max rise slope, mean (mV/s)',
    ('rs_mohm', ''): 'Rs (MΩ)',
    ('fi_slope_hz_per_pa', 'mV'): 'F-I slope (Hz/pA)',
    ('prop_lag_xcorr_median_ms', 'mV'): 'Propagation lag (cross-correlation), median (ms)',
    ('ppr_mean', 'mV'): 'Paired-pulse ratio, mean',
    ('ibi_mean_s', 'mV'): 'Inter-burst interval, mean (s)',
}
fail = []
for (k, u), want in EXPECT.items():
    got = with_unit(label_metric(k, u))
    if got != want:
        fail.append(f'{k}: {got!r} != {want!r}')

demos = [('cohort_demo/sEPSC', 'events'), ('qc_demo', 'resistance'), ('cohort_demo/LTP', 'fpsp_ltp')]
for folder, at in demos:
    path = ROOT / 'sample_data' / folder
    if not path.exists():
        continue
    r = cohort.aggregate_folder(str(path), at)
    labels = r.get('metric_labels') or {}
    keys = {k for c in r['cells'] for k in list(c['scalars']) + list(c['distributions'])}
    for k in keys:
        lab = labels.get(k, {}).get('label', '')
        if not lab or '_' in lab:
            fail.append(f'{at}: {k} → {lab!r}')
    if r['cells'] and at == 'resistance' and labels.get('baseline', {}).get('label') != 'Holding current':
        fail.append('resistance baseline is not labelled holding current')

print('\n'.join(fail) if fail else 'OK')
sys.exit(1 if fail else 0)
