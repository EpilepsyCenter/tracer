/**
 * Stacked channel lanes for the main viewer.
 *
 * With "Stack channels" on, every visible channel gets its own
 * horizontal lane of the plot. All lanes live in ONE uPlot instance
 * (so cursors, notes and markers keep working across them): each
 * lane has its own y scale, whose range is stretched so the lane's
 * visible range [lo, hi] lands exactly in the lane's band of the
 * plot. Lines are clipped to their band, and one left axis carries
 * the ticks of every lane.
 *
 * Fractions are measured from the TOP of the plot area (0 = top,
 * 1 = bottom), matching how lanes are drawn.
 */

export interface Lane {
  /** Saved-range key: ``c<channel>`` for a recorded channel, ``stim``. */
  id: string
  /** uPlot scale key: ``y`` for the active channel, ``ch<n>`` for
   *  other channels, ``stim`` for the stimulus overlay. */
  scale: string
  label: string
  units: string
  color: string
  /** Data columns (uPlot series indices) drawn in this lane. */
  cols: number[]
}

export interface Band { top: number; bottom: number }

/** Gap between lanes, in CSS px. */
export const LANE_GAP_PX = 10

/** Band of lane ``i`` of ``n`` in a plot ``heightPx`` CSS px tall. */
export function laneBand(i: number, n: number, heightPx: number): Band {
  const gap = heightPx > 0 ? Math.min(0.3 / n, LANE_GAP_PX / heightPx) : 0
  const h = 1 / n
  return { top: i * h + (i > 0 ? gap / 2 : 0), bottom: (i + 1) * h - (i < n - 1 ? gap / 2 : 0) }
}

/** Scale range that puts [lo, hi] into ``band``. */
export function toScale(lo: number, hi: number, band: Band): [number, number] {
  const span = hi - lo
  const frac = band.bottom - band.top
  if (!(span > 0) || !(frac > 0)) return [lo, hi]
  const perUnit = span / frac            // data units per plot height
  return [lo - (1 - band.bottom) * perUnit, hi + band.top * perUnit]
}

/** Inverse of ``toScale``: the lane range shown by scale [min, max]. */
export function fromScale(min: number, max: number, band: Band): [number, number] {
  const total = max - min
  return [min + (1 - band.bottom) * total, max - band.top * total]
}

/** Position of ``v`` (in a lane showing [lo, hi]) as a fraction from top. */
export function fracOf(v: number, lo: number, hi: number, band: Band): number {
  return band.top + ((hi - v) / (hi - lo)) * (band.bottom - band.top)
}

/** Which lane a fraction-from-top falls in (nearest band). */
export function laneAt(frac: number, n: number, heightPx: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < n; i++) {
    const b = laneBand(i, n, heightPx)
    const d = frac < b.top ? b.top - frac : frac > b.bottom ? frac - b.bottom : 0
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/** "Nice" tick values inside [lo, hi], about ``target`` of them. */
export function niceTicks(lo: number, hi: number, target: number): number[] {
  const span = hi - lo
  if (!(span > 0) || !isFinite(span)) return []
  const raw = span / Math.max(1, target)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const out: number[] = []
  const start = Math.ceil(lo / step - 1e-9) * step
  for (let v = start; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
    if (out.length > 50) break
  }
  return out
}

/** Decimal places that make ticks with this spacing distinct. */
export function tickDecimals(ticks: number[]): number {
  if (ticks.length < 2) return 2
  const step = Math.abs(ticks[1] - ticks[0])
  return Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)))
}

/** Default range for a lane from its data: padded min..max. */
export function paddedExtent(lo: number, hi: number): [number, number] | null {
  if (!isFinite(lo) || !isFinite(hi)) return null
  if (hi === lo) {
    const pad = Math.abs(lo) * 0.1 || 1
    return [lo - pad, hi + pad]
  }
  const pad = (hi - lo) * 0.05
  return [lo - pad, hi + pad]
}
