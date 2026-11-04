"""Readable names for Cohort metrics: ``amp_mean`` → "Amplitude, mean"
with unit "pA"; ``slot0__rise_time_10_90_mean`` → "Slot 1 · Rise time
10–90 %, mean" (ms).

The metric keys stay what they are (sidecars, sessions, scripts and the
statistics use them); labels are for people: the Cohort window, its
graphs and every export. Most keys follow ``<quantity>[_<stat>][_<unit>]``
and are labelled by rule; the rest are listed explicitly. Extractors can
also name their own metrics (``meta['metric_labels']``), as Spectral does
for its region × band names.
"""

from __future__ import annotations

import re
from typing import Optional

# Units at the end of a key → display unit. Longest first.
_UNITS = [
    ('mv_per_ms', 'mV/ms'), ('hz_per_pa', 'Hz/pA'), ('per_min', '/min'),
    ('mohm', 'MΩ'), ('ms', 'ms'), ('hz', 'Hz'), ('pa', 'pA'), ('mv', 'mV'),
    ('pf', 'pF'), ('pct', '%'), ('db', 'dB'), ('s', 's'),
]
_STATS = {'mean': 'mean', 'median': 'median', 'sd': 'SD', 'cv': 'CV', 'iqr': 'IQR'}

# What a key's quantity means. ``None`` unit = the recording's own unit
# (pA in voltage clamp, mV in current clamp / fields); ``'{v}·s'`` /
# ``'{v}/s'`` are built from it; ``''`` = no unit (ratios, counts).
_QUANTITY: dict[str, tuple[str, Optional[str]]] = {
    'amp': ('Amplitude', None), 'amplitude': ('Amplitude', None),
    'auc': ('Charge (area)', '{v}·s'), 'area': ('Area', '{v}·s'),
    'peak': ('Peak', None), 'baseline': ('Baseline', None),
    'iei': ('Inter-event interval', 'ms'), 'isi': ('Inter-spike interval', 'ms'),
    'ibi': ('Inter-burst interval', 's'), 'freq': ('Frequency', 'Hz'),
    'rise': ('Rise time', 'ms'), 'decay': ('Decay time', 'ms'),
    'tau_decay': ('Decay τ', 'ms'), 'tau': ('τ', 'ms'),
    'half_width': ('Half-width', 'ms'), 'fwhm': ('Half-width', 'ms'),
    'rise_time_10_90': ('Rise time 10–90 %', 'ms'), 'rise_time_20_80': ('Rise time 20–80 %', 'ms'),
    'time_to_peak': ('Time to peak', 'ms'),
    'max_rise_slope': ('Max rise slope', '{v}/s'), 'max_decay_slope': ('Max decay slope', '{v}/s'),
    'rise_slope': ('Rise slope', '{v}/s'), 'decay_slope': ('Decay slope', '{v}/s'),
    'duration': ('Duration', 'ms'), 'integral': ('Integral', None),
    'latency': ('Latency', 'ms'), 'threshold': ('Threshold', None),
    'ap_amp': ('AP amplitude', 'mV'), 'ap_peak': ('AP peak', 'mV'),
    'fahp': ('Fast AHP', 'mV'), 'mahp': ('Medium AHP', 'mV'),
    'rs': ('Rs', 'MΩ'), 'rin': ('Rin', 'MΩ'), 'cm': ('Cm', 'pF'),
    'rs_drift': ('Rs drift', '%'), 'local_variance': ('Local variance', ''),
    'ppr': ('Paired-pulse ratio', ''), 'spikes_per_burst': ('Spikes per burst', ''),
    'intra_burst_freq': ('Intra-burst frequency', 'Hz'),
    'first_spike_latency': ('First-spike latency', 's'),
    'sag_amp': ('Sag amplitude', 'mV'), 'sag_ratio': ('Sag ratio', ''),
    'sfa_divisor': ('Spike-frequency adaptation', ''),
    'peak_current': ('Peak current', 'pA'), 'steady_state_current': ('Steady-state current', 'pA'),
    'firing_rate': ('Firing rate', 'Hz'), 'max_rate': ('Max firing rate', 'Hz'),
}

# Keys that don't follow the pattern.
_FULL: dict[str, tuple[str, Optional[str]]] = {
    'n_events': ('Events (n)', None), 'n_bursts': ('Bursts (n)', None),
    'n_spikes_total': ('Spikes (n)', None), 'n_trains': ('Trains (n)', None),
    'n_events_in_trains': ('Events in trains (n)', None), 'n_pairs': ('Paired discharges (n)', None),
    'n_partner_bursts': ('Second-channel bursts (n)', None), 'n_measurements': ('Measurements (n)', None),
    'n_trials': ('Trials (n)', None), 'n_successes': ('Successes (n)', None), 'n_failures': ('Failures (n)', None),
    'n_points': ('Points (n)', None), 'n_intensities': ('Intensities (n)', None),
    'n_baseline_bins': ('Baseline bins (n)', None), 'n_late_bins': ('Late bins (n)', None),
    'n_total_bins': ('Bins (n)', None),
    'freq_hz': ('Frequency', 'Hz'), 'inv_cv2': ('1/CV²', None),
    'failure_rate': ('Failure rate', None), 'potency': ('Potency', None),
    'cv_success': ('CV of successes', None),
    'mean_amplitude': ('Amplitude, mean', None),
    'mean_amplitude_zeroed': ('Amplitude, mean (failures as 0)', None),
    'amplitude_success': ('Amplitude (successes)', None),
    'rheobase_pa': ('Rheobase', 'pA'), 'fi_slope_hz_per_pa': ('F-I slope', 'Hz/pA'),
    'fi_intercept_hz': ('F-I intercept', 'Hz'),
    'iv_slope': ('I-V slope', None), 'iv_intercept': ('I-V intercept', None),
    'reversal_potential': ('Reversal potential', None),
    'io_slope': ('I-O slope', None), 'io_intercept': ('I-O intercept', None),
    'io_max_response': ('I-O max response', None), 'io_at_threshold_response': ('I-O threshold response', None),
    'late_normalized_mean': ('Late response (normalised)', None),
    'pct_change_from_baseline': ('Change from baseline', '%'),
    'baseline_response_mean': ('Baseline response', None), 'late_response_mean': ('Late response', None),
    'response_normalized_timeseries': ('Response (normalised), per bin', None),
    'response_raw_timeseries': ('Response, per bin', None),
    'ppr_2_1': ('Paired-pulse ratio 2/1', None), 'ppr_2_1_n_sweeps': ('PPR sweeps (n)', None),
    'fraction_events_in_trains': ('Events in trains (fraction)', None),
    'train_rate_per_min': ('Train rate', '/min'), 'mean_events_per_train': ('Events per train, mean', None),
    'mean_train_duration_ms': ('Train duration, mean', 'ms'),
    'mean_intra_train_iei_ms': ('Intra-train interval, mean', 'ms'),
    'mean_intra_train_freq_hz': ('Intra-train frequency, mean', 'Hz'),
    'events_per_train': ('Events per train', None), 'train_durations_ms': ('Train duration', 'ms'),
    'intra_train_iei_ms': ('Intra-train interval', 'ms'), 'inter_train_iei_ms': ('Inter-train interval', 'ms'),
    'prop_fraction': ('Propagated discharges (fraction)', None),
    'prop_ref_leads_fraction': ('Reference leads (fraction)', None),
    'prop_partner_only_per_min': ('Second-channel-only discharges', '/min'),
    'prop_partner_only_fraction': ('Second-channel-only discharges (fraction)', None),
    'prop_amp_ratio_median': ('Amplitude ratio (2nd / reference), median', None),
    'prop_xcorr_r_median': ('Waveform correlation r, median', None),
    'rs_mohm_trace': ('Rs, per measurement', 'MΩ'), 'rin_mohm_trace': ('Rin, per measurement', 'MΩ'),
    'cm_pf_trace': ('Cm, per measurement', 'pF'),
    'baseline': ('Baseline', None),
}

_PROP_LAG = re.compile(r'^prop_lag_(xcorr|onset|peak)_(median|iqr)_ms$')
_SLOT = re.compile(r'^slot(\d+)__(.+)$')


def _humanise(token: str) -> str:
    t = token.replace('_', ' ').strip()
    return t[:1].upper() + t[1:] if t else token


def label_metric(key: str, value_unit: str = '') -> dict:
    """``{'label': …, 'unit': …}`` for one metric key. ``value_unit`` is the
    recording's unit (pA / mV …) for quantities measured in it."""
    m = _SLOT.match(key)
    if m:
        inner = label_metric(m.group(2), value_unit)
        return {'label': f"Slot {int(m.group(1)) + 1} · {inner['label']}", 'unit': inner['unit']}
    m = _PROP_LAG.match(key)
    if m:
        what = {'xcorr': 'cross-correlation', 'onset': 'onset', 'peak': 'peak'}[m.group(1)]
        stat = 'median' if m.group(2) == 'median' else 'IQR'
        return {'label': f'Propagation lag ({what}), {stat}', 'unit': 'ms'}
    if key in _FULL:
        lab, unit = _FULL[key]
        return {'label': lab, 'unit': unit if unit is not None else (value_unit if _uses_value_unit(key) else '')}

    toks = key.split('_')
    unit = ''
    for u, disp in _UNITS:
        ut = u.split('_')
        if len(toks) > len(ut) and toks[-len(ut):] == ut:
            unit, toks = disp, toks[:-len(ut)]
            break
    stat = ''
    if len(toks) > 1 and toks[-1] in _STATS:
        stat, toks = _STATS[toks[-1]], toks[:-1]
    qty = '_'.join(toks)
    if qty in _QUANTITY:
        name, q_unit = _QUANTITY[qty]
    else:
        name, q_unit = _humanise(qty), ''
    if not unit:
        if q_unit is None:
            unit = value_unit
        elif '{v}' in q_unit:
            unit = q_unit.replace('{v}', value_unit) if value_unit else ''
        else:
            unit = q_unit
    if stat == 'CV':
        unit = ''                       # dimensionless
    label = f'{name}, {stat}' if stat else name
    return {'label': label, 'unit': unit or ''}


def _uses_value_unit(key: str) -> bool:
    return key in ('mean_amplitude', 'mean_amplitude_zeroed', 'amplitude_success', 'baseline',
                   'baseline_response_mean', 'late_response_mean', 'io_max_response',
                   'io_at_threshold_response', 'response_raw_timeseries')


def with_unit(entry: dict) -> str:
    """"Amplitude, mean (pA)" — for headers, axes and table names."""
    return f"{entry['label']} ({entry['unit']})" if entry.get('unit') else entry['label']


def labels_for_cells(cells: list[dict]) -> dict[str, dict]:
    """Label every scalar and distribution key in an aggregate's cells,
    using each cell's recording unit and any labels its extractor gave."""
    out: dict[str, dict] = {}
    for c in cells:
        meta = c.get('meta') or {}
        vu = str(meta.get('units') or meta.get('trace_unit') or meta.get('traceUnit')
                 or meta.get('response_unit') or '')
        given = meta.get('metric_labels') or {}
        for k in list((c.get('scalars') or {}).keys()) + list((c.get('distributions') or {}).keys()):
            if k in out:
                continue
            out[k] = dict(given[k]) if k in given else label_metric(k, vu)
    return out
