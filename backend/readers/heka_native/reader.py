"""Top-level native HEKA reader.

Opens a .dat bundle, parses .pul + .pgf trees, reads trace data,
reconstructs per-sweep stimulus waveforms, and returns our Recording model.
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np

from ..base import BaseReader
from ..models import Recording, Group, Series, Sweep, Trace, StimulusInfo, StimulusSegment

from .bundle import parse_bundle_header
from .tree import parse_tree_header, walk_tree
from .pul import parse_pul, read_trace_data, PulTrace
from .pgf import parse_pgf, PgfStimulation, PgfChannel, PgfSegment, SegmentClass, StoreKind


class HekaNativeReader(BaseReader):
    """Native HEKA PatchMaster .dat reader — no myokit dependency."""

    def __init__(self):
        self._last_pgf = None  # PgfRoot, stashed for per-sweep stimulus queries
        self._last_pgf_stims: list = []  # flat list of PgfStimulation

    @staticmethod
    def can_read(file_path: str) -> bool:
        if not file_path.lower().endswith('.dat'):
            return False
        try:
            with open(file_path, 'rb') as f:
                magic = f.read(4)
                return magic in (b'DAT2', b'DAT1', b'DATA')
        except (IOError, OSError):
            return False

    def read(self, file_path: str, **_options) -> Recording:
        with open(file_path, 'rb') as f:
            data = f.read()

        bundle = parse_bundle_header(data)

        # Find sub-files
        dat_item = bundle.find('.dat')
        pul_item = bundle.find('.pul')
        pgf_item = bundle.find('.pgf')

        if not pul_item:
            raise IOError("No .pul tree found in bundle")

        dat_offset = dat_item.start if dat_item else 0

        # Parse .pul tree
        pul_header = parse_tree_header(data, pul_item.start)
        pul_tree = walk_tree(data, pul_header)
        pul_root = parse_pul(data, pul_tree)

        # Parse .pgf tree (optional — some files may not have it)
        pgf_root = None
        if pgf_item:
            try:
                pgf_header = parse_tree_header(data, pgf_item.start)
                pgf_tree = walk_tree(data, pgf_header)
                pgf_root = parse_pgf(data, pgf_tree)
            except Exception:
                pgf_root = None

        # Stash pgf for per-sweep stimulus queries
        self._last_pgf = pgf_root
        self._last_pgf_stims = pgf_root.stimulations if pgf_root else []

        recording = Recording(
            file_path=file_path,
            file_name=os.path.basename(file_path),
            format='HEKA',
        )

        # In HEKA files, stimulations in the .pgf are in 1:1 correspondence
        # with series in the .pul, ordered linearly across all groups.
        # Build a flat list of stimulations for index-based matching.
        pgf_stims: list[PgfStimulation] = []
        if pgf_root:
            pgf_stims = pgf_root.stimulations

        stim_idx = 0  # linear index across all series

        # Build our Recording model from the .pul tree
        for pul_group in pul_root.groups:
            # HEKA already labels groups as ``E-1``, ``E-2``, … so we
            # use that verbatim and only synthesize a name when the
            # file doesn't carry one. (Series labels DO get a numeric
            # prefix below — those come from the PGF and frequently
            # repeat across runs.)
            group_idx = len(recording.groups)
            group = Group(
                index=group_idx,
                label=pul_group.label or f'Group {group_idx + 1}',
            )

            for pul_series in pul_group.series_list:
                series_idx = len(group.series_list)
                series_label = (
                    f"{series_idx + 1}. {pul_series.label}"
                    if pul_series.label else f'Series {series_idx + 1}'
                )
                series = Series(
                    index=series_idx,
                    label=series_label,
                    protocol=pul_series.method_name or pul_series.label,
                    timestamp=_heka_unix_time(pul_series.time),
                )

                # Match stimulation by linear index
                pgf_stim = pgf_stims[stim_idx] if stim_idx < len(pgf_stims) else None
                stim_idx += 1

                # Extract stimulus info
                if pgf_stim:
                    series.stimulus = _extract_stimulus(pgf_stim, pul_series.label)

                        # Get holding from the first DA channel.
                    # Sanity check: reject values that are obviously garbage
                    # (CC channels sometimes have uninitialized holding fields).
                    for ch in pgf_stim.channels:
                        if ch.do_write:
                            h = _to_display_units(ch.holding, ch.dac_unit)
                            if abs(h) < 1e6:  # reject > 1 million mV or pA
                                series.holding = h
                            break

                # Build sweeps
                for pul_sweep in pul_series.sweeps:
                    sweep = Sweep(
                        index=len(series.sweeps),
                        label=pul_sweep.label or f'Sweep {len(series.sweeps) + 1}',
                        time=_heka_unix_time(pul_sweep.time),
                    )

                    for pul_trace in pul_sweep.traces:
                        trace_data = read_trace_data(data, dat_offset, pul_trace)
                        display_unit, trace_data = _convert_si_to_display(pul_trace.y_unit, trace_data)

                        trace = Trace(
                            data=trace_data,
                            sampling_rate=pul_trace.sampling_rate,
                            units=display_unit,
                            label=f'{pul_trace.label} ({display_unit})',
                        )
                        sweep.traces.append(trace)

                    if sweep.traces:
                        series.sweeps.append(sweep)

                if series.sweeps:
                    group.series_list.append(series)

            if group.series_list:
                recording.groups.append(group)

        if not recording.groups:
            raise IOError('No readable data found in HEKA file')

        return recording


def _extract_stimulus(stim: PgfStimulation, series_label: str) -> StimulusInfo | None:
    """Extract a StimulusInfo from a PgfStimulation.

    Tries all channels and picks the most informative one — the channel
    whose sweep-0 segments show the most variation (i.e., has a clear pulse
    or step). This handles multi-channel protocols like LTP where the
    stimulator trigger is on channel 1 but the amplifier command (channel 0)
    is flat.
    """
    if not stim.channels:
        return None

    # Score each channel: prefer the one with the largest voltage range at sweep 0
    best_ch: PgfChannel | None = None
    best_range = 0.0

    for ch in stim.channels:
        if not ch.segments:
            continue
        levels = [seg.voltage_at_sweep(0) for seg in ch.segments]
        if not levels:
            continue
        v_range = max(abs(v) for v in levels) if levels else 0
        # Bonus for channels that actually write data
        score = v_range * (2.0 if ch.do_write else 1.0)
        if score > best_range or best_ch is None:
            best_range = score
            best_ch = ch

    if best_ch is None:
        # Fall back to the first channel with segments
        for ch in stim.channels:
            if ch.segments:
                best_ch = ch
                break

    if best_ch is None or not best_ch.segments:
        return None

    primary_ch = best_ch

    # Determine the unit and scale factor.
    # HEKA stores stimulus values with a universal x1000 conversion to
    # display units: V -> mV (x1000). For CC mode, the 'A' unit actually
    # stores values in nA, so the conversion nA -> pA is also x1000.
    # This was verified empirically: 0.05 raw * 1000 = 50 pA per step
    # gives Rin ~ 90 MOhm from the I-V trace, which is physiologically correct.
    dac_unit = primary_ch.dac_unit.strip()
    if dac_unit in ('V', 'Volt'):
        unit_label = 'mV'
        scale = 1000.0
    elif dac_unit in ('A', 'Amp', 'Ampere'):
        unit_label = 'pA'
        scale = 1000.0  # stored as nA, not SI Amperes
    else:
        unit_label = dac_unit
        scale = 1.0

    holding_si = primary_ch.holding  # SI units
    holding_display = holding_si * scale
    dt = stim.sample_interval if stim.sample_interval > 0 else 1e-4

    # Build segments list for sweep 0.
    # Values are relative to holding (UseRelative is typical). We keep them
    # relative for display: baseline shows as 0, pulse shows as -5 mV, etc.
    # This matches what PatchMaster displays and what the user expects.
    segments: list[StimulusSegment] = []
    t = 0.0
    for seg in primary_ch.segments:
        dur = seg.duration_at_sweep(0)
        level_display = seg.voltage_at_sweep(0) * scale
        if dur > 0:
            segments.append(StimulusSegment(start=t, end=t + dur, level=level_display))
        t += dur

    if not segments:
        return None

    # Find the holding level (longest-duration segment)
    level_durations: dict[float, float] = {}
    for s in segments:
        dur = s.end - s.start
        level_durations[s.level] = level_durations.get(s.level, 0) + dur

    v_hold = max(level_durations, key=level_durations.get)  # type: ignore

    # Find the first non-holding segment (the pulse)
    pulse = None
    for s in segments:
        if abs(s.level - v_hold) >= 0.5 and (s.end - s.start) > 0:
            pulse = s
            break

    if pulse is None:
        # No clear pulse — still return segments for overlay
        return StimulusInfo(
            unit=unit_label,
            v_hold=v_hold,
            v_step=0.0,
            v_step_absolute=v_hold,
            pulse_start=0.0,
            pulse_end=0.0,
            baseline_start=0.0,
            baseline_end=0.0,
            segments=segments,
        )

    # Suggested baseline cursor
    guard = max(0.0005, 2 * dt)
    bl_end = max(0.0, pulse.start - guard)
    bl_dur = min(0.1, max(0.002, bl_end))
    bl_start = max(0.0, bl_end - bl_dur)

    return StimulusInfo(
        unit=unit_label,
        v_hold=v_hold,
        v_step=pulse.level - v_hold,
        v_step_absolute=pulse.level,
        pulse_start=pulse.start,
        pulse_end=pulse.end,
        baseline_start=bl_start,
        baseline_end=bl_end,
        segments=segments,
    )


def _to_display_units(value_si: float, unit: str) -> float:
    """Convert an SI value to display units based on the unit string."""
    u = unit.strip()
    if u in ('V', 'Volt'):
        return value_si * 1000  # V → mV
    elif u in ('A', 'Amp', 'Ampere'):
        return value_si * 1e12  # A → pA
    return value_si


def _convert_si_to_display(y_unit: str, values: np.ndarray) -> tuple[str, np.ndarray]:
    """Convert trace data from SI units to display units."""
    u = y_unit.strip()
    if u in ('A', 'Amp', 'Ampere'):
        return 'pA', values * 1e12
    elif u in ('V', 'Volt'):
        return 'mV', values * 1e3
    elif u in ('S', 'Siemens'):
        return 'nS', values * 1e9
    elif u in ('F', 'Farad'):
        return 'pF', values * 1e12
    elif u in ('pA', 'mV', 'nS', 'pF', 'nA', 'uV', 'MOhm'):
        return u, values
    elif u:
        return u, values
    else:
        return 'pA', values * 1e12  # default: assume Amps


# PatchMaster stores times as seconds since 1904-01-01 (Mac epoch) plus a
# fixed 1580970496 s offset; subtracting both gives Unix time (UTC).
_HEKA_UNIX_OFFSET = 1580970496.0 + 2082844800.0


def _heka_unix_time(t: float) -> float | None:
    try:
        u = float(t) - _HEKA_UNIX_OFFSET
    except (TypeError, ValueError):
        return None
    # Plausible range: 1990 to 2100; anything else is an unset field.
    return u if 631152000.0 < u < 4102444800.0 else None
