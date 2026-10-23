import React, { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  TraceItem,
  currentViewRef, useTraceExportStore,
} from '../../stores/traceExportStore'
import { makeScalebarDrawHook } from './scalebarDraw'

interface RenderItem {
  id: string
  axis_id: string
  unit: string
  series: { kind: 'sweep' | 'mean' | 'single'; sweep_index?: number; time: number[]; values: number[] }[]
}

interface Props {
  backendUrl: string
}

/**
 * Stacked-layout live preview — one uPlot instance per y-axis,
 * stacked vertically with shared x. Used when ``panelLayout ===
 * 'stacked'`` and there are ≥ 2 axes. Mirrors the matplotlib
 * exporter: scalebars on each panel (x bar only on the bottom),
 * legend per panel, height ratios driven by ``height_weight``.
 *
 * This is intentionally a sibling of ``PreviewPanel`` rather than a
 * mode inside it — keeps the overlay path unchanged while we
 * iterate on stacking. Same render-data endpoint feeds both.
 */
export function StackedPreview({ backendUrl }: Props) {
  const items = useTraceExportStore((s) => s.items)
  const seriesCfgs = useTraceExportStore((s) => s.seriesCfgs)
  const axes = useTraceExportStore((s) => s.axes)
  const axisStyle = useTraceExportStore((s) => s.axisStyle)
  const scalebar = useTraceExportStore((s) => s.scalebar)
  const legend = useTraceExportStore((s) => s.legend)

  const [data, setData] = useState<RenderItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reqIdRef = useRef(0)

  const payloadKey = useMemo(() => {
    const slim = items.map(({ y_offset: _y, ...rest }) => rest)
    return JSON.stringify({ items: slim, seriesCfgs })
  }, [items, seriesCfgs])

  useEffect(() => {
    if (items.length === 0) { setData([]); setError(null); return }
    const reqId = ++reqIdRef.current
    const t = setTimeout(async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/trace_export/render_data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: items.map((i) => ({
              id: i.id,
              file_path: i.file_path,
              group: i.group, series: i.series, trace: i.trace,
              sweeps: i.sweeps,
              show_individuals: i.show_individuals,
              show_mean: i.show_mean,
              style: i.style,
              x_offset: i.x_offset,
              y_offset: i.y_offset,
              x_range: i.x_range,
              axis_id: i.axis_id,
              display_name: i.display_name,
            })),
            series_cfgs: seriesCfgs,
            decim_max_points: 8000,
          }),
        })
        if (reqId !== reqIdRef.current) return
        if (!resp.ok) {
          setError(`Render failed: ${resp.status}`)
          setData(null)
          return
        }
        const json = await resp.json()
        setError(null)
        setData(json.items as RenderItem[])
      } catch (err) {
        if (reqId !== reqIdRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }, 80)
    return () => clearTimeout(t)
  }, [backendUrl, payloadKey, items, seriesCfgs])

  // ----- Per-panel uPlot instances --------------------------------------
  //
  // We hold one uPlot per axis in a Map keyed by axis id. The build
  // effect rebuilds them all whenever data / axes / scalebar / legend
  // changes (rebuild-on-data pattern). x-sync between instances is
  // routed through ``currentViewRef.ranges['x']`` + a setScale hook
  // that mirrors x-changes to siblings (debounced one frame to avoid
  // recursive setScale storms).
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const plotRefs = useRef<Map<string, uPlot>>(new Map())
  const resetViewRef = useRef<(() => void) | null>(null)

  // R = fit
  useEffect(() => {
    const onFit = () => resetViewRef.current?.()
    window.addEventListener('trace-export-fit', onFit as EventListener)
    return () => window.removeEventListener('trace-export-fit', onFit as EventListener)
  }, [])

  useEffect(() => {
    // Tear down everything first.
    plotRefs.current.forEach((u) => u.destroy())
    plotRefs.current.clear()

    if (!data || data.length === 0) return

    // Index data by axis id for cheap lookups during rebuild.
    const dataByAxis = new Map<string, { item: TraceItem; sub: RenderItem['series'][number] }[]>()
    for (const item of items) {
      const dItem = data.find((d) => d.id === item.id)
      if (!dItem) continue
      const list = dataByAxis.get(item.axis_id) ?? []
      for (const s of dItem.series) list.push({ item, sub: s })
      dataByAxis.set(item.axis_id, list)
    }

    // Compute the shared x-data envelope (drives auto-fit + range
    // checks). Take the longest time array we encounter — same trick
    // as the overlay PreviewPanel.
    let xRef: number[] | null = null
    for (const list of dataByAxis.values()) {
      for (const { sub } of list) {
        if (!xRef || sub.time.length > xRef.length) xRef = sub.time
      }
    }
    if (!xRef || xRef.length === 0) return
    const xDataMin = xRef[0]
    const xDataMax = xRef[xRef.length - 1]

    // Drop stale saved x-range if it no longer overlaps.
    {
      const saved = currentViewRef.ranges['x']
      if (saved && (saved.max < xDataMin || saved.min > xDataMax)) {
        delete currentViewRef.ranges['x']
      }
    }

    function interp(srcT: number[], srcV: number[], targetT: number[]): number[] {
      const out = new Array(targetT.length).fill(NaN)
      let j = 0
      for (let i = 0; i < targetT.length; i++) {
        const t = targetT[i]
        while (j < srcT.length - 1 && srcT[j + 1] < t) j++
        if (t < srcT[0] || t > srcT[srcT.length - 1]) continue
        const t0 = srcT[j], t1 = srcT[j + 1] ?? t0
        const v0 = srcV[j], v1 = srcV[j + 1] ?? v0
        if (t1 === t0) out[i] = v0
        else out[i] = v0 + (v1 - v0) * ((t - t0) / (t1 - t0))
      }
      return out
    }

    // Track which series index in each plot belongs to which trace
    // item — needed by the trace-grab handler below.
    const seriesItemIdMaps = new Map<string, Record<number, string>>()

    // Build one uPlot per axis.
    for (let axisIdx = 0; axisIdx < axes.length; axisIdx++) {
      const axis = axes[axisIdx]
      const list = dataByAxis.get(axis.id) ?? []
      const el = containerRefs.current.get(axis.id)
      if (!el) continue

      // Series payload for this axis only.
      const rendered: { name: string; itemId: string; v: number[]; color: string; weight: number; alpha: number; dash: string }[] = []
      for (const { item, sub } of list) {
        const isMean = sub.kind === 'mean'
        const isInd = sub.kind === 'sweep'
        const color = isMean ? item.style.mean_color : item.style.color
        const weight = isMean ? item.style.mean_weight : item.style.weight
        const dash = isMean ? item.style.mean_dash : item.style.dash
        const alpha = isMean
          ? item.style.mean_alpha
          : isInd ? item.style.individuals_alpha : item.style.alpha
        const yOff = item.y_offset
        const offsetVals = yOff !== 0
          ? sub.values.map((v) => (Number.isFinite(v) ? v + yOff : v))
          : sub.values
        const aligned = sub.time === xRef
          ? offsetVals
          : interp(sub.time, offsetVals, xRef)
        rendered.push({
          name: `${item.label}${isMean ? ' (mean)' : isInd ? ` sw${(sub.sweep_index ?? 0) + 1}` : ''}`,
          itemId: item.id,
          v: aligned,
          color, weight, alpha, dash,
        })
      }

      if (rendered.length === 0) continue

      // y-data envelope per axis, used to drop stale saved y-ranges.
      let yLo = Infinity, yHi = -Infinity
      for (const r of rendered) for (const v of r.v) {
        if (v == null || !Number.isFinite(v)) continue
        if (v < yLo) yLo = v
        if (v > yHi) yHi = v
      }
      const savedY = currentViewRef.ranges[axis.id]
      if (savedY && Number.isFinite(yLo) && (savedY.max < yLo || savedY.min > yHi)) {
        delete currentViewRef.ranges[axis.id]
      }

      const manualMin = !axis.auto_limits ? axis.min : null
      const manualMax = !axis.auto_limits ? axis.max : null

      const isBottom = axisIdx === axes.length - 1
      const seriesIdMap: Record<number, string> = {}
      for (let i = 0; i < rendered.length; i++) seriesIdMap[i + 1] = rendered[i].itemId
      seriesItemIdMaps.set(axis.id, seriesIdMap)

      const showScalebars = axisStyle === 'scalebars' && scalebar.enabled

      const u = new uPlot({
        width: el.clientWidth || 600,
        height: el.clientHeight || 200,
        cursor: { drag: { x: false, y: false } },
        scales: {
          x: {
            time: false,
            range: (_self, dMin, dMax) => {
              const saved = currentViewRef.ranges['x']
              if (saved) return [saved.min, saved.max] as [number, number]
              return [dMin, dMax] as [number, number]
            },
          },
          [axis.id]: {
            range: (_self, dMin, dMax) => {
              // Live drag/zoom wins. Manual limits act as the
              // initial seed when there's no live range yet, so the
              // user can still drag from manual values once they're
              // set. ``updateAxis`` clears the live range on manual-
              // limits edits so freshly-typed numbers take effect.
              const cur = currentViewRef.ranges[axis.id]
              if (cur) return [cur.min, cur.max] as [number, number]
              if (manualMin != null && manualMax != null) {
                return [manualMin, manualMax] as [number, number]
              }
              const span = dMax - dMin
              const pad = span > 0 ? span * 0.05 : 1
              return [dMin - pad, dMax + pad] as [number, number]
            },
          },
        },
        axes: axisStyle === 'axes'
          ? [
              {
                stroke: 'var(--text-primary)',
                show: isBottom,  // x-axis labels only on the bottom panel
                label: isBottom ? 'Time (s)' : undefined,
              } as any,
              {
                stroke: 'var(--text-primary)',
                scale: axis.id,
                label: axis.unit ? `${axis.label || axis.unit} (${axis.unit})` : axis.label,
                side: 3,
              } as any,
            ]
          : [
              { show: false },
              { scale: axis.id, show: false } as any,
            ],
        series: [
          { label: 'time' },
          ...rendered.map((r) => ({
            label: r.name,
            stroke: r.color,
            width: r.weight,
            scale: axis.id,
            dash: r.dash ? r.dash.split(',').map((n) => parseFloat(n)) : undefined,
            alpha: r.alpha,
          } as any)),
        ],
        hooks: {
          setScale: [
            (self, key) => {
              const s = self.scales[key]
              if (s && s.min != null && s.max != null) {
                currentViewRef.ranges[key] = { min: s.min as number, max: s.max as number }
                // Mirror x changes to other panels via setScale.
                if (key === 'x') {
                  plotRefs.current.forEach((other, otherId) => {
                    if (otherId === axis.id) return
                    const sx = other.scales.x
                    if (sx.min !== s.min || sx.max !== s.max) {
                      other.setScale('x', { min: s.min as number, max: s.max as number })
                    }
                  })
                }
              }
            },
          ],
          ...(showScalebars ? {
            // Bottom panel gets X+Y bars. Top panels get Y only.
            draw: [makeScalebarDrawHook({
              cfg: { ...scalebar, ...(isBottom ? {} : { x_value: -1 }) },
              axes: [axis],
            })],
          } : {}),
        },
      }, [xRef, ...rendered.map((r) => r.v)] as any, el)

      plotRefs.current.set(axis.id, u)

      // Seed ref so the export modal can match the live view.
      const sx = u.scales.x, sy = u.scales[axis.id]
      if (sx?.min != null && sx?.max != null) currentViewRef.ranges['x'] = { min: sx.min as number, max: sx.max as number }
      if (sy?.min != null && sy?.max != null) currentViewRef.ranges[axis.id] = { min: sy.min as number, max: sy.max as number }

      // Attach pointer + wheel handlers to .u-over.
      const over = el.querySelector<HTMLDivElement>('.u-over')
      if (over) {
        const onWheel = (ev: WheelEvent) => {
          ev.preventDefault()
          const rect = over.getBoundingClientRect()
          const cssX = ev.clientX - rect.left
          const cssY = ev.clientY - rect.top
          const factor = ev.deltaY > 0 ? 1.176 : 0.85
          if (ev.altKey) {
            const s = u.scales[axis.id]
            if (s.min == null || s.max == null) return
            const anchor = u.posToVal(cssY, axis.id)
            if (!Number.isFinite(anchor)) return
            const lo = anchor - (anchor - (s.min as number)) * factor
            const hi = anchor + ((s.max as number) - anchor) * factor
            currentViewRef.ranges[axis.id] = { min: lo, max: hi }
            u.setScale(axis.id, { min: lo, max: hi })
          } else {
            const s = u.scales.x
            if (s.min == null || s.max == null) return
            const anchor = u.posToVal(cssX, 'x')
            if (!Number.isFinite(anchor)) return
            const lo = anchor - (anchor - (s.min as number)) * factor
            const hi = anchor + ((s.max as number) - anchor) * factor
            currentViewRef.ranges['x'] = { min: lo, max: hi }
            u.setScale('x', { min: lo, max: hi })
          }
        }
        over.addEventListener('wheel', onWheel, { passive: false })

        type DragState =
          | {
              kind: 'trace';
              itemId: string;
              startY: number;
              startOffset: number;
              pxPerY: number;
              /** lastClientY captured by onMove so onUp can compute the
               *  final delta without listening for it itself. */
              lastClientY: number;
              /** Snapshot of the per-plot data arrays for series that
               *  belong to the dragged item — keyed by axisId then by
               *  series index. Used to redraw with the live offset
               *  delta applied without rebuilding the plot, which
               *  would destroy the pointer capture and abort the drag. */
              snapshots: Map<string, Map<number, number[]>>;
            }
          | { kind: 'pan'; startX: number; startY: number; xMin: number; xMax: number; yMin: number; yMax: number }
        let drag: DragState | null = null

        const pickItem = (cssX: number, cssY: number): TraceItem | null => {
          const tVal = u.posToVal(cssX, 'x')
          if (!Number.isFinite(tVal)) return null
          const xData = u.data[0] as number[]
          if (!xData?.length) return null
          let lo2 = 0, hi2 = xData.length - 1
          while (lo2 < hi2) {
            const mid = (lo2 + hi2) >> 1
            if (xData[mid] < tVal) lo2 = mid + 1
            else hi2 = mid
          }
          const itemById = Object.fromEntries(items.map((i) => [i.id, i]))
          const cands = [Math.max(0, lo2 - 1), lo2, Math.min(xData.length - 1, lo2 + 1)]
          let best: TraceItem | null = null
          let bestDist = Infinity
          for (let i = 1; i < u.series.length; i++) {
            const s = u.series[i] as any
            const arr = u.data[i] as (number | null)[] | undefined
            const itemId = seriesIdMap[i]
            const item = itemId ? itemById[itemId] : undefined
            if (!arr || !s || !item) continue
            for (const idx of cands) {
              const v = arr[idx]
              if (v == null || !Number.isFinite(v)) continue
              const yPx = u.valToPos(v as number, s.scale ?? axis.id, false)
              const d = Math.abs(yPx - cssY)
              if (d < bestDist) { bestDist = d; best = item }
            }
          }
          return bestDist <= 12 ? best : null
        }

        const onDown = (ev: PointerEvent) => {
          if (ev.button !== 0 && ev.button !== 1) return
          const rect = over.getBoundingClientRect()
          const cssX = ev.clientX - rect.left
          const cssY = ev.clientY - rect.top
          const wantsPan = ev.metaKey || ev.ctrlKey || ev.button === 1
          if (!wantsPan) {
            const hit = pickItem(cssX, cssY)
            if (hit) {
              const ax = u.scales[axis.id]
              if (ax.min == null || ax.max == null) return
              const yRange = (ax.max as number) - (ax.min as number)
              const h = u.bbox.height / (window.devicePixelRatio || 1)
              // Snapshot the current data for every series belonging
              // to this item across every panel — onMove rewrites
              // those arrays in place via u.setData, leaving the
              // store untouched until pointerup. This avoids the
              // per-mousemove plot rebuild that was killing pointer
              // capture and aborting the drag.
              const snapshots = new Map<string, Map<number, number[]>>()
              plotRefs.current.forEach((plot, axisId) => {
                const seriesMap = seriesItemIdMaps.get(axisId)
                if (!seriesMap) return
                const perSeries = new Map<number, number[]>()
                for (const [idxStr, itemId] of Object.entries(seriesMap)) {
                  if (itemId !== hit.id) continue
                  const idx = Number(idxStr)
                  const arr = plot.data[idx] as (number | null)[] | undefined
                  if (!arr) continue
                  perSeries.set(idx, Array.from(arr) as number[])
                }
                if (perSeries.size > 0) snapshots.set(axisId, perSeries)
              })
              drag = {
                kind: 'trace', itemId: hit.id,
                startY: ev.clientY,
                startOffset: hit.y_offset,
                pxPerY: h / yRange,
                lastClientY: ev.clientY,
                snapshots,
              }
              over.setPointerCapture(ev.pointerId)
              over.style.cursor = 'ns-resize'
              return
            }
          }
          const xs = u.scales.x, ys = u.scales[axis.id]
          if (xs.min == null || xs.max == null || ys.min == null || ys.max == null) return
          drag = {
            kind: 'pan',
            startX: ev.clientX, startY: ev.clientY,
            xMin: xs.min as number, xMax: xs.max as number,
            yMin: ys.min as number, yMax: ys.max as number,
          }
          over.setPointerCapture(ev.pointerId)
          over.style.cursor = 'grabbing'
        }
        const onMove = (ev: PointerEvent) => {
          if (!drag) return
          if (drag.kind === 'trace') {
            drag.lastClientY = ev.clientY
            const dyPx = ev.clientY - drag.startY
            const delta = -dyPx / drag.pxPerY  // shift from start, in data units
            // Re-write each plot's data arrays from the snapshot,
            // adding the live delta. Skips the auto-rescale via
            // setData(_, false) so the user's pan / zoom on Y stays
            // put.
            drag.snapshots.forEach((perSeries, axisId) => {
              const plot = plotRefs.current.get(axisId)
              if (!plot) return
              const newData: any[] = [plot.data[0]]
              for (let i = 1; i < plot.data.length; i++) {
                const base = perSeries.get(i)
                if (base) {
                  newData.push(base.map((v) => Number.isFinite(v) ? v + delta : v))
                } else {
                  newData.push(plot.data[i])
                }
              }
              plot.setData(newData as any, false)
              // Force a fresh path build so the new offset paints
              // immediately. setData alone caches the path on
              // unchanged scales — fine for static updates, not
              // for live dragging.
              plot.redraw(true)
            })
            return
          }
          const bboxW = u.bbox.width / (window.devicePixelRatio || 1)
          const bboxH = u.bbox.height / (window.devicePixelRatio || 1)
          const dxPx = ev.clientX - drag.startX
          const dyPx = ev.clientY - drag.startY
          const xRange = drag.xMax - drag.xMin
          const xShift = -(dxPx / bboxW) * xRange
          const yRange = drag.yMax - drag.yMin
          const yShift = (dyPx / bboxH) * yRange
          const newXMin = drag.xMin + xShift
          const newXMax = drag.xMax + xShift
          currentViewRef.ranges['x'] = { min: newXMin, max: newXMax }
          u.setScale('x', { min: newXMin, max: newXMax })
          const newYMin = drag.yMin + yShift
          const newYMax = drag.yMax + yShift
          currentViewRef.ranges[axis.id] = { min: newYMin, max: newYMax }
          u.setScale(axis.id, { min: newYMin, max: newYMax })
        }
        const onUp = (ev: PointerEvent) => {
          if (!drag) return
          // Commit the final y_offset to the store. The store
          // mutation will re-fire the rebuild useEffect, but since
          // the drag has ended there's no pointer capture to lose.
          if (drag.kind === 'trace') {
            const dyPx = drag.lastClientY - drag.startY
            const dyData = -dyPx / drag.pxPerY
            if (dyData !== 0) {
              useTraceExportStore.getState().updateItem(drag.itemId, {
                y_offset: drag.startOffset + dyData,
              })
            }
          }
          drag = null
          try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
          over.style.cursor = ''
        }
        over.addEventListener('pointerdown', onDown)
        over.addEventListener('pointermove', onMove)
        over.addEventListener('pointerup', onUp)
        over.addEventListener('pointercancel', onUp)
      }
    }

    // Resize observer per panel — keep each uPlot fitted.
    const ros: ResizeObserver[] = []
    plotRefs.current.forEach((u, aid) => {
      const el = containerRefs.current.get(aid)
      if (!el) return
      const ro = new ResizeObserver(() => {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      })
      ro.observe(el)
      ros.push(ro)
    })

    // resetView: drop saved ranges, auto-fit each panel.
    resetViewRef.current = () => {
      currentViewRef.ranges = {}
      plotRefs.current.forEach((u, aid) => {
        const xData = u.data[0] as number[] | undefined
        if (xData && xData.length) u.setScale('x', { min: xData[0], max: xData[xData.length - 1] })
        let lo = Infinity, hi = -Infinity
        for (let i = 1; i < u.data.length; i++) {
          const arr = u.data[i] as (number | null)[] | undefined
          if (!arr) continue
          for (const v of arr) {
            if (v == null || !Number.isFinite(v)) continue
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
        }
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
          const pad = (hi - lo) * 0.05
          u.setScale(aid, { min: lo - pad, max: hi + pad })
        }
      })
    }

    return () => { ros.forEach((r) => r.disconnect()) }
  }, [data, axes, axisStyle, items, scalebar])

  return (
    <div style={{
      position: 'relative', height: '100%', width: '100%',
      background: 'var(--bg-primary)',
      fontFamily: 'var(--font-ui)',
      display: 'flex', flexDirection: 'column',
    }}>
      {error && (
        <div className="notice" style={{
          position: 'absolute', top: 8, left: 8, right: 8, zIndex: 5,
          background: 'var(--bg-error)', color: '#fff',
        }}>{error}</div>
      )}
      {(!data || data.length === 0) && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)',
        }}>
          {items.length === 0 ? 'Add traces to preview the figure.' : 'Computing preview…'}
        </div>
      )}
      {data && data.length > 0 && (
        <div style={{
          position: 'absolute', top: 6, right: 6, zIndex: 4,
          display: 'flex', gap: 4,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: 2,
          fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-ui)',
        }}>
          <button className="btn" onClick={() => resetViewRef.current?.()}
            title="Reset zoom (R)" style={{ padding: '2px 8px' }}>
            Fit
          </button>
          <span style={{ color: 'var(--text-muted)', alignSelf: 'center', padding: '0 4px' }}>
            wheel = X · alt+wheel = Y · cmd-drag = pan
          </span>
        </div>
      )}
      {axes.map((a) => (
        <div
          key={a.id}
          style={{ flex: `${a.height_weight} 0 0`, minHeight: 0, position: 'relative' }}
        >
          <div
            ref={(el) => {
              if (el) containerRefs.current.set(a.id, el)
              else containerRefs.current.delete(a.id)
            }}
            style={{ width: '100%', height: '100%' }}
          />
          {/* Per-panel legend */}
          {legend.enabled && (() => {
            const legendItems = items
              .filter((i) => i.axis_id === a.id)
              .filter((i) => !legend.only_named || i.display_name.trim() !== '')
              .map((i) => ({
                id: i.id,
                name: i.display_name.trim() || i.label,
                color: i.show_mean && i.sweeps.length > 1 ? i.style.mean_color : i.style.color,
              }))
            if (legendItems.length === 0) return null
            const pos = legend.position
            const ps: React.CSSProperties = {
              position: 'absolute',
              ...(pos === 'tl' && { top: 4, left: 6 }),
              ...(pos === 'tr' && { top: 4, right: 6 }),
              ...(pos === 'bl' && { bottom: 4, left: 6 }),
              ...(pos === 'br' && { bottom: 4, right: 6 }),
              ...(pos === 'outside-right' && { top: 4, right: 0 }),
            }
            return (
              <div style={{
                ...ps, zIndex: 4,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                padding: '2px 6px',
                fontSize: legend.font_size,
                fontFamily: 'var(--font-ui)',
                color: 'var(--text-primary)',
                pointerEvents: 'none',
                maxWidth: 240,
              }}>
                {legendItems.map((l) => (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-block', width: 14, height: 2, background: l.color, flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      ))}
    </div>
  )
}
