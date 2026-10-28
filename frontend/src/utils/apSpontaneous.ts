import type { APPoint } from '../stores/appStore'

/**
 * Firing statistics for spontaneous (continuous) AP recordings.
 *
 * Derived live from the spike list — never persisted — so manual
 * add / remove updates every number without re-running detection
 * (same "source of truth = events list" rule as train grouping).
 * The UI panel and the CSV export both call these helpers, so the
 * numbers on screen and in the file match by construction.
 *
 * Definitions:
 *   - rate      = spikes inside [tStart, tEnd] / (tEnd − tStart)
 *   - ISI       = differences between consecutive peak times
 *   - CV        = SD(ISI, n−1) / mean(ISI)
 *   - LV        = Shinomoto local variance,
 *                 3/(n−1) · Σ ((I_i − I_{i+1}) / (I_i + I_{i+1}))²
 *                 (same formula as ``_local_variance`` in analysis/ap.py)
 */

export interface FiringSummary {
  nSpikes: number
  durationS: number
  rateHz: number | null
  meanIsiS: number | null
  medianIsiS: number | null
  cvIsi: number | null
  lv: number | null
}

export interface RateBins {
  binS: number
  /** Bin start times (s). */
  t: number[]
  /** Spikes / s in each bin. */
  rate: number[]
}

export interface IsiHistogram {
  /** Bin left edges in ms. */
  edgesMs: number[]
  counts: number[]
  binMs: number
  log: boolean
}

/** Peak times (s) of one sweep's spikes inside [tStart, tEnd], sorted. */
export function peakTimesIn(
  spikes: APPoint[], sweep: number, tStart: number, tEnd: number,
): number[] {
  const ts: number[] = []
  for (const sp of spikes) {
    if (sp.sweep !== sweep) continue
    if (sp.peakT < tStart || sp.peakT > tEnd) continue
    ts.push(sp.peakT)
  }
  ts.sort((a, b) => a - b)
  return ts
}

export function isisOf(times: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < times.length; i++) out.push(times[i] - times[i - 1])
  return out
}

export function firingSummary(times: number[], tStart: number, tEnd: number): FiringSummary {
  const durationS = Math.max(0, tEnd - tStart)
  const isis = isisOf(times)
  const n = isis.length
  let mean: number | null = null
  let median: number | null = null
  let cv: number | null = null
  let lv: number | null = null
  if (n > 0) {
    mean = isis.reduce((a, b) => a + b, 0) / n
    const sorted = [...isis].sort((a, b) => a - b)
    median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  }
  if (n >= 2 && mean) {
    const ss = isis.reduce((a, b) => a + (b - mean!) ** 2, 0)
    cv = Math.sqrt(ss / (n - 1)) / mean
    let acc = 0
    for (let i = 0; i < n - 1; i++) {
      const s = isis[i] + isis[i + 1]
      if (s > 0) acc += ((isis[i] - isis[i + 1]) / s) ** 2
    }
    lv = (3 * acc) / (n - 1)
  }
  return {
    nSpikes: times.length,
    durationS,
    rateHz: durationS > 0 ? times.length / durationS : null,
    meanIsiS: mean,
    medianIsiS: median,
    cvIsi: cv,
    lv,
  }
}

/** Firing rate in consecutive bins of ``binS`` across [tStart, tEnd].
 *  The last bin is normalised by its actual (possibly shorter) width. */
export function rateBins(
  times: number[], tStart: number, tEnd: number, binS: number,
): RateBins {
  const t: number[] = []
  const rate: number[] = []
  if (!(binS > 0) || !(tEnd > tStart)) return { binS, t, rate }
  const nBins = Math.ceil((tEnd - tStart) / binS - 1e-9)
  const counts = new Array(nBins).fill(0)
  for (const x of times) {
    if (x < tStart || x > tEnd) continue
    const i = Math.min(nBins - 1, Math.floor((x - tStart) / binS))
    counts[i]++
  }
  for (let i = 0; i < nBins; i++) {
    const b0 = tStart + i * binS
    const w = Math.min(binS, tEnd - b0)
    t.push(b0)
    rate.push(w > 0 ? counts[i] / w : 0)
  }
  return { binS, t, rate }
}

/** ISI histogram in ms. ``log`` bins on a log10 axis (better for the
 *  long-tailed ISI distributions of irregular / bursty firing). */
export function isiHistogram(isisS: number[], opts: { log: boolean; nBins?: number }): IsiHistogram {
  const nBins = opts.nBins ?? 40
  const ms = isisS.map((x) => x * 1000).filter((x) => x > 0 && isFinite(x))
  if (ms.length === 0) return { edgesMs: [], counts: [], binMs: 0, log: opts.log }
  if (opts.log) {
    const lo = Math.log10(Math.min(...ms))
    const hi = Math.log10(Math.max(...ms))
    const span = Math.max(hi - lo, 1e-6)
    const step = span / nBins
    const counts = new Array(nBins).fill(0)
    for (const x of ms) {
      const i = Math.min(nBins - 1, Math.floor((Math.log10(x) - lo) / step))
      counts[i]++
    }
    const edgesMs = counts.map((_, i) => 10 ** (lo + i * step))
    return { edgesMs, counts, binMs: step, log: true }
  }
  const max = Math.max(...ms)
  const step = max / nBins || 1
  const counts = new Array(nBins).fill(0)
  for (const x of ms) {
    const i = Math.min(nBins - 1, Math.floor(x / step))
    counts[i]++
  }
  const edgesMs = counts.map((_, i) => i * step)
  return { edgesMs, counts, binMs: step, log: false }
}
