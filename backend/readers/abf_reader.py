"""Axon Binary Format (.abf) reader using pyabf."""

from __future__ import annotations

import os
import numpy as np

from .base import BaseReader
from .models import Recording, Group, Series, Sweep, Trace


class AbfReader(BaseReader):
    """Reader for Axon Binary Format (.abf) files."""

    @staticmethod
    def can_read(file_path: str) -> bool:
        return file_path.lower().endswith(".abf")

    def read(self, file_path: str, **_options) -> Recording:
        import pyabf

        abf = pyabf.ABF(file_path, loadData=True)

        recording = Recording(
            file_path=file_path,
            file_name=os.path.basename(file_path),
            format="ABF",
        )

        # ABF files map to: 1 group, 1 series per protocol, sweeps within
        group = Group(index=0, label=abf.abfID or "Recording")

        # Determine recording mode
        protocol = abf.protocol or ""
        holding = None
        if hasattr(abf, "holdingCommand") and abf.holdingCommand:
            holding = abf.holdingCommand[0] if abf.holdingCommand else None

        # Recording start (abfDateTime is local time) and sweep start times.
        t0 = None
        try:
            t0 = abf.abfDateTime.timestamp()
        except Exception:
            pass
        try:
            sweep_times = [float(t) for t in abf.sweepTimesSec]
        except Exception:
            sweep_times = []

        series = Series(
            index=0,
            label=protocol or f"Series 1",
            protocol=protocol,
            holding=holding,
            timestamp=t0,
        )

        for sweep_idx in range(abf.sweepCount):
            sweep = Sweep(index=sweep_idx, label=f"Sweep {sweep_idx + 1}")
            if t0 is not None and sweep_idx < len(sweep_times):
                sweep.time = t0 + sweep_times[sweep_idx]

            for channel in range(abf.channelCount):
                abf.setSweep(sweep_idx, channel=channel)

                data = np.array(abf.sweepY, dtype=np.float64)
                units = abf.sweepUnitsY or "pA"
                label = abf.sweepLabelY or f"Ch{channel}"
                sampling_rate = abf.dataRate

                trace = Trace(
                    data=data,
                    sampling_rate=float(sampling_rate),
                    units=units,
                    label=label,
                )
                sweep.traces.append(trace)

            series.sweeps.append(sweep)

        group.series_list.append(series)
        recording.groups.append(group)

        return recording
