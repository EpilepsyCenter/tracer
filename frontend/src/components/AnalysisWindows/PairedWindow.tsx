import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  PairedData, PairedFormState, PairedManualEdits, PairedTrial,
  defaultPairedForm, useAppStore,
} from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { sampleTraceYAt } from '../../utils/sampleTraceY'
import { useRowSelection, buildTSV, copyTextToClipboard } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { usePlotMenu } from '../common/PlotMenu'

// ---------------------------------------------------------------------------
// Types and helpers
// ---------------------------------------------------------------------------

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

/** Add an alpha channel to a resolved colour (theme oklch() tokens,
 *  or a user-picked hex / rgb() trace colour), for canvas fills that
 *  need a tint. */
function withAlpha(color: string, alpha: number): string {
  const fn = /^(oklch|oklab|lch|lab|rgb|hsl)a?\(([^/)]*)\)$/.exec(color)
  if (fn) {
    const args = fn[2].trim()
    return args.includes(',') ? `${fn[1]}a(${args}, ${alpha})` : `${fn[1]}(${args} / ${alpha})`
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    const n = parseInt(h, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  return color
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

export function PairedWindow({
  backendUrl, fileInfo, mainGroup, mainSeries,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
}) {
  const {
    pairedAnalyses, pairedForm, setPairedAnalysis, clearPairedAnalysis, setPairedForm,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)
  // Subscribe to traceColors so per-slot overrides set in the
  // global Settings panel re-render the viewer (cssVar() resolves
  // ``--trace-color-N`` against :root, which themeStore updates
  // when the user picks a new colour). Reference everything to
  // keep the subscriptions live.
  const traceColors = useThemeStore((s) => s.traceColors)
  void theme; void fontSize; void traceColors

  // ---- Selectors ----
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [preTrace, setPreTrace] = useState(0)
  const [postTrace, setPostTrace] = useState(1)
  const [sweep, setSweep] = useState(0)

  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
  }, [mainGroup, mainSeries])

  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0) {
      if (preTrace >= channels.length) setPreTrace(0)
      if (postTrace >= channels.length) setPostTrace(Math.min(1, channels.length - 1))
      if (preTrace === postTrace && channels.length > 1) {
        setPostTrace(preTrace === 0 ? 1 : 0)
      }
    }
  }, [channels, preTrace, postTrace])

  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  useEffect(() => {
    if (sweep >= totalSweeps) setSweep(Math.max(0, totalSweeps - 1))
  }, [totalSweeps, sweep])

  // ---- Form state — global last-used, with per-series rehydration ----
  // The store carries last-used defaults; per-series saved entries (from
  // a previous Run) override them when this window opens onto a series
  // that already has results. ``rehydratedKeyRef`` ensures we don't
  // clobber the user's edits when an async state-update arrives later.
  const [form, setLocalForm] = useState<PairedFormState>(() => pairedForm ?? defaultPairedForm())
  const rehydratedKeyRef = useRef<string | null>(null)
  const formKey = `${group}:${series}`
  useEffect(() => {
    if (rehydratedKeyRef.current === formKey) return
    rehydratedKeyRef.current = formKey
    const stored = pairedAnalyses[formKey]
    if (stored) {
      setLocalForm({
        preMode: stored.preMode,
        preParams: stored.preParams,
        postParams: stored.postParams,
        failureParams: stored.failureParams,
        latencyParams: stored.latencyParams,
      })
    } else {
      setLocalForm(pairedForm ?? defaultPairedForm())
    }
  }, [formKey, pairedAnalyses, pairedForm])

  const updateForm = useCallback((patch: Partial<PairedFormState>) => {
    setLocalForm((prev) => ({ ...prev, ...patch }))
  }, [])

  // ---- Run mode ----
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  useEffect(() => {
    if (totalSweeps > 0 && sweepTo > totalSweeps) setSweepTo(totalSweeps)
  }, [totalSweeps, sweepTo])

  // ---- Tab ----
  type Tab = 'trials' | 'statistics' | 'sta'
  const [tab, setTab] = useState<Tab>('trials')

  // ---- Sweep data (pre + post) ----
  // Each fetch carries its channel's pre-detection filter params
  // (when enabled) so the displayed trace matches what detection
  // sees. Re-fetches when any filter knob changes, so the user sees
  // the effect of toggling the filter live.
  const [preData, setPreData] = useState<{ time: number[]; values: number[] } | null>(null)
  const [postData, setPostData] = useState<{ time: number[]; values: number[] } | null>(null)

  // Pre filter params live snake_case'd inside ``preParams``; post
  // is camelCase via the typed PostParams. Pull both into a stable
  // signature for the effect's dependency list so the fetch only
  // re-runs when something actually changed.
  const preFilterEnabled = Boolean(form.preParams.filter_enabled ?? false)
  const preFilterType = String(form.preParams.filter_type ?? 'lowpass')
  const preFilterLow = Number(form.preParams.filter_low ?? 0)
  const preFilterHigh = Number(form.preParams.filter_high ?? 0)
  const preFilterOrder = Number(form.preParams.filter_order ?? 4)

  useEffect(() => {
    let cancelled = false
    const fetchOne = async (
      traceIdx: number,
      filter: {
        enabled: boolean
        type: string
        low: number
        high: number
        order: number
      },
      setter: (v: { time: number[]; values: number[] } | null) => void,
    ) => {
      try {
        const params = new URLSearchParams({
          group: String(group), series: String(series),
          sweep: String(sweep), trace: String(traceIdx),
          // Full resolution — AP / Burst use this for the same
          // reason: LTTB decimation can drop the actual peak
          // sample, making the trace's drawn line dip below the
          // detected peak and the on-trace markers sit "lower"
          // than the real value. Sweeps in paired protocols are
          // short enough (typically 1–5 s at 20 kHz) for full
          // resolution to be fine.
          max_points: '0',
        })
        if (filter.enabled) {
          params.set('filter_type', filter.type)
          params.set('filter_low', String(filter.low))
          params.set('filter_high', String(filter.high))
          params.set('filter_order', String(filter.order))
        }
        const r = await fetch(`${backendUrl}/api/traces/data?${params}`)
        if (!r.ok) { setter(null); return }
        const d = await r.json()
        if (cancelled) return
        setter({ time: d.time as number[], values: d.values as number[] })
      } catch {
        if (!cancelled) setter(null)
      }
    }
    if (totalSweeps > 0 && channels.length > 0) {
      fetchOne(preTrace, {
        enabled: preFilterEnabled, type: preFilterType,
        low: preFilterLow, high: preFilterHigh, order: preFilterOrder,
      }, setPreData)
      if (preTrace !== postTrace) {
        fetchOne(postTrace, {
          enabled: form.postParams.filterEnabled,
          type: form.postParams.filterType,
          low: form.postParams.filterLow,
          high: form.postParams.filterHigh,
          order: form.postParams.filterOrder,
        }, setPostData)
      } else {
        setPostData(null)
      }
    }
    return () => { cancelled = true }
  }, [
    backendUrl, group, series, sweep, preTrace, postTrace,
    totalSweeps, channels.length,
    preFilterEnabled, preFilterType, preFilterLow, preFilterHigh, preFilterOrder,
    form.postParams.filterEnabled, form.postParams.filterType,
    form.postParams.filterLow, form.postParams.filterHigh, form.postParams.filterOrder,
  ])

  // ---- Shared X axis ----
  // Parent owns the single source of truth for the X range. Both
  // viewers read this and write through ``setXRange`` so wheel-zoom
  // / pan on either drives both in lockstep.
  const [xRange, setXRange] = useState<[number, number] | null>(null)
  // Reset shared X when we switch series.
  useEffect(() => { setXRange(null) }, [group, series])

  // ---- Manual edits (pre-event add / remove via clicks on the viewer) ----
  // Local React state so click handlers can mutate fast and the
  // re-run hits the latest values via a ref (the run callback is
  // useCallback'd; we don't want clicks to recreate it). The
  // rehydration effect copies the most recently-stored edits back
  // into local state when the user navigates between series.
  const [manualEdits, setManualEdits] = useState<PairedManualEdits>(
    { added: {}, removed: {} },
  )
  const manualEditsRef = useRef(manualEdits)
  manualEditsRef.current = manualEdits
  useEffect(() => {
    const stored = pairedAnalyses[`${group}:${series}`]
    setManualEdits(stored?.manualEdits ?? { added: {}, removed: {} })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, series])

  // ---- Post-detection bounds (analysis cursors on the post viewer) ----
  // ``null`` start = no clip (use post_ms only). When both are set,
  // peak search per trial is intersected with [start, end] in
  // absolute sweep time. Persisted per-series as part of PairedData
  // so the cursors survive series switches and Run.
  const [postBounds, setPostBounds] = useState<{ start: number | null; end: number | null }>(
    { start: null, end: null },
  )
  // Show/hide checkboxes for the cursor bands on the (now combined)
  // viewer. Defaults to off — users opt-in. ``showPostBounds`` ties
  // to whether the bounds are actually applied to detection.
  const [showPreBounds, setShowPreBounds] = useState(false)
  const [showPostBounds, setShowPostBounds] = useState(false)
  // Hydrate post-bounds from a stored entry on series change.
  useEffect(() => {
    const stored = pairedAnalyses[`${group}:${series}`]
    if (stored && stored.postSearchStartS != null && stored.postSearchEndS != null) {
      setPostBounds({
        start: stored.postSearchStartS,
        end: stored.postSearchEndS,
      })
    } else {
      setPostBounds({ start: null, end: null })
    }
  }, [group, series, pairedAnalyses])

  // ---- Splitter heights / widths (persisted in Electron prefs) ----
  // ``topHeight`` = pixel height of the viewers area; result region
  // takes whatever's below. ``leftPanelWidth`` = sidebar pixel width.
  // Both hydrate from ``pairedWindowUI`` on mount and write back at
  // mouseup to avoid spamming prefs writes during the drag.
  const [topHeight, setTopHeight] = useState(360)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const saved = prefs?.pairedWindowUI?.topHeight
        if (!cancelled && typeof saved === 'number' && saved >= 150 && saved <= 800) {
          setTopHeight(saved)
        }
        const savedW = prefs?.pairedWindowUI?.leftPanelWidth
        if (!cancelled && typeof savedW === 'number' && savedW >= 240 && savedW <= 600) {
          setLeftPanelWidth(savedW)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const writePairedUIPref = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.pairedWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, pairedWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  const onTopSplitMouseDown = useCallback((e: React.MouseEvent) => {
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
      writePairedUIPref({ topHeight: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [topHeight, writePairedUIPref])

  // ---- Run ----
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const onRun = useCallback(async () => {
    if (totalSweeps === 0) return
    if (preTrace === postTrace) {
      setRunError('Pre and post channels must differ.')
      return
    }
    setRunning(true)
    setRunError(null)
    try {
      const sweeps =
        runMode === 'all' ? Array.from({ length: totalSweeps }, (_, i) => i)
        : runMode === 'range' ? Array.from({
          length: Math.max(0, sweepTo - sweepFrom + 1),
        }, (_, i) => sweepFrom - 1 + i)
        : [sweepOne - 1]

      const body = {
        group, series,
        pre_trace: preTrace,
        post_trace: postTrace,
        sweeps,
        pre_mode: form.preMode,
        pre_params: form.preParams,
        post_params: {
          pre_ms: form.postParams.preMs,
          post_ms: form.postParams.postMs,
          baseline_ms: form.postParams.baselineMs,
          peak_direction: form.postParams.peakDirection,
          filter_enabled: form.postParams.filterEnabled,
          filter_type: form.postParams.filterType,
          filter_low: form.postParams.filterLow,
          filter_high: form.postParams.filterHigh,
          filter_order: form.postParams.filterOrder,
          // Optional absolute-time clip from the post-search cursors.
          // Applied whenever both values are set, regardless of
          // whether the user has the visualisation checkbox ticked
          // (the checkbox is now visibility-only — clear the start /
          // end values to disable the clip). Backend treats null /
          // undefined as "no clip".
          post_search_start_s: postBounds.start,
          post_search_end_s:   postBounds.end,
        },
        failure_params: {
          rule: form.failureParams.rule,
          k_sd: form.failureParams.kSd,
          absolute: form.failureParams.absolute,
        },
        latency_params: {
          rule: form.latencyParams.rule,
          fraction: form.latencyParams.fraction,
        },
        manual_edits: manualEditsRef.current ? {
          added: manualEditsRef.current.added,
          removed: manualEditsRef.current.removed,
          // Backend uses snake_case; ``postFailed`` is camelCase in
          // our store so we translate here at the API boundary.
          post_failed: manualEditsRef.current.postFailed ?? {},
        } : null,
      }
      const r = await fetch(`${backendUrl}/api/paired/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const text = await r.text()
        setRunError(`Run failed: ${r.status} ${text}`)
        return
      }
      const d = await r.json()
      const data: PairedData = {
        group, series,
        preTrace, postTrace,
        sweeps,
        samplingRate: d.sampling_rate,
        preMode: form.preMode,
        preParams: form.preParams,
        postParams: form.postParams,
        failureParams: form.failureParams,
        latencyParams: form.latencyParams,
        manualEdits: manualEditsRef.current,
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
        staAll: mapSta(d.sta_all),
        staSuccess: mapSta(d.sta_success),
        staFailure: mapSta(d.sta_failure),
        selectedTrialIdx: null,
        postSearchStartS: postBounds.start,
        postSearchEndS: postBounds.end,
      }
      setPairedAnalysis(group, series, data)
      setPairedForm(form)
    } catch (e: any) {
      setRunError(`Run failed: ${e?.message ?? String(e)}`)
    } finally {
      setRunning(false)
    }
  }, [
    backendUrl, group, series, preTrace, postTrace, totalSweeps,
    runMode, sweepFrom, sweepTo, sweepOne, form, pairedAnalyses,
    formKey, setPairedAnalysis, setPairedForm,
    // postBounds / showPostBounds are read inside the body — must
    // be in deps or the button click will use a stale closure
    // captured from the last render where some OTHER dep changed,
    // sending stale bounds (or no bounds) to the backend.
    postBounds, showPostBounds,
  ])

  const stored = pairedAnalyses[formKey] ?? null

  // ---- Manual click handlers (pre + post viewer) ----
  // ``onAddPreEvent`` is called when the user left-clicks on empty
  // space in either viewer — adds a new pre event at the click time.
  // ``onRemoveTrialAt`` is called when the prime + reclick gesture
  // confirms a removal — drops the corresponding pre event from the
  // detected list (or from manualEdits.added if it was a manual add).
  // Both trigger an immediate re-run via setTimeout so the closure
  // sees the just-updated manualEditsRef value.
  const onAddPreEvent = useCallback((t: number) => {
    if (totalSweeps === 0) return
    setManualEdits((prev) => {
      const added = { ...prev.added }
      const arr = added[sweep] ? [...added[sweep]] : []
      arr.push(t)
      added[sweep] = arr
      return { ...prev, added }
    })
    setTimeout(() => onRun(), 0)
  }, [sweep, onRun, totalSweeps])
  const onTogglePostFailure = useCallback((preT: number) => {
    if (totalSweeps === 0) return
    const minDistMs = Number(form.preParams.min_distance_ms ?? 2.0)
    const tol = Math.max(0.001, minDistMs / 1000.0)
    setManualEdits((prev) => {
      const pf = { ...(prev.postFailed ?? {}) }
      const arr = pf[sweep] ? [...pf[sweep]] : []
      const idx = arr.findIndex((x) => Math.abs(x - preT) <= tol)
      if (idx >= 0) {
        arr.splice(idx, 1)
        if (arr.length === 0) delete pf[sweep]
        else pf[sweep] = arr
      } else {
        arr.push(preT)
        pf[sweep] = arr
      }
      return { ...prev, postFailed: pf }
    })
    setTimeout(() => onRun(), 0)
  }, [sweep, onRun, totalSweeps, form.preParams.min_distance_ms])
  const onRemoveTrialAt = useCallback((preT: number) => {
    if (totalSweeps === 0) return
    // Tolerance for matching: minimum spacing between pre events,
    // converted to seconds. Falls back to 1 ms if not set.
    const minDistMs = Number(form.preParams.min_distance_ms ?? 2.0)
    const tol = Math.max(0.001, minDistMs / 1000.0)
    setManualEdits((prev) => {
      const addedSweep = prev.added[sweep] ?? []
      // Was this a manual add? Then strip it from added (instead
      // of pushing to removed, which would create both add+remove
      // entries that cancel out).
      const matchAddedIdx = addedSweep.findIndex((x) => Math.abs(x - preT) <= tol)
      if (matchAddedIdx >= 0) {
        const arr = [...addedSweep]
        arr.splice(matchAddedIdx, 1)
        const added = { ...prev.added, [sweep]: arr }
        if (arr.length === 0) delete added[sweep]
        return { ...prev, added }
      }
      // Auto-detected event — push to removed.
      const removed = { ...prev.removed }
      const arr = removed[sweep] ? [...removed[sweep]] : []
      arr.push(preT)
      removed[sweep] = arr
      return { ...prev, removed }
    })
    setTimeout(() => onRun(), 0)
  }, [sweep, onRun, totalSweeps, form.preParams.min_distance_ms])

  // ---- Resizable left sidebar ----
  const [leftPanelWidth, setLeftPanelWidth] = useState(360)
  const onSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftPanelWidth
    let latest = startW
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      latest = Math.max(240, Math.min(600, startW + dx))
      setLeftPanelWidth(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writePairedUIPref({ leftPanelWidth: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftPanelWidth, writePairedUIPref])

  // ---- UI ----
  const channelOptions = channels.map((c: any, i: number) => ({
    value: c.index ?? i, label: c.label || `Ch ${(c.index ?? i) + 1}`,
  }))
  const sweepLabel = totalSweeps > 0 ? `${sweep + 1}/${totalSweeps}` : '—'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ───── Top header: selectors + sweep arrows ───── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        gap: 8, padding: '6px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--font-size-sm)',
      }}>
        <Selector label="Group" value={group}
          onChange={setGroup}
          options={Array.from({ length: fileInfo?.groupCount ?? 0 }, (_, i) => ({
            value: i, label: `${i + 1}`,
          }))}
        />
        <Selector label="Series" value={series}
          onChange={setSeries}
          options={(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => ({
            value: i, label: s.label || `S${i + 1}`,
          }))}
        />
        <Selector label="Pre" value={preTrace}
          onChange={setPreTrace}
          options={channelOptions}
        />
        <Selector label="Post" value={postTrace}
          onChange={setPostTrace}
          options={channelOptions}
        />
        <div style={{ flex: 1 }} />
        {/* Sweep arrow cluster — back / forward only. The wider AP
            cluster (first / ±10 / last) made sense for current-clamp
            recordings with hundreds of sweeps; for paired protocols
            the user navigates one trial at a time. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep === 0}
            onClick={() => setSweep(Math.max(0, sweep - 1))} title="Prev sweep">◀</button>
          <span style={{
            display: 'inline-flex', minWidth: 60, justifyContent: 'center',
            color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums',
          }}>Sweep {sweepLabel}</span>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep >= totalSweeps - 1}
            onClick={() => setSweep(Math.min(totalSweeps - 1, sweep + 1))}
            title="Next sweep">▶</button>
        </span>
      </div>

      {/* ───── Body: left sidebar + main ───── */}
      {/* ``overflow: hidden`` + ``minWidth: 0`` are both needed: the
          first stops the body from growing beyond its parent when
          the user shrinks the window (so buttons don't render off-
          screen); the second lets the flex children below ignore
          their intrinsic content width and actually shrink. */}
      <div style={{
        flex: 1, display: 'flex', minHeight: 0, minWidth: 0,
        overflow: 'hidden',
        gap: 0, padding: 8,
      }}>
        {/* Left sidebar — same shell shape as APWindow's left panel:
            bg-secondary tone, padded, bordered, with a scrollable param
            region above a pinned Run-controls card. */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)',
          padding: 8,
          borderRadius: 4,
          border: '1px solid var(--border)',
        }}>
          {/* Scrollable param sections. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,
          }}>
            <PreSourceCard form={form} onChange={updateForm}
              showBounds={showPreBounds}
              setShowBounds={setShowPreBounds} />
            <PostWindowCard form={form} onChange={updateForm}
              bounds={postBounds}
              onBoundsChange={setPostBounds}
              showBounds={showPostBounds}
              setShowBounds={setShowPostBounds} />
            <FailureThresholdCard form={form} onChange={updateForm} />
            <LatencyCard form={form} onChange={updateForm} />
          </div>
          {/* Pinned footer: Run controls — same chrome as the AP / FPsp
              run footer (bordered card with primary Run button + small
              Clear secondary, sweep-scope dropdown progressively
              disclosing range / single rows). */}
          <div style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <button className="btn btn-primary" onClick={onRun}
              disabled={running || totalSweeps === 0}
              style={{
                width: '100%', padding: '8px 0',
                fontSize: 'var(--font-size-sm)', fontWeight: 600,
              }}>
              {running ? 'Running…' : 'Run'}
            </button>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--font-size-label)',
            }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Run on</span>
              <select value={runMode} style={{ minWidth: 130 }}
                onChange={(e) => setRunMode(e.target.value as RunMode)}>
                <option value="all">All sweeps</option>
                <option value="range">Range</option>
                <option value="one">Single</option>
              </select>
            </label>
            {runMode === 'range' && (
              <div style={{
                display: 'flex', gap: 6, alignItems: 'center',
                fontSize: 'var(--font-size-label)',
              }}>
                <span style={{ color: 'var(--text-muted)' }}>From</span>
                <NumInput value={sweepFrom} min={1} max={totalSweeps}
                  onChange={(v) => setSweepFrom(Math.max(1, Math.round(v)))}
                  style={{ width: 60 }} />
                <span style={{ color: 'var(--text-muted)' }}>to</span>
                <NumInput value={sweepTo} min={1} max={totalSweeps}
                  onChange={(v) => setSweepTo(Math.max(sweepFrom, Math.round(v)))}
                  style={{ width: 60 }} />
              </div>
            )}
            {runMode === 'one' && (
              <div style={{
                display: 'flex', gap: 6, alignItems: 'center',
                fontSize: 'var(--font-size-label)',
              }}>
                <span style={{ color: 'var(--text-muted)' }}>Sweep</span>
                <NumInput value={sweepOne} min={1} max={totalSweeps}
                  onChange={(v) => setSweepOne(Math.max(1, Math.min(totalSweeps, Math.round(v))))}
                  style={{ width: 60 }} />
              </div>
            )}
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn"
                onClick={() => clearPairedAnalysis(group, series)}
                disabled={!stored}
                style={{
                  flex: 1,
                  fontSize: 'var(--font-size-label)', padding: '4px 10px',
                }}
                title="Clear stored results for this series">
                Clear results
              </button>
              <button className="btn"
                onClick={() => stored && exportPairedTrialsCSV(
                  stored.perTrial,
                  fileInfo?.fileName ?? 'recording',
                  group, series,
                )}
                disabled={!stored || stored.perTrial.length === 0}
                style={{
                  flex: 1,
                  fontSize: 'var(--font-size-label)', padding: '4px 10px',
                }}
                title="Export per-trial measurements to CSV">
                Export CSV
              </button>
            </div>
            {runError && (
              <div className="notice notice-error" style={{
                whiteSpace: 'pre-wrap',
              }}>{runError}</div>
            )}
          </div>
        </div>

        {/* Vertical splitter between sidebar and main column. */}
        <div onMouseDown={onSidebarDrag} style={{
          width: 4, cursor: 'col-resize', flexShrink: 0,
          background: 'var(--border)',
          marginLeft: 4, marginRight: 4,
        }} />

        {/* Main content — ``minWidth: 0`` lets the column shrink
            below the intrinsic width of the viewer header (which
            otherwise stretches to fit its buttons and shoves the
            Reset zoom button off-screen on narrow windows). */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          minHeight: 0, minWidth: 0,
        }}>
          {/* Single overlay viewer — pre on left Y axis, post on right
              Y axis. Fixed pixel height driven by the row-resize
              splitter below. */}
          <div style={{
            height: topHeight, minHeight: 180, flexShrink: 0,
            display: 'flex', flexDirection: 'column', minWidth: 0,
          }}>
            <OverlayViewer
              preData={preData}
              postData={postData}
              preColor={cssVar('--trace-color-1')}
              postColor={cssVar('--trace-color-2')}
              preUnits={channels[preTrace]?.units ?? ''}
              postUnits={channels[postTrace]?.units ?? ''}
              xRange={xRange}
              onXRangeChange={setXRange}
              heightSignal={topHeight}
              detectionMarkers={stored && stored.preTrace === preTrace
                ? stored.perTrial
                    .filter((t) => t.sweep === sweep)
                    .map((t) => ({ t: t.preTS, preT: t.preTS, manual: t.manual }))
                : []}
              postPeakMarkers={stored && stored.postTrace === postTrace
                ? stored.perTrial.filter((t) => t.sweep === sweep).map((t) => ({
                  t: t.postPeakTS, y: t.postPeak, preT: t.preTS,
                  success: t.success,
                  postManualFailure: t.postManualFailure,
                }))
                : []}
              onAddPreEvent={onAddPreEvent}
              onRemoveTrialAt={onRemoveTrialAt}
              onTogglePostFailure={onTogglePostFailure}
              preBounds={{
                start: Number(form.preParams.bounds_start_s ?? 0),
                end:   Number(form.preParams.bounds_end_s ?? 0),
              }}
              onPreBoundsChange={(next) => updateForm({
                preParams: {
                  ...form.preParams,
                  bounds_start_s: next.start,
                  bounds_end_s: next.end,
                },
              })}
              showPreBounds={showPreBounds}
              postBounds={postBounds}
              onPostBoundsChange={setPostBounds}
              showPostBounds={showPostBounds}
            />
          </div>
          {/* Horizontal splitter between viewers and result region. */}
          <div onMouseDown={onTopSplitMouseDown} style={{
            height: 4, cursor: 'row-resize', flexShrink: 0,
            background: 'var(--border)',
          }} />

          {/* Tab strip — segmented control in a hairline-bordered bar. */}
          <div style={{
            flexShrink: 0, display: 'flex',
            borderBottom: '1px solid var(--border)',
            padding: '6px 8px',
            background: 'var(--bg-secondary)',
          }}>
            <div className="segmented">
              {(['trials', 'statistics', 'sta'] as Tab[]).map((t) => {
                const label = t === 'trials' ? 'Trials'
                  : t === 'statistics' ? 'Statistics'
                  : 'STA / Average'
                const active = tab === t
                return (
                  <button key={t}
                    className={active ? 'active' : undefined}
                    onClick={() => setTab(t)}
                    style={{ flex: 'none', padding: '0 18px', whiteSpace: 'nowrap' }}>{label}</button>
                )
              })}
            </div>
          </div>

          {/* Result region — absorbs whatever's below the splitter. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'hidden',
            background: 'var(--bg-secondary)',
            display: 'flex', flexDirection: 'column',
          }}>
            {tab === 'trials' && <TrialsTab data={stored} />}
            {tab === 'statistics' && (
              <StatisticsTab
                data={stored}
                fileName={fileInfo?.fileName ?? 'recording'}
                group={group} series={series}
              />
            )}
            {tab === 'sta' && <STATab data={stored} />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Top-bar selector
// ---------------------------------------------------------------------------

function Selector({
  label, value, onChange, options,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  options: { value: number; label: string }[]
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={{ minWidth: 80 }}>
        {options.length === 0 && <option value={0}>—</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Param cards (left sidebar)
//
// Match the AP / Events / FPsp convention: each card is a single
// bordered + rounded two-column grid; section dividers come from
// ``SubHeader`` strips with a hairline top border. ``Field`` wraps a
// label-above-input pair for dropdowns; ``ParamRow`` does the same
// with a fixed-width NumInput so columns line up vertically across
// cards.
// ---------------------------------------------------------------------------

function ParamGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="section-card" style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      gap: 8,
    }}>
      {children}
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

function ParamRow({
  label, value, step, min, max, onChange,
}: {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange}
        style={{ width: 110 }} />
    </label>
  )
}

/** Pre-detection filter row — used inside both pre and post param
 *  cards. Reads / writes whatever shape the parent passes in (pre
 *  uses snake_case keys, post uses camelCase via PostParams), so the
 *  caller wires this up via getter / setter callbacks. */
function FilterRow({
  enabled, type, low, high, order, onChange,
}: {
  enabled: boolean
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
  low: number
  high: number
  order: number
  onChange: (patch: {
    enabled?: boolean
    type?: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
    low?: number
    high?: number
    order?: number
  }) => void
}) {
  return (
    <>
      <label style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-label)',
      }}>
        <input type="checkbox" checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })} />
        <span>Pre-detection filter</span>
      </label>
      {enabled && (
        <>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Type">
              <select value={type}
                onChange={(e) => onChange({ type: e.target.value as any })}>
                <option value="lowpass">Lowpass</option>
                <option value="highpass">Highpass</option>
                <option value="bandpass">Bandpass</option>
                <option value="notch">Notch</option>
              </select>
            </Field>
          </div>
          {(type === 'highpass' || type === 'bandpass' || type === 'notch') && (
            <ParamRow label="Low (Hz)"
              value={low} step={1} min={0}
              onChange={(v) => onChange({ low: v })} />
          )}
          {(type === 'lowpass' || type === 'bandpass' || type === 'notch') && (
            <ParamRow label="High (Hz)"
              value={high} step={50} min={1}
              onChange={(v) => onChange({ high: v })} />
          )}
          <ParamRow label="Order"
            value={order} step={1} min={1} max={8}
            onChange={(v) => onChange({ order: Math.max(1, Math.min(8, Math.round(v))) })} />
        </>
      )}
    </>
  )
}

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

function PreSourceCard({
  form, onChange, showBounds, setShowBounds,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
  showBounds: boolean
  setShowBounds: (v: boolean) => void
}) {
  const setPP = (patch: Record<string, unknown>) =>
    onChange({ preParams: { ...form.preParams, ...patch } })
  return (
    <ParamGrid>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Pre-event source">
          <select value={form.preMode}
            onChange={(e) => onChange({ preMode: e.target.value as PairedFormState['preMode'] })}>
            <option value="ap">AP detect</option>
            <option value="stim">Stim artifact</option>
            <option value="ttl">TTL pulse</option>
            <option value="manual">Manual only</option>
          </select>
        </Field>
      </div>

      {form.preMode === 'ap' && (
        <>
          <SubHeader>AP detection</SubHeader>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Method">
              <select value={String(form.preParams.ap_method ?? 'auto_rec')}
                onChange={(e) => setPP({ ap_method: e.target.value })}>
                <option value="auto_rec">Auto (adaptive)</option>
                <option value="auto_spike">Auto (single pass)</option>
                <option value="manual">Manual threshold</option>
              </select>
            </Field>
          </div>
          {String(form.preParams.ap_method ?? 'auto_rec') === 'manual' ? (
            <ParamRow label="Manual threshold (mV)"
              value={Number(form.preParams.ap_manual_threshold_mv ?? -10)}
              step={5}
              onChange={(v) => setPP({ ap_manual_threshold_mv: v })} />
          ) : (
            <>
              <ParamRow label="Min amplitude (mV)"
                value={Number(form.preParams.ap_min_amplitude_mv ?? 50)} step={5} min={0}
                onChange={(v) => setPP({ ap_min_amplitude_mv: v })} />
              <ParamRow label="+dV/dt (mV/ms)"
                value={Number(form.preParams.ap_pos_dvdt_mv_ms ?? 10)} step={1} min={0}
                onChange={(v) => setPP({ ap_pos_dvdt_mv_ms: v })} />
              <ParamRow label="−dV/dt (mV/ms)"
                value={Number(form.preParams.ap_neg_dvdt_mv_ms ?? -10)} step={1}
                onChange={(v) => setPP({ ap_neg_dvdt_mv_ms: v })} />
              <ParamRow label="Max width (ms)"
                value={Number(form.preParams.ap_width_ms ?? 5)} step={0.5} min={0.1}
                onChange={(v) => setPP({ ap_width_ms: v })} />
            </>
          )}
        </>
      )}

      {form.preMode === 'stim' && (
        <>
          <SubHeader>Stim artifact</SubHeader>
          <ParamRow label="|d/dt| threshold (units/s)"
            value={Number(form.preParams.stim_dvdt_threshold ?? 1.0e3)} step={100}
            onChange={(v) => setPP({ stim_dvdt_threshold: v })} />
        </>
      )}

      {form.preMode === 'ttl' && (
        <>
          <SubHeader>TTL pulse</SubHeader>
          <label style={{
            gridColumn: '1 / -1',
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 'var(--font-size-label)',
          }}
            title="Uncheck for auto threshold (midway between sweep min and max)">
            <input type="checkbox"
              checked={form.preParams.ttl_level_threshold !== null
                && form.preParams.ttl_level_threshold !== undefined}
              onChange={(e) => setPP({ ttl_level_threshold: e.target.checked ? 2.5 : null })} />
            <span>Manual level threshold</span>
          </label>
          {form.preParams.ttl_level_threshold !== null
            && form.preParams.ttl_level_threshold !== undefined && (
            <ParamRow label="Level threshold"
              value={Number(form.preParams.ttl_level_threshold)} step={0.5}
              onChange={(v) => setPP({ ttl_level_threshold: v })} />
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Edge">
              <select value={String(form.preParams.ttl_edge ?? 'rising')}
                onChange={(e) => setPP({ ttl_edge: e.target.value })}>
                <option value="rising">Rising</option>
                <option value="falling">Falling</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </div>
          <ParamRow label="Min pulse (ms)"
            value={Number(form.preParams.ttl_min_pulse_ms ?? 1.0)} step={0.5} min={0}
            onChange={(v) => setPP({ ttl_min_pulse_ms: v })} />
        </>
      )}

      <SubHeader>Filter</SubHeader>
      <FilterRow
        enabled={Boolean(form.preParams.filter_enabled ?? false)}
        type={(form.preParams.filter_type as any) ?? 'lowpass'}
        low={Number(form.preParams.filter_low ?? 1)}
        high={Number(form.preParams.filter_high ?? 1000)}
        order={Number(form.preParams.filter_order ?? 1)}
        onChange={(p) => setPP({
          ...(p.enabled !== undefined ? { filter_enabled: p.enabled } : {}),
          ...(p.type !== undefined ? { filter_type: p.type } : {}),
          ...(p.low !== undefined ? { filter_low: p.low } : {}),
          ...(p.high !== undefined ? { filter_high: p.high } : {}),
          ...(p.order !== undefined ? { filter_order: p.order } : {}),
        })}
      />

      <SubHeader>Spacing & bounds</SubHeader>
      <ParamRow label="Min distance (ms)"
        value={Number(form.preParams.min_distance_ms ?? 5.0)} step={0.5} min={0.1}
        onChange={(v) => setPP({ min_distance_ms: v })} />
      <label style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-label)',
      }}
        title="Show pre-detection analysis bounds on the viewer. Drag the cursors or edit the start/end values below.">
        <input type="checkbox" checked={showBounds}
          onChange={(e) => setShowBounds(e.target.checked)} />
        <span>Show pre-detection cursors</span>
      </label>
      <ParamRow label="Start (ms)"
        value={Number(form.preParams.bounds_start_s ?? 0) * 1000} step={5} min={0}
        onChange={(v) => setPP({ bounds_start_s: Math.max(0, v / 1000) })} />
      <ParamRow label="End (ms, 0=auto)"
        value={Number(form.preParams.bounds_end_s ?? 0) * 1000} step={5} min={0}
        onChange={(v) => setPP({ bounds_end_s: Math.max(0, v / 1000) })} />
    </ParamGrid>
  )
}

function PostWindowCard({
  form, onChange,
  bounds, onBoundsChange, showBounds, setShowBounds,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
  bounds: { start: number | null; end: number | null }
  onBoundsChange: (next: { start: number | null; end: number | null }) => void
  showBounds: boolean
  setShowBounds: (v: boolean) => void
}) {
  const set = (patch: Partial<PairedFormState['postParams']>) =>
    onChange({ postParams: { ...form.postParams, ...patch } })
  const startMs = bounds.start != null ? bounds.start * 1000 : 0
  const endMs   = bounds.end   != null ? bounds.end   * 1000 : 0
  return (
    <ParamGrid>
      <SubHeader>Post window</SubHeader>
      <ParamRow label="Pre-anchor (ms)"
        value={form.postParams.preMs} step={0.5} min={0}
        onChange={(v) => set({ preMs: v })} />
      <ParamRow label="Post-anchor (ms)"
        value={form.postParams.postMs} step={1} min={0.1}
        onChange={(v) => set({ postMs: v })} />
      <ParamRow label="Baseline (ms)"
        value={form.postParams.baselineMs} step={0.5} min={0.1}
        onChange={(v) => set({ baselineMs: v })} />
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Peak direction">
          <select value={form.postParams.peakDirection}
            onChange={(e) => set({ peakDirection: e.target.value as any })}>
            <option value="auto">Auto</option>
            <option value="positive">Positive</option>
            <option value="negative">Negative</option>
          </select>
        </Field>
      </div>

      <SubHeader>Filter</SubHeader>
      <FilterRow
        enabled={form.postParams.filterEnabled}
        type={form.postParams.filterType}
        low={form.postParams.filterLow}
        high={form.postParams.filterHigh}
        order={form.postParams.filterOrder}
        onChange={(p) => set({
          ...(p.enabled !== undefined ? { filterEnabled: p.enabled } : {}),
          ...(p.type !== undefined ? { filterType: p.type } : {}),
          ...(p.low !== undefined ? { filterLow: p.low } : {}),
          ...(p.high !== undefined ? { filterHigh: p.high } : {}),
          ...(p.order !== undefined ? { filterOrder: p.order } : {}),
        })}
      />

      <SubHeader>Search cursors</SubHeader>
      <label style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-label)',
      }}
        title="Show / hide the post-search cursor band on the viewer. Detection always honours the Start / End values below when both are set; this toggle is for visualisation only.">
        <input type="checkbox" checked={showBounds}
          onChange={(e) => {
            const v = e.target.checked
            setShowBounds(v)
            if (v && (bounds.start == null || bounds.end == null)) {
              // Seed default cursors at 100–500 ms — sensible for
              // typical paired-recording protocols. User adjusts.
              onBoundsChange({
                start: bounds.start ?? 0.10,
                end: bounds.end ?? 0.50,
              })
            }
          }} />
        <span>Show post-search cursors on viewer</span>
      </label>
      <ParamRow label="Start (ms)"
        value={startMs} step={5}
        onChange={(v) => onBoundsChange({ start: v / 1000, end: bounds.end })} />
      <ParamRow label="End (ms)"
        value={endMs} step={5}
        onChange={(v) => onBoundsChange({ start: bounds.start, end: v / 1000 })} />
    </ParamGrid>
  )
}

function FailureThresholdCard({
  form, onChange,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
}) {
  const set = (patch: Partial<PairedFormState['failureParams']>) =>
    onChange({ failureParams: { ...form.failureParams, ...patch } })
  return (
    <ParamGrid>
      <SubHeader>Failure threshold</SubHeader>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Rule">
          <select value={form.failureParams.rule}
            onChange={(e) => set({ rule: e.target.value as any })}>
            <option value="k_sd">k × baseline SD</option>
            <option value="absolute">Absolute amplitude</option>
          </select>
        </Field>
      </div>
      {form.failureParams.rule === 'k_sd' ? (
        <ParamRow label="k"
          value={form.failureParams.kSd} step={0.5} min={0}
          onChange={(v) => set({ kSd: v })} />
      ) : (
        <ParamRow label="|amplitude| ≥"
          value={form.failureParams.absolute} step={1} min={0}
          onChange={(v) => set({ absolute: v })} />
      )}
    </ParamGrid>
  )
}

function LatencyCard({
  form, onChange,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
}) {
  const set = (patch: Partial<PairedFormState['latencyParams']>) =>
    onChange({ latencyParams: { ...form.latencyParams, ...patch } })
  return (
    <ParamGrid>
      <SubHeader>Latency rule</SubHeader>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Method">
          <select value={form.latencyParams.rule}
            onChange={(e) => set({ rule: e.target.value as any })}>
            <option value="fraction">Fraction of peak</option>
            <option value="onset_d2">Onset (d²V/dt²)</option>
          </select>
        </Field>
      </div>
      {form.latencyParams.rule === 'fraction' && (
        <ParamRow label="Fraction"
          value={form.latencyParams.fraction} step={0.05} min={0} max={1}
          onChange={(v) => set({ fraction: v })} />
      )}
    </ParamGrid>
  )
}

// ---------------------------------------------------------------------------
// Mini-viewer (uPlot, rebuild-on-data, shared X via parent ref)
// ---------------------------------------------------------------------------

// Overlay colours as theme-token names, resolved with cssVar() at draw
// time so theme switches apply.
const BOUND_COLOR = '--marker-bounds'      // analysis-bounds band (post viewer)
const PRE_MARKER_COLOR = '--marker-manual' // pre events + pre bounds band
const SUCCESS_COLOR = '--success'
const FAILURE_COLOR = '--error'
const MARKER_RADIUS = 5          // matches AP / Bursts spike-marker size
const MARKER_RING_RADIUS = 9     // for manually-added markers
const BAND_EDGE_PX = 6           // grab tolerance on bounds edges
const DRAG_THRESHOLD_PX = 3      // click-vs-drag

/**
 * Overlay viewer — single uPlot showing pre + post on the same X axis
 * with two independent Y axes (left = pre, right = post). Replaces
 * the old stacked-mini-viewer arrangement so the user can read latencies
 * across both channels without eye-jumping.
 *
 * Conventions copied from the main TraceViewer / AP sweep viewer:
 *
 * - ``cursor.drag.{x,y}: false`` disables uPlot's native rectangle
 *   selection. Wheel + pointer-drag are wired by hand on ``.u-over``.
 * - All zoom / pan goes through ``u.setScale(scale, {min, max})`` so
 *   the same frame's draw call sees the new range. Plain ``redraw()``
 *   doesn't re-evaluate ``scales.*.range()`` callbacks.
 * - X axis values are stored in seconds; the bottom axis displays them
 *   as milliseconds via the ``values:`` formatter. ``time: false`` on
 *   the X scale stops uPlot from formatting them as Unix dates.
 * - Marker dots match AP / Bursts: 5 px radius, 1.2 px outline;
 *   manual ones get a 9 px ring. Pre-event dots ride the ``y`` scale,
 *   post-peak dots ride ``y_post`` so they sit on the right-axis trace.
 *
 * Bounds bands (analysis-bounds cursors) are drawn for both pre and
 * post when their show-flag is true. Both sets of edges + bodies are
 * drag-targets; pre uses an orange band, post uses blue, so they're
 * easy to tell apart when they overlap.
 */
function OverlayViewer({
  preData, postData,
  preColor, postColor,
  preUnits, postUnits,
  xRange, onXRangeChange, heightSignal,
  detectionMarkers, postPeakMarkers,
  preBounds, onPreBoundsChange, showPreBounds,
  postBounds, onPostBoundsChange, showPostBounds,
  onAddPreEvent, onRemoveTrialAt, onTogglePostFailure,
}: {
  preData: { time: number[]; values: number[] } | null
  postData: { time: number[]; values: number[] } | null
  preColor: string
  postColor: string
  preUnits: string
  postUnits: string
  xRange: [number, number] | null
  onXRangeChange: (r: [number, number] | null) => void
  heightSignal?: number
  /** Each pre marker carries the trial's pre-event time (``preT``)
   *  so a click can prime / remove the corresponding trial. */
  detectionMarkers: { t: number; preT: number; manual: boolean }[]
  /** Each post marker carries the trial's pre-event time (``preT``)
   *  too. ``postManualFailure`` is true when the user has marked
   *  this trial via prime+reclick on the post side; the marker
   *  draws greyed-out so the user knows it's their override. */
  postPeakMarkers?: { t: number; y: number; preT: number; success: boolean; postManualFailure?: boolean }[]
  preBounds: { start: number; end: number }
  onPreBoundsChange: (next: { start: number; end: number }) => void
  showPreBounds: boolean
  postBounds: { start: number | null; end: number | null }
  onPostBoundsChange: (next: { start: number | null; end: number | null }) => void
  showPostBounds: boolean
  /** Click on empty area → add a pre event at that time. */
  onAddPreEvent?: (t: number) => void
  /** Confirmed prime+reclick on a PRE marker → remove the trial
   *  whose pre event is at ``preT`` (drops both pre and post). */
  onRemoveTrialAt?: (preT: number) => void
  /** Confirmed prime+reclick on a POST marker → toggle the trial's
   *  manual-failure flag. The pre event stays; the trial is just
   *  reclassified to a failure (or back to its auto state). */
  onTogglePostFailure?: (preT: number) => void
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Y ranges per scale (left = pre, right = post). X is shared with
  // the parent via xRangeRef + onXRangeChange.
  const yPreRangeRef = useRef<[number, number] | null>(null)
  const yPostRangeRef = useRef<[number, number] | null>(null)
  const xRangeRef = useRef<[number, number] | null>(xRange)
  xRangeRef.current = xRange
  // Refs that the draw hook + pointer handlers read so we don't have
  // to rebuild the plot when these change frame-to-frame.
  const detectionRef = useRef(detectionMarkers)
  detectionRef.current = detectionMarkers
  const postPeakRef = useRef(postPeakMarkers ?? [])
  postPeakRef.current = postPeakMarkers ?? []
  const preBoundsRef = useRef(preBounds)
  preBoundsRef.current = preBounds
  const postBoundsRef = useRef(postBounds)
  postBoundsRef.current = postBounds
  const showPreBoundsRef = useRef(showPreBounds)
  showPreBoundsRef.current = showPreBounds
  const showPostBoundsRef = useRef(showPostBounds)
  showPostBoundsRef.current = showPostBounds
  const onXRef = useRef(onXRangeChange)
  onXRef.current = onXRangeChange
  const onPreBoundsRef = useRef(onPreBoundsChange)
  onPreBoundsRef.current = onPreBoundsChange
  const onPostBoundsRef = useRef(onPostBoundsChange)
  onPostBoundsRef.current = onPostBoundsChange
  const onAddPreEventRef = useRef(onAddPreEvent)
  onAddPreEventRef.current = onAddPreEvent
  const onRemoveTrialAtRef = useRef(onRemoveTrialAt)
  onRemoveTrialAtRef.current = onRemoveTrialAt
  const onTogglePostFailureRef = useRef(onTogglePostFailure)
  onTogglePostFailureRef.current = onTogglePostFailure
  // Currently primed marker — tracks BOTH which side (pre / post)
  // and which trial (pre-event time). Click a marker once to prime,
  // click the same one again to confirm. The two sides have
  // independent meanings:
  //   - ``side: 'pre'``  → confirm drops the trial entirely.
  //   - ``side: 'post'`` → confirm toggles manual-failure on the
  //                        trial without dropping it.
  const primedRef = useRef<{ side: 'pre' | 'post'; preT: number } | null>(null)
  // Reset the prime when sweep data changes.
  useEffect(() => { primedRef.current = null }, [preData, postData])
  const [, setVer] = useState(0)
  const bump = useCallback(() => setVer((n) => n + 1), [])
  // Bumped from inside the rebuild RAF callback once the new uPlot
  // has been constructed, so the pointer/wheel useEffect can re-run
  // and attach its handlers to the fresh ``.u-over`` element. Without
  // this, the pointer effect would fire before RAF and find
  // ``plotRef.current`` null.
  const [plotVer, setPlotVer] = useState(0)

  // Right-click PNG / SVG export menu — shared with the rest of the
  // app via ``usePlotMenu``. Left-click is already consumed by the
  // pointer handlers (``button !== 0`` short-circuits them) so
  // right-click falls through to this menu.
  const plotMenu = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'paired-overlay',
  })

  // ── Build / rebuild the plot ───────────────────────────────────
  // Wrapped in ``requestAnimationFrame`` so the destroy + create
  // pair runs after the current render's layout has settled (same
  // pattern as APWindow's sweep viewer). Without this, the new
  // plot was occasionally being constructed against stale container
  // dimensions / before scale state from the previous plot had been
  // fully torn down — which is what caused the "blank viewer after
  // sweep arrow" issue.
  useEffect(() => {
    const container = containerRef.current
    if (!container || (!preData && !postData)) {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      return
    }
    const frame = requestAnimationFrame(() => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }

    // Use pre's time grid as the master X array. Interpolate post
    // onto it so uPlot can plot both as parallel series. When pre
    // is missing, fall back to post's grid as the X.
    const masterT = preData?.time ?? postData!.time
    const preY: (number | null)[] = preData
      ? preData.values.map((v) => v)
      : new Array(masterT.length).fill(null)
    const postY: (number | null)[] = postData
      ? interpolateOnto(postData.time, postData.values, masterT)
      : new Array(masterT.length).fill(null)

    const w = container.clientWidth
    const h = container.clientHeight

    const opts: uPlot.Options = {
      width: Math.max(200, w),
      height: Math.max(80, h),
      legend: { show: false },
      // ``cursor.focus.prox`` is uPlot's series-focus mechanism: when
      // the cursor sits within ``prox`` pixels of a series sample,
      // that series becomes "focused" and the others get drawn at
      // ``series[i].alpha`` (kept in our ``setSeries`` hook below).
      // Same UX as the main TraceViewer.
      cursor: {
        drag: { x: false, y: false },
        focus: { prox: 30 },
      },
      scales: {
        // Range callbacks return the user-set ref when present, else
        // fall through to a 5 %-padded autofit on the data extents.
        // Crucially we DO NOT stash the autofit into the ref —
        // otherwise a sweep change would re-apply the previous
        // sweep's tight bounds to the new sweep's data and look
        // blank. The ref only ever holds values written by an
        // explicit user gesture (wheel, drag-pan, Fit Y).
        x: {
          time: false,
          range: (_u, dMin, dMax) => xRangeRef.current ?? [dMin, dMax],
        },
        y: {
          range: (_u, dMin, dMax) => {
            if (yPreRangeRef.current) return yPreRangeRef.current
            if (!isFinite(dMin) || !isFinite(dMax) || dMin === dMax) return [0, 1]
            const pad = (dMax - dMin) * 0.05
            return [dMin - pad, dMax + pad]
          },
        },
        y_post: {
          range: (_u, dMin, dMax) => {
            if (yPostRangeRef.current) return yPostRangeRef.current
            if (!isFinite(dMin) || !isFinite(dMax) || dMin === dMax) return [0, 1]
            const pad = (dMax - dMin) * 0.05
            return [dMin - pad, dMax + pad]
          },
        },
      },
      axes: [
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          values: (_u, splits) => splits.map((s) => fmtMs(s * 1000)),
          label: 'Time (ms)', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        { stroke: preColor,
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: `Pre (${preUnits || 'Vm'})`, labelSize: 22,
          scale: 'y',
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        { stroke: postColor,
          grid: { show: false },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: `Post (${postUnits || 'I'})`, labelSize: 22,
          scale: 'y_post', side: 1,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
      ],
      hooks: {
        draw: [(u) => drawOverlay(u)],
        // Series-focus dim: when uPlot picks a focused series via
        // ``cursor.focus.prox``, drop the other trace's stroke alpha
        // so the hovered one stands out. Reset on unfocus so both
        // come back to full opacity. Triggers a redraw via
        // ``u.redraw()`` so the canvas re-renders with the new alpha.
        setSeries: [
          (u, focusedIdx) => {
            for (let i = 1; i < u.series.length; i++) {
              const dimmed = focusedIdx != null && i !== focusedIdx
              ;(u.series[i] as any).alpha = dimmed ? 0.25 : 1
            }
            u.redraw()
          },
        ],
      },
      series: [
        {},
        { stroke: preColor, width: 1.25, label: 'Pre',
          scale: 'y', points: { show: false } },
        { stroke: postColor, width: 1.25, label: 'Post',
          scale: 'y_post', points: { show: false } },
      ],
    }
    plotRef.current = new uPlot(opts, [masterT, preY, postY] as any, container)

    // Defensive autofit. When refs are null (no manual zoom), force
    // each scale onto the new sweep's data extents explicitly. The
    // range() callbacks above should already do this during
    // construction; we double-apply here for the same reason AP /
    // Burst do — there have been edge cases (LTTB length mismatch
    // between channels, brief mixed-data state mid-fetch) where the
    // plot ended up at a stale scale and looked blank.
    if (xRangeRef.current === null && masterT.length > 1) {
      plotRef.current.setScale('x', { min: masterT[0], max: masterT[masterT.length - 1] })
    }
    const refit = (key: 'y' | 'y_post', src: { time: number[]; values: number[] } | null) => {
      if (!src || src.time.length === 0) return
      const ref = key === 'y' ? yPreRangeRef : yPostRangeRef
      if (ref.current !== null) return
      let lo = Infinity, hi = -Infinity
      for (const v of src.values) { if (v < lo) lo = v; if (v > hi) hi = v }
      if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return
      const pad = (hi - lo) * 0.05
      plotRef.current?.setScale(key, { min: lo - pad, max: hi + pad })
    }
    refit('y', preData)
    refit('y_post', postData)
    // Tell the pointer/wheel effect (and any other downstream
    // effects keyed on this counter) that a fresh plot now exists
    // so they can attach handlers to its ``.u-over`` element.
    setPlotVer((n) => n + 1)
    })  // end requestAnimationFrame
    return () => {
      cancelAnimationFrame(frame)
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preData, postData, preColor, postColor, preUnits, postUnits, themeKey])

  function drawOverlay(u: uPlot) {
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1
    const top = u.bbox.top
    const bottom = u.bbox.top + u.bbox.height

    // Bounds bands.
    const drawBand = (x0: number, x1: number, fill: string, label: string) => {
      const px0 = u.valToPos(x0, 'x', true)
      const px1 = u.valToPos(x1, 'x', true)
      ctx.save()
      ctx.globalAlpha = 0.14
      ctx.fillStyle = cssVar(fill)
      ctx.fillRect(Math.min(px0, px1), top, Math.abs(px1 - px0), bottom - top)
      ctx.globalAlpha = 1
      ctx.fillStyle = cssVar(fill)
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, top + 12 * dpr)
      ctx.restore()
    }
    if (showPreBoundsRef.current) {
      const b = preBoundsRef.current
      const xMax = u.scales.x.max ?? b.start
      const effEnd = b.end > b.start ? b.end : xMax
      drawBand(b.start, effEnd, PRE_MARKER_COLOR, 'Pre bounds')
    }
    if (showPostBoundsRef.current) {
      const b = postBoundsRef.current
      if (b.start != null) {
        const xMax = u.scales.x.max ?? b.start
        const effEnd = b.end != null ? b.end : xMax
        drawBand(b.start, effEnd, BOUND_COLOR, 'Post-search bounds')
      }
    }

    // Marker drawing helper — shared between pre-event dots and
    // post-peak dots. ``scaleKey`` picks which Y axis the marker's
    // y value is positioned against.
    const dot = (px: number, py: number, fill: string, ring: boolean) => {
      const color = cssVar(fill)
      ctx.beginPath()
      ctx.arc(px, py, MARKER_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.fill()
      ctx.strokeStyle = cssVar('--marker-outline'); ctx.lineWidth = 1.2; ctx.stroke()
      if (ring) {
        ctx.beginPath()
        ctx.arc(px, py, MARKER_RING_RADIUS, 0, Math.PI * 2)
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
      }
    }
    // Detection markers (pre-event peaks) — linearly interpolate
    // the displayed trace at the marker time so the dot rides the
    // visible line. Same pattern as APWindow's ``toPx`` / FPsp's
    // overlay drawing. Replaces the old "next sample after t"
    // bisect logic that put the dot below the actual peak when
    // LTTB decimation removed the peak sample.
    const primed = primedRef.current
    const tolPrime = 1e-6
    const markers = detectionRef.current
    if (markers.length > 0 && preData) {
      ctx.save()
      for (const m of markers) {
        const sampled = sampleTraceYAt(preData.time, preData.values, m.t)
        if (sampled == null) continue
        const px = u.valToPos(m.t, 'x', true)
        const py = u.valToPos(sampled, 'y', true)
        // Manual edits get the AP-style outer ring; primed pre-side
        // markers get a thicker confirmation ring on top.
        dot(px, py, PRE_MARKER_COLOR, m.manual)
        if (primed?.side === 'pre' && Math.abs(primed.preT - m.preT) <= tolPrime) {
          ctx.beginPath()
          ctx.arc(px, py, MARKER_RING_RADIUS + 2, 0, Math.PI * 2)
          ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2; ctx.stroke()
        }
      }
      ctx.restore()
    }
    // Post-peak markers — y on the post (right) axis. Marker fill
    // colour reflects classification: green = auto success, red =
    // auto failure, grey = user-overridden post-manual-failure.
    const ppm = postPeakRef.current
    if (ppm.length > 0) {
      ctx.save()
      for (const m of ppm) {
        if (!isFinite(m.y)) continue
        const px = u.valToPos(m.t, 'x', true)
        const py = u.valToPos(m.y, 'y_post', true)
        const fill = m.postManualFailure
          ? '--text-muted'
          : (m.success ? SUCCESS_COLOR : FAILURE_COLOR)
        dot(px, py, fill, false)
        if (primed?.side === 'post' && Math.abs(primed.preT - m.preT) <= tolPrime) {
          ctx.beginPath()
          ctx.arc(px, py, MARKER_RING_RADIUS + 2, 0, Math.PI * 2)
          ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2; ctx.stroke()
        }
      }
      ctx.restore()
    }
  }

  // ── Pointer + wheel ───────────────────────────────────────────
  useEffect(() => {
    const cont = containerRef.current
    if (!cont || !plotRef.current) return
    if (!preData && !postData) return
    const u = plotRef.current
    const over = cont.querySelector<HTMLDivElement>('.u-over')
    if (!over) return

    type Drag =
      | { kind: 'maybe-pan'; startX: number; startY: number; xMin: number; xMax: number; yKey: 'y' | 'y_post'; yMin: number; yMax: number; panning: boolean }
      | { kind: 'pre-edge'; which: 'start' | 'end' }
      | { kind: 'pre-band'; startX: number; startStart: number; startEnd: number }
      | { kind: 'post-edge'; which: 'start' | 'end' }
      | { kind: 'post-band'; startX: number; startStart: number; startEnd: number }
    let drag: Drag | null = null
    const xToPx = (x: number) => u.valToPos(x, 'x', false)
    const pxToX = (px: number) => u.posToVal(px, 'x')

    // Pick the Y axis the cursor is currently nearest to — same
    // approach as the main TraceViewer's ``pickYScale``: at the
    // cursor's X, locate each series's sample point and pick
    // whichever sits closer in canvas pixels to the cursor's Y.
    const pickYScale = (cssX: number, cssY: number): 'y' | 'y_post' => {
      const xs = u.data[0] as number[] | undefined
      if (!xs || xs.length === 0) return 'y'
      const xVal = u.posToVal(cssX, 'x')
      if (!isFinite(xVal)) return 'y'
      let lo = 0, hi = xs.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (xs[mid] < xVal) lo = mid + 1
        else hi = mid
      }
      const sampleIdx = lo
      let bestKey: 'y' | 'y_post' = 'y'
      let bestDist = Infinity
      for (let i = 1; i < u.series.length; i++) {
        const s = u.series[i]
        const sk = (s.scale ?? 'y') as string
        if (sk !== 'y' && sk !== 'y_post') continue
        const arr = u.data[i] as (number | null)[] | undefined
        if (!arr) continue
        const v = arr[sampleIdx]
        if (v == null || !isFinite(v)) continue
        const py = u.valToPos(v, sk as any, false)
        const d = Math.abs(py - cssY)
        if (d < bestDist) { bestDist = d; bestKey = sk as 'y' | 'y_post' }
      }
      return bestKey
    }

    const MARKER_HIT_PX = 10
    // Marker hit-test — returns ``{ side, preT }`` for the closest
    // marker within MARKER_HIT_PX, or null. Pre and post markers
    // are tested INDEPENDENTLY: ``pickYScale`` decides which side
    // the cursor is closer to (= which trace the user is "pointing
    // at"), and only that side's markers are considered. So a click
    // near the pre trace primes a pre event regardless of how close
    // the post marker happens to be in the X direction.
    const findMarkerHit = (
      pxX: number, pxY: number,
    ): { side: 'pre' | 'post'; preT: number } | null => {
      const ySide = pickYScale(pxX, pxY)
      const wantPre = ySide === 'y'
      let bestT: number | null = null
      let bestD = Infinity
      if (wantPre) {
        const pre = detectionRef.current
        if (preData && pre.length > 0) {
          for (const m of pre) {
            const sampled = sampleTraceYAt(preData.time, preData.values, m.t)
            if (sampled == null) continue
            const px = u.valToPos(m.t, 'x', false)
            const py = u.valToPos(sampled, 'y', false)
            const d = Math.hypot(px - pxX, py - pxY)
            if (d < bestD && d < MARKER_HIT_PX) { bestD = d; bestT = m.preT }
          }
        }
        return bestT == null ? null : { side: 'pre', preT: bestT }
      } else {
        const post = postPeakRef.current
        if (post.length > 0) {
          for (const m of post) {
            if (!isFinite(m.y)) continue
            const px = u.valToPos(m.t, 'x', false)
            const py = u.valToPos(m.y, 'y_post' as any, false)
            const d = Math.hypot(px - pxX, py - pxY)
            if (d < bestD && d < MARKER_HIT_PX) { bestD = d; bestT = m.preT }
          }
        }
        return bestT == null ? null : { side: 'post', preT: bestT }
      }
    }

    const findHit = (pxX: number): Drag | null => {
      // Test post bounds first (drawn on top, more interactive).
      if (showPostBoundsRef.current) {
        const b = postBoundsRef.current
        if (b.start != null) {
          const startPx = xToPx(b.start)
          const endVal = b.end != null ? b.end : (u.scales.x.max ?? b.start)
          const endPx = xToPx(endVal)
          if (Math.abs(pxX - startPx) <= BAND_EDGE_PX) return { kind: 'post-edge', which: 'start' }
          if (b.end != null && Math.abs(pxX - endPx) <= BAND_EDGE_PX) return { kind: 'post-edge', which: 'end' }
          if (pxX > Math.min(startPx, endPx) + BAND_EDGE_PX
              && pxX < Math.max(startPx, endPx) - BAND_EDGE_PX) {
            return {
              kind: 'post-band', startX: pxX,
              startStart: b.start,
              startEnd: b.end != null ? b.end : (u.scales.x.max ?? b.start),
            }
          }
        }
      }
      if (showPreBoundsRef.current) {
        const b = preBoundsRef.current
        const startPx = xToPx(b.start)
        const endVal = b.end > b.start ? b.end : (u.scales.x.max ?? b.start)
        const endPx = xToPx(endVal)
        if (Math.abs(pxX - startPx) <= BAND_EDGE_PX) return { kind: 'pre-edge', which: 'start' }
        if (b.end > b.start && Math.abs(pxX - endPx) <= BAND_EDGE_PX) return { kind: 'pre-edge', which: 'end' }
        if (pxX > Math.min(startPx, endPx) + BAND_EDGE_PX
            && pxX < Math.max(startPx, endPx) - BAND_EDGE_PX) {
          return {
            kind: 'pre-band', startX: pxX,
            startStart: b.start, startEnd: b.end > b.start ? b.end : endVal,
          }
        }
      }
      return null
    }

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top

      // Priority 1: bound edges / band — drag the cursor.
      const hit = findHit(pxX)
      if (hit) {
        drag = hit
        try { over.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
        return
      }

      // Priority 2a: if a marker is currently primed, the second
      // click should confirm the SAME primed marker even when the
      // mouse drifted slightly off it (so pickYScale would otherwise
      // pick the wrong axis and miss the hit). We hit-test the
      // primed marker directly with a generous tolerance before
      // running the side-aware findMarkerHit.
      const cur = primedRef.current
      if (cur != null) {
        let primedPx: number | null = null
        let primedPy: number | null = null
        if (cur.side === 'pre' && preData) {
          const m = detectionRef.current.find(
            (x) => Math.abs(x.preT - cur.preT) < 1e-6,
          )
          if (m) {
            const sampled = sampleTraceYAt(preData.time, preData.values, m.t)
            if (sampled != null) {
              primedPx = u.valToPos(m.t, 'x', false)
              primedPy = u.valToPos(sampled, 'y', false)
            }
          }
        } else if (cur.side === 'post') {
          const m = postPeakRef.current.find(
            (x) => Math.abs(x.preT - cur.preT) < 1e-6,
          )
          if (m && isFinite(m.y)) {
            primedPx = u.valToPos(m.t, 'x', false)
            primedPy = u.valToPos(m.y, 'y_post' as any, false)
          }
        }
        if (primedPx != null && primedPy != null) {
          const d = Math.hypot(primedPx - pxX, primedPy - pxY)
          if (d < MARKER_HIT_PX * 1.5) {
            // Confirm — clear prime, redraw, fire side-specific cb.
            primedRef.current = null
            plotRef.current?.redraw()
            if (cur.side === 'pre') {
              onRemoveTrialAtRef.current?.(cur.preT)
            } else {
              onTogglePostFailureRef.current?.(cur.preT)
            }
            ev.preventDefault()
            return
          }
        }
      }

      // Priority 2b: side-aware first prime. ``pickYScale`` chooses
      // the trace the user is pointing at; only that side's markers
      // are tested. A hit primes the marker; the next click within
      // the primed-tolerance above confirms.
      const markerHit = findMarkerHit(pxX, pxY)
      if (markerHit != null) {
        primedRef.current = markerHit
        plotRef.current?.redraw()
        ev.preventDefault()
        return
      }

      // Priority 3: empty space — start click-or-pan. Plain click
      // (release without movement) ADDS a new pre event at click
      // time. Movement past DRAG_THRESHOLD_PX commits to a pan.
      const yKey = pickYScale(pxX, pxY)
      const ys = (u.scales as any)[yKey]
      drag = {
        kind: 'maybe-pan',
        startX: pxX, startY: pxY,
        xMin: u.scales.x.min ?? 0, xMax: u.scales.x.max ?? 1,
        yKey,
        yMin: ys?.min ?? 0, yMax: ys?.max ?? 1,
        panning: false,
      }
      try { over.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
    }
    const onPointerMove = (ev: PointerEvent) => {
      const rect = over.getBoundingClientRect()
      if (!drag) {
        const hit = findHit(ev.clientX - rect.left)
        over.style.cursor = hit
          ? (hit.kind.endsWith('-edge') ? 'ew-resize' : 'grab')
          : ''
        return
      }
      if (drag.kind === 'pre-edge') {
        const t = pxToX(ev.clientX - rect.left)
        const cur = preBoundsRef.current
        const next = { ...cur }
        if (drag.which === 'start') next.start = Math.max(0, t)
        else next.end = Math.max(0, t)
        if (next.start > next.end && next.end > 0) {
          [next.start, next.end] = [next.end, next.start]
          drag.which = drag.which === 'start' ? 'end' : 'start'
        }
        onPreBoundsRef.current(next)
        u.redraw()
      } else if (drag.kind === 'pre-band') {
        const dxPx = (ev.clientX - rect.left) - drag.startX
        const xMin = u.scales.x.min ?? 0
        const xMax = u.scales.x.max ?? 1
        const xPerPx = (xMax - xMin) / Math.max(1, u.bbox.width / (devicePixelRatio || 1))
        const dx = dxPx * xPerPx
        onPreBoundsRef.current({
          start: Math.max(0, drag.startStart + dx),
          end: Math.max(0, drag.startEnd + dx),
        })
        u.redraw()
      } else if (drag.kind === 'post-edge') {
        const t = pxToX(ev.clientX - rect.left)
        const cur = postBoundsRef.current
        const next = { ...cur }
        if (drag.which === 'start') next.start = t
        else next.end = t
        if (next.start != null && next.end != null && next.start > next.end) {
          [next.start, next.end] = [next.end, next.start]
          drag.which = drag.which === 'start' ? 'end' : 'start'
        }
        onPostBoundsRef.current(next)
        u.redraw()
      } else if (drag.kind === 'post-band') {
        const dxPx = (ev.clientX - rect.left) - drag.startX
        const xMin = u.scales.x.min ?? 0
        const xMax = u.scales.x.max ?? 1
        const xPerPx = (xMax - xMin) / Math.max(1, u.bbox.width / (devicePixelRatio || 1))
        const dx = dxPx * xPerPx
        onPostBoundsRef.current({
          start: drag.startStart + dx,
          end: drag.startEnd + dx,
        })
        u.redraw()
      } else if (drag.kind === 'maybe-pan') {
        const dxPx = (ev.clientX - rect.left) - drag.startX
        const dyPx = (ev.clientY - rect.top) - drag.startY
        if (!drag.panning) {
          if (Math.abs(dxPx) < DRAG_THRESHOLD_PX && Math.abs(dyPx) < DRAG_THRESHOLD_PX) return
          drag.panning = true
          over.style.cursor = 'grabbing'
        }
        const bboxW = u.bbox.width / (devicePixelRatio || 1)
        const bboxH = u.bbox.height / (devicePixelRatio || 1)
        // X is shared between traces — pan affects both. The Y pan
        // sticks to the axis picked at mousedown, so the user can
        // shift one trace vertically without dragging the other.
        const dxX = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
        const dyY = (dyPx / bboxH) * (drag.yMax - drag.yMin)
        const nx: [number, number] = [drag.xMin + dxX, drag.xMax + dxX]
        const ny: [number, number] = [drag.yMin + dyY, drag.yMax + dyY]
        xRangeRef.current = nx
        if (drag.yKey === 'y') yPreRangeRef.current = ny
        else yPostRangeRef.current = ny
        u.setScale('x', { min: nx[0], max: nx[1] })
        u.setScale(drag.yKey, { min: ny[0], max: ny[1] })
        onXRef.current(nx)
      }
    }
    const onPointerUp = (ev: PointerEvent) => {
      if (!drag) return
      // Capture click-or-pan resolution before clearing drag.
      const clickCandidate = drag.kind === 'maybe-pan' && !drag.panning
      drag = null
      try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      over.style.cursor = ''
      if (clickCandidate) {
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const tClick = pxToX(pxX)
        // Clicking empty space cancels any prime — same as AP /
        // Events: "no, don't delete that one".
        if (primedRef.current != null) {
          primedRef.current = null
          plotRef.current?.redraw()
        }
        if (isFinite(tClick)) onAddPreEventRef.current?.(tClick)
      }
    }
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      if (ev.altKey) {
        // Y zoom — picks whichever axis the cursor is closest to so
        // the user can zoom each trace independently. Hover the
        // trace you want, ⌥-scroll. Same pattern as the main
        // TraceViewer's pickYScale-driven wheel.
        const key = pickYScale(pxX, pxY)
        const sMin = (u.scales as any)[key].min, sMax = (u.scales as any)[key].max
        if (sMin == null || sMax == null) return
        const yAtCur = u.posToVal(pxY, key as any)
        const newMin = yAtCur - (yAtCur - sMin) * factor
        const newMax = yAtCur + (sMax - yAtCur) * factor
        if (key === 'y') yPreRangeRef.current = [newMin, newMax]
        else yPostRangeRef.current = [newMin, newMax]
        u.setScale(key as any, { min: newMin, max: newMax })
      } else {
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        if (xMin == null || xMax == null) return
        const xAtCur = u.posToVal(pxX, 'x')
        const newMin = xAtCur - (xAtCur - xMin) * factor
        const newMax = xAtCur + (xMax - xAtCur) * factor
        xRangeRef.current = [newMin, newMax]
        u.setScale('x', { min: newMin, max: newMax })
        onXRef.current([newMin, newMax])
      }
    }
    const onDbl = () => doResetZoom()

    over.addEventListener('pointerdown', onPointerDown)
    over.addEventListener('pointermove', onPointerMove)
    over.addEventListener('pointerup', onPointerUp)
    over.addEventListener('pointercancel', onPointerUp)
    over.addEventListener('wheel', onWheel, { passive: false })
    over.addEventListener('dblclick', onDbl)
    return () => {
      over.removeEventListener('pointerdown', onPointerDown)
      over.removeEventListener('pointermove', onPointerMove)
      over.removeEventListener('pointerup', onPointerUp)
      over.removeEventListener('pointercancel', onPointerUp)
      over.removeEventListener('wheel', onWheel)
      over.removeEventListener('dblclick', onDbl)
    }
    // ``plotVer`` is the rebuild counter set inside the rebuild
    // effect's RAF callback. Including it here makes this effect
    // re-run AFTER each new uPlot is built, so the pointer/wheel
    // handlers attach to the fresh ``.u-over``.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preData, postData, plotVer])

  // Apply parent-driven X range changes (after a sibling triggers
  // them — though there's no sibling now, the prop still routes here
  // for cross-window cursor sync).
  useEffect(() => {
    const u = plotRef.current
    if (!u) return
    if (xRange) {
      u.setScale('x', { min: xRange[0], max: xRange[1] })
    } else {
      const t = preData?.time ?? postData?.time
      if (t && t.length > 1) u.setScale('x', { min: t[0], max: t[t.length - 1] })
    }
  }, [xRange, preData, postData])

  // Redraw on overlay-data changes (refs already hold the values).
  useEffect(() => { plotRef.current?.redraw() },
    [detectionMarkers, postPeakMarkers,
     preBounds, postBounds, showPreBounds, showPostBounds])

  // Resize handling — observer + parent splitter signal.
  useEffect(() => {
    const cont = containerRef.current
    if (!cont) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u) return
      const w = cont.clientWidth, h = cont.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(cont)
    return () => ro.disconnect()
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

  // Compute & apply Y autofit. ``scale`` picks which Y axis to act
  // on; ``preserveX`` controls whether X stays put (Fit Y) or also
  // resets (Reset zoom).
  const fitY = useCallback((scale: 'y' | 'y_post' | 'both', preserveX: boolean) => {
    const u = plotRef.current
    if (!u) return
    const scales: Array<'y' | 'y_post'> = scale === 'both' ? ['y', 'y_post'] : [scale]
    let xLo: number, xHi: number
    const masterT = preData?.time ?? postData?.time
    if (!masterT || masterT.length === 0) return
    if (preserveX) {
      xLo = u.scales.x.min ?? masterT[0]
      xHi = u.scales.x.max ?? masterT[masterT.length - 1]
    } else {
      xLo = masterT[0]; xHi = masterT[masterT.length - 1]
      xRangeRef.current = null
      u.setScale('x', { min: xLo, max: xHi })
      onXRef.current(null)
    }
    for (const s of scales) {
      const src = s === 'y' ? preData : postData
      if (!src) continue
      let yLo = Infinity, yHi = -Infinity
      for (let i = 0; i < src.time.length; i++) {
        const t = src.time[i]
        if (t < xLo || t > xHi) continue
        const v = src.values[i]
        if (v < yLo) yLo = v
        if (v > yHi) yHi = v
      }
      if (!isFinite(yLo) || !isFinite(yHi) || yHi <= yLo) continue
      const pad = (yHi - yLo) * 0.05
      const ny: [number, number] = [yLo - pad, yHi + pad]
      // Clear the ref (rather than write the fitted values into it)
      // so the next sweep change reverts to autofit-on-data instead
      // of dragging the previous sweep's bounds along. setScale
      // applies the freshly-computed range to the current view.
      if (s === 'y') yPreRangeRef.current = null; else yPostRangeRef.current = null
      u.setScale(s, { min: ny[0], max: ny[1] })
    }
    bump()
  }, [preData, postData, bump])

  const doResetZoom = useCallback(() => fitY('both', false), [fitY])
  const onFitYPre = useCallback(() => fitY('y', true), [fitY])
  const onFitYPost = useCallback(() => fitY('y_post', true), [fitY])
  const onResetZoom = doResetZoom

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: 'var(--bg-primary)', position: 'relative',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        padding: '3px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <ChannelSwatch color={preColor} label="Pre" />
        <ChannelSwatch color={postColor} label="Post" />
        <PairedMarkerLegend role="overlay" />
        <button className="btn" onClick={onFitYPre}
          style={{ marginLeft: 'auto', padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Fit Y on the pre (left) axis to currently-visible X">Fit Y (pre)</button>
        <button className="btn" onClick={onFitYPost}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Fit Y on the post (right) axis to currently-visible X">Fit Y (post)</button>
        <button className="btn" onClick={onResetZoom}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Reset both Y axes + X to data bounds (also: double-click)">Reset zoom</button>
      </div>
      <div ref={containerRef}
        onContextMenu={plotMenu.onContextMenu}
        style={{ flex: 1, minHeight: 0, position: 'relative' }} />
      {plotMenu.menu}
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
      }}>
        Scroll = zoom X · ⌥ scroll = zoom Y (nearest trace) · drag = pan X + nearest Y · drag bounds edge to resize · double-click = reset
      </div>
    </div>
  )
}

/** Linear interpolation of (srcT, srcY) onto refT. Both srcT and refT
 *  must be sorted ascending. Out-of-range refT values get clamped to
 *  the source endpoints rather than NaN — keeps the line continuous
 *  when the two channels were LTTB'd to slightly different time
 *  arrays. */
function interpolateOnto(srcT: number[], srcY: number[], refT: number[]): number[] {
  const out: number[] = new Array(refT.length)
  if (srcT.length === 0) {
    for (let i = 0; i < refT.length; i++) out[i] = NaN
    return out
  }
  let j = 0
  for (let i = 0; i < refT.length; i++) {
    const t = refT[i]
    if (t <= srcT[0]) { out[i] = srcY[0]; continue }
    if (t >= srcT[srcT.length - 1]) { out[i] = srcY[srcY.length - 1]; continue }
    while (j < srcT.length - 1 && srcT[j + 1] < t) j++
    const t0 = srcT[j], t1 = srcT[j + 1]
    const y0 = srcY[j], y1 = srcY[j + 1]
    const f = (t - t0) / Math.max(1e-12, t1 - t0)
    out[i] = y0 + f * (y1 - y0)
  }
  return out
}

/** Channel colour swatch + label for the overlay viewer's header. */
function ChannelSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        display: 'inline-block', width: 14, height: 3,
        background: color,
      }} />
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{label}</span>
    </span>
  )
}

/** Tiny inline legend matching the AP / Events marker convention —
 *  small coloured dots with one-word labels, muted text. */
function PairedMarkerLegend({ role }: { role: 'pre' | 'post' | 'overlay' }) {
  const pre = { color: `var(${PRE_MARKER_COLOR})`, label: 'Pre event' }
  const success = { color: `var(${SUCCESS_COLOR})`, label: 'Success' }
  const failure = { color: `var(${FAILURE_COLOR})`, label: 'Failure' }
  const items =
    role === 'pre' ? [pre]
    : role === 'post' ? [success, failure]
    : [pre, success, failure]
  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8,
            borderRadius: '50%', background: it.color,
          }} />
          <span>{it.label}</span>
        </span>
      ))}
    </span>
  )
}

/** Format a number of milliseconds for an axis tick — keeps the
 *  precision short so labels don't overlap. Trailing zeros AFTER a
 *  decimal point are trimmed (e.g. "1.50" → "1.5"); integers are
 *  left untouched (so "100" stays "100", not "1"). */
function fmtMs(ms: number): string {
  if (!isFinite(ms)) return ''
  const abs = Math.abs(ms)
  // Pick decimals based on magnitude — typical uPlot tick spacing on
  // a sweep window of seconds means ticks are every 50–500 ms; sub-
  // millisecond ticks only show up when the user zooms way in.
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3
  const s = ms.toFixed(decimals)
  if (!s.includes('.')) return s
  return s.replace(/\.?0+$/, '')
}

/** Convert a backend STA payload into the camelCase ``PairedSta``
 *  shape stored in the frontend. Returns null for null inputs. */
function mapSta(s: any): import('../../stores/appStore').PairedSta | null {
  if (!s) return null
  return {
    time: s.time, mean: s.mean, sem: s.sem, n: s.n,
    traces: s.traces, traceSuccess: s.trace_success,
    fit: s.fit ? {
      baseline: s.fit.baseline,
      amplitude: s.fit.amplitude,
      peakTS: s.fit.peak_t_s,
      peakV: s.fit.peak_v,
      tauDecayMs: s.fit.tau_decay_ms,
      r2: s.fit.r2,
      fitCurve: s.fit.fit_curve,
      fitCurveMask: s.fit.fit_curve_mask,
    } : undefined,
  }
}

function bisect(arr: number[], t: number): number {
  let lo = 0, hi = arr.length - 1
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (arr[m] < t) lo = m + 1; else hi = m
  }
  return lo
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return '—'
  return n.toFixed(decimals)
}

function exportPairedTrialsCSV(
  trials: PairedTrial[],
  fileName: string,
  group: number,
  series: number,
) {
  if (trials.length === 0) return
  const header = [
    'file', 'group', 'series', 'sweep', 'trial_idx',
    'pre_t_s', 'pre_amp', 'baseline_mean', 'baseline_sd',
    'post_peak', 'post_peak_t_s', 'amplitude', 'success',
    'latency_ms', 'rise_ms', 'decay_ms', 'tau_decay_ms', 'half_width_ms',
    'truncated', 'manual', 'manual_failure',
  ]
  const rows = trials.map((t) => [
    JSON.stringify(fileName),
    group, series, t.sweep + 1, t.trialIdx + 1,
    t.preTS.toFixed(6),
    t.preAmp.toFixed(4),
    t.baselineMean.toFixed(4),
    t.baselineSd.toFixed(4),
    t.postPeak.toFixed(4),
    t.postPeakTS.toFixed(6),
    t.amplitude.toFixed(4),
    t.success ? '1' : '0',
    t.latencyMs != null ? t.latencyMs.toFixed(4) : '',
    t.riseMs != null ? t.riseMs.toFixed(4) : '',
    t.decayMs != null ? t.decayMs.toFixed(4) : '',
    t.decayTauMs != null ? t.decayTauMs.toFixed(4) : '',
    t.halfWidthMs != null ? t.halfWidthMs.toFixed(4) : '',
    t.truncated ? '1' : '0',
    t.manual ? '1' : '0',
    t.postManualFailure ? '1' : '0',
  ])
  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n')
  const name = fileName.replace(/\.[^.]+$/, '') + '_paired_trials.csv'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

function TrialsTab({ data }: { data: PairedData | null }) {
  const headers = [
    'Sweep', '#', 'pre t (s)', 'amplitude',
    'success', 'latency (ms)', 'rise (ms)', 'decay (ms)',
    'τ_decay (ms)', 'half-width (ms)',
    'baseline σ', 'truncated',
  ]
  const rows = data?.perTrial ?? []
  // Hooks must run unconditionally — call them before any early
  // return so React's hook order stays stable when the data goes
  // null between renders.
  const sel = useRowSelection(rows.length)
  const rowToCells = (i: number): Array<string | number | null> => {
    const t = rows[i]
    if (!t) return []
    return [
      t.sweep + 1,
      t.trialIdx + 1 + (t.manual ? ' (manual)' : ''),
      t.preTS,
      t.amplitude,
      t.success ? 'yes' : 'no',
      t.latencyMs ?? null,
      t.riseMs ?? null,
      t.decayMs ?? null,
      t.decayTauMs ?? null,
      t.halfWidthMs ?? null,
      t.baselineSd,
      t.truncated ? 'yes' : '',
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0
      ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })

  if (!data) {
    return <Empty msg="Run analysis to see trials." />
  }
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', height: '100%', margin: 8,
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)',
      }}>
        <thead>
          <tr style={{
            background: 'var(--bg-secondary)', textAlign: 'left',
            position: 'sticky', top: 0,
          }}>
            {headers.map((h, i) => <Th key={i}>{h}</Th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i}
              onClick={(ev) => sel.onRowClick(i, ev)}
              onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                if (!sel.isSelected(i)) sel.setSelected([i])
              })}
              style={{
                borderTop: '1px solid var(--border)',
                background: sel.isSelected(i)
                  ? 'var(--accent-muted)'
                  : t.success ? 'transparent' : 'color-mix(in oklab, var(--error) 8%, transparent)',
              }}>
              <Td>{t.sweep + 1}</Td>
              <Td>{t.trialIdx + 1}{t.manual ? '*' : ''}</Td>
              <Td>{fmt(t.preTS, 4)}</Td>
              <Td>{fmt(t.amplitude)}</Td>
              <Td style={{ color: t.success ? 'var(--success)' : 'var(--error)' }}>
                {t.success ? 'yes' : 'no'}
              </Td>
              <Td>{fmt(t.latencyMs)}</Td>
              <Td>{fmt(t.riseMs)}</Td>
              <Td>{fmt(t.decayMs)}</Td>
              <Td>{fmt(t.decayTauMs)}</Td>
              <Td>{fmt(t.halfWidthMs)}</Td>
              <Td>{fmt(t.baselineSd, 3)}</Td>
              <Td>{t.truncated ? 'yes' : ''}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

function StatisticsTab({
  data, fileName, group, series,
}: {
  data: PairedData | null
  fileName: string
  group: number
  series: number
}) {
  if (!data) {
    return <Empty msg="Run analysis to see statistics." />
  }
  const s = data.seriesSummary
  const items: { label: string; value: string }[] = [
    { label: 'n trials',             value: String(s.nTrials) },
    { label: 'n successes',          value: String(s.nSuccess) },
    { label: 'n failures',           value: String(s.nFailures) },
    { label: 'failure rate',         value: fmt(s.failureRate, 3) },
    { label: 'mean amplitude',       value: fmt(s.meanAmplitude) },
    { label: 'mean amp (zero-fail)', value: fmt(s.meanAmplitudeZeroed) },
    { label: 'potency',              value: fmt(s.potency) },
    { label: 'CV (success)',         value: fmt(s.cvSuccess, 3) },
    { label: '1 / CV²',              value: fmt(s.invCv2, 2) },
    { label: 'latency mean (ms)',    value: fmt(s.latencyMeanMs, 2) },
    { label: 'jitter (ms, SD)',      value: fmt(s.latencySdMs, 3) },
  ]
  return (
    <div style={{
      padding: 8, display: 'grid', gap: 8,
      gridTemplateColumns: 'minmax(280px, 1fr) minmax(280px, 1fr)',
      gridTemplateRows: 'minmax(180px, auto) minmax(180px, auto)',
      height: '100%', boxSizing: 'border-box', overflow: 'auto',
    }}>
      <div style={{
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', overflow: 'auto',
        minWidth: 0, minHeight: 0,
      }}>
        <div style={{
          padding: '4px 10px', fontSize: 'var(--font-size-label)',
          fontWeight: 600, color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>Series summary</span>
          <button className="btn"
            onClick={() => {
              const headerRow = ['file', 'group', 'series', ...items.map((it) => it.label)]
              const dataRow = [fileName, group, series, ...items.map((it) => it.value)]
              copyTextToClipboard(buildTSV(headerRow, [dataRow]))
            }}
            title="Copy series-summary table as TSV (paste into Excel / Sheets)"
            style={{
              marginLeft: 'auto',
              fontSize: 'var(--font-size-xs)',
              padding: '1px 8px',
            }}>
            Copy CSV
          </button>
        </div>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontSize: 'var(--font-size-label)',
        }}>
          <tbody>
            {items.map((it) => (
              <tr key={it.label} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{
                  color: 'var(--text-muted)', padding: '3px 10px',
                  whiteSpace: 'nowrap', fontFamily: 'var(--font-ui)',
                }}>{it.label}</td>
                <td style={{ padding: '3px 10px', textAlign: 'right' }}>{it.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', overflow: 'auto',
        minWidth: 0, minHeight: 0,
      }}>
        <div style={{
          padding: '4px 10px', fontSize: 'var(--font-size-label)',
          fontWeight: 600, color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>Paired-pulse ratios</span>
          <button className="btn"
            onClick={() => {
              const headerRow = ['file', 'group', 'series', 'pulse_n', 'ratio_n_over_1', 'n_sweeps']
              const dataRows = s.pprN1.map((p) => [
                fileName, group, series, p.n,
                p.ratio.toFixed(4), p.nSweeps,
              ])
              copyTextToClipboard(buildTSV(headerRow, dataRows))
            }}
            disabled={s.pprN1.length === 0}
            title="Copy PPR table as TSV (paste into Excel / Sheets)"
            style={{
              marginLeft: 'auto',
              fontSize: 'var(--font-size-xs)',
              padding: '1px 8px',
            }}>
            Copy CSV
          </button>
        </div>
        {s.pprN1.length === 0 ? (
          <div style={{
            padding: 12, color: 'var(--text-muted)',
            fontStyle: 'italic', fontSize: 'var(--font-size-label)',
          }}>
            Sweeps need ≥ 2 pre-events with pulse 1 = success to contribute.
          </div>
        ) : (
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontSize: 'var(--font-size-label)',
          }}>
            <thead>
              <tr style={{
                background: 'var(--bg-secondary)', textAlign: 'left',
                position: 'sticky', top: 0,
              }}>
                <Th>Pulse N</Th><Th>Ratio (N / 1)</Th><Th>n sweeps</Th>
              </tr>
            </thead>
            <tbody>
              {s.pprN1.map((p) => (
                <tr key={p.n} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td>{p.n}</Td>
                  <Td>{fmt(p.ratio, 3)}</Td>
                  <Td>{p.nSweeps}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {/* Trial-sequence plot — amplitude vs trial index across all
          sweeps, success vs failure coloured. Useful for spotting
          rundown / wash-in trends. */}
      <div style={{
        gridColumn: '1 / -1',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        minHeight: 200, display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '4px 10px', fontSize: 'var(--font-size-label)',
          fontWeight: 600, color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}>Trial sequence</div>
        <TrialSequencePlot trials={data.perTrial} />
      </div>
    </div>
  )
}

/** Trial-sequence plot — amplitude vs trial index across the whole
 *  series. Two scatter series (successes blue, failures red) drawn
 *  as points only. Reveals rundown / wash-in / drug effects. */
function TrialSequencePlot({ trials }: { trials: PairedTrial[] }) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const menu = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'paired-trial-sequence',
  })

  useEffect(() => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!containerRef.current) return
    if (trials.length === 0) return
    const xs: number[] = []
    const ySucc: (number | null)[] = []
    const yFail: (number | null)[] = []
    for (let i = 0; i < trials.length; i++) {
      const t = trials[i]
      xs.push(i + 1)
      if (t.success) { ySucc.push(t.amplitude); yFail.push(null) }
      else           { ySucc.push(null); yFail.push(t.amplitude) }
    }
    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight
    const opts: uPlot.Options = {
      width: Math.max(200, w),
      height: Math.max(80, h),
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: { x: { time: false } },
      axes: [
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'Trial #', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'Amplitude', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
      ],
      series: [
        {},
        { stroke: cssVar('--trace-color-1'), width: 0, label: 'successes',
          points: { show: true, size: 5, stroke: cssVar('--trace-color-1'), fill: cssVar('--trace-color-1') } },
        { stroke: cssVar('--error'), width: 0, label: 'failures',
          points: { show: true, size: 5, stroke: cssVar('--error'), fill: cssVar('--error') } },
      ],
    }
    plotRef.current = new uPlot(opts, [xs, ySucc, yFail] as any, containerRef.current)
    return () => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    }
  }, [trials, themeKey])

  useEffect(() => {
    const cont = containerRef.current
    if (!cont) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u) return
      const w = cont.clientWidth, h = cont.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(cont)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef}
      onContextMenu={menu.onContextMenu}
      style={{ flex: 1, minHeight: 0 }}>
      {menu.menu}
    </div>
  )
}

function STATab({ data }: { data: PairedData | null }) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  type SeriesPick = 'all' | 'success' | 'failure'
  const [seriesPick, setSeriesPick] = useState<SeriesPick>('all')
  const [showOverlay, setShowOverlay] = useState(false)
  const [overlayIncludesFailures, setOverlayIncludesFailures] = useState(false)
  const [showFit, setShowFit] = useState(true)
  const staMenu = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'paired-sta',
  })

  const sta = data
    ? (seriesPick === 'success' ? data.staSuccess
       : seriesPick === 'failure' ? data.staFailure
       : data.staAll)
    : null

  useEffect(() => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!sta || !containerRef.current) return
    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight
    const upper = sta.mean.map((m, i) => m + sta.sem[i])
    const lower = sta.mean.map((m, i) => m - sta.sem[i])

    // Optional individual-sweep overlay. Each row of ``traces`` becomes
    // its own faint series; failure rows are filtered out unless the
    // user opted in.
    const overlayRows: { values: number[]; success: boolean }[] = []
    if (showOverlay && sta.traces && sta.traceSuccess) {
      for (let i = 0; i < sta.traces.length; i++) {
        const ok = sta.traceSuccess[i]
        if (!overlayIncludesFailures && !ok) continue
        overlayRows.push({ values: sta.traces[i], success: ok })
      }
    }

    // Series order:
    //   0: x
    //   1: upper (mean+SEM, transparent stroke — used as band edge)
    //   2: lower (mean−SEM, transparent stroke — band edge)
    //   3..3+k-1: per-trial overlays (failures paint first so
    //             successes draw over them)
    //   last: mean on top
    // The translucent ribbon between (1, 2) is drawn via uPlot's
    // ``bands`` config below.
    const series: uPlot.Series[] = [
      {},
      { stroke: 'rgba(0,0,0,0)', width: 0.0001, label: 'mean+SEM',
        points: { show: false } },
      { stroke: 'rgba(0,0,0,0)', width: 0.0001, label: 'mean−SEM',
        points: { show: false } },
    ]
    const overlayValues: number[][] = []
    overlayRows.sort((a, b) => Number(a.success) - Number(b.success))
    for (const r of overlayRows) {
      series.push({
        // Solid colours at modest opacity — alpha-rgba was washing
        // out on dark backgrounds. uPlot draws series in order, so
        // failures (0.5) paint first and successes (0.6) layer on
        // top, with the bold mean drawn last.
        stroke: r.success ? cssVar('--trace-color-1') : cssVar('--error'),
        alpha: r.success ? 0.6 : 0.5,
        width: 1, points: { show: false },
      } as any)
      overlayValues.push(r.values)
    }
    series.push({
      stroke: cssVar('--trace-color-1'), width: 2.0,
      label: `Mean (n=${sta.n})`, points: { show: false },
    })
    // Optional monoexponential decay fit overlay. Drawn AFTER mean
    // so it sits on top; dashed accent stroke distinguishes it from
    // the data line. ``fitCurveMask`` picks out the peak→end span.
    let fitValues: (number | null)[] | null = null
    if (showFit && sta.fit) {
      fitValues = sta.fit.fitCurve.map((v, i) =>
        sta.fit!.fitCurveMask[i] ? v : null,
      )
      series.push({
        stroke: cssVar('--trace-color-3'), width: 1.75,
        dash: [6, 4],
        label: `Fit (τ=${sta.fit.tauDecayMs.toFixed(2)} ms)`,
        points: { show: false },
      } as any)
    }

    const opts: uPlot.Options = {
      width: Math.max(200, w),
      height: Math.max(80, h),
      cursor: { drag: { x: false, y: false }, focus: { prox: 30 } },
      legend: { show: false },
      scales: {
        // ``time: false`` — same fix as the OverlayViewer; without it
        // uPlot interprets the X numbers as Unix timestamps and
        // shows dates on the axis. Underlying values stay in seconds
        // (relative to t_pre, so they're already small) and the
        // ``values`` formatter converts to ms for display.
        x: { time: false },
      },
      // Translucent ±1 SEM ribbon — uPlot fills the area between
      // the upper-SEM (series 1, top of band) and lower-SEM
      // (series 2, bottom of band) curves. Stroke on the boundary
      // series is fully transparent so only the fill shows.
      bands: [{ series: [1, 2], fill: withAlpha(cssVar('--trace-color-1'), 0.22) }],
      axes: [
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          values: (_u, splits) => splits.map((s) => fmtMs(s * 1000)),
          label: 'Time relative to pre-event (ms)', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'Post amplitude', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
      ],
      series,
    }
    const plotData: any[] = [sta.time, upper, lower, ...overlayValues, sta.mean]
    if (fitValues) plotData.push(fitValues)
    plotRef.current = new uPlot(opts, plotData as any, containerRef.current)
    return () => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    }
  }, [sta, showOverlay, overlayIncludesFailures, showFit, themeKey])

  if (!data) return <Empty msg="Run analysis to see the spike-triggered average." />
  return (
    <div style={{
      padding: 8, display: 'flex', flexDirection: 'column',
      height: '100%', boxSizing: 'border-box',
    }}>
      {/* Header strip — segmented picker + overlay toggles, hairline
          border, same chrome as the viewer header. */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        flexWrap: 'wrap',
        padding: '3px 8px',
        fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 4,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>STA / Average</span>
        <span className="segmented" style={{ display: 'inline-flex' }}>
          {(['all', 'success', 'failure'] as SeriesPick[]).map((k) => {
            const active = seriesPick === k
            const label = k === 'all' ? 'All trials'
              : k === 'success' ? 'Successes only' : 'Failures only'
            return (
              <button key={k} className={active ? 'active' : undefined}
                onClick={() => setSeriesPick(k)}
                style={{ flex: 'none', padding: '0 10px', whiteSpace: 'nowrap' }}>{label}</button>
            )
          })}
        </span>
        {/* Overlay toggles. ``Show sweeps`` superimposes every aligned
            trial as a faint trace; ``include failures`` decides
            whether 0-amplitude / sub-threshold trials appear in red.
            Both default off so the average is uncluttered on first
            view. */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title={
            sta?.traces && sta?.traceSuccess
              ? "Overlay each individual trial's post-window aligned to t_pre. Successes draw in blue, failures in red."
              : "Re-run the analysis to populate per-sweep overlays. Older results don't carry the per-trial traces."
          }>
          <input type="checkbox" checked={showOverlay}
            disabled={!(sta?.traces && sta?.traceSuccess)}
            onChange={(e) => setShowOverlay(e.target.checked)} />
          Show sweeps
        </label>
        {showOverlay && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title="When unchecked, only successful trials are overlaid. Failures usually sit near baseline and clutter the picture.">
            <input type="checkbox" checked={overlayIncludesFailures}
              onChange={(e) => setOverlayIncludesFailures(e.target.checked)} />
            Include failures
          </label>
        )}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title={
            sta?.fit
              ? `Show the monoexponential fit on the average's decay phase. τ_decay = ${sta.fit.tauDecayMs.toFixed(2)} ms (R² = ${sta.fit.r2.toFixed(3)}).`
              : 'Re-run the analysis to populate the decay fit. Older results don\'t carry the fit.'
          }>
          <input type="checkbox" checked={showFit}
            disabled={!sta?.fit}
            onChange={(e) => setShowFit(e.target.checked)} />
          Show fit
        </label>
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          {sta?.fit
            ? `n = ${sta.n} · τ = ${sta.fit.tauDecayMs.toFixed(2)} ms · R² = ${sta.fit.r2.toFixed(2)}`
            : (sta ? `n = ${sta.n}` : 'no trials')}
        </span>
      </div>
      <div ref={containerRef}
        onContextMenu={staMenu.onContextMenu}
        style={{
        flex: 1, minHeight: 0, marginTop: 6,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }} />
      {staMenu.menu}
      {/* Inline note: explain the two grey lines flanking the mean.
          Spelled out fully because the ribbon convention isn't
          obvious from the picture alone. */}
      <div style={{
        flexShrink: 0, marginTop: 4,
        padding: '3px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 4,
      }}>
        Bold blue line: per-sample mean across the {seriesPick === 'all'
          ? 'selected'
          : seriesPick === 'success' ? 'successful' : 'failed'} trials.
        Translucent blue band: ±1 SEM (standard error of the mean,
        i.e. per-sample SD ÷ √n). The band is a confidence ribbon for
        the average — narrow band = trials cluster tightly around the
        mean, wide band = the average is dominated by trial-to-trial
        variability. With "Show sweeps" enabled, faint blue overlays
        are individual successful trials and faint red overlays are
        individual failures. With "Show fit" enabled, the orange
        dashed line is a monoexponential ``y = baseline + a·exp(-Δt/τ)``
        fitted to the decay phase of the mean — τ and R² are reported
        in the header strip.
      </div>
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', fontStyle: 'italic',
      fontSize: 'var(--font-size-label)',
    }}>
      {msg}
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)' }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...style }}>{children}</td>
)
