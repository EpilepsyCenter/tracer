import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  EventsData, EventRow,
} from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { usePlotMenu } from '../common/PlotMenu'

/**
 * Events — Browser & Overlay window.
 *
 * Separate Electron window that owns the two heavier event-analysis
 * views (per-event browser + all-events overlay). Tied to the main
 * Event Detection window via the same ``eventsWindowSession`` prefs
 * slot + BroadcastChannel that the Template Refine window uses, so
 * navigating in the main window (e.g. switching series) updates which
 * analysis entry this window browses.
 *
 * Why a separate window: these views are big — the overlay stacks
 * every event, the browser keeps its own sub-trace plot alive per
 * selection — and users want to keep them on a second monitor beside
 * the main trace + results. Matches EE's detachable panels.
 *
 * Both plots support:
 *   - Scroll wheel to zoom X (Alt+wheel zooms Y)
 *   - Drag to pan
 *   - Double-click to reset to auto-range
 *
 * The browser tab honours the pre-detection filter (with a toggle so
 * users can A/B raw vs filtered), and draws peak / foot / decay
 * markers plus the rise 20/80 crossings and the half-amplitude bar —
 * the same set EE shows on page 29 of the manual.
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

export function EventsBrowserWindow({
  backendUrl, fileInfo,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
}) {
  void fileInfo
  const eventsAnalyses = useAppStore((s) => s.eventsAnalyses)
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)
  void theme; void fontSize

  // Follow the main events window's (group, series) via the shared
  // prefs snapshot + live broadcast. Same pattern as the Refinement
  // window — no backend round-trips, all cross-window sync goes
  // through BroadcastChannel messages.
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  useEffect(() => {
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const s = prefs?.eventsWindowSession
        if (s && typeof s.group === 'number' && typeof s.series === 'number') {
          setSessionKey(`${s.group}:${s.series}`)
        }
      } catch { /* ignore */ }
    })()
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'events-session-update' && ev.data.eventsWindowSession) {
          const s = ev.data.eventsWindowSession
          if (typeof s.group === 'number' && typeof s.series === 'number') {
            setSessionKey(`${s.group}:${s.series}`)
          }
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  // Fallback to "the series with the most events" if no session exists
  // yet (user opened the browser without ever having the main events
  // window focused). Matches the Refinement window's defensive default.
  const entry: EventsData | undefined = useMemo(() => {
    if (sessionKey && eventsAnalyses[sessionKey]) return eventsAnalyses[sessionKey]
    const entries = Object.values(eventsAnalyses)
    if (entries.length === 0) return undefined
    return entries.reduce((best, cur) =>
      (cur.events.length > (best?.events.length ?? 0) ? cur : best), entries[0])
  }, [eventsAnalyses, sessionKey])

  const selectEvent = useAppStore((s) => s.selectEvent)
  const removeEvent = useAppStore((s) => s.removeEvent)

  const [tab, setTab] = useState<'browser' | 'overlay'>('browser')

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0,
        background: 'var(--bg-secondary)',
        padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)',
        fontSize: 'var(--font-size-label)',
      }}>
        <span style={{ fontWeight: 600 }}>Events browser</span>
        {entry ? (
          <span style={{ color: 'var(--text-muted)' }}>
            G{entry.group} / S{entry.series} · {entry.events.length} detected events
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>
            No events detected — run detection in the main Events window first.
          </span>
        )}
      </div>

      {/* Tab bar — Browser | Overlay. Only these two views live here;
          Results / Histogram / Rate stay in the main events window. */}
      <div className="segmented" role="tablist" style={{
        flexShrink: 0, alignSelf: 'flex-start',
      }}>
        {(['browser', 'overlay'] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'active' : undefined}
            style={{ flex: 'none', padding: '0 14px' }}>
            {k === 'browser' ? 'Browser' : 'Overlay'}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'browser' && (
          <EventBrowserPanel
            backendUrl={backendUrl}
            entry={entry}
            onSelect={(idx) => entry && selectEvent(entry.group, entry.series, idx)}
            onDiscard={(idx) => entry && removeEvent(entry.group, entry.series, idx)}
          />
        )}
        {tab === 'overlay' && (
          <AllEventsOverlayPanel
            backendUrl={backendUrl}
            entry={entry}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared zoom / pan behaviour — wheel-to-zoom, drag-to-pan, dbl-click
// to reset. Attached to uPlot's over layer. Returns a teardown fn.
// ---------------------------------------------------------------------------

function attachZoomPan(u: uPlot): () => void {
  const over = (u as any).over as HTMLDivElement
  if (!over) return () => {}
  type Drag = {
    startPxX: number; startPxY: number
    xMin: number; xMax: number; yMin: number; yMax: number
    panning: boolean
  }
  let drag: Drag | null = null
  const THRESHOLD = 3

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return
    const xMin = u.scales.x.min, xMax = u.scales.x.max
    const yMin = u.scales.y.min, yMax = u.scales.y.max
    if (xMin == null || xMax == null || yMin == null || yMax == null) return
    const rect = over.getBoundingClientRect()
    drag = {
      startPxX: ev.clientX - rect.left,
      startPxY: ev.clientY - rect.top,
      xMin, xMax, yMin, yMax, panning: false,
    }
    over.setPointerCapture(ev.pointerId)
  }
  const onPointerMove = (ev: PointerEvent) => {
    if (!drag) return
    const rect = over.getBoundingClientRect()
    const dxPx = (ev.clientX - rect.left) - drag.startPxX
    const dyPx = (ev.clientY - rect.top) - drag.startPxY
    if (!drag.panning && Math.abs(dxPx) < THRESHOLD && Math.abs(dyPx) < THRESHOLD) return
    drag.panning = true
    const bboxW = u.bbox.width / (devicePixelRatio || 1)
    const bboxH = u.bbox.height / (devicePixelRatio || 1)
    const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
    const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
    u.setScale('x', { min: drag.xMin + dx, max: drag.xMax + dx })
    u.setScale('y', { min: drag.yMin + dy, max: drag.yMax + dy })
    over.style.cursor = 'grabbing'
  }
  const onPointerUp = (ev: PointerEvent) => {
    if (!drag) return
    drag = null
    try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
    over.style.cursor = ''
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
      const yAt = u.posToVal(pxY, 'y')
      u.setScale('y', {
        min: yAt - (yAt - yMin) * factor,
        max: yAt + (yMax - yAt) * factor,
      })
    } else {
      const xMin = u.scales.x.min, xMax = u.scales.x.max
      if (xMin == null || xMax == null) return
      const xAt = u.posToVal(pxX, 'x')
      u.setScale('x', {
        min: xAt - (xAt - xMin) * factor,
        max: xAt + (xMax - xAt) * factor,
      })
    }
  }
  const onDblClick = (_ev: MouseEvent) => {
    // Reset to auto-range.
    u.setScale('x', { min: null as any, max: null as any })
    u.setScale('y', { min: null as any, max: null as any })
  }

  over.addEventListener('pointerdown', onPointerDown)
  over.addEventListener('pointermove', onPointerMove)
  over.addEventListener('pointerup', onPointerUp)
  over.addEventListener('pointercancel', onPointerUp)
  over.addEventListener('wheel', onWheel, { passive: false })
  over.addEventListener('dblclick', onDblClick)

  return () => {
    over.removeEventListener('pointerdown', onPointerDown)
    over.removeEventListener('pointermove', onPointerMove)
    over.removeEventListener('pointerup', onPointerUp)
    over.removeEventListener('pointercancel', onPointerUp)
    over.removeEventListener('wheel', onWheel)
    over.removeEventListener('dblclick', onDblClick)
  }
}

// ---------------------------------------------------------------------------
// Browser panel — single-event zoomed view with EE-style kinetics
// markers (peak, foot, decay endpoint, 20/80 rise crossings,
// half-amplitude bar). Optionally fetches the trace through the
// pre-detection filter so the user can A/B raw vs filtered shape.
// ---------------------------------------------------------------------------

function EventBrowserPanel({
  backendUrl, entry,
  onSelect, onDiscard,
}: {
  backendUrl: string
  entry: EventsData | undefined
  onSelect: (idx: number) => void
  onDiscard: (idx: number) => void
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'event-browser',
  })
  const [preMs, setPreMs] = useState(10)
  const [winMs, setWinMs] = useState(60)
  const [respectFilter, setRespectFilter] = useState(true)
  // Edit-Kinetics drag mode. ``primed`` is the landmark the user has
  // selected to move; the next click on the plot sets the new
  // position and triggers a backend re-measure. Off by default so
  // accidental clicks don't move kinetics.
  const [editMode, setEditMode] = useState(false)
  const [primed, setPrimed] = useState<'foot' | 'decay' | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const replaceEvent = useAppStore((s) => s.replaceEvent)

  const idx = entry?.selectedIdx ?? (entry && entry.events.length > 0 ? 0 : null)
  const ev: EventRow | null = entry && idx != null && idx >= 0 && idx < entry.events.length
    ? entry.events[idx]
    : null

  /** Send a foot / decay-endpoint override for the current event to
   *  the backend, then replace the event row with the response. The
   *  click time is in seconds RELATIVE to the peak (the plot's x is
   *  centred on the peak); we add the absolute peak time to get sweep
   *  coordinates. ``which`` controls which override field is sent. */
  const editKineticsCommit = useCallback(async (which: 'foot' | 'decay', clickRelS: number) => {
    if (!entry || !ev || idx == null) return
    const absS = ev.peakTimeS + clickRelS
    setEditBusy(true)
    try {
      const body: Record<string, any> = {
        group: entry.group, series: entry.series,
        sweep: ev.sweep ?? entry.sweep, trace: entry.channel,
        direction: entry.params.peakDirection,
        peak_idx: ev.peakIdx,
        baseline_search_ms: entry.params.baselineSearchMs,
        avg_baseline_ms: entry.params.avgBaselineMs,
        avg_peak_ms: entry.params.avgPeakMs,
        rise_low_pct: entry.params.riseLowPct,
        rise_high_pct: entry.params.riseHighPct,
        decay_pct: entry.params.decayPct,
        decay_search_ms: entry.params.decaySearchMs,
        decay_endpoint_method: entry.params.decayEndpointMethod,
        // Match the original detection's pre-processing so the
        // re-measure runs against the same trace.
        filter_enabled: entry.params.filterEnabled,
        filter_type: entry.params.filterType,
        filter_low: entry.params.filterLow,
        filter_high: entry.params.filterHigh,
        filter_order: entry.params.filterOrder,
        detrend_enabled: entry.params.detrendEnabled,
        detrend_window_ms: entry.params.detrendWindowMs,
      }
      if (which === 'foot') body.foot_time_s = absS
      else body.decay_endpoint_time_s = absS
      const resp = await fetch(`${backendUrl}/api/events/edit_kinetics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error(String(resp.status))
      const out = await resp.json()
      const e = out.event
      if (!e) throw new Error('no event in response')
      // Map the backend snake_case → frontend camelCase. Same shape as
      // EventRow elsewhere in the store.
      const row: EventRow = {
        sweep: Number(e.sweep ?? 0),
        peakIdx: Number(e.peak_idx),
        peakTimeS: Number(e.peak_time_s),
        peakVal: Number(e.peak_val),
        footIdx: Number(e.foot_idx),
        footTimeS: Number(e.foot_time_s),
        baselineVal: Number(e.baseline_val),
        amplitude: Number(e.amplitude),
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
        // Preserve the existing event's template tag + group across an
        // edit-kinetics adjustment — the user is fine-tuning landmarks,
        // not redetecting from a different template, and they don't
        // expect their group assignment to evaporate.
        templateIdx: ev.templateIdx,
        group: ev.group,
      }
      replaceEvent(entry.group, entry.series, idx, row)
    } catch (err) {
      console.error('edit_kinetics failed', err)
    } finally {
      setEditBusy(false)
      setPrimed(null)
    }
  }, [backendUrl, entry, ev, idx, replaceEvent])

  // Keyboard nav — ← / → step through events. Ignores inputs so
  // users can type into the window/pre fields without flipping events.
  useEffect(() => {
    if (!entry) return
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT'
                || t.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowRight') {
        const cur = entry.selectedIdx ?? -1
        const nxt = Math.min(entry.events.length - 1, cur + 1)
        if (nxt !== cur) onSelect(nxt); e.preventDefault()
      } else if (e.key === 'ArrowLeft') {
        const cur = entry.selectedIdx ?? 0
        const nxt = Math.max(0, cur - 1)
        if (nxt !== cur) onSelect(nxt); e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [entry, onSelect])

  const [winData, setWinData] = useState<{
    time: number[]; values: (number | null)[]
  } | null>(null)
  useEffect(() => {
    if (!backendUrl || !entry || !ev) { setWinData(null); return }
    const after = Math.max(1, winMs - preMs)
    // Re-use the /overlay endpoint in single-event mode. The endpoint
    // already honours the pre-detection filter flag we pass through —
    // so the same code path handles both raw and filtered views.
    const filterParams = respectFilter && entry.params.filterEnabled ? {
      filter_enabled: true,
      filter_type: entry.params.filterType,
      filter_low: entry.params.filterLow,
      filter_high: entry.params.filterHigh,
      filter_order: entry.params.filterOrder,
    } : {}
    fetch(`${backendUrl}/api/events/overlay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group: entry.group, series: entry.series,
        sweep: entry.sweep, trace: entry.channel,
        events: [{
          peak_idx: ev.peakIdx, foot_idx: ev.footIdx,
          baseline_val: ev.baselineVal,
        }],
        align: 'peak',
        window_before_ms: preMs,
        window_after_ms: after,
        baseline_subtract: false,
        ...filterParams,
      }),
    }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((d) => {
        const row = (d.traces?.[0] ?? []) as (number | null)[]
        setWinData({
          time: (d.time_s ?? []).map((x: any) => Number(x)),
          values: row.map((x) => x == null ? null : Number(x)),
        })
      })
      .catch(() => setWinData(null))
  }, [backendUrl, entry, ev, preMs, winMs, respectFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let teardown: (() => void) | null = null
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!winData || winData.time.length === 0 || !ev || !entry) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const sr = entry.samplingRate || 1
      const footOff = (ev.footIdx - ev.peakIdx) / sr
      const decayOff = ev.decayEndpointIdx != null
        ? (ev.decayEndpointIdx - ev.peakIdx) / sr : null
      // 20 / 80 rise crossings — find them by scanning winData.values
      // from peak backward (rise goes baseline → peak). Matches how
      // `rise_time_ms` is computed on the backend, so the dots
      // coincide with the reported rise time.
      const amp = ev.amplitude
      let rise20Off: number | null = null
      let rise80Off: number | null = null
      let halfLeft: number | null = null
      let halfRight: number | null = null
      if (amp !== 0) {
        const t20 = ev.baselineVal + 0.20 * amp
        const t80 = ev.baselineVal + 0.80 * amp
        const halfV = ev.baselineVal + 0.50 * amp
        const upward = amp > 0
        // Find the sample nearest t=0 (the peak) in winData.
        let peakI = 0, bestDT = Infinity
        for (let i = 0; i < winData.time.length; i++) {
          const dt = Math.abs(winData.time[i])
          if (dt < bestDT) { bestDT = dt; peakI = i }
        }
        // Walk backward from peak to find last sample on peak-side of each.
        const onPeakSide = (v: number, target: number) =>
          upward ? v >= target : v <= target
        const findBwd = (target: number): number | null => {
          for (let i = peakI - 1; i >= 0; i--) {
            const v = winData.values[i]
            if (v == null) continue
            if (!onPeakSide(v, target)) return winData.time[i + 1]
          }
          return null
        }
        // Walk forward from peak (decay side) for half-amplitude right.
        const findFwd = (target: number): number | null => {
          for (let i = peakI + 1; i < winData.time.length; i++) {
            const v = winData.values[i]
            if (v == null) continue
            if (!onPeakSide(v, target)) return winData.time[i - 1]
          }
          return null
        }
        rise20Off = findBwd(t20)
        rise80Off = findBwd(t80)
        halfLeft = findBwd(halfV)
        halfRight = findFwd(halfV)
      }
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: { x: { time: false }, y: { auto: true } },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            values: (_u, vals) => vals.map((v) => (v * 1000).toFixed(1)),
            label: 'Time (ms, 0 = peak)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55, label: entry.units,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [{}, { stroke: cssVar('--trace-color-1'), width: 1.5, spanGaps: false }],
        hooks: {
          draw: [(u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            // Baseline horizontal line (gray dashed).
            const byPos = u.valToPos(ev.baselineVal, 'y', true)
            const outline = cssVar('--marker-outline')
            ctx.save()
            ctx.strokeStyle = cssVar('--text-muted')
            ctx.setLineDash([4 * dpr, 3 * dpr])
            ctx.lineWidth = 1 * dpr
            ctx.beginPath()
            ctx.moveTo(u.bbox.left, byPos)
            ctx.lineTo(u.bbox.left + u.bbox.width, byPos)
            ctx.stroke()
            ctx.setLineDash([])
            // Half-amplitude bar (amber dashed between left / right
            // half crossings). EE's "FWHM" display on page 29.
            if (halfLeft != null && halfRight != null && amp !== 0) {
              const halfV = ev.baselineVal + 0.50 * amp
              const hyPos = u.valToPos(halfV, 'y', true)
              const hxL = u.valToPos(halfLeft, 'x', true)
              const hxR = u.valToPos(halfRight, 'x', true)
              const fwhmColor = cssVar('--warning')
              ctx.strokeStyle = fwhmColor
              ctx.setLineDash([4 * dpr, 3 * dpr])
              ctx.lineWidth = 1.25 * dpr
              ctx.beginPath()
              ctx.moveTo(hxL, hyPos); ctx.lineTo(hxR, hyPos)
              ctx.stroke()
              ctx.setLineDash([])
              // FWHM crossing dots — sit on the trace, so keep them a
              // touch smaller than the foot/peak anchors but still
              // clearly visible (matching the 20/80 rise dots).
              ctx.fillStyle = fwhmColor
              ctx.strokeStyle = outline
              ctx.lineWidth = 1 * dpr
              ctx.beginPath(); ctx.arc(hxL, hyPos, 4 * dpr, 0, 2 * Math.PI)
              ctx.fill(); ctx.stroke()
              ctx.beginPath(); ctx.arc(hxR, hyPos, 4 * dpr, 0, 2 * Math.PI)
              ctx.fill(); ctx.stroke()
            }
            // Radii in CSS pixels (multiplied by dpr inside drawDot).
            // Matches the burst markers on the main TraceViewer so the
            // browser doesn't feel visually secondary. Peak is biggest
            // (the event's primary anchor); kinetic markers a touch
            // smaller; rise 20 / 80 and half-amplitude crossings are
            // fine dots because they're on the already-visible trace
            // rather than the baseline reference line.
            const drawDot = (x: number, y: number, color: string, r: number = 5) => {
              if (!isFinite(x) || !isFinite(y)) return
              ctx.fillStyle = color
              ctx.beginPath(); ctx.arc(x, y, r * dpr, 0, 2 * Math.PI); ctx.fill()
              ctx.strokeStyle = outline; ctx.lineWidth = 1.5 * dpr; ctx.stroke()
            }
            // Foot (gray) — same size as burst baseline dots.
            drawDot(u.valToPos(footOff, 'x', true), byPos, cssVar('--text-muted'), 5)
            // 20/80 rise (cyan / teal) on the rising edge. Slightly
            // smaller because they sit ON the trace line — too big and
            // they'd obscure the rising edge shape.
            if (rise20Off != null && amp !== 0) {
              const t20 = ev.baselineVal + 0.20 * amp
              drawDot(u.valToPos(rise20Off, 'x', true),
                      u.valToPos(t20, 'y', true), '#4dd0e1', 4)
            }
            if (rise80Off != null && amp !== 0) {
              const t80 = ev.baselineVal + 0.80 * amp
              drawDot(u.valToPos(rise80Off, 'x', true),
                      u.valToPos(t80, 'y', true), '#26a69a', 4)
            }
            // Peak (red) — biggest, primary anchor for the event.
            const pxPos = u.valToPos(0, 'x', true)
            const pyPos = u.valToPos(ev.peakVal, 'y', true)
            drawDot(pxPos, pyPos, cssVar('--marker-detected'), 6)
            // Decay endpoint (purple)
            if (decayOff != null) {
              drawDot(u.valToPos(decayOff, 'x', true), byPos, cssVar('--cursor-fit'), 5)
            }
            ctx.restore()
          }],
        },
      }
      const payload: uPlot.AlignedData = [
        winData.time as any, winData.values as any,
      ]
      plotRef.current = new uPlot(opts, payload, container)
      teardown = attachZoomPan(plotRef.current!)
    })
    return () => {
      cancelAnimationFrame(frame)
      if (teardown) teardown()
    }
  }, [winData, ev, entry, themeKey])

  // Edit-Kinetics click capture — when a landmark is primed, the next
  // click on the plot's overlay layer is consumed as the new position.
  // Attaches over the zoom/pan handler in capture phase so the drag
  // handler doesn't swallow the click. Released as soon as the click
  // commits (or the user presses Esc).
  useEffect(() => {
    if (!primed) return
    const u = plotRef.current
    if (!u) return
    const over = (u as any).over as HTMLDivElement | null
    if (!over) return
    over.style.cursor = 'crosshair'
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const rect = over.getBoundingClientRect()
      const px = e.clientX - rect.left
      const t = u.posToVal(px, 'x')
      if (!isFinite(t)) return
      e.stopPropagation()
      e.preventDefault()
      void editKineticsCommit(primed, t)
    }
    over.addEventListener('pointerdown', onDown, { capture: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPrimed(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      over.removeEventListener('pointerdown', onDown, { capture: true } as any)
      window.removeEventListener('keydown', onKey)
      over.style.cursor = ''
    }
  }, [primed, editKineticsCommit])

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

  if (!entry || entry.events.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Run detection in the main Events window to browse events here.
      </div>
    )
  }

  const unit = entry.units
  const cur = (idx ?? 0) + 1
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, minHeight: 0,
    }}>
      {/* Nav strip */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <button className="btn" onClick={() => onSelect(Math.max(0, (idx ?? 0) - 1))}
          disabled={(idx ?? 0) <= 0}
          style={{ padding: '3px 10px' }} title="Previous event (←)">← Prev</button>
        <span className="num" style={{
          minWidth: 60, textAlign: 'center',
        }}>{cur} / {entry.events.length}</span>
        <button className="btn" onClick={() => onSelect(Math.min(entry.events.length - 1, (idx ?? 0) + 1))}
          disabled={(idx ?? 0) >= entry.events.length - 1}
          style={{ padding: '3px 10px' }} title="Next event (→)">Next →</button>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
               title="When on, the plot shows the trace AFTER the pre-detection filter has been applied (same signal the detector sees). When off, shows the raw unfiltered sweep.">
          <input type="checkbox" checked={respectFilter}
            onChange={(e) => setRespectFilter(e.target.checked)} />
          <span>Filter{entry.params.filterEnabled
            ? '' : ' (off in detection)'}</span>
        </label>
        {ev && (
          <button className="btn"
            onClick={() => {
              // Tell the main events window to re-centre its viewer
              // on this event. Keeps the detached browser useful
              // for QC: poke through events here, hit "Go to event"
              // to see the same event in the main window's context
              // (cursors, markers, trace neighbours). The main
              // window's BroadcastChannel listener consumes this.
              if (!ev) return
              try {
                const ch = new BroadcastChannel('tracer-sync')
                ch.postMessage({
                  type: 'events-navigate-to',
                  timeS: ev.peakTimeS,
                  windowS: 0.06,
                })
                ch.close()
              } catch { /* ignore */ }
            }}
            style={{ padding: '3px 10px' }}
            title="Recentre the main Events window's viewer on this event">
            Go to event
          </button>
        )}
        {ev && (
          <button className="btn" onClick={() => idx != null && onDiscard(idx)}
            style={{ padding: '3px 10px' }} title="Remove this event">
            Discard
          </button>
        )}
        {/* Edit-Kinetics drag mode. Toggles a panel of "move" buttons
            for foot / decay-endpoint; when one is primed the cursor
            becomes a crosshair and the next click on the trace sets
            the new landmark, triggering a backend re-measure. Esc
            cancels a primed move without touching the kinetics. */}
        {ev && (
          <button className={editMode ? 'btn btn-toggled' : 'btn'}
            onClick={() => { setEditMode((v) => !v); setPrimed(null) }}
            aria-pressed={editMode}
            style={{ padding: '3px 10px' }}
            title="Manually drag the foot / decay endpoint of this event">
            {editMode ? 'Edit on' : 'Edit kinetics'}
          </button>
        )}
      </div>
      {editMode && ev && (
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center',
          padding: '4px 8px', borderRadius: 4,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          fontSize: 'var(--font-size-label)',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>Move:</span>
          <button className="btn"
            onClick={() => setPrimed('foot')}
            disabled={editBusy}
            style={{
              padding: '2px 10px',
              background: primed === 'foot' ? 'var(--text-muted)' : undefined,
              color: primed === 'foot' ? 'var(--on-accent)' : undefined,
            }}
            title="Click the trace to reposition the foot / baseline anchor">
            Foot
          </button>
          <button className="btn"
            onClick={() => setPrimed('decay')}
            disabled={editBusy}
            style={{
              padding: '2px 10px',
              background: primed === 'decay' ? 'var(--cursor-fit)' : undefined,
              color: primed === 'decay' ? 'var(--on-accent)' : undefined,
            }}
            title="Click the trace to reposition the decay endpoint">
            Decay end
          </button>
          {primed && (
            <span style={{
              color: 'var(--text-muted)', fontStyle: 'italic',
            }}>
              Click the trace to set… (Esc cancels)
            </span>
          )}
          {editBusy && <span style={{ color: 'var(--text-muted)' }}>Re-measuring…</span>}
        </div>
      )}

      {/* Kinetics card + mini plot side-by-side */}
      <div style={{
        display: 'flex', gap: 8, flex: 1, minHeight: 0,
      }}>
        <div style={{
          width: 200, flexShrink: 0,
          padding: 8, border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--bg-primary)',
          fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.7, overflow: 'auto',
        }}>
          {ev && (
            <>
              <div>t<sub>peak</sub> = {ev.peakTimeS.toFixed(4)} s</div>
              <div>amp = {ev.amplitude.toFixed(2)} {unit}</div>
              <div>baseline = {ev.baselineVal.toFixed(2)} {unit}</div>
              <div>peak = {ev.peakVal.toFixed(2)} {unit}</div>
              <div style={{
                marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--border)',
              }} />
              <div>rise {ev.riseTimeMs != null ? ev.riseTimeMs.toFixed(2) : '—'} ms</div>
              <div>decay {ev.decayTimeMs != null ? ev.decayTimeMs.toFixed(2) : '—'} ms</div>
              <div>τ<sub>decay</sub> {ev.decayTauMs != null ? ev.decayTauMs.toFixed(2) : '—'} ms</div>
              <div>FWHM {ev.halfWidthMs != null ? ev.halfWidthMs.toFixed(2) : '—'} ms</div>
              <div>AUC {ev.auc != null ? ev.auc.toFixed(3) : '—'} {unit}·s</div>
              <div style={{
                marginTop: 6, color: ev.manual ? 'var(--marker-manual)' : 'var(--text-muted)',
                fontStyle: 'italic', fontFamily: 'var(--font-ui)',
              }}>{ev.manual ? 'Manual' : 'Auto-detected'}</div>
              <div style={{
                marginTop: 10, paddingTop: 6, borderTop: '1px solid var(--border)',
                color: 'var(--text-muted)', fontFamily: 'var(--font-ui)',
                fontSize: 'var(--font-size-xs)', lineHeight: 1.35,
              }}>
                Legend: <span style={{ color: 'var(--marker-detected)' }}>●</span> peak&nbsp;
                <span style={{ color: 'var(--text-muted)' }}>●</span> foot&nbsp;
                <span style={{ color: '#4dd0e1' }}>●</span> 20%&nbsp;
                <span style={{ color: '#26a69a' }}>●</span> 80%&nbsp;
                <span style={{ color: 'var(--warning)' }}>●</span> FWHM&nbsp;
                <span style={{ color: 'var(--cursor-fit)' }}>●</span> end
              </div>
            </>
          )}
        </div>
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{
            display: 'flex', gap: 8, alignItems: 'center',
            fontSize: 'var(--font-size-label)', flexShrink: 0,
          }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Before (ms)</span>
              <NumInput value={preMs} step={1} min={1}
                onChange={(v) => setPreMs(Math.max(1, Math.min(winMs - 1, v)))} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Total (ms)</span>
              <NumInput value={winMs} step={5} min={10}
                onChange={(v) => setWinMs(Math.max(preMs + 1, v))} />
            </label>
            <span style={{ flex: 1 }} />
            <span style={{
              color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic',
            }}>Scroll = zoom X · Alt+scroll = zoom Y · drag = pan · dbl-click = reset</span>
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
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overlay panel — all events aligned on peak (or foot), with mean and
// ±1 SD envelope. Supports zoom/pan; toggle to honour the pre-detection
// filter for the same A/B comparison the browser offers.
// ---------------------------------------------------------------------------

function AllEventsOverlayPanel({
  backendUrl, entry,
}: {
  backendUrl: string
  entry: EventsData | undefined
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-overlay',
  })
  const [data, setData] = useState<{
    time: number[]; traces: (number | null)[][]
    mean: (number | null)[]; sdLo: (number | null)[]; sdHi: (number | null)[]
    nIncluded: number
    /** Per-trace event index (into ``entry.events``) for the rows in
     *  ``traces``. Backend may exclude events whose window runs off the
     *  edge of the sweep, so this is not always ``[0, 1, 2, …]``. */
    rowIdxToEventIdx: number[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [alignMode, setAlignMode] = useState<'peak' | 'foot'>('peak')
  const [beforeMs, setBeforeMs] = useState(5)
  const [afterMs, setAfterMs] = useState(50)
  const [respectFilter, setRespectFilter] = useState(true)
  // Shift / Scale display options — client-side transforms applied
  // before rendering. Not persisted to the analysis (this is purely
  // about how the overlay LOOKS); distance ranking + highlight use
  // the same transformed values so what you see is what's compared.
  // EE's convention is "scale before shift"; we follow it.
  type ShiftMode = 'none' | 'demean' | 'align' | 'first'
  type ScaleMode = 'none' | 'amplitude' | 'std'
  const [shiftMode, setShiftMode] = useState<ShiftMode>('none')
  const [scaleMode, setScaleMode] = useState<ScaleMode>('none')

  // ---- Most-Distant browsing state ----
  // Tracks the rank into the L2-distance-sorted list (0 = most distant
  // from the mean event, 1 = next, …). ``null`` = no event highlighted
  // (the panel is in plain "all events overlaid" mode). The actual
  // event index in the entry is read off ``distances[rank].rowIdx``.
  const [distantRank, setDistantRank] = useState<number | null>(null)
  const removeEvent = useAppStore((s) => s.removeEvent)

  /** Transformed-for-display version of the fetched overlay data —
   *  scale-then-shift applied per row (EE's convention), then mean +
   *  ±1 SD recomputed across the transformed rows so the envelope
   *  matches what's drawn. ``data`` (raw) is kept around for nothing
   *  in particular but retained as the source of truth in case we
   *  need it later. Same row-count + time array as ``data``. */
  const displayData = useMemo(() => {
    if (!data) return null
    const { time, traces, rowIdxToEventIdx, nIncluded } = data
    if (shiftMode === 'none' && scaleMode === 'none') return data
    // Find the aligned-zero index — t=0 in the time array. Used by the
    // 'align' shift mode (subtract the value at the alignment anchor
    // so every event passes through 0 at t=0).
    let alignIdx = 0
    let bestAbs = Infinity
    for (let i = 0; i < time.length; i++) {
      const a = Math.abs(time[i])
      if (a < bestAbs) { bestAbs = a; alignIdx = i }
    }
    const newTraces: (number | null)[][] = traces.map((row) => {
      // Skip null rows (events whose window ran off the sweep edge).
      if (row.every((v) => v == null)) return row.slice()
      // Pull non-null samples for stat computations.
      const xs: number[] = []
      for (const v of row) if (v != null) xs.push(v)
      if (xs.length === 0) return row.slice()
      // Scale first.
      let scale = 1
      if (scaleMode === 'amplitude') {
        const mn = Math.min(...xs); const mx = Math.max(...xs)
        const span = mx - mn
        if (span > 0 && isFinite(span)) scale = 1 / span
      } else if (scaleMode === 'std') {
        const mean = xs.reduce((s, v) => s + v, 0) / xs.length
        let s2 = 0
        for (const v of xs) s2 += (v - mean) * (v - mean)
        const sd = Math.sqrt(s2 / Math.max(1, xs.length - 1))
        if (sd > 0 && isFinite(sd)) scale = 1 / sd
      }
      const scaled = row.map((v) => v == null ? null : v * scale)
      // Shift second.
      let shift = 0
      if (shiftMode === 'demean') {
        let s = 0; let n = 0
        for (const v of scaled) if (v != null) { s += v; n++ }
        shift = n > 0 ? s / n : 0
      } else if (shiftMode === 'align') {
        const a = scaled[alignIdx]
        if (a != null) shift = a
      } else if (shiftMode === 'first') {
        // Use the first non-null sample of the (scaled) row.
        for (const v of scaled) if (v != null) { shift = v; break }
      }
      if (shift === 0) return scaled
      return scaled.map((v) => v == null ? null : v - shift)
    })
    // Recompute mean + sd from transformed rows so the envelope tracks
    // what's drawn rather than the raw fetched mean.
    const m: (number | null)[] = []
    const lo: (number | null)[] = []
    const hi: (number | null)[] = []
    for (let i = 0; i < time.length; i++) {
      const col: number[] = []
      for (const row of newTraces) {
        const v = row[i]; if (v != null) col.push(v)
      }
      if (col.length === 0) { m.push(null); lo.push(null); hi.push(null); continue }
      const mean = col.reduce((s, v) => s + v, 0) / col.length
      let s2 = 0; for (const v of col) s2 += (v - mean) * (v - mean)
      const sd = col.length > 1 ? Math.sqrt(s2 / (col.length - 1)) : 0
      m.push(mean); lo.push(mean - sd); hi.push(mean + sd)
    }
    return { time, traces: newTraces, mean: m, sdLo: lo, sdHi: hi,
             nIncluded, rowIdxToEventIdx }
  }, [data, shiftMode, scaleMode])

  /** L2 distance from each event's trace to the mean event, sorted
   *  descending. Rows whose backend window ran off the edge of the
   *  sweep (all-null trace) are excluded — they have no shape to
   *  compare. Recomputed whenever the overlay data changes. */
  const distances = useMemo(() => {
    const dd = displayData
    if (!dd || dd.traces.length === 0) return []
    const mean = dd.mean
    if (mean.length === 0) return []
    const out: { rowIdx: number; distance: number }[] = []
    for (let r = 0; r < dd.traces.length; r++) {
      const row = dd.traces[r]
      let acc = 0
      let counted = 0
      for (let i = 0; i < row.length; i++) {
        const v = row[i], m = mean[i]
        if (v == null || m == null) continue
        const d = v - m
        acc += d * d
        counted++
      }
      if (counted === 0) continue
      out.push({ rowIdx: r, distance: Math.sqrt(acc / counted) })
    }
    out.sort((a, b) => b.distance - a.distance)
    return out
  }, [displayData])

  // Reset distance ranking whenever the displayed data changes
  // (refetch OR shift/scale toggle) — otherwise rank would point at a
  // stale row index or stale distance.
  useEffect(() => { setDistantRank(null) }, [displayData])

  /** Row index of the currently-highlighted event (null = none). Used
   *  by the draw hook to bold-trace the selected row in blue. */
  const highlightedRowIdx = (distantRank != null && distances[distantRank])
    ? distances[distantRank].rowIdx : null
  const highlightedRowIdxRef = useRef<number | null>(highlightedRowIdx)
  highlightedRowIdxRef.current = highlightedRowIdx
  const dataRef = useRef(displayData)
  dataRef.current = displayData

  useEffect(() => {
    if (!backendUrl || !entry || entry.events.length === 0) {
      setData(null); return
    }
    const t = setTimeout(() => {
      setLoading(true); setErr(null)
      const filterParams = respectFilter && entry.params.filterEnabled ? {
        filter_enabled: true,
        filter_type: entry.params.filterType,
        filter_low: entry.params.filterLow,
        filter_high: entry.params.filterHigh,
        filter_order: entry.params.filterOrder,
      } : {}
      fetch(`${backendUrl}/api/events/overlay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: entry.group, series: entry.series,
          sweep: entry.sweep, trace: entry.channel,
          events: entry.events.map((e) => ({
            peak_idx: e.peakIdx, foot_idx: e.footIdx,
            baseline_val: e.baselineVal,
          })),
          align: alignMode,
          window_before_ms: beforeMs,
          window_after_ms: afterMs,
          baseline_subtract: true,
          ...filterParams,
        }),
      }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
        .then((d) => {
          const traces = (d.traces ?? []).map((row: any[]) =>
            row.map((x: any) => x == null ? null : Number(x)))
          // Backend preserves a 1:1 row↔event mapping by emitting an
          // all-null row for events whose window would run off the
          // sweep edge. The L2-distance ranking below ignores those.
          setData({
            time: (d.time_s ?? []).map((x: any) => Number(x)),
            traces,
            mean: (d.mean ?? []).map((x: any) => x == null ? null : Number(x)),
            sdLo: (d.sd_lo ?? []).map((x: any) => x == null ? null : Number(x)),
            sdHi: (d.sd_hi ?? []).map((x: any) => x == null ? null : Number(x)),
            nIncluded: Number(d.n_included ?? 0),
            rowIdxToEventIdx: traces.map((_: any, i: number) => i),
          })
          setLoading(false)
        })
        .catch((e) => { setErr(String(e)); setLoading(false); setData(null) })
    }, 150)
    return () => clearTimeout(t)
  }, [backendUrl, entry, alignMode, beforeMs, afterMs, respectFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let teardown: (() => void) | null = null
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    const dd = displayData
    if (!dd || dd.time.length === 0) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const aligned: uPlot.AlignedData = [
        dd.time as any,
        ...(dd.traces.map((row) => row as any) as any[]),
        dd.mean as any,
      ]
      const seriesDefs: uPlot.Series[] = [{}]
      for (let i = 0; i < dd.traces.length; i++) {
        seriesDefs.push({
          stroke: 'rgba(128,128,128,0.35)', width: 0.8, spanGaps: false,
        })
      }
      seriesDefs.push({ stroke: cssVar('--trace-average'), width: 2, spanGaps: false })
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: { x: { time: false }, y: { auto: true } },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: `Time (ms, 0 = ${alignMode})`, labelSize: 14,
            values: (_u, vals) => vals.map((v) => (v * 1000).toFixed(0)),
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55,
            label: scaleMode === 'amplitude' ? 'amp = 1'
                 : scaleMode === 'std' ? 'σ = 1'
                 : 'Δ baseline',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: seriesDefs,
        hooks: {
          draw: [(u) => {
            if (dd.sdLo.length !== dd.time.length
                || dd.sdHi.length !== dd.time.length) return
            const ctx = u.ctx
            ctx.save()
            ctx.fillStyle = cssVar('--trace-average')
            ctx.globalAlpha = 0.18
            ctx.beginPath()
            let started = false
            for (let i = 0; i < dd.time.length; i++) {
              const v = dd.sdHi[i]
              if (v == null) continue
              const px = u.valToPos(dd.time[i], 'x', true)
              const py = u.valToPos(v, 'y', true)
              if (!started) { ctx.moveTo(px, py); started = true }
              else ctx.lineTo(px, py)
            }
            for (let i = dd.time.length - 1; i >= 0; i--) {
              const v = dd.sdLo[i]
              if (v == null) continue
              const px = u.valToPos(dd.time[i], 'x', true)
              const py = u.valToPos(v, 'y', true)
              ctx.lineTo(px, py)
            }
            ctx.closePath()
            ctx.fill()
            ctx.globalAlpha = 1
            // Most-Distant highlight — overdraw the currently selected
            // event's trace in the accent colour, on top of the gray stack.
            // Reading from refs keeps the plot from rebuilding when the
            // user steps through events; uPlot's draw hook re-fires on
            // redraw(), which we trigger via a useEffect below.
            const rIdx = highlightedRowIdxRef.current
            const cur = dataRef.current
            if (rIdx != null && cur && cur.traces[rIdx]) {
              const row = cur.traces[rIdx]
              ctx.strokeStyle = cssVar('--accent')
              ctx.lineWidth = 2
              ctx.beginPath()
              let drawing = false
              for (let i = 0; i < cur.time.length; i++) {
                const v = row[i]
                if (v == null) { drawing = false; continue }
                const px = u.valToPos(cur.time[i], 'x', true)
                const py = u.valToPos(v, 'y', true)
                if (!drawing) { ctx.moveTo(px, py); drawing = true }
                else ctx.lineTo(px, py)
              }
              ctx.stroke()
            }
            ctx.restore()
          }],
        },
      }
      plotRef.current = new uPlot(opts, aligned, container)
      teardown = attachZoomPan(plotRef.current!)
    })
    return () => {
      cancelAnimationFrame(frame)
      if (teardown) teardown()
    }
  }, [displayData, alignMode, themeKey])

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

  // Cheap redraw when the highlight rank changes — avoids rebuilding
  // the whole uPlot instance for every step through the distance list.
  useEffect(() => { plotRef.current?.redraw() }, [highlightedRowIdx])

  // ---- Most-Distant nav handlers ----
  const stepDistant = useCallback((delta: number) => {
    if (distances.length === 0) return
    setDistantRank((r) => {
      const start = r ?? -1
      const next = start + delta
      if (next < 0) return 0
      if (next >= distances.length) return distances.length - 1
      return next
    })
  }, [distances])

  const enterDistantMode = useCallback(() => {
    if (distances.length === 0) return
    setDistantRank((r) => r ?? 0)
  }, [distances])

  const exitDistantMode = useCallback(() => setDistantRank(null), [])

  /** Delete the currently-highlighted event from the analysis. The
   *  store removal flows back through the entry → re-fetches the
   *  overlay data → distances recompute → distantRank reset to null
   *  via the data-change effect above. The user can then click "Most
   *  distant" again to keep curating. */
  const deleteHighlighted = useCallback(() => {
    if (highlightedRowIdx == null || !entry) return
    void removeEvent(entry.group, entry.series, highlightedRowIdx)
  }, [highlightedRowIdx, entry, removeEvent])

  const distantInfo = (distantRank != null && distances[distantRank])
    ? distances[distantRank] : null

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      minHeight: 0, gap: 6,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Align</span>
          <select value={alignMode}
            onChange={(e) => setAlignMode(e.target.value as 'peak' | 'foot')}>
            <option value="peak">Peak</option>
            <option value="foot">Foot</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Before (ms)</span>
          <NumInput value={beforeMs} step={1} min={1} onChange={setBeforeMs} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>After (ms)</span>
          <NumInput value={afterMs} step={5} min={5} onChange={setAfterMs} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
               title="Apply the pre-detection filter before overlaying">
          <input type="checkbox" checked={respectFilter}
            onChange={(e) => setRespectFilter(e.target.checked)} />
          <span>Filter</span>
        </label>
        {/* Display transforms — scale-then-shift, EE convention. None
            by default. Mean + ±1 SD envelope are recomputed from the
            transformed traces so the red mean tracks the gray cloud. */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
               title="Per-event amplitude rescale before plotting">
          <span style={{ color: 'var(--text-muted)' }}>Scale</span>
          <select value={scaleMode}
            onChange={(e) => setScaleMode(e.target.value as ScaleMode)}>
            <option value="none">None</option>
            <option value="amplitude">Amp → 1</option>
            <option value="std">σ → 1</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
               title="Per-event vertical shift before plotting">
          <span style={{ color: 'var(--text-muted)' }}>Shift</span>
          <select value={shiftMode}
            onChange={(e) => setShiftMode(e.target.value as ShiftMode)}>
            <option value="none">None</option>
            <option value="demean">Demean</option>
            <option value="align">{alignMode}=0</option>
            <option value="first">First=0</option>
          </select>
        </label>
        {data && (
          <span style={{ color: 'var(--text-muted)' }}>
            <span className="num">{data.nIncluded} / {entry?.events.length ?? 0}</span> events
          </span>
        )}
        {loading && <span style={{ color: 'var(--text-muted)' }}>Loading…</span>}
        {err && <span style={{ color: 'var(--error)' }}>⚠ {err}</span>}
        {/* Most-Distant outlier curation. Steps through events sorted
            by L2 distance from the mean event (most-distant first).
            Highlighted event is drawn in the accent colour; Delete removes it and
            the overlay refetches automatically. */}
        <span style={{
          marginLeft: 8, paddingLeft: 8,
          borderLeft: '1px solid var(--border)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          {distantRank == null ? (
            <button className="btn"
              onClick={enterDistantMode}
              disabled={distances.length === 0}
              style={{ padding: '2px 8px' }}
              title="Step through events from most distant to nearest (L2 from mean)">
              Most distant
            </button>
          ) : (
            <>
              <button className="btn"
                onClick={() => stepDistant(-1)}
                disabled={distantRank <= 0}
                style={{ padding: '2px 6px' }}
                title="More distant">
                ◀
              </button>
              <span className="num" style={{
                minWidth: 90,
                textAlign: 'center',
              }}>
                #{distantRank + 1} / {distances.length}
                {distantInfo && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}· d={distantInfo.distance.toFixed(2)}
                  </span>
                )}
              </span>
              <button className="btn"
                onClick={() => stepDistant(1)}
                disabled={distantRank >= distances.length - 1}
                style={{ padding: '2px 6px' }}
                title="Less distant">
                ▶
              </button>
              <button className="btn"
                onClick={deleteHighlighted}
                disabled={highlightedRowIdx == null}
                style={{
                  padding: '2px 8px',
                  background: 'var(--bg-error)', color: '#fff',
                  borderColor: 'transparent',
                }}
                title="Delete this event from the analysis">
                Del
              </button>
              <button className="btn"
                onClick={exitDistantMode}
                style={{ padding: '2px 6px' }}
                title="Exit Most-Distant mode">
                ✕
              </button>
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic',
        }}>Scroll = zoom · drag = pan · dbl-click = reset</span>
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
            Run detection to see the event overlay.
          </div>
        )}
      </div>
    </div>
  )
}
