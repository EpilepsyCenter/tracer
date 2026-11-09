"""Step level and timing from a recorded stimulus trace.

For recordings whose stimulus is a channel in the file rather than a HEKA
protocol: an NWB stimulus series, an ABF command channel, a HEKA current or
voltage monitor. The user picks the channel; this finds, per sweep, the
holding level and the dominant step (the longest stretch away from
holding), robust to the noise of a recorded monitor channel.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class Step:
    level: float          # the step's level, in the trace's units (absolute)
    holding: float        # the level before the step
    start_s: float
    end_s: float


def find_step(data: np.ndarray, sr: float, min_dev: float = 0.0) -> Optional[Step]:
    """The dominant step of one sweep's stimulus, or None when the sweep
    has no step (e.g. a 0 pA sweep in a current-step series).

    Holding is the median of the first 2 % of the sweep (at least 5
    samples). Samples more than half the largest deviation from holding
    belong to a step; the longest run of them is the step. Its level is
    the median of its middle 80 %, so edges and noise don't move it.
    ``min_dev`` (trace units) is the smallest deviation that counts as a
    step: below it the sweep is treated as flat.
    """
    x = np.asarray(data, dtype=float)
    n = x.size
    if n < 10 or sr <= 0:
        return None
    head = max(5, int(0.02 * n))
    holding = float(np.median(x[:head]))
    dev = x - holding
    big = float(np.max(np.abs(dev)))
    noise = float(np.median(np.abs(dev[:head] - np.median(dev[:head])))) * 1.4826
    if big <= max(min_dev, 5.0 * noise, 1e-12):
        return None
    on = np.abs(dev) > 0.5 * big
    # Longest run of True.
    edges = np.flatnonzero(np.diff(np.concatenate(([0], on.astype(np.int8), [0]))))
    starts, ends = edges[0::2], edges[1::2]
    k = int(np.argmax(ends - starts))
    a, b = int(starts[k]), int(ends[k])
    trim = (b - a) // 10
    level = float(np.median(x[a + trim:b - trim] if b - a > 10 else x[a:b]))
    return Step(level=level, holding=holding, start_s=a / sr, end_s=b / sr)


def steps_for_series(traces: list[np.ndarray], sr: float) -> list[Optional[Step]]:
    """``find_step`` per sweep. A sweep without a step (0 pA) gets the
    timing of the nearest sweep that has one, and its own mean over that
    window as the level — so a 0 pA sweep still has a level and an onset."""
    found = [find_step(t, sr) for t in traces]
    have = [i for i, s in enumerate(found) if s is not None]
    if not have:
        return found
    out: list[Optional[Step]] = []
    for i, s in enumerate(found):
        if s is not None:
            out.append(s)
            continue
        j = min(have, key=lambda h: abs(h - i))
        ref = found[j]
        x = np.asarray(traces[i], dtype=float)
        a, b = int(round(ref.start_s * sr)), int(round(ref.end_s * sr))
        head = max(5, int(0.02 * x.size))
        level = float(np.mean(x[a:b])) if b > a else float(np.median(x[:head]))
        out.append(Step(level=level, holding=float(np.median(x[:head])),
                        start_s=ref.start_s, end_s=ref.end_s))
    return out


def current_in_pa(data: np.ndarray, units: str) -> Optional[np.ndarray]:
    """A current trace in pA, or None if ``units`` isn't a current."""
    u = (units or "").strip()
    scale = {"pA": 1.0, "nA": 1e3, "µA": 1e6, "uA": 1e6, "A": 1e12}.get(u)
    return None if scale is None else np.asarray(data, dtype=float) * scale


def is_current_unit(units: str) -> bool:
    return (units or "").strip() in ("pA", "nA", "µA", "uA", "A")
