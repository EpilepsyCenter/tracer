import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  CursorPositions,
  EventsData, EventsParams, EventsTemplate, EventRow,
  defaultEventsParams,
} from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import {
  Viewport, SetViewport, ViewportBar, ViewportSlider, shiftViewportBy,
} from '../common/ContinuousViewport'
import { usePlotMenu } from '../common/PlotMenu'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'
import { sampleTraceYAt } from '../../utils/sampleTraceY'
import { TrainOptions, defaultTrainParamsFor } from './TrainOptions'
import type { TrainParams, TrainSummary } from '../../utils/trains'
import { computeEventTrainIds } from '../../utils/eventTrains'

/**
 * Event detection & analysis — Phase 1 (expanded).
 *
 * Core UX:
 *  - Two detection families (Template Matching / Thresholding) sharing
 *    one per-event kinetics pipeline. See backend/analysis/events.py.
 *  - Continuous-sweep viewer with viewport presets + nav arrows +
 *    minimap slider + cursor bands, same pattern as FieldBurstWindow.
 *  - Cursor bands define the "quiet region" for RMS calculation AND
 *    the "event exemplar" region for template fitting. Shared across
 *    all analysis windows via the main app store's `cursors`.
 *  - Per-event manual edits (click → add, click-marker-again → discard)
 *    persist in the store's manualEdits blob; backend replays them on
 *    every re-run.
 *  - Optional pre-detection filter (same Butterworth sosfiltfilt as the
 *    AP / Burst modules) — applied once, so threshold + detection +
 *    kinetics all see the filtered trace.
 *
 * Separate sub-windows (Template Generator + Refinement) open via the
 * `events_template_generator` / `events_template_refinement` views —
 * handled by the parent Electron process, routed in AnalysisWindow.tsx.
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

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

// Cursor-band colors — match the baseline cursor convention used
// everywhere else in TRACER (FPsp, IV, Cursor, Resistance, AP).
// CSS form for JSX; canvas code reads ``cssVar('--cursor-baseline')``.
const CURSOR_COLOR = 'var(--cursor-baseline)'

/** Per-template peak colors — index 0 = primary, 1 = 2nd, 2 = 3rd.
 *  Used by the events viewer to color peak markers in multi-template
 *  detection mode AND by the Template panel to label which slot
 *  contributes which color. Stays distinct from the manual-event
 *  orange (--marker-manual) so manual + template-3 don't collide visually. */
export const TEMPLATE_COLORS = ['#e57373', '#81d4fa', '#aed581'] as const

/** Group color palette — one per group (1–5). Used by the small
 *  digit drawn under grouped event peaks in the main viewer. */
export const GROUP_COLORS = [
  '#ef5350', '#ffb300', '#66bb6a', '#26c6da', '#ab47bc',
] as const

/** Filter selector for the bottom-tab strip. Keeps the user's
 *  curation tags useful — limit results to a single group, or hide a
 *  group while keeping everything else. ``ungrouped`` shows only
 *  events that haven't been tagged at all. */
export type GroupFilter =
  | { kind: 'all' }
  | { kind: 'ungrouped' }
  | { kind: 'include'; g: number }
  | { kind: 'exclude'; g: number }

export function passesGroupFilter(g: number | null, f: GroupFilter): boolean {
  switch (f.kind) {
    case 'all': return true
    case 'ungrouped': return g == null
    case 'include': return g === f.g
    case 'exclude': return g !== f.g
  }
}

function groupFilterToValue(f: GroupFilter): string {
  if (f.kind === 'all') return 'all'
  if (f.kind === 'ungrouped') return 'ungrouped'
  return `${f.kind === 'include' ? 'in' : 'ex'}-${f.g}`
}
function groupFilterFromValue(v: string): GroupFilter {
  if (v === 'all') return { kind: 'all' }
  if (v === 'ungrouped') return { kind: 'ungrouped' }
  const [k, g] = v.split('-')
  return { kind: k === 'in' ? 'include' : 'exclude', g: Number(g) }
}

/** Filter on which template detected each event. ``manual`` shows
 *  only user-added events; numeric tNs match templateIdx. */
export type TemplateFilter =
  | { kind: 'all' }
  | { kind: 'tpl'; t: number }
  | { kind: 'manual' }

export function passesTemplateFilter(
  ev: { templateIdx: number | null; manual: boolean },
  f: TemplateFilter,
): boolean {
  switch (f.kind) {
    case 'all': return true
    case 'manual': return ev.manual
    case 'tpl': return !ev.manual && ev.templateIdx === f.t
  }
}

function templateFilterToValue(f: TemplateFilter): string {
  if (f.kind === 'all') return 'all'
  if (f.kind === 'manual') return 'manual'
  return `t-${f.t}`
}
function templateFilterFromValue(v: string): TemplateFilter {
  if (v === 'all') return { kind: 'all' }
  if (v === 'manual') return { kind: 'manual' }
  const [, t] = v.split('-')
  return { kind: 'tpl', t: Number(t) }
}

/** Combined event-row predicate — group AND template filters. Both
 *  are AND-ed so the user gets the natural "drill into T2 events that
 *  are also group 3" behaviour without a separate UI for combinations. */
export function passesEventFilters(
  ev: { group: number | null; templateIdx: number | null; manual: boolean },
  gf: GroupFilter, tf: TemplateFilter,
): boolean {
  return passesGroupFilter(ev.group, gf) && passesTemplateFilter(ev, tf)
}

// ---------------------------------------------------------------------------
// Top-level window
// ---------------------------------------------------------------------------

export function EventDetectionWindow({
  backendUrl, fileInfo, mainGroup, mainSeries, mainTrace, cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const {
    eventsAnalyses, eventsTemplates,
    runEvents, clearEvents, selectEvent, addManualEvent, removeEvent,
    computeEventsRms,
    saveEventsTemplate, deleteEventsTemplate, selectEventsTemplate,
    setCursors,
    trainParams,
    loading, error, setError,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // ---- Top-row selectors ----
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [channel, setChannel] = useState(mainTrace ?? 0)
  const [sweep, setSweep] = useState(0)
  const hasSyncedMainRef = useRef(false)
  useEffect(() => {
    if (hasSyncedMainRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedMainRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])
  const channels = useMemo(
    () => channelsForSeries(fileInfo, group, series),
    [fileInfo, group, series],
  )
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  useEffect(() => {
    if (sweep >= totalSweeps && totalSweeps > 0) setSweep(0)
  }, [totalSweeps, sweep])

  // ---- Viewport (viewport-based fetch + navigation) ----
  // Series-TYPE-based default (matches the main viewer):
  //   * Episodic series (sweepCount > 1): every sweep is a discrete
  //     protocol-driven episode → full view always, regardless of
  //     duration.
  //   * Single long sweep (sweepCount === 1 AND duration > 60 s): a
  //     continuous spontaneous-events / field recording → open at
  //     the 1 s window so initial paint is cheap and the user gets
  //     a navigable starting view.
  //   * Single short sweep: one-shot evoked response → full view.
  const DEFAULT_VIEWPORT_S = 1
  const CONTINUOUS_SWEEP_THRESHOLD_S = 60
  const [viewport, setViewport] = useState<Viewport>({ tStart: 0, tEnd: DEFAULT_VIEWPORT_S })
  const [sweepDurationS, setSweepDurationS] = useState(0)
  useEffect(() => {
    if (sweepDurationS <= 0) return
    const isContinuous =
      totalSweeps === 1 && sweepDurationS > CONTINUOUS_SWEEP_THRESHOLD_S
    if (isContinuous) {
      // Long single-sweep continuous recording → 1 s window.
      setViewport({ tStart: 0, tEnd: DEFAULT_VIEWPORT_S })
    } else {
      // Episodic (or single short) sweep → full view.
      setViewport({ tStart: 0, tEnd: sweepDurationS })
    }
  }, [group, series, sweep, sweepDurationS, totalSweeps])
  const shiftViewport = useCallback((factor: number) => {
    setViewport((v) => shiftViewportBy(v, sweepDurationS, factor))
  }, [sweepDurationS])
  const goHome = useCallback(() => {
    setViewport((v) => v ? { tStart: 0, tEnd: v.tEnd - v.tStart } : v)
  }, [])
  const goEnd = useCallback(() => {
    setViewport((v) => {
      if (!v || sweepDurationS <= 0) return v
      const w = v.tEnd - v.tStart
      return { tStart: Math.max(0, sweepDurationS - w), tEnd: sweepDurationS }
    })
  }, [sweepDurationS])

  // ---- Cross-window navigate ("Zoom to" + table-click from the
  // detached Browser window). The browser sends
  // { type: 'events-navigate-to', timeS, windowS } and we centre our
  // viewport on that timestamp. A small default window (60 ms) lets
  // the user see rise + decay without having to zoom manually.
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.onmessage = (ev) => {
        if (ev.data?.type !== 'events-navigate-to') return
        const t = Number(ev.data.timeS)
        const w = Number(ev.data.windowS ?? 0.06)
        if (!isFinite(t) || !isFinite(w) || w <= 0) return
        setViewport((cur) => {
          // Preserve the user's current zoom level when sensible: if
          // the request's window fits in the current viewport, just
          // re-centre; otherwise override with the requested window.
          const curLen = cur ? cur.tEnd - cur.tStart : 0
          const useLen = curLen > 0 && curLen <= 2 * w ? curLen : w
          const dur = sweepDurationS
          let start = t - useLen / 2
          let end = t + useLen / 2
          if (dur > 0) {
            if (start < 0) { end -= start; start = 0 }
            if (end > dur) { start -= (end - dur); end = dur }
            start = Math.max(0, start)
          } else {
            start = Math.max(0, start)
          }
          return { tStart: start, tEnd: end }
        })
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [sweepDurationS])

  // ---- Form state ----
  const [params, setParams] = useState<EventsParams>(() => defaultEventsParams())
  const key = `${group}:${series}`
  const entry: EventsData | undefined = eventsAnalyses[key]

  // Train-grouping (post-detection cluster of closely spaced events).
  // Pure derivation: read params from the store, walk events per-sweep,
  // run the shared algorithm, hand the per-event train_id and per-
  // sweep summaries back to the overlay + tables. Manual edits to
  // ``entry.events`` invalidate the memo automatically. ``minIeiMs``
  // from the detection params drives the warning floor — events
  // closer than that get dropped upstream.
  const storedTrainParams = trainParams.events[key] as
    | (TrainParams & { enabled?: boolean })
    | undefined
  const effectiveTrainParams = storedTrainParams ?? defaultTrainParamsFor('events')
  const trainsEnabled = effectiveTrainParams.enabled === true
  const trainData = useMemo(
    () => computeEventTrainIds(
      entry?.events ?? [],
      { ...effectiveTrainParams, enabled: trainsEnabled },
    ),
    [entry?.events, trainsEnabled, effectiveTrainParams.metric,
      effectiveTrainParams.maxIeiMs, effectiveTrainParams.minCount,
      effectiveTrainParams.minDurationMs, effectiveTrainParams.minInterTrainMs],
  )
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entry) return
    if (rehydratedKeyRef.current === key) return
    rehydratedKeyRef.current = key
    // Merge with current defaults so any field added to ``EventsParams``
    // since this entry was serialized (e.g. baseline-method,
    // ampFloorRmsMultiplier) doesn't end up as ``undefined`` in the UI.
    setParams({ ...defaultEventsParams(), ...entry.params })
    setChannel(entry.channel)
    setSweep(entry.sweep)
  }, [entry, key])

  const activeTemplateId = params.templateId ?? eventsTemplates.selectedId
  const activeTemplate: EventsTemplate | null =
    (activeTemplateId && eventsTemplates.entries[activeTemplateId]) || null
  useEffect(() => {
    if (params.templateId == null && eventsTemplates.selectedId) {
      setParams((p) => ({ ...p, templateId: eventsTemplates.selectedId }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsTemplates.selectedId])
  useEffect(() => {
    if (activeTemplate) {
      setParams((p) => ({ ...p, peakDirection: activeTemplate.direction }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate?.id])

  // ---- Splitters (persisted under eventsWindowUI) ----
  const [leftPanelWidth, setLeftPanelWidth] = useState(340)
  const [plotHeight, setPlotHeight] = useState(360)
  // Per-card collapsed state — lets users hide panels they don't
  // touch often. Keyed by card title. Persisted under
  // `eventsWindowUI.collapsedCards`. Defaults put the busy panels
  // (Kinetics / Exclusion) collapsed on first use so the Detection
  // method / Template panels get prime vertical real estate.
  const DEFAULT_COLLAPSED: Record<string, boolean> = {
    'Kinetics': true,
    'Exclusion': true,
    // Skip regions is a power-user feature; hidden until the user
    // adds one. Unchanged from the pre-collapsible-refactor behaviour.
    'Skip regions': true,
    // Threshold card is now always rendered, but only relevant by
    // default for the Threshold method. For correlation /
    // deconvolution it's a vehicle for the RMS workflow that feeds
    // the Min |amp| × RMS mode in Exclusion — collapsed by default.
    'Threshold (RMS)': true,
  }
  const [collapsedCards, setCollapsedCards] = useState<Record<string, boolean>>(DEFAULT_COLLAPSED)
  /** Build collapsible-card props for a given card title. Looked up
   *  against state with the default-collapsed map as fallback. */
  const cardProps = (title: string) => ({
    collapsible: true as const,
    collapsed: collapsedCards[title] ?? DEFAULT_COLLAPSED[title] ?? false,
    onToggle: () => toggleCard(title),
  })
  const toggleCard = useCallback((title: string) => {
    setCollapsedCards((prev) => {
      const cur = prev[title] ?? (DEFAULT_COLLAPSED[title] ?? false)
      const next = { ...prev, [title]: !cur }
      // Fire-and-forget persistence. Keeps the list tight by
      // dropping explicit ``false`` entries that match the default —
      // less churn in the prefs file on repeated open/close cycles.
      const cleaned: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(next)) {
        const def = DEFAULT_COLLAPSED[k] ?? false
        if (v !== def) cleaned[k] = v
      }
      ;(async () => {
        try {
          const api = window.electronAPI
          if (!api?.getPreferences || !api?.setPreferences) return
          const prefs = (await api.getPreferences()) ?? {}
          const ui = { ...(prefs.eventsWindowUI ?? {}), collapsedCards: cleaned }
          await api.setPreferences({ ...prefs, eventsWindowUI: ui })
        } catch { /* ignore */ }
      })()
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Histogram bin sizes — persisted globally under
  // `eventsWindowUI.ampHistBinW` / `ieiHistBinMs`. Lives here at the
  // parent so bin choice survives tab switches (the child tabs
  // unmount when you switch bottom tab). Null = use auto sqrt-N.
  const [ampHistBinW, setAmpHistBinW] = useState<number | null>(null)
  const [ieiHistBinMs, setIeiHistBinMs] = useState<number | null>(null)
  const [rateBinS, setRateBinS] = useState<number>(5)
  // Bottom-pane tab — "table" (events results), "overlay" (all events
  // aligned on peak/foot), or "histogram" (amplitude distribution).
  // Matches EE's tab row below the viewer.
  // Bottom pane is now just the quick-reference views that belong
  // next to the detection controls. The heavy per-event browser + the
  // all-events overlay moved to their own Electron window (see the
  // "Open browser window" button in the results header).
  const [bottomTab, setBottomTab] = useState<
    'table' | 'histogram' | 'rate' | 'ampvstime' | 'iei' | 'trains'
  >('table')
  // Group filter applied to results table + histograms + viewer
  // markers. UI-only state — not persisted, defaults to "all" each
  // session. Curation grouping itself IS persisted on each event row.
  const [groupFilter, setGroupFilter] = useState<GroupFilter>({ kind: 'all' })
  // Template filter — only relevant when multi-template detection
  // tagged events. Combined with the group filter via AND so users
  // can drill into "T2 + group 3" without rerunning anything.
  const [templateFilter, setTemplateFilter] = useState<TemplateFilter>({ kind: 'all' })
  // Zero-offset toggle for the sweep mini-viewer trace fetch. Default
  // off; persisted in Electron prefs so a user who normally works
  // with offset-subtracted traces doesn't have to flip it every
  // session. Mirrors the AP / Burst pattern.
  const [zeroOffset, setZeroOffset] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const ui = prefs?.eventsWindowUI
        if (cancelled || !ui) return
        if (typeof ui.leftPanelWidth === 'number'
            && ui.leftPanelWidth >= 240 && ui.leftPanelWidth <= 600) {
          setLeftPanelWidth(ui.leftPanelWidth)
        }
        if (typeof ui.plotHeight === 'number'
            && ui.plotHeight >= 150 && ui.plotHeight <= 800) {
          setPlotHeight(ui.plotHeight)
        }
        if (ui.collapsedCards && typeof ui.collapsedCards === 'object') {
          // Merge stored overrides ON TOP of the defaults so adding
          // new collapsible cards in the future keeps their default
          // collapsed-ness for existing users.
          setCollapsedCards((prev) => ({ ...prev, ...ui.collapsedCards }))
        }
        if (typeof ui.ampHistBinW === 'number' && ui.ampHistBinW > 0) {
          setAmpHistBinW(ui.ampHistBinW)
        }
        if (typeof ui.ieiHistBinMs === 'number' && ui.ieiHistBinMs > 0) {
          setIeiHistBinMs(ui.ieiHistBinMs)
        }
        if (typeof ui.rateBinS === 'number' && ui.rateBinS > 0) {
          setRateBinS(ui.rateBinS)
        }
        if (typeof ui.zeroOffset === 'boolean') {
          setZeroOffset(ui.zeroOffset)
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
      const next = { ...(prefs.eventsWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, eventsWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  const setZeroOffsetAndPersist = useCallback((v: boolean) => {
    setZeroOffset(v)
    void writeUIPref({ zeroOffset: v })
  }, [])
  // Persist bin-size choices on change. Debounced at 300 ms so a
  // quick succession of Enter-commits doesn't spam setPreferences.
  useEffect(() => {
    const id = setTimeout(() => writeUIPref({ ampHistBinW }), 300)
    return () => clearTimeout(id)
  }, [ampHistBinW, writeUIPref])
  useEffect(() => {
    const id = setTimeout(() => writeUIPref({ ieiHistBinMs }), 300)
    return () => clearTimeout(id)
  }, [ieiHistBinMs, writeUIPref])
  useEffect(() => {
    const id = setTimeout(() => writeUIPref({ rateBinS }), 300)
    return () => clearTimeout(id)
  }, [rateBinS, writeUIPref])

  // Session handoff — whenever the main events window's group /
  // series / channel / sweep / viewport / filter changes, we stamp a
  // snapshot under `eventsWindowSession` in Electron prefs. Sub-
  // windows (template generator, refinement) read it on mount so
  // they open on the SAME view the user was looking at in the main
  // window, with the SAME filter applied — no scrolling back to
  // find the event they were inspecting. Also broadcast the session
  // on every change so already-open sub-windows can pick up live
  // changes.
  const writeEventsSession = useCallback(async (patch: Record<string, any>) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.eventsWindowSession ?? {}), ...patch }
      await api.setPreferences({ ...prefs, eventsWindowSession: next })
      // Notify any open sub-windows.
      try {
        const ch = new BroadcastChannel('tracer-sync')
        ch.postMessage({ type: 'events-session-update', eventsWindowSession: next })
        ch.close()
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    // Debounced write on state change — ~100 ms so rapid scrolling
    // doesn't hammer prefs.
    const id = setTimeout(() => {
      writeEventsSession({
        group, series, channel, sweep,
        viewport: viewport ? { tStart: viewport.tStart, tEnd: viewport.tEnd } : null,
        filter: {
          enabled: params.filterEnabled,
          type: params.filterType,
          low: params.filterLow,
          high: params.filterHigh,
          order: params.filterOrder,
        },
      })
    }, 100)
    return () => clearTimeout(id)
  }, [group, series, channel, sweep, viewport,
      params.filterEnabled, params.filterType,
      params.filterLow, params.filterHigh, params.filterOrder,
      writeEventsSession])
  const onLeftSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftPanelWidth
    let latest = startW
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(240, Math.min(600, startW + (ev.clientX - startX)))
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
  const onSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = plotHeight
    let latest = startH
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(150, Math.min(800, startH + (ev.clientY - startY)))
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

  // ---- Cursor handling ----
  // BroadcastChannel cached at component scope — opening + closing
  // a fresh channel per pointer-move (the previous behaviour) was a
  // ~1 ms hit each, and at 60 Hz dragging that's noticeable on top
  // of the marker redraw cost.
  const cursorBroadcastRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      cursorBroadcastRef.current = new BroadcastChannel('tracer-sync')
    } catch { /* ignore */ }
    return () => {
      try { cursorBroadcastRef.current?.close() } catch { /* ignore */ }
      cursorBroadcastRef.current = null
    }
  }, [])
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    setCursors(next)
    // Broadcast to the main window so its cursor bands move in lockstep.
    try {
      const merged = { ...useAppStore.getState().cursors, ...next }
      cursorBroadcastRef.current?.postMessage({
        type: 'cursor-update', cursors: merged,
      })
    } catch { /* ignore */ }
  }, [setCursors])

  /** Centre the baseline cursor pair in the middle 20% of the current
   *  viewer range — i.e. x range = [0.4·len, 0.6·len] inside viewport. */
  const bringCursorsToView = useCallback(() => {
    const vp = viewport ?? { tStart: 0, tEnd: sweepDurationS || 10 }
    const len = Math.max(1e-3, vp.tEnd - vp.tStart)
    const start = vp.tStart + 0.40 * len
    const end = vp.tStart + 0.60 * len
    updateCursors({ baselineStart: start, baselineEnd: end })
  }, [viewport, sweepDurationS, updateCursors])

  // ---- Run ----
  // Progress fraction the streaming detect endpoint reports per
  // sweep. Drives the RUN button's gradient fill so the user can see
  // long detections (multi-sweep, multi-template) make headway —
  // before the streaming refactor a 60-sweep detection just sat at
  // "Running…" for 30+ seconds with no feedback.
  const [runProgress, setRunProgress] = useState(0)
  const onRun = async () => {
    const template = params.method.startsWith('template_') ? activeTemplate : null
    if (params.method.startsWith('template_') && !template) {
      setError('Select or generate a template first.')
      return
    }
    setRunProgress(0)
    try {
      await runEvents(group, series, channel, sweep, params, template, (frac) => {
        setRunProgress(frac)
      })
    } finally {
      // Brief settle so the user sees the bar reach 100% before the
      // button reverts to the idle label.
      setTimeout(() => setRunProgress(0), 250)
    }
  }

  // ---- Open sub-windows ----
  const openTemplateGenerator = async () => {
    const api = window.electronAPI
    if (api?.openAnalysisWindow) {
      await api.openAnalysisWindow('events_template_generator')
    }
  }
  const openTemplateRefinement = async () => {
    if (!entry || entry.events.length < 2) {
      setError('Run detection first; need ≥ 2 events to refine.')
      return
    }
    const api = window.electronAPI
    if (api?.openAnalysisWindow) {
      await api.openAnalysisWindow('events_template_refinement')
    }
  }
  const openEventsBrowser = async () => {
    if (!entry || entry.events.length === 0) {
      setError('Run detection first to open the browser.')
      return
    }
    const api = window.electronAPI
    if (api?.openAnalysisWindow) {
      await api.openAnalysisWindow('events_browser')
    }
  }

  // ---- Viewer-side actions ----
  const onAddEventAtTime = useCallback(async (timeS: number) => {
    if (!entry) {
      await runEvents(group, series, channel, sweep, params, activeTemplate)
    }
    await addManualEvent(group, series, timeS)
  }, [entry, group, series, channel, sweep, params, activeTemplate,
      runEvents, addManualEvent])
  const onDiscardEvent = useCallback(async (idx: number) => {
    await removeEvent(group, series, idx)
  }, [group, series, removeEvent])

  // Compute the filter payload once for action calls that need it.
  const filterPayload = useMemo(() => ({
    enabled: params.filterEnabled, type: params.filterType,
    low: params.filterLow, high: params.filterHigh, order: params.filterOrder,
  }), [params.filterEnabled, params.filterType, params.filterLow,
      params.filterHigh, params.filterOrder])

  /** Compute RMS over the current cursor band. Shared between the
   *  Threshold method panel (where it drives the n×RMS level line) and
   *  the Exclusion card's RMS amplitude floor toggle. Stores the
   *  result on ``params`` so subsequent detect runs pick it up. */
  const handleComputeRms = useCallback(async () => {
    if (cursors.baselineEnd <= cursors.baselineStart) {
      setError('Cursor region is empty — use "Cursors to view" first.')
      return
    }
    try {
      const r = await computeEventsRms(
        group, series, channel, sweep,
        cursors.baselineStart, cursors.baselineEnd,
        filterPayload,
      )
      setParams((p) => ({
        ...p,
        rmsRegion: {
          startS: cursors.baselineStart,
          endS: cursors.baselineEnd,
        },
        rmsValue: r.rms,
        rmsBaselineMean: r.baselineMean,
      }))
    } catch (err: any) {
      setError(err.message ?? String(err))
    }
  }, [cursors.baselineStart, cursors.baselineEnd, group, series, channel, sweep,
      computeEventsRms, filterPayload, setError])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      {/* Top selectors */}
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
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}
                  disabled={channels.length === 0}>
            {channels.map((c: any) => (
              <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
            ))}
          </select>
        </Field>
        <Field label="Sweep">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setSweep((s) => Math.max(0, s - 1))}
              disabled={sweep <= 0 || totalSweeps === 0} title="Previous sweep">←</button>
            <span style={{
              minWidth: 58, textAlign: 'center',
              fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
            }}>
              {totalSweeps > 0 ? `${sweep + 1} / ${totalSweeps}` : '— / —'}
            </span>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setSweep((s) => Math.min(totalSweeps - 1, s + 1))}
              disabled={sweep >= totalSweeps - 1 || totalSweeps === 0} title="Next sweep">→</button>
          </span>
        </Field>
      </div>

      {/* Two-column body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 0 }}>
        {/* LEFT PANEL */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)',
          padding: 8, borderRadius: 4, border: '1px solid var(--border)',
        }}>
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,
          }}>
            {/* Method card */}
            <Card title="Detection method" {...cardProps('Detection method')}>
              <Row label="Method">
                <select value={params.method} style={{ width: '100%' }}
                  onChange={(e) => setParams((p) => ({
                    ...p, method: e.target.value as EventsParams['method'],
                  }))}>
                  <option value="template_correlation">Template — correlation</option>
                  <option value="template_deconvolution">Template — deconvolution</option>
                  <option value="threshold">Thresholding</option>
                </select>
              </Row>
              <Row label="Peak direction">
                <select value={params.peakDirection} style={{ width: '100%' }}
                  onChange={(e) => setParams((p) => ({
                    ...p, peakDirection: e.target.value as 'negative' | 'positive',
                  }))}>
                  <option value="negative">Negative</option>
                  <option value="positive">Positive</option>
                </select>
              </Row>
            </Card>

            {/* Filter card */}
            <FilterCard params={params} setParams={setParams}
              cardProps={cardProps('Pre-detection filter')} />

            {/* Template card */}
            {params.method.startsWith('template_') && (
              <TemplatePanel
                templates={eventsTemplates.entries}
                activeTemplateId={activeTemplateId}
                activeTemplate={activeTemplate}
                additionalTemplateIds={params.additionalTemplateIds ?? []}
                onPickTemplate={(id) => {
                  setParams((p) => ({ ...p, templateId: id }))
                  selectEventsTemplate(id)
                }}
                onPickAdditional={(idx, id) => {
                  setParams((p) => {
                    const next = [...(p.additionalTemplateIds ?? [])]
                    if (id == null) {
                      next.splice(idx, 1)
                    } else {
                      next[idx] = id
                    }
                    // Keep compact — drop any undefined slots.
                    return { ...p, additionalTemplateIds: next.filter(Boolean) }
                  })
                }}
                onOpenGenerator={openTemplateGenerator}
                onOpenRefinement={openTemplateRefinement}
                canRefine={(entry?.events.length ?? 0) >= 2}
                cardProps={cardProps('Template')}
              />
            )}

            {/* Detection algorithm cutoff */}
            {params.method === 'template_correlation' && (
              <Card title="Correlation cutoff" {...cardProps('Correlation cutoff')}>
                <Row label="Cutoff (r)">
                  <NumInput value={params.correlationCutoff} step={0.05} min={-1} max={1}
                    onChange={(v) => setParams((p) => ({ ...p, correlationCutoff: v }))} />
                </Row>
                <HelpText>Typical 0.3–0.6. Raise to miss noise, lower to catch smaller events.</HelpText>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={params.showDetectionMeasure}
                    onChange={(e) => setParams((p) => ({ ...p, showDetectionMeasure: e.target.checked }))} />
                  <span>Show correlation trace</span>
                </label>
              </Card>
            )}
            {params.method === 'template_deconvolution' && (
              <Card title="Deconvolution cutoff" {...cardProps('Deconvolution cutoff')}>
                <Row label="Cutoff (σ)">
                  <NumInput value={params.deconvCutoffSd} step={0.25} min={0.5}
                    onChange={(v) => setParams((p) => ({ ...p, deconvCutoffSd: v }))} />
                </Row>
                <Row label="Low (Hz)">
                  <NumInput value={params.deconvLowHz} step={0.1} min={0}
                    onChange={(v) => setParams((p) => ({ ...p, deconvLowHz: v }))} />
                </Row>
                <Row label="High (Hz)">
                  <NumInput value={params.deconvHighHz} step={10} min={1}
                    onChange={(v) => setParams((p) => ({ ...p, deconvHighHz: v }))} />
                </Row>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={params.showDetectionMeasure}
                    onChange={(e) => setParams((p) => ({ ...p, showDetectionMeasure: e.target.checked }))} />
                  <span>Show filtered deconvolution</span>
                </label>
                <HelpText>
                  Overlay the deconvolution trace beneath the viewer with
                  a horizontal line at the cutoff — lets you tune the
                  σ and low/high cutoffs visually.
                </HelpText>
              </Card>
            )}

            {/* Threshold / RMS card — always visible. For the Threshold
                method it controls the detection level line; for
                correlation / deconvolution the same RMS value feeds the
                Exclusion → Min |amp| (× RMS mode) below. Collapsed by
                default when the method isn't Threshold so the panel
                stays compact for the common template-method case. */}
            <ThresholdPanel
              params={params}
              onParamsChange={setParams}
              cursors={cursors}
              onBringCursorsToView={bringCursorsToView}
              cardProps={cardProps(
                params.method === 'threshold' ? 'Threshold' : 'Threshold (RMS)',
              )}
              onComputeRms={handleComputeRms}
            />

            {/* Kinetics card */}
            <Card title="Kinetics" {...cardProps('Kinetics')}>
              {/* Baseline detection method — Auto (Jonas) or
                  Polynomial-curve (drift-aware). Polynomial is the
                  better choice for recordings whose baseline drifts
                  faster than the rolling-median detrend can flatten
                  without ringing on event edges. */}
              <Row label="Baseline">
                <select value={params.baselineMethod}
                  style={{ width: '100%' }}
                  onChange={(e) => setParams((p) => ({
                    ...p, baselineMethod: e.target.value as 'auto' | 'polynomial',
                  }))}
                  title="Auto: per-event Jonas line-intersect. Polynomial: low-order polynomial fit to the sweep, evaluated at each event's foot.">
                  <option value="auto">Auto</option>
                  <option value="polynomial">Polynomial curve</option>
                </select>
              </Row>
              {params.baselineMethod === 'polynomial' && (
                <Row label="Poly order">
                  <NumInput value={params.baselinePolyOrder} step={1} min={1}
                    onChange={(v) => setParams((p) => ({
                      ...p, baselinePolyOrder: Math.max(1, Math.round(v)),
                    }))} />
                </Row>
              )}
              {/* Per-event biexp fit overlay — thin black curves
                  drawn over each visible event's foot → endpoint
                  span. Off by default to keep the viewer clean. */}
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6,
              }} title="Overlay the per-event biexp fit on the main viewer">
                <input type="checkbox" checked={params.showEventFits}
                  onChange={(e) => setParams((p) => ({
                    ...p, showEventFits: e.target.checked,
                  }))} />
                <span>Show event fits</span>
              </label>
              {/* Decay-endpoint method — controls how the integration
                  window's right edge is chosen post-peak. First-cross
                  is the EE default and matches what we shipped before;
                  Entire-region gives a deterministic window at the
                  expense of including some baseline tail. */}
              <Row label="Decay end">
                <select value={params.decayEndpointMethod}
                  style={{ width: '100%' }}
                  onChange={(e) => setParams((p) => ({
                    ...p, decayEndpointMethod: e.target.value as 'first_cross' | 'entire',
                  }))}
                  title="First baseline cross within the search window (default), or always use the entire search window.">
                  <option value="first_cross">First baseline cross</option>
                  <option value="entire">Entire search region</option>
                </select>
              </Row>
              <Row label="Baseline search (ms)">
                <NumInput value={params.baselineSearchMs} step={1} min={1}
                  onChange={(v) => setParams((p) => ({ ...p, baselineSearchMs: v }))} />
              </Row>
              <Row label="Avg baseline (ms)">
                <NumInput value={params.avgBaselineMs} step={0.1} min={0.1}
                  onChange={(v) => setParams((p) => ({ ...p, avgBaselineMs: v }))} />
              </Row>
              <Row label="Avg peak (ms)">
                <NumInput value={params.avgPeakMs} step={0.1} min={0.1}
                  onChange={(v) => setParams((p) => ({ ...p, avgPeakMs: v }))} />
              </Row>
              {/* Rise-time convention — standard presets (10–90 is the
                  classic e-phys default, 20–80 is less noise-sensitive,
                  37–63 is the "1 τ" span). Custom unlocks the two
                  number fields below. Whatever pair is active feeds
                  the per-event `rise_time_ms` calculation. */}
              {(() => {
                const lo = params.riseLowPct, hi = params.riseHighPct
                const preset =
                  (lo === 10 && hi === 90) ? '10-90'
                  : (lo === 20 && hi === 80) ? '20-80'
                  : (lo === 37 && hi === 63) ? '37-63'
                  : 'custom'
                return (
                  <>
                    <Row label="Rise convention">
                      {/* Drop `width:100%` on the select — `Row` already
                          constrains the right-hand column to 80 px, so
                          the select now matches the sibling NumInputs
                          instead of stretching. */}
                      <select value={preset}
                        style={{ width: '100%' }}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === '10-90') setParams((p) => ({ ...p, riseLowPct: 10, riseHighPct: 90 }))
                          else if (v === '20-80') setParams((p) => ({ ...p, riseLowPct: 20, riseHighPct: 80 }))
                          else if (v === '37-63') setParams((p) => ({ ...p, riseLowPct: 37, riseHighPct: 63 }))
                          else {
                            // Entering Custom — seed with the current
                            // pair if they're already off-preset;
                            // otherwise default to 10–90 which the user
                            // can tweak. Prevents "Custom" from keeping
                            // a preset's exact values (which would
                            // snap the dropdown back to that preset on
                            // the next re-render).
                            if (preset !== 'custom') {
                              setParams((p) => ({ ...p, riseLowPct: 15, riseHighPct: 85 }))
                            }
                          }
                        }}>
                        <option value="10-90">10–90 %</option>
                        <option value="20-80">20–80 %</option>
                        <option value="37-63">37–63 %</option>
                        <option value="custom">Custom…</option>
                      </select>
                    </Row>
                    {/* Only surface the raw % fields when Custom is
                        selected — keeps the Kinetics card tight for
                        the 95 % of users who want a preset. */}
                    {preset === 'custom' && (
                      <>
                        <Row label="Rise low %">
                          <NumInput value={params.riseLowPct} step={5} min={0} max={100}
                            onChange={(v) => setParams((p) => ({ ...p, riseLowPct: v }))} />
                        </Row>
                        <Row label="Rise high %">
                          <NumInput value={params.riseHighPct} step={5} min={0} max={100}
                            onChange={(v) => setParams((p) => ({ ...p, riseHighPct: v }))} />
                        </Row>
                      </>
                    )}
                  </>
                )
              })()}
              <Row label="Decay %">
                <NumInput value={params.decayPct} step={1} min={1} max={99}
                  onChange={(v) => setParams((p) => ({ ...p, decayPct: v }))} />
              </Row>
              <Row label="Decay search (ms)">
                <NumInput value={params.decaySearchMs} step={5} min={1}
                  onChange={(v) => setParams((p) => ({ ...p, decaySearchMs: v }))} />
              </Row>
            </Card>

            {/* Exclusion card — matches EE's Exclusion panel. Events
                outside any of these bounds get dropped from the table.
                Null = filter off. Manual-added events bypass these
                guards, so users can force-include a marginal event. */}
            <Card title="Exclusion" {...cardProps('Exclusion')}>
              {/* Min |amp| with a mode toggle: absolute pA/mV value, OR
                  n × RMS of the quiet region (computed via the Threshold
                  card above). Picking × RMS gives noise-relative
                  rejection — useful when noise levels vary across cells
                  in batch. The two values are stored independently so
                  switching modes preserves both. */}
              <MinAmpRow
                params={params}
                setParams={setParams} />
              <Row label="Max |amp|">
                <NumInput value={params.amplitudeMaxAbs} step={50} min={1}
                  onChange={(v) => setParams((p) => ({ ...p, amplitudeMaxAbs: v }))} />
              </Row>
              <Row label="Min IEI (ms)">
                <NumInput value={params.minIeiMs} step={1} min={0}
                  onChange={(v) => setParams((p) => ({ ...p, minIeiMs: v }))} />
              </Row>
              <OptionalNumRow
                label="Max AUC" value={params.aucMinAbs} step={0.01} min={0}
                onChange={(v) => setParams((p) => ({ ...p, aucMinAbs: v }))}
                title="Drop events whose integrated area is below this value" />
              <OptionalNumRow
                label="Max rise (ms)" value={params.riseMaxMs} step={0.5} min={0.1}
                onChange={(v) => setParams((p) => ({ ...p, riseMaxMs: v }))}
                title="Drop events with rise time exceeding this value" />
              <OptionalNumRow
                label="Max decay (ms)" value={params.decayMaxMs} step={1} min={0.1}
                onChange={(v) => setParams((p) => ({ ...p, decayMaxMs: v }))}
                title="Drop events with decay time exceeding this value" />
              <OptionalNumRow
                label="Max FWHM (ms)" value={params.fwhmMaxMs} step={1} min={0.1}
                onChange={(v) => setParams((p) => ({ ...p, fwhmMaxMs: v }))}
                title="Drop events with half-width exceeding this value" />
              {/* Min biexp R² — when on, events whose biexp fit R² is
                  below the value are dropped. Manual events bypass.
                  0.7 is lax (catches obvious noise), 0.85 is strict
                  (mostly clean events only). */}
              <OptionalNumRow
                label="Min R² (biexp)" value={params.biexpMinR2} step={0.05} min={0}
                onChange={(v) => setParams((p) => ({ ...p, biexpMinR2: v }))}
                title="Drop events whose biexp goodness-of-fit is below this value (auto-detected only)." />
            </Card>

            {/* Skip regions — up to 5 time ranges where detection is
                suppressed (stimulus artifacts, perfusion switches).
                Each entry is independently toggleable so users can
                A/B detection with and without a given region. Drawn
                as red bands on the main viewer; drag edges / bands
                to adjust like the baseline cursors. Sweep-duration-
                anchored, so they persist across re-runs. */}
            <SkipRegionsCard
              params={params}
              setParams={setParams}
              sweepDurationS={sweepDurationS}
              viewport={viewport}
              cardProps={cardProps('Skip regions')}
            />

            {/* Post-detection: optional grouping of closely-spaced
                events into trains. Off by default; results derive
                live from the events list, so manual add/remove
                rebuilds train assignments without re-running
                detection. ``minIeiMs`` from the detection params
                drives the warning floor — events closer than that
                are already dropped upstream. */}
            <TrainOptions
              module="events"
              group={group}
              series={series}
              hostMergeFloorMs={params.minIeiMs}
            />
          </div>

          {/* Pinned Run footer */}
          <div style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8, border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            {(() => {
              // RUN button = a progress bar.
              //
              // The label always reflects the current state. The
              // background depends on ``loading``:
              //   - idle    → default primary button (CSS class)
              //   - loading → a CSS-painted bar laid OVER the button
              //     by way of an absolutely-positioned overlay div.
              //     We use an overlay (rather than a background
              //     gradient) so the button can keep its primary
              //     colour underneath; the overlay is the accent
              //     fill for whatever progress fraction we have.
              //
              // When loading but no progress yet (single-sweep run,
              // or backend hasn't finished its first sweep), the
              // overlay is 100% wide with a faded indeterminate
              // animation so the user sees activity immediately —
              // the previous "no-fill until first progress event"
              // looked broken on fast detections that completed
              // before the first progress chunk could repaint.
              const pct = Math.round(runProgress * 100)
              const hasProgress = runProgress > 0
              return (
                <button className="btn btn-primary" onClick={onRun}
                  disabled={loading || !fileInfo}
                  style={{
                    width: '100%', padding: '8px 0',
                    fontSize: 'var(--font-size-sm)', fontWeight: 600,
                    position: 'relative',
                    overflow: 'hidden',
                  }}>
                  {loading && hasProgress && (
                    // Determinate fill — semi-transparent white wash
                    // across the left ``pct%`` of the button. Sits on
                    // top of the primary-button background colour so
                    // the colour shift reads as "X% complete".
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: `linear-gradient(to right,
                          rgba(255,255,255,0.32) 0%,
                          rgba(255,255,255,0.32) ${pct}%,
                          transparent ${pct}%,
                          transparent 100%)`,
                        transition: 'background 80ms linear',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                  {loading && !hasProgress && (
                    // Indeterminate marquee — a bright stripe slides
                    // left-to-right across the button so the user sees
                    // activity even when we don't know the fraction
                    // (single-sweep runs, slow first sweep, etc.).
                    // The stripe is a narrow gradient bar, repeated
                    // by the keyframe animation moving its position.
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.42) 50%, transparent 100%)',
                        backgroundSize: '40% 100%',
                        backgroundRepeat: 'no-repeat',
                        animation: 'btn-indet 1.2s linear infinite',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                  <span style={{ position: 'relative' }}>
                    {loading
                      ? (hasProgress
                        ? `Running… ${pct}%`
                        : 'Running…')
                      : params.sweepMode === 'all'
                        ? `Run on all sweeps (${totalSweeps})`
                        : 'Run'}
                  </span>
                  {/* Indeterminate-bar keyframes scoped via a style
                      tag adjacent to the button. Defined inline so we
                      don't have to add a global CSS rule for one
                      affordance. The stripe starts off-screen left
                      (-50% of its 40%-wide bar = -20% of container),
                      slides to off-screen right. */}
                  <style>{`
                    @keyframes btn-indet {
                      0%   { background-position: -50% 0; }
                      100% { background-position: 150% 0; }
                    }
                  `}</style>
                </button>
              )
            })()}
            {/* Sweep-mode dropdown — sits directly under the Run
                button so the "what am I about to run on?" is right
                next to the action. Same pattern as the other analysis
                windows. Excluded sweeps (from the CursorPanel) are
                automatically skipped when 'all' is chosen. */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 'var(--font-size-label)',
            }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Run on</span>
              <select value={params.sweepMode} style={{ minWidth: 140 }}
                onChange={(e) => setParams((p) => ({
                  ...p, sweepMode: e.target.value as 'current' | 'all',
                }))}>
                <option value="current">Current sweep only</option>
                <option value="all">All sweeps ({totalSweeps})</option>
              </select>
            </label>
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn" onClick={() => clearEvents(group, series)}
                disabled={!entry}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={() => exportEventsCSV(
                  entry,
                  fileInfo?.fileName ?? 'recording',
                  trainsEnabled ? trainData.idByGlobalIdx : null,
                )}
                disabled={!entry || entry.events.length === 0}
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
              <button className="btn btn-sm" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* Vertical splitter */}
        <div onMouseDown={onLeftSplitMouseDown} title="Drag to resize"
          style={{
            width: 3, flexShrink: 0, cursor: 'col-resize',
            background: 'var(--border)', position: 'relative',
          }}>
          <div style={{
            position: 'absolute', top: '50%', left: 0,
            transform: 'translateY(-50%)',
            width: 2, height: 40, background: 'var(--text-muted)',
            borderRadius: 1, opacity: 0.5,
          }} />
        </div>

        {/* RIGHT PANEL */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>
          {/* Main viewer. The detection-measure trace (correlation r or
              filtered deconvolution) is now drawn as a SECOND series
              on the same plot — with its own right-hand Y axis —
              instead of in a stacked subplot. Matches EE. */}
          <div style={{ height: plotHeight, minHeight: 180, flexShrink: 0 }}>
            <EventsSweepViewer
              backendUrl={backendUrl}
              group={group} series={series} channel={channel} sweep={sweep}
              entry={entry}
              params={params}
              setParams={setParams}
              groupFilter={groupFilter}
              templateFilter={templateFilter}
              activeTemplate={activeTemplate}
              cursors={cursors}
              updateCursors={updateCursors}
              viewport={viewport}
              setViewport={setViewport}
              sweepDurationS={sweepDurationS}
              setSweepDurationS={setSweepDurationS}
              trainsForSweep={trainData.summariesBySweep.get(sweep) ?? []}
              shiftViewport={shiftViewport}
              goHome={goHome}
              goEnd={goEnd}
              theme={theme} fontSize={fontSize}
              heightSignal={plotHeight}
              onAddEvent={onAddEventAtTime}
              onDiscardEvent={onDiscardEvent}
              zeroOffset={zeroOffset}
              onZeroOffsetChange={setZeroOffsetAndPersist}
            />
          </div>

          {/* Horizontal splitter */}
          <div onMouseDown={onSplitMouseDown} title="Drag to resize"
            style={{
              height: 3, cursor: 'row-resize', background: 'var(--border)',
              flexShrink: 0, position: 'relative',
            }}>
            <div style={{
              position: 'absolute', left: '50%', top: 0,
              transform: 'translateX(-50%)',
              width: 40, height: 2, background: 'var(--text-muted)',
              borderRadius: 1, opacity: 0.5,
            }} />
          </div>

          {/* Summary stats — single-line headline, live-updating. */}
          <EventsSummaryBar entry={entry} />

          {/* Bottom tabs: Results (table) / Overlay / Histogram. Tabs
              let us add views without growing the already-busy main
              window vertically. Each tab fills the remaining flex
              space below the summary bar. */}
          <div style={{
            flex: 1, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            marginTop: 4,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <div style={{
              display: 'flex', gap: 6, alignItems: 'center',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
              padding: '4px 6px',
              background: 'var(--bg-secondary)',
            }}>
              <div className="segmented" role="tablist">
                {(['table', 'histogram', 'iei', 'rate', 'ampvstime', 'trains'] as const).map((k) => (
                  <button key={k}
                    role="tab"
                    aria-selected={bottomTab === k}
                    className={bottomTab === k ? 'active' : undefined}
                    onClick={() => setBottomTab(k)}
                    style={{ flex: 'none' }}>
                    {k === 'table' ? 'Results'
                      : k === 'histogram' ? 'Amp hist'
                      : k === 'iei' ? 'IEI hist'
                      : k === 'rate' ? 'Rate'
                      : k === 'ampvstime' ? 'Amp vs time'
                      : `Trains${trainData.flatSummaries.length > 0
                        ? ` (${trainData.flatSummaries.length})` : ''}`}
                  </button>
                ))}
              </div>
              <span style={{ flex: 1 }} />
              {/* Template filter — visible only when multi-template
                  detection actually tagged at least one event. AND-ed
                  with the group filter below. */}
              {entry?.events.some((e) => e.templateIdx != null || e.manual) && (
                <label style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontSize: 'var(--font-size-label)', marginRight: 6,
                }} title="Filter displayed events by which template detected them">
                  <span style={{ color: 'var(--text-muted)' }}>Tpl</span>
                  <select value={templateFilterToValue(templateFilter)}
                    onChange={(e) => setTemplateFilter(templateFilterFromValue(e.target.value))}
                    style={{ padding: '2px 4px' }}>
                    <option value="all">All</option>
                    <option value="t-0">T1 only</option>
                    <option value="t-1">T2 only</option>
                    <option value="t-2">T3 only</option>
                    <option value="manual">Manual only</option>
                  </select>
                </label>
              )}
              {/* Group filter — limits the results table, histograms,
                  and viewer markers to one group, or hides one. The
                  underlying group tags persist; the filter is purely
                  what's displayed. */}
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 'var(--font-size-label)', marginRight: 6,
              }} title="Filter displayed events by curation group">
                <span style={{ color: 'var(--text-muted)' }}>Group</span>
                <select value={groupFilterToValue(groupFilter)}
                  onChange={(e) => setGroupFilter(groupFilterFromValue(e.target.value))}
                  style={{ padding: '2px 4px' }}>
                  <option value="all">All</option>
                  <option value="ungrouped">Ungrouped</option>
                  <option value="in-1">Only 1</option>
                  <option value="in-2">Only 2</option>
                  <option value="in-3">Only 3</option>
                  <option value="in-4">Only 4</option>
                  <option value="in-5">Only 5</option>
                  <option value="ex-1">Hide 1</option>
                  <option value="ex-2">Hide 2</option>
                  <option value="ex-3">Hide 3</option>
                  <option value="ex-4">Hide 4</option>
                  <option value="ex-5">Hide 5</option>
                </select>
              </label>
              {/* Open the detached Browser + Overlay window. Lives
                  flush-right on the tab bar for easy one-click access
                  once the user has run detection. */}
              {/* Edit-Kinetics shortcut — opens the browser focused
                  on whichever event is currently selected. The browser
                  picks up the selection via the shared ``selectedIdx``
                  on the entry, so opening it after we've selected
                  drops the user straight onto the right event for
                  drag-mode editing. */}
              <button className="btn btn-sm"
                onClick={openEventsBrowser}
                disabled={!entry || entry.events.length === 0
                          || entry.selectedIdx == null}
                title="Open the Event Browser focused on the selected event for kinetics editing"
                style={{ alignSelf: 'center' }}>
                Edit selected…
              </button>
              <button className="btn btn-sm"
                onClick={openEventsBrowser}
                disabled={!entry || entry.events.length === 0}
                title="Open the detached Browser & Overlay window"
                style={{ alignSelf: 'center' }}>
                Open browser + overlay…
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {bottomTab === 'table' && (
                <div style={{ height: '100%', overflow: 'auto' }}>
                  <EventsResultsTable
                    entry={entry}
                    groupFilter={groupFilter}
                    templateFilter={templateFilter}
                    onSelect={(idx) => {
                      // Mark selected + zoom to event. In cross-sweep
                      // mode the clicked row may belong to a different
                      // sweep than the one currently shown — switch to
                      // that sweep first so the viewport applies to
                      // the right trace.
                      selectEvent(group, series, idx)
                      const e = entry?.events[idx]
                      if (e) {
                        if (e.sweep !== sweep) setSweep(e.sweep)
                        const useLen = viewport
                          && viewport.tEnd - viewport.tStart > 0
                          && viewport.tEnd - viewport.tStart <= 0.12
                            ? viewport.tEnd - viewport.tStart
                            : 0.06
                        let start = e.peakTimeS - useLen / 2
                        let end = e.peakTimeS + useLen / 2
                        const dur = sweepDurationS
                        if (dur > 0) {
                          if (start < 0) { end -= start; start = 0 }
                          if (end > dur) { start -= (end - dur); end = dur }
                          start = Math.max(0, start)
                        } else { start = Math.max(0, start) }
                        setViewport({ tStart: start, tEnd: end })
                      }
                    }}
                    onDiscard={(idx) => onDiscardEvent(idx)}
                    trainIdByIdx={trainsEnabled ? trainData.idByGlobalIdx : null}
                  />
                </div>
              )}
              {/* Browser + Overlay tabs were moved to a dedicated
                  Electron window — see the "Open browser + overlay"
                  button on this tab bar. */}
              {bottomTab === 'histogram' && (
                <AmplitudeHistogram
                  entry={entry}
                  groupFilter={groupFilter}
                  templateFilter={templateFilter}
                  heightSignal={plotHeight}
                  binW={ampHistBinW} setBinW={setAmpHistBinW}
                />
              )}
              {bottomTab === 'rate' && (
                <EventRatePlot
                  entry={entry}
                  groupFilter={groupFilter}
                  templateFilter={templateFilter}
                  heightSignal={plotHeight}
                  binS={rateBinS} setBinS={setRateBinS}
                />
              )}
              {bottomTab === 'ampvstime' && (
                <AmpVsTimeScatter
                  entry={entry}
                  groupFilter={groupFilter}
                  templateFilter={templateFilter}
                  heightSignal={plotHeight}
                />
              )}
              {bottomTab === 'iei' && (
                <IEIHistogram
                  entry={entry}
                  groupFilter={groupFilter}
                  templateFilter={templateFilter}
                  heightSignal={plotHeight}
                  binMs={ieiHistBinMs} setBinMs={setIeiHistBinMs}
                />
              )}
              {bottomTab === 'trains' && (
                <EventTrainsTab
                  trains={trainData.flatSummaries}
                  enabled={trainsEnabled}
                  onExport={() => exportEventTrainsCSV(
                    trainData.flatSummaries,
                    effectiveTrainParams,
                    fileInfo?.fileName ?? 'recording',
                    group, series,
                  )}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers (small UI primitives)
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

/** Left-panel card with an optional collapsible header.
 *
 * When ``collapsible`` is true and ``collapsed`` is passed, clicking
 * the header toggles the pane via ``onToggle``. The parent is
 * responsible for persisting the collapsed state (the main window
 * stores it under ``eventsWindowUI.collapsedCards`` keyed by ``title``).
 * Non-collapsible cards render the same as before, no disclosure
 * affordance shown. */
function Card({
  title, children,
  collapsible = false,
  collapsed = false,
  onToggle,
  rightAdornment,
}: {
  title: string
  children: React.ReactNode
  collapsible?: boolean
  collapsed?: boolean
  onToggle?: () => void
  /** Optional inline control(s) that live on the header to the right
   *  of the title (e.g. a count badge). Not clickable — header click
   *  still toggles collapse. */
  rightAdornment?: React.ReactNode
}) {
  // One header span per card, arrow pinned to the right via
  // `margin-left: auto` rather than a phantom spacer + flex:1 on the
  // arrow itself. The old layout rendered the arrow in a flex-row as
  // the growing child which, when combined with CSS transform on
  // collapse, sometimes produced half-redrawn "leftover" glyphs next
  // to the title after repeated open/close cycles.
  const header = (
    <div
      className="section-card-title"
      onClick={collapsible ? onToggle : undefined}>
      <span>{title}</span>
      {rightAdornment}
      {collapsible && (
        <span aria-hidden="true" style={{
          marginLeft: 'auto',
          color: 'var(--text-muted)',
          display: 'inline-block',
          width: 10, textAlign: 'center',
          lineHeight: 1,
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transformOrigin: 'center',
          transition: 'transform 0.15s',
        }}>▾</span>
      )}
    </div>
  )
  return (
    <div className="section-card">
      {header}
      {!collapsed && children}
    </div>
  )
}

function Row({ label, children }: {
  label: React.ReactNode    // string for plain rows; ReactNode for colored markers etc.
  children: React.ReactNode
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--text-muted)', flex: 1 }}>{label}</span>
      <span style={{ minWidth: 80 }}>{children}</span>
    </label>
  )
}

/** A nullable-number row with a small checkbox-style enable toggle.
 *  Null = filter off (checkbox unchecked); number = filter on with
 *  that value. Lets the user turn each kinetic-max filter on or off
 *  without having to nuke the value when disabling. */
function OptionalNumRow({
  label, value, step, min, onChange, title,
}: {
  label: string
  value: number | null
  step?: number; min?: number
  onChange: (v: number | null) => void
  title?: string
}) {
  const enabled = value != null
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}
           title={title}>
      <input type="checkbox" checked={enabled}
        onChange={(e) => onChange(e.target.checked
          ? (value ?? (step ?? 1) * 10) : null)} />
      <span style={{
        color: enabled ? undefined : 'var(--text-muted)',
        flex: 1, opacity: enabled ? 1 : 0.6,
      }}>{label}</span>
      <span style={{ minWidth: 80 }}>
        <NumInput
          value={value ?? 0}
          step={step} min={min}
          onChange={(v) => onChange(v)}
        />
      </span>
    </label>
  )
}

/** Min |amp| field with a unit toggle: absolute pA/mV, or n × RMS of
 *  the quiet region (computed via the Threshold card). Mode is stored
 *  on ``useRmsAmpFloor``; ``amplitudeMinAbs`` and ``ampFloorRmsMultiplier``
 *  are kept separate so switching modes preserves both values. The
 *  effective floor in absolute units is shown below when × RMS is
 *  selected and an RMS value is available. */
function MinAmpRow({
  params, setParams,
}: {
  params: EventsParams
  setParams: (updater: (p: EventsParams) => EventsParams) => void
}) {
  const useRms = params.useRmsAmpFloor
  const rms = params.rmsValue
  const effective = (useRms && rms != null)
    ? params.ampFloorRmsMultiplier * Math.abs(rms)
    : null
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '2px 0',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        title="Minimum event |amplitude|. Absolute uses a fixed pA/mV value; × RMS multiplies the quiet-region RMS (from the Threshold card).">
        <span style={{ color: 'var(--text-muted)', flex: 1 }}>Min |amp|</span>
        <select value={useRms ? 'rms' : 'abs'}
          style={{ width: 70 }}
          onChange={(e) => setParams((p) => ({
            ...p, useRmsAmpFloor: e.target.value === 'rms',
          }))}>
          <option value="abs">abs</option>
          <option value="rms">× RMS</option>
        </select>
        <span style={{ minWidth: 80 }}>
          {useRms ? (
            <NumInput value={params.ampFloorRmsMultiplier} step={0.5} min={0}
              onChange={(v) => setParams((p) => ({ ...p, ampFloorRmsMultiplier: v }))} />
          ) : (
            <NumInput value={params.amplitudeMinAbs} step={1} min={0}
              onChange={(v) => setParams((p) => ({ ...p, amplitudeMinAbs: v }))} />
          )}
        </span>
      </label>
      {useRms && (
        <div style={{
          fontSize: 'var(--font-size-label)',
          color: 'var(--text-muted)',
          paddingLeft: 6,
        }}>
          {rms != null
            ? `RMS = ${Math.abs(rms).toFixed(3)} → floor ≈ ${effective?.toFixed(2)}`
            : 'Compute RMS in the Threshold card above first.'}
        </div>
      )}
    </div>
  )
}

function HelpText({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      color: 'var(--text-muted)', fontStyle: 'italic',
      fontSize: 'var(--font-size-label)',
    }}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Skip-regions card — up to 5 time ranges where detection is
// suppressed. Each has its own enable checkbox + start / end inputs
// + delete button. "From cursors" sets the region to the current
// baseline cursor span so users don't always have to type numbers.
// The regions also draw as translucent red bands on the main events
// viewer, with edge/band drag support (see SkipRegionHandle refs).
// ---------------------------------------------------------------------------

const MAX_SKIP_REGIONS = 5

function SkipRegionsCard({
  params, setParams, sweepDurationS, viewport, cardProps,
}: {
  params: EventsParams
  setParams: React.Dispatch<React.SetStateAction<EventsParams>>
  sweepDurationS: number
  viewport: Viewport
  cardProps?: CollapsibleCardProps
}) {
  const regions = params.skipRegions ?? []
  const { cursors } = useAppStore()
  // Count badge on the header tells the user at a glance whether any
  // regions are configured even when the card is collapsed.
  const enabledCount = regions.filter((r) => r.enabled).length

  const update = (i: number, patch: Partial<typeof regions[number]>) => {
    setParams((p) => {
      const next = [...(p.skipRegions ?? [])]
      next[i] = { ...next[i], ...patch }
      return { ...p, skipRegions: next }
    })
  }
  const addRegion = () => {
    setParams((p) => {
      const prev = p.skipRegions ?? []
      if (prev.length >= MAX_SKIP_REGIONS) return p
      // Place the new region in the middle 20% of the current view,
      // so the user can see it immediately and drag to refine.
      const vp = viewport ?? { tStart: 0, tEnd: sweepDurationS || 10 }
      const len = Math.max(1e-3, vp.tEnd - vp.tStart)
      const startS = vp.tStart + 0.40 * len
      const endS = vp.tStart + 0.60 * len
      return {
        ...p,
        skipRegions: [...prev, { enabled: true, startS, endS }],
      }
    })
    // Force-open the card so the user sees the region they just
    // added, even if they had it collapsed.
    if (cardProps?.collapsed) cardProps.onToggle()
  }
  const removeRegion = (i: number) => {
    setParams((p) => ({
      ...p,
      skipRegions: (p.skipRegions ?? []).filter((_, k) => k !== i),
    }))
  }

  // Card now shared with the other collapsible cards in the left
  // panel — centralised collapsed state, persisted via prefs.
  return (
    <Card
      title={`Skip regions${enabledCount > 0 ? ` (${enabledCount})` : ''}`}
      {...(cardProps ?? { collapsible: true as const, collapsed: true,
                          onToggle: () => {} })}>
      <>
          {regions.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Detection is never suppressed. Add a region to exclude a
              time range — useful for stimulus artifacts.
            </span>
          )}
          {regions.map((r, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', gap: 4,
              padding: 6, borderRadius: 3,
              background: r.enabled ? 'color-mix(in oklab, var(--error) 10%, transparent)' : 'var(--bg-field)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={r.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })} />
                <span style={{ fontWeight: 600, flex: 1 }}>Region {i + 1}</span>
                <button className="btn"
                  title="Set this region to the current baseline-cursor span"
                  onClick={() => update(i, {
                    startS: Math.min(cursors.baselineStart, cursors.baselineEnd),
                    endS: Math.max(cursors.baselineStart, cursors.baselineEnd),
                  })}
                  style={{ padding: '1px 6px', fontSize: 'var(--font-size-xs)' }}>
                  From cursors
                </button>
                <button className="btn"
                  onClick={() => removeRegion(i)}
                  style={{ padding: '1px 6px', fontSize: 'var(--font-size-xs)' }}
                  title="Remove this region">✕</button>
              </div>
              {/* Start / end pinned to 4 decimals + a hard maxWidth so
                  they don't grow past the card's right border when the
                  drag resolution pushes a long float into the field
                  (the flex container would happily let them expand
                  and overflow). */}
              <div style={{
                display: 'flex', gap: 4, minWidth: 0,
              }}>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  flex: 1, minWidth: 0,
                }}>
                  <span style={{ color: 'var(--text-muted)' }}>Start</span>
                  <NumInput value={r.startS} step={0.1} min={0}
                    decimals={4}
                    style={{ width: '100%', minWidth: 0, maxWidth: 72 }}
                    onChange={(v) => update(i, { startS: v })} />
                </label>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  flex: 1, minWidth: 0,
                }}>
                  <span style={{ color: 'var(--text-muted)' }}>End</span>
                  <NumInput value={r.endS} step={0.1} min={0}
                    decimals={4}
                    style={{ width: '100%', minWidth: 0, maxWidth: 72 }}
                    onChange={(v) => update(i, { endS: v })} />
                </label>
              </div>
            </div>
          ))}
          <button className="btn"
            disabled={regions.length >= MAX_SKIP_REGIONS}
            onClick={addRegion}
            style={{ padding: '3px 6px', marginTop: 2 }}
            title={regions.length >= MAX_SKIP_REGIONS
              ? `Max ${MAX_SKIP_REGIONS} skip regions`
              : 'Add a new skip region centred in the current view'}>
            + Add region ({regions.length}/{MAX_SKIP_REGIONS})
          </button>
      </>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Filter card (same shape as AP / Burst)
// ---------------------------------------------------------------------------

/** Shared shape for the collapsible-Card props that parent cards
 *  thread through to their internal ``Card`` wrapper. */
type CollapsibleCardProps = {
  collapsible: true
  collapsed: boolean
  onToggle: () => void
}

function FilterCard({
  params, setParams, cardProps,
}: {
  params: EventsParams
  setParams: React.Dispatch<React.SetStateAction<EventsParams>>
  cardProps?: CollapsibleCardProps
}) {
  return (
    <Card title="Pre-detection filter" {...(cardProps ?? {})}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input type="checkbox" checked={params.filterEnabled}
          onChange={(e) => setParams((p) => ({ ...p, filterEnabled: e.target.checked }))} />
        <span style={{ fontWeight: 600 }}>Enable</span>
      </label>
      {params.filterEnabled && (
        <>
          <Row label="Type">
            <select value={params.filterType} style={{ width: '100%' }}
              onChange={(e) => setParams((p) => ({
                ...p, filterType: e.target.value as 'lowpass' | 'highpass' | 'bandpass',
              }))}>
              <option value="bandpass">Bandpass</option>
              <option value="lowpass">Lowpass</option>
              <option value="highpass">Highpass</option>
            </select>
          </Row>
          {(params.filterType === 'highpass' || params.filterType === 'bandpass') && (
            <Row label="Low (Hz)">
              <NumInput value={params.filterLow} step={0.5} min={0}
                onChange={(v) => setParams((p) => ({ ...p, filterLow: v }))} />
            </Row>
          )}
          {(params.filterType === 'lowpass' || params.filterType === 'bandpass') && (
            <Row label="High (Hz)">
              <NumInput value={params.filterHigh} step={10} min={1}
                onChange={(v) => setParams((p) => ({ ...p, filterHigh: v }))} />
            </Row>
          )}
          <Row label="Order">
            <NumInput value={params.filterOrder} step={1} min={1} max={8}
              onChange={(v) => setParams((p) => ({
                ...p, filterOrder: Math.max(1, Math.min(8, Math.round(v))),
              }))} />
          </Row>
        </>
      )}
      {/* Detrend (rolling-median subtraction) — applied BEFORE the
          Butterworth filter. Both can be on at once: detrend handles
          slow drift, filter handles high-frequency noise. */}
      <div style={{
        marginTop: 4, paddingTop: 4,
        borderTop: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title="Subtract a rolling median before detection; flattens slow drift">
          <input type="checkbox" checked={params.detrendEnabled}
            onChange={(e) => setParams((p) => ({ ...p, detrendEnabled: e.target.checked }))} />
          <span>Detrend (rolling median)</span>
        </label>
        {params.detrendEnabled && (
          <Row label="Window (ms)">
            <NumInput value={params.detrendWindowMs} step={50} min={10}
              onChange={(v) => setParams((p) => ({ ...p, detrendWindowMs: v }))} />
          </Row>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Template panel
// ---------------------------------------------------------------------------

/** Miniature SVG preview of a biexponential template, rendered over a
 *  fixed 60 × 18 viewport. Handy for library listings where users
 *  want to pick by shape ("the fast one" / "the slow one") before
 *  looking at coefficients. */
function TemplateThumbnail({
  template, width = 60, height = 18, stroke = 'var(--marker-bounds)',
}: {
  template: EventsTemplate
  width?: number; height?: number; stroke?: string
}) {
  const { b0, b1, tauRiseMs, tauDecayMs, widthMs } = template
  const n = 64
  const ys: number[] = []
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (widthMs / 1000.0)
    const rise = 1 - Math.exp(-t / Math.max(tauRiseMs / 1000, 1e-6))
    const decay = Math.exp(-t / Math.max(tauDecayMs / 1000, 1e-6))
    const y = b0 + b1 * rise * decay
    ys.push(y)
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  if (hi === lo) { hi = lo + 1 }
  const pts = ys.map((y, i) => {
    const x = (i / (n - 1)) * width
    const py = height - ((y - lo) / (hi - lo)) * (height - 2) - 1
    return `${x.toFixed(1)},${py.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={width} height={height}
         style={{ verticalAlign: 'middle', flexShrink: 0 }}>
      <polyline points={pts}
        fill="none" style={{ stroke }} strokeWidth={1.2} />
    </svg>
  )
}

function TemplatePanel({
  templates, activeTemplateId, activeTemplate,
  additionalTemplateIds,
  onPickTemplate,
  onPickAdditional,
  onOpenGenerator, onOpenRefinement,
  canRefine,
  cardProps,
}: {
  templates: Record<string, EventsTemplate>
  activeTemplateId: string | null
  activeTemplate: EventsTemplate | null
  additionalTemplateIds: string[]
  onPickTemplate: (id: string) => void
  /** Set the additional-template slot at ``index`` (0 or 1). Passing
   *  ``null`` clears that slot; the rest shift down to keep the list
   *  compact. */
  onPickAdditional: (index: number, id: string | null) => void
  onOpenGenerator: () => void
  onOpenRefinement: () => void
  canRefine: boolean
  cardProps?: CollapsibleCardProps
}) {
  // Main-window template panel is READ-ONLY: library picker + a
  // compact coefficient readout + buttons to open the dedicated
  // generator / refinement sub-windows. All editing (fit, coefficient
  // tweaks, save-as, delete) lives in the template generator —
  // matches EE's pattern where Generate Template is a separate
  // window from the main Events Analysis panel.
  const libEntries = Object.values(templates)
  const usedIds = new Set(
    [activeTemplateId, ...additionalTemplateIds].filter(Boolean) as string[])
  // Second slot is always visible; third only when the second is set,
  // so users aren't confronted with empty rows they don't need.
  const slot2 = additionalTemplateIds[0] ?? null
  const slot3 = additionalTemplateIds[1] ?? null
  // Color the slot labels with the same palette the events viewer
  // uses to color peak markers — gives the user a direct legend
  // (label = peak fill color) without a separate legend strip. Only
  // shown for the slots actually in use; "Primary" stays colored even
  // alone so single-template runs match if the palette is referenced.
  const labelColor = (i: number) => ({
    color: TEMPLATE_COLORS[i] ?? 'var(--text-muted)',
    fontWeight: 600,
  } as const)
  return (
    <Card title="Template" {...(cardProps ?? {})}>
      <Row label={<span style={labelColor(0)}>● Primary</span>}>
        <select value={activeTemplateId ?? ''} style={{ width: '100%' }}
          onChange={(e) => { if (e.target.value) onPickTemplate(e.target.value) }}>
          <option value="" disabled>— pick —</option>
          {libEntries.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </Row>
      {activeTemplate && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <TemplateThumbnail template={activeTemplate}
            stroke={activeTemplate.direction === 'negative' ? 'var(--marker-detected)' : 'var(--marker-bounds)'} />
          <div className="num" style={{
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-label)',
            lineHeight: 1.5,
          }}>
            τ {activeTemplate.tauRiseMs.toFixed(2)} / {activeTemplate.tauDecayMs.toFixed(1)} ms<br />
            b0 {activeTemplate.b0.toFixed(1)} · b1 {activeTemplate.b1.toFixed(1)}
          </div>
        </div>
      )}
      {/* Additional slots — EE-style 2nd and 3rd templates that get
          merged into detection. Primary template carries the overlay;
          additional ones contribute peaks via pointwise-max (corr) or
          union (deconv). */}
      <Row label={<span style={labelColor(1)}>● + 2nd</span>}>
        <select value={slot2 ?? ''} style={{ width: '100%' }}
          onChange={(e) => onPickAdditional(0, e.target.value || null)}>
          <option value="">— none —</option>
          {libEntries
            .filter((t) => !usedIds.has(t.id) || t.id === slot2)
            .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Row>
      {slot2 && (
        <Row label={<span style={labelColor(2)}>● + 3rd</span>}>
          <select value={slot3 ?? ''} style={{ width: '100%' }}
            onChange={(e) => onPickAdditional(1, e.target.value || null)}>
            <option value="">— none —</option>
            {libEntries
              .filter((t) => !usedIds.has(t.id) || t.id === slot3)
              .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Row>
      )}
      <div style={{
        marginTop: 6, paddingTop: 6,
        borderTop: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <button className="btn btn-primary" onClick={onOpenGenerator}
          style={{ padding: '4px 10px', fontSize: 'var(--font-size-label)' }}>
          Open template generator…
        </button>
        <button className="btn" onClick={onOpenRefinement} disabled={!canRefine}
          style={{ padding: '3px 10px', fontSize: 'var(--font-size-label)' }}
          title={canRefine ? 'Fit a biexp to the average of detected events'
            : 'Run detection first (need ≥ 2 events)'}>
          Open refine template…
        </button>
        {/* Library import/export — JSON round-trip for sharing
            templates between datasets / users. */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn" onClick={() => exportTemplatesJSON(templates)}
            disabled={libEntries.length === 0}
            style={{ flex: 1, padding: '3px 6px', fontSize: 'var(--font-size-label)' }}
            title="Download all library templates as a JSON file">
            Export JSON
          </button>
          <button className="btn" onClick={() => importTemplatesJSON()}
            style={{ flex: 1, padding: '3px 6px', fontSize: 'var(--font-size-label)' }}
            title="Load templates from a JSON file, merging into the library">
            Import JSON
          </button>
        </div>
      </div>
    </Card>
  )
}

/** Download the whole template library as a JSON file. */
function exportTemplatesJSON(entries: Record<string, EventsTemplate>) {
  const payload = {
    format: 'tracer-event-templates',
    version: 1,
    templates: Object.values(entries),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'tracer_event_templates.json'
  a.click()
  URL.revokeObjectURL(url)
}

/** Open a file picker for a JSON template file and merge into the
 *  library. Duplicate IDs are skipped (existing entries win); duplicate
 *  names get a suffix. */
function importTemplatesJSON() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        const items: any[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.templates) ? parsed.templates : []
        const store = useAppStore.getState()
        const existing = store.eventsTemplates.entries
        const existingNames = new Set(Object.values(existing).map((t) => t.name))
        let imported = 0
        for (const raw of items) {
          if (!raw || typeof raw !== 'object') continue
          const id = typeof raw.id === 'string' && raw.id.length > 0
            ? raw.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          if (existing[id]) continue          // don't clobber existing
          let name = typeof raw.name === 'string' ? raw.name : 'Imported template'
          if (existingNames.has(name)) name = `${name} (imported)`
          const t: EventsTemplate = {
            id,
            name,
            b0: Number(raw.b0 ?? 0),
            b1: Number(raw.b1 ?? -30),
            tauRiseMs: Number(raw.tauRiseMs ?? 0.5),
            tauDecayMs: Number(raw.tauDecayMs ?? 5),
            widthMs: Number(raw.widthMs ?? 30),
            direction: raw.direction === 'positive' ? 'positive' : 'negative',
          }
          store.saveEventsTemplate(t)
          existingNames.add(name)
          imported++
        }
        alert(`Imported ${imported} template${imported === 1 ? '' : 's'}.`)
      } catch (e) {
        alert(`Import failed: ${e}`)
      }
    }
    reader.readAsText(f)
  }
  input.click()
}

// ---------------------------------------------------------------------------
// Threshold panel
// ---------------------------------------------------------------------------

function ThresholdPanel({
  params, onParamsChange, cursors, onBringCursorsToView, onComputeRms,
  cardProps,
}: {
  params: EventsParams
  onParamsChange: React.Dispatch<React.SetStateAction<EventsParams>>
  cursors: CursorPositions
  onBringCursorsToView: () => void
  onComputeRms: () => void
  cardProps?: CollapsibleCardProps
}) {
  // For correlation / deconvolution methods only the RMS workflow is
  // meaningful (it feeds Exclusion → Min |amp| (× RMS)). The Mode
  // dropdown and Linear threshold UI are hidden in that case. The
  // ``× RMS`` multiplier on the Threshold card drives the detection
  // *level line* and only matters for the Threshold method, so it's
  // hidden alongside the Linear input.
  const isThresholdMethod = params.method === 'threshold'
  const showLinear = isThresholdMethod && params.thresholdMode === 'linear'
  const showRmsControls = !isThresholdMethod || params.thresholdMode === 'rms'
  return (
    <Card title="Threshold" {...(cardProps ?? {})}>
      {isThresholdMethod && (
        <Row label="Mode">
          <select value={params.thresholdMode} style={{ width: '100%' }}
            onChange={(e) => onParamsChange((p) => ({
              ...p, thresholdMode: e.target.value as 'rms' | 'linear',
            }))}>
            <option value="rms">RMS of quiet region</option>
            <option value="linear">Linear value</option>
          </select>
        </Row>
      )}
      {showRmsControls && (
        <>
          <HelpText>
            {isThresholdMethod
              ? 'Drag the cursor band on the viewer to cover a quiet section, then Compute RMS.'
              : 'Compute RMS over a quiet region; feeds the Exclusion → Min |amp| (× RMS) option below.'}
          </HelpText>
          <div className="num" style={{
            color: CURSOR_COLOR,
            fontSize: 'var(--font-size-label)',
          }}>
            {cursors.baselineStart.toFixed(3)} → {cursors.baselineEnd.toFixed(3)} s
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn" onClick={onBringCursorsToView}
              style={{ flex: 1, padding: '2px 6px', fontSize: 'var(--font-size-label)' }}
              title="Center the cursor band in the middle 20% of the current view">
              Cursors to view
            </button>
            <button className="btn" onClick={onComputeRms}
              style={{ flex: 1, padding: '2px 6px', fontSize: 'var(--font-size-label)' }}>
              Compute RMS
            </button>
          </div>
          {params.rmsValue != null && (
            <HelpText>
              baseline = {params.rmsBaselineMean?.toFixed(3)},{' '}
              RMS = {params.rmsValue.toFixed(3)}
            </HelpText>
          )}
          {isThresholdMethod && (
            <Row label="× RMS">
              <NumInput value={params.rmsMultiplier} step={0.5} min={0.5}
                onChange={(v) => onParamsChange((p) => ({ ...p, rmsMultiplier: v }))} />
            </Row>
          )}
        </>
      )}
      {showLinear && (
        <Row label="Threshold">
          <NumInput value={params.linearThreshold} step={1}
            onChange={(v) => onParamsChange((p) => ({ ...p, linearThreshold: v }))} />
        </Row>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Continuous-sweep viewer with full navigation, cursor bands, and event markers
// ---------------------------------------------------------------------------

function EventsSweepViewer({
  backendUrl, group, series, channel, sweep, entry, params, setParams,
  groupFilter, templateFilter,
  activeTemplate,
  cursors, updateCursors,
  viewport, setViewport, sweepDurationS, setSweepDurationS,
  shiftViewport, goHome, goEnd,
  theme, fontSize, heightSignal,
  onAddEvent, onDiscardEvent,
  zeroOffset, onZeroOffsetChange,
  trainsForSweep,
}: {
  backendUrl: string
  group: number; series: number; channel: number; sweep: number
  entry: EventsData | undefined
  params: EventsParams
  /** Updater for params — needed so skip-region edge / band drags
   *  can write back the new start / end times. */
  setParams: React.Dispatch<React.SetStateAction<EventsParams>>
  /** Visibility filter from the parent — same value drives the
   *  results table / histograms below. Markers for filtered-out
   *  events are simply not drawn (and not hit-tested). */
  groupFilter: GroupFilter
  templateFilter: TemplateFilter
  /** Active biexp template — needed so the viewer can refetch the
   *  detection-measure overlay on viewport / template changes. */
  activeTemplate: EventsTemplate | null
  cursors: CursorPositions
  updateCursors: (next: Partial<CursorPositions>) => void
  viewport: Viewport
  setViewport: SetViewport
  sweepDurationS: number
  setSweepDurationS: React.Dispatch<React.SetStateAction<number>>
  shiftViewport: (factor: number) => void
  goHome: () => void
  goEnd: () => void
  theme: string; fontSize: number
  heightSignal: number
  onAddEvent: (timeS: number) => void
  onDiscardEvent: (idx: number) => void
  /** Zero-offset toggle — when on, the trace fetch passes
   *  ``zero_offset=true`` and the backend subtracts the per-sweep
   *  baseline before returning. Stored in prefs by the parent so
   *  the choice survives across sessions. */
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  /** Trains computed for the currently shown sweep. Drawn as
   *  translucent shaded spans behind the per-event markers; empty
   *  when grouping is off or no clusters qualify. */
  trainsForSweep: TrainSummary[]
}) {
  const themeKey = useThemeKey()
  void theme; void fontSize
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Right-click position in TIME (sweep seconds) — set on the wrapping
  // contextmenu handler before usePlotMenu opens its menu. Used by the
  // dynamic "Open in Event Browser at event #N" item to pick the event
  // nearest the click.
  const lastRightClickTimeRef = useRef<number | null>(null)
  const selectEvent = useAppStore((s) => s.selectEvent)
  const { onContextMenu: onContextMenuMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-sweep',
    getExtraItems: () => {
      const e = entryRef.current
      if (!e || e.events.length === 0) return []
      const t = lastRightClickTimeRef.current
      // Pick the event whose peak is closest to the right-click time.
      // Hit radius is generous (200 ms) — a wider miss falls through to
      // the unanchored "Open Event Browser" entry.
      let nearest = -1
      let bestDt = Infinity
      if (t != null) {
        for (let i = 0; i < e.events.length; i++) {
          const dt = Math.abs(e.events[i].peakTimeS - t)
          if (dt < bestDt) { bestDt = dt; nearest = i }
        }
      }
      const items = []
      if (nearest >= 0 && bestDt < 0.2) {
        items.push({
          label: `Open event #${nearest + 1} in Event Browser`,
          hint: `${(bestDt * 1000).toFixed(0)} ms from click`,
          onClick: () => {
            selectEvent(e.group, e.series, nearest)
            void window.electronAPI?.openAnalysisWindow?.('events_browser')
          },
        })
      }
      items.push({
        label: 'Open Event Browser',
        onClick: () => {
          void window.electronAPI?.openAnalysisWindow?.('events_browser')
        },
      })
      return items
    },
  })
  // Wrapper that captures the right-click time position before
  // delegating to usePlotMenu — getExtraItems reads from the ref.
  const onContextMenu = useCallback((ev: React.MouseEvent) => {
    const u = plotRef.current
    if (u) {
      const rect = ((u as any).over as HTMLDivElement | null)?.getBoundingClientRect()
        ?? (u as any).root?.getBoundingClientRect?.()
      if (rect) {
        const px = ev.clientX - rect.left
        const t = u.posToVal(px, 'x')
        lastRightClickTimeRef.current = isFinite(t) ? t : null
      }
    }
    onContextMenuMenu(ev)
  }, [onContextMenuMenu])
  // Held digit (1–5) tracked window-wide for the EE-style "hold-key
  // + click peak to assign group" gesture. ``0`` means clear group.
  // Stored in a ref so the pointer handler reads current state without
  // re-rendering the plot. Window-level listener so the user doesn't
  // have to focus the plot first to use the shortcut.
  const heldGroupKeyRef = useRef<number | null>(null)
  const setEventGroupAction = useAppStore((s) => s.setEventGroup)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing into form fields — wouldn't want '1' in a
      // NumInput to set a group.
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT'
                || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key >= '0' && e.key <= '5' && !e.repeat) {
        heldGroupKeyRef.current = Number(e.key)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '5'
          && heldGroupKeyRef.current === Number(e.key)) {
        heldGroupKeyRef.current = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])
  const primedDiscardIdxRef = useRef<number | null>(null)
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors
  const entryRef = useRef(entry)
  entryRef.current = entry
  const paramsRef = useRef(params)
  paramsRef.current = params
  // Mirror the per-sweep trains in a ref so the imperative
  // ``drawOverlays`` callback (registered once on plot init) can
  // pick up updated train assignments without a remount.
  const trainsRef = useRef<TrainSummary[]>(trainsForSweep)
  trainsRef.current = trainsForSweep
  // Group filter mirrored into a ref — the draw hook + pointer
  // handler read it inside closures bound to the plot's lifetime.
  const groupFilterRef = useRef(groupFilter)
  groupFilterRef.current = groupFilter
  const templateFilterRef = useRef(templateFilter)
  templateFilterRef.current = templateFilter
  // Zero-offset applied by the backend on the most recent fetch.
  // Stored detection thresholds, the polynomial baseline curve, the
  // RMS amp floor, and the biexp event fits all carry RAW signal
  // y-values, so we subtract this before mapping them to pixels —
  // keeps overlays glued to the visibly-shifted trace. Mirrored into
  // a ref so the draw hook (bound at plot creation) reads the
  // latest value without rebuilding.
  const offsetRef = useRef<number>(0)
  // Route pointer-handler callbacks through refs so changing their
  // identity (e.g. the parent re-creating onAddEvent when `entry`
  // updates) doesn't tear down and rebuild the uPlot instance. Event
  // add/discard is a frequent action in normal use — without this, the
  // whole plot + event listeners get reconstructed on every edit.
  const onAddEventRef = useRef(onAddEvent)
  onAddEventRef.current = onAddEvent
  const onDiscardEventRef = useRef(onDiscardEvent)
  onDiscardEventRef.current = onDiscardEvent
  const setParamsRef = useRef(setParams)
  setParamsRef.current = setParams
  const setViewportRef = useRef(setViewport)
  setViewportRef.current = setViewport
  const updateCursorsRef = useRef(updateCursors)
  updateCursorsRef.current = updateCursors

  const [data, setData] = useState<{
    time: Float64Array; values: Float64Array
    /** DC baseline the backend subtracted when ``zero_offset=true``.
     *  Stored y-values for stored detection thresholds, baseline
     *  curves, and biexp fits are in RAW signal space, so we
     *  subtract this before mapping them to pixels — keeps the
     *  overlays glued to the visibly-shifted trace. */
    zeroOffsetApplied: number
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** Detection-measure overlay (correlation r or filtered
   *  deconvolution) for the current viewport. Fetched on-demand at
   *  full sampling-rate resolution when the user has the "Show
   *  detection measure" toggle on. Drawn as a second uPlot series
   *  with its own right-hand Y axis, NOT a stacked subplot. */
  const [dm, setDm] = useState<import('../../stores/appStore').EventsDetectionMeasure | null>(null)
  const dmRef = useRef(dm)
  dmRef.current = dm
  const fetchDm = useAppStore((s) => s.fetchEventsDetectionMeasure)

  /** Polynomial baseline curve for the current viewport — fetched
   *  when ``params.baselineMethod === 'polynomial'``. Uniform sampling
   *  (dt = 1/sr unless very long sweeps trigger backend decimation)
   *  starting at ``tStartS``. Drawn as a thin line in the same Y axis
   *  as the trace so the user can verify the fit isn't bending into
   *  the events. */
  const [baselineCurve, setBaselineCurve] = useState<{
    values: number[]; dtS: number; tStartS: number
  } | null>(null)
  const baselineCurveRef = useRef(baselineCurve)
  baselineCurveRef.current = baselineCurve

  // Fetch data for the current viewport. Full original sampling rate
  // (max_points=0) — for long viewports uPlot will manage its own
  // rendering decimation, and for zoomed-in windows we get the full
  // temporal resolution needed for accurate event placement.
  //
  // Debounced (~80 ms) so a fast scroll / drag-pan / cursor move doesn't
  // blast the trace endpoint with one fetch per pixel. The cleanup
  // clears any pending timer so the LATEST viewport wins.
  useEffect(() => {
    if (!backendUrl) { setData(null); return }
    let cancelled = false
    const timer = setTimeout(() => {
      const parts: string[] = [
        `group=${group}`, `series=${series}`, `sweep=${sweep}`,
        `trace=${channel}`, `max_points=0`,
      ]
      if (viewport) {
        parts.push(`t_start=${viewport.tStart}`)
        parts.push(`t_end=${viewport.tEnd}`)
      }
      // Pre-detection filter — feed the same params through the traces
      // endpoint so the viewer shows the trace the detector will see.
      if (params.filterEnabled) {
        parts.push(`filter_type=${params.filterType}`)
        parts.push(`filter_low=${params.filterLow}`)
        parts.push(`filter_high=${params.filterHigh}`)
        parts.push(`filter_order=${params.filterOrder}`)
      }
      if (zeroOffset) parts.push('zero_offset=true')
      const url = `${backendUrl}/api/traces/data?${parts.join('&')}`
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          if (cancelled) return
          const n = Number(d.n_samples ?? 0)
          const sr = Number(d.sampling_rate ?? 1)
          const durationS = sr > 0 ? n / sr : Number(d.duration ?? 0)
          if (durationS > 0 && Math.abs(durationS - sweepDurationS) > 1e-3) {
            setSweepDurationS(durationS)
          }
          const off = Number(d.zero_offset ?? 0)
          offsetRef.current = off
          setData({
            time: new Float64Array(d.time ?? []),
            values: new Float64Array(d.values ?? []),
            zeroOffsetApplied: off,
          })
          setErr(null)
        })
        .catch((e) => { if (!cancelled) { setData(null); setErr(String(e)) } })
    }, 80)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [backendUrl, group, series, sweep, channel, viewport,
      params.filterEnabled, params.filterType, params.filterLow,
      params.filterHigh, params.filterOrder, zeroOffset,
      setSweepDurationS, sweepDurationS])

  // Fetch the detection-measure slice for the current viewport at
  // full sampling-rate resolution. Only runs when the toggle is on
  // AND we have a template (deconvolution and correlation both
  // require one). Re-fires on viewport / cutoff / template / filter
  // changes so the overlay always tracks the visible trace.
  // Debounced like the trace fetch above — same goal, same window.
  useEffect(() => {
    if (!params.showDetectionMeasure
        || !params.method.startsWith('template_')
        || !activeTemplate || !viewport) {
      setDm(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const method = params.method as 'template_correlation' | 'template_deconvolution'
      const cutoff = method === 'template_correlation'
        ? params.correlationCutoff
        : params.deconvCutoffSd
      const filterPayload = params.filterEnabled ? {
        enabled: true, type: params.filterType,
        low: params.filterLow, high: params.filterHigh, order: params.filterOrder,
      } : null
      fetchDm(
        group, series, channel, sweep,
        method, activeTemplate, cutoff, params.peakDirection,
        params.deconvLowHz, params.deconvHighHz,
        viewport.tStart, viewport.tEnd,
        filterPayload,
      )
        .then((out) => { if (!cancelled) setDm(out) })
        .catch(() => { if (!cancelled) setDm(null) })
    }, 80)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [
    fetchDm, group, series, channel, sweep,
    viewport,
    params.showDetectionMeasure, params.method,
    params.correlationCutoff, params.deconvCutoffSd,
    params.deconvLowHz, params.deconvHighHz,
    params.peakDirection,
    params.filterEnabled, params.filterType, params.filterLow,
    params.filterHigh, params.filterOrder,
    activeTemplate?.b0, activeTemplate?.b1,
    activeTemplate?.tauRiseMs, activeTemplate?.tauDecayMs,
    activeTemplate?.widthMs,
    activeTemplate,
  ])

  // Fetch the polynomial baseline curve for the current viewport.
  // Backend computes the fit on the WHOLE sweep (so the curve is
  // anchored at edges) and returns the requested slice. Refetches on
  // viewport / order / direction / filter / detrend changes.
  // Debounced like the other viewport-driven fetches above.
  useEffect(() => {
    if (params.baselineMethod !== 'polynomial' || !viewport) {
      setBaselineCurve(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const body = {
        group, series, sweep, trace: channel,
        direction: params.peakDirection,
        poly_order: params.baselinePolyOrder,
        filter_enabled: params.filterEnabled,
        filter_type: params.filterType,
        filter_low: params.filterLow,
        filter_high: params.filterHigh,
        filter_order: params.filterOrder,
        detrend_enabled: params.detrendEnabled,
        detrend_window_ms: params.detrendWindowMs,
        t_start_s: viewport.tStart,
        t_end_s: viewport.tEnd,
      }
      fetch(`${backendUrl}/api/events/baseline_curve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          if (cancelled) return
          setBaselineCurve({
            values: Array.isArray(d.values) ? d.values : [],
            dtS: Number(d.dt_s ?? 1),
            tStartS: Number(d.t_start_s ?? 0),
          })
        })
        .catch(() => { if (!cancelled) setBaselineCurve(null) })
    }, 80)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [backendUrl, group, series, sweep, channel, viewport,
      params.baselineMethod, params.baselinePolyOrder,
      params.peakDirection,
      params.filterEnabled, params.filterType, params.filterLow,
      params.filterHigh, params.filterOrder,
      params.detrendEnabled, params.detrendWindowMs])

  // ---- Overlays drawn inside uPlot's draw hook ----
  const drawOverlays = useCallback((u: uPlot) => {
    const e = entryRef.current
    const p = paramsRef.current
    const c = cursorsRef.current
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1

    // Train spans (drawn first so cursors / skip-bands / per-event
    // markers all sit on top). Each train gets a faint amber band
    // spanning [startS, endS] with a small "T#" label at the upper-
    // left corner — same colour family as the manual-event orange
    // so the user reads "this is a higher-level grouping of the
    // events below." Empty when grouping is off.
    const trains = trainsRef.current
    if (trains.length > 0) {
      const trainColor = cssVar('--marker-manual')
      ctx.save()
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      for (const t of trains) {
        const a = u.valToPos(t.startS, 'x', true)
        const b = u.valToPos(t.endS, 'x', true)
        if (!isFinite(a) || !isFinite(b)) continue
        const lo = Math.min(a, b)
        const w = Math.max(1 * dpr, Math.abs(b - a))
        ctx.fillStyle = trainColor
        ctx.globalAlpha = 0.13
        ctx.fillRect(lo, u.bbox.top, w, u.bbox.height)
        ctx.strokeStyle = trainColor
        ctx.globalAlpha = 0.45
        ctx.lineWidth = 1 * dpr
        ctx.beginPath()
        ctx.moveTo(a, u.bbox.top); ctx.lineTo(a, u.bbox.top + u.bbox.height)
        ctx.moveTo(b, u.bbox.top); ctx.lineTo(b, u.bbox.top + u.bbox.height)
        ctx.stroke()
        ctx.globalAlpha = 0.95
        ctx.fillText(`T${t.id + 1}`, lo + 3 * dpr, u.bbox.top + 12 * dpr)
      }
      ctx.restore()
    }

    // Cursor baseline band — drag-move / drag-edge on pointerdown below.
    {
      const a = u.valToPos(c.baselineStart, 'x', true)
      const b = u.valToPos(c.baselineEnd, 'x', true)
      if (isFinite(a) && isFinite(b)) {
        const cursorColor = cssVar('--cursor-baseline')
        ctx.save()
        ctx.globalAlpha = 0.14
        ctx.fillStyle = cursorColor
        ctx.fillRect(
          Math.min(a, b), u.bbox.top,
          Math.abs(b - a), u.bbox.height,
        )
        ctx.globalAlpha = 0.85
        ctx.strokeStyle = cursorColor
        ctx.lineWidth = 1.5 * dpr
        ctx.beginPath()
        ctx.moveTo(a, u.bbox.top); ctx.lineTo(a, u.bbox.top + u.bbox.height)
        ctx.moveTo(b, u.bbox.top); ctx.lineTo(b, u.bbox.top + u.bbox.height)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.fillStyle = cursorColor
        ctx.font = `600 ${10 * dpr}px ${cssVar('--font-ui')}`
        ctx.fillText('cursors', Math.min(a, b) + 2 * dpr, u.bbox.top + 12 * dpr)
        ctx.restore()
      }
    }

    // Skip-region bands (translucent red). Drawn only for regions the
    // user has enabled; disabled ones are kept as outlined ghosts so
    // the user can still see where they'd fall when toggling. Drag
    // edges / bands like the baseline cursor — see pointer handler.
    const skips = p.skipRegions ?? []
    if (skips.length > 0) {
      for (let i = 0; i < skips.length; i++) {
        const r = skips[i]
        if (r.endS <= r.startS) continue
        const a = u.valToPos(r.startS, 'x', true)
        const b = u.valToPos(r.endS, 'x', true)
        if (!isFinite(a) || !isFinite(b)) continue
        const skipColor = cssVar('--error')
        ctx.save()
        if (r.enabled) {
          ctx.globalAlpha = 0.18
          ctx.fillStyle = skipColor
          ctx.fillRect(
            Math.min(a, b), u.bbox.top,
            Math.abs(b - a), u.bbox.height,
          )
          ctx.globalAlpha = 0.85
          ctx.strokeStyle = skipColor
          ctx.lineWidth = 1.5 * dpr
        } else {
          ctx.globalAlpha = 0.35
          ctx.strokeStyle = skipColor
          ctx.lineWidth = 1 * dpr
          ctx.setLineDash([4 * dpr, 3 * dpr])
        }
        ctx.beginPath()
        ctx.moveTo(a, u.bbox.top); ctx.lineTo(a, u.bbox.top + u.bbox.height)
        ctx.moveTo(b, u.bbox.top); ctx.lineTo(b, u.bbox.top + u.bbox.height)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        ctx.fillStyle = skipColor
        ctx.font = `600 ${10 * dpr}px ${cssVar('--font-ui')}`
        ctx.fillText(`skip ${i + 1}${r.enabled ? '' : ' (off)'}`,
          Math.min(a, b) + 2 * dpr, u.bbox.top + 24 * dpr)
        ctx.restore()
      }
    }

    // Polynomial baseline curve (cyan, thin) — when polynomial mode is
    // active. Drawn as a connected line through the curve samples that
    // fall inside the visible X range. Uses the trace's Y axis since
    // the curve is in the same units as the signal.
    const bc = baselineCurveRef.current
    if (p.baselineMethod === 'polynomial' && bc && bc.values.length > 1) {
      const xMin = u.scales.x.min ?? 0
      const xMax = u.scales.x.max ?? 0
      ctx.save()
      ctx.strokeStyle = cssVar('--cursor-baseline')
      ctx.lineWidth = 1.25 * dpr
      ctx.setLineDash([])
      ctx.beginPath()
      let started = false
      const dt = bc.dtS || 1e-6
      // Sample stride keeps the path cheap on long viewports — at most
      // ~1500 line segments across the visible range, indistinguishable
      // from sample-perfect at typical screen widths.
      const nVisible = Math.max(1,
        Math.ceil((xMax - xMin) / dt))
      const stride = Math.max(1, Math.ceil(nVisible / 1500))
      const yOffset = offsetRef.current
      for (let i = 0; i < bc.values.length; i += stride) {
        const t = bc.tStartS + i * dt
        if (t < xMin) continue
        if (t > xMax) break
        const px = u.valToPos(t, 'x', true)
        const py = u.valToPos(bc.values[i] - yOffset, 'y', true)
        if (!started) {
          ctx.moveTo(px, py); started = true
        } else {
          ctx.lineTo(px, py)
        }
      }
      ctx.stroke()
      ctx.restore()
    }

    // Threshold line (red dashed) for threshold method.
    if (p.method === 'threshold') {
      let threshold: number | null = null
      if (p.thresholdMode === 'linear') {
        threshold = p.linearThreshold
      } else if (p.rmsValue != null) {
        const base = p.rmsBaselineMean ?? 0
        const sign = p.peakDirection === 'negative' ? -1 : 1
        threshold = base + sign * p.rmsMultiplier * p.rmsValue
      }
      if (threshold != null && isFinite(threshold)) {
        const py = u.valToPos(threshold - offsetRef.current, 'y', true)
        ctx.save()
        ctx.strokeStyle = cssVar('--marker-detected')
        ctx.lineWidth = 1 * dpr
        ctx.setLineDash([6 * dpr, 4 * dpr])
        ctx.beginPath()
        ctx.moveTo(u.bbox.left, py)
        ctx.lineTo(u.bbox.left + u.bbox.width, py)
        ctx.stroke()
        ctx.restore()
      }
    }

    // × RMS amplitude floor line (orange dashed) — drawn whenever the
    // user picked × RMS mode for Min |amp|, regardless of detection
    // method. Position is rmsBaselineMean ± n × rmsValue (sign matches
    // the peak direction); shows where events smaller than the floor
    // get rejected post-detection. Skipped silently if RMS hasn't been
    // computed yet (the toggle is a no-op in that state anyway).
    if (p.useRmsAmpFloor && p.rmsValue != null) {
      const base = p.rmsBaselineMean ?? 0
      const sign = p.peakDirection === 'negative' ? -1 : 1
      const floor = base + sign * p.ampFloorRmsMultiplier * Math.abs(p.rmsValue)
      if (isFinite(floor)) {
        const py = u.valToPos(floor - offsetRef.current, 'y', true)
        ctx.save()
        ctx.strokeStyle = cssVar('--warning')
        ctx.lineWidth = 1 * dpr
        ctx.setLineDash([3 * dpr, 3 * dpr])
        ctx.beginPath()
        ctx.moveTo(u.bbox.left, py)
        ctx.lineTo(u.bbox.left + u.bbox.width, py)
        ctx.stroke()
        ctx.restore()
      }
    }

    // Per-event biexp-fit overlay — thin black curves traced from
    // foot → decay endpoint using the stored coefficients. Drawn
    // BEFORE the markers so dots sit cleanly on top. Skipped when
    // toggle is off, when no fit succeeded for the event, or when
    // the density backoff for markers (set further down) would have
    // dropped the dots — at that zoom-out level the fits become a
    // wash anyway.
    if (e && p.showEventFits && e.events.length > 0) {
      const xMin = u.scales.x.min ?? 0
      const xMax = u.scales.x.max ?? 0
      const sr = e.samplingRate || 1
      const gf = groupFilterRef.current
      const tf = templateFilterRef.current
      ctx.save()
      ctx.strokeStyle = cssVar('--text-primary')
      ctx.lineWidth = 1 * dpr
      for (let i = 0; i < e.events.length; i++) {
        const ev = e.events[i]
        if (ev.peakTimeS < xMin) continue
        if (ev.peakTimeS > xMax) break
        if (!passesEventFilters(ev, gf, tf)) continue
        if (ev.biexpB0 == null || ev.biexpB1 == null
            || ev.biexpTauRiseMs == null || ev.biexpTauDecayMs == null
            || ev.decayEndpointIdx == null) continue
        const tau_r = (ev.biexpTauRiseMs as number) / 1000.0
        const tau_d = (ev.biexpTauDecayMs as number) / 1000.0
        if (!(tau_r > 0) || !(tau_d > 0)) continue
        const tStart = ev.footTimeS
        const tEnd = ev.decayEndpointIdx / sr
        const span = tEnd - tStart
        if (span <= 0) continue
        // Sample at the trace's native rate to get a smooth curve
        // without too many segments — capped at ~120 segments per
        // event for cheap drawing.
        const nSamp = Math.min(120, Math.max(8,
          Math.ceil(span * sr)))
        ctx.beginPath()
        for (let s = 0; s <= nSamp; s++) {
          const tt = (s / nSamp) * span
          const rise = 1 - Math.exp(-tt / tau_r)
          const decay = Math.exp(-tt / tau_d)
          const yVal = (ev.biexpB0 as number)
            + (ev.biexpB1 as number) * rise * decay
          const tx = tStart + tt
          if (tx < xMin || tx > xMax) continue
          const px = u.valToPos(tx, 'x', true)
          const py = u.valToPos(yVal - offsetRef.current, 'y', true)
          if (s === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.stroke()
      }
      ctx.restore()
    }

    // Event markers — peak (palette), foot (gray), decay endpoint
    // (purple). Two performance optimisations vs the original loop:
    //
    //   1. Batch by color. Each colour's dots go into ONE Path2D-style
    //      sub-path (beginPath → all arcs → single fill). Reduces a
    //      per-event beginPath/fill (≈ thousands at high event rates)
    //      down to ≤ 6 fills (3 template + manual + default + foot +
    //      endpoint). save/restore is also pulled out of the hot loop.
    //
    //   2. Density backoff. When > 1000 events fall inside the
    //      viewport, draw only the peaks — foot / endpoint / group
    //      digits become indistinguishable at that zoom anyway and
    //      were the main visual cost. Zoom in to recover them.
    //
    //   3. Sorted-time early break. Events are stored in time order;
    //      once we pass xMax the loop terminates.
    if (e && e.events.length > 0) {
      const xMin = u.scales.x.min ?? 0
      const xMax = u.scales.x.max ?? 0
      const sr = e.samplingRate || 1
      const gf = groupFilterRef.current
      const tf = templateFilterRef.current

      // Per-color peak buckets keyed by hex string. We collect screen
      // coordinates once, then issue one fill per bucket below.
      const peakByColor = new Map<string, number[]>() // hex → flat [x, y, x, y, …]
      const footPts: number[] = []
      const decayPts: number[] = []
      const digits: { px: number; py: number; g: number }[] = []
      let selectedXY: [number, number] | null = null
      let primedXY: [number, number] | null = null

      // Quick first pass: count visible-and-passing events to decide
      // density backoff. Sample-stride a count; we don't need exact
      // numbers, just "many vs few".
      let visibleN = 0
      for (let i = 0; i < e.events.length; i++) {
        const ev = e.events[i]
        if (ev.peakTimeS < xMin) continue
        if (ev.peakTimeS > xMax) break
        if (!passesEventFilters(ev, gf, tf)) continue
        visibleN++
        if (visibleN > 1200) break  // we don't need a precise count
      }
      const dense = visibleN > 1000

      const peakR = 4 * dpr
      const dotR = 2.5 * dpr
      const manualColor = cssVar('--marker-manual')
      const detectedColor = cssVar('--marker-detected')

      // Sample the displayed trace (post-filter, post-zero-offset)
      // so markers stay glued to the line whatever the user toggles.
      const tt = u.data[0] as unknown as number[]
      const tv = u.data[1] as unknown as number[]

      for (let i = 0; i < e.events.length; i++) {
        const ev = e.events[i]
        if (ev.peakTimeS < xMin) continue
        if (ev.peakTimeS > xMax) break  // events are time-sorted
        if (!passesEventFilters(ev, gf, tf)) continue

        const peakSampled = sampleTraceYAt(tt, tv, ev.peakTimeS)
        const px = u.valToPos(ev.peakTimeS, 'x', true)
        const py = u.valToPos(peakSampled != null ? peakSampled : ev.peakVal, 'y', true)
        const color = ev.manual
          ? manualColor
          : (ev.templateIdx != null && TEMPLATE_COLORS[ev.templateIdx])
            ? TEMPLATE_COLORS[ev.templateIdx]
            : detectedColor
        let bucket = peakByColor.get(color)
        if (!bucket) { bucket = []; peakByColor.set(color, bucket) }
        bucket.push(px, py)

        if (i === e.selectedIdx) selectedXY = [px, py]
        if (primedDiscardIdxRef.current === i) primedXY = [px, py]

        if (!dense) {
          // Foot — sample displayed trace at footTimeS.
          const footSampled = sampleTraceYAt(tt, tv, ev.footTimeS)
          const fpx = u.valToPos(ev.footTimeS, 'x', true)
          const fpy = u.valToPos(footSampled != null ? footSampled : ev.baselineVal, 'y', true)
          footPts.push(fpx, fpy)
          // Decay endpoint — also pinned to the trace.
          if (ev.decayEndpointIdx != null) {
            const dt = ev.decayEndpointIdx / sr
            const epSampled = sampleTraceYAt(tt, tv, dt)
            const dpx = u.valToPos(dt, 'x', true)
            const dpy = u.valToPos(epSampled != null ? epSampled : ev.baselineVal, 'y', true)
            decayPts.push(dpx, dpy)
          }
          // Group digit
          if (ev.group != null && ev.group >= 1 && ev.group <= 5) {
            digits.push({ px, py, g: ev.group })
          }
        }
      }

      // ---- Now render each batched layer with minimal state churn ----
      // Foot dots (gray) — single path, single fill.
      if (footPts.length) {
        ctx.fillStyle = cssVar('--text-muted')
        ctx.beginPath()
        for (let k = 0; k < footPts.length; k += 2) {
          ctx.moveTo(footPts[k] + dotR, footPts[k + 1])
          ctx.arc(footPts[k], footPts[k + 1], dotR, 0, 2 * Math.PI)
        }
        ctx.fill()
      }
      // Decay endpoints (purple) — single path, single fill.
      if (decayPts.length) {
        ctx.fillStyle = cssVar('--cursor-fit')
        ctx.beginPath()
        for (let k = 0; k < decayPts.length; k += 2) {
          ctx.moveTo(decayPts[k] + dotR, decayPts[k + 1])
          ctx.arc(decayPts[k], decayPts[k + 1], dotR, 0, 2 * Math.PI)
        }
        ctx.fill()
      }
      // Peaks — one beginPath/fill per color bucket.
      for (const [hex, pts] of peakByColor) {
        ctx.fillStyle = hex
        ctx.beginPath()
        for (let k = 0; k < pts.length; k += 2) {
          ctx.moveTo(pts[k] + peakR, pts[k + 1])
          ctx.arc(pts[k], pts[k + 1], peakR, 0, 2 * Math.PI)
        }
        ctx.fill()
      }
      // Group digits — set font/baseline once, fillText each. Color
      // changes per group so we accept that one state change per
      // digit; in practice users usually use 1–2 groups.
      if (digits.length) {
        ctx.save()
        ctx.font = `bold ${11 * dpr}px ${cssVar('--font-mono')}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const sign = paramsRef.current.peakDirection === 'negative' ? 1 : -1
        for (const d of digits) {
          ctx.fillStyle = GROUP_COLORS[d.g - 1] ?? '#cccccc'
          ctx.fillText(String(d.g), d.px, d.py + sign * 8 * dpr)
        }
        ctx.restore()
      }
      // Selected ring (high-contrast) and primed-discard ring (accent)
      // — one event each at most; cheap.
      if (selectedXY) {
        ctx.strokeStyle = cssVar('--text-primary')
        ctx.lineWidth = 1.5 * dpr
        ctx.beginPath()
        ctx.arc(selectedXY[0], selectedXY[1], 5 * dpr, 0, 2 * Math.PI)
        ctx.stroke()
      }
      if (primedXY) {
        ctx.strokeStyle = cssVar('--accent')
        ctx.lineWidth = 2 * dpr
        ctx.beginPath()
        ctx.arc(primedXY[0], primedXY[1], 7 * dpr, 0, 2 * Math.PI)
        ctx.stroke()
      }
    }
  }, [])

  // ---- X-range ref (locked-zoom pattern) ----
  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  // When viewport changes externally, snap x-range to viewport. Keep
  // Y unchanged — the user may have manually zoomed Y and scrolling X
  // should never reset that.
  useEffect(() => {
    if (!viewport) return
    xRangeRef.current = [viewport.tStart, viewport.tEnd]
    const u = plotRef.current
    if (u) {
      u.setScale('x', { min: viewport.tStart, max: viewport.tEnd })
    }
  }, [viewport])
  // Reset Y only when the user explicitly switches sweep / group /
  // series / channel — the trace itself changes and old Y range may
  // be wildly off-scale. (Not when viewport shifts within the same
  // sweep.)
  useEffect(() => {
    yRangeRef.current = null
  }, [group, series, channel, sweep])

  // Manual "Fit Y" recovery — re-fits the y range to the values
  // currently visible inside the active x window. Mirrors the
  // user-facing intent of the "Reset zoom" button in AP / Burst
  // viewers, but Y-only so the user keeps their scrolled / zoomed
  // x viewport. Clearing the ref ensures a subsequent rebuild
  // starts from auto-fit again rather than re-locking to the cached
  // value.
  const fitYNow = useCallback(() => {
    const u = plotRef.current
    if (!u) return
    const xs = u.data[0] as unknown as number[]
    const ys = u.data[1] as unknown as number[]
    if (!xs || !ys || ys.length === 0) return
    const xMin = u.scales.x.min ?? xs[0]
    const xMax = u.scales.x.max ?? xs[xs.length - 1]
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < ys.length; i++) {
      const x = xs[i]
      if (x < xMin || x > xMax) continue
      const v = ys[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    if (!isFinite(mn) || !isFinite(mx) || mn === mx) {
      yRangeRef.current = null
      // Empty / flat view → fall back to uPlot's default auto-scale.
      u.setScale('y', { min: null as any, max: null as any })
      return
    }
    const pad = (mx - mn) * 0.05
    const r: [number, number] = [mn - pad, mx + pad]
    yRangeRef.current = r
    u.setScale('y', { min: r[0], max: r[1] })
  }, [])

  // Build / rebuild plot when data changes.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) {
      const teardown = (plotRef.current as any)._teardownEvents
      if (teardown) teardown()
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!data || data.time.length === 0) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      // Align the detection-measure trace onto the raw trace's X grid
      // so both series share uPlot's single X array. Nearest-neighbor
      // indexing is fast (O(N_trace)) and accurate since the DM's
      // sampling rate is the trace's sampling rate (or strided at a
      // fixed factor) — no real aliasing on resample.
      const dmCurrent = dmRef.current
      let dmAligned: (number | null)[] | null = null
      if (dmCurrent && dmCurrent.values.length > 0) {
        const dmVals = dmCurrent.values
        const dmT0 = dmCurrent.tStartS
        const dmDt = dmCurrent.dtS
        const dmN = dmVals.length
        dmAligned = new Array(data.time.length)
        for (let i = 0; i < data.time.length; i++) {
          const j = Math.round((data.time[i] - dmT0) / dmDt)
          dmAligned[i] = (j >= 0 && j < dmN) ? dmVals[j] : null
        }
      }
      const dmCutoff = dmCurrent?.cutoffLine ?? null
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
              return r
            },
          },
          y: {
            range: (_u, dmin, dmax) => {
              if (yRangeRef.current) return yRangeRef.current
              if (!isFinite(dmin) || !isFinite(dmax) || dmin === dmax) return [0, 1]
              const pad = (dmax - dmin) * 0.05
              const r: [number, number] = [dmin - pad, dmax + pad]
              yRangeRef.current = r
              return r
            },
          },
          // Detection-measure scale (right Y axis) — auto-fits so the
          // DM trace uses the full vertical space, independent of the
          // recording's pA/mV range.
          dm: {
            auto: true,
            range: (_u, dmin, dmax) => {
              const cutoff = dmCutoff
              let lo = isFinite(dmin) ? dmin : 0
              let hi = isFinite(dmax) ? dmax : 1
              if (cutoff != null && isFinite(cutoff)) {
                lo = Math.min(lo, cutoff)
                hi = Math.max(hi, cutoff)
              }
              if (hi <= lo) hi = lo + 1
              const pad = (hi - lo) * 0.05
              return [lo - pad, hi + pad]
            },
          },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          // Right-hand Y axis for the DM series. Only visible when a
          // DM series is present; otherwise uPlot still allocates
          // space so we gate `show: !!dmAligned`.
          ...(dmAligned ? [{
            scale: 'dm',
            side: 1 as const,
            stroke: cssVar('--trace-color-3'),
            grid: { show: false },
            ticks: { stroke: cssVar('--trace-color-3'), width: 1 },
            size: 55,
            label: dmCurrent?.method === 'deconvolution' ? 'deconv' : 'r',
            labelSize: 12,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          }] : []),
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.25 },
          // DM series — only present when dmAligned is populated.
          ...(dmAligned ? [{
            stroke: cssVar('--trace-color-3'),
            width: 1,
            scale: 'dm',
            spanGaps: false,
          }] : []),
        ],
        hooks: {
          draw: [(u) => {
            drawOverlays(u)
            // Draw the DM cutoff as a dashed orange horizontal line
            // on the DM scale so the user can tune the cutoff by eye.
            if (dmAligned && dmCutoff != null) {
              const py = u.valToPos(dmCutoff, 'dm', true)
              if (isFinite(py)) {
                const ctx = u.ctx
                const dpr = devicePixelRatio || 1
                ctx.save()
                ctx.strokeStyle = cssVar('--trace-color-3')
                ctx.lineWidth = 1 * dpr
                ctx.setLineDash([6 * dpr, 4 * dpr])
                ctx.beginPath()
                ctx.moveTo(u.bbox.left, py)
                ctx.lineTo(u.bbox.left + u.bbox.width, py)
                ctx.stroke()
                ctx.restore()
              }
            }
          }],
        },
      }
      const payload: uPlot.AlignedData = dmAligned
        ? [Array.from(data.time), Array.from(data.values), dmAligned as any]
        : [Array.from(data.time), Array.from(data.values)]
      const attachTip = attachHoverCoords(opts)
      plotRef.current = new uPlot(opts, payload, container)
      attachTip(container)

      // Attach pointer handlers on uPlot's over layer.
      //
      // Dispatch priority on pointerdown:
      //   1. Hit on cursor edge   → start cursor-edge drag
      //   2. Hit on cursor band   → start cursor-band drag
      //   3. Hit on event marker  → prime / discard
      //   4. Empty space          → potential click-vs-drag —
      //        if the pointer moves > 3 px before release → pan
      //        if the pointer releases without moving     → add event
      //
      // This matches the BurstSweepViewer pattern: plain drag always
      // pans (no shift modifier needed), plain click adds an event.
      const over = (plotRef.current as any).over as HTMLDivElement
      type Drag =
        | { kind: 'cursor-edge'; edge: 'start' | 'end' }
        | { kind: 'cursor-band'; startPxX: number; startStart: number; startEnd: number }
        | { kind: 'skip-edge'; index: number; edge: 'start' | 'end' }
        | { kind: 'skip-band'; index: number; startPxX: number; startStart: number; startEnd: number }
        | {
            kind: 'maybe-pan'
            startPxX: number; startPxY: number
            xMin: number; xMax: number; yMin: number; yMax: number
            panning: boolean
          }
      let drag: Drag | null = null
      const EDGE_PX = 6
      const DRAG_THRESHOLD_PX = 3

      const pxToX = (px: number) => {
        const u = plotRef.current!
        return u.posToVal(px, 'x')
      }
      const findCursorHit = (pxX: number) => {
        const u = plotRef.current!
        const c = cursorsRef.current
        const aPx = u.valToPos(c.baselineStart, 'x', false)
        const bPx = u.valToPos(c.baselineEnd, 'x', false)
        const [lo, hi] = aPx <= bPx ? [aPx, bPx] : [bPx, aPx]
        if (Math.abs(pxX - aPx) <= EDGE_PX) return { kind: 'cursor-edge' as const, edge: 'start' as const }
        if (Math.abs(pxX - bPx) <= EDGE_PX) return { kind: 'cursor-edge' as const, edge: 'end' as const }
        if (pxX >= lo + EDGE_PX && pxX <= hi - EDGE_PX) {
          return { kind: 'cursor-band' as const }
        }
        return null
      }
      // Hit-test any enabled skip region. Only enabled regions are
      // draggable — disabled ones show as dashed ghosts and ignore
      // pointer events, so toggling a region off doesn't stop you
      // from click-adding events inside it.
      const findSkipHit = (pxX: number) => {
        const u = plotRef.current!
        const skips = paramsRef.current.skipRegions ?? []
        for (let i = 0; i < skips.length; i++) {
          const r = skips[i]
          if (!r.enabled || r.endS <= r.startS) continue
          const aPx = u.valToPos(r.startS, 'x', false)
          const bPx = u.valToPos(r.endS, 'x', false)
          const [lo, hi] = aPx <= bPx ? [aPx, bPx] : [bPx, aPx]
          if (Math.abs(pxX - aPx) <= EDGE_PX) {
            return { kind: 'skip-edge' as const, index: i, edge: 'start' as const }
          }
          if (Math.abs(pxX - bPx) <= EDGE_PX) {
            return { kind: 'skip-edge' as const, index: i, edge: 'end' as const }
          }
          if (pxX >= lo + EDGE_PX && pxX <= hi - EDGE_PX) {
            return { kind: 'skip-band' as const, index: i }
          }
        }
        return null
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (ev.button !== 0) return
        const u = plotRef.current
        if (!u) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top

        // Priority 1: cursor band / edge.
        const ch = findCursorHit(pxX)
        if (ch) {
          if (ch.kind === 'cursor-band') {
            const c = cursorsRef.current
            drag = {
              kind: 'cursor-band',
              startPxX: pxX, startStart: c.baselineStart, startEnd: c.baselineEnd,
            }
            over.style.cursor = 'move'
          } else {
            drag = { kind: 'cursor-edge', edge: ch.edge }
            over.style.cursor = 'ew-resize'
          }
          over.setPointerCapture(ev.pointerId)
          ev.preventDefault()
          return
        }

        // Priority 1b: skip-region band / edge. Checked AFTER baseline
        // cursor so baseline cursor hits always win when both overlap
        // — users reach for the blue band more often.
        const sh = findSkipHit(pxX)
        if (sh) {
          const skips = paramsRef.current.skipRegions ?? []
          const r = skips[sh.index]
          if (sh.kind === 'skip-band') {
            drag = {
              kind: 'skip-band', index: sh.index,
              startPxX: pxX, startStart: r.startS, startEnd: r.endS,
            }
            over.style.cursor = 'move'
          } else {
            drag = { kind: 'skip-edge', index: sh.index, edge: sh.edge }
            over.style.cursor = 'ew-resize'
          }
          over.setPointerCapture(ev.pointerId)
          ev.preventDefault()
          return
        }

        // Priority 2: click near an event marker → prime / discard
        // (no drag state — a plain click toggles prime / confirm).
        const e = entryRef.current
        if (e) {
          let hit = -1
          let hitDist = Infinity
          const gf = groupFilterRef.current
          const tf = templateFilterRef.current
          // Marker y comes from sampling the displayed trace at
          // peakTimeS — same source the overlay uses, so the click
          // target lines up with what the user sees under any
          // filter / zero-offset combination. Falls back to the
          // stored peakVal (offset-shifted) when sampling can't
          // find a value.
          const tt = u.data[0] as unknown as number[]
          const tv = u.data[1] as unknown as number[]
          const yOffset = offsetRef.current
          for (let i = 0; i < e.events.length; i++) {
            const ev0 = e.events[i]
            // Skip hit-tests on filtered-out events — they're not
            // drawn, and clicking through to them would be confusing.
            if (!passesEventFilters(ev0, gf, tf)) continue
            const sampled = sampleTraceYAt(tt, tv, ev0.peakTimeS)
            const yUse = sampled != null ? sampled : (ev0.peakVal - yOffset)
            const mx = u.valToPos(ev0.peakTimeS, 'x', false)
            const my = u.valToPos(yUse, 'y', false)
            const d = Math.hypot(mx - pxX, my - pxY)
            if (d < hitDist && d < 10) { hit = i; hitDist = d }
          }
          if (hit >= 0) {
            // Digit-held → assign group instead of priming discard.
            // 1–5 sets the group; 0 clears it. Matches EE's hotkey
            // tagging flow — fast bulk curation without a context menu.
            const k = heldGroupKeyRef.current
            if (k != null) {
              const g = k === 0 ? null : k
              setEventGroupAction(e.group, e.series, hit, g)
              plotRef.current?.redraw()
              ev.preventDefault()
              return
            }
            if (primedDiscardIdxRef.current === hit) {
              primedDiscardIdxRef.current = null
              onDiscardEventRef.current(hit)
            } else {
              primedDiscardIdxRef.current = hit
              plotRef.current?.redraw()
            }
            ev.preventDefault()
            return
          }
        }

        // Priority 3: empty-space — start click-or-pan state.
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

      // rAF-throttle for cursor-edge / cursor-band drags. Pointer-moves
      // can fire faster than the browser's paint cycle on some setups,
      // and each one triggers a full marker redraw via the cursors
      // useEffect. Coalescing to one update per frame caps the redraw
      // cost regardless of mouse-event rate. The cursor scheduling
      // state captures the LATEST pointer position so the final frame
      // always reflects the user's actual position.
      let cursorRafId: number | null = null
      let pendingCursor: Partial<CursorPositions> | null = null
      const flushCursor = () => {
        cursorRafId = null
        if (pendingCursor) {
          updateCursorsRef.current(pendingCursor)
          pendingCursor = null
        }
      }
      const scheduleCursor = (next: Partial<CursorPositions>) => {
        pendingCursor = next
        if (cursorRafId == null) {
          cursorRafId = requestAnimationFrame(flushCursor)
        }
      }

      const onPointerMove = (ev: PointerEvent) => {
        const u = plotRef.current
        if (!u) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        if (!drag) {
          // Hover-cursor-shape hint: edge→resize, band→move. Check
          // skip regions first so you see the ew-resize cursor when
          // hovering a skip edge (otherwise it'd fall through to no
          // cursor and users wouldn't realise they can drag).
          const sHit = findSkipHit(pxX)
          if (sHit) {
            over.style.cursor = sHit.kind === 'skip-edge' ? 'ew-resize' : 'move'
            return
          }
          const hit = findCursorHit(pxX)
          over.style.cursor = !hit ? '' : (hit.kind === 'cursor-edge' ? 'ew-resize' : 'move')
          return
        }
        if (drag.kind === 'cursor-edge') {
          const x = pxToX(pxX)
          scheduleCursor(drag.edge === 'start'
            ? { baselineStart: x }
            : { baselineEnd: x })
          return
        }
        if (drag.kind === 'cursor-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          scheduleCursor({
            baselineStart: drag.startStart + dx,
            baselineEnd: drag.startEnd + dx,
          })
          return
        }
        if (drag.kind === 'skip-edge') {
          const x = pxToX(pxX)
          const idx = drag.index
          const edge = drag.edge
          setParamsRef.current((p) => {
            const next = [...(p.skipRegions ?? [])]
            if (!next[idx]) return p
            if (edge === 'start') {
              // Prevent start from crossing end — clamp to end-ε.
              next[idx] = { ...next[idx], startS: Math.min(x, next[idx].endS - 1e-4) }
            } else {
              next[idx] = { ...next[idx], endS: Math.max(x, next[idx].startS + 1e-4) }
            }
            return { ...p, skipRegions: next }
          })
          return
        }
        if (drag.kind === 'skip-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          const idx = drag.index
          const ns = drag.startStart + dx
          const ne = drag.startEnd + dx
          setParamsRef.current((p) => {
            const next = [...(p.skipRegions ?? [])]
            if (!next[idx]) return p
            next[idx] = { ...next[idx], startS: ns, endS: ne }
            return { ...p, skipRegions: next }
          })
          return
        }
        if (drag.kind === 'maybe-pan') {
          const dxPx = pxX - drag.startPxX
          const dyPx = pxY - drag.startPxY
          if (!drag.panning
              && Math.abs(dxPx) < DRAG_THRESHOLD_PX
              && Math.abs(dyPx) < DRAG_THRESHOLD_PX) {
            return
          }
          drag.panning = true
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
          setViewportRef.current({ tStart: nx[0], tEnd: nx[1] })
          over.style.cursor = 'grabbing'
          return
        }
      }
      const onPointerUp = (ev: PointerEvent) => {
        if (!drag) return
        // Narrow before reading .panning.
        const clickCandidate = drag.kind === 'maybe-pan' && !drag.panning
        drag = null
        try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        over.style.cursor = ''
        // If the pointer never moved past the threshold, treat as a plain
        // click → add a manual event at the click time.
        if (clickCandidate) {
          const rect = over.getBoundingClientRect()
          const pxX = ev.clientX - rect.left
          const tClick = pxToX(pxX)
          primedDiscardIdxRef.current = null
          if (isFinite(tClick)) onAddEventRef.current(tClick)
        }
      }
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault()
        const u = plotRef.current
        if (!u) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
        if (ev.altKey) {
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (yMin == null || yMax == null) return
          const yAt = u.posToVal(pxY, 'y')
          yRangeRef.current = [yAt - (yAt - yMin) * factor, yAt + (yMax - yAt) * factor]
          u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
        } else {
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          if (xMin == null || xMax == null) return
          const xAt = u.posToVal(pxX, 'x')
          const nMin = xAt - (xAt - xMin) * factor
          const nMax = xAt + (xMax - xAt) * factor
          xRangeRef.current = [nMin, nMax]
          u.setScale('x', { min: nMin, max: nMax })
          setViewportRef.current({ tStart: nMin, tEnd: nMax })
        }
      }

      over.addEventListener('pointerdown', onPointerDown)
      over.addEventListener('pointermove', onPointerMove)
      over.addEventListener('pointerup', onPointerUp)
      over.addEventListener('pointercancel', onPointerUp)
      over.addEventListener('wheel', onWheel, { passive: false })
      ;(plotRef.current as any)._teardownEvents = () => {
        over.removeEventListener('pointerdown', onPointerDown)
        over.removeEventListener('pointermove', onPointerMove)
        over.removeEventListener('pointerup', onPointerUp)
        over.removeEventListener('pointercancel', onPointerUp)
        over.removeEventListener('wheel', onWheel)
        if (cursorRafId != null) {
          cancelAnimationFrame(cursorRafId)
          cursorRafId = null
        }
      }
    })
    return () => cancelAnimationFrame(frame)
    // NOTE: pointer-handler callbacks are routed through refs above so
    // we can leave them out of the deps. Otherwise every state change
    // in the parent that touches `entry` / `params` would re-create
    // the callbacks and force a full uPlot teardown + rebuild — which
    // is what made adding a manual event or scrolling with many markers
    // feel like the whole trace was being recomputed.
  }, [data, dm, drawOverlays, themeKey])

  // ResizeObserver: keep uPlot sized to container.
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
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  // Redraw overlays when cursors / entry / params / baseline curve /
  // trains change. ``trainsForSweep`` flows in via a ref read inside
  // ``drawOverlays``, so a redraw is the only way to refresh the
  // shaded train spans without rebuilding the plot.
  useEffect(() => { plotRef.current?.redraw() },
    [cursors, entry, params, baselineCurve, trainsForSweep])

  return (
    <div ref={rootRef} style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
      position: 'relative',
    }}>
      <ViewportBar
        viewport={viewport}
        sweepDuration={sweepDurationS}
        setViewport={setViewport}
        shiftViewport={shiftViewport}
        goHome={goHome} goEnd={goEnd}
      />
      <div className="viewer-header" style={{
        color: 'var(--text-muted)', flexShrink: 0,
      }}>
        <span>Sweep {sweep + 1}{entry ? ` · ${entry.events.length} events` : ''}</span>
        <button
          className="btn btn-sm"
          onClick={fitYNow}
          title="Re-fit the y range to the trace currently inside the visible x window. Useful after toggling the filter or zero-offset shifts the baseline out of view."
        >
          Fit Y
        </button>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title="Subtract the per-sweep DC baseline server-side, mirroring the AP and Burst windows. Stored detection thresholds, baseline curve, and biexp fits are shifted to match."
        >
          <input
            type="checkbox"
            checked={zeroOffset}
            onChange={(e) => onZeroOffsetChange(e.target.checked)}
            style={{ margin: 0 }}
          />
          <span>Zero offset</span>
        </label>
        <span style={{ marginLeft: 'auto', fontStyle: 'italic', fontSize: 'var(--font-size-xs)' }}>
          Drag empty: pan · click empty: add event · click marker:
          prime / discard · drag cursor band: move · wheel: zoom
        </span>
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{ flex: 1, minHeight: 120, position: 'relative' }}
      >
        {menu}
      </div>
      <ViewportSlider viewport={viewport} sweepDuration={sweepDurationS} setViewport={setViewport} />
      {err && (
        <div className="notice notice-error" style={{
          position: 'absolute', top: 30, left: 10,
          background: 'color-mix(in oklab, var(--error) 12%, var(--bg-field))',
        }}>
          ⚠ Trace load failed: {err}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Summary stats — single-line headline above the table. Mirrors EE's
// "Summary" pane: n events, mean amp ± SD, mean rise / decay / FWHM,
// frequency (Hz), mean IEI. Computed inline from entry.events; updates
// live as the user discards / adds manual events.
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]
  return s / xs.length
}
function sd(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  let s = 0; for (let i = 0; i < xs.length; i++) { const d = xs[i] - m; s += d * d }
  return Math.sqrt(s / (xs.length - 1))
}

function EventsSummaryBar({ entry }: { entry: EventsData | undefined }) {
  if (!entry || entry.events.length === 0) return null
  const amps = entry.events.map((e) => e.amplitude)
  const rises = entry.events.map((e) => e.riseTimeMs).filter((v): v is number => v != null)
  const decays = entry.events.map((e) => e.decayTimeMs).filter((v): v is number => v != null)
  const fwhms = entry.events.map((e) => e.halfWidthMs).filter((v): v is number => v != null)
  const iei: number[] = []
  for (let i = 1; i < entry.events.length; i++) {
    iei.push(entry.events[i].peakTimeS - entry.events[i - 1].peakTimeS)
  }
  // Use totalLengthS for cross-sweep rates — in single-sweep mode it
  // equals sweepLengthS, so there's no behaviour change there.
  const denomS = entry.totalLengthS || entry.sweepLengthS
  const freqHz = denomS > 0 ? entry.events.length / denomS : NaN
  const u = entry.units
  const fmt = (v: number, p = 2) => (Number.isFinite(v) ? v.toFixed(p) : '—')
  const cell: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 1,
    fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)',
    padding: '3px 8px', borderRight: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  }
  const lbl: React.CSSProperties = {
    color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-ui)',
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', flexWrap: 'wrap',
      background: 'var(--bg-primary)',
      borderTop: '1px solid var(--border)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={cell}>
        <span style={lbl}>Events</span>
        <span>{entry.events.length}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>Rate (Hz)</span>
        <span>{fmt(freqHz, 2)}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>Amp ({u})</span>
        <span>{fmt(mean(amps))} ± {fmt(sd(amps))}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>Rise (ms)</span>
        <span>{fmt(mean(rises))} ± {fmt(sd(rises))}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>Decay (ms)</span>
        <span>{fmt(mean(decays))} ± {fmt(sd(decays))}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>FWHM (ms)</span>
        <span>{fmt(mean(fwhms))} ± {fmt(sd(fwhms))}</span>
      </div>
      <div style={{ ...cell, borderRight: 'none' }}>
        <span style={lbl}>IEI (ms)</span>
        <span>{fmt(mean(iei) * 1000, 1)} ± {fmt(sd(iei) * 1000, 1)}</span>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Amplitude histogram — distribution of event amplitudes with a
// Gaussian fit to the bulk. Useful QC for "am I catching the shoulder
// or the noise?". Counts are per-bin; Gaussian and cutoff line drawn
// in overlay. Computed entirely client-side from entry.events.
// ---------------------------------------------------------------------------

function AmplitudeHistogram({
  entry, heightSignal,
  binW, setBinW,
  groupFilter = { kind: 'all' },
  templateFilter = { kind: 'all' },
}: {
  entry: EventsData | undefined
  heightSignal: number
  /** Bin width in amplitude units, lifted to the parent so it
   *  persists across bottom-tab switches and is written to prefs.
   *  ``null`` → auto (√n bins clamped to [8, 40]). */
  binW: number | null
  setBinW: React.Dispatch<React.SetStateAction<number | null>>
  groupFilter?: GroupFilter
  templateFilter?: TemplateFilter
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-amp-hist',
  })

  const stats = useMemo(() => {
    if (!entry || entry.events.length < 5) return null
    const amps = entry.events
      .filter((e) => passesEventFilters(e, groupFilter, templateFilter))
      .map((e) => e.amplitude)
    if (amps.length < 5) return null
    const n = amps.length
    const m = mean(amps)
    const s = sd(amps) || 1
    const lo = Math.min(...amps), hi = Math.max(...amps)
    const pad = (hi - lo) * 0.05 || 1
    const minE = lo - pad, maxE = hi + pad
    const autoBins = Math.max(8, Math.min(40, Math.round(Math.sqrt(n))))
    const autoBw = (maxE - minE) / autoBins
    const bw = binW && binW > 0 ? binW : autoBw
    const nBins = Math.max(1, Math.ceil((maxE - minE) / bw))
    const counts = new Array<number>(nBins).fill(0)
    for (const a of amps) {
      const k = Math.max(0, Math.min(nBins - 1, Math.floor((a - minE) / bw)))
      counts[k]++
    }
    const centers = new Array<number>(nBins)
    for (let i = 0; i < nBins; i++) centers[i] = minE + (i + 0.5) * bw
    // Gaussian curve — not re-fit; just plot N(μ,σ) scaled to max count.
    const peakCount = Math.max(...counts) || 1
    const gauss = centers.map((x) =>
      peakCount * Math.exp(-0.5 * ((x - m) / s) ** 2))
    return { centers, counts, gauss, mean: m, sd: s, n, bw, autoBw }
  }, [entry, binW, groupFilter, templateFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!stats) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      // Bars via uPlot paths: use a "bars" pattern by drawing line from
      // bar-top to zero with wide width. Simpler: custom draw hook.
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: { time: false },
          y: { range: (_u, _dmin, dmax) => [0, Math.max(1, dmax * 1.1)] },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: `Amplitude (${entry?.units ?? ''})`, labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 50,
            label: 'count',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.5 },
        ],
        hooks: {
          draw: [(u) => {
            // Draw bars under the line.
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            const bw = stats.centers.length > 1
              ? stats.centers[1] - stats.centers[0] : 1
            ctx.save()
            ctx.fillStyle = cssVar('--trace-color-1')
            ctx.globalAlpha = 0.35
            for (let i = 0; i < stats.centers.length; i++) {
              const x0 = u.valToPos(stats.centers[i] - bw / 2, 'x', true)
              const x1 = u.valToPos(stats.centers[i] + bw / 2, 'x', true)
              const y0 = u.valToPos(0, 'y', true)
              const y1 = u.valToPos(stats.counts[i], 'y', true)
              ctx.fillRect(Math.min(x0, x1), y1, Math.abs(x1 - x0), y0 - y1)
            }
            // Vertical line at mean.
            const mx = u.valToPos(stats.mean, 'x', true)
            ctx.globalAlpha = 1
            ctx.strokeStyle = cssVar('--trace-average')
            ctx.lineWidth = 1.5 * dpr
            ctx.setLineDash([4 * dpr, 3 * dpr])
            ctx.beginPath()
            ctx.moveTo(mx, u.bbox.top)
            ctx.lineTo(mx, u.bbox.top + u.bbox.height)
            ctx.stroke()
            ctx.restore()
          }],
        },
      }
      const data: uPlot.AlignedData = [stats.centers, stats.gauss]
      plotRef.current = new uPlot(opts, data, container)
    })
    return () => cancelAnimationFrame(frame)
  }, [stats, entry?.units, themeKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      minHeight: 0, gap: 6, padding: 6,
    }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        {/* Bin width — selectable like the IEI histogram. Unit is the
            amplitude unit (pA in VC, mV in CC); value 0 resets to the
            auto sqrt-N binning. */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>
            Bin ({entry?.units ?? ''})
          </span>
          <NumInput value={binW ?? 0} step={0.5} min={0}
            decimals={3}
            style={{ width: 72 }}
            onChange={(v) => setBinW(v <= 0 ? null : v)} />
          {binW == null && (
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              (auto)
            </span>
          )}
        </label>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {stats
            ? (
              <>
                n = {stats.n} · μ = {stats.mean.toFixed(2)} {entry?.units}
                {' · '}σ = {stats.sd.toFixed(2)} {entry?.units}
              </>
            )
            : <span style={{ color: 'var(--text-muted)' }}>Need ≥ 5 events.</span>}
        </span>
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{
          flex: 1, minHeight: 0,
          border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--bg-primary)', position: 'relative',
        }}
      >
        {menu}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Event rate plot — histogram of event peak times in N bins across
// the sweep duration, reported in Hz. Useful for detecting wash-in /
// wash-out effects over a recording. Bin width is user-adjustable.
// ---------------------------------------------------------------------------

function EventRatePlot({
  entry, heightSignal,
  binS, setBinS,
  groupFilter = { kind: 'all' },
  templateFilter = { kind: 'all' },
}: {
  entry: EventsData | undefined
  heightSignal: number
  /** Bin width in seconds, lifted to parent for prefs persistence. */
  binS: number
  setBinS: React.Dispatch<React.SetStateAction<number>>
  groupFilter?: GroupFilter
  templateFilter?: TemplateFilter
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-rate',
  })

  const stats = useMemo(() => {
    if (!entry || entry.events.length === 0 || entry.sweepLengthS <= 0) return null
    const T = entry.sweepLengthS
    const n = Math.max(1, Math.ceil(T / binS))
    const counts = new Array<number>(n).fill(0)
    for (const e of entry.events) {
      if (!passesEventFilters(e, groupFilter, templateFilter)) continue
      const k = Math.max(0, Math.min(n - 1, Math.floor(e.peakTimeS / binS)))
      counts[k]++
    }
    const centers = new Array<number>(n)
    const rates = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      centers[i] = (i + 0.5) * binS
      rates[i] = counts[i] / binS  // Hz
    }
    return { centers, rates }
  }, [entry, binS, groupFilter, templateFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!stats) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: { time: false },
          y: { range: (_u, _dmin, dmax) => [0, Math.max(1, dmax * 1.1)] },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 50, label: 'Rate (Hz)',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [{}, { stroke: cssVar('--trace-color-1'), width: 1.5 }],
        hooks: {
          draw: [(u) => {
            // Bars: cleaner PSTH look than a line.
            const ctx = u.ctx
            const bw = stats.centers.length > 1
              ? stats.centers[1] - stats.centers[0] : binS
            ctx.save()
            ctx.fillStyle = cssVar('--trace-color-1')
            ctx.globalAlpha = 0.35
            for (let i = 0; i < stats.centers.length; i++) {
              const x0 = u.valToPos(stats.centers[i] - bw / 2, 'x', true)
              const x1 = u.valToPos(stats.centers[i] + bw / 2, 'x', true)
              const y0 = u.valToPos(0, 'y', true)
              const y1 = u.valToPos(stats.rates[i], 'y', true)
              ctx.fillRect(Math.min(x0, x1), y1, Math.abs(x1 - x0), y0 - y1)
            }
            ctx.restore()
          }],
        },
      }
      const payload: uPlot.AlignedData = [stats.centers, stats.rates]
      plotRef.current = new uPlot(opts, payload, container)
    })
    return () => cancelAnimationFrame(frame)
  }, [stats, binS, themeKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, padding: 6, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Bin (s)</span>
          <NumInput value={binS} step={1} min={0.5} onChange={setBinS} />
        </label>
        {stats && (
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {stats.centers.length} bins
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{
          flex: 1, minHeight: 0,
          border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--bg-primary)', position: 'relative',
        }}
      >
        {menu}
        {(!entry || entry.events.length === 0) && (
          <div style={{
            padding: 16, textAlign: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)',
          }}>
            Run detection to see the event rate vs time.
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Amplitude-vs-time scatter — one dot per event, x = peak time, y =
// amplitude. Reveals rundown / washout / drug effects at a glance.
// ---------------------------------------------------------------------------

function AmpVsTimeScatter({
  entry, heightSignal,
  groupFilter = { kind: 'all' },
  templateFilter = { kind: 'all' },
}: {
  entry: EventsData | undefined
  heightSignal: number
  groupFilter?: GroupFilter
  templateFilter?: TemplateFilter
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-amp-vs-time',
  })

  const data = useMemo(() => {
    if (!entry || entry.events.length === 0) return null
    const xs: number[] = []
    const ys: number[] = []
    for (const e of entry.events) {
      if (!passesEventFilters(e, groupFilter, templateFilter)) continue
      xs.push(e.peakTimeS)
      ys.push(e.amplitude)
    }
    if (xs.length === 0) return null
    return { xs, ys }
  }, [entry, groupFilter, templateFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: { x: { time: false }, y: { auto: true } },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55, label: `Amplitude (${entry?.units ?? ''})`,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        // No connecting line — draw dots directly in hooks.draw.
        series: [{}, { points: { show: false }, stroke: 'rgba(0,0,0,0)' }],
        hooks: {
          draw: [(u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            ctx.save()
            ctx.fillStyle = cssVar('--trace-color-1')
            ctx.globalAlpha = 0.7
            for (let i = 0; i < data.xs.length; i++) {
              const px = u.valToPos(data.xs[i], 'x', true)
              const py = u.valToPos(data.ys[i], 'y', true)
              if (!isFinite(px) || !isFinite(py)) continue
              ctx.beginPath()
              ctx.arc(px, py, 2.5 * dpr, 0, 2 * Math.PI)
              ctx.fill()
            }
            ctx.restore()
          }],
        },
      }
      plotRef.current = new uPlot(opts, [data.xs, data.ys], container)
    })
    return () => cancelAnimationFrame(frame)
  }, [data, entry?.units, themeKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, padding: 6, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        {data
          ? <span className="num">n = {data.xs.length}</span>
          : <span style={{ color: 'var(--text-muted)' }}>Run detection first.</span>}
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{
          flex: 1, minHeight: 0,
          border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--bg-primary)', position: 'relative',
        }}
      >
        {menu}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// IEI histogram — distribution of inter-event intervals (ms). Bimodal
// distributions or long-tail shapes reveal bursting / refractory
// effects that mean rate alone can't show.
// ---------------------------------------------------------------------------

function IEIHistogram({
  entry, heightSignal,
  binMs, setBinMs,
  groupFilter = { kind: 'all' },
  templateFilter = { kind: 'all' },
}: {
  entry: EventsData | undefined
  heightSignal: number
  /** Bin width in ms, lifted to parent for prefs persistence.
   *  ``null`` → auto (sqrt-N binning). */
  binMs: number | null
  setBinMs: React.Dispatch<React.SetStateAction<number | null>>
  groupFilter?: GroupFilter
  templateFilter?: TemplateFilter
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-iei',
  })

  const stats = useMemo(() => {
    if (!entry || entry.events.length < 2) return null
    // Filter first, THEN compute IEIs across the filtered subset —
    // intervals across hidden events would mix groups and undermine
    // the whole point of the filter.
    const filtered = entry.events.filter(
      (e) => passesEventFilters(e, groupFilter, templateFilter))
    if (filtered.length < 2) return null
    const iei: number[] = []
    for (let i = 1; i < filtered.length; i++) {
      iei.push((filtered[i].peakTimeS - filtered[i - 1].peakTimeS) * 1000)
    }
    if (iei.length === 0) return null
    const lo = 0
    const hi = Math.max(...iei) * 1.05
    const n = iei.length
    // Freedman–Diaconis would be nicer; √n is close enough for a
    // quick-look tab and doesn't need sorting.
    const nBins = Math.max(8, Math.min(60, Math.round(Math.sqrt(n))))
    const autoBw = (hi - lo) / nBins
    const bw = binMs && binMs > 0 ? binMs : autoBw
    const nBinsFinal = Math.max(1, Math.ceil((hi - lo) / bw))
    const counts = new Array<number>(nBinsFinal).fill(0)
    for (const v of iei) {
      const k = Math.max(0, Math.min(nBinsFinal - 1, Math.floor((v - lo) / bw)))
      counts[k]++
    }
    const centers = new Array<number>(nBinsFinal)
    for (let i = 0; i < nBinsFinal; i++) centers[i] = lo + (i + 0.5) * bw
    const meanIei = iei.reduce((s, v) => s + v, 0) / iei.length
    return { centers, counts, bw, n, meanIei }
  }, [entry, binMs, groupFilter, templateFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!stats) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: { time: false },
          y: { range: (_u, _dmin, dmax) => [0, Math.max(1, dmax * 1.1)] },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'IEI (ms)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 50, label: 'count',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [{}, { points: { show: false }, stroke: 'rgba(0,0,0,0)' }],
        hooks: {
          draw: [(u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            ctx.save()
            ctx.fillStyle = cssVar('--trace-color-1')
            ctx.globalAlpha = 0.4
            for (let i = 0; i < stats.centers.length; i++) {
              const x0 = u.valToPos(stats.centers[i] - stats.bw / 2, 'x', true)
              const x1 = u.valToPos(stats.centers[i] + stats.bw / 2, 'x', true)
              const y0 = u.valToPos(0, 'y', true)
              const y1 = u.valToPos(stats.counts[i], 'y', true)
              ctx.fillRect(Math.min(x0, x1), y1, Math.abs(x1 - x0), y0 - y1)
            }
            // Vertical line at the mean IEI — quick anchor for
            // comparing against 1 / rate.
            const mx = u.valToPos(stats.meanIei, 'x', true)
            ctx.globalAlpha = 1
            ctx.strokeStyle = cssVar('--trace-average')
            ctx.lineWidth = 1.5 * dpr
            ctx.setLineDash([4 * dpr, 3 * dpr])
            ctx.beginPath()
            ctx.moveTo(mx, u.bbox.top)
            ctx.lineTo(mx, u.bbox.top + u.bbox.height)
            ctx.stroke()
            ctx.restore()
          }],
        },
      }
      plotRef.current = new uPlot(opts, [stats.centers, stats.counts], container)
    })
    return () => cancelAnimationFrame(frame)
  }, [stats, themeKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, padding: 6, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Bin (ms)</span>
          <NumInput value={binMs ?? 0} step={5} min={0}
            onChange={(v) => setBinMs(v <= 0 ? null : v)} />
          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {binMs == null ? '(auto)' : ''}
          </span>
        </label>
        {stats && (
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            n = {stats.n} · mean = {stats.meanIei.toFixed(1)} ms
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{
          flex: 1, minHeight: 0,
          border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--bg-primary)', position: 'relative',
        }}
      >
        {menu}
        {(!entry || entry.events.length < 2) && (
          <div style={{
            padding: 16, textAlign: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)',
          }}>
            Need ≥ 2 events to form intervals.
          </div>
        )}
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

function EventsResultsTable({
  entry,
  groupFilter = { kind: 'all' },
  templateFilter = { kind: 'all' },
  onSelect, onDiscard,
  trainIdByIdx,
}: {
  entry: EventsData | undefined
  groupFilter?: GroupFilter
  templateFilter?: TemplateFilter
  onSelect: (idx: number) => void
  onDiscard: (idx: number) => void
  /** Per-event train assignment (same length + order as
   *  ``entry.events``). ``null`` = isolated; integer = global train
   *  id. When omitted or all-null the Train column is hidden so
   *  users without grouping enabled don't see an empty column. */
  trainIdByIdx?: (number | null)[] | null
}) {
  // Multi-row selection — click / shift-click for range / cmd-or-ctrl
  // -click for toggle. Right-click brings up the Copy-as-TSV menu;
  // selection survives across re-renders, drops on row-count shrink.
  const events = entry?.events ?? []
  const sel = useRowSelection(events.length)
  // Cross-sweep detection → show a Sweep column so rows are
  // unambiguously placed. Single-sweep skips the column to keep the
  // table compact.
  const multiSweep = (entry?.sweepsAnalysed?.length ?? 1) > 1
  // Show a Template column only when multi-template detection (or
  // mixed manual + auto) actually produced a non-null tag — otherwise
  // it's a wasted column for single-template / threshold runs.
  const showTplCol = !!entry && entry.events.some(
    (e) => e.templateIdx != null || e.manual)
  const showTrainCol = !!trainIdByIdx && trainIdByIdx.some((v) => v != null)
  const unit = entry?.units ?? ''
  const headers = [
    '#',
    ...(multiSweep ? ['Sweep'] : []),
    ...(showTplCol ? ['Tpl'] : []),
    'Time (s)', `Amp (${unit})`, 'Rise (ms)', 'Decay (ms)',
    'τ rise (ms)', 'τ decay (ms)',
    'FWHM (ms)', `AUC (${unit}·s)`, 'IEI (ms)',
    ...(showTrainCol ? ['Train'] : []),
    '',
  ]
  // TSV header drops the trailing empty (the discard-button column)
  // and the Tpl column is collapsed to the integer template index
  // so spreadsheets can sort cleanly.
  const tsvHeaders = headers.slice(0, -1)
  const rowToCells = (i: number): Array<string | number | null> => {
    const e = entry!.events[i]
    const prev = i === 0 ? null : entry!.events[i - 1]
    const iei = prev && (!multiSweep || prev.sweep === e.sweep)
      ? (e.peakTimeS - prev.peakTimeS) * 1000
      : null
    const cells: Array<string | number | null> = [
      i + 1 + (e.manual ? ' *' : ''),
    ]
    if (multiSweep) cells.push(e.sweep + 1)
    if (showTplCol) {
      cells.push(e.manual ? 'M'
        : e.templateIdx != null ? `T${e.templateIdx + 1}` : '')
    }
    cells.push(
      e.peakTimeS.toFixed(4),
      e.amplitude.toFixed(4),
      e.riseTimeMs ?? null,
      e.decayTimeMs ?? null,
      e.biexpTauRiseMs ?? null,
      e.decayTauMs ?? null,
      e.halfWidthMs ?? null,
      e.auc ?? null,
      iei == null ? null : iei.toFixed(2),
    )
    if (showTrainCol) {
      const tid = trainIdByIdx?.[i]
      cells.push(tid != null ? `T${tid + 1}` : '')
    }
    return cells
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => {
      if (!entry || sel.selectedIndexes.length === 0) return null
      return buildTSV(tsvHeaders, sel.selectedIndexes.map(rowToCells))
    },
  })
  // All hooks above this line — early return is now safe.
  if (!entry || entry.events.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry
          ? 'No events detected. Try lowering the cutoff / amplitude threshold.'
          : 'Run detection to populate the events table.'}
      </div>
    )
  }
  return (
    <>
    <table className="data-table num">
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th key={i} style={{ fontFamily: 'var(--font-ui)' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entry.events.map((e: EventRow, i: number) => {
          // Group + template filters — keeps original index `i` so
          // click handlers (select / discard) reach the right event
          // row even though we visually skip filtered-out rows.
          if (!passesEventFilters(e, groupFilter, templateFilter)) return null
          // IEI only meaningful within the same sweep — don't span
          // the sweep boundary in multi-sweep mode.
          const prev = i === 0 ? null : entry.events[i - 1]
          const iei = prev && (!multiSweep || prev.sweep === e.sweep)
            ? (e.peakTimeS - prev.peakTimeS) * 1000
            : null
          return (
            <tr key={i}
              onClick={(ev) => {
                sel.onRowClick(i, ev)
                // Plain click also "selects" the event for the
                // viewer (zooms to + highlights peak). Skip the
                // viewer side-effect on multi-select gestures —
                // user is curating a range, not navigating.
                if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
                  onSelect(i)
                }
              }}
              onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                if (!sel.isSelected(i)) sel.setSelected([i])
              })}
              style={{
                background: sel.isSelected(i)
                  ? 'var(--accent-muted)'
                  : i === entry.selectedIdx
                    ? 'var(--bg-selected)'
                    : (i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)'),
                fontStyle: e.manual ? 'italic' : 'normal',
              }}>
              <td style={td}>{i + 1}{e.manual ? ' *' : ''}</td>
              {multiSweep && <td style={td}>{e.sweep + 1}</td>}
              {showTplCol && (
                <td style={td}>
                  {e.manual ? (
                    <span style={{ color: 'var(--marker-manual)', fontWeight: 600 }}>M</span>
                  ) : e.templateIdx != null && TEMPLATE_COLORS[e.templateIdx] ? (
                    <span style={{
                      color: TEMPLATE_COLORS[e.templateIdx],
                      fontWeight: 600,
                    }}>T{e.templateIdx + 1}</span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                  )}
                </td>
              )}
              <td style={td}>{e.peakTimeS.toFixed(4)}</td>
              <td style={td}>{e.amplitude.toFixed(2)}</td>
              <td style={td}>{e.riseTimeMs != null ? e.riseTimeMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.decayTimeMs != null ? e.decayTimeMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.biexpTauRiseMs != null ? e.biexpTauRiseMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.decayTauMs != null ? e.decayTauMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.halfWidthMs != null ? e.halfWidthMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.auc != null ? e.auc.toFixed(4) : '—'}</td>
              <td style={td}>{iei != null ? iei.toFixed(1) : '—'}</td>
              {showTrainCol && (
                <td style={td}>
                  {trainIdByIdx?.[i] != null
                    ? <span style={{ color: 'var(--marker-manual)' }}>T{(trainIdByIdx![i] as number) + 1}</span>
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
              )}
              <td style={{ ...td, textAlign: 'right' }}>
                <button className="btn btn-sm" onClick={(ev) => { ev.stopPropagation(); onDiscard(i) }}
                  style={{ padding: '0 6px' }}
                  title="Remove this event from the results">
                  ✕
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
      </table>
      {copyMenu.menu}
    </>
  )
}

const td: React.CSSProperties = {
  padding: '2px 8px',
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportEventsCSV(
  entry: EventsData | undefined,
  fileName: string,
  trainIdByIdx?: (number | null)[] | null,
) {
  if (!entry || entry.events.length === 0) return
  const unit = entry.units
  const header = [
    '#', 'Sweep', 'Time_s', 'Foot_time_s',
    `Peak_${unit}`, `Baseline_${unit}`, `Amplitude_${unit}`,
    'Rise_ms', 'Decay_ms',
    'BiexpTauRise_ms', 'BiexpTauDecay_ms', 'Biexp_b0', 'Biexp_b1',
    'DecayTau_ms', 'FWHM_ms', `AUC_${unit}·s`,
    'IEI_ms',
    'Manual',
    'Train_id',
  ]
  const rows = entry.events.map((e, i) => {
    const iei = i === 0
      ? ''
      : ((e.peakTimeS - entry.events[i - 1].peakTimeS) * 1000).toFixed(3)
    const tid = trainIdByIdx?.[i]
    return [
      i + 1, e.sweep,
      e.peakTimeS.toFixed(6), e.footTimeS.toFixed(6),
      e.peakVal.toFixed(4), e.baselineVal.toFixed(4), e.amplitude.toFixed(4),
      e.riseTimeMs ?? '', e.decayTimeMs ?? '',
      e.biexpTauRiseMs ?? '', e.biexpTauDecayMs ?? '',
      e.biexpB0 ?? '', e.biexpB1 ?? '',
      e.decayTauMs ?? '', e.halfWidthMs ?? '',
      e.auc ?? '',
      iei,
      e.manual ? 1 : 0,
      tid != null ? tid + 1 : '',
    ]
  })
  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n')
  const name = fileName.replace(/\.[^.]+$/, '') + '_events.csv'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Trains tab + per-train CSV export
// ---------------------------------------------------------------------------

function EventTrainsTab({
  trains, enabled, onExport,
}: {
  trains: Array<TrainSummary & { sweep: number }>
  enabled: boolean
  onExport: () => void
}) {
  const sel = useRowSelection(trains.length)
  const headers = ['Train', 'Sweep', 'Start (s)', 'End (s)', 'Dur (ms)',
    'n events', 'Mean IEI (ms)', 'Intra freq (Hz)']
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
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Train grouping is off. Enable it in the sidebar's "Group into trains"
        section to cluster closely-spaced events.
      </div>
    )
  }
  if (trains.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
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
      height: '100%', display: 'flex', flexDirection: 'column',
      minHeight: 0, gap: 4,
    }}>
      <div style={{
        flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 6px',
        fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
      }}>
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>
            {trains.length}
          </strong> trains
        </span>
        <button className="btn btn-sm"
          onClick={onExport}
          style={{ marginLeft: 'auto' }}
          title="Export per-train summary to CSV">
          Export trains CSV
        </button>
      </div>
      <div style={{
        flex: 1, overflow: 'auto',
        border: '1px solid var(--border)', borderRadius: 4,
      }}>
        <table className="data-table num">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} style={{ fontFamily: 'var(--font-ui)' }}>{h}</th>
              ))}
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
                    : (i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)'),
                }}>
                <td style={td}><span style={{ color: 'var(--marker-manual)' }}>T{t.id + 1}</span></td>
                <td style={td}>{t.sweep + 1}</td>
                <td style={td}>{t.startS.toFixed(4)}</td>
                <td style={td}>{t.endS.toFixed(4)}</td>
                <td style={td}>{t.durationMs.toFixed(2)}</td>
                <td style={td}>{t.nEvents}</td>
                <td style={td}>{t.meanIeiMs != null ? t.meanIeiMs.toFixed(2) : '—'}</td>
                <td style={td}>{t.intraFreqHz != null ? t.intraFreqHz.toFixed(2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {copyMenu.menu}
      </div>
    </div>
  )
}

function exportEventTrainsCSV(
  trains: Array<TrainSummary & { sweep: number }>,
  cfg: TrainParams & { enabled?: boolean },
  fileName: string,
  group: number,
  series: number,
) {
  if (trains.length === 0) return
  const header = [
    'file', 'group', 'series', 'sweep_index', 'train_id',
    'start_s', 'end_s', 'duration_ms', 'n_events',
    'mean_iei_ms', 'intra_freq_hz',
    'metric', 'max_iei_ms', 'min_count',
    'min_duration_ms', 'min_inter_train_ms',
    'first_event_idx', 'last_event_idx',
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
  const name = fileName.replace(/\.[^.]+$/, '') + '_event_trains.csv'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
