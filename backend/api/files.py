"""File management API endpoints."""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from readers.heka_native.reader import HekaNativeReader
from readers.heka_reader import HekaReader
from readers.abf_reader import AbfReader
from readers.neo_reader import NeoReader
from readers.nwb_reader import NwbReader
from readers.text_reader import TextReader
from readers.models import Recording

router = APIRouter()

# In-memory storage for the currently loaded recording
_current_recording: Recording | None = None
# Raw pgf data from the native HEKA reader (for per-sweep stimulus)
_pgf_data: Any = None  # PgfRoot or None
# Original (file-reported) units, captured the first time apply_overrides
# is called. Keyed by f"{group}:{series}:{channel}". The "__file__" entry
# tracks which recording these belong to so a new file invalidates them.
_original_units: dict[str, str] | None = None

# Native HEKA reader first (handles .pgf stimulus parsing).
# Myokit-based reader as fallback for older format versions.
# Order matters — binary readers first so an ambiguous extension
# (e.g. ``.dat``, ``.txt``) is given to the format-specific reader
# before the generic text fallback.
READERS = [HekaNativeReader(), HekaReader(), AbfReader(), NwbReader(), NeoReader(), TextReader()]


def get_current_recording() -> Recording:
    if _current_recording is None:
        raise HTTPException(status_code=400, detail="No file loaded")
    return _current_recording


class OpenFileRequest(BaseModel):
    file_path: str
    # Reader-specific options. Currently only TextReader consumes
    # this — keys: sample_rate_hz, time_column, delimiter,
    # units_per_channel. Binary readers ignore it.
    options: dict[str, Any] | None = None


@router.post("/open")
async def open_file(req: OpenFileRequest):
    global _current_recording, _pgf_data, _original_units

    file_path = req.file_path
    _pgf_data = None
    _original_units = None

    for reader in READERS:
        if reader.can_read(file_path):
            try:
                _current_recording = reader.read(file_path, options=req.options)
                # If native HEKA reader, stash the pgf data for per-sweep stimulus
                if isinstance(reader, HekaNativeReader) and hasattr(reader, '_last_pgf'):
                    _pgf_data = reader._last_pgf
                return _current_recording.to_dict()
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Error reading file: {e}")

    raise HTTPException(status_code=400, detail=f"Unsupported file format: {file_path}")


@router.get("/info")
async def file_info():
    if _current_recording is None:
        return {"fileName": None, "format": None, "groupCount": 0, "groups": []}
    return _current_recording.to_dict()


@router.post("/close")
async def close_file():
    global _current_recording, _original_units
    _current_recording = None
    _original_units = None
    return {"status": "closed"}


class ProbeTextRequest(BaseModel):
    file_path: str


@router.post("/probe_text")
async def probe_text(req: ProbeTextRequest):
    """Probe a text file before committing to a full import.

    Returns a small preview plus auto-detected suggestions (delimiter,
    header row, time column, inferred sampling rate, per-column
    labels and units) so the import wizard can pre-populate sensible
    defaults. The file is NOT loaded into the recording cache.
    """
    import os, re
    from readers.text_reader import (
        TextReader, _resolve_delimiter, _split_with_delim,
        _line_is_numeric, _split_label_units, _is_monotonic_time,
        _infer_sampling_rate, _NUMERIC_RE,
    )
    import numpy as np

    if not TextReader.can_read(req.file_path):
        raise HTTPException(status_code=400, detail="Not a text-formatted file")

    with open(req.file_path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.readlines()

    body: list[str] = []
    comment_lines: list[str] = []
    for line in raw[:200]:
        s = line.rstrip("\n\r")
        if not s.strip():
            continue
        if s.lstrip().startswith(("#", "%", "//")):
            comment_lines.append(s)
            continue
        body.append(s)
    if not body:
        raise HTTPException(status_code=400, detail="File has no data lines")

    delim = _resolve_delimiter("auto", body[0])
    header: list[str] | None = None
    if not _line_is_numeric(body[0], delim):
        header = _split_with_delim(body[0], delim)
        body = body[1:]

    rows = []
    for s in body[:50]:
        toks = _split_with_delim(s, delim)
        if not toks:
            continue
        rows.append([float(t) if _NUMERIC_RE.match(t.strip()) else float("nan") for t in toks])
    if not rows:
        raise HTTPException(status_code=400, detail="No numeric rows in preview")
    arr = np.asarray(rows, dtype=float)
    n_cols = arr.shape[1]

    # Time-column detection (mirrors text_reader._resolve_time_column).
    time_col = None
    if header:
        for i, h in enumerate(header):
            if i >= n_cols:
                break
            if re.search(r"\btime\b|\bt\s*\(", h, re.IGNORECASE) and _is_monotonic_time(arr[:, i]):
                time_col = i
                break
    if time_col is None and _is_monotonic_time(arr[:, 0]):
        time_col = 0

    inferred_sr = None
    if time_col is not None:
        try:
            inferred_sr = _infer_sampling_rate(arr[:, time_col])
        except Exception:
            inferred_sr = None

    columns = []
    for c in range(n_cols):
        if header and c < len(header):
            label, unit_in_label = _split_label_units(header[c])
        else:
            label, unit_in_label = (f"Ch {c + 1}", "")
        columns.append({
            "index": c,
            "label": label,
            "units": unit_in_label,
            "is_time": (c == time_col),
        })

    delim_label = {",": "comma", "\t": "tab", " ": "space"}.get(delim, delim)
    preview_lines = [*comment_lines[:3], *body[:20]]

    return {
        "file_name": os.path.basename(req.file_path),
        "delimiter": delim_label,
        "preview": preview_lines,
        "header": header,
        "columns": columns,
        "time_column": time_col,
        "sample_rate_hz": inferred_sr,
        "n_columns": n_cols,
    }


@router.get("/channels")
async def list_channels():
    """Return the recording-wide union of channels.

    Channels are keyed by ``(index, file_units)`` rather than ``index``
    alone, because mixed-protocol HEKA recordings reuse the same
    channel index for different physical signals — e.g. channel 0 is
    "Vm (mV)" in current-clamp series and "Im (pA)" in voltage-clamp
    series. Treating those as one row would force a single override
    to apply to both, which is exactly the wrong semantic. Using
    ``original_units`` (snapshotted at file open) as part of the key
    means an mV→V override only touches the CC sweeps and a pA→nA
    override only touches the VC sweeps.

    The returned ``key`` is the stable identifier the frontend uses
    in the sidecar and in subsequent ``apply_overrides`` calls.
    """
    rec = get_current_recording()
    _ensure_original_units_snapshot(rec)

    seen: dict[tuple[int, str], dict[str, Any]] = {}
    for g in rec.groups:
        for s in g.series_list:
            for sw in s.sweeps:
                for ch_idx, tr in enumerate(sw.traces):
                    file_units = (_original_units or {}).get(
                        f"{g.index}:{s.index}:{ch_idx}", tr.units
                    )
                    bucket = (ch_idx, file_units)
                    entry = seen.get(bucket)
                    if entry is None:
                        seen[bucket] = {
                            "key": f"{ch_idx}|{file_units}",
                            "index": ch_idx,
                            "file_units": file_units,
                            "label": tr.label or f"Ch {ch_idx + 1}",
                            "occurrences": 1,
                        }
                    else:
                        entry["occurrences"] += 1
                        if not entry["label"] and tr.label:
                            entry["label"] = tr.label
    # Sort by (index, file_units) for stable ordering across sessions.
    ordered = sorted(seen.items(), key=lambda kv: (kv[0][0], kv[0][1]))
    return {"channels": [v for _, v in ordered]}


def _ensure_original_units_snapshot(rec: Recording) -> None:
    """Capture the file-reported units before any override mutates them.

    Called by both ``/channels`` and ``/apply_overrides`` so the
    snapshot exists regardless of which is hit first. Idempotent —
    only records on first call per recording.
    """
    global _original_units
    if _original_units is None or _original_units.get("__file__") != rec.file_path:
        _original_units = {"__file__": rec.file_path}
        for g in rec.groups:
            for s in g.series_list:
                for sw in s.sweeps:
                    for ch_idx, tr in enumerate(sw.traces):
                        key = f"{g.index}:{s.index}:{ch_idx}"
                        _original_units.setdefault(key, tr.units)


class ScaleOverride(BaseModel):
    """One scaling override, identified by ``(channel, file_units)``.

    Applies to every sweep across every series in which channel index
    ``channel`` was originally reported with units ``file_units`` (per
    the snapshot taken at file open). This lets a single override
    target either the CC or the VC view of channel 0 without touching
    the other.
    """
    channel: int
    file_units: str
    units: str
    y_scale: float = 1.0
    y_offset: float = 0.0


class ApplyOverridesRequest(BaseModel):
    overrides: list[ScaleOverride]


@router.post("/apply_overrides")
async def apply_overrides(req: ApplyOverridesRequest):
    """Apply per-channel scaling overrides to the cached recording.

    A full overrides list is authoritative — every (g, s, c) tuple
    not matched by some override is reset to ``y_scale=1.0``,
    ``y_offset=0.0`` and the file-reported units captured at file
    open. Matching is by ``(channel_index, original_units)`` so the
    same override doesn't bleed across mixed CC/VC series sharing a
    channel index.
    """
    rec = get_current_recording()
    _ensure_original_units_snapshot(rec)

    override_map: dict[tuple[int, str], ScaleOverride] = {
        (o.channel, o.file_units): o for o in req.overrides
    }
    snap = _original_units or {}

    for g in rec.groups:
        for s in g.series_list:
            for sw in s.sweeps:
                for ch_idx, tr in enumerate(sw.traces):
                    file_units = snap.get(f"{g.index}:{s.index}:{ch_idx}", tr.units)
                    o = override_map.get((ch_idx, file_units))
                    if o is None:
                        tr.y_scale = 1.0
                        tr.y_offset = 0.0
                        tr.units = file_units
                    else:
                        tr.y_scale = float(o.y_scale)
                        tr.y_offset = float(o.y_offset)
                        tr.units = o.units

    return rec.to_dict()


class TreeRequest(BaseModel):
    file_path: str


@router.post("/tree")
async def file_tree(req: TreeRequest):
    """Return a recording's group/series/channel tree without disturbing
    the active recording.

    Used by the Metadata window to render per-series tag chips for files
    other than the one currently open. Body matches ``Recording.to_dict``
    so the frontend can drop the result into its existing tree consumers
    unchanged. The recording is read into a local variable and discarded
    on return — ``_current_recording`` is left alone.
    """
    file_path = req.file_path
    for reader in READERS:
        if reader.can_read(file_path):
            try:
                rec = reader.read(file_path)
                # Don't mutate the global active-recording state. Don't
                # cache rec; let the GC reclaim the sample arrays as soon
                # as the response is serialized.
                return rec.to_dict()
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Error reading file: {e}")
    raise HTTPException(status_code=400, detail=f"Unsupported file format: {file_path}")
