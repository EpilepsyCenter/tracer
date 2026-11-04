"""Generic reader using the Neo library for 50+ electrophysiology formats."""

from __future__ import annotations

import os

import numpy as np

from .base import BaseReader
from .models import Recording, Group, Series, Sweep, Trace

# File extension to Neo IO class mapping
NEO_FORMAT_MAP = {
    ".wcp": "WinWcpIO",
    ".axgd": "AxographIO",
    ".axgx": "AxographIO",
    ".smr": "Spike2IO",
    ".h5": "NeoHdf5IO",
    ".nwb": "NWBIO",
    ".nix": "NixIO",
    ".mcd": "MicromedIO",
    ".plx": "PlexonIO",
    ".nev": "BlackrockIO",
    ".ns5": "BlackrockIO",
    ".edf": "EdfIO",
    ".bdf": "EdfIO",
    ".rhd": "IntanIO",
    ".rhs": "IntanIO",
}


class NeoReader(BaseReader):
    """Reader wrapping Neo library for broad format support."""

    @staticmethod
    def can_read(file_path: str) -> bool:
        ext = os.path.splitext(file_path)[1].lower()
        return ext in NEO_FORMAT_MAP

    def read(self, file_path: str, **_options) -> Recording:
        import neo

        ext = os.path.splitext(file_path)[1].lower()
        io_class_name = NEO_FORMAT_MAP.get(ext)
        if not io_class_name:
            raise ValueError(f"Unsupported format: {ext}")

        # Dynamically get the Neo IO class
        io_class = getattr(neo.io, io_class_name, None)
        if io_class is None:
            # Try rawio
            io_class = getattr(neo.rawio, io_class_name, None)
        if io_class is None:
            raise ValueError(f"Neo IO class not found: {io_class_name}")

        reader = io_class(filename=file_path)
        block = reader.read_block(lazy=False)

        recording = Recording(
            file_path=file_path,
            file_name=os.path.basename(file_path),
            format=io_class_name.replace("IO", ""),
        )

        return _block_to_recording(block, recording)


def _display_units(sig) -> tuple[str, float]:
    """(TRACER unit, multiplier) for a Neo signal: currents in pA, voltages
    in mV, anything else as the file states it."""
    import quantities as pq

    dim = sig.units.simplified.dimensionality
    for unit, target in (("pA", pq.pA), ("mV", pq.mV)):
        if dim == target.simplified.dimensionality:
            return unit, float(sig.units.rescale(target).magnitude)
    return str(sig.units.dimensionality), 1.0


def _channel_names(sig, n: int) -> list[str]:
    names = None
    ann = getattr(sig, "array_annotations", None) or {}
    for key in ("channel_names", "channel_name"):
        if key in ann and len(ann[key]) == n:
            names = [str(x) for x in ann[key]]
            break
    base = sig.name or ""
    if names and all(names):
        return names
    if n == 1:
        return [base] if base else []
    return [f"{base} {i + 1}" if base else "" for i in range(n)]


def _block_to_recording(block, recording: Recording) -> Recording:
    """Neo Block > Segment (sweep) > AnalogSignal (one or more channels).
    One group and one series; each segment is a sweep and each channel
    of each signal is a trace."""
    group = Group(index=0, label=block.name or "Recording")
    series = Series(index=0, label="Series 1")

    for seg_idx, segment in enumerate(block.segments):
        sweep = Sweep(index=seg_idx, label=f"Sweep {seg_idx + 1}")
        for sig in segment.analogsignals:
            arr = np.asarray(sig.magnitude, dtype=np.float64)
            if arr.ndim == 1:
                arr = arr[:, None]
            units, mult = _display_units(sig)
            if mult != 1.0:
                arr = arr * mult
            sr = float(sig.sampling_rate.rescale("Hz").magnitude)
            names = _channel_names(sig, arr.shape[1])
            for c in range(arr.shape[1]):
                label = names[c] if c < len(names) and names[c] else f"Signal {len(sweep.traces) + 1}"
                sweep.traces.append(Trace(
                    data=np.ascontiguousarray(arr[:, c]),
                    sampling_rate=sr,
                    units=units,
                    label=label,
                ))
        series.sweeps.append(sweep)

    group.series_list.append(series)
    recording.groups.append(group)
    return recording
