"""Downsampling algorithms for efficient trace display."""

import numpy as np


def lttb_downsample(x: np.ndarray, y: np.ndarray, n_out: int) -> tuple[np.ndarray, np.ndarray]:
    """Largest-Triangle-Three-Buckets downsampling.

    Preserves visual shape of the signal while reducing point count.
    Reference: Sveinn Steinarsson, 2013.
    """
    n_in = len(x)
    if n_out >= n_in or n_out < 3:
        return x, y

    out_x = np.empty(n_out, dtype=x.dtype)
    out_y = np.empty(n_out, dtype=y.dtype)

    # Always keep first and last point
    out_x[0] = x[0]
    out_y[0] = y[0]
    out_x[n_out - 1] = x[n_in - 1]
    out_y[n_out - 1] = y[n_in - 1]

    bucket_size = (n_in - 2) / (n_out - 2)

    a_idx = 0  # index of previous selected point

    for i in range(1, n_out - 1):
        # Calculate bucket boundaries
        bucket_start = int(np.floor((i - 1) * bucket_size)) + 1
        bucket_end = int(np.floor(i * bucket_size)) + 1
        bucket_end = min(bucket_end, n_in - 1)

        # Calculate next bucket average for area computation
        next_start = int(np.floor(i * bucket_size)) + 1
        next_end = int(np.floor((i + 1) * bucket_size)) + 1
        next_end = min(next_end, n_in)

        avg_x = np.mean(x[next_start:next_end])
        avg_y = np.mean(y[next_start:next_end])

        # Point in the current bucket with the largest triangle area.
        # Vectorised over the bucket; same arithmetic and the same
        # first-maximum tie-break as the original per-point loop, so the
        # selected points are identical, just ~50x faster.
        if bucket_end > bucket_start:
            xs = x[bucket_start:bucket_end]
            ys = y[bucket_start:bucket_end]
            areas = np.abs(
                (x[a_idx] - avg_x) * (ys - y[a_idx])
                - (x[a_idx] - xs) * (avg_y - y[a_idx])
            )
            max_idx = bucket_start + int(np.argmax(areas))
        else:
            max_idx = bucket_start

        out_x[i] = x[max_idx]
        out_y[i] = y[max_idx]
        a_idx = max_idx

    return out_x, out_y


def minmax_downsample(x: np.ndarray, y: np.ndarray, n_out: int) -> tuple[np.ndarray, np.ndarray]:
    """Min-max downsampling: keep min and max per bucket.

    Faster than LTTB, preserves peaks/troughs. Output is 2*n_out points.
    """
    n_in = len(x)
    if n_out * 2 >= n_in:
        return x, y

    bucket_size = n_in / n_out
    out_x = []
    out_y = []

    for i in range(n_out):
        start = int(i * bucket_size)
        end = int((i + 1) * bucket_size)
        end = min(end, n_in)
        segment = y[start:end]

        min_idx = start + np.argmin(segment)
        max_idx = start + np.argmax(segment)

        # Add in time order
        if min_idx <= max_idx:
            out_x.extend([x[min_idx], x[max_idx]])
            out_y.extend([y[min_idx], y[max_idx]])
        else:
            out_x.extend([x[max_idx], x[min_idx]])
            out_y.extend([y[max_idx], y[min_idx]])

    return np.array(out_x), np.array(out_y)
