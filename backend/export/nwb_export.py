"""Write the open recording as an NWB 2.x file.

Each series is written as the type the user confirms:

- ``vc`` / ``cc`` (patch clamp): one IntracellularElectrode per
  response channel of the group (the cell; two for a paired
  recording). Every sweep becomes a Voltage/CurrentClampSeries
  response plus, when known, its stimulus: the recorded command
  read-back channel, otherwise the waveform rebuilt from the
  PatchMaster protocol. Sweeps recorded together form a simultaneous
  recording; each series is a sequential recording named after its
  protocol (the NWB icephys tables).
- ``field``: an ElectricalSeries per sweep with one column per
  voltage channel, electrodes in the electrodes table. Sweeps of one
  series share a ``comments`` tag so TRACER reads them back as one
  series.
- ``skip``: not written.

Values are written as float32 in the display unit (pA / mV) with the
NWB ``conversion`` factor to SI, after any Channel Scaling the user
applied. The file can then be checked with the NWB Inspector
(``inspect``).
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np

from readers.models import Recording, Series, Trace
from utils.scaling import scaled

KINDS = ("vc", "cc", "field", "skip")

# Display unit → (family, factor to SI)
_UNITS = {
    "pa": ("current", 1e-12), "na": ("current", 1e-9), "a": ("current", 1.0),
    "µa": ("current", 1e-6), "ua": ("current", 1e-6),
    "mv": ("voltage", 1e-3), "v": ("voltage", 1.0),
    "µv": ("voltage", 1e-6), "uv": ("voltage", 1e-6),
}


def unit_info(units: str) -> tuple[Optional[str], float]:
    return _UNITS.get((units or "").strip().lower(), (None, 1.0))


# ---------------------------------------------------------------------------
# What to write: the per-series plan the dialog shows
# ---------------------------------------------------------------------------

_CC_RE = re.compile(r"\bcc\b|current.?clamp|i.?clamp|c-clamp")
_VC_RE = re.compile(r"\bvc\b|voltage.?clamp|v.?clamp|test.?pulse|i-v|ramp|seal")
_FIELD_RE = re.compile(r"field|fepsp|epsp|pop.?spike|lfp|extracell")


def guess_kind(ser: Series) -> str:
    """Same order as the tree badge: the file's own type, the series name,
    the stimulus / holding, then the channel units."""
    if ser.kind in KINDS:
        return ser.kind
    # The command unit is the clearest sign: mV commands = voltage clamp,
    # pA commands = current clamp ("I-V" step protocols are often CC).
    if ser.stimulus is not None:
        if ser.stimulus.unit == "mV":
            return "vc"
        if ser.stimulus.unit == "pA":
            return "cc"
    text = f"{ser.label} {ser.protocol}".lower()
    if _CC_RE.search(text):
        return "cc"
    if _VC_RE.search(text):
        return "vc"
    if _FIELD_RE.search(text):
        return "field"
    first = ser.sweeps[0].traces[0] if ser.sweeps and ser.sweeps[0].traces else None
    fam = unit_info(first.units)[0] if first else None
    if fam == "current":
        return "vc"
    if fam == "voltage":
        return "cc"
    return "skip"


def plan(rec: Recording) -> dict:
    series = []
    times = []
    for g in rec.groups:
        for s in g.series_list:
            chans = [{"label": t.label, "units": t.units}
                     for t in (s.sweeps[0].traces if s.sweeps else [])]
            series.append({
                "group": g.index, "series": s.index,
                "groupLabel": g.label, "label": s.label,
                "sweeps": s.sweep_count, "channels": chans,
                "kind": guess_kind(s),
            })
            t = _series_start(s)
            if t is not None:
                times.append(t)
    start = min(times) if times else None
    return {
        "fileName": rec.file_name,
        "format": rec.format,
        "series": series,
        # Unix seconds; None = the file doesn't record when it was made
        "recordingStart": start,
    }


def _series_start(s: Series) -> Optional[float]:
    if s.sweeps and s.sweeps[0].time is not None:
        return s.sweeps[0].time
    return s.timestamp


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

@dataclass
class ExportResult:
    path: str
    series_written: int = 0
    sweeps_written: int = 0
    notes: list[str] = field(default_factory=list)


def _safe(name: str) -> str:
    name = re.sub(r"[/\\:]", "_", (name or "").strip())
    return name or "unnamed"


class _Names:
    """Unique object names within the file."""

    def __init__(self) -> None:
        self.used: set[str] = set()

    def __call__(self, base: str) -> str:
        base = _safe(base)
        name, k = base, 2
        while name in self.used:
            name = f"{base} ({k})"
            k += 1
        self.used.add(name)
        return name


def _compressed(arr: np.ndarray):
    from hdmf.backends.hdf5.h5_utils import H5DataIO
    return H5DataIO(np.ascontiguousarray(arr, dtype=np.float32), compression="gzip",
                    compression_opts=4)


def _iso_age(meta: dict) -> Optional[str]:
    """``{"age": 30, "ageUnit": "days"}`` → ``P30D``; a ready ISO string
    passes through."""
    a = meta.get("age")
    if a in (None, ""):
        return None
    if isinstance(a, str) and a.strip().upper().startswith("P"):
        return a.strip().upper()
    try:
        v = float(a)
    except (TypeError, ValueError):
        return None
    unit = {"days": "D", "weeks": "W", "months": "M", "years": "Y"}.get(meta.get("ageUnit", "days"), "D")
    num = int(v) if v == int(v) else v
    return f"P{num}{unit}"


def _pgf_stimulus(pgf, rec: Recording, group: int, series: int, sweep: int,
                  n: int, dt: float) -> Optional[tuple[np.ndarray, str]]:
    """Command waveform of one HEKA sweep from the .pgf protocol, in mV / pA."""
    if pgf is None:
        return None
    idx = 0
    target = None
    for g in rec.groups:
        for s in g.series_list:
            if g.index == group and s.index == series:
                target = idx
            idx += 1
    if target is None or target >= len(pgf.stimulations):
        return None
    stim = pgf.stimulations[target]
    best, best_score = None, -1.0
    for ch in stim.channels:
        if not ch.segments:
            continue
        levels = [abs(seg.voltage_at_sweep(0)) for seg in ch.segments]
        score = (max(levels) if levels else 0.0) * (2.0 if ch.do_write else 1.0)
        if score > best_score:
            best, best_score = ch, score
    if best is None:
        return None
    unit = best.dac_unit.strip()
    if unit in ("V", "Volt"):
        label, scale = "mV", 1000.0
    elif unit in ("A", "Amp", "Ampere"):
        label, scale = "pA", 1000.0       # PatchMaster stores current commands in nA
    else:
        return None
    try:
        wave = best.reconstruct_sweep(sweep, dt) * scale
    except Exception:
        return None
    if wave.size >= n:
        wave = wave[:n]
    else:
        wave = np.concatenate([wave, np.full(n - wave.size, wave[-1] if wave.size else 0.0)])
    return wave, label


def write_nwb(rec: Recording, path: str, meta: dict, kinds: dict[str, str],
              excluded: Optional[dict[str, list[int]]] = None, pgf: Any = None) -> ExportResult:
    from pynwb import NWBFile, NWBHDF5IO
    from pynwb.file import Subject
    from pynwb.icephys import (CurrentClampSeries, CurrentClampStimulusSeries,
                               VoltageClampSeries, VoltageClampStimulusSeries)
    from pynwb.ecephys import ElectricalSeries

    excluded = excluded or {}
    result = ExportResult(path=path)
    pl = plan(rec)

    # Session start: the form's value, else the recording's, else the file date.
    start_ts: Optional[float] = None
    if meta.get("sessionStart"):
        try:
            start_ts = datetime.fromisoformat(str(meta["sessionStart"]).replace("Z", "+00:00")).timestamp()
        except ValueError:
            start_ts = None
    if start_ts is None:
        start_ts = pl["recordingStart"]
    if start_ts is None:
        start_ts = os.path.getmtime(rec.file_path) if os.path.exists(rec.file_path) else 0.0
        result.notes.append("The recording doesn't store when it was made; "
                            "the file's modification date was used as the session start.")
    session_start = datetime.fromtimestamp(start_ts, tz=timezone.utc).astimezone()

    def listify(v):
        if not v:
            return None
        items = [x.strip() for x in (v if isinstance(v, list) else str(v).split(";"))]
        return [x for x in items if x] or None

    version = meta.get("tracerVersion") or ""
    nwb = NWBFile(
        session_description=meta.get("sessionDescription") or f"{rec.file_name}, exported by TRACER",
        identifier=str(uuid.uuid4()),
        session_start_time=session_start,
        experimenter=listify(meta.get("experimenter")),
        lab=meta.get("lab") or None,
        institution=meta.get("institution") or None,
        experiment_description=meta.get("experimentDescription") or None,
        keywords=listify(meta.get("keywords")),
        session_id=meta.get("sessionId") or None,
        source_script=f"TRACER {version}".strip(),
        source_script_file_name=rec.file_name,
    )
    if meta.get("subjectId") or meta.get("species"):
        nwb.subject = Subject(
            subject_id=meta.get("subjectId") or None,
            species=meta.get("species") or None,
            sex=meta.get("sex") or "U",
            age=_iso_age(meta),
            genotype=meta.get("genotype") or None,
            strain=meta.get("strain") or None,
            description=meta.get("subjectDescription") or None,
        )

    device_desc = {"HEKA": "HEKA amplifier, recorded with PatchMaster",
                   "ABF": "Axon amplifier, recorded with pCLAMP"}.get(rec.format, f"{rec.format} recording")
    device = nwb.create_device(name=meta.get("device") or "Amplifier", description=device_desc)
    location = meta.get("location") or "unknown"
    names = _Names()

    # Icephys electrodes: one per (group, response channel ordinal).
    electrodes: dict[tuple[int, int], Any] = {}
    n_electrodes: dict[int, int] = {}      # group → response channels per sweep

    def electrode(g, ordinal: int, multi: bool):
        key = (g.index, ordinal)
        if key not in electrodes:
            base = g.label or f"Group {g.index + 1}"
            stem = os.path.splitext(rec.file_name)[0]
            # A group read from NWB is named "A + B" after its electrodes:
            # reuse those names so a re-export keeps them.
            parts = [p.strip() for p in base.split(" + ")]
            own = parts[ordinal] if multi and len(parts) == n_electrodes.get(g.index, 0) else None
            electrodes[key] = nwb.create_icephys_electrode(
                name=names(own or (f"{base} E{ordinal + 1}" if multi else base)),
                description=f"Patch pipette, {base}" + (f", electrode {ordinal + 1}" if multi else ""),
                device=device, location=location,
                cell_id=f"{stem} {own or base}" + ("" if own or not multi else f" E{ordinal + 1}"))
        return electrodes[key]

    # Extracellular: one electrode group per TRACER group, one row per channel.
    egroups: dict[int, Any] = {}
    erows: dict[tuple[int, str], int] = {}

    def ec_row(g, label: str) -> int:
        key = (g.index, label)
        if key in erows:
            return erows[key]
        if g.index not in egroups:
            if not erows:
                nwb.add_electrode_column(name="label", description="Channel name in the recording")
            base = g.label or f"Group {g.index + 1}"
            egroups[g.index] = nwb.create_electrode_group(
                name=names(base), description=f"Extracellular electrodes, {base}",
                location=location, device=device)
        nwb.add_electrode(group=egroups[g.index], location=location, label=label)
        erows[key] = len(nwb.electrodes) - 1
        return erows[key]

    sweep_number = 0
    for g in rec.groups:
        for s in g.series_list:
            key = f"{g.index}:{s.index}"
            kind = kinds.get(key) or guess_kind(s)
            if kind not in ("vc", "cc", "field") or not s.sweeps:
                continue
            skip = set(excluded.get(key, []))
            sweeps = [(k, sw) for k, sw in enumerate(s.sweeps) if k not in skip]
            if not sweeps:
                continue
            first = s.sweeps[0].traces
            fams = [unit_info(t.units)[0] for t in first]
            proto = s.protocol or s.label
            t_series = _series_start(s)

            def start_of(k, sw, length_s):
                if sw.time is not None:
                    return max(0.0, sw.time - start_ts)
                base = (t_series - start_ts) if t_series is not None else 0.0
                return max(0.0, base + k * length_s)

            if kind == "field":
                chans = [i for i, f in enumerate(fams) if f == "voltage"]
                if not chans:
                    result.notes.append(f"{s.label}: no voltage channel, not written.")
                    continue
                rows = [ec_row(g, first[i].label or f"Ch {i + 1}") for i in chans]
                region = nwb.create_electrode_table_region(
                    region=rows, description=f"Electrodes of {s.label}")
                tag = json.dumps({"tracer_series": key, "group": g.label, "label": s.label})
                for k, sw in sweeps:
                    cols = []
                    for i in chans:
                        if i >= len(sw.traces):
                            break
                        tr = sw.traces[i]
                        cols.append(scaled(tr) * (unit_info(tr.units)[1] / 1e-3))   # → mV
                    if len(cols) != len(chans):
                        continue
                    n = min(len(c) for c in cols)
                    data = np.column_stack([c[:n] for c in cols]) if len(cols) > 1 else cols[0][:n]
                    sr = sw.traces[chans[0]].sampling_rate
                    nm = f"{s.label} sweep {k + 1}" if len(s.sweeps) > 1 else s.label
                    nwb.add_acquisition(ElectricalSeries(
                        name=names(nm), data=_compressed(data), electrodes=region,
                        rate=float(sr), starting_time=start_of(k, sw, n / sr),
                        conversion=1e-3,
                        description=f"{s.label}, sweep {k + 1} of {len(s.sweeps)}",
                        comments=tag))
                    result.sweeps_written += 1
                result.series_written += 1
                continue

            # Patch clamp
            resp_fam, cmd_fam = ("current", "voltage") if kind == "vc" else ("voltage", "current")
            resp_idx = [i for i, f in enumerate(fams) if f == resp_fam]
            cmd_idx = [i for i, f in enumerate(fams) if f == cmd_fam]
            if not resp_idx:
                result.notes.append(
                    f"{s.label}: no {'current' if kind == 'vc' else 'voltage'} channel for "
                    f"{'voltage' if kind == 'vc' else 'current'} clamp, not written.")
                continue
            n_electrodes[g.index] = max(n_electrodes.get(g.index, 0), len(resp_idx))
            use_cmd = len(cmd_idx) == len(resp_idx)
            if cmd_idx and not use_cmd:
                result.notes.append(f"{s.label}: command channels don't pair with the responses; "
                                    "written without them.")
            multi = len(resp_idx) > 1
            Resp = VoltageClampSeries if kind == "vc" else CurrentClampSeries
            Stim = VoltageClampStimulusSeries if kind == "vc" else CurrentClampStimulusSeries
            resp_si = 1e-12 if kind == "vc" else 1e-3
            stim_si = 1e-3 if kind == "vc" else 1e-12
            stim_unit = "mV" if kind == "vc" else "pA"
            sims = []
            for k, sw in sweeps:
                rows = []
                for e, ri in enumerate(resp_idx):
                    if ri >= len(sw.traces):
                        continue
                    tr = sw.traces[ri]
                    sr = float(tr.sampling_rate)
                    y = scaled(tr) * (unit_info(tr.units)[1] / resp_si)
                    t0 = start_of(k, sw, len(y) / sr)
                    el = electrode(g, e, multi)
                    tag = f"{g.label} {s.label} sweep {k + 1}" + (f" E{e + 1}" if multi else "")
                    extra = {}
                    if kind == "vc" and s.rs:
                        extra["whole_cell_series_resistance_comp"] = float(s.rs) * 1e6
                    if kind == "vc" and s.cm:
                        extra["whole_cell_capacitance_comp"] = float(s.cm) * 1e-12
                    what = "Membrane current" if kind == "vc" else "Membrane potential"
                    resp = Resp(name=names(f"{tag} response"), data=_compressed(y), electrode=el,
                                rate=sr, starting_time=t0, conversion=resp_si, gain=1.0,
                                stimulus_description=proto, sweep_number=sweep_number,
                                description=f"{what} ({tr.label}), {s.label}, sweep {k + 1} of {len(s.sweeps)}",
                                **extra)
                    stim = None
                    wave = None
                    if use_cmd and cmd_idx[e] < len(sw.traces):
                        ct = sw.traces[cmd_idx[e]]
                        wave = scaled(ct) * (unit_info(ct.units)[1] / stim_si)
                        desc = f"Recorded command ({ct.label})"
                    elif not multi:
                        got = _pgf_stimulus(pgf, rec, g.index, s.index, k, len(y), 1.0 / sr)
                        if got and got[1] == stim_unit:
                            wave = got[0]
                            desc = "Command waveform rebuilt from the PatchMaster protocol"
                    if wave is not None:
                        stim = Stim(name=names(f"{tag} stimulus"), data=_compressed(wave), electrode=el,
                                    rate=sr, starting_time=t0, conversion=stim_si, gain=1.0,
                                    stimulus_description=proto, sweep_number=sweep_number,
                                    description=desc)
                    rows.append(nwb.add_intracellular_recording(
                        electrode=el, stimulus=stim, response=resp))
                if rows:
                    sims.append(nwb.add_icephys_simultaneous_recording(recordings=rows))
                    sweep_number += 1
                    result.sweeps_written += 1
            if sims:
                nwb.add_icephys_sequential_recording(simultaneous_recordings=sims, stimulus_type=proto)
                result.series_written += 1

    if result.series_written == 0:
        raise ValueError("Nothing to write: every series is set to Skip or has no matching channels.")

    tmp = path + ".tmp-tracer"
    try:
        with NWBHDF5IO(tmp, "w") as io:
            io.write(nwb)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return result


# ---------------------------------------------------------------------------
# NWB Inspector
# ---------------------------------------------------------------------------

_IMPORTANCE = {
    "ERROR": ("error", "Error"),
    "PYNWB_VALIDATION": ("error", "Invalid NWB"),
    "CRITICAL": ("critical", "Must fix for DANDI"),
    "BEST_PRACTICE_VIOLATION": ("violation", "Should fix"),
    "BEST_PRACTICE_SUGGESTION": ("suggestion", "Suggestion"),
}


def inspect(path: str) -> list[dict]:
    """Run the NWB Inspector with DANDI's settings; plain-language rows."""
    from nwbinspector import inspect_nwbfile, load_config

    try:
        config = load_config("dandi")
    except Exception:
        config = None
    out = []
    for m in inspect_nwbfile(nwbfile_path=path, config=config):
        imp = getattr(m.importance, "name", str(m.importance))
        level, title = _IMPORTANCE.get(imp, ("suggestion", imp.replace("_", " ").title()))
        where = " ".join(x for x in (getattr(m, "object_type", ""), getattr(m, "object_name", "")) if x)
        out.append({"level": level, "importance": title, "message": m.message,
                    "check": getattr(m, "check_function_name", ""), "object": where,
                    "location": getattr(m, "location", "") or ""})
    order = {"error": 0, "critical": 1, "violation": 2, "suggestion": 3}
    out.sort(key=lambda r: order.get(r["level"], 9))
    return out
