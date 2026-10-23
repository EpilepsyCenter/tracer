import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, BurstRecord, FieldBurstsData, FieldBurstsParams } from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { TrainOptions, defaultTrainParamsFor } from './TrainOptions'
import { TrainSummary, TrainParams } from '../../utils/trains'
import { computeBurstTrainIds } from '../../utils/burstTrains'
import { usePlotMenu } from '../common/PlotMenu'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'
import { sampleTraceYAt } from '../../utils/sampleTraceY'

/** Burst marker colours as theme tokens. Canvas code resolves them
 *  with ``cssVar`` at draw time; the legend uses ``var(...)``. */
const MARKER_COLORS = {
  baseline: '--text-muted',
  peak: '--marker-detected',
  decay: '--warning',
  end: '--success',
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

type Method = 'threshold' | 'oscillation' | 'isi'
type BaselineMode = 'percentile' | 'robust' | 'rolling' | 'fixed_start'

/** Default params per method + baseline mode. Centralized so the form can
 *  reset cleanly when the user switches methods. */
/** Shared filter + noise defaults applied to every method. Epileptiform
 *  recordings typically want a 1–50 Hz bandpass to kill drift + HF noise
 *  before detection; this also makes the SD-based noise estimate tight. */
const FILTER_NOISE_DEFAULTS = {
  filter_enabled: true,
  filter_type: 'bandpass' as const,
  filter_low: 1,
  filter_high: 50,
  filter_order: 4,
  noise_method: 'sd' as const,  // classical SD; user can switch to MAD
}

function defaultParamsFor(method: Method, baseline_mode: BaselineMode): FieldBurstsParams {
  if (method === 'threshold') {
    return {
      method, baseline_mode,
      ...FILTER_NOISE_DEFAULTS,
      n_sd: 2.0,
      smooth_ms: 10,
      min_duration_ms: 50,
      min_gap_ms: 100,
      baseline_percentile: 10,
      baseline_window_s: 5,
      baseline_end_s: 1,
      pre_burst_window_ms: 100,
      peak_direction: 'auto',
    }
  }
  if (method === 'oscillation') {
    return {
      method, baseline_mode,
      // Oscillation method has its own bandpass; pre-filter off by default.
      ...FILTER_NOISE_DEFAULTS,
      filter_enabled: false,
      low_freq: 4,
      high_freq: 30,
      n_sd: 2.0,
      smooth_ms: 50,
      min_duration_ms: 100,
      min_gap_ms: 200,
      baseline_percentile: 10,
      baseline_window_s: 5,
      baseline_end_s: 1,
      pre_burst_window_ms: 100,
      peak_direction: 'auto',
    }
  }
  // isi
  return {
    method, baseline_mode: 'percentile',
    ...FILTER_NOISE_DEFAULTS,
    spike_threshold: 0,  // 0 = auto (MAD-based)
    min_spike_dist_ms: 2,
    max_isi_ms: 100,
    min_spikes_per_burst: 3,
    pre_burst_window_ms: 100,
    peak_direction: 'auto',
  }
}

/** One row for the Nth recorded channel of the selected series. */
function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

export function FieldBurstWindow({
  backendUrl,
  fileInfo,
  currentSweep,
  mainGroup,
  mainSeries,
  mainTrace,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  currentSweep: number
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
}) {
  const {
    fieldBursts,
    burstFormParams, setBurstFormParams,
    trainParams,
    runFieldBurstsOnSweep, runFieldBurstsOnSeries,
    clearFieldBursts, selectFieldBurst, exportFieldBurstsCSV,
    exportFieldBurstTrainsCSV,
    addManualBurst, removeBurstAt,
    loading, error, setError,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // Selections. Start from the main window's current selection on first
  // mount; afterwards the user can change them here without being
  // hijacked by further main-window navigation.
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [channel, setChannel] = useState(mainTrace ?? 0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])
  // Local form state. Initially seeded from the store's persisted
  // per-series `burstFormParams` if already present (e.g. the main
  // window hydrated prefs before this window mounted); otherwise
  // defaults with filter fields inherited from the main viewer. A
  // useEffect below rehydrates again whenever the user switches
  // (group, series) or the persisted blob arrives asynchronously via
  // a BroadcastChannel state-update.
  const initialKey = `${mainGroup ?? 0}:${mainSeries ?? 0}`
  const initialStored = useAppStore.getState().burstFormParams[initialKey]
  const [method, setMethod] = useState<Method>(
    (initialStored?.method as Method | undefined) ?? 'threshold',
  )
  const [baselineMode, setBaselineMode] = useState<BaselineMode>(
    (initialStored?.baseline_mode as BaselineMode | undefined) ?? 'percentile',
  )
  const [params, setParams] = useState<FieldBurstsParams>(() => {
    if (initialStored) return initialStored
    // Seed filter fields from the main viewer if main has a filter
    // currently enabled — matches the behaviour of the other analysis
    // windows. If main's filter is off, keep the burst-default bandpass
    // so new users get sensible detection out of the box.
    const defaults = defaultParamsFor('threshold', 'percentile')
    const mf = useAppStore.getState().filter
    if (mf.enabled) {
      return {
        ...defaults,
        filter_enabled: true,
        filter_type: mf.type,
        filter_low: mf.lowCutoff,
        filter_high: mf.highCutoff,
        filter_order: mf.order,
      }
    }
    return defaults
  })

  // Splitters — both persist to Electron prefs under burstWindowUI so
  // the layout survives window reopens. Same recipe as AP/FPsp/IV/
  // Resistance. Hydrate on mount, write on mouseup only.
  const [miniHeight, setMiniHeight] = useState(340)
  const [leftPanelWidth, setLeftPanelWidth] = useState(320)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const ui = prefs?.burstWindowUI
        if (cancelled || !ui) return
        if (typeof ui.leftPanelWidth === 'number'
            && ui.leftPanelWidth >= 200 && ui.leftPanelWidth <= 500) {
          setLeftPanelWidth(ui.leftPanelWidth)
        }
        if (typeof ui.miniHeight === 'number'
            && ui.miniHeight >= 150 && ui.miniHeight <= 800) {
          setMiniHeight(ui.miniHeight)
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
      const next = { ...(prefs.burstWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, burstWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = miniHeight
    let latest = startH
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      latest = Math.max(150, Math.min(800, startH + dy))
      setMiniHeight(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeUIPref({ miniHeight: latest })
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

  // Unified Sweeps-scope dropdown. Burst detection supports only two
  // scopes (single sweep vs the whole series) — no "range" option,
  // since the backend doesn't take a sweep-subset for this analysis.
  type RunMode = 'all' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const [sweepOne, setSweepOne] = useState(1)

  // Rehydrate the form from the store's per-series blob whenever we
  // "land on" a (group, series) pair that has saved params. Matches the
  // FPspWindow pattern — keyed by `${group}:${series}` with a ref that
  // tracks which key we've already rehydrated so we don't clobber
  // subsequent user edits. Fires when the stored blob becomes available
  // asynchronously too (e.g. the first `state-update` broadcast arrives
  // after this window has already rendered once).
  const formKey = `${group}:${series}`
  const storedForm = burstFormParams[formKey]
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!storedForm) return
    if (rehydratedKeyRef.current === formKey) return
    rehydratedKeyRef.current = formKey
    const m = (storedForm.method as Method | undefined) ?? 'threshold'
    const bm = (storedForm.baseline_mode as BaselineMode | undefined) ?? 'percentile'
    setMethod(m)
    setBaselineMode(bm)
    setParams(storedForm)
  }, [storedForm, formKey])

  // Wrapped setters: persist every form edit to the store (which the
  // main-window subscribe then writes to disk, and every other open
  // window picks up via broadcast). Changing method / baseline-mode
  // also resets params to the defaults for that combination, matching
  // the old useEffect-based behaviour but without the race against
  // rehydration.
  const commitForm = useCallback((
    m: Method, bm: BaselineMode, p: FieldBurstsParams,
  ) => {
    // Rehydration has happened (or will happen and supersede) for this
    // key. Mark it so the rehydration effect won't overwrite the user's
    // fresh edits on the next render.
    rehydratedKeyRef.current = formKey
    setBurstFormParams(group, series, p)
  }, [formKey, group, series, setBurstFormParams])

  const onMethodChange = useCallback((m: Method) => {
    const next = defaultParamsFor(m, baselineMode)
    setMethod(m)
    setParams(next)
    commitForm(m, baselineMode, next)
  }, [baselineMode, commitForm])

  const onBaselineModeChange = useCallback((bm: BaselineMode) => {
    const next = defaultParamsFor(method, bm)
    setBaselineMode(bm)
    setParams(next)
    commitForm(method, bm, next)
  }, [method, commitForm])

  // Reset group/series if the file changes and the previous indices are gone.
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])

  // Reset channel if the previous one no longer exists.
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])

  const key = `${group}:${series}`
  const entry = fieldBursts[key]

  // Train-grouping (Easy-Electrophysiology-style cluster of closely
  // spaced bursts). Pure derivation: read params from the store, walk
  // bursts per-sweep (never cross sweep boundaries — different trials),
  // compute clusters, hand both the per-burst train_id and the per-
  // sweep summary list back to the overlay + tables. Manual edits to
  // ``entry.bursts`` invalidate the memo automatically.
  const storedTrainParams = trainParams.bursts[key] as
    | (TrainParams & { enabled?: boolean })
    | undefined
  const effectiveTrainParams = storedTrainParams ?? defaultTrainParamsFor('bursts')
  const trainsEnabled = effectiveTrainParams.enabled === true
  const trainData = useMemo(
    () => computeBurstTrainIds(
      entry?.bursts ?? [],
      { ...effectiveTrainParams, enabled: trainsEnabled },
    ),
    [entry?.bursts, trainsEnabled, effectiveTrainParams.metric,
      effectiveTrainParams.maxIeiMs, effectiveTrainParams.minCount,
      effectiveTrainParams.minDurationMs, effectiveTrainParams.minInterTrainMs],
  )

  // ---- Sweep preview + viewport state for the new central viewer ----
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  const [previewSweep, setPreviewSweep] = useState(currentSweep)
  // On first mount, sync from the main-window sweep; after that let the
  // user scroll independently here.
  const mainSyncedRef = useRef(false)
  useEffect(() => {
    if (mainSyncedRef.current) return
    mainSyncedRef.current = true
    setPreviewSweep(currentSweep)
  }, [currentSweep])
  // Clamp when the series changes.
  const lastSeriesKeyRef = useRef(`${group}:${series}`)
  useEffect(() => {
    const k = `${group}:${series}`
    if (lastSeriesKeyRef.current === k) return
    lastSeriesKeyRef.current = k
    setPreviewSweep((s) => Math.max(0, Math.min(s, totalSweeps - 1)))
  }, [group, series, totalSweeps])

  /** Viewport state for the central viewer. Default window is 10 s so
   *  the first fetch stays cheap on long sweeps. `null` is reserved
   *  for the Reset-zoom action (which defers to the viewer's own
   *  default-10s-or-full-sweep logic based on the known duration).
   *  Clicking a table row zooms the viewer to that burst ±200 ms. */
  const [viewport, setViewport] = useState<{ tStart: number; tEnd: number } | null>(
    { tStart: 0, tEnd: 10 },
  )
  // Reset to default 10 s on sweep change so the user isn't
  // surprised by a random window on a new sweep.
  useEffect(() => {
    setViewport({ tStart: 0, tEnd: 10 })
  }, [previewSweep])

  // Zero-offset toggle for the mini-viewer — subtracts a per-sweep
  // baseline (first ~3 ms) so drifting DC doesn't push the trace off
  // screen between sweeps. Matches the toggle in every other analysis
  // window. Does not affect detection; detection always runs on the
  // raw signal server-side.
  const [zeroOffset, setZeroOffset] = useState(false)

  const onParamChange = (name: string, value: number) => {
    setParams((p) => {
      const next = { ...p, [name]: value }
      commitForm(method, baselineMode, next)
      return next
    })
  }
  const onParamChangeRaw = (name: string, value: string | boolean) => {
    setParams((p) => {
      const next = { ...p, [name]: value }
      commitForm(method, baselineMode, next)
      return next
    })
  }

  const onRun = () => {
    if (runMode === 'all') {
      runFieldBurstsOnSeries(group, series, channel, params)
    } else {
      const idx = Math.max(0, Math.min(totalSweeps - 1, sweepOne - 1))
      runFieldBurstsOnSweep(group, series, idx, channel, params)
    }
  }

  const onSelectRow = (idx: number) => {
    selectFieldBurst(group, series, idx)
    const b = entry?.bursts[idx]
    if (b) {
      // Pan the viewer to the clicked burst with 1 s of context on
      // each side. Also snap the preview sweep to the burst's sweep so
      // the trace fetch targets the right data.
      setPreviewSweep(b.sweepIndex)
      setViewport({
        tStart: Math.max(0, b.startS - 1.0),
        tEnd: b.endS + 1.0,
      })
    }
  }

  /** Left-click on the sweep viewer → add a manual burst at that time. */
  const onAddManualBurst = useCallback(async (timeS: number) => {
    try {
      const resp = await fetch(`${backendUrl}/api/bursts/measure_at`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group, series, sweep: previewSweep, trace: channel,
          time_s: timeS, params,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'measure_at failed' }))
        setError(err.detail || 'measure_at failed')
        return
      }
      const b = await resp.json()
      // Translate backend-snake-case to frontend shape.
      const burst: BurstRecord = {
        sweepIndex: Number(b.sweep_index ?? 0),
        startS: Number(b.start_s ?? 0),
        endS: Number(b.end_s ?? 0),
        durationMs: Number(b.duration_ms ?? 0),
        peakAmplitude: Number(b.peak_amplitude ?? 0),
        peakSigned: Number(b.peak_signed ?? 0),
        peakTimeS: Number(b.peak_time_s ?? 0),
        meanAmplitude: Number(b.mean_amplitude ?? 0),
        integral: Number(b.integral ?? 0),
        riseTime10_90Ms: b.rise_time_10_90_ms != null ? Number(b.rise_time_10_90_ms) : null,
        decayHalfTimeMs: b.decay_half_time_ms != null ? Number(b.decay_half_time_ms) : null,
        preBurstBaseline: Number(b.pre_burst_baseline ?? 0),
        meanFrequencyHz: b.mean_frequency_hz != null ? Number(b.mean_frequency_hz) : null,
        manual: true,
      }
      addManualBurst(group, series, burst)
    } catch (err: any) {
      setError(err.message ?? String(err))
    }
  }, [backendUrl, group, series, previewSweep, channel, params, addManualBurst, setError])

  /** Right-click / double-click on a burst → remove it. */
  const onRemoveBurstAt = useCallback((timeS: number) => {
    removeBurstAt(group, series, previewSweep, timeS)
  }, [group, series, previewSweep, removeBurstAt])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: 10,
      gap: 10,
      minHeight: 0,
    }}>
      {/* Top bar: scoping selectors only (Group/Series/Channel/Sweep).
          Method + Baseline live in the LEFT panel now. */}
      <TopBar
        fileInfo={fileInfo}
        group={group} setGroup={setGroup}
        series={series} setSeries={setSeries}
        channels={channels} channel={channel} setChannel={setChannel}
        previewSweep={previewSweep} setPreviewSweep={setPreviewSweep}
        totalSweeps={totalSweeps}
      />

      {/* Main body: two-column flex. LEFT = params column (scrollable
          with Run controls pinned to its bottom); RIGHT = viewer +
          results. Same layout as APWindow/FPspWindow/IVCurveWindow/
          ResistanceWindow. */}
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
              sit outside the scrollable so they're always visible. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,
          }}>
            {/* Method + Baseline-mode dropdowns. These two drive which
                params show in ParamsForm below, so they live at the
                top of the left panel. */}
            <div className="section-card">
              <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)', gap: 2 }}>
                <span style={{ color: 'var(--text-muted)' }}>Method</span>
                <select value={method} onChange={(e) => onMethodChange(e.target.value as Method)}>
                  <option value="threshold">Threshold</option>
                  <option value="oscillation">Oscillation envelope</option>
                  <option value="isi">ISI clustering</option>
                </select>
              </label>
              {method !== 'isi' && (
                <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)', gap: 2 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Baseline</span>
                  <select value={baselineMode} onChange={(e) => onBaselineModeChange(e.target.value as BaselineMode)}>
                    <option value="percentile">Percentile (default)</option>
                    <option value="robust">Robust (median + MAD)</option>
                    <option value="rolling">Rolling median</option>
                    <option value="fixed_start">Fixed start</option>
                  </select>
                </label>
              )}
            </div>

            {/* Params form */}
            <ParamsForm
              method={method}
              baselineMode={baselineMode}
              params={params}
              onChange={onParamChange}
              onChangeRaw={onParamChangeRaw}
            />

            {/* Post-detection: optional grouping of closely-spaced
                bursts into trains. Off by default; results derive
                live from the bursts list, so manual add/remove
                rebuilds train assignments without re-running
                detection. ``min_gap_ms`` from the detection params
                drives the warning floor: any IEI smaller than that
                is meaningless because adjacent bursts under that
                threshold were already merged upstream. */}
            <TrainOptions
              module="bursts"
              group={group}
              series={series}
              hostMergeFloorMs={typeof params.min_gap_ms === 'number' ? params.min_gap_ms : undefined}
            />
          </div>

          {/* Pinned footer: Run + Sweeps dropdown (all/one), then
              secondary Clear + Export CSV below a separator. */}
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
                <option value="one">Single sweep</option>
              </select>
            </div>
            {runMode === 'one' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                <span>Sweep</span>
                <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span style={{ marginLeft: 'auto' }}>/ {totalSweeps || '—'}</span>
              </div>
            )}
            {/* Secondary actions — smaller, visually subordinate.
                "Export trains" lives next to its summary table (right
                pane) instead of here so the sidebar buttons don't get
                crammed. */}
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn"
                onClick={() => clearFieldBursts(group, series)} disabled={!entry}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={() => exportFieldBurstsCSV()}
                disabled={Object.keys(fieldBursts).length === 0}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Export CSV
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

        {/* RIGHT PANEL: viewer + horizontal splitter + summary strip + table. */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>
          <div style={{ height: miniHeight, minHeight: 150, flexShrink: 0 }}>
            <BurstSweepViewer
              backendUrl={backendUrl}
              entry={entry}
              liveParams={params}
              group={group}
              series={series}
              channel={channel}
              sweep={previewSweep}
              viewport={viewport}
              setViewport={setViewport}
              heightSignal={miniHeight}
              onAddBurst={onAddManualBurst}
              onRemoveBurst={onRemoveBurstAt}
              zeroOffset={zeroOffset}
              onZeroOffsetChange={setZeroOffset}
              theme={theme}
              fontSize={fontSize}
              trainsForSweep={trainData.summariesBySweep.get(previewSweep) ?? []}
            />
          </div>

          {/* Horizontal splitter — thin (3px hit / 2px grip). */}
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

          {/* Summary strip — baseline + threshold + signal diag. Sits
              right above the table so the "why did I get zero bursts"
              context is visually adjacent to the results. */}
          {entry && (
            <div style={{
              flexShrink: 0,
              fontSize: 'var(--font-size-label)',
              color: 'var(--text-muted)',
              background: 'var(--bg-secondary)',
              padding: '4px 8px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              marginTop: 6,
              lineHeight: 1.6,
            }}>
              <div className="num">
                <strong style={{ color: 'var(--text-primary)' }}>{entry.bursts.length}</strong> bursts
                {' · '}baseline = {entry.baselineValue.toFixed(3)}
                {entry.thresholdHigh != null && ` · thr ↑ ${entry.thresholdHigh.toFixed(3)}`}
                {entry.thresholdLow != null && ` · thr ↓ ${entry.thresholdLow.toFixed(3)}`}
              </div>
              {entry.diag && (
                <div className="num" style={{ color: 'var(--text-muted)' }}>
                  Signal: median {entry.diag.median.toFixed(3)}, MAD {entry.diag.mad.toFixed(3)},
                  range [{entry.diag.min.toFixed(3)}, {entry.diag.max.toFixed(3)}],
                  max |dev| {entry.diag.maxAbsDev.toFixed(3)} · {entry.diag.durationS.toFixed(1)} s
                  {' '}({entry.diag.nSamples.toString()} samples)
                </div>
              )}
              {entry.bursts.length === 0 && entry.diag && entry.thresholdHigh != null && (
                <div style={{ color: 'var(--accent)', fontStyle: 'italic' }}>
                  No bursts above threshold. Max |signal − baseline| = {Math.max(
                    Math.abs(entry.diag.max - entry.baselineValue),
                    Math.abs(entry.diag.min - entry.baselineValue),
                  ).toFixed(3)} · threshold at {Math.abs(entry.thresholdHigh - entry.baselineValue).toFixed(3)}.
                  Try lowering <code>n_sd</code>, switching baseline mode, or raising <code>baseline_percentile</code>.
                </div>
              )}
            </div>
          )}

          {/* Trains summary — only renders when train-grouping is on
              AND at least one cluster qualifies. Sits above the burst
              table so the higher-level grouping is the first thing the
              user sees after the trace. Header strip carries the
              count + Export CSV action so the sidebar isn't cramped
              by a third button. */}
          {trainsEnabled && trainData.flatSummaries.length > 0 && (
            <div style={{
              flexShrink: 0, marginTop: 6,
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 'var(--font-size-label)',
                color: 'var(--text-muted)',
                padding: '0 2px',
              }}>
                <span>
                  <strong style={{ color: 'var(--text-primary)' }}>
                    {trainData.flatSummaries.length}
                  </strong> trains
                </span>
                <button className="btn btn-sm"
                  onClick={() => exportFieldBurstTrainsCSV()}
                  style={{ marginLeft: 'auto' }}
                  title="Export per-train summary to CSV">
                  Export trains CSV
                </button>
              </div>
              <TrainSummaryTable trains={trainData.flatSummaries} />
            </div>
          )}

          {/* Burst table. */}
          <div style={{
            flex: 1, overflow: 'auto', minHeight: 0,
            marginTop: 6,
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          }}>
            <BurstTable
              bursts={entry?.bursts ?? []}
              selectedIdx={entry?.selectedIdx ?? null}
              onSelect={onSelectRow}
              trainIdByIdx={trainsEnabled ? trainData.idByGlobalIdx : null}
            />
          </div>
        </div>{/* close RIGHT panel */}
      </div>{/* close two-column body */}
    </div>
  )
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

function TopBar({
  fileInfo, group, setGroup, series, setSeries,
  channels, channel, setChannel,
  previewSweep, setPreviewSweep, totalSweeps,
}: {
  fileInfo: FileInfo | null
  group: number; setGroup: (n: number) => void
  series: number; setSeries: (n: number) => void
  channels: any[]; channel: number; setChannel: (n: number) => void
  previewSweep: number
  setPreviewSweep: React.Dispatch<React.SetStateAction<number>>
  totalSweeps: number
}) {
  const groups = fileInfo?.groups ?? []
  const seriesList = fileInfo?.groups?.[group]?.series ?? []

  // Only the scoping selectors (Group/Series/Channel/Sweep) live in
  // the top row. Method + Baseline-mode — which drive which params
  // show below — moved to the LEFT panel so the top row is consistent
  // across all analysis windows.
  return (
    <div style={{
      display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
      background: 'var(--bg-secondary)',
      padding: '6px 10px',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
    }}>
      <Field label="Group">
        <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
          {groups.map((g: any, i: number) => (
            <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
          ))}
        </select>
      </Field>
      <Field label="Series">
        <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
          {seriesList.map((s: any, i: number) => (
            <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
          ))}
        </select>
      </Field>
      <Field label="Channel">
        <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={channels.length === 0}>
          {channels.map((c: any) => (
            <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
          ))}
        </select>
      </Field>
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
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function ParamsForm({
  method, baselineMode, params, onChange, onChangeRaw,
}: {
  method: Method
  baselineMode: BaselineMode
  params: FieldBurstsParams
  onChange: (name: string, v: number) => void
  onChangeRaw: (name: string, v: string | boolean) => void
}) {
  const p = (k: string) => Number(params[k] ?? 0)
  const filterEnabled = Boolean(params.filter_enabled)
  const noiseMethod = String(params.noise_method ?? 'sd')
  const filterType = String(params.filter_type ?? 'bandpass')
  const peakDirection = String(params.peak_direction ?? 'auto')

  return (
    <div className="section-card">
      {/* --- Pre-detection filter --- */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input
            type="checkbox"
            checked={filterEnabled}
            onChange={(e) => onChangeRaw('filter_enabled', e.target.checked)}
          />
          <span style={{ fontWeight: 600 }}>Pre-detection filter</span>
        </label>
        {filterEnabled && (
          <>
            <select
              value={filterType}
              onChange={(e) => onChangeRaw('filter_type', e.target.value)}
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <option value="bandpass">Bandpass</option>
              <option value="lowpass">Lowpass</option>
              <option value="highpass">Highpass</option>
            </select>
            {(filterType === 'highpass' || filterType === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Low</span>
                <NumInput value={p('filter_low')} step={0.1} min={0}
                  onChange={(v) => onChange('filter_low', v)}
                  style={{ width: 60 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            {(filterType === 'lowpass' || filterType === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>High</span>
                <NumInput value={p('filter_high')} step={1} min={1}
                  onChange={(v) => onChange('filter_high', v)}
                  style={{ width: 60 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Order</span>
              <NumInput value={p('filter_order')} step={1} min={1} max={8}
                onChange={(v) => onChange('filter_order', Math.max(1, Math.min(8, Math.round(v))))}
                style={{ width: 40 }} />
            </label>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)', marginLeft: 'auto' }}>
          <span style={{ color: 'var(--text-muted)' }}>Noise</span>
          <select
            value={noiseMethod}
            onChange={(e) => onChangeRaw('noise_method', e.target.value)}
            style={{ fontSize: 'var(--font-size-label)' }}
            title="SD: classical standard deviation. MAD: robust to outliers. MAD-diff: robust to outliers AND drift."
          >
            <option value="sd">SD</option>
            <option value="mad">MAD</option>
            <option value="mad_diff">MAD-diff</option>
          </select>
        </label>
      </div>

      {/* --- Method + baseline knobs --- */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 6,
        borderTop: '1px solid var(--border)',
        paddingTop: 6,
      }}>
      {/* Method-specific knobs */}
      {(method === 'threshold' || method === 'oscillation') && (
        <>
          <ParamRow label="n_sd" value={p('n_sd')} step={0.1} min={0}
            onChange={(v) => onChange('n_sd', v)} />
          <ParamRow label="Smooth (ms)" value={p('smooth_ms')} step={1} min={1}
            onChange={(v) => onChange('smooth_ms', v)} />
          <ParamRow label="Min dur (ms)" value={p('min_duration_ms')} step={1} min={1}
            onChange={(v) => onChange('min_duration_ms', v)} />
          <ParamRow label="Min gap (ms)" value={p('min_gap_ms')} step={1} min={0}
            onChange={(v) => onChange('min_gap_ms', v)} />
        </>
      )}
      {method === 'oscillation' && (
        <>
          <ParamRow label="Band low (Hz)" value={p('low_freq')} step={1} min={0}
            onChange={(v) => onChange('low_freq', v)} />
          <ParamRow label="Band high (Hz)" value={p('high_freq')} step={1} min={1}
            onChange={(v) => onChange('high_freq', v)} />
        </>
      )}
      {method === 'isi' && (
        <>
          <ParamRow label="Spike thr (abs)" value={p('spike_threshold')} step={0.1} min={0}
            onChange={(v) => onChange('spike_threshold', v)} />
          <ParamRow label="Min dist (ms)" value={p('min_spike_dist_ms')} step={0.1} min={0}
            onChange={(v) => onChange('min_spike_dist_ms', v)} />
          <ParamRow label="Max ISI (ms)" value={p('max_isi_ms')} step={1} min={1}
            onChange={(v) => onChange('max_isi_ms', v)} />
          <ParamRow label="Min spikes/burst" value={p('min_spikes_per_burst')} step={1} min={2}
            onChange={(v) => onChange('min_spikes_per_burst', Math.max(2, Math.round(v)))} />
        </>
      )}

      {/* Baseline-mode-specific knobs */}
      {method !== 'isi' && baselineMode === 'percentile' && (
        <ParamRow label="Percentile (%)" value={p('baseline_percentile')} step={1} min={0} max={100}
          onChange={(v) => onChange('baseline_percentile', Math.max(0, Math.min(100, v)))} />
      )}
      {method !== 'isi' && baselineMode === 'rolling' && (
        <ParamRow label="Window (s)" value={p('baseline_window_s')} step={0.5} min={0.1}
          onChange={(v) => onChange('baseline_window_s', v)} />
      )}
      {method !== 'isi' && baselineMode === 'fixed_start' && (
        <ParamRow label="Baseline end (s)" value={p('baseline_end_s')} step={0.1} min={0.01}
          onChange={(v) => onChange('baseline_end_s', v)} />
      )}

      {/* Pre-burst baseline window — applies to all methods (per-burst
          amplitude is computed as |signal − mean(pre-burst window)|). */}
      <ParamRow
        label="Pre-burst (ms)"
        value={p('pre_burst_window_ms')}
        step={10} min={1}
        onChange={(v) => onChange('pre_burst_window_ms', v)}
      />

      {/* Peak direction — "auto" picks the sample with the largest |Δ|,
          keeping the sign. "positive" / "negative" force that direction,
          which matters for spike-and-wave epileptiform events where a
          short initial downward spike is followed by a larger upward
          wave — pick "positive" to place the peak on the wave. */}
      <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
        <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Peak direction</span>
        <select
          value={peakDirection}
          onChange={(e) => onChangeRaw('peak_direction', e.target.value)}
        >
          <option value="auto">Auto (|max dev|)</option>
          <option value="positive">Positive</option>
          <option value="negative">Negative</option>
        </select>
      </label>
      </div>{/* /method knobs grid */}
    </div>
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

/** Central "continuous-style" sweep viewer for the Burst Detection
 *  window. Replaces the old selected-burst mini-viewer with a viewport
 *  over the whole sweep, peak/baseline/decay/end dots for EVERY burst,
 *  and left-click-to-add / right-click (or double-click) -to-remove
 *  manual-edit hooks. Clicking a row in the burst table below pans the
 *  viewport to centre that burst via the controlled `viewport` prop. */
function BurstSweepViewer({
  backendUrl, entry, liveParams, group, series, channel, sweep,
  viewport, setViewport, heightSignal,
  onAddBurst, onRemoveBurst,
  zeroOffset, onZeroOffsetChange,
  theme, fontSize,
  trainsForSweep,
}: {
  backendUrl: string
  entry: FieldBurstsData | undefined
  /** Live params from the form (as opposed to `entry.params`, which
   *  are frozen at the time of the last detection run). Drives the
   *  filter applied to the DISPLAYED trace so toggling the checkbox
   *  shows the effect immediately. */
  liveParams: FieldBurstsParams
  group: number
  series: number
  channel: number
  sweep: number
  viewport: { tStart: number; tEnd: number } | null
  setViewport: React.Dispatch<React.SetStateAction<{ tStart: number; tEnd: number } | null>>
  heightSignal?: number
  onAddBurst: (timeS: number) => void
  onRemoveBurst: (timeS: number) => void
  /** Subtract per-sweep baseline server-side before sending samples. */
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  theme: string
  fontSize: number
  /** Trains computed for the currently previewed sweep. Drawn as
   *  translucent shaded spans behind the burst markers; empty array
   *  when train-grouping is disabled or there are no qualifying
   *  clusters in this sweep. */
  trainsForSweep: TrainSummary[]
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu: onBurstContextMenu, menu: burstPlotMenu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'burst-trace',
  })
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // Index (within ``sweepBursts``) of the burst the user clicked first
  // and is awaiting confirmation to delete. Mirrors the AP / Events
  // prime+reclick flow. Reset on sweep change so an unconfirmed prime
  // doesn't carry across sweeps.
  const primedRemoveIdxRef = useRef<number | null>(null)
  useEffect(() => { primedRemoveIdxRef.current = null }, [sweep])

  // Bursts on THIS sweep. Everything else (other sweeps' bursts) is
  // invisible here — they belong to a different trace.
  const sweepBursts = useMemo(
    () => (entry?.bursts ?? []).filter((b) => b.sweepIndex === sweep),
    [entry?.bursts, sweep],
  )

  const [data, setData] = useState<{
    time: Float64Array; values: Float64Array; sweepDurationS: number
    /** Baseline subtracted server-side when `zero_offset=true`. Needed
     *  to shift burst markers (which carry RAW signal y values) so they
     *  stay aligned with the visibly DC-shifted trace. 0 when off. */
    zeroOffsetApplied: number
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Sweep trace fetch. Uses LIVE form params for the filter so the
  // user sees the effect of toggling the filter immediately (and
  // before running detection for the first time). Range comes from
  // the viewport prop; null means "let the backend default to the
  // full sweep" — we avoid that on initial mount by seeding viewport
  // to [0, 10] s in the parent.
  useEffect(() => {
    if (!backendUrl) { setData(null); return }
    const p = liveParams as Record<string, any>
    const parts: string[] = [
      `group=${group}`, `series=${series}`, `sweep=${sweep}`,
      `trace=${channel}`, `max_points=4000`,
    ]
    if (viewport) {
      parts.push(`t_start=${viewport.tStart}`)
      parts.push(`t_end=${viewport.tEnd}`)
    }
    if (p.filter_enabled) {
      parts.push(`filter_type=${p.filter_type ?? 'bandpass'}`)
      if (p.filter_low != null) parts.push(`filter_low=${p.filter_low}`)
      if (p.filter_high != null) parts.push(`filter_high=${p.filter_high}`)
      if (p.filter_order != null) parts.push(`filter_order=${p.filter_order}`)
    }
    if (zeroOffset) parts.push('zero_offset=true')
    const url = `${backendUrl}/api/traces/data?${parts.join('&')}`
    let cancelled = false
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        const n = Number(d.n_samples ?? 0)
        const sr = Number(d.sampling_rate ?? 1)
        const sweepDurationS = sr > 0 ? n / sr : Number(d.duration ?? 0)
        setData({
          time: new Float64Array(d.time ?? []),
          values: new Float64Array(d.values ?? []),
          sweepDurationS,
          zeroOffsetApplied: Number(d.zero_offset ?? 0),
        })
        setErr(null)
      })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [backendUrl, group, series, channel, sweep, viewport, liveParams, zeroOffset])

  // (Re)build the plot whenever the data changes. Mirrors the pattern
  // we now use in every other analysis window (Cursor/Resistance/IV/
  // FPsp) — rebuild-on-data, not setData-on-data, which avoided a
  // subtle stale-frame bug in one of those earlier.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || data.time.length === 0) return

    const opts: uPlot.Options = {
      width: container.clientWidth || 400,
      height: Math.max(120, container.clientHeight || 180),
      scales: { x: { time: false }, y: {} },
      // Hide uPlot's top legend — the header row already shows sweep
      // number, burst count, etc., and the "Time / Value / Trace"
      // pills uPlot draws by default just add noise.
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        { stroke: cssVar('--trace-color-1'), width: 1.25, points: { show: false } },
      ],
      hooks: {
        draw: [() => drawBurstOverlay(
          plotRef.current, overlayRef.current, entry, sweepBursts,
          data.zeroOffsetApplied,
          primedRemoveIdxRef.current,
          trainsForSweep,
        )],
      },
    }
    const payload: uPlot.AlignedData = [Array.from(data.time), Array.from(data.values)]
    const attachTip = attachHoverCoords(opts)
    plotRef.current = new uPlot(opts, payload, container)
    attachTip(container)
    drawBurstOverlay(
      plotRef.current, overlayRef.current, entry, sweepBursts,
      data.zeroOffsetApplied,
      primedRemoveIdxRef.current,
      trainsForSweep,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, themeKey])

  // Redraw overlays when the burst list or entry thresholds change
  // without a fresh fetch (e.g. manual add/remove on the same view).
  useEffect(() => {
    drawBurstOverlay(
      plotRef.current, overlayRef.current, entry, sweepBursts,
      data?.zeroOffsetApplied ?? 0,
      primedRemoveIdxRef.current,
      trainsForSweep,
    )
  }, [entry, sweepBursts, trainsForSweep, theme, fontSize, data])

  // Imperative redraw after a click toggles the primed index. Avoids
  // adding the ref to a useEffect dep list (refs aren't reactive).
  const redrawOverlay = useCallback(() => {
    drawBurstOverlay(
      plotRef.current, overlayRef.current, entry, sweepBursts,
      data?.zeroOffsetApplied ?? 0,
      primedRemoveIdxRef.current,
      trainsForSweep,
    )
  }, [entry, sweepBursts, trainsForSweep, data])

  // Keep uPlot sized to its container — ResizeObserver + parent
  // heightSignal (splitter drag) + window resize.
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
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  // ---- Interactions: wheel = zoom X viewport, ⌥-wheel = zoom Y,
  // drag empty = pan. Left-click = add burst. Right-click / dblclick
  // near a burst = remove. Keyboard: PgUp/PgDn = ±viewport-width
  // jumps, Home/End, ←/→ = small nudges.
  const pxToTimeRef = useRef<(px: number) => number>(() => 0)
  useEffect(() => {
    const container = containerRef.current
    const u = plotRef.current
    if (!container || !u || !data) return
    const over = container.querySelector<HTMLDivElement>('.u-over')
    if (!over) return

    const xToPx = (x: number) => u.valToPos(x, 'x', false)
    const pxToX = (px: number) => u.posToVal(px, 'x')
    pxToTimeRef.current = pxToX

    const effectiveViewport = (): { tStart: number; tEnd: number } => {
      if (viewport) return viewport
      return { tStart: 0, tEnd: data.sweepDurationS || data.time[data.time.length - 1] }
    }

    type Drag = {
      kind: 'maybe-pan'
      startPxX: number; startPxY: number
      vpStart: number; vpEnd: number
      panning: boolean
    }
    let dragState: Drag | null = null
    const DRAG_THRESHOLD_PX = 3
    const MARKER_HIT_PX = 10

    // Hit-test against burst peak dots only — start / decay / end
    // markers stay visible but aren't click targets, so the user has
    // a single deterministic prime location per burst (matches the
    // AP and Events flows).
    const findBurstHit = (pxX: number, pxY: number): number | null => {
      const tt = u.data[0] as unknown as number[]
      const tv = u.data[1] as unknown as number[]
      const yOffset = data?.zeroOffsetApplied ?? 0
      let best = -1, bestD = Infinity
      for (let i = 0; i < sweepBursts.length; i++) {
        const b = sweepBursts[i]
        const sampled = sampleTraceYAt(tt, tv, b.peakTimeS)
        const yUse = sampled != null
          ? sampled
          : (b.preBurstBaseline + b.peakSigned - yOffset)
        const mx = u.valToPos(b.peakTimeS, 'x', false)
        const my = u.valToPos(yUse, 'y', false)
        const d = Math.hypot(mx - pxX, my - pxY)
        if (d < bestD && d < MARKER_HIT_PX) { best = i; bestD = d }
      }
      return best >= 0 ? best : null
    }

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return // right-click falls through to PlotMenu
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      // Priority 1: burst peak hit → prime / confirm-remove. Mirrors
      // the AP and Events prime+reclick gesture; the actual delete
      // happens here on the second click of the same primed marker.
      const hit = findBurstHit(pxX, pxY)
      if (hit != null) {
        if (primedRemoveIdxRef.current === hit) {
          const peakT = sweepBursts[hit].peakTimeS
          primedRemoveIdxRef.current = null
          onRemoveBurst(peakT)
        } else {
          primedRemoveIdxRef.current = hit
          redrawOverlay()
        }
        ev.preventDefault()
        return
      }
      // Priority 2: empty space → click-or-pan. X-only pan; the y
      // scale is left to auto-fit (a pre-detection bandpass keeps
      // traces centred around 0, so manual y panning isn't needed
      // here — Fit Y handles odd cases).
      const v = effectiveViewport()
      dragState = {
        kind: 'maybe-pan',
        startPxX: pxX, startPxY: pxY,
        vpStart: v.tStart, vpEnd: v.tEnd,
        panning: false,
      }
      over.setPointerCapture(ev.pointerId)
    }

    const onPointerMove = (ev: PointerEvent) => {
      if (!dragState) return
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const dxPx = pxX - dragState.startPxX
      const dyPx = pxY - dragState.startPxY
      if (!dragState.panning &&
          (Math.abs(dxPx) > DRAG_THRESHOLD_PX || Math.abs(dyPx) > DRAG_THRESHOLD_PX)) {
        dragState.panning = true
        over.style.cursor = 'grabbing'
      }
      if (!dragState.panning) return
      const vpW = dragState.vpEnd - dragState.vpStart
      const bboxW = u.bbox.width / (devicePixelRatio || 1)
      const dt = -(dxPx / bboxW) * vpW
      setViewport({
        tStart: dragState.vpStart + dt,
        tEnd: dragState.vpEnd + dt,
      })
    }

    const onPointerUp = (ev: PointerEvent) => {
      if (!dragState) return
      const clickCandidate = !dragState.panning
      dragState = null
      try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      over.style.cursor = ''
      if (clickCandidate) {
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const tClick = pxToX(pxX)
        // Empty-space click clears any pending prime — a deliberate
        // "no, don't delete that one" gesture — then ADDS a manual
        // burst at the click time.
        if (primedRemoveIdxRef.current != null) {
          primedRemoveIdxRef.current = null
          redrawOverlay()
        }
        if (isFinite(tClick)) onAddBurst(tClick)
      }
    }

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      const v = effectiveViewport()
      if (ev.altKey) {
        // Y zoom
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (yMin == null || yMax == null) return
        const yAtCur = u.posToVal(pxY, 'y')
        u.setScale('y', {
          min: yAtCur - (yAtCur - yMin) * factor,
          max: yAtCur + (yMax - yAtCur) * factor,
        })
      } else {
        const xAtCur = pxToX(pxX)
        const newStart = xAtCur - (xAtCur - v.tStart) * factor
        const newEnd = xAtCur + (v.tEnd - xAtCur) * factor
        setViewport({ tStart: newStart, tEnd: newEnd })
      }
    }

    over.addEventListener('pointerdown', onPointerDown)
    over.addEventListener('pointermove', onPointerMove)
    over.addEventListener('pointerup', onPointerUp)
    over.addEventListener('pointercancel', onPointerUp)
    over.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      over.removeEventListener('pointerdown', onPointerDown)
      over.removeEventListener('pointermove', onPointerMove)
      over.removeEventListener('pointerup', onPointerUp)
      over.removeEventListener('pointercancel', onPointerUp)
      over.removeEventListener('wheel', onWheel)
    }
  }, [data, viewport, setViewport, onAddBurst, onRemoveBurst, sweepBursts, redrawOverlay])

  // Keyboard navigation — active only when the viewer has focus.
  //   ←/→      = back/forward by one viewport width
  //   PgUp/Dn  = 3× viewport jumps (for skimming fast through long sweeps)
  //   Home/End = sweep start / sweep end
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (e: KeyboardEvent) => {
      if (!data) return
      const duration = data.sweepDurationS || (data.time[data.time.length - 1] ?? 0)
      const v = viewport ?? { tStart: 0, tEnd: duration }
      const w = v.tEnd - v.tStart
      const shift = (dt: number) => {
        const ns = Math.max(0, v.tStart + dt)
        const ne = Math.min(duration, ns + w)
        const clampedStart = Math.max(0, ne - w)
        setViewport({ tStart: clampedStart, tEnd: ne })
      }
      if (e.key === 'ArrowRight') { e.preventDefault(); shift(w) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); shift(-w) }
      else if (e.key === 'PageDown') { e.preventDefault(); shift(w * 3) }
      else if (e.key === 'PageUp') { e.preventDefault(); shift(-w * 3) }
      else if (e.key === 'Home') { e.preventDefault(); setViewport({ tStart: 0, tEnd: Math.min(duration, w) }) }
      else if (e.key === 'End') { e.preventDefault(); setViewport({ tStart: Math.max(0, duration - w), tEnd: duration }) }
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [data, viewport, setViewport])

  /** Shift the viewport by `deltaWidthsFactor × current width`. Clamps
   *  to [0, sweepDuration] without changing the viewport width. */
  const shiftViewport = (deltaWidthsFactor: number) => {
    if (!data) return
    const duration = data.sweepDurationS || (data.time[data.time.length - 1] ?? 0)
    const v = viewport ?? { tStart: 0, tEnd: Math.min(10, duration) }
    const w = v.tEnd - v.tStart
    let ns = v.tStart + w * deltaWidthsFactor
    ns = Math.max(0, Math.min(duration - w, ns))
    setViewport({ tStart: ns, tEnd: ns + w })
  }

  const goHome = () => {
    if (!data) return
    const duration = data.sweepDurationS || (data.time[data.time.length - 1] ?? 0)
    const v = viewport ?? { tStart: 0, tEnd: 10 }
    const w = v.tEnd - v.tStart
    setViewport({ tStart: 0, tEnd: Math.min(duration, w) })
  }
  const goEnd = () => {
    if (!data) return
    const duration = data.sweepDurationS || (data.time[data.time.length - 1] ?? 0)
    const v = viewport ?? { tStart: 0, tEnd: 10 }
    const w = v.tEnd - v.tStart
    setViewport({ tStart: Math.max(0, duration - w), tEnd: duration })
  }

  const manualCount = sweepBursts.filter((b) => b.manual).length

  /** Fit Y = re-autoscale Y to the currently-visible data. X is
   *  driven by the viewport preset buttons, so leave it alone (the
   *  user just picked a width — resetting it would override that).
   *  Finds the min/max of the samples inside the current viewport
   *  and applies a small pad so the trace doesn't clip.
   *
   *  Same name + behaviour as the Events miniviewer's Fit Y so the
   *  gesture is consistent across windows. */
  const fitYNow = () => {
    const u = plotRef.current
    if (!u || !data || data.time.length === 0) return
    const v = viewport ?? { tStart: 0, tEnd: data.sweepDurationS }
    let ymin = Infinity, ymax = -Infinity
    for (let i = 0; i < data.time.length; i++) {
      const t = data.time[i]
      if (t < v.tStart) continue
      if (t > v.tEnd) break
      const y = data.values[i]
      if (y < ymin) ymin = y
      if (y > ymax) ymax = y
    }
    if (!isFinite(ymin) || !isFinite(ymax) || ymin === ymax) {
      // Fallback: autoscale from the whole buffer.
      for (const y of data.values) { if (y < ymin) ymin = y; if (y > ymax) ymax = y }
    }
    if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
      const pad = (ymax - ymin) * 0.05
      u.setScale('y', { min: ymin - pad, max: ymax + pad })
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        background: 'var(--bg-primary)', position: 'relative',
        outline: 'none',
      }}
    >
      {/* Sweep + burst info + legend — narrow strip, no controls. */}
      <div className="viewer-header" style={{
        fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
        borderRadius: 'var(--radius) var(--radius) 0 0',
      }}>
        <span>Sweep <span className="num">{sweep + 1}</span></span>
        <span><span className="num">{sweepBursts.length}</span> bursts{manualCount > 0 ? ` (${manualCount} manual)` : ''}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 3 }}
            title="Subtract a per-sweep baseline (first ~3 ms) from the displayed trace. Detection always runs on the raw signal."
          >
            <input
              type="checkbox"
              checked={zeroOffset}
              onChange={(e) => onZeroOffsetChange(e.target.checked)}
            />
            Zero offset
          </label>
          <button
            className="btn btn-sm"
            onClick={fitYNow}
            title="Re-fit the y range to the trace currently inside the visible x window. Useful after toggling the filter or zero-offset shifts the baseline out of view."
          >
            Fit Y
          </button>
          <span style={{ width: 1, height: 14, background: 'var(--border)' }} />
          <LegendDot color={`var(${MARKER_COLORS.baseline})`} label="Baseline" />
          <LegendDot color={`var(${MARKER_COLORS.peak})`} label="Peak" />
          <LegendDot color={`var(${MARKER_COLORS.decay})`} label="½ decay" />
          <LegendDot color={`var(${MARKER_COLORS.end})`} label="Return" />
        </span>
      </div>

      {/* Viewport controls — mirrors the main viewer's ViewportBar
          (presets + custom seconds + ⟨⟨ ⟪ ◀ ▶ ⟫ ⟩⟩ arrows + time
          readout) so the burst window feels identical to the main
          continuous-mode UI the user already knows. */}
      <BurstViewportBar
        viewport={viewport}
        sweepDuration={data?.sweepDurationS ?? 0}
        setViewport={setViewport}
        shiftViewport={shiftViewport}
        goHome={goHome}
        goEnd={goEnd}
      />

      <div
        ref={containerRef}
        onContextMenu={onBurstContextMenu}
        style={{ flex: 1, position: 'relative', minHeight: 0 }}
      >
        {burstPlotMenu}
        <canvas
          ref={overlayRef}
          style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            zIndex: 5, width: '100%', height: '100%',
          }}
        />
      </div>

      {/* Scroll indicator: shows where the visible viewport sits
          inside the full sweep. Drag or click to pan. */}
      <BurstViewportSlider
        viewport={viewport}
        sweepDuration={data?.sweepDurationS ?? 0}
        setViewport={setViewport}
      />

      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
        borderRadius: '0 0 var(--radius) var(--radius)',
      }}>
        Scroll = zoom X · ⌥ scroll = zoom Y · drag = pan · left-click = add burst · right-click / double-click = remove
      </div>
      {err && (
        <div style={{
          position: 'absolute', top: 30, left: 10,
          color: 'var(--error)', fontSize: 'var(--font-size-label)',
        }}>Fetch: {err}</div>
      )}
    </div>
  )
}

/** Same as BurstMiniViewer's old `drawMiniOverlay`, but loops over
 *  EVERY burst in the current sweep (not just the selected one) and
 *  draws a ring around the peak dot for manually-added bursts. */
function drawBurstOverlay(
  u: uPlot | null,
  canvas: HTMLCanvasElement | null,
  entry: FieldBurstsData | undefined,
  bursts: BurstRecord[],
  /** DC baseline the backend subtracted when zero-offset was on.
   *  Burst records and detection thresholds are in RAW signal space,
   *  so we subtract the same offset here to keep markers glued to the
   *  visibly shifted trace (mirrors the main viewer's overlay). */
  yOffset: number = 0,
  /** Index of the burst (within ``bursts``) the user has primed for
   *  removal — drawn with a confirmation ring outside the dot.
   *  ``null`` = no prime. Mirrors the AP / Events flow. */
  primedIdx: number | null = null,
  /** Train spans for THIS sweep, drawn as translucent shaded boxes
   *  behind the per-burst markers. Empty when train-grouping is off
   *  or no clusters qualify. */
  trains: TrainSummary[] = [],
) {
  if (!u || !canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = devicePixelRatio || 1
  const cssW = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const left = u.bbox.left / dpr
  const right = left + u.bbox.width / dpr

  // Sample the displayed trace (already filter / zero-offset adjusted)
  // so markers ride on the visible line whether the user toggles the
  // pre-detection filter on or off. Falls back to the stored y when
  // the time is out of range or data isn't loaded.
  const tt = u.data[0] as unknown as number[]
  const tv = u.data[1] as unknown as number[]
  const toPx = (x: number, fallbackY: number): [number, number] => {
    const sampled = sampleTraceYAt(tt, tv, x)
    const yUse = sampled != null ? sampled : (fallbackY - yOffset)
    return [
      u.valToPos(x, 'x', true) / dpr,
      u.valToPos(yUse, 'y', true) / dpr,
    ]
  }

  // Train spans (drawn first so threshold lines + per-burst markers
  // sit on top). Each train gets a faint amber band spanning its
  // [startS, endS] range plus a small "T#" label at the upper-left
  // corner — same colour family as the manual-burst orange ring so
  // the user reads "this is a higher-level grouping of the bursts
  // below."
  if (trains.length > 0) {
    const trainColor = cssVar('--marker-manual')
    ctx.font = `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`
    for (const t of trains) {
      const px0 = u.valToPos(t.startS, 'x', true) / dpr
      const px1 = u.valToPos(t.endS, 'x', true) / dpr
      if (!isFinite(px0) || !isFinite(px1)) continue
      const w = Math.max(1, px1 - px0)
      ctx.fillStyle = trainColor
      ctx.globalAlpha = 0.13
      ctx.fillRect(px0, 0, w, cssH)
      ctx.strokeStyle = trainColor
      ctx.globalAlpha = 0.45
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(px0, 0); ctx.lineTo(px0, cssH)
      ctx.moveTo(px1, 0); ctx.lineTo(px1, cssH)
      ctx.stroke()
      ctx.globalAlpha = 0.95
      ctx.fillText(`T${t.id + 1}`, px0 + 3, 11)
      ctx.globalAlpha = 1
    }
  }

  // Dashed horizontal lines: detection thresholds (once per view, not
  // per burst). Pre-burst-baseline varies per burst so we draw short
  // local marks at each burst's baseline dot instead.
  const hLine = (y: number, color: string, alpha: number, label: string) => {
    const py = u.valToPos(y - yOffset, 'y', true) / dpr
    if (!isFinite(py)) return
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(left, py)
    ctx.lineTo(right, py)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = color
    ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`
    ctx.fillText(label, left + 4, py - 3)
    ctx.restore()
  }
  // Global detection baseline (grey) + thresholds (red), same style as
  // the main viewer's burst overlay. `baselineValue` is 0 for entries
  // predating the field that was added later; skip the line then so
  // we don't draw a misleading y=0 guide.
  if (entry && entry.baselineValue !== 0) {
    hLine(entry.baselineValue, cssVar('--text-muted'), 0.8, 'baseline')
  }
  const thrColor = cssVar('--marker-detected')
  if (entry?.thresholdHigh != null) hLine(entry.thresholdHigh, thrColor, 0.7, 'thr ↑')
  if (entry?.thresholdLow != null && entry.thresholdLow !== entry.thresholdHigh) {
    hLine(entry.thresholdLow, thrColor, 0.7, 'thr ↓')
  }

  const outlineColor = cssVar('--marker-outline')
  const baselineColor = cssVar(MARKER_COLORS.baseline)
  const peakColor = cssVar(MARKER_COLORS.peak)
  const decayColor = cssVar(MARKER_COLORS.decay)
  const endColor = cssVar(MARKER_COLORS.end)
  const drawDot = (px: number, py: number, color: string, ring: boolean = false) => {
    if (!isFinite(px) || !isFinite(py)) return
    ctx.beginPath()
    ctx.arc(px, py, 6, 0, 2 * Math.PI)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = outlineColor
    ctx.lineWidth = 1.5
    ctx.stroke()
    if (ring) {
      // Bold outer ring for manually-added bursts.
      ctx.beginPath()
      ctx.arc(px, py, 9.5, 0, 2 * Math.PI)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }

  let primedPos: [number, number] | null = null
  for (let bi = 0; bi < bursts.length; bi++) {
    const b = bursts[bi]
    const peakY = b.preBurstBaseline + b.peakSigned
    const [px0, py0] = toPx(b.startS, b.preBurstBaseline)
    const [px1, py1] = toPx(b.peakTimeS, peakY)
    const [px3, py3] = toPx(b.endS, b.preBurstBaseline)
    const decay = b.decayHalfTimeMs != null
      ? toPx(
          b.peakTimeS + b.decayHalfTimeMs / 1000,
          b.preBurstBaseline + b.peakSigned * 0.5,
        )
      : null
    drawDot(px0, py0, baselineColor)
    drawDot(px1, py1, peakColor, !!b.manual)
    if (decay) drawDot(decay[0], decay[1], decayColor)
    drawDot(px3, py3, endColor)
    if (bi === primedIdx) primedPos = [px1, py1]
  }
  // Primed-remove confirmation ring around the peak dot, drawn last
  // so it sits over the manual-orange ring (which lands at radius
  // ~9.5). Same text-primary ring as the AP and Events windows.
  if (primedPos) {
    ctx.save()
    ctx.strokeStyle = cssVar('--text-primary')
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(primedPos[0], primedPos[1], 12, 0, 2 * Math.PI)
    ctx.stroke()
    ctx.restore()
  }
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color, border: '1px solid var(--marker-outline)',
      }} />
      {label}
    </span>
  )
}

function BurstTable({
  bursts, selectedIdx, onSelect, trainIdByIdx,
}: {
  bursts: BurstRecord[]
  selectedIdx: number | null
  onSelect: (idx: number) => void
  /** Per-burst train assignment (same length + order as ``bursts``).
   *  ``null`` = isolated; integer = global train id. When omitted the
   *  Train column is hidden so users without train grouping enabled
   *  don't see an empty extra column. */
  trainIdByIdx?: (number | null)[] | null
}) {
  const sel = useRowSelection(bursts.length)
  const showTrainCol = !!trainIdByIdx && trainIdByIdx.some((v) => v != null)
  const baseHeaders = ['#', 'Sweep', 't_start (s)', 'Dur (ms)', 'Pre-baseline',
    'Peak (Δ)', 'Rise 10-90 (ms)', 'Decay t₅₀ (ms)', 'Integral (·s)',
    'Freq (Hz)', 'Peak t (s)']
  const headers = showTrainCol ? [...baseHeaders, 'Train'] : baseHeaders
  const rowToCells = (i: number): Array<string | number | null> => {
    const b = bursts[i]
    const base: Array<string | number | null> = [
      `${i + 1}${b.manual ? '*' : ''}`,
      b.sweepIndex + 1,
      b.startS.toFixed(3),
      b.durationMs.toFixed(1),
      b.preBurstBaseline.toFixed(3),
      b.peakAmplitude.toFixed(3),
      b.riseTime10_90Ms ?? null,
      b.decayHalfTimeMs ?? null,
      b.integral.toFixed(4),
      b.meanFrequencyHz ?? null,
      b.peakTimeS.toFixed(3),
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
  if (bursts.length === 0) {
    return (
      <div style={{
        padding: 16,
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-md)',
      }}>
        No bursts detected yet. Configure params above and run on a sweep or series.
      </div>
    )
  }

  return (
    <div style={{
      overflow: 'auto',
      height: '100%',
    }}>
      <table className="data-table">
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Sweep</Th>
            <Th>t_start (s)</Th>
            <Th>Dur (ms)</Th>
            <Th>Pre-baseline</Th>
            <Th>Peak (Δ)</Th>
            <Th>Rise 10-90 (ms)</Th>
            <Th>Decay t₅₀ (ms)</Th>
            <Th>Integral (·s)</Th>
            <Th>Freq (Hz)</Th>
            <Th>Peak t (s)</Th>
            {showTrainCol && <Th>Train</Th>}
          </tr>
        </thead>
        <tbody>
          {bursts.map((b, i) => (
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
                background: sel.isSelected(i)
                  ? 'var(--accent-muted)'
                  : i === selectedIdx
                    ? 'var(--bg-selected)'
                    : 'transparent',
                // Italicize manually-added bursts so the user can tell
                // at a glance which rows came from clicks vs auto
                // detection. Matches the ring the overlay draws
                // around their peak dot.
                fontStyle: b.manual ? 'italic' : 'normal',
              }}
              title={b.manual ? 'Manually added' : undefined}
            >
              <Td>{b.manual ? `${i + 1}★` : `${i + 1}`}</Td>
              <Td>{b.sweepIndex + 1}</Td>
              <Td>{b.startS.toFixed(3)}</Td>
              <Td>{b.durationMs.toFixed(1)}</Td>
              <Td>{b.preBurstBaseline.toFixed(3)}</Td>
              <Td>{b.peakAmplitude.toFixed(3)}</Td>
              <Td>{b.riseTime10_90Ms != null ? b.riseTime10_90Ms.toFixed(1) : '—'}</Td>
              <Td>{b.decayHalfTimeMs != null ? b.decayHalfTimeMs.toFixed(1) : '—'}</Td>
              <Td>{b.integral.toFixed(4)}</Td>
              <Td>{b.meanFrequencyHz != null ? b.meanFrequencyHz.toFixed(1) : '—'}</Td>
              <Td>{b.peakTimeS.toFixed(3)}</Td>
              {showTrainCol && (
                <Td>
                  {trainIdByIdx?.[i] != null
                    ? <span style={{ color: 'var(--marker-manual)' }}>T{(trainIdByIdx![i] as number) + 1}</span>
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

/** Compact summary table for detected trains. Shown below the bursts
 *  table when train-grouping is on. Mirrors the burst table's styling
 *  (data-table, sticky thead, copy menu) but only renders if there are
 *  any trains — empty data hides the whole block. */
function TrainSummaryTable({ trains }: {
  trains: Array<TrainSummary & { sweep: number }>
}) {
  const sel = useRowSelection(trains.length)
  const headers = ['Train', 'Sweep', 'Start (s)', 'End (s)', 'Dur (ms)',
    'n bursts', 'Mean IEI (ms)', 'Intra freq (Hz)']
  const rowToCells = (i: number): Array<string | number | null> => {
    const t = trains[i]
    return [
      `T${t.id + 1}`,
      t.sweep + 1,
      t.startS.toFixed(3),
      t.endS.toFixed(3),
      t.durationMs.toFixed(1),
      t.nEvents,
      t.meanIeiMs != null ? t.meanIeiMs.toFixed(1) : null,
      t.intraFreqHz != null ? t.intraFreqHz.toFixed(2) : null,
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  if (trains.length === 0) return null
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      overflow: 'auto',
      maxHeight: 200,
    }}>
      <table className="data-table">
        <thead>
          <tr>
            <Th>Train</Th>
            <Th>Sweep</Th>
            <Th>Start (s)</Th>
            <Th>End (s)</Th>
            <Th>Dur (ms)</Th>
            <Th>n bursts</Th>
            <Th>Mean IEI (ms)</Th>
            <Th>Intra freq (Hz)</Th>
          </tr>
        </thead>
        <tbody>
          {trains.map((t, i) => (
            <tr
              key={i}
              onClick={(ev) => sel.onRowClick(i, ev)}
              onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                if (!sel.isSelected(i)) sel.setSelected([i])
              })}
              style={{
                background: sel.isSelected(i)
                  ? 'var(--accent-muted)'
                  : 'transparent',
              }}
            >
              <Td><span style={{ color: 'var(--marker-manual)' }}>T{t.id + 1}</span></Td>
              <Td>{t.sweep + 1}</Td>
              <Td>{t.startS.toFixed(3)}</Td>
              <Td>{t.endS.toFixed(3)}</Td>
              <Td>{t.durationMs.toFixed(1)}</Td>
              <Td>{t.nEvents}</Td>
              <Td>{t.meanIeiMs != null ? t.meanIeiMs.toFixed(1) : '—'}</Td>
              <Td>{t.intraFreqHz != null ? t.intraFreqHz.toFixed(2) : '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th>{children}</th>
)
const Td = ({ children }: { children: React.ReactNode }) => (
  <td>{children}</td>
)

// ---------------------------------------------------------------------------
// Viewport toolbar + scroll indicator for the BurstSweepViewer.
//
// Structurally the same as the main viewer's ViewportBar /
// ViewportSlider, but driven by LOCAL viewport state (the analysis
// window has its own uPlot + fetch loop and doesn't share the main
// viewer's zustand slice). Behaviour mirrors main:
//   Presets (Full, 5 min, 1 min, 30 s, 10 s, 1 s), custom seconds
//   input, ⟨⟨ ⟪ ◀ ▶ ⟫ ⟩⟩ scroll arrows, M:SS.s time readout.
// ---------------------------------------------------------------------------

const VIEWPORT_PRESETS: { label: string; seconds: number | null }[] = [
  { label: 'Full',  seconds: null },
  { label: '5 min', seconds: 300 },
  { label: '1 min', seconds: 60 },
  { label: '30 s',  seconds: 30 },
  { label: '10 s',  seconds: 10 },
  { label: '1 s',   seconds: 1 },
]

function fmtViewportTime(s: number): string {
  if (!isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`
}

function BurstViewportBar({
  viewport, sweepDuration, setViewport, shiftViewport, goHome, goEnd,
}: {
  viewport: { tStart: number; tEnd: number } | null
  sweepDuration: number
  setViewport: React.Dispatch<React.SetStateAction<{ tStart: number; tEnd: number } | null>>
  shiftViewport: (widthsFactor: number) => void
  goHome: () => void
  goEnd: () => void
}) {
  const len = viewport ? viewport.tEnd - viewport.tStart : sweepDuration
  const start = viewport ? viewport.tStart : 0
  const end = viewport ? viewport.tEnd : sweepDuration
  const atStart = start <= 1e-6
  const atEnd = sweepDuration > 0 && end >= sweepDuration - 1e-6

  // Label for the currently-active preset (or Custom).
  const presetLabel = (() => {
    if (!viewport || (sweepDuration > 0 && len >= sweepDuration - 1e-3)) return 'Full'
    for (const p of VIEWPORT_PRESETS) {
      if (p.seconds !== null && Math.abs(p.seconds - len) < 0.01) return p.label
    }
    return 'Custom'
  })()

  /** Jump to a window of `seconds` length starting at viewport.tStart
   *  (or 0 when switching from Full). `null` means Full-sweep view. */
  const setWindow = (seconds: number | null) => {
    if (seconds == null) {
      // "Full" — size the viewport to the whole sweep.
      if (sweepDuration <= 0) { setViewport({ tStart: 0, tEnd: 10 }); return }
      setViewport({ tStart: 0, tEnd: sweepDuration })
      return
    }
    const curStart = viewport?.tStart ?? 0
    const ns = Math.max(0, Math.min(curStart, Math.max(0, sweepDuration - seconds)))
    const ne = sweepDuration > 0 ? Math.min(sweepDuration, ns + seconds) : ns + seconds
    setViewport({ tStart: ns, tEnd: ne })
  }

  const customValue = len || 10
  const commitCustom = (v: number) => {
    if (!isFinite(v) || v <= 0) return
    setWindow(v)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '2px 8px',
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border)',
      fontSize: 'var(--font-size-xs)',
      color: 'var(--text-secondary)',
      flexShrink: 0, minHeight: 22,
    }}>
      <span style={{ color: 'var(--text-muted)' }}>View:</span>

      <div style={{ display: 'flex', gap: 2 }}>
        {VIEWPORT_PRESETS.map((p) => {
          const active = p.label === presetLabel
          return (
            <button
              key={p.label}
              className="zoom-btn"
              onClick={() => setWindow(p.seconds)}
              aria-pressed={active}
              style={active ? {
                background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                color: 'var(--accent)',
                fontWeight: 600,
              } : undefined}
              title={p.seconds ? `Show a ${p.label} window` : 'Show the entire sweep'}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>Custom:</span>
        <NumInput
          value={customValue}
          min={0.001}
          step={0.1}
          onChange={commitCustom}
          style={{ width: 56, padding: '0 4px' }}
          title="Custom window length in seconds"
        />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>s</span>
      </div>

      <div style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
        <button className="zoom-btn" onClick={goHome} disabled={atStart}
          title="Jump to start (Home)">⟨⟨</button>
        <button className="zoom-btn" onClick={() => shiftViewport(-2)} disabled={atStart}
          title="Scroll back 2 windows (Page Up)">⟪</button>
        <button className="zoom-btn" onClick={() => shiftViewport(-1)} disabled={atStart}
          title="Previous window (←)">◀</button>
        <button className="zoom-btn" onClick={() => shiftViewport(1)} disabled={atEnd}
          title="Next window (→)">▶</button>
        <button className="zoom-btn" onClick={() => shiftViewport(2)} disabled={atEnd}
          title="Scroll forward 2 windows (Page Down)">⟫</button>
        <button className="zoom-btn" onClick={goEnd} disabled={atEnd}
          title="Jump to end (End)">⟩⟩</button>
      </div>

      <span className="num" style={{
        marginLeft: 'auto',
        color: 'var(--text-muted)',
      }}>
        {fmtViewportTime(start)} – {fmtViewportTime(end)}
        {sweepDuration > 0 ? ` / ${fmtViewportTime(sweepDuration)}` : ''}
      </span>
    </div>
  )
}

/** Thin horizontal slider under the plot showing where the visible
 *  viewport sits inside the whole sweep. Drag or click to scroll. */
function BurstViewportSlider({
  viewport, sweepDuration, setViewport,
}: {
  viewport: { tStart: number; tEnd: number } | null
  sweepDuration: number
  setViewport: React.Dispatch<React.SetStateAction<{ tStart: number; tEnd: number } | null>>
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  // Track the most recent viewport inside the drag loop so move handlers
  // read the latest width even if state updates are batched.
  const vpRef = useRef(viewport)
  vpRef.current = viewport

  const len = viewport ? viewport.tEnd - viewport.tStart : 0
  const visible = viewport != null && sweepDuration > 0 && len < sweepDuration - 1e-6

  const viewportFromX = (clientX: number) => {
    const el = trackRef.current
    if (!el || !vpRef.current || sweepDuration <= 0) return null
    const winLen = vpRef.current.tEnd - vpRef.current.tStart
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    let newStart = frac * sweepDuration - winLen / 2
    newStart = Math.max(0, Math.min(sweepDuration - winLen, newStart))
    return { tStart: newStart, tEnd: newStart + winLen }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (!visible) return
    draggingRef.current = true
    const vp = viewportFromX(e.clientX)
    if (vp) setViewport(vp)
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const v = viewportFromX(ev.clientX)
      if (v) setViewport(v)
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!visible || !viewport) return null

  const startFrac = viewport.tStart / sweepDuration
  const lenFrac = len / sweepDuration

  return (
    <div
      ref={trackRef}
      onMouseDown={onMouseDown}
      style={{
        position: 'relative',
        height: 12,
        background: 'var(--bg-primary)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0, userSelect: 'none',
      }}
      title="Drag or click to scroll the viewport"
    >
      <div style={{
        position: 'absolute', top: 2, bottom: 2,
        left: `${startFrac * 100}%`,
        width: `${Math.max(2, lenFrac * 100)}%`,
        background: 'var(--accent)',
        opacity: 0.55,
        borderRadius: 2,
      }} />
    </div>
  )
}
