import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  CursorPositions,
  FPspData,
  FPspPoint,
  FPspMeasurementMethod,
  FPspPeakDirection,
  FPspTimeAxis,
} from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { ChannelsOverlaySelect, STIMULUS_OVERLAY_KEY } from '../common/ChannelsOverlaySelect'
import { OverlayTraceViewer, OverlayChannel } from '../common/OverlayTraceViewer'
import { usePlotMenu } from '../common/PlotMenu'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'

// FPsp cursor→band mapping: baseline cursor pair → Baseline,
// fit cursor pair → Volley, peak cursor pair → fEPSP.
const FPSP_BASELINE_COLOR = '#9e9e9e'
const FPSP_VOLLEY_COLOR = '#64b5f6'
const FPSP_FEPSP_COLOR = '#e57373'

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

const MARKER = {
  baseline: '#9e9e9e',
  volley: '#64b5f6',
  fepsp: '#e57373',
  slopeLo: '#ffb74d',
  slopeHi: '#ffb74d',
}

export function FPspWindow({
  backendUrl,
  fileInfo,
  mainGroup,
  mainSeries,
  mainTrace,
  cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const {
    fpspCurves,
    runFPsp,
    clearFPsp,
    selectFPspPoint,
    setFPspTimeAxis,
    setFPspNormalize,
    exportFPspCSV,
    setCursors: _mainSetCursors,  // for Auto-place via BroadcastChannel
    loading,
    error,
    setError,
  } = useAppStore()
  void _mainSetCursors

  const [group, setGroup] = useState(mainGroup ?? 0)

  // Analysis mode (tab). Three flavours of fPSP analysis share the
  // window: stimulus-intensity I-O curves, paired-pulse ratios, and
  // LTP time course (the original single mode). Tab order mirrors the
  // typical experimental order (characterise with I-O → measure PPR →
  // induce LTP). Only LTP is wired up at this point; I-O and PPR show
  // placeholders until their subcomponents are built.
  type FPspMode = 'io' | 'ppr' | 'ltp'
  const [mode, setMode] = useState<FPspMode>('ltp')

  // Per-mode series selection. Each tab remembers its own series so
  // the user can analyse different series under different tabs (e.g.
  // LTP on series 1, I-O on series 2) without the selector jumping
  // around on every tab switch. `series` below resolves to the active
  // mode's slot; `setSeries` writes to it.
  const [seriesByMode, setSeriesByMode] = useState<Record<FPspMode, number>>({
    ltp: mainSeries ?? 0,
    io: mainSeries ?? 0,
    ppr: mainSeries ?? 0,
  })
  const series = seriesByMode[mode]
  // Track which modes the user has manually changed series for. We
  // use this below to avoid clobbering a manual pick when the
  // persisted-entry auto-seed effect arrives via state-update (which
  // can land a few ms after first mount in analysis windows).
  const manuallyChangedSeriesRef = useRef<Record<FPspMode, boolean>>({
    ltp: false, io: false, ppr: false,
  })
  const setSeries = useCallback((v: number) => {
    manuallyChangedSeriesRef.current[mode] = true
    setSeriesByMode((p) => ({ ...p, [mode]: v }))
  }, [mode])
  const [seriesB, setSeriesB] = useState<number | null>(null)  // LTP-only secondary
  const [channel, setChannel] = useState(mainTrace ?? 0)

  // Visibility signals bumped whenever a (previously hidden) results
  // panel becomes the active tab. The panel components watch these
  // and resize+redraw their uPlot instances on change — needed
  // because display-toggling around a plot leaves it in whatever
  // 0-dim state the ResizeObserver happened to setSize it to while
  // hidden. Without this, flipping tabs made the plot come back
  // blank until a data change forced a full rebuild.
  const [ltpVisibilitySignal, setLtpVisibilitySignal] = useState(0)
  const [ioVisibilitySignal, setIoVisibilitySignal] = useState(0)
  const [pprVisibilitySignal, setPprVisibilitySignal] = useState(0)
  useEffect(() => {
    if (mode === 'ltp') setLtpVisibilitySignal((s) => s + 1)
    if (mode === 'io') setIoVisibilitySignal((s) => s + 1)
    if (mode === 'ppr') setPprVisibilitySignal((s) => s + 1)
  }, [mode])

  // I-O tab parameters. Rehydrated from the entry if one exists. The
  // intensity axis is always a pure frontend construct — no backend
  // changes — computed as `initial + sweepIndex * step` per point.
  // Unit is fixed to µA for v1 (per brainstorm); expose as a dropdown
  // later if people ask for V or %.
  const [ioInitialIntensity, setIoInitialIntensity] = useState<number>(0)
  const [ioIntensityStep, setIoIntensityStep] = useState<number>(100)
  const [ioMetric, setIoMetric] = useState<'slope' | 'amplitude'>('slope')
  const ioUnit = 'µA'

  // PPR tab parameters. V2/F2 cursor windows are local to this window
  // for v1 (not pushed to the main viewer's cursor state), so the
  // global CursorPositions shape stays unchanged. ISI is stored as
  // a convenience for the "place V2/F2 from ISI" helper. Initial
  // defaults are 50 ms apart from V1/F1 — a harmless placeholder
  // until the user drags or uses the helper.
  const [volley2Start, setVolley2Start] = useState<number>(0.051)
  const [volley2End, setVolley2End] = useState<number>(0.052)
  const [fepsp2Start, setFepsp2Start] = useState<number>(0.052)
  const [fepsp2End, setFepsp2End] = useState<number>(0.055)
  const [pprIsiMs, setPprIsiMs] = useState<number>(50)
  const [pprMetric, setPprMetric] = useState<'amp' | 'slope'>('amp')
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    // Seed every tab with the main viewer's current series — otherwise
    // a freshly-opened FPsp window would stick each tab on series 0
    // regardless of where the user was browsing.
    if (mainSeries != null) {
      setSeriesByMode({ ltp: mainSeries, io: mainSeries, ppr: mainSeries })
    }
    if (mainTrace != null) setChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])

  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    const count = ser?.length ?? 0
    // Clamp every tab's stored series, not just the active one —
    // otherwise an inactive tab could hold a stale out-of-range
    // index that would glitch when the user finally switches to it.
    setSeriesByMode((prev) => {
      const next = { ...prev }
      let changed = false
      for (const k of Object.keys(next) as FPspMode[]) {
        if (next[k] >= count) { next[k] = 0; changed = true }
      }
      return changed ? next : prev
    })
  }, [fileInfo, group])

  // Auto-seed each tab's series from persisted analyses once
  // `fpspCurves` has arrived via state-update. A window reopened on
  // a recording with prior runs should show those runs' series
  // without the user having to navigate back manually. Skips any mode
  // where the user has already manually picked a series, and runs at
  // most once per mode (guarded by `autoSeededRef`). Ignores the main
  // viewer's current series — if there's a saved analysis, that
  // takes priority over where the user happens to be in the main
  // viewer at the moment.
  const autoSeededRef = useRef<Record<FPspMode, boolean>>({
    ltp: false, io: false, ppr: false,
  })
  useEffect(() => {
    if (!fileInfo) return
    const prefix = `${group}:`
    setSeriesByMode((prev) => {
      const next = { ...prev }
      let changed = false
      for (const m of ['ltp', 'io', 'ppr'] as FPspMode[]) {
        if (autoSeededRef.current[m]) continue
        if (manuallyChangedSeriesRef.current[m]) continue
        // Pick the highest-index series with a saved entry for this
        // mode in the current group. Higher index ≈ most recent run
        // in typical recordings; lacking timestamps, it's the closest
        // heuristic to "last analysed".
        let best: number | null = null
        for (const key of Object.keys(fpspCurves)) {
          if (!key.startsWith(prefix) || !key.endsWith(`:${m}`)) continue
          const parts = key.split(':')
          if (parts.length !== 3) continue
          const s = Number(parts[1])
          if (!isFinite(s)) continue
          if (best == null || s > best) best = s
        }
        if (best != null && best !== prev[m]) {
          autoSeededRef.current[m] = true
          next[m] = best
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [fileInfo, group, fpspCurves])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])

  // Overlay channels — extra traces to display as stacked subplots
  // beneath the primary viewer (usually the stimulus protocol so the
  // user can verify that stim artifacts land inside the expected
  // cursor windows). Analysis never runs on overlay channels; they
  // are visual context only. Same pattern as AP/IV.
  const [overlayChannels, setOverlayChannels] = useState<number[]>([])
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
  const [primaryXRange, setPrimaryXRange] = useState<[number, number] | null>(null)

  // Params local to the window — not persisted until Run commits them.
  const [method, setMethod] = useState<FPspMeasurementMethod>('range_slope')
  const [slopeLow, setSlopeLow] = useState(20)
  const [slopeHigh, setSlopeHigh] = useState(80)
  const [peakDir, setPeakDir] = useState<FPspPeakDirection>('auto')
  const [avgN, setAvgN] = useState(1)
  // Pre-detection filter, same shape as bursts. Default off.
  const [filterEnabled, setFilterEnabled] = useState(false)
  const [filterType, setFilterType] = useState<'lowpass' | 'highpass' | 'bandpass'>('lowpass')
  const [filterLow, setFilterLow] = useState(1)
  // Lowpass 2 kHz, order 1: higher orders (or lower cutoffs) ring the
  // volley flank and artificially inflate its amplitude — the volley is
  // a fast deflection (~0.5 ms rise), so keep the filter gentle.
  const [filterHigh, setFilterHigh] = useState(2000)
  const [filterOrder, setFilterOrder] = useState(1)

  // Run-mode controls (mirror the FieldBurstWindow pattern).
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

  // ---- Sweep mini-viewer: which series + which sweep to show -------------
  const [viewerSource, setViewerSource] = useState<'A' | 'B'>('A')
  const viewerSeries = viewerSource === 'A' ? series : (seriesB ?? series)
  const viewerSeriesInfo = fileInfo?.groups?.[group]?.series?.[viewerSeries]
  const viewerSweepCount: number = viewerSeriesInfo?.sweepCount ?? 0
  const [previewSweep, setPreviewSweep] = useState(0)
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, viewerSweepCount - 1)))
  }, [viewerSource, viewerSeries, viewerSweepCount])

  const [sweepTraceTime, setSweepTraceTime] = useState<number[] | null>(null)
  const [sweepTraceValues, setSweepTraceValues] = useState<number[] | null>(null)
  const [sweepTraceUnits, setSweepTraceUnits] = useState<string>('')
  /** DC offset the backend subtracted when `zero_offset=true`. Needed
   *  to shift the detection marker dots by the same amount so they
   *  stay aligned with the displayed trace — raw measurements come
   *  from the unshifted signal, the display is shifted. */
  const [sweepZeroOffsetApplied, setSweepZeroOffsetApplied] = useState<number>(0)
  // Per-window zero-offset toggle — applied to the preview fetch only;
  // the run-time analysis already does its own baseline subtraction.
  const [zeroOffset, setZeroOffset] = useState(false)
  useEffect(() => {
    if (!backendUrl || viewerSweepCount === 0) {
      setSweepTraceTime(null); setSweepTraceValues(null); return
    }
    let cancelled = false
    const qs = new URLSearchParams({
      group: String(group), series: String(viewerSeries),
      sweep: String(previewSweep), trace: String(channel),
      max_points: '0',
    })
    if (zeroOffset) qs.set('zero_offset', 'true')
    // When the pre-detection filter is on, show the FILTERED trace in
    // the sweep mini-viewer so the user can see exactly what the
    // detector operates on. Unchecked = raw trace as usual.
    if (filterEnabled) {
      qs.set('filter_type', filterType)
      qs.set('filter_low', String(filterLow))
      qs.set('filter_high', String(filterHigh))
      qs.set('filter_order', String(filterOrder))
    }
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((d) => {
        if (cancelled) return
        setSweepTraceTime(d.time ?? [])
        setSweepTraceValues(d.values ?? [])
        setSweepTraceUnits(d.units ?? '')
        setSweepZeroOffsetApplied(Number(d.zero_offset ?? 0))
      })
      .catch(() => { if (!cancelled) { setSweepTraceTime(null); setSweepTraceValues(null) } })
    return () => { cancelled = true }
  }, [
    backendUrl, group, viewerSeries, channel, previewSweep,
    viewerSweepCount, zeroOffset,
    filterEnabled, filterType, filterLow, filterHigh, filterOrder,
  ])

  // Exclusion badge for the preview sweep (affects run-on-all, but
  // single-sweep preview runs are still allowed).
  const isPreviewExcluded = useAppStore((s) =>
    s.isSweepExcluded(group, viewerSeries, previewSweep))

  // Push a cursor change (from viewer drag) into the store + broadcast.
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    useAppStore.getState().setCursors(next)
    try {
      const ch = new BroadcastChannel('tracer-sync')
      const merged = { ...useAppStore.getState().cursors, ...next }
      ch.postMessage({ type: 'cursor-update', cursors: merged })
      ch.close()
    } catch { /* ignore */ }
  }, [])

  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // Splitters. Both persist to Electron prefs under fpspWindowUI so
  // the layout survives window reopens — same recipe APWindow uses.
  // We hydrate on mount and write only on mouseup (one write per drag,
  // not per pixel) to avoid hammering the prefs store.
  const [topHeight, setTopHeight] = useState(300)
  const [leftPanelWidth, setLeftPanelWidth] = useState(320)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const ui = prefs?.fpspWindowUI
        if (cancelled || !ui) return
        if (typeof ui.leftPanelWidth === 'number'
            && ui.leftPanelWidth >= 200 && ui.leftPanelWidth <= 500) {
          setLeftPanelWidth(ui.leftPanelWidth)
        }
        if (typeof ui.topHeight === 'number'
            && ui.topHeight >= 150 && ui.topHeight <= 800) {
          setTopHeight(ui.topHeight)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  const writeUIPref = useCallback(async (patch: Record<string, any>) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.fpspWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, fpspWindowUI: next })
    } catch { /* ignore */ }
  }, [])
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
      writeUIPref({ topHeight: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
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
      writeUIPref({ leftPanelWidth: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Mode-scoped lookup: I-O / PPR / LTP results for the same series
  // live in separate slots so switching tabs swaps the data cleanly.
  // `entry` is the CURRENT-mode entry (drives rehydration + summary).
  // `ltpEntry` / `ioEntry` are read separately because the results
  // panels for both modes stay mounted with display-toggle — without
  // that, switching tabs unmounted the LTP over-time plot, and on
  // return it tried to size itself while still display:none and came
  // back blank until the user jiggled `normalize` or `index`.
  const key = `${group}:${series}:${mode}`
  const entry = fpspCurves[key]
  // Each mode's entry must use THAT mode's own stored series, not the
  // currently-resolved `series` (which flips with the active tab).
  // Otherwise the hidden tab's panel briefly looks at the wrong
  // series's slot (typically empty), destroys its plot, and the plot
  // can't come back until data changes on return.
  const ltpEntry = fpspCurves[`${group}:${seriesByMode.ltp}:ltp`]
  const ioEntry = fpspCurves[`${group}:${seriesByMode.io}:io`]
  const pprEntry = fpspCurves[`${group}:${seriesByMode.ppr}:ppr`]

  // Rehydrate the form from the persisted entry whenever we "land on" a
  // (group, series) pair that has results stored — either because the
  // user opened the window fresh and state-sync delivered fpspCurves
  // from disk, or because they switched selector to a pair that was
  // previously analysed. Without this, closing and reopening the window
  // leaves the form showing defaults even though the plot+table below
  // show the persisted run.
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entry) return
    if (rehydratedKeyRef.current === key) return
    rehydratedKeyRef.current = key
    setSeriesB(entry.seriesB)
    setChannel(entry.channel)
    setMethod(entry.measurementMethod)
    setSlopeLow(entry.slopeLowPct)
    setSlopeHigh(entry.slopeHighPct)
    setPeakDir(entry.peakDirection)
    setAvgN(entry.avgN)
    setFilterEnabled(entry.filterEnabled)
    setFilterType(entry.filterType)
    setFilterLow(entry.filterLow)
    setFilterHigh(entry.filterHigh)
    setFilterOrder(entry.filterOrder)
    if (entry.mode === 'io') {
      if (entry.ioInitialIntensity != null) setIoInitialIntensity(entry.ioInitialIntensity)
      if (entry.ioIntensityStep != null) setIoIntensityStep(entry.ioIntensityStep)
      if (entry.ioMetric) setIoMetric(entry.ioMetric)
    }
    if (entry.mode === 'ppr') {
      if (entry.volley2StartS != null) setVolley2Start(entry.volley2StartS)
      if (entry.volley2EndS != null) setVolley2End(entry.volley2EndS)
      if (entry.fepsp2StartS != null) setFepsp2Start(entry.fepsp2StartS)
      if (entry.fepsp2EndS != null) setFepsp2End(entry.fepsp2EndS)
      if (entry.pprIsiMs != null) setPprIsiMs(entry.pprIsiMs)
      if (entry.pprMetric) setPprMetric(entry.pprMetric)
    }
    // Run-scope fields (optional on older saves).
    if (entry.runMode) setRunMode(entry.runMode)
    if (entry.sweepFrom != null) setSweepFrom(entry.sweepFrom)
    if (entry.sweepTo != null) setSweepTo(entry.sweepTo)
    if (entry.sweepOne != null) setSweepOne(entry.sweepOne)
  }, [entry, key])

  /** Auto-place cursors: detect stim onset from the backend, then place
   *  baseline / volley / fEPSP windows at sensible defaults around it.
   *  Writes cursors through the main store's setCursors so the main viewer
   *  updates instantly, AND broadcasts a cursor-update so the main window
   *  picks them up regardless of which window we're running in. */
  const onAutoPlace = async () => {
    if (!backendUrl || !fileInfo) return
    try {
      // Do a tiny, no-op run just to read stim_onset_s back. Using a trivial
      // set of windows so it returns fast, without side effects to data.
      const qs = new URLSearchParams({
        group: String(group), series: String(series), trace: String(channel),
        baseline_start_s: '0', baseline_end_s: '0.001',
        volley_start_s: '0.001', volley_end_s: '0.002',
        fepsp_start_s: '0.002', fepsp_end_s: '0.003',
        method: 'amplitude', slope_low_pct: '20', slope_high_pct: '80',
        peak_direction: 'auto', avg_n: '1',
        sweeps: '0',
      })
      const resp = await fetch(`${backendUrl}/api/fpsp/run?${qs}`)
      if (!resp.ok) return
      const data = await resp.json()
      const t0 = Number(data.stim_onset_s ?? 0)
      // Defaults (e.g. for a 1 ms stim pulse starting at t0):
      //   Baseline: [0, t0 − 0.5 ms]
      //   Volley:  [t0 + 1 ms, t0 + 2 ms]    (1 ms wide, right after stim pulse)
      //   fEPSP:   [t0 + 2 ms, t0 + 5 ms]    (3 ms wide, starts at end of volley)
      // Map to main cursor pairs:
      //   baseline cursor pair → baseline window
      //   fit cursor pair      → volley window
      //   peak cursor pair     → fEPSP window
      const newCursors: Partial<CursorPositions> = {
        baselineStart: 0,
        baselineEnd: Math.max(0, t0 - 0.0005),
        fitStart: t0 + 0.001,
        fitEnd: t0 + 0.002,
        peakStart: t0 + 0.002,
        peakEnd: t0 + 0.005,
      }
      // Push to this window's store (so the read-out row updates).
      useAppStore.getState().setCursors(newCursors)
      // Broadcast so the MAIN window's cursor state updates too — its
      // viewer can only adopt via the tracer-sync channel.
      try {
        const ch = new BroadcastChannel('tracer-sync')
        const merged = { ...useAppStore.getState().cursors, ...newCursors }
        ch.postMessage({ type: 'cursor-update', cursors: merged })
        ch.close()
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  const onRun = async () => {
    let sweepIndices: number[] | null = null
    let appendToExisting = false
    const store = useAppStore.getState()
    if (runMode === 'all') {
      // Send an explicit list of non-excluded sweeps when any are
      // excluded; otherwise null lets the backend default to "all".
      const included = store.includedSweepsFor(group, series, totalSweeps)
      if (included.length !== totalSweeps) sweepIndices = included
    } else if (runMode === 'range') {
      const lo = Math.max(1, Math.min(sweepFrom, totalSweeps))
      const hi = Math.max(lo, Math.min(sweepTo, totalSweeps))
      const range: number[] = []
      for (let i = lo - 1; i <= hi - 1; i++) range.push(i)
      sweepIndices = store.filterExcludedSweeps(group, series, range)
    } else if (runMode === 'one') {
      const sw = Math.max(1, Math.min(sweepOne, totalSweeps))
      sweepIndices = [sw - 1]
      appendToExisting = true
    }
    runFPsp(group, series, channel, {
      mode,
      seriesB: mode === 'ltp' ? seriesB : null,  // B-series is LTP-only
      baselineStartS: cursors.baselineStart,
      baselineEndS: cursors.baselineEnd,
      volleyStartS: cursors.fitStart,
      volleyEndS: cursors.fitEnd,
      fepspStartS: cursors.peakStart,
      fepspEndS: cursors.peakEnd,
      method,
      slopeLowPct: slopeLow,
      slopeHighPct: slopeHigh,
      peakDirection: peakDir,
      // I-O always forces avgN=1 — averaging would conflate adjacent
      // intensity steps, defeating the point of the curve. PPR and
      // LTP honour the user's avgN; for PPR > 1 the right-side
      // bin-waveform viewer takes over showing the averaged trace
      // with detection dots (the LEFT sweep viewer's per-sweep dots
      // are gated on sweepIndices.length === 1, so they only show
      // when avgN == 1).
      avgN: mode === 'io' ? 1 : avgN,
      sweepIndices,
      appendToExisting,
      // I-O-specific metadata (echoed into the entry). Undefined for
      // other modes so the entry doesn't carry stale fields.
      ioInitialIntensity: mode === 'io' ? ioInitialIntensity : undefined,
      ioIntensityStep: mode === 'io' ? ioIntensityStep : undefined,
      ioUnit: mode === 'io' ? ioUnit : undefined,
      ioMetric: mode === 'io' ? ioMetric : undefined,
      // PPR: 2nd-response windows + ISI + scatter-metric toggle.
      // The store fires two parallel /api/fpsp/run calls (V1/F1 and
      // V2/F2) and merges the points with pprAmp / pprSlope ratios.
      volley2StartS: mode === 'ppr' ? volley2Start : undefined,
      volley2EndS: mode === 'ppr' ? volley2End : undefined,
      fepsp2StartS: mode === 'ppr' ? fepsp2Start : undefined,
      fepsp2EndS: mode === 'ppr' ? fepsp2End : undefined,
      pprIsiMs: mode === 'ppr' ? pprIsiMs : undefined,
      pprMetric: mode === 'ppr' ? pprMetric : undefined,
      filterEnabled,
      filterType,
      filterLow,
      filterHigh,
      filterOrder,
    })
    // Stamp run-scope form state onto the entry so the sidecar
    // persists it and the form rehydrates on reopen.
    useAppStore.setState((s) => {
      const e = s.fpspCurves[`${group}:${series}`]
      if (!e) return s
      return {
        fpspCurves: {
          ...s.fpspCurves,
          [`${group}:${series}`]: { ...e, runMode, sweepFrom, sweepTo, sweepOne },
        },
      }
    })
  }

  const onSelectPoint = (idx: number) => {
    selectFPspPoint(mode, group, series, idx)
    // Broadcast the first sweep of this bin so the main viewer jumps to it.
    const p = entry?.points[idx]
    if (p && p.sweepIndices.length > 0) {
      // Also pan the LOCAL sweep viewer to that sweep so the
      // detection markers show up on the displayed trace (without
      // this, clicking a row would only move the main viewer and
      // leave the analysis-window's mini-viewer on the previous sweep).
      setPreviewSweep(p.sweepIndices[0])
      try {
        const ch = new BroadcastChannel('tracer-sync')
        ch.postMessage({ type: 'sweep-update', sweep: p.sweepIndices[0] })
        ch.close()
      } catch { /* ignore */ }
    }
  }

  // The point whose markers should be drawn on the sweep viewer:
  // the currently-selected point, if it represents exactly this one
  // sweep (so its measurements actually correspond to the trace the
  // user is looking at). Multi-sweep bins (LTP avgN>1) are excluded —
  // their measurements come from the averaged trace, not any
  // individual sweep, so overlaying them on one sweep would mislead.
  const markerPoint = useMemo(() => {
    if (!entry || entry.selectedIdx == null) return null
    const p = entry.points[entry.selectedIdx]
    if (!p) return null
    if (p.sweepIndices.length !== 1) return null
    if (p.sweepIndices[0] !== previewSweep) return null
    return p
  }, [entry, previewSweep])

  const flaggedCount = entry ? entry.points.filter((p) => p.flagged).length : 0

  // One editable start→end row for a cursor window. Typed values commit
  // on blur/Enter (NumInput) and flow through the same setters as the
  // viewer's drag handles, so typing and dragging stay in sync. Not a
  // nested component — a plain JSX-returning helper, so the NumInputs
  // keep their identity (and focus) across re-renders.
  const cursorTimeRow = (
    label: string,
    color: string,
    start: number,
    end: number,
    onStart: (v: number) => void,
    onEnd: (v: number) => void,
  ) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
      <span style={{ color, fontWeight: 600, width: 56, flexShrink: 0 }}>{label}</span>
      <NumInput value={start} min={0} decimals={4} onChange={onStart} style={{ width: 72 }} />
      <span style={{ color: 'var(--text-muted)' }}>→</span>
      <NumInput value={end} min={0} decimals={4} onChange={onEnd} style={{ width: 72 }} />
      <span style={{ color: 'var(--text-muted)' }}>s</span>
    </div>
  )

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: 10,
      gap: 10,
      minHeight: 0,
    }}>
      {/* Selectors — thin top row, always visible. Wrapped in the
          bg-secondary "chrome" tone so the window's top row + left
          panel read as one cohesive region, matching the main
          window's tree sidebar. */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
        background: 'var(--bg-secondary)',
        padding: '6px 10px',
        borderRadius: 4,
        border: '1px solid var(--border)',
      }}>
        <Field label="Group">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Primary series">
          <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        {/* Secondary series only makes sense in LTP mode (to hold the
            post-tetanus series for time-course concatenation). I-O and
            PPR run on a single series, so we hide the selector there
            rather than having a "doesn't do anything here" field. */}
        {mode === 'ltp' && (
          <Field label="Secondary (post-tetanus, optional)">
            <select
              value={seriesB ?? ''}
              onChange={(e) => setSeriesB(e.target.value === '' ? null : Number(e.target.value))}
              disabled={!fileInfo}
            >
              <option value="">— none —</option>
              {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
                i !== series ? (
                  <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
                ) : null
              ))}
            </select>
          </Field>
        )}
        <ChannelsOverlaySelect
          channels={channels.map((c: any) => ({ index: c.index, label: c.label, units: c.units }))}
          primary={channel}
          onPrimaryChange={(i) => setChannel(i)}
          overlay={overlayChannels}
          onOverlayChange={setOverlayChannels}
          hasStimulus={hasStimulus}
        />

        {/* Sweep navigator + A/B source toggle. Sits at the top of
            every analysis window for consistency. */}
        <Field label="Sweep (preview)">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            {seriesB != null && (
              <span style={{ display: 'inline-flex', gap: 2, marginRight: 4 }}>
                <button
                  className={`btn${viewerSource === 'A' ? ' btn-primary' : ''}`}
                  style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
                  title="Show a sweep from the baseline series"
                  onClick={() => setViewerSource('A')}
                >BL</button>
                <button
                  className={`btn${viewerSource === 'B' ? ' btn-primary' : ''}`}
                  style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
                  title="Show a sweep from the LTP / post-tetanus series"
                  onClick={() => setViewerSource('B')}
                >LTP</button>
              </span>
            )}
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setPreviewSweep((s) => Math.max(0, s - 1))}
              disabled={previewSweep <= 0 || viewerSweepCount === 0}
              title="Previous sweep">←</button>
            <span style={{ minWidth: 58, textAlign: 'center', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
              {viewerSweepCount > 0 ? `${previewSweep + 1} / ${viewerSweepCount}` : '— / —'}
            </span>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setPreviewSweep((s) => Math.min(viewerSweepCount - 1, s + 1))}
              disabled={previewSweep >= viewerSweepCount - 1 || viewerSweepCount === 0}
              title="Next sweep">→</button>
          </span>
        </Field>
      </div>

      {/* Tab bar — I-O · PPR · LTP. Spans the full window width above
          the two-column body so the choice visibly scopes both the
          LEFT params column and the RIGHT results panel. Same
          prominent style as APWindow (3px underline, 14px font) for
          cross-window consistency. */}
      <div style={{
        display: 'flex', gap: 2, borderBottom: '1px solid var(--border)',
        alignItems: 'flex-end', flexShrink: 0,
      }}>
        {(['io', 'ppr', 'ltp'] as FPspMode[]).map((m) => {
          const label = m === 'io' ? 'I-O curve'
            : m === 'ppr' ? 'Paired-pulse ratio'
            : 'LTP time course'
          const active = mode === m
          return (
            <button
              key={m}
              className="btn"
              onClick={() => setMode(m)}
              style={{
                padding: '8px 22px',
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
                borderBottom: active ? '3px solid var(--accent, #4a90e2)' : '3px solid transparent',
                marginBottom: -1,
                background: active ? 'var(--bg-primary)' : 'transparent',
                color: active ? 'var(--accent, #4a90e2)' : 'var(--text-muted)',
                fontWeight: active ? 700 : 500,
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-ui)',
              }}
              title={
                m === 'io' ? 'Stimulus intensity vs fEPSP slope/amplitude'
                : m === 'ppr' ? 'Paired-pulse ratio (amp/slope of response 2 ÷ response 1)'
                : 'LTP time course — slope/amplitude over time, normalised to baseline'
              }
            >{label}</button>
          )
        })}
      </div>

      {/* Main body: two-column flex. LEFT = params column (scrollable
          with Run controls pinned to its bottom); RIGHT = summary +
          viewers + results. Same layout as APWindow for cross-window
          consistency. */}
      <div style={{
        flex: 1, display: 'flex', minHeight: 0, gap: 0,
      }}>
        {/* LEFT PANEL */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)',
          padding: 8,
          borderRadius: 4,
          border: '1px solid var(--border)',
        }}>
          {/* Scrollable param sections. Run controls + error banner
              sit outside this scrollable so they're always visible. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,
          }}>
            {/* Cursor readout + Auto-place */}
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              padding: 8,
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg-primary)',
              fontSize: 'var(--font-size-label)',
              fontFamily: 'var(--font-mono)',
            }}>
              {cursorTimeRow(
                'Baseline', MARKER.baseline,
                cursors.baselineStart, cursors.baselineEnd,
                (v) => updateCursors({ baselineStart: v }),
                (v) => updateCursors({ baselineEnd: v }),
              )}
              {cursorTimeRow(
                mode === 'ppr' ? 'V1' : 'Volley', MARKER.volley,
                cursors.fitStart, cursors.fitEnd,
                (v) => updateCursors({ fitStart: v }),
                (v) => updateCursors({ fitEnd: v }),
              )}
              {cursorTimeRow(
                mode === 'ppr' ? 'F1' : 'fEPSP', MARKER.fepsp,
                cursors.peakStart, cursors.peakEnd,
                (v) => updateCursors({ peakStart: v }),
                (v) => updateCursors({ peakEnd: v }),
              )}
              {mode === 'ppr' && (
                <>
                  {cursorTimeRow(
                    'V2', MARKER.volley,
                    volley2Start, volley2End,
                    setVolley2Start, setVolley2End,
                  )}
                  {cursorTimeRow(
                    'F2', MARKER.fepsp,
                    fepsp2Start, fepsp2End,
                    setFepsp2Start, setFepsp2End,
                  )}
                </>
              )}
              <button
                className="btn"
                onClick={onAutoPlace}
                disabled={!backendUrl || !fileInfo}
                style={{ width: '100%', marginTop: 4 }}
                title="Detect stim onset from the stimulus protocol and place baseline / volley / fEPSP cursors at sensible defaults"
              >
                Auto-place cursors
              </button>
            </div>

            {/* Pre-detection filter (optional) */}
            <div style={{
              display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
              padding: 8, border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--bg-primary)',
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)', width: '100%' }}>
                <input type="checkbox" checked={filterEnabled}
                  onChange={(e) => setFilterEnabled(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Pre-detection filter</span>
              </label>
              {filterEnabled && (
                <>
                  <select value={filterType}
                    onChange={(e) => setFilterType(e.target.value as 'lowpass' | 'highpass' | 'bandpass')}
                    style={{ fontSize: 'var(--font-size-label)', width: '100%' }}>
                    <option value="lowpass">Lowpass</option>
                    <option value="highpass">Highpass</option>
                    <option value="bandpass">Bandpass</option>
                  </select>
                  {(filterType === 'highpass' || filterType === 'bandpass') && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>low</span>
                      <NumInput value={filterLow} step={0.1} min={0}
                        onChange={setFilterLow} style={{ width: 64 }} />
                      <span style={{ color: 'var(--text-muted)' }}>Hz</span>
                    </label>
                  )}
                  {(filterType === 'lowpass' || filterType === 'bandpass') && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>high</span>
                      <NumInput value={filterHigh} step={10} min={1}
                        onChange={setFilterHigh} style={{ width: 70 }} />
                      <span style={{ color: 'var(--text-muted)' }}>Hz</span>
                    </label>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>order</span>
                    <NumInput value={filterOrder} step={1} min={1} max={8}
                      onChange={(v) => setFilterOrder(Math.max(1, Math.min(8, Math.round(v))))}
                      style={{ width: 42 }} />
                  </label>
                </>
              )}
              {!filterEnabled && (
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)', fontStyle: 'italic' }}>
                  off — try 2 kHz lowpass order 1 to clean HF noise
                </span>
              )}
            </div>

            {/* Params */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 8,
              padding: 8,
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg-primary)',
            }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label="Measurement">
                  <select value={method} onChange={(e) => setMethod(e.target.value as FPspMeasurementMethod)} style={{ width: '100%' }}>
                    <option value="amplitude">Amplitude (peak)</option>
                    <option value="full_slope">Slope (10%→peak)</option>
                    <option value="range_slope">Slope (low%→high%)</option>
                  </select>
                </Field>
              </div>
              {method === 'range_slope' && (
                <>
                  <ParamRow label="Low %" value={slopeLow} step={5} min={0} max={100}
                    onChange={(v) => setSlopeLow(Math.max(0, Math.min(100, v)))} />
                  <ParamRow label="High %" value={slopeHigh} step={5} min={0} max={100}
                    onChange={(v) => setSlopeHigh(Math.max(0, Math.min(100, v)))} />
                </>
              )}
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label="Peak direction">
                  <select value={peakDir} onChange={(e) => setPeakDir(e.target.value as FPspPeakDirection)} style={{ width: '100%' }}>
                    <option value="auto">Auto (|max dev|)</option>
                    <option value="negative">Negative</option>
                    <option value="positive">Positive</option>
                  </select>
                </Field>
              </div>
              {(mode === 'ltp' || mode === 'ppr') && (
                <ParamRow label="Average N sweeps" value={avgN} step={1} min={1}
                  onChange={(v) => setAvgN(Math.max(1, Math.round(v)))} />
              )}
              {/* I-O specific: stimulus intensity ramp. Each sweep gets
                  `initial + sweepIndex * step` assigned to the x-axis of
                  the scatter plot below. Excluded sweeps are skipped on run
                  but do not shift intensity — the sweep index is preserved. */}
              {mode === 'io' && (
                <>
                  <ParamRow label={`Initial (${ioUnit})`}
                    value={ioInitialIntensity} step={10} min={0}
                    onChange={setIoInitialIntensity} />
                  <ParamRow label={`Step (${ioUnit})`}
                    value={ioIntensityStep} step={10} min={0}
                    onChange={setIoIntensityStep} />
                </>
              )}
              {/* PPR specific: ISI input + "Place V2/F2 from ISI" helper.
                  Copies V1/F1 offsets forward by ISI ms so the user doesn't
                  have to drag both pairs manually on every sweep. */}
              {mode === 'ppr' && (
                <>
                  <ParamRow label="ISI (ms)"
                    value={pprIsiMs} step={5} min={1}
                    onChange={setPprIsiMs} />
                  <div style={{ gridColumn: '1 / -1' }}>
                    <button
                      className="btn"
                      onClick={() => {
                        const dt = pprIsiMs / 1000
                        setVolley2Start(cursors.fitStart + dt)
                        setVolley2End(cursors.fitEnd + dt)
                        setFepsp2Start(cursors.peakStart + dt)
                        setFepsp2End(cursors.peakEnd + dt)
                      }}
                      title="Place the 2nd-response volley + fEPSP cursors at the V1/F1 positions shifted forward by ISI milliseconds."
                      style={{ width: '100%' }}
                    >
                      Place V2/F2 from ISI
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Pinned footer: Run button (primary) + sweeps-scope
              dropdown with progressive disclosure, then secondary
              Clear / Export CSV below a separator. Same pattern as
              APWindow — radios-on-one-row got cramped in the narrow
              left column. */}
          <div style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <button className="btn btn-primary" onClick={onRun}
              disabled={loading || !fileInfo}
              style={{
                width: '100%', padding: '8px 0',
                fontSize: 'var(--font-size-sm)', fontWeight: 600,
              }}>
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
                <span>from</span>
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
                <span>sweep</span>
                <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span style={{ marginLeft: 'auto' }}>/ {totalSweeps || '—'} · appends</span>
              </div>
            )}
            {/* Secondary actions — smaller, visually subordinate. */}
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn"
                onClick={() => clearFPsp(mode, group, series)} disabled={!entry}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={() => exportFPspCSV()}
                disabled={Object.keys(fpspCurves).length === 0}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Export CSV
              </button>
            </div>
          </div>
          {error && (
            <div style={{
              flexShrink: 0,
              padding: '6px 10px',
              background: 'var(--bg-error, #5c1b1b)',
              color: '#fff', borderRadius: 3,
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 'var(--font-size-xs)',
            }}>
              <span style={{ flex: 1 }}>⚠ {error}</span>
              <button className="btn" onClick={() => setError(null)}
                style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}>dismiss</button>
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

        {/* RIGHT PANEL: viewer + horizontal splitter + results. Same
            flat structure as APWindow (no gap, no conditional siblings
            in the column) so flex sizing propagates cleanly to the
            plot containers — the earlier structure with three
            conditional summary strips at the top interfered with
            flex-height propagation, making the result plots snap to a
            minimum size. The mode-specific summary strips now live
            directly above each plot, inside the results panel (as
            `plotHeader`), where they belong. */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>
          {/* Viewers: top = sweep + optional mini, bottom = results. */}
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
          }}>
            <div style={{
              height: topHeight, minHeight: 180,
              display: 'flex', gap: 6, flexShrink: 0,
            }}>
              {/* LEFT: sweep navigator with draggable bands, plus
                  optional stacked overlay subplots beneath for extra
                  channels or the stimulus protocol. Overlay viewers
                  are display-only and X-sync from the sweep viewer. */}
              <div style={{
                flex: 1, minWidth: 0,
                display: 'flex', flexDirection: 'column', minHeight: 0,
              }}>
                <div style={{
                  flex: overlayChannels.length > 0 ? 5 : 1,
                  minHeight: 0,
                }}>
                  <FPspSweepViewer
                    traceTime={sweepTraceTime}
                    traceValues={sweepTraceValues}
                    traceUnits={sweepTraceUnits}
                    cursors={cursors}
                    updateCursors={updateCursors}
                    previewSweep={previewSweep}
                    totalSweeps={viewerSweepCount}
                    source={viewerSource}
                    isExcluded={isPreviewExcluded}
                    theme={theme}
                    fontSize={fontSize}
                    zeroOffset={zeroOffset}
                    onZeroOffsetChange={setZeroOffset}
                    zeroOffsetApplied={sweepZeroOffsetApplied}
                    markerPoint={markerPoint}
                    markerEntry={entry}
                    pprBands={mode === 'ppr' ? {
                      volleyStart: volley2Start,
                      volleyEnd: volley2End,
                      fepspStart: fepsp2Start,
                      fepspEnd: fepsp2End,
                    } : null}
                    onXRangeChange={(xMin, xMax) => setPrimaryXRange([xMin, xMax])}
                  />
                </div>
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
              {/* RIGHT: selected-bin averaged waveform (LTP/PPR only;
                  I-O hidden via display-toggle so the uPlot instance
                  survives mode round-trips). */}
              <div style={{
                flex: 1, minWidth: 0,
                display: (mode === 'ltp' || mode === 'ppr') ? 'block' : 'none',
              }}>
                <FPspMiniViewer
                  backendUrl={backendUrl}
                  entry={mode === 'ppr' ? pprEntry : ltpEntry}
                  group={group} series={series} channel={channel}
                  heightSignal={topHeight}
                />
              </div>
            </div>

            {/* Horizontal splitter between viewer and results. Thin
                (3px hit / 2px grip) to match APWindow. */}
            <div
              onMouseDown={onSplitMouseDown}
              style={{
                height: 3, cursor: 'row-resize', background: 'var(--border)',
                flexShrink: 0, position: 'relative',
              }}
              title="Drag to resize"
            >
              <div style={{
                position: 'absolute', left: '50%', top: 0,
                transform: 'translateX(-50%)',
                width: 40, height: 2, background: 'var(--text-muted)',
                borderRadius: 1, opacity: 0.5,
              }} />
            </div>

            {/* Bottom: mode-specific results. All three stay mounted
                (display-toggle) so internal uPlot / sub-tab / zoom
                state survives mode switches. The plot controls
                (normalize / time / y-metric) live in a compact header
                rendered inside each panel directly above its plot —
                passed in as `plotHeader` so the controls are visually
                adjacent to what they affect. */}
            <div style={{
              display: mode === 'ltp' ? 'flex' : 'none',
              flexDirection: 'column',
              flex: 1, minHeight: 0,
            }}>
              <FPspResultsTabs
                entry={ltpEntry}
                onSelectPoint={onSelectPoint}
                visibilitySignal={ltpVisibilitySignal}
                plotHeader={ltpEntry && (
                  <div style={{
                    flexShrink: 0,
                    fontSize: 'var(--font-size-label)',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-primary)',
                    padding: '4px 8px',
                    borderRadius: 3,
                    border: '1px solid var(--border)',
                    display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                  }}>
                    <span>
                      <strong style={{ color: 'var(--text-primary)' }}>{ltpEntry.points.length}</strong> bins ·
                      avg N {ltpEntry.avgN} · unit {ltpEntry.responseUnit || '—'}
                    </span>
                    {flaggedCount > 0 && (
                      <span style={{ color: '#e57373' }}>
                        ⚠ {flaggedCount} ratio {'<'} 3
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-ui)' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <input type="radio" checked={ltpEntry.timeAxis === 'timestamp'}
                          onChange={() => setFPspTimeAxis('ltp', group, series, 'timestamp')} />
                        time
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <input type="radio" checked={ltpEntry.timeAxis === 'index'}
                          onChange={() => setFPspTimeAxis('ltp', group, series, 'index')} />
                        index
                      </label>
                      <span style={{ color: 'var(--border)' }}>|</span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <input type="checkbox" checked={ltpEntry.normalize}
                          onChange={(e) => setFPspNormalize('ltp', group, series, e.target.checked)} />
                        normalize
                      </label>
                    </span>
                  </div>
                )}
              />
            </div>
            <div style={{
              display: mode === 'io' ? 'flex' : 'none',
              flex: 1, minHeight: 0,
            }}>
              <IOResultsPanel
                entry={ioEntry}
                metric={ioMetric}
                onSelectPoint={onSelectPoint}
                theme={theme}
                fontSize={fontSize}
                visibilitySignal={ioVisibilitySignal}
                plotHeader={ioEntry && (
                  <div style={{
                    flexShrink: 0,
                    fontSize: 'var(--font-size-label)',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-primary)',
                    padding: '4px 8px',
                    borderRadius: 3,
                    border: '1px solid var(--border)',
                    display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                  }}>
                    <span>
                      <strong style={{ color: 'var(--text-primary)' }}>{ioEntry.points.length}</strong> sweeps ·
                      {(ioEntry.ioInitialIntensity ?? 0).toFixed(0)}–
                      {((ioEntry.ioInitialIntensity ?? 0)
                        + Math.max(0, ioEntry.points.length - 1) * (ioEntry.ioIntensityStep ?? 0)
                      ).toFixed(0)} {ioEntry.ioUnit ?? 'µA'}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-ui)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>y-axis:</span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <input type="radio" checked={ioMetric === 'slope'}
                          onChange={() => setIoMetric('slope')} />
                        slope
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <input type="radio" checked={ioMetric === 'amplitude'}
                          onChange={() => setIoMetric('amplitude')} />
                        amplitude
                      </label>
                    </span>
                  </div>
                )}
              />
            </div>
            <div style={{
              display: mode === 'ppr' ? 'flex' : 'none',
              flex: 1, minHeight: 0,
            }}>
              <PPRResultsPanel
                entry={pprEntry}
                metric={pprMetric}
                onSelectPoint={onSelectPoint}
                visibilitySignal={pprVisibilitySignal}
                plotHeader={pprEntry && (() => {
                  const amps: number[] = []
                  const slopes: number[] = []
                  for (const p of pprEntry.points) {
                    if (p.pprAmp != null && isFinite(p.pprAmp)) amps.push(p.pprAmp)
                    if (p.pprSlope != null && isFinite(p.pprSlope)) slopes.push(p.pprSlope)
                  }
                  const meanAmp = amps.length ? amps.reduce((a, b) => a + b, 0) / amps.length : null
                  const meanSlope = slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : null
                  return (
                    <div style={{
                      flexShrink: 0,
                      fontSize: 'var(--font-size-label)',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      background: 'var(--bg-primary)',
                      padding: '4px 8px',
                      borderRadius: 3,
                      border: '1px solid var(--border)',
                      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                    }}>
                      <span>
                        <strong style={{ color: 'var(--text-primary)' }}>{pprEntry.points.length}</strong> sweeps ·
                        ISI {(pprEntry.pprIsiMs ?? 0).toFixed(1)} ms ·
                        amp {meanAmp != null ? meanAmp.toFixed(2) : '—'} · slope {meanSlope != null ? meanSlope.toFixed(2) : '—'}
                      </span>
                      <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-ui)' }}>
                        <span style={{ color: 'var(--text-muted)' }}>y:</span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <input type="radio" checked={pprMetric === 'amp'}
                            onChange={() => setPprMetric('amp')} />
                          amp
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <input type="radio" checked={pprMetric === 'slope'}
                            onChange={() => setPprMetric('slope')} />
                          slope
                        </label>
                      </span>
                    </div>
                  )
                })()}
              />
            </div>
          </div>
        </div>{/* close RIGHT panel */}
      </div>{/* close two-column body */}
    </div>
  )
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

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
  label: string; value: number; step: number; min?: number; max?: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange} />
    </label>
  )
}

// ----------------------------------------------------------------------
// Mini-viewer: zoomed waveform of the selected bin, with markers.
// ----------------------------------------------------------------------

function FPspMiniViewer({
  backendUrl, entry, group, series, channel, heightSignal,
}: {
  backendUrl: string
  entry: FPspData | undefined
  group: number; series: number; channel: number
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'fpsp-trace',
  })
  // Default tuned range (recomputed on each plot rebuild) and the
  // user's current zoom/pan range. Range callbacks prefer the user
  // ranges when set; reset clears them. Refs (not state) so wheel /
  // pan don't trigger React re-renders — uPlot redraws on setScale.
  const tunedXRangeRef = useRef<[number, number] | null>(null)
  const tunedYRangeRef = useRef<[number, number] | null>(null)
  const userXRangeRef = useRef<[number, number] | null>(null)
  const userYRangeRef = useRef<[number, number] | null>(null)
  // Bumping this on Reset zoom forces a re-render so the button can
  // also clear via setScale (refs alone don't trigger redraw cycles).
  const [, forceRedraw] = useState(0)

  const selected: FPspPoint | null =
    entry && entry.selectedIdx != null && entry.selectedIdx < entry.points.length
      ? entry.points[entry.selectedIdx]
      : null

  const [data, setData] = useState<{ time: Float64Array; values: Float64Array } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Furthest-right cursor edge in the entry — F1's end for LTP/I-O,
  // F2's end for PPR. Used to size both the fetch window and the
  // x-axis range so the viewer always shows the full event(s).
  const fEnd = entry
    ? (entry.mode === 'ppr' && entry.fepsp2EndS != null
        ? Math.max(entry.fepspEndS, entry.fepsp2EndS)
        : entry.fepspEndS)
    : 0

  // Fetch the AVERAGED waveform for the bin's sweeps via the new
  // /api/fpsp/bin_waveform endpoint. The mini-viewer then shows exactly
  // the signal the baseline/volley/fEPSP/slope measurements were
  // computed on. Note: uses the point's sourceSeries (baseline or LTP).
  useEffect(() => {
    if (!selected || !backendUrl || !entry) { setData(null); return }
    // X window: from 0 to 2 × the furthest fEPSP end (F1 for LTP/I-O,
    // F2 for PPR), so the event(s) sit in the left half with an equal
    // chunk of tail after them.
    const tStart = 0
    const tEnd = Math.max(fEnd * 2, fEnd + 0.005)
    const qs = new URLSearchParams({
      group: String(group),
      series: String(selected.sourceSeries),
      trace: String(channel),
      sweeps: selected.sweepIndices.join(','),
      t_start: String(tStart),
      t_end: String(tEnd),
      max_points: '4000',
    })
    // Replay the same pre-detection filter used by the run so the mini-
    // viewer shows what the measurements were computed on.
    if (entry.filterEnabled) {
      qs.set('filter_enabled', 'true')
      qs.set('filter_type', entry.filterType)
      qs.set('filter_low', String(entry.filterLow))
      qs.set('filter_high', String(entry.filterHigh))
      qs.set('filter_order', String(entry.filterOrder))
    }
    let cancelled = false
    fetch(`${backendUrl}/api/fpsp/bin_waveform?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        setData({
          time: new Float64Array(d.time ?? []),
          values: new Float64Array(d.values ?? []),
        })
        setErr(null)
      })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [selected, backendUrl, group, channel, entry])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || data.time.length === 0 || !selected) return

    // Y-axis tuned range: the stim artifact dominates auto-scaling and
    // buries the actual volley/fEPSP deflections. Center y on the bin
    // baseline + size to 1.5× the largest measured deflection (R2
    // included for PPR) so we zoom straight onto the event(s)
    // regardless of artifact size. Total range = 3× max amplitude.
    const sel = selected
    const maxAmp = Math.max(
      Math.abs(sel.volleyAmp),
      Math.abs(sel.fepspAmp),
      Math.abs(sel.volleyAmp2 ?? 0),
      Math.abs(sel.fepspAmp2 ?? 0),
    )
    const tunedY: [number, number] | null = (maxAmp > 0)
      ? [sel.baseline - 1.5 * maxAmp, sel.baseline + 1.5 * maxAmp]
      : null
    // X tuned range: 0 → 2 × furthest fEPSP end-cursor.
    const tunedX: [number, number] = [
      0,
      Math.max(fEnd * 2, fEnd + 0.005),
    ]
    tunedXRangeRef.current = tunedX
    tunedYRangeRef.current = tunedY
    // Don't carry user zoom across data rebuilds — different bins
    // have different deflection magnitudes, so a stale zoom from bin
    // 5 may leave bin 6 entirely off-screen. Reset on rebuild.
    userXRangeRef.current = null
    userYRangeRef.current = null

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 180),
      scales: {
        // Range callbacks return the user range when present (wheel /
        // pan), otherwise the tuned range. Identical pattern to the
        // sweep viewer's locked-zoom — keeps `data` rebuilds from
        // wiping the user's inspection state within a bin.
        x: {
          time: false,
          range: () => userXRangeRef.current ?? tunedXRangeRef.current ?? tunedX,
        },
        y: {
          range: () => userYRangeRef.current
            ?? tunedYRangeRef.current
            ?? (tunedY as [number, number])
            ?? [0, 1],
        },
      },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        { stroke: cssVar('--trace-color-1'), width: 1.25 },
      ],
      hooks: {
        draw: [() => drawMiniOverlay(plotRef.current, overlayRef.current, entry, selected)],
      },
    }
    const payload: uPlot.AlignedData = [Array.from(data.time), Array.from(data.values)]
    plotRef.current = new uPlot(opts, payload, el)
    drawMiniOverlay(plotRef.current, overlayRef.current, entry, selected)

    // ---- Wheel zoom (X by default, Y with ⌥) + drag-to-pan ----
    // Mirrors the sweep viewer so the UX feels identical: scroll to
    // zoom around the cursor, ⌥-scroll to zoom Y, click-and-drag to
    // pan both axes. Touch-ups go directly through uPlot.setScale
    // (which redraws), and the user range refs are updated so the
    // next rebuild keeps the user view (until they click Reset).
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
        const newMin = yAtCur - (yAtCur - yMin) * factor
        const newMax = yAtCur + (yMax - yAtCur) * factor
        userYRangeRef.current = [newMin, newMax]
        u.setScale('y', { min: newMin, max: newMax })
      } else {
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        if (xMin == null || xMax == null) return
        const xAtCur = u.posToVal(pxX, 'x')
        const newMin = xAtCur - (xAtCur - xMin) * factor
        const newMax = xAtCur + (xMax - xAtCur) * factor
        userXRangeRef.current = [newMin, newMax]
        u.setScale('x', { min: newMin, max: newMax })
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
      const nx: [number, number] = [drag.xMin + dx, drag.xMax + dx]
      const ny: [number, number] = [drag.yMin + dy, drag.yMax + dy]
      userXRangeRef.current = nx
      userYRangeRef.current = ny
      u.setScale('x', { min: nx[0], max: nx[1] })
      u.setScale('y', { min: ny[0], max: ny[1] })
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
    // Cleanup happens automatically on next destroy (next rebuild).
  }, [data, entry, selected])

  // Reset-zoom helper used by the header button. Clears the user
  // range refs and re-applies the tuned range via setScale so we
  // don't have to rebuild the plot.
  const resetZoom = () => {
    const u = plotRef.current
    userXRangeRef.current = null
    userYRangeRef.current = null
    if (!u) { forceRedraw((n) => n + 1); return }
    if (tunedXRangeRef.current) {
      u.setScale('x', { min: tunedXRangeRef.current[0], max: tunedXRangeRef.current[1] })
    }
    if (tunedYRangeRef.current) {
      u.setScale('y', { min: tunedYRangeRef.current[0], max: tunedYRangeRef.current[1] })
    }
  }

  // Resize handling.
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
      if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    window.addEventListener('resize', onWin)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
    }
  }, [selected != null])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)', position: 'relative',
    }}>
      {!selected ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', color: 'var(--text-muted)', fontStyle: 'italic',
          fontSize: 'var(--font-size-label)',
        }}>
          Select a bin in the table to preview it here.
        </div>
      ) : (
        <>
          <div style={{
            padding: '3px 8px', fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
            borderBottom: '1px solid var(--border)',
            display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
          }}>
            <span>bin #{(entry?.selectedIdx ?? 0) + 1}</span>
            <span>sweeps {selected.sweepIndices.map((s) => s + 1).join(',')}</span>
            <span>volley {selected.volleyAmp.toFixed(3)}</span>
            <span>fEPSP {selected.fepspAmp.toFixed(3)}</span>
            {selected.ratio != null && (
              <span style={{ color: selected.flagged ? '#e57373' : undefined }}>
                ratio {selected.ratio.toFixed(2)}
                {selected.flagged && ' ⚠'}
              </span>
            )}
            {selected.slope != null && <span>slope {selected.slope.toFixed(3)}</span>}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                className="btn"
                onClick={resetZoom}
                style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
                title="Restore the tuned default view (centred on baseline, scaled to event amplitudes)"
              >
                Reset zoom
              </button>
              <span style={{ width: 1, height: 14, background: 'var(--border)' }} />
              <LegendDot color={MARKER.baseline} label="baseline" />
              <LegendDot color={MARKER.volley} label="volley" />
              <LegendDot color={MARKER.fepsp} label="fEPSP" />
              {entry?.measurementMethod !== 'amplitude' && (
                <LegendDot color={MARKER.slopeLo} label="slope %" />
              )}
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
          }}>
            scroll = zoom X · ⌥ scroll = zoom Y · drag = pan
          </div>
          {err && (
            <div style={{ position: 'absolute', top: 30, left: 10, color: '#f44336', fontSize: 'var(--font-size-label)' }}>
              fetch: {err}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color, border: '1px solid rgba(255,255,255,0.6)',
      }} />
      {label}
    </span>
  )
}

function drawMiniOverlay(
  u: uPlot | null,
  canvas: HTMLCanvasElement | null,
  entry: FPspData | undefined,
  selected: FPspPoint | null,
) {
  if (!u || !canvas || !selected || !entry) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = devicePixelRatio || 1
  const cssW = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr; canvas.height = cssH * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const toPx = (x: number, y: number): [number, number] => [
    u.valToPos(x, 'x', true) / dpr,
    u.valToPos(y, 'y', true) / dpr,
  ]

  const dot = (px: number, py: number, color: string) => {
    if (!isFinite(px) || !isFinite(py)) return
    ctx.beginPath()
    ctx.arc(px, py, 5, 0, Math.PI * 2)
    ctx.fillStyle = color; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke()
  }

  // Baseline level marker — midpoint of the baseline cursor window.
  const blTMid = (entry.baselineStartS + entry.baselineEndS) / 2
  {
    const [px, py] = toPx(blTMid, selected.baseline)
    dot(px, py, MARKER.baseline)
  }
  // Volley peak
  {
    const [px, py] = toPx(selected.volleyPeakTs, selected.volleyPeak)
    dot(px, py, MARKER.volley)
  }
  // fEPSP peak
  {
    const [px, py] = toPx(selected.fepspPeakTs, selected.fepspPeak)
    dot(px, py, MARKER.fepsp)
  }
  // Slope % crossings (two dots only, no fit line per user preference).
  if (selected.slopeLow) {
    const [px, py] = toPx(selected.slopeLow.t, selected.slopeLow.v)
    dot(px, py, MARKER.slopeLo)
  }
  if (selected.slopeHigh) {
    const [px, py] = toPx(selected.slopeHigh.t, selected.slopeHigh.v)
    dot(px, py, MARKER.slopeHi)
  }
  // PPR mode: also draw the 2nd-response markers. The bin viewer
  // shows the averaged trace, so these dots are the canonical "this
  // is what was measured" reference (the LEFT raw-sweep viewer
  // suppresses dots when avgN > 1).
  if (selected.volleyAmp2 != null && selected.volleyPeakTs2 != null) {
    const [px, py] = toPx(selected.volleyPeakTs2, selected.volleyPeak2 ?? 0)
    dot(px, py, MARKER.volley)
  }
  if (selected.fepspAmp2 != null && selected.fepspPeakTs2 != null) {
    const [px, py] = toPx(selected.fepspPeakTs2, selected.fepspPeak2 ?? 0)
    dot(px, py, MARKER.fepsp)
  }
  if (selected.slopeLow2) {
    const [px, py] = toPx(selected.slopeLow2.t, selected.slopeLow2.v)
    dot(px, py, MARKER.slopeLo)
  }
  if (selected.slopeHigh2) {
    const [px, py] = toPx(selected.slopeHigh2.t, selected.slopeHigh2.v)
    dot(px, py, MARKER.slopeHi)
  }
}

// ----------------------------------------------------------------------
// Over-time graph: fEPSP slope/amplitude vs time (or bin index).
// ----------------------------------------------------------------------

function FPspOverTimeGraph({
  entry, onSelectIdx, heightSignal,
}: {
  entry: FPspData | undefined
  onSelectIdx: (idx: number) => void
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'fpsp-over-time',
  })
  const selectedRef = useRef<number | null>(null)
  selectedRef.current = entry?.selectedIdx ?? null

  // Decide what y-value to plot per point, and how to compute the x-axis
  // (real time from the .pgf's inter-sweep interval when available; bin
  // index otherwise). Series B (LTP) points get appended to the X axis
  // after series A's last point plus a visible gap, with a vertical
  // separator drawn in the plot's draw hook below.
  const { xs, ys, splitX, metricLabel, xLabel } = useMemo(() => {
    const empty = { xs: [] as number[], ys: [] as number[], splitX: null as number | null, metricLabel: '', xLabel: '' }
    if (!entry || entry.points.length === 0) return empty

    // Split points by source series, preserving per-series ordering.
    const a = entry.points.filter((p) => p.sourceSeries === entry.seriesA)
    const b = entry.seriesB != null
      ? entry.points.filter((p) => p.sourceSeries === entry.seriesB)
      : []

    const useTime = entry.timeAxis === 'timestamp'
    // In time mode, show minutes — LTP experiments run on the 10s-of-
    // minutes scale so seconds produce awkwardly large numbers.
    const toMin = (s: number) => s / 60

    // Per-series X in minutes from the start of that series (or raw bin
    // index in index mode).
    const xA = a.map((p) => (useTime && entry.sweepIntervalA > 0
      ? toMin(p.meanSweepIndex * entry.sweepIntervalA)
      : p.binIndex + 1))
    // Offset B so it follows A on the same axis.
    const lastA = xA.length > 0 ? xA[xA.length - 1] : 0
    // Visible gap between series: in time mode, max(1 min, 2×bin-interval);
    // in index mode, a single-step gap.
    const gap = useTime
      ? Math.max(1, toMin(2 * (entry.sweepIntervalA || 15) * entry.avgN))
      : 1
    const rawSplit = b.length > 0 ? (lastA + gap / 2) : null
    const xB = b.map((p) => (useTime && entry.sweepIntervalB > 0
      ? toMin(p.meanSweepIndex * entry.sweepIntervalB) + lastA + gap
      : p.binIndex + 1 + lastA + gap))

    // Re-origin the x axis so the tetanus (splitX) is at 0 — baseline
    // points sit at negative x, LTP points at positive x. That's the
    // conventional way to display LTP time courses. Only applied when
    // there's actually a seriesB (otherwise there's no tetanus).
    let splitX: number | null = rawSplit
    if (rawSplit != null) {
      for (let i = 0; i < xA.length; i++) xA[i] -= rawSplit
      for (let i = 0; i < xB.length; i++) xB[i] -= rawSplit
      splitX = 0
    }

    const yOf = (p: FPspPoint) =>
      entry.measurementMethod === 'amplitude' ? p.fepspAmp : (p.slope ?? 0)
    const rawYs = [...a.map(yOf), ...b.map(yOf)]
    const xs = [...xA, ...xB]

    // Normalization: the denominator is the mean of the chosen metric
    // (slope or amplitude) across ALL baseline-series (series A)
    // averaged-sweep points. Each point — baseline AND LTP — is then
    // expressed as % of that common mean, so the LTP-induced change
    // reads as a deviation from the flat 100 % baseline.
    let finalYs: number[]
    if (entry.normalize) {
      const baselineYs = a.map(yOf)
      const mean = baselineYs.length > 0
        ? baselineYs.reduce((s, v) => s + v, 0) / baselineYs.length
        : 0
      finalYs = Math.abs(mean) > 1e-12
        ? rawYs.map((y) => 100 * (y / mean))
        : rawYs.slice()
    } else {
      finalYs = rawYs.slice()
    }

    const yUnit = entry.measurementMethod === 'amplitude'
      ? entry.responseUnit
      : `${entry.responseUnit || '?'}/s`
    const metricLabel = entry.measurementMethod === 'amplitude'
      ? `fEPSP amplitude${entry.normalize ? ' (% of baseline)' : ` (${yUnit})`}`
      : `fEPSP slope${entry.normalize ? ' (% of baseline)' : ` (${yUnit})`}`

    const xLabel = useTime
      ? (entry.sweepIntervalA > 0 ? 'Time (min)' : 'Sweep index (≈ time)')
      : 'Bin #'

    return { xs, ys: finalYs, splitX, metricLabel, xLabel }
    // Deliberately NOT depending on `entry` as a whole. selectedIdx changes
    // produce a new entry object but the same `points` reference — so
    // listing individual fields keeps the memo stable across selection
    // clicks, avoiding a full plot-destroy/rebuild cycle (which was
    // flashing the graph blank when the user clicked a table row).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entry?.points,
    entry?.seriesA,
    entry?.seriesB,
    entry?.timeAxis,
    entry?.sweepIntervalA,
    entry?.sweepIntervalB,
    entry?.measurementMethod,
    entry?.responseUnit,
    entry?.normalize,
    entry?.normBaselineFrom,
    entry?.normBaselineTo,
    entry?.avgN,
  ])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (xs.length === 0) return

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 180),
      scales: { x: { time: false }, y: {} },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: xLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: metricLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          stroke: cssVar('--trace-color-1'),
          width: 1.5,
          points: { size: 5, stroke: cssVar('--trace-color-1'), fill: cssVar('--bg-surface') },
        },
      ],
      hooks: {
        init: [(u) => {
          u.over.addEventListener('click', () => {
            const idx = u.cursor.idx
            if (idx != null && idx >= 0) onSelectIdx(idx as number)
          })
        }],
        draw: [
          (u) => drawSeriesSplit(u, splitX),
          (u) => drawGraphSelected(u, selectedRef.current),
        ],
      },
    }
    plotRef.current = new uPlot(opts, [xs, ys], el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xs, ys, splitX, metricLabel, xLabel])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      // Guard against 0-dim setSize: when the panel is hidden via
      // display:none (tab switched away), ResizeObserver fires with
      // width=0/height=0 and uPlot can't redraw itself out of that
      // state — the plot comes back blank until something else
      // triggers a rebuild. Skip and let the visibility-signal effect
      // below handle the recovery.
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
    // Defer via rAF: when this effect fires because the tab just became
    // visible (display: none → block), the browser hasn't yet laid out
    // the container, so clientWidth/Height would still read 0. Waiting
    // a frame lets the layout settle before we resize uPlot. We also
    // call redraw() — setSize alone isn't always enough to recover
    // after a 0-dim hide/restore round trip, because intermediate
    // ResizeObserver firings may have corrupted the plot state.
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

  useEffect(() => { plotRef.current?.redraw() }, [entry?.selectedIdx])

  if (!entry || xs.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry ? 'No points yet.' : 'Run to populate the over-time graph.'}
      </div>
    )
  }

  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', position: 'relative',
      }}
    >
      {menu}
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

function drawSeriesSplit(u: uPlot, splitX: number | null) {
  if (splitX == null) return
  const dpr = devicePixelRatio || 1
  const px = u.valToPos(splitX, 'x', true) / dpr
  if (!isFinite(px)) return
  const ctx = u.ctx
  const top = u.bbox.top / dpr
  const bottom = (u.bbox.top + u.bbox.height) / dpr
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.strokeStyle = 'rgba(229,115,115,0.6)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(px, top)
  ctx.lineTo(px, bottom)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(229,115,115,0.85)'
  ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`
  ctx.fillText('tetanus', px + 4, top + 12)
  ctx.restore()
}

function drawGraphSelected(u: uPlot, selectedIdx: number | null) {
  if (selectedIdx == null) return
  const xArr = u.data[0] as number[]
  const yArr = u.data[1] as (number | null)[]
  if (selectedIdx < 0 || selectedIdx >= xArr.length) return
  const x = xArr[selectedIdx], y = yArr[selectedIdx]
  if (y == null || !isFinite(x) || !isFinite(y)) return
  const dpr = devicePixelRatio || 1
  const px = u.valToPos(x, 'x', true) / dpr
  const py = u.valToPos(y, 'y', true) / dpr
  const ctx = u.ctx
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.beginPath()
  ctx.arc(px, py, 7, 0, Math.PI * 2)
  ctx.fillStyle = cssVar('--accent')
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.fill(); ctx.stroke()
  ctx.restore()
}

// ----------------------------------------------------------------------
// Table
// ----------------------------------------------------------------------

function FPspTable({
  entry, onSelect,
}: {
  entry: FPspData | undefined
  onSelect: (idx: number) => void
}) {
  const sel = useRowSelection(entry?.points.length ?? 0)
  const u = entry?.responseUnit || ''
  const headers = ['#', 'Series', 'Sweeps', `Baseline (${u})`,
    `Volley amp (${u})`, `fEPSP amp (${u})`, 'Ratio', 'Slope / Amp']
  const rowToCells = (i: number): Array<string | number | null> => {
    const p = entry!.points[i]
    const isLtp = entry!.seriesB != null && p.sourceSeries === entry!.seriesB
    return [
      i + 1,
      `${isLtp ? 'LTP' : 'BL'} (${p.sourceSeries + 1})`,
      p.sweepIndices.map((s) => s + 1).join(','),
      p.baseline.toFixed(3),
      p.volleyAmp.toFixed(3),
      p.fepspAmp.toFixed(3),
      p.ratio == null ? null : p.ratio.toFixed(3),
      entry!.measurementMethod === 'amplitude'
        ? p.fepspAmp.toFixed(3)
        : (p.slope == null ? null : p.slope.toFixed(3)),
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  if (!entry || entry.points.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)', borderRadius: 4,
      }}>
        {entry ? 'No bins.' : 'Run to populate the table.'}
      </div>
    )
  }

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', height: '100%',
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>#</Th>
            <Th>Series</Th>
            <Th>Sweeps</Th>
            <Th>Baseline ({u})</Th>
            <Th>Volley amp ({u})</Th>
            <Th>fEPSP amp ({u})</Th>
            <Th>Ratio</Th>
            <Th>Slope / Amp</Th>
          </tr>
        </thead>
        <tbody>
          {entry.points.map((p, i) => {
            const isLtp = entry.seriesB != null && p.sourceSeries === entry.seriesB
            const selectedBg = i === entry.selectedIdx
              ? 'var(--bg-selected, rgba(100,181,246,0.2))'
              : undefined
            const flaggedBg = p.flagged ? 'rgba(229,115,115,0.12)' : undefined
            const ltpBg = isLtp ? 'rgba(255,183,77,0.08)' : undefined
            const multiBg = sel.isSelected(i)
              ? 'var(--accent-muted, rgba(100,181,246,0.30))' : undefined
            return (
              <tr
                key={i}
                onClick={(ev) => {
                  sel.onRowClick(i, ev)
                  if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) onSelect(i)
                }}
                onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                })}
                style={{
                  background: multiBg ?? selectedBg ?? flaggedBg ?? ltpBg ?? 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{i + 1}</Td>
                <Td style={{ color: isLtp ? '#ffb74d' : 'var(--text-muted)' }}>
                  {isLtp ? 'LTP' : 'BL'} ({p.sourceSeries + 1})
                </Td>
                <Td>{p.sweepIndices.map((s) => s + 1).join(',')}</Td>
                <Td>{p.baseline.toFixed(3)}</Td>
                <Td>{p.volleyAmp.toFixed(3)}</Td>
                <Td>{p.fepspAmp.toFixed(3)}</Td>
                <Td style={p.flagged ? { color: '#e57373', fontWeight: 600 } : undefined}>
                  {p.ratio != null ? p.ratio.toFixed(2) : '—'}
                  {p.flagged && ' ⚠'}
                </Td>
                <Td>
                  {entry.measurementMethod === 'amplitude'
                    ? p.fepspAmp.toFixed(3)
                    : (p.slope != null ? p.slope.toFixed(3) : '—')}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)' }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...style }}>{children}</td>
)

// ---------------------------------------------------------------------------
// FPspSweepViewer — interactive per-sweep viewer with three draggable
// cursor bands (Baseline / Volley / fEPSP), prev/next sweep arrows, and
// an A/B series selector when seriesB is set. Locked-zoom pattern with
// wheel/pan/Reset, same as the other analysis windows.
// ---------------------------------------------------------------------------

function FPspSweepViewer({
  traceTime, traceValues, traceUnits,
  cursors, updateCursors,
  previewSweep, totalSweeps,
  source,
  isExcluded, theme, fontSize,
  zeroOffset, onZeroOffsetChange, zeroOffsetApplied,
  markerPoint, markerEntry,
  pprBands,
  onXRangeChange,
}: {
  traceTime: number[] | null
  traceValues: number[] | null
  traceUnits: string
  cursors: CursorPositions
  updateCursors: (next: Partial<CursorPositions>) => void
  previewSweep: number
  totalSweeps: number
  source: 'A' | 'B'
  isExcluded: boolean
  theme: string
  fontSize: number
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  /** DC offset (in trace units) the backend subtracted from the
   *  displayed samples when zero-offset was on. 0 when off. Used to
   *  shift detection-marker dots so they stay glued to the displayed
   *  (shifted) trace rather than floating above/below it. */
  zeroOffsetApplied?: number
  /** Detection result for the sweep currently displayed, if any —
   *  i.e. the selected row in the results table whose single sweep
   *  matches previewSweep. Drawn as dots on top of the bands so the
   *  user can see exactly what got measured. Pass null to suppress. */
  markerPoint?: FPspPoint | null
  /** Entry the marker point came from — needed for baseline-window
   *  midpoint (so the baseline dot can be placed inside the band). */
  markerEntry?: FPspData | null
  /** PPR-mode only. When set, the viewer additionally renders V2/F2
   *  cursor bands (read-only — positioned via the "Place V2/F2 from
   *  ISI" helper, not dragged inline yet). Markers for the 2nd
   *  response are also drawn when markerPoint carries pprAmp/pprSlope. */
  pprBands?: {
    volleyStart: number; volleyEnd: number
    fepspStart: number; fepspEnd: number
  } | null
  /** Fired on pan / wheel / reset / initial auto-fit so stacked
   *  overlay viewers can mirror the x range. Same pattern as AP/IV. */
  onXRangeChange?: (xMin: number, xMax: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'fpsp-sweep',
  })

  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors
  const markerPointRef = useRef<FPspPoint | null | undefined>(markerPoint)
  markerPointRef.current = markerPoint
  const markerEntryRef = useRef<FPspData | null | undefined>(markerEntry)
  markerEntryRef.current = markerEntry
  const zeroOffsetAppliedRef = useRef<number>(zeroOffsetApplied ?? 0)
  zeroOffsetAppliedRef.current = zeroOffsetApplied ?? 0
  const pprBandsRef = useRef(pprBands)
  pprBandsRef.current = pprBands

  // Stash the onXRangeChange callback in a ref so handlers wired once
  // see the latest prop value without a remount.
  const onXRangeChangeRef = useRef(onXRangeChange)
  onXRangeChangeRef.current = onXRangeChange
  const emitXRange = (xMin: number, xMax: number) => {
    try { onXRangeChangeRef.current?.(xMin, xMax) } catch { /* ignore */ }
  }

  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  const hasRealDataRef = useRef(false)

  type DragTarget =
    | { kind: 'baseline-edge'; edge: 'start' | 'end' }
    | { kind: 'baseline-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'volley-edge'; edge: 'start' | 'end' }
    | { kind: 'volley-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'fepsp-edge'; edge: 'start' | 'end' }
    | { kind: 'fepsp-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'pan'; startX: number; xMin: number; xMax: number; startY: number; yMin: number; yMax: number }
  const dragRef = useRef<DragTarget | null>(null)

  const resetZoom = () => {
    const u = plotRef.current
    if (!u) return
    xRangeRef.current = null
    yRangeRef.current = null
    const d = u.data as unknown as [number[], number[]] | undefined
    if (!d || !d[0] || d[0].length === 0) { u.redraw(); return }
    const xs = d[0], ys = d[1]
    const xmin = xs[0], xmax = xs[xs.length - 1]
    let ymin = Infinity, ymax = -Infinity
    for (const v of ys) { if (v < ymin) ymin = v; if (v > ymax) ymax = v }
    if (isFinite(xmin) && isFinite(xmax) && xmax > xmin) {
      u.setScale('x', { min: xmin, max: xmax })
      emitXRange(xmin, xmax)
    }
    if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
      const pad = (ymax - ymin) * 0.05
      u.setScale('y', { min: ymin - pad, max: ymax + pad })
    }
  }

  const resetCursorsInView = () => {
    const u = plotRef.current
    let xMin: number | null = u?.scales.x.min ?? null
    let xMax: number | null = u?.scales.x.max ?? null
    if ((xMin == null || xMax == null || xMax <= xMin) && traceTime && traceTime.length > 0) {
      xMin = traceTime[0]
      xMax = traceTime[traceTime.length - 1]
    }
    if (xMin == null || xMax == null || xMax <= xMin) return
    const span = xMax - xMin
    updateCursors({
      baselineStart: xMin + 0.05 * span,
      baselineEnd: xMin + 0.15 * span,
      fitStart: xMin + 0.25 * span,   // Volley
      fitEnd: xMin + 0.40 * span,
      peakStart: xMin + 0.45 * span,  // fEPSP
      peakEnd: xMin + 0.75 * span,
    })
  }

  const drawOverlays = (u: uPlot) => {
    const cur = cursorsRef.current
    const ctx = u.ctx
    const yTop = u.bbox.top
    const yBot = u.bbox.top + u.bbox.height
    const drawBand = (xs: number, xe: number, color: string, label: string) => {
      const px0 = u.valToPos(xs, 'x', true)
      const px1 = u.valToPos(xe, 'x', true)
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.fillStyle = color
      ctx.fillRect(Math.min(px0, px1), yTop, Math.abs(px1 - px0), yBot - yTop)
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      const dpr = devicePixelRatio || 1
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, yTop + 12 * dpr)
      ctx.restore()
    }
    const pb = pprBandsRef.current
    drawBand(cur.baselineStart, cur.baselineEnd, FPSP_BASELINE_COLOR, 'BL')
    drawBand(cur.fitStart, cur.fitEnd, FPSP_VOLLEY_COLOR, pb ? 'V1' : 'Vol')
    drawBand(cur.peakStart, cur.peakEnd, FPSP_FEPSP_COLOR, pb ? 'F1' : 'fEPSP')
    // PPR: 2nd-response bands, same colours (measurement is identical,
    // just on a different time window). Read-only in v1 — positioned
    // via the "Place V2/F2 from ISI" helper.
    if (pb) {
      drawBand(pb.volleyStart, pb.volleyEnd, FPSP_VOLLEY_COLOR, 'V2')
      drawBand(pb.fepspStart, pb.fepspEnd, FPSP_FEPSP_COLOR, 'F2')
    }

    // Detection markers for the selected-row sweep. Same dot style
    // as the LTP right-side bin viewer — single circle per quantity,
    // thin white outline so they sit cleanly on the trace. Drawn in
    // canvas pixels (not CSS pixels) so we scale by dpr inline.
    const point = markerPointRef.current
    const markEntry = markerEntryRef.current
    if (point && markEntry) {
      const dpr = devicePixelRatio || 1
      // Marker y-values come from the raw signal; the displayed trace
      // has been DC-shifted by zeroOffsetApplied when the zero-offset
      // toggle is on. Subtract the same offset to keep dots glued to
      // the visible waveform.
      const yOffset = zeroOffsetAppliedRef.current
      const toPxRaw = (x: number, y: number): [number, number] => [
        u.valToPos(x, 'x', true),
        u.valToPos(y - yOffset, 'y', true),
      ]
      const dot = (px: number, py: number, color: string) => {
        if (!isFinite(px) || !isFinite(py)) return
        ctx.save()
        ctx.beginPath()
        ctx.arc(px, py, 5 * dpr, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.2 * dpr
        ctx.stroke()
        ctx.restore()
      }
      // Baseline: dot at the middle of the baseline window at the
      // measured baseline y-value.
      {
        const tMid = (markEntry.baselineStartS + markEntry.baselineEndS) / 2
        const [px, py] = toPxRaw(tMid, point.baseline)
        dot(px, py, MARKER.baseline)
      }
      // Volley peak
      {
        const [px, py] = toPxRaw(point.volleyPeakTs, point.volleyPeak)
        dot(px, py, MARKER.volley)
      }
      // fEPSP peak
      {
        const [px, py] = toPxRaw(point.fepspPeakTs, point.fepspPeak)
        dot(px, py, MARKER.fepsp)
      }
      // Slope low/high crossings (when range_slope method was used)
      if (point.slopeLow) {
        const [px, py] = toPxRaw(point.slopeLow.t, point.slopeLow.v)
        dot(px, py, MARKER.slopeLo)
      }
      if (point.slopeHigh) {
        const [px, py] = toPxRaw(point.slopeHigh.t, point.slopeHigh.v)
        dot(px, py, MARKER.slopeHi)
      }
      // PPR mode: 2nd-response dots (V2 peak, F2 peak, slope2
      // crossings). Presence of volleyAmp2/fepspAmp2 tells us this
      // entry was measured in PPR mode.
      if (point.volleyAmp2 != null && point.volleyPeakTs2 != null) {
        const [px, py] = toPxRaw(point.volleyPeakTs2, point.volleyPeak2 ?? 0)
        dot(px, py, MARKER.volley)
      }
      if (point.fepspAmp2 != null && point.fepspPeakTs2 != null) {
        const [px, py] = toPxRaw(point.fepspPeakTs2, point.fepspPeak2 ?? 0)
        dot(px, py, MARKER.fepsp)
      }
      if (point.slopeLow2) {
        const [px, py] = toPxRaw(point.slopeLow2.t, point.slopeLow2.v)
        dot(px, py, MARKER.slopeLo)
      }
      if (point.slopeHigh2) {
        const [px, py] = toPxRaw(point.slopeHigh2.t, point.slopeHigh2.v)
        dot(px, py, MARKER.slopeHi)
      }
    }
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container || !traceTime || !traceValues) {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      return
    }
    const frameId = requestAnimationFrame(() => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 100)
      hasRealDataRef.current = true
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
              if (hasRealDataRef.current) {
                xRangeRef.current = r
                emitXRange(lo, hi)
              }
              return r
            },
          },
          y: {
            range: (_u, dataMin, dataMax) => {
              if (yRangeRef.current) return yRangeRef.current
              let r: [number, number]
              if (!isFinite(dataMin) || !isFinite(dataMax) || dataMin === dataMax) r = [0, 1]
              else { const pad = (dataMax - dataMin) * 0.05; r = [dataMin - pad, dataMax + pad] }
              if (hasRealDataRef.current) yRangeRef.current = r
              return r
            },
          },
        },
        axes: [
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}` },
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: traceUnits || '', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}` },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.25, points: { show: false } },
        ],
        hooks: { draw: [(u) => drawOverlays(u)] },
      }
      const attachTip = attachHoverCoords(opts, { unitsRef: { current: traceUnits } })
      plotRef.current = new uPlot(opts, [traceTime, traceValues], container)
      attachTip(container)

      const u = plotRef.current
      const over = container.querySelector<HTMLDivElement>('.u-over')
      const EDGE_THRESHOLD_PX = 6

      const xToPx = (x: number) => u.valToPos(x, 'x', false)
      const pxToX = (px: number) => u.posToVal(px, 'x')
      const pxToY = (py: number) => u.posToVal(py, 'y')

      const findHit = (pxX: number): DragTarget | null => {
        const cur = cursorsRef.current
        const pairs: Array<{
          start: number; end: number
          edge: (e: 'start' | 'end') => DragTarget
          band: (startPxX: number) => DragTarget
        }> = [
          {
            start: cur.baselineStart, end: cur.baselineEnd,
            edge: (e) => ({ kind: 'baseline-edge', edge: e }),
            band: (startPxX) => ({ kind: 'baseline-band', startPxX,
              startStart: cur.baselineStart, startEnd: cur.baselineEnd }),
          },
          {
            start: cur.fitStart, end: cur.fitEnd,
            edge: (e) => ({ kind: 'volley-edge', edge: e }),
            band: (startPxX) => ({ kind: 'volley-band', startPxX,
              startStart: cur.fitStart, startEnd: cur.fitEnd }),
          },
          {
            start: cur.peakStart, end: cur.peakEnd,
            edge: (e) => ({ kind: 'fepsp-edge', edge: e }),
            band: (startPxX) => ({ kind: 'fepsp-band', startPxX,
              startStart: cur.peakStart, startEnd: cur.peakEnd }),
          },
        ]
        let best: { dist: number; target: DragTarget } | null = null
        for (const r of pairs) {
          const ds = Math.abs(xToPx(r.start) - pxX)
          const de = Math.abs(xToPx(r.end) - pxX)
          if (ds < EDGE_THRESHOLD_PX && (!best || ds < best.dist)) best = { dist: ds, target: r.edge('start') }
          if (de < EDGE_THRESHOLD_PX && (!best || de < best.dist)) best = { dist: de, target: r.edge('end') }
        }
        if (best) return best.target
        for (let i = pairs.length - 1; i >= 0; i--) {
          const r = pairs[i]
          const p0 = xToPx(r.start), p1 = xToPx(r.end)
          const lo = Math.min(p0, p1), hi = Math.max(p0, p1)
          if (pxX > lo && pxX < hi) return r.band(pxX)
        }
        return null
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (!over) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const hit = findHit(pxX)
        if (hit) dragRef.current = hit
        else {
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (xMin == null || xMax == null || yMin == null || yMax == null) return
          dragRef.current = {
            kind: 'pan', startX: pxX, xMin, xMax,
            startY: ev.clientY - rect.top, yMin, yMax,
          }
        }
        over.setPointerCapture(ev.pointerId)
        ev.preventDefault()
      }

      const onPointerMove = (ev: PointerEvent) => {
        if (!over) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const t = dragRef.current
        if (!t) {
          const hit = findHit(pxX)
          over.style.cursor = !hit ? 'grab'
            : (hit.kind === 'baseline-edge' || hit.kind === 'volley-edge' || hit.kind === 'fepsp-edge') ? 'ew-resize'
            : 'move'
          return
        }
        if (t.kind === 'pan') {
          const x = pxToX(pxX)
          const x0 = u.posToVal(t.startX, 'x')
          const y = pxToY(pxY)
          const y0 = u.posToVal(t.startY, 'y')
          const dx = x - x0, dy = y - y0
          xRangeRef.current = [t.xMin - dx, t.xMax - dx]
          yRangeRef.current = [t.yMin - dy, t.yMax - dy]
          u.setScale('x', { min: xRangeRef.current[0], max: xRangeRef.current[1] })
          u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
          emitXRange(xRangeRef.current[0], xRangeRef.current[1])
          over.style.cursor = 'grabbing'
          return
        }
        const x = pxToX(pxX)
        const shift = (pxStart: number) => pxToX(pxX) - pxToX(pxStart)
        switch (t.kind) {
          case 'baseline-edge':
            updateCursors({ [t.edge === 'start' ? 'baselineStart' : 'baselineEnd']: x } as Partial<CursorPositions>)
            break
          case 'baseline-band': {
            const dx = shift(t.startPxX)
            updateCursors({ baselineStart: t.startStart + dx, baselineEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
          case 'volley-edge':
            updateCursors({ [t.edge === 'start' ? 'fitStart' : 'fitEnd']: x } as Partial<CursorPositions>)
            break
          case 'volley-band': {
            const dx = shift(t.startPxX)
            updateCursors({ fitStart: t.startStart + dx, fitEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
          case 'fepsp-edge':
            updateCursors({ [t.edge === 'start' ? 'peakStart' : 'peakEnd']: x } as Partial<CursorPositions>)
            break
          case 'fepsp-band': {
            const dx = shift(t.startPxX)
            updateCursors({ peakStart: t.startStart + dx, peakEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
        }
      }

      const onPointerUp = (ev: PointerEvent) => {
        if (dragRef.current && over) {
          dragRef.current = null
          try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
          over.style.cursor = ''
        }
      }

      const onWheel = (ev: WheelEvent) => {
        if (!over) return
        ev.preventDefault()
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (xMin == null || xMax == null || yMin == null || yMax == null) return
        if (ev.altKey) {
          const yAtCur = u.posToVal(pxY, 'y')
          yRangeRef.current = [
            yAtCur - (yAtCur - yMin) * factor,
            yAtCur + (yMax - yAtCur) * factor,
          ]
          xRangeRef.current = [xMin, xMax]
        } else {
          const xAtCur = u.posToVal(pxX, 'x')
          xRangeRef.current = [
            xAtCur - (xAtCur - xMin) * factor,
            xAtCur + (xMax - xAtCur) * factor,
          ]
          yRangeRef.current = [yMin, yMax]
        }
        u.setScale('x', { min: xRangeRef.current[0], max: xRangeRef.current[1] })
        u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
        emitXRange(xRangeRef.current[0], xRangeRef.current[1])
      }

      if (over) {
        over.addEventListener('pointerdown', onPointerDown)
        over.addEventListener('pointermove', onPointerMove)
        over.addEventListener('pointerup', onPointerUp)
        over.addEventListener('pointercancel', onPointerUp)
        over.addEventListener('wheel', onWheel, { passive: false })
      }
      ;(plotRef.current as any)._teardownFPspSweep = () => {
        if (over) {
          over.removeEventListener('pointerdown', onPointerDown)
          over.removeEventListener('pointermove', onPointerMove)
          over.removeEventListener('pointerup', onPointerUp)
          over.removeEventListener('pointercancel', onPointerUp)
          over.removeEventListener('wheel', onWheel)
        }
      }
    })
    return () => {
      cancelAnimationFrame(frameId)
      const teardown = (plotRef.current as any)?._teardownFPspSweep
      if (teardown) teardown()
      plotRef.current?.destroy()
      plotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues])

  useEffect(() => { plotRef.current?.redraw() }, [cursors])
  useEffect(() => { plotRef.current?.redraw() }, [theme, fontSize])
  // Redraw when the marker point (selected row) changes so the
  // detection dots update without rebuilding the plot. Same for
  // zero-offset toggling — the dots need to shift with the trace.
  useEffect(() => { plotRef.current?.redraw() }, [markerPoint, markerEntry, zeroOffsetApplied])
  // PPR cursor bands live outside the main cursor store, so redraw
  // on their changes too (moving V1/F1 + clicking "Place V2/F2 from
  // ISI" must show the new positions immediately).
  useEffect(() => { plotRef.current?.redraw() }, [pprBands])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0)
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        padding: '3px 8px', fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)', background: 'var(--bg-secondary)',
        display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {/* A/B toggle + sweep arrows moved to the top selector row. */}
        <span style={{ minWidth: 110 }}>
          {source === 'B' ? 'LTP ' : 'BL '}
          Sweep {totalSweeps > 0 ? previewSweep + 1 : '—'}
        </span>
        {isExcluded && (
          <span style={{
            fontSize: 'var(--font-size-label)', fontWeight: 600,
            color: '#fff', background: '#e65100',
            padding: '1px 6px', borderRadius: 3,
          }}>⊘ Excluded</span>
        )}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 3,
          fontSize: 'var(--font-size-label)', marginLeft: 'auto',
        }} title="Subtract a baseline computed from the first ~3 ms of each sweep">
          <input type="checkbox" checked={zeroOffset}
            onChange={(e) => onZeroOffsetChange(e.target.checked)} />
          Zero offset
        </label>
        <button className="btn"
          onClick={resetCursorsInView}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Bring Baseline / Volley / fEPSP bands into the current view">
          Reset cursors
        </button>
        <button className="btn"
          onClick={resetZoom}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Reset zoom to full sweep">Reset zoom</button>
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{ flex: 1, minHeight: 120, position: 'relative' }}
      >
        {menu}
      </div>
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        scroll = zoom X · ⌥ scroll = zoom Y · drag empty = pan · drag band = move · drag edge = resize
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FPspResultsTabs — bottom-section tabs. Two tabs: Table (the existing
// FPspTable) and Over-time (the existing FPspOverTimeGraph). Both stay
// mounted so switching doesn't rebuild the over-time plot and lose any
// user zoom / selection state.
// ---------------------------------------------------------------------------

function FPspResultsTabs({
  entry, onSelectPoint, visibilitySignal, plotHeader,
}: {
  entry: FPspData | undefined
  onSelectPoint: (idx: number) => void
  /** Bumped by the parent when the LTP tab becomes visible. Forwarded
   *  to FPspOverTimeGraph as heightSignal so the plot resizes + redraws
   *  after a mode-switch round-trip (which would otherwise leave it
   *  stuck at whatever 0-dim setSize the ResizeObserver applied while
   *  hidden). */
  visibilitySignal?: number
  /** Optional control bar rendered directly above the over-time plot
   *  (right column). Keeps the plot toggles (normalize / time / index)
   *  visually adjacent to what they affect, instead of far away at
   *  the top of the window. */
  plotHeader?: React.ReactNode
}) {
  // Side-by-side layout (table left, over-time graph right) to match
  // the I-O and PPR result panels. The earlier subtab layout had two
  // failure modes — the over-time plot started 0×0 the first time the
  // user clicked into it, and switching modes-then-back lost the
  // user's place. Inline both views and the user always sees both.
  return (
    <div style={{
      flex: 1, display: 'flex', gap: 6, minHeight: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <FPspTable entry={entry} onSelect={onSelectPoint} />
      </div>
      <div style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {plotHeader}
        <div style={{ flex: 1, minHeight: 0 }}>
          <FPspOverTimeGraph
            entry={entry}
            onSelectIdx={onSelectPoint}
            heightSignal={visibilitySignal ?? 0}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// I-O tab result components
//
// I-O results are presented inline: table on the left, intensity-vs-metric
// scatter on the right. Unlike LTP (which tabs between Table and Over-time
// because the over-time plot needs the full width to be useful), I-O
// users typically want to read a row and eyeball the curve at the same
// time, so side-by-side is more informative.
// ---------------------------------------------------------------------------

function IOResultsPanel({
  entry, metric, onSelectPoint, theme, fontSize, visibilitySignal, plotHeader,
}: {
  entry: FPspData | undefined
  metric: 'slope' | 'amplitude'
  onSelectPoint: (idx: number) => void
  theme: string
  fontSize: number
  /** Bumped by the parent every time the panel becomes visible. */
  visibilitySignal?: number
  /** Optional control bar rendered directly above the scatter plot
   *  (right column). Keeps the y-axis toggle visually next to what
   *  it affects. */
  plotHeader?: React.ReactNode
}) {
  void theme; void fontSize  // captured via cssVar inside IOScatter
  return (
    <div style={{
      flex: 1, display: 'flex', gap: 6, minHeight: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <IOTable entry={entry} onSelect={onSelectPoint} />
      </div>
      <div style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {plotHeader}
        <div style={{ flex: 1, minHeight: 0 }}>
          <IOScatter
            entry={entry}
            metric={metric}
            onSelectIdx={onSelectPoint}
            visibilitySignal={visibilitySignal}
          />
        </div>
      </div>
    </div>
  )
}

/** Per-sweep I-O results table. One row per sweep (I-O runs always
 *  set avgN=1), with intensity computed frontend-side from the
 *  entry's `ioInitialIntensity + sweepIndex * ioIntensityStep`. The
 *  row-click navigates the main viewer to that sweep, same as every
 *  other analysis-window table. */
function IOTable({
  entry, onSelect,
}: {
  entry: FPspData | undefined
  onSelect: (idx: number) => void
}) {
  const sel = useRowSelection(entry?.points.length ?? 0)
  const u = entry?.responseUnit || ''
  const unit = entry?.ioUnit ?? 'µA'
  const i0 = entry?.ioInitialIntensity ?? 0
  const step = entry?.ioIntensityStep ?? 0
  const headers = ['#', 'Sweep', `Intensity (${unit})`, `Baseline (${u})`,
    `Volley (${u})`, `fEPSP amp (${u})`, 'Slope']
  const rowToCells = (i: number): Array<string | number | null> => {
    const p = entry!.points[i]
    const sweepIdx = p.sweepIndices[0] ?? p.meanSweepIndex
    const intensity = i0 + sweepIdx * step
    return [
      i + 1, sweepIdx + 1, intensity.toFixed(2),
      p.baseline.toFixed(3), p.volleyAmp.toFixed(3), p.fepspAmp.toFixed(3),
      p.slope == null ? null : p.slope.toFixed(3),
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  if (!entry || entry.points.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)', borderRadius: 4,
        height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {entry ? 'No points.' : 'Run to populate the I-O curve.'}
      </div>
    )
  }

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', height: '100%',
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>#</Th>
            <Th>Sweep</Th>
            <Th>Intensity ({unit})</Th>
            <Th>Baseline ({u})</Th>
            <Th>Volley ({u})</Th>
            <Th>fEPSP amp ({u})</Th>
            <Th>Slope</Th>
          </tr>
        </thead>
        <tbody>
          {entry.points.map((p, i) => {
            const sweepIdx = p.sweepIndices[0] ?? p.meanSweepIndex
            const intensity = i0 + sweepIdx * step
            const selectedBg = i === entry.selectedIdx
              ? 'var(--bg-selected, rgba(100,181,246,0.2))'
              : undefined
            const multiBg = sel.isSelected(i)
              ? 'var(--accent-muted, rgba(100,181,246,0.30))' : undefined
            return (
              <tr
                key={i}
                onClick={(ev) => {
                  sel.onRowClick(i, ev)
                  if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) onSelect(i)
                }}
                onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                })}
                style={{
                  background: multiBg ?? selectedBg ?? 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{i + 1}</Td>
                <Td>{sweepIdx + 1}</Td>
                <Td>{intensity.toFixed(2)}</Td>
                <Td>{p.baseline.toFixed(3)}</Td>
                <Td>{p.volleyAmp.toFixed(3)}</Td>
                <Td>{p.fepspAmp.toFixed(3)}</Td>
                <Td>{p.slope != null ? p.slope.toFixed(3) : '—'}</Td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

/** uPlot scatter of fEPSP slope (or amplitude) versus stimulus
 *  intensity — the actual "I-O curve". Clicking a point selects the
 *  corresponding row in the table. Rebuild-on-data pattern, same
 *  as the LTP over-time plot. */
function IOScatter({
  entry, metric, onSelectIdx, visibilitySignal,
}: {
  entry: FPspData | undefined
  metric: 'slope' | 'amplitude'
  onSelectIdx: (idx: number) => void
  /** Incremented by the parent whenever this panel becomes visible
   *  (tab switched to I-O). Triggers a setSize+redraw after rAF so
   *  the plot recovers from any 0-dim state the display-toggle put
   *  it in while the panel was hidden. */
  visibilitySignal?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'fpsp-io-curve',
  })
  // Mirror the selected index into a ref so the draw hook picks up
  // selection changes without having to rebuild the plot — which, if
  // left in the rebuild-deps, made the scatter visibly flash and the
  // user's zoom reset on every row click.
  const selectedRef = useRef<number | null>(entry?.selectedIdx ?? null)
  selectedRef.current = entry?.selectedIdx ?? null

  // Build the (intensity, y) pairs. Deps are scoped to actual data
  // fields so a selection change (new entry identity, same points)
  // does NOT produce new array refs and does NOT trigger rebuild.
  // Slope is taken absolute — classical fEPSPs have negative slopes
  // (downward flank to the sink), and plotting |slope| yields a
  // positive correlation with stimulus intensity which reads more
  // naturally on the curve.
  const { xs, ys } = useMemo(() => {
    if (!entry) return { xs: [] as number[], ys: [] as (number | null)[] }
    const i0 = entry.ioInitialIntensity ?? 0
    const step = entry.ioIntensityStep ?? 0
    const xs: number[] = []
    const ys: (number | null)[] = []
    entry.points.forEach((p) => {
      const sweepIdx = p.sweepIndices[0] ?? p.meanSweepIndex
      xs.push(i0 + sweepIdx * step)
      if (metric === 'amplitude') {
        ys.push(Math.abs(p.fepspAmp))
      } else {
        ys.push(p.slope != null ? Math.abs(p.slope) : null)
      }
    })
    return { xs, ys }
    // Intentionally field-scoped — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entry?.points,
    entry?.ioInitialIntensity,
    entry?.ioIntensityStep,
    metric,
  ])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!entry || xs.length === 0) return

    const yUnit = entry.responseUnit || ''
    const yLabel = metric === 'amplitude'
      ? `|fEPSP amp| (${yUnit})`
      : `|Slope| (${yUnit}/s)`
    const xLabel = `Intensity (${entry.ioUnit ?? 'µA'})`

    const opts: uPlot.Options = {
      width: container.clientWidth || 400,
      height: Math.max(140, container.clientHeight || 220),
      scales: { x: { time: false }, y: {} },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: xLabel,
          labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: yLabel,
          labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          stroke: cssVar('--trace-color-1'),
          width: 1.25,
          points: { show: true, size: 6, stroke: cssVar('--trace-color-1'), fill: cssVar('--trace-color-1') },
        },
      ],
      hooks: {
        draw: [(u) => drawGraphSelected(u, selectedRef.current)],
      },
    }
    const payload: uPlot.AlignedData = [xs, ys]
    plotRef.current = new uPlot(opts, payload, container)
    // Click-to-select: find nearest point by x-distance.
    const over = container.querySelector<HTMLDivElement>('.u-over')
    if (over) {
      const onClick = (ev: MouseEvent) => {
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const u = plotRef.current
        if (!u) return
        const xVal = u.posToVal(pxX, 'x')
        // xs is in sweep-order (often monotonic but may not be strictly
        // so if sweeps were excluded mid-ramp). Linear scan is fine:
        // I-O curves have ~10–30 points.
        let best = -1
        let bestDist = Infinity
        for (let i = 0; i < xs.length; i++) {
          const d = Math.abs(xs[i] - xVal)
          if (d < bestDist) { bestDist = d; best = i }
        }
        if (best >= 0) onSelectIdx(best)
      }
      over.addEventListener('click', onClick)
      // Cleanup handled on next rebuild; the next destroy nukes `over`.
    }
    // Deps intentionally exclude `entry` (whole) — selection-only
    // changes produce a new entry ref, but the memoized xs/ys remain
    // stable (field-scoped deps above), so the plot keeps its instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xs, ys, metric, entry?.responseUnit, entry?.ioUnit])

  useEffect(() => { plotRef.current?.redraw() }, [entry?.selectedIdx])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // When the parent signals the panel has (re)become visible after a
  // tab switch, resize to the now-measurable container + force a
  // redraw. Mirrors FPspOverTimeGraph's pattern; without this the
  // scatter came back blank until the user clicked a control that
  // changed data (slope/amplitude toggle) and triggered a rebuild.
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

  if (!entry || xs.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry ? 'No points yet.' : 'Run to populate the I-O curve.'}
      </div>
    )
  }
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', position: 'relative',
      }}
    >
      {menu}
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// PPR tab result components
//
// Same shape as the I-O panel (table left, scatter right) — but the
// scatter plots paired-pulse ratio vs sweep index, with the user
// choosing whether ratio is computed from amplitude or slope. The
// table shows the full R1/R2/PPR breakdown so mistakes in cursor
// placement are easy to spot (e.g. an R1 accidentally landing on a
// flat window gives a PPR that jumps around).
// ---------------------------------------------------------------------------

function PPRResultsPanel({
  entry, metric, onSelectPoint, visibilitySignal, plotHeader,
}: {
  entry: FPspData | undefined
  metric: 'amp' | 'slope'
  onSelectPoint: (idx: number) => void
  visibilitySignal?: number
  /** Optional control bar rendered directly above the ratio scatter
   *  (right column). */
  plotHeader?: React.ReactNode
}) {
  return (
    <div style={{
      flex: 1, display: 'flex', gap: 6, minHeight: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <PPRTable entry={entry} onSelect={onSelectPoint} metric={metric} />
      </div>
      <div style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {plotHeader}
        <div style={{ flex: 1, minHeight: 0 }}>
          <PPRScatter
            entry={entry}
            metric={metric}
            onSelectIdx={onSelectPoint}
            visibilitySignal={visibilitySignal}
          />
        </div>
      </div>
    </div>
  )
}

/** Per-sweep PPR table. Row = one sweep. Columns cover both responses
 *  and both ratios so the user can spot outliers at a glance. The
 *  currently-active ratio metric (amp vs slope) is highlighted in
 *  the column header so it's clear which one the scatter is tracking. */
function PPRTable({
  entry, onSelect, metric,
}: {
  entry: FPspData | undefined
  onSelect: (idx: number) => void
  metric: 'amp' | 'slope'
}) {
  const sel = useRowSelection(entry?.points.length ?? 0)
  const u = entry?.responseUnit || ''
  const headers = ['#', 'Sweep', `R1 amp (${u})`, `R2 amp (${u})`,
    'R1 slope', 'R2 slope', 'PPR (amp)', 'PPR (slope)']
  const rowToCells = (i: number): Array<string | number | null> => {
    const p = entry!.points[i]
    const sweepIdx = p.sweepIndices[0] ?? p.meanSweepIndex
    return [
      i + 1, sweepIdx + 1,
      p.fepspAmp.toFixed(3),
      p.fepspAmp2 == null ? null : p.fepspAmp2.toFixed(3),
      p.slope == null ? null : p.slope.toFixed(3),
      p.slope2 == null ? null : p.slope2.toFixed(3),
      p.pprAmp == null ? null : p.pprAmp.toFixed(3),
      p.pprSlope == null ? null : p.pprSlope.toFixed(3),
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  if (!entry || entry.points.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)', borderRadius: 4,
        height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {entry ? 'No points.' : 'Run to populate the PPR table.'}
      </div>
    )
  }
  const highlight = (which: 'amp' | 'slope') =>
    metric === which ? { background: 'rgba(100,181,246,0.12)' } : undefined

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', height: '100%',
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>#</Th>
            <Th>Sweep</Th>
            <Th>R1 amp ({u})</Th>
            <Th>R2 amp ({u})</Th>
            <Th>R1 slope</Th>
            <Th>R2 slope</Th>
            <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)', ...highlight('amp') }}>
              PPR (amp)
            </th>
            <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)', ...highlight('slope') }}>
              PPR (slope)
            </th>
          </tr>
        </thead>
        <tbody>
          {entry.points.map((p, i) => {
            const sweepIdx = p.sweepIndices[0] ?? p.meanSweepIndex
            const selectedBg = i === entry.selectedIdx
              ? 'var(--bg-selected, rgba(100,181,246,0.2))'
              : undefined
            const multiBg = sel.isSelected(i)
              ? 'var(--accent-muted, rgba(100,181,246,0.30))' : undefined
            return (
              <tr
                key={i}
                onClick={(ev) => {
                  sel.onRowClick(i, ev)
                  if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) onSelect(i)
                }}
                onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                })}
                style={{
                  background: multiBg ?? selectedBg ?? 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{i + 1}</Td>
                <Td>{sweepIdx + 1}</Td>
                <Td>{p.fepspAmp.toFixed(3)}</Td>
                <Td>{p.fepspAmp2 != null ? p.fepspAmp2.toFixed(3) : '—'}</Td>
                <Td>{p.slope != null ? p.slope.toFixed(3) : '—'}</Td>
                <Td>{p.slope2 != null ? p.slope2.toFixed(3) : '—'}</Td>
                <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...highlight('amp') }}>
                  {p.pprAmp != null ? p.pprAmp.toFixed(3) : '—'}
                </td>
                <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...highlight('slope') }}>
                  {p.pprSlope != null ? p.pprSlope.toFixed(3) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

/** PPR-over-sweeps scatter. Same rebuild-on-data / redraw-on-select
 *  pattern as IOScatter. A dashed guide at y=1 makes depression vs
 *  facilitation readable at a glance (< 1 = depression, > 1 = facilitation). */
function PPRScatter({
  entry, metric, onSelectIdx, visibilitySignal,
}: {
  entry: FPspData | undefined
  metric: 'amp' | 'slope'
  onSelectIdx: (idx: number) => void
  visibilitySignal?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'fpsp-ppr',
  })
  const selectedRef = useRef<number | null>(entry?.selectedIdx ?? null)
  selectedRef.current = entry?.selectedIdx ?? null

  const { xs, ys } = useMemo(() => {
    if (!entry) return { xs: [] as number[], ys: [] as (number | null)[] }
    const xs: number[] = []
    const ys: (number | null)[] = []
    entry.points.forEach((p) => {
      const sweepIdx = p.sweepIndices[0] ?? p.meanSweepIndex
      xs.push(sweepIdx + 1)  // 1-based for human display
      ys.push(metric === 'amp' ? (p.pprAmp ?? null) : (p.pprSlope ?? null))
    })
    return { xs, ys }
    // Field-scoped deps so row-click (selectedIdx change) doesn't rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.points, metric])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!entry || xs.length === 0) return

    const yLabel = metric === 'amp' ? 'PPR (amp)' : 'PPR (slope)'
    const xLabel = 'Sweep #'

    const opts: uPlot.Options = {
      width: container.clientWidth || 400,
      height: Math.max(140, container.clientHeight || 220),
      scales: { x: { time: false }, y: {} },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: xLabel,
          labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: yLabel,
          labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          stroke: cssVar('--trace-color-1'),
          width: 1.25,
          points: { show: true, size: 6, stroke: cssVar('--trace-color-1'), fill: cssVar('--trace-color-1') },
        },
      ],
      hooks: {
        draw: [
          // Dashed unity line — the "depression vs facilitation"
          // boundary most readers look for first.
          (u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            const px1 = u.bbox.left / dpr
            const px2 = (u.bbox.left + u.bbox.width) / dpr
            const py = u.valToPos(1, 'y', true) / dpr
            if (!isFinite(py)) return
            ctx.save()
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.strokeStyle = 'rgba(158,158,158,0.7)'
            ctx.lineWidth = 1
            ctx.setLineDash([5, 4])
            ctx.beginPath()
            ctx.moveTo(px1, py)
            ctx.lineTo(px2, py)
            ctx.stroke()
            ctx.setLineDash([])
            ctx.fillStyle = 'rgba(158,158,158,0.9)'
            ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`
            ctx.fillText('PPR = 1', px1 + 4, py - 3)
            ctx.restore()
          },
          (u) => drawGraphSelected(u, selectedRef.current),
        ],
      },
    }
    const payload: uPlot.AlignedData = [xs, ys]
    plotRef.current = new uPlot(opts, payload, container)

    // Click-to-select: find nearest x (sweep index) in the list.
    const over = container.querySelector<HTMLDivElement>('.u-over')
    if (over) {
      const onClick = (ev: MouseEvent) => {
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const u = plotRef.current
        if (!u) return
        const xVal = u.posToVal(pxX, 'x')
        let best = -1
        let bestDist = Infinity
        for (let i = 0; i < xs.length; i++) {
          const d = Math.abs(xs[i] - xVal)
          if (d < bestDist) { bestDist = d; best = i }
        }
        if (best >= 0) onSelectIdx(best)
      }
      over.addEventListener('click', onClick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xs, ys, metric, entry?.responseUnit])

  useEffect(() => { plotRef.current?.redraw() }, [entry?.selectedIdx])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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

  if (!entry || xs.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry ? 'No points yet.' : 'Run PPR to populate the ratio scatter.'}
      </div>
    )
  }
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', position: 'relative',
      }}
    >
      {menu}
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}
