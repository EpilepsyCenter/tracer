import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  CursorPositions,
  EventsTemplate,
} from '../../stores/appStore'
import { useThemeStore, useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { CoefficientStepper } from '../common/CoefficientStepper'
import {
  Viewport, SetViewport, ViewportBar, ViewportSlider, shiftViewportBy,
} from '../common/ContinuousViewport'
import { usePlotMenu } from '../common/PlotMenu'

/**
 * Template Generator — separate Electron BrowserWindow.
 *
 * Purpose: interactively fit a biexponential event template to a
 * user-selected exemplar event from the recording. User picks a clean
 * event by dragging the baseline cursor pair to span it, clicks "Fit
 * biexponential", tweaks the result manually if needed, and saves
 * back to the shared template library.
 *
 * Communication with the main events window:
 *   - Shared app store (via Electron state-broadcast) — the template
 *     library is a global slice, so saving here updates the main
 *     window's library too.
 *   - Main-store `cursors` — the same baseline/peak cursor bands
 *     that live in every analysis window. User drags them on this
 *     viewer; main window sees the same positions.
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

// CSS form for JSX; canvas code reads ``cssVar('--cursor-baseline')``.
const CURSOR_COLOR = 'var(--cursor-baseline)'

export function EventsTemplateGeneratorWindow({
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
    eventsTemplates, fitEventsTemplate,
    saveEventsTemplate, selectEventsTemplate,
    setCursors,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [channel, setChannel] = useState(mainTrace ?? 0)
  const [sweep, setSweep] = useState(0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
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

  // Viewport nav.
  const [viewport, setViewport] = useState<Viewport>({ tStart: 0, tEnd: 10 })
  const [sweepDurationS, setSweepDurationS] = useState(0)
  // Once the viewport has been set explicitly (by session handoff from
  // the main window, or by the user navigating in-generator), stop
  // auto-resetting it when the sweep changes. Otherwise the default
  // "0..10 s" would clobber the main window's viewport the instant the
  // generator's trace fetch completes and sweepDurationS updates.
  const viewportExplicitlySetRef = useRef(false)
  useEffect(() => {
    if (viewportExplicitlySetRef.current) return
    if (sweepDurationS <= 0) return
    setViewport({ tStart: 0, tEnd: Math.min(10, sweepDurationS) })
    viewportExplicitlySetRef.current = true
  }, [sweepDurationS])
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

  // Cursor sync with main window.
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    setCursors(next)
    try {
      const ch = new BroadcastChannel('tracer-sync')
      const merged = { ...useAppStore.getState().cursors, ...next }
      ch.postMessage({ type: 'cursor-update', cursors: merged })
      ch.close()
    } catch { /* ignore */ }
  }, [setCursors])

  const bringCursorsToView = useCallback(() => {
    const vp = viewport ?? { tStart: 0, tEnd: sweepDurationS || 10 }
    const len = Math.max(1e-3, vp.tEnd - vp.tStart)
    updateCursors({
      baselineStart: vp.tStart + 0.40 * len,
      baselineEnd: vp.tStart + 0.60 * len,
    })
  }, [viewport, sweepDurationS, updateCursors])

  /** Trim Left Edge (EE): nudge the selection's start by `ms`
   *  milliseconds, keeping the end fixed. Useful to align the left
   *  edge of the selection with the event foot — biexp fitting is
   *  very sensitive to this. */
  const trimLeftEdge = useCallback((deltaMs: number) => {
    const dt = deltaMs / 1000
    updateCursors({
      baselineStart: Math.max(0, cursors.baselineStart + dt),
    })
  }, [cursors.baselineStart, updateCursors])

  // Active template from library.
  const activeId = eventsTemplates.selectedId
  const activeTemplate: EventsTemplate | null =
    (activeId && eventsTemplates.entries[activeId]) || null

  // Direction and filter used for the fit.
  const [direction, setDirection] = useState<'auto' | 'negative' | 'positive'>(
    activeTemplate?.direction ?? 'negative',
  )
  useEffect(() => {
    if (activeTemplate) setDirection(activeTemplate.direction)
  }, [activeTemplate?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [filterEnabled, setFilterEnabled] = useState(false)
  const [filterType, setFilterType] = useState<'lowpass' | 'highpass' | 'bandpass'>('bandpass')
  const [filterLow, setFilterLow] = useState(1)
  const [filterHigh, setFilterHigh] = useState(500)
  const [filterOrder, setFilterOrder] = useState(4)

  // Hydrate group/series/channel/sweep/viewport/filter from the main
  // events window's session snapshot so the generator opens on the
  // SAME view the user was looking at. On mount we read the prefs
  // slot once; then we listen for live broadcasts (so if the user
  // navigates in the main window while the generator is open, it
  // follows along).
  const applySession = useCallback((s: any) => {
    if (!s || typeof s !== 'object') return
    if (typeof s.group === 'number') setGroup(s.group)
    if (typeof s.series === 'number') setSeries(s.series)
    if (typeof s.channel === 'number') setChannel(s.channel)
    if (typeof s.sweep === 'number') setSweep(s.sweep)
    if (s.viewport && typeof s.viewport.tStart === 'number'
        && typeof s.viewport.tEnd === 'number') {
      // Mark BEFORE setState so the default-viewport effect (which
      // fires on sweepDurationS loading after the trace fetch) sees
      // the flag set and doesn't override us.
      viewportExplicitlySetRef.current = true
      setViewport({ tStart: s.viewport.tStart, tEnd: s.viewport.tEnd })
    }
    if (s.filter && typeof s.filter === 'object') {
      setFilterEnabled(!!s.filter.enabled)
      if (typeof s.filter.type === 'string') setFilterType(s.filter.type)
      if (typeof s.filter.low === 'number') setFilterLow(s.filter.low)
      if (typeof s.filter.high === 'number') setFilterHigh(s.filter.high)
      if (typeof s.filter.order === 'number') setFilterOrder(s.filter.order)
    }
  }, [])
  useEffect(() => {
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        applySession(prefs?.eventsWindowSession)
      } catch { /* ignore */ }
    })()
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'events-session-update'
            && ev.data.eventsWindowSession) {
          applySession(ev.data.eventsWindowSession)
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [applySession])

  // Diagnostic from the last fit — shown as "R² = 0.XXX" so the user
  // sees quality without a separate orange curve overlay (which made
  // people wonder which of black/yellow was the "real" template).
  const [lastFitR2, setLastFitR2] = useState<number | null>(null)
  const [saveName, setSaveName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  /** Working coefficients — the generator's draft / preview state.
   *  Edits via sliders and "Fit biexponential" update this local
   *  state ONLY. Committing to the library is explicit: either
   *  "Apply to existing" (overwrites the selected template) or
   *  "Save as new" (creates a copy). Matches EE's Generate-Template
   *  flow where tweaks don't persist until the user presses Apply. */
  type PreviewCoeffs = {
    b0: number; b1: number
    tauRiseMs: number; tauDecayMs: number
    widthMs: number
    direction: 'positive' | 'negative'
  }
  const [preview, setPreview] = useState<PreviewCoeffs | null>(null)
  // Reset preview to the active template's coefficients whenever the
  // library selection changes — the user is now editing a fresh copy
  // of that entry, any pending tweaks on the previous one are dropped.
  useEffect(() => {
    if (!activeTemplate) { setPreview(null); return }
    setPreview({
      b0: activeTemplate.b0, b1: activeTemplate.b1,
      tauRiseMs: activeTemplate.tauRiseMs, tauDecayMs: activeTemplate.tauDecayMs,
      widthMs: activeTemplate.widthMs,
      direction: activeTemplate.direction,
    })
  }, [activeTemplate?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /** True when the preview differs from the library template (i.e.
   *  there are unsaved edits). Drives the "Apply to existing" button
   *  enabled state + the "· modified" indicator. */
  const isDirty = !!(preview && activeTemplate && (
    preview.b0 !== activeTemplate.b0 ||
    preview.b1 !== activeTemplate.b1 ||
    preview.tauRiseMs !== activeTemplate.tauRiseMs ||
    preview.tauDecayMs !== activeTemplate.tauDecayMs ||
    preview.widthMs !== activeTemplate.widthMs ||
    preview.direction !== activeTemplate.direction
  ))

  /** Fit biexponential to the cursor region. Updates the PREVIEW
   *  coefficients only — user must click "Apply to existing" or
   *  "Save as new" to commit. */
  const onFit = async () => {
    if (cursors.baselineEnd <= cursors.baselineStart) {
      setErr('Place the cursor band over a clean event first (use "Cursors to view").')
      return
    }
    try {
      const r = await fitEventsTemplate(
        group, series, channel, sweep,
        cursors.baselineStart, cursors.baselineEnd,
        undefined, undefined, direction,
        filterEnabled
          ? { enabled: filterEnabled, type: filterType, low: filterLow, high: filterHigh, order: filterOrder }
          : null,
      )
      const effectiveDir: 'positive' | 'negative' =
        direction === 'auto' ? (r.b1 < 0 ? 'negative' : 'positive') : direction
      setPreview({
        b0: r.b0, b1: r.b1,
        tauRiseMs: r.tauRiseMs, tauDecayMs: r.tauDecayMs,
        widthMs: activeTemplate?.widthMs ?? Math.max(10, 6 * r.tauDecayMs),
        direction: effectiveDir,
      })
      // No active template yet — create one on-the-fly so there's
      // something to apply to. The preview already holds the fit
      // values; apply-to-existing commits them.
      if (!activeTemplate) {
        const id = `${Date.now().toString(36)}-gen`
        saveEventsTemplate({
          id, name: 'Fitted template',
          b0: r.b0, b1: r.b1,
          tauRiseMs: r.tauRiseMs, tauDecayMs: r.tauDecayMs,
          widthMs: Math.max(10, 6 * r.tauDecayMs),
          direction: effectiveDir,
        })
        selectEventsTemplate(id)
      }
      setLastFitR2(r.rSquared)
      setErr(null)
    } catch (e: any) {
      setErr(e.message ?? String(e))
    }
  }

  /** Apply preview coefficients to the currently-selected library
   *  template. Overwrites its (b0, b1, τ_rise, τ_decay, width,
   *  direction) in place. Propagates through the shared store so the
   *  main events window picks up the new template on its next
   *  detection run. */
  const onApplyToExisting = () => {
    if (!activeTemplate || !preview) return
    saveEventsTemplate({
      ...activeTemplate,
      b0: preview.b0, b1: preview.b1,
      tauRiseMs: preview.tauRiseMs, tauDecayMs: preview.tauDecayMs,
      widthMs: preview.widthMs, direction: preview.direction,
    })
  }

  /** Save a COPY of the preview under a new name. Leaves the
   *  originally-selected template untouched; the new copy becomes
   *  the selected template. */
  const onSaveAs = (name: string) => {
    if (!preview || !name.trim()) return
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    saveEventsTemplate({
      id, name: name.trim(),
      b0: preview.b0, b1: preview.b1,
      tauRiseMs: preview.tauRiseMs, tauDecayMs: preview.tauDecayMs,
      widthMs: preview.widthMs, direction: preview.direction,
    })
    selectEventsTemplate(id)
    setSaveName('')
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      {/* Top row: selectors */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
        background: 'var(--bg-secondary)',
        padding: '6px 10px',
        borderRadius: 4,
        border: '1px solid var(--border)',
      }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
          <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Group</span>
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
          <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Series</span>
          <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
          <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Channel</span>
          <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}
                  disabled={channels.length === 0}>
            {channels.map((c: any) => (
              <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
          <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Sweep</span>
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
        </label>
      </div>

      {/* Two-column body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 8 }}>
        {/* LEFT: config + library */}
        <div style={{
          width: 340, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 8,
          background: 'var(--bg-secondary)', padding: 8,
          borderRadius: 4, border: '1px solid var(--border)',
          overflow: 'auto',
        }}>
          <div className="section-card">
            <span className="section-card-title">Library</span>
            <select value={activeId ?? ''}
              onChange={(e) => e.target.value && selectEventsTemplate(e.target.value)}
              style={{ width: '100%' }}>
              <option value="" disabled>— pick —</option>
              {Object.values(eventsTemplates.entries).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="section-card">
            <span className="section-card-title">Cursors (event region)</span>
            <div className="num" style={{
              color: CURSOR_COLOR,
              fontSize: 'var(--font-size-label)',
            }}>
              {cursors.baselineStart.toFixed(4)} → {cursors.baselineEnd.toFixed(4)} s
            </div>
            <button className="btn" onClick={bringCursorsToView}
              style={{ padding: '2px 6px', fontSize: 'var(--font-size-label)' }}
              title="Centre the cursor band in the middle 20% of the current view">
              Cursors to view
            </button>
            {/* Trim Left Edge — matches EE's Generate Template box. The
                start-of-region sample is critical for biexp fitting;
                users nudge it by small increments until the fit snaps. */}
            <div style={{
              marginTop: 4, paddingTop: 4,
              borderTop: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 'var(--font-size-xs)' }}>
                Trim left edge
              </span>
              <div style={{ display: 'flex', gap: 3 }}>
                <button className="btn" onClick={() => trimLeftEdge(-1)}
                  style={{ flex: 1, padding: '2px 0', fontSize: 'var(--font-size-xs)' }}
                  title="Shift region start 1 ms earlier">
                  ← 1 ms
                </button>
                <button className="btn" onClick={() => trimLeftEdge(-0.1)}
                  style={{ flex: 1, padding: '2px 0', fontSize: 'var(--font-size-xs)' }}
                  title="Shift region start 0.1 ms earlier">
                  ← 0.1
                </button>
                <button className="btn" onClick={() => trimLeftEdge(0.1)}
                  style={{ flex: 1, padding: '2px 0', fontSize: 'var(--font-size-xs)' }}
                  title="Shift region start 0.1 ms later">
                  0.1 →
                </button>
                <button className="btn" onClick={() => trimLeftEdge(1)}
                  style={{ flex: 1, padding: '2px 0', fontSize: 'var(--font-size-xs)' }}
                  title="Shift region start 1 ms later">
                  1 ms →
                </button>
              </div>
            </div>
          </div>

          {/* Coefficient editor — slider + input + ± buttons per
              coefficient, same as EE's Generate Template. The
              user can edit BEFORE or AFTER fitting. Values outside
              the slider range can still be typed into the input. */}
          {activeTemplate && preview && (
            <div className="section-card" style={{ gap: 8 }}>
              <span className="section-card-title">
                Coefficients
                {isDirty && (
                  <span style={{
                    fontSize: 'var(--font-size-xs)', color: 'var(--warning)',
                    fontStyle: 'italic', fontWeight: 400,
                  }}>· modified</span>
                )}
              </span>
              <CoefficientStepper
                label="b0" value={preview.b0} step={0.1}
                onChange={(v) => setPreview({ ...preview, b0: v })}
              />
              <CoefficientStepper
                label="b1" value={preview.b1} step={1}
                onChange={(v) => setPreview({ ...preview, b1: v })}
              />
              <CoefficientStepper
                label="τ rise" value={preview.tauRiseMs} step={0.05}
                min={0.05} max={50}
                onChange={(v) => setPreview({ ...preview, tauRiseMs: v })}
                unit="ms"
              />
              <CoefficientStepper
                label="τ decay" value={preview.tauDecayMs} step={0.5}
                min={0.1} max={500}
                onChange={(v) => setPreview({ ...preview, tauDecayMs: v })}
                unit="ms"
              />
              <CoefficientStepper
                label="width" value={preview.widthMs} step={1}
                min={5} max={500}
                onChange={(v) => setPreview({ ...preview, widthMs: v })}
                unit="ms"
              />
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <button className="btn btn-primary"
                  disabled={!isDirty}
                  onClick={onApplyToExisting}
                  style={{ flex: 1, padding: '4px 0' }}
                  title="Overwrite the selected library template with these coefficients">
                  Apply to existing
                </button>
                <button className="btn"
                  disabled={!isDirty}
                  onClick={() => {
                    if (!activeTemplate) return
                    setPreview({
                      b0: activeTemplate.b0, b1: activeTemplate.b1,
                      tauRiseMs: activeTemplate.tauRiseMs,
                      tauDecayMs: activeTemplate.tauDecayMs,
                      widthMs: activeTemplate.widthMs,
                      direction: activeTemplate.direction,
                    })
                  }}
                  style={{ padding: '4px 10px' }}
                  title="Discard pending edits; reset to the library template">
                  Revert
                </button>
              </div>
            </div>
          )}

          <div className="section-card">
            <span className="section-card-title">Fit</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Direction</span>
              <select value={direction}
                onChange={(e) => setDirection(e.target.value as 'auto' | 'negative' | 'positive')}>
                <option value="auto">Auto</option>
                <option value="negative">Negative</option>
                <option value="positive">Positive</option>
              </select>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={filterEnabled}
                onChange={(e) => setFilterEnabled(e.target.checked)} />
              <span>Filter before fitting</span>
            </label>
            {filterEnabled && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1 }}>Type</span>
                  <select value={filterType}
                    onChange={(e) => setFilterType(e.target.value as typeof filterType)}>
                    <option value="bandpass">Bandpass</option>
                    <option value="lowpass">Lowpass</option>
                    <option value="highpass">Highpass</option>
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1 }}>Low (Hz)</span>
                  <NumInput value={filterLow} step={0.5} min={0} onChange={setFilterLow} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1 }}>High (Hz)</span>
                  <NumInput value={filterHigh} step={10} min={1} onChange={setFilterHigh} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1 }}>Order</span>
                  <NumInput value={filterOrder} step={1} min={1} max={8}
                    onChange={(v) => setFilterOrder(Math.max(1, Math.min(8, Math.round(v))))} />
                </label>
              </>
            )}

            <button className="btn btn-primary" onClick={onFit}
              style={{ padding: '6px 0', marginTop: 4 }}>
              Fit biexponential
            </button>
            {lastFitR2 != null && (
              <span style={{
                fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
              }}>
                Last fit R² = <span className="num">{lastFitR2.toFixed(3)}</span>
              </span>
            )}
          </div>

          {/* Save As new — copies the current template to a new named
              entry in the library. User can keep iterating on the
              current template and occasionally freeze a snapshot. */}
          {activeTemplate && (
            <div className="section-card">
              <span className="section-card-title">Save as new</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <input type="text" placeholder="Template name"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onSaveAs(saveName) }}
                  style={{ flex: 1 }} />
                <button className="btn" disabled={!saveName.trim()}
                  onClick={() => onSaveAs(saveName)}
                  style={{ padding: '2px 10px' }}>
                  Save
                </button>
              </div>
              {Object.keys(eventsTemplates.entries).length > 1 && (
                <button className="btn btn-sm"
                  onClick={() => {
                    if (!activeTemplate) return
                    if (confirm(`Delete template "${activeTemplate.name}"?`)) {
                      useAppStore.getState().deleteEventsTemplate(activeTemplate.id)
                    }
                  }}
                  style={{ alignSelf: 'flex-start' }}>
                  Delete current
                </button>
              )}
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

        {/* RIGHT: viewer */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <TemplateGeneratorViewer
            backendUrl={backendUrl}
            group={group} series={series} channel={channel} sweep={sweep}
            cursors={cursors} updateCursors={updateCursors}
            viewport={viewport} setViewport={setViewport}
            sweepDurationS={sweepDurationS}
            setSweepDurationS={setSweepDurationS}
            shiftViewport={shiftViewport} goHome={goHome} goEnd={goEnd}
            filterEnabled={filterEnabled} filterType={filterType}
            filterLow={filterLow} filterHigh={filterHigh} filterOrder={filterOrder}
            // Template curve on the viewer renders from PREVIEW
            // coefficients so slider tweaks update in real time
            // without committing to the library until the user
            // presses Apply / Save As.
            activeTemplate={activeTemplate && preview ? {
              ...activeTemplate,
              b0: preview.b0, b1: preview.b1,
              tauRiseMs: preview.tauRiseMs, tauDecayMs: preview.tauDecayMs,
              widthMs: preview.widthMs, direction: preview.direction,
            } : activeTemplate}
            theme={theme} fontSize={fontSize}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline continuous viewer — simpler than the main one. Draws trace,
// cursor band, and the last fit curve overlaid on the region.
// ---------------------------------------------------------------------------

function TemplateGeneratorViewer({
  backendUrl, group, series, channel, sweep,
  cursors, updateCursors,
  viewport, setViewport, sweepDurationS, setSweepDurationS,
  shiftViewport, goHome, goEnd,
  filterEnabled, filterType, filterLow, filterHigh, filterOrder,
  activeTemplate,
  theme, fontSize,
}: {
  backendUrl: string
  group: number; series: number; channel: number; sweep: number
  cursors: CursorPositions
  updateCursors: (next: Partial<CursorPositions>) => void
  viewport: Viewport
  setViewport: SetViewport
  sweepDurationS: number
  setSweepDurationS: React.Dispatch<React.SetStateAction<number>>
  shiftViewport: (factor: number) => void
  goHome: () => void
  goEnd: () => void
  filterEnabled: boolean
  filterType: 'lowpass' | 'highpass' | 'bandpass'
  filterLow: number
  filterHigh: number
  filterOrder: number
  /** Current template coefficients — rendered live as a black curve
   *  inside the cursor region so the user can see the effect of
   *  slider changes and fitting immediately (EE's generator does this).
   *  Only ONE curve is drawn — after fitting, the active template
   *  coefficients are updated directly; there's no separate "fit
   *  overlay" to confuse which curve is the current template. */
  activeTemplate: EventsTemplate | null
  theme: string; fontSize: number
}) {
  const themeKey = useThemeKey()
  void theme; void fontSize
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'events-template-gen',
  })
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors
  const templateRef = useRef(activeTemplate)
  templateRef.current = activeTemplate

  const [data, setData] = useState<{ time: Float64Array; values: Float64Array } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!backendUrl) { setData(null); return }
    const parts: string[] = [
      `group=${group}`, `series=${series}`, `sweep=${sweep}`,
      `trace=${channel}`, `max_points=0`,
    ]
    if (viewport) {
      parts.push(`t_start=${viewport.tStart}`)
      parts.push(`t_end=${viewport.tEnd}`)
    }
    if (filterEnabled) {
      parts.push(`filter_type=${filterType}`)
      parts.push(`filter_low=${filterLow}`)
      parts.push(`filter_high=${filterHigh}`)
      parts.push(`filter_order=${filterOrder}`)
    }
    const url = `${backendUrl}/api/traces/data?${parts.join('&')}`
    let cancelled = false
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
        setData({
          time: new Float64Array(d.time ?? []),
          values: new Float64Array(d.values ?? []),
        })
        setErr(null)
      })
      .catch((e) => { if (!cancelled) { setData(null); setErr(String(e)) } })
    return () => { cancelled = true }
  }, [backendUrl, group, series, sweep, channel, viewport,
      filterEnabled, filterType, filterLow, filterHigh, filterOrder,
      sweepDurationS, setSweepDurationS])

  const drawOverlays = useCallback((u: uPlot) => {
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1
    const c = cursorsRef.current

    // Cursor band.
    const a = u.valToPos(c.baselineStart, 'x', true)
    const b = u.valToPos(c.baselineEnd, 'x', true)
    if (isFinite(a) && isFinite(b)) {
      const cursorColor = cssVar('--cursor-baseline')
      ctx.save()
      ctx.globalAlpha = 0.14
      ctx.fillStyle = cursorColor
      ctx.fillRect(Math.min(a, b), u.bbox.top, Math.abs(b - a), u.bbox.height)
      ctx.globalAlpha = 0.85
      ctx.strokeStyle = cursorColor
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      ctx.moveTo(a, u.bbox.top); ctx.lineTo(a, u.bbox.top + u.bbox.height)
      ctx.moveTo(b, u.bbox.top); ctx.lineTo(b, u.bbox.top + u.bbox.height)
      ctx.stroke()
      ctx.restore()
    }

    // Live template curve — drawn from the CURRENT active template's
    // coefficients starting at the cursor region's left edge. Updates
    // instantly when the user drags the coefficient sliders, so they
    // can see whether the template matches the selected event before
    // committing to a new fit. Drawn in the primary text colour (black
    // in the light theme, matching EE's convention).
    const tpl = templateRef.current
    if (tpl) {
      const tStart = c.baselineStart
      const tEnd = c.baselineEnd
      const width = Math.max(0.001, tEnd - tStart)
      const nSamples = Math.max(16, Math.floor(width * 5000))
      ctx.save()
      ctx.strokeStyle = cssVar('--text-primary')
      ctx.lineWidth = 1.5 * dpr
      ctx.setLineDash([])
      ctx.beginPath()
      for (let i = 0; i < nSamples; i++) {
        const t = (i / (nSamples - 1)) * width
        const absT = tStart + t
        const tauRise = Math.max(tpl.tauRiseMs / 1000, 1e-6)
        const tauDecay = Math.max(tpl.tauDecayMs / 1000, 1e-6)
        const y = tpl.b0 + tpl.b1 * (1 - Math.exp(-t / tauRise)) * Math.exp(-t / tauDecay)
        const px = u.valToPos(absT, 'x', true)
        const py = u.valToPos(y, 'y', true)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
      ctx.restore()
    }

    // (No separate "fit overlay" curve — when the user clicks "Fit
    // biexponential", the active template's coefficients update
    // directly, so the template curve above IS the fit result.
    // This removes the two-curves confusion from earlier versions.)
  }, [])

  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  // Preserve user Y zoom across viewport pans / X zooms. Reset only
  // when sweep / series / channel actually changes.
  useEffect(() => {
    if (!viewport) return
    xRangeRef.current = [viewport.tStart, viewport.tEnd]
    const u = plotRef.current
    if (u) u.setScale('x', { min: viewport.tStart, max: viewport.tEnd })
  }, [viewport])
  useEffect(() => {
    yRangeRef.current = null
  }, [group, series, channel, sweep])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) {
      const teardown = (plotRef.current as any)._teardownGen
      if (teardown) teardown()
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!data || data.time.length === 0) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: { time: false, range: (_u, dmin, dmax) => xRangeRef.current ?? [dmin, dmax] },
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
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.25 },
        ],
        hooks: { draw: [(u) => drawOverlays(u)] },
      }
      const payload: uPlot.AlignedData = [Array.from(data.time), Array.from(data.values)]
      plotRef.current = new uPlot(opts, payload, container)

      const over = (plotRef.current as any).over as HTMLDivElement
      // Same click-vs-drag dispatch as EventsSweepViewer — plain drag
      // pans; cursor-band / edge hits start cursor drag. No event-add
      // in this window because there are no detected events here.
      type Drag =
        | { kind: 'cursor-edge'; edge: 'start' | 'end' }
        | { kind: 'cursor-band'; startPxX: number; startStart: number; startEnd: number }
        | {
            kind: 'pan'
            startPxX: number; startPxY: number
            xMin: number; xMax: number; yMin: number; yMax: number
          }
      let drag: Drag | null = null
      const EDGE_PX = 6
      const pxToX = (px: number) => plotRef.current!.posToVal(px, 'x')
      const findCursorHit = (pxX: number) => {
        const u = plotRef.current!
        const c = cursorsRef.current
        const aPx = u.valToPos(c.baselineStart, 'x', false)
        const bPx = u.valToPos(c.baselineEnd, 'x', false)
        const [lo, hi] = aPx <= bPx ? [aPx, bPx] : [bPx, aPx]
        if (Math.abs(pxX - aPx) <= EDGE_PX) return { kind: 'cursor-edge' as const, edge: 'start' as const }
        if (Math.abs(pxX - bPx) <= EDGE_PX) return { kind: 'cursor-edge' as const, edge: 'end' as const }
        if (pxX >= lo + EDGE_PX && pxX <= hi - EDGE_PX) return { kind: 'cursor-band' as const }
        return null
      }
      const onPointerDown = (ev: PointerEvent) => {
        if (ev.button !== 0) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
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
        const u = plotRef.current
        if (!u) return
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (xMin == null || xMax == null || yMin == null || yMax == null) return
        drag = { kind: 'pan', startPxX: pxX, startPxY: pxY, xMin, xMax, yMin, yMax }
        over.setPointerCapture(ev.pointerId)
        over.style.cursor = 'grab'
      }
      const onPointerMove = (ev: PointerEvent) => {
        const u = plotRef.current
        if (!u) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        if (!drag) {
          const hit = findCursorHit(pxX)
          over.style.cursor = !hit ? '' : (hit.kind === 'cursor-edge' ? 'ew-resize' : 'move')
          return
        }
        if (drag.kind === 'cursor-edge') {
          const x = pxToX(pxX)
          updateCursors(drag.edge === 'start' ? { baselineStart: x } : { baselineEnd: x })
          return
        }
        if (drag.kind === 'cursor-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          updateCursors({
            baselineStart: drag.startStart + dx,
            baselineEnd: drag.startEnd + dx,
          })
          return
        }
        if (drag.kind === 'pan') {
          const bboxW = u.bbox.width / (devicePixelRatio || 1)
          const bboxH = u.bbox.height / (devicePixelRatio || 1)
          const dxPx = pxX - drag.startPxX
          const dyPx = pxY - drag.startPxY
          const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
          const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
          const nx: [number, number] = [drag.xMin + dx, drag.xMax + dx]
          const ny: [number, number] = [drag.yMin + dy, drag.yMax + dy]
          xRangeRef.current = nx
          yRangeRef.current = ny
          u.setScale('x', { min: nx[0], max: nx[1] })
          u.setScale('y', { min: ny[0], max: ny[1] })
          setViewport({ tStart: nx[0], tEnd: nx[1] })
          over.style.cursor = 'grabbing'
        }
      }
      const onPointerUp = (ev: PointerEvent) => {
        if (!drag) return
        drag = null
        try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        over.style.cursor = ''
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
          setViewport({ tStart: nMin, tEnd: nMax })
        }
      }
      over.addEventListener('pointerdown', onPointerDown)
      over.addEventListener('pointermove', onPointerMove)
      over.addEventListener('pointerup', onPointerUp)
      over.addEventListener('pointercancel', onPointerUp)
      over.addEventListener('wheel', onWheel, { passive: false })
      ;(plotRef.current as any)._teardownGen = () => {
        over.removeEventListener('pointerdown', onPointerDown)
        over.removeEventListener('pointermove', onPointerMove)
        over.removeEventListener('pointerup', onPointerUp)
        over.removeEventListener('pointercancel', onPointerUp)
        over.removeEventListener('wheel', onWheel)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [data, drawOverlays, updateCursors, setViewport, themeKey])

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
    plotRef.current?.redraw()
  }, [cursors, activeTemplate])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
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
        <span style={{ fontStyle: 'italic' }}>
          Drag the cursor band over a clean event, then click "Fit biexponential".
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
        }}>⚠ {err}</div>
      )}
    </div>
  )
}
