import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  CursorPositions, StimulusInfo, useAppStore,
} from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { usePlotMenu } from '../common/PlotMenu'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function fmt(v: number | null | undefined, digits: number, unit: string): string {
  if (v == null || !isFinite(v)) return '—'
  return `${v.toFixed(digits)} ${unit}`
}

interface MeasurementRow {
  series: string
  sweep: number | string
  rs: number | null
  rin: number | null
  cm: number | null
  tau: number | null
  fit_r_squared: number | null
  source: string
}

interface Props {
  backendUrl: string
  fileInfo: any
  cursors: CursorPositions
  currentSweep: number
  // Mirrored from the main viewer's selection so the resistance
  // window opens already pointed at the same series the user is
  // looking at, matching the pattern the other analysis windows
  // (IV, AP, fPSP, …) use. Initial value only — once the user
  // picks a different series here, this stops driving anything.
  mainGroup?: number | null
  mainSeries?: number | null
  mainTrace?: number | null
}

// Recover a 1-based sweep number (or "avg X-Y" string) from a stored
// ResistanceResult's ``source`` tag — purely for table display. Used
// when rehydrating the per-series row list from store. Falls back to
// ``null`` when the source doesn't match a known format and the
// caller renders the row index instead.
function _parseSweepFromSource(source: string | undefined): number | string | null {
  if (!source) return null
  const m = source.match(/^sweep\s+(\d+)/i)
  if (m) return Number(m[1])
  if (source.startsWith('avg') || source.startsWith('averaged')) return source
  return null
}

// Cursor band colors mirror the other analysis windows for consistency.
const BASELINE_COLOR_VAR = '--cursor-baseline'
const PEAK_COLOR_VAR = '--cursor-peak'
const FIT_COLOR_VAR = '--cursor-fit'

export function ResistanceWindow({
  backendUrl, fileInfo, cursors, currentSweep,
  mainGroup, mainSeries, mainTrace,
}: Props) {
  const themeKey = useThemeKey()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // Pre-select the main viewer's series. Default 0/0/0 only if the
  // main window hasn't reported a selection yet. Once the user picks
  // a different series in the dropdowns here, the mirroring stops —
  // hence this is initial state, not a controlled prop.
  const [currentGroup, setCurrentGroup] = useState(mainGroup ?? 0)
  const [currentSeries, setCurrentSeries] = useState(mainSeries ?? 0)
  const [currentChannel, setCurrentChannel] = useState(mainTrace ?? 0)
  // Adopt the main-window selection on first arrival (state-update
  // broadcast lands a moment after mount). Without this the window
  // would stay on 0/0 if the user opened it before main-window state
  // sync. We only update when the value actually changes from what we
  // have, so the user's manual picks here aren't clobbered.
  const adoptedSelectionRef = useRef(false)
  useEffect(() => {
    if (adoptedSelectionRef.current) return
    if (mainGroup == null || mainSeries == null) return
    adoptedSelectionRef.current = true
    setCurrentGroup(mainGroup)
    setCurrentSeries(mainSeries)
    if (mainTrace != null) setCurrentChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])
  // Form state lives in the app store so the .tracer sidecar can
  // round-trip it across sessions. ``setForm`` patches only the
  // fields the caller passes; everything else stays intact.
  const resistanceForm = useAppStore((s) => s.resistanceForm)
  const setForm = useAppStore((s) => s.setResistanceForm)
  const { vStep, nExp, fitDurationMs, runMode, avgFrom, avgTo, sweepOne } = resistanceForm
  type RunMode = typeof resistanceForm['runMode']
  const setVStep = (v: number) => setForm({ vStep: v })
  const setAvgFrom = (v: number) => setForm({ avgFrom: v })
  const setAvgTo = (v: number) => setForm({ avgTo: v })
  const setNExp = (v: number) => setForm({ nExp: (v === 1 ? 1 : 2) })
  const setFitDurationMs = (v: number) => setForm({ fitDurationMs: v })
  const setRunMode = (v: RunMode) => setForm({ runMode: v })
  const setSweepOne = (v: number) => setForm({ sweepOne: v })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [measurements, setMeasurements] = useState<MeasurementRow[]>([])
  // Multi-row selection + Copy-as-TSV for the results table.
  const measSel = useRowSelection(measurements.length)
  const measCopyMenu = useRowCopyMenu({
    selectionCount: measSel.selectedIndexes.length,
    getTSV: () => {
      if (measSel.selectedIndexes.length === 0) return null
      const headers = ['Series', 'Sweep', 'Rs (MΩ)', 'Rin (MΩ)',
        'Cm (pF)', 'τ (ms)', 'R²']
      const rows = measSel.selectedIndexes.map((i) => {
        const r = measurements[i]
        return [
          r.series, r.sweep,
          fmt(r.rs, 2, ''), fmt(r.rin, 2, ''),
          fmt(r.cm, 2, ''), fmt(r.tau, 3, ''),
          r.fit_r_squared == null ? '' : r.fit_r_squared.toFixed(4),
        ]
      })
      return buildTSV(headers, rows)
    },
  })

  // Which sweep the embedded viewer is showing. Initialised from the main
  // window's current sweep and then updated locally via the prev/next
  // arrows. Kept independent so skimming here doesn't yank the main
  // viewer around.
  const [previewSweep, setPreviewSweep] = useState(currentSweep)

  // Trace data for the embedded viewer
  const [traceTime, setTraceTime] = useState<number[] | null>(null)
  const [traceValues, setTraceValues] = useState<number[] | null>(null)
  const [fitTime, setFitTime] = useState<number[] | null>(null)
  const [fitValues, setFitValues] = useState<number[] | null>(null)
  const [fitStartOffset, setFitStartOffset] = useState(0)
  const [traceLabel, setTraceLabel] = useState('')

  const traceChartRef = useRef<HTMLDivElement>(null)
  const tracePlotRef = useRef<uPlot | null>(null)
  const { onContextMenu: onResContextMenu, menu: resPlotMenu } = usePlotMenu({
    getCanvas: () => tracePlotRef.current?.ctx?.canvas ?? null,
    defaultName: 'resistance-trace',
  })

  // Splitters — both persist to Electron prefs under resistanceWindowUI
  // so the layout survives window reopens. Same recipe as AP/FPsp/IV.
  const [plotHeight, setPlotHeight] = useState(340)
  const [leftPanelWidth, setLeftPanelWidth] = useState(320)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const ui = prefs?.resistanceWindowUI
        if (cancelled || !ui) return
        if (typeof ui.leftPanelWidth === 'number'
            && ui.leftPanelWidth >= 200 && ui.leftPanelWidth <= 500) {
          setLeftPanelWidth(ui.leftPanelWidth)
        }
        if (typeof ui.plotHeight === 'number'
            && ui.plotHeight >= 150 && ui.plotHeight <= 800) {
          setPlotHeight(ui.plotHeight)
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
      const next = { ...(prefs.resistanceWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, resistanceWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = plotHeight
    let latest = startH
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      latest = Math.max(150, Math.min(800, startH + dy))
      setPlotHeight(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeUIPref({ plotHeight: latest })
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
  // Unified Run button — picks the action based on runMode. Keeps the
  // three existing action semantics (run one sweep / run averaged
  // over a range / run each sweep in series) while matching the AP
  // layout pattern.
  const onRun = () => {
    if (runMode === 'all') runAllSweeps()
    else if (runMode === 'selected') runSelected()
    else if (runMode === 'range') runAveraged()
    else {
      const idx = Math.max(0, Math.min(totalSweeps - 1, sweepOne - 1))
      runSingle(idx)
    }
  }

  // Derived
  const groups = fileInfo?.groups || []
  const seriesList = groups[currentGroup]?.series || []
  const currentSeriesInfo = seriesList[currentSeries]
  const totalSweeps = currentSeriesInfo?.sweepCount ?? 0
  const stimulus: StimulusInfo | null = currentSeriesInfo?.stimulus ?? null
  const filePath = fileInfo?.filePath || ''
  // Channel list mirrors whatever the current series has. Resistance
  // traditionally runs on trace 0 but multi-channel rigs can have the
  // test pulse on a specific amplifier channel.
  const channels = currentSeriesInfo?.channels || []
  // Clamp channel to the current series' channel count so switching
  // series never leaves the picker pointing at a non-existent channel.
  useEffect(() => {
    if (channels.length > 0 && currentChannel >= channels.length) {
      setCurrentChannel(0)
    }
  }, [channels, currentChannel])

  // Sweeps multi-selected in the tree navigator, for the "Selected
  // sweeps" run-mode option. Empty when no multi-selection exists;
  // the dropdown option is hidden in that case.
  const selectedSweepsList = useAppStore((s) =>
    s.selectedSweeps[`${currentGroup}:${currentSeries}`] ?? [])
  // If the user had "Selected" picked and then cleared the selection,
  // fall back to "all" so the Run button stays actionable.
  useEffect(() => {
    if (runMode === 'selected' && selectedSweepsList.length === 0) {
      setRunMode('all')
    }
  }, [runMode, selectedSweepsList.length])

  // Exclusion state — mirror from store so we can show a tiny badge on
  // the preview sweep when it's excluded (run on it is still allowed).
  const isPreviewExcluded = useAppStore((s) =>
    s.isSweepExcluded(currentGroup, currentSeries, previewSweep))

  // Auto-populate V_step from stimulus
  useEffect(() => {
    if (stimulus) setVStep(Number(stimulus.vStepAbsolute.toFixed(2)))
  }, [stimulus?.vStepAbsolute])

  // Auto-populate sweep range
  useEffect(() => {
    if (totalSweeps > 0) { setAvgFrom(1); setAvgTo(totalSweeps) }
  }, [currentGroup, currentSeries, totalSweeps])

  // If the main window's sweep changes, follow — but only once; don't
  // fight the user once they start using the prev/next arrows here.
  const mainSyncedRef = useRef(false)
  useEffect(() => {
    if (mainSyncedRef.current) return
    mainSyncedRef.current = true
    setPreviewSweep(currentSweep)
  }, [currentSweep])

  // Clamp previewSweep when series changes
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, totalSweeps - 1)))
  }, [currentGroup, currentSeries, totalSweeps])

  // Fetch persisted results on mount (global per file)
  // Rehydrate the measurement table from the per-series store
  // (``resistanceResults[g:s]``) whenever the user navigates to a
  // different series — OR when this series' stored row list grows
  // (a fresh run just appended to it).
  //
  // Within the same series, runs accumulate (single sweep + then
  // averaged + then more single sweeps all pile up in the same
  // table). Switching series swaps the entire table to whatever the
  // new series has stored, which is empty for unanalyzed series.
  //
  // The previous backend-cache fetch (``/api/results/get`` keyed
  // hard to ``group: 0, series: 0``) was vestigial — a leftover
  // from before per-series sidecar persistence existed — and is
  // dropped entirely.
  const resistanceForCurrent = useAppStore(
    (s) => s.resistanceResults[`${currentGroup}:${currentSeries}`]
  )
  useEffect(() => {
    const rows = resistanceForCurrent ?? []
    setMeasurements(rows.map((r, i) => ({
      series: seriesLabel,
      // We don't carry the original sweep index in the stored
      // ResistanceResult shape — recover it from ``source`` when
      // it parses, otherwise fall back to the row index for
      // display only. Keeps the ECDF-style rebuild deterministic.
      sweep: _parseSweepFromSource(r.source) ?? (i + 1),
      rs: r.rs ?? null,
      rin: r.rin ?? null,
      cm: r.cm ?? null,
      tau: r.tau ?? null,
      fit_r_squared: null,
      source: r.source ?? '',
    })))
    // Drop the fit overlay on series switch — it belongs to a
    // previous series' trace and would be misaligned otherwise.
    // Within-series re-runs just paint a new fit on top, so the
    // ``fitTime != null`` test below leaves overlays alone for
    // append-within-series cases by checking ``measurements`` count.
    if ((resistanceForCurrent ?? []).length === 0) {
      setFitTime(null)
      setFitValues(null)
      setFitStartOffset(0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroup, currentSeries, resistanceForCurrent])

  const storeRows = async (rows: MeasurementRow[]) => {
    try {
      await fetch(`${backendUrl}/api/results/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance', file_path: filePath,
          group: 0, series: 0,
          slot: 'measurements', data: rows,
        }),
      })
    } catch { /* ignore */ }
  }

  // Per-window "zero offset" toggle. When on, the backend subtracts a
  // baseline computed from the first ~3 ms of each sweep before
  // returning the trace — useful for aligning sweeps that drift
  // between recordings.
  const [zeroOffset, setZeroOffset] = useState(false)

  // ---- Load trace for embedded viewer ----
  const loadTrace = useCallback(async (sweepIdx: number) => {
    if (!backendUrl) return
    try {
      const qs = new URLSearchParams({
        group: String(currentGroup), series: String(currentSeries),
        sweep: String(sweepIdx), trace: '0', max_points: '0',
      })
      if (zeroOffset) qs.set('zero_offset', 'true')
      const resp = await fetch(`${backendUrl}/api/traces/data?${qs}`)
      if (resp.ok) {
        const data = await resp.json()
        setTraceTime(data.time)
        setTraceValues(data.values)
        setTraceLabel(`Sweep ${sweepIdx + 1}`)
      }
    } catch { /* ignore */ }
  }, [backendUrl, currentGroup, currentSeries, zeroOffset])

  // Drive the viewer off previewSweep (not currentSweep) so the local
  // arrows actually do something.
  useEffect(() => {
    if (totalSweeps > 0) loadTrace(previewSweep)
  }, [previewSweep, loadTrace, totalSweeps])

  // Cursor changes from drag → push up to the main store AND broadcast
  // so the main trace viewer moves its bands in lockstep.
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    useAppStore.getState().setCursors(next)
    try {
      const ch = new BroadcastChannel('tracer-sync')
      const merged = { ...useAppStore.getState().cursors, ...next }
      ch.postMessage({ type: 'cursor-update', cursors: merged })
      ch.close()
    } catch { /* ignore */ }
  }, [])

  // ---- Common analysis params ----
  const analysisParams = () => ({
    v_step: vStep, n_exp: nExp, fit_duration_ms: fitDurationMs,
  })

  const seriesLabel = `${currentSeries + 1}: ${currentSeriesInfo?.label || 'Series'}`

  const toRow = (m: any, source: string, sweep: number | string): MeasurementRow => ({
    series: seriesLabel,
    sweep,
    rs: m.rs ?? null,
    rin: m.rin ?? null,
    cm: m.cm ?? null,
    tau: m.tau ?? null,
    fit_r_squared: m.fit_r_squared ?? null,
    source,
  })

  const applyFit = (m: any) => {
    if (m.fit_time_ms && m.fit_values) {
      setFitTime(m.fit_time_ms)
      setFitValues(m.fit_values)
      setFitStartOffset(m.fit_start_offset ?? 0)
    } else {
      setFitTime(null); setFitValues(null); setFitStartOffset(0)
    }
  }

  // Append a batch of rows to this series' stored resistance results.
  // Within the same series, successive runs accumulate (single
  // sweep → averaged → another single sweep all sit in the same
  // table). Switching series swaps to that series' accumulated
  // rows — see the rehydration effect below. The cohort extractor
  // reduces the list to a per-cell scalar (mean Rs/Rin/Cm/τ).
  //
  // ResistanceWindow lives in its own Electron BrowserWindow with
  // its own Zustand store instance; the broadcast bridges to the
  // main window so the TreeNavigator's R badge sees it (same
  // pattern as ``_broadcastEvents`` etc. in the appStore).
  const appendResistanceRows = useCallback((measurements: any[], source: string) => {
    if (measurements.length === 0) return
    const key = `${currentGroup}:${currentSeries}`
    const newRows = measurements.map((m) => ({
      baseline: Number(m.baseline ?? 0),
      peak_current: Number(m.peak_current ?? 0),
      steady_state_current: Number(m.steady_state_current ?? 0),
      rs: m.rs == null ? null : Number(m.rs),
      rin: m.rin == null ? null : Number(m.rin),
      cm: m.cm == null ? null : Number(m.cm),
      tau: m.tau == null ? null : Number(m.tau),
      peak_idx: m.peak_idx,
      steady_state_start_idx: m.steady_state_start_idx,
      pulse_end_idx: m.pulse_end_idx,
      source,
    }))
    const prev = useAppStore.getState().resistanceResults
    const existing = prev[key] ?? []
    const nextResults = { ...prev, [key]: [...existing, ...newRows] }
    useAppStore.setState({ resistanceResults: nextResults })
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.postMessage({
        type: 'resistance-update',
        resistanceResults: nextResults,
      })
      ch.close()
    } catch { /* ignore */ }
  }, [currentGroup, currentSeries])

  // Drop this series' entire row set. Used by the in-window Clear
  // button below; lets the user start fresh on a series without
  // having to re-tag or close + reopen.
  const clearResistanceRows = useCallback(() => {
    const key = `${currentGroup}:${currentSeries}`
    const prev = useAppStore.getState().resistanceResults
    if (!(key in prev)) return
    const nextResults = { ...prev }
    delete nextResults[key]
    useAppStore.setState({ resistanceResults: nextResults })
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.postMessage({
        type: 'resistance-update',
        resistanceResults: nextResults,
      })
      ch.close()
    } catch { /* ignore */ }
  }, [currentGroup, currentSeries])

  // ---- API: single sweep ----
  const runSingle = async (sweepIdx: number) => {
    setLoading(true); setError(null)
    try {
      const resp = await fetch(`${backendUrl}/api/analysis/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup, series: currentSeries, sweep: sweepIdx, trace: currentChannel,
          cursors, params: analysisParams(),
        }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText)
      const data = await resp.json()
      // Append into the per-series store; the rehydrate effect picks
      // it up and updates the local ``measurements`` table. Storing
      // separately to ``storeRows`` is the legacy backend cache; kept
      // for now until that endpoint is retired.
      await storeRows([toRow(data.measurement, `sweep ${sweepIdx + 1}`, sweepIdx + 1)])
      applyFit(data.measurement)
      appendResistanceRows([data.measurement], `sweep ${sweepIdx + 1}`)
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }

  // ---- API: averaged ----
  const runAveraged = async () => {
    setLoading(true); setError(null)
    try {
      const from = Math.max(1, Math.min(avgFrom, totalSweeps))
      const to = Math.max(from, Math.min(avgTo, totalSweeps))
      const rawRange: number[] = []
      for (let i = from - 1; i <= to - 1; i++) rawRange.push(i)
      const indices = useAppStore.getState()
        .filterExcludedSweeps(currentGroup, currentSeries, rawRange)
      if (indices.length === 0) {
        throw new Error('No non-excluded sweeps in the chosen range.')
      }

      const trResp = await fetch(
        `${backendUrl}/api/traces/average?group=${currentGroup}&series=${currentSeries}&trace=${currentChannel}&sweeps=${indices.join(',')}&max_points=0`
      )
      if (trResp.ok) {
        const td = await trResp.json()
        setTraceTime(td.time); setTraceValues(td.values); setTraceLabel(`Avg ${from}–${to}`)
      }

      const resp = await fetch(`${backendUrl}/api/analysis/run_averaged`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup, series: currentSeries, trace: currentChannel,
          sweep_indices: indices, cursors, params: analysisParams(),
        }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText)
      const data = await resp.json()
      await storeRows([toRow(data.measurement, `avg ${from}–${to}`, `avg ${from}–${to}`)])
      applyFit(data.measurement)
      appendResistanceRows([data.measurement], `averaged sweeps ${from}–${to}`)
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }

  // ---- API: selected sweeps (tree multi-selection → per-sweep rows) ----
  // Same endpoint as runAllSweeps but restricts to the user's current
  // multi-selection in the tree. Cheaper than asking the backend to
  // accept a sparse `sweep_indices` list — we just iterate here so
  // excluded sweeps are still honoured if the user ticks some of the
  // selected ones as excluded.
  const runSelected = async () => {
    if (selectedSweepsList.length === 0) return
    setLoading(true); setError(null)
    try {
      const excluded = new Set(useAppStore.getState()
        .excludedSweeps[`${currentGroup}:${currentSeries}`] ?? [])
      const rows: MeasurementRow[] = []
      const measurements: any[] = []
      for (const swIdx of selectedSweepsList) {
        if (excluded.has(swIdx)) continue
        const resp = await fetch(`${backendUrl}/api/analysis/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            analysis_type: 'resistance',
            group: currentGroup, series: currentSeries, sweep: swIdx, trace: currentChannel,
            cursors, params: analysisParams(),
          }),
        })
        if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText)
        const data = await resp.json()
        rows.push(toRow(data.measurement, `sweep ${swIdx + 1}`, swIdx + 1))
        measurements.push({ ...data.measurement, _swIdx: swIdx })
      }
      await storeRows(rows)
      // Append all rows in one shot so the badge + table see the
      // batch atomically (and the broadcast fires once, not N times).
      for (const m of measurements) {
        appendResistanceRows([m], `sweep ${m._swIdx + 1}`)
      }
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }

  // ---- API: all sweeps (batch → per-sweep rows in the table) ----
  const runAllSweeps = async () => {
    setLoading(true); setError(null)
    try {
      const excluded = useAppStore.getState()
        .excludedSweeps[`${currentGroup}:${currentSeries}`] ?? []
      const resp = await fetch(`${backendUrl}/api/analysis/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup, series: currentSeries, trace: currentChannel,
          sweep_start: 0, sweep_end: totalSweeps,
          excluded_sweeps: excluded.length > 0 ? excluded : undefined,
          cursors, params: analysisParams(),
        }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText)
      const data = await resp.json()

      const rows: MeasurementRow[] = (data.results || []).map((r: any) => {
        const swIdx = r.sweep_index ?? 0
        return toRow(r, `sweep ${swIdx + 1}`, swIdx + 1)
      })
      await storeRows(rows)
      // Append every row from the batch; the rehydrate effect picks
      // them up. One call so the broadcast fires once.
      const measurementsWithSource = (data.results || []).map((r: any) => ({
        m: r,
        source: `sweep ${(r.sweep_index ?? 0) + 1}`,
      }))
      // Build all-at-once so we get a single store update + broadcast
      // instead of N round trips.
      const key = `${currentGroup}:${currentSeries}`
      const prev = useAppStore.getState().resistanceResults
      const newEntries = measurementsWithSource.map(({ m, source }: any) => ({
        baseline: Number(m.baseline ?? 0),
        peak_current: Number(m.peak_current ?? 0),
        steady_state_current: Number(m.steady_state_current ?? 0),
        rs: m.rs == null ? null : Number(m.rs),
        rin: m.rin == null ? null : Number(m.rin),
        cm: m.cm == null ? null : Number(m.cm),
        tau: m.tau == null ? null : Number(m.tau),
        peak_idx: m.peak_idx,
        steady_state_start_idx: m.steady_state_start_idx,
        pulse_end_idx: m.pulse_end_idx,
        source,
      }))
      const nextResults = {
        ...prev,
        [key]: [...(prev[key] ?? []), ...newEntries],
      }
      useAppStore.setState({ resistanceResults: nextResults })
      try {
        const ch = new BroadcastChannel('tracer-sync')
        ch.postMessage({ type: 'resistance-update', resistanceResults: nextResults })
        ch.close()
      } catch { /* ignore */ }
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }

  const clearResults = async () => {
    // Drop this series' rows from the per-series store; the
    // rehydrate effect picks up the now-empty entry and clears the
    // local table + fit overlay.
    clearResistanceRows()
    // Legacy backend cache cleanup — kept until ``/api/results/*``
    // is retired.
    try {
      await fetch(`${backendUrl}/api/results/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis_type: 'resistance', file_path: filePath, group: 0, series: 0 }),
      })
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------
  // Embedded trace chart — now with draggable cursor bands and
  // locked-zoom pan/wheel, same pattern as the Cursor analysis
  // window's mini-viewer.
  // ---------------------------------------------------------------

  // Keep the latest cursors reachable from the hook closures below
  // (they're attached once at plot mount and must always see current
  // values without tearing down uPlot on every drag).
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors

  // Refs that back the uPlot scale range functions — same locked-
  // zoom pattern that actually works. Null means "auto-fit next
  // draw, then stash the result".
  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  const hasRealDataRef = useRef(false)

  // Drag state
  type DragTarget =
    | { kind: 'baseline-edge'; edge: 'start' | 'end' }
    | { kind: 'baseline-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'peak-edge'; edge: 'start' | 'end' }
    | { kind: 'peak-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'pan'; startX: number; xMin: number; xMax: number; startY: number; yMin: number; yMax: number }
  const dragRef = useRef<DragTarget | null>(null)

  const resetZoom = () => {
    const u = tracePlotRef.current
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
    }
    if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
      const pad = (ymax - ymin) * 0.05
      u.setScale('y', { min: ymin - pad, max: ymax + pad })
    }
  }

  // Compute the interpolated fit overlay array whenever fit values /
  // cursors / trace change. Done here (not inside the plot effect) so
  // the plot effect can stay pinned to [traceTime, traceValues].
  const fitOverlayValues = useMemo<Array<number | null> | null>(() => {
    if (!traceTime || !traceValues || !fitTime || !fitValues || fitTime.length === 0) {
      return null
    }
    const sr = traceTime.length > 1 ? 1 / (traceTime[1] - traceTime[0]) : 10000
    const peakTimeS = cursors.peakStart + fitStartOffset / sr
    const fitTimeS = fitTime.map((t) => peakTimeS + t / 1000)
    const blIdx0 = Math.max(0, Math.round(cursors.baselineStart * sr))
    const blIdx1 = Math.max(blIdx0 + 1, Math.round(cursors.baselineEnd * sr))
    let bl = 0
    if (blIdx1 <= traceValues.length) {
      let sum = 0
      for (let i = blIdx0; i < blIdx1; i++) sum += traceValues[i]
      bl = sum / (blIdx1 - blIdx0)
    }
    const fitInterp: Array<number | null> = new Array(traceTime.length).fill(null)
    let fi = 0
    for (let i = 0; i < traceTime.length; i++) {
      const t = traceTime[i]
      if (t >= fitTimeS[0] && t <= fitTimeS[fitTimeS.length - 1]) {
        while (fi < fitTimeS.length - 1 && fitTimeS[fi + 1] < t) fi++
        if (fi < fitTimeS.length - 1) {
          const frac = (t - fitTimeS[fi]) / (fitTimeS[fi + 1] - fitTimeS[fi])
          fitInterp[i] = fitValues[fi] + frac * (fitValues[fi + 1] - fitValues[fi]) + bl
        }
      }
    }
    return fitInterp
  }, [traceTime, traceValues, fitTime, fitValues, fitStartOffset,
      cursors.peakStart, cursors.baselineStart, cursors.baselineEnd])

  // Draw the cursor bands + fit line. Runs every redraw.
  const drawOverlays = (u: uPlot) => {
    const cur = cursorsRef.current
    const ctx = u.ctx
    const yTop = u.bbox.top
    const yBot = u.bbox.top + u.bbox.height
    const drawBand = (xs: number, xe: number, colorVar: string, label: string) => {
      const px0 = u.valToPos(xs, 'x', true)
      const px1 = u.valToPos(xe, 'x', true)
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.fillStyle = cssVar(colorVar) || '#888'
      ctx.fillRect(Math.min(px0, px1), yTop, Math.abs(px1 - px0), yBot - yTop)
      ctx.globalAlpha = 1
      ctx.fillStyle = cssVar(colorVar) || '#888'
      const dpr = devicePixelRatio || 1
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, yTop + 12 * dpr)
      ctx.restore()
    }
    drawBand(cur.baselineStart, cur.baselineEnd, BASELINE_COLOR_VAR, 'BL')
    drawBand(cur.peakStart, cur.peakEnd, PEAK_COLOR_VAR, 'PK')
  }

  useEffect(() => {
    const container = traceChartRef.current
    if (!container || !traceTime || !traceValues) {
      if (tracePlotRef.current) { tracePlotRef.current.destroy(); tracePlotRef.current = null }
      return
    }

    const frameId = requestAnimationFrame(() => {
      if (tracePlotRef.current) { tracePlotRef.current.destroy(); tracePlotRef.current = null }

      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 100)

      // Build the payload. Second series is the fit overlay.
      const payload: uPlot.AlignedData = fitOverlayValues
        ? [traceTime, traceValues, fitOverlayValues as any]
        : [traceTime, traceValues]

      const series: uPlot.Series[] = [
        {},
        { stroke: cssVar('--trace-color-1'), width: 1.5, scale: 'y' },
      ]
      if (fitOverlayValues) {
        series.push({
          stroke: cssVar(FIT_COLOR_VAR) || '#9c27b0',
          width: 2.5, scale: 'y', points: { show: false },
        })
      }

      // First real data → flip the flag so the range fns stash their
      // initial fit. Reset button and sweep switches do not clear
      // refs, so the user's zoom survives sweep navigation.
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
              if (hasRealDataRef.current) xRangeRef.current = r
              return r
            },
          },
          y: {
            range: (_u, dataMin, dataMax) => {
              if (yRangeRef.current) return yRangeRef.current
              let r: [number, number]
              if (!isFinite(dataMin) || !isFinite(dataMax) || dataMin === dataMax) {
                r = [0, 1]
              } else {
                const pad = (dataMax - dataMin) * 0.05
                r = [dataMin - pad, dataMax + pad]
              }
              if (hasRealDataRef.current) yRangeRef.current = r
              return r
            },
          },
        },
        axes: [
          {
            stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
          },
          {
            stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'pA', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
            scale: 'y',
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series,
        hooks: {
          draw: [(u) => drawOverlays(u)],
        },
      }

      const attachTip = attachHoverCoords(opts)
      tracePlotRef.current = new uPlot(opts, payload, container)
      attachTip(container)

      // --- wire up drag-to-move cursors + pan + wheel-zoom ---
      const u = tracePlotRef.current
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
            band: (startPxX) => ({
              kind: 'baseline-band', startPxX,
              startStart: cur.baselineStart, startEnd: cur.baselineEnd,
            }),
          },
          {
            start: cur.peakStart, end: cur.peakEnd,
            edge: (e) => ({ kind: 'peak-edge', edge: e }),
            band: (startPxX) => ({
              kind: 'peak-band', startPxX,
              startStart: cur.peakStart, startEnd: cur.peakEnd,
            }),
          },
        ]
        // Edge hits first.
        let best: { dist: number; target: DragTarget } | null = null
        for (const r of pairs) {
          const ds = Math.abs(xToPx(r.start) - pxX)
          const de = Math.abs(xToPx(r.end) - pxX)
          if (ds < EDGE_THRESHOLD_PX && (!best || ds < best.dist)) {
            best = { dist: ds, target: r.edge('start') }
          }
          if (de < EDGE_THRESHOLD_PX && (!best || de < best.dist)) {
            best = { dist: de, target: r.edge('end') }
          }
        }
        if (best) return best.target
        // Whole-band hits — later pair wins.
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
        if (hit) {
          dragRef.current = hit
        } else {
          // Empty area → pan.
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (xMin == null || xMax == null || yMin == null || yMax == null) return
          dragRef.current = {
            kind: 'pan',
            startX: pxX, xMin, xMax,
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
            : (hit.kind === 'baseline-edge' || hit.kind === 'peak-edge') ? 'ew-resize'
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
          over.style.cursor = 'grabbing'
          return
        }
        const x = pxToX(pxX)
        const cur = cursorsRef.current
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
          case 'peak-edge':
            updateCursors({ [t.edge === 'start' ? 'peakStart' : 'peakEnd']: x } as Partial<CursorPositions>)
            break
          case 'peak-band': {
            const dx = shift(t.startPxX)
            updateCursors({ peakStart: t.startStart + dx, peakEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
        }
        void cur // silence ts
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
      }

      if (over) {
        over.addEventListener('pointerdown', onPointerDown)
        over.addEventListener('pointermove', onPointerMove)
        over.addEventListener('pointerup', onPointerUp)
        over.addEventListener('pointercancel', onPointerUp)
        over.addEventListener('wheel', onWheel, { passive: false })
      }
      ;(tracePlotRef.current as any)._teardownResistance = () => {
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
      const teardown = (tracePlotRef.current as any)?._teardownResistance
      if (teardown) teardown()
      tracePlotRef.current?.destroy()
      tracePlotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues, fitOverlayValues, themeKey])

  // Redraw when cursors change (so the band overlays follow the drag
  // without rebuilding the whole plot).
  useEffect(() => { tracePlotRef.current?.redraw() }, [cursors])

  useEffect(() => {
    const el = traceChartRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      const u = tracePlotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0)
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Redraw on theme change — band colors resolve at draw time via cssVar.
  useEffect(() => { tracePlotRef.current?.redraw() }, [theme, fontSize])

  // ---- CSV export ----
  const exportCSV = () => {
    const cols = ['Series', 'Sweep', 'Rs (MΩ)', 'Rin (MΩ)', 'Cm (pF)', 'τ (ms)', 'R²']
    const rows = measurements.map((r) =>
      [r.series, r.sweep, fmt(r.rs, 2, ''), fmt(r.rin, 2, ''), fmt(r.cm, 2, ''), fmt(r.tau, 3, ''), r.fit_r_squared?.toFixed(4) ?? ''].join(',')
    )
    const csv = [cols.join(','), ...rows].join('\n')
    navigator.clipboard.writeText(csv)
  }

  // ---- Prev / next sweep navigation ----
  const goPrev = () => setPreviewSweep((s) => Math.max(0, s - 1))
  const goNext = () => setPreviewSweep((s) => Math.min(totalSweeps - 1, s + 1))

  // "Reset cursors" — places Baseline + Peak cursor pairs inside the
  // currently-visible X range of the mini-viewer. Same idea as the main
  // window's reset-to-defaults button, but uses whatever X zoom the user
  // has here so the cursors always land on screen (even if they'd been
  // scrolled off by wheel/pan).
  const resetCursorsInView = () => {
    const u = tracePlotRef.current
    let xMin: number | null = null, xMax: number | null = null
    if (u) {
      xMin = u.scales.x.min ?? null
      xMax = u.scales.x.max ?? null
    }
    if (xMin == null || xMax == null || xMax <= xMin) {
      if (!traceTime || traceTime.length === 0) return
      xMin = traceTime[0]
      xMax = traceTime[traceTime.length - 1]
    }
    const span = xMax - xMin
    updateCursors({
      baselineStart: xMin + 0.05 * span,
      baselineEnd: xMin + 0.20 * span,
      peakStart: xMin + 0.35 * span,
      peakEnd: xMin + 0.65 * span,
    })
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      {/* Selectors — Group / Series / Channel / Sweep, same shape as
          AP, FPsp, Event Detection, etc. Wrapped in bg-secondary so
          the window's "chrome" (selectors + left panel) reads as one
          cohesive region, matching the main-window tree sidebar. */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        flexShrink: 0,
        background: 'var(--bg-secondary)',
        padding: '6px 10px',
        borderRadius: 4,
        border: '1px solid var(--border)',
      }}>
        <Field label="Group">
          <select value={currentGroup}
            onChange={(e) => {
              setCurrentGroup(Number(e.target.value))
              setCurrentSeries(0)
              setFitTime(null); setFitValues(null)
            }}
            disabled={groups.length === 0}>
            {groups.map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Series">
          <select value={currentSeries}
            onChange={(e) => {
              setCurrentSeries(Number(e.target.value))
              setFitTime(null); setFitValues(null)
            }}
            disabled={seriesList.length === 0}>
            {seriesList.map((s: any, i: number) => (
              <option key={i} value={i}>
                {s.label || `S${i + 1}`} ({s.sweepCount} sw)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <select value={currentChannel}
            onChange={(e) => setCurrentChannel(Number(e.target.value))}
            disabled={channels.length === 0}>
            {channels.map((c: any) => (
              <option key={c.index} value={c.index}>
                {c.label} ({c.units})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sweep (preview)">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button className="btn" onClick={goPrev}
              disabled={previewSweep <= 0 || totalSweeps === 0}
              title="Previous sweep"
              style={{ padding: '2px 8px' }}>←</button>
            <span className="num" style={{
              minWidth: 58, textAlign: 'center',
              fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
            }}>
              {totalSweeps > 0 ? `${previewSweep + 1} / ${totalSweeps}` : '— / —'}
            </span>
            <button className="btn" onClick={goNext}
              disabled={previewSweep >= totalSweeps - 1 || totalSweeps === 0}
              title="Next sweep"
              style={{ padding: '2px 8px' }}>→</button>
          </span>
        </Field>
      </div>

      {/* Main body: two-column flex. LEFT = params; RIGHT = viewer +
          results. Same layout as APWindow/FPspWindow/IVCurveWindow. */}
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
              sit outside the scrollable so they're always visible. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,
          }}>
            {/* Cursor readout — read-only, drag bands on the main
                trace or the viewer to change. */}
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 4,
              padding: 8,
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg-primary)',
              fontSize: 'var(--font-size-label)',
            }}>
              <span>
                <span style={{ color: `var(${BASELINE_COLOR_VAR})`, fontWeight: 600 }}>BL:</span>{' '}
                <span className="num">{cursors.baselineStart.toFixed(3)} → {cursors.baselineEnd.toFixed(3)}s</span>
              </span>
              <span>
                <span style={{ color: `var(${PEAK_COLOR_VAR})`, fontWeight: 600 }}>PK:</span>{' '}
                <span className="num">{cursors.peakStart.toFixed(3)} → {cursors.peakEnd.toFixed(3)}s</span>
              </span>
            </div>

            {/* Fit params */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 8,
              padding: 8,
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg-primary)',
            }}>
              <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)', gap: 2 }}>
                <span style={{ color: 'var(--text-muted)' }}>
                  V<sub>step</sub> (mV) {stimulus && <span style={{ color: 'var(--accent)' }}>auto</span>}
                </span>
                <NumInput value={vStep} step={1} onChange={setVStep} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)', gap: 2 }}>
                <span style={{ color: 'var(--text-muted)' }}>Exp fit</span>
                <select value={nExp} onChange={(e) => setNExp(Number(e.target.value))}>
                  <option value={1}>Mono</option>
                  <option value={2}>Bi</option>
                </select>
              </label>
              <label style={{
                gridColumn: '1 / -1',
                display: 'flex', flexDirection: 'column',
                fontSize: 'var(--font-size-label)', gap: 2,
              }}>
                <span style={{ color: 'var(--text-muted)' }}>Fit duration (ms)</span>
                <NumInput value={fitDurationMs} step={0.5} min={0.5} max={50}
                  onChange={setFitDurationMs} />
              </label>
            </div>
          </div>

          {/* Pinned footer: Run + Sweeps dropdown + progressive
              disclosure for Range/Single, then secondary Copy CSV /
              Clear below a separator. The three run actions map to:
                - "All sweeps"     → runAllSweeps()
                - "Averaged range" → runAveraged() (uses from/to)
                - "Single sweep"   → runSingle(sweepOne - 1)
              NB: "range" here means averaged-over-range, not
              per-sweep-in-range, because that's the action the
              Resistance analysis naturally supports. */}
          <div style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <button className="btn btn-primary" onClick={onRun}
              disabled={loading || totalSweeps === 0}
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
                <option value="all">
                  All sweeps ({totalSweeps})
                </option>
                {selectedSweepsList.length > 0 && (
                  <option value="selected">
                    Selected ({selectedSweepsList.length})
                  </option>
                )}
                <option value="range">Averaged range</option>
                <option value="one">Single sweep</option>
              </select>
            </div>
            {runMode === 'range' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                <span>From</span>
                <NumInput value={avgFrom} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setAvgFrom(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span>to</span>
                <NumInput value={avgTo} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setAvgTo(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
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
                onClick={clearResults} disabled={measurements.length === 0}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={exportCSV} disabled={measurements.length === 0}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Copy CSV
              </button>
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

        {/* RIGHT PANEL: viewer + horizontal splitter + results table. */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>
          {/* Viewer — trace label strip + chart + help caption. */}
          <div style={{
            height: plotHeight, minHeight: 160, flexShrink: 0,
            display: 'flex', flexDirection: 'column',
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
            position: 'relative',
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '3px 8px', fontSize: 'var(--font-size-xs)',
              color: 'var(--text-muted)', background: 'var(--bg-secondary)',
              flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
              borderBottom: '1px solid var(--border)',
            }}>
              <span>{traceLabel || 'No trace'}</span>
              {isPreviewExcluded && (
                <span className="notice notice-warning" style={{
            fontSize: 'var(--font-size-xs)', fontWeight: 600,
            padding: '1px 8px', borderRadius: 'var(--radius-sm)', lineHeight: 1.4,
          }}>
                  ⊘ Excluded
                </span>
              )}
              <label style={{
                display: 'flex', alignItems: 'center', gap: 3,
                fontSize: 'var(--font-size-label)', marginLeft: 'auto',
              }} title="Subtract a baseline computed from the first ~3 ms of each sweep">
                <input type="checkbox" checked={zeroOffset}
                  onChange={(e) => setZeroOffset(e.target.checked)} />
                Zero offset
              </label>
              {fitTime && (
                <span style={{ color: `var(${FIT_COLOR_VAR})` }}>
                  ● Fit ({nExp === 1 ? 'mono' : 'bi'}-exp, {fitDurationMs}ms)
                </span>
              )}
              <button
                className="btn"
                onClick={resetCursorsInView}
                style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
                title="Bring baseline + peak cursors into the current view"
              >
                Reset cursors
              </button>
              <button
                className="btn"
                onClick={resetZoom}
                style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
                title="Reset zoom to full sweep"
              >
                Reset zoom
              </button>
            </div>
            <div
              ref={traceChartRef}
              onContextMenu={onResContextMenu}
              style={{ flex: 1, minHeight: 120, position: 'relative' }}
            >
              {resPlotMenu}
            </div>
            <div style={{
              position: 'absolute', bottom: 4, left: 10, zIndex: 2,
              fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
              fontStyle: 'italic', pointerEvents: 'none',
            }}>
              Scroll = zoom X · ⌥ scroll = zoom Y · drag empty = pan · drag band = move · drag edge = resize
            </div>
          </div>

          {/* Horizontal splitter between viewer and results. Thin
              (3px hit / 2px grip) to match AP/FPsp/IV. */}
          <div
            onMouseDown={onSplitterMouseDown}
            style={{
              height: 3,
              cursor: 'row-resize',
              background: 'var(--border)',
              flexShrink: 0,
              position: 'relative',
            }}
            title="Drag to resize"
          >
            <div style={{
              position: 'absolute', left: '50%', top: 0,
              transform: 'translateX(-50%)',
              width: 40, height: 2,
              background: 'var(--text-muted)',
              borderRadius: 1, opacity: 0.5,
            }} />
          </div>

          {/* Results table */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
            marginTop: 6,
          }}>
            {measurements.length > 0 ? (
              <table className="data-table">
                <thead>
                  <tr>
                    {['Series', 'Sweep', 'Rs (MΩ)', 'Rin (MΩ)', 'Cm (pF)', 'τ (ms)', 'R²'].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {measurements.map((row, i) => (
                    <tr key={i}
                      onClick={(ev) => measSel.onRowClick(i, ev)}
                      onContextMenu={(ev) => measCopyMenu.onContextMenu(ev, () => {
                        if (!measSel.isSelected(i)) measSel.setSelected([i])
                      })}
                      style={{
                        background: measSel.isSelected(i)
                          ? 'var(--accent-muted)'
                          : (i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)'),
                      }}>
                      <td style={{ fontFamily: 'var(--font-ui)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.series}>{row.series}</td>
                      <td>{row.sweep}</td>
                      <td>{fmt(row.rs, 1, '')}</td>
                      <td>{fmt(row.rin, 1, '')}</td>
                      <td>{fmt(row.cm, 1, '')}</td>
                      <td>{fmt(row.tau, 2, '')}</td>
                      <td>{row.fit_r_squared != null ? row.fit_r_squared.toFixed(3) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: 12, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 'var(--font-size-xs)' }}>
                Results accumulate here as you run analyses.
              </div>
            )}
            {measCopyMenu.menu}
          </div>
        </div>{/* close RIGHT panel */}
      </div>{/* close two-column body */}
    </div>
  )
}

/** Small label / child wrapper used in the top selector row so
 *  Group / Series / Channel / Sweep all lay out the same way across
 *  analysis windows. The span gets ``className="selector-label"`` so
 *  the global selector-label style (muted colour) picks it up. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label"
        style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}
