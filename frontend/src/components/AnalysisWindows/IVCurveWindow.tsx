import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, IVCurveData, IVResponseMetric, CursorPositions } from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { ImSourceCard } from '../common/ImSourceCard'
import { ChannelsOverlaySelect, STIMULUS_OVERLAY_KEY } from '../common/ChannelsOverlaySelect'
import { OverlayTraceViewer, OverlayChannel } from '../common/OverlayTraceViewer'
import { usePlotMenu } from '../common/PlotMenu'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'

const BASELINE_COLOR_VAR = '--cursor-baseline'
const PEAK_COLOR_VAR = '--cursor-peak'

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

export function IVCurveWindow({
  backendUrl,
  fileInfo,
  currentSweep,
  mainGroup,
  mainSeries,
  mainTrace,
  cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  currentSweep: number
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const {
    ivCurves,
    runIVCurve, clearIVCurve, selectIVPoint, setIVResponseMetric, exportIVCSV,
    loading, error, setError,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // Selections. Preselect from main window on first mount.
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

  // Reset group/series bounds when file changes.
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])

  // Overlay channels — extra traces to show as stacked subplots
  // beneath the primary viewer (e.g. stimulus Im next to Vm).
  // Analysis never runs on these; they're visual context only. Same
  // pattern as AP. See ChannelsOverlaySelect + OverlayTraceViewer.
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

  const key = `${group}:${series}`
  const entry = ivCurves[key]

  // Rehydrate the form from the persisted entry whenever we land on
  // a (group, series) pair with results. Mirrors the pattern in
  // APWindow / FPspWindow — without this, closing and reopening the
  // file leaves form defaults showing even though the plot + table
  // below show the persisted run.
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entry) return
    if (rehydratedKeyRef.current === key) return
    rehydratedKeyRef.current = key
    if (entry.runMode) setRunMode(entry.runMode)
    if (entry.sweepFrom != null) setSweepFrom(entry.sweepFrom)
    if (entry.sweepTo != null) setSweepTo(entry.sweepTo)
    if (entry.sweepOne != null) setSweepOne(entry.sweepOne)
    if (entry.manualImEnabled != null) setManualImEnabled(entry.manualImEnabled)
    if (entry.manualImStartS != null) setManualImStartS(entry.manualImStartS)
    if (entry.manualImEndS != null) setManualImEndS(entry.manualImEndS)
    if (entry.manualImStartPA != null) setManualImStartPA(entry.manualImStartPA)
    if (entry.manualImStepPA != null) setManualImStepPA(entry.manualImStepPA)
    // Restore the cursor windows the original run used. Without
    // this, the cursors stay at whatever the main TraceViewer
    // currently shows — typically the defaults — and the next Run
    // computes points off a different baseline / peak window than
    // the one the saved curve was generated from. ``updateCursors``
    // also broadcasts so the main viewer's bands move in lockstep.
    if (entry.baselineStartS != null && entry.baselineEndS != null
        && entry.peakStartS != null && entry.peakEndS != null) {
      updateCursors({
        baselineStart: entry.baselineStartS,
        baselineEnd:   entry.baselineEndS,
        peakStart:     entry.peakStartS,
        peakEnd:       entry.peakEndS,
      })
    }
  }, [entry, key])

  // Mode + per-sweep range controls. "all" runs every sweep; "range" runs a
  // user-picked half-open [from, to] range; "one" runs just one sweep and
  // appends to the existing table.
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  // When series changes, reset the range to the full series.
  useEffect(() => {
    if (totalSweeps > 0) {
      setSweepFrom(1)
      setSweepTo(totalSweeps)
      setSweepOne((s) => Math.min(Math.max(1, s), totalSweeps))
    }
  }, [totalSweeps])

  // ---- Manual Im fallback (when the stimulus trace isn't recorded) ----
  const [manualImEnabled, setManualImEnabled] = useState(false)
  const [manualImStartS, setManualImStartS] = useState(0.1)
  const [manualImEndS, setManualImEndS] = useState(0.6)
  const [manualImStartPA, setManualImStartPA] = useState(-100)
  const [manualImStepPA, setManualImStepPA] = useState(20)

  // ---- Mini-viewer state ----
  const [previewSweep, setPreviewSweep] = useState(currentSweep)
  const [traceTime, setTraceTime] = useState<number[] | null>(null)
  const [traceValues, setTraceValues] = useState<number[] | null>(null)
  const [traceUnits, setTraceUnits] = useState<string>('')
  // Per-window zero-offset toggle for the mini-viewer.
  const [zeroOffset, setZeroOffset] = useState(false)
  const mainSyncedRef = useRef(false)
  useEffect(() => {
    if (mainSyncedRef.current) return
    mainSyncedRef.current = true
    setPreviewSweep(currentSweep)
  }, [currentSweep])
  // Clamp preview sweep to [0, totalSweeps) whenever the series changes.
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, totalSweeps - 1)))
  }, [group, series, totalSweeps])
  // Fetch the preview sweep whenever it changes.
  useEffect(() => {
    if (!backendUrl || totalSweeps === 0) { setTraceTime(null); setTraceValues(null); return }
    let cancelled = false
    const qs = new URLSearchParams({
      group: String(group), series: String(series),
      sweep: String(previewSweep), trace: String(channel),
      max_points: '0',
    })
    if (zeroOffset) qs.set('zero_offset', 'true')
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        setTraceTime(d.time ?? [])
        setTraceValues(d.values ?? [])
        setTraceUnits(d.units ?? '')
      })
      .catch(() => { if (!cancelled) { setTraceTime(null); setTraceValues(null) } })
    return () => { cancelled = true }
  }, [backendUrl, group, series, channel, previewSweep, totalSweeps, zeroOffset])

  // Cursor changes from drag → push up to the main store AND broadcast
  // so the main trace viewer's bands move in lockstep.
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    useAppStore.getState().setCursors(next)
    try {
      const ch = new BroadcastChannel('tracer-sync')
      const merged = { ...useAppStore.getState().cursors, ...next }
      ch.postMessage({ type: 'cursor-update', cursors: merged })
      ch.close()
    } catch { /* ignore */ }
  }, [])

  // Exclusion badge for the preview sweep.
  const isPreviewExcluded = useAppStore((s) => s.isSweepExcluded(group, series, previewSweep))

  // Splitters. Both persist to Electron prefs under ivWindowUI so the
  // layout survives window reopens — same recipe APWindow/FPspWindow
  // use. Hydrate on mount, write only on mouseup (one write per drag,
  // not per pixel).
  const [plotHeight, setPlotHeight] = useState(340)
  const [leftPanelWidth, setLeftPanelWidth] = useState(320)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const ui = prefs?.ivWindowUI
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
      const next = { ...(prefs.ivWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, ivWindowUI: next })
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

  const onRun = async () => {
    // Build the sweep selection based on mode. Backend accepts an optional
    // array of sweep indices; absent = run all.
    let sweepIndices: number[] | null = null
    let appendToExisting = false
    const store = useAppStore.getState()
    if (runMode === 'all') {
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
    // Pull the windows from the main-window cursors (now also
    // draggable inside the mini-viewer below). baseline = baseline
    // cursor, peak/SS = peak cursor.
    await runIVCurve(group, series, channel, {
      baselineStartS: cursors.baselineStart,
      baselineEndS: cursors.baselineEnd,
      peakStartS: cursors.peakStart,
      peakEndS: cursors.peakEnd,
      sweepIndices,
      appendToExisting,
      manualImEnabled,
      manualImStartS,
      manualImEndS,
      manualImStartPA,
      manualImStepPA,
      // Form-state passes through the action now and lands on the
      // stored entry inside ``runIVCurve`` itself; the broadcast
      // afterwards carries it to the main window's store and from
      // there to the sidecar auto-save. Replaces the old local
      // ``useAppStore.setState`` stamp which only updated the
      // analysis window's OWN store and was therefore invisible to
      // the sidecar persistence path.
      runMode, sweepFrom, sweepTo, sweepOne,
    })
  }
  const onSelectRow = (idx: number) => {
    selectIVPoint(group, series, idx)
    // Jump the main viewer to the sweep this point belongs to.
    const p = entry?.points[idx]
    if (p != null) {
      try {
        const ch = new BroadcastChannel('tracer-sync')
        ch.postMessage({ type: 'sweep-update', sweep: p.sweepIndex })
        ch.close()
      } catch { /* ignore */ }
    }
  }

  const metric: IVResponseMetric = entry?.responseMetric ?? 'steady'
  const onMetricChange = (m: IVResponseMetric) => {
    if (!entry) return
    setIVResponseMetric(group, series, m)
  }

  // Linear fit over the current (stim, response) points. Slope = dV/dI for
  // VC data → in that case it's the INVERSE of input resistance (dI/dV),
  // since stim is mV and response is pA: R = 1 / slope × 1000 (to get MΩ).
  // For CC data (stim = pA, response = mV), the slope itself IS R in GΩ
  // (mV / pA = GΩ), which we convert to MΩ via ×1000.
  const fit = useMemo(() => {
    if (!entry || entry.points.length < 2) return null
    const xs: number[] = []
    const ys: number[] = []
    for (const p of entry.points) {
      xs.push(p.stimLevel)
      const r = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
      ys.push(r)
    }
    const n = xs.length
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx
      num += dx * (ys[i] - my)
      den += dx * dx
    }
    if (den === 0) return null
    const slope = num / den
    const intercept = my - slope * mx
    // R² for quick sanity.
    let ssRes = 0
    let ssTot = 0
    for (let i = 0; i < n; i++) {
      const yHat = slope * xs[i] + intercept
      ssRes += (ys[i] - yHat) ** 2
      ssTot += (ys[i] - my) ** 2
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1
    // Input resistance interpretation:
    //   VC: stim mV, response pA  → slope (pA/mV) → R = 1000 / slope  [MΩ]
    //   CC: stim pA, response mV  → slope (mV/pA) → R = slope × 1000  [MΩ]
    //   otherwise — not meaningful.
    let rInMOhm: number | null = null
    const stimU = entry.stimUnit.toLowerCase()
    const respU = entry.responseUnit.toLowerCase()
    if (stimU === 'mv' && respU === 'pa' && slope !== 0) {
      rInMOhm = 1000 / slope  // signed; take abs in UI
    } else if (stimU === 'pa' && respU === 'mv') {
      rInMOhm = slope * 1000
    }
    return { slope, intercept, r2, rInMOhm }
  }, [entry])

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
          bg-secondary chrome tone so the window's top row + left
          panel read as one cohesive region (matching the main
          window's tree sidebar). */}
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
        <Field label="Series">
          <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        <ChannelsOverlaySelect
          channels={channels.map((c: any) => ({ index: c.index, label: c.label, units: c.units }))}
          primary={channel}
          onPrimaryChange={(i) => setChannel(i)}
          overlay={overlayChannels}
          onOverlayChange={setOverlayChannels}
          hasStimulus={hasStimulus}
        />

        {/* Sweep navigator — kept at the top of every analysis window
            next to the selectors so users don't hunt for it. */}
        <Field label="Sweep (preview)">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setPreviewSweep((s) => Math.max(0, s - 1))}
              disabled={previewSweep <= 0 || totalSweeps === 0}
              title="Previous sweep">←</button>
            <span className="num" style={{ minWidth: 58, textAlign: 'center', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
              {totalSweeps > 0 ? `${previewSweep + 1} / ${totalSweeps}` : '— / —'}
            </span>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setPreviewSweep((s) => Math.min(totalSweeps - 1, s + 1))}
              disabled={previewSweep >= totalSweeps - 1 || totalSweeps === 0}
              title="Next sweep">→</button>
          </span>
        </Field>
      </div>

      {/* Main body: two-column flex. LEFT = params column (scrollable
          with Run controls pinned to its bottom); RIGHT = viewer +
          results. Same layout as APWindow/FPspWindow. */}
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
            {/* Cursor windows (mirrored from the main viewer, read-only
                here) + Y-metric dropdown. Drag the cursor bands on the
                main trace (or the mini-viewer) to change the
                measurement windows. */}
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              padding: 8,
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg-primary)',
              fontSize: 'var(--font-size-label)',
            }}>
              <span style={{ color: 'var(--cursor-baseline)', fontWeight: 600, width: '100%' }}>
                Baseline:
              </span>
              <span className="num">{cursors.baselineStart.toFixed(4)}s → {cursors.baselineEnd.toFixed(4)}s</span>
              <span style={{ color: 'var(--cursor-peak)', fontWeight: 600, width: '100%' }}>
                Peak / SS:
              </span>
              <span className="num">{cursors.peakStart.toFixed(4)}s → {cursors.peakEnd.toFixed(4)}s</span>
              <label style={{
                display: 'flex', flexDirection: 'column', gap: 3,
                width: '100%', marginTop: 4,
              }}>
                <span style={{ color: 'var(--text-muted)' }}>Y metric:</span>
                <select
                  value={metric}
                  onChange={(e) => onMetricChange(e.target.value as IVResponseMetric)}
                  disabled={!entry}
                  style={{ width: '100%' }}
                  title="Steady-state = mean of the peak-cursor window. Transient peak = most-deviant sample within the peak-cursor window."
                >
                  <option value="steady">Steady-state (mean)</option>
                  <option value="peak">Transient peak</option>
                </select>
              </label>
            </div>

            {/* Im source — shared with the AP window. Auto uses the
                stimulus protocol; Manual falls back to user-supplied
                start/step/window (for recordings where the stimulus
                wasn't saved or the protocol doesn't expose Im). */}
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
          </div>

          {/* Pinned footer: Run + Sweeps dropdown + progressive
              disclosure for Range/Single, then secondary Clear /
              Export CSV below a separator. Same pattern as AP/FPsp. */}
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
                onChange={(e) => setRunMode(e.target.value as typeof runMode)}
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
                <span style={{ marginLeft: 'auto' }}>/ {totalSweeps || '—'} · appends</span>
              </div>
            )}
            {/* Secondary actions — smaller, visually subordinate. */}
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn"
                onClick={() => clearIVCurve(group, series)} disabled={!entry}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={() => exportIVCSV()}
                disabled={Object.keys(ivCurves).length === 0}
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

        {/* RIGHT PANEL: viewer + horizontal splitter + results. */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>
          {/* Viewer area: primary TraceMiniViewer, optionally with
              stacked overlay subplots below. Primary : each overlay
              = 5:2 so one overlay is ~29% of the viewer height. X
              range is shared from primary via onXRangeChange. */}
          <div style={{
            height: plotHeight, minHeight: 160, flexShrink: 0,
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              flex: overlayChannels.length > 0 ? 5 : 1,
              minHeight: 0,
            }}>
              <TraceMiniViewer
                traceTime={traceTime}
                traceValues={traceValues}
                traceUnits={traceUnits}
                cursors={cursors}
                updateCursors={updateCursors}
                previewSweep={previewSweep}
                totalSweeps={totalSweeps}
                isExcluded={isPreviewExcluded}
                loading={loading}
                theme={theme}
                fontSize={fontSize}
                zeroOffset={zeroOffset}
                onZeroOffsetChange={setZeroOffset}
                resetCursorsInView={(xMin, xMax) => {
                  const span = xMax - xMin
                  updateCursors({
                    baselineStart: xMin + 0.05 * span,
                    baselineEnd: xMin + 0.20 * span,
                    peakStart: xMin + 0.35 * span,
                    peakEnd: xMin + 0.65 * span,
                  })
                }}
                onXRangeChange={(xMin, xMax) => setPrimaryXRange([xMin, xMax])}
                viewKey={`${group}:${series}:${channel}:${zeroOffset}`}
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
                      heightSignal={plotHeight}
                    />
                  </div>
                </React.Fragment>
              )
            })}
          </div>

          {/* Horizontal splitter between viewer and results. Thin
              (3px hit / 2px grip) to match AP/FPsp. */}
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

          {/* Summary strip (point count / windows / units / fit + Rin)
              sits just above the results area — physically adjacent
              to the I-V curve plot it describes. */}
          {entry && (
            <div style={{
              flexShrink: 0,
              fontSize: 'var(--font-size-label)',
              color: 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums',
              background: 'var(--bg-primary)',
              padding: '4px 8px',
              borderRadius: 3,
              border: '1px solid var(--border)',
              marginTop: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}>
              <span>
                <strong style={{ color: 'var(--text-primary)' }}>{entry.points.length}</strong> points ·
                BL {entry.baselineStartS.toFixed(3)}→{entry.baselineEndS.toFixed(3)}s ·
                PK {entry.peakStartS.toFixed(3)}→{entry.peakEndS.toFixed(3)}s ·
                stim {entry.stimUnit || '—'} · response {entry.responseUnit || '—'}
              </span>
              {fit && (
                <span style={{
                  marginLeft: 'auto',
                  color: 'var(--text-primary)',
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                }}>
                  <span title="Slope of the linear fit to the I-V points">
                    slope = {formatSlope(fit.slope, entry)} · R² = {fit.r2.toFixed(3)}
                  </span>
                  {fit.rInMOhm != null && (
                    <span
                      style={{ color: 'var(--accent)', fontWeight: 600 }}
                      title="Input resistance derived from the I-V slope"
                    >
                      Rin = {Math.abs(fit.rInMOhm).toFixed(1)} MΩ
                    </span>
                  )}
                </span>
              )}
            </div>
          )}

          {/* Bottom tab strip: I-V curve / Table */}
          <div style={{ flex: 1, minHeight: 0, marginTop: 6, display: 'flex' }}>
            <ResultsTabs
              entry={entry}
              fit={fit}
              onSelectRow={onSelectRow}
            />
          </div>
        </div>{/* close RIGHT panel */}
      </div>{/* close two-column body */}
    </div>
  )
}

// ----------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------

function formatSlope(slope: number, entry: IVCurveData): string {
  const u = `${entry.responseUnit || '?'}/${entry.stimUnit || '?'}`
  return `${slope.toFixed(4)} ${u}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function IVPlot({
  entry, heightSignal, onSelectIdx, fit,
}: {
  entry: IVCurveData | undefined
  heightSignal: number
  onSelectIdx: (idx: number) => void
  fit: { slope: number; intercept: number; r2: number; rInMOhm: number | null } | null
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'iv-curve',
  })
  const selectedRef = useRef<number | null>(null)
  selectedRef.current = entry?.selectedIdx ?? null

  // Build data arrays from the points, sorted by stim level.
  // If a fit is available, also emit the regression line evaluated at the
  // x-extremes — added as a second uPlot series.
  const { xs, ys, yFit, sweepByIdx } = useMemo(() => {
    if (!entry || entry.points.length === 0) {
      return {
        xs: [] as number[], ys: [] as number[],
        yFit: [] as (number | null)[], sweepByIdx: [] as number[],
      }
    }
    const xs: number[] = []
    const ys: number[] = []
    const sweepByIdx: number[] = []
    for (const p of entry.points) {
      xs.push(p.stimLevel)
      const resp = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
      ys.push(resp)
      sweepByIdx.push(p.sweepIndex)
    }
    const yFit: (number | null)[] = fit
      ? xs.map((x) => fit.slope * x + fit.intercept)
      : xs.map(() => null)
    return { xs, ys, yFit, sweepByIdx }
  }, [entry, fit])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!entry || xs.length === 0) return

    const xLabel = `Stim${entry.stimUnit ? ` (${entry.stimUnit})` : ''}`
    const yLabel = `Response Δ${entry.responseUnit ? ` (${entry.responseUnit})` : ''}`
    // Compute x/y ranges ourselves and feed them via static `range`
    // callbacks. uPlot's auto-range was producing a degenerate scale
    // on the reopen path (xScale.min/max coming back null) — the data
    // is identical to the fresh-Run path that works, but something in
    // uPlot's setScales pipeline doesn't pick it up. Skipping the
    // auto-range entirely makes the curve render reliably either way.
    const xMin = xs[0]
    const xMax = xs[xs.length - 1]
    const xPad = (xMax - xMin) * 0.05 || 1
    let yMinD = Infinity, yMaxD = -Infinity
    for (const v of ys) {
      if (v < yMinD) yMinD = v
      if (v > yMaxD) yMaxD = v
    }
    for (const v of yFit) {
      if (v != null) {
        if (v < yMinD) yMinD = v
        if (v > yMaxD) yMaxD = v
      }
    }
    const yLo = Math.min(0, yMinD)
    const yHi = Math.max(0, yMaxD)
    const yPad = (yHi - yLo) * 0.1 || 1
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 180),
      legend: { show: false },
      scales: {
        x: { time: false, range: () => [xMin - xPad, xMax + xPad] },
        y: { range: () => [yLo - yPad, yHi + yPad] },
      },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: xLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: yLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          stroke: cssVar('--trace-color-1'),
          width: 1.5,
          points: { size: 6, stroke: cssVar('--trace-color-1'), fill: cssVar('--bg-surface') },
        },
        {
          stroke: cssVar('--accent'),
          width: 1,
          dash: [4, 4],
          points: { show: false },
        },
      ],
      hooks: {
        // Click anywhere: find the nearest data point, select it.
        init: [(u) => {
          u.over.addEventListener('click', () => {
            const idx = u.cursor.idx
            if (idx != null && idx >= 0) onSelectIdx(idx as number)
          })
        }],
        draw: [(u) => drawSelectedMarker(u, selectedRef.current)],
      },
    }
    plotRef.current = new uPlot(opts, [xs, ys, yFit as any], el)

    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      // Skip 0-size invalidations — happens briefly on layout
      // transitions (display: none toggles, parent flex reflow).
      // Calling setSize with 0×0 makes the canvas invisible and
      // uPlot doesn't recover when a real size arrives later.
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
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
      plotRef.current?.destroy()
      plotRef.current = null
    }
    // Depend on ``entry`` directly (rather than its sub-properties)
    // so any change — including the initial undefined → loaded
    // transition on file-reopen — guarantees a rebuild. The earlier
    // sub-property dep list was too clever and missed the reopen
    // path; the rebuild is cheap (a handful of points), so the
    // occasional extra fire on selection changes is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, themeKey])

  // Re-fit size synchronously on splitter drag.
  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  // Redraw to update the selected-marker highlight.
  useEffect(() => {
    plotRef.current?.redraw()
  }, [entry?.selectedIdx])

  void sweepByIdx  // kept for potential future use
  if (!entry || xs.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry ? 'No I-V points for this series.' : 'Click Run to compute the I-V for this series.'}
      </div>
    )
  }
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: '100%',
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        position: 'relative',
      }}
    >
      {menu}
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

function drawSelectedMarker(u: uPlot, selectedIdx: number | null) {
  if (selectedIdx == null) return
  const xArr = u.data[0] as number[]
  const yArr = u.data[1] as (number | null)[]
  if (selectedIdx < 0 || selectedIdx >= xArr.length) return
  const x = xArr[selectedIdx]
  const y = yArr[selectedIdx]
  if (y == null || !isFinite(x) || !isFinite(y)) return
  const dpr = devicePixelRatio || 1
  const px = u.valToPos(x, 'x', true) / dpr
  const py = u.valToPos(y, 'y', true) / dpr
  const ctx = u.ctx
  // Draw in CSS pixels.
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.beginPath()
  ctx.arc(px, py, 8, 0, Math.PI * 2)
  ctx.fillStyle = cssVar('--accent')
  ctx.strokeStyle = cssVar('--marker-outline')
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function IVTable({
  entry, onSelect,
}: {
  entry: IVCurveData | undefined
  onSelect: (idx: number) => void
}) {
  const sel = useRowSelection(entry?.points.length ?? 0)
  const stimUnit = entry?.stimUnit || ''
  const respUnit = entry?.responseUnit || ''
  const headers = ['#', 'Sweep', `Stim (${stimUnit})`, `Baseline (${respUnit})`,
    `Steady-state (${respUnit})`, `Transient peak (${respUnit})`,
    `Sag amp (${respUnit})`, 'Sag ratio', `Response (${respUnit})`]
  const rowToCells = (i: number): Array<string | number | null> => {
    const p = entry!.points[i]
    const resp = (entry!.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
    return [
      i + 1, p.sweepIndex + 1,
      p.stimLevel.toFixed(2),
      p.baseline.toFixed(3), p.steadyState.toFixed(3), p.transientPeak.toFixed(3),
      p.sagAmp.toFixed(3), p.sagRatio ?? null,
      resp.toFixed(3),
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
        {entry ? 'No I-V points.' : 'Click Run to populate the table.'}
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
        fontSize: 'var(--font-size-label)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>#</Th>
            <Th>Sweep</Th>
            <Th>Stim ({stimUnit})</Th>
            <Th>Baseline ({respUnit})</Th>
            <Th>Steady-state ({respUnit})</Th>
            <Th>Transient peak ({respUnit})</Th>
            <Th>Sag amp ({respUnit})</Th>
            <Th>Sag ratio</Th>
            <Th>Response ({respUnit})</Th>
          </tr>
        </thead>
        <tbody>
          {entry.points.map((p, i) => {
            const resp = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
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
                  background: sel.isSelected(i)
                    ? 'var(--accent-muted)'
                    : i === entry.selectedIdx
                      ? 'var(--bg-selected)'
                      : 'transparent',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{i + 1}</Td>
                <Td>{p.sweepIndex + 1}</Td>
                <Td>{p.stimLevel.toFixed(2)}</Td>
                <Td>{p.baseline.toFixed(3)}</Td>
                <Td>{p.steadyState.toFixed(3)}</Td>
                <Td>{p.transientPeak.toFixed(3)}</Td>
                <Td>{p.sagAmp.toFixed(3)}</Td>
                <Td>{p.sagRatio != null ? p.sagRatio.toFixed(3) : '—'}</Td>
                <Td><strong>{resp.toFixed(3)}</strong></Td>
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
const Td = ({ children }: { children: React.ReactNode }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{children}</td>
)

// ---------------------------------------------------------------------------
// TraceMiniViewer — fetches and displays one sweep's trace with draggable
// Baseline (green) and Peak (blue) cursor bands. Wheel/pan/Reset locked-
// zoom pattern mirrors the Cursor and Resistance windows.
// ---------------------------------------------------------------------------

function TraceMiniViewer({
  traceTime, traceValues, traceUnits,
  cursors, updateCursors,
  previewSweep, totalSweeps, isExcluded,
  loading,
  theme, fontSize,
  zeroOffset, onZeroOffsetChange,
  resetCursorsInView,
  onXRangeChange, viewKey,
}: {
  traceTime: number[] | null
  traceValues: number[] | null
  traceUnits: string
  cursors: CursorPositions
  updateCursors: (next: Partial<CursorPositions>) => void
  previewSweep: number
  totalSweeps: number
  isExcluded: boolean
  loading: boolean
  theme: string
  fontSize: number
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  /** Parent-supplied "put the cursor bands back on screen" action.
   *  Called with the CURRENT visible X range so the parent can drop
   *  each cursor pair to a sensible position inside that window. */
  resetCursorsInView: (xMin: number, xMax: number) => void
  /** Fired on pan / wheel / reset / initial auto-fit so stacked
   *  overlay viewers mirror the x range. Same pattern as AP. */
  onXRangeChange?: (xMin: number, xMax: number) => void
  /** Changes when the group / series / channel / zero-offset shown
   *  changes; the saved zoom is cleared so the new trace auto-fits. */
  viewKey: string
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'iv-trace',
  })

  // Keep the latest cursors reachable from hook closures.
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors

  // Refs that back the uPlot scale range functions — locked-zoom pattern.
  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  const hasRealDataRef = useRef(false)

  // A different recording slice → once its trace arrives, drop the saved
  // zoom so it auto-fits instead of sitting in the old range. (Clearing
  // straight away isn't enough: redraws of the old plot would save the
  // old range again before the new trace loads.)
  const zoomResetFromRef = useRef<unknown>(undefined)
  useEffect(() => { zoomResetFromRef.current = traceTime }, [viewKey])

  // Stash the onXRangeChange callback in a ref so handlers wired once
  // can see the latest prop without requiring a remount.
  const onXRangeChangeRef = useRef(onXRangeChange)
  onXRangeChangeRef.current = onXRangeChange
  const emitXRange = (xMin: number, xMax: number) => {
    try { onXRangeChangeRef.current?.(xMin, xMax) } catch { /* ignore */ }
  }

  type DragTarget =
    | { kind: 'baseline-edge'; edge: 'start' | 'end' }
    | { kind: 'baseline-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'peak-edge'; edge: 'start' | 'end' }
    | { kind: 'peak-band'; startPxX: number; startStart: number; startEnd: number }
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
    drawBand(cur.peakStart, cur.peakEnd, PEAK_COLOR_VAR, 'PK/SS')
  }

  useEffect(() => {
    const resetZoomOnBuild = zoomResetFromRef.current !== undefined && traceTime !== zoomResetFromRef.current
    const container = containerRef.current
    if (!container || !traceTime || !traceValues) {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      return
    }
    const frameId = requestAnimationFrame(() => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      // Cleared here, not before the frame: the old plot can still redraw
      // (and re-save its range) until it's destroyed.
      if (resetZoomOnBuild) {
        xRangeRef.current = null
        yRangeRef.current = null
        hasRealDataRef.current = false
        zoomResetFromRef.current = undefined
      }
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
              else {
                const pad = (dataMax - dataMin) * 0.05
                r = [dataMin - pad, dataMax + pad]
              }
              if (hasRealDataRef.current) yRangeRef.current = r
              return r
            },
          },
        },
        axes: [
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: traceUnits || '', labelSize: 14,
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
            : (hit.kind === 'baseline-edge' || hit.kind === 'peak-edge') ? 'ew-resize' : 'move'
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
      ;(plotRef.current as any)._teardownIV = () => {
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
      const teardown = (plotRef.current as any)?._teardownIV
      if (teardown) teardown()
      plotRef.current?.destroy()
      plotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues, themeKey])

  // Redraw bands on cursor / theme changes.
  useEffect(() => { plotRef.current?.redraw() }, [cursors])
  useEffect(() => { plotRef.current?.redraw() }, [theme, fontSize])

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
        {/* Sweep arrows live in the top-of-window selector row.
            Single-sweep runs go through the "single sweep" toggle in
            the Run controls — the dedicated "Run sweep N" button
            here was redundant with that toggle + the Run button, so
            it's been removed to match the other analysis windows. */}
        <span style={{ minWidth: 58, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
          Sweep {totalSweeps > 0 ? previewSweep + 1 : '—'}
        </span>
        {isExcluded && (
          <span className="notice notice-warning" style={{
            fontSize: 'var(--font-size-xs)', fontWeight: 600,
            padding: '1px 8px', borderRadius: 'var(--radius-sm)', lineHeight: 1.4,
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
          onClick={() => {
            const u = plotRef.current
            let xMin: number | null = u?.scales.x.min ?? null
            let xMax: number | null = u?.scales.x.max ?? null
            if ((xMin == null || xMax == null || xMax <= xMin) && traceTime && traceTime.length > 0) {
              xMin = traceTime[0]
              xMax = traceTime[traceTime.length - 1]
            }
            if (xMin != null && xMax != null && xMax > xMin) resetCursorsInView(xMin, xMax)
          }}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Bring cursor bands into the current view">Reset cursors</button>
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
        Scroll = zoom X · ⌥ scroll = zoom Y · drag empty = pan · drag band = move · drag edge = resize
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ResultsTabs — bottom-section tab strip. Two tabs: the I-V plot and the
// full points table. Switching tabs does NOT destroy the other's state.
// ---------------------------------------------------------------------------

function ResultsTabs({
  entry, fit, onSelectRow,
}: {
  entry: IVCurveData | undefined
  fit: { slope: number; intercept: number; r2: number; rInMOhm: number | null } | null
  onSelectRow: (idx: number) => void
}) {
  const [activeTab, setActiveTab] = useState<'iv' | 'table'>('iv')
  const pointCount = entry?.points.length ?? 0
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      minHeight: 0, overflow: 'hidden',
    }}>
      <div className="segmented" style={{
        alignSelf: 'flex-start', flexShrink: 0, marginBottom: 6,
      }}>
        {([
          { id: 'iv' as const, label: 'I-V curve' },
          { id: 'table' as const, label: 'Table' },
        ]).map((t) => {
          const active = activeTab === t.id
          return (
            <button
              key={t.id}
              type="button"
              className={active ? 'active' : undefined}
              onClick={() => setActiveTab(t.id)}
              style={{ flex: 'none', userSelect: 'none', padding: '0 14px', whiteSpace: 'nowrap' }}
            >
              {t.label}
              {pointCount > 0 && t.id === 'iv' && (
                <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontSize: 'var(--font-size-label)', fontWeight: 400 }}>
                  ({pointCount})
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Keep both mounted — switching tabs shouldn't destroy the plot.
            Visibility toggles via display: none. */}
        <div style={{ display: activeTab === 'iv' ? 'block' : 'none', height: '100%' }}>
          <IVPlot entry={entry} heightSignal={0} onSelectIdx={onSelectRow} fit={fit} />
        </div>
        <div style={{ display: activeTab === 'table' ? 'block' : 'none', height: '100%', overflow: 'auto' }}>
          <IVTable entry={entry} onSelect={onSelectRow} />
        </div>
      </div>
    </div>
  )
}
