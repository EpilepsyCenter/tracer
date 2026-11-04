"""Core data models for electrophysiology recordings."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np


@dataclass
class Trace:
    """A single continuous data trace (one channel of one sweep)."""

    data: np.ndarray  # raw sample values
    sampling_rate: float  # Hz
    units: str = "pA"  # e.g., "pA", "mV", "V"
    label: str = ""
    y_offset: float = 0.0
    y_scale: float = 1.0

    @property
    def duration(self) -> float:
        return len(self.data) / self.sampling_rate

    @property
    def time_array(self) -> np.ndarray:
        return np.arange(len(self.data)) / self.sampling_rate


@dataclass
class Sweep:
    """One sweep (episode) containing one or more traces (channels)."""

    index: int
    traces: list[Trace] = field(default_factory=list)
    label: str = ""

    @property
    def trace_count(self) -> int:
        return len(self.traces)


@dataclass
class StimulusSegment:
    """A single constant-level segment of the stimulus within one sweep."""
    start: float    # seconds
    end: float      # seconds
    level: float    # mV or pA depending on unit


@dataclass
class StimulusInfo:
    """Extracted stimulus-protocol summary for a voltage-clamp (or similar) series.

    All times are in seconds. Voltages in mV, currents in pA.
    """

    unit: str                   # "mV" (voltage clamp) or "pA" (current clamp)
    v_hold: float               # holding level (mV or pA — see `unit`)
    v_step: float               # pulse amplitude relative to holding (signed)
    v_step_absolute: float      # pulse absolute level
    pulse_start: float          # pulse onset in sweep (s)
    pulse_end: float            # pulse offset in sweep (s)
    baseline_start: float       # suggested pre-pulse baseline start (s)
    baseline_end: float         # suggested pre-pulse baseline end (s)
    segments: list[StimulusSegment] = field(default_factory=list)  # full first-sweep reconstruction


@dataclass
class Series:
    """A series of sweeps recorded with the same protocol."""

    index: int
    sweeps: list[Sweep] = field(default_factory=list)
    label: str = ""
    protocol: str = ""
    holding: Optional[float] = None  # holding potential (mV)
    rs: Optional[float] = None  # series resistance (MOhm)
    cm: Optional[float] = None  # membrane capacitance (pF)
    timestamp: Optional[float] = None  # Unix timestamp
    stimulus: Optional[StimulusInfo] = None  # parsed test-pulse info, if any
    # 'vc' / 'cc' / 'field' when the file states it (NWB); None = guess
    kind: Optional[str] = None

    @property
    def sweep_count(self) -> int:
        return len(self.sweeps)


@dataclass
class Group:
    """A group of series (e.g., one cell or one experimental condition)."""

    index: int
    series_list: list[Series] = field(default_factory=list)
    label: str = ""

    @property
    def series_count(self) -> int:
        return len(self.series_list)


@dataclass
class Recording:
    """Top-level container for an entire recording file."""

    file_path: str
    file_name: str
    format: str  # e.g., "HEKA", "ABF", "NWB"
    groups: list[Group] = field(default_factory=list)

    @property
    def group_count(self) -> int:
        return len(self.groups)

    def to_dict(self) -> dict:
        """Serialize to dict for JSON API response (without trace data)."""

        def _channel_kind(units: str) -> str:
            u = units.strip().lower()
            if u in ("mv", "v", "volt", "volts"):
                return "voltage"
            if u in ("pa", "na", "a", "amp", "amps", "ampere", "amperes"):
                return "current"
            return "other"

        def _channels_for_series(s: Series) -> list[dict]:
            """Probe the first sweep to learn per-channel label/units."""
            if not s.sweeps or not s.sweeps[0].traces:
                return []
            return [
                {
                    "index": i,
                    "label": t.label or f"Ch {i + 1}",
                    "units": t.units,
                    "kind": _channel_kind(t.units),
                }
                for i, t in enumerate(s.sweeps[0].traces)
            ]

        return {
            "filePath": self.file_path,
            "fileName": self.file_name,
            "format": self.format,
            "groupCount": self.group_count,
            "groups": [
                {
                    "index": g.index,
                    "label": g.label,
                    "seriesCount": g.series_count,
                    "series": [
                        {
                            "index": s.index,
                            "label": s.label,
                            "sweepCount": s.sweep_count,
                            "sweeps": [
                                {
                                    "index": sw.index,
                                    "label": sw.label,
                                    "traceCount": sw.trace_count,
                                }
                                for sw in s.sweeps
                            ],
                            "channels": _channels_for_series(s),
                            "rs": s.rs,
                            "cm": s.cm,
                            "holding": s.holding,
                            "protocol": s.protocol,
                            "kind": s.kind,
                            "stimulus": {
                                "unit": s.stimulus.unit,
                                "vHold": s.stimulus.v_hold,
                                "vStep": s.stimulus.v_step,
                                "vStepAbsolute": s.stimulus.v_step_absolute,
                                "pulseStart": s.stimulus.pulse_start,
                                "pulseEnd": s.stimulus.pulse_end,
                                "baselineStart": s.stimulus.baseline_start,
                                "baselineEnd": s.stimulus.baseline_end,
                                "segments": [
                                    {"start": seg.start, "end": seg.end, "level": seg.level}
                                    for seg in s.stimulus.segments
                                ],
                            } if s.stimulus is not None else None,
                        }
                        for s in g.series_list
                    ],
                }
                for g in self.groups
            ],
        }
