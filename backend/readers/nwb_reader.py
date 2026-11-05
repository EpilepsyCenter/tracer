"""Neurodata Without Borders (.nwb) reader, using pynwb.

Maps an NWB file onto TRACER's Group > Series > Sweep > Trace model:

Patch clamp (icephys)
  - Group  = the set of electrodes recorded together (one cell, or a
             pair for dual patch).
  - Series = one protocol run: a row of the sequential-recordings
             table when the file has one, otherwise consecutive sweeps
             with the same protocol name.
  - Sweep  = one simultaneous recording (or one sweep number in older
             files that use the sweep table).
  - Traces = one response per electrode, then one stimulus per
             electrode (labelled "Stim ...").

Extracellular (ecephys, e.g. field / LFP recordings)
  - One Group "Extracellular"; each ElectricalSeries is a Series with
    a single continuous sweep and one trace per electrode.

Values are converted from NWB's SI units to TRACER's display units
(V -> mV, A -> pA), with NWB's conversion / offset factors applied.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

import numpy as np

from .base import BaseReader
from .models import Recording, Group, Series, Sweep, Trace, StimulusInfo

# Skip extracellular series larger than this (values). TRACER keeps
# recordings in memory; Neuropixels-sized data is out of scope.
MAX_ECEPHYS_VALUES = 150_000_000


# ---------------------------------------------------------------------------
# Units and data
# ---------------------------------------------------------------------------

_UNIT_SCALE = {
    "volts": ("mV", 1e3), "volt": ("mV", 1e3), "v": ("mV", 1e3),
    "millivolts": ("mV", 1.0), "mv": ("mV", 1.0),
    "microvolts": ("mV", 1e-3), "uv": ("mV", 1e-3), "µv": ("mV", 1e-3),
    "amperes": ("pA", 1e12), "ampere": ("pA", 1e12), "amps": ("pA", 1e12),
    "a": ("pA", 1e12),
    "nanoamperes": ("pA", 1e3), "na": ("pA", 1e3),
    "picoamperes": ("pA", 1.0), "pa": ("pA", 1.0),
}


def _display_unit(unit: str | None) -> tuple[str, float]:
    """NWB unit string -> (TRACER unit, multiplier)."""
    u = (unit or "").strip()
    hit = _UNIT_SCALE.get(u.lower())
    return hit if hit else (u, 1.0)


def _rate(ts) -> float:
    if getattr(ts, "rate", None):
        return float(ts.rate)
    t = getattr(ts, "timestamps", None)
    if t is not None and len(t) > 1:
        dt = float(np.median(np.diff(np.asarray(t[: min(len(t), 10000)]))))
        if dt > 0:
            return 1.0 / dt
    raise ValueError(f"{ts.name}: no sampling rate")


def _start_time(ts) -> float:
    if getattr(ts, "starting_time", None) is not None:
        return float(ts.starting_time)
    t = getattr(ts, "timestamps", None)
    return float(t[0]) if t is not None and len(t) else 0.0


def _values(ts, start: int = 0, count: Optional[int] = None,
            column: Optional[int] = None) -> np.ndarray:
    """Samples of a TimeSeries in SI units (conversion + offset applied)."""
    stop = None if count is None or count < 0 else start + count
    if column is None:
        raw = ts.data[start:stop]
    else:
        raw = ts.data[start:stop, column]
    arr = np.asarray(raw, dtype=np.float64)
    conv = float(getattr(ts, "conversion", 1.0) or 1.0)
    off = float(getattr(ts, "offset", 0.0) or 0.0)
    if conv != 1.0:
        arr = arr * conv
    if off != 0.0:
        arr = arr + off
    return arr


def _trace(ts, label: str, start: int = 0, count: Optional[int] = None,
           column: Optional[int] = None, extra_scale: float = 1.0) -> Trace:
    unit, mult = _display_unit(getattr(ts, "unit", ""))
    data = _values(ts, start, count, column)
    if mult * extra_scale != 1.0:
        data = data * (mult * extra_scale)
    return Trace(data=data, sampling_rate=_rate(ts), units=unit, label=label)


# ---------------------------------------------------------------------------
# Patch clamp
# ---------------------------------------------------------------------------

@dataclass
class _Rec:
    """One electrode's response (and stimulus, if any) in one sweep."""
    electrode: str
    response: Any
    r_start: int = 0
    r_count: Optional[int] = None
    stimulus: Any = None
    s_start: int = 0
    s_count: Optional[int] = None


@dataclass
class _SweepSpec:
    recs: list[_Rec]
    protocol: str = ""


@dataclass
class _SeriesSpec:
    label: str
    sweeps: list[_SweepSpec] = field(default_factory=list)


def _ragged(column) -> list[list[int]]:
    """Rows of a ragged DynamicTableRegion column (VectorIndex) as lists
    of target row indices."""
    ends = np.asarray(column.data[:], dtype=np.int64)
    target = np.asarray(column.target.data[:], dtype=np.int64)
    out, start = [], 0
    for e in ends:
        out.append([int(x) for x in target[start:e]])
        start = int(e)
    return out


def _ref(ref) -> tuple[Any, int, Optional[int]]:
    """TimeSeriesReference -> (timeseries, start, count), or (None, 0, None)."""
    if ref is None:
        return None, 0, None
    try:
        if hasattr(ref, "isvalid") and not ref.isvalid():
            return None, 0, None
    except Exception:
        return None, 0, None
    ts = getattr(ref, "timeseries", None)
    if ts is None:
        return None, 0, None
    start = int(getattr(ref, "idx_start", 0) or 0)
    count = getattr(ref, "count", None)
    count = int(count) if count is not None and count >= 0 else None
    return ts, max(0, start), count


def _protocol_name(ts) -> str:
    d = (getattr(ts, "stimulus_description", "") or "").strip()
    return "" if d.upper() in ("N/A", "NA", "NONE") else d


def _sweeps_from_tables(nwb) -> list[_SeriesSpec]:
    """Use the icephys metadata tables (NWB >= 2.4)."""
    ir = nwb.intracellular_recordings
    n = len(ir)
    recs: list[_Rec] = []
    for i in range(n):
        elec = ir["electrodes"]["electrode"][i]
        r_ts, r0, rn = _ref(ir["responses"]["response"][i])
        s_ts, s0, sn = _ref(ir["stimuli"]["stimulus"][i])
        recs.append(_Rec(electrode=getattr(elec, "name", "Electrode"),
                         response=r_ts, r_start=r0, r_count=rn,
                         stimulus=s_ts, s_start=s0, s_count=sn))

    sim = nwb.icephys_simultaneous_recordings
    seq = nwb.icephys_sequential_recordings
    sim_rows = _ragged(sim["recordings"]) if sim is not None and len(sim) else [[i] for i in range(n)]

    def sweep(rows: list[int]) -> Optional[_SweepSpec]:
        rr = [recs[i] for i in rows if 0 <= i < n and recs[i].response is not None]
        if not rr:
            return None
        return _SweepSpec(recs=rr, protocol=_protocol_name(rr[0].response))

    out: list[_SeriesSpec] = []
    used: set[int] = set()
    if seq is not None and len(seq):
        types = list(seq["stimulus_type"][:]) if "stimulus_type" in seq.colnames else [""] * len(seq)
        for j, sim_ids in enumerate(_ragged(seq["simultaneous_recordings"])):
            spec = _SeriesSpec(label=str(types[j] or ""))
            for k in sim_ids:
                used.add(k)
                sw = sweep(sim_rows[k]) if 0 <= k < len(sim_rows) else None
                if sw:
                    spec.sweeps.append(sw)
            if spec.sweeps:
                out.append(spec)
    leftovers = [sweep(rows) for k, rows in enumerate(sim_rows) if k not in used]
    out.extend(_group_consecutive([s for s in leftovers if s]))
    return out


def _sweeps_from_acquisition(nwb) -> list[_SeriesSpec]:
    """Older files (sweep table) or files with no icephys tables: pair
    each PatchClampSeries response with its stimulus by sweep number."""
    from pynwb.icephys import PatchClampSeries

    def patch(container) -> list:
        return [o for o in container.values() if isinstance(o, PatchClampSeries)]

    responses = patch(nwb.acquisition)
    stimuli = patch(nwb.stimulus)
    if not responses:
        return []

    def key(ts, i):
        sn = getattr(ts, "sweep_number", None)
        return int(sn) if sn is not None else -(i + 1)

    stim_by = {}
    for i, s in enumerate(stimuli):
        stim_by[(key(s, i), getattr(s.electrode, "name", ""))] = s

    by_sweep: dict[int, list] = {}
    order: dict[int, float] = {}
    for i, r in enumerate(responses):
        k = key(r, i)
        by_sweep.setdefault(k, []).append(r)
        order[k] = min(order.get(k, float("inf")), _start_time(r))
    sweeps: list[_SweepSpec] = []
    for k in sorted(by_sweep, key=lambda k: (order[k], k)):
        rr = []
        for r in sorted(by_sweep[k], key=lambda r: getattr(r.electrode, "name", "")):
            ename = getattr(r.electrode, "name", "Electrode")
            rr.append(_Rec(electrode=ename, response=r,
                           stimulus=stim_by.get((k, ename))))
        sweeps.append(_SweepSpec(recs=rr, protocol=_protocol_name(rr[0].response)))
    return _group_consecutive(sweeps)


def _signature(sw: _SweepSpec) -> tuple:
    return tuple((r.electrode, type(r.response).__name__, r.stimulus is not None,
                  round(_rate(r.response))) for r in sw.recs)


def _group_consecutive(sweeps: list[_SweepSpec]) -> list[_SeriesSpec]:
    """Consecutive sweeps with the same protocol and channels -> one series."""
    out: list[_SeriesSpec] = []
    last = None
    for sw in sweeps:
        k = (sw.protocol, _signature(sw))
        if out and k == last:
            out[-1].sweeps.append(sw)
        else:
            out.append(_SeriesSpec(label=sw.protocol, sweeps=[sw]))
            last = k
    return out


def _stim_label(rec: _Rec, multi: bool) -> str:
    return f"Stim {rec.electrode}" if multi else "Stimulus"


def _resp_label(rec: _Rec, multi: bool) -> str:
    kind = type(rec.response).__name__
    base = "Im" if kind.startswith("VoltageClamp") else "Vm" if kind.startswith("CurrentClamp") else "Response"
    return f"{base} {rec.electrode}" if multi else base


def _stimulus_info(data: np.ndarray, unit: str, dt: float) -> Optional[StimulusInfo]:
    """Holding level and first pulse of a stimulus waveform (first sweep),
    for the cursor defaults TRACER derives from a protocol."""
    from .heka_reader import _make_stimulus_info

    if data.size < 3:
        return None
    rounded = np.round(data, 3)
    if float(rounded.max() - rounded.min()) < 1e-6:
        return None
    change = np.flatnonzero(np.diff(rounded)) + 1
    bounds = np.concatenate(([0], change, [rounded.size]))
    segs = [(int(a), int(b), float(rounded[a])) for a, b in zip(bounds[:-1], bounds[1:])]
    if len(segs) > 200:          # ramps, noise, sines: not a step protocol
        return None
    # NWB stimuli are sampled waveforms that start at the holding level;
    # the longest level can be the step itself (long current steps).
    hold = segs[0][2]
    tol = max(0.5, 0.01 * abs(hold))
    pulse = next(((a, b, lvl) for a, b, lvl in segs if abs(lvl - hold) >= tol), None)
    if pulse is None:
        return None
    a, b, lvl = pulse
    return _make_stimulus_info(unit_label=unit, v_hold=hold, pulse_start_s=a * dt,
                               pulse_end_s=b * dt, pulse_level=lvl, dt_s=dt)


def _amp_settings(ts) -> tuple[Optional[float], Optional[float]]:
    """Rs (MOhm) and Cm (pF) from voltage-clamp compensation fields."""
    def ok(v):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return None
        return v if np.isfinite(v) and v > 0 else None
    rs = ok(getattr(ts, "whole_cell_series_resistance_comp", None))
    cm = ok(getattr(ts, "whole_cell_capacitance_comp", None))
    return (rs / 1e6 if rs else None), (cm * 1e12 if cm else None)


def _build_icephys(nwb, recording: Recording, t0: Optional[float]) -> None:
    has_tables = nwb.intracellular_recordings is not None and len(nwb.intracellular_recordings) > 0
    specs = _sweeps_from_tables(nwb) if has_tables else _sweeps_from_acquisition(nwb)
    groups: dict[tuple, Group] = {}
    for spec in specs:
        electrodes = tuple(r.electrode for r in spec.sweeps[0].recs)
        grp = groups.get(electrodes)
        if grp is None:
            grp = Group(index=len(recording.groups), label=" + ".join(electrodes))
            groups[electrodes] = grp
            recording.groups.append(grp)
        multi = len(electrodes) > 1
        first = spec.sweeps[0].recs[0]
        label = spec.label or f"Series {len(grp.series_list) + 1}"
        ser = Series(index=len(grp.series_list), label=label, protocol=spec.label)
        if t0 is not None:
            ser.timestamp = t0 + _start_time(first.response)
        ser.rs, ser.cm = _amp_settings(first.response)
        rtype = type(first.response).__name__
        ser.kind = 'vc' if rtype.startswith('VoltageClamp') else 'cc' if rtype.startswith('CurrentClamp') else None
        for si, sw in enumerate(spec.sweeps):
            sweep = Sweep(index=si, label=f"Sweep {si + 1}")
            if t0 is not None:
                sweep.time = t0 + _start_time(sw.recs[0].response)
            for r in sw.recs:
                sweep.traces.append(_trace(r.response, _resp_label(r, multi), r.r_start, r.r_count))
            for r in sw.recs:
                if r.stimulus is not None:
                    sweep.traces.append(_trace(r.stimulus, _stim_label(r, multi), r.s_start, r.s_count))
            ser.sweeps.append(sweep)
        if first.stimulus is not None:
            st = next((t for t in ser.sweeps[0].traces if t.label.startswith("Stim")), None)
            if st is not None:
                ser.stimulus = _stimulus_info(st.data, st.units, 1.0 / st.sampling_rate)
        grp.series_list.append(ser)


# ---------------------------------------------------------------------------
# Extracellular
# ---------------------------------------------------------------------------

def _electrical_series(nwb) -> list:
    from pynwb.ecephys import ElectricalSeries

    found, seen = [], set()

    def add(o):
        if isinstance(o, ElectricalSeries) and id(o) not in seen:
            seen.add(id(o))
            found.append(o)
        elif hasattr(o, "electrical_series"):        # LFP, FilteredEphys
            for es in o.electrical_series.values():
                add(es)

    for o in nwb.acquisition.values():
        add(o)
    for pm in nwb.processing.values():
        for o in pm.data_interfaces.values():
            add(o)
    return found


def _electrode_labels(es, n: int) -> list[str]:
    try:
        table = es.electrodes.table
        rows = list(es.electrodes.data[:])
        cols = table.colnames
        for col in ("label", "channel_name", "name"):
            if col in cols:
                vals = [str(table[col][i]) for i in rows]
                if all(vals):
                    return vals
        ids = [int(table.id[i]) for i in rows]
        loc = [str(table["location"][i]) for i in rows] if "location" in cols else [""] * len(rows)
        return [f"Ch {i}" + (f" ({l})" if l and l.lower() not in ("unknown", "none", "n/a") else "")
                for i, l in zip(ids, loc)]
    except Exception:
        return [f"Ch {i + 1}" for i in range(n)]


def _tracer_tag(es) -> Optional[dict]:
    """Sweeps of one series written by TRACER's NWB export share a JSON tag
    in ``comments``; files from elsewhere have none."""
    try:
        tag = json.loads(getattr(es, "comments", "") or "")
    except (ValueError, TypeError):
        return None
    return tag if isinstance(tag, dict) and "tracer_series" in tag else None


def _build_ecephys(nwb, recording: Recording, t0: Optional[float]) -> list[str]:
    """Each ElectricalSeries is a continuous series in "Extracellular" —
    except series exported by TRACER, whose sweeps are regrouped into one
    series in a group named as in the original recording."""
    skipped: list[str] = []
    groups: dict[str, Group] = {}
    tagged: dict[str, Series] = {}

    def group(label: str) -> Group:
        if label not in groups:
            groups[label] = Group(index=len(recording.groups), label=label)
            recording.groups.append(groups[label])
        return groups[label]

    for es in _electrical_series(nwb):
        shape = es.data.shape
        n_ch = shape[1] if len(shape) > 1 else 1
        if shape[0] * n_ch > MAX_ECEPHYS_VALUES:
            skipped.append(f"{es.name} ({n_ch} channels × {shape[0]} samples)")
            continue
        labels = _electrode_labels(es, n_ch)
        conv = getattr(es, "channel_conversion", None)
        conv = np.asarray(conv[:], dtype=np.float64) if conv is not None else None
        tag = _tracer_tag(es)
        if tag is not None and tag["tracer_series"] in tagged:
            ser = tagged[tag["tracer_series"]]
        else:
            grp = group(str(tag.get("group") or "Extracellular") if tag else "Extracellular")
            ser = Series(index=len(grp.series_list),
                         label=str(tag.get("label") or es.name) if tag else es.name,
                         protocol="", kind="field")
            if t0 is not None:
                ser.timestamp = t0 + _start_time(es)
            grp.series_list.append(ser)
            if tag is not None:
                tagged[tag["tracer_series"]] = ser
        sweep = Sweep(index=len(ser.sweeps), label=f"Sweep {len(ser.sweeps) + 1}")
        if t0 is not None:
            sweep.time = t0 + _start_time(es)
        for c in range(n_ch):
            extra = float(conv[c]) if conv is not None and c < len(conv) else 1.0
            sweep.traces.append(_trace(es, labels[c] if c < len(labels) else f"Ch {c + 1}",
                                       column=c if len(shape) > 1 else None, extra_scale=extra))
        ser.sweeps.append(sweep)
    return skipped


# ---------------------------------------------------------------------------
# Reader
# ---------------------------------------------------------------------------

class NwbReader(BaseReader):
    """Reader for Neurodata Without Borders 2.x files."""

    @staticmethod
    def can_read(file_path: str) -> bool:
        return file_path.lower().endswith(".nwb")

    def read(self, file_path: str, **_options) -> Recording:
        from pynwb import NWBHDF5IO

        recording = Recording(file_path=file_path, file_name=os.path.basename(file_path),
                              format="NWB")
        with NWBHDF5IO(file_path, "r", load_namespaces=True) as io:
            nwb = io.read()
            start: Optional[datetime] = getattr(nwb, "session_start_time", None)
            t0 = start.timestamp() if start is not None else None
            _build_icephys(nwb, recording, t0)
            skipped = _build_ecephys(nwb, recording, t0)

        if not recording.groups:
            if skipped:
                raise ValueError(
                    "This NWB file's extracellular recordings are too large for TRACER: "
                    + "; ".join(skipped))
            raise ValueError(
                "No patch-clamp or extracellular voltage recordings found in this NWB file")
        return recording
