import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { TraceItem, currentViewRef, useTraceExportStore } from '../../stores/traceExportStore'
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
 * Live preview — calls /api/trace_export/render_data on every config
 * change and rebuilds the uPlot instance with the returned arrays.
 *
 * Uses the rebuild-on-data pattern (per CLAUDE.md) rather than
 * setData-in-place; we get a clean redraw with no stale-frame bugs.
 */
export function PreviewPanel({ backendUrl }: Props) {
  const items = useTraceExportStore((s) => s.items)
  const seriesCfgs = useTraceExportStore((s) => s.seriesCfgs)
  const axes = useTraceExportStore((s) => s.axes)
  const axisStyle = useTraceExportStore((s) => s.axisStyle)
  const scalebar = useTraceExportStore((s) => s.scalebar)
  const legend = useTraceExportStore((s) => s.legend)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  /** Series-index → trace item id, populated each rebuild so the
   *  drag-pick handler can resolve which trace was hit without
   *  relying on label-prefix matching (fragile if labels collide). */
  const seriesItemIdRef = useRef<Record<number, string>>({})
  /** Saved scale ranges across uPlot rebuilds — kept in the shared
   *  ``currentViewRef`` so the ExportModal can snapshot the live view
   *  at export time. Keys are scale ids ('x' or axis.id). */
  const savedRangesRef = currentViewRef
  // ``savedRangesRef.ranges`` is the actual map — we alias it as
  // ``current`` below for the existing call sites.
  /** Tracks whether the previous render had any items, so we can
   *  reset saved ranges when going from empty → first trace (avoids
   *  showing the new trace under a stale zoom from a previous edit). */
  const hadItemsRef = useRef(false)
  const [data, setData] = useState<RenderItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reqIdRef = useRef(0)

  // Snapshot the payload so we re-fetch only on actual config change.
  // y_offset is intentionally excluded — it's applied client-side in the
  // uPlot rebuild below, so dragging a trace doesn't trigger a network
  // round-trip on every mousemove.
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
              group: i.group,
              series: i.series,
              trace: i.trace,
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
    }, 80)  // debounce edits
    return () => clearTimeout(t)
  }, [backendUrl, payloadKey, items, seriesCfgs])

  // Build / rebuild uPlot whenever we have new data
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || data.length === 0) return

    // Build a single shared x-axis by unioning all series time arrays.
    // For multi-axis support we'd need multiple subplots; v1 stacks
    // values from secondary axes onto the same x but uses uPlot's
    // axis scale to render them. To keep the live preview simple we
    // normalize each series onto its own y-scale per axis_id.

    // Flatten series into uPlot format. We'll create one synthetic
    // shared time axis from the first series; others will use their
    // own time arrays interpolated onto the shared one.
    const rendered: { name: string; itemId: string; t: number[]; v: number[]; color: string; weight: number; alpha: number; dash: string; axisId: string }[] = []
    for (const item of items) {
      const dataItem = data.find((d) => d.id === item.id)
      if (!dataItem) continue
      for (const s of dataItem.series) {
        const isMean = s.kind === 'mean'
        const isIndividual = s.kind === 'sweep'
        // Mean overlay uses the dedicated mean_* style; individuals
        // (and single-sweep "single" lines) use the base style.
        const color = isMean ? item.style.mean_color : item.style.color
        const weight = isMean ? item.style.mean_weight : item.style.weight
        const dash = isMean ? item.style.mean_dash : item.style.dash
        const alpha = isMean
          ? item.style.mean_alpha
          : isIndividual
            ? item.style.individuals_alpha
            : item.style.alpha
        // Apply y_offset client-side so dragging is local-only (no
        // backend round-trip). Backend applies it on the export path.
        const yOff = item.y_offset
        const offsetValues = yOff !== 0
          ? s.values.map((v) => (Number.isFinite(v) ? v + yOff : v))
          : s.values
        rendered.push({
          name: `${item.label}${isMean ? ' (mean)' : isIndividual ? ` sw${(s.sweep_index ?? 0) + 1}` : ''}`,
          itemId: item.id,
          t: s.time,
          v: offsetValues,
          color,
          weight,
          alpha,
          dash,
          axisId: item.axis_id,
        })
      }
    }
    if (rendered.length === 0) {
      // No drawable series → keep hadItemsRef in sync with reality so
      // the next add-from-empty triggers a saved-range reset.
      hadItemsRef.current = false
      return
    }

    // Use the longest time array as the x grid; interpolate others.
    const xRef = rendered.reduce((acc, r) => (r.t.length > acc.length ? r.t : acc), rendered[0].t)
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
    const xAxis = xRef
    const ySeries = rendered.map((r) => ({
      ...r,
      values: r.t === xRef ? r.v : interp(r.t, r.v, xAxis),
    }))

    // Split y values by axis_id — uPlot scales need different scale keys.
    //
    // Two pieces of state survive a rebuild and feed into each scale's
    // ``range`` callback (called on every redraw, so we get the latest
    // value):
    //
    //  1. Manual axis limits from the FigurePanel ("Manual limits" toggle).
    //     These are absolute and override everything else for that axis.
    //  2. The user's current zoom — saved into ``savedRangesRef`` via
    //     uPlot's setScale hook below. Without this, every config edit
    //     or new trace would reset the user's wheel-zoom because uPlot
    //     auto-ranges the scale on rebuild.
    //
    // To avoid the "trace outside the view" bug when the user adds
    // traces from a recording with a totally different time range, we
    // drop a saved range whenever it no longer overlaps the new data
    // envelope. Without this, switching recordings stranded the new
    // trace offscreen until the user knew to click Fit.
    //
    // Also: when the user goes from empty → first trace, reset
    // everything. Stale ranges from a previous session (or from a
    // React-strict-mode double-mount in dev) would otherwise hide
    // the very first trace they add.
    //
    // EXCEPTION: when a session file was just loaded, ``hydrated`` is
    // set on the shared ref. We honor those restored ranges instead of
    // wiping them, then clear the flag so subsequent edits behave
    // normally.
    if (!hadItemsRef.current) {
      if (savedRangesRef.hydrated) {
        savedRangesRef.hydrated = false
      } else {
        savedRangesRef.ranges = {}
      }
    }
    hadItemsRef.current = items.length > 0
    const xDataMin = xAxis[0]
    const xDataMax = xAxis[xAxis.length - 1]
    {
      const saved = savedRangesRef.ranges['x']
      if (saved && (saved.max < xDataMin || saved.min > xDataMax)) {
        delete savedRangesRef.ranges['x']
      }
    }
    // Always attach a range callback. Two reasons to do this even
    // when there's no manual override:
    //   - it's how we keep the user's wheel-zoom across redraws.
    //     setScale writes the new range into savedRangesRef via the
    //     setScale hook, and the callback returns it on the next
    //     redraw. Without the callback, uPlot's built-in auto-range
    //     overwrites setScale on every redraw and zoom resets.
    //   - the alternative — returning [dataMin, dataMax] directly —
    //     would have NO padding, so the trace would render flush with
    //     the canvas edges. We pad the fallback the same way uPlot's
    //     defaults do (no pad on x, ~5% on y) so first paint matches
    //     the auto-range look.
    const xScale: any = {
      time: false,
      range: (_self: uPlot, dataMin: number, dataMax: number) => {
        const saved = savedRangesRef.ranges['x']
        if (saved) return [saved.min, saved.max] as [number, number]
        return [dataMin, dataMax] as [number, number]
      },
    }
    const scales: Record<string, any> = { x: xScale }
    const series: any[] = [{ label: 'time' }]
    const seriesIdMap: Record<number, string> = {}
    for (let i = 0; i < ySeries.length; i++) {
      seriesIdMap[i + 1] = ySeries[i].itemId  // +1 for the time series at index 0
    }
    seriesItemIdRef.current = seriesIdMap
    // Compute per-axis y-data envelope so we can drop stale saved
    // y-ranges when a new trace comes in with values outside the
    // previously-zoomed window.
    const yEnvelope: Record<string, [number, number]> = {}
    for (const r of ySeries) {
      let lo = Infinity, hi = -Infinity
      for (const v of r.v) {
        if (v == null || !Number.isFinite(v)) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const cur = yEnvelope[r.axisId]
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        yEnvelope[r.axisId] = cur
          ? [Math.min(cur[0], lo), Math.max(cur[1], hi)]
          : [lo, hi]
      }
    }
    for (const r of ySeries) {
      const scaleKey = r.axisId
      if (!scales[scaleKey]) {
        const axisDef = axes.find((a) => a.id === scaleKey)
        const manualMin = axisDef && !axisDef.auto_limits ? axisDef.min : null
        const manualMax = axisDef && !axisDef.auto_limits ? axisDef.max : null
        // Drop a stale saved y-range if it doesn't overlap the new
        // data envelope on this axis. Keeps switching traces from
        // stranding them offscreen.
        const env = yEnvelope[scaleKey]
        const saved = savedRangesRef.ranges[scaleKey]
        if (env && saved && (saved.max < env[0] || saved.min > env[1])) {
          delete savedRangesRef.ranges[scaleKey]
        }
        // Always attach a range callback (see x scale above for why).
        // Auto fallback pads the data extents by ~5 % so the trace has
        // breathing room on the canvas — same look as uPlot's built-in
        // auto-range.
        const yScale: any = {
          range: (_self: uPlot, dataMin: number, dataMax: number) => {
            // Live drag/zoom wins. Manual limits act as the initial
            // seed only — once the user pans, the live range takes
            // over. ``updateAxis`` clears the live range when the
            // user edits manual values so a fresh number sticks.
            const cur = savedRangesRef.ranges[scaleKey]
            if (cur) return [cur.min, cur.max] as [number, number]
            if (manualMin != null && manualMax != null) {
              return [manualMin, manualMax] as [number, number]
            }
            const span = dataMax - dataMin
            const pad = span > 0 ? span * 0.05 : 1
            return [dataMin - pad, dataMax + pad] as [number, number]
          },
        }
        scales[scaleKey] = yScale
      }
      series.push({
        label: r.name,
        stroke: r.color,
        width: r.weight,
        scale: scaleKey,
        dash: r.dash ? r.dash.split(',').map((n) => parseFloat(n)) : undefined,
        alpha: r.alpha,
      })
    }

    const showScalebars = axisStyle === 'scalebars' && scalebar.enabled
    const u = new uPlot({
      width: el.clientWidth || 600,
      height: el.clientHeight || 400,
      // We disable uPlot's default drag-to-zoom so left-click is free
      // for trace selection / vertical drag (vector-design metaphor).
      // Wheel handles all zooming, and pan is cmd/space + drag below.
      cursor: { drag: { x: false, y: false } },
      scales,
      axes: axisStyle === 'axes'
        ? [
            { stroke: 'var(--text-primary)', label: 'Time (s)' },
            ...axes.map((a) => ({
              stroke: 'var(--text-primary)',
              scale: a.id,
              label: a.unit ? `${a.label || a.unit} (${a.unit})` : a.label,
              side: a.side === 'left' ? 3 : 1,
            } as any)),
          ]
        : [
            { show: false },
            ...axes.map((a) => ({ scale: a.id, show: false } as any)),
          ],
      series,
      hooks: {
        // setScale fires after every zoom/pan change. Write the new
        // range into our ref so the next rebuild reads it back via the
        // scale's range() callback.
        setScale: [
          (self, key) => {
            const s = self.scales[key]
            if (s && s.min != null && s.max != null) {
              savedRangesRef.ranges[key] = { min: s.min as number, max: s.max as number }
            }
          },
        ],
        ...(showScalebars ? {
          draw: [makeScalebarDrawHook({ cfg: scalebar, axes })],
        } : {}),
      },
    }, [xAxis, ...ySeries.map((r) => r.values)] as any, el)
    plotRef.current = u

    // Seed currentViewRef from the freshly computed scale ranges so
    // the ExportModal can match the live preview EXACTLY even when
    // the user hasn't wheel-zoomed yet. Without this, the matplotlib
    // exporter would auto-range whichever scale the user never
    // touched, and matplotlib's auto-padding doesn't always match
    // uPlot's (matplotlib snaps to "nice" tick-friendly bounds, uPlot
    // uses an exact 5 % pad).
    for (const key of ['x', ...axes.map((a) => a.id)]) {
      const s = u.scales[key]
      if (s && s.min != null && s.max != null) {
        savedRangesRef.ranges[key] = { min: s.min as number, max: s.max as number }
      }
    }

    // ----- Pointer + wheel handling ---------------------------------
    //
    // Same pattern as FPspWindow (and other analysis windows): attach
    // listeners to ``.u-over`` (uPlot's input overlay div) with
    // ``passive: false`` so we can preventDefault on wheel. React's
    // synthetic onWheel can't reliably preventDefault inside an
    // Electron renderer once the event has bubbled past the canvas.
    //
    // Wheel       — zoom X anchored at cursor.
    // Alt + wheel — zoom Y on every axis (anchored at cursor).
    // Plain drag  — if cursor is on a trace, drag that trace's
    //               y_offset; otherwise pan the canvas.
    // Cmd/Ctrl/middle-mouse drag — always pan (no trace-grab).
    const over = el.querySelector<HTMLDivElement>('.u-over')
    if (over) {
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault()
        const rect = over.getBoundingClientRect()
        const cssX = ev.clientX - rect.left
        const cssY = ev.clientY - rect.top
        const factor = ev.deltaY > 0 ? 1.176 : 0.85
        if (ev.altKey) {
          for (const a of axes) {
            const s = u.scales[a.id]
            if (s.min == null || s.max == null) continue
            const anchor = u.posToVal(cssY, a.id)
            if (!Number.isFinite(anchor)) continue
            const lo = anchor - (anchor - (s.min as number)) * factor
            const hi = anchor + ((s.max as number) - anchor) * factor
            savedRangesRef.ranges[a.id] = { min: lo, max: hi }
            u.setScale(a.id, { min: lo, max: hi })
          }
        } else {
          const s = u.scales.x
          if (s.min == null || s.max == null) return
          const anchor = u.posToVal(cssX, 'x')
          if (!Number.isFinite(anchor)) return
          const lo = anchor - (anchor - (s.min as number)) * factor
          const hi = anchor + ((s.max as number) - anchor) * factor
          savedRangesRef.ranges['x'] = { min: lo, max: hi }
          u.setScale('x', { min: lo, max: hi })
        }
      }
      over.addEventListener('wheel', onWheel, { passive: false })

      // ---- Drag handling (trace-grab vs pan) ----
      type DragState =
        | {
            kind: 'trace';
            itemId: string;
            startClientY: number;
            startOffset: number;
            pxPerY: number;
            lastClientY: number;
            /** Snapshot of the data arrays for series owned by this
             *  item — keyed by series index. onMove rewrites these
             *  via u.setData with the live offset delta applied so
             *  the plot doesn't have to rebuild (which would tear
             *  down pointer capture and abort the drag). */
            snapshot: Map<number, number[]>;
          }
        | { kind: 'pan'; startClientX: number; startClientY: number; xMin: number; xMax: number; perAxisY: Record<string, [number, number]> }
      let drag: DragState | null = null

      const itemsSnapshot = items
      const pickItemAt = (cssX: number, cssY: number): TraceItem | null => {
        if (itemsSnapshot.length === 0) return null
        const tVal = u.posToVal(cssX, 'x')
        if (!Number.isFinite(tVal)) return null
        const xData = u.data[0] as number[]
        if (!xData?.length) return null
        let lo = 0, hi = xData.length - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (xData[mid] < tVal) lo = mid + 1
          else hi = mid
        }
        const itemById = Object.fromEntries(itemsSnapshot.map((i) => [i.id, i]))
        const candidates = [Math.max(0, lo - 1), lo, Math.min(xData.length - 1, lo + 1)]
        let best: TraceItem | null = null
        let bestDist = Infinity
        for (let i = 1; i < u.series.length; i++) {
          const s = u.series[i] as any
          const arr = u.data[i] as (number | null)[] | undefined
          const itemId = seriesItemIdRef.current[i]
          const item = itemId ? itemById[itemId] : undefined
          if (!arr || !s || !item) continue
          for (const idx of candidates) {
            const v = arr[idx]
            if (v == null || !Number.isFinite(v)) continue
            const yPx = u.valToPos(v as number, s.scale ?? 'y0', false)
            const d = Math.abs(yPx - cssY)
            if (d < bestDist) { bestDist = d; best = item }
          }
        }
        return bestDist <= 12 ? best : null
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (ev.button !== 0 && ev.button !== 1) return
        const rect = over.getBoundingClientRect()
        const cssX = ev.clientX - rect.left
        const cssY = ev.clientY - rect.top
        const wantsPan = ev.metaKey || ev.ctrlKey || ev.button === 1
        if (!wantsPan) {
          const hit = pickItemAt(cssX, cssY)
          if (hit) {
            const ax = u.scales[hit.axis_id]
            if (ax.min == null || ax.max == null) return
            const yRange = (ax.max as number) - (ax.min as number)
            const h = u.bbox.height / (window.devicePixelRatio || 1)
            // Snapshot every series belonging to this item before
            // the drag begins. onMove rewrites these via setData
            // and the store is only updated on pointerup.
            const snapshot = new Map<number, number[]>()
            for (let i = 1; i < u.series.length; i++) {
              if (seriesItemIdRef.current[i] !== hit.id) continue
              const arr = u.data[i] as (number | null)[] | undefined
              if (arr) snapshot.set(i, Array.from(arr) as number[])
            }
            drag = {
              kind: 'trace',
              itemId: hit.id,
              startClientY: ev.clientY,
              startOffset: hit.y_offset,
              pxPerY: h / yRange,
              lastClientY: ev.clientY,
              snapshot,
            }
            over.setPointerCapture(ev.pointerId)
            over.style.cursor = 'ns-resize'
            return
          }
        }
        // Pan
        const xs = u.scales.x
        if (xs.min == null || xs.max == null) return
        const perAxisY: Record<string, [number, number]> = {}
        for (const a of axes) {
          const ys = u.scales[a.id]
          if (ys && ys.min != null && ys.max != null) {
            perAxisY[a.id] = [ys.min as number, ys.max as number]
          }
        }
        drag = {
          kind: 'pan',
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          xMin: xs.min as number,
          xMax: xs.max as number,
          perAxisY,
        }
        over.setPointerCapture(ev.pointerId)
        over.style.cursor = 'grabbing'
      }

      const onPointerMove = (ev: PointerEvent) => {
        if (!drag) return
        if (drag.kind === 'trace') {
          drag.lastClientY = ev.clientY
          const dyPx = ev.clientY - drag.startClientY
          const delta = -dyPx / drag.pxPerY
          // Rewrite the dragged item's series in place with the live
          // offset delta. Skip auto-rescale (false) so the user's
          // current Y zoom isn't reset on every mousemove.
          const newData: any[] = [u.data[0]]
          for (let i = 1; i < u.data.length; i++) {
            const base = drag.snapshot.get(i)
            if (base) {
              newData.push(base.map((v) => Number.isFinite(v) ? v + delta : v))
            } else {
              newData.push(u.data[i])
            }
          }
          u.setData(newData as any, false)
          // Force the path cache to rebuild — without this uPlot
          // can keep painting the previous snapshot during the drag.
          u.redraw(true)
          return
        }
        // pan
        const bboxW = u.bbox.width / (window.devicePixelRatio || 1)
        const bboxH = u.bbox.height / (window.devicePixelRatio || 1)
        const dxPx = ev.clientX - drag.startClientX
        const dyPx = ev.clientY - drag.startClientY
        const xRange = drag.xMax - drag.xMin
        const xShift = -(dxPx / bboxW) * xRange
        const newXMin = drag.xMin + xShift
        const newXMax = drag.xMax + xShift
        savedRangesRef.ranges['x'] = { min: newXMin, max: newXMax }
        u.setScale('x', { min: newXMin, max: newXMax })
        for (const [aid, [yLo, yHi]] of Object.entries(drag.perAxisY)) {
          const yRange = yHi - yLo
          const yShift = (dyPx / bboxH) * yRange
          const newYMin = yLo + yShift
          const newYMax = yHi + yShift
          savedRangesRef.ranges[aid] = { min: newYMin, max: newYMax }
          u.setScale(aid, { min: newYMin, max: newYMax })
        }
      }

      const onPointerUp = (ev: PointerEvent) => {
        if (!drag) return
        // Commit the final y_offset to the store. The natural
        // rebuild that follows is fine — the drag has ended so
        // there's no pointer capture to lose.
        if (drag.kind === 'trace') {
          const dyPx = drag.lastClientY - drag.startClientY
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

      over.addEventListener('pointerdown', onPointerDown)
      over.addEventListener('pointermove', onPointerMove)
      over.addEventListener('pointerup', onPointerUp)
      over.addEventListener('pointercancel', onPointerUp)
    }

    // Resize observer keeps the plot fitting the panel
    const ro = new ResizeObserver(() => {
      if (!plotRef.current || !el) return
      plotRef.current.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [data, axes, axisStyle, items, scalebar])

  // Listen for the keyboard shortcut from the parent — pressing R
  // anywhere outside an input fires ``trace-export-fit`` on window.
  useEffect(() => {
    const onFit = () => {
      // resetView is defined just below; this closure captures the
      // latest `axes` because the listener is re-attached when axes
      // change.
      resetViewRef.current?.()
    }
    window.addEventListener('trace-export-fit', onFit as EventListener)
    return () => window.removeEventListener('trace-export-fit', onFit as EventListener)
  }, [])
  // Hold the latest resetView in a ref so the keydown listener (defined
  // once above) calls the freshest closure with current ``axes``.
  const resetViewRef = useRef<(() => void) | null>(null)

  const resetView = useCallback(() => {
    const u = plotRef.current
    if (!u) return
    // Drop saved ranges so the scale.range callbacks fall through to
    // their auto path on the next redraw — otherwise the saved range
    // would immediately overwrite our setScale below.
    savedRangesRef.ranges = {}
    // Auto-range every scale by re-applying its data envelope.
    const xData = u.data[0] as number[] | undefined
    if (xData && xData.length) u.setScale('x', { min: xData[0], max: xData[xData.length - 1] })
    for (const a of axes) {
      let lo = Infinity, hi = -Infinity
      // Loop series belonging to this axis. uPlot's series array is
      // index-aligned with our build order, but axis_id lives in
      // ``items``; easiest is to scan all data columns and clamp.
      for (let i = 1; i < u.data.length; i++) {
        const arr = u.data[i] as (number | null)[] | undefined
        if (!arr) continue
        const s = u.series[i] as any
        if (s?.scale !== a.id) continue
        for (const v of arr) {
          if (v == null || !Number.isFinite(v)) continue
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
        const pad = (hi - lo) * 0.05
        u.setScale(a.id, { min: lo - pad, max: hi + pad })
      }
    }
  }, [axes])

  // Keep the keyboard-shortcut path pointed at the freshest resetView.
  useEffect(() => { resetViewRef.current = resetView }, [resetView])

  return (
    <div style={{
      position: 'relative', height: '100%', width: '100%',
      // Main viewer surface — primary background, matching the
      // central pane convention used by other analysis windows.
      background: 'var(--bg-primary)',
      fontFamily: 'var(--font-ui)',
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
      {/* Live legend — HTML overlay over the canvas. Position mirrors
          the matplotlib export's legend so the live preview shows the
          user roughly the same composition they'll get on disk. */}
      {legend.enabled && (() => {
        const legendItems = items
          .filter((i) => !legend.only_named || i.display_name.trim() !== '')
          .map((i) => ({
            id: i.id,
            name: i.display_name.trim() || i.label,
            color: i.show_mean && i.sweeps.length > 1 ? i.style.mean_color : i.style.color,
          }))
        if (legendItems.length === 0) return null
        const pos = legend.position
        const positionStyle: React.CSSProperties = {
          position: 'absolute',
          ...(pos === 'tl' && { top: 30, left: 12 }),
          ...(pos === 'tr' && { top: 30, right: 12 }),
          ...(pos === 'bl' && { bottom: 12, left: 12 }),
          ...(pos === 'br' && { bottom: 12, right: 12 }),
          ...(pos === 'outside-right' && { top: 30, right: 4 }),
        }
        return (
          <div
            style={{
              ...positionStyle,
              zIndex: 4,
              // Theme-aware background instead of hardcoded white so
              // the legend reads in both light and dark themes.
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              padding: '4px 8px',
              fontSize: legend.font_size,
              fontFamily: 'var(--font-ui)',
              color: 'var(--text-primary)',
              pointerEvents: 'none',
              maxWidth: 240,
            }}
          >
            {legendItems.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  display: 'inline-block', width: 14, height: 2,
                  background: l.color, flexShrink: 0,
                }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
              </div>
            ))}
          </div>
        )
      })()}

      {/* Floating zoom controls — small, non-intrusive, mirrors a
          "page" toolbar in vector-design apps. */}
      {data && data.length > 0 && (
        <div style={{
          position: 'absolute', top: 6, right: 6, zIndex: 4,
          display: 'flex', gap: 4,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: 2,
          fontSize: 'var(--font-size-xs)',
          fontFamily: 'var(--font-ui)',
        }}>
          <button className="btn" onClick={resetView} title="Reset zoom (Fit)" style={{ padding: '2px 8px' }}>
            Fit
          </button>
          <span style={{ color: 'var(--text-muted)', alignSelf: 'center', padding: '0 4px' }}>
            wheel = zoom · alt+wheel = Y · cmd-drag = pan
          </span>
        </div>
      )}
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}
