/**
 * Which sweeps an analysis runs on — one code path for the analysis
 * windows and Batch, so a batched run measures exactly what the window
 * would on the same file.
 *
 * The windows show sweep numbers 1-based (``sweepFrom`` / ``sweepTo`` /
 * ``sweepOne``); analyses take 0-based indices. Excluded sweeps are
 * dropped for "all" and "range"; a single sweep chosen on purpose
 * ("one") is kept. Values are clamped to the series' sweep count, so a
 * template's range still makes sense on a target with fewer sweeps.
 */

export interface SweepScope {
  runMode?: string | null
  sweepFrom?: number | null
  sweepTo?: number | null
  sweepOne?: number | null
}

export function resolveSweeps(
  scope: SweepScope, total: number, excluded: Iterable<number> = [],
): number[] {
  if (!(total > 0)) return []
  const ex = new Set(excluded)
  const mode = scope.runMode ?? 'all'
  if (mode === 'one') {
    const one = Number(scope.sweepOne ?? 1)
    return [Math.max(0, Math.min(Math.round(one) - 1, total - 1))]
  }
  let lo = 1
  let hi = total
  if (mode === 'range') {
    lo = Math.max(1, Math.min(Math.round(Number(scope.sweepFrom ?? 1)), total))
    hi = Math.max(lo, Math.min(Math.round(Number(scope.sweepTo ?? total)), total))
  }
  const out: number[] = []
  for (let i = lo - 1; i <= hi - 1; i++) if (!ex.has(i)) out.push(i)
  return out
}

export type RunMode = 'all' | 'range' | 'one'

/** The scope fields to save with a result (what the window's Run used). */
export function scopeOf(s: SweepScope): {
  runMode: RunMode; sweepFrom: number; sweepTo: number; sweepOne: number
} {
  return {
    runMode: s.runMode === 'range' || s.runMode === 'one' ? s.runMode : 'all',
    sweepFrom: s.sweepFrom ?? 1,
    sweepTo: s.sweepTo ?? 1,
    sweepOne: s.sweepOne ?? 1,
  }
}
