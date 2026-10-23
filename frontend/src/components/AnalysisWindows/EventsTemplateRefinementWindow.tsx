import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  EventsData, EventsTemplate, EventsDetectionMeasure,
} from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { CoefficientStepper } from '../common/CoefficientStepper'
import { usePlotMenu } from '../common/PlotMenu'

/**
 * Template Refinement — separate Electron BrowserWindow.
 *
 * Shows all detected events aligned on a chosen anchor (peak / foot /
 * rise-half-width), overlays their average in red, fits a biexp to
 * the average, and lets the user apply the refined template back to
 * the library.
 *
 * Meant for the classic "detect → refine → detect again" loop: the
 * initial template is often a hand-fit to one exemplar, and the
 * average of ~20–100 real detections gives a much cleaner shape for
 * the second pass.
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


export function EventsTemplateRefinementWindow({
  backendUrl, fileInfo,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
}) {
  void fileInfo
  const {
    eventsAnalyses, eventsTemplates, refineEventsTemplate,
    saveEventsTemplate, selectEventsTemplate,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)
  void theme; void fontSize

  // Follow the main events window's current (group, series). On mount
  // we read the session snapshot; afterwards we listen for live
  // broadcasts so if the user navigates in the main window while the
  // refine window is open, the refine window switches to the matching
  // entry. Falls back to "entry with most events" if no session is
  // stored (e.g. the user opens refine without having run detection
  // yet — defensive).
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
        if (ev.data?.type === 'events-session-update'
            && ev.data.eventsWindowSession) {
          const s = ev.data.eventsWindowSession
          if (typeof s.group === 'number' && typeof s.series === 'number') {
            setSessionKey(`${s.group}:${s.series}`)
          }
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  const entry: EventsData | undefined = useMemo(() => {
    if (sessionKey && eventsAnalyses[sessionKey]) {
      return eventsAnalyses[sessionKey]
    }
    const entries = Object.values(eventsAnalyses)
    if (entries.length === 0) return undefined
    return entries.reduce((best, cur) =>
      (cur.events.length > (best?.events.length ?? 0) ? cur : best), entries[0])
  }, [eventsAnalyses, sessionKey])

  const activeId = eventsTemplates.selectedId
  const activeTemplate: EventsTemplate | null =
    (activeId && eventsTemplates.entries[activeId]) || null

  const [align, setAlign] = useState<'peak' | 'foot' | 'rise_halfwidth'>('peak')
  const [windowBeforeMs, setWindowBeforeMs] = useState(5)
  const [windowAfterMs, setWindowAfterMs] = useState(50)
  const [result, setResult] = useState<{
    nAveraged: number
    averageTimeS: number[]; averageValues: number[]
    footSampleIdx: number
    fit: {
      b0: number; b1: number; tauRiseMs: number; tauDecayMs: number
      rSquared: number; fitTimeS: number[]; fitValues: number[]
    }
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const onRefine = async () => {
    if (!entry) {
      setErr('No events detected yet in any series.')
      return
    }
    if (entry.events.length < 2) {
      setErr('Need ≥ 2 events to average.')
      return
    }
    try {
      const r = await refineEventsTemplate(
        entry.group, entry.series, entry.channel, entry.sweep,
        entry.events, align, windowBeforeMs, windowAfterMs,
        activeTemplate?.direction ?? 'negative',
      )
      setResult(r)
      setErr(null)
    } catch (e: any) {
      setErr(e.message ?? String(e))
    }
  }

  const onApply = (mode: 'overwrite' | 'save-as') => {
    if (!result) return
    const dir: 'positive' | 'negative' = result.fit.b1 < 0 ? 'negative' : 'positive'
    if (mode === 'overwrite' && activeTemplate) {
      saveEventsTemplate({
        ...activeTemplate,
        b0: result.fit.b0, b1: result.fit.b1,
        tauRiseMs: result.fit.tauRiseMs, tauDecayMs: result.fit.tauDecayMs,
        direction: dir,
      })
    } else {
      const id = `${Date.now().toString(36)}-refined`
      const name = activeTemplate ? `${activeTemplate.name} (refined)` : 'Refined template'
      saveEventsTemplate({
        id, name,
        b0: result.fit.b0, b1: result.fit.b1,
        tauRiseMs: result.fit.tauRiseMs, tauDecayMs: result.fit.tauDecayMs,
        widthMs: Math.max(10, 6 * result.fit.tauDecayMs),
        direction: dir,
      })
      selectEventsTemplate(id)
    }
  }

  // Auto-run the first refinement when the window first renders with
  // at least two events — saves the user a click.
  useEffect(() => {
    if (entry && entry.events.length >= 2 && result == null && backendUrl) {
      onRefine()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.events.length, backendUrl])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
        background: 'var(--bg-secondary)',
        padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)',
        fontSize: 'var(--font-size-label)',
      }}>
        <span style={{ fontWeight: 600 }}>Refine template</span>
        {entry ? (
          <span style={{ color: 'var(--text-muted)' }}>
            G{entry.group} / S{entry.series} · {entry.events.length} detected events
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>
            No events detected — run detection in the main window first.
          </span>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 8 }}>
        {/* LEFT: options */}
        <div style={{
          width: 300, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 8,
          background: 'var(--bg-secondary)', padding: 8,
          borderRadius: 4, border: '1px solid var(--border)',
          overflow: 'auto', fontSize: 'var(--font-size-label)',
        }}>
          <div className="section-card">
            <span className="section-card-title">Averaging</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Align on</span>
              <select value={align}
                onChange={(e) => setAlign(e.target.value as typeof align)}>
                <option value="peak">Peak</option>
                <option value="foot">Foot</option>
                <option value="rise_halfwidth">Rise half-width</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Before (ms)</span>
              <NumInput value={windowBeforeMs} step={1} min={0}
                onChange={setWindowBeforeMs} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>After (ms)</span>
              <NumInput value={windowAfterMs} step={5} min={1}
                onChange={setWindowAfterMs} />
            </label>
            <button className="btn btn-primary" onClick={onRefine}
              disabled={!entry || entry.events.length < 2}
              style={{ padding: '6px 0', marginTop: 4 }}>
              Fit biexponential to average
            </button>
          </div>

          {result && (
            <div className="section-card">
              <span className="section-card-title">
                Result ({result.nAveraged} events · R² = {result.fit.rSquared.toFixed(3)})
              </span>
              {/* Coefficient stepper — editable manual tweak of the fit
                  result. Matches EE where you can continue tweaking
                  coefficients after fitting the average event. */}
              <CoefficientStepper
                label="b0" value={result.fit.b0} step={0.1}
                onChange={(v) => setResult((r) => r && ({
                  ...r, fit: { ...r.fit, b0: v },
                }))}
              />
              <CoefficientStepper
                label="b1" value={result.fit.b1} step={1}
                onChange={(v) => setResult((r) => r && ({
                  ...r, fit: { ...r.fit, b1: v },
                }))}
              />
              <CoefficientStepper
                label="τ rise" value={result.fit.tauRiseMs} step={0.05}
                min={0.05} max={50}
                onChange={(v) => setResult((r) => r && ({
                  ...r, fit: { ...r.fit, tauRiseMs: v },
                }))}
                unit="ms"
              />
              <CoefficientStepper
                label="τ decay" value={result.fit.tauDecayMs} step={0.5}
                min={0.1} max={500}
                onChange={(v) => setResult((r) => r && ({
                  ...r, fit: { ...r.fit, tauDecayMs: v },
                }))}
                unit="ms"
              />
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                <button className="btn" onClick={() => onApply('overwrite')}
                  disabled={!activeTemplate}
                  style={{ flex: 1 }}>
                  Apply to current
                </button>
                <button className="btn" onClick={() => onApply('save-as')}
                  style={{ flex: 1 }}>
                  Save as new
                </button>
              </div>
            </div>
          )}
          {err && (
            <div className="notice notice-error" style={{
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ flex: 1 }}>⚠ {err}</span>
              <button className="btn btn-sm" onClick={() => setErr(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* RIGHT: plot */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <AveragePlot result={result} />
        </div>
      </div>
    </div>
  )
}

function AveragePlot({
  result,
}: {
  result: {
    averageTimeS: number[]; averageValues: number[]
    fit: {
      fitTimeS: number[]; fitValues: number[]
      // Carry the biexp coefficients so the plot can re-evaluate the
      // fit curve LIVE as the user drags the coefficient steppers,
      // rather than only on the backend's initial fitValues array.
      b0: number; b1: number; tauRiseMs: number; tauDecayMs: number
    }
    footSampleIdx: number
  } | null
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-template-refine',
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!result || result.averageTimeS.length === 0) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const avgX = Array.from(result.averageTimeS)
      const avgY = Array.from(result.averageValues)
      // Evaluate the biexp curve from the current coefficients over
      // the whole avgX (NaN before the foot sample so uPlot doesn't
      // draw the pre-foot garbage). This makes stepper tweaks update
      // the plot immediately without another backend roundtrip.
      const fitY = new Array<number | null>(avgX.length).fill(null)
      const { b0, b1, tauRiseMs, tauDecayMs } = result.fit
      const tauRise = Math.max(tauRiseMs / 1000, 1e-6)
      const tauDecay = Math.max(tauDecayMs / 1000, 1e-6)
      const fitStart = avgX.length > 0 ? avgX[result.footSampleIdx] ?? avgX[0] : 0
      for (let i = result.footSampleIdx; i < avgX.length; i++) {
        const t = avgX[i] - fitStart
        if (t < 0) continue
        fitY[i] = b0 + b1 * (1 - Math.exp(-t / tauRise)) * Math.exp(-t / tauDecay)
      }
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: { x: { time: false } },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time from alignment (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-average'), width: 1.5 },
          { stroke: cssVar('--cursor-fit'), width: 2, spanGaps: false },
        ],
      }
      const payload: uPlot.AlignedData = [avgX, avgY, fitY as any]
      plotRef.current = new uPlot(opts, payload, container)
    })
    return () => cancelAnimationFrame(frame)
  }, [result, themeKey])

  useEffect(() => {
    // Depend on ``result`` because the container element only exists
    // in the rendered tree when ``result`` is truthy (the early-return
    // path above renders a placeholder with no ref). Without this
    // dependency the observer was set up at mount when the ref was
    // still null and never re-attached after the plot div appeared,
    // so the plot never resized with the window.
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    // Also listen on window resize as a belt-and-braces safeguard for
    // browsers / Electron versions where the inner ResizeObserver
    // doesn't fire on parent layout shifts driven purely by chrome
    // resize.
    const onWin = () => {
      const u = plotRef.current
      if (!u) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
    }
  }, [result])

  if (!result) {
    return (
      <div style={{
        height: '100%', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px solid var(--border)', borderRadius: 4,
      }}>
        Click "Fit biexponential to average" to compute and display the average event + fit.
      </div>
    )
  }
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', position: 'relative',
      }}
    >
      {menu}
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}
