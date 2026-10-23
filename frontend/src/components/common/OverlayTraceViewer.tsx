import React, { useEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { usePlotMenu } from './PlotMenu'

/**
 * Simple stacked-subplot trace viewer used alongside the primary
 * analysis viewer. Display-only:
 *
 *   - Fetches its own trace data for (group, series, sweep, channel).
 *   - For `channel === 'stimulus'`, calls the stimulus endpoint and
 *     renders the reconstructed step waveform instead.
 *   - Y auto-fits to whatever's visible within the current X range.
 *   - X range is fully controlled by the parent via `xRange` prop —
 *     the primary viewer drives zoom/pan, this component just
 *     mirrors. No wheel/pan handlers of its own.
 *
 * The intent: show Im (or any other channel) beneath Vm so the user
 * can see the stimulus step position while placing cursors on the
 * voltage trace. Analysis still runs only on the primary channel.
 */

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export type OverlayChannel =
  | { kind: 'channel'; index: number; label: string; units: string }
  | { kind: 'stimulus'; label: string; units: string }

interface Props {
  backendUrl: string
  group: number
  series: number
  sweep: number
  channel: OverlayChannel
  /** Current X range from the primary viewer, in seconds. null → auto-fit. */
  xRange: [number, number] | null
  /** Bumped by parent when the container height changes so the plot
   *  re-measures and resizes. */
  heightSignal?: number
  /** Optional — colour for the trace line. Defaults to a neutral hue
   *  distinct from the primary trace colour. */
  color?: string
}

export function OverlayTraceViewer({
  backendUrl, group, series, sweep, channel, xRange, heightSignal, color,
}: Props) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const theme = useThemeStore((s) => s.theme)
  void theme  // captured via cssVar at plot build time

  const [time, setTime] = React.useState<number[] | null>(null)
  const [values, setValues] = React.useState<number[] | null>(null)

  // Stash the latest xRange in a ref so the uPlot `scale.range`
  // callbacks — which uPlot re-invokes inside every setScale() — can
  // read the current value instead of a stale closure captured at
  // plot-build time. Without this, live wheel-zoom and Reset on the
  // primary viewer failed to propagate: setScale would set the new
  // range, then uPlot's internal re-evaluation overwrote it with the
  // old closure value. Same trick the primary viewer uses for its
  // own xRangeRef.
  const xRangeRef = useRef<[number, number] | null>(xRange)
  xRangeRef.current = xRange
  const yRangeRef = useRef<[number, number] | null>(null)

  // Fetch trace data. Re-fires on sweep or channel change. Stimulus is
  // always fetched as step segments and rasterised to a uniform sample
  // array so uPlot can draw it like any other trace.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (channel.kind === 'stimulus') {
          const r = await fetch(
            `${backendUrl}/api/traces/stimulus?group=${group}&series=${series}&sweep=${sweep}`,
          )
          if (!r.ok) { if (!cancelled) { setTime(null); setValues(null) } ; return }
          const d = await r.json()
          const segs: { start: number; end: number; level: number }[] = d.segments ?? []
          if (segs.length === 0) { if (!cancelled) { setTime(null); setValues(null) } ; return }
          // Rasterise: two samples per segment boundary (step function).
          const ts: number[] = []
          const vs: number[] = []
          let prevLevel: number | null = null
          for (const seg of segs) {
            if (prevLevel !== null) {
              // Tiny gap to get a visible vertical transition on uPlot.
              ts.push(seg.start)
              vs.push(prevLevel)
            }
            ts.push(seg.start)
            vs.push(seg.level)
            ts.push(seg.end)
            vs.push(seg.level)
            prevLevel = seg.level
          }
          if (!cancelled) { setTime(ts); setValues(vs) }
        } else {
          const qs = new URLSearchParams({
            group: String(group), series: String(series),
            sweep: String(sweep), trace: String(channel.index),
            max_points: '8000',
          })
          const r = await fetch(`${backendUrl}/api/traces/data?${qs}`)
          if (!r.ok) { if (!cancelled) { setTime(null); setValues(null) } ; return }
          const d = await r.json()
          if (!cancelled) { setTime(d.time ?? []); setValues(d.values ?? []) }
        }
      } catch {
        if (!cancelled) { setTime(null); setValues(null) }
      }
    })()
    return () => { cancelled = true }
  }, [backendUrl, group, series, sweep, channel.kind, (channel as any).index])

  // Y-range helper — auto-fit within the current X window so changes in
  // primary zoom also re-fit Y here (otherwise a tiny stim step looks
  // identical on every zoom, losing amplitude resolution).
  const yRangeForView = useMemo(() => {
    if (!time || !values || time.length === 0) return null
    const [xMin, xMax] = xRange ?? [time[0], time[time.length - 1]]
    let yMin = Infinity, yMax = -Infinity
    for (let i = 0; i < time.length; i++) {
      const t = time[i]
      if (t < xMin || t > xMax) continue
      const v = values[i]
      if (v < yMin) yMin = v
      if (v > yMax) yMax = v
    }
    if (!isFinite(yMin) || !isFinite(yMax) || yMin === yMax) {
      if (!isFinite(yMin) || !isFinite(yMax)) return null
      return [yMin - 1, yMax + 1] as [number, number]
    }
    const pad = (yMax - yMin) * 0.08
    return [yMin - pad, yMax + pad] as [number, number]
  }, [time, values, xRange])
  yRangeRef.current = yRangeForView

  // Build/rebuild the uPlot instance when the trace data changes.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!time || !values || time.length === 0) return

    const lineColor = color ?? (cssVar('--trace-color-3') || '#ffb74d')
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(60, el.clientHeight || 100),
      legend: { show: false },
      scales: {
        // Read the refs on every re-evaluate so setScale() calls
        // triggered by prop changes below aren't overwritten by a
        // stale closure of the initial xRange / yRangeForView.
        x: { time: false, range: () => xRangeRef.current ?? [time[0], time[time.length - 1]] },
        y: { range: () => yRangeRef.current ?? [0, 1] },
      },
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
          size: 55,
          label: channel.units || undefined,
          labelSize: 14,
        },
      ],
      series: [
        {},
        { stroke: lineColor, width: 1.25 },
      ],
      cursor: { drag: { x: false, y: false }, points: { show: false } },
    }
    const payload: uPlot.AlignedData = [time, values]
    plotRef.current = new uPlot(opts, payload, el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, values, channel.units, color, themeKey])

  // React to xRange / yRange updates without a full rebuild.
  useEffect(() => {
    const u = plotRef.current
    if (!u || !time || time.length === 0) return
    const r = xRange ?? [time[0], time[time.length - 1]]
    u.setScale('x', { min: r[0], max: r[1] })
    if (yRangeForView) u.setScale('y', { min: yRangeForView[0], max: yRangeForView[1] })
  }, [xRange, yRangeForView, time])

  // Resize on container size changes (splitter drags, window resize).
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

  // Parent-driven resize signal (stacked-subplot splitter drags don't
  // always fire a clean ResizeObserver event on the inner container,
  // so we bump a signal as a belt-and-braces fallback).
  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  if (time == null || values == null || time.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        background: 'var(--chart-bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {channel.kind === 'stimulus' ? 'No stimulus protocol' : `No data for ${channel.label}`}
      </div>
    )
  }
  return <OverlayBody containerRef={containerRef} plotRef={plotRef} channelLabel={channel.label} />
}

function OverlayBody({
  containerRef, plotRef, channelLabel,
}: {
  containerRef: React.RefObject<HTMLDivElement>
  plotRef: React.RefObject<uPlot | null>
  channelLabel: string
}) {
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: channelLabel || 'overlay',
  })
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: '100%', minHeight: 0,
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        background: 'var(--chart-bg)',
        position: 'relative',
      }}
    >
      {menu}
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}
