/**
 * Spectral analysis — shared types, defaults and CSV builders.
 *
 * The numbers are all computed in Python (`backend/analysis/spectral.py`);
 * this file only describes the shapes the store, the Spectral window,
 * Batch and the sidecar pass around.
 *
 * Persisted per series in the sidecar under `analyses.spectral`, keyed
 * `${group}:${series}`. One entry holds the form (channel, params,
 * regions) AND the last results, so the window, Batch and Cohort all read
 * the same blob.
 */

export interface SpectralBand {
  name: string
  low: number
  high: number
}

export type SpectralMethod = 'welch' | 'periodogram'
export type SpectralWindowFn = 'hann' | 'hamming' | 'blackman' | 'boxcar'
export type SpectralDetrend = 'constant' | 'linear' | 'none'
export type SpectralAverage = 'mean' | 'median'

export interface SpectralParams {
  method: SpectralMethod
  segment_s: number
  overlap_pct: number
  window: SpectralWindowFn
  detrend: SpectralDetrend
  average: SpectralAverage
  /** Analysis range — total power, relative power, dominant frequency
   *  and the stored spectrum all refer to it. */
  fmin: number
  fmax: number
  bands: SpectralBand[]
  line_freq: number
  line_bw_hz: number
  line_harmonics: number
  /** Interpolate over mains bins when integrating band powers. */
  exclude_line_noise: boolean
  filter_enabled: boolean
  filter_type: 'lowpass' | 'highpass' | 'bandpass'
  filter_low: number
  filter_high: number
  filter_order: number
  /** Spectrogram display (not persisted as results). */
  spec_window_s: number
  spec_overlap_pct: number
  spec_fmin: number
  spec_fmax: number
  /** Band power over time: bin length and step (s). Step 0 = bin. */
  tc_bin_s: number
  tc_step_s: number
  /** Two-channel coupling (coherence, wPLI, cross-correlation) with a
   *  partner channel, on the same regions and segments. */
  coupling_enabled: boolean
  coupling_channel: number
  coupling_ref_label: string
  coupling_partner_label: string
  coupling_max_lag_ms: number
  coupling_xcorr_low: number
  coupling_xcorr_high: number
  coupling_min_coherence: number
}

/** A named stretch of the series. Sweep indices are 0-based; `null`
 *  means "first" / "last". Times are seconds within each sweep; `null`
 *  means sweep start / end. Every sweep in the range is analysed
 *  separately and the spectra are pooled. */
export interface SpectralRegion {
  id: string
  label: string
  sweepFrom: number | null
  sweepTo: number | null
  tStart: number | null
  tEnd: number | null
}

export interface SpectralBandResult {
  low: number
  high: number
  power: number | null
  relative: number | null
  peakFreqHz: number | null
  note?: string
}

export interface SpectralLineHarmonic {
  freqHz: number
  prominenceDb: number | null
  rms: number
}

export interface CouplingBandResult {
  low: number
  high: number
  coherence: number | null
  imagCoherence: number | null
  wpli: number | null
  /** Debiased squared wPLI (Vinck et al. 2011): 0 on average without
   *  coupling, can be slightly negative. */
  wpliDebiased: number | null
  /** Phase-slope delay, partner − reference (ms); null below the
   *  coherence floor. */
  phaseDelayMs: number | null
}

/** Two-channel coupling of one region. Lags: partner − reference
 *  (positive = reference leads). */
export interface CouplingResult {
  error?: string
  partnerChannel: number
  partnerUnits?: string
  freqs: number[]
  coherence: number[]
  imagCoherence: number[]
  wpli: number[]
  wpliDebiased: number[]
  phase: number[]
  bands: Record<string, CouplingBandResult>
  xcorr: {
    lagsMs: number[]
    r: number[]
    peakR: number
    peakLagMs: number | null
    peakAtLimit: boolean
    zeroLagR: number
    maxLagMs: number
  } | null
  nSegments: number
  freqResHz: number
}

export interface SpectralRegionResult {
  regionId: string
  label: string
  error?: string
  /** The region asked for sweeps / time this recording doesn't have and
   *  was analysed on what exists (e.g. copied by Batch). */
  warnings?: string[]
  freqs: number[]
  psd: number[]
  nSegments: number
  nPieces: number
  skippedPieces: number
  freqResHz: number
  durationS: number
  segmentS: number
  rms: number | null
  totalPower: number | null
  dominantFreqHz: number | null
  bands: Record<string, SpectralBandResult>
  lineNoise: {
    lineFreq: number
    harmonics: SpectralLineHarmonic[]
    rms: number | null
    reliable: boolean
  } | null
  units: string
  samplingRate: number
  sweepsUsed: number[]
  coupling?: CouplingResult
}

export interface SpectralData {
  /** Stored on the blob so the Cohort extractor (which only sees the
   *  blob) knows which series it came from. */
  group: number
  series: number
  channel: number
  params: SpectralParams
  regions: SpectralRegion[]
  results: SpectralRegionResult[] | null
  /** Signature of (channel, params, regions, excluded sweeps) at the
   *  last run. When it differs from the current one the results are
   *  shown as out of date. */
  runSignature: string | null
  ranAt?: string
}

/** Bands tuned for slice field potentials, HFOs included. Mirrors
 *  `DEFAULT_BANDS` in backend/analysis/spectral.py. */
export const DEFAULT_SPECTRAL_BANDS: SpectralBand[] = [
  { name: 'delta', low: 1, high: 4 },
  { name: 'theta', low: 4, high: 12 },
  { name: 'beta', low: 12, high: 30 },
  { name: 'low gamma', low: 30, high: 80 },
  { name: 'high gamma', low: 80, high: 150 },
  { name: 'ripple', low: 150, high: 250 },
  { name: 'fast ripple', low: 250, high: 500 },
]

export function defaultSpectralParams(): SpectralParams {
  return {
    method: 'welch',
    segment_s: 2,
    overlap_pct: 50,
    window: 'hann',
    detrend: 'constant',
    average: 'mean',
    fmin: 1,
    fmax: 500,
    bands: DEFAULT_SPECTRAL_BANDS.map((b) => ({ ...b })),
    line_freq: 50,
    line_bw_hz: 1,
    line_harmonics: 5,
    exclude_line_noise: true,
    filter_enabled: false,
    filter_type: 'highpass',
    filter_low: 0.5,
    filter_high: 1000,
    filter_order: 4,
    spec_window_s: 1,
    spec_overlap_pct: 75,
    spec_fmin: 0,
    spec_fmax: 100,
    tc_bin_s: 10,
    tc_step_s: 0,
    coupling_enabled: false,
    coupling_channel: 1,
    coupling_ref_label: 'CA3',
    coupling_partner_label: 'CA1',
    coupling_max_lag_ms: 200,
    coupling_xcorr_low: 1,
    coupling_xcorr_high: 100,
    coupling_min_coherence: 0.3,
  }
}

export const WHOLE_SERIES_REGION_ID = 'all'

export function wholeSeriesRegion(): SpectralRegion {
  return {
    id: WHOLE_SERIES_REGION_ID, label: 'Whole series',
    sweepFrom: null, sweepTo: null, tStart: null, tEnd: null,
  }
}

export function newRegionId(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}

export function defaultSpectralData(group: number, series: number, channel: number): SpectralData {
  return {
    group, series, channel,
    params: defaultSpectralParams(),
    regions: [wholeSeriesRegion()],
    results: null,
    runSignature: null,
  }
}

/** Fill params missing from older blobs with today's defaults. */
export function withSpectralDefaults(p: Partial<SpectralParams> | undefined): SpectralParams {
  return { ...defaultSpectralParams(), ...(p ?? {}) }
}

/** Params that change the region results (spectrogram and over-time
 *  settings excluded — they don't affect the region numbers). */
function analysisParams(p: SpectralParams) {
  const {
    spec_window_s: _a, spec_overlap_pct: _b, spec_fmin: _c, spec_fmax: _d,
    tc_bin_s: _e, tc_step_s: _f,
    // Names are display-only.
    coupling_ref_label: _g, coupling_partner_label: _h, ...rest
  } = p
  return rest
}

export function spectralSignature(
  entry: Pick<SpectralData, 'channel' | 'params' | 'regions'>,
  excluded: number[] | undefined,
): string {
  return JSON.stringify({
    c: entry.channel,
    p: analysisParams(entry.params),
    r: entry.regions,
    x: [...(excluded ?? [])].sort((a, b) => a - b),
  })
}

/** Backend region shape (snake_case). */
export function regionToBackend(r: SpectralRegion) {
  return {
    id: r.id, label: r.label,
    sweep_from: r.sweepFrom, sweep_to: r.sweepTo,
    t_start: r.tStart, t_end: r.tEnd,
  }
}

/** Backend result (snake_case) → stored camelCase shape. */
export function regionResultFromBackend(r: any): SpectralRegionResult {
  const bands: Record<string, SpectralBandResult> = {}
  for (const [name, b] of Object.entries<any>(r.bands ?? {})) {
    bands[name] = {
      low: Number(b.low), high: Number(b.high),
      power: b.power ?? null,
      relative: b.relative ?? null,
      peakFreqHz: b.peak_freq_hz ?? null,
      ...(b.note ? { note: String(b.note) } : {}),
    }
  }
  const ln = r.line_noise
  return {
    regionId: String(r.region_id ?? ''),
    label: String(r.label ?? ''),
    ...(r.error ? { error: String(r.error) } : {}),
    ...(Array.isArray(r.warnings) && r.warnings.length ? { warnings: r.warnings.map(String) } : {}),
    freqs: r.freqs ?? [],
    psd: r.psd ?? [],
    nSegments: Number(r.n_segments ?? 0),
    nPieces: Number(r.n_pieces ?? 0),
    skippedPieces: Number(r.skipped_pieces ?? 0),
    freqResHz: Number(r.freq_res_hz ?? 0),
    durationS: Number(r.duration_s ?? 0),
    segmentS: Number(r.segment_s ?? 0),
    rms: r.rms ?? null,
    totalPower: r.total_power ?? null,
    dominantFreqHz: r.dominant_freq_hz ?? null,
    bands,
    lineNoise: ln ? {
      lineFreq: Number(ln.line_freq ?? 0),
      harmonics: (ln.harmonics ?? []).map((h: any) => ({
        freqHz: Number(h.freq_hz), prominenceDb: h.prominence_db ?? null, rms: Number(h.rms ?? 0),
      })),
      rms: ln.rms ?? null,
      reliable: !!ln.reliable,
    } : null,
    units: String(r.units ?? ''),
    samplingRate: Number(r.sampling_rate ?? 0),
    sweepsUsed: r.sweeps_used ?? [],
    ...(r.coupling ? { coupling: couplingFromBackend(r.coupling) } : {}),
  }
}

function couplingFromBackend(c: any): CouplingResult {
  const bands: Record<string, CouplingBandResult> = {}
  for (const [name, b] of Object.entries<any>(c.bands ?? {})) {
    bands[name] = {
      low: Number(b.low), high: Number(b.high),
      coherence: b.coherence ?? null, imagCoherence: b.imag_coherence ?? null,
      wpli: b.wpli ?? null, wpliDebiased: b.wpli_debiased ?? null, phaseDelayMs: b.phase_delay_ms ?? null,
    }
  }
  const x = c.xcorr
  return {
    ...(c.error ? { error: String(c.error) } : {}),
    partnerChannel: Number(c.partner_channel ?? 0),
    partnerUnits: c.partner_units,
    freqs: c.freqs ?? [], coherence: c.coherence ?? [], imagCoherence: c.imag_coherence ?? [],
    wpli: c.wpli ?? [], wpliDebiased: c.wpli_debiased ?? [], phase: c.phase ?? [],
    bands,
    xcorr: x ? {
      lagsMs: x.lags_ms ?? [], r: x.r ?? [], peakR: Number(x.peak_r ?? 0),
      peakLagMs: x.peak_lag_ms ?? null, peakAtLimit: !!x.peak_at_limit,
      zeroLagR: Number(x.zero_lag_r ?? 0), maxLagMs: Number(x.max_lag_ms ?? 0),
    } : null,
    nSegments: Number(c.n_segments ?? 0),
    freqResHz: Number(c.freq_res_hz ?? 0),
  }
}

/** Human-readable scope of a region, e.g. "sweeps 1–5 · 10–70 s". */
export function describeRegion(r: SpectralRegion): string {
  const sw = r.sweepFrom == null && r.sweepTo == null
    ? 'all sweeps'
    : r.sweepFrom != null && r.sweepFrom === r.sweepTo
      ? `sweep ${r.sweepFrom + 1}`
      : `sweeps ${r.sweepFrom != null ? r.sweepFrom + 1 : 1}–${r.sweepTo != null ? r.sweepTo + 1 : 'end'}`
  const tm = r.tStart == null && r.tEnd == null
    ? 'full length'
    : `${fmtS(r.tStart ?? 0)}–${r.tEnd != null ? fmtS(r.tEnd) : 'end'}`
  return `${sw} · ${tm}`
}

function fmtS(s: number): string {
  return `${Number(s.toFixed(3))} s`
}

/** Unit string for power (`mV²`) and density (`mV²/Hz`). */
export function powerUnits(units: string): { power: string; density: string } {
  const u = units || 'unit'
  return { power: `${u}²`, density: `${u}²/Hz` }
}

const csvCell = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  const s = String(v)
  return /[",\n]/.test(s) ? JSON.stringify(s) : s
}

/** One row per (series, region): durations, RMS, totals, every band's
 *  absolute + relative power and peak, and line-noise metrics. */
export function buildSpectralBandCSV(
  fileName: string, analyses: Record<string, SpectralData>,
): string | null {
  const keys = Object.keys(analyses).filter((k) => (analyses[k].results ?? []).length > 0)
  if (keys.length === 0) return null
  const bandNames: string[] = []
  for (const k of keys) {
    for (const r of analyses[k].results ?? []) {
      for (const n of Object.keys(r.bands ?? {})) if (!bandNames.includes(n)) bandNames.push(n)
    }
  }
  const anyCoupling = keys.some((k) => (analyses[k].results ?? []).some((r) => r.coupling && !r.coupling.error))
  const header = [
    'file', 'group', 'series', 'channel', 'region', 'scope', 'units',
    'duration_s', 'sweeps_used', 'n_segments', 'freq_res_hz', 'method', 'average',
    'rms', 'total_power', 'analysis_fmin_hz', 'analysis_fmax_hz', 'dominant_freq_hz',
    ...bandNames.flatMap((n) => [`${n}_power`, `${n}_relative`, `${n}_peak_hz`]),
    'line_freq_hz', 'line_noise_rms', 'line_1st_prominence_db', 'line_noise_excluded',
    ...(anyCoupling ? [
      'coupling_partner_channel', 'xcorr_peak_r', 'xcorr_peak_lag_ms', 'xcorr_zero_lag_r',
      ...bandNames.flatMap((n) => [`${n}_coherence`, `${n}_imag_coherence`, `${n}_wpli`, `${n}_wpli_debiased`, `${n}_phase_delay_ms`]),
    ] : []),
    'error',
  ]
  const rows = [header.join(',')]
  for (const k of keys) {
    const e = analyses[k]
    const [g, s] = k.split(':').map(Number)
    for (const r of e.results ?? []) {
      const reg = e.regions.find((x) => x.id === r.regionId)
      rows.push([
        fileName, g + 1, s + 1, e.channel, r.label, reg ? describeRegion(reg) : '', r.units,
        r.durationS, (r.sweepsUsed ?? []).map((i) => i + 1).join(' '), r.nSegments, r.freqResHz,
        e.params.method, e.params.average,
        r.rms, r.totalPower, e.params.fmin, e.params.fmax, r.dominantFreqHz,
        ...bandNames.flatMap((n) => {
          const b = r.bands?.[n]
          return [b?.power, b?.relative, b?.peakFreqHz]
        }),
        r.lineNoise?.lineFreq, r.lineNoise?.rms, r.lineNoise?.harmonics?.[0]?.prominenceDb,
        e.params.exclude_line_noise ? 'yes' : 'no',
        ...(anyCoupling ? (() => {
          const c = r.coupling && !r.coupling.error ? r.coupling : null
          return [
            c?.partnerChannel, c?.xcorr?.peakR, c?.xcorr?.peakLagMs, c?.xcorr?.zeroLagR,
            ...bandNames.flatMap((n) => {
              const b = c?.bands?.[n]
              return [b?.coherence, b?.imagCoherence, b?.wpli, b?.wpliDebiased, b?.phaseDelayMs]
            }),
          ]
        })() : []),
        r.error ?? r.coupling?.error ?? '',
      ].map(csvCell).join(','))
    }
  }
  return rows.join('\n')
}

/** The stored spectra of one series: a frequency column plus one PSD
 *  column per region. Regions share a grid when their resolution is
 *  equal; otherwise each region gets its own frequency column. */
export function buildSpectralPsdCSV(entry: SpectralData): string | null {
  const res = (entry.results ?? []).filter((r) => !r.error && r.freqs.length > 0)
  if (res.length === 0) return null
  const units = powerUnits(res[0].units).density
  const sameGrid = res.every((r) =>
    r.freqs.length === res[0].freqs.length && r.freqs[0] === res[0].freqs[0]
    && r.freqs[r.freqs.length - 1] === res[0].freqs[res[0].freqs.length - 1])
  const rows: string[] = []
  if (sameGrid) {
    rows.push(['frequency_hz', ...res.map((r) => `${r.label} (${units})`)].map(csvCell).join(','))
    for (let i = 0; i < res[0].freqs.length; i++) {
      rows.push([res[0].freqs[i], ...res.map((r) => r.psd[i])].map(csvCell).join(','))
    }
  } else {
    rows.push(res.flatMap((r) => [`${r.label} frequency_hz`, `${r.label} (${units})`]).map(csvCell).join(','))
    const n = Math.max(...res.map((r) => r.freqs.length))
    for (let i = 0; i < n; i++) {
      rows.push(res.flatMap((r) => [r.freqs[i], r.psd[i]]).map(csvCell).join(','))
    }
  }
  return rows.join('\n')
}

/** Browser-style download (works inside Electron's renderer). */
export function downloadText(text: string, fileName: string, mime = 'text/csv') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/** Band power over time, as returned by /api/spectral/timecourse. */
export interface SpectralTimecourse {
  times: number[]
  sweeps: number[]
  sweepOffsets: Record<string, number>
  sweepDurations: Record<string, number>
  totalPower: (number | null)[]
  dominantFreqHz: (number | null)[]
  rms: (number | null)[]
  bands: Record<string, { power: (number | null)[]; relative: (number | null)[] }>
  bandOrder: string[]
  binS: number
  stepS: number
  units: string
}

export function timecourseFromBackend(d: any): SpectralTimecourse {
  const bands: SpectralTimecourse['bands'] = {}
  for (const [n, b] of Object.entries<any>(d.bands ?? {})) {
    bands[n] = { power: b.power ?? [], relative: b.relative ?? [] }
  }
  return {
    times: d.times ?? [], sweeps: d.sweeps ?? [],
    sweepOffsets: d.sweep_offsets ?? {}, sweepDurations: d.sweep_durations ?? {},
    totalPower: d.total_power ?? [], dominantFreqHz: d.dominant_freq_hz ?? [], rms: d.rms ?? [],
    bands, bandOrder: d.band_order ?? Object.keys(bands),
    binS: Number(d.bin_s ?? 0), stepS: Number(d.step_s ?? 0), units: String(d.units ?? ''),
  }
}

/** One row per time bin: sweep, time within sweep, every band's power
 *  and relative power, total power, RMS and dominant frequency. */
export function buildTimecourseCSV(tc: SpectralTimecourse): string {
  const pu = powerUnits(tc.units)
  const header = [
    'sweep', 'time_in_sweep_s', 'time_s',
    ...tc.bandOrder.flatMap((n) => [`${n}_power_${pu.power}`, `${n}_relative`]),
    `total_power_${pu.power}`, `rms_${tc.units || 'units'}`, 'dominant_freq_hz',
  ]
  const rows = [header.map(csvCell).join(',')]
  for (let i = 0; i < tc.times.length; i++) {
    const sw = tc.sweeps[i]
    rows.push([
      sw + 1, tc.times[i], tc.times[i] + (tc.sweepOffsets[String(sw)] ?? 0),
      ...tc.bandOrder.flatMap((n) => [tc.bands[n].power[i], tc.bands[n].relative[i]]),
      tc.totalPower[i], tc.rms[i], tc.dominantFreqHz[i],
    ].map(csvCell).join(','))
  }
  return rows.join('\n')
}
