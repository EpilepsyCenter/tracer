import { create } from 'zustand'
import type { TrainParams } from '../utils/trains'
import { computeBurstTrainIds } from '../utils/burstTrains'

/** Modules that can group their detected events into trains. Bursts =
 *  the FieldBurstWindow's epileptiform burst detection; events = the
 *  Event Detection window; ap = the Action Potentials window. The
 *  algorithm is shared (frontend/src/utils/trains.ts ↔ backend/
 *  analysis/trains.py); only the timestamp source differs. */
export type TrainModule = 'bursts' | 'events' | 'ap'

/** All train-detection form state for one recording, keyed first by
 *  module then by `${group}:${series}`. Persisted in the .tracer
 *  sidecar; results are NOT stored — they are recomputed on demand
 *  from the existing event/burst/spike timestamps. */
export type TrainParamsBundle = Record<TrainModule, Record<string, TrainParams>>

export function defaultTrainParamsBundle(): TrainParamsBundle {
  return { bursts: {}, events: {}, ap: {} }
}

export interface TraceData {
  time: Float64Array
  values: Float64Array
  samplingRate: number
  units: string
  label: string
}

export interface SweepInfo {
  index: number
  label: string
  traceCount: number
}

export interface StimulusSegment {
  start: number  // seconds
  end: number    // seconds
  level: number  // mV or pA
}

export interface StimulusInfo {
  unit: 'mV' | 'pA'       // command unit (VC → mV, CC → pA)
  vHold: number           // holding level (same unit)
  vStep: number           // pulse delta from holding (signed)
  vStepAbsolute: number   // absolute pulse level
  pulseStart: number      // seconds
  pulseEnd: number        // seconds
  baselineStart: number   // seconds (suggested cursor)
  baselineEnd: number     // seconds (suggested cursor)
  segments: StimulusSegment[]  // first-sweep reconstruction for overlay
}

/** Metadata about one recorded channel within a series (probed from first sweep). */
export interface ChannelInfo {
  index: number
  label: string
  units: string
  kind: 'voltage' | 'current' | 'other'
}

/** Sentinel trace index representing the reconstructed stimulus in a
 *  ``visibleTraces`` list. Recorded channel indices are >= 0. */
export const STIMULUS_TRACE_INDEX = -1

export interface SeriesInfo {
  index: number
  label: string
  sweepCount: number
  sweeps: SweepInfo[]
  channels?: ChannelInfo[]
  rs?: number
  cm?: number
  holding?: number
  protocol?: string
  stimulus?: StimulusInfo | null
}

export interface GroupInfo {
  index: number
  label: string
  seriesCount: number
  series: SeriesInfo[]
}

export interface RecordingInfo {
  filePath: string
  fileName: string
  format: string
  groupCount: number
  groups: GroupInfo[]
}

export interface CursorPositions {
  baselineStart: number
  baselineEnd: number
  peakStart: number
  peakEnd: number
  fitStart: number
  fitEnd: number
}

export interface CursorVisibility {
  baseline: boolean
  peak: boolean
  fit: boolean
}

export interface FilterState {
  enabled: boolean
  type: 'lowpass' | 'highpass' | 'bandpass'
  lowCutoff: number   // Hz
  highCutoff: number  // Hz
  order: number
}

/** Viewport into a trace, for continuous-data scrolling. */
export interface Viewport {
  start: number  // seconds, inclusive
  end: number    // seconds, exclusive
}

/** Default viewport length when opening a new sweep (seconds) —
 *  applies only to **continuous-mode** recordings (single very long
 *  sweep, typically spontaneous-event or field-potential traces of
 *  many minutes). Episodic recordings (multi-sweep protocol-driven,
 *  every test pulse / evoked response / fEPSP / AP train) always
 *  open at full view regardless of per-sweep duration. The 1 s
 *  window only kicks in to keep initial paint fast on multi-minute
 *  single-sweep traces. */
export const DEFAULT_VIEWPORT_SECONDS = 1

/** Threshold (seconds) above which a SINGLE-sweep series is treated
 *  as a continuous recording. Used only when ``sweepCount === 1`` —
 *  for multi-sweep series, every sweep opens at full view
 *  regardless of length, because by definition the protocol
 *  generated discrete episodes meant to be viewed individually.
 *
 *  60 s catches the realistic edge: a single 60+ s sweep is almost
 *  always a continuous spontaneous-events / field recording; a
 *  single short sweep is a one-shot evoked response which the user
 *  wants in full. */
export const CONTINUOUS_SWEEP_THRESHOLD_S = 60

/** Monotonic counter used by refetchViewport to discard stale responses
 *  (e.g. when the user drags the scroll slider, we fire many requests and
 *  only the latest one should be committed to state). */
let _viewportFetchSeq = 0

/** Stable empty visible-traces reference. Returned by `getVisibleTraces` when
 *  a series' defaults haven't been materialized yet. Keeping this stable means
 *  selectors return the same reference across renders and don't cause
 *  spurious re-renders / plot rebuilds. */
const EMPTY_VISIBLE_TRACES: number[] = []

/** Broadcast I-V state to other windows — analogous to _broadcastBursts. */
function _broadcastIVCurves(ivCurves: Record<string, IVCurveData>) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'iv-update', ivCurves })
    ch.close()
  } catch { /* ignore */ }
}

function _broadcastFPsp(fpspCurves: Record<string, FPspData>) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'fpsp-update', fpspCurves })
    ch.close()
  } catch { /* ignore */ }
}

function _broadcastCursorAnalyses(cursorAnalyses: Record<string, CursorAnalysisData>) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'cursor-analyses-update', cursorAnalyses })
    ch.close()
  } catch { /* ignore */ }
}

function _broadcastAP(apAnalyses: Record<string, APData>) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'ap-update', apAnalyses })
    ch.close()
  } catch { /* ignore */ }
}

/** Strip every legacy per-file analysis blob from Electron prefs.
 *  Run once at app start; idempotent. The keys listed below were the
 *  pre-sidecar persistence layer — every analysis got its own
 *  ``saved<Type>: { [filePath]: data }`` entry, which could grow to
 *  hundreds of MB (averaged sweeps embed full time + value arrays).
 *  Even after the writers were removed, the bloat persisted on disk
 *  and made every ``getPreferences`` / ``setPreferences`` call slow.
 *  Drop them so future prefs touches are fast. */
async function _cleanupLegacyPrefs() {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const legacyKeys = [
      'savedFieldBursts',
      'savedBurstFormParams',
      'savedIVCurves',
      'savedFPspCurves',
      'savedCursorAnalyses',
      'savedAPAnalyses',
      'savedEventsAnalyses',
      'savedExcludedSweeps',
      'savedAveragedSweeps',
    ]
    let touched = false
    const next: Record<string, unknown> = { ...prefs }
    for (const k of legacyKeys) {
      if (k in next) { delete next[k]; touched = true }
    }
    if (touched) await api.setPreferences(next)
  } catch { /* ignore — best-effort */ }
}

/** Forward-compatible deserialization of saved ``EventsData``. Old
 *  sidecars predate fields added to ``EventsParams`` over successive
 *  releases — spreading the current defaults underneath ensures every
 *  blob has a full shape regardless of when it was serialized.
 *  Idempotent. Without this NumInputs bound to new fields show
 *  ``undefined``. */
function _migrateEventsAnalyses(
  raw: Record<string, any> | null | undefined,
): Record<string, EventsData> | null {
  if (!raw) return null
  const defaults = defaultEventsParams()
  const out: Record<string, EventsData> = {}
  for (const [key, ent] of Object.entries(raw)) {
    if (!ent || typeof ent !== 'object') continue
    const merged: EventsData = {
      ...(ent as EventsData),
      params: { ...defaults, ...((ent as any).params ?? {}) },
    }
    out[key] = merged
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-recording sidecar (.tracer JSON next to the recording file)
// ---------------------------------------------------------------------------
//
// All analysis params + results get round-tripped through this one file so
// closing and re-opening a recording restores the full workspace state.
// The Electron main process owns the file I/O (read-sidecar / write-sidecar
// IPC channels with atomic writes); this module just produces / consumes
// the JSON payload.
//
// Shape of the payload is flat, slice-keyed, and intentionally stable —
// future schema changes bump ``version`` and add a migration block here.

const SIDECAR_VERSION = 4
const SIDECAR_DEBOUNCE_MS = 1000

/** Slice values to apply when the active recording is closed —
 *  shared between the store's ``closeFile`` action and the cross-
 *  window ``file-close`` handler in CursorPanel so the two stay in
 *  lockstep. Adding a new per-recording slice? Add it here so both
 *  sites pick it up automatically. Returns a fresh object so each
 *  caller gets its own (avoids accidental shared-mutation if Zustand
 *  ever started reusing the reference). */
export function fileCloseResetSlices(): Record<string, unknown> {
  return {
    recording: null,
    currentGroup: 0, currentSeries: 0, currentSweep: 0, currentTrace: 0,
    traceData: null,
    overlayEntries: [],
    averageTrace: null,
    additionalTraces: {},
    visibleTraces: {},
    fieldBursts: {}, burstFormParams: {},
    trainParams: defaultTrainParamsBundle(),
    ivCurves: {}, fpspCurves: {}, cursorAnalyses: {},
    apAnalyses: {}, eventsAnalyses: {},
    pairedAnalyses: {}, pairedForm: defaultPairedForm(),
    excludedSweeps: {}, selectedSweeps: {}, averagedSweeps: {},
    currentAveragedSweep: null,
    resistanceResult: null, resistanceResults: {},
    recordingMeta: null, recordingMetaReady: false,
    showOverlay: false, showAverage: false,
    scaleOverrides: {},
    filtersByChannel: {},
  }
}

/** Recording-level metadata used by the Metadata module + Cohort
 *  Analysis. Tags are arrays so a cell can carry multiple orthogonal
 *  attributes (genotype + sex + age + treatment) at once. Series
 *  tags are keyed by ``${group}:${series}`` (HEKA group + series). */
export interface SidecarMeta {
  cell_id?: string
  /** Optional animal-of-origin identifier. First-class field rather
   *  than a tag because animal grouping is a fundamental piece of
   *  experimental provenance — multiple cells routinely come from
   *  the same animal, and the cohort module needs an unambiguous
   *  way to collapse them when the user picks "N = animal". The
   *  string is opaque (any naming convention works); whatever the
   *  user types is the grouping key. */
  animal_id?: string
  notes?: string
  group_tags?: string[]
  series_tags?: Record<string, string[]>
  /** When true the "this file has no tags" toast is suppressed for
   *  this specific recording. Per-file rather than global so users
   *  don't accidentally turn the prompt off forever. */
  suppressTagToast?: boolean
}

/** A single user-applied scaling override for one channel of one
 *  series. The backend multiplies raw samples by ``y_scale`` and adds
 *  ``y_offset`` before any analysis or rendering reads them; ``units``
 *  is what every analysis module reports back. ``note`` is free-text
 *  user-facing breadcrumb (e.g. "imported as V, should be mV"). */
export interface ScaleOverride {
  units: string
  y_scale: number
  y_offset: number
  note?: string
}

/** Map of overrides keyed by ``${channelIndex}|${fileUnits}``. The
 *  composite key matters for mixed-protocol recordings (e.g. HEKA
 *  files with both CC and VC series) where the same channel index
 *  carries different physical signals depending on the series — the
 *  ``fileUnits`` half disambiguates them so an override only touches
 *  the matching subset of sweeps. The backend applies the override
 *  to every sweep where ``(channel_index, original_units)`` matches.
 *  See ``GET /api/files/channels`` for the authoritative key list. */
export type ScaleOverrides = Record<string, ScaleOverride>

/** Parse a ``${channel}|${fileUnits}`` override key. */
export function parseOverrideKey(key: string): { channel: number; fileUnits: string } | null {
  const i = key.indexOf('|')
  if (i < 0) return null
  const ch = Number(key.slice(0, i))
  if (!Number.isFinite(ch)) return null
  return { channel: ch, fileUnits: key.slice(i + 1) }
}

/** Status derived from ``SidecarMeta`` for the file-status pill:
 *
 *  - ``red``    — no file-level tags. Cell can't be grouped.
 *  - ``yellow`` — file-level tags present but no series tagged yet.
 *  - ``green``  — file-level tags present AND ≥ 1 series carries a tag.
 *
 *  See ``TRACER_modules_spec.md`` for the rationale (we
 *  deliberately don't require every series to be tagged). */
export type MetaStatus = 'red' | 'yellow' | 'green'

export function getMetaStatus(meta: SidecarMeta | null | undefined): MetaStatus {
  if (!meta || !meta.group_tags || meta.group_tags.length === 0) return 'red'
  const seriesTags = meta.series_tags ?? {}
  const anySeriesTagged = Object.values(seriesTags).some((tags) =>
    Array.isArray(tags) && tags.length > 0)
  return anySeriesTagged ? 'green' : 'yellow'
}

type SidecarPayload = {
  format: 'tracer-sidecar'
  version: number
  saved_at?: string
  app_version?: string
  recording_name?: string
  /** Per-recording metadata — see ``SidecarMeta``. Optional for
   *  backward-compat with v1 sidecars; absent / empty meta means
   *  the file shows as red status until the user tags it. */
  meta?: SidecarMeta
  analyses?: {
    events?: Record<string, EventsData>
    paired?: Record<string, PairedData>
    bursts?: Record<string, FieldBurstsData>
    ap?: Record<string, APData>
    iv_curves?: Record<string, IVCurveData>
    fpsp_curves?: Record<string, FPspData>
    cursor_analyses?: Record<string, CursorAnalysisData>
    /** Per-series resistance results (Rs, Rin, Cm, τ). Keyed by
     *  ``${group}:${series}``. Each entry is an array — one row per
     *  sweep (cross-sweep mode) or one row total (single / averaged
     *  modes). Cohort extractor takes the mean across the array
     *  for its per-cell scalar. */
    resistance?: Record<string, ResistanceResult[]>
  }
  /** Form / preference state per analysis that doesn't live inside
   *  a per-(group,series) results blob. Flat so future analyses can
   *  plug in without reshaping the schema. */
  forms?: {
    resistance?: ResistanceFormState
    paired?: PairedFormState
  }
  burst_form_params?: Record<string, FieldBurstsParams>
  /** Per-module train-grouping form state. Results are not stored —
   *  computed on demand from each module's existing event timestamps
   *  via the shared algorithm in `utils/trains.ts`. */
  train_params?: TrainParamsBundle
  excluded_sweeps?: Record<string, number[]>
  averaged_sweeps?: Record<string, AveragedSweep[]>
  cursors?: CursorPositions
  /** Per-channel numeric scaling overrides applied at file-open and
   *  on every edit. Empty / absent → recording uses file-reported
   *  units and ``y_scale=1, y_offset=0`` (the dormant case). */
  scale_overrides?: ScaleOverrides
  /** Per-series filter snapshot keyed ``${group}:${series}``. Each
   *  entry bundles the default ``filter`` plus any per-channel
   *  overrides so switching series restores the full context. When
   *  absent, ``selectSweep`` falls back to the legacy events-derived
   *  filter mirror (so old recordings still match what detection
   *  saw). Older sidecars that stored a flat ``FilterState`` value
   *  are migrated on load. */
  filters_by_series?: Record<string, { filter: FilterState; filtersByChannel?: Record<number, FilterState> } | FilterState>
}

async function _loadSidecar(filePath: string): Promise<SidecarPayload | null> {
  const api = window.electronAPI
  if (!api?.readSidecar || !filePath) return null
  try {
    const parsed = await api.readSidecar(filePath)
    if (parsed && (parsed as any).format === 'tracer-sidecar') {
      return parsed as unknown as SidecarPayload
    }
    return null
  } catch { return null }
}

function _sidecarPayloadFromState(state: AppState): SidecarPayload {
  return {
    format: 'tracer-sidecar',
    version: SIDECAR_VERSION,
    app_version: '0.5.0',
    recording_name: state.recording?.filePath?.split(/[/\\]/).pop(),
    meta: state.recordingMeta ?? undefined,
    analyses: {
      events: state.eventsAnalyses,
      paired: state.pairedAnalyses,
      bursts: state.fieldBursts,
      ap: state.apAnalyses,
      iv_curves: state.ivCurves,
      fpsp_curves: state.fpspCurves,
      cursor_analyses: state.cursorAnalyses,
      resistance: state.resistanceResults,
    },
    forms: {
      resistance: state.resistanceForm,
      paired: state.pairedForm,
    },
    burst_form_params: state.burstFormParams,
    train_params: state.trainParams,
    excluded_sweeps: state.excludedSweeps,
    averaged_sweeps: state.averagedSweeps,
    cursors: state.cursors,
    scale_overrides: Object.keys(state.scaleOverrides).length > 0
      ? state.scaleOverrides : undefined,
    filters_by_series: Object.keys(state.filtersBySeries).length > 0
      ? state.filtersBySeries : undefined,
  }
}

async function _saveSidecar(filePath: string, state: AppState): Promise<void> {
  const api = window.electronAPI
  if (!api?.writeSidecar || !filePath) return
  try {
    const payload = _sidecarPayloadFromState(state)
    // Meta block is owned by the metadata window — it writes
    // synchronously via writeSidecar at the moment of each user
    // edit. Main's debounced auto-save fires for unrelated state
    // changes (cursor moves, analyses, …) and would otherwise
    // overwrite a freshly-typed tag with main's stale
    // ``state.recordingMeta`` (the cross-window broadcast that
    // refreshes main's view may not have arrived yet).
    //
    // Prevent that by always preserving whatever's currently on
    // disk. Read existing → if it has a meta block, use it
    // verbatim. Falls back to state.recordingMeta only when the
    // disk has no sidecar yet (first write).
    if (api.readSidecar) {
      try {
        const existing = await api.readSidecar(filePath)
        if (existing && (existing as any).meta) {
          payload.meta = (existing as any).meta as SidecarMeta
        }
      } catch { /* ignore — fall back to state's meta */ }
    }
    await api.writeSidecar(filePath, payload as unknown as Record<string, unknown>)
  } catch { /* ignore */ }
}

function _broadcastScaleOverrides(scaleOverrides: ScaleOverrides) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'scale-overrides-update', scaleOverrides })
    ch.close()
  } catch { /* ignore */ }
}

function _broadcastEvents(eventsAnalyses: Record<string, EventsData>) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'events-update', eventsAnalyses })
    ch.close()
  } catch { /* ignore */ }
}

function _broadcastPaired(
  pairedAnalyses: Record<string, PairedData>,
  pairedForm: PairedFormState,
) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'paired-update', pairedAnalyses, pairedForm })
    ch.close()
  } catch { /* ignore */ }
}

async function _saveEventsTemplates(
  entries: Record<string, EventsTemplate>,
  selectedId: string | null,
): Promise<void> {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    await api.setPreferences({
      ...prefs,
      eventsTemplates: { selectedId, entries },
    })
  } catch { /* ignore */ }
}

function _broadcastEventsTemplates(
  selectedId: string | null,
  entries: Record<string, EventsTemplate>,
) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({
      type: 'events-templates-update',
      eventsTemplates: { selectedId, entries },
    })
    ch.close()
  } catch { /* ignore */ }
}

/** Default params for a fresh event-detection run. Matches the
 *  `EventsParams` defaults wired into the backend `/detect` endpoint. */
export function defaultEventsParams(): EventsParams {
  return {
    method: 'template_correlation',
    peakDirection: 'negative',
    showDetectionMeasure: false,
    filterEnabled: false,
    // Defaults chosen to match EE's out-of-the-box mEPSC pipeline:
    // a gentle wide bandpass (1–1000 Hz, order 1) that rejects slow
    // drift + supra-kHz noise without introducing ringing on the fast
    // rising edges event-fits need.
    filterType: 'bandpass',
    filterLow: 1,
    filterHigh: 1000,
    filterOrder: 1,
    detrendEnabled: false,
    detrendWindowMs: 500,
    templateId: null,
    additionalTemplateIds: [],
    correlationCutoff: 0.4,
    deconvCutoffSd: 3.5,
    deconvLowHz: 1.0,             // EE default (high-pass corner of the Gaussian bandpass)
    deconvHighHz: 200.0,
    thresholdMode: 'rms',
    rmsRegion: null,
    rmsValue: null,
    rmsBaselineMean: null,
    rmsMultiplier: 3.0,
    linearThreshold: -15,
    baselineSearchMs: 10,
    avgBaselineMs: 1,
    // Default 0 → skip boxcar peak smoothing. See backend comment in
    // `measure_event_kinetics` for why this matters: the boxcar is
    // symmetric but EPSC/IPSC shapes aren't, so smoothing biases peak
    // position toward the decay side. Opt in (> 0) only for very
    // noisy recordings where raw-sample peak jitter is a problem.
    avgPeakMs: 0,
    riseLowPct: 10,
    riseHighPct: 90,
    decayPct: 37,
    decaySearchMs: 30,
    baselineMethod: 'auto',
    // Order 2 (quadratic) handles the typical "drift-then-settle"
    // shape most slow-VC recordings show without bending into the
    // events themselves. Order 1 = linear drift; orders > 3 risk
    // tracking the event tails. Users can crank it for unusual cases.
    baselinePolyOrder: 2,
    decayEndpointMethod: 'first_cross',
    biexpMinR2: null,
    showEventFits: false,
    amplitudeMinAbs: 5,
    useRmsAmpFloor: false,
    ampFloorRmsMultiplier: 3,
    amplitudeMaxAbs: 2000,
    minIEIMs: 5,
    minIeiMs: 5,   // duplicate — backend expects min_iei_ms
    aucMinAbs: null,
    // Max-kinetic filters — events exceeding these are dropped as
    // artefacts (double-peaks, long-tailed noise). ``null`` disables
    // the filter for that kinetic.
    riseMaxMs: null,
    decayMaxMs: null,
    fwhmMaxMs: null,
    sweepMode: 'current',
    skipRegions: [],
  }
}

function _broadcastExcludedSweeps(excludedSweeps: Record<string, number[]>) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'excluded-update', excludedSweeps })
    ch.close()
  } catch { /* ignore */ }
}

function _broadcastAveragedSweeps(averagedSweeps: Record<string, AveragedSweep[]>) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'averaged-update', averagedSweeps })
    ch.close()
  } catch { /* ignore */ }
}

/** Broadcast field-burst state + detection filter to other windows via the
 *  shared `tracer-sync` channel. Called from the analysis window's store
 *  after every detection run so markers appear in the main viewer. */
function _broadcastBursts(fieldBursts: Record<string, FieldBurstsData>, params: FieldBurstsParams) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'bursts-update', fieldBursts })
    // Also push the detection filter config so the main viewer can adopt it
    // (keeps the visual-trace and burst-marker y-values aligned).
    if (params.filter_enabled) {
      ch.postMessage({
        type: 'detection-filter',
        filter: {
          enabled: true,
          type: String(params.filter_type ?? 'bandpass') as FilterState['type'],
          lowCutoff: Number(params.filter_low ?? 1),
          highCutoff: Number(params.filter_high ?? 50),
          order: Number(params.filter_order ?? 4),
        },
      })
    }
    ch.close()
  } catch { /* ignore — BroadcastChannel unavailable */ }
}

/** Broadcast the per-series burst-detection form state so every open
 *  window (including the main window, which owns persistence) stays in
 *  sync. The main window's CursorPanel listener adopts the payload into
 *  its store; the disk-persistence subscribe then writes to Electron
 *  prefs. Without this round-trip, the analysis window's updates would
 *  never reach disk. */
function _broadcastBurstFormParams(
  burstFormParams: Record<string, FieldBurstsParams>,
) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'burst-form-params-update', burstFormParams })
    ch.close()
  } catch { /* ignore */ }
}

/** Broadcast the full train-params bundle (all modules + all series).
 *  Cheap — the bundle is small and only changes when the user toggles
 *  or edits the train sidepanel in one of the three windows. */
function _broadcastTrainParams(trainParams: TrainParamsBundle) {
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'train-params-update', trainParams })
    ch.close()
  } catch { /* ignore */ }
}


export interface MeasurementResult {
  sweepIndex: number
  seriesIndex: number
  baseline: number
  peak: number
  amplitude: number
  riseTime?: number
  decayTime?: number
  halfWidth?: number
  area?: number
  rs?: number
  rin?: number
}

export interface OverlayEntry {
  sweep: number
  data: TraceData
  color: string
}

/** One detected burst, flat shape suitable for the table + overlay.
 *  Amplitudes are computed against a LOCAL pre-burst baseline (mean of
 *  the ~100 ms preceding the burst onset) so they're meaningful regardless
 *  of how the detection baseline was estimated. */
export interface BurstRecord {
  sweepIndex: number
  startS: number
  endS: number
  durationMs: number
  peakAmplitude: number       // |signal − preBurstBaseline| at peak
  peakSigned: number          // signed deviation at peak (+ = upward, − = downward)
  peakTimeS: number
  meanAmplitude: number       // mean |signal − preBurstBaseline| over burst
  integral: number            // ∫ |signal − preBurstBaseline| dt (units · s)
  riseTime10_90Ms: number | null  // time for |dev| to go 10% → 90% of peak
  decayHalfTimeMs: number | null  // time from peak to 50% of peak (descending)
  preBurstBaseline: number    // raw signal level just before the burst
  meanFrequencyHz: number | null  // (# prominent local maxima) / duration
  nSpikes?: number            // ISI method only
  /** True when the user added this burst manually via the sweep viewer
   *  (left-click) rather than auto-detection. Drives italic row styling
   *  + a ring around the peak dot. */
  manual?: boolean
}

/** Params the user configured for the last detection run. Stored alongside
 *  the bursts so the table + overlay lines can be interpreted / re-run. */
export interface FieldBurstsParams {
  method: 'threshold' | 'oscillation' | 'isi'
  baseline_mode: 'percentile' | 'robust' | 'rolling' | 'fixed_start'
  // All method-specific params go here in a flat dict.
  [key: string]: number | string | boolean | null | undefined
}

/** Signal-scale diagnostics attached to every burst-detection response.
 *  Useful for understanding why detection returned few/no bursts. */
export interface FieldBurstsDiag {
  median: number
  min: number
  max: number
  mad: number
  maxAbsDev: number
  nSamples: number
  durationS: number
}

/** One row of the I-V analysis table — computed per-sweep. */
export interface IVPoint {
  sweepIndex: number
  stimLevel: number          // mV (VC) or pA (CC)
  baseline: number           // mean of first baseline_window_ms of the sweep
  steadyState: number        // mean of last peak_window_ms of the pulse
  transientPeak: number      // extreme during pulse window
  /** Sag amplitude (mV for VC / pA for CC): transientPeak − steadyState.
   *  Typically of interest only for hyperpolarising steps (Ih-mediated
   *  sag-back), but reported for every sweep regardless of polarity so
   *  the user can interpret in context. */
  sagAmp: number
  /** Sag as a fraction of the total deflection: sagAmp / (transientPeak
   *  − baseline). Dimensionless, usually 0..1 when there's genuine sag.
   *  null when the total deflection is near zero (ratio undefined). */
  sagRatio: number | null
}

/** Which column of the I-V point is plotted on the y-axis. */
export type IVResponseMetric = 'steady' | 'peak'

// ---- Field PSP (fEPSP + fiber-volley) analysis ----

export type FPspMeasurementMethod = 'amplitude' | 'full_slope' | 'range_slope'
export type FPspPeakDirection = 'auto' | 'negative' | 'positive'
export type FPspTimeAxis = 'timestamp' | 'index'

/** Which flavour of fPSP analysis an FPspData entry holds. All three
 *  modes share the same per-sweep measurement machinery (slope, amp,
 *  baseline, volley/fEPSP values) — they differ only in how the result
 *  table is presented and which axis is used in the secondary plot. */
export type FPspMode = 'io' | 'ppr' | 'ltp'

export interface FPspPoint {
  sourceSeries: number       // which series index this bin came from
  binIndex: number           // index WITHIN its source series (0-based)
  sweepIndices: number[]
  meanSweepIndex: number
  baseline: number
  volleyPeak: number
  volleyPeakTs: number
  volleyAmp: number
  fepspPeak: number
  fepspPeakTs: number
  fepspAmp: number
  slope: number | null
  slopeLow: { t: number; v: number } | null
  slopeHigh: { t: number; v: number } | null
  ratio: number | null
  flagged: boolean
  // ---- PPR mode only: second response + paired-pulse ratios ----
  // Populated when the run was in PPR mode (two fEPSP windows per
  // sweep). Undefined in I-O / LTP entries. Ratios are
  // second/first, so a PPR < 1 means synaptic depression and > 1
  // means facilitation.
  volleyPeak2?: number
  volleyPeakTs2?: number
  volleyAmp2?: number
  fepspPeak2?: number
  fepspPeakTs2?: number
  fepspAmp2?: number
  slope2?: number | null
  slopeLow2?: { t: number; v: number } | null
  slopeHigh2?: { t: number; v: number } | null
  pprAmp?: number | null      // fepspAmp2 / fepspAmp
  pprSlope?: number | null    // slope2 / slope (both in |abs| terms)
}

export interface FPspData {
  /** Which tab this entry was produced from. Distinguishes I-O / PPR
   *  / LTP runs that may coexist for the same (group, series). Defaults
   *  to 'ltp' when absent for backward-compat with pre-tab-bar saves. */
  mode: FPspMode
  /** Run-scope form state from the last run. Optional — pre-v0.3.1
   *  saves don't carry these. Rehydrated on window reopen so "I was
   *  running sweeps 15-30" survives a close. */
  runMode?: 'all' | 'range' | 'one'
  sweepFrom?: number
  sweepTo?: number
  sweepOne?: number
  channel: number
  responseUnit: string
  /** Primary ("baseline") series index in the file. */
  seriesA: number
  /** Optional second ("LTP" / post-tetanus) series index. Only used
   *  in LTP mode. */
  seriesB: number | null
  stimOnsetS: number
  /** Inter-sweep intervals (seconds) parsed from .pgf for each series.
   *  0 means unknown — the graph then falls back to sweep-index-based x. */
  sweepIntervalA: number
  sweepIntervalB: number
  measurementMethod: FPspMeasurementMethod
  slopeLowPct: number
  slopeHighPct: number
  peakDirection: FPspPeakDirection
  avgN: number
  /** Pre-detection filter used for the run (echoed back so the mini-
   *  viewer can fetch the same filtered waveform). */
  filterEnabled: boolean
  filterType: 'lowpass' | 'highpass' | 'bandpass'
  filterLow: number
  filterHigh: number
  filterOrder: number
  /** Cursor positions at the time of the run (seconds). Echoed so the
   *  mini-viewer and table summary can refer back to them. */
  baselineStartS: number
  baselineEndS: number
  volleyStartS: number
  volleyEndS: number
  fepspStartS: number
  fepspEndS: number
  /** UI-only settings persisted with the entry. */
  timeAxis: FPspTimeAxis
  normalize: boolean
  normBaselineFrom: number   // 1-based bin index, inclusive (across the
  normBaselineTo: number     //   concatenated points list)
  points: FPspPoint[]
  selectedIdx: number | null
  /** I-O mode only: echoed back so the results table and scatter plot
   *  can label points with their stimulus intensity. Each point's
   *  intensity is computed as `ioInitialIntensity + sweepIndex * ioIntensityStep`
   *  on the frontend (preserves intensity alignment across excluded sweeps). */
  ioInitialIntensity?: number
  ioIntensityStep?: number
  /** Unit shown on the intensity axis (µA by default). Not converted
   *  — purely a label attached to the user's own input. */
  ioUnit?: string
  /** Which metric drives the I-O scatter's y-axis: slope (default) or
   *  amplitude. User-togglable; persisted with the entry. */
  ioMetric?: 'slope' | 'amplitude'
  // ---- PPR mode only ----
  /** Cursor window for the 2nd response's volley / fEPSP. The
   *  baseline window is shared with the 1st response (field above). */
  volley2StartS?: number
  volley2EndS?: number
  fepsp2StartS?: number
  fepsp2EndS?: number
  /** Inter-stimulus interval used for the last "Place V2/F2 from ISI"
   *  action. Persisted so the control retains the last-used value
   *  when the window reopens. */
  pprIsiMs?: number
  /** Whether the PPR over-time scatter shows amp-ratio or slope-ratio. */
  pprMetric?: 'amp' | 'slope'
}

/** Per-series I-V output, keyed in the store by "group:series". */
/** Reported by the AP and IV backends on every `/run` response so the
 *  UI's `ImSourceCard` info line can tell the user which Im source
 *  was actually used. `mode`:
 *    - 'protocol' — reconstructed from the recording's stimulus protocol
 *    - 'manual'   — user-supplied start/step values
 *    - 'none'     — no Im could be derived (no protocol, manual off)
 *  `label` is an optional short description (e.g. "reconstructed (pA)"). */
export interface ImSource {
  mode: 'protocol' | 'manual' | 'none'
  label: string | null
}

export interface IVCurveData {
  channel: number
  stimUnit: string           // mV for VC, pA for CC (x-axis label)
  responseUnit: string       // pA for VC, mV for CC (y-axis label)
  responseMetric: IVResponseMetric
  /** Cursor windows used for the run (seconds from sweep start). */
  baselineStartS: number
  baselineEndS: number
  peakStartS: number
  peakEndS: number
  points: IVPoint[]
  selectedIdx: number | null
  /** What the backend actually used as the Im source on the last run.
   *  Drives the ImSourceCard info line. Absent on pre-refactor saves. */
  imSource?: ImSource
  /** Form-state carried in the entry so reopening restores the user's
   *  exact setup — run scope, manual-Im fallback, sweep selections.
   *  All optional so pre-v0.3.1 saves still load. */
  runMode?: 'all' | 'range' | 'one'
  sweepFrom?: number
  sweepTo?: number
  sweepOne?: number
  manualImEnabled?: boolean
  manualImStartS?: number
  manualImEndS?: number
  manualImStartPA?: number
  manualImStepPA?: number
}

/** Per-series burst-detection output, keyed in the store by "group:series". */
export interface FieldBurstsData {
  channel: number
  params: FieldBurstsParams
  baselineValue: number
  thresholdHigh: number | null   // baseline + threshold (null for methods where not applicable)
  thresholdLow: number | null    // baseline − threshold
  bursts: BurstRecord[]
  selectedIdx: number | null
  diag?: FieldBurstsDiag         // signal-scale diagnostics (from the latest run)
}

export interface ResistanceResult {
  baseline: number
  peak_current: number
  steady_state_current: number
  rs: number | null
  rin: number | null
  cm?: number | null
  tau?: number | null
  peak_idx?: number
  steady_state_start_idx?: number
  pulse_end_idx?: number
  /** Tag describing where this result came from */
  source?: string
}

/** Resistance-window form state — the user-facing params that the
 *  ResistanceWindow used to hold in local ``useState``. Lifted into
 *  the store so the sidecar can persist them per recording.
 *
 *  Note: ``vStep`` auto-populates from the stimulus protocol when a
 *  new series is picked, but typed-in user values persist via the
 *  sidecar (overrides survive across sessions). ``avgFrom`` / ``avgTo``
 *  are ephemeral per-series defaults; still here so batch analysis
 *  can reconstruct the exact run. */
export interface ResistanceFormState {
  vStep: number
  nExp: 1 | 2
  fitDurationMs: number
  runMode: 'all' | 'selected' | 'range' | 'one'
  avgFrom: number
  avgTo: number
  sweepOne: number
}

/** Cursor-analysis types: one state blob per recording, mirroring the
 *  pattern used by ivCurves / fpspCurves / fieldBursts. */
export interface CursorSlotConfig {
  enabled: boolean
  peak: { start: number; end: number }
  fit: { start: number; end: number } | null
  fitFunction: string | null
  fitOptions: {
    maxfev?: number
    ftol?: number
    xtol?: number
    /** Per-parameter initial-guess override. null/undefined = auto. */
    initialGuess?: Record<string, number | null>
  } | null
}

export interface CursorMeasurement {
  slot: number
  sweep: number                           // -1 for the averaged trace
  baseline: number
  baseline_sd: number
  peak: number
  peak_time: number
  amplitude: number
  time_to_peak?: number
  rise_time_10_90?: number
  rise_time_20_80?: number
  half_width?: number
  max_slope_rise?: number
  max_slope_decay?: number
  rise_decay_ratio?: number
  area?: number
  ap_threshold?: number
  ap_threshold_time?: number
  fit?: {
    function: string
    params: Record<string, number>
    rss: number
    r_squared: number
    fit_time: number[]
    fit_values: number[]
  } | null
}

// ---- Action Potentials analysis ----

export type APThresholdMethod =
  | 'first_deriv_cutoff'
  | 'first_deriv_max'
  | 'third_deriv_cutoff'
  | 'third_deriv_max'
  | 'sekerli_I'
  | 'sekerli_II'
  | 'leading_inflection'
  | 'max_curvature'

export type APDetectionMethod = 'auto_rec' | 'auto_spike' | 'manual'
export type APRheobaseMode = 'record' | 'exact' | 'ramp'

export interface APDetectionParams {
  method: APDetectionMethod
  manual_threshold_mv: number
  min_amplitude_mv: number
  pos_dvdt_mv_ms: number
  neg_dvdt_mv_ms: number
  width_ms: number
  min_distance_ms: number
  bounds_start_s: number
  bounds_end_s: number
  filter_enabled: boolean
  filter_type: 'lowpass' | 'highpass' | 'bandpass'
  filter_low: number
  filter_high: number
  filter_order: number
}

export interface APKineticsParams {
  threshold_method: APThresholdMethod
  threshold_cutoff_mv_ms: number
  threshold_search_ms_before_peak: number
  sekerli_lower_bound_mv_ms: number
  rise_low_pct: number
  rise_high_pct: number
  decay_low_pct: number
  decay_high_pct: number
  decay_end: 'to_threshold' | 'to_fahp'
  fahp_search_start_ms: number
  fahp_search_end_ms: number
  mahp_search_start_ms: number
  mahp_search_end_ms: number
  max_slope_window_ms: number
  interpolate_to_200khz: boolean
}

export interface APRampParams {
  t_start_s: number
  t_end_s: number
  im_start_pa: number
  im_end_pa: number
}

/** One detected spike with all kinetic measurements. `manual` flags
 *  spikes the user added via left-click (drawn with a ring marker). */
export interface APPoint {
  sweep: number
  spikeIndex: number
  thresholdVm: number
  thresholdT: number
  peakVm: number
  peakT: number
  amplitudeMv: number
  riseTimeS: number | null
  decayTimeS: number | null
  halfWidthS: number | null
  fahpVm: number | null
  fahpT: number | null
  mahpVm: number | null
  mahpT: number | null
  maxRiseSlopeMvMs: number | null
  maxDecaySlopeMvMs: number | null
  manual: boolean
}

/** Per-sweep counting metrics — one row per analysed sweep. */
export interface APPerSweep {
  sweep: number
  spikeCount: number
  peakTimes: number[]
  firstSpikeLatency: number | null
  meanISI: number | null
  sfaDivisor: number | null
  localVariance: number | null
  imMean: number | null
  spikeRateHz: number | null
}

/** User overrides on top of auto-detection. Replayed on every run so
 *  edits survive parameter tweaks; `Clear manual edits` button drops
 *  these wholesale. Sweep keys are 0-based; values are peak times in
 *  seconds within the sweep. */
export interface APManualEdits {
  added: Record<number, number[]>
  removed: Record<number, number[]>
}

export interface APData {
  group: number
  series: number
  trace: number
  /** Manual Im override. When enabled, the backend uses
   *  `manualImStart/Step/StartS/EndS` directly instead of
   *  reconstructing Im from the stimulus protocol. Mirrors the IV
   *  window's manual-Im fallback for consistency. */
  manualImEnabled: boolean
  manualImStartS: number
  manualImEndS: number
  manualImStartPA: number
  manualImStepPA: number
  /** Run-scope form state from the last run. Persisted so reopening
   *  the file lands you on the exact same "which sweeps" selection.
   *  Optional because pre-v0.3.1 saves don't carry it. */
  runMode?: 'all' | 'range' | 'one'
  sweepFrom?: number
  sweepTo?: number
  sweepOne?: number
  detection: APDetectionParams
  kinetics: APKineticsParams
  rheobaseMode: APRheobaseMode
  rampParams: APRampParams | null
  manualEdits: APManualEdits
  perSweep: APPerSweep[]
  perSpike: APPoint[]
  fiCurve: { im: number[]; rate: number[]; sweep: number[] } | null
  rheobase: { mode: APRheobaseMode; value: number | null } | null
  spikeTimesPerSweep: number[][]
  selectedSpikeIdx: number | null
  imOnsetS: number | null
  samplingRate: number
  /** What the backend actually used as the Im source on the last run.
   *  Drives the ImSourceCard info line. Absent on pre-refactor saves. */
  imSource?: ImSource
}

// ---------------------------------------------------------------------------
// Event detection & analysis
// ---------------------------------------------------------------------------

/** Biexponential template coefficients: the user fits one of these to
 *  a clean exemplar event, then the backend renders it to a sample
 *  array and slides it across the data for correlation / deconvolution
 *  detection. Width_ms is the template window length in ms, separate
 *  from the biexp coefficients. */
export interface EventsTemplate {
  id: string
  name: string
  b0: number
  b1: number                     // sign determines polarity (negative → downward)
  tauRiseMs: number
  tauDecayMs: number
  widthMs: number
  direction: 'positive' | 'negative'
}

export type EventsDetectionMethod =
  | 'template_correlation'
  | 'template_deconvolution'
  | 'threshold'

export type EventsThresholdMode = 'rms' | 'linear'

/** Detection-measure payload — the correlation or deconvolution
 *  trace (decimated) + the horizontal cutoff line that renders as a
 *  stacked subplot under the main viewer. `values` is a min-max-paired
 *  array; render with step x = dt_s × i. */
export interface EventsDetectionMeasure {
  values: number[]
  dtS: number
  tStartS: number
  method: 'correlation' | 'deconvolution'
  cutoffLine: number           // y-value of the horizontal cutoff on the trace
  mu?: number                  // (deconvolution only) histogram Gaussian mean
  sigma?: number               // (deconvolution only) histogram Gaussian σ
}

export interface EventsParams {
  method: EventsDetectionMethod
  peakDirection: 'negative' | 'positive'
  // If true, the backend returns + we render the detection-measure
  // trace (correlation r or deconvolution σ-scaled signal) as a
  // stacked subplot beneath the main viewer, with a horizontal line
  // at the cutoff value. Same UX as EE's "Show Deconvolution" /
  // "Show Correlation" toggles.
  showDetectionMeasure: boolean
  // Pre-detection filter (same shape as AP / FieldBurst params). Applied
  // to the sweep before anything else — so threshold, detection, and
  // kinetics all see the filtered trace. Off by default; users typically
  // enable a 1–500 Hz bandpass for noisy VC recordings.
  filterEnabled: boolean
  filterType: 'lowpass' | 'highpass' | 'bandpass'
  filterLow: number
  filterHigh: number
  filterOrder: number
  /** Pre-detection detrending via rolling-median subtraction. Flattens
   *  slow drift that a high-pass filter would also handle but with
   *  less ringing near sharp edges. Matches EE's "Subtract baseline
   *  (moving median)" option. Window is in ms. */
  detrendEnabled: boolean
  detrendWindowMs: number
  // Template-method
  templateId: string | null                 // primary template from the library
  /** Up to two ADDITIONAL templates for multi-template detection (EE
   *  parity: detect with templates 1/2/3 simultaneously). When any of
   *  these is non-null, correlation/deconvolution uses the cooperative
   *  set — correlation takes pointwise max, deconvolution unions
   *  per-template peak sets. Empty array = single-template mode. */
  additionalTemplateIds: string[]
  correlationCutoff: number                 // 0-1, default 0.4
  deconvCutoffSd: number                    // default 3.5 σ
  deconvLowHz: number
  deconvHighHz: number
  // Threshold-method
  thresholdMode: EventsThresholdMode
  rmsRegion: { startS: number; endS: number } | null
  rmsValue: number | null                   // populated after /api/events/rms
  rmsBaselineMean: number | null
  rmsMultiplier: number                     // n × RMS (default 3)
  linearThreshold: number                   // fixed pA/mV value in linear mode
  // Kinetics
  baselineSearchMs: number
  avgBaselineMs: number
  avgPeakMs: number
  riseLowPct: number
  riseHighPct: number
  decayPct: number
  decaySearchMs: number
  /** Per-event baseline detection method.
   *  - ``'auto'``       — Jonas line-intersect + local mean window
   *    (default; matches EE's automatic baseline).
   *  - ``'polynomial'`` — fit a low-order polynomial to the whole
   *    sweep with event-side samples clipped, then read the baseline
   *    off that curve at each event's foot. Drift-aware; preferred
   *    when slow-trend baselines outpace what the rolling-median
   *    detrend can flatten without ringing. */
  baselineMethod: 'auto' | 'polynomial'
  baselinePolyOrder: number
  /** Decay-endpoint detection: ``'first_cross'`` (default) returns to
   *  baseline within the search window; ``'entire'`` always uses the
   *  far edge of ``decaySearchMs``. ``entire`` gives a deterministic
   *  integration window when events overlap heavily. */
  decayEndpointMethod: 'first_cross' | 'entire'
  /** Minimum biexp R² for an event to be retained. ``null`` disables
   *  the filter. Auto-detected events only — manual adds bypass like
   *  every other exclusion guard. */
  biexpMinR2: number | null
  /** Render thin black biexp-fit curves over each visible event in
   *  the main viewer. Off by default to keep the viewer uncluttered;
   *  toggle on to QC the fits visually before tightening R². */
  showEventFits: boolean
  // Exclusion
  amplitudeMinAbs: number                   // abs(amplitude) cutoff
  /** When true, the effective minimum-amplitude floor used during
   *  detection is ``max(amplitudeMinAbs, ampFloorRmsMultiplier × |rmsValue|)``.
   *  Lets template (correlation/deconvolution) methods reject events
   *  smaller than n × baseline-noise without conflating the absolute
   *  floor. ``rmsValue`` must be computed first (cursor band → Compute
   *  RMS); if it's null this toggle is a no-op. */
  useRmsAmpFloor: boolean
  ampFloorRmsMultiplier: number             // n × RMS, default 3
  amplitudeMaxAbs: number                   // above → rejected as artefact
  minIEIMs: number
  aucMinAbs: number | null                  // null = off
  // Max-kinetic filters — events exceeding these get dropped. ``null``
  // disables that specific filter. Matches EE's Exclusion panel.
  riseMaxMs: number | null
  decayMaxMs: number | null
  fwhmMaxMs: number | null
  /** Cross-sweep detection mode. ``'current'`` (default) runs on the
   *  single sweep the user is looking at. ``'all'`` loops over every
   *  sweep in the current series, concatenating events into a single
   *  table. Each event's ``sweep`` field identifies its origin, and
   *  main-viewer markers / Browser window already filter by sweep so
   *  navigating between sweeps shows only that sweep's events. */
  sweepMode: 'current' | 'all'
  /** Manual "skip" regions — up to 5 time ranges where detection is
   *  suppressed (stimulus artifacts, perfusion switches, junk). Each
   *  region has its own enable flag so the user can A/B-compare with
   *  and without skipping. Drawn as red translucent bands on the
   *  main events viewer; draggable by the user like the baseline
   *  cursors. */
  skipRegions: { enabled: boolean; startS: number; endS: number }[]
  // Common
  minIeiMs: number
}

/** One detected event, hydrated from the backend response. Times are
 *  in seconds within the containing sweep. Values are in the trace's
 *  native units (pA in VC, mV in CC). */
export interface EventRow {
  sweep: number
  peakIdx: number
  peakTimeS: number
  peakVal: number
  footIdx: number
  footTimeS: number
  baselineVal: number
  amplitude: number
  riseTimeMs: number | null
  decayTimeMs: number | null
  halfWidthMs: number | null
  auc: number | null
  decayEndpointIdx: number | null
  /** Per-event monoexponential decay τ in milliseconds — fit of
   *  ``y = baseline + a·exp(-t/τ)`` from peak to decay-endpoint.
   *  Null when the fit couldn't converge (short window, noisy tail). */
  decayTauMs: number | null
  /** Per-event biexponential fit — same model as the template.
   *  Gives a τ_rise per event that the percent-threshold rise time
   *  can't deliver on noisy events. All four coefficients null
   *  together when the fit couldn't run. */
  biexpTauRiseMs: number | null
  biexpTauDecayMs: number | null
  biexpB0: number | null
  biexpB1: number | null
  /** Goodness-of-fit on the biexp model — 1 = perfect, ~0 = no
   *  better than mean-only, < 0 = worse than mean. Null when the fit
   *  didn't run (window too short etc). */
  biexpR2: number | null
  manual: boolean
  /** Multi-template detection only — 0-based index into the templates
   *  list active during the run. Backend tags it from argmax of the
   *  per-template detection measure (correlation) or from the merged
   *  union (deconvolution). Null for single-template, threshold, and
   *  manual events. The viewer uses it to color the peak marker. */
  templateIdx: number | null
  /** Curation group (1–5). Set manually via the digit-key + click
   *  flow on the main events viewer. Null = ungrouped. Used for
   *  filtering / coloring. Round-trips via the .tracer sidecar. */
  group: number | null
}

export interface EventsData {
  group: number
  series: number
  channel: number
  sweep: number
  params: EventsParams
  events: EventRow[]
  selectedIdx: number | null
  /** Manual edits persisted across re-runs. Added entries are inserted
   *  at the requested time (backend snaps to the local extremum);
   *  removed times drop any auto-detected peak within tolerance. */
  manualEdits: {
    addedTimes: number[]
    removedTimes: number[]
  }
  samplingRate: number
  sweepLengthS: number
  /** Total recording time that contributed to this analysis. Equals
   *  ``sweepLengthS`` for single-sweep detection; for cross-sweep,
   *  sum of the analysed sweeps' durations. Used by the Rate / IEI
   *  tabs to compute Hz across the whole run. */
  totalLengthS: number
  /** Sweep indices that contributed to this analysis. Length = 1 in
   *  single-sweep mode. */
  sweepsAnalysed: number[]
  units: string
  /** Populated when `params.showDetectionMeasure` was true on the
   *  last run. Drives the stacked detection-measure subplot. */
  detectionMeasure?: EventsDetectionMeasure
}

export interface CursorAnalysisData {
  group: number
  series: number
  trace: number
  slotCount: number                       // 1..10 — number of visible slots
  baseline: { start: number; end: number }
  baselineMethod: 'mean' | 'median'
  computeAP: boolean
  apSlope: number
  slots: CursorSlotConfig[]               // always length 10 (unused ones are disabled)
  runMode: 'all' | 'range' | 'one'
  sweepFrom: number
  sweepTo: number
  sweepOne: number
  average: boolean
  measurements: CursorMeasurement[]
  traceUnit: string
}

// Paired-recording analysis — pre/post synaptic trial extraction.
// One entry per ``${group}:${series}`` carries the full computed state
// for that pair; a separate ``pairedForm`` slot holds last-used params
// so a fresh series gets sensible defaults instead of empty inputs.
export interface PairedTrial {
  sweep: number
  trialIdx: number
  preTS: number
  preAmp: number
  baselineMean: number
  baselineSd: number
  postPeak: number
  postPeakTS: number
  amplitude: number
  success: boolean
  latencyMs: number | null
  riseMs: number | null
  decayMs: number | null
  /** Monoexponential decay τ from a fit on the post window. Same
   *  estimator as ``analysis.events.measure_event_kinetics``. */
  decayTauMs: number | null
  halfWidthMs: number | null
  truncated: boolean
  manual: boolean
  /** User overrode this trial's classification by right-clicking
   *  the post marker. Renders distinctly so the user can tell auto-
   *  vs manual-failures apart. */
  postManualFailure?: boolean
}

export interface PairedSeriesSummary {
  nTrials: number
  nSuccess: number
  nFailures: number
  failureRate: number | null
  meanAmplitude: number | null
  meanAmplitudeZeroed: number | null
  potency: number | null
  cvSuccess: number | null
  invCv2: number | null
  latencyMeanMs: number | null
  latencySdMs: number | null
  pprN1: { n: number; ratio: number; nSweeps: number }[]
}

export interface PairedSweepSummary {
  sweep: number
  nTrials: number
  nSuccess: number
  nFailures: number
  ppr21: number | null
}

export interface PairedSta {
  time: number[]
  mean: number[]
  sem: number[]
  n: number
  /** Per-trial aligned post-window traces (one per row), shape
   *  ``[n][len(time)]``. Used by the STA tab's "show individual
   *  sweeps" overlay so the user can see how tightly the trials
   *  cluster around the average. NaN-padded samples come back as
   *  zeros to keep the JSON small; the renderer treats them like
   *  any other point. */
  traces?: number[][]
  /** Per-trial success flag in the same order as ``traces``. */
  traceSuccess?: boolean[]
  /** Monoexponential decay fit on the STA mean. ``fitCurve`` is
   *  evaluated on the same time array as ``mean`` so the renderer
   *  can plot it as a parallel series; ``fitCurveMask`` is 1 where
   *  the fit is defined (peak → end) and 0 where it isn't (pre-
   *  peak samples are zero-filled). */
  fit?: {
    baseline: number
    amplitude: number
    peakTS: number
    peakV: number
    tauDecayMs: number
    r2: number
    fitCurve: number[]
    fitCurveMask: number[]
  }
}

export interface PairedManualEdits {
  added: Record<number, number[]>     // sweep idx → list of pre_t in seconds
  removed: Record<number, number[]>
  /** Per-sweep list of pre_t values whose corresponding trials the
   *  user has marked as a "post manual failure" (right-click on the
   *  post marker → reclick to confirm). The auto-detected post peak
   *  is preserved for visual feedback (so the user can see what
   *  they're overruling) but the trial is forced to success=False
   *  in stats. Re-clicking the same marker clears the override. */
  postFailed?: Record<number, number[]>
}

/** Mode-agnostic pre-detection params + post-window + failure +
 *  latency settings. Stored as one flat blob so the form can drop it
 *  into one ``setPairedForm`` call without parameter spread. */
export interface PairedFormState {
  preMode: 'ap' | 'stim' | 'ttl' | 'manual'
  preParams: Record<string, unknown>
  postParams: {
    preMs: number
    postMs: number
    baselineMs: number
    peakDirection: 'auto' | 'positive' | 'negative'
    filterEnabled: boolean
    filterType: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
    filterLow: number
    filterHigh: number
    filterOrder: number
  }
  failureParams: {
    rule: 'k_sd' | 'absolute'
    kSd: number
    absolute: number
  }
  latencyParams: {
    rule: 'fraction' | 'onset_d2'
    fraction: number
  }
}

export interface PairedData {
  group: number
  series: number
  preTrace: number
  postTrace: number
  sweeps: number[]
  samplingRate: number
  preMode: PairedFormState['preMode']
  preParams: Record<string, unknown>
  postParams: PairedFormState['postParams']
  failureParams: PairedFormState['failureParams']
  latencyParams: PairedFormState['latencyParams']
  /** Optional absolute-time post-search bounds (the draggable
   *  cursors on the post viewer). ``null`` / undefined = no clip. */
  postSearchStartS?: number | null
  postSearchEndS?: number | null
  manualEdits: PairedManualEdits
  perTrial: PairedTrial[]
  perSweepSummary: PairedSweepSummary[]
  seriesSummary: PairedSeriesSummary
  staAll: PairedSta | null
  staSuccess: PairedSta | null
  staFailure: PairedSta | null
  selectedTrialIdx: number | null
}

export function defaultPairedForm(): PairedFormState {
  return {
    preMode: 'ap',
    preParams: {
      ap_method: 'auto_rec',
      ap_min_amplitude_mv: 50,
      ap_pos_dvdt_mv_ms: 10,
      ap_neg_dvdt_mv_ms: -10,
      ap_width_ms: 5,
      ap_manual_threshold_mv: -10,
      stim_dvdt_threshold: 1.0e3,
      ttl_level_threshold: null,
      ttl_edge: 'rising',
      ttl_min_pulse_ms: 1.0,
      min_distance_ms: 5.0,
      bounds_start_s: 0.0,
      bounds_end_s: 0.0,
      // Pre-detection filter (off by default — pre channels are
      // typically AP traces or square TTL pulses where filtering
      // wouldn't help). Same key shape the backend's filter helper
      // expects for the rest of the analyses.
      filter_enabled: false,
      filter_type: 'lowpass',
      filter_low: 1.0,
      filter_high: 1000.0,
      filter_order: 1,
    },
    postParams: {
      preMs: 1.0,
      postMs: 30.0,
      baselineMs: 2.0,
      peakDirection: 'auto',
      // Post pre-detection filter — on by default with lowpass
      // 1 kHz, order 1. Post channels are usually noisy PSCs / PSPs
      // where a gentle lowpass removes high-frequency hash without
      // distorting the rising edge enough to bias rise / latency.
      filterEnabled: true,
      filterType: 'lowpass',
      filterLow: 1.0,
      filterHigh: 1000.0,
      filterOrder: 1,
    },
    failureParams: {
      rule: 'k_sd',
      kSd: 3.0,
      absolute: 0.0,
    },
    latencyParams: {
      rule: 'fraction',
      fraction: 0.20,
    },
  }
}

export interface CursorWindowUI {
  plotHeight: number
  leftPanelWidth: number                  // left params column width, 200–500 px
  measurementColumns: string[]            // visible-column IDs for the Measurements tab
  fitColumns: string[]                    // visible-column IDs for the Fit tab
  activeTab: 'measurements' | 'fit'
}

/** User-created averaged trace that shows up in the TreeNavigator as
 *  a virtual sweep. Time/values are stored at full resolution so the
 *  plot can resample to whatever max_points the viewer needs. */
export interface AveragedSweep {
  id: string                   // stable unique key (e.g. "avg-<ms>-<rand>")
  group: number
  series: number
  trace: number
  sourceSweepIndices: number[] // 0-based indices of the sweeps averaged
  label: string
  time: number[]
  values: number[]
  samplingRate: number
  units: string
  createdAt: number            // epoch ms
}

interface AppState {
  // Backend connection
  backendUrl: string
  backendReady: boolean
  initBackend: () => Promise<void>

  // File state
  recording: RecordingInfo | null
  currentGroup: number
  currentSeries: number
  currentSweep: number
  currentTrace: number
  recentFiles: string[]
  clearRecentFiles: () => void

  // Trace data
  traceData: TraceData | null
  overlayEntries: OverlayEntry[]
  averageTrace: TraceData | null
  showOverlay: boolean
  showAverage: boolean

  // Additional visible channels (beyond traceData, which tracks currentTrace).
  // Keyed by channel index; fetched in parallel when visibility changes.
  additionalTraces: Record<number, TraceData>

  // Per-series set of visible trace indices. The sentinel STIMULUS_TRACE_INDEX
  // (-1) represents the reconstructed stimulus. Keyed by `${group}:${series}`.
  visibleTraces: Record<string, number[]>

  // Per-sweep stimulus segments (fetched on sweep change for overlay)
  sweepStimulusSegments: StimulusSegment[] | null
  sweepStimulusUnit: string

  // Cursors
  cursors: CursorPositions
  cursorVisibility: CursorVisibility

  /** User-applied per-channel scaling overrides for the current
   *  recording. Keyed by ``${group}:${series}:${channel}``. Dormant
   *  by default — most files load with this empty and never touch
   *  it. See ``ScaleOverride`` for shape. */
  scaleOverrides: ScaleOverrides

  // Filtering
  filter: FilterState
  /** Per-channel filter overrides. ``filter`` is the fallback used
   *  for any channel without an explicit entry here. UI surfaces
   *  one filter at a time (the panel reads/writes this slot for the
   *  channel the user has selected in the panel). */
  filtersByChannel: Record<number, FilterState>
  /** Per-series filter snapshot, keyed ``${group}:${series}``. Bundles
   *  both the default (all-channels) filter AND any per-channel
   *  overrides — that way switching series faithfully restores the
   *  whole filter context, no matter which slot ("Default" or a
   *  specific channel) the user toggled. Round-trips through the
   *  .tracer sidecar; ``selectSweep`` restores it on series
   *  change, and both ``setFilter`` and ``setFilterFor`` keep the
   *  current-series slot in sync. */
  filtersBySeries: Record<string, { filter: FilterState; filtersByChannel: Record<number, FilterState> }>

  // Zero offset subtraction
  zeroOffset: boolean
  // Actual offset value the backend subtracted for the currently-displayed
  // sweep (from `/api/traces/data` response). Zero when zeroOffset is off.
  // Used by burst-marker rendering to place dots at their correct y on an
  // offset-corrected trace (burst records carry raw y values).
  currentZeroOffset: number

  // Continuous-data viewport — null = "full sweep" (show everything).
  viewport: Viewport | null
  // Full duration of the currently displayed sweep in seconds (from backend metadata).
  // Used to size the scroll slider and clamp viewport navigation.
  sweepDuration: number
  // Max number of samples to request in the current fetch (tied to plot width).
  viewportMaxPoints: number

  // Per-series axis ranges (saved when switching away, restored when switching back)
  seriesAxisRanges: Record<string, {
    x?: { min: number; max: number }
    y?: { min: number; max: number }
    /** Right-side Y axis used by additional channels with units that
     *  differ from the primary trace (e.g. an mV channel alongside a
     *  pA primary). Pans/zooms independently of ``y``. */
    y_alt?: { min: number; max: number }
    stim?: { min: number; max: number }
  }>

  // Measurements
  results: MeasurementResult[]

  // Resistance analysis
  resistanceResult: ResistanceResult | null
  /** Per-series resistance results, keyed by ``${group}:${series}``.
   *  Each entry is the *full set of rows* the user computed in their
   *  most recent run on that series — one row for single-sweep or
   *  averaged-sweep runs, N rows for cross-sweep / "all sweeps"
   *  runs. Replacing instead of appending matches what every other
   *  per-series analysis does (events, AP, bursts: one stored
   *  result per series, last-write-wins).
   *
   *  Drives:
   *    * tree-navigator's R badge (any non-empty array lights it)
   *    * resistance window's table on series switch (rehydrates from
   *      this so switching series never shows the previous one's
   *      numbers and never accumulates across runs)
   *    * cohort extractor (computes mean Rs/Rin/Cm/τ across the
   *      array for the per-cell scalar)
   *
   *  Sidecar storage uses the same shape; v0.3.x sidecars that wrote
   *  this field as a single object before this change get migrated
   *  to ``[obj]`` on load. */
  resistanceResults: Record<string, ResistanceResult[]>
  /** Resistance-window form state — lifted out of the component so
   *  the sidecar can persist it per recording. ``vStep`` is also
   *  auto-populated from the stimulus protocol when a new series is
   *  picked; users can then override by typing a new value, which
   *  sticks (sidecar save on change). */
  resistanceForm: ResistanceFormState

  /** Recording-level metadata: cell ID, free-text notes, and the
   *  multi-tag arrays that drive Cohort Analysis grouping. ``null``
   *  when no recording is loaded. Auto-saved into the sidecar like
   *  the rest of the per-recording state. */
  recordingMeta: SidecarMeta | null

  /** ``true`` once the sidecar load (or "no sidecar" determination)
   *  for the current recording has finished. The tag-prompt toast
   *  uses this to avoid firing during the brief window between the
   *  recording being set and the sidecar actually being read off
   *  disk — without it, every freshly-opened tagged file briefly
   *  shows "no tags" and the toast pops even on green-status files. */
  recordingMetaReady: boolean

  // Field-burst detection, keyed by `${group}:${series}` so markers can
  // persist across series switches.
  fieldBursts: Record<string, FieldBurstsData>

  /** Per-series burst-detection *form* state (method, baseline mode,
   *  all numeric params, filter fields). Survives window close even if
   *  the user never clicked Run. Keyed by `${group}:${series}`;
   *  persisted per-recording in the .tracer sidecar. */
  burstFormParams: Record<string, FieldBurstsParams>

  /** Train-grouping form state for the Burst, Event, and AP windows.
   *  Only the parameters live here — train results are derived on the
   *  fly from each module's detected timestamps via
   *  `frontend/src/utils/trains.ts`. Persisted per-recording. */
  trainParams: TrainParamsBundle

  // I-V curves, keyed by `${group}:${series}` — persists across navigation
  // and is saved per-recording in Electron preferences.
  ivCurves: Record<string, IVCurveData>

  // Field PSP analyses, same key shape + same persistence pattern.
  fpspCurves: Record<string, FPspData>

  // Cursor analyses — at most one blob per recording (keyed by filePath).
  // Contains the full slot configuration plus the last run's measurements,
  // so reopening the window on the same file restores the previous state.
  cursorAnalyses: Record<string, CursorAnalysisData>

  // Action Potentials analyses — keyed by `${group}:${series}` so
  // detection results survive series switches. The three AP-window
  // tabs (Counting / Kinetics / Phase) all read from the same blob.
  apAnalyses: Record<string, APData>

  // Event-detection analyses — keyed by `${group}:${series}` like AP.
  // Contains the last run's params + detected events + manual edits.
  eventsAnalyses: Record<string, EventsData>

  // Paired-recording analyses — keyed by `${group}:${series}`. Each
  // entry carries the request shape (channels + params + manual edits)
  // alongside per-trial / per-sweep / series / STA outputs from the
  // backend. ``pairedForm`` holds the global form defaults so a fresh
  // series picks up the user's last-used settings.
  pairedAnalyses: Record<string, PairedData>
  pairedForm: PairedFormState
  setPairedAnalysis: (group: number, series: number, data: PairedData) => void
  clearPairedAnalysis: (group: number, series: number) => void
  setPairedForm: (form: PairedFormState) => void
  /** Batch-friendly runner that POSTs to ``/api/paired/run`` and stores
   *  the response via ``setPairedAnalysis``. Same wire shape the
   *  Paired window's onRun uses; lets the Batch module reuse the
   *  store action without rebuilding the request body. */
  runPaired: (
    group: number, series: number,
    preTrace: number, postTrace: number,
    params: {
      preMode: PairedFormState['preMode']
      preParams: Record<string, unknown>
      postParams: PairedFormState['postParams']
      failureParams: PairedFormState['failureParams']
      latencyParams: PairedFormState['latencyParams']
      postSearchStartS?: number | null
      postSearchEndS?: number | null
      manualEdits?: PairedManualEdits | null
      sweeps?: number[] | null
    },
  ) => Promise<void>

  /** Global biexponential template library for event detection.
   *  Persisted per-user (not per-file) so templates fit on one
   *  recording can be reused on another. `selectedId` is which
   *  template the window currently treats as "active" — this is
   *  the one the detector uses and the one the Refine dialog
   *  overwrites when the user accepts a refined fit. */
  eventsTemplates: {
    selectedId: string | null
    entries: Record<string, EventsTemplate>
  }

  /** Global (per-user, not per-file) UI prefs for the cursor window:
   *  splitter position, visible columns per tab, active tab. */
  cursorWindowUI: CursorWindowUI

  /** Per-series set of excluded sweep indices. Keyed by "group:series".
   *  Stored as a sorted array (JSON-serializable) rather than a Set so
   *  it round-trips through Electron prefs and BroadcastChannel cleanly.
   *  Excluded sweeps are dropped from EVERY analysis and from the main
   *  viewer's "Show average" — they're not deleted from disk, just
   *  filtered out of any batch processing. */
  excludedSweeps: Record<string, number[]>

  /** Per-series session-only multi-selection in the tree. Drives the
   *  "Average → Selected" mode and any future multi-sweep actions.
   *  NOT persisted. Cleared when switching series. */
  selectedSweeps: Record<string, number[]>

  /** Per-series user-created averaged traces that show up in the tree
   *  as virtual sweeps. Persisted per-file in Electron prefs. Users
   *  can navigate to them like real sweeps; they're NOT targets for
   *  analyses (analysis windows have their own in-built averaging). */
  averagedSweeps: Record<string, AveragedSweep[]>

  /** Navigation pointer into `averagedSweeps` for the CURRENTLY-VIEWED
   *  averaged sweep, or null if a real sweep is on screen. When
   *  non-null, TraceViewer sources its trace data from the stored
   *  AveragedSweep rather than hitting the backend. */
  currentAveragedSweep: { group: number; series: number; id: string } | null

  // UI state
  zoomMode: boolean
  showCursors: boolean
  /** Whether burst markers (baseline + threshold lines + per-burst dots)
   *  are drawn on the main TraceViewer overlay. Independent of `showCursors`. */
  showBurstMarkers: boolean
  /** Whether detected-event markers (peak / foot / decay dots from the
   *  event-detection module) are drawn on the main TraceViewer overlay.
   *  Persisted like `showBurstMarkers`. Useful for glancing across a
   *  recording to see which series have been analysed. */
  showEventMarkers: boolean
  /** Whether the hover-tooltip showing x/y coordinates is active in the
   *  main TraceViewer. */
  showCoordinates: boolean
  loading: boolean
  error: string | null

  // Actions
  toggleZoomMode: () => void
  toggleCursors: () => void
  toggleBurstMarkers: () => void
  toggleEventMarkers: () => void
  toggleCoordinates: () => void
  resetCursorsToDefaults: () => void
  setCursorVisibility: (v: Partial<CursorVisibility>) => void
  setFilter: (f: Partial<FilterState>) => void
  /** Set the filter for a specific channel. Pass ``null`` as patch
   *  to drop the per-channel entry and fall back to the default
   *  ``filter`` again. */
  setFilterFor: (channel: number, patch: Partial<FilterState> | null) => void
  /** Resolve the effective filter for a channel: per-channel entry
   *  if present, otherwise the global ``filter`` fallback. */
  getFilterForChannel: (channel: number) => FilterState
  applyFilter: () => Promise<void>
  toggleZeroOffset: () => void
  // Viewport controls
  setViewport: (viewport: Viewport | null) => void
  setViewportWindowSize: (seconds: number | null) => void  // null = full sweep
  scrollViewport: (deltaSeconds: number) => void
  setViewportStart: (start: number) => void
  setViewportMaxPoints: (n: number) => void
  refetchViewport: () => Promise<void>
  saveSeriesAxisRange: (group: number, series: number, ranges: {
    x?: { min: number; max: number }
    y?: { min: number; max: number }
    y_alt?: { min: number; max: number }
    stim?: { min: number; max: number }
  }) => void
  getSeriesAxisRange: (group: number, series: number) => {
    x?: { min: number; max: number }
    y?: { min: number; max: number }
    y_alt?: { min: number; max: number }
    stim?: { min: number; max: number }
  } | null
  // Trace visibility controls — per-series.
  getVisibleTraces: (group: number, series: number) => number[]
  setVisibleTraces: (group: number, series: number, indices: number[]) => void
  toggleTraceVisible: (group: number, series: number, index: number) => void
  /** Fetch/drop `additionalTraces` entries so they match `visibleTraces`
   *  for the currently-viewed series. Idempotent; safe to call on every
   *  sweep/viewport/filter change. */
  syncAdditionalTraces: () => Promise<void>
  openFile: (filePath: string, options?: Record<string, unknown>) => Promise<void>
  /** Close the currently-active recording across the whole app:
   *  hits the backend's ``/api/files/close`` so its
   *  ``_current_recording`` is reset, clears every per-recording
   *  store slice in the calling window, and broadcasts ``file-close``
   *  so other windows (main tree, analysis windows) clear theirs too.
   *  Used by the batch window before kicking off a multi-file run, so
   *  no window holds a stale file reference that batch could write
   *  analyses into. */
  closeFile: () => Promise<void>
  selectSweep: (group: number, series: number, sweep: number, trace?: number) => Promise<void>
  setCursors: (cursors: Partial<CursorPositions>) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  addResult: (result: MeasurementResult) => void
  clearResults: () => void

  // Overlay / average
  toggleOverlay: () => void
  toggleAverage: () => void
  addOverlaySweep: (sweep: number) => Promise<void>
  removeOverlaySweep: (sweep: number) => void
  clearOverlays: () => void
  overlayAllSweeps: () => Promise<void>
  loadAverageTrace: () => Promise<void>

  // Excluded-sweep controls (see `excludedSweeps` slice above).
  toggleSweepExcluded: (group: number, series: number, sweep: number) => void
  clearExcludedSweeps: (group: number, series: number) => void
  isSweepExcluded: (group: number, series: number, sweep: number) => boolean
  /** Returns the list of sweep indices in [0, totalSweeps) that are NOT
   *  in the excluded set for (group, series). Use this wherever a
   *  "run on all sweeps" call would previously pass null / undefined —
   *  send the explicit complement list instead so excluded sweeps
   *  never reach the backend. */
  includedSweepsFor: (group: number, series: number, totalSweeps: number) => number[]
  /** Same but applied to a caller-supplied list (e.g. a user-selected
   *  range). Filters out any entries that are in the excluded set. */
  filterExcludedSweeps: (group: number, series: number, sweeps: number[]) => number[]

  // Multi-selection in the tree (session-only, per series).
  handleSweepSelection: (
    group: number, series: number, sweep: number,
    modifier: 'shift' | 'cmd' | 'none',
  ) => void
  clearSweepSelection: (group: number, series: number) => void
  isSweepSelected: (group: number, series: number, sweep: number) => boolean

  // Averaged virtual-sweep actions.
  createAveragedSweep: (
    group: number, series: number, trace: number,
    sweepIndices: number[], label?: string,
  ) => Promise<string | null>
  deleteAveragedSweep: (group: number, series: number, id: string) => void
  renameAveragedSweep: (group: number, series: number, id: string, label: string) => void
  /** Navigate to an averaged sweep — puts its values into the
   *  TraceViewer and flips currentAveragedSweep to track it. */
  selectAveragedSweep: (group: number, series: number, id: string) => void

  // Resistance analysis actions
  runResistanceOnSweep: (vStep: number) => Promise<void>
  runResistanceOnAverage: (vStep: number, sweepIndices: number[] | null) => Promise<void>
  clearResistanceResult: () => void
  setResistanceForm: (patch: Partial<ResistanceFormState>) => void

  /** Patch the active recording's metadata. Pass undefined values to
   *  delete a field. Auto-saved through the existing sidecar
   *  debounce; no explicit save needed. */
  setRecordingMeta: (patch: Partial<SidecarMeta>) => void

  /** Replace the active recording's scale overrides. Pushes the full
   *  map to the backend (``/api/files/apply_overrides``), updates
   *  the in-store ``recording`` from the response (so per-channel
   *  ``units`` reflect the override), broadcasts the new map, and
   *  triggers the sidecar auto-save. Pass ``{}`` to clear all. */
  setScaleOverrides: (overrides: ScaleOverrides) => Promise<void>
  /** Replace a single series' tag array (group is HEKA group, not
   *  experimental group). Pass an empty array to clear. */
  setSeriesTags: (group: number, series: number, tags: string[]) => void

  // Field-burst actions
  /** Run on a single sweep. Result REPLACES any existing bursts for that
   *  (group, series, sweepIndex) triple and APPENDS for new sweep indices. */
  runFieldBurstsOnSweep: (
    group: number, series: number, sweep: number,
    channel: number, params: FieldBurstsParams,
  ) => Promise<void>
  /** Run across every sweep in a series. REPLACES the series's burst table
   *  wholesale. */
  runFieldBurstsOnSeries: (
    group: number, series: number,
    channel: number, params: FieldBurstsParams,
  ) => Promise<void>
  /** Discard bursts for a specific series, or all series if omitted. */
  clearFieldBursts: (group?: number, series?: number) => void
  /** Set the currently-selected burst within a series (for mini-viewer). */
  selectFieldBurst: (group: number, series: number, idx: number | null) => void
  /** Dump the union of all detected bursts across all series to CSV.
   *  Includes a ``train_id`` column derived live from the current
   *  ``trainParams.bursts`` settings (empty when grouping is off for
   *  that series or the burst doesn't belong to a qualifying train). */
  exportFieldBurstsCSV: () => Promise<void>
  /** Dump the per-train summary across all series to CSV — one row
   *  per train, with start/end/duration/n_bursts/mean IEI/intra
   *  freq. Only runs for series with grouping enabled. */
  exportFieldBurstTrainsCSV: () => Promise<void>
  /** Append a manually-measured burst (from a left-click in the sweep
   *  viewer). The burst is pre-populated by the backend; we just
   *  splice it into the current list, sort, and broadcast. */
  addManualBurst: (group: number, series: number, burst: BurstRecord) => void
  /** Remove the burst whose span contains `timeS` on the given sweep.
   *  If multiple match, removes the one whose peak is closest in time.
   *  No-op when nothing matches. */
  removeBurstAt: (group: number, series: number, sweep: number, timeS: number) => void
  /** Store the burst-detection form state for a given series so the
   *  window can restore it after close/reopen. Broadcast + persisted. */
  setBurstFormParams: (group: number, series: number, params: FieldBurstsParams) => void

  /** Train-grouping form state for one of the three modules that can
   *  cluster their detected events into trains. Broadcast + persisted
   *  in the sidecar; results are not stored, only the params. */
  setTrainParams: (
    module: TrainModule,
    group: number,
    series: number,
    params: TrainParams,
  ) => void

  // Field PSP actions
  runFPsp: (
    group: number, series: number, channel: number,
    params: {
      /** Which tab the run was triggered from. Defaults to 'ltp' for
       *  back-compat. The mode determines which slot the result lands
       *  in (keyed `${group}:${series}:${mode}`) and how the window
       *  renders the output. */
      mode?: FPspMode
      /** Optional second (LTP) series in the same group. */
      seriesB?: number | null
      baselineStartS: number
      baselineEndS: number
      volleyStartS: number
      volleyEndS: number
      fepspStartS: number
      fepspEndS: number
      method: FPspMeasurementMethod
      slopeLowPct: number
      slopeHighPct: number
      peakDirection: FPspPeakDirection
      avgN: number
      sweepIndices?: number[] | null
      appendToExisting?: boolean
      /** Pre-detection filter applied per sweep before averaging. */
      filterEnabled?: boolean
      filterType?: 'lowpass' | 'highpass' | 'bandpass'
      filterLow?: number
      filterHigh?: number
      filterOrder?: number
      /** I-O mode only — stored on the entry for display. */
      ioInitialIntensity?: number
      ioIntensityStep?: number
      ioUnit?: string
      ioMetric?: 'slope' | 'amplitude'
      /** PPR mode only — 2nd response cursor windows. When mode is
       *  'ppr' the run fires two parallel `/api/fpsp/run` requests
       *  (one with V1/F1, one with V2/F2) and merges the points
       *  frontend-side into a single entry with ratios computed. */
      volley2StartS?: number
      volley2EndS?: number
      fepsp2StartS?: number
      fepsp2EndS?: number
      pprIsiMs?: number
      pprMetric?: 'amp' | 'slope'
    },
  ) => Promise<void>
  clearFPsp: (mode: FPspMode, group?: number, series?: number) => void
  selectFPspPoint: (mode: FPspMode, group: number, series: number, idx: number | null) => void
  setFPspTimeAxis: (mode: FPspMode, group: number, series: number, axis: FPspTimeAxis) => void
  setFPspNormalize: (mode: FPspMode, group: number, series: number, normalize: boolean) => void
  setFPspNormBaseline: (mode: FPspMode, group: number, series: number, from: number, to: number) => void
  exportFPspCSV: () => Promise<void>

  // Action Potentials actions
  /** Run the full AP pipeline (detection + counting + optional kinetics)
   *  on the given series. Replaces any prior result for that
   *  (group, series). Manual edits + form params get echoed onto the
   *  resulting entry so closing/reopening the window restores them. */
  runAP: (
    group: number, series: number, trace: number,
    /** Im source config — Auto (reconstruct from stimulus protocol) or
     *  Manual (start/step/window). Matches the IV window's Manual Im
     *  semantics so both use the same shape on the wire. */
    imSource: {
      manualEnabled: boolean
      manualStartS: number
      manualEndS: number
      manualStartPA: number
      manualStepPA: number
    },
    sweepIndices: number[] | null,
    detection: APDetectionParams,
    kinetics: APKineticsParams,
    rheobaseMode: APRheobaseMode,
    rampParams: APRampParams | null,
    manualEdits: APManualEdits,
    measureKinetics: boolean,
  ) => Promise<void>
  /** Drop AP results for one series (or all if both are null). */
  clearAP: (group?: number, series?: number) => void
  /** Highlight one spike row in the per-spike table + on the mini-viewer. */
  selectAPSpike: (group: number, series: number, idx: number | null) => void
  /** Add a manual spike at ``timeS`` (within ``sweep``) for the given
   *  series. Inserts an optimistic ``APPoint`` placeholder (manual:
   *  true, kinetics blank) so the marker shows up immediately, then
   *  calls ``/api/ap/measure_one`` to fill in threshold / amplitude /
   *  rise / decay / FWHM / fAHP / mAHP / max-slope using the same
   *  math the auto-detector uses. Falls back to the placeholder if
   *  the measurement endpoint can't fit a spike at the click point.
   *  Always also pushes the click time into ``manualEdits.added`` so
   *  the next Run sees the same edit. */
  addManualAPSpike: (group: number, series: number, sweep: number, timeS: number) => Promise<void>
  /** Remove the spike on ``sweep`` whose peak is closest to ``timeS``
   *  (within a tolerance). Updates ``manualEdits`` so the change
   *  survives the next Run, and prunes the spike from ``perSweep`` /
   *  ``perSpike`` so the marker disappears immediately. */
  removeManualAPSpikeAt: (group: number, series: number, sweep: number, timeS: number) => void

  // Event-detection actions — see backend/api/events.py for the
  // endpoint behavior. Templates live in the global library;
  // analyses (detected events + params) live per-(group:series).
  runEvents: (
    group: number, series: number, channel: number, sweep: number,
    params: EventsParams,
    template: EventsTemplate | null,
    /** Optional progress callback. Called once per sweep with a
     *  fraction in [0, 1]. Used by the EventDetectionWindow to
     *  render a progress fill on its RUN button — multi-sweep
     *  detections can take 30-60s on large recordings and the
     *  user wants to see things moving. */
    onProgress?: (fraction: number) => void,
  ) => Promise<void>
  /** Fit a biexponential to (t_start_s, t_end_s) in the specified sweep.
   *  Returns the fitted coefficients + the data + the fit curve so the
   *  Template Generator dialog can plot them overlaid. */
  fitEventsTemplate: (
    group: number, series: number, channel: number, sweep: number,
    tStartS: number, tEndS: number,
    initialRiseMs?: number, initialDecayMs?: number,
    direction?: 'auto' | 'negative' | 'positive',
    filter?: { enabled: boolean; type: string; low: number; high: number; order: number } | null,
  ) => Promise<{
    b0: number; b1: number; tauRiseMs: number; tauDecayMs: number
    rSquared: number; timeS: number[]; fitValues: number[]
    regionValues: number[]; regionTStartS: number
  }>
  /** Compute RMS + mean of a user-picked quiet region — used to seed
   *  the thresholding detector's `baseline ± n × rms` threshold. */
  computeEventsRms: (
    group: number, series: number, channel: number, sweep: number,
    tStartS: number, tEndS: number,
    filter?: { enabled: boolean; type: string; low: number; high: number; order: number } | null,
  ) => Promise<{ rms: number; baselineMean: number; nSamples: number }>
  /** On-demand fetch of the correlation or deconvolution trace for a
   *  viewport window — full sampling-rate resolution within the
   *  requested slice. Used by the viewer's overlay series. */
  fetchEventsDetectionMeasure: (
    group: number, series: number, channel: number, sweep: number,
    method: 'template_correlation' | 'template_deconvolution',
    template: EventsTemplate,
    cutoff: number,
    direction: 'negative' | 'positive',
    deconvLowHz: number, deconvHighHz: number,
    tStartS: number, tEndS: number,
    filter?: { enabled: boolean; type: string; low: number; high: number; order: number } | null,
  ) => Promise<EventsDetectionMeasure>
  /** Given the current detection events, average them and fit a fresh
   *  biexp to the average. Returns the averaged event + the fit so the
   *  Refine Template dialog can display them. */
  refineEventsTemplate: (
    group: number, series: number, channel: number, sweep: number,
    events: EventRow[],
    align: 'peak' | 'foot' | 'rise_halfwidth',
    windowBeforeMs: number, windowAfterMs: number,
    direction: 'negative' | 'positive',
  ) => Promise<{
    nAveraged: number
    averageTimeS: number[]
    averageValues: number[]
    footSampleIdx: number
    fit: {
      b0: number; b1: number; tauRiseMs: number; tauDecayMs: number
      rSquared: number; fitTimeS: number[]; fitValues: number[]
    }
  }>
  /** Drop events results for one series (or all when group/series null). */
  clearEvents: (group?: number, series?: number) => void
  /** Highlight one event row in the results table + on the viewer. */
  selectEvent: (group: number, series: number, idx: number | null) => void
  /** Add a manual event at the given time — inserted into manualEdits
   *  so it persists across re-runs. Re-runs detection afterwards so
   *  the backend can snap the added time to the local extremum. */
  addManualEvent: (group: number, series: number, timeS: number) => Promise<void>
  /** Remove an event (by table index). Appends its peak time to the
   *  manual-removed list so re-runs honor the deletion. */
  removeEvent: (group: number, series: number, idx: number) => Promise<void>
  /** Replace one event row in-place — Edit-Kinetics drag mode. The
   *  caller has already round-tripped the new row through the backend
   *  (with foot / decay-endpoint overrides applied); this action just
   *  splices it in and broadcasts. The event's index is preserved so
   *  navigation / selection stays put. */
  replaceEvent: (group: number, series: number, idx: number, row: EventRow) => void
  /** Assign or clear the curation group for one event. ``groupNum``
   *  must be 1–5 or null (clear). Round-trips via the .tracer
   *  sidecar like any other event field. */
  setEventGroup: (group: number, series: number, idx: number, groupNum: number | null) => void

  // Template library actions
  saveEventsTemplate: (template: EventsTemplate) => void
  deleteEventsTemplate: (id: string) => void
  selectEventsTemplate: (id: string | null) => void

  // I-V curve actions
  runIVCurve: (
    group: number, series: number, channel: number,
    params: {
      /** Cursor windows in seconds from sweep start. */
      baselineStartS: number
      baselineEndS: number
      peakStartS: number
      peakEndS: number
      /** Zero-based sweep indices to run on. null = all sweeps. */
      sweepIndices?: number[] | null
      /** When true, merge the returned points into the existing table
       *  (replacing any rows with matching sweepIndex). Used by "single
       *  sweep" mode. When false, the table is replaced outright. */
      appendToExisting?: boolean
      /** When true, the backend skips the .pgf stimulus lookup and
       *  reconstructs Im per sweep from the four manual params below. */
      manualImEnabled?: boolean
      manualImStartS?: number
      manualImEndS?: number
      manualImStartPA?: number
      manualImStepPA?: number
      /** Form-state echoed onto the stored ``IVCurveData`` so a close-
       *  and-reopen cycle restores the user's exact run setup (the
       *  Im-source widget AND the run-scope dropdown). Optional —
       *  pre-stamp callers can omit and the action falls back to the
       *  existing entry's values when re-running. */
      runMode?: 'all' | 'range' | 'one'
      sweepFrom?: number
      sweepTo?: number
      sweepOne?: number
    },
  ) => Promise<void>
  clearIVCurve: (group?: number, series?: number) => void
  selectIVPoint: (group: number, series: number, idx: number | null) => void
  setIVResponseMetric: (group: number, series: number, metric: IVResponseMetric) => void
  exportIVCSV: () => Promise<void>
}

const OVERLAY_COLORS = [
  '#64b5f6', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
  '#4dd0e1', '#aed581', '#ffd54f', '#ff8a65', '#ce93d8',
  '#4fc3f7', '#a5d6a7', '#fff176', '#ef9a9a', '#b39ddb',
]

/** Build the query string for trace data, including filter params if enabled.
 *
 * If ``viewport`` is provided, the backend slices to [start, end] seconds and
 * decimates to at most ``maxPoints`` samples. If ``viewport`` is null, the full
 * trace is returned (decimated to maxPoints if > 0).
 *
 * When ``zeroOffset`` is true the backend computes the baseline from the first
 * ~3 ms of the FULL sweep (post-filter, pre-slice) and subtracts it before
 * returning — so the offset is always per-sweep, not per-viewport-window.
 */
function traceDataUrl(
  group: number, series: number, sweep: number, trace: number,
  filter: FilterState,
  viewport: Viewport | null = null,
  maxPoints: number = 0,
  zeroOffset: boolean = false,
): string {
  let url = `/api/traces/data?group=${group}&series=${series}&sweep=${sweep}&trace=${trace}&max_points=${maxPoints}`
  if (viewport) {
    url += `&t_start=${viewport.start}&t_end=${viewport.end}`
  }
  if (filter.enabled) {
    url += `&filter_type=${filter.type}`
    if (filter.type === 'lowpass' || filter.type === 'bandpass') {
      url += `&filter_high=${filter.highCutoff}`
    }
    if (filter.type === 'highpass' || filter.type === 'bandpass') {
      url += `&filter_low=${filter.lowCutoff}`
    }
    url += `&filter_order=${filter.order}`
  }
  if (zeroOffset) {
    url += `&zero_offset=true`
  }
  return url
}

async function apiFetch(backendUrl: string, path: string, options?: RequestInit) {
  const resp = await fetch(`${backendUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(err.detail || resp.statusText)
  }
  return resp.json()
}

export const useAppStore = create<AppState>((set, get) => ({
  backendUrl: '',
  backendReady: false,

  recording: null,
  currentGroup: 0,
  currentSeries: 0,
  currentSweep: 0,
  currentTrace: 0,
  recentFiles: ((): string[] => {
    try {
      const saved = (window as any).electronAPI?.syncPreferences?.recentFiles
      if (Array.isArray(saved)) return saved.filter((s) => typeof s === 'string').slice(0, 10)
    } catch { /* ignore */ }
    return []
  })(),

  traceData: null,
  overlayEntries: [],
  averageTrace: null,
  showOverlay: false,
  showAverage: false,
  additionalTraces: {},
  visibleTraces: {},

  cursors: {
    baselineStart: 0,
    baselineEnd: 0.01,
    peakStart: 0.01,
    peakEnd: 0.05,
    fitStart: 0.01,
    fitEnd: 0.1,
  },

  sweepStimulusSegments: null,
  sweepStimulusUnit: '',

  cursorVisibility: { baseline: true, peak: true, fit: true },
  scaleOverrides: {},
  filter: { enabled: false, type: 'bandpass', lowCutoff: 1, highCutoff: 50, order: 4 },
  filtersByChannel: {},
  filtersBySeries: {},
  zeroOffset: false,
  currentZeroOffset: 0,
  viewport: null,
  sweepDuration: 0,
  viewportMaxPoints: 5000,
  seriesAxisRanges: {},

  results: [],
  resistanceResult: null,
  resistanceResults: {},
  resistanceForm: {
    vStep: 5,
    nExp: 2,
    fitDurationMs: 5.0,
    runMode: 'all',
    avgFrom: 1,
    avgTo: 1,
    sweepOne: 1,
  },
  recordingMeta: null,
  recordingMetaReady: false,
  fieldBursts: {},
  burstFormParams: {},
  trainParams: defaultTrainParamsBundle(),
  ivCurves: {},
  fpspCurves: {},
  cursorAnalyses: {},
  apAnalyses: {},
  eventsAnalyses: {},
  pairedAnalyses: {},
  pairedForm: defaultPairedForm(),
  eventsTemplates: (() => {
    // Default templates — one EPSC, one IPSC — seeded from Jonas 1993
    // defaults (τ_rise 0.5 ms, τ_decay 5 ms). `selectedId` points at
    // the EPSC by default. User-saved templates are merged in from
    // Electron prefs on mount below.
    const epsc: EventsTemplate = {
      id: 'default-epsc',
      name: 'Default EPSC',
      b0: 0, b1: -30,
      tauRiseMs: 0.5, tauDecayMs: 5.0,
      widthMs: 30, direction: 'negative',
    }
    const ipsc: EventsTemplate = {
      id: 'default-ipsc',
      name: 'Default IPSC (slow)',
      b0: 0, b1: 30,
      tauRiseMs: 1.0, tauDecayMs: 15.0,
      widthMs: 80, direction: 'positive',
    }
    const defaults = {
      selectedId: 'default-epsc',
      entries: { [epsc.id]: epsc, [ipsc.id]: ipsc } as Record<string, EventsTemplate>,
    }
    try {
      const saved = (window as any).electronAPI?.syncPreferences?.eventsTemplates
      if (saved && typeof saved === 'object') {
        return {
          selectedId: typeof saved.selectedId === 'string' ? saved.selectedId : defaults.selectedId,
          entries: { ...defaults.entries, ...(saved.entries ?? {}) },
        }
      }
    } catch { /* ignore */ }
    return defaults
  })(),
  excludedSweeps: {},
  selectedSweeps: {},
  averagedSweeps: {},
  currentAveragedSweep: null,
  cursorWindowUI: (() => {
    const defaults: CursorWindowUI = {
      plotHeight: 220,
      leftPanelWidth: 340,
      measurementColumns: [
        'sweep', 'slot', 'baseline', 'peak', 'amplitude', 'peak_time',
        'rise_time_20_80', 'half_width', 'area',
      ],
      fitColumns: ['sweep', 'slot', 'fit_function', 'r_squared', 'params'],
      activeTab: 'measurements',
    }
    try {
      const saved = (window as any).electronAPI?.syncPreferences?.cursorWindowUI
      if (saved && typeof saved === 'object') return { ...defaults, ...saved }
    } catch { /* ignore */ }
    return defaults
  })(),
  zoomMode: false,
  // Cursors default OFF so the main viewer stays clean on first open;
  // the user turns them on from the right panel when they need them.
  showCursors: false,
  showBurstMarkers: true,
  showEventMarkers: true,
  showCoordinates: true,
  loading: false,
  error: null,

  toggleZoomMode: () => set((s) => ({ zoomMode: !s.zoomMode })),
  toggleCursors: () => set((s) => ({ showCursors: !s.showCursors })),

  setPairedAnalysis: (group, series, data) => {
    const key = `${group}:${series}`
    set((s) => ({ pairedAnalyses: { ...s.pairedAnalyses, [key]: data } }))
    _broadcastPaired(get().pairedAnalyses, get().pairedForm)
  },
  clearPairedAnalysis: (group, series) => {
    const key = `${group}:${series}`
    set((s) => {
      const { [key]: _dropped, ...rest } = s.pairedAnalyses
      return { pairedAnalyses: rest }
    })
    _broadcastPaired(get().pairedAnalyses, get().pairedForm)
  },
  setPairedForm: (form) => {
    set({ pairedForm: form })
    _broadcastPaired(get().pairedAnalyses, get().pairedForm)
  },
  runPaired: async (group, series, preTrace, postTrace, params) => {
    const url = `${get().backendUrl}/api/paired/run`
    const body: any = {
      group, series,
      pre_trace: preTrace, post_trace: postTrace,
      sweeps: params.sweeps ?? null,
      pre_mode: params.preMode,
      pre_params: params.preParams,
      post_params: {
        pre_ms: params.postParams.preMs,
        post_ms: params.postParams.postMs,
        baseline_ms: params.postParams.baselineMs,
        peak_direction: params.postParams.peakDirection,
        filter_enabled: params.postParams.filterEnabled,
        filter_type: params.postParams.filterType,
        filter_low: params.postParams.filterLow,
        filter_high: params.postParams.filterHigh,
        filter_order: params.postParams.filterOrder,
        post_search_start_s: params.postSearchStartS ?? null,
        post_search_end_s: params.postSearchEndS ?? null,
      },
      failure_params: {
        rule: params.failureParams.rule,
        k_sd: params.failureParams.kSd,
        absolute: params.failureParams.absolute,
      },
      latency_params: {
        rule: params.latencyParams.rule,
        fraction: params.latencyParams.fraction,
      },
      manual_edits: params.manualEdits ? {
        added: params.manualEdits.added,
        removed: params.manualEdits.removed,
        post_failed: params.manualEdits.postFailed ?? {},
      } : null,
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText)
      throw new Error(`paired run failed: ${resp.status} ${text}`)
    }
    const d = await resp.json()
    const mapStaIn = (s: any): PairedSta | null => {
      if (!s) return null
      return {
        time: s.time, mean: s.mean, sem: s.sem, n: s.n,
        traces: s.traces, traceSuccess: s.trace_success,
        fit: s.fit ? {
          baseline: s.fit.baseline, amplitude: s.fit.amplitude,
          peakTS: s.fit.peak_t_s, peakV: s.fit.peak_v,
          tauDecayMs: s.fit.tau_decay_ms, r2: s.fit.r2,
          fitCurve: s.fit.fit_curve, fitCurveMask: s.fit.fit_curve_mask,
        } : undefined,
      }
    }
    const data: PairedData = {
      group, series, preTrace, postTrace,
      sweeps: Array.isArray(body.sweeps) ? body.sweeps : [],
      samplingRate: d.sampling_rate,
      preMode: params.preMode,
      preParams: params.preParams,
      postParams: params.postParams,
      failureParams: params.failureParams,
      latencyParams: params.latencyParams,
      manualEdits: params.manualEdits ?? { added: {}, removed: {} },
      perTrial: (d.per_trial as any[]).map((t: any): PairedTrial => ({
        sweep: t.sweep,
        trialIdx: t.trial_idx,
        preTS: t.pre_t_s,
        preAmp: t.pre_amp,
        baselineMean: t.baseline_mean,
        baselineSd: t.baseline_sd,
        postPeak: t.post_peak,
        postPeakTS: t.post_peak_t_s,
        amplitude: t.amplitude,
        success: t.success,
        latencyMs: t.latency_ms,
        riseMs: t.rise_ms,
        decayMs: t.decay_ms,
        decayTauMs: t.decay_tau_ms,
        halfWidthMs: t.half_width_ms,
        truncated: t.truncated,
        manual: t.manual,
        postManualFailure: t.post_manual_failure,
      })),
      perSweepSummary: (d.per_sweep_summary as any[]).map((s: any) => ({
        sweep: s.sweep, nTrials: s.n_trials, nSuccess: s.n_success,
        nFailures: s.n_failures, ppr21: s.ppr_2_1,
      })),
      seriesSummary: {
        nTrials: d.series_summary.n_trials,
        nSuccess: d.series_summary.n_success,
        nFailures: d.series_summary.n_failures,
        failureRate: d.series_summary.failure_rate,
        meanAmplitude: d.series_summary.mean_amplitude,
        meanAmplitudeZeroed: d.series_summary.mean_amplitude_zeroed,
        potency: d.series_summary.potency,
        cvSuccess: d.series_summary.cv_success,
        invCv2: d.series_summary.inv_cv2,
        latencyMeanMs: d.series_summary.latency_mean_ms,
        latencySdMs: d.series_summary.latency_sd_ms,
        pprN1: (d.series_summary.ppr_n1 as any[]).map((p) => ({
          n: p.n, ratio: p.ratio, nSweeps: p.n_sweeps,
        })),
      },
      staAll: mapStaIn(d.sta_all),
      staSuccess: mapStaIn(d.sta_success),
      staFailure: mapStaIn(d.sta_failure),
      selectedTrialIdx: null,
      postSearchStartS: params.postSearchStartS ?? null,
      postSearchEndS: params.postSearchEndS ?? null,
    }
    get().setPairedAnalysis(group, series, data)
  },
  toggleBurstMarkers: () => set((s) => ({ showBurstMarkers: !s.showBurstMarkers })),
  toggleEventMarkers: () => set((s) => ({ showEventMarkers: !s.showEventMarkers })),
  toggleCoordinates: () => set((s) => ({ showCoordinates: !s.showCoordinates })),

  resetCursorsToDefaults: () => {
    const { traceData, sweepDuration, viewport } = get()
    if (!traceData) return
    // In continuous / viewport mode, place cursors relative to the CURRENTLY
    // VISIBLE window so they always land on screen when the user clicks reset.
    // Otherwise use the full sweep duration.
    const start = viewport ? viewport.start : 0
    const end = viewport
      ? viewport.end
      : sweepDuration > 0
        ? sweepDuration
        : traceData.values.length / traceData.samplingRate
    const span = end - start
    set({
      cursors: {
        baselineStart: start,
        baselineEnd: start + 0.2 * span,
        peakStart: start + 0.3 * span,
        peakEnd: start + 0.5 * span,
        fitStart: start + 0.6 * span,
        fitEnd: start + 0.8 * span,
      },
    })
  },

  setCursorVisibility: (v) =>
    set((s) => ({ cursorVisibility: { ...s.cursorVisibility, ...v } })),

  setFilterFor: (channel, patch) => {
    set((s) => {
      const next = { ...s.filtersByChannel }
      if (patch === null) {
        delete next[channel]
      } else {
        const cur = next[channel] ?? s.filter
        next[channel] = { ...cur, ...patch }
      }
      // Per-channel filter changes also belong to the current series
      // — capture them in the per-series sidecar slot alongside the
      // default filter so a round-trip through series-select restores
      // them.
      const key = `${s.currentGroup}:${s.currentSeries}`
      const filtersBySeries = {
        ...s.filtersBySeries,
        [key]: { filter: s.filter, filtersByChannel: next },
      }
      return { filtersByChannel: next, filtersBySeries }
    })
    // Trigger a refetch for the affected channel — the primary
    // goes through ``refetchViewport``; additional channels are
    // dropped from ``additionalTraces`` so ``syncAdditionalTraces``
    // (which only fetches missing entries) reissues with the new
    // filter.
    const st = get()
    if (!st.backendUrl) return
    if (channel === st.currentTrace) {
      if (st.traceData) st.refetchViewport().catch(() => { /* ignore */ })
    } else {
      const next = { ...st.additionalTraces }
      if (channel in next) {
        delete next[channel]
        set({ additionalTraces: next })
      }
      st.syncAdditionalTraces().catch(() => { /* ignore */ })
    }
  },
  getFilterForChannel: (channel) => {
    const s = get()
    return s.filtersByChannel[channel] ?? s.filter
  },
  setFilter: (f) => {
    set((s) => {
      const filter = { ...s.filter, ...f }
      // Persist to the per-series sidecar slot for the active series so
      // navigating away and back restores the same filter state.
      // Snapshot the per-channel overrides too — restoring just the
      // default would leave stale per-channel slots from another series.
      const key = `${s.currentGroup}:${s.currentSeries}`
      const filtersBySeries = {
        ...s.filtersBySeries,
        [key]: { filter, filtersByChannel: s.filtersByChannel },
      }
      return { filter, filtersBySeries }
    })
    // Re-fetch the current trace with updated filter params (respecting viewport).
    const st = get()
    if (!st.backendUrl) return
    if (st.traceData) st.refetchViewport().catch(() => { /* ignore */ })
    // Default filter affects every additional channel that has no
    // per-channel override — drop their cached data so the next
    // syncAdditionalTraces reissues with the new filter.
    const drops = Object.keys(st.additionalTraces)
      .map(Number)
      .filter((ch) => st.filtersByChannel[ch] == null)
    if (drops.length > 0) {
      const next = { ...st.additionalTraces }
      for (const ch of drops) delete next[ch]
      set({ additionalTraces: next })
      st.syncAdditionalTraces().catch(() => { /* ignore */ })
    }
  },

  applyFilter: async () => {
    const state = get()
    if (state.backendUrl) {
      state.selectSweep(state.currentGroup, state.currentSeries, state.currentSweep, state.currentTrace)
    }
  },

  toggleZeroOffset: () => {
    set((s) => ({ zeroOffset: !s.zeroOffset }))
    // Offset is now computed server-side, so we have to refetch to get the
    // values with/without the baseline subtracted.
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  // ---- Viewport actions ----

  setViewport: (viewport) => {
    // Clamp to the current sweep duration so zoom / Apply / drag-zoom can't
    // push the store into an out-of-bounds state. null means Full mode, left
    // untouched.
    let clamped = viewport
    if (viewport != null) {
      const { sweepDuration } = get()
      if (sweepDuration > 0) {
        let start = Math.max(0, Math.min(viewport.start, sweepDuration))
        let end = Math.max(start, Math.min(viewport.end, sweepDuration))
        // If the window collapsed to a point (zoom-in past data), keep at
        // least a tiny slice so the plot has something to render.
        if (end - start < 1e-6) {
          end = Math.min(sweepDuration, start + Math.max(1e-3, sweepDuration * 1e-4))
          start = Math.max(0, end - 1e-3)
        }
        clamped = { start, end }
      }
    }
    set({ viewport: clamped })
    // Fire-and-forget refetch with the new viewport
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  setViewportWindowSize: (seconds) => {
    const { viewport, sweepDuration } = get()
    if (seconds === null || sweepDuration <= 0) {
      set({ viewport: null })
      get().refetchViewport().catch(() => { /* ignore */ })
      return
    }
    // Preserve current start; clamp end to duration; if window would push past
    // the end, slide it back.
    const start = viewport?.start ?? 0
    let newStart = start
    let newEnd = start + seconds
    if (newEnd > sweepDuration) {
      newEnd = sweepDuration
      newStart = Math.max(0, newEnd - seconds)
    }
    set({ viewport: { start: newStart, end: newEnd } })
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  scrollViewport: (deltaSeconds) => {
    const { viewport, sweepDuration } = get()
    if (!viewport) return
    const len = viewport.end - viewport.start
    let newStart = Math.max(0, Math.min(sweepDuration - len, viewport.start + deltaSeconds))
    if (!isFinite(newStart)) newStart = 0
    set({ viewport: { start: newStart, end: newStart + len } })
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  setViewportStart: (start) => {
    const { viewport, sweepDuration } = get()
    if (!viewport) return
    const len = viewport.end - viewport.start
    const clamped = Math.max(0, Math.min(Math.max(0, sweepDuration - len), start))
    set({ viewport: { start: clamped, end: clamped + len } })
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  setViewportMaxPoints: (n) => {
    const prev = get().viewportMaxPoints
    const clamped = Math.max(500, Math.floor(n))
    if (clamped === prev) return
    set({ viewportMaxPoints: clamped })
  },

  refetchViewport: async () => {
    const {
      backendUrl, currentGroup, currentSeries, currentSweep, currentTrace,
      viewport, viewportMaxPoints, zeroOffset,
    } = get()
    if (!backendUrl) return
    const filter = get().getFilterForChannel(currentTrace)
    // Increment the sequence — when the response comes back we verify that
    // no newer fetch has been issued meanwhile. This prevents stale slider-
    // drag responses from clobbering the current view.
    const mySeq = ++_viewportFetchSeq
    try {
      const url = traceDataUrl(
        currentGroup, currentSeries, currentSweep, currentTrace,
        filter, viewport, viewportMaxPoints, zeroOffset,
      )
      const data = await apiFetch(backendUrl, url)
      if (mySeq !== _viewportFetchSeq) return  // superseded — drop
      set((s) => ({
        traceData: {
          time: new Float64Array(data.time),
          values: new Float64Array(data.values),
          samplingRate: data.sampling_rate,
          units: data.units,
          label: data.label,
        },
        sweepDuration: data.duration ?? s.sweepDuration,
        currentZeroOffset: Number(data.zero_offset ?? 0),
      }))
      // Keep additional channels in sync with the new viewport/filter.
      get().syncAdditionalTraces().catch(() => { /* ignore */ })
    } catch { /* ignore transient errors */ }
  },

  saveSeriesAxisRange: (group, series, ranges) => {
    // Key includes the recording's file path so file-boundary
    // collisions can't poison a fresh file's first series with the
    // previous file's saved range. Without this, opening a second
    // file whose first series shared indices with the previous
    // file's last series would suppress auto-fit.
    const fp = get().recording?.filePath ?? '__none__'
    const key = `${fp}|${group}:${series}`
    set((s) => ({
      seriesAxisRanges: { ...s.seriesAxisRanges, [key]: ranges },
    }))
  },

  getSeriesAxisRange: (group, series) => {
    const fp = get().recording?.filePath ?? '__none__'
    const key = `${fp}|${group}:${series}`
    return get().seriesAxisRanges[key] ?? null
  },

  // ---- Trace visibility ----

  getVisibleTraces: (group, series) => {
    // Pure read — returns the materialized value or a stable empty array.
    // `selectSweep` materializes defaults for a series on first visit so
    // consumers in render paths get a stable reference.
    const key = `${group}:${series}`
    return get().visibleTraces[key] ?? EMPTY_VISIBLE_TRACES
  },

  setVisibleTraces: (group, series, indices) => {
    const key = `${group}:${series}`
    // Dedupe and sort: recorded channels in natural order, stimulus sentinel at end.
    const recorded = Array.from(new Set(indices.filter((i) => i >= 0))).sort((a, b) => a - b)
    const withStim = indices.includes(STIMULUS_TRACE_INDEX)
      ? [...recorded, STIMULUS_TRACE_INDEX]
      : recorded
    set((s) => ({ visibleTraces: { ...s.visibleTraces, [key]: withStim } }))
    // If this is the currently-viewed series, sync the fetched additional
    // channels (add newly visible, drop newly hidden).
    const { currentGroup, currentSeries } = get()
    if (group === currentGroup && series === currentSeries) {
      get().syncAdditionalTraces().catch(() => { /* ignore */ })
    }
  },

  toggleTraceVisible: (group, series, index) => {
    const current = get().getVisibleTraces(group, series)
    const next = current.includes(index)
      ? current.filter((i) => i !== index)
      : [...current, index]
    get().setVisibleTraces(group, series, next)
  },

  syncAdditionalTraces: async () => {
    // Fetch TraceData for every visible channel that isn't the primary
    // (currentTrace — already held in `traceData`). Drop any that are no
    // longer visible. Fire the fetches in parallel.
    const {
      backendUrl, currentGroup, currentSeries, currentSweep, currentTrace,
      viewport, viewportMaxPoints, zeroOffset,
    } = get()
    if (!backendUrl) return
    const visible = get().getVisibleTraces(currentGroup, currentSeries)
    const wanted = visible.filter((i) => i >= 0 && i !== currentTrace)
    const existing = get().additionalTraces
    // Drop channels no longer wanted.
    const kept: Record<number, TraceData> = {}
    for (const k of Object.keys(existing).map(Number)) {
      if (wanted.includes(k)) kept[k] = existing[k]
    }
    set({ additionalTraces: kept })
    // Fetch the missing ones in parallel.
    const toFetch = wanted.filter((i) => !(i in kept))
    if (toFetch.length === 0) return
    await Promise.all(toFetch.map(async (chIdx) => {
      try {
        // Each channel gets its own filter (see getFilterForChannel).
        const chFilter = get().getFilterForChannel(chIdx)
        const url = traceDataUrl(
          currentGroup, currentSeries, currentSweep, chIdx,
          chFilter, viewport, viewportMaxPoints, zeroOffset,
        )
        const data = await apiFetch(backendUrl, url)
        // Check still wanted before committing (user may have toggled off meanwhile).
        const stillWanted = get().getVisibleTraces(currentGroup, currentSeries).includes(chIdx)
        if (!stillWanted) return
        set((s) => ({
          additionalTraces: {
            ...s.additionalTraces,
            [chIdx]: {
              time: new Float64Array(data.time),
              values: new Float64Array(data.values),
              samplingRate: data.sampling_rate,
              units: data.units,
              label: data.label,
            },
          },
        }))
      } catch { /* ignore per-channel errors */ }
    }))
  },

  initBackend: async () => {
    // One-shot cleanup of legacy per-file analysis blobs from
    // Electron prefs. Pre-sidecar versions wrote events / bursts / AP
    // / IV / FPsp / cursor / excluded / averaged-sweep state into a
    // single big prefs JSON keyed by file path. The averaged-sweeps
    // entry alone embeds time + value arrays and could easily inflate
    // prefs to hundreds of MB. Every getPreferences / setPreferences
    // call parses + rewrites the whole file, so even after we stopped
    // writing those keys the legacy bloat still slowed every prefs
    // touch (which the toolbar / window code does dozens of times
    // per session). Strip them once at app start. Idempotent.
    void _cleanupLegacyPrefs()
    try {
      const url = window.electronAPI
        ? await window.electronAPI.getBackendUrl()
        : 'http://localhost:8321'
      set({ backendUrl: url })

      for (let i = 0; i < 60; i++) {
        try {
          await fetch(`${url}/health`)
          set({ backendReady: true })
          console.log('Backend connected at', url)
          return
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      set({ error: 'Backend failed to start' })
    } catch (err) {
      set({ error: `Backend init error: ${err}` })
    }
  },

  clearRecentFiles: () => {
    set({ recentFiles: [] })
    try {
      const api = (window as any).electronAPI
      if (api?.getPreferences && api?.setPreferences) {
        api.getPreferences().then((prefs: any) => {
          api.setPreferences({ ...(prefs ?? {}), recentFiles: [] }).catch(() => { /* ignore */ })
        }).catch(() => { /* ignore */ })
      }
    } catch { /* ignore */ }
  },

  closeFile: async () => {
    const { backendUrl, recording } = get()
    // Best-effort backend close — silently swallow failures so a
    // backend that never had a file open (rare race) doesn't block
    // the rest of the cleanup.
    if (backendUrl) {
      try {
        await apiFetch(backendUrl, '/api/files/close', { method: 'POST' })
      } catch { /* ignore */ }
    }
    set(fileCloseResetSlices() as Partial<AppState>)
    // Notify other windows so their local stores match. Each window's
    // ``onmessage`` listener is responsible for clearing its slice
    // when it sees ``file-close`` — see CursorPanel for the main
    // window's adopt-handler.
    if (recording?.filePath) {
      try {
        const ch = new BroadcastChannel('tracer-sync')
        ch.postMessage({ type: 'file-close' })
        ch.close()
      } catch { /* ignore */ }
    }
  },

  openFile: async (filePath, options) => {
    const { backendUrl } = get()
    // If there's a pending sidecar write for the CURRENT recording,
    // flush it synchronously before swapping recordings. Otherwise
    // the debounced save could race with the new file's state and
    // clobber the OLD file's sidecar with NEW data keyed to the
    // wrong filePath.
    const currentFilePath = get().recording?.filePath
    if (currentFilePath && _sidecarTimer) {
      clearTimeout(_sidecarTimer)
      _sidecarTimer = null
      try {
        await _saveSidecar(currentFilePath, get())
      } catch { /* ignore */ }
    }
    set({
      loading: true,
      error: null,
      overlayEntries: [],
      averageTrace: null,
      additionalTraces: {},
      visibleTraces: {},
      fieldBursts: {},
      burstFormParams: {},
      trainParams: defaultTrainParamsBundle(),
      ivCurves: {},
      fpspCurves: {},
      cursorAnalyses: {},
      apAnalyses: {},
      eventsAnalyses: {},
      pairedAnalyses: {},
      pairedForm: defaultPairedForm(),
      excludedSweeps: {},
      selectedSweeps: {},
      averagedSweeps: {},
      currentAveragedSweep: null,
      showOverlay: false,
      showAverage: false,
      resistanceResult: null,
      resistanceResults: {},
      resistanceForm: {
        vStep: 5, nExp: 2, fitDurationMs: 5.0,
        runMode: 'all', avgFrom: 1, avgTo: 1, sweepOne: 1,
      },
      recordingMeta: null,
      recordingMetaReady: false,
      scaleOverrides: {},
      // ``seriesAxisRanges`` is keyed by file path now, so cross-
      // file collisions are impossible — leaving previous files'
      // entries in place lets a re-open within the same session
      // restore the user's last zoom on that file.
      filtersByChannel: {},
      // Per-series filter overrides are file-scoped — wipe them on
      // open so a new recording starts with a clean slate (the
      // sidecar load below will repopulate if it has any).
      filtersBySeries: {},
    })
    try {
      const recording = await apiFetch(backendUrl, '/api/files/open', {
        method: 'POST',
        body: JSON.stringify({ file_path: filePath, options: options ?? null }),
      })
      set({
        recording,
        currentGroup: 0,
        currentSeries: 0,
        currentSweep: 0,
        currentTrace: 0,
        loading: false,
      })
      // Track recent files (most-recent first, deduped, capped at 10).
      // Persisted to Electron prefs via the small ``recentFiles`` key.
      if (recording?.filePath) {
        const prev = get().recentFiles
        const next = [recording.filePath, ...prev.filter((p) => p !== recording.filePath)].slice(0, 10)
        set({ recentFiles: next })
        try {
          const api = (window as any).electronAPI
          if (api?.getPreferences && api?.setPreferences) {
            const prefs = (await api.getPreferences()) ?? {}
            await api.setPreferences({ ...prefs, recentFiles: next })
          }
        } catch { /* ignore */ }
      }
      // Try the per-recording sidecar first. If a ``<file>.tracer``
      // sits next to the recording it carries every analysis slice
      // in one shot — load-and-broadcast everything, then skip the
      // legacy prefs loads below. When the sidecar is absent we fall
      // through to the per-slice prefs loads for back-compat with
      // users whose results are still stored in the Electron prefs
      // file from before v0.3.x.
      // Track which slices the sidecar populated, so the legacy
      // prefs hydration below knows which ones still need loading.
      // Without this, a sidecar with only ``meta`` (e.g. a file the
      // user tagged via the metadata window before ever running an
      // analysis) used to overwrite legacy-prefs analyses with empty
      // dicts and then early-return — losing all prior events / AP /
      // bursts / IV / fPSP / cursor data until the next prefs save.
      const sidecarPopulated = {
        events: false, bursts: false, ap: false, iv: false,
        fpsp: false, cursor_analyses: false, resistance: false,
        burst_form: false, train_params: false,
        excluded: false, averaged: false,
      }
      if (recording?.filePath) {
        const sidecar = await _loadSidecar(recording.filePath)
        if (sidecar) {
          const bc = new BroadcastChannel('tracer-sync')
          const post = (msg: any) => { try { bc.postMessage(msg) } catch { /* ignore */ } }
          const a = sidecar.analyses ?? {}
          const patch: Partial<AppState> = {}
          // Only patch when the sidecar actually carries data for the
          // slice. ``Object.keys(...).length > 0`` distinguishes a
          // populated slice from an empty placeholder dict that earlier
          // versions (or the metadata-only sidecar path) might have
          // serialized.
          if (a.events && Object.keys(a.events).length > 0) {
            // Backfill any params fields added since this sidecar was
            // written so new UI controls don't bind to ``undefined``.
            const migrated = _migrateEventsAnalyses(a.events) ?? a.events
            patch.eventsAnalyses = migrated
            post({ type: 'events-update', eventsAnalyses: migrated })
            sidecarPopulated.events = true
          }
          if (a.bursts && Object.keys(a.bursts).length > 0) {
            patch.fieldBursts = a.bursts
            post({ type: 'bursts-update', fieldBursts: a.bursts })
            sidecarPopulated.bursts = true
          }
          if (a.ap && Object.keys(a.ap).length > 0) {
            patch.apAnalyses = a.ap
            post({ type: 'ap-update', apAnalyses: a.ap })
            sidecarPopulated.ap = true
          }
          if (a.iv_curves && Object.keys(a.iv_curves).length > 0) {
            patch.ivCurves = a.iv_curves
            post({ type: 'iv-update', ivCurves: a.iv_curves })
            sidecarPopulated.iv = true
          }
          if (a.fpsp_curves && Object.keys(a.fpsp_curves).length > 0) {
            patch.fpspCurves = a.fpsp_curves
            post({ type: 'fpsp-update', fpspCurves: a.fpsp_curves })
            sidecarPopulated.fpsp = true
          }
          if (a.cursor_analyses && Object.keys(a.cursor_analyses).length > 0) {
            patch.cursorAnalyses = a.cursor_analyses
            post({ type: 'cursor-analyses-update', cursorAnalyses: a.cursor_analyses })
            sidecarPopulated.cursor_analyses = true
          }
          if ((a as any).resistance && Object.keys((a as any).resistance).length > 0) {
            patch.resistanceResults = (a as any).resistance
            sidecarPopulated.resistance = true
          }
          if (sidecar.burst_form_params && Object.keys(sidecar.burst_form_params).length > 0) {
            patch.burstFormParams = sidecar.burst_form_params
            post({ type: 'burst-form-params-update', burstFormParams: sidecar.burst_form_params })
            sidecarPopulated.burst_form = true
          }
          if (sidecar.train_params && typeof sidecar.train_params === 'object') {
            // Forward-compatible: sidecar may pre-date one or more
            // modules. Spread the default empty bundle underneath so
            // every key exists.
            const merged: TrainParamsBundle = {
              ...defaultTrainParamsBundle(),
              ...(sidecar.train_params as Partial<TrainParamsBundle>),
            }
            patch.trainParams = merged
            post({ type: 'train-params-update', trainParams: merged })
            sidecarPopulated.train_params = true
          }
          if (sidecar.excluded_sweeps && Object.keys(sidecar.excluded_sweeps).length > 0) {
            patch.excludedSweeps = sidecar.excluded_sweeps
            post({ type: 'excluded-update', excludedSweeps: sidecar.excluded_sweeps })
            sidecarPopulated.excluded = true
          }
          if (sidecar.averaged_sweeps && Object.keys(sidecar.averaged_sweeps).length > 0) {
            patch.averagedSweeps = sidecar.averaged_sweeps
            post({ type: 'averaged-update', averagedSweeps: sidecar.averaged_sweeps })
            sidecarPopulated.averaged = true
          }
          if (sidecar.cursors) {
            patch.cursors = { ...get().cursors, ...sidecar.cursors }
            post({ type: 'cursor-update', cursors: patch.cursors })
          }
          // Per-series filter overrides — restore the dictionary so
          // selectSweep can pick the right filter when the user
          // navigates between series. The active filter will get
          // mirrored from this dict the next time selectSweep runs.
          // Older sidecars stored a flat ``FilterState`` per series;
          // migrate by wrapping it into the new bundle shape.
          if (sidecar.filters_by_series && Object.keys(sidecar.filters_by_series).length > 0) {
            const migrated: AppState['filtersBySeries'] = {}
            for (const [k, v] of Object.entries(sidecar.filters_by_series)) {
              if (v && typeof v === 'object' && 'filter' in (v as any)) {
                const slot = v as { filter: FilterState; filtersByChannel?: Record<number, FilterState> }
                migrated[k] = {
                  filter: slot.filter,
                  filtersByChannel: slot.filtersByChannel ?? {},
                }
              } else {
                migrated[k] = {
                  filter: v as FilterState,
                  filtersByChannel: {},
                }
              }
            }
            patch.filtersBySeries = migrated
          }
          if (sidecar.forms?.resistance) {
            patch.resistanceForm = { ...get().resistanceForm, ...sidecar.forms.resistance }
          }
          if ((a as any).paired && Object.keys((a as any).paired).length > 0) {
            patch.pairedAnalyses = (a as any).paired
            post({
              type: 'paired-update',
              pairedAnalyses: (a as any).paired,
              pairedForm: sidecar.forms?.paired ?? get().pairedForm,
            })
          }
          if (sidecar.forms?.paired) {
            patch.pairedForm = { ...get().pairedForm, ...sidecar.forms.paired }
          }
          // Apply scaling overrides to the backend BEFORE the first
          // selectSweep fetches data, so the trace returned already
          // reflects the corrected units. The response carries an
          // updated RecordingInfo with rewritten channels[].units.
          if (sidecar.scale_overrides && Object.keys(sidecar.scale_overrides).length > 0) {
            try {
              const ov = sidecar.scale_overrides
              const payload: Array<{
                channel: number; file_units: string;
                units: string; y_scale: number; y_offset: number
              }> = []
              for (const [key, v] of Object.entries(ov)) {
                const parsed = parseOverrideKey(key)
                if (!parsed) continue
                payload.push({
                  channel: parsed.channel, file_units: parsed.fileUnits,
                  units: v.units, y_scale: v.y_scale, y_offset: v.y_offset,
                })
              }
              const updated = await apiFetch(get().backendUrl, '/api/files/apply_overrides', {
                method: 'POST',
                body: JSON.stringify({ overrides: payload }),
              })
              patch.recording = updated
              patch.scaleOverrides = ov
              post({ type: 'scale-overrides-update', scaleOverrides: ov })
            } catch { /* ignore — file still loads with file-reported units */ }
          }
          if (sidecar.meta) {
            patch.recordingMeta = sidecar.meta
            // No broadcast — the metadata window will resync on its
            // own once it lands; meta isn't shared across windows
            // beyond the eventual metadata UI.
          }
          // Mark meta as hydrated so the tag-prompt toast can finally
          // make a decision based on real data instead of the
          // transient null state.
          patch.recordingMetaReady = true
          bc.close()
          if (Object.keys(patch).length > 0) set(patch)
          // Fall through to the legacy prefs hydration. It only fills
          // in slices the sidecar didn't carry, so cells that have
          // both (sidecar wins) work correctly while cells with only
          // legacy prefs data still surface their analyses.
        } else {
          // No sidecar at all — meta load is a no-op; mark ready so
          // the toast knows it's safe to evaluate.
          set({ recordingMetaReady: true })
        }
      } else {
        set({ recordingMetaReady: true })
      }

      // No prefs fallback: the .tracer sidecar is the only
      // persistence layer. Files without a sidecar simply load
      // empty per-analysis state. The legacy ``saved*`` prefs
      // helpers were removed — see the deleted block in this file
      // for the prior shape. ``sidecarPopulated`` is no longer
      // gating anything; left in place above so the sidecar-load
      // diagnostics still tell the user which slices were filled.
      void sidecarPopulated
      await get().selectSweep(0, 0, 0, 0)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  selectSweep: async (group, series, sweep, trace = 0) => {
    const state = get()
    const { backendUrl, recording } = state
    if (!recording) return

    // Detect whether we're switching to a different series — in that case
    // apply the stimulus-derived cursor defaults (if the new series exposes them).
    const seriesChanged =
      state.traceData == null ||
      state.currentGroup !== group ||
      state.currentSeries !== series

    const newSeries = recording.groups[group]?.series[series]
    const stimulus = newSeries?.stimulus

    const patch: Partial<AppState> = {
      currentGroup: group,
      currentSeries: series,
      currentSweep: sweep,
      currentTrace: trace,
      // Navigating to a real sweep always clears the "we're viewing an
      // averaged virtual sweep" pointer, so the viewer fetches fresh
      // trace data below instead of keeping the averaged Float64Array.
      currentAveragedSweep: null,
    }

    if (seriesChanged && stimulus) {
      // Snap cursors to the stimulus windows. Keep fit cursors independent.
      patch.cursors = {
        ...state.cursors,
        baselineStart: stimulus.baselineStart,
        baselineEnd: stimulus.baselineEnd,
        peakStart: stimulus.pulseStart,
        peakEnd: stimulus.pulseEnd,
      }
    }

    // When navigating to a series, ALWAYS pick an explicit filter
    // context for that series so the previous series' filter doesn't
    // bleed through. The per-series slot bundles both the default
    // ``filter`` and the ``filtersByChannel`` overrides — restoring
    // both keeps the per-channel picker honest. Resolution order:
    //   1. Per-series sidecar slot (the user's remembered choice)
    //   2. Events-derived mirror (back-compat for recordings whose
    //      events were detected with a filter, before the per-series
    //      slot existed — keeps the displayed trace matching what
    //      detection saw; only fills the default slot)
    //   3. Filter OFF, with the user's last-used params kept so a
    //      simple toggle picks up where they left off.
    //
    // Field-name shim: ``EventsParams`` uses ``filterLow / filterHigh``
    // while the main store's ``FilterState`` uses ``lowCutoff /
    // highCutoff``. Same numbers, different keys.
    if (seriesChanged) {
      const evKey = `${group}:${series}`
      const slot = state.filtersBySeries[evKey]
      let nextFilter: FilterState
      let nextFiltersByChannel: Record<number, FilterState>
      if (slot) {
        nextFilter = slot.filter
        nextFiltersByChannel = slot.filtersByChannel ?? {}
      } else {
        const evParams = state.eventsAnalyses[evKey]?.params
        if (evParams) {
          nextFilter = {
            enabled: !!evParams.filterEnabled,
            type: evParams.filterType,
            lowCutoff: Number(evParams.filterLow ?? 1),
            highCutoff: Number(evParams.filterHigh ?? 1000),
            order: Number(evParams.filterOrder ?? 1),
          }
        } else {
          // Default-off, params inherited from the prior filter so
          // toggling on later keeps the user's chosen cutoffs.
          nextFilter = { ...state.filter, enabled: false }
        }
        // Series with no slot start with no per-channel overrides —
        // the per-channel UI shouldn't carry data from a previous
        // series' channel pinned by index alone.
        nextFiltersByChannel = {}
      }
      patch.filter = nextFilter
      patch.filtersByChannel = nextFiltersByChannel
      // Echo to other windows so the analysis-window filter strip
      // stays in lockstep — same broadcast type the detection
      // window listens for.
      try {
        const ch = new BroadcastChannel('tracer-sync')
        ch.postMessage({ type: 'detection-filter', filter: nextFilter })
        ch.close()
      } catch { /* ignore */ }
    }

    set(patch)

    try {
      const { viewport: prevViewport, viewportMaxPoints, zeroOffset } = get()
      const filter = get().getFilterForChannel(trace)
      const sweepChanged =
        seriesChanged || state.currentSweep !== sweep || state.currentTrace !== trace

      // Pick the viewport for THIS fetch:
      // - Same sweep (e.g. cursor drag): keep whatever the user has.
      // - Different sweep: probe with a NULL viewport so the backend
      //   returns the full sweep, decimated to ``viewportMaxPoints``.
      //   The decision to actually USE Full vs. windowed mode happens
      //   after the response, based on series TYPE (sweepCount).
      const viewportForFetch: Viewport | null = sweepChanged
        ? null
        : prevViewport

      const [traceResp, stimResp] = await Promise.all([
        apiFetch(
          backendUrl,
          traceDataUrl(group, series, sweep, trace, filter, viewportForFetch, viewportMaxPoints, zeroOffset),
        ),
        apiFetch(backendUrl, `/api/traces/stimulus?group=${group}&series=${series}&sweep=${sweep}`).catch(() => null),
      ])

      const duration: number = traceResp.duration ?? 0

      // Decide the post-fetch viewport mode based on series TYPE, not
      // sweep duration:
      //   * Episodic (sweepCount > 1): every sweep is a discrete
      //     protocol-driven episode (test pulses, evoked responses,
      //     fEPSPs, AP trains). Always open at full view regardless
      //     of length — the user wants to see the whole episode.
      //   * Continuous (sweepCount === 1) AND long enough to qualify
      //     (duration > CONTINUOUS_SWEEP_THRESHOLD_S): a single
      //     multi-minute sweep is almost always a spontaneous-events
      //     or field recording. Open windowed at
      //     DEFAULT_VIEWPORT_SECONDS so the user gets a navigable
      //     starting view instead of a useless multi-minute aggregate.
      //   * Single short sweep: still a one-shot evoked response →
      //     full view.
      // Same-sweep changes (cursor drag etc.) keep ``prevViewport``
      // untouched.
      const seriesInfo = recording.groups[group]?.series[series]
      const sweepCount = seriesInfo?.sweepCount ?? 1
      const isContinuous =
        sweepCount === 1 && duration > CONTINUOUS_SWEEP_THRESHOLD_S

      let viewportNow: Viewport | null = viewportForFetch
      if (sweepChanged) {
        viewportNow = isContinuous
          ? { start: 0, end: DEFAULT_VIEWPORT_SECONDS }
          : null
      }

      // The probe above used ``viewport=null`` to learn the full
      // duration. For a long continuous recording that means the
      // returned trace is the WHOLE sweep decimated to
      // ``viewportMaxPoints`` — typically ~8 points fall inside the
      // default 1 s viewport, which the user perceives as a severely
      // downsampled trace. Refetch once with the windowed viewport so
      // the plot has high-resolution samples inside the visible
      // range. Episodic series (``viewportNow == null``) skip this —
      // the full-sweep probe IS what they want.
      let displayResp = traceResp
      if (sweepChanged && isContinuous && viewportNow) {
        try {
          displayResp = await apiFetch(
            backendUrl,
            traceDataUrl(group, series, sweep, trace, filter, viewportNow, viewportMaxPoints, zeroOffset),
          )
        } catch {
          // Network blip — fall back to the probe data. The viewport
          // is still set, so the user sees a sparse trace they can
          // recover from by interacting (any pan / zoom triggers a
          // fresh fetch via refetchViewport).
        }
      }

      const updates: Partial<AppState> = {
        traceData: {
          time: new Float64Array(displayResp.time),
          values: new Float64Array(displayResp.values),
          samplingRate: displayResp.sampling_rate,
          units: displayResp.units,
          label: displayResp.label,
        },
        sweepDuration: duration,
        viewport: viewportNow,
        currentZeroOffset: Number(displayResp.zero_offset ?? 0),
      }

      if (stimResp && stimResp.segments?.length > 0) {
        updates.sweepStimulusSegments = stimResp.segments
        updates.sweepStimulusUnit = stimResp.unit || ''
      } else {
        updates.sweepStimulusSegments = null
        updates.sweepStimulusUnit = ''
      }

      // Reset additional channels on sweep/series change so we don't flash
      // stale data while the new fetches are in flight.
      if (sweepChanged) updates.additionalTraces = {}

      // Materialize default trace visibility for the new series if this is
      // the first time we've visited it. Doing this eagerly (instead of
      // computing defaults lazily in `getVisibleTraces`) keeps selector
      // references stable across renders — which is critical, because
      // allocating a fresh default array on every selector call caused the
      // plot-rebuild effect to fire continuously and the trace to flash
      // blank right after loading.
      const vtKey = `${group}:${series}`
      const existingVt = get().visibleTraces
      if (!existingVt[vtKey]) {
        // Default: primary channel only. Stimulus is hidden by default —
        // user opts in from the Traces dropdown when they want it.
        updates.visibleTraces = { ...existingVt, [vtKey]: [trace] }
      }

      set(updates)

      // Now sync any visible additional channels for the new view.
      get().syncAdditionalTraces().catch(() => { /* ignore */ })
    } catch (err: any) {
      set({ error: err.message })
    }
  },

  setCursors: (partial) =>
    set((state) => ({ cursors: { ...state.cursors, ...partial } })),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  addResult: (result) =>
    set((state) => ({ results: [...state.results, result] })),

  clearResults: () => set({ results: [] }),

  // --- Overlay ---

  toggleOverlay: () => set((s) => ({ showOverlay: !s.showOverlay })),
  toggleAverage: () => set((s) => ({ showAverage: !s.showAverage })),

  addOverlaySweep: async (sweep: number) => {
    const { backendUrl, currentGroup, currentSeries, currentTrace, overlayEntries, viewport, viewportMaxPoints, zeroOffset } = get()
    if (overlayEntries.some((e) => e.sweep === sweep)) return
    try {
      const filter = get().getFilterForChannel(currentTrace)
      const data = await apiFetch(
        backendUrl,
        traceDataUrl(currentGroup, currentSeries, sweep, currentTrace, filter, viewport, viewportMaxPoints, zeroOffset)
      )
      const color = OVERLAY_COLORS[overlayEntries.length % OVERLAY_COLORS.length]
      set({
        overlayEntries: [
          ...overlayEntries,
          {
            sweep,
            data: {
              time: new Float64Array(data.time),
              values: new Float64Array(data.values),
              samplingRate: data.sampling_rate,
              units: data.units,
              label: `Sweep ${sweep + 1}`,
            },
            color,
          },
        ],
      })
    } catch (err: any) {
      set({ error: err.message })
    }
  },

  removeOverlaySweep: (sweep: number) => {
    set((s) => ({ overlayEntries: s.overlayEntries.filter((e) => e.sweep !== sweep) }))
  },

  clearOverlays: () => set({ overlayEntries: [], showOverlay: false }),

  overlayAllSweeps: async () => {
    const { recording, currentGroup, currentSeries, currentTrace, backendUrl, viewport, viewportMaxPoints, zeroOffset } = get()
    if (!recording) return
    const ser = recording.groups[currentGroup]?.series[currentSeries]
    if (!ser) return
    const filter = get().getFilterForChannel(currentTrace)

    set({ loading: true })
    const entries: OverlayEntry[] = []
    for (let i = 0; i < ser.sweepCount; i++) {
      try {
        const data = await apiFetch(
          backendUrl,
          traceDataUrl(currentGroup, currentSeries, i, currentTrace, filter, viewport, viewportMaxPoints, zeroOffset)
        )
        entries.push({
          sweep: i,
          data: {
            time: new Float64Array(data.time),
            values: new Float64Array(data.values),
            samplingRate: data.sampling_rate,
            units: data.units,
            label: `Sweep ${i + 1}`,
          },
          color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
        })
      } catch { /* skip failed sweeps */ }
    }
    set({ overlayEntries: entries, showOverlay: true, loading: false })
  },

  loadAverageTrace: async () => {
    const { backendUrl, currentGroup, currentSeries, currentTrace, recording } = get()
    try {
      // Exclude any sweeps the user flagged in the tree — ask the backend
      // for an explicit-list average when exclusions exist, otherwise let
      // it default to "all sweeps" via range 0..N.
      const total = recording?.groups?.[currentGroup]?.series?.[currentSeries]?.sweepCount ?? 0
      const included = get().includedSweepsFor(currentGroup, currentSeries, total)
      let url = `/api/traces/average?group=${currentGroup}&series=${currentSeries}&trace=${currentTrace}&max_points=0`
      if (total > 0 && included.length !== total) {
        url += `&sweeps=${included.join(',')}`
      }
      const data = await apiFetch(backendUrl, url)
      set({
        averageTrace: {
          time: new Float64Array(data.time),
          values: new Float64Array(data.values),
          samplingRate: data.sampling_rate,
          units: data.units,
          label: data.label,
        },
        showAverage: true,
      })
    } catch (err: any) {
      set({ error: err.message })
    }
  },

  // ---- Excluded sweeps ----
  //
  // Persistence lives in the .tracer sidecar alongside the other
  // analysis slices. Cross-window sync flows through BroadcastChannel
  // "excluded-update" — the main window's CursorPanel adopts it on
  // receipt, exactly like the other analysis slices.

  toggleSweepExcluded: (group, series, sweep) => {
    const key = `${group}:${series}`
    set((s) => {
      const current = s.excludedSweeps[key] ?? []
      const has = current.includes(sweep)
      const next = has
        ? current.filter((i) => i !== sweep)
        : [...current, sweep].sort((a, b) => a - b)
      const nextMap = { ...s.excludedSweeps, [key]: next }
      // Drop empty entries so the persisted blob stays clean.
      if (next.length === 0) delete nextMap[key]
      return { excludedSweeps: nextMap }
    })
    _broadcastExcludedSweeps(get().excludedSweeps)
  },

  clearExcludedSweeps: (group, series) => {
    const key = `${group}:${series}`
    set((s) => {
      if (!s.excludedSweeps[key]) return s
      const nextMap = { ...s.excludedSweeps }
      delete nextMap[key]
      return { excludedSweeps: nextMap }
    })
    _broadcastExcludedSweeps(get().excludedSweeps)
  },

  isSweepExcluded: (group, series, sweep) => {
    const set = get().excludedSweeps[`${group}:${series}`]
    return !!set && set.includes(sweep)
  },

  includedSweepsFor: (group, series, totalSweeps) => {
    const excluded = get().excludedSweeps[`${group}:${series}`]
    if (!excluded || excluded.length === 0) {
      return Array.from({ length: totalSweeps }, (_, i) => i)
    }
    const ex = new Set(excluded)
    const out: number[] = []
    for (let i = 0; i < totalSweeps; i++) if (!ex.has(i)) out.push(i)
    return out
  },

  filterExcludedSweeps: (group, series, sweeps) => {
    const excluded = get().excludedSweeps[`${group}:${series}`]
    if (!excluded || excluded.length === 0) return sweeps.slice()
    const ex = new Set(excluded)
    return sweeps.filter((i) => !ex.has(i))
  },

  // ---- Multi-selection ---------------------------------------------
  //
  // Behaviour mirrors Finder / VS Code:
  //   - `none` (plain click) → treat as a navigation click; do NOT
  //     clear selection (that's handled in selectSweep).
  //   - `cmd` / Ctrl → toggle the single sweep in/out of selection.
  //   - `shift` → select the contiguous range between the LAST
  //     plain-clicked / shift-anchored sweep and this one.
  // The anchor is tracked as the most recent single-sweep selection
  // in the selectedSweeps list.

  handleSweepSelection: (group, series, sweep, modifier) => {
    const key = `${group}:${series}`
    set((s) => {
      const current = s.selectedSweeps[key] ?? []
      let next: number[]
      if (modifier === 'cmd') {
        next = current.includes(sweep)
          ? current.filter((i) => i !== sweep)
          : [...current, sweep].sort((a, b) => a - b)
      } else if (modifier === 'shift' && current.length > 0) {
        const anchor = current[current.length - 1]
        const lo = Math.min(anchor, sweep)
        const hi = Math.max(anchor, sweep)
        const range: number[] = []
        for (let i = lo; i <= hi; i++) range.push(i)
        next = range
      } else {
        // 'none' or shift-without-anchor: seed selection with this sweep.
        next = [sweep]
      }
      const nextMap = { ...s.selectedSweeps, [key]: next }
      if (next.length === 0) delete nextMap[key]
      return { selectedSweeps: nextMap }
    })
  },

  clearSweepSelection: (group, series) => {
    const key = `${group}:${series}`
    set((s) => {
      if (!s.selectedSweeps[key]) return s
      const nextMap = { ...s.selectedSweeps }
      delete nextMap[key]
      return { selectedSweeps: nextMap }
    })
  },

  isSweepSelected: (group, series, sweep) => {
    const sel = get().selectedSweeps[`${group}:${series}`]
    return !!sel && sel.includes(sweep)
  },

  // ---- Averaged virtual sweeps ------------------------------------
  //
  // `createAveragedSweep` hits the backend's /api/traces/average with an
  // explicit sweeps list, stores the returned trace under (group, series)
  // as a new AveragedSweep, and navigates to it. Persistence + cross-
  // window sync flow through the standard _broadcast + subscribe
  // pattern defined below.

  createAveragedSweep: async (group, series, trace, sweepIndices, label) => {
    const { backendUrl, recording } = get()
    if (sweepIndices.length === 0) {
      set({ error: 'No sweeps selected for averaging.' })
      return null
    }
    try {
      const resp = await apiFetch(
        backendUrl,
        `/api/traces/average?group=${group}&series=${series}&trace=${trace}&sweeps=${sweepIndices.join(',')}&max_points=0`,
      )
      const id = `avg-${Date.now()}-${Math.floor(Math.random() * 10000)}`
      const avg: AveragedSweep = {
        id,
        group, series, trace,
        sourceSweepIndices: sweepIndices.slice(),
        label: label || `Avg ${sweepIndices.length === 1
          ? `sweep ${sweepIndices[0] + 1}`
          : `${sweepIndices.length} sweeps`}`,
        time: resp.time,
        values: resp.values,
        samplingRate: resp.sampling_rate,
        units: resp.units,
        createdAt: Date.now(),
      }
      const key = `${group}:${series}`
      set((s) => ({
        averagedSweeps: {
          ...s.averagedSweeps,
          [key]: [...(s.averagedSweeps[key] ?? []), avg],
        },
      }))
      _broadcastAveragedSweeps(get().averagedSweeps)
      // Navigate to the new averaged sweep so the user can see it right away.
      get().selectAveragedSweep(group, series, id)
      void recording  // may be null in analysis windows; persistence subscribe runs in main only
      return id
    } catch (err: any) {
      set({ error: err.message || 'Failed to create averaged sweep' })
      return null
    }
  },

  deleteAveragedSweep: (group, series, id) => {
    const key = `${group}:${series}`
    set((s) => {
      const list = s.averagedSweeps[key] ?? []
      const next = list.filter((a) => a.id !== id)
      const nextMap = { ...s.averagedSweeps }
      if (next.length === 0) delete nextMap[key]
      else nextMap[key] = next
      // If we're currently viewing the deleted one, clear the pointer.
      const cur = s.currentAveragedSweep
      const clearCurrent = cur && cur.group === group && cur.series === series && cur.id === id
      return {
        averagedSweeps: nextMap,
        ...(clearCurrent ? { currentAveragedSweep: null } : {}),
      }
    })
    _broadcastAveragedSweeps(get().averagedSweeps)
  },

  renameAveragedSweep: (group, series, id, label) => {
    const key = `${group}:${series}`
    set((s) => {
      const list = s.averagedSweeps[key] ?? []
      const next = list.map((a) => a.id === id ? { ...a, label } : a)
      return { averagedSweeps: { ...s.averagedSweeps, [key]: next } }
    })
    _broadcastAveragedSweeps(get().averagedSweeps)
  },

  selectAveragedSweep: (group, series, id) => {
    const list = get().averagedSweeps[`${group}:${series}`] ?? []
    const avg = list.find((a) => a.id === id)
    if (!avg) return
    set({
      currentGroup: group,
      currentSeries: series,
      currentTrace: avg.trace,
      currentAveragedSweep: { group, series, id },
      traceData: {
        time: new Float64Array(avg.time),
        values: new Float64Array(avg.values),
        samplingRate: avg.samplingRate,
        units: avg.units,
        label: avg.label,
      },
    })
  },

  // ---- Resistance analysis ----

  runResistanceOnSweep: async (vStep: number) => {
    const { backendUrl, currentGroup, currentSeries, currentSweep, currentTrace, cursors } = get()
    set({ loading: true, error: null })
    try {
      const resp = await apiFetch(backendUrl, '/api/analysis/run', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup,
          series: currentSeries,
          sweep: currentSweep,
          trace: currentTrace,
          cursors,
          params: { v_step: vStep },
        }),
      })
      const m = resp.measurement || {}
      const result = { ...m, source: `sweep ${currentSweep + 1}` }
      // Also stash into the per-series map so the tree-navigator's
      // "R" badge lights up and the cohort extractor can later pick
      // up resistance values from the sidecar.
      const seriesKey = `${currentGroup}:${currentSeries}`
      set((s) => ({
        resistanceResult: result,
        resistanceResults: { ...s.resistanceResults, [seriesKey]: result },
        loading: false,
      }))
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  runResistanceOnAverage: async (vStep: number, sweepIndices: number[] | null) => {
    const { backendUrl, currentGroup, currentSeries, currentTrace, cursors } = get()
    set({ loading: true, error: null })
    try {
      const resp = await apiFetch(backendUrl, '/api/analysis/run_averaged', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup,
          series: currentSeries,
          trace: currentTrace,
          sweep_indices: sweepIndices,
          cursors,
          params: { v_step: vStep },
        }),
      })
      const m = resp.measurement || {}
      const n = resp.n_sweeps_averaged ?? 0
      const indices: number[] = resp.sweep_indices ?? []
      let sourceLabel: string
      if (indices.length > 0) {
        const lo = Math.min(...indices) + 1
        const hi = Math.max(...indices) + 1
        sourceLabel = indices.length === hi - lo + 1
          ? `averaged over sweeps ${lo}–${hi}`
          : `averaged over ${n} sweeps`
      } else {
        sourceLabel = `averaged over ${n} sweeps`
      }
      const result = { ...m, source: sourceLabel }
      const seriesKey = `${currentGroup}:${currentSeries}`
      set((s) => ({
        resistanceResult: result,
        resistanceResults: { ...s.resistanceResults, [seriesKey]: result },
        loading: false,
      }))
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearResistanceResult: () => set({ resistanceResult: null }),
  setResistanceForm: (patch) => set((s) => ({
    resistanceForm: { ...s.resistanceForm, ...patch },
  })),

  setRecordingMeta: (patch) => set((s) => {
    const next: SidecarMeta = { ...(s.recordingMeta ?? {}), ...patch }
    // Strip undefined values so the sidecar doesn't persist explicit
    // "absent" markers — keeps the JSON tidy and `getMetaStatus`
    // doesn't have to special-case them.
    for (const k of Object.keys(next) as (keyof SidecarMeta)[]) {
      if (next[k] === undefined) delete next[k]
    }
    return { recordingMeta: next }
  }),
  setScaleOverrides: async (overrides) => {
    const { backendUrl, recording } = get()
    if (!recording) return
    // Backend identifies overrides by (channel, file_units) so an
    // override on the CC view of channel 0 doesn't bleed into the
    // VC sweeps that share the same index. The composite key in
    // ``overrides`` already encodes both; we just unpack here.
    const payload: Array<{
      channel: number; file_units: string;
      units: string; y_scale: number; y_offset: number
    }> = []
    for (const [key, ov] of Object.entries(overrides)) {
      const parsed = parseOverrideKey(key)
      if (!parsed) continue
      payload.push({
        channel: parsed.channel, file_units: parsed.fileUnits,
        units: ov.units, y_scale: ov.y_scale, y_offset: ov.y_offset,
      })
    }
    try {
      const updated = await apiFetch(backendUrl, '/api/files/apply_overrides', {
        method: 'POST',
        body: JSON.stringify({ overrides: payload }),
      })
      set({ scaleOverrides: overrides, recording: updated })
      _broadcastScaleOverrides(overrides)
    } catch (err: any) {
      set({ error: err.message })
    }
  },

  setSeriesTags: (group, series, tags) => set((s) => {
    const cleaned = tags.map((t) => t.trim()).filter(Boolean)
    const meta = { ...(s.recordingMeta ?? {}) }
    const seriesTags = { ...(meta.series_tags ?? {}) }
    const key = `${group}:${series}`
    if (cleaned.length === 0) {
      delete seriesTags[key]
    } else {
      seriesTags[key] = cleaned
    }
    meta.series_tags = seriesTags
    return { recordingMeta: meta }
  }),

  // ---- Field-burst detection ----

  runFieldBurstsOnSweep: async (group, series, sweep, channel, params) => {
    const { backendUrl } = get()
    set({ loading: true, error: null })
    try {
      const resp = await apiFetch(backendUrl, '/api/analysis/run', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'bursts',
          group, series, sweep, trace: channel,
          params,
        }),
      })
      const m = resp.measurement || {}
      if (m.error) {
        set({ error: `Burst detection: ${m.error}`, loading: false })
        return
      }
      const newRecords = burstsFromResponse(m, sweep)
      const key = `${group}:${series}`
      set((s) => {
        const prev = s.fieldBursts[key]
        // Replace existing rows for this sweep; keep rows from other sweeps.
        const kept = (prev?.bursts ?? []).filter((b) => b.sweepIndex !== sweep)
        const merged = [...kept, ...newRecords].sort(
          (a, b) => a.sweepIndex - b.sweepIndex || a.startS - b.startS,
        )
        const next: FieldBurstsData = {
          channel,
          params,
          baselineValue: Number(m.baseline_value ?? 0),
          thresholdHigh: m.threshold_high != null ? Number(m.threshold_high) : null,
          thresholdLow: m.threshold_low != null ? Number(m.threshold_low) : null,
          bursts: merged,
          selectedIdx: null,
          diag: diagFromResponse(m),
        }
        return { fieldBursts: { ...s.fieldBursts, [key]: next }, loading: false }
      })
      _broadcastBursts(get().fieldBursts, params)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  runFieldBurstsOnSeries: async (group, series, channel, params) => {
    const { backendUrl } = get()
    set({ loading: true, error: null })
    try {
      const excluded = get().excludedSweeps[`${group}:${series}`] ?? []
      const resp = await apiFetch(backendUrl, '/api/analysis/batch', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'bursts',
          group, series, trace: channel,
          // sweep_end: -1 tells the backend to use ser.sweep_count.
          sweep_start: 0, sweep_end: -1,
          // Backend subtracts these after resolving the range.
          excluded_sweeps: excluded.length > 0 ? excluded : undefined,
          params,
        }),
      })
      const results: any[] = resp.results ?? []
      const allBursts: BurstRecord[] = []
      let baselineValue = 0
      let thresholdHigh: number | null = null
      let thresholdLow: number | null = null
      let diag: FieldBurstsDiag | undefined
      const sweepErrors: string[] = []
      for (const perSweep of results) {
        const sw = Number(perSweep.sweep_index ?? 0)
        if (perSweep.error) {
          sweepErrors.push(`sweep ${sw + 1}: ${perSweep.error}`)
          continue
        }
        allBursts.push(...burstsFromResponse(perSweep, sw))
        // Capture baseline + thresholds from the FIRST sweep's result — they
        // should be comparable across sweeps since params are the same.
        if (perSweep.baseline_value != null && baselineValue === 0) {
          baselineValue = Number(perSweep.baseline_value)
          if (perSweep.threshold_high != null) thresholdHigh = Number(perSweep.threshold_high)
          if (perSweep.threshold_low != null) thresholdLow = Number(perSweep.threshold_low)
          diag = diagFromResponse(perSweep)
        }
      }
      allBursts.sort((a, b) => a.sweepIndex - b.sweepIndex || a.startS - b.startS)
      const key = `${group}:${series}`
      const next: FieldBurstsData = {
        channel,
        params,
        baselineValue,
        thresholdHigh,
        thresholdLow,
        bursts: allBursts,
        selectedIdx: null,
        diag,
      }
      set((s) => ({
        fieldBursts: { ...s.fieldBursts, [key]: next },
        loading: false,
        error: sweepErrors.length > 0 ? sweepErrors.join('; ') : null,
      }))
      _broadcastBursts(get().fieldBursts, params)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearFieldBursts: (group, series) => {
    set((s) => {
      if (group == null || series == null) return { fieldBursts: {} }
      const key = `${group}:${series}`
      const { [key]: _dropped, ...rest } = s.fieldBursts
      return { fieldBursts: rest }
    })
    // Propagate to other windows (main viewer) so markers clear there too.
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.postMessage({ type: 'bursts-update', fieldBursts: get().fieldBursts })
      ch.close()
    } catch { /* ignore */ }
  },

  selectFieldBurst: (group, series, idx) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.fieldBursts[key]
      if (!entry) return s
      return {
        fieldBursts: {
          ...s.fieldBursts,
          [key]: { ...entry, selectedIdx: idx },
        },
      }
    })
  },

  addManualBurst: (group, series, burst) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.fieldBursts[key]
      const existing = entry?.bursts ?? []
      const next = [...existing, { ...burst, manual: true }].sort((a, b) => {
        if (a.sweepIndex !== b.sweepIndex) return a.sweepIndex - b.sweepIndex
        return a.startS - b.startS
      })
      // If there's no existing entry yet (user happens to click before any
      // auto-detection has run), create a minimal one so the burst still
      // renders. Thresholds stay null; params are echoed as empty.
      const baseEntry: FieldBurstsData = entry ?? {
        channel: 0,
        bursts: [],
        baselineValue: 0,
        thresholdHigh: null,
        thresholdLow: null,
        selectedIdx: null,
        params: { method: 'threshold', baseline_mode: 'percentile' } as FieldBurstsParams,
      }
      return {
        fieldBursts: {
          ...s.fieldBursts,
          [key]: { ...baseEntry, bursts: next },
        },
      }
    })
    _broadcastBursts(get().fieldBursts, get().fieldBursts[key]?.params ?? { method: 'threshold', baseline_mode: 'percentile' } as FieldBurstsParams)
  },

  removeBurstAt: (group, series, sweep, timeS) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.fieldBursts[key]
      if (!entry) return s
      // Find candidate bursts on the clicked sweep. Prefer bursts whose
      // [startS, endS] span contains the click; fall back to the one
      // whose peak is closest in time within 0.5 s so the click still
      // lands when the user hits the marker dot outside the span.
      let best: { idx: number; dist: number } | null = null
      entry.bursts.forEach((b, i) => {
        if (b.sweepIndex !== sweep) return
        const inside = timeS >= b.startS && timeS <= b.endS
        const peakDist = Math.abs(timeS - b.peakTimeS)
        const dist = inside ? 0 : peakDist
        if (inside || peakDist < 0.5) {
          if (!best || dist < best.dist) best = { idx: i, dist }
        }
      })
      if (!best) return s
      // `best` is narrowed inside the callbacks above; TS doesn't follow
      // the mutation back out so assert it here.
      const removeIdx = (best as { idx: number; dist: number }).idx
      const nextBursts = entry.bursts.filter((_, i) => i !== removeIdx)
      return {
        fieldBursts: {
          ...s.fieldBursts,
          [key]: { ...entry, bursts: nextBursts },
        },
      }
    })
    _broadcastBursts(get().fieldBursts, get().fieldBursts[key]?.params ?? { method: 'threshold', baseline_mode: 'percentile' } as FieldBurstsParams)
  },

  setBurstFormParams: (group, series, params) => {
    const key = `${group}:${series}`
    set((s) => ({
      burstFormParams: { ...s.burstFormParams, [key]: params },
    }))
    _broadcastBurstFormParams(get().burstFormParams)
  },

  setTrainParams: (module, group, series, params) => {
    const key = `${group}:${series}`
    set((s) => ({
      trainParams: {
        ...s.trainParams,
        [module]: { ...s.trainParams[module], [key]: params },
      },
    }))
    _broadcastTrainParams(get().trainParams)
  },

  exportFieldBurstsCSV: async () => {
    const { fieldBursts, recording, backendUrl, trainParams } = get()
    const keys = Object.keys(fieldBursts)
    if (keys.length === 0) return
    // `recording` is only populated in the main window's store; analysis
    // windows don't carry it. Fall back to querying the backend if we're
    // in the analysis window.
    let fileName: string = recording?.fileName ?? ''
    if (!fileName && backendUrl) {
      try {
        const info = await fetch(`${backendUrl}/api/files/info`).then((r) => r.ok ? r.json() : null)
        if (info?.fileName) fileName = info.fileName
      } catch { /* ignore */ }
    }
    const header = [
      'file', 'group', 'series', 'sweep_index', 'burst_idx',
      'start_s', 'end_s', 'duration_ms',
      'peak_amplitude', 'peak_time_s', 'mean_amplitude',
      'integral', 'rise_time_10_90_ms', 'decay_half_time_ms',
      'pre_burst_baseline',
      'mean_frequency_hz', 'n_spikes',
      'method', 'baseline_mode', 'baseline_value',
      'threshold_high', 'threshold_low',
      'train_id',
    ]
    const rows: string[] = [header.join(',')]
    for (const key of keys) {
      const [g, s] = key.split(':').map(Number)
      const entry = fieldBursts[key]
      const trainCfg = trainParams.bursts[key] as
        | (TrainParams & { enabled?: boolean })
        | undefined
      const trainIdByIdx = trainCfg?.enabled
        ? computeBurstTrainIds(entry.bursts, trainCfg).idByGlobalIdx
        : null
      entry.bursts.forEach((b, i) => {
        const tid = trainIdByIdx?.[i]
        rows.push([
          JSON.stringify(fileName),
          g, s, b.sweepIndex, i,
          b.startS.toFixed(6), b.endS.toFixed(6), b.durationMs.toFixed(3),
          b.peakAmplitude.toFixed(4), b.peakTimeS.toFixed(6),
          b.meanAmplitude.toFixed(4), b.integral.toFixed(6),
          b.riseTime10_90Ms != null ? b.riseTime10_90Ms.toFixed(3) : '',
          b.decayHalfTimeMs != null ? b.decayHalfTimeMs.toFixed(3) : '',
          b.preBurstBaseline.toFixed(4),
          b.meanFrequencyHz != null ? b.meanFrequencyHz.toFixed(3) : '',
          b.nSpikes ?? '',
          String(entry.params.method),
          String(entry.params.baseline_mode),
          entry.baselineValue.toFixed(4),
          entry.thresholdHigh != null ? entry.thresholdHigh.toFixed(4) : '',
          entry.thresholdLow != null ? entry.thresholdLow.toFixed(4) : '',
          tid != null ? tid + 1 : '',
        ].join(','))
      })
    }
    const csv = rows.join('\n')
    const defaultName = (fileName || 'recording').replace(/\.[^.]+$/, '') + '_bursts.csv'
    // Browser-style download works in Electron too and handles the Save dialog
    // via the renderer's built-in download handler.
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
  },

  exportFieldBurstTrainsCSV: async () => {
    const { fieldBursts, recording, backendUrl, trainParams } = get()
    const keys = Object.keys(fieldBursts)
    if (keys.length === 0) return
    let fileName: string = recording?.fileName ?? ''
    if (!fileName && backendUrl) {
      try {
        const info = await fetch(`${backendUrl}/api/files/info`).then((r) => r.ok ? r.json() : null)
        if (info?.fileName) fileName = info.fileName
      } catch { /* ignore */ }
    }
    const header = [
      'file', 'group', 'series', 'sweep_index', 'train_id',
      'start_s', 'end_s', 'duration_ms', 'n_bursts',
      'mean_iei_ms', 'intra_freq_hz',
      'metric', 'max_iei_ms', 'min_count',
      'min_duration_ms', 'min_inter_train_ms',
      'first_burst_idx', 'last_burst_idx',
    ]
    const rows: string[] = [header.join(',')]
    let total = 0
    for (const key of keys) {
      const [g, s] = key.split(':').map(Number)
      const entry = fieldBursts[key]
      const trainCfg = trainParams.bursts[key] as
        | (TrainParams & { enabled?: boolean })
        | undefined
      if (!trainCfg?.enabled) continue
      const { flatSummaries } = computeBurstTrainIds(entry.bursts, trainCfg)
      for (const t of flatSummaries) {
        rows.push([
          JSON.stringify(fileName),
          g, s, t.sweep, t.id + 1,
          t.startS.toFixed(6), t.endS.toFixed(6), t.durationMs.toFixed(3),
          t.nEvents,
          t.meanIeiMs != null ? t.meanIeiMs.toFixed(3) : '',
          t.intraFreqHz != null ? t.intraFreqHz.toFixed(4) : '',
          String(trainCfg.metric),
          trainCfg.maxIeiMs,
          trainCfg.minCount,
          trainCfg.minDurationMs ?? 0,
          trainCfg.minInterTrainMs ?? 0,
          t.memberIndices[0],
          t.memberIndices[t.memberIndices.length - 1],
        ].join(','))
        total++
      }
    }
    if (total === 0) return
    const csv = rows.join('\n')
    const defaultName = (fileName || 'recording').replace(/\.[^.]+$/, '') + '_burst_trains.csv'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
  },

  // ---- I-V curve analysis ----

  runIVCurve: async (group, series, channel, params) => {
    const { backendUrl } = get()
    if (!backendUrl) return
    set({ loading: true, error: null })
    try {
      const qs = new URLSearchParams({
        group: String(group),
        series: String(series),
        trace: String(channel),
        baseline_start_s: String(params.baselineStartS),
        baseline_end_s: String(params.baselineEndS),
        peak_start_s: String(params.peakStartS),
        peak_end_s: String(params.peakEndS),
      })
      if (params.sweepIndices && params.sweepIndices.length > 0) {
        qs.set('sweeps', params.sweepIndices.join(','))
      }
      if (params.manualImEnabled) {
        qs.set('manual_im_enabled', 'true')
        qs.set('manual_im_start_s', String(params.manualImStartS ?? 0))
        qs.set('manual_im_end_s', String(params.manualImEndS ?? 0))
        qs.set('manual_im_start_pa', String(params.manualImStartPA ?? 0))
        qs.set('manual_im_step_pa', String(params.manualImStepPA ?? 0))
      }
      const resp = await apiFetch(backendUrl, `/api/iv/run?${qs}`)
      const key = `${group}:${series}`
      const existing = get().ivCurves[key]
      const newPoints: IVPoint[] = (resp.points ?? []).map((p: any) => ({
        sweepIndex: Number(p.sweep_index ?? 0),
        stimLevel: Number(p.stim_level ?? 0),
        baseline: Number(p.baseline ?? 0),
        steadyState: Number(p.steady_state ?? 0),
        transientPeak: Number(p.transient_peak ?? 0),
        sagAmp: Number(p.sag_amp ?? 0),
        sagRatio: p.sag_ratio != null ? Number(p.sag_ratio) : null,
      }))
      // Merge into existing table vs replace — driven by the run mode.
      // "append" (single sweep) keeps older rows from other sweeps and
      // replaces any row for the same sweep. Range + all replace entirely.
      let mergedPoints: IVPoint[] = newPoints
      if (params.appendToExisting && existing) {
        const newSweepSet = new Set(newPoints.map((p) => p.sweepIndex))
        const kept = existing.points.filter((p) => !newSweepSet.has(p.sweepIndex))
        mergedPoints = [...kept, ...newPoints].sort((a, b) => a.stimLevel - b.stimLevel)
      }
      const next: IVCurveData = {
        channel,
        stimUnit: String(resp.stim_unit ?? existing?.stimUnit ?? ''),
        responseUnit: String(resp.response_unit ?? existing?.responseUnit ?? ''),
        responseMetric: (existing?.responseMetric ?? 'steady') as IVResponseMetric,
        baselineStartS: params.baselineStartS,
        baselineEndS: params.baselineEndS,
        peakStartS: params.peakStartS,
        peakEndS: params.peakEndS,
        points: mergedPoints,
        selectedIdx: null,
        imSource: resp.im_source ? {
          mode: resp.im_source.mode as ImSource['mode'],
          label: resp.im_source.label ?? null,
        } : undefined,
        // Echo form-state into the entry so the broadcast (and the
        // sidecar auto-save that follows) carries everything needed
        // to restore the user's setup on next open. Without this,
        // any local ``setState`` in the analysis window only updated
        // the analysis window's OWN store; the main window stamped
        // the original (form-state-less) blob to disk via its
        // sidecar subscriber. Falls back to the previous entry's
        // values when the caller didn't pass them (e.g. mid-run
        // updates from older code paths).
        runMode: params.runMode ?? existing?.runMode,
        sweepFrom: params.sweepFrom ?? existing?.sweepFrom,
        sweepTo: params.sweepTo ?? existing?.sweepTo,
        sweepOne: params.sweepOne ?? existing?.sweepOne,
        manualImEnabled: params.manualImEnabled ?? existing?.manualImEnabled,
        manualImStartS: params.manualImStartS ?? existing?.manualImStartS,
        manualImEndS: params.manualImEndS ?? existing?.manualImEndS,
        manualImStartPA: params.manualImStartPA ?? existing?.manualImStartPA,
        manualImStepPA: params.manualImStepPA ?? existing?.manualImStepPA,
      }
      set((s) => ({ ivCurves: { ...s.ivCurves, [key]: next }, loading: false }))
      _broadcastIVCurves(get().ivCurves)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearIVCurve: (group, series) => {
    set((s) => {
      if (group == null || series == null) return { ivCurves: {} }
      const key = `${group}:${series}`
      const { [key]: _dropped, ...rest } = s.ivCurves
      return { ivCurves: rest }
    })
    _broadcastIVCurves(get().ivCurves)
  },

  selectIVPoint: (group, series, idx) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.ivCurves[key]
      if (!entry) return s
      return {
        ivCurves: {
          ...s.ivCurves,
          [key]: { ...entry, selectedIdx: idx },
        },
      }
    })
  },

  setIVResponseMetric: (group, series, metric) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.ivCurves[key]
      if (!entry) return s
      return {
        ivCurves: {
          ...s.ivCurves,
          [key]: { ...entry, responseMetric: metric },
        },
      }
    })
    _broadcastIVCurves(get().ivCurves)
  },

  exportIVCSV: async () => {
    const { ivCurves, recording, backendUrl } = get()
    const keys = Object.keys(ivCurves)
    if (keys.length === 0) return
    let fileName: string = recording?.fileName ?? ''
    if (!fileName && backendUrl) {
      try {
        const info = await fetch(`${backendUrl}/api/files/info`).then((r) => r.ok ? r.json() : null)
        if (info?.fileName) fileName = info.fileName
      } catch { /* ignore */ }
    }
    const header = [
      'file', 'group', 'series', 'sweep_index',
      'stim_level', 'stim_unit',
      'baseline', 'steady_state', 'transient_peak',
      'sag_amp', 'sag_ratio',
      'response_metric', 'response', 'response_unit',
    ]
    const rows: string[] = [header.join(',')]
    for (const key of keys) {
      const [g, s] = key.split(':').map(Number)
      const entry = ivCurves[key]
      entry.points.forEach((p) => {
        const resp = entry.responseMetric === 'peak'
          ? p.transientPeak - p.baseline
          : p.steadyState - p.baseline
        rows.push([
          JSON.stringify(fileName),
          g, s, p.sweepIndex,
          p.stimLevel.toFixed(4),
          JSON.stringify(entry.stimUnit),
          p.baseline.toFixed(4),
          p.steadyState.toFixed(4),
          p.transientPeak.toFixed(4),
          p.sagAmp.toFixed(4),
          p.sagRatio != null ? p.sagRatio.toFixed(4) : '',
          entry.responseMetric,
          resp.toFixed(4),
          JSON.stringify(entry.responseUnit),
        ].join(','))
      })
    }
    const csv = rows.join('\n')
    const defaultName = (fileName || 'recording').replace(/\.[^.]+$/, '') + '_iv.csv'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
  },

  // ---- Field PSP analysis ----

  runFPsp: async (group, series, channel, params) => {
    const { backendUrl } = get()
    if (!backendUrl) return
    set({ loading: true, error: null })
    try {
      const mode: FPspMode = params.mode ?? 'ltp'
      // Build a /api/fpsp/run query. The `volS`/`volE`/`fepS`/`fepE`
      // args let us reuse this for both responses in PPR mode.
      const buildQuery = (volS: number, volE: number, fepS: number, fepE: number) => {
        const qs = new URLSearchParams({
          group: String(group),
          series: String(series),
          trace: String(channel),
          baseline_start_s: String(params.baselineStartS),
          baseline_end_s: String(params.baselineEndS),
          volley_start_s: String(volS),
          volley_end_s: String(volE),
          fepsp_start_s: String(fepS),
          fepsp_end_s: String(fepE),
          method: params.method,
          slope_low_pct: String(params.slopeLowPct),
          slope_high_pct: String(params.slopeHighPct),
          peak_direction: params.peakDirection,
          avg_n: String(Math.max(1, Math.round(params.avgN))),
        })
        if (params.seriesB != null) qs.set('series_b', String(params.seriesB))
        if (params.sweepIndices && params.sweepIndices.length > 0) {
          qs.set('sweeps', params.sweepIndices.join(','))
        }
        if (params.filterEnabled) {
          qs.set('filter_enabled', 'true')
          qs.set('filter_type', params.filterType ?? 'lowpass')
          qs.set('filter_low', String(params.filterLow ?? 1))
          qs.set('filter_high', String(params.filterHigh ?? 1000))
          qs.set('filter_order', String(params.filterOrder ?? 4))
        }
        return qs
      }
      // Parse a single backend point-dict into an FPspPoint. Used for
      // the primary response always; the PPR secondary response parses
      // into a "shadow" list that later gets merged into the primary.
      const parsePoint = (p: any): FPspPoint => ({
        sourceSeries: Number(p.source_series ?? series),
        binIndex: Number(p.bin_index ?? 0),
        sweepIndices: (p.sweep_indices ?? []).map((x: any) => Number(x)),
        meanSweepIndex: Number(p.mean_sweep_index ?? 0),
        baseline: Number(p.baseline ?? 0),
        volleyPeak: Number(p.volley_peak ?? 0),
        volleyPeakTs: Number(p.volley_peak_t_s ?? 0),
        volleyAmp: Number(p.volley_amp ?? 0),
        fepspPeak: Number(p.fepsp_peak ?? 0),
        fepspPeakTs: Number(p.fepsp_peak_t_s ?? 0),
        fepspAmp: Number(p.fepsp_amp ?? 0),
        slope: p.slope != null ? Number(p.slope) : null,
        slopeLow: p.slope_low_point
          ? { t: Number(p.slope_low_point.t), v: Number(p.slope_low_point.v) }
          : null,
        slopeHigh: p.slope_high_point
          ? { t: Number(p.slope_high_point.t), v: Number(p.slope_high_point.v) }
          : null,
        ratio: p.ratio != null ? Number(p.ratio) : null,
        flagged: Boolean(p.flagged),
      })

      const qs = buildQuery(
        params.volleyStartS, params.volleyEndS,
        params.fepspStartS, params.fepspEndS,
      )
      // PPR mode: fire the 2nd-response request in parallel with the
      // 1st. Both use the same baseline window + method/filter; only
      // the volley/fepsp windows differ. Merged by binIndex below.
      const wantPPR = mode === 'ppr'
        && params.volley2StartS != null && params.volley2EndS != null
        && params.fepsp2StartS != null && params.fepsp2EndS != null
      const qs2 = wantPPR
        ? buildQuery(
            params.volley2StartS!, params.volley2EndS!,
            params.fepsp2StartS!, params.fepsp2EndS!,
          )
        : null
      const [resp, resp2] = await Promise.all([
        apiFetch(backendUrl, `/api/fpsp/run?${qs}`),
        qs2 ? apiFetch(backendUrl, `/api/fpsp/run?${qs2}`) : Promise.resolve(null),
      ])
      const key = `${group}:${series}:${mode}`
      const existing = get().fpspCurves[key]
      const newPoints: FPspPoint[] = (resp.points ?? []).map(parsePoint)

      // Merge the 2nd-response fields into the primary points (matched
      // on binIndex + sourceSeries). PPR amp/slope ratios are computed
      // in |abs| terms so negative-going fEPSPs give sensibly-signed
      // ratios (both peak amplitudes are negative; R2/R1 is positive).
      if (wantPPR && resp2) {
        const second = new Map<string, any>()
        for (const p of (resp2.points ?? [])) {
          second.set(`${p.source_series}:${p.bin_index}`, p)
        }
        for (const p of newPoints) {
          const s = second.get(`${p.sourceSeries}:${p.binIndex}`)
          if (!s) continue
          p.volleyPeak2 = Number(s.volley_peak ?? 0)
          p.volleyPeakTs2 = Number(s.volley_peak_t_s ?? 0)
          p.volleyAmp2 = Number(s.volley_amp ?? 0)
          p.fepspPeak2 = Number(s.fepsp_peak ?? 0)
          p.fepspPeakTs2 = Number(s.fepsp_peak_t_s ?? 0)
          p.fepspAmp2 = Number(s.fepsp_amp ?? 0)
          p.slope2 = s.slope != null ? Number(s.slope) : null
          p.slopeLow2 = s.slope_low_point
            ? { t: Number(s.slope_low_point.t), v: Number(s.slope_low_point.v) }
            : null
          p.slopeHigh2 = s.slope_high_point
            ? { t: Number(s.slope_high_point.t), v: Number(s.slope_high_point.v) }
            : null
          const a1 = Math.abs(p.fepspAmp)
          const a2 = Math.abs(p.fepspAmp2 ?? 0)
          p.pprAmp = a1 > 0 ? a2 / a1 : null
          const s1 = p.slope != null ? Math.abs(p.slope) : null
          const s2Abs = p.slope2 != null ? Math.abs(p.slope2) : null
          p.pprSlope = (s1 != null && s1 > 0 && s2Abs != null) ? s2Abs / s1 : null
        }
      }

      // For append mode, only rows from the SAME source-series+bin pair
      // get replaced; everything else stays. Keeps points from seriesB
      // intact when the user re-runs on a single seriesA sweep, etc.
      let merged = newPoints
      if (params.appendToExisting && existing) {
        const ids = new Set(newPoints.map((p) => `${p.sourceSeries}:${p.binIndex}`))
        const kept = existing.points.filter(
          (p) => !ids.has(`${p.sourceSeries}:${p.binIndex}`),
        )
        merged = [...kept, ...newPoints].sort((a, b) => {
          if (a.sourceSeries !== b.sourceSeries) return a.sourceSeries - b.sourceSeries
          return a.binIndex - b.binIndex
        })
      }

      const next: FPspData = {
        mode,
        channel,
        responseUnit: String(resp.response_unit ?? existing?.responseUnit ?? ''),
        seriesA: series,
        seriesB: params.seriesB ?? null,
        stimOnsetS: Number(resp.stim_onset_s ?? existing?.stimOnsetS ?? 0),
        sweepIntervalA: Number(resp.sweep_interval_s ?? existing?.sweepIntervalA ?? 0),
        sweepIntervalB: Number(resp.sweep_interval_s_b ?? existing?.sweepIntervalB ?? 0),
        measurementMethod: params.method,
        slopeLowPct: params.slopeLowPct,
        slopeHighPct: params.slopeHighPct,
        peakDirection: params.peakDirection,
        avgN: Math.max(1, Math.round(params.avgN)),
        filterEnabled: Boolean(params.filterEnabled),
        filterType: params.filterType ?? 'lowpass',
        filterLow: Number(params.filterLow ?? 1),
        filterHigh: Number(params.filterHigh ?? 1000),
        filterOrder: Number(params.filterOrder ?? 4),
        baselineStartS: params.baselineStartS,
        baselineEndS: params.baselineEndS,
        volleyStartS: params.volleyStartS,
        volleyEndS: params.volleyEndS,
        fepspStartS: params.fepspStartS,
        fepspEndS: params.fepspEndS,
        timeAxis: existing?.timeAxis ?? 'timestamp',
        normalize: existing?.normalize ?? false,
        normBaselineFrom: existing?.normBaselineFrom ?? 1,
        normBaselineTo: existing?.normBaselineTo ?? Math.max(1, Math.min(10, merged.length)),
        points: merged,
        selectedIdx: null,
        // I-O mode only — preserved on the entry so the scatter plot
        // and results table can show intensities without re-prompting.
        ioInitialIntensity: mode === 'io'
          ? (params.ioInitialIntensity ?? existing?.ioInitialIntensity ?? 0)
          : existing?.ioInitialIntensity,
        ioIntensityStep: mode === 'io'
          ? (params.ioIntensityStep ?? existing?.ioIntensityStep ?? 0)
          : existing?.ioIntensityStep,
        ioUnit: mode === 'io'
          ? (params.ioUnit ?? existing?.ioUnit ?? 'µA')
          : existing?.ioUnit,
        ioMetric: mode === 'io'
          ? (params.ioMetric ?? existing?.ioMetric ?? 'slope')
          : existing?.ioMetric,
        // PPR mode only — echoed onto the entry so reopening the
        // window restores the 5 bands / ISI / metric toggle.
        volley2StartS: mode === 'ppr' ? params.volley2StartS : existing?.volley2StartS,
        volley2EndS: mode === 'ppr' ? params.volley2EndS : existing?.volley2EndS,
        fepsp2StartS: mode === 'ppr' ? params.fepsp2StartS : existing?.fepsp2StartS,
        fepsp2EndS: mode === 'ppr' ? params.fepsp2EndS : existing?.fepsp2EndS,
        pprIsiMs: mode === 'ppr' ? (params.pprIsiMs ?? existing?.pprIsiMs) : existing?.pprIsiMs,
        pprMetric: mode === 'ppr'
          ? (params.pprMetric ?? existing?.pprMetric ?? 'amp')
          : existing?.pprMetric,
      }
      set((s) => ({ fpspCurves: { ...s.fpspCurves, [key]: next }, loading: false }))
      _broadcastFPsp(get().fpspCurves)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearFPsp: (mode, group, series) => {
    set((s) => {
      if (group == null || series == null) return { fpspCurves: {} }
      const key = `${group}:${series}:${mode}`
      const { [key]: _dropped, ...rest } = s.fpspCurves
      return { fpspCurves: rest }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  selectFPspPoint: (mode, group, series, idx) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      return { fpspCurves: { ...s.fpspCurves, [key]: { ...entry, selectedIdx: idx } } }
    })
  },

  setFPspTimeAxis: (mode, group, series, axis) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      return { fpspCurves: { ...s.fpspCurves, [key]: { ...entry, timeAxis: axis } } }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  setFPspNormalize: (mode, group, series, normalize) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      return { fpspCurves: { ...s.fpspCurves, [key]: { ...entry, normalize } } }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  setFPspNormBaseline: (mode, group, series, from, to) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      const lo = Math.max(1, Math.min(from, to))
      const hi = Math.max(lo, Math.max(from, to))
      return {
        fpspCurves: {
          ...s.fpspCurves,
          [key]: { ...entry, normBaselineFrom: lo, normBaselineTo: hi },
        },
      }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  exportFPspCSV: async () => {
    const { fpspCurves, recording, backendUrl } = get()
    const keys = Object.keys(fpspCurves)
    if (keys.length === 0) return
    let fileName: string = recording?.fileName ?? ''
    if (!fileName && backendUrl) {
      try {
        const info = await fetch(`${backendUrl}/api/files/info`).then((r) => r.ok ? r.json() : null)
        if (info?.fileName) fileName = info.fileName
      } catch { /* ignore */ }
    }
    const header = [
      'file', 'mode', 'group', 'source_series', 'bin_index', 'sweep_indices',
      'io_intensity', 'io_unit',
      'baseline', 'volley_peak', 'volley_peak_t_s', 'volley_amp',
      'fepsp_peak', 'fepsp_peak_t_s', 'fepsp_amp',
      'ratio', 'flagged',
      'slope', 'slope_low_t_s', 'slope_low_v', 'slope_high_t_s', 'slope_high_v',
      'method', 'slope_low_pct', 'slope_high_pct',
      'peak_direction', 'avg_n', 'response_unit', 'stim_onset_s',
      'sweep_interval_s',
    ]
    const rows: string[] = [header.join(',')]
    for (const key of keys) {
      const [g] = key.split(':').map(Number)
      const entry = fpspCurves[key]
      const mode = entry.mode ?? 'ltp'
      entry.points.forEach((p) => {
        const ival = p.sourceSeries === entry.seriesA
          ? entry.sweepIntervalA
          : (entry.sweepIntervalB || 0)
        // I-O: one row per sweep; intensity = initial + sweepIndex * step.
        // Use the first (only) sweep in the bin. For LTP bins containing
        // multiple sweeps, leave intensity blank.
        const ioIntensity =
          mode === 'io' && p.sweepIndices.length === 1 &&
          entry.ioInitialIntensity != null && entry.ioIntensityStep != null
            ? (entry.ioInitialIntensity + p.sweepIndices[0] * entry.ioIntensityStep).toFixed(3)
            : ''
        rows.push([
          JSON.stringify(fileName),
          mode,
          g, p.sourceSeries, p.binIndex,
          JSON.stringify(p.sweepIndices.join(' ')),
          ioIntensity,
          mode === 'io' ? JSON.stringify(entry.ioUnit ?? 'µA') : '',
          p.baseline.toFixed(4),
          p.volleyPeak.toFixed(4),
          p.volleyPeakTs.toFixed(6),
          p.volleyAmp.toFixed(4),
          p.fepspPeak.toFixed(4),
          p.fepspPeakTs.toFixed(6),
          p.fepspAmp.toFixed(4),
          p.ratio != null ? p.ratio.toFixed(3) : '',
          p.flagged ? '1' : '0',
          p.slope != null ? p.slope.toFixed(4) : '',
          p.slopeLow ? p.slopeLow.t.toFixed(6) : '',
          p.slopeLow ? p.slopeLow.v.toFixed(4) : '',
          p.slopeHigh ? p.slopeHigh.t.toFixed(6) : '',
          p.slopeHigh ? p.slopeHigh.v.toFixed(4) : '',
          entry.measurementMethod,
          entry.slopeLowPct.toFixed(1),
          entry.slopeHighPct.toFixed(1),
          entry.peakDirection,
          entry.avgN,
          JSON.stringify(entry.responseUnit),
          entry.stimOnsetS.toFixed(6),
          ival.toFixed(4),
        ].join(','))
      })
    }
    const csv = rows.join('\n')
    const defaultName = (fileName || 'recording').replace(/\.[^.]+$/, '') + '_fpsp.csv'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
  },

  // ---- Action Potentials ----

  runAP: async (group, series, trace, imSource, sweepIndices, detection, kinetics, rheobaseMode, rampParams, manualEdits, measureKinetics) => {
    const { backendUrl } = get()
    if (!backendUrl) return
    set({ loading: true, error: null })
    try {
      // POST body — params are too nested for a query string. The
      // backend handles bounds_end_s = 0 as "use full sweep length".
      const body: Record<string, any> = {
        group, series, trace,
        sweeps: sweepIndices,
        detection,
        kinetics,
        rheobase_mode: rheobaseMode,
        ramp_params: rampParams,
        // Manual edits: convert sparse map keys (numbers) to strings
        // for the JSON wire (the backend re-parses them as ints).
        manual_edits: {
          added: Object.fromEntries(
            Object.entries(manualEdits.added).filter(([, v]) => v && v.length),
          ),
          removed: Object.fromEntries(
            Object.entries(manualEdits.removed).filter(([, v]) => v && v.length),
          ),
        },
        measure_kinetics: measureKinetics,
        // Im source — Auto means "reconstruct from stimulus protocol"
        // (default backend behavior), Manual passes start/step/window.
        manual_im_enabled: imSource.manualEnabled,
        manual_im_start_s: imSource.manualStartS,
        manual_im_end_s: imSource.manualEndS,
        manual_im_start_pa: imSource.manualStartPA,
        manual_im_step_pa: imSource.manualStepPA,
      }
      const resp = await fetch(`${backendUrl}/api/ap/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const txt = await resp.text()
        throw new Error(txt || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      // Convert per-sweep + per-spike rows from the snake_case backend
      // shape into our camelCase APData shape.
      const perSweep: APPerSweep[] = (data.per_sweep ?? []).map((p: any) => ({
        sweep: Number(p.sweep ?? 0),
        spikeCount: Number(p.spike_count ?? 0),
        peakTimes: (p.peak_times_s ?? []).map((t: any) => Number(t)),
        firstSpikeLatency: p.first_spike_latency_s != null ? Number(p.first_spike_latency_s) : null,
        meanISI: p.mean_isi_s != null ? Number(p.mean_isi_s) : null,
        sfaDivisor: p.sfa_divisor != null ? Number(p.sfa_divisor) : null,
        localVariance: p.local_variance != null ? Number(p.local_variance) : null,
        imMean: p.im_mean_pa != null ? Number(p.im_mean_pa) : null,
        spikeRateHz: p.spike_rate_hz != null ? Number(p.spike_rate_hz) : null,
      }))
      const perSpike: APPoint[] = (data.per_spike ?? []).map((p: any) => ({
        sweep: Number(p.sweep ?? 0),
        spikeIndex: Number(p.spike_index ?? 0),
        thresholdVm: Number(p.threshold_vm ?? 0),
        thresholdT: Number(p.threshold_t_s ?? 0),
        peakVm: Number(p.peak_vm ?? 0),
        peakT: Number(p.peak_t_s ?? 0),
        amplitudeMv: Number(p.amplitude_mv ?? 0),
        riseTimeS: p.rise_time_s != null ? Number(p.rise_time_s) : null,
        decayTimeS: p.decay_time_s != null ? Number(p.decay_time_s) : null,
        halfWidthS: p.half_width_s != null ? Number(p.half_width_s) : null,
        fahpVm: p.fahp_vm != null ? Number(p.fahp_vm) : null,
        fahpT: p.fahp_t_s != null ? Number(p.fahp_t_s) : null,
        mahpVm: p.mahp_vm != null ? Number(p.mahp_vm) : null,
        mahpT: p.mahp_t_s != null ? Number(p.mahp_t_s) : null,
        maxRiseSlopeMvMs: p.max_rise_slope_mv_ms != null ? Number(p.max_rise_slope_mv_ms) : null,
        maxDecaySlopeMvMs: p.max_decay_slope_mv_ms != null ? Number(p.max_decay_slope_mv_ms) : null,
        manual: Boolean(p.manual),
      }))
      const fi = data.fi_curve
      const fiCurve = fi
        ? {
            im: (fi.im ?? []).map((x: any) => Number(x)),
            rate: (fi.rate ?? []).map((x: any) => Number(x)),
            sweep: (fi.sweep ?? []).map((x: any) => Number(x)),
          }
        : null
      const next: APData = {
        group, series, trace,
        manualImEnabled: imSource.manualEnabled,
        manualImStartS: imSource.manualStartS,
        manualImEndS: imSource.manualEndS,
        manualImStartPA: imSource.manualStartPA,
        manualImStepPA: imSource.manualStepPA,
        detection, kinetics,
        rheobaseMode,
        rampParams,
        manualEdits,
        perSweep,
        perSpike,
        fiCurve,
        rheobase: data.rheobase ?? null,
        spikeTimesPerSweep: (data.spike_times_per_sweep ?? []).map(
          (xs: any) => (xs ?? []).map((t: any) => Number(t)),
        ),
        selectedSpikeIdx: null,
        imOnsetS: data.im_onset_s != null ? Number(data.im_onset_s) : null,
        samplingRate: Number(data.sampling_rate ?? 0),
        imSource: data.im_source ? {
          mode: data.im_source.mode as ImSource['mode'],
          label: data.im_source.label ?? null,
        } : undefined,
      }
      const key = `${group}:${series}`
      set((s) => ({ apAnalyses: { ...s.apAnalyses, [key]: next }, loading: false }))
      _broadcastAP(get().apAnalyses)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearAP: (group, series) => {
    set((s) => {
      if (group == null || series == null) return { apAnalyses: {} }
      const key = `${group}:${series}`
      const { [key]: _dropped, ...rest } = s.apAnalyses
      return { apAnalyses: rest }
    })
    _broadcastAP(get().apAnalyses)
  },

  selectAPSpike: (group, series, idx) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.apAnalyses[key]
      if (!entry) return s
      return { apAnalyses: { ...s.apAnalyses, [key]: { ...entry, selectedSpikeIdx: idx } } }
    })
    _broadcastAP(get().apAnalyses)
  },

  addManualAPSpike: async (group, series, sweep, timeS) => {
    const key = `${group}:${series}`
    // Insert the optimistic placeholder synchronously so the marker
    // appears immediately even on slow links. If the backend
    // measurement returns kinetics, we'll overwrite this row's
    // numeric fields below; if not, the placeholder stays and the
    // user can still see / remove it.
    let inserted = false
    set((s) => {
      const entry = s.apAnalyses[key]
      if (!entry) return s
      // Idempotency — if a spike (manual or auto) already exists at
      // this time within ~0.5 ms, skip the add. Stops a quick
      // double-click from inserting two markers on top of each other.
      const collidesAt = (t: number) =>
        entry.perSpike.some((sp) => sp.sweep === sweep && Math.abs(sp.peakT - t) < 5e-4)
      if (collidesAt(timeS)) return s
      // Append to manualEdits.added so the next Run applies the same
      // edit. Existing array might be undefined for sweeps the user
      // hasn't touched before.
      const addedForSweep = entry.manualEdits.added[sweep] ?? []
      const nextAdded = {
        ...entry.manualEdits.added,
        [sweep]: [...addedForSweep, timeS].sort((a, b) => a - b),
      }
      // Optimistic perSpike row — kinetics fields are blank until
      // either ``measure_one`` returns or the user re-Runs.
      const newSpike: APPoint = {
        sweep,
        spikeIndex: 0,             // re-numbered on next Run
        thresholdVm: 0,
        thresholdT: 0,
        peakVm: 0,
        peakT: timeS,
        amplitudeMv: 0,
        riseTimeS: null,
        decayTimeS: null,
        halfWidthS: null,
        fahpVm: null,
        fahpT: null,
        mahpVm: null,
        mahpT: null,
        maxRiseSlopeMvMs: null,
        maxDecaySlopeMvMs: null,
        manual: true,
      }
      const nextPerSpike = [...entry.perSpike, newSpike].sort((a, b) =>
        a.sweep !== b.sweep ? a.sweep - b.sweep : a.peakT - b.peakT,
      )
      // Mirror into perSweep[sweep].peakTimes so the counting view
      // reflects the manual addition.
      const nextPerSweep = entry.perSweep.map((p) => {
        if (p.sweep !== sweep) return p
        return {
          ...p,
          spikeCount: p.spikeCount + 1,
          peakTimes: [...p.peakTimes, timeS].sort((a, b) => a - b),
        }
      })
      inserted = true
      return {
        apAnalyses: {
          ...s.apAnalyses,
          [key]: {
            ...entry,
            manualEdits: { ...entry.manualEdits, added: nextAdded },
            perSpike: nextPerSpike,
            perSweep: nextPerSweep,
          },
        },
      }
    })
    if (!inserted) return
    _broadcastAP(get().apAnalyses)
    // Async: ask the backend for full kinetics on this single spike.
    // Uses the entry's last-Run detection + kinetics so the manual
    // measurement matches the auto-detected ones (same threshold
    // method, same filter, same rise/decay percents, …). If the
    // measurement fails (out-of-range, no clear spike at the click
    // point) the placeholder stays put and the user can still
    // remove it via the prime+reclick gesture.
    const st = get()
    if (!st.backendUrl) return
    const entry = st.apAnalyses[key]
    if (!entry) return
    try {
      const resp = await fetch(`${st.backendUrl}/api/ap/measure_one`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group, series, trace: entry.trace, sweep, peak_t_s: timeS,
          detection: entry.detection,
          kinetics: entry.kinetics,
        }),
      })
      if (!resp.ok) return
      const m: any = await resp.json()
      const measuredPeakT = Number(m.peak_t_s ?? timeS)
      set((s) => {
        const e = s.apAnalyses[key]
        if (!e) return s
        // Find the placeholder we just inserted. Match on the click
        // time (peakT === timeS) since the backend may have snapped
        // its peak to a slightly different sample.
        const idx = e.perSpike.findIndex(
          (sp) => sp.sweep === sweep && sp.manual && Math.abs(sp.peakT - timeS) < 1e-9,
        )
        if (idx < 0) return s
        const measured: APPoint = {
          ...e.perSpike[idx],
          thresholdVm: Number(m.threshold_vm ?? 0),
          thresholdT: Number(m.threshold_t_s ?? 0),
          peakVm: Number(m.peak_vm ?? 0),
          peakT: measuredPeakT,
          amplitudeMv: Number(m.amplitude_mv ?? 0),
          riseTimeS: m.rise_time_s != null ? Number(m.rise_time_s) : null,
          decayTimeS: m.decay_time_s != null ? Number(m.decay_time_s) : null,
          halfWidthS: m.half_width_s != null ? Number(m.half_width_s) : null,
          fahpVm: m.fahp_vm != null ? Number(m.fahp_vm) : null,
          fahpT: m.fahp_t_s != null ? Number(m.fahp_t_s) : null,
          mahpVm: m.mahp_vm != null ? Number(m.mahp_vm) : null,
          mahpT: m.mahp_t_s != null ? Number(m.mahp_t_s) : null,
          maxRiseSlopeMvMs: m.max_rise_slope_mv_ms != null ? Number(m.max_rise_slope_mv_ms) : null,
          maxDecaySlopeMvMs: m.max_decay_slope_mv_ms != null ? Number(m.max_decay_slope_mv_ms) : null,
          manual: true,
        }
        const nextPerSpike = [...e.perSpike]
        nextPerSpike[idx] = measured
        nextPerSpike.sort((a, b) =>
          a.sweep !== b.sweep ? a.sweep - b.sweep : a.peakT - b.peakT,
        )
        // Keep perSweep.peakTimes consistent with the snapped peak.
        const nextPerSweep = e.perSweep.map((p) => {
          if (p.sweep !== sweep) return p
          // Replace the original click time with the measured peak.
          const peakTimes = p.peakTimes
            .filter((t) => Math.abs(t - timeS) >= 1e-9)
          peakTimes.push(measuredPeakT)
          peakTimes.sort((a, b) => a - b)
          return { ...p, peakTimes }
        })
        return {
          apAnalyses: {
            ...s.apAnalyses,
            [key]: { ...e, perSpike: nextPerSpike, perSweep: nextPerSweep },
          },
        }
      })
      _broadcastAP(get().apAnalyses)
    } catch {
      /* network error — keep the placeholder; user can still curate */
    }
  },

  removeManualAPSpikeAt: (group, series, sweep, timeS) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.apAnalyses[key]
      if (!entry) return s
      // Find the closest spike on this sweep within 0.5 s; otherwise
      // the right-clicked / clicked location was just empty space.
      let bestIdx = -1, bestDist = Infinity
      entry.perSpike.forEach((sp, i) => {
        if (sp.sweep !== sweep) return
        const d = Math.abs(sp.peakT - timeS)
        if (d < bestDist) { bestDist = d; bestIdx = i }
      })
      if (bestIdx < 0 || bestDist > 0.5) return s
      const target = entry.perSpike[bestIdx]
      // Update manualEdits. Two cases:
      //   (a) target was a previously-added manual spike → strip it
      //       from manualEdits.added and skip ``removed`` (no auto
      //       spike to suppress).
      //   (b) target was auto-detected → push its peak time into
      //       manualEdits.removed so the next Run drops it again.
      const APPROX = 5e-4   // 0.5 ms tolerance for time-key matching
      let nextAdded = entry.manualEdits.added
      let nextRemoved = entry.manualEdits.removed
      const addedForSweep = entry.manualEdits.added[sweep] ?? []
      const matchedAddedIdx = addedForSweep.findIndex((t) => Math.abs(t - target.peakT) < APPROX)
      if (matchedAddedIdx >= 0) {
        const nextAddedForSweep = addedForSweep.filter((_, i) => i !== matchedAddedIdx)
        nextAdded = nextAddedForSweep.length > 0
          ? { ...entry.manualEdits.added, [sweep]: nextAddedForSweep }
          : Object.fromEntries(Object.entries(entry.manualEdits.added).filter(([k]) => k !== String(sweep)))
      } else {
        const removedForSweep = entry.manualEdits.removed[sweep] ?? []
        nextRemoved = {
          ...entry.manualEdits.removed,
          [sweep]: [...removedForSweep, target.peakT].sort((a, b) => a - b),
        }
      }
      const nextPerSpike = entry.perSpike.filter((_, i) => i !== bestIdx)
      const nextPerSweep = entry.perSweep.map((p) => {
        if (p.sweep !== sweep) return p
        return {
          ...p,
          spikeCount: Math.max(0, p.spikeCount - 1),
          peakTimes: p.peakTimes.filter((t) => Math.abs(t - target.peakT) >= APPROX),
        }
      })
      // Drop selectedSpikeIdx if it pointed at the removed spike.
      const nextSelected =
        entry.selectedSpikeIdx == null
          ? null
          : entry.selectedSpikeIdx === bestIdx
            ? null
            : entry.selectedSpikeIdx > bestIdx
              ? entry.selectedSpikeIdx - 1
              : entry.selectedSpikeIdx
      return {
        apAnalyses: {
          ...s.apAnalyses,
          [key]: {
            ...entry,
            manualEdits: { added: nextAdded, removed: nextRemoved },
            perSpike: nextPerSpike,
            perSweep: nextPerSweep,
            selectedSpikeIdx: nextSelected,
          },
        },
      }
    })
    _broadcastAP(get().apAnalyses)
  },

  // ---- Events ----

  runEvents: async (group, series, channel, sweep, params, template, onProgress) => {
    const { backendUrl } = get()
    if (!backendUrl) return
    set({ loading: true, error: null })
    try {
      // Gather manual edits from the current stored blob (if any) so
      // re-runs preserve user-added/removed events.
      const key = `${group}:${series}`
      const existing = get().eventsAnalyses[key]
      const addedTimes = existing?.manualEdits?.addedTimes ?? []
      const removedTimes = existing?.manualEdits?.removedTimes ?? []

      // Cross-sweep mode: build the sweep list from the current
      // recording's series. Skip excluded sweeps (same convention as
      // other analyses). For 'current' mode, leave `sweeps` off and
      // the backend runs just `sweep`.
      let sweepsArr: number[] | undefined
      if (params.sweepMode === 'all') {
        const rec = get().recording
        const totalSweeps = rec?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
        const excluded = new Set(get().excludedSweeps[`${group}:${series}`] ?? [])
        sweepsArr = []
        for (let i = 0; i < totalSweeps; i++) {
          if (!excluded.has(i)) sweepsArr.push(i)
        }
        if (sweepsArr.length === 0) sweepsArr = [sweep]
      }
      const body: Record<string, any> = {
        group, series, sweep, trace: channel,
        ...(sweepsArr ? { sweeps: sweepsArr } : {}),
        method: params.method,
        direction: params.peakDirection,
        filter_enabled: params.filterEnabled,
        filter_type: params.filterType,
        filter_low: params.filterLow,
        filter_high: params.filterHigh,
        filter_order: params.filterOrder,
        detrend_enabled: params.detrendEnabled,
        detrend_window_ms: params.detrendWindowMs,
        min_iei_ms: params.minIeiMs,
        baseline_search_ms: params.baselineSearchMs,
        avg_baseline_ms: params.avgBaselineMs,
        avg_peak_ms: params.avgPeakMs,
        rise_low_pct: params.riseLowPct,
        rise_high_pct: params.riseHighPct,
        decay_pct: params.decayPct,
        decay_search_ms: params.decaySearchMs,
        baseline_method: params.baselineMethod,
        baseline_poly_order: params.baselinePolyOrder,
        decay_endpoint_method: params.decayEndpointMethod,
        biexp_min_r2: params.biexpMinR2,
        amplitude_min_abs: (
          // When the user picks "× RMS" mode for Min |amp|, the floor
          // is derived from the quiet-region RMS instead of the
          // absolute value (the absolute is preserved on params for
          // mode-toggle round-trip). Falls back to the absolute when
          // RMS hasn't been computed yet — silent no-op so the run
          // still completes; the Min-amp card surfaces the warning.
          params.useRmsAmpFloor && params.rmsValue != null
            ? params.ampFloorRmsMultiplier * Math.abs(params.rmsValue)
            : params.amplitudeMinAbs
        ),
        amplitude_max_abs: params.amplitudeMaxAbs,
        auc_min_abs: params.aucMinAbs,
        rise_max_ms: params.riseMaxMs,
        decay_max_ms: params.decayMaxMs,
        fwhm_max_ms: params.fwhmMaxMs,
        // Ship only enabled skip regions (disabled ones are kept in
        // state so users can A/B by ticking the checkbox).
        skip_regions: (params.skipRegions ?? [])
          .filter((r) => r.enabled && r.endS > r.startS)
          .map((r) => [r.startS, r.endS]),
        manual_added_times: addedTimes,
        manual_removed_times: removedTimes,
        return_detection_measure: params.showDetectionMeasure
          && params.method.startsWith('template_'),
      }

      if (params.method === 'template_correlation' || params.method === 'template_deconvolution') {
        if (!template) throw new Error('Template methods require a selected template')
        // Primary template (preserved for single-template compat).
        body.template = {
          b0: template.b0,
          b1: template.b1,
          tau_rise_ms: template.tauRiseMs,
          tau_decay_ms: template.tauDecayMs,
          width_ms: template.widthMs,
        }
        // Multi-template: resolve additional IDs from the library and
        // send the full list. Backend prefers this when present.
        const { eventsTemplates } = get()
        const addl = (params.additionalTemplateIds ?? [])
          .map((id) => eventsTemplates.entries[id])
          .filter((t): t is EventsTemplate => !!t)
        if (addl.length > 0) {
          body.templates = [template, ...addl].map((t) => ({
            b0: t.b0, b1: t.b1,
            tau_rise_ms: t.tauRiseMs, tau_decay_ms: t.tauDecayMs,
            width_ms: t.widthMs,
          }))
        }
        body.cutoff = params.method === 'template_correlation'
          ? params.correlationCutoff
          : params.deconvCutoffSd
        body.deconv_low_hz = params.deconvLowHz
        body.deconv_high_hz = params.deconvHighHz
      } else if (params.method === 'threshold') {
        // Resolve linear vs RMS threshold into a single value.
        let t: number | null = null
        if (params.thresholdMode === 'linear') {
          t = params.linearThreshold
        } else if (params.thresholdMode === 'rms' && params.rmsValue != null) {
          const base = params.rmsBaselineMean ?? 0
          const sign = params.peakDirection === 'negative' ? -1 : 1
          t = base + sign * params.rmsMultiplier * params.rmsValue
        }
        if (t == null || !isFinite(t)) {
          throw new Error(
            params.thresholdMode === 'rms'
              ? 'Select a quiet region first to compute RMS'
              : 'Set a threshold value',
          )
        }
        body.threshold_value = t
      }

      // Streaming detection — NDJSON over POST. The backend yields one
      // ``{type:"progress", ...}`` line per sweep finished, then a
      // final ``{type:"result", data:{...}}`` line carrying the same
      // payload the original synchronous /detect endpoint returned.
      // Reading the body chunk-by-chunk lets us drive ``onProgress``
      // for the RUN button's gradual fill.
      const resp = await fetch(`${backendUrl}/api/events/detect_stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`)
      if (!resp.body) throw new Error('Streaming response has no body')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let data: any = null
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // Drain complete lines; the trailing fragment stays in ``buf``
        // until the next chunk arrives.
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line) continue
          let parsed: any
          try { parsed = JSON.parse(line) } catch { continue }
          if (parsed.type === 'progress') {
            onProgress?.(Number(parsed.fraction) || 0)
          } else if (parsed.type === 'result') {
            data = parsed.data
          } else if (parsed.type === 'error') {
            throw new Error(`HTTP ${parsed.status}: ${parsed.detail}`)
          }
        }
      }
      // Drain any final fragment without a trailing newline (defensive
      // — the backend always terminates with \n but defensive parsing
      // is cheap insurance).
      const tail = buf.trim()
      if (tail) {
        try {
          const parsed = JSON.parse(tail)
          if (parsed.type === 'result') data = parsed.data
        } catch { /* ignore */ }
      }
      if (!data) throw new Error('Detection completed without a result')
      // Final 100% tick so the UI button settles full before clearing.
      onProgress?.(1)

      const events: EventRow[] = (data.events ?? []).map((e: any) => ({
        sweep: Number(e.sweep ?? sweep),
        peakIdx: Number(e.peak_idx ?? 0),
        peakTimeS: Number(e.peak_time_s ?? 0),
        peakVal: Number(e.peak_val ?? 0),
        footIdx: Number(e.foot_idx ?? 0),
        footTimeS: Number(e.foot_time_s ?? 0),
        baselineVal: Number(e.baseline_val ?? 0),
        amplitude: Number(e.amplitude ?? 0),
        riseTimeMs: e.rise_time_ms == null ? null : Number(e.rise_time_ms),
        decayTimeMs: e.decay_time_ms == null ? null : Number(e.decay_time_ms),
        halfWidthMs: e.half_width_ms == null ? null : Number(e.half_width_ms),
        auc: e.auc == null ? null : Number(e.auc),
        decayEndpointIdx: e.decay_endpoint_idx == null ? null : Number(e.decay_endpoint_idx),
        decayTauMs: e.decay_tau_ms == null ? null : Number(e.decay_tau_ms),
        biexpTauRiseMs: e.biexp_tau_rise_ms == null ? null : Number(e.biexp_tau_rise_ms),
        biexpTauDecayMs: e.biexp_tau_decay_ms == null ? null : Number(e.biexp_tau_decay_ms),
        biexpB0: e.biexp_b0 == null ? null : Number(e.biexp_b0),
        biexpB1: e.biexp_b1 == null ? null : Number(e.biexp_b1),
        biexpR2: e.biexp_r2 == null ? null : Number(e.biexp_r2),
        manual: Boolean(e.manual),
        templateIdx: e.template_idx == null ? null : Number(e.template_idx),
        group: e.group == null ? null : Number(e.group),
      }))

      const dmRaw = data.detection_measure
      const detectionMeasure: EventsDetectionMeasure | undefined = dmRaw ? {
        values: (dmRaw.values ?? []).map((x: any) => Number(x)),
        dtS: Number(dmRaw.dt_s ?? 1),
        tStartS: Number(dmRaw.t_start_s ?? 0),
        method: dmRaw.method as 'correlation' | 'deconvolution',
        cutoffLine: Number(dmRaw.cutoff_line ?? 0),
        mu: dmRaw.mu != null ? Number(dmRaw.mu) : undefined,
        sigma: dmRaw.sigma != null ? Number(dmRaw.sigma) : undefined,
      } : undefined

      const next: EventsData = {
        group, series, channel, sweep,
        params,
        events,
        selectedIdx: null,
        manualEdits: { addedTimes, removedTimes },
        samplingRate: Number(data.sampling_rate ?? 0),
        sweepLengthS: Number(data.sweep_length_s ?? 0),
        totalLengthS: Number(data.total_length_s ?? data.sweep_length_s ?? 0),
        sweepsAnalysed: Array.isArray(data.sweeps_analysed)
          ? data.sweeps_analysed.map((n: any) => Number(n))
          : [sweep],
        units: String(data.units ?? ''),
        detectionMeasure,
      }
      set((s) => ({ eventsAnalyses: { ...s.eventsAnalyses, [key]: next }, loading: false }))
      _broadcastEvents(get().eventsAnalyses)
    } catch (err: any) {
      set({ error: err.message ?? String(err), loading: false })
    }
  },

  fitEventsTemplate: async (group, series, channel, sweep, tStartS, tEndS,
                             initialRiseMs = 0.5, initialDecayMs = 5.0,
                             direction = 'auto', filter = null) => {
    const { backendUrl } = get()
    if (!backendUrl) throw new Error('Backend not connected')
    const resp = await fetch(`${backendUrl}/api/events/template/fit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group, series, sweep, trace: channel,
        t_start_s: tStartS, t_end_s: tEndS,
        initial_rise_ms: initialRiseMs,
        initial_decay_ms: initialDecayMs,
        direction,
        filter_enabled: filter?.enabled ?? false,
        filter_type: filter?.type ?? 'bandpass',
        filter_low: filter?.low ?? 1,
        filter_high: filter?.high ?? 500,
        filter_order: filter?.order ?? 4,
      }),
    })
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`)
    const d = await resp.json()
    return {
      b0: Number(d.b0),
      b1: Number(d.b1),
      tauRiseMs: Number(d.tau_rise_ms),
      tauDecayMs: Number(d.tau_decay_ms),
      rSquared: Number(d.r_squared),
      timeS: (d.time_s ?? []).map((x: any) => Number(x)),
      fitValues: (d.fit_values ?? []).map((x: any) => Number(x)),
      regionValues: (d.region_values ?? []).map((x: any) => Number(x)),
      regionTStartS: Number(d.region_t_start_s),
    }
  },

  fetchEventsDetectionMeasure: async (group, series, channel, sweep, method, template,
                                       cutoff, direction, deconvLowHz, deconvHighHz,
                                       tStartS, tEndS, filter = null) => {
    const { backendUrl } = get()
    if (!backendUrl) throw new Error('Backend not connected')
    const resp = await fetch(`${backendUrl}/api/events/detection_measure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group, series, sweep, trace: channel,
        method,
        template: {
          b0: template.b0, b1: template.b1,
          tau_rise_ms: template.tauRiseMs,
          tau_decay_ms: template.tauDecayMs,
          width_ms: template.widthMs,
        },
        cutoff,
        direction,
        deconv_low_hz: deconvLowHz,
        deconv_high_hz: deconvHighHz,
        t_start_s: tStartS, t_end_s: tEndS,
        filter_enabled: filter?.enabled ?? false,
        filter_type: filter?.type ?? 'bandpass',
        filter_low: filter?.low ?? 1,
        filter_high: filter?.high ?? 500,
        filter_order: filter?.order ?? 4,
      }),
    })
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`)
    const d = await resp.json()
    return {
      values: (d.values ?? []).map((x: any) => Number(x)),
      dtS: Number(d.dt_s ?? 1),
      tStartS: Number(d.t_start_s ?? 0),
      method: d.method as 'correlation' | 'deconvolution',
      cutoffLine: Number(d.cutoff_line ?? 0),
      mu: d.mu != null ? Number(d.mu) : undefined,
      sigma: d.sigma != null ? Number(d.sigma) : undefined,
    }
  },

  computeEventsRms: async (group, series, channel, sweep, tStartS, tEndS, filter = null) => {
    const { backendUrl } = get()
    if (!backendUrl) throw new Error('Backend not connected')
    const resp = await fetch(`${backendUrl}/api/events/rms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group, series, sweep, trace: channel,
        t_start_s: tStartS, t_end_s: tEndS,
        filter_enabled: filter?.enabled ?? false,
        filter_type: filter?.type ?? 'bandpass',
        filter_low: filter?.low ?? 1,
        filter_high: filter?.high ?? 500,
        filter_order: filter?.order ?? 4,
      }),
    })
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`)
    const d = await resp.json()
    return {
      rms: Number(d.rms),
      baselineMean: Number(d.baseline_mean),
      nSamples: Number(d.n_samples),
    }
  },

  refineEventsTemplate: async (group, series, channel, sweep, events,
                                align, windowBeforeMs, windowAfterMs, direction) => {
    const { backendUrl } = get()
    if (!backendUrl) throw new Error('Backend not connected')
    const resp = await fetch(`${backendUrl}/api/events/refine_template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group, series, sweep, trace: channel,
        events: events.map((e) => ({
          sweep: e.sweep, peak_idx: e.peakIdx, peak_time_s: e.peakTimeS,
          peak_val: e.peakVal, foot_idx: e.footIdx, foot_time_s: e.footTimeS,
          baseline_val: e.baselineVal, amplitude: e.amplitude,
          manual: e.manual,
        })),
        align,
        window_before_ms: windowBeforeMs,
        window_after_ms: windowAfterMs,
        direction,
      }),
    })
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`)
    const d = await resp.json()
    return {
      nAveraged: Number(d.n_events_averaged),
      averageTimeS: (d.average_time_s ?? []).map((x: any) => Number(x)),
      averageValues: (d.average_values ?? []).map((x: any) => Number(x)),
      footSampleIdx: Number(d.foot_sample_idx ?? 0),
      fit: {
        b0: Number(d.fit.b0),
        b1: Number(d.fit.b1),
        tauRiseMs: Number(d.fit.tau_rise_ms),
        tauDecayMs: Number(d.fit.tau_decay_ms),
        rSquared: Number(d.fit.r_squared),
        fitTimeS: (d.fit.fit_time_s ?? []).map((x: any) => Number(x)),
        fitValues: (d.fit.fit_values ?? []).map((x: any) => Number(x)),
      },
    }
  },

  clearEvents: (group, series) => {
    set((s) => {
      if (group == null || series == null) return { eventsAnalyses: {} }
      const key = `${group}:${series}`
      const { [key]: _dropped, ...rest } = s.eventsAnalyses
      return { eventsAnalyses: rest }
    })
    _broadcastEvents(get().eventsAnalyses)
  },

  selectEvent: (group, series, idx) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.eventsAnalyses[key]
      if (!entry) return s
      return { eventsAnalyses: { ...s.eventsAnalyses, [key]: { ...entry, selectedIdx: idx } } }
    })
    _broadcastEvents(get().eventsAnalyses)
  },

  addManualEvent: async (group, series, timeS) => {
    const key = `${group}:${series}`
    const entry = get().eventsAnalyses[key]
    if (!entry) return
    // Clean up any pending "removed" entry at the same time — user may
    // have removed then changed their mind.
    const nextAdded = [...entry.manualEdits.addedTimes, timeS]
    const nextRemoved = entry.manualEdits.removedTimes.filter(
      (t) => Math.abs(t - timeS) > 0.001,
    )

    // Fast path: ask the backend to snap + measure ONLY this one
    // event, then splice it into the existing results. Avoids the
    // seconds-long full re-detection on every manual click.
    const { backendUrl } = get()
    if (!backendUrl) return
    let newRow: EventRow | null = null
    try {
      const p = entry.params
      const resp = await fetch(`${backendUrl}/api/events/add_manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group, series, sweep: entry.sweep, trace: entry.channel,
          click_time_s: timeS,
          direction: p.peakDirection,
          baseline_search_ms: p.baselineSearchMs,
          avg_baseline_ms: p.avgBaselineMs,
          avg_peak_ms: p.avgPeakMs,
          rise_low_pct: p.riseLowPct,
          rise_high_pct: p.riseHighPct,
          decay_pct: p.decayPct,
          decay_search_ms: p.decaySearchMs,
          filter_enabled: p.filterEnabled,
          filter_type: p.filterType,
          filter_low: p.filterLow,
          filter_high: p.filterHigh,
          filter_order: p.filterOrder,
        }),
      })
      if (resp.ok) {
        const d = await resp.json()
        const e = d.event
        newRow = {
          sweep: Number(e.sweep ?? entry.sweep),
          peakIdx: Number(e.peak_idx ?? 0),
          peakTimeS: Number(e.peak_time_s ?? 0),
          peakVal: Number(e.peak_val ?? 0),
          footIdx: Number(e.foot_idx ?? 0),
          footTimeS: Number(e.foot_time_s ?? 0),
          baselineVal: Number(e.baseline_val ?? 0),
          amplitude: Number(e.amplitude ?? 0),
          riseTimeMs: e.rise_time_ms == null ? null : Number(e.rise_time_ms),
          decayTimeMs: e.decay_time_ms == null ? null : Number(e.decay_time_ms),
          halfWidthMs: e.half_width_ms == null ? null : Number(e.half_width_ms),
          auc: e.auc == null ? null : Number(e.auc),
          decayEndpointIdx: e.decay_endpoint_idx == null ? null : Number(e.decay_endpoint_idx),
          decayTauMs: e.decay_tau_ms == null ? null : Number(e.decay_tau_ms),
          biexpTauRiseMs: e.biexp_tau_rise_ms == null ? null : Number(e.biexp_tau_rise_ms),
          biexpTauDecayMs: e.biexp_tau_decay_ms == null ? null : Number(e.biexp_tau_decay_ms),
          biexpB0: e.biexp_b0 == null ? null : Number(e.biexp_b0),
          biexpB1: e.biexp_b1 == null ? null : Number(e.biexp_b1),
          biexpR2: e.biexp_r2 == null ? null : Number(e.biexp_r2),
          manual: true,
          templateIdx: null,
          group: null,
        }
      }
    } catch {
      // Network error — fall through to just recording the addedTime
      // without measured kinetics. The next full re-run will pick it up.
    }

    // Splice the new row into the existing events list (sorted by
    // peak time) and drop any auto-detected peak at the same time.
    const prunedEvents = newRow
      ? entry.events.filter((ev) => Math.abs(ev.peakTimeS - newRow!.peakTimeS) > 0.001)
      : entry.events
    const insertedEvents = newRow
      ? [...prunedEvents, newRow].sort((a, b) => a.peakTimeS - b.peakTimeS)
      : prunedEvents

    const updated: EventsData = {
      ...entry,
      events: insertedEvents,
      manualEdits: { addedTimes: nextAdded, removedTimes: nextRemoved },
    }
    set((s) => ({ eventsAnalyses: { ...s.eventsAnalyses, [key]: updated } }))
    _broadcastEvents(get().eventsAnalyses)
  },

  removeEvent: async (group, series, idx) => {
    const key = `${group}:${series}`
    const entry = get().eventsAnalyses[key]
    if (!entry || idx < 0 || idx >= entry.events.length) return
    const target = entry.events[idx]
    // Manual-added events get dropped from the added-list, not logged
    // in removed — so the next run simply doesn't re-add them.
    let nextAdded = entry.manualEdits.addedTimes
    let nextRemoved = entry.manualEdits.removedTimes
    if (target.manual) {
      nextAdded = nextAdded.filter((t) => Math.abs(t - target.peakTimeS) > 0.001)
    } else {
      nextRemoved = [...nextRemoved, target.peakTimeS]
    }
    // Fast path: drop the row locally. A full re-run isn't needed —
    // removal is a pure subtraction. The `manualEdits.removedTimes`
    // list persists the decision so the next explicit "Run detection"
    // re-applies it.
    const nextEvents = entry.events.filter((_, i) => i !== idx)
    const nextSelected = entry.selectedIdx == null
      ? null
      : entry.selectedIdx === idx
        ? null
        : entry.selectedIdx > idx
          ? entry.selectedIdx - 1
          : entry.selectedIdx
    const updated: EventsData = {
      ...entry,
      events: nextEvents,
      selectedIdx: nextSelected,
      manualEdits: { addedTimes: nextAdded, removedTimes: nextRemoved },
    }
    set((s) => ({ eventsAnalyses: { ...s.eventsAnalyses, [key]: updated } }))
    _broadcastEvents(get().eventsAnalyses)
  },

  replaceEvent: (group, series, idx, row) => {
    const key = `${group}:${series}`
    const entry = get().eventsAnalyses[key]
    if (!entry || idx < 0 || idx >= entry.events.length) return
    const nextEvents = entry.events.slice()
    nextEvents[idx] = row
    const updated: EventsData = { ...entry, events: nextEvents }
    set((s) => ({ eventsAnalyses: { ...s.eventsAnalyses, [key]: updated } }))
    _broadcastEvents(get().eventsAnalyses)
  },

  setEventGroup: (group, series, idx, groupNum) => {
    const key = `${group}:${series}`
    const entry = get().eventsAnalyses[key]
    if (!entry || idx < 0 || idx >= entry.events.length) return
    const valid = groupNum == null
      ? null
      : (Number.isInteger(groupNum) && groupNum >= 1 && groupNum <= 5
          ? groupNum : null)
    const cur = entry.events[idx]
    if (cur.group === valid) return
    const nextEvents = entry.events.slice()
    nextEvents[idx] = { ...cur, group: valid }
    const updated: EventsData = { ...entry, events: nextEvents }
    set((s) => ({ eventsAnalyses: { ...s.eventsAnalyses, [key]: updated } }))
    _broadcastEvents(get().eventsAnalyses)
  },

  saveEventsTemplate: (template) => {
    set((s) => {
      const entries = { ...s.eventsTemplates.entries, [template.id]: template }
      const selectedId = s.eventsTemplates.selectedId ?? template.id
      return { eventsTemplates: { selectedId, entries } }
    })
    const { eventsTemplates } = get()
    _saveEventsTemplates(eventsTemplates.entries, eventsTemplates.selectedId)
    _broadcastEventsTemplates(eventsTemplates.selectedId, eventsTemplates.entries)
  },

  deleteEventsTemplate: (id) => {
    set((s) => {
      const { [id]: _dropped, ...entries } = s.eventsTemplates.entries
      const selectedId = s.eventsTemplates.selectedId === id
        ? Object.keys(entries)[0] ?? null
        : s.eventsTemplates.selectedId
      return { eventsTemplates: { selectedId, entries } }
    })
    const { eventsTemplates } = get()
    _saveEventsTemplates(eventsTemplates.entries, eventsTemplates.selectedId)
    _broadcastEventsTemplates(eventsTemplates.selectedId, eventsTemplates.entries)
  },

  selectEventsTemplate: (id) => {
    set((s) => ({
      eventsTemplates: { ...s.eventsTemplates, selectedId: id },
    }))
    const { eventsTemplates } = get()
    _saveEventsTemplates(eventsTemplates.entries, eventsTemplates.selectedId)
    _broadcastEventsTemplates(eventsTemplates.selectedId, eventsTemplates.entries)
  },
}))

/** Normalize a single-sweep burst-detector response into BurstRecord[]. */
function burstsFromResponse(m: any, sweepIndex: number): BurstRecord[] {
  const bursts: any[] = m.bursts ?? []
  return bursts.map((b) => ({
    sweepIndex,
    startS: Number(b.start_s ?? 0),
    endS: Number(b.end_s ?? 0),
    durationMs: Number(b.duration_ms ?? 0),
    peakAmplitude: Number(b.peak_amplitude ?? 0),
    peakSigned: Number(b.peak_signed ?? b.peak_amplitude ?? 0),
    peakTimeS: Number(b.peak_time_s ?? 0),
    meanAmplitude: Number(b.mean_amplitude ?? 0),
    integral: Number(b.integral ?? 0),
    riseTime10_90Ms: b.rise_time_10_90_ms != null ? Number(b.rise_time_10_90_ms) : null,
    decayHalfTimeMs: b.decay_half_time_ms != null ? Number(b.decay_half_time_ms) : null,
    preBurstBaseline: Number(b.pre_burst_baseline ?? 0),
    meanFrequencyHz: b.mean_frequency_hz != null ? Number(b.mean_frequency_hz) : null,
    nSpikes: b.n_spikes != null ? Number(b.n_spikes) : undefined,
  }))
}

/** Pull the signal-scale diagnostics block out of a detection response. */
function diagFromResponse(m: any): FieldBurstsDiag | undefined {
  const d = m.signal_diag
  if (!d) return undefined
  return {
    median: Number(d.median ?? 0),
    min: Number(d.min ?? 0),
    max: Number(d.max ?? 0),
    mad: Number(d.mad ?? 0),
    maxAbsDev: Number(d.max_abs_dev ?? 0),
    nSamples: Number(d.n_samples ?? 0),
    durationS: Number(d.duration_s ?? 0),
  }
}

// All per-recording analysis state (events / bursts / AP / IV / FPsp /
// cursor / resistance + auxiliaries like excluded + averaged sweeps)
// persists exclusively through the .tracer sidecar — the
// debounced subscriber lives below this block. The legacy per-slice
// Electron-prefs writers were removed; sidecar is the only source of
// truth for files we open.

// Cursor window UI prefs — global (not per-file). Persist via electronAPI
// under 'cursorWindowUI' so the splitter position + selected columns survive
// restarts.
let _lastPersistedCursorUIRef: CursorWindowUI | null = null
useAppStore.subscribe((state) => {
  if (state.cursorWindowUI === _lastPersistedCursorUIRef) return
  _lastPersistedCursorUIRef = state.cursorWindowUI
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences) return
  api.getPreferences().then((prefs) => {
    api.setPreferences!({ ...(prefs ?? {}), cursorWindowUI: state.cursorWindowUI }).catch(() => { /* ignore */ })
  }).catch(() => { /* ignore */ })
})

// ---------------------------------------------------------------------------
// Per-recording sidecar auto-save.
//
// One subscriber watches all the slices that belong in the .tracer
// sidecar. On any change it schedules a debounced write — coalescing bursts
// of updates (typing a param into a NumInput, dragging cursors, etc.) into
// a single file write. Runs in parallel with the legacy per-slice prefs
// writers above so existing users don't lose state during the transition.
// ---------------------------------------------------------------------------
let _sidecarTimer: ReturnType<typeof setTimeout> | null = null
let _sidecarRefs = {
  events: null as any,
  bursts: null as any,
  ap: null as any,
  iv: null as any,
  fpsp: null as any,
  cursorAnalyses: null as any,
  resistanceResults: null as any,
  burstFormParams: null as any,
  trainParams: null as any,
  excluded: null as any,
  averaged: null as any,
  cursors: null as any,
  resistanceForm: null as any,
  recordingMeta: null as any,
  scaleOverrides: null as any,
  filtersBySeries: null as any,
}
useAppStore.subscribe((state) => {
  // Same gate as the per-slice prefs subscribers above: skip while
  // ``loading`` is true so the openFile clear-state transition
  // can't schedule a phantom save with a stale filePath.
  if (state.loading) return
  const filePath = state.recording?.filePath
  if (!filePath) return
  const next = {
    events: state.eventsAnalyses,
    bursts: state.fieldBursts,
    ap: state.apAnalyses,
    iv: state.ivCurves,
    fpsp: state.fpspCurves,
    cursorAnalyses: state.cursorAnalyses,
    resistanceResults: state.resistanceResults,
    burstFormParams: state.burstFormParams,
    trainParams: state.trainParams,
    excluded: state.excludedSweeps,
    averaged: state.averagedSweeps,
    cursors: state.cursors,
    resistanceForm: state.resistanceForm,
    recordingMeta: state.recordingMeta,
    scaleOverrides: state.scaleOverrides,
    filtersBySeries: state.filtersBySeries,
  }
  // Reference-equality check across the tracked slices — avoids
  // re-scheduling on unrelated state churn (e.g. trace fetches).
  let changed = false
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    if (next[k] !== _sidecarRefs[k]) { changed = true; break }
  }
  if (!changed) return
  _sidecarRefs = next
  if (_sidecarTimer) clearTimeout(_sidecarTimer)
  _sidecarTimer = setTimeout(() => {
    _sidecarTimer = null
    _saveSidecar(filePath, useAppStore.getState())
  }, SIDECAR_DEBOUNCE_MS)
})

// Flush the sidecar on page unload so a quick close-and-quit after a
// change still writes. synchronous IPC via sendSync isn't available on
// context-isolated channels, but electron keeps the main process alive
// briefly during renderer teardown so the async invoke usually makes it
// through. Best-effort.
window.addEventListener('beforeunload', () => {
  const state = useAppStore.getState()
  const filePath = state.recording?.filePath
  if (!filePath) return
  if (_sidecarTimer) {
    clearTimeout(_sidecarTimer)
    _sidecarTimer = null
  }
  // Fire-and-forget — renderer can't block the unload.
  void _saveSidecar(filePath, state)
})

declare global {
  interface Window {
    electronAPI?: {
      syncPreferences: Record<string, unknown>
      platform?: string
      openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>
      getBackendUrl: () => Promise<string>
      openFileDialog: () => Promise<string | null>
      openFolderDialog: (defaultPath?: string) => Promise<string | null>
      saveFileDialog: (defaultName: string, filters?: { name: string; extensions: string[] }[]) => Promise<string | null>
      writeTextFile: (targetPath: string, contents: string) => Promise<{ ok: boolean; error?: string }>
      writeBinaryFile: (targetPath: string, base64: string) => Promise<{ ok: boolean; error?: string }>
      getPreferences: () => Promise<Record<string, unknown>>
      setPreferences: (prefs: Record<string, unknown>) => Promise<boolean>
      readSidecar: (recordingPath: string) => Promise<Record<string, unknown> | null>
      writeSidecar: (recordingPath: string, payload: Record<string, unknown>) => Promise<boolean>
      readCohortSession: (sessionPath: string) => Promise<Record<string, unknown> | null>
      writeCohortSession: (sessionPath: string, payload: Record<string, unknown>) => Promise<boolean>
      openCohortSessionDialog: () => Promise<string | null>
      readFigureSession: (sessionPath: string) => Promise<Record<string, unknown> | null>
      writeFigureSession: (sessionPath: string, payload: Record<string, unknown>) => Promise<boolean>
      openFigureSessionDialog: () => Promise<string | null>
      listFolderRecordings: (anchorPath: string) => Promise<{
        folder: string | null
        entries: Array<{
          filePath: string
          fileName: string
          hasSidecar: boolean
          meta?: Record<string, unknown> | null
        }>
      }>
      openAnalysisWindow: (type: string) => Promise<boolean>
      closeAnalysisWindow: (type: string) => Promise<boolean>
      getOpenAnalysisWindows: () => Promise<string[]>
      onAnalysisWindowClosed: (callback: (type: string) => void) => () => void
      /** Point Electron's nativeTheme at the user's choice so native
       *  menus, dialogs and title bars match. */
      setThemeSource?: (pref: 'system' | 'light' | 'dark') => void
      /** Native menu-bar commands, delivered to the focused window. */
      onMenuAction?: (callback: (action: string, arg?: string) => void) => () => void
      /** Tell the menu bar whether a recording is open (enables Analysis items). */
      setMenuState?: (state: { hasRecording?: boolean }) => void
    }
  }
}
