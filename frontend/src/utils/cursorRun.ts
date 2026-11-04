/**
 * The Cursor analysis request — one builder for the Cursor window and
 * Batch, so a batched run measures exactly what the window's Run would.
 * Each result keeps ``runSettings``: the settings that produced its
 * numbers (the window's form can be edited after a Run), which Batch
 * repeats.
 */
import type { CursorAnalysisData } from '../stores/appStore'

export type CursorRunSettings = Pick<CursorAnalysisData,
  'trace' | 'slotCount' | 'slots' | 'baseline' | 'baselineMethod' | 'average'
  | 'runMode' | 'sweepFrom' | 'sweepTo' | 'sweepOne'>

export function cursorRunSettings(d: CursorAnalysisData): CursorRunSettings {
  return JSON.parse(JSON.stringify({
    trace: d.trace, slotCount: d.slotCount, slots: d.slots, baseline: d.baseline,
    baselineMethod: d.baselineMethod, average: d.average, runMode: d.runMode,
    sweepFrom: d.sweepFrom, sweepTo: d.sweepTo, sweepOne: d.sweepOne,
  }))
}

export function cursorRunBody(
  group: number, series: number, d: CursorRunSettings, sweeps: number[] | null,
) {
  const visibleSlots = (d.slots ?? []).slice(0, d.slotCount)
  return {
    group, series, trace: d.trace,
    sweeps,
    average: !!d.average,
    baseline: d.baseline,
    baseline_method: d.baselineMethod ?? 'mean',
    slots: visibleSlots.map((s) => ({
      enabled: !!s.enabled,
      peak: s.peak ?? null,
      fit: s.fit ?? null,
      fit_function: s.fit && s.fitFunction ? s.fitFunction : null,
      fit_options: s.fitOptions ? {
        maxfev: s.fitOptions.maxfev,
        ftol: s.fitOptions.ftol,
        xtol: s.fitOptions.xtol,
        initial_guess: s.fitOptions.initialGuess ?? null,
      } : null,
    })),
    // AP-threshold detection lives in the AP window; always off here.
    compute_ap: false,
  }
}
