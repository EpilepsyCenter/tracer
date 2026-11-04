import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, CursorPositions, STIMULUS_TRACE_INDEX, stackedFor, type BurstRecord } from '../../stores/appStore'
import { NoteFlags, NoteEditor, SweepNoteChips, NotesMenu, NoteDraft, NoteFlagPos } from './TraceNotes'
import type { TraceNote } from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { ViewportBar, ViewportSlider } from './ViewportBar'
import { usePlotMenu } from '../common/PlotMenu'
import { Welcome } from '../Welcome/Welcome'
import { sampleTraceYAt } from '../../utils/sampleTraceY'
import { channelColorVar } from '../../utils/channelColors'
import * as lanes from './lanes'

// Channel colours — shared with the Traces dropdown.
function colorForChannel(idx: number): string {
  return cssVar(channelColorVar(idx))
}

type DragEdge =
  | 'baselineStart' | 'baselineEnd'
  | 'peakStart' | 'peakEnd'
  | 'fitStart' | 'fitEnd'

/** What we're dragging: a single edge, an entire region, or panning the view */
type DragTarget =
  | { kind: 'edge'; key: DragEdge }
  | { kind: 'region'; startKey: DragEdge; endKey: DragEdge; anchorVal: number; origStart: number; origEnd: number }
  | { kind: 'pan'; lastClientX: number; lastClientY: number; yScaleKey?: string }
  | null

/** Reads a CSS custom property from :root computed style */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const CURSOR_DEFS: {
  startKey: keyof CursorPositions
  endKey: keyof CursorPositions
  fillVar: string
  lineVar: string
  label: string
  visKey: 'baseline' | 'peak' | 'fit'
}[] = [
  { startKey: 'baselineStart', endKey: 'baselineEnd', fillVar: '--cursor-baseline-fill', lineVar: '--cursor-baseline', label: 'BL', visKey: 'baseline' },
  { startKey: 'peakStart', endKey: 'peakEnd', fillVar: '--cursor-peak-fill', lineVar: '--cursor-peak', label: 'PK', visKey: 'peak' },
  { startKey: 'fitStart', endKey: 'fitEnd', fillVar: '--cursor-fit-fill', lineVar: '--cursor-fit', label: 'FT', visKey: 'fit' },
]

const SNAP_PX = 8

/** Linear interpolation of (srcT, srcV) onto ``time``; null outside the
 *  source's time span. Both time arrays are ascending. */
function interpolateOnto(time: number[], srcT: Float64Array, srcV: Float64Array): (number | null)[] {
  const out: (number | null)[] = new Array(time.length).fill(null)
  const n = Math.min(srcT.length, srcV.length)
  if (n === 0) return out
  let j = 0
  for (let i = 0; i < time.length; i++) {
    const t = time[i]
    if (t < srcT[0] || t > srcT[n - 1]) continue
    while (j < n - 2 && srcT[j + 1] < t) j++
    const t0 = srcT[j], t1 = srcT[j + 1] ?? t0
    out[i] = t1 > t0 ? srcV[j] + ((t - t0) / (t1 - t0)) * (srcV[j + 1] - srcV[j]) : srcV[j]
  }
  return out
}

export function TraceViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const dragRef = useRef<DragTarget>(null)

  // Keep a mutable ref to the latest cursors so draw callbacks always see
  // current values without needing to be recreated.
  const cursorsRef = useRef<CursorPositions>(useAppStore.getState().cursors)
  const showCursorsRef = useRef<boolean>(useAppStore.getState().showCursors)
  const cursorVisRef = useRef(useAppStore.getState().cursorVisibility)
  // Burst-marker refs — drawCursors reads these on every paint without
  // rebuilding itself.
  const fieldBurstsRef = useRef(useAppStore.getState().fieldBursts)
  const currentSweepRef = useRef(useAppStore.getState().currentSweep)
  const showBurstMarkersRef = useRef(useAppStore.getState().showBurstMarkers)
  // AP-marker refs — same pattern as bursts. Drawn always when an
  // entry exists for the current group/series; toggle could be added
  // later mirroring the bursts checkbox.
  const apAnalysesRef = useRef(useAppStore.getState().apAnalyses)
  // Event-marker refs — foot / peak / decay dots for detected events
  // from the event-detection module. Same lazy-ref pattern as bursts.
  const eventsAnalysesRef = useRef(useAppStore.getState().eventsAnalyses)
  const showEventMarkersRef = useRef(useAppStore.getState().showEventMarkers)
  // Latest traceData snapshot — read from drawCursors when painting
  // counting-only (no kinetics) AP markers, so we can look up the
  // y-value at a peak time without relying on react render cycles.
  const traceDataRef = useRef(useAppStore.getState().traceData)
  // Timed notes on the sweep on screen (drawn as dashed lines + flags).
  const sweepNotesRef = useRef<TraceNote[]>([])
  /** Recorded channel index → uPlot series index of the current plot. */
  const channelSeriesRef = useRef<Record<number, number>>({})
  const showCoordinatesRef = useRef(useAppStore.getState().showCoordinates)
  const coordTooltipRef = useRef<HTMLDivElement>(null)

  // Tracks whether the CURRENT plot instance was built in Full (null viewport)
  // mode. Used in cleanup so we only persist x-range as the "Full-mode saved
  // range" when the plot actually rendered in Full mode — prevents a viewport
  // change (which flips store.viewport → null synchronously) from racing ahead
  // of the data-refetch and saving the stale windowed x-range as Full.

  const {
    traceData, cursors, setCursors,
    overlayEntries, showOverlay,
    averageTrace, showAverage,
    zoomMode,
    showCursors,
    cursorVisibility,
    sweepStimulusSegments,
    sweepStimulusUnit,
    zeroOffset,
    additionalTraces,
    currentTrace,
    currentSweep,
    fieldBursts,
    showBurstMarkers,
    apAnalyses,
    eventsAnalyses,
    showEventMarkers,
    showCoordinates,
    toggleCoordinates,
  } = useAppStore()

  // Visible-trace set for the current series — includes recorded channel
  // indices plus the stimulus sentinel. Drives which series the plot draws.
  const visibleTracesForSeries = useAppStore((s) =>
    s.getVisibleTraces(s.currentGroup, s.currentSeries),
  )

  // Current series' stimulus info, if any.
  const stimulus = useAppStore((s) => {
    if (!s.recording) return null
    return s.recording.groups[s.currentGroup]?.series[s.currentSeries]?.stimulus ?? null
  })

  // Stimulus is drawn when it's in the visible set AND there is actual
  // stimulus data to draw.
  const stimulusDataPresent =
    (sweepStimulusSegments && sweepStimulusSegments.length > 0) ||
    (!!stimulus && (stimulus.segments?.length > 0 || stimulus.pulseEnd > stimulus.pulseStart))
  const showStimulusOverlay =
    stimulusDataPresent && visibleTracesForSeries.includes(STIMULUS_TRACE_INDEX)

  // Subscribe to theme so chart rebuilds on theme/font change
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)
  // ``colorForChannel`` reads CSS vars at build time; the plot
  // doesn't auto-rebuild on theme updates so we subscribe to the
  // overrides slice and join it as a string for the dep array.
  const traceColorsKey = useThemeStore((s) => s.traceColors.join('|'))

  // Sync the refs every render
  cursorsRef.current = cursors
  showCursorsRef.current = showCursors
  cursorVisRef.current = cursorVisibility
  fieldBurstsRef.current = fieldBursts
  currentSweepRef.current = currentSweep
  showBurstMarkersRef.current = showBurstMarkers
  apAnalysesRef.current = apAnalyses
  eventsAnalysesRef.current = eventsAnalyses
  showEventMarkersRef.current = showEventMarkers
  traceDataRef.current = traceData
  showCoordinatesRef.current = showCoordinates

  // ---- Notes on the trace ----
  const notesGroup = useAppStore((s) => s.currentGroup)
  const notesSeries = useAppStore((s) => s.currentSeries)
  const notesAveraged = useAppStore((s) => s.currentAveragedSweep)
  const seriesNotes = useAppStore((s) => s.traceNotes[`${s.currentGroup}:${s.currentSeries}`])
  const sweepNotes = useMemo(
    () => (notesAveraged ? [] : (seriesNotes ?? []).filter((n) => n.sweep === currentSweep && n.time != null)),
    [seriesNotes, currentSweep, notesAveraged],
  )
  sweepNotesRef.current = sweepNotes
  const [noteFlags, setNoteFlags] = useState<NoteFlagPos[]>([])
  const [noteFlagTop, setNoteFlagTop] = useState(0)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const noteLayoutKeyRef = useRef('')
  const layoutNoteFlags = (pos: NoteFlagPos[], top: number) => {
    const key = JSON.stringify([pos, top])
    if (key === noteLayoutKeyRef.current) return
    noteLayoutKeyRef.current = key
    setNoteFlags(pos)
    setNoteFlagTop(top)
  }
  // Notes list → go to the note's sweep, scrolling a long sweep to it.
  const goToNote = async (group: number, series: number, note: TraceNote) => {
    const st = useAppStore.getState()
    await st.selectSweep(group, series, note.sweep)
    const vp = useAppStore.getState().viewport
    if (vp && note.time != null && (note.time < vp.start || note.time > vp.end)) {
      const w = vp.end - vp.start
      const start = Math.max(0, note.time - w / 2)
      useAppStore.getState().setViewport({ start, end: start + w })
    }
  }

  const [hoverCursor, setHoverCursor] = useState<string>('')

  // ================================================================
  // Draw cursor overlays on the transparent canvas.
  // Reads from refs only — no stale closures.
  // ================================================================
  function drawCursors() {
    const u = plotRef.current
    const canvas = canvasRef.current
    if (!u || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = devicePixelRatio || 1

    // Match canvas backing-store size to its CSS layout size
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr
      canvas.height = cssH * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    // uPlot bbox is in CSS pixels — use directly, no dpr division.
    const { left, top, width: pw, height: ph } = u.bbox
    const by = top / dpr
    const bh = ph / dpr
    const bx = left / dpr
    const bw = pw / dpr

    // --- Cursor overlays --- (gated by the cursors visibility toggle)
    if (showCursorsRef.current) {
    const cur = cursorsRef.current

    for (const def of CURSOR_DEFS) {
      // Skip individually hidden cursors
      if (!cursorVisRef.current[def.visKey]) continue

      const startVal = cur[def.startKey]
      const endVal = cur[def.endKey]

      const x0 = u.valToPos(startVal, 'x', true) / dpr
      const x1 = u.valToPos(endVal, 'x', true) / dpr

      if (!isFinite(x0) || !isFinite(x1)) continue

      // Filled region — read colors from CSS custom properties
      ctx.fillStyle = cssVar(def.fillVar)
      ctx.fillRect(x0, by, x1 - x0, bh)

      // Dashed vertical edge lines
      ctx.strokeStyle = cssVar(def.lineVar)
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])

      ctx.beginPath()
      ctx.moveTo(x0, by); ctx.lineTo(x0, by + bh)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(x1, by); ctx.lineTo(x1, by + bh)
      ctx.stroke()

      ctx.setLineDash([])

      // Label
      ctx.fillStyle = cssVar(def.lineVar)
      ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`
      ctx.fillText(def.label, x0 + 3, by + 12)
    }
    } // end cursors block

    // ---- Burst markers ----
    // Burst dots + baseline/threshold lines render INDEPENDENTLY of the
    // cursor-visibility toggle — they're their own layer, gated by the
    // `Bursts` checkbox in the sidebar.
    //
    // Burst records carry RAW signal y values. If zero-offset is on the
    // displayed trace has been DC-shifted by `currentZeroOffset`; markers
    // must shift by the same amount to stay visually aligned with the trace.
    if (!showBurstMarkersRef.current) return
    const st = useAppStore.getState()
    const fbKey = `${st.currentGroup}:${st.currentSeries}`
    let fb = fieldBurstsRef.current[fbKey]
    // Dual-site: the OTHER channel's discharges, drawn on that channel's
    // trace when it is shown as an additional channel.
    const rawFb = fb
    type OtherChannel = {
      bursts: BurstRecord[]; channel: number
      baselineValue: number; thresholdHigh: number | null; thresholdLow: number | null
    }
    const otherBursts: OtherChannel | null =
      rawFb?.partner
        ? (st.currentTrace === rawFb.partner.channel && st.currentTrace !== rawFb.channel
          ? {
            bursts: rawFb.bursts, channel: rawFb.channel, baselineValue: rawFb.baselineValue,
            thresholdHigh: rawFb.thresholdHigh, thresholdLow: rawFb.thresholdLow,
          }
          : st.currentTrace === rawFb.channel
            ? {
              bursts: rawFb.partner.bursts, channel: rawFb.partner.channel,
              baselineValue: rawFb.partner.baselineValue,
              thresholdHigh: rawFb.partner.thresholdHigh, thresholdLow: rawFb.partner.thresholdLow,
            }
            : null)
        : null
    // Dual-site: when the partner channel is on screen, draw its own
    // discharges rather than the reference channel's.
    if (fb?.partner && st.currentTrace === fb.partner.channel && st.currentTrace !== fb.channel) {
      fb = {
        ...fb,
        channel: fb.partner.channel,
        bursts: fb.partner.bursts,
        baselineValue: fb.partner.baselineValue,
        thresholdHigh: fb.partner.thresholdHigh,
        thresholdLow: fb.partner.thresholdLow,
        selectedIdx: null,
      }
    }
    const yOffset = st.zeroOffset ? st.currentZeroOffset : 0
    if (fb) {
      // Horizontal dashed lines spanning the plot: detection baseline and
      // thresholds from the last detection run on this series.
      const hLine = (y: number, color: string, label: string) => {
        const py = u.valToPos(y - yOffset, 'y', true) / dpr
        if (!isFinite(py)) return
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        ctx.moveTo(bx, py)
        ctx.lineTo(bx + bw, py)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = color
        ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`
        ctx.fillText(label, bx + 4, py - 3)
      }
      ctx.save()
      ctx.globalAlpha = 0.8
      hLine(fb.baselineValue, cssVar('--text-muted'), 'baseline')
      ctx.restore()
      ctx.save()
      ctx.globalAlpha = 0.7
      if (fb.thresholdHigh != null) {
        hLine(fb.thresholdHigh, cssVar('--marker-detected'), 'thr ↑')
      }
      if (fb.thresholdLow != null && fb.thresholdLow !== fb.thresholdHigh) {
        hLine(fb.thresholdLow, cssVar('--marker-detected'), 'thr ↓')
      }
      ctx.restore()
    }
    if (fb && fb.bursts.length > 0) {
      const xScale = u.scales.x
      const xMin = xScale?.min ?? -Infinity
      const xMax = xScale?.max ?? Infinity
      const sweep = currentSweepRef.current
      const selected = fb.selectedIdx
      const colors = {
        baseline: cssVar('--text-muted'),
        peak: cssVar('--marker-detected'),
        decay: cssVar('--cursor-peak'),
        end: cssVar('--success'),
      }
      const outline = cssVar('--marker-outline')

      // Pull the displayed trace samples (already filter / zero-offset
      // adjusted server-side) so markers track whatever's actually on
      // screen. Falls back to the stored y-values if the trace isn't
      // loaded for some reason.
      const tdB = traceDataRef.current
      const ttB = tdB?.time
      const tvB = tdB?.values
      for (let i = 0; i < fb.bursts.length; i++) {
        const b = fb.bursts[i]
        if (b.sweepIndex !== sweep) continue
        if (b.endS < xMin || b.startS > xMax) continue

        const toPxAtTrace = (x: number, fallback: number): [number, number] => {
          const sampled = sampleTraceYAt(ttB, tvB, x)
          const yUse = sampled != null ? sampled : (fallback - yOffset)
          const px = u.valToPos(x, 'x', true) / dpr
          const py = u.valToPos(yUse, 'y', true) / dpr
          return [px, py]
        }
        const peakY = b.preBurstBaseline + b.peakSigned
        const [px0, py0] = toPxAtTrace(b.startS, b.preBurstBaseline)
        const [px1, py1] = toPxAtTrace(b.peakTimeS, peakY)
        const [px3, py3] = toPxAtTrace(b.endS, b.preBurstBaseline)
        const decayCoord =
          b.decayHalfTimeMs != null
            ? toPxAtTrace(
                b.peakTimeS + b.decayHalfTimeMs / 1000,
                b.preBurstBaseline + b.peakSigned * 0.5,
              )
            : null

        const isSel = i === selected
        const r = isSel ? 6 : 4

        const drawDot = (px: number, py: number, color: string) => {
          if (!isFinite(px) || !isFinite(py)) return
          ctx.beginPath()
          ctx.arc(px, py, r, 0, 2 * Math.PI)
          ctx.fillStyle = color
          ctx.fill()
          ctx.save()
          ctx.strokeStyle = outline
          ctx.globalAlpha = isSel ? 1 : 0.6
          ctx.lineWidth = isSel ? 2 : 1
          ctx.stroke()
          ctx.restore()
        }

        drawDot(px0, py0, colors.baseline)
        drawDot(px1, py1, colors.peak)
        if (decayCoord) drawDot(decayCoord[0], decayCoord[1], colors.decay)
        drawDot(px3, py3, colors.end)

        // Faint vertical bar from pre-baseline to peak to anchor the group
        // visually; muted so it doesn't fight the trace.
        ctx.save()
        ctx.strokeStyle = colors.peak
        ctx.globalAlpha = 0.35
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(px1, py0)
        ctx.lineTo(px1, py1)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.restore()
      }
    }

    // Dual-site: the other channel's baseline / thresholds and its
    // discharges' start / peak / end dots, on that channel's own axis.
    // Lines carry raw values: shift by that channel's zero offset; dots
    // are sampled from its displayed trace.
    const otherIdx = otherBursts ? channelSeriesRef.current[otherBursts.channel] : undefined
    if (showBurstMarkersRef.current && otherBursts && otherIdx != null
        && u.data[otherIdx] && u.series[otherIdx]?.show !== false) {
      const xs = u.data[0] as unknown as number[]
      const ys = u.data[otherIdx] as unknown as number[]
      const scaleKey = u.series[otherIdx].scale ?? 'y'
      const otherTd = useAppStore.getState().additionalTraces[otherBursts.channel]
      const yOff2 = st.zeroOffset ? Number(otherTd?.zeroOffset ?? 0) : 0
      const name = otherTd?.label || `Ch ${otherBursts.channel + 1}`
      // Labels go at the right edge so they don't collide with the
      // primary channel's labels on the left.
      const hLine2 = (y: number, color: string, label: string) => {
        const py = u.valToPos(y - yOff2, scaleKey, true) / dpr
        if (!isFinite(py)) return
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.setLineDash([2, 4])
        ctx.beginPath()
        ctx.moveTo(bx, py)
        ctx.lineTo(bx + bw, py)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = color
        ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`
        const tw = ctx.measureText(label).width
        ctx.fillText(label, bx + bw - tw - 4, py - 3)
      }
      ctx.save()
      ctx.globalAlpha = 0.8
      hLine2(otherBursts.baselineValue, cssVar('--text-muted'), `${name} baseline`)
      ctx.restore()
      ctx.save()
      ctx.globalAlpha = 0.7
      if (otherBursts.thresholdHigh != null) {
        hLine2(otherBursts.thresholdHigh, cssVar('--marker-detected'), `${name} thr ↑`)
      }
      if (otherBursts.thresholdLow != null && otherBursts.thresholdLow !== otherBursts.thresholdHigh) {
        hLine2(otherBursts.thresholdLow, cssVar('--marker-detected'), `${name} thr ↓`)
      }
      ctx.restore()
      const xMin = u.scales.x?.min ?? -Infinity
      const xMax = u.scales.x?.max ?? Infinity
      const sweep = currentSweepRef.current
      const outline = cssVar('--marker-outline')
      const dot = (t: number, color: string) => {
        const yv = sampleTraceYAt(xs, ys, t)
        if (yv == null) return
        const px = u.valToPos(t, 'x', true) / dpr
        const py = u.valToPos(yv, scaleKey, true) / dpr
        if (!isFinite(px) || !isFinite(py)) return
        ctx.beginPath()
        ctx.arc(px, py, 4, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
        ctx.save()
        ctx.strokeStyle = outline
        ctx.globalAlpha = 0.6
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.restore()
      }
      for (const b of otherBursts.bursts) {
        if (b.sweepIndex !== sweep || b.endS < xMin || b.startS > xMax) continue
        dot(b.startS, cssVar('--text-muted'))
        dot(b.peakTimeS, cssVar('--marker-detected'))
        if (b.decayHalfTimeMs != null) dot(b.peakTimeS + b.decayHalfTimeMs / 1000, cssVar('--cursor-peak'))
        dot(b.endS, cssVar('--success'))
      }
    }

    // ---- Action-Potential markers ----
    // Same approach as bursts — independent layer, reads the
    // current group/series's AP entry and draws spike-peak dots
    // (plus threshold dots when kinetics were measured) on the
    // current sweep. Y-values are raw signal so subtract yOffset
    // when zero-offset is on.
    const apKey = `${st.currentGroup}:${st.currentSeries}`
    const ap = apAnalysesRef.current[apKey]
    if (ap) {
      const xScale2 = u.scales.x
      const xMin2 = xScale2?.min ?? -Infinity
      const xMax2 = xScale2?.max ?? Infinity
      const sweep = currentSweepRef.current
      // Per-sweep peak times are the cheapest source — they exist
      // even when kinetics weren't measured. perSpike adds threshold,
      // amplitude, etc. when available; we use it to also dot the
      // threshold for visual context.
      const ps = ap.perSweep.find((p) => p.sweep === sweep)
      const peakTimes = ps?.peakTimes ?? []
      const sweepSpikes = ap.perSpike.filter((sp) => sp.sweep === sweep)
      const apOutline = cssVar('--marker-outline')
      const apPeak = cssVar('--marker-detected')
      const apThreshold = cssVar('--text-muted')
      const apFwhm = cssVar('--warning')
      const apFahp = cssVar('--cursor-peak')
      const apMahp = cssVar('--cursor-fit')
      const drawAPDot = (px: number, py: number, color: string, manual: boolean = false) => {
        if (!isFinite(px) || !isFinite(py)) return
        ctx.beginPath()
        ctx.arc(px, py, 4, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = apOutline
        ctx.lineWidth = 1
        ctx.stroke()
        if (manual) {
          ctx.beginPath()
          ctx.arc(px, py, 7, 0, 2 * Math.PI)
          ctx.strokeStyle = color
          ctx.lineWidth = 1.2
          ctx.stroke()
        }
      }
      if (sweepSpikes.length > 0) {
        // Color scheme (theme tokens):
        //   peak       = --marker-detected
        //   threshold  = --text-muted
        //   FWHM tips  = --warning
        //   fAHP       = --cursor-peak
        //   mAHP       = --cursor-fit
        const td = traceDataRef.current
        const tt = td?.time
        const tv = td?.values
        for (const sp of sweepSpikes) {
          if (sp.peakT < xMin2 || sp.peakT > xMax2) continue
          // Peak (always) — sample displayed trace so the dot stays
          // glued to the line under filter / no-filter / zero-offset.
          const peakSampled = sampleTraceYAt(tt, tv, sp.peakT)
          const peakY = peakSampled != null ? peakSampled : (sp.peakVm - yOffset)
          const px = u.valToPos(sp.peakT, 'x', true) / dpr
          const py = u.valToPos(peakY, 'y', true) / dpr
          drawAPDot(px, py, apPeak, sp.manual)
          // Threshold (when kinetics measured)
          if (sp.thresholdT !== 0 || sp.thresholdVm !== 0) {
            const thrSampled = sampleTraceYAt(tt, tv, sp.thresholdT)
            const thrY = thrSampled != null ? thrSampled : (sp.thresholdVm - yOffset)
            const tpx = u.valToPos(sp.thresholdT, 'x', true) / dpr
            const tpy = u.valToPos(thrY, 'y', true) / dpr
            drawAPDot(tpx, tpy, apThreshold)
          }
          // FWHM crossings — find them on the main viewer's trace
          // data using the same walk-the-samples approach as the
          // AP window. Adds two small yellow dots + a dashed line
          // at the half-amplitude level.
          if (
            sp.halfWidthS != null && sp.amplitudeMv > 0 &&
            tt && tv && tt.length > 0
          ) {
            const halfV = sp.thresholdVm + sp.amplitudeMv / 2
            const tLo = sp.thresholdT
            const tHi = sp.peakT + sp.halfWidthS + 0.005
            const findCross = (t0: number, t1: number, ascending: boolean): number | null => {
              let prevT = -Infinity, prevV = NaN
              for (let i = 0; i < tt.length; i++) {
                const t = tt[i]
                if (t < t0) { prevT = t; prevV = tv[i]; continue }
                if (t > t1) break
                const v = tv[i]
                const above = v >= halfV
                if (isFinite(prevV)) {
                  const wasAbove = prevV >= halfV
                  if (ascending && !wasAbove && above) {
                    const frac = (halfV - prevV) / (v - prevV)
                    return prevT + frac * (t - prevT)
                  }
                  if (!ascending && wasAbove && !above) {
                    const frac = (halfV - prevV) / (v - prevV)
                    return prevT + frac * (t - prevT)
                  }
                }
                prevT = t; prevV = v
              }
              return null
            }
            const tLeft = findCross(tLo, sp.peakT, true)
            const tRight = findCross(sp.peakT, tHi, false)
            if (tLeft != null && tRight != null) {
              const pxL = u.valToPos(tLeft, 'x', true) / dpr
              const pyL = u.valToPos(halfV - yOffset, 'y', true) / dpr
              const pxR = u.valToPos(tRight, 'x', true) / dpr
              const pyR = u.valToPos(halfV - yOffset, 'y', true) / dpr
              if (isFinite(pxL) && isFinite(pyL) && isFinite(pxR) && isFinite(pyR)) {
                ctx.save()
                ctx.strokeStyle = apFwhm
                ctx.lineWidth = 1
                ctx.setLineDash([3, 3])
                ctx.beginPath()
                ctx.moveTo(pxL, pyL); ctx.lineTo(pxR, pyR)
                ctx.stroke()
                ctx.setLineDash([])
                ctx.restore()
                drawAPDot(pxL, pyL, apFwhm)
                drawAPDot(pxR, pyR, apFwhm)
              }
            }
          }
          // fAHP
          if (sp.fahpVm != null && sp.fahpT != null) {
            const fSampled = sampleTraceYAt(tt, tv, sp.fahpT)
            const fY = fSampled != null ? fSampled : (sp.fahpVm - yOffset)
            const px2 = u.valToPos(sp.fahpT, 'x', true) / dpr
            const py2 = u.valToPos(fY, 'y', true) / dpr
            drawAPDot(px2, py2, apFahp)
          }
          // mAHP
          if (sp.mahpVm != null && sp.mahpT != null) {
            const mSampled = sampleTraceYAt(tt, tv, sp.mahpT)
            const mY = mSampled != null ? mSampled : (sp.mahpVm - yOffset)
            const px3 = u.valToPos(sp.mahpT, 'x', true) / dpr
            const py3 = u.valToPos(mY, 'y', true) / dpr
            drawAPDot(px3, py3, apMahp)
          }
        }
      } else if (peakTimes.length > 0) {
        // Counting-only fallback: dot at peak time using the
        // displayed-trace y-value (kinetics weren't measured so we
        // don't know peak Vm to a high precision).
        const td = traceDataRef.current
        if (td && td.time && td.values) {
          for (const t of peakTimes) {
            if (t < xMin2 || t > xMax2) continue
            // Nearest sample (linear scan — typical sweeps have a few
            // hundred AP markers max; binary search would be premature).
            let nearestIdx = 0
            let bestDist = Infinity
            for (let i = 0; i < td.time.length; i++) {
              const d = Math.abs(td.time[i] - t)
              if (d < bestDist) { bestDist = d; nearestIdx = i }
            }
            const y = td.values[nearestIdx]
            const px = u.valToPos(t, 'x', true) / dpr
            const py = u.valToPos(y, 'y', true) / dpr
            drawAPDot(px, py, apPeak, false)
          }
        }
      }
    }

    // ---- Event (mEPSC / mIPSC) markers ----
    // Same pattern as bursts/APs: independent layer gated by its own
    // checkbox. Renders the currently-analysed series' event markers
    // for the current sweep — peak (red dot), foot (gray dot), decay
    // endpoint (purple dot). Gives a quick glance-verification that
    // a series has been analysed, right on the main viewer, without
    // opening the events analysis window.
    if (showEventMarkersRef.current) {
      const evKey = `${st.currentGroup}:${st.currentSeries}`
      const ev = eventsAnalysesRef.current[evKey]
      if (ev && ev.events.length > 0 && ev.sweep === currentSweepRef.current) {
        const xScale3 = u.scales.x
        const xMin3 = xScale3?.min ?? -Infinity
        const xMax3 = xScale3?.max ?? Infinity
        const sr = ev.samplingRate || 1
        // Marker sizes — bumped from the original (3.5 / 2.5 / 5
        // selected) so events on the main viewer are spottable at a
        // glance without leaning into the screen.
        const PEAK_R = 5.5
        const PEAK_R_SELECTED = 8
        const FOOT_R = 4
        const ENDPOINT_R = 4
        const evOutline = cssVar('--marker-outline')
        const evDetected = cssVar('--marker-detected')
        const evManual = cssVar('--marker-manual')
        const evFoot = cssVar('--text-muted')
        const evEndpoint = cssVar('--cursor-fit')
        const drawEvDot = (px: number, py: number, color: string, r: number = PEAK_R) => {
          if (!isFinite(px) || !isFinite(py)) return
          ctx.beginPath()
          ctx.arc(px, py, r, 0, 2 * Math.PI)
          ctx.fillStyle = color
          ctx.fill()
          ctx.strokeStyle = evOutline
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
        const tdE = traceDataRef.current
        const ttE = tdE?.time
        const tvE = tdE?.values
        for (let i = 0; i < ev.events.length; i++) {
          const e = ev.events[i]
          if (e.peakTimeS < xMin3 || e.peakTimeS > xMax3) continue
          // Peak (red, larger for selected) — sample displayed trace
          // so the dot follows the line under any filter / offset.
          const selected = i === ev.selectedIdx
          const peakSampled = sampleTraceYAt(ttE, tvE, e.peakTimeS)
          const peakY = peakSampled != null ? peakSampled : (e.peakVal - yOffset)
          const px = u.valToPos(e.peakTimeS, 'x', true) / dpr
          const py = u.valToPos(peakY, 'y', true) / dpr
          drawEvDot(px, py, e.manual ? evManual : evDetected, selected ? PEAK_R_SELECTED : PEAK_R)
          // Foot (gray) at footTimeS — also pinned to the trace.
          const footSampled = sampleTraceYAt(ttE, tvE, e.footTimeS)
          const footY = footSampled != null ? footSampled : (e.baselineVal - yOffset)
          const fpx = u.valToPos(e.footTimeS, 'x', true) / dpr
          const fpy = u.valToPos(footY, 'y', true) / dpr
          drawEvDot(fpx, fpy, evFoot, FOOT_R)
          // Decay endpoint (purple) — the endpoint sits on the trace
          // where it returned to baseline, so sample there too.
          if (e.decayEndpointIdx != null) {
            const endpointT = e.decayEndpointIdx / sr
            const epSampled = sampleTraceYAt(ttE, tvE, endpointT)
            const epY = epSampled != null ? epSampled : (e.baselineVal - yOffset)
            const dpx = u.valToPos(endpointT, 'x', true) / dpr
            const dpy = u.valToPos(epY, 'y', true) / dpr
            drawEvDot(dpx, dpy, evEndpoint, ENDPOINT_R)
          }
        }
      }
    }

    // --- Notes: a dashed line at each timed note; flags are DOM (below) ---
    const flagPos: NoteFlagPos[] = []
    const notes = sweepNotesRef.current
    if (notes.length > 0) {
      const xmin = u.scales.x.min ?? -Infinity
      const xmax = u.scales.x.max ?? Infinity
      ctx.save()
      ctx.strokeStyle = cssVar('--note')
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      for (const n of notes) {
        if (n.time == null || n.time < xmin || n.time > xmax) continue
        const x = u.valToPos(n.time, 'x', true) / dpr
        if (!isFinite(x)) continue
        ctx.beginPath()
        ctx.moveTo(x, by)
        ctx.lineTo(x, by + bh)
        ctx.stroke()
        flagPos.push({ id: n.id, x })
      }
      ctx.restore()
    }
    layoutNoteFlags(flagPos, by + 2)
  }

  // Index of the stimulus series in the data array (when present), so we
  // can run auto-zoom only on that series' values.
  const stimSeriesIdxRef = useRef<number | null>(null)
  // Units string + presence of the right-side alt Y axis. Drives the
  // optional auto-zoom button next to the primary Y controls.
  const [altScaleUnits, setAltScaleUnits] = useState<string | null>(null)

  // Stacked lanes ("Stack channels"): each visible channel in its own
  // lane with its own y scale. ``lanesRef`` holds the lanes of the
  // current plot (empty when not stacked) and how to compute a lane's
  // default range; the handlers below read it.
  const stacked = useAppStore((s) => stackedFor(s, s.currentGroup, s.currentSeries))
  const lanesRef = useRef<{ list: lanes.Lane[]; auto: (lane: lanes.Lane) => [number, number] }>(
    { list: [], auto: () => [-1, 1] })

  // ================================================================
  // Build uPlot data arrays from current state
  // ================================================================
  const buildSeriesData = useCallback((): { data: uPlot.AlignedData; seriesOpts: uPlot.Series[]; stimIdx: number | null } => {
    if (!traceData) return { data: [[]], seriesOpts: [], stimIdx: null }

    const time = Array.from(traceData.time)
    const columns: number[][] = [time]
    const seriesOpts: uPlot.Series[] = [{}]
    channelSeriesRef.current = { [currentTrace]: 1 }

    // Zero offset is now applied server-side (per-sweep, from the first ~3ms
    // of the full sweep) — frontend does no subtraction of its own.

    // Visibility for the current series.
    const primaryVisible = visibleTracesForSeries.includes(currentTrace)

    // Primary trace (the channel `currentTrace` points at — always the one
    // analyses run on). Hidden iff the user has it unchecked in the dropdown.
    columns.push(Array.from(traceData.values))
    seriesOpts.push({
      label: traceData.label || 'Trace',
      stroke: colorForChannel(currentTrace),
      width: 1.5,
      scale: 'y',
      show: primaryVisible,
    } as uPlot.Series)

    // Additional recorded channels the user has turned on.
    const primaryUnits = traceData.units || ''
    // When every extra channel has the primary's units (e.g. CA3 + CA1
    // field channels, both mV), they get the right-hand axis so they can
    // be dragged on their own. With mixed units, keep the long-standing
    // rule: same units share the left axis, other units go right.
    const extraUnits = visibleTracesForSeries
      .filter((chIdx) => chIdx >= 0 && chIdx !== currentTrace && additionalTraces[chIdx])
      .map((chIdx) => additionalTraces[chIdx].units || '')
    const allExtraSameUnits = extraUnits.length > 0 && extraUnits.every((u) => u === primaryUnits)
    for (const chIdx of visibleTracesForSeries) {
      if (chIdx < 0 || chIdx === currentTrace) continue
      const td = additionalTraces[chIdx]
      if (!td) continue  // fetch may still be in flight
      // Place the channel on the primary time axis BY TIME. Each channel
      // is decimated (LTTB) on its own, so the i-th point of two channels
      // is not the same instant — index alignment could shift a channel
      // by up to one display bucket (e.g. ~15 ms in a 1 min view).
      columns.push(interpolateOnto(time, td.time, td.values) as any)
      channelSeriesRef.current[chIdx] = columns.length - 1
      const sameUnits = (td.units || '') === primaryUnits
      seriesOpts.push({
        label: td.label || `Ch ${chIdx + 1}`,
        stroke: colorForChannel(chIdx),
        width: 1.25,
        // Same-unit-only case: own (right) axis, starting on the
        // primary's range (see the y / y_alt range hooks).
        scale: stacked ? `ch${chIdx}` : allExtraSameUnits || !sameUnits ? 'y_alt' : 'y',
      } as uPlot.Series)
    }

    // Overlay sweeps — data already reflects zero_offset from the server.
    if (showOverlay && overlayEntries.length > 0) {
      for (const entry of overlayEntries) {
        const vals = new Array(time.length)
        const src = entry.data.values
        for (let i = 0; i < time.length; i++) vals[i] = i < src.length ? src[i] : null
        columns.push(vals)
        seriesOpts.push({
          label: entry.data.label,
          stroke: entry.color,
          width: 1,
          scale: 'y',
        } as uPlot.Series)
      }
    }

    // Average trace. The main trace's `time` array is typically the
    // backend's LTTB-decimated time (non-uniform) — we can't just
    // align the average's samples by index because the x axis sample
    // positions don't correspond. Interpolate the average onto the
    // main time axis instead.
    if (showAverage && averageTrace) {
      const avgT = averageTrace.time
      const avgV = averageTrace.values
      const vals: (number | null)[] = new Array(time.length).fill(null)
      if (avgT.length > 0 && avgV.length > 0) {
        // avgT is uniform (arange(n)/sr from the backend), so a linear
        // interpolation is fine and cheap. Walk both arrays in parallel.
        const nA = avgT.length
        let j = 0
        for (let i = 0; i < time.length; i++) {
          const t = time[i]
          if (t < avgT[0] || t > avgT[nA - 1]) {
            vals[i] = null
            continue
          }
          while (j < nA - 1 && avgT[j + 1] < t) j++
          if (j >= nA - 1) {
            vals[i] = avgV[nA - 1]
          } else {
            const span = avgT[j + 1] - avgT[j]
            if (span <= 0) {
              vals[i] = avgV[j]
            } else {
              const frac = (t - avgT[j]) / span
              vals[i] = avgV[j] + frac * (avgV[j + 1] - avgV[j])
            }
          }
        }
      }
      columns.push(vals as any)
      seriesOpts.push({
        label: 'Average',
        stroke: cssVar('--trace-average'),
        width: 2.5,
        scale: 'y',
        dash: [6, 3],
      })
    }

    // Stimulus overlay — uses per-sweep segments from the /api/traces/stimulus
    // endpoint (which applies the .pgf increment math for the current sweep).
    // Falls back to the series-level stimulus for backwards compatibility.
    let stimIdx: number | null = null
    if (showStimulusOverlay) {
      const n = time.length
      // Prefer per-sweep segments (has correct I-V step levels per sweep)
      const segs = sweepStimulusSegments ?? stimulus?.segments
      const stimUnit = sweepStimulusUnit || stimulus?.unit || ''
      let stimVals: (number | null)[] | null = null

      if (segs && segs.length > 0) {
        stimVals = new Array(n).fill(0)
        for (let i = 0; i < n; i++) {
          const t = time[i]
          for (let s = 0; s < segs.length; s++) {
            if (t >= segs[s].start && t < segs[s].end) {
              stimVals[i] = segs[s].level
              break
            }
          }
        }
      } else if (stimulus && stimulus.pulseEnd > stimulus.pulseStart) {
        stimVals = new Array(n).fill(0)
        for (let i = 0; i < n; i++) {
          const t = time[i]
          if (t >= stimulus.pulseStart && t < stimulus.pulseEnd) {
            stimVals[i] = stimulus.vStepAbsolute
          }
        }
      }

      if (stimVals) {
        stimIdx = columns.length
        columns.push(stimVals as any)
        seriesOpts.push({
          label: `Stim (${stimUnit})`,
          stroke: cssVar('--stimulus-color'),
          width: 1.75,
          scale: 'stim',
        } as uPlot.Series)
      }
    }

    return { data: columns as unknown as uPlot.AlignedData, seriesOpts, stimIdx }
  }, [traceData, overlayEntries, showOverlay, averageTrace, showAverage, theme, showStimulusOverlay, stimulus, sweepStimulusSegments, zeroOffset, visibleTracesForSeries, additionalTraces, currentTrace, stacked])

  // ================================================================
  // Track which series we last built the plot for, so we can save/restore ranges
  const lastSeriesRef = useRef<string | null>(null)
  const currentGroup = useAppStore((s) => s.currentGroup)
  const currentSeries = useAppStore((s) => s.currentSeries)
  const saveSeriesAxisRange = useAppStore((s) => s.saveSeriesAxisRange)
  const getSeriesAxisRange = useAppStore((s) => s.getSeriesAxisRange)

  // Right-click → Copy / Save PNG. Canvas-only (no SVG round-trip
  // for the live viewer; if the user wants vector they go through
  // the Trace Export window).
  const fileNameForExport = useAppStore((s) => s.recording?.fileName ?? null)
  const baseName = fileNameForExport
    ? fileNameForExport.replace(/\.[^.]+$/, '') + `_g${currentGroup + 1}s${currentSeries + 1}`
    : 'trace'
  // Where the last right-click landed (plot-container px + trace time),
  // for "Add note here".
  const menuAtRef = useRef<{ x: number; y: number; t: number | null } | null>(null)
  const { onContextMenu: onPlotMenuOpen, menu: plotMenu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    getUplot: () => plotRef.current ?? null,
    defaultName: baseName,
    getExtraItems: () => {
      const st = useAppStore.getState()
      if (!st.traceData || st.currentAveragedSweep) return []
      const at = menuAtRef.current
      const base = { group: st.currentGroup, series: st.currentSeries, sweep: st.currentSweep, text: '' }
      const items: { label: string; onClick?: () => void }[] = []
      if (at?.t != null) {
        const t = at.t
        items.push({ label: 'Add note here…', onClick: () => setNoteDraft({ ...base, time: t, x: at.x, y: at.y }) })
      }
      items.push({
        label: 'Note on this sweep…',
        onClick: () => setNoteDraft({ ...base, time: null, x: at?.x ?? 200, y: at?.y ?? 40 }),
      })
      items.push({ label: '' })
      return items
    },
  })
  const onPlotContextMenu = (e: React.MouseEvent) => {
    const u = plotRef.current
    const box = containerRef.current?.getBoundingClientRect()
    if (u && box) {
      const dpr = devicePixelRatio || 1
      const x = e.clientX - box.left
      const y = e.clientY - box.top
      const t = u.posToVal(x * dpr - u.bbox.left, 'x', true)
      const inPlot = x * dpr >= u.bbox.left && x * dpr <= u.bbox.left + u.bbox.width
      menuAtRef.current = { x, y, t: inPlot && isFinite(t) ? Math.max(0, t) : null }
    } else {
      menuAtRef.current = null
    }
    onPlotMenuOpen(e)
  }

  // Create / recreate uPlot when data or overlays change
  // ================================================================
  useEffect(() => {
    if (!containerRef.current || !traceData) return

    // No "save the previous plot's ranges before tearing down" step
    // here — the setScale observer (registered below) already
    // persists every user-driven zoom / pan / auto-zoom synchronously
    // while the plot is bound to the right (group, series, file).
    // Saving again at teardown time is dangerous because by the
    // moment this effect re-runs the store may already reflect the
    // NEW file, so a save would key the OLD plot's range against
    // the WRONG file and leak across recordings.
    lastSeriesRef.current = `${currentGroup}:${currentSeries}`

    // Tear down previous instance
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }

    const container = containerRef.current
    const { data, seriesOpts, stimIdx } = buildSeriesData()
    stimSeriesIdxRef.current = stimIdx

    // Build axis list — always has Time (bottom) + Y data (left).
    // Adds Stim (right) when the stimulus overlay is enabled.
    const axes: uPlot.Axis[] = [
      {
        stroke: cssVar('--chart-axis'),
        grid: { stroke: cssVar('--chart-grid'), width: 1 },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: 'Time (s)',
        labelSize: 16,
        font: `500 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        labelFont: `600 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
      },
      {
        stroke: cssVar('--chart-axis'),
        grid: { stroke: cssVar('--chart-grid'), width: 1 },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: traceData.units || 'Value',
        labelSize: 16,
        font: `500 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        labelFont: `600 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        scale: 'y',
      },
    ]

    // Columns per scale, and whether the right-axis channels share the
    // primary's units (then both axes start on one common range).
    const primaryCols = seriesOpts
      .map((so, i) => ((so as any).scale === 'y' ? i : -1)).filter((i) => i > 0)
    const altCols = seriesOpts
      .map((so, i) => ((so as any).scale === 'y_alt' ? i : -1)).filter((i) => i > 0)
    const sharedUnits = altCols.length > 0 && visibleTracesForSeries
      .filter((chIdx) => chIdx >= 0 && chIdx !== currentTrace && additionalTraces[chIdx])
      .every((chIdx) => (additionalTraces[chIdx].units || '') === (traceData.units || ''))
      ? altCols : []
    const colExtent = (cols: number[]): [number, number] => {
      let lo = Infinity, hi = -Infinity
      for (const c of cols) {
        const arr = data[c] as (number | null)[] | undefined
        if (!arr) continue
        for (const v of arr) {
          if (v == null || !isFinite(v)) continue
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      return [lo, hi]
    }
    const widen = (lo: number, hi: number, ext: [number, number]): [number, number] => {
      const a = Math.min(isFinite(lo) ? lo : Infinity, ext[0])
      const b = Math.max(isFinite(hi) ? hi : -Infinity, ext[1])
      return isFinite(a) && isFinite(b) ? [a, b] : [lo, hi]
    }

    // Build scales object. The `stim` scale is only present when needed.
    //
    // X and Y `range` hooks read the CURRENT store on every call (not a
    // closure snapshot), so user actions (Apply ranges, drag-zoom, zoom-
    // controls) that save to the store immediately take effect on the next
    // draw. The setScale hook (below, in `hooks`) writes the store whenever
    // the user changes a scale, keeping the two in lock-step.
    const scales: uPlot.Scales = {
      x: {
        time: false,
        range: (_u, dataMin, dataMax) => {
          const vp = useAppStore.getState().viewport
          if (vp) return [vp.start, vp.end]
          const savedX = useAppStore.getState().getSeriesAxisRange(currentGroup, currentSeries)?.x
          if (savedX) return [savedX.min, savedX.max]
          return [dataMin, dataMax]
        },
      },
      y: {
        range: (_u, dataMinRaw, dataMaxRaw) => {
          // Same-unit extra channels live on y_alt but start on the same
          // range as the primary: widen by their data until either axis is
          // dragged (saved ranges below take over).
          const [dataMin, dataMax] = sharedUnits.length > 0
            ? widen(dataMinRaw, dataMaxRaw, colExtent(altCols)) : [dataMinRaw, dataMaxRaw]
          const savedY = useAppStore.getState().getSeriesAxisRange(currentGroup, currentSeries)?.y
          if (savedY) {
            // Sanity check: if the saved range doesn't cover any of the data
            // (e.g. user switched to a series with a completely different Y
            // baseline), fall through to auto-fit instead of showing an empty
            // plot. Triggers when the data is entirely outside the saved
            // range, or when the saved range covers < 5% of the data span.
            const dataSpan = dataMax - dataMin
            const savedSpan = savedY.max - savedY.min
            const entirelyOutside = dataMax < savedY.min || dataMin > savedY.max
            const savedTooNarrow =
              dataSpan > 0 && savedSpan > 0 && savedSpan < 0.05 * dataSpan
            if (!entirelyOutside && !savedTooNarrow) {
              return [savedY.min, savedY.max]
            }
            // fall through to auto behavior below
          }
          // In zero-offset mode with no saved range, default to symmetric
          // around 0 based on the currently-drawn data.
          if (zeroOffset) {
            const primary = data[1] as number[] | undefined
            let maxAbs = 0
            if (primary) {
              for (const v of primary) {
                if (v != null && isFinite(v)) {
                  const a = Math.abs(v)
                  if (a > maxAbs) maxAbs = a
                }
              }
            }
            const pad = maxAbs * 1.1 || 1
            return [-pad, pad]
          }
          return [dataMin, dataMax]
        },
      },
    }

    // Add y_alt scale + right-side axis if any visible additional channel
    // uses different units from the primary. (Iterate via series opts — the
    // scale name is already assigned in buildSeriesData.)
    const hasAltScale = seriesOpts.some((s) => (s as any).scale === 'y_alt')
    if (hasAltScale) {
      // Label the right axis: the channel's name when there is exactly one
      // extra channel (e.g. "CA1 (mV)"), otherwise the units.
      const altTds = visibleTracesForSeries
        .filter((chIdx) => chIdx >= 0 && chIdx !== currentTrace && additionalTraces[chIdx])
        .map((chIdx) => additionalTraces[chIdx])
      const altUnits = altTds.find((td) => td.units !== traceData.units)?.units ?? altTds[0]?.units ?? ''
      const altLabel = altTds.length === 1
        ? `${altTds[0].label || 'Ch'}${altTds[0].units ? ` (${altTds[0].units})` : ''}`
        : altUnits
      scales.y_alt = {
        range: (_u, dataMinRaw, dataMaxRaw) => {
          const [dataMin, dataMax] = sharedUnits.length > 0
            ? widen(dataMinRaw, dataMaxRaw, colExtent(primaryCols)) : [dataMinRaw, dataMaxRaw]
          const savedAlt = useAppStore.getState()
            .getSeriesAxisRange(currentGroup, currentSeries)?.y_alt
          if (savedAlt) {
            const dataSpan = dataMax - dataMin
            const savedSpan = savedAlt.max - savedAlt.min
            const entirelyOutside = dataMax < savedAlt.min || dataMin > savedAlt.max
            const savedTooNarrow =
              dataSpan > 0 && savedSpan > 0 && savedSpan < 0.05 * dataSpan
            if (!entirelyOutside && !savedTooNarrow) {
              return [savedAlt.min, savedAlt.max]
            }
          }
          // Same units, not dragged yet: the same default the primary axis
          // uses (common data range, or symmetric around 0 with zero
          // offset), computed from the data — NOT from the primary's saved
          // range, so dragging one axis never moves the other.
          // First draw with a saved primary range: start aligned with it.
          // (Each axis's range is saved on its first draw, so from then on
          // dragging one never moves the other.)
          const savedYForAlt = sharedUnits.length > 0
            ? useAppStore.getState().getSeriesAxisRange(currentGroup, currentSeries)?.y : undefined
          if (savedYForAlt && !(dataMax < savedYForAlt.min || dataMin > savedYForAlt.max)) {
            return [savedYForAlt.min, savedYForAlt.max]
          }
          if (sharedUnits.length > 0 && zeroOffset) {
            const [pLo, pHi] = colExtent(primaryCols.slice(0, 1))
            const pad = Math.max(Math.abs(pLo), Math.abs(pHi)) * 1.1 || 1
            if (isFinite(pad)) return [-pad, pad]
          }
          return [dataMin, dataMax]
        },
      }
      axes.push({
        stroke: cssVar('--chart-axis'),
        grid: { show: false },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: altLabel || 'Alt',
        labelSize: 16,
        font: `500 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        labelFont: `600 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        scale: 'y_alt',
        side: 1,
      })
      // Surface the alt-axis units to the toolbar so an extra
      // auto-zoom button can render. Setting state during the build
      // is safe because uPlot rebuild itself is debounced via the
      // outer useEffect — this is essentially the rebuild commit.
      if (altScaleUnits !== (altLabel || 'Alt')) setAltScaleUnits(altLabel || 'Alt')
    } else if (altScaleUnits !== null) {
      setAltScaleUnits(null)
    }

    if (stimIdx !== null && stimulus) {
      // The stimulus overlay is drawn as "0 baseline + pulse at
      // vStepAbsolute", so the natural Y range is [0, vStepAbsolute] (or
      // flipped if the pulse is negative).
      //
      // Default window: ±20 mV (or ±200 pA) centered on 0, unless the
      // absolute pulse level sticks outside that window — then auto-range
      // with 20% padding around the pulse level.
      const DEFAULT_HALF: Record<string, number> = { mV: 20, pA: 200 }
      const halfWindow = DEFAULT_HALF[stimulus.unit] ?? 20

      const pulse = stimulus.vStepAbsolute
      const needed = Math.abs(pulse)

      // Default range: ±halfWindow centered on 0 (small pulses), else
      // 20% pad around the pulse level.
      const defaultRange: [number, number] = needed <= halfWindow
        ? [-halfWindow, halfWindow]
        : (() => {
            const pad = needed * 0.2 || 1
            return [Math.min(0, pulse) - pad, Math.max(0, pulse) + pad]
          })()

      // Reads saved stim range live from the store (if any), so stim zooms
      // persist across sweep/series changes the same way X/Y do.
      scales.stim = {
        range: () => {
          const saved = useAppStore.getState()
            .getSeriesAxisRange(currentGroup, currentSeries)?.stim
          if (saved) return [saved.min, saved.max]
          return defaultRange
        },
      }

      // Right-side axis in the stimulus color
      axes.push({
        stroke: cssVar('--stimulus-color'),
        grid: { show: false },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: `Stim (${stimulus.unit})`,
        labelSize: 16,
        font: `500 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        labelFont: `600 ${cssVar('--font-size-sm')} ${cssVar('--font-ui')}`,
        scale: 'stim',
        side: 1,
      })
    }

    // ---- Stacked lanes: one band per visible channel ----
    lanesRef.current = { list: [], auto: () => [-1, 1] }
    if (stacked) {
      const colsOf = (key: string) => seriesOpts
        .map((so, i) => (i > 0 && (so as any).scale === key ? i : -1)).filter((i) => i > 0)
      const list: lanes.Lane[] = []
      const recorded = visibleTracesForSeries.filter((i) => i >= 0).sort((a, b) => a - b)
      for (const ch of recorded) {
        if (ch === currentTrace) {
          list.push({ id: `c${ch}`, scale: 'y', label: traceData.label || `Ch ${ch + 1}`,
            units: traceData.units || '', color: colorForChannel(ch), cols: colsOf('y') })
        } else if (additionalTraces[ch]) {
          const td = additionalTraces[ch]
          list.push({ id: `c${ch}`, scale: `ch${ch}`, label: td.label || `Ch ${ch + 1}`,
            units: td.units || '', color: colorForChannel(ch), cols: colsOf(`ch${ch}`) })
        }
      }
      if (stimIdx !== null) {
        list.push({ id: 'stim', scale: 'stim', label: 'Stimulus', units: stimulus?.unit ?? '',
          color: cssVar('--stimulus-color'), cols: [stimIdx] })
      }
      if (list.length >= 2) {
        const N = list.length
        const dpr = devicePixelRatio || 1
        const auto = (lane: lanes.Lane): [number, number] => {
          const [lo, hi] = colExtent(lane.cols)
          return lanes.paddedExtent(lo, hi) ?? [-1, 1]
        }
        // A lane shows its saved range (once dragged or zoomed), else its data.
        const laneRange = (lane: lanes.Lane): [number, number] => {
          const saved = useAppStore.getState()
            .getSeriesAxisRange(currentGroup, currentSeries)?.lanes?.[lane.id]
          if (saved && saved.max > saved.min) {
            const [lo, hi] = colExtent(lane.cols)
            if (!(isFinite(lo) && (hi < saved.min || lo > saved.max))) return [saved.min, saved.max]
          }
          return auto(lane)
        }
        lanesRef.current = { list, auto }
        const laneOfScale = new Map(list.map((l, i) => [l.scale, i]))
        list.forEach((lane, i) => {
          scales[lane.scale] = {
            range: (u) => lanes.toScale(...laneRange(lane), lanes.laneBand(i, N, u.bbox.height / dpr)),
          }
        })
        // Each line stays inside its lane; series with no lane (the
        // active channel's overlays when that channel is hidden) are off.
        const linear = uPlot.paths.linear!()
        seriesOpts.forEach((so, si) => {
          if (si === 0) return
          const li = laneOfScale.get((so as any).scale ?? 'y')
          if (li == null) { so.show = false; return }
          so.paths = (u, sidx, i0, i1) => {
            const p = linear(u, sidx, i0, i1)
            if (p) {
              const band = lanes.laneBand(li, N, u.bbox.height / dpr)
              const clip = new Path2D()
              clip.rect(u.bbox.left, u.bbox.top + band.top * u.bbox.height,
                u.bbox.width, (band.bottom - band.top) * u.bbox.height)
              p.clip = clip
            }
            return p
          }
        })
        // One left axis carries every lane's ticks (labels and grid
        // lines per lane); lane names are drawn inside each lane.
        let tickLabels: string[] = []
        const laneAxis: uPlot.Axis = {
          ...axes[1],
          label: undefined,
          labelSize: 0,
          scale: list[0].scale,
          splits: (u, _ai, sMin, sMax) => {
            const hCss = u.bbox.height / dpr
            const pairs: [number, string][] = []
            list.forEach((lane, i) => {
              const sc = u.scales[lane.scale]
              if (sc?.min == null || sc?.max == null) return
              const band = lanes.laneBand(i, N, hCss)
              const [lo, hi] = lanes.fromScale(sc.min, sc.max, band)
              const target = Math.max(2, Math.floor(((band.bottom - band.top) * hCss) / 26))
              const ticks = lanes.niceTicks(lo, hi, target)
              const dec = lanes.tickDecimals(ticks)
              for (const t of ticks) {
                const f = lanes.fracOf(t, lo, hi, band)
                pairs.push([sMax - f * (sMax - sMin), t.toFixed(dec)])
              }
            })
            pairs.sort((a, b) => a[0] - b[0])
            tickLabels = pairs.map((p) => p[1])
            return pairs.map((p) => p[0])
          },
          values: () => tickLabels,
        }
        axes.splice(1, axes.length - 1, laneAxis)
      }
    }

    const opts: uPlot.Options = {
      width: container.clientWidth,
      height: container.clientHeight,
      // We render our own toolbar / coordinate tooltip — uPlot's
      // default legend strip below the plot is not part of the UI.
      legend: { show: false },
      cursor: {
        drag: {
          x: zoomMode,
          y: zoomMode,
          // We intercept the drag-zoom via the `setSelect` hook (below) and
          // drive the scale changes ourselves, so disable uPlot's built-in
          // auto-setScale. This lets us route X through the viewport system
          // (triggering a re-fetch at higher resolution) rather than letting
          // uPlot fight our X range hook.
          setScale: false,
          // No `uni` threshold — any rectangle drag zooms both axes.
        },
        focus: { prox: 30 },
        // Crosshair line + point styling lives in CSS (.u-cursor-x,
        // .u-cursor-y, .u-cursor-pt). uPlot's TS types make these
        // config fields booleans, so styling via stylesheet is the
        // sanctioned route.
      },
      scales,
      axes,
      series: seriesOpts,
      hooks: {
        draw: [(u: uPlot) => drawLaneChrome(u), () => drawCursors()],
        // Coordinate tooltip that follows the cursor. Position + content
        // come from uPlot's cursor state; visibility is gated by the
        // "Show/hide coordinates" toolbar toggle (read via ref so this
        // hook doesn't need to rebuild when the flag flips).
        setCursor: [
          (u: uPlot) => {
            const tip = coordTooltipRef.current
            if (!tip) return
            if (!showCoordinatesRef.current) {
              tip.style.display = 'none'
              return
            }
            const left = u.cursor.left
            const top = u.cursor.top
            const idx = u.cursor.idx
            if (
              left == null || top == null || idx == null ||
              left < 0 || top < 0 || !isFinite(idx as number)
            ) {
              tip.style.display = 'none'
              return
            }
            const xs = (u.data[0] as unknown as number[])?.[idx as number]
            // Stacked: the value of the channel whose lane is under the cursor.
            let col = 1
            let tipUnits = traceData?.units ?? ''
            const laneList = lanesRef.current.list
            if (laneList.length >= 2) {
              const hCss = u.bbox.height / (devicePixelRatio || 1)
              const lane = laneList[lanes.laneAt(top / hCss, laneList.length, hCss)]
              col = lane.cols[0] ?? 1
              tipUnits = lane.units
            }
            const ys = (u.data[col] as unknown as (number | null)[])?.[idx as number]
            if (xs == null || ys == null || !isFinite(xs) || !isFinite(ys as number)) {
              tip.style.display = 'none'
              return
            }
            // Position the tooltip offset from the cursor so the OS mouse
            // arrow (which extends down-right from its tip) doesn't sit on
            // top of it. Default: above-right of the cursor. Flip below
            // when near the top edge; flip left when near the right edge.
            const dpr = devicePixelRatio || 1
            const plotRight = u.bbox.width / dpr
            const approxTipW = 110
            const approxTipH = 22
            const offsetX = 12
            const offsetY = 14
            const nearRight = left + offsetX + approxTipW > plotRight
            const nearTop = top - offsetY - approxTipH < 0
            tip.style.display = 'block'
            tip.style.left = nearRight
              ? `${left - offsetX - approxTipW}px`
              : `${left + offsetX}px`
            tip.style.top = nearTop
              ? `${top + offsetY + 10}px`          // below cursor
              : `${top - offsetY - approxTipH}px`  // above cursor (default)
            tip.textContent = `${(xs as number).toFixed(3)} s  ·  ${(ys as number).toFixed(3)}${tipUnits ? ' ' + tipUnits : ''}`
          },
        ],
        // Drag-zoom rectangle completed: apply it ourselves.
        // Route X through the viewport system so we refetch at the zoomed
        // resolution; apply Y directly via setScale + persist to the store.
        setSelect: [
          (u: uPlot) => {
            const sel = u.select
            if (!sel || sel.width < 2 || sel.height < 2) {
              // Too small — treat as click, just clear selection
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
              return
            }
            // Pixel rect → data-space bounds. Y is inverted on screen.
            const xMin = u.posToVal(sel.left, 'x')
            const xMax = u.posToVal(sel.left + sel.width, 'x')
            const yMax = u.posToVal(sel.top, 'y')
            const yMin = u.posToVal(sel.top + sel.height, 'y')

            const st = useAppStore.getState()

            // X: viewport-mode routes to setViewport (triggers refetch).
            //    Full-mode uses u.setScale directly.
            if (st.viewport) {
              st.setViewport({ start: xMin, end: xMax })
            } else if (isFinite(xMin) && isFinite(xMax) && xMax > xMin) {
              u.setScale('x', { min: xMin, max: xMax })
            }

            // Y: set the scale now AND save to store so rebuilds preserve it.
            // (Stacked lanes: the box zooms time only.)
            if (lanesRef.current.list.length < 2 && isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
              u.setScale('y', { min: yMin, max: yMax })
              const cur = st.getSeriesAxisRange(currentGroup, currentSeries)
              st.saveSeriesAxisRange(currentGroup, currentSeries, {
                ...cur,
                y: { min: yMin, max: yMax },
              })
            }

            // Clear the visual selection rectangle.
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
          },
        ],
        // When the user drag-zooms on X (zoom mode), uPlot calls setScale('x')
        // with the new bounds. Since our X range hook would otherwise force
        // the scale back to the current viewport on the next redraw, we sync
        // the viewport to the user's zoom selection here. This both persists
        // the zoom AND triggers a refetch at the right resolution.
        setScale: [
          (u: uPlot, key: string) => {
            const st = useAppStore.getState()

            if (key === 'x') {
              const vp = st.viewport
              if (!vp) return  // Full mode — uPlot manages X freely
              const xs = u.scales.x
              if (xs?.min == null || xs?.max == null) return
              const EPS = 1e-6
              // Snap: scale matches viewport, nothing to do.
              if (Math.abs(xs.min - vp.start) < EPS && Math.abs(xs.max - vp.end) < EPS) return
              const newLen = xs.max - xs.min
              if (newLen <= 0 || !isFinite(newLen)) return
              // Mid-pan: update state only, no fetch per-frame. Clamp in
              // the same way setViewport does, otherwise pan past the
              // edges puts the store in an out-of-bounds state.
              if (dragRef.current?.kind === 'pan') {
                const dur = st.sweepDuration
                let start = xs.min
                let end = xs.max
                if (dur > 0) {
                  start = Math.max(0, Math.min(start, dur))
                  end = Math.max(start, Math.min(end, dur))
                }
                useAppStore.setState({ viewport: { start, end } })
              } else {
                // Drag-zoom, Apply-ranges, or zoom-button: deliberate viewport
                // change — update + refetch at higher resolution (setViewport
                // clamps internally).
                st.setViewport({ start: xs.min, end: xs.max })
              }
              return
            }

            // Stacked lanes save their own ranges (setLaneRange).
            if (lanesRef.current.list.length >= 2) return
            if (key === 'y' || key === 'y_alt' || key === 'stim') {
              const ys = u.scales[key]
              if (ys?.min == null || ys?.max == null) return
              // Persist the range so the hook returns it on subsequent
              // rebuilds (viewport scroll, etc). Without this, drag /
              // zoom on either Y scale would be wiped when the data
              // next changes.
              const EPS = 1e-6
              const cur = st.getSeriesAxisRange(currentGroup, currentSeries)
              const prev = key === 'y' ? cur?.y : key === 'y_alt' ? cur?.y_alt : cur?.stim
              const same =
                prev &&
                Math.abs(prev.min - ys.min) < EPS &&
                Math.abs(prev.max - ys.max) < EPS
              if (same) return
              st.saveSeriesAxisRange(currentGroup, currentSeries, {
                ...cur,
                [key]: { min: ys.min, max: ys.max },
              })
            }
          },
        ],
      },
    }

    plotRef.current = new uPlot(opts, data, container)

    // Scale ranges are handled by the `range` hooks in the scales config
    // above — no post-creation setScale needed. The hooks read viewport and
    // saved-range state, so the initial draw uses the correct bounds.

    drawCursors()

    // Cleanup on unmount or before next recreation.
    //
    // Notably we do NOT save scale ranges here. The setScale hook
    // (above) already persists any user-driven zoom / pan to the
    // store synchronously, while the OLD plot is still bound to
    // the OLD file. Persisting here in cleanup is dangerous: the
    // cleanup runs AFTER ``recording`` has been swapped to the
    // new file, so every saveSeriesAxisRange call would key
    // against the wrong file. That was the source of cross-file
    // zoom leaks.
    return () => {
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [traceData, buildSeriesData, theme, fontSize, zoomMode, showStimulusOverlay, stimulus, traceColorsKey, stacked]) // deliberately NOT including cursors

  // ================================================================
  // Repaint cursor canvas when cursor positions or visibility change
  // (no plot rebuild)
  // ================================================================
  useEffect(() => {
    drawCursors()
  }, [cursors, showCursors, cursorVisibility, fieldBursts, currentSweep, zeroOffset, showBurstMarkers, apAnalyses, eventsAnalyses, showEventMarkers, sweepNotes])

  // Hide the coordinate tooltip immediately when the toggle flips off.
  useEffect(() => {
    if (!showCoordinates && coordTooltipRef.current) {
      coordTooltipRef.current.style.display = 'none'
    }
  }, [showCoordinates])

  // ================================================================
  // Listen for axis range commands from the CursorPanel
  // ================================================================
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('tracer-axis-range')
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'set-axis-range') {
          const u = plotRef.current
          if (!u) return
          // Read current group/series from the store, not closure — the
          // listener is installed once and must survive series switches.
          const st = useAppStore.getState()
          const g = st.currentGroup
          const s = st.currentSeries
          if (ev.data.x) {
            if (st.viewport) {
              st.setViewport({ start: ev.data.x.min, end: ev.data.x.max })
            } else {
              const cur = st.getSeriesAxisRange(g, s) ?? {}
              st.saveSeriesAxisRange(g, s, {
                ...cur, x: { min: ev.data.x.min, max: ev.data.x.max },
              })
              u.setScale('x', { min: ev.data.x.min, max: ev.data.x.max })
            }
          }
          if (ev.data.y && lanesRef.current.list.length >= 2) {
            const lane = lanesRef.current.list.find((l) => l.scale === 'y')
            if (lane) setLaneRange(lane, ev.data.y.min, ev.data.y.max)
          } else if (ev.data.y) {
            const cur = st.getSeriesAxisRange(g, s) ?? {}
            st.saveSeriesAxisRange(g, s, {
              ...cur, y: { min: ev.data.y.min, max: ev.data.y.max },
            })
            u.setScale('y', { min: ev.data.y.min, max: ev.data.y.max })
          }
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  // ================================================================
  // Keyboard viewport navigation:
  //   ←  / →             scroll by one window
  //   Shift-← / Shift-→  scroll by two windows (fast)
  //   Home / End          jump to start / end
  // ================================================================
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing in an input
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

      const st = useAppStore.getState()
      if (!st.viewport) return
      const len = st.viewport.end - st.viewport.start
      const step = e.shiftKey ? 2 * len : len
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        st.scrollViewport(-step)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        st.scrollViewport(step)
      } else if (e.key === 'Home') {
        e.preventDefault()
        st.setViewportStart(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        st.setViewportStart(Math.max(0, st.sweepDuration - len))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ================================================================
  // Resize: keep uPlot and canvas in sync with container
  // ================================================================
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Debounced max_points update: when the plot is resized, the ideal
    // resolution for the current viewport is ~ pixel-width × DPR. We don't
    // want to re-fetch on every frame of a resize drag, so we coalesce.
    let resizeTimer: number | null = null

    const observer = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !container) return
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) {
        // setSize triggers uPlot's draw hook, which calls drawCursors()
        u.setSize({ width: w, height: h })

        // Tie fetch resolution to display resolution (×2 for min/max-style
        // density, no point going higher).
        const dpr = window.devicePixelRatio || 1
        const targetPoints = Math.max(500, Math.floor(w * dpr * 2))
        const state = useAppStore.getState()
        if (targetPoints !== state.viewportMaxPoints) {
          if (resizeTimer !== null) window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => {
            const latest = useAppStore.getState()
            latest.setViewportMaxPoints(targetPoints)
            // Only re-fetch if a viewport is set (otherwise the full sweep
            // is already shown and max_points=0 behavior is fine).
            if (latest.viewport) {
              latest.refetchViewport().catch(() => { /* ignore */ })
            }
          }, 150)
        }
      }
    })

    observer.observe(container)
    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      observer.disconnect()
    }
  }, []) // stable — reads plotRef.current at call time

  // Keyboard: Left/Right scrolls the viewport by one window
  // (Shift+arrow = half-window for overlap).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing in an input/textarea
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const state = useAppStore.getState()
      if (!state.viewport) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const len = state.viewport.end - state.viewport.start
      const step = e.shiftKey ? len / 2 : len
      state.scrollViewport(e.key === 'ArrowLeft' ? -step : step)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ================================================================
  // Draggable cursor edges + region drag
  // ================================================================
  const valFromClientX = (clientX: number): number | null => {
    const u = plotRef.current
    if (!u || !containerRef.current) return null
    const rect = containerRef.current.getBoundingClientRect()
    const cssPx = clientX - rect.left
    const canvasPx = cssPx * (devicePixelRatio || 1)
    return u.posToVal(canvasPx, 'x')
  }

  /**
   * Hit-test cursor edges and regions.
   * Priority: edge snap (within SNAP_PX) > region interior > nothing.
   * Returns null when cursors are globally hidden.
   */
  const hitTest = (clientX: number): { type: 'edge'; key: DragEdge } | { type: 'region'; def: typeof CURSOR_DEFS[0] } | null => {
    if (!showCursors) return null
    const u = plotRef.current
    if (!u || !containerRef.current) return null
    const rect = containerRef.current.getBoundingClientRect()
    const cssPx = clientX - rect.left
    const dpr = devicePixelRatio || 1
    const cur = cursorsRef.current

    // First pass: check edge snapping (highest priority)
    let bestEdge: DragEdge | null = null
    let bestDist = SNAP_PX
    const vis = cursorVisRef.current

    for (const def of CURSOR_DEFS) {
      if (!vis[def.visKey]) continue
      const x0 = u.valToPos(cur[def.startKey], 'x', true) / dpr
      const x1 = u.valToPos(cur[def.endKey], 'x', true) / dpr
      if (!isFinite(x0) || !isFinite(x1)) continue

      const d0 = Math.abs(cssPx - x0)
      const d1 = Math.abs(cssPx - x1)
      if (d0 < bestDist) { bestDist = d0; bestEdge = def.startKey }
      if (d1 < bestDist) { bestDist = d1; bestEdge = def.endKey }
    }

    if (bestEdge) return { type: 'edge', key: bestEdge }

    // Second pass: check if inside a region
    for (const def of CURSOR_DEFS) {
      if (!vis[def.visKey]) continue
      const x0 = u.valToPos(cur[def.startKey], 'x', true) / dpr
      const x1 = u.valToPos(cur[def.endKey], 'x', true) / dpr
      if (!isFinite(x0) || !isFinite(x1)) continue

      const lo = Math.min(x0, x1)
      const hi = Math.max(x0, x1)
      if (cssPx >= lo && cssPx <= hi) {
        return { type: 'region', def }
      }
    }

    return null
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return

    const hit = hitTest(e.clientX)

    if (hit) {
      e.preventDefault()
      e.stopPropagation()

      if (hit.type === 'edge') {
        dragRef.current = { kind: 'edge', key: hit.key }
      } else {
        const val = valFromClientX(e.clientX)
        if (val === null) return
        const cur = cursorsRef.current
        dragRef.current = {
          kind: 'region',
          startKey: hit.def.startKey as DragEdge,
          endKey: hit.def.endKey as DragEdge,
          anchorVal: val,
          origStart: cur[hit.def.startKey],
          origEnd: cur[hit.def.endKey],
        }
      }
    } else if (!zoomMode) {
      // No cursor hit and zoom mode is off — start panning the view.
      // When zoom mode is on, let uPlot handle the drag-to-zoom instead.
      e.preventDefault()
      dragRef.current = {
        kind: 'pan',
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        yScaleKey: pickYScale(e.clientX, e.clientY),
      }
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current
    if (drag) {
      if (drag.kind === 'edge') {
        const val = valFromClientX(e.clientX)
        if (val !== null) setCursors({ [drag.key]: Math.max(0, val) })
      } else if (drag.kind === 'region') {
        const val = valFromClientX(e.clientX)
        if (val !== null) {
          const delta = val - drag.anchorVal
          setCursors({ [drag.startKey]: Math.max(0, drag.origStart + delta), [drag.endKey]: Math.max(0, drag.origEnd + delta) })
        }
      } else if (drag.kind === 'pan') {
        // Pan: convert pixel delta to axis value delta and shift both scales.
        //
        // X in viewport mode MUST NOT go through u.setScale('x', ...) — the
        // X range hook would read the current (stale) viewport from the
        // store and clobber the shift. We update the viewport state in the
        // store directly; the range hook reads the fresh value on next draw.
        // (Refetch is deferred to mouseup via handleMouseUp to avoid one
        // fetch per mousemove.)
        const u = plotRef.current
        if (u && containerRef.current) {
          const dpr = devicePixelRatio || 1
          const dxPx = (e.clientX - drag.lastClientX) * dpr
          const dyPx = (e.clientY - drag.lastClientY) * dpr

          // X pan: convert pixel delta to value delta
          const xScale = u.scales.x
          if (xScale && xScale.min != null && xScale.max != null) {
            const plotW = u.bbox.width
            const xRange = xScale.max - xScale.min
            const dxVal = -(dxPx / plotW) * xRange
            const newMin = xScale.min + dxVal
            const newMax = xScale.max + dxVal

            const st = useAppStore.getState()
            if (st.viewport) {
              // Clamp to sweep edges so we can't pan off-end and poison the
              // viewport store.
              const dur = st.sweepDuration
              let start = newMin
              let end = newMax
              if (dur > 0) {
                start = Math.max(0, Math.min(start, dur))
                end = Math.max(start, Math.min(end, dur))
              }
              // Write viewport FIRST so the X range hook reads the new
              // values when uPlot calls it during the setScale below.
              useAppStore.setState({ viewport: { start, end } })
              u.setScale('x', { min: start, max: end })
            } else {
              // Full mode: the X range hook returns savedX if present, which
              // would clobber the shifted values here. Write savedX in the
              // store FIRST, then setScale — the hook reads fresh and
              // returns the panned range.
              const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
              st.saveSeriesAxisRange(currentGroup, currentSeries, {
                ...cur,
                x: { min: newMin, max: newMax },
              })
              u.setScale('x', { min: newMin, max: newMax })
            }
          }

          // Y pan — pan whichever Y-like scale (y / y_alt / stim)
          // the cursor was closest to at mousedown. Sticky for the
          // duration of one drag so the picked trace doesn't change
          // if the user pans across another one.
          const yKey = drag.yScaleKey ?? 'y'
          const yScale = u.scales[yKey]
          if (lanesRef.current.list.length >= 2) {
            panLane(yKey, dyPx)
          } else if (yScale && yScale.min != null && yScale.max != null) {
            const plotH = u.bbox.height
            const yRange = yScale.max - yScale.min
            const dyVal = (dyPx / plotH) * yRange  // positive dy = move up = decrease values shown
            u.setScale(yKey, { min: yScale.min + dyVal, max: yScale.max + dyVal })
          }

          drag.lastClientX = e.clientX
          drag.lastClientY = e.clientY
        }
      }
    } else {
      const hit = hitTest(e.clientX)
      let cur = ''
      if (hit?.type === 'edge') cur = 'col-resize'
      else if (hit?.type === 'region') cur = 'grab'
      if (cur !== hoverCursor) setHoverCursor(cur)
    }
  }

  const handleMouseUp = () => {
    const wasPanning = dragRef.current?.kind === 'pan'
    dragRef.current = null
    // If we just finished panning in a viewport mode, fire a single refetch
    // so the data matches the new viewport at proper resolution.
    if (wasPanning && useAppStore.getState().viewport) {
      useAppStore.getState().refetchViewport().catch(() => { /* ignore */ })
    }
  }

  // ================================================================
  // Axis zoom controls
  // ================================================================

  /** Zoom an axis by the given factor. factor < 1 zooms in, > 1 zooms out. */
  /** Apply a new scale range, routing through the right persistence path so
   *  the range hook doesn't clobber the update.
   *
   *  X in viewport mode  → setViewport (refetch at new bounds).
   *  X in Full mode      → update savedX in the store, then u.setScale. The
   *                        range hook reads savedX fresh and returns the new
   *                        bounds; if we skipped the store write, the hook
   *                        would return the STALE savedX and the setScale
   *                        would appear to do nothing.
   *  Y (always)          → update savedY in store, then u.setScale. Same
   *                        reasoning as Full-mode X.
   *  stim                → u.setScale directly (no persistence layer).
   */
  const applyScale = (key: 'x' | 'y' | 'y_alt' | 'stim', min: number, max: number) => {
    const u = plotRef.current
    if (!u) return
    if (!isFinite(min) || !isFinite(max) || max <= min) return
    const st = useAppStore.getState()
    if (key === 'x' && st.viewport) {
      st.setViewport({ start: min, end: max })
      return
    }
    if (key === 'x') {
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, x: { min, max } })
      u.setScale('x', { min, max })
      return
    }
    if (key === 'y' || key === 'y_alt') {
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, [key]: { min, max } })
      u.setScale(key, { min, max })
      return
    }
    if (key === 'stim') {
      // Persist stim range per-series so zooming the stimulus axis survives
      // sweep switches (same pattern as X and Y).
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, stim: { min, max } })
      u.setScale('stim', { min, max })
      return
    }
    u.setScale(key, { min, max })
  }

  // ---- Stacked lanes: read / set / pan a lane's visible range ----

  /** The range lane ``lane`` currently shows, from its scale. */
  const laneShown = (lane: lanes.Lane): [number, number] | null => {
    const u = plotRef.current
    const list = lanesRef.current.list
    const i = list.indexOf(lane)
    const sc = u?.scales[lane.scale]
    if (!u || i < 0 || sc?.min == null || sc?.max == null) return null
    const band = lanes.laneBand(i, list.length, u.bbox.height / (devicePixelRatio || 1))
    return lanes.fromScale(sc.min, sc.max, band)
  }

  /** Show [lo, hi] in a lane and remember it for the series. */
  const setLaneRange = (lane: lanes.Lane, lo: number, hi: number) => {
    const u = plotRef.current
    const list = lanesRef.current.list
    const i = list.indexOf(lane)
    if (!u || i < 0 || !isFinite(lo) || !isFinite(hi) || hi <= lo) return
    const st = useAppStore.getState()
    const g = st.currentGroup
    const s = st.currentSeries
    const cur = st.getSeriesAxisRange(g, s) ?? {}
    st.saveSeriesAxisRange(g, s, { ...cur, lanes: { ...cur.lanes, [lane.id]: { min: lo, max: hi } } })
    const band = lanes.laneBand(i, list.length, u.bbox.height / (devicePixelRatio || 1))
    const [min, max] = lanes.toScale(lo, hi, band)
    u.setScale(lane.scale, { min, max })
  }

  /** Drag a lane's trace up / down by ``dyPx`` canvas pixels. */
  const panLane = (key: string, dyPx: number) => {
    const u = plotRef.current
    const list = lanesRef.current.list
    const i = list.findIndex((l) => l.scale === key)
    if (!u || i < 0) return
    const r = laneShown(list[i])
    if (!r) return
    const band = lanes.laneBand(i, list.length, u.bbox.height / (devicePixelRatio || 1))
    const bandPx = (band.bottom - band.top) * u.bbox.height
    if (!(bandPx > 0)) return
    const d = (dyPx / bandPx) * (r[1] - r[0])
    setLaneRange(list[i], r[0] + d, r[1] + d)
  }

  /** Toolbar Y buttons with stacked lanes: act on every lane. */
  const zoomAllLanes = (factor: number) => {
    for (const lane of [...lanesRef.current.list]) zoomScale(lane.scale, factor)
  }
  const autoAllLanes = () => {
    for (const lane of [...lanesRef.current.list]) autoScale(lane.scale)
  }

  /** Lane separators and names, drawn on the plot canvas. */
  const drawLaneChrome = (u: uPlot) => {
    const list = lanesRef.current.list
    const N = list.length
    if (N < 2) return
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1
    const { left, top, width, height } = u.bbox
    const hCss = height / dpr
    ctx.save()
    ctx.strokeStyle = cssVar('--chart-axis')
    ctx.globalAlpha = 0.45
    ctx.lineWidth = dpr
    for (let i = 1; i < N; i++) {
      const a = lanes.laneBand(i - 1, N, hCss)
      const b = lanes.laneBand(i, N, hCss)
      const y = Math.round(top + ((a.bottom + b.top) / 2) * height) + 0.5
      ctx.beginPath()
      ctx.moveTo(left, y)
      ctx.lineTo(left + width, y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    const fontPx = (parseFloat(cssVar('--font-size-label')) || 11) * dpr
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'      // uPlot's axis drawing leaves it right-aligned
    // Names sit top-right in each lane, clear of the cursor labels and
    // note flags along the top-left.
    list.forEach((lane, i) => {
      const band = lanes.laneBand(i, N, hCss)
      const text = lane.units && !lane.label.endsWith(`(${lane.units})`)
        ? `${lane.label} (${lane.units})` : lane.label
      ctx.font = `${lane.scale === 'y' ? 700 : 600} ${fontPx}px ${cssVar('--font-ui')}`
      const w = ctx.measureText(text).width
      const x = left + width - w - 8 * dpr
      const y = top + band.top * height + 3 * dpr
      ctx.globalAlpha = 0.85
      ctx.fillStyle = cssVar('--bg-primary')
      ctx.fillRect(x - 3 * dpr, y - 2 * dpr, w + 6 * dpr, fontPx + 4 * dpr)
      ctx.globalAlpha = 1
      ctx.fillStyle = lane.color
      ctx.fillText(text, x, y)
    })
    ctx.restore()
  }

  const zoomScale = (key: string, factor: number) => {
    const u = plotRef.current
    if (!u) return
    if (key !== 'x' && lanesRef.current.list.length >= 2) {
      const lane = lanesRef.current.list.find((l) => l.scale === key)
      const r = lane ? laneShown(lane) : null
      if (lane && r) {
        const mid = (r[0] + r[1]) / 2
        const half = ((r[1] - r[0]) / 2) * factor
        setLaneRange(lane, mid - half, mid + half)
      }
      return
    }
    const s = u.scales[key]
    if (!s || s.min == null || s.max == null) return
    const mid = (s.min + s.max) / 2
    const half = ((s.max - s.min) / 2) * factor
    applyScale(key as 'x' | 'y' | 'y_alt' | 'stim', mid - half, mid + half)
  }

  /** Zoom an axis centered on a specific value (for wheel zoom). */
  const zoomScaleAt = (key: 'x' | 'y' | 'y_alt' | 'stim', factor: number, anchor: number) => {
    const u = plotRef.current
    if (!u) return
    const s = u.scales[key]
    if (!s || s.min == null || s.max == null) return
    const lo = anchor - (anchor - s.min) * factor
    const hi = anchor + (s.max - anchor) * factor
    applyScale(key, lo, hi)
  }

  /** Pick which Y-like scale a cursor position should target.
   *
   *  At the cursor's X, find the data point of every recorded
   *  channel, project each to canvas Y using its own scale, and
   *  return the scale whose canvas Y is closest to the cursor's
   *  clientY. Falls back to ``'y'`` when ``y_alt`` doesn't exist
   *  or the projection isn't possible. */
  const pickYScale = (clientX: number, clientY: number): string => {
    const u = plotRef.current
    if (!u || !containerRef.current) return 'y'
    // Stacked: the lane under the cursor.
    const laneList = lanesRef.current.list
    if (laneList.length >= 2) {
      const over = u.over.getBoundingClientRect()
      if (over.height <= 0) return laneList[0].scale
      return laneList[lanes.laneAt((clientY - over.top) / over.height, laneList.length, over.height)].scale
    }
    const hasAlt = !!u.scales.y_alt
    const hasStim = !!u.scales.stim
    if (!hasAlt && !hasStim) return 'y'
    const rect = containerRef.current.getBoundingClientRect()
    const cssX = clientX - rect.left
    const cssY = clientY - rect.top
    const dpr = devicePixelRatio || 1
    const xVal = u.posToVal(cssX * dpr, 'x')
    if (!isFinite(xVal)) return 'y'

    // Find the index in u.data[0] (time) closest to xVal.
    const xs = u.data[0] as number[] | undefined
    if (!xs || xs.length === 0) return 'y'
    // Binary search — time is monotonic.
    let lo = 0, hi = xs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (xs[mid] < xVal) lo = mid + 1
      else hi = mid
    }
    const sampleIdx = lo

    let bestKey: 'y' | 'y_alt' | 'stim' = 'y'
    let bestDist = Infinity
    for (let i = 1; i < u.series.length; i++) {
      const s = u.series[i]
      const scaleKey = (s.scale ?? 'y') as string
      if (scaleKey !== 'y' && scaleKey !== 'y_alt' && scaleKey !== 'stim') continue
      const arr = u.data[i] as (number | null)[] | undefined
      if (!arr) continue
      const v = arr[sampleIdx]
      if (v == null || !isFinite(v)) continue
      const cssYpx = u.valToPos(v, scaleKey, false)
      const d = Math.abs(cssYpx - cssY)
      if (d < bestDist) {
        bestDist = d
        bestKey = scaleKey as 'y' | 'y_alt' | 'stim'
      }
    }
    return bestKey
  }

  /** Auto-range an axis to fit its data. */
  const autoScale = (key: string) => {
    const u = plotRef.current
    if (!u) return
    if (key !== 'x' && lanesRef.current.list.length >= 2) {
      const lane = lanesRef.current.list.find((l) => l.scale === key)
      if (lane) setLaneRange(lane, ...lanesRef.current.auto(lane))
      return
    }

    if (key === 'x') {
      const st = useAppStore.getState()
      // Viewport mode: "auto X" = expand the viewport to the whole sweep.
      // Staying in viewport mode means mouse pan + zoom keep working through
      // the viewport system (properly refetched data), instead of flipping
      // to Full mode where you pan through a decimated 5000-point view of
      // the whole sweep with no sensible mid-drag refetch.
      if (st.viewport && st.sweepDuration > 0) {
        st.setViewport({ start: 0, end: st.sweepDuration })
        return
      }
      // Full mode: clear the saved X range so the hook returns [dataMin, dataMax].
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      if (cur.x) {
        const { x: _x, ...rest } = cur
        st.saveSeriesAxisRange(currentGroup, currentSeries, rest)
      }
      const arr = u.data[0] as number[] | undefined
      if (!arr || arr.length === 0) return
      const first = arr[0]
      const last = arr[arr.length - 1]
      if (!isFinite(first) || !isFinite(last) || first === last) return
      u.setScale('x', { min: first, max: last })
      return
    }

    // Determine which data series indices belong to this scale.
    // Iterate u.series so the scale assignment matches what was set
    // in buildSeriesData (channels with same units → 'y', different
    // units → 'y_alt', stim → 'stim').
    const indices: number[] = []
    for (let i = 1; i < u.series.length; i++) {
      const sScale = (u.series[i].scale ?? 'y') as string
      if (sScale === key) indices.push(i)
    }

    let min = Infinity
    let max = -Infinity
    for (const idx of indices) {
      const arr = u.data[idx] as (number | null)[] | undefined
      if (!arr) continue
      for (const v of arr) {
        if (v == null || !isFinite(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (!isFinite(min) || !isFinite(max) || max === min) return
    const pad = (max - min) * 0.05
    // Persist the result so it survives sweep switches. For 'stim', clear
    // the saved range entirely so the range hook falls back to the
    // protocol-derived default on the next rebuild (simplest "reset" UX).
    const st = useAppStore.getState()
    const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
    if (key === 'y') {
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, y: { min: min - pad, max: max + pad } })
    } else if (key === 'y_alt') {
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, y_alt: { min: min - pad, max: max + pad } })
    } else if (key === 'stim') {
      const { stim: _stim, ...rest } = cur
      st.saveSeriesAxisRange(currentGroup, currentSeries, rest)
    }
    u.setScale(key, { min: min - pad, max: max + pad })
  }

  // ================================================================
  // Mouse wheel zoom near axes
  // ================================================================
  // When the mouse hovers near the bottom (x-axis), left (y-axis), or right
  // (stim axis) edge of the plot, the wheel zooms that scale. Anywhere else,
  // we let the wheel scroll the page normally.
  // Mouse wheel zoom:
  //   Scroll         → zoom X axis (anchored at cursor position)
  //   Option + scroll → zoom Y axis
  //   Shift + scroll  → zoom Stimulus axis (if visible)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const u = plotRef.current
    if (!u || !containerRef.current || !traceData) return

    e.preventDefault()
    const factor = e.deltaY < 0 ? 0.85 : 1.176

    if (e.altKey) {
      // Option/Alt + scroll → zoom whichever Y scale the cursor is
      // closest to (so a multi-channel file can zoom each channel
      // independently — hover the trace you want and Alt+scroll).
      zoomScale(pickYScale(e.clientX, e.clientY), factor)
    } else if (e.shiftKey && stimSeriesIdxRef.current != null) {
      // Shift + scroll → zoom Stimulus axis
      zoomScale('stim', factor)
    } else {
      // Default scroll → zoom X, anchored at mouse position
      const rect = containerRef.current.getBoundingClientRect()
      const cssPx = e.clientX - rect.left
      const canvasPx = cssPx * (devicePixelRatio || 1)
      const val = u.posToVal(canvasPx, 'x')
      if (isFinite(val)) {
        zoomScaleAt('x', factor, val)
      } else {
        zoomScale('x', factor)
      }
    }
  }, [traceData])

  // Outer wrapper is a column flex: control bar + plot container.
  // The plot container is ALWAYS rendered so containerRef stays stable,
  // which is critical for the ResizeObserver to attach correctly.
  return (
    <div className="trace-viewer-root" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* --- Control bar --- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '3px 8px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--font-size-xs)',
          flexShrink: 0,
          minHeight: 26,
        }}
      >
        {/* TracesDropdown now lives in the main Toolbar (before the
            Overlay / Average group) so it's discoverable at first
            glance. Kept the import around for the badge below. */}

        {/* "This sweep is excluded" badge. Click to restore. */}
        <ExcludedSweepBadge />

        {/* Notes on the whole sweep, and the list of every note. */}
        <SweepNoteChips onOpen={(n, anchor) => {
          const box = containerRef.current?.getBoundingClientRect()
          const r = anchor.getBoundingClientRect()
          setNoteDraft({
            id: n.id, group: notesGroup, series: notesSeries, sweep: n.sweep, time: n.time, text: n.text,
            x: box ? r.left - box.left + 130 : 200, y: 8,
          })
        }} />
        <NotesMenu onGo={goToNote} />

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Coordinate-tooltip toggle — shows x/y readout near the cursor
              when hovering over the trace. */}
          <button
            className="zoom-btn"
            onClick={toggleCoordinates}
            disabled={!traceData}
            title={showCoordinates ? 'Hide hover coordinates' : 'Show hover coordinates (x, y)'}
            aria-pressed={showCoordinates}
            style={showCoordinates ? {
              background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
              color: 'var(--accent)',
            } : undefined}
          >
            x,y
          </button>

          {/* X-axis zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>X:</span>
            <button
              className="zoom-btn"
              onClick={() => zoomScale('x', 0.8)}
              disabled={!traceData}
              title="Zoom in X"
            >+</button>
            <button
              className="zoom-btn"
              onClick={() => zoomScale('x', 1.25)}
              disabled={!traceData}
              title="Zoom out X"
            >−</button>
            <button
              className="zoom-btn"
              onClick={() => autoScale('x')}
              disabled={!traceData}
              title="Auto-range X"
            >Auto</button>
          </div>

          {/* Data Y-axis zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>
              {stacked ? 'Lanes' : traceData?.units || 'Y'}:
            </span>
            <button
              className="zoom-btn"
              onClick={() => (lanesRef.current.list.length >= 2 ? zoomAllLanes(0.8) : zoomScale('y', 0.8))}
              disabled={!traceData}
              title={stacked ? 'Zoom in every lane (Option+scroll over a lane zooms just that one)' : 'Zoom in Y'}
            >+</button>
            <button
              className="zoom-btn"
              onClick={() => (lanesRef.current.list.length >= 2 ? zoomAllLanes(1.25) : zoomScale('y', 1.25))}
              disabled={!traceData}
              title={stacked ? 'Zoom out every lane' : 'Zoom out Y'}
            >−</button>
            <button
              className="zoom-btn"
              onClick={() => (lanesRef.current.list.length >= 2 ? autoAllLanes() : autoScale('y'))}
              disabled={!traceData}
              title={stacked ? 'Fit every lane to its data' : 'Auto-range Y'}
            >Auto</button>
          </div>

          {/* Alt Y-axis zoom — visible when an additional channel
              with units that differ from the primary trace is on
              (e.g. an mV channel alongside a pA primary). */}
          {altScaleUnits && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>
                {altScaleUnits}:
              </span>
              <button
                className="zoom-btn"
                onClick={() => zoomScale('y_alt', 0.8)}
                title={`Zoom in ${altScaleUnits}`}
              >+</button>
              <button
                className="zoom-btn"
                onClick={() => zoomScale('y_alt', 1.25)}
                title={`Zoom out ${altScaleUnits}`}
              >−</button>
              <button
                className="zoom-btn"
                onClick={() => autoScale('y_alt')}
                title={`Auto-range ${altScaleUnits}`}
              >Auto</button>
            </div>
          )}

          {/* Stim Y-axis zoom — only when stimulus is a visible trace */}
          {showStimulusOverlay && stimulus && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ color: 'var(--stimulus-color)', marginRight: 4 }}>
                {stimulus.unit}:
              </span>
              <button
                className="zoom-btn"
                onClick={() => zoomScale('stim', 0.8)}
                title="Zoom in stimulus"
              >+</button>
              <button
                className="zoom-btn"
                onClick={() => zoomScale('stim', 1.25)}
                title="Zoom out stimulus"
              >−</button>
              <button
                className="zoom-btn"
                onClick={() => autoScale('stim')}
                title="Auto-range stimulus"
              >Auto</button>
            </div>
          )}
        </div>
      </div>

      {/* --- Viewport bar (window size, scroll, time readout) --- */}
      <ViewportBar />

      {/* --- Plot container --- */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          cursor: traceData
            ? (dragRef.current?.kind === 'pan' ? 'move'
               : dragRef.current?.kind === 'region' ? 'grabbing'
               : dragRef.current?.kind === 'edge' ? 'col-resize'
               : hoverCursor || undefined)
            : undefined,
        }}
        onMouseDown={traceData ? handleMouseDown : undefined}
        onMouseMove={traceData ? handleMouseMove : undefined}
        onMouseUp={traceData ? handleMouseUp : undefined}
        onMouseLeave={traceData ? handleMouseUp : undefined}
        onWheel={traceData ? handleWheel : undefined}
        onContextMenu={onPlotContextMenu}
      >
        {plotMenu}
        {!traceData && <Welcome />}
        {traceData && (
          <NoteFlags
            notes={sweepNotes}
            positions={noteFlags}
            top={noteFlagTop}
            onOpen={(n, x, y) => setNoteDraft({
              id: n.id, group: notesGroup, series: notesSeries, sweep: n.sweep, time: n.time, text: n.text, x, y,
            })}
          />
        )}
        {noteDraft && <NoteEditor draft={noteDraft} onClose={() => setNoteDraft(null)} />}
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        />
        {/* Hover coordinate tooltip — positioned by the setCursor hook. */}
        <div
          ref={coordTooltipRef}
          className="coord-tooltip"
        />
      </div>

      {/* --- Viewport scroll slider --- */}
      <ViewportSlider />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Excluded-sweep badge — rendered inline in the TraceViewer control bar.
// Shows only when the currently-displayed sweep is in the exclusion set;
// click to restore that sweep into the active analysis pool.
// ---------------------------------------------------------------------------

function ExcludedSweepBadge() {
  const group = useAppStore((s) => s.currentGroup)
  const series = useAppStore((s) => s.currentSeries)
  const sweep = useAppStore((s) => s.currentSweep)
  const isExcluded = useAppStore((s) => s.isSweepExcluded(group, series, sweep))
  const toggleSweepExcluded = useAppStore((s) => s.toggleSweepExcluded)
  if (!isExcluded) return null
  return (
    <button
      onClick={() => toggleSweepExcluded(group, series, sweep)}
      title="This sweep is excluded from analyses — click to restore it."
      className="notice notice-warning"
      style={{
        fontSize: 'var(--font-size-xs)',
        fontWeight: 600,
        border: 'none',
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        lineHeight: 1.4,
      }}
    >
      ⊘ Excluded — click to restore
    </button>
  )
}
