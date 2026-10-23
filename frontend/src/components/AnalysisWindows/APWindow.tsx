import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  APData, APDetectionMethod, APDetectionParams, APKineticsParams,
  APThresholdMethod, APRampParams, APRheobaseMode, APManualEdits,
  APPoint, APPerSweep,
} from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { ImSourceCard } from '../common/ImSourceCard'
import { ChannelsOverlaySelect, STIMULUS_OVERLAY_KEY } from '../common/ChannelsOverlaySelect'
import { OverlayTraceViewer, OverlayChannel } from '../common/OverlayTraceViewer'
import { usePlotMenu } from '../common/PlotMenu'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'
import { sampleTraceYAt } from '../../utils/sampleTraceY'
import { TrainOptions, defaultTrainParamsFor } from './TrainOptions'
import type { TrainParams, TrainSummary } from '../../utils/trains'
import { computeApTrainIds } from '../../utils/apTrains'

/**
 * Action Potentials analysis window.
 *
 * One detection stage feeds three tabs:
 * - **Counting** — spikes/sweep, F-I curve, rheobase.
 * - **Kinetics** — per-spike table (threshold, peak, amp, rise/decay,
 *   FWHM, fAHP, mAHP, max rise/decay slopes). 8 threshold methods.
 * - **Phase plot** — Vm vs dV/dt for one spike at a time.
 *
 * Mini-viewer on the left shows the current preview sweep with
 * draggable analysis-bounds bands + spike markers. Tab-specific
 * results panel on the right.
 *
 * Persistence: `apAnalyses[group:series]`. Auto-seed series on window
 * reopen from the saved entry's series.
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Marker colours are theme tokens; canvas code resolves them with
// ``cssVar`` at draw time so a theme switch is picked up on redraw.
const BOUND_COLOR = '--marker-bounds'     // analysis-bounds bands
const SPIKE_COLOR = '--marker-detected'   // detected spike peak dots
const MANUAL_COLOR = '--marker-manual'    // manually-added spike ring

/** Per-quantity kinetics marker tokens (peak / threshold / FWHM /
 *  fAHP / mAHP). Shared by both viewers and the legend so the
 *  colour → quantity mapping stays identical everywhere. */
const AP_MARKER = {
  peak: '--marker-detected',
  threshold: '--text-muted',
  fwhm: '--warning',
  fahp: '--cursor-peak',
  mahp: '--cursor-fit',
} as const

// Default detection params — match what `analysis/ap.py` falls back to
// when fields are missing. Values picked to work on a typical 10 kHz
// current-clamp recording with healthy spikes (~100 mV amplitude).
const DEFAULT_DETECTION: APDetectionParams = {
  method: 'auto_rec',
  manual_threshold_mv: -10,
  min_amplitude_mv: 50,
  pos_dvdt_mv_ms: 10,
  neg_dvdt_mv_ms: -10,
  width_ms: 5,
  min_distance_ms: 2,
  bounds_start_s: 0,
  bounds_end_s: 0,            // 0 = use full sweep length (backend default)
  filter_enabled: false,
  filter_type: 'lowpass',
  filter_low: 1,
  filter_high: 2000,
  filter_order: 2,
}

const DEFAULT_KINETICS: APKineticsParams = {
  threshold_method: 'sekerli_I',
  threshold_cutoff_mv_ms: 20,
  threshold_search_ms_before_peak: 5,
  sekerli_lower_bound_mv_ms: 5,
  rise_low_pct: 10,
  rise_high_pct: 90,
  decay_low_pct: 10,
  decay_high_pct: 90,
  decay_end: 'to_threshold',
  fahp_search_start_ms: 0,
  fahp_search_end_ms: 5,
  mahp_search_start_ms: 5,
  mahp_search_end_ms: 100,
  max_slope_window_ms: 0.5,
  interpolate_to_200khz: true,
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

export function APWindow({
  backendUrl, fileInfo, mainGroup, mainSeries, mainTrace,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
}) {
  const {
    apAnalyses, runAP, clearAP, selectAPSpike,
    addManualAPSpike, removeManualAPSpikeAt,
    trainParams,
    loading, error, setError,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // ---- Selectors ----
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [trace, setTrace] = useState(mainTrace ?? 0)
  // Im source — matches IV's manual-Im fallback. Auto (default) means
  // the backend reconstructs Im from the recording's stimulus protocol.
  // Manual bypasses that with user-supplied start/step/window values.
  // The old "Im series" + "Im channel" selectors are gone; users who
  // need to override auto-detect use Manual instead. See ImSourceCard
  // + /api/ap/run's manual_im_* params.
  const [manualImEnabled, setManualImEnabled] = useState(false)
  const [manualImStartS, setManualImStartS] = useState(0)
  const [manualImEndS, setManualImEndS] = useState(0)
  const [manualImStartPA, setManualImStartPA] = useState(0)
  const [manualImStepPA, setManualImStepPA] = useState(0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setTrace(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])
  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0 && trace >= channels.length) setTrace(0)
  }, [channels, trace])

  // Overlay channels — extra channels / stimulus to display as
  // stacked subplots under the primary viewer. Analysis never runs
  // on overlay channels; they're for visual context only (e.g. see
  // the stim step while placing analysis bounds on Vm).
  const [overlayChannels, setOverlayChannels] = useState<number[]>([])
  // Drop any overlay that stops existing after a series/channel change.
  useEffect(() => {
    setOverlayChannels((prev) => prev.filter((idx) => {
      if (idx === STIMULUS_OVERLAY_KEY) return true
      return channels.some((c: any) => c.index === idx)
    }))
  }, [channels])
  const hasStimulus = useMemo(() => {
    const ser = fileInfo?.groups?.[group]?.series?.[series]
    return Boolean(ser?.stimulus)
  }, [fileInfo, group, series])
  // Current X range from the primary viewer — drives all overlay
  // subplots. null = auto-fit (each subplot falls back to its own data
  // extents). React state rather than a ref so setter propagates a
  // re-render to overlays.
  const [primaryXRange, setPrimaryXRange] = useState<[number, number] | null>(null)

  // ---- Tab ----
  type APTab = 'counting' | 'kinetics'
  const [tab, setTab] = useState<APTab>('counting')
  // Per-tab visibility signals — bumped when the user switches tabs
  // so each panel's uPlot re-fits + redraws after coming back into
  // view. Without this the kinetics phase plot stayed blank or
  // wrongly-sized until something else triggered a rebuild.
  const [countingVis, setCountingVis] = useState(0)
  const [kineticsVis, setKineticsVis] = useState(0)
  useEffect(() => {
    if (tab === 'counting') setCountingVis((n) => n + 1)
    if (tab === 'kinetics') setKineticsVis((n) => n + 1)
  }, [tab])
  void countingVis  // reserved for future Counting-tab plot resizes

  // When the user enters the Kinetics tab and there's a result with
  // at least one spike, auto-select the first one (so the right-side
  // phase plot has something to draw and the left viewer auto-zooms).
  // Skipped when a spike is already selected so we don't override
  // the user's pick from a previous kinetics session.
  useEffect(() => {
    if (tab !== 'kinetics') return
    const e = useAppStore.getState().apAnalyses[`${group}:${series}`]
    if (!e || e.perSpike.length === 0) return
    if (e.selectedSpikeIdx == null) {
      selectAPSpike(group, series, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, group, series, apAnalyses])

  // ---- Detection / kinetics / rheobase / ramp ----
  // Initially pull filter from main viewer if it's enabled, mirroring
  // the burst / FPsp behaviour. Saved entry for the active series
  // overrides this via the rehydration effect below.
  const [detection, setDetection] = useState<APDetectionParams>(() => {
    const mf = useAppStore.getState().filter
    if (mf.enabled) {
      return {
        ...DEFAULT_DETECTION,
        filter_enabled: true,
        filter_type: mf.type,
        filter_low: mf.lowCutoff,
        filter_high: mf.highCutoff,
        filter_order: mf.order,
      }
    }
    return DEFAULT_DETECTION
  })
  const [kinetics, setKinetics] = useState<APKineticsParams>(DEFAULT_KINETICS)
  const [rheobaseMode, setRheobaseMode] = useState<APRheobaseMode>('record')
  const [rampParams, setRampParams] = useState<APRampParams>({
    t_start_s: 0, t_end_s: 1, im_start_pa: 0, im_end_pa: 200,
  })

  // ---- Manual edits — local until next run ----
  const [manualEdits, setManualEdits] = useState<APManualEdits>({ added: {}, removed: {} })

  // ---- Multi-spike selection (Kinetics tab) ----
  // Independent from the per-row "active" selection (selectedSpikeIdx
  // in the entry). When the user checks multiple spikes, the kinetics
  // viewer overlays them (zoomed, time-aligned to peak) and the phase
  // plot overlays their loops. Empty set → fall back to the active
  // single-spike selection so the panel never has nothing to show.
  const [selectedSpikeSet, setSelectedSpikeSet] = useState<Set<number>>(new Set())
  const toggleSpikeSelected = useCallback((idx: number) => {
    setSelectedSpikeSet((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }, [])
  const clearSpikeSelection = useCallback(() => setSelectedSpikeSet(new Set()), [])
  const selectAllSpikes = useCallback(() => {
    const e = useAppStore.getState().apAnalyses[`${group}:${series}`]
    if (!e) return
    setSelectedSpikeSet(new Set(e.perSpike.map((_, i) => i)))
  }, [group, series])
  // "Hide markers" — toggles the threshold/peak/half/AHP dots on
  // both the zoomed-spike viewer and the phase plot. Useful when
  // overlaying many spikes — markers from N spikes get noisy.
  const [hideMarkers, setHideMarkers] = useState(false)
  // Visibility of the analysis-bounds bands in the AP sweep viewer.
  // Toggling this to ``false`` hides the blue cursors AND disables
  // their hit-test so the user can click straight through the area
  // they normally cover (helpful when manual add/remove markers fall
  // behind a bound). Persisted in Electron prefs under
  // ``apWindowUI.showBounds`` so the choice survives restarts.
  const [showBounds, setShowBounds] = useState(true)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const saved = prefs?.apWindowUI?.showBounds
        if (!cancelled && typeof saved === 'boolean') setShowBounds(saved)
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  const setShowBoundsAndPersist = useCallback((v: boolean) => {
    setShowBounds(v)
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences || !api?.setPreferences) return
        const prefs = (await api.getPreferences()) ?? {}
        const next = { ...(prefs.apWindowUI ?? {}), showBounds: v }
        await api.setPreferences({ ...prefs, apWindowUI: next })
      } catch { /* ignore */ }
    })()
  }, [])
  // Reset selection when the entry changes (new run, new series).
  useEffect(() => {
    setSelectedSpikeSet(new Set())
  }, [`${group}:${series}`])  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Run controls ----
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  useEffect(() => {
    if (totalSweeps > 0) {
      setSweepFrom(1)
      setSweepTo(totalSweeps)
      setSweepOne((s) => Math.min(Math.max(1, s), totalSweeps))
    }
  }, [totalSweeps])

  // ---- Preview sweep ----
  const [previewSweep, setPreviewSweep] = useState(0)
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, totalSweeps - 1)))
  }, [totalSweeps])

  // Zoom-to-spike request: bumped each time a kinetics row is
  // clicked OR when the kinetics tab becomes active with a spike
  // already selected. The viewer watches `bump` and applies x range
  // = peakT ± halfMs. Counter-based so re-clicking the SAME spike
  // re-zooms (e.g. after the user has panned away to inspect).
  const [zoomRequest, setZoomRequest] = useState<
    { bump: number; centerT: number; halfMs: number } | null
  >(null)
  const requestZoomToSpike = useCallback((peakT: number, halfMs: number = 10) => {
    setZoomRequest((prev) => ({ bump: (prev?.bump ?? 0) + 1, centerT: peakT, halfMs }))
  }, [])

  // Auto-zoom the kinetics-tab left viewer to the selected spike
  // whenever (a) the tab is active and (b) the selection changes
  // (or the tab just became active with a non-null selection). The
  // entry lookup happens inline because `entry` is declared further
  // down in the component and we don't want a circular dep.
  const apAnalysesRef = useRef(apAnalyses)
  apAnalysesRef.current = apAnalyses
  useEffect(() => {
    if (tab !== 'kinetics') return
    const e = apAnalysesRef.current[`${group}:${series}`]
    if (!e || e.selectedSpikeIdx == null) return
    const sp = e.perSpike[e.selectedSpikeIdx]
    if (!sp) return
    setPreviewSweep(sp.sweep)
    requestZoomToSpike(sp.peakT, 15)
    // Trigger on tab change, on series change, and on the apAnalyses
    // identity changing (a Run completed, selection changed, etc.).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, group, series, apAnalyses, requestZoomToSpike])

  // ---- Per-window splitter (persisted) ----
  // The mini-viewer reads `topHeight` as a heightSignal — every time
  // the splitter (or window resize via ResizeObserver inside the
  // viewer) bumps it, the viewer's uPlot re-fits to the container.
  // The value persists in Electron prefs under `apWindowUI.topHeight`
  // so the user's preferred split survives close/reopen and
  // app-restart cycles. Other analysis windows can adopt the same
  // pattern (FPsp / Burst still default-only).
  const [topHeight, setTopHeight] = useState(280)
  // Hydrate from prefs once on mount. Sync (state-update) doesn't
  // help here because this is local UI state, not shared via the
  // BroadcastChannel.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const saved = prefs?.apWindowUI?.topHeight
        if (!cancelled && typeof saved === 'number'
            && saved >= 150 && saved <= 800) {
          setTopHeight(saved)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  // Persist on splitter mouseup (one write per drag, not per pixel
  // — typing/dragging UI shouldn't spam prefs writes).
  const writeTopHeightToPrefs = useCallback(async (h: number) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.apWindowUI ?? {}), topHeight: h }
      await api.setPreferences({ ...prefs, apWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  // Left-panel width (vertical splitter between params column and
  // viewer+results). Same prefs-persistence recipe as topHeight:
  // hydrate on mount, write on mouseup-end-of-drag, clamp the saved
  // value on restore so a pathologically small / large persisted
  // width can't wedge the UI.
  const [leftPanelWidth, setLeftPanelWidth] = useState(320)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const saved = prefs?.apWindowUI?.leftPanelWidth
        if (!cancelled && typeof saved === 'number'
            && saved >= 200 && saved <= 500) {
          setLeftPanelWidth(saved)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  const writeLeftPanelWidthToPrefs = useCallback(async (w: number) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.apWindowUI ?? {}), leftPanelWidth: w }
      await api.setPreferences({ ...prefs, apWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  const onLeftSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftPanelWidth
    let latest = startW
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      latest = Math.max(200, Math.min(500, startW + dx))
      setLeftPanelWidth(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeLeftPanelWidthToPrefs(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = topHeight
    let latest = startH
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      latest = Math.max(150, Math.min(800, startH + dy))
      setTopHeight(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Save once at end-of-drag rather than per-pixel.
      writeTopHeightToPrefs(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }


  // ---- Lookup + rehydrate ----
  const key = `${group}:${series}`
  const entry: APData | undefined = apAnalyses[key]

  // Train-grouping (post-detection cluster of closely spaced spikes —
  // useful for adapting / non-adapting cell classification, or for
  // splitting "high-frequency" bursts within depolarising current
  // pulses). Pure derivation: walk perSpike per-sweep, run the
  // shared algorithm, hand back the global per-spike train_id and
  // per-sweep summaries. Manual edits to ``perSpike`` invalidate the
  // memo automatically.
  const storedTrainParams = trainParams.ap[key] as
    | (TrainParams & { enabled?: boolean })
    | undefined
  const effectiveTrainParams = storedTrainParams ?? defaultTrainParamsFor('ap')
  const trainsEnabled = effectiveTrainParams.enabled === true
  const trainData = useMemo(
    () => computeApTrainIds(
      entry?.perSpike ?? [],
      { ...effectiveTrainParams, enabled: trainsEnabled },
    ),
    [entry?.perSpike, trainsEnabled, effectiveTrainParams.metric,
      effectiveTrainParams.maxIeiMs, effectiveTrainParams.minCount,
      effectiveTrainParams.minDurationMs, effectiveTrainParams.minInterTrainMs],
  )
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entry) return
    if (rehydratedKeyRef.current === key) return
    rehydratedKeyRef.current = key
    setTrace(entry.trace)
    setManualImEnabled(entry.manualImEnabled ?? false)
    setManualImStartS(entry.manualImStartS ?? 0)
    setManualImEndS(entry.manualImEndS ?? 0)
    setManualImStartPA(entry.manualImStartPA ?? 0)
    setManualImStepPA(entry.manualImStepPA ?? 0)
    setDetection(entry.detection)
    setKinetics(entry.kinetics)
    setRheobaseMode(entry.rheobaseMode)
    if (entry.rampParams) setRampParams(entry.rampParams)
    setManualEdits(entry.manualEdits ?? { added: {}, removed: {} })
    // Optional on pre-v0.3.1 saves — guard each field individually.
    if (entry.runMode) setRunMode(entry.runMode)
    if (entry.sweepFrom != null) setSweepFrom(entry.sweepFrom)
    if (entry.sweepTo != null) setSweepTo(entry.sweepTo)
    if (entry.sweepOne != null) setSweepOne(entry.sweepOne)
  }, [entry, key])

  // ---- Auto-seed series on window reopen from the saved AP entries
  // for this group, falling back to the main viewer's series if none. ----
  const autoSeededRef = useRef(false)
  const manuallyChangedSeriesRef = useRef(false)
  useEffect(() => {
    if (autoSeededRef.current) return
    if (manuallyChangedSeriesRef.current) return
    if (!fileInfo) return
    const prefix = `${group}:`
    let best: number | null = null
    for (const k of Object.keys(apAnalyses)) {
      if (!k.startsWith(prefix)) continue
      const parts = k.split(':')
      if (parts.length !== 2) continue
      const s = Number(parts[1])
      if (!isFinite(s)) continue
      if (best == null || s > best) best = s
    }
    if (best != null && best !== series) {
      autoSeededRef.current = true
      setSeries(best)
    }
  }, [apAnalyses, group, fileInfo, series])
  const onSeriesChange = (v: number) => {
    manuallyChangedSeriesRef.current = true
    setSeries(v)
  }

  // ---- Sweep trace fetch (mini-viewer) ----
  const [traceTime, setTraceTime] = useState<number[] | null>(null)
  const [traceValues, setTraceValues] = useState<number[] | null>(null)
  const [traceUnits, setTraceUnits] = useState<string>('mV')
  const [zeroOffset, setZeroOffset] = useState(false)
  const [zeroOffsetApplied, setZeroOffsetApplied] = useState(0)
  useEffect(() => {
    if (!backendUrl || totalSweeps === 0) {
      setTraceTime(null); setTraceValues(null); return
    }
    const qs = new URLSearchParams({
      group: String(group), series: String(series),
      sweep: String(previewSweep), trace: String(trace),
      max_points: '0',  // full resolution — sweeps are short for AP
    })
    if (zeroOffset) qs.set('zero_offset', 'true')
    if (detection.filter_enabled) {
      qs.set('filter_type', detection.filter_type)
      qs.set('filter_low', String(detection.filter_low))
      qs.set('filter_high', String(detection.filter_high))
      qs.set('filter_order', String(detection.filter_order))
    }
    let cancelled = false
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((d) => {
        if (cancelled) return
        setTraceTime(d.time ?? [])
        setTraceValues(d.values ?? [])
        setTraceUnits(d.units ?? 'mV')
        setZeroOffsetApplied(Number(d.zero_offset ?? 0))
      })
      .catch(() => { if (!cancelled) { setTraceTime(null); setTraceValues(null) } })
    return () => { cancelled = true }
  }, [
    backendUrl, group, series, trace, previewSweep, totalSweeps, zeroOffset,
    detection.filter_enabled, detection.filter_type,
    detection.filter_low, detection.filter_high, detection.filter_order,
  ])

  // ---- Run ----
  const onRun = async () => {
    let sweepIndices: number[] | null = null
    if (runMode === 'range') {
      const lo = Math.max(1, Math.min(sweepFrom, totalSweeps))
      const hi = Math.max(lo, Math.min(sweepTo, totalSweeps))
      sweepIndices = []
      for (let i = lo - 1; i <= hi - 1; i++) sweepIndices.push(i)
    } else if (runMode === 'one') {
      sweepIndices = [Math.max(0, Math.min(sweepOne - 1, totalSweeps - 1))]
    }
    await runAP(
      group, series, trace,
      {
        manualEnabled: manualImEnabled,
        manualStartS: manualImStartS,
        manualEndS: manualImEndS,
        manualStartPA: manualImStartPA,
        manualStepPA: manualImStepPA,
      },
      sweepIndices,
      detection, kinetics,
      rheobaseMode,
      rheobaseMode === 'ramp' ? rampParams : null,
      manualEdits,
      true,
    )
    // Stamp the run-mode + sweep selection onto the entry so the
    // sidecar persists them and the form rehydrates them on reopen.
    useAppStore.setState((s) => {
      const e = s.apAnalyses[`${group}:${series}`]
      if (!e) return s
      return {
        apAnalyses: {
          ...s.apAnalyses,
          [`${group}:${series}`]: { ...e, runMode, sweepFrom, sweepTo, sweepOne },
        },
      }
    })
  }

  // Per-spike measurements for the current preview sweep — used by
  // the mini-viewer to overlay threshold / peak / fAHP / mAHP /
  // half-width markers. When kinetics weren't measured we fall back
  // to the peak-time-only list from per-sweep counting.
  const previewSpikes: APPoint[] = useMemo(() => {
    if (!entry) return []
    const matched = entry.perSpike.filter((sp) => sp.sweep === previewSweep)
    if (matched.length > 0) return matched
    // Fall back to peak-times-only from the per-sweep counting result.
    const ps = entry.perSweep.find((p) => p.sweep === previewSweep)
    return (ps?.peakTimes ?? []).map((t, i) => ({
      sweep: previewSweep,
      spikeIndex: i,
      thresholdVm: 0, thresholdT: 0,
      peakVm: 0, peakT: t,
      amplitudeMv: 0,
      riseTimeS: null, decayTimeS: null, halfWidthS: null,
      fahpVm: null, fahpT: null,
      mahpVm: null, mahpT: null,
      maxRiseSlopeMvMs: null, maxDecaySlopeMvMs: null,
      manual: false,
    }))
  }, [entry, previewSweep])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      {/* Selectors — stay as a thin top row (always visible). All
          other param sections + Run controls + error banner live in
          the LEFT panel below; the viewer + results panel live in
          the RIGHT panel. The vertical splitter between them is
          draggable and persists its width to Electron prefs under
          apWindowUI.leftPanelWidth. */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
        // Match the main-window tree sidebar tone so the window's
        // "chrome" (selectors + left panel) reads as one cohesive
        // region distinct from the content (viewer + results).
        background: 'var(--bg-secondary)',
        padding: '6px 10px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
      }}>
        <Field label="Group">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Series">
          <select value={series} onChange={(e) => onSeriesChange(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        <ChannelsOverlaySelect
          channels={channels.map((c: any) => ({ index: c.index, label: c.label, units: c.units }))}
          primary={trace}
          onPrimaryChange={(i) => setTrace(i)}
          overlay={overlayChannels}
          onOverlayChange={setOverlayChannels}
          hasStimulus={hasStimulus}
        />
        <Field label="Sweep (preview)">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button className="btn btn-compact"
              onClick={() => setPreviewSweep((s) => Math.max(0, s - 1))}
              disabled={previewSweep <= 0 || totalSweeps === 0}
              title="Previous sweep">←</button>
            <span className="num" style={{ minWidth: 58, textAlign: 'center', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
              {totalSweeps > 0 ? `${previewSweep + 1} / ${totalSweeps}` : '— / —'}
            </span>
            <button className="btn btn-compact"
              onClick={() => setPreviewSweep((s) => Math.min(totalSweeps - 1, s + 1))}
              disabled={previewSweep >= totalSweeps - 1 || totalSweeps === 0}
              title="Next sweep">→</button>
          </span>
        </Field>
      </div>

      {/* Tab bar — spans the full window width so it's visually above
          BOTH columns. The tab choice drives which params show in
          the left column (Rheobase for Counting, Kinetics for
          Kinetics) and which results show on the right; placing the
          bar inside the right column made it look like a local viewer
          toggle, which misread its actual scope. */}
      <div className="segmented" style={{ alignSelf: 'flex-start', flexShrink: 0 }}>
        {(['counting', 'kinetics'] as APTab[]).map((t) => {
          const label = t === 'counting' ? 'Counting' : 'Kinetics'
          const active = tab === t
          return (
            <button
              key={t}
              className={active ? 'active' : undefined}
              aria-selected={active}
              onClick={() => setTab(t)}
              style={{ minWidth: 110 }}
            >{label}</button>
          )
        })}
      </div>

      {/* Main body: two-column flex. LEFT = params column (scrollable
          with Run controls pinned to its bottom); RIGHT = viewer +
          results. */}
      <div style={{
        flex: 1, display: 'flex', minHeight: 0, gap: 0,
      }}>
        {/* LEFT PANEL */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)',
          padding: 8,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
        }}>
          {/* Scrollable param sections. Run controls + error banner
              sit outside this scrollable so they're always visible. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,  // room for the scrollbar
          }}>
            {/* Im source — Auto reconstructs from the recording's
                stimulus protocol; Manual falls back to start/step
                values. Shared with the IV window via ImSourceCard. */}
            <ImSourceCard
              mode={manualImEnabled ? 'manual' : 'auto'}
              onModeChange={(m) => setManualImEnabled(m === 'manual')}
              manual={{
                startS: manualImStartS,
                endS: manualImEndS,
                startPA: manualImStartPA,
                stepPA: manualImStepPA,
              }}
              onManualChange={(p) => {
                if (p.startS !== undefined) setManualImStartS(p.startS)
                if (p.endS !== undefined) setManualImEndS(p.endS)
                if (p.startPA !== undefined) setManualImStartPA(p.startPA)
                if (p.stepPA !== undefined) setManualImStepPA(p.stepPA)
              }}
              detected={entry?.imSource ?? null}
            />
            {/* Detection params (filter + method + bounds) live here. */}
            <APDetectionPanel
              detection={detection} setDetection={setDetection}
              showBounds={showBounds} setShowBounds={setShowBoundsAndPersist}
            />
            {/* Tab-specific params. */}
            {tab === 'counting' && (
              <APRheobasePanel
                rheobaseMode={rheobaseMode}
                setRheobaseMode={setRheobaseMode}
                rampParams={rampParams}
                setRampParams={setRampParams}
                backendUrl={backendUrl}
                group={group} series={series}
              />
            )}
            {tab === 'kinetics' && (
              <APKineticsPanel kinetics={kinetics} setKinetics={setKinetics} />
            )}
            {/* Post-detection: optional grouping of closely-spaced
                spikes into trains. Off by default; useful for picking
                out high-frequency bursts inside long current-clamp
                steps. Train data is derived live from ``perSpike``,
                so manual add/remove updates the assignments without
                a re-run. */}
            <TrainOptions
              module="ap"
              group={group}
              series={series}
            />
          </div>
          {/* Pinned footer: Run controls + error banner.
              Primary: Run. Secondary (smaller): Clear, Clear edits.
              Sweep-scope selector is a dropdown (progressive
              disclosure) — "All sweeps" is the default; Range and
              Single reveal their inline input rows only when chosen.
              This replaces the earlier radios-on-one-row layout,
              which got cramped in a narrow left column. */}
          <div className="section-card" style={{ flexShrink: 0 }}>
            <button className="btn btn-primary btn-lg" onClick={onRun}
              disabled={loading || !fileInfo}
              style={{ width: '100%' }}>
              {loading ? 'Running…' : 'Run'}
            </button>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--font-size-label)',
            }}>
              <span style={{ color: 'var(--text-muted)' }}>Sweeps:</span>
              <select value={runMode}
                onChange={(e) => setRunMode(e.target.value as RunMode)}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                <option value="all">All sweeps</option>
                <option value="range">Range</option>
                <option value="one">Single sweep</option>
              </select>
            </div>
            {runMode === 'range' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                <span>From</span>
                <NumInput value={sweepFrom} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepFrom(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span>to</span>
                <NumInput value={sweepTo} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepTo(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span style={{ marginLeft: 'auto' }}>/ {totalSweeps || '—'}</span>
              </div>
            )}
            {runMode === 'one' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                <span>Sweep</span>
                <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span style={{ marginLeft: 'auto' }}>/ {totalSweeps || '—'}</span>
              </div>
            )}
            {/* Secondary actions — smaller, visually subordinate. */}
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn"
                onClick={() => clearAP(group, series)} disabled={!entry}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={() => { setManualEdits({ added: {}, removed: {} }) }}
                disabled={
                  Object.keys(manualEdits.added).length === 0 &&
                  Object.keys(manualEdits.removed).length === 0
                }
                title="Drop manual spike additions / removals (next Run will use raw auto-detection)"
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear edits
              </button>
              <APExportDropdown
                stretch
                placement="up"
                disabled={!entry || (entry.perSweep.length === 0 && entry.perSpike.length === 0)}
                onCounting={() => entry && exportApCountingCSV(
                  entry.perSweep, fileInfo?.fileName ?? 'recording', group, series,
                )}
                onKinetics={() => entry && exportApKineticsCSV(
                  entry.perSpike, fileInfo?.fileName ?? 'recording', group, series,
                )}
                countingCount={entry?.perSweep.length ?? 0}
                kineticsCount={entry?.perSpike.length ?? 0}
              />
            </div>
          </div>
          {error && (
            <div className="notice notice-error" style={{
              flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ flex: 1 }}>⚠ {error}</span>
              <button className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
        </div>{/* close LEFT panel */}

        {/* Vertical splitter between LEFT and RIGHT. */}
        <div
          onMouseDown={onLeftSplitMouseDown}
          title="Drag to resize"
          style={{
            width: 3, flexShrink: 0, cursor: 'col-resize',
            background: 'var(--border)',
            position: 'relative',
          }}
        >
          <div style={{
            position: 'absolute', top: '50%', left: 0,
            transform: 'translateY(-50%)',
            width: 2, height: 40, background: 'var(--text-muted)',
            borderRadius: 1, opacity: 0.5,
          }} />
        </div>

        {/* RIGHT PANEL: tab bar + viewer + results. */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>

      {/* Top: mode-dependent viewer area. Counting tab gets the full
          sweep viewer (whole trace + spike markers + draggable bounds),
          optionally with stacked overlay subplots beneath for extra
          channels / the stimulus protocol. Kinetics tab swaps in
          [zoomed-spike (left) | phase-plot (right)] so the user can
          verify detection markers up close AND see the characteristic
          phase loop side-by-side. */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ height: topHeight, minHeight: 180, flexShrink: 0,
          display: 'flex', gap: 6,
        }}>
          {tab === 'counting' && (
            <div style={{
              flex: 1, minWidth: 0,
              display: 'flex', flexDirection: 'column', minHeight: 0,
            }}>
              {/* Primary subplot: APSweepViewer with all analysis
                  bands + spike markers. Cursor bands are drawn only
                  here — overlay subplots below are display-only.
                  5:2 primary-to-each-overlay ratio so one overlay
                  takes ~29% of the viewer height (small enough to
                  stay out of the way, tall enough to read off stim
                  amplitude and timing). */}
              <div style={{
                flex: overlayChannels.length > 0 ? 5 : 1,
                minHeight: 0,
              }}>
                <APSweepViewer
                  viewKey={`${group}:${series}:${trace}:${zeroOffset}`}
                  traceTime={traceTime}
                  traceValues={traceValues}
                  traceUnits={traceUnits}
                  previewSweep={previewSweep}
                  totalSweeps={totalSweeps}
                  theme={theme}
                  fontSize={fontSize}
                  zeroOffset={zeroOffset}
                  onZeroOffsetChange={setZeroOffset}
                  zeroOffsetApplied={zeroOffsetApplied}
                  boundsStartS={detection.bounds_start_s}
                  boundsEndS={detection.bounds_end_s}
                  onBoundsChange={(start, end) => {
                    setDetection((d) => ({ ...d, bounds_start_s: start, bounds_end_s: end }))
                  }}
                  previewSpikes={previewSpikes}
                  entry={entry}
                  heightSignal={topHeight}
                  zoomToSpikeRequest={zoomRequest}
                  onXRangeChange={(xMin, xMax) => setPrimaryXRange([xMin, xMax])}
                  onAddSpike={(t) => addManualAPSpike(group, series, previewSweep, t)}
                  onRemoveSpikeAt={(t) => removeManualAPSpikeAt(group, series, previewSweep, t)}
                  showBounds={showBounds}
                  trainsForSweep={trainData.summariesBySweep.get(previewSweep) ?? []}
                />
              </div>
              {/* Overlay subplots — one per selected overlay channel.
                  Thin divider between each, 5:2 primary-to-each ratio
                  (overlay ≈ 29% of the viewer height when there's
                  one; halves from there if more are added). Display-
                  only, X-synced from primary. */}
              {overlayChannels.map((ch) => {
                const label = ch === STIMULUS_OVERLAY_KEY
                  ? 'Stimulus'
                  : channels.find((c: any) => c.index === ch)?.label ?? `Ch ${ch}`
                const units = ch === STIMULUS_OVERLAY_KEY
                  ? 'pA'
                  : channels.find((c: any) => c.index === ch)?.units ?? ''
                const overlayConfig: OverlayChannel = ch === STIMULUS_OVERLAY_KEY
                  ? { kind: 'stimulus', label, units }
                  : { kind: 'channel', index: ch, label, units }
                return (
                  <React.Fragment key={ch}>
                    <div style={{
                      height: 3, flexShrink: 0,
                      background: 'var(--border)',
                    }} />
                    <div style={{ flex: 2, minHeight: 0 }}>
                      <OverlayTraceViewer
                        backendUrl={backendUrl}
                        group={group}
                        series={series}
                        sweep={previewSweep}
                        channel={overlayConfig}
                        xRange={primaryXRange}
                        heightSignal={topHeight}
                      />
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          )}
          {tab === 'kinetics' && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <APSpikesOverlayViewer
                  backendUrl={backendUrl}
                  entry={entry}
                  group={group} series={series} trace={trace}
                  selectedSpikeIndices={selectedSpikeSet}
                  hideMarkers={hideMarkers}
                  onHideMarkersChange={setHideMarkers}
                  onSelectAll={selectAllSpikes}
                  onClearSelection={clearSpikeSelection}
                  onSelectSpike={(idx) => {
                    // Drive both the table-active selection + the
                    // auto-zoom (so prev/next behaves exactly like
                    // clicking a kinetics-table row).
                    selectAPSpike(group, series, idx)
                    const sp = entry?.perSpike[idx]
                    if (sp) {
                      setPreviewSweep(sp.sweep)
                      requestZoomToSpike(sp.peakT, 15)
                    }
                  }}
                  filter={detection.filter_enabled ? {
                    type: detection.filter_type,
                    low: detection.filter_low,
                    high: detection.filter_high,
                    order: detection.filter_order,
                  } : null}
                  zeroOffset={zeroOffset}
                  visibilitySignal={kineticsVis}
                  heightSignal={topHeight}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <APPhasePlotPanel
                  backendUrl={backendUrl}
                  entry={entry}
                  group={group} series={series} trace={trace}
                  visibilitySignal={kineticsVis}
                  heightSignal={topHeight}
                  selectedSpikeIndices={selectedSpikeSet}
                  hideMarkers={hideMarkers}
                />
              </div>
            </>
          )}
        </div>
        <div onMouseDown={onSplitMouseDown}
          style={{
            height: 3, cursor: 'row-resize', background: 'var(--border)',
            flexShrink: 0, position: 'relative',
          }}
          title="Drag to resize">
          <div style={{
            position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)',
            width: 40, height: 2, background: 'var(--text-muted)',
            borderRadius: 1, opacity: 0.5,
          }} />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* All three result panels stay mounted (display-toggle) so
              uPlot instances + zoom survive tab round-trips. */}
          <div style={{
            display: tab === 'counting' ? 'flex' : 'none', height: '100%',
          }}>
            <APCountingPanel
              entry={entry}
              previewSweep={previewSweep}
              setPreviewSweep={setPreviewSweep}
              heightSignal={topHeight}
              trainsEnabled={trainsEnabled}
              trains={trainData.flatSummaries}
              onExportTrains={() => exportApTrainsCSV(
                trainData.flatSummaries,
                effectiveTrainParams,
                fileInfo?.fileName ?? 'recording',
                group, series,
              )}
            />
          </div>
          <div style={{
            display: tab === 'kinetics' ? 'flex' : 'none', height: '100%',
          }}>
            <APKineticsTable
              entry={entry}
              onSelectSpike={(idx) => {
                selectAPSpike(group, series, idx)
                const sp = entry?.perSpike[idx]
                if (sp) {
                  // Pan the preview to the spike's sweep AND zoom in
                  // around the peak so the user can verify the
                  // detection markers without manually zooming.
                  setPreviewSweep(sp.sweep)
                  requestZoomToSpike(sp.peakT, 15)
                }
              }}
              selectedSpikeSet={selectedSpikeSet}
              onToggleSpike={toggleSpikeSelected}
              trainIdByIdx={trainsEnabled ? trainData.idByGlobalIdx : null}
            />
          </div>
        </div>
      </div>
        </div>{/* close RIGHT panel */}
      </div>{/* close two-column body */}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detection params panel — shared by all three tabs
// ---------------------------------------------------------------------------

function APDetectionPanel({
  detection, setDetection,
  showBounds, setShowBounds,
}: {
  detection: APDetectionParams
  setDetection: React.Dispatch<React.SetStateAction<APDetectionParams>>
  showBounds: boolean
  setShowBounds: (v: boolean) => void
}) {
  const set = <K extends keyof APDetectionParams>(k: K, v: APDetectionParams[K]) =>
    setDetection((d) => ({ ...d, [k]: v }))
  return (
    <>
      {/* Pre-detection filter */}
      <div className="section-card" style={{
        flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input type="checkbox" checked={detection.filter_enabled}
            onChange={(e) => set('filter_enabled', e.target.checked)} />
          <span style={{ fontWeight: 600 }}>Pre-detection filter</span>
        </label>
        {detection.filter_enabled && (
          <>
            <select value={detection.filter_type}
              onChange={(e) => set('filter_type', e.target.value as 'lowpass' | 'highpass' | 'bandpass')}
              style={{ fontSize: 'var(--font-size-label)' }}>
              <option value="lowpass">Lowpass</option>
              <option value="highpass">Highpass</option>
              <option value="bandpass">Bandpass</option>
            </select>
            {(detection.filter_type === 'highpass' || detection.filter_type === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Low</span>
                <NumInput value={detection.filter_low} step={0.1} min={0}
                  onChange={(v) => set('filter_low', v)} style={{ width: 64 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            {(detection.filter_type === 'lowpass' || detection.filter_type === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>High</span>
                <NumInput value={detection.filter_high} step={50} min={1}
                  onChange={(v) => set('filter_high', v)} style={{ width: 70 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Order</span>
              <NumInput value={detection.filter_order} step={1} min={1} max={8}
                onChange={(v) => set('filter_order', Math.max(1, Math.min(8, Math.round(v))))}
                style={{ width: 42 }} />
            </label>
          </>
        )}
      </div>

      {/* Detection params. Two-column grid with wider controls
          (dropdowns) spanning both columns via gridColumn '1 / -1'.
          Thin sub-header strips group related fields so the user can
          scan the panel quickly. */}
      <div className="section-card" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 8,
      }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Detection method">
            <select value={detection.method}
              onChange={(e) => set('method', e.target.value as APDetectionMethod)}>
              <option value="auto_rec">Auto (adaptive)</option>
              <option value="auto_spike">Auto (single pass)</option>
              <option value="manual">Manual threshold</option>
            </select>
          </Field>
        </div>
        {detection.method === 'manual' && (
          <ParamRow label="Manual threshold (mV)"
            value={detection.manual_threshold_mv} step={5}
            onChange={(v) => set('manual_threshold_mv', v)} />
        )}
        {detection.method !== 'manual' && (
          <>
            <SubHeader>Thresholds</SubHeader>
            <ParamRow label="Min amplitude (mV)"
              value={detection.min_amplitude_mv} step={5} min={0}
              onChange={(v) => set('min_amplitude_mv', v)} />
            <ParamRow label="+dV/dt (mV/ms)"
              value={detection.pos_dvdt_mv_ms} step={1} min={0}
              onChange={(v) => set('pos_dvdt_mv_ms', v)} />
            <ParamRow label="−dV/dt (mV/ms)"
              value={detection.neg_dvdt_mv_ms} step={1}
              onChange={(v) => set('neg_dvdt_mv_ms', v)} />
          </>
        )}
        <SubHeader>Spike shape</SubHeader>
        <ParamRow label="Max width (ms)"
          value={detection.width_ms} step={0.5} min={0.1}
          onChange={(v) => set('width_ms', v)} />
        <ParamRow label="Min distance (ms)"
          value={detection.min_distance_ms} step={0.5} min={0.1}
          onChange={(v) => set('min_distance_ms', v)} />
        <SubHeader>Analysis bounds</SubHeader>
        <label
          style={{
            // Span the full grid row so the start / end ParamRows
            // below pair up as before (col 1 + col 2). Without this
            // the checkbox would take col 1 and push the start input
            // out of line with the end input.
            gridColumn: '1 / -1',
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 'var(--font-size-label)', marginBottom: 4,
          }}
          title="Hide the blue analysis-bounds cursors so you can click through them when adding / removing manual spikes underneath. Bounds values stay; only their on-trace markers are hidden."
        >
          <input type="checkbox"
            checked={showBounds}
            onChange={(e) => setShowBounds(e.target.checked)} />
          <span>Show bounds on viewer</span>
        </label>
        <ParamRow label="Bounds start (s)"
          value={detection.bounds_start_s} step={0.05} min={0}
          onChange={(v) => set('bounds_start_s', Math.max(0, v))} />
        <ParamRow label="Bounds end (s)"
          value={detection.bounds_end_s} step={0.05} min={0}
          onChange={(v) => set('bounds_end_s', Math.max(0, v))} />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Kinetics params panel
// ---------------------------------------------------------------------------

function APKineticsPanel({
  kinetics, setKinetics,
}: {
  kinetics: APKineticsParams
  setKinetics: React.Dispatch<React.SetStateAction<APKineticsParams>>
}) {
  const set = <K extends keyof APKineticsParams>(k: K, v: APKineticsParams[K]) =>
    setKinetics((kk) => ({ ...kk, [k]: v }))
  const isCutoff = kinetics.threshold_method === 'first_deriv_cutoff'
    || kinetics.threshold_method === 'third_deriv_cutoff'
  const isSekerli = kinetics.threshold_method === 'sekerli_I'
    || kinetics.threshold_method === 'sekerli_II'
  return (
    <div className="section-card" style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      gap: 8,
    }}>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Threshold method">
          <select value={kinetics.threshold_method}
            onChange={(e) => set('threshold_method', e.target.value as APThresholdMethod)}>
            <option value="first_deriv_cutoff">First-deriv cutoff</option>
            <option value="first_deriv_max">First-deriv max</option>
            <option value="third_deriv_cutoff">Third-deriv cutoff</option>
            <option value="third_deriv_max">Third-deriv max</option>
            <option value="sekerli_I">Sekerli I</option>
            <option value="sekerli_II">Sekerli II</option>
            <option value="leading_inflection">Leading inflection</option>
            <option value="max_curvature">Max curvature</option>
          </select>
        </Field>
      </div>
      {isCutoff && (
        <ParamRow label="Cutoff (mV/ms)"
          value={kinetics.threshold_cutoff_mv_ms} step={1} min={0}
          onChange={(v) => set('threshold_cutoff_mv_ms', v)} />
      )}
      {isSekerli && (
        <ParamRow label="Sekerli mask (mV/ms)"
          value={kinetics.sekerli_lower_bound_mv_ms} step={1} min={0}
          onChange={(v) => set('sekerli_lower_bound_mv_ms', v)} />
      )}
      <ParamRow label="Search before peak (ms)"
        value={kinetics.threshold_search_ms_before_peak} step={0.5} min={0.1}
        onChange={(v) => set('threshold_search_ms_before_peak', v)} />

      <SubHeader>Rise / decay</SubHeader>
      <ParamRow label="Rise low %" value={kinetics.rise_low_pct} step={5} min={0} max={100}
        onChange={(v) => set('rise_low_pct', v)} />
      <ParamRow label="Rise high %" value={kinetics.rise_high_pct} step={5} min={0} max={100}
        onChange={(v) => set('rise_high_pct', v)} />
      <ParamRow label="Decay low %" value={kinetics.decay_low_pct} step={5} min={0} max={100}
        onChange={(v) => set('decay_low_pct', v)} />
      <ParamRow label="Decay high %" value={kinetics.decay_high_pct} step={5} min={0} max={100}
        onChange={(v) => set('decay_high_pct', v)} />
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Decay end">
          <select value={kinetics.decay_end}
            onChange={(e) => set('decay_end', e.target.value as 'to_threshold' | 'to_fahp')}>
            <option value="to_threshold">To threshold</option>
            <option value="to_fahp">To fAHP</option>
          </select>
        </Field>
      </div>

      <SubHeader>AHP windows</SubHeader>
      <ParamRow label="fAHP start (ms)"
        value={kinetics.fahp_search_start_ms} step={1} min={0}
        onChange={(v) => set('fahp_search_start_ms', v)} />
      <ParamRow label="fAHP end (ms)"
        value={kinetics.fahp_search_end_ms} step={1} min={0}
        onChange={(v) => set('fahp_search_end_ms', v)} />
      <ParamRow label="mAHP start (ms)"
        value={kinetics.mahp_search_start_ms} step={5} min={0}
        onChange={(v) => set('mahp_search_start_ms', v)} />
      <ParamRow label="mAHP end (ms)"
        value={kinetics.mahp_search_end_ms} step={10} min={0}
        onChange={(v) => set('mahp_search_end_ms', v)} />

      <SubHeader>Slope</SubHeader>
      <ParamRow label="Max-slope window (ms)"
        value={kinetics.max_slope_window_ms} step={0.1} min={0.1}
        onChange={(v) => set('max_slope_window_ms', v)} />
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input type="checkbox" checked={kinetics.interpolate_to_200khz}
            onChange={(e) => set('interpolate_to_200khz', e.target.checked)} />
          Interp to 200 kHz
        </label>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rheobase panel — mode picker + ramp params, with auto-fill from .pgf
// ---------------------------------------------------------------------------

function APRheobasePanel({
  rheobaseMode, setRheobaseMode,
  rampParams, setRampParams,
  backendUrl, group, series,
}: {
  rheobaseMode: APRheobaseMode
  setRheobaseMode: (m: APRheobaseMode) => void
  rampParams: APRampParams
  setRampParams: React.Dispatch<React.SetStateAction<APRampParams>>
  backendUrl: string
  group: number
  series: number
}) {
  const setRamp = <K extends keyof APRampParams>(k: K, v: APRampParams[K]) =>
    setRampParams((r) => ({ ...r, [k]: v }))

  const onAutoFill = async () => {
    if (!backendUrl) return
    try {
      const r = await fetch(`${backendUrl}/api/ap/auto_im_params?group=${group}&series=${series}`)
      if (!r.ok) return
      const d = await r.json()
      if (d?.type === 'ramp') {
        setRampParams({
          t_start_s: Number(d.t_start_s ?? 0),
          t_end_s: Number(d.t_end_s ?? 0),
          im_start_pa: Number(d.im_start_pa ?? 0),
          im_end_pa: Number(d.im_end_pa ?? 0),
        })
      } else if (d?.type === 'step') {
        // No ramp parsed — use the step's bounds with constant Im so
        // the user can edit instead of starting from zero.
        setRampParams({
          t_start_s: Number(d.t_start_s ?? 0),
          t_end_s: Number(d.t_end_s ?? 0),
          im_start_pa: Number(d.im_pa ?? 0),
          im_end_pa: Number(d.im_pa ?? 0),
        })
      }
    } catch { /* ignore */ }
  }

  return (
    <div className="section-card" style={{
      flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      fontSize: 'var(--font-size-label)',
    }}>
      <span style={{ color: 'var(--text-muted)' }}>Rheobase:</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input type="radio" name="ap-rheobase-mode" checked={rheobaseMode === 'record'}
          onChange={() => setRheobaseMode('record')} />
        Record (mean Im of first sweep with AP)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input type="radio" name="ap-rheobase-mode" checked={rheobaseMode === 'exact'}
          onChange={() => setRheobaseMode('exact')} />
        Exact (Im at first AP sample)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input type="radio" name="ap-rheobase-mode" checked={rheobaseMode === 'ramp'}
          onChange={() => setRheobaseMode('ramp')} />
        Ramp (manual)
      </label>
      {rheobaseMode === 'ramp' && (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>t0 (s)</span>
            <NumInput value={rampParams.t_start_s} step={0.05} min={0}
              onChange={(v) => setRamp('t_start_s', Math.max(0, v))} style={{ width: 64 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>t1 (s)</span>
            <NumInput value={rampParams.t_end_s} step={0.05} min={0}
              onChange={(v) => setRamp('t_end_s', Math.max(0, v))} style={{ width: 64 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>I0 (pA)</span>
            <NumInput value={rampParams.im_start_pa} step={10}
              onChange={(v) => setRamp('im_start_pa', v)} style={{ width: 70 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>I1 (pA)</span>
            <NumInput value={rampParams.im_end_pa} step={10}
              onChange={(v) => setRamp('im_end_pa', v)} style={{ width: 70 }} />
          </label>
          <button className="btn btn-sm" onClick={onAutoFill}
            title="Try to fill from the stimulus protocol">
            Auto-fill from protocol
          </button>
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Counting tab — per-sweep table + F-I curve + rheobase badge
// ---------------------------------------------------------------------------

function APCountingPanel({
  entry, previewSweep, setPreviewSweep, heightSignal,
  trainsEnabled, trains, onExportTrains,
}: {
  entry: APData | undefined
  previewSweep: number
  setPreviewSweep: (n: number) => void
  /** Forwarded to the F-I curve so the plot resizes on splitter
   *  drag (flexbox layout updates don't always trigger uPlot's
   *  internal ResizeObserver predictably). */
  heightSignal?: number
  /** Train-grouping form state from the parent — drives whether the
   *  Trains sub-tab on the right column has anything to show. */
  trainsEnabled: boolean
  /** Per-train summaries computed in the parent. Always passed (the
   *  Trains sub-tab handles the disabled / empty cases inline). */
  trains: Array<TrainSummary & { sweep: number }>
  onExportTrains: () => void
}) {
  // Sub-tab inside the LEFT column (the results table): per-sweep
  // counting (default) or per-train summary. Auto-switches to Trains
  // on the rising edge of "grouping enabled AND produced clusters"
  // so flipping the sidebar checkbox drops you right into the
  // result; bounces back to per-sweep when grouping is turned off.
  const [resultTab, setResultTab] = useState<'sweeps' | 'trains'>('sweeps')
  const trainsAvailable = trainsEnabled && trains.length > 0
  const lastTrainsAvailRef = useRef(false)
  useEffect(() => {
    if (trainsAvailable && !lastTrainsAvailRef.current) setResultTab('trains')
    lastTrainsAvailRef.current = trainsAvailable
  }, [trainsAvailable])
  useEffect(() => {
    if (!trainsEnabled && resultTab === 'trains') setResultTab('sweeps')
  }, [trainsEnabled, resultTab])

  if (!entry || entry.perSweep.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Run to populate the counting table.
      </div>
    )
  }
  return (
    <div style={{ flex: 1, display: 'flex', gap: 6, minHeight: 0 }}>
      <div style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0,
      }}>
        {/* Sub-tab strip — Per sweep (default) or Trains. */}
        <div className="segmented" style={{ alignSelf: 'flex-start', flexShrink: 0 }}>
          {(['sweeps', 'trains'] as const).map((k) => (
            <button key={k}
              className={resultTab === k ? 'active' : undefined}
              aria-selected={resultTab === k}
              onClick={() => setResultTab(k)}
              style={{ minWidth: 80 }}>
              {k === 'sweeps' ? 'Per sweep'
                : `Trains${trainsAvailable ? ` (${trains.length})` : ''}`}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {resultTab === 'sweeps' && (
            <APPerSweepTable entry={entry} previewSweep={previewSweep}
              onSelectSweep={setPreviewSweep} />
          )}
          {resultTab === 'trains' && (
            <APTrainsPanel
              trains={trains}
              enabled={trainsEnabled}
              onExport={onExportTrains}
            />
          )}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <APRheobaseBadge entry={entry} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <APFICurve entry={entry} onSelectSweep={setPreviewSweep}
            heightSignal={heightSignal} />
        </div>
      </div>
    </div>
  )
}

/** Trains tab — full per-train results panel + Export CSV. Mirrors
 *  the Events window's trains tab. The shaded train bands stay on
 *  the upper APSweepViewer (shared with the Counting tab) so users
 *  can flip back and forth between this table and the trace. */
function APTrainsPanel({
  trains, enabled, onExport,
}: {
  trains: Array<TrainSummary & { sweep: number }>
  enabled: boolean
  onExport: () => void
}) {
  const sel = useRowSelection(trains.length)
  const headers = ['Train', 'Sweep', 'Start (s)', 'End (s)', 'Dur (ms)',
    'n spikes', 'Mean ISI (ms)', 'Intra freq (Hz)']
  const rowToCells = (i: number): Array<string | number | null> => {
    const t = trains[i]
    return [
      `T${t.id + 1}`,
      t.sweep + 1,
      t.startS.toFixed(4),
      t.endS.toFixed(4),
      t.durationMs.toFixed(2),
      t.nEvents,
      t.meanIeiMs != null ? t.meanIeiMs.toFixed(2) : null,
      t.intraFreqHz != null ? t.intraFreqHz.toFixed(2) : null,
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  if (!enabled) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Train grouping is off. Enable it in the sidebar's "Group into trains"
        section to cluster closely-spaced spikes.
      </div>
    )
  }
  if (trains.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        No trains found with the current parameters. Try widening the
        "Max IEI" or lowering the "Min events / train" threshold.
      </div>
    )
  }
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0,
    }}>
      <div style={{
        flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 2px',
        fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
      }}>
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>{trains.length}</strong> trains
        </span>
        <button className="btn btn-sm"
          onClick={onExport}
          style={{ marginLeft: 'auto' }}
          title="Export per-train summary to CSV">
          Export trains CSV
        </button>
      </div>
      <div style={{
        flex: 1, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        overflow: 'auto', minHeight: 0,
      }}>
        <table className="data-table">
          <thead>
            <tr>
              {headers.map((h, i) => <Th key={i}>{h}</Th>)}
            </tr>
          </thead>
          <tbody>
            {trains.map((t, i) => (
              <tr key={i}
                onClick={(ev) => sel.onRowClick(i, ev)}
                onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                })}
                style={{
                  background: sel.isSelected(i)
                    ? 'var(--accent-muted)'
                    : 'transparent',
                }}>
                <Td><span style={{ color: 'var(--marker-manual)' }}>T{t.id + 1}</span></Td>
                <Td>{t.sweep + 1}</Td>
                <Td>{t.startS.toFixed(4)}</Td>
                <Td>{t.endS.toFixed(4)}</Td>
                <Td>{t.durationMs.toFixed(2)}</Td>
                <Td>{t.nEvents}</Td>
                <Td>{t.meanIeiMs != null ? t.meanIeiMs.toFixed(2) : '—'}</Td>
                <Td>{t.intraFreqHz != null ? t.intraFreqHz.toFixed(2) : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        {copyMenu.menu}
      </div>
    </div>
  )
}

function APExportDropdown({
  disabled, onCounting, onKinetics, countingCount, kineticsCount,
  placement = 'down', stretch = false,
}: {
  disabled: boolean
  onCounting: () => void
  onKinetics: () => void
  countingCount: number
  kineticsCount: number
  /** ``up`` opens the popover above the button — use this when the
   *  button sits at the bottom of a panel (e.g. the Run footer). */
  placement?: 'down' | 'up'
  /** When true, the button fills its container (used in the Run
   *  footer's flex row alongside Clear / Clear edits). */
  stretch?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])
  const popoverPosition = placement === 'up'
    ? { bottom: 'calc(100% + 4px)' as const }
    : { top: 'calc(100% + 4px)' as const }
  return (
    <div ref={rootRef} style={{
      position: 'relative',
      ...(stretch ? { flex: 1, display: 'flex' } : null),
    }}>
      <button className="btn" disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 'var(--font-size-label)',
          ...(stretch ? { flex: 1 } : null),
        }}
        title="Export per-sweep counts or per-spike kinetics to CSV">
        Export CSV ▾
      </button>
      {open && (
        <div style={{
          position: 'absolute', ...popoverPosition, right: 0,
          background: 'var(--bg-field)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-popover)',
          minWidth: 200, zIndex: 10, padding: 4,
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <button className="btn btn-ghost"
            onClick={() => { onCounting(); setOpen(false) }}
            disabled={countingCount === 0}
            style={{
              textAlign: 'left',
              display: 'flex', justifyContent: 'space-between', gap: 12,
            }}
            title="Per-sweep spike counts, rate, ISI, SFA, LV, Im">
            <span>Counting (per sweep)</span>
            <span className="num" style={{ color: 'var(--text-muted)' }}>{countingCount}</span>
          </button>
          <button className="btn btn-ghost"
            onClick={() => { onKinetics(); setOpen(false) }}
            disabled={kineticsCount === 0}
            style={{
              textAlign: 'left',
              display: 'flex', justifyContent: 'space-between', gap: 12,
            }}
            title="Per-spike threshold, peak, amplitude, rise/decay, half-width, AHP">
            <span>Kinetics (per spike)</span>
            <span className="num" style={{ color: 'var(--text-muted)' }}>{kineticsCount}</span>
          </button>
        </div>
      )}
    </div>
  )
}

function exportApCountingCSV(
  perSweep: APPerSweep[],
  fileName: string,
  group: number,
  series: number,
) {
  if (perSweep.length === 0) return
  const header = [
    'file', 'group', 'series', 'sweep',
    'spike_count', 'spike_rate_hz', 'im_mean_pa',
    'first_spike_latency_s', 'mean_isi_s', 'sfa_divisor', 'local_variance',
  ]
  const rows = perSweep.map((p) => [
    JSON.stringify(fileName),
    group, series, p.sweep + 1,
    p.spikeCount,
    p.spikeRateHz != null ? p.spikeRateHz.toFixed(4) : '',
    p.imMean != null ? p.imMean.toFixed(3) : '',
    p.firstSpikeLatency != null ? p.firstSpikeLatency.toFixed(6) : '',
    p.meanISI != null ? p.meanISI.toFixed(6) : '',
    p.sfaDivisor != null ? p.sfaDivisor.toFixed(4) : '',
    p.localVariance != null ? p.localVariance.toFixed(4) : '',
  ])
  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n')
  const name = fileName.replace(/\.[^.]+$/, '') + '_ap_counting.csv'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

function exportApKineticsCSV(
  perSpike: APPoint[],
  fileName: string,
  group: number,
  series: number,
) {
  if (perSpike.length === 0) return
  const header = [
    'file', 'group', 'series', 'sweep', 'spike_index',
    'threshold_vm', 'threshold_t_s', 'peak_vm', 'peak_t_s',
    'amplitude_mv', 'rise_time_s', 'decay_time_s', 'half_width_s',
    'fahp_vm', 'fahp_t_s', 'mahp_vm', 'mahp_t_s',
    'max_rise_slope_mv_ms', 'max_decay_slope_mv_ms', 'manual',
  ]
  const rows = perSpike.map((s) => [
    JSON.stringify(fileName),
    group, series, s.sweep + 1, s.spikeIndex + 1,
    s.thresholdVm.toFixed(4), s.thresholdT.toFixed(6),
    s.peakVm.toFixed(4), s.peakT.toFixed(6),
    s.amplitudeMv.toFixed(4),
    s.riseTimeS != null ? s.riseTimeS.toFixed(6) : '',
    s.decayTimeS != null ? s.decayTimeS.toFixed(6) : '',
    s.halfWidthS != null ? s.halfWidthS.toFixed(6) : '',
    s.fahpVm != null ? s.fahpVm.toFixed(4) : '',
    s.fahpT != null ? s.fahpT.toFixed(6) : '',
    s.mahpVm != null ? s.mahpVm.toFixed(4) : '',
    s.mahpT != null ? s.mahpT.toFixed(6) : '',
    s.maxRiseSlopeMvMs != null ? s.maxRiseSlopeMvMs.toFixed(4) : '',
    s.maxDecaySlopeMvMs != null ? s.maxDecaySlopeMvMs.toFixed(4) : '',
    s.manual ? '1' : '0',
  ])
  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n')
  const name = fileName.replace(/\.[^.]+$/, '') + '_ap_kinetics.csv'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

function exportApTrainsCSV(
  trains: Array<TrainSummary & { sweep: number }>,
  cfg: TrainParams & { enabled?: boolean },
  fileName: string,
  group: number,
  series: number,
) {
  if (trains.length === 0) return
  const header = [
    'file', 'group', 'series', 'sweep_index', 'train_id',
    'start_s', 'end_s', 'duration_ms', 'n_spikes',
    'mean_isi_ms', 'intra_freq_hz',
    'metric', 'max_iei_ms', 'min_count',
    'min_duration_ms', 'min_inter_train_ms',
    'first_spike_idx', 'last_spike_idx',
  ]
  const rows = trains.map((t) => [
    JSON.stringify(fileName),
    group, series, t.sweep, t.id + 1,
    t.startS.toFixed(6), t.endS.toFixed(6), t.durationMs.toFixed(3),
    t.nEvents,
    t.meanIeiMs != null ? t.meanIeiMs.toFixed(3) : '',
    t.intraFreqHz != null ? t.intraFreqHz.toFixed(4) : '',
    String(cfg.metric),
    cfg.maxIeiMs,
    cfg.minCount,
    cfg.minDurationMs ?? 0,
    cfg.minInterTrainMs ?? 0,
    t.memberIndices[0],
    t.memberIndices[t.memberIndices.length - 1],
  ])
  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n')
  const name = fileName.replace(/\.[^.]+$/, '') + '_ap_trains.csv'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function APRheobaseBadge({ entry }: { entry: APData }) {
  const r = entry.rheobase
  if (!r) return null
  const value = r.value != null ? `${r.value.toFixed(1)} pA` : '—'
  return (
    <div style={{
      padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-secondary)',
      display: 'flex', gap: 10, alignItems: 'center',
      fontSize: 'var(--font-size-label)',
    }}>
      <span style={{ color: 'var(--text-muted)' }}>Rheobase</span>
      <strong className="num" style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-sm)' }}>{value}</strong>
      <span style={{
        padding: '1px 6px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-hover)', color: 'var(--text-muted)',
        fontSize: 'var(--font-size-xs)',
      }}>{r.mode}</span>
    </div>
  )
}

function APPerSweepTable({
  entry, previewSweep, onSelectSweep,
}: {
  entry: APData
  previewSweep: number
  onSelectSweep: (sweep: number) => void
}) {
  const headers = ['Sweep', 'Spikes', 'Rate (Hz)', 'Im (pA)', 'Latency (s)', 'Mean ISI (s)', 'SFA', 'LV']
  const sel = useRowSelection(entry.perSweep.length)
  const rowToCells = (i: number): Array<string | number | null> => {
    const p = entry.perSweep[i]
    return [
      p.sweep + 1, p.spikeCount,
      p.spikeRateHz ?? null, p.imMean ?? null,
      p.firstSpikeLatency ?? null, p.meanISI ?? null,
      p.sfaDivisor ?? null, p.localVariance ?? null,
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      overflow: 'auto', height: '100%',
    }}>
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((h, i) => <Th key={i}>{h}</Th>)}
          </tr>
        </thead>
        <tbody>
          {entry.perSweep.map((p, i) => {
            const selected = p.sweep === previewSweep
            return (
              <tr
                key={p.sweep}
                onClick={(ev) => {
                  sel.onRowClick(i, ev)
                  if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
                    onSelectSweep(p.sweep)
                  }
                }}
                onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                })}
                style={{
                  background: sel.isSelected(i)
                    ? 'var(--accent-muted)'
                    : selected
                      ? 'var(--bg-selected)'
                      : 'transparent',
                }}
              >
                <Td>{p.sweep + 1}</Td>
                <Td>{p.spikeCount}</Td>
                <Td>{p.spikeRateHz != null ? p.spikeRateHz.toFixed(2) : '—'}</Td>
                <Td>{p.imMean != null ? p.imMean.toFixed(1) : '—'}</Td>
                <Td>{p.firstSpikeLatency != null ? p.firstSpikeLatency.toFixed(4) : '—'}</Td>
                <Td>{p.meanISI != null ? p.meanISI.toFixed(4) : '—'}</Td>
                <Td>{p.sfaDivisor != null ? p.sfaDivisor.toFixed(2) : '—'}</Td>
                <Td>{p.localVariance != null ? p.localVariance.toFixed(3) : '—'}</Td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

function APFICurve({
  entry, onSelectSweep, heightSignal,
}: {
  entry: APData
  onSelectSweep: (sweep: number) => void
  /** Parent splitter height — explicit setSize on every bump because
   *  ResizeObserver alone misses some flexbox-redistribute cases. */
  heightSignal?: number
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'fi-curve',
  })
  const fi = entry.fiCurve

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!fi || fi.im.length === 0) return
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 200),
      scales: { x: { time: false }, y: {} },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          label: 'Im (pA)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          label: 'Rate (Hz)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          stroke: cssVar('--trace-color-1'), width: 1.5,
          points: { show: true, size: 6, stroke: cssVar('--trace-color-1'), fill: cssVar('--trace-color-1') },
        },
      ],
    }
    plotRef.current = new uPlot(opts, [fi.im, fi.rate], el)
    // Click → jump to the sweep at the nearest x.
    const over = el.querySelector<HTMLDivElement>('.u-over')
    if (over) {
      const onClick = (ev: MouseEvent) => {
        const rect = over.getBoundingClientRect()
        const u = plotRef.current
        if (!u) return
        const xVal = u.posToVal(ev.clientX - rect.left, 'x')
        let best = -1; let bestDist = Infinity
        for (let i = 0; i < fi.im.length; i++) {
          const d = Math.abs(fi.im[i] - xVal)
          if (d < bestDist) { bestDist = d; best = i }
        }
        if (best >= 0) onSelectSweep(fi.sweep[best])
      }
      over.addEventListener('click', onClick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fi, themeKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    const onWin = () => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  // Splitter / window resize signal — same double-rAF pattern as
  // the phase plot (single rAF runs before the post-height-change
  // layout pass in some browsers).
  useEffect(() => {
    if (heightSignal == null) return
    let r1 = 0, r2 = 0
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const u = plotRef.current
        const el = containerRef.current
        if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
          u.setSize({ width: el.clientWidth, height: el.clientHeight })
          u.redraw()
        }
      })
    })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
  }, [heightSignal])

  if (!fi || fi.im.length === 0) {
    return (
      <div style={{
        height: '100%', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)', padding: 8, textAlign: 'center',
      }}>
        F-I curve needs an Im channel — pick one above and re-run.
      </div>
    )
  }
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: '100%', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        background: 'var(--bg-primary)', position: 'relative',
      }}
    >
      {menu}
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kinetics tab — per-spike table
// ---------------------------------------------------------------------------

function APKineticsTable({
  entry, onSelectSpike, selectedSpikeSet, onToggleSpike,
  trainIdByIdx,
}: {
  entry: APData | undefined
  onSelectSpike: (idx: number) => void
  /** Set of spike indices the user has checked for multi-spike
   *  overlay in the upper viewer / phase plot. Independent from the
   *  per-row "active" selectedSpikeIdx — that one drives the auto-
   *  zoom; this one drives overlay rendering. */
  selectedSpikeSet: Set<number>
  onToggleSpike: (idx: number) => void
  /** Per-spike train assignment (same length + order as
   *  ``entry.perSpike``). ``null`` = isolated; integer = global
   *  train id. When omitted or all-null the Train column is hidden
   *  so users without grouping enabled don't see an empty column. */
  trainIdByIdx?: (number | null)[] | null
}) {
  const sel = useRowSelection(entry?.perSpike.length ?? 0)
  const showTrainCol = !!trainIdByIdx && trainIdByIdx.some((v) => v != null)
  const baseHeaders = ['#', 'Sweep', 'Threshold (mV)', 'Peak (mV)', 'Amp (mV)',
    'Rise (ms)', 'Decay (ms)', 'FWHM (ms)', 'fAHP (mV)', 'mAHP (mV)',
    '+slope', '−slope']
  const headers = showTrainCol ? [...baseHeaders, 'Train'] : baseHeaders
  const rowToCells = (i: number): Array<string | number | null> => {
    const sp = entry!.perSpike[i]
    const base: Array<string | number | null> = [
      (sp.manual ? '★ ' : '') + (i + 1),
      sp.sweep + 1,
      sp.thresholdVm.toFixed(2),
      sp.peakVm.toFixed(2),
      sp.amplitudeMv.toFixed(2),
      sp.riseTimeS != null ? (sp.riseTimeS * 1000).toFixed(3) : null,
      sp.decayTimeS != null ? (sp.decayTimeS * 1000).toFixed(3) : null,
      sp.halfWidthS != null ? (sp.halfWidthS * 1000).toFixed(3) : null,
      sp.fahpVm ?? null,
      sp.mahpVm ?? null,
      sp.maxRiseSlopeMvMs ?? null,
      sp.maxDecaySlopeMvMs ?? null,
    ]
    if (showTrainCol) {
      const tid = trainIdByIdx?.[i]
      base.push(tid != null ? `T${tid + 1}` : '')
    }
    return base
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  if (!entry || entry.perSpike.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Run to populate the per-spike kinetics table.
      </div>
    )
  }
  return (
    <div style={{
      flex: 1, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      overflow: 'auto', minHeight: 0,
    }}>
      <table className="data-table">
        <thead>
          <tr>
            <Th>✓</Th>
            {headers.map((h, i) => <Th key={i}>{h}</Th>)}
          </tr>
        </thead>
        <tbody>
          {entry.perSpike.map((sp, i) => {
            const selected = i === entry.selectedSpikeIdx
            const checked = selectedSpikeSet.has(i)
            return (
              <tr
                key={i}
                onClick={(ev) => {
                  sel.onRowClick(i, ev)
                  if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
                    onSelectSpike(i)
                  }
                }}
                onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                })}
                style={{
                  background: sel.isSelected(i)
                    ? 'var(--accent-muted)'
                    : selected
                      ? 'var(--bg-selected)'
                      : 'transparent',
                  fontStyle: sp.manual ? 'italic' : 'normal',
                }}
              >
                <td
                  onClick={(e) => { e.stopPropagation(); onToggleSpike(i) }}>
                  <input type="checkbox" checked={checked}
                    onChange={() => onToggleSpike(i)}
                    onClick={(e) => e.stopPropagation()} />
                </td>
                <Td>{sp.manual ? '★ ' : ''}{i + 1}</Td>
                <Td>{sp.sweep + 1}</Td>
                <Td>{sp.thresholdVm.toFixed(2)}</Td>
                <Td>{sp.peakVm.toFixed(2)}</Td>
                <Td>{sp.amplitudeMv.toFixed(2)}</Td>
                <Td>{sp.riseTimeS != null ? (sp.riseTimeS * 1000).toFixed(3) : '—'}</Td>
                <Td>{sp.decayTimeS != null ? (sp.decayTimeS * 1000).toFixed(3) : '—'}</Td>
                <Td>{sp.halfWidthS != null ? (sp.halfWidthS * 1000).toFixed(3) : '—'}</Td>
                <Td>{sp.fahpVm != null ? sp.fahpVm.toFixed(2) : '—'}</Td>
                <Td>{sp.mahpVm != null ? sp.mahpVm.toFixed(2) : '—'}</Td>
                <Td>{sp.maxRiseSlopeMvMs != null ? sp.maxRiseSlopeMvMs.toFixed(1) : '—'}</Td>
                <Td>{sp.maxDecaySlopeMvMs != null ? sp.maxDecaySlopeMvMs.toFixed(1) : '—'}</Td>
                {showTrainCol && (
                  <Td>
                    {trainIdByIdx?.[i] != null
                      ? <span style={{ color: 'var(--marker-manual)' }}>T{(trainIdByIdx![i] as number) + 1}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </Td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase plot tab — Vm vs dV/dt for one selected spike
// ---------------------------------------------------------------------------

function APPhasePlotPanel({
  backendUrl, entry, group, series, trace, visibilitySignal, heightSignal,
  selectedSpikeIndices, hideMarkers,
}: {
  backendUrl: string
  entry: APData | undefined
  group: number; series: number; trace: number
  visibilitySignal?: number
  /** Parent splitter height — the panel sets uPlot size on every
   *  bump so dragging the splitter re-fits the plot. */
  heightSignal?: number
  /** When non-empty, overlay one phase loop per selected spike
   *  (colour-cycled). When empty, fall back to the entry's
   *  selectedSpikeIdx so the panel always shows something. */
  selectedSpikeIndices: Set<number>
  /** When true, suppress the threshold/peak/AHP marker dots in the
   *  loop. Useful when overlaying many spikes — markers stack. */
  hideMarkers: boolean
}) {
  const themeKey = useThemeKey()
  void hideMarkers  // not yet used inside the loop; reserved for future per-spike marker dots
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'phase-plot',
  })
  // Default 10 ms window — big enough to capture the full AP loop
  // (rising phase → peak → repolarisation → AHP back to baseline).
  const [windowMs, setWindowMs] = useState(10)
  // Default 1× (no upsampling) — the kinetics measurements are
  // already computed at the acquisition rate, and 10× was making
  // the phase-loop look over-smoothed on typical 20-50 kHz recordings.
  const [interp, setInterp] = useState(1)

  // Which spikes to plot. If the user has checked any, use that set;
  // otherwise fall back to a single-spike view of the table-active
  // selection so the panel never goes blank just because nothing is
  // checked.
  const spikesToPlot: APPoint[] = useMemo(() => {
    if (!entry || entry.perSpike.length === 0) return []
    if (selectedSpikeIndices.size > 0) {
      return [...selectedSpikeIndices]
        .sort((a, b) => a - b)
        .map((i) => entry.perSpike[i])
        .filter((sp): sp is APPoint => !!sp)
    }
    const fallback = entry.selectedSpikeIdx ?? 0
    const sp = entry.perSpike[fallback]
    return sp ? [sp] : []
  }, [entry, selectedSpikeIndices])
  const total = entry?.perSpike.length ?? 0
  const selectedIdx = entry?.selectedSpikeIdx ?? 0
  const selectedSpike: APPoint | null = entry?.perSpike[selectedIdx] ?? null

  // Per-spike fetched phase-plot data. Keyed by `${sweep}:${peakT}`
  // so re-rendering with the same set doesn't refetch.
  const [phaseSlices, setPhaseSlices] = useState<Record<string, { vm: number[]; dvdt: number[] } | null>>({})

  useEffect(() => {
    if (!backendUrl || spikesToPlot.length === 0) { setPhaseSlices({}); return }
    let cancelled = false
    const fetches = spikesToPlot.map(async (sp) => {
      const key = `${sp.sweep}:${sp.peakT}`
      const qs = new URLSearchParams({
        group: String(group), series: String(series), trace: String(trace),
        sweep: String(sp.sweep),
        peak_t_s: String(sp.peakT),
        window_ms: String(windowMs),
        interp_factor: String(interp),
      })
      try {
        const r = await fetch(`${backendUrl}/api/ap/phase_plot?${qs}`)
        if (!r.ok) return [key, null] as const
        const d = await r.json()
        return [key, { vm: d.vm ?? [], dvdt: d.dvdt ?? [] }] as const
      } catch {
        return [key, null] as const
      }
    })
    Promise.all(fetches).then((entries) => {
      if (cancelled) return
      const next: Record<string, { vm: number[]; dvdt: number[] } | null> = {}
      for (const [k, v] of entries) next[k] = v
      setPhaseSlices(next)
    })
    return () => { cancelled = true }
  }, [backendUrl, group, series, trace, spikesToPlot, windowMs, interp])

  // Single representative slice for the legacy max-Vm/max-dV/dt
  // header readout (use the active row's slice).
  const data = selectedSpike ? phaseSlices[`${selectedSpike.sweep}:${selectedSpike.peakT}`] ?? null : null

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    // Collect all the loops we have data for, in the same order as
    // spikesToPlot so colours stay consistent with the per-spike
    // rows in the table.
    const loops: { vm: number[]; dvdt: number[] }[] = []
    for (const sp of spikesToPlot) {
      const k = `${sp.sweep}:${sp.peakT}`
      const slice = phaseSlices[k]
      if (slice && slice.vm.length >= 2) loops.push(slice)
    }
    if (loops.length === 0) return

    // uPlot's AlignedData layout requires a SHARED x array across
    // series. For overlaid phase plots we need each loop to have
    // its OWN Vm vector — they're not aligned. Cleanest workaround:
    // build a synthetic shared "sample index" x and feed each loop
    // as a (synthetic-x, vm) pair... no, that doesn't work either.
    //
    // Actual approach: build a single padded x/y per series. The
    // x array becomes the LONGEST loop's Vm. Shorter loops get
    // null-padded. uPlot then plots each series on its own y vs
    // the SAME x, but the x values per series are also stored as
    // ALIGNED to one master. To overlay loops with different Vm
    // ranges, we use the trick: the Vm array goes into POSITION 0
    // (the common x). For multi-loop, we'd need a different approach.
    //
    // In practice the simplest reliable thing: concatenate all loops
    // into one (vm, dvdt) pair separated by NaN gaps. uPlot honours
    // null/undefined breaks in the path, so each loop draws as its
    // own segment without connecting lines between them. Loses the
    // per-spike colour distinction though.
    //
    // Better: render each loop as its own series. uPlot allows that
    // if we use the same x but each y can have different valid spans.
    // Trick: pick the FIRST loop's vm as the canonical x; subsequent
    // loops are projected onto it via index. Loops with different
    // lengths get padded/clipped. This loses fidelity if loops have
    // wildly different lengths but the typical case (similar window,
    // similar AP shape) works fine.
    //
    // Pragma: use the longest loop as the canonical x; pad shorter
    // ones with nulls; assign each its own series with its own colour.
    let longest = loops[0]
    for (const l of loops) if (l.vm.length > longest.vm.length) longest = l
    const xData = longest.vm.slice()
    const yArrays = loops.map((l) => {
      // For the canonical loop, no padding needed.
      if (l === longest) return l.dvdt.slice()
      // For others, repeat-pad/truncate so the array length matches.
      // This is a visual approximation — the loop will be drawn
      // against the canonical x positions, not its own. Acceptable
      // for similar-shaped APs.
      const out: (number | null)[] = new Array(xData.length).fill(null)
      const stride = l.vm.length / xData.length
      for (let i = 0; i < xData.length; i++) {
        const j = Math.min(l.vm.length - 1, Math.floor(i * stride))
        out[i] = l.dvdt[j]
      }
      return out
    })

    // Pin x/y ranges to the union extent of all loops + a little pad.
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity
    for (const l of loops) {
      for (let i = 0; i < l.vm.length; i++) {
        const x = l.vm[i], y = l.dvdt[i]
        if (x < xmin) xmin = x; if (x > xmax) xmax = x
        if (y < ymin) ymin = y; if (y > ymax) ymax = y
      }
    }
    const xpad = (xmax - xmin) * 0.05 || 1
    const ypad = (ymax - ymin) * 0.05 || 1
    const xRange: [number, number] = [xmin - xpad, xmax + xpad]
    const yRange: [number, number] = [ymin - ypad, ymax + ypad]

    // Colour cycle — first loop = primary trace colour, others
    // shifted around the wheel by HSL rotation.
    const palette = [
      cssVar('--trace-color-1') || '#42a5f5',
      '#e57373', '#81c784', '#ba68c8', '#ffb74d', '#4dd0e1',
      '#aed581', '#f06292', '#9575cd', '#fff176',
    ]
    const seriesOpts: uPlot.Series[] = [{}]
    for (let i = 0; i < loops.length; i++) {
      seriesOpts.push({
        stroke: palette[i % palette.length],
        width: 1.25,
        points: { show: false },
      })
    }

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(180, el.clientHeight || 280),
      scales: {
        x: { time: false, range: () => xRange },
        y: { range: () => yRange },
      },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          label: 'Vm (mV)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          label: 'dV/dt (mV/ms)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: seriesOpts,
    }
    const payload: uPlot.AlignedData = [xData, ...yArrays] as any
    plotRef.current = new uPlot(opts, payload, el)
  }, [phaseSlices, spikesToPlot, themeKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    const onWin = () => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  // Visibility signal — when the Phase tab becomes active the parent
  // bumps this; we resize+redraw on the next frame so the plot snaps
  // to the now-real container size (it was display:none before).
  useEffect(() => {
    if (visibilitySignal == null) return
    const raf = requestAnimationFrame(() => {
      const u = plotRef.current
      const el = containerRef.current
      if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
        u.redraw()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visibilitySignal])

  // Splitter / window resize signal from the parent. ResizeObserver
  // doesn't always fire reliably when the parent flexbox redistributes
  // height, so we explicitly setSize on every heightSignal bump. Two
  // rAFs deep so layout has actually flushed (a single rAF still runs
  // before the layout pass that follows the height change in some
  // browsers).
  useEffect(() => {
    if (heightSignal == null) return
    let r1 = 0, r2 = 0
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const u = plotRef.current
        const el = containerRef.current
        if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
          u.setSize({ width: el.clientWidth, height: el.clientHeight })
          u.redraw()
        }
      })
    })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
  }, [heightSignal])

  // setSel helper removed — prev/next now live in the overlay
  // viewer's header (single source of truth for spike navigation).

  return (
    // height: '100%' (not flex: 1) — the parent wrapper isn't a flex
    // container, so flex: 1 here was a no-op and the panel sized to
    // its content. That made the splitter's height changes invisible.
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
      <div className="viewer-header" style={{
        gap: 8,
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: 'var(--font-size-label)',
      }}>
        {/* Prev / next moved to the overlay viewer's header —
            they drive BOTH panels (zoomed spike + phase loop),
            so it made more sense to co-locate them with the
            primary viewer rather than embed them here. */}
        <span style={{ marginRight: 4, color: 'var(--text-muted)' }}>Window ±</span>
        <NumInput value={windowMs} step={1} min={1}
          onChange={(v) => setWindowMs(Math.max(1, v))} style={{ width: 56 }} />
        <span style={{ color: 'var(--text-muted)' }}>ms</span>
        <span style={{ marginLeft: 16, color: 'var(--text-muted)' }}>Interp</span>
        <select value={interp}
          onChange={(e) => setInterp(Number(e.target.value))}
          style={{ fontSize: 'var(--font-size-label)' }}>
          <option value="1">1×</option>
          <option value="10">10×</option>
          <option value="50">50×</option>
          <option value="100">100×</option>
        </select>
        {data && data.vm.length > 0 && (() => {
          // Header readout: peak / max-dV/dt / min-dV/dt for the
          // table-active spike. Computed locally now that we no
          // longer carry a metrics blob in the per-spike fetch.
          let mv = -Infinity, mdv = -Infinity, mndv = Infinity
          for (let i = 0; i < data.vm.length; i++) {
            if (data.vm[i] > mv) mv = data.vm[i]
            if (data.dvdt[i] > mdv) mdv = data.dvdt[i]
            if (data.dvdt[i] < mndv) mndv = data.dvdt[i]
          }
          return (
            <span className="num" style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
              Max Vm {mv.toFixed(1)} ·
              max dV/dt {mdv.toFixed(1)} ·
              min dV/dt {mndv.toFixed(1)}
            </span>
          )
        })()}
      </div>
      <div
        onContextMenu={onContextMenu}
        style={{ flex: 1, minHeight: 0, position: 'relative',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          background: 'var(--bg-primary)',
        }}
      >
        {menu}
        {/* Always-mounted plot container so ResizeObserver attaches
            on first mount, not after data arrives. The empty-state
            overlay sits on top via absolute positioning when the plot
            has nothing to show yet. */}
        <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
        {(!data || data.vm.length < 2) && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)',
            background: 'var(--bg-primary)',
            pointerEvents: 'none',
          }}>
            {entry && total > 0
              ? 'Loading phase plot…'
              : 'Run to populate the phase plot, then pick a spike.'}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AP sweep viewer — Vm trace + draggable bounds bands + spike markers
// ---------------------------------------------------------------------------

function APSweepViewer({
  traceTime, traceValues, traceUnits,
  previewSweep, totalSweeps,
  theme, fontSize,
  zeroOffset, onZeroOffsetChange, zeroOffsetApplied,
  boundsStartS, boundsEndS, onBoundsChange,
  previewSpikes,
  entry,
  heightSignal,
  zoomToSpikeRequest,
  onXRangeChange, viewKey,
  onAddSpike,
  onRemoveSpikeAt,
  showBounds,
  trainsForSweep,
}: {
  traceTime: number[] | null
  traceValues: number[] | null
  traceUnits: string
  previewSweep: number
  totalSweeps: number
  theme: string
  fontSize: number
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  zeroOffsetApplied: number
  boundsStartS: number
  boundsEndS: number
  onBoundsChange: (start: number, end: number) => void
  /** Per-spike measurements for the current preview sweep — drives
   *  the threshold/peak/half-width/fAHP/mAHP overlay markers. */
  previewSpikes: APPoint[]
  entry: APData | undefined
  /** Parent splitter / window height. uPlot resizes on change. */
  heightSignal?: number
  /** Bumped by the parent when a kinetics row is clicked: viewer
   *  zooms its x range to centre ± half-width-ms around the spike. */
  zoomToSpikeRequest?: { bump: number; centerT: number; halfMs: number } | null
  /** Fired when the user pans / wheel-zooms / resets, so stacked
   *  overlay viewers can mirror the x range. */
  onXRangeChange?: (xMin: number, xMax: number) => void
  /** Click-on-empty-space adds a manual spike at the click time
   *  (matches the Events-window prime+confirm gesture set). */
  onAddSpike?: (timeS: number) => void
  /** Click-on-primed-marker confirms removal at that peak time. */
  onRemoveSpikeAt?: (timeS: number) => void
  /** When false, the analysis-bounds bands are hidden AND the
   *  drag-edge / drag-band hit-test is skipped, so click-through
   *  works in the area they normally cover. */
  showBounds: boolean
  /** Trains computed for the currently previewed sweep. Drawn as
   *  translucent shaded spans behind the spike markers; empty when
   *  grouping is off or no clusters qualify. */
  trainsForSweep: TrainSummary[]
  /** Changes when the recording slice shown changes; clears the saved zoom. */
  viewKey: string
}) {
  const themeKey = useThemeKey()
  void previewSweep; void totalSweeps; void traceUnits
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'ap-sweep',
  })

  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)

  // A different recording slice → once its trace arrives, drop the saved
  // zoom so it auto-fits instead of sitting in the old range. (Clearing
  // straight away isn't enough: redraws of the old plot would save the
  // old range again before the new trace loads.)
  const zoomResetFromRef = useRef<unknown>(undefined)
  useEffect(() => { zoomResetFromRef.current = traceTime }, [viewKey])
  const boundsRef = useRef({ start: boundsStartS, end: boundsEndS })
  boundsRef.current = { start: boundsStartS, end: boundsEndS }
  const spikesRef = useRef<APPoint[]>(previewSpikes)
  spikesRef.current = previewSpikes
  const offsetRef = useRef(zeroOffsetApplied)
  offsetRef.current = zeroOffsetApplied
  const entryRef = useRef(entry)
  entryRef.current = entry
  // Stash the X-range-change callback in a ref so the wheel/pan/reset
  // handlers (which are wired once and never rebuilt) always see the
  // latest prop value without forcing a remount.
  const onXRangeChangeRef = useRef(onXRangeChange)
  onXRangeChangeRef.current = onXRangeChange
  const emitXRange = (xMin: number, xMax: number) => {
    try { onXRangeChangeRef.current?.(xMin, xMax) } catch { /* ignore */ }
  }
  // Manual spike add/remove callbacks, also stashed in refs because
  // the pointer handlers below are wired once per uPlot rebuild.
  const onAddSpikeRef = useRef(onAddSpike)
  onAddSpikeRef.current = onAddSpike
  const onRemoveSpikeAtRef = useRef(onRemoveSpikeAt)
  onRemoveSpikeAtRef.current = onRemoveSpikeAt
  // Index (within ``previewSpikes``) of the marker the user clicked
  // first, awaiting a confirmation click to delete. Mirrors the
  // Events-window primedDiscardIdxRef pattern. Reset on sweep /
  // series change so an unconfirmed prime doesn't persist across
  // navigation.
  const primedRemoveIdxRef = useRef<number | null>(null)
  useEffect(() => { primedRemoveIdxRef.current = null }, [previewSweep])
  // Mirror ``showBounds`` into a ref so the once-wired pointer
  // handlers and the uPlot draw hook always see the latest value
  // without rebuilding the plot.
  const showBoundsRef = useRef(showBounds)
  showBoundsRef.current = showBounds
  useEffect(() => { plotRef.current?.redraw() }, [showBounds])

  // Per-sweep trains, mirrored in a ref so the imperative
  // ``drawOverlays`` callback (registered once on plot init) reads
  // the latest set without forcing a uPlot rebuild. The redraw is
  // triggered by the dedicated useEffect below.
  const trainsRef = useRef<TrainSummary[]>(trainsForSweep)
  trainsRef.current = trainsForSweep
  useEffect(() => { plotRef.current?.redraw() }, [trainsForSweep])

  const drawOverlays = (u: uPlot) => {
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1
    const top = u.bbox.top
    const bottom = u.bbox.top + u.bbox.height

    // Train spans (drawn first so the bounds band + spike markers all
    // sit on top). Faint amber band per train spanning [startS, endS]
    // with a small "T#" label at the upper-left corner — same colour
    // family as the manual-spike orange so the user reads "this is a
    // grouping of the spikes inside." Empty when grouping is off.
    const trains = trainsRef.current
    if (trains.length > 0) {
      const trainColor = cssVar('--marker-manual')
      ctx.save()
      ctx.font = `600 ${10 * dpr}px ${cssVar('--font-ui')}`
      for (const t of trains) {
        const a = u.valToPos(t.startS, 'x', true)
        const b = u.valToPos(t.endS, 'x', true)
        if (!isFinite(a) || !isFinite(b)) continue
        const lo = Math.min(a, b)
        const w = Math.max(1 * dpr, Math.abs(b - a))
        ctx.fillStyle = trainColor
        ctx.globalAlpha = 0.13
        ctx.fillRect(lo, top, w, bottom - top)
        ctx.strokeStyle = trainColor
        ctx.globalAlpha = 0.45
        ctx.lineWidth = 1 * dpr
        ctx.beginPath()
        ctx.moveTo(a, top); ctx.lineTo(a, bottom)
        ctx.moveTo(b, top); ctx.lineTo(b, bottom)
        ctx.stroke()
        ctx.globalAlpha = 0.95
        ctx.fillText(`T${t.id + 1}`, lo + 3 * dpr, top + 12 * dpr)
        ctx.globalAlpha = 1
      }
      ctx.restore()
    }

    // Bounds bands — translucent blue, label inside.
    const drawBand = (x0: number, x1: number, color: string, label: string) => {
      // Clip to the plot area: a band that starts before the visible
      // range (e.g. bounds from 0 s) would otherwise put its label in
      // the y-axis gutter, where it gets cut off.
      const plotL = u.bbox.left
      const plotR = u.bbox.left + u.bbox.width
      const l = Math.max(plotL, Math.min(u.valToPos(x0, 'x', true), u.valToPos(x1, 'x', true)))
      const r = Math.min(plotR, Math.max(u.valToPos(x0, 'x', true), u.valToPos(x1, 'x', true)))
      if (r <= l) return
      ctx.save()
      ctx.globalAlpha = 0.14
      ctx.fillStyle = color
      ctx.fillRect(l, top, r - l, bottom - top)
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.font = `600 ${10 * dpr}px ${cssVar('--font-ui')}`
      // uPlot leaves textAlign at 'right' after drawing the y axis.
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(label, l + 4 * dpr, top + 12 * dpr)
      ctx.restore()
    }
    const b = boundsRef.current
    // Effective end — when set to 0, treat as full sweep so the band
    // visually spans the whole trace rather than collapsing to a line.
    const effEnd = b.end > b.start
      ? b.end
      : (u.scales.x.max ?? b.start)
    // ``showBounds`` toggles the band visibility (and the hit-test
    // below). Bounds values are kept; the user just hides them.
    if (showBoundsRef.current) {
      drawBand(b.start, effEnd, cssVar(BOUND_COLOR), 'Analysis bounds')
    }

    // Per-spike markers on the trace. Drawn on the overlay canvas
    // (separate from the uPlot canvas so they don't interact with
    // its scale callbacks). Five marker types per spike — colours
    // match the kinetics-table semantics and are tooltipped in the
    // legend strip.
    const offset = offsetRef.current
    const spikes = spikesRef.current
    const overlayCanvas = overlayRef.current
    if (!overlayCanvas) return
    const oCtx = overlayCanvas.getContext('2d')
    if (!oCtx) return
    const cssW = overlayCanvas.clientWidth
    const cssH = overlayCanvas.clientHeight
    if (overlayCanvas.width !== cssW * dpr || overlayCanvas.height !== cssH * dpr) {
      overlayCanvas.width = cssW * dpr; overlayCanvas.height = cssH * dpr
    }
    oCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    oCtx.clearRect(0, 0, cssW, cssH)
    if (spikes.length === 0) return
    const outlineColor = cssVar('--marker-outline')
    const spikeColor = cssVar(SPIKE_COLOR)
    const thresholdColor = cssVar(AP_MARKER.threshold)
    const fwhmColor = cssVar(AP_MARKER.fwhm)
    const fahpColor = cssVar(AP_MARKER.fahp)
    const mahpColor = cssVar(AP_MARKER.mahp)

    // toPx variants. ``traceValues`` is already in display space (the
    // backend has applied zero-offset when on), so sampled values
    // plot as-is. Stored marker y-values are RAW signal, so they map
    // to display by subtracting ``offset``.
    //   ``toPxRaw`` — caller passes a known raw y (e.g. stored peak
    //                 amplitude) and we shift to display.
    //   ``toPx``    — peak / threshold / fAHP / mAHP: sample the
    //                 displayed trace at t so dots ride the visible
    //                 line regardless of filter state. Falls back to
    //                 the raw stored y (with offset shift) when the
    //                 sample is out-of-range.
    const toPxRaw = (t: number, v: number): [number, number] => [
      u.valToPos(t, 'x', true) / dpr,
      u.valToPos(v - offset, 'y', true) / dpr,
    ]
    const toPx = (t: number, fallbackV: number): [number, number] => {
      const sampled = sampleTraceYAt(traceTime, traceValues, t)
      const yUse = sampled != null ? sampled : (fallbackV - offset)
      return [
        u.valToPos(t, 'x', true) / dpr,
        u.valToPos(yUse, 'y', true) / dpr,
      ]
    }
    const dot = (px: number, py: number, color: string, ring: boolean = false) => {
      if (!isFinite(px) || !isFinite(py)) return
      oCtx.beginPath()
      oCtx.arc(px, py, 5, 0, Math.PI * 2)
      oCtx.fillStyle = color; oCtx.fill()
      oCtx.strokeStyle = outlineColor; oCtx.lineWidth = 1.2; oCtx.stroke()
      if (ring) {
        oCtx.beginPath()
        oCtx.arc(px, py, 9, 0, Math.PI * 2)
        oCtx.strokeStyle = color; oCtx.lineWidth = 1.5
        oCtx.stroke()
      }
    }

    // Find the nearest trace sample for a given peak time — used
    // when the spike record only has the peak time (kinetics not
    // measured) so we can still place a peak dot on the trace.
    const tt = traceTime
    const tv = traceValues
    const nearestY = (t: number): number | null => {
      if (!tt || !tv || tt.length === 0) return null
      let idx = 0; let best = Infinity
      for (let i = 0; i < tt.length; i++) {
        const d = Math.abs(tt[i] - t)
        if (d < best) { best = d; idx = i }
      }
      return tv[idx]
    }

    // Track the primed marker's screen position so we can stamp a
    // confirmation ring after the rest of the layer is drawn.
    let primedPos: [number, number] | null = null
    const primedIdx = primedRemoveIdxRef.current
    for (let spi = 0; spi < spikes.length; spi++) {
      const sp = spikes[spi]
      let peakXY: [number, number] | null = null
      // Peak — always present (manual flag rings it).
      if (sp.peakVm !== 0 || sp.thresholdVm !== 0) {
        peakXY = toPx(sp.peakT, sp.peakVm)
        dot(peakXY[0], peakXY[1], spikeColor, sp.manual)
      } else {
        // Fallback (no kinetics) — place peak at the nearest sample y.
        const y = nearestY(sp.peakT)
        if (y != null) {
          peakXY = toPx(sp.peakT, y)
          dot(peakXY[0], peakXY[1], spikeColor, sp.manual)
        }
      }
      if (peakXY && spi === primedIdx) primedPos = peakXY
      // Threshold dot (foot of the spike).
      if (sp.thresholdVm !== 0 || sp.thresholdT !== 0) {
        const [px, py] = toPx(sp.thresholdT, sp.thresholdVm)
        dot(px, py, thresholdColor)
      }
      // Half-width markers — find the actual times where the trace
      // crosses (threshold + amplitude/2) on the rising and falling
      // sides of the spike. The backend returns half_width in
      // duration only; positioning the markers via algebraic
      // approximation drifted off the trace, so we walk the displayed
      // samples here. Slightly more code, dots actually land on it.
      if (sp.halfWidthS != null && sp.amplitudeMv > 0 && tt && tv) {
        // ``thresholdVm`` / ``amplitudeMv`` are in raw signal space.
        // ``halfVRaw`` keeps that frame for ``toPx`` (which applies
        // ``- offset`` for the fallback path). ``halfV`` is the same
        // value shifted into display space so the crossing scan
        // against ``tv`` (already display-space) compares correctly.
        const halfVRaw = sp.thresholdVm + sp.amplitudeMv / 2
        const halfV = halfVRaw - offset
        // Clip search to a sensible window: from threshold time to
        // peak time + half-width-extra (so we catch the falling
        // crossing even if it sits slightly past peak + halfWidth).
        const tLo = sp.thresholdT
        const tHi = sp.peakT + sp.halfWidthS + 0.005
        // Linear-interp the rising crossing (between threshold and peak)
        // and the falling crossing (between peak and tHi).
        const findCrossing = (t0: number, t1: number, ascending: boolean): number | null => {
          let prevT = -Infinity, prevV = NaN
          for (let i = 0; i < tt.length; i++) {
            const t = tt[i]
            if (t < t0) { prevT = t; prevV = tv[i]; continue }
            if (t > t1) break
            const v = tv[i]
            const above = v >= halfV
            const wasAbove = isFinite(prevV) ? prevV >= halfV : null
            if (wasAbove != null) {
              if (ascending && !wasAbove && above) {
                const frac = (halfV - prevV) / (v - prevV)
                return prevT + frac * (t - prevT)
              }
              if (!ascending && wasAbove && !above) {
                const frac = (halfV - prevV) / (v - prevV)
                return prevT + frac * (t - prevT)
              }
            }
            prevT = t; prevV = v
          }
          return null
        }
        const tLeft = findCrossing(tLo, sp.peakT, true)
        const tRight = findCrossing(sp.peakT, tHi, false)
        if (tLeft != null && tRight != null) {
          const [pxL, pyL] = toPx(tLeft, halfVRaw)
          const [pxR, pyR] = toPx(tRight, halfVRaw)
          if (isFinite(pxL) && isFinite(pyL) && isFinite(pxR) && isFinite(pyR)) {
            oCtx.save()
            oCtx.strokeStyle = fwhmColor
            oCtx.lineWidth = 1
            oCtx.setLineDash([3, 3])
            oCtx.beginPath()
            oCtx.moveTo(pxL, pyL); oCtx.lineTo(pxR, pyR)
            oCtx.stroke()
            oCtx.setLineDash([])
            oCtx.restore()
            dot(pxL, pyL, fwhmColor); dot(pxR, pyR, fwhmColor)
          }
        }
      }
      // fAHP marker (post-peak fast undershoot).
      if (sp.fahpVm != null && sp.fahpT != null) {
        const [px, py] = toPx(sp.fahpT, sp.fahpVm)
        dot(px, py, fahpColor)
      }
      // mAHP marker (slower medium undershoot).
      if (sp.mahpVm != null && sp.mahpT != null) {
        const [px, py] = toPx(sp.mahpT, sp.mahpVm)
        dot(px, py, mahpColor)
      }
    }
    // Primed-remove confirmation ring — drawn LAST so it sits over
    // any per-spike rings from manual / kinetics layers. Same
    // text-primary ring as the Events / Burst windows so the
    // prime-then-confirm gesture is consistent across windows.
    if (primedPos) {
      oCtx.save()
      oCtx.strokeStyle = cssVar('--text-primary')
      oCtx.lineWidth = 2
      oCtx.beginPath()
      oCtx.arc(primedPos[0], primedPos[1], 11, 0, Math.PI * 2)
      oCtx.stroke()
      oCtx.restore()
    }
  }

  const resetZoom = () => {
    const u = plotRef.current
    if (!u || !traceTime || !traceValues) return
    xRangeRef.current = null
    yRangeRef.current = null
    if (traceTime.length === 0) return
    const xmin = traceTime[0], xmax = traceTime[traceTime.length - 1]
    let ymin = Infinity, ymax = -Infinity
    // ``traceValues`` is already the displayed trace — the backend
    // applied zero-offset server-side via the ``zero_offset=true``
    // flag on the trace fetch. No further subtraction here, otherwise
    // the auto-fit Y range would be computed against a doubly-shifted
    // trace.
    for (const v of traceValues) {
      if (v < ymin) ymin = v; if (v > ymax) ymax = v
    }
    if (isFinite(xmin) && isFinite(xmax) && xmax > xmin) {
      u.setScale('x', { min: xmin, max: xmax })
      emitXRange(xmin, xmax)
    }
    if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
      const pad = (ymax - ymin) * 0.05
      u.setScale('y', { min: ymin - pad, max: ymax + pad })
    }
  }

  useEffect(() => {
    const resetZoomOnBuild = zoomResetFromRef.current !== undefined && traceTime !== zoomResetFromRef.current
    const container = containerRef.current
    if (!container || !traceTime || !traceValues) {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      return
    }
    const frame = requestAnimationFrame(() => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      // Cleared here, not before the frame: the old plot can still redraw
      // (and re-save its range) until it's destroyed.
      if (resetZoomOnBuild) {
        xRangeRef.current = null
        yRangeRef.current = null
        zoomResetFromRef.current = undefined
      }
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 100)
      // ``traceValues`` already reflects the requested zero-offset
      // (subtracted server-side when zeroOffset is on, otherwise
      // unchanged). Plot it directly — subtracting ``zeroOffsetApplied``
      // here too would shift the trace by twice the intended amount.
      // Markers stored in raw signal space still apply ``- offset``
      // when they map onto this displayed trace; see ``toPx``.
      const adjusted = traceValues
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: {
            time: false,
            range: (_u, dataMin, dataMax) => {
              if (xRangeRef.current) return xRangeRef.current
              const lo = isFinite(dataMin) ? dataMin : 0
              const hi = isFinite(dataMax) && dataMax > lo ? dataMax : lo + 1
              const r: [number, number] = [lo, hi]
              xRangeRef.current = r
              // Notify overlay viewers of the initial auto-fit range
              // on the very first draw, so they mirror it immediately
              // rather than waiting for the user to interact.
              emitXRange(lo, hi)
              return r
            },
          },
          y: {
            range: (_u, dataMin, dataMax) => {
              if (yRangeRef.current) return yRangeRef.current
              if (!isFinite(dataMin) || !isFinite(dataMax) || dataMin === dataMax) return [0, 1]
              const pad = (dataMax - dataMin) * 0.05
              const r: [number, number] = [dataMin - pad, dataMax + pad]
              yRangeRef.current = r
              return r
            },
          },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'mV', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.25, points: { show: false } },
        ],
        hooks: { draw: [(u) => drawOverlays(u)] },
      }
      const attachTip = attachHoverCoords(opts, { unitsRef: { current: traceUnits } })
      plotRef.current = new uPlot(opts, [traceTime, adjusted], container)
      attachTip(container)
      // ---- Wheel zoom + drag-to-pan + drag bounds-band edges ----
      const u = plotRef.current
      const over = container.querySelector<HTMLDivElement>('.u-over')
      if (!over) return
      const EDGE_PX = 6

      const xToPx = (x: number) => u.valToPos(x, 'x', false)
      const pxToX = (px: number) => u.posToVal(px, 'x')

      type Drag =
        | { kind: 'bound-edge'; which: 'start' | 'end' }
        | { kind: 'bound-band'; startPxX: number; startStart: number; startEnd: number }
        | {
            kind: 'maybe-pan'
            startPxX: number; startPxY: number
            xMin: number; xMax: number; yMin: number; yMax: number
            panning: boolean
          }
      let drag: Drag | null = null
      const DRAG_THRESHOLD_PX = 3
      const MARKER_HIT_PX = 10

      const findHit = (pxX: number): Drag | null => {
        // Skip hit-test entirely when bounds are hidden — clicking
        // through the area should pan / add markers, not grab an
        // invisible cursor edge.
        if (!showBoundsRef.current) return null
        const b = boundsRef.current
        const effEnd = b.end > b.start ? b.end : (u.scales.x.max ?? b.start)
        const pxStart = xToPx(b.start)
        const pxEnd = xToPx(effEnd)
        if (Math.abs(pxX - pxStart) <= EDGE_PX) return { kind: 'bound-edge', which: 'start' }
        if (b.end > b.start && Math.abs(pxX - pxEnd) <= EDGE_PX) return { kind: 'bound-edge', which: 'end' }
        if (pxX > Math.min(pxStart, pxEnd) + EDGE_PX && pxX < Math.max(pxStart, pxEnd) - EDGE_PX) {
          return { kind: 'bound-band', startPxX: pxX, startStart: b.start, startEnd: b.end }
        }
        return null
      }

      // Hit-test against a spike marker (peak dot). Returns the index
      // into ``previewSpikes`` if within MARKER_HIT_PX of the dot's
      // screen position, else null. The marker y comes from sampling
      // the displayed trace at peakT — same source the overlay uses,
      // so the click target lines up with what the user sees.
      const findSpikeHit = (pxX: number, pxY: number): number | null => {
        const sps = spikesRef.current
        if (!sps || sps.length === 0) return null
        let best = -1, bestD = Infinity
        for (let i = 0; i < sps.length; i++) {
          const sp = sps[i]
          const sampled = sampleTraceYAt(traceTime, traceValues, sp.peakT)
          const yUse = sampled != null
            ? sampled
            : (sp.peakVm !== 0 ? sp.peakVm - offsetRef.current : null)
          if (yUse == null) continue
          const mx = u.valToPos(sp.peakT, 'x', false)
          const my = u.valToPos(yUse, 'y', false)
          const d = Math.hypot(mx - pxX, my - pxY)
          if (d < bestD && d < MARKER_HIT_PX) { best = i; bestD = d }
        }
        return best >= 0 ? best : null
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (ev.button !== 0) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top

        // Priority 1: bound edges / band — keep the existing drag.
        const hit = findHit(pxX)
        if (hit) {
          drag = hit
          over.setPointerCapture(ev.pointerId)
          over.style.cursor = 'ew-resize'
          ev.preventDefault()
          return
        }

        // Priority 2: spike marker — prime on first click, confirm
        // remove on second click of the same primed marker. Matches
        // the Events-window prime+confirm gesture.
        const spikeHit = findSpikeHit(pxX, pxY)
        if (spikeHit != null) {
          if (primedRemoveIdxRef.current === spikeHit) {
            const sp = spikesRef.current[spikeHit]
            primedRemoveIdxRef.current = null
            onRemoveSpikeAtRef.current?.(sp.peakT)
          } else {
            primedRemoveIdxRef.current = spikeHit
            plotRef.current?.redraw()
          }
          ev.preventDefault()
          return
        }

        // Priority 3: empty space — start click-or-pan. Plain click
        // (release without movement) ADDS a manual spike at the
        // click time. Movement past DRAG_THRESHOLD_PX commits to a
        // pan. Run analysis is NOT triggered from here — it has its
        // own button (see ``onRun``).
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (xMin == null || xMax == null || yMin == null || yMax == null) return
        drag = {
          kind: 'maybe-pan',
          startPxX: pxX, startPxY: pxY,
          xMin, xMax, yMin, yMax,
          panning: false,
        }
        over.setPointerCapture(ev.pointerId)
      }
      const onPointerMove = (ev: PointerEvent) => {
        if (!drag) {
          // Hover affordance for bound edges.
          const rect = over.getBoundingClientRect()
          const hit = findHit(ev.clientX - rect.left)
          over.style.cursor = hit ? (hit.kind === 'bound-edge' ? 'ew-resize' : 'grab') : ''
          return
        }
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        if (drag.kind === 'bound-edge') {
          const newT = pxToX(pxX)
          const b = boundsRef.current
          if (drag.which === 'start') {
            onBoundsChange(Math.max(0, newT), b.end)
          } else {
            onBoundsChange(b.start, Math.max(b.start + 0.001, newT))
          }
        } else if (drag.kind === 'bound-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          onBoundsChange(
            Math.max(0, drag.startStart + dx),
            Math.max(drag.startStart + dx + 0.001, drag.startEnd + dx),
          )
        } else if (drag.kind === 'maybe-pan') {
          const dxPx = pxX - drag.startPxX
          const dyPx = pxY - drag.startPxY
          if (!drag.panning &&
              (Math.abs(dxPx) > DRAG_THRESHOLD_PX || Math.abs(dyPx) > DRAG_THRESHOLD_PX)) {
            drag.panning = true
            over.style.cursor = 'grabbing'
          }
          if (!drag.panning) return
          const bboxW = u.bbox.width / (devicePixelRatio || 1)
          const bboxH = u.bbox.height / (devicePixelRatio || 1)
          const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
          const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
          const nx: [number, number] = [drag.xMin + dx, drag.xMax + dx]
          const ny: [number, number] = [drag.yMin + dy, drag.yMax + dy]
          xRangeRef.current = nx
          yRangeRef.current = ny
          u.setScale('x', { min: nx[0], max: nx[1] })
          u.setScale('y', { min: ny[0], max: ny[1] })
          emitXRange(nx[0], nx[1])
        }
      }
      const onPointerUp = (ev: PointerEvent) => {
        if (!drag) return
        // Capture click-or-pan resolution before clearing drag so the
        // narrow type assertion holds when reading .panning below.
        const clickCandidate = drag.kind === 'maybe-pan' && !drag.panning
        drag = null
        try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        over.style.cursor = ''
        if (clickCandidate) {
          const rect = over.getBoundingClientRect()
          const pxX = ev.clientX - rect.left
          const tClick = pxToX(pxX)
          // Clear any primed-remove state — clicking empty space is
          // a deliberate "no, don't delete that one" gesture.
          if (primedRemoveIdxRef.current != null) {
            primedRemoveIdxRef.current = null
            plotRef.current?.redraw()
          }
          if (isFinite(tClick)) onAddSpikeRef.current?.(tClick)
        }
      }
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault()
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
        if (ev.altKey) {
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (yMin == null || yMax == null) return
          const yAtCur = u.posToVal(pxY, 'y')
          const newMin = yAtCur - (yAtCur - yMin) * factor
          const newMax = yAtCur + (yMax - yAtCur) * factor
          yRangeRef.current = [newMin, newMax]
          u.setScale('y', { min: newMin, max: newMax })
        } else {
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          if (xMin == null || xMax == null) return
          const xAtCur = u.posToVal(pxX, 'x')
          const newMin = xAtCur - (xAtCur - xMin) * factor
          const newMax = xAtCur + (xMax - xAtCur) * factor
          xRangeRef.current = [newMin, newMax]
          u.setScale('x', { min: newMin, max: newMax })
          emitXRange(newMin, newMax)
        }
      }
      over.addEventListener('pointerdown', onPointerDown)
      over.addEventListener('pointermove', onPointerMove)
      over.addEventListener('pointerup', onPointerUp)
      over.addEventListener('pointercancel', onPointerUp)
      over.addEventListener('wheel', onWheel, { passive: false })
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues, zeroOffsetApplied, themeKey])

  useEffect(() => { plotRef.current?.redraw() }, [boundsStartS, boundsEndS])
  useEffect(() => { plotRef.current?.redraw() }, [previewSpikes, entry, theme, fontSize])

  // Resize on container size changes (splitter drag, window resize)
  // and on heightSignal bumps (parent's topHeight). Same 0-dim guard
  // we settled on for the FPsp viewer.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    const onWin = () => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const u = plotRef.current
      const el = containerRef.current
      if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
        u.redraw()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [heightSignal])

  // Zoom to a spike when the parent issues a request — e.g. user
  // clicked a kinetics row and wants to inspect the markers up close.
  useEffect(() => {
    if (!zoomToSpikeRequest) return
    const u = plotRef.current
    if (!u) return
    const half = zoomToSpikeRequest.halfMs / 1000
    const lo = zoomToSpikeRequest.centerT - half
    const hi = zoomToSpikeRequest.centerT + half
    xRangeRef.current = [lo, hi]
    u.setScale('x', { min: lo, max: hi })
    u.redraw()
    emitXRange(lo, hi)
  }, [zoomToSpikeRequest])

  // Emit the initial auto-fit range so overlay viewers mirror it
  // before the user does anything. Fires once per plot build.
  useEffect(() => {
    const u = plotRef.current
    if (!u) return
    const r = xRangeRef.current
    if (r) emitXRange(r[0], r[1])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-primary)', position: 'relative',
    }}>
      <div className="viewer-header" style={{
        fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
        borderRadius: 'var(--radius) var(--radius) 0 0',
      }}>
        <span>Sweep <span className="num">{previewSweep + 1}</span></span>
        <span><span className="num">{previewSpikes.length}</span> spike{previewSpikes.length === 1 ? '' : 's'}</span>
        <APMarkerLegend />
        <label style={{
          display: 'flex', alignItems: 'center', gap: 3, marginLeft: 'auto',
        }} title="Subtract per-sweep baseline (first ~3 ms) from the displayed trace">
          <input type="checkbox" checked={zeroOffset}
            onChange={(e) => onZeroOffsetChange(e.target.checked)} />
          Zero offset
        </label>
        <button className="btn btn-sm" onClick={resetZoom}
          title="Reset X+Y to data bounds">Reset zoom</button>
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{ flex: 1, position: 'relative', minHeight: 0 }}
      >
        {menu}
        <canvas ref={overlayRef}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, width: '100%', height: '100%' }} />
      </div>
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
        borderRadius: '0 0 var(--radius) var(--radius)',
      }}>
        Scroll = zoom X · ⌥ scroll = zoom Y · drag = pan · drag bounds edge / band to move
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function ParamRow({
  label, value, step, min, max, onChange,
}: {
  label: string
  value: number
  step: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  // Explicit narrow width for the left-column layout — without it
  // NumInput stretches to fill the full column (~300 px in a
  // single-column grid), which wastes horizontal space when the
  // actual typed values are 3–4 digits.
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange}
        style={{ width: 110 }} />
    </label>
  )
}

/** Thin section divider inside a two-column param grid. Spans the
 *  full grid width via gridColumn. Small semibold label + a hairline
 *  top border gives the panel a scannable structure without stealing
 *  vertical space. */
function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      gridColumn: '1 / -1',
      fontSize: 'var(--font-size-xs)',
      color: 'var(--text-muted)',
      fontWeight: 600,
      paddingTop: 4,
      borderTop: '1px solid var(--border)',
      marginTop: 4,
    }}>{children}</div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={style}>{children}</td>
)

// Shut up unused-import warnings until we add a manual-edit polish pass.
void MANUAL_COLOR

// ---------------------------------------------------------------------------
// APSpikesOverlayViewer — Kinetics-tab left side
//
// Fetches a per-spike trace slice (peak ± window) for every spike in
// `selectedSpikeIndices` and overlays them on a single uPlot, time-
// aligned to t=0 at each spike's peak. When the selection is empty,
// falls back to the entry's selectedSpikeIdx so the panel always
// shows something.
//
// "Hide markers" suppresses the per-spike threshold/peak/AHP overlay
// dots (useful when overlaying many spikes — markers stack into a
// blob otherwise).
// ---------------------------------------------------------------------------

const OVERLAY_PALETTE = [
  '#42a5f5', '#e57373', '#81c784', '#ba68c8', '#ffb74d',
  '#4dd0e1', '#aed581', '#f06292', '#9575cd', '#fff176',
]

function APSpikesOverlayViewer({
  backendUrl, entry, group, series, trace,
  selectedSpikeIndices, hideMarkers, onHideMarkersChange,
  onSelectAll, onClearSelection, onSelectSpike,
  filter, zeroOffset,
  visibilitySignal, heightSignal,
}: {
  backendUrl: string
  entry: APData | undefined
  group: number; series: number; trace: number
  selectedSpikeIndices: Set<number>
  hideMarkers: boolean
  onHideMarkersChange: (v: boolean) => void
  onSelectAll: () => void
  onClearSelection: () => void
  /** Spike-navigation setter — moves the table-active spike index.
   *  Lives here (instead of in the phase-plot header) because this
   *  viewer is the primary one; prev/next affect both panels. */
  onSelectSpike: (idx: number) => void
  /** Echo the AP detection filter so the displayed slice matches the
   *  signal the detector ran on (mirrors what FPsp does). null = off. */
  filter: { type: 'lowpass' | 'highpass' | 'bandpass'; low: number; high: number; order: number } | null
  /** Apply the same per-sweep zero-offset the AP sweep viewer uses
   *  so overlaid spikes align in y when from different baselines. */
  zeroOffset: boolean
  visibilitySignal?: number
  heightSignal?: number
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'ap-spikes-overlay',
  })
  const [windowMs, setWindowMs] = useState(15)

  // Spikes to display: the user's checkbox set, or fall back to the
  // active row when nothing's checked.
  const spikesToShow: APPoint[] = useMemo(() => {
    if (!entry || entry.perSpike.length === 0) return []
    if (selectedSpikeIndices.size > 0) {
      return [...selectedSpikeIndices]
        .sort((a, b) => a - b)
        .map((i) => entry.perSpike[i])
        .filter((sp): sp is APPoint => !!sp)
    }
    const fallback = entry.selectedSpikeIdx ?? 0
    const sp = entry.perSpike[fallback]
    return sp ? [sp] : []
  }, [entry, selectedSpikeIndices])

  // Per-spike fetched slice. Keyed on `${sweep}:${peakT}` so the same
  // selection (or selection subset) doesn't re-fetch.
  const [slices, setSlices] = useState<Record<string, { time: number[]; values: number[] } | null>>({})
  // Mirror slices into a ref so drawMarkerOverlay — which is called
  // from the uPlot draw hook without state access — can look up the
  // per-spike trace data to compute FWHM crossings on the fly.
  const slicesRef = useRef(slices)
  slicesRef.current = slices

  useEffect(() => {
    if (!backendUrl || spikesToShow.length === 0) { setSlices({}); return }
    let cancelled = false
    const half = windowMs / 1000
    const fetches = spikesToShow.map(async (sp) => {
      const key = `${sp.sweep}:${sp.peakT}`
      const t0 = Math.max(0, sp.peakT - half)
      const t1 = sp.peakT + half
      const qs = new URLSearchParams({
        group: String(group), series: String(series), trace: String(trace),
        sweep: String(sp.sweep),
        t_start: String(t0), t_end: String(t1),
        max_points: '0',
      })
      if (zeroOffset) qs.set('zero_offset', 'true')
      if (filter) {
        qs.set('filter_type', filter.type)
        qs.set('filter_low', String(filter.low))
        qs.set('filter_high', String(filter.high))
        qs.set('filter_order', String(filter.order))
      }
      try {
        const r = await fetch(`${backendUrl}/api/traces/data?${qs}`)
        if (!r.ok) return [key, null] as const
        const d = await r.json()
        return [key, { time: d.time ?? [], values: d.values ?? [] }] as const
      } catch {
        return [key, null] as const
      }
    })
    Promise.all(fetches).then((entries) => {
      if (cancelled) return
      const next: Record<string, { time: number[]; values: number[] } | null> = {}
      for (const [k, v] of entries) next[k] = v
      setSlices(next)
    })
    return () => { cancelled = true }
  }, [backendUrl, group, series, trace, spikesToShow, windowMs, zeroOffset, filter])

  const drawMarkerOverlay = (u: uPlot) => {
    if (hideMarkers) {
      const c = overlayRef.current
      if (c) {
        const ctx = c.getContext('2d')
        const dpr = devicePixelRatio || 1
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, c.clientWidth, c.clientHeight)
        }
      }
      return
    }
    const c = overlayRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const dpr = devicePixelRatio || 1
    const cssW = c.clientWidth, cssH = c.clientHeight
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr; c.height = cssH * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    // Standard marker colours per quantity (peak / threshold / FWHM /
    // fAHP / mAHP) — same scheme on every viewer so users learn the
    // legend once. The trace LINES are colour-cycled per spike; only
    // the marker dots use these semantic colours.
    const outlineColor = cssVar('--marker-outline')
    const peakColor = cssVar(AP_MARKER.peak)
    const thresholdColor = cssVar(AP_MARKER.threshold)
    const fwhmColor = cssVar(AP_MARKER.fwhm)
    const fahpColor = cssVar(AP_MARKER.fahp)
    const mahpColor = cssVar(AP_MARKER.mahp)
    spikesToShow.forEach((sp) => {
      // Per-spike slice. ``slice.time`` is in ABSOLUTE seconds (what
      // the backend returned), while the overlay plot's x-axis is
      // relative-to-peak (``longest = sl.time - sp.peakT`` above), so
      // dot calls pass ``xRel``. Convert back via ``sp.peakT + xRel``
      // to look up the slice's y at that absolute time. (Earlier
      // attempts sampled at ``xRel`` directly — that pulled values
      // from the start of the slice and put markers way off the
      // trace.) Falls back to the stored marker y if sampling
      // can't find a value (out-of-range / unloaded slice).
      const slice = slicesRef.current[`${sp.sweep}:${sp.peakT}`]
      const sliceY = (xRel: number, fallbackY: number) => {
        if (!slice || slice.time.length < 2) return fallbackY
        const s = sampleTraceYAt(slice.time, slice.values, sp.peakT + xRel)
        return s != null ? s : fallbackY
      }
      const dotAt = (xRel: number, y: number, colour: string) => {
        const px = u.valToPos(xRel, 'x', true) / dpr
        const py = u.valToPos(y, 'y', true) / dpr
        if (!isFinite(px) || !isFinite(py)) return
        ctx.beginPath()
        ctx.arc(px, py, 4, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.fill()
        ctx.strokeStyle = outlineColor; ctx.lineWidth = 1
        ctx.stroke()
      }
      // x is time-relative-to-peak (s).
      dotAt(0, sliceY(0, sp.peakVm), peakColor)                 // peak
      if (sp.thresholdT !== 0 || sp.thresholdVm !== 0) {
        const xR = sp.thresholdT - sp.peakT
        dotAt(xR, sliceY(xR, sp.thresholdVm), thresholdColor)   // threshold
      }
      if (sp.fahpT != null && sp.fahpVm != null) {
        const xR = sp.fahpT - sp.peakT
        dotAt(xR, sliceY(xR, sp.fahpVm), fahpColor)             // fAHP
      }
      if (sp.mahpT != null && sp.mahpVm != null) {
        const xR = sp.mahpT - sp.peakT
        dotAt(xR, sliceY(xR, sp.mahpVm), mahpColor)             // mAHP
      }
      // FWHM crossings — walk the per-spike slice to find the two
      // times the trace actually crosses half-amplitude. Derive
      // halfV from sampled values so it stays in the same frame as
      // ``slice.values`` (display space when zero-offset is on,
      // raw otherwise) — going through ``sp.thresholdVm`` /
      // ``sp.peakVm`` directly would put halfV in raw space and
      // misplace the crossing dots whenever zero-offset is on.
      if (sp.halfWidthS != null && sp.amplitudeMv > 0) {
        const slice = slicesRef.current[`${sp.sweep}:${sp.peakT}`]
        if (slice && slice.time.length > 1) {
          const peakYFrame = sampleTraceYAt(slice.time, slice.values, sp.peakT) ?? sp.peakVm
          const thrYFrame = sampleTraceYAt(slice.time, slice.values, sp.thresholdT) ?? sp.thresholdVm
          const halfV = thrYFrame + (peakYFrame - thrYFrame) / 2
          // Bound the search to threshold → peak (rising) and
          // peak → peak+halfWidth+slop (falling), in absolute time.
          const tLo = sp.thresholdT
          const tHi = sp.peakT + sp.halfWidthS + 0.005
          const findCross = (t0: number, t1: number, ascending: boolean): number | null => {
            let prevT = -Infinity, prevV = NaN
            for (let i = 0; i < slice.time.length; i++) {
              const t = slice.time[i]
              if (t < t0) { prevT = t; prevV = slice.values[i]; continue }
              if (t > t1) break
              const v = slice.values[i]
              if (isFinite(prevV)) {
                const above = v >= halfV
                const wasAbove = prevV >= halfV
                if (ascending && !wasAbove && above) {
                  const frac = (halfV - prevV) / (v - prevV)
                  return prevT + frac * (t - prevT)
                }
                if (!ascending && wasAbove && !above) {
                  const frac = (halfV - prevV) / (v - prevV)
                  return prevT + frac * (t - prevT)
                }
              }
              prevT = t; prevV = v
            }
            return null
          }
          const tLeft = findCross(tLo, sp.peakT, true)
          const tRight = findCross(sp.peakT, tHi, false)
          if (tLeft != null && tRight != null) {
            // Rel-to-peak x for the overlay's time-aligned axis.
            dotAt(tLeft - sp.peakT, halfV, fwhmColor)
            dotAt(tRight - sp.peakT, halfV, fwhmColor)
          }
        }
      }
    })
  }

  // (Re)build the plot whenever the slices map changes. Each spike
  // is its own series with its own colour. X axis = time relative
  // to peak (s) → −window ... +window.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (spikesToShow.length === 0) return
    const ready = spikesToShow.every((sp) => slices[`${sp.sweep}:${sp.peakT}`])
    if (!ready) return

    // Build per-spike (xRel, y) arrays. Each spike's time vector is
    // shifted so peak lands at x=0.
    const longest = spikesToShow.reduce((acc, sp) => {
      const sl = slices[`${sp.sweep}:${sp.peakT}`]
      return sl && sl.time.length > acc.length ? sl.time.map((t) => t - sp.peakT) : acc
    }, [] as number[])
    if (longest.length === 0) return

    const seriesY = spikesToShow.map((sp) => {
      const sl = slices[`${sp.sweep}:${sp.peakT}`]
      if (!sl) return new Array(longest.length).fill(null)
      // Map onto the longest x grid by linear interpolation using
      // sample-index proportionality (cheap and good enough for
      // visual overlay; spikes have similar sample counts).
      const out: (number | null)[] = new Array(longest.length).fill(null)
      const stride = sl.time.length / longest.length
      for (let i = 0; i < longest.length; i++) {
        const j = Math.min(sl.values.length - 1, Math.floor(i * stride))
        out[i] = sl.values[j]
      }
      return out
    })

    // Range — union extent + tiny pad so all overlaid spikes fit.
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity
    for (let i = 0; i < longest.length; i++) {
      if (longest[i] < xmin) xmin = longest[i]
      if (longest[i] > xmax) xmax = longest[i]
    }
    for (const ys of seriesY) {
      for (const y of ys) {
        if (y == null) continue
        if (y < ymin) ymin = y; if (y > ymax) ymax = y
      }
    }
    const xpad = (xmax - xmin) * 0.02 || 1
    const ypad = (ymax - ymin) * 0.05 || 1
    const xRange: [number, number] = [xmin - xpad, xmax + xpad]
    const yRange: [number, number] = [ymin - ypad, ymax + ypad]

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(180, el.clientHeight || 280),
      legend: { show: false },
      scales: {
        x: { time: false, range: () => xRange },
        y: { range: () => yRange },
      },
      axes: [
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          label: 'Time relative to peak (s)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}` },
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          label: 'Vm (mV)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}` },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        ...spikesToShow.map((_, i) => ({
          stroke: OVERLAY_PALETTE[i % OVERLAY_PALETTE.length],
          width: 1.25,
          points: { show: false },
        })),
      ],
      hooks: { draw: [(u) => drawMarkerOverlay(u)] },
    }
    const payload: uPlot.AlignedData = [longest, ...seriesY] as any
    plotRef.current = new uPlot(opts, payload, el)
    drawMarkerOverlay(plotRef.current)

    // Wheel-zoom + drag-pan, same UX as the sweep viewer. Without
    // this the overlay viewer felt cramped — users couldn't zoom
    // into a specific region of the AP loop.
    const u = plotRef.current
    const over = el.querySelector<HTMLDivElement>('.u-over')
    if (!over) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      if (ev.altKey) {
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (yMin == null || yMax == null) return
        const yAtCur = u.posToVal(pxY, 'y')
        u.setScale('y', {
          min: yAtCur - (yAtCur - yMin) * factor,
          max: yAtCur + (yMax - yAtCur) * factor,
        })
      } else {
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        if (xMin == null || xMax == null) return
        const xAtCur = u.posToVal(pxX, 'x')
        u.setScale('x', {
          min: xAtCur - (xAtCur - xMin) * factor,
          max: xAtCur + (xMax - xAtCur) * factor,
        })
      }
    }
    let drag: null | {
      startPxX: number; startPxY: number
      xMin: number; xMax: number; yMin: number; yMax: number
    } = null
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return
      const rect = over.getBoundingClientRect()
      const xMin = u.scales.x.min, xMax = u.scales.x.max
      const yMin = u.scales.y.min, yMax = u.scales.y.max
      if (xMin == null || xMax == null || yMin == null || yMax == null) return
      drag = {
        startPxX: ev.clientX - rect.left,
        startPxY: ev.clientY - rect.top,
        xMin, xMax, yMin, yMax,
      }
      over.setPointerCapture(ev.pointerId)
      over.style.cursor = 'grabbing'
    }
    const onMove = (ev: PointerEvent) => {
      if (!drag) return
      const rect = over.getBoundingClientRect()
      const dxPx = (ev.clientX - rect.left) - drag.startPxX
      const dyPx = (ev.clientY - rect.top) - drag.startPxY
      const bboxW = u.bbox.width / (devicePixelRatio || 1)
      const bboxH = u.bbox.height / (devicePixelRatio || 1)
      const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
      const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
      u.setScale('x', { min: drag.xMin + dx, max: drag.xMax + dx })
      u.setScale('y', { min: drag.yMin + dy, max: drag.yMax + dy })
    }
    const onUp = (ev: PointerEvent) => {
      if (!drag) return
      drag = null
      try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      over.style.cursor = ''
    }
    over.addEventListener('wheel', onWheel, { passive: false })
    over.addEventListener('pointerdown', onDown)
    over.addEventListener('pointermove', onMove)
    over.addEventListener('pointerup', onUp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slices, spikesToShow, hideMarkers, themeKey])

  useEffect(() => { plotRef.current?.redraw() }, [hideMarkers])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    const onWin = () => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  useEffect(() => {
    if (visibilitySignal == null && heightSignal == null) return
    const raf = requestAnimationFrame(() => {
      const u = plotRef.current
      const el = containerRef.current
      if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
        u.redraw()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visibilitySignal, heightSignal])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-primary)',
    }}>
      <div className="viewer-header" style={{
        gap: 8, fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
        borderRadius: 'var(--radius) var(--radius) 0 0',
      }}>
        {(() => {
          // Prev/next spike navigation — affects this viewer AND
          // the phase plot (both read from entry.selectedSpikeIdx).
          // Lives here since this viewer is the primary one.
          const total = entry?.perSpike.length ?? 0
          const active = entry?.selectedSpikeIdx ?? 0
          return (
            <>
              <button className="btn btn-sm"
                onClick={() => onSelectSpike(Math.max(0, active - 1))}
                disabled={total === 0 || active <= 0}
                title="Previous spike (also drives the phase plot)">← Prev</button>
              <span>
                Spike <span className="num">{total > 0 ? active + 1 : '—'} / {total || '—'}</span>
              </span>
              <button className="btn btn-sm"
                onClick={() => onSelectSpike(Math.min(total - 1, active + 1))}
                disabled={total === 0 || active >= total - 1}
                title="Next spike (also drives the phase plot)">Next →</button>
              <span style={{ color: 'var(--text-muted)' }}>·</span>
            </>
          )
        })()}
        <span><span className="num">{spikesToShow.length}</span> shown</span>
        <span style={{ color: 'var(--text-muted)' }}>· Window ±</span>
        <NumInput value={windowMs} step={1} min={1}
          onChange={(v) => setWindowMs(Math.max(1, v))} style={{ width: 56 }} />
        <span style={{ color: 'var(--text-muted)' }}>ms</span>
        {!hideMarkers && (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <APMarkerLegend />
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={onSelectAll}>
            Select all
          </button>
          <button className="btn btn-sm" onClick={onClearSelection}
            disabled={selectedSpikeIndices.size === 0}>
            Clear
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}
            title="Hide threshold / peak / fAHP / mAHP marker dots — useful when overlaying many spikes.">
            <input type="checkbox" checked={hideMarkers}
              onChange={(e) => onHideMarkersChange(e.target.checked)} />
            Hide markers
          </label>
        </span>
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{ flex: 1, position: 'relative', minHeight: 0 }}
      >
        {menu}
        <canvas ref={overlayRef}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, width: '100%', height: '100%' }} />
      </div>
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
        borderRadius: '0 0 var(--radius) var(--radius)',
      }}>
        Scroll = zoom X · ⌥ scroll = zoom Y · drag = pan
      </div>
    </div>
  )
}

/** Tiny inline legend for the AP detection marker colours. Used in
 *  both the Counting-tab sweep viewer and the Kinetics-tab overlay
 *  viewer so the color → quantity mapping is consistent and
 *  discoverable without a separate help popup. */
function APMarkerLegend() {
  const items: { color: string; label: string }[] = [
    { color: `var(${AP_MARKER.peak})`, label: 'Peak' },
    { color: `var(${AP_MARKER.threshold})`, label: 'Threshold' },
    { color: `var(${AP_MARKER.fwhm})`, label: 'FWHM' },
    { color: `var(${AP_MARKER.fahp})`, label: 'fAHP' },
    { color: `var(${AP_MARKER.mahp})`, label: 'mAHP' },
  ]
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: it.color, border: '1px solid var(--marker-outline)',
          }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>{it.label}</span>
        </span>
      ))}
    </span>
  )
}
