/**
 * Dual-site propagation (e.g. CA3 → CA1) — shared types, defaults,
 * staleness signature and CSV export. The numbers come from
 * `backend/analysis/propagation.py`.
 *
 * Storage:
 * - `burstDualForm[g:s]` (sidecar `burst_dual_form`): the second-channel
 *   form — on/off, channel, labels, its own detection params, and the
 *   pairing / lag settings. Persisted even before anything is run.
 * - `fieldBursts[g:s].partner`: the partner channel's detected bursts.
 * - `fieldBursts[g:s].propagation`: the last result plus the settings it
 *   was computed with. Batch and Cohort read these from the burst blob.
 *
 * Lags are partner − reference: positive = the reference channel leads.
 */

import type { BurstRecord, FieldBurstsData, FieldBurstsParams } from '../stores/appStore'

export type LagMethod = 'xcorr' | 'onset' | 'peak'
export type PolarityMode = 'auto' | 'same' | 'opposite'

export interface PropagationParams {
  max_lag_ms: number
  xcorr_pre_ms: number
  xcorr_max_ms: number
  polarity: PolarityMode
  primary: LagMethod
  avg_pre_ms: number
  avg_post_ms: number
}

export interface BurstDualForm {
  enabled: boolean
  channel: number
  refLabel: string
  partnerLabel: string
  /** Detection params for the partner channel (own polarity, threshold…). */
  params: FieldBurstsParams | null
  propagation: PropagationParams
}

export interface BurstPartnerData {
  channel: number
  params: FieldBurstsParams
  baselineValue: number
  thresholdHigh: number | null
  thresholdLow: number | null
  bursts: BurstRecord[]
}

export interface PropagationPair {
  refIdx: number
  partnerIdx: number
  sweep: number
  refStartS: number
  partnerStartS: number
  refPeakS: number
  partnerPeakS: number
  /** Null when either discharge has no clean 20 %-of-peak crossing. */
  onsetLagMs: number | null
  peakLagMs: number
  xcorrLagMs: number | null
  xcorrR: number | null
  xcorrAtLimit: boolean
  ampRatio: number | null
  polarity: 'same' | 'opposite'
}

export interface LagStats {
  n: number
  median: number | null
  mean: number | null
  q25: number | null
  q75: number | null
  sd: number | null
}

export interface PropagationSummary {
  nRef: number
  nPartner: number
  nPairs: number
  propagationFraction: number | null
  partnerOnlyFraction: number | null
  partnerOnlyPerMin: number | null
  refLeadsFraction: number | null
  primary: LagMethod
  lagMs: Record<LagMethod, LagStats>
  ampRatio: LagStats
  xcorrR: LagStats
  nXcorrAtLimit: number
  durationS: number
}

export interface PropagationAverage {
  tMs: number[]
  refMean: number[]
  refSem: number[]
  partnerMean: number[]
  partnerSem: number[]
  n: number
  partnerFlipped: boolean
}

export interface PropagationResult {
  pairs: PropagationPair[]
  refOnly: number[]
  partnerOnly: number[]
  summary: PropagationSummary
  average: PropagationAverage | null
  unitsRef: string
  unitsPartner: string
  /** Signature of the inputs; a different current signature = stale. */
  signature: string
  computedAt: string
}

export interface PropagationBlock {
  params: PropagationParams
  refLabel: string
  partnerLabel: string
  result: PropagationResult | null
}

export function defaultPropagationParams(): PropagationParams {
  return {
    max_lag_ms: 100,
    xcorr_pre_ms: 20,
    xcorr_max_ms: 500,
    polarity: 'auto',
    primary: 'xcorr',
    avg_pre_ms: 100,
    avg_post_ms: 400,
  }
}

export function defaultDualForm(channel = 1): BurstDualForm {
  return {
    enabled: false,
    channel,
    refLabel: 'CA3',
    partnerLabel: 'CA1',
    params: null,
    propagation: defaultPropagationParams(),
  }
}

export function withDualDefaults(f: Partial<BurstDualForm> | undefined, channel = 1): BurstDualForm {
  const d = defaultDualForm(channel)
  return {
    ...d, ...(f ?? {}),
    propagation: { ...d.propagation, ...(f?.propagation ?? {}) },
  }
}

/** Bump when the result's shape or method changes: results saved by an
 *  older version then no longer match and are recomputed automatically.
 *  v2: pairing by peak time, onset at 20 % of peak, peak times in pairs.
 *  v3: aligned average re-aligned on the reference's 20 % onset. */
export const PROPAGATION_RESULT_VERSION = 3

/** FNV-1a 32-bit — enough to notice that inputs changed. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

const slim = (b: BurstRecord) => [b.sweepIndex, b.startS, b.endS, b.peakTimeS, b.peakSigned, b.peakAmplitude]
const filterOf = (p: FieldBurstsParams | null | undefined) => p
  ? [p.filter_enabled, p.filter_type, p.filter_low, p.filter_high, p.filter_order] : null

/** Everything the propagation numbers depend on. */
export function propagationSignature(
  entry: FieldBurstsData | undefined, form: BurstDualForm, excluded: number[] | undefined,
): string | null {
  if (!entry || !entry.partner) return null
  return hash(JSON.stringify({
    v: PROPAGATION_RESULT_VERSION,
    rc: entry.channel, pc: entry.partner.channel,
    r: entry.bursts.map(slim), p: entry.partner.bursts.map(slim),
    rf: filterOf(entry.params), pf: filterOf(entry.partner.params),
    pp: form.propagation,
    x: [...(excluded ?? [])].sort((a, b) => a - b),
  }))
}

const stats = (s: any): LagStats => ({
  n: Number(s?.n ?? 0), median: s?.median ?? null, mean: s?.mean ?? null,
  q25: s?.q25 ?? null, q75: s?.q75 ?? null, sd: s?.sd ?? null,
})

export function propagationFromBackend(d: any, signature: string): PropagationResult {
  const s = d.summary ?? {}
  const a = d.average
  return {
    pairs: (d.pairs ?? []).map((p: any) => ({
      refIdx: p.ref_idx, partnerIdx: p.partner_idx, sweep: p.sweep,
      refStartS: p.ref_start_s, partnerStartS: p.partner_start_s,
      refPeakS: p.ref_peak_s ?? p.ref_start_s, partnerPeakS: p.partner_peak_s ?? p.partner_start_s,
      onsetLagMs: p.onset_lag_ms ?? null, peakLagMs: p.peak_lag_ms,
      xcorrLagMs: p.xcorr_lag_ms ?? null, xcorrR: p.xcorr_r ?? null,
      xcorrAtLimit: !!p.xcorr_at_limit, ampRatio: p.amp_ratio ?? null,
      polarity: p.polarity === 'opposite' ? 'opposite' : 'same',
    })),
    refOnly: d.ref_only ?? [],
    partnerOnly: d.partner_only ?? [],
    summary: {
      nRef: s.n_ref ?? 0, nPartner: s.n_partner ?? 0, nPairs: s.n_pairs ?? 0,
      propagationFraction: s.propagation_fraction ?? null,
      partnerOnlyFraction: s.partner_only_fraction ?? null,
      partnerOnlyPerMin: s.partner_only_per_min ?? null,
      refLeadsFraction: s.ref_leads_fraction ?? null,
      primary: (s.primary ?? 'xcorr') as LagMethod,
      lagMs: {
        xcorr: stats(s.lag_ms?.xcorr), onset: stats(s.lag_ms?.onset), peak: stats(s.lag_ms?.peak),
      },
      ampRatio: stats(s.amp_ratio), xcorrR: stats(s.xcorr_r),
      nXcorrAtLimit: s.n_xcorr_at_limit ?? 0,
      durationS: s.duration_s ?? 0,
    },
    average: a ? {
      tMs: a.t_ms, refMean: a.ref_mean, refSem: a.ref_sem,
      partnerMean: a.partner_mean, partnerSem: a.partner_sem,
      n: a.n, partnerFlipped: !!a.partner_flipped,
    } : null,
    unitsRef: d.units_ref ?? '', unitsPartner: d.units_partner ?? '',
    signature,
    computedAt: new Date().toISOString(),
  }
}

/** Backend burst shape for the propagation request. */
export function burstsForBackend(list: BurstRecord[]) {
  return list.map((b) => ({
    sweepIndex: b.sweepIndex, startS: b.startS, endS: b.endS,
    peakTimeS: b.peakTimeS, peakSigned: b.peakSigned, peakAmplitude: b.peakAmplitude,
  }))
}

const cell = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  const s = String(v)
  return /[",\n]/.test(s) ? JSON.stringify(s) : s
}

/** One row per paired discharge, then the unpaired ones of each channel. */
export function buildPropagationCSV(
  fileName: string, group: number, series: number,
  entry: FieldBurstsData, block: PropagationBlock,
): string | null {
  const res = block.result
  if (!res || !entry.partner) return null
  const R = block.refLabel || 'reference'
  const Pn = block.partnerLabel || 'partner'
  const header = [
    'file', 'group', 'series', 'sweep', 'status',
    `${R}_burst_idx`, `${Pn}_burst_idx`, `${R}_peak_s`, `${Pn}_peak_s`,
    'onset_lag_ms', 'peak_lag_ms', 'xcorr_lag_ms', 'xcorr_r', 'xcorr_at_limit',
    `${R}_peak_amplitude`, `${Pn}_peak_amplitude`, 'amplitude_ratio', 'polarity',
  ]
  const rows = [header.map(cell).join(',')]
  const base = [fileName, group + 1, series + 1]
  for (const p of res.pairs) {
    const rb = entry.bursts[p.refIdx]
    const pb = entry.partner.bursts[p.partnerIdx]
    rows.push([...base, p.sweep + 1, 'paired', p.refIdx, p.partnerIdx, p.refPeakS, p.partnerPeakS,
      p.onsetLagMs, p.peakLagMs, p.xcorrLagMs, p.xcorrR, p.xcorrAtLimit ? 'yes' : 'no',
      rb?.peakAmplitude, pb?.peakAmplitude, p.ampRatio, p.polarity].map(cell).join(','))
  }
  for (const i of res.refOnly) {
    const b = entry.bursts[i]
    if (!b) continue
    rows.push([...base, b.sweepIndex + 1, `${R} only`, i, '', b.peakTimeS, '',
      '', '', '', '', '', b.peakAmplitude, '', '', ''].map(cell).join(','))
  }
  for (const j of res.partnerOnly) {
    const b = entry.partner.bursts[j]
    if (!b) continue
    rows.push([...base, b.sweepIndex + 1, `${Pn} only`, '', j, '', b.peakTimeS,
      '', '', '', '', '', '', b.peakAmplitude, '', ''].map(cell).join(','))
  }
  return rows.join('\n')
}
