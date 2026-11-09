import React, { useEffect, useState, useCallback, useRef, Suspense, lazy } from 'react'
import { useThemeStore } from './stores/themeStore'
import { CursorPositions, useAppStore } from './stores/appStore'
import { WINDOW_KIND } from './utils/windowKind'

// Each analysis window is its own lazy chunk so the shared bundle
// doesn't carry code for all 14 windows in every renderer process.
// Vite emits one chunk per dynamic ``import()`` target; each window
// is loaded only when the user actually opens it. Named-exports get
// shimmed into ``{ default: ... }`` because ``React.lazy`` insists on
// default exports — the modules themselves stay unchanged.
const ResistanceWindow = lazy(() =>
  import('./components/AnalysisWindows/ResistanceWindow').then((m) => ({ default: m.ResistanceWindow })))
const FieldBurstWindow = lazy(() =>
  import('./components/AnalysisWindows/FieldBurstWindow').then((m) => ({ default: m.FieldBurstWindow })))
const SpectralWindow = lazy(() =>
  import('./components/AnalysisWindows/SpectralWindow').then((m) => ({ default: m.SpectralWindow })))
const IVCurveWindow = lazy(() =>
  import('./components/AnalysisWindows/IVCurveWindow').then((m) => ({ default: m.IVCurveWindow })))
const FPspWindow = lazy(() =>
  import('./components/AnalysisWindows/FPspWindow').then((m) => ({ default: m.FPspWindow })))
const CursorAnalysisWindow = lazy(() =>
  import('./components/AnalysisWindows/CursorAnalysisWindow').then((m) => ({ default: m.CursorAnalysisWindow })))
const APWindow = lazy(() =>
  import('./components/AnalysisWindows/APWindow').then((m) => ({ default: m.APWindow })))
const PairedWindow = lazy(() =>
  import('./components/AnalysisWindows/PairedWindow').then((m) => ({ default: m.PairedWindow })))
const EventDetectionWindow = lazy(() =>
  import('./components/AnalysisWindows/EventDetectionWindow').then((m) => ({ default: m.EventDetectionWindow })))
const EventsTemplateGeneratorWindow = lazy(() =>
  import('./components/AnalysisWindows/EventsTemplateGeneratorWindow').then((m) => ({ default: m.EventsTemplateGeneratorWindow })))
const EventsTemplateRefinementWindow = lazy(() =>
  import('./components/AnalysisWindows/EventsTemplateRefinementWindow').then((m) => ({ default: m.EventsTemplateRefinementWindow })))
const EventsBrowserWindow = lazy(() =>
  import('./components/AnalysisWindows/EventsBrowserWindow').then((m) => ({ default: m.EventsBrowserWindow })))
const MetadataWindow = lazy(() =>
  import('./components/AnalysisWindows/MetadataWindow').then((m) => ({ default: m.MetadataWindow })))
const BatchWindow = lazy(() =>
  import('./components/AnalysisWindows/BatchWindow').then((m) => ({ default: m.BatchWindow })))
const CohortWindow = lazy(() =>
  import('./components/AnalysisWindows/CohortWindow').then((m) => ({ default: m.CohortWindow })))
const TraceExportWindow = lazy(() =>
  import('./components/AnalysisWindows/TraceExportWindow').then((m) => ({ default: m.TraceExportWindow })))
const Manual = lazy(() =>
  import('./components/Manual/Manual').then((m) => ({ default: m.Manual })))

/**
 * Shell for all analysis windows. Runs in a separate Electron BrowserWindow.
 *
 * Responsibilities:
 * - Initialize theme
 * - Connect to the Python backend
 * - Listen for cursor updates from the main window via BroadcastChannel
 * - Route to the correct analysis component based on `view` prop
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

/** Catches a crash inside one analysis window and shows it, instead of
 *  leaving a blank window. "Try again" re-mounts the window. */
class WindowErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Analysis window crashed:', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 24, color: 'var(--text-primary)', fontSize: 'var(--font-size-label)' }}>
        <div className="notice notice-error" style={{ marginBottom: 12 }}>
          This window hit an error and stopped drawing.
        </div>
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {String(this.state.error?.message ?? this.state.error)}
        </pre>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}

export function AnalysisWindow({ view }: { view: string }) {
  const { initTheme } = useThemeStore()
  const [backendUrl, setBackendUrl] = useState('')
  const [backendReady, setBackendReady] = useState(false)
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null)
  const [cursors, setCursors] = useState<CursorPositions>({
    baselineStart: 0,
    baselineEnd: 0.01,
    peakStart: 0.01,
    peakEnd: 0.05,
    fitStart: 0.01,
    fitEnd: 0.1,
  })
  const [currentSweep, setCurrentSweep] = useState(0)
  // Current tree selection mirrored from the main window, so analysis
  // windows can preselect the right group/series/trace without the user
  // having to pick it again.
  const [mainGroup, setMainGroup] = useState<number | null>(null)
  const [mainSeries, setMainSeries] = useState<number | null>(null)
  const [mainTrace, setMainTrace] = useState<number | null>(null)
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors

  // Mirror the main window's cursors into this window's store. Windows
  // that drag a single band edge merge it with ``useAppStore`` cursors
  // before broadcasting; without this mirror that store still holds the
  // defaults, and the first drag snapped every other band to them.
  useEffect(() => {
    useAppStore.getState().setCursors(cursors)
  }, [cursors])

  // Initialize
  useEffect(() => {
    initTheme();
    (async () => {
      const url = window.electronAPI
        ? await window.electronAPI.getBackendUrl()
        : 'http://localhost:8321'
      setBackendUrl(url)
      // The analysis window runs in a separate Electron BrowserWindow with
      // its own Zustand store instance. Inject the backend URL into that
      // store so any store actions the analysis components call (e.g. the
      // burst-detection actions on `useAppStore`) build absolute URLs — if
      // we skip this the relative "/api/..." path falls back to the Vite
      // dev-server origin and you get a 404 "Not Found".
      useAppStore.setState({ backendUrl: url, backendReady: true })

      // Wait for backend
      for (let i = 0; i < 60; i++) {
        try {
          const resp = await fetch(`${url}/health`)
          if (resp.ok) { setBackendReady(true); break }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 500))
      }
    })()
  }, [initTheme])

  // Poll file info
  const refreshFileInfo = useCallback(async () => {
    if (!backendUrl) return
    try {
      const resp = await fetch(`${backendUrl}/api/files/info`)
      if (resp.ok) {
        const data = await resp.json()
        setFileInfo(data)
      }
    } catch { /* ignore */ }
  }, [backendUrl])

  useEffect(() => {
    if (!backendReady) return
    refreshFileInfo()
    const id = setInterval(refreshFileInfo, 3000)
    return () => clearInterval(id)
  }, [backendReady, refreshFileInfo])

  // Listen for cursor + sweep updates from the main window
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('tracer-sync')

      ch.onmessage = (ev) => {
        // The store's own broadcasts come back to this window too, and
        // late: adopting one during or after a file switch re-armed the
        // auto-save and emptied the previous file's sidecar in Batch
        // (#19), or could carry its results into the next file. This
        // window already has that state, so ignore its own echoes.
        if (ev.data?.src === WINDOW_KIND) return
        if (ev.data?.type === 'cursor-update' && ev.data.cursors) {
          setCursors(ev.data.cursors)
        }
        if (ev.data?.type === 'sweep-update' && ev.data.sweep != null) {
          setCurrentSweep(ev.data.sweep)
        }
        if (ev.data?.type === 'selection-update') {
          if (ev.data.group != null) setMainGroup(ev.data.group)
          if (ev.data.series != null) setMainSeries(ev.data.series)
          if (ev.data.trace != null) setMainTrace(ev.data.trace)
        }
        if (ev.data?.type === 'state-update') {
          if (ev.data.cursors) setCursors(ev.data.cursors)
          if (ev.data.sweep != null) setCurrentSweep(ev.data.sweep)
          if (ev.data.group != null) setMainGroup(ev.data.group)
          if (ev.data.series != null) setMainSeries(ev.data.series)
          if (ev.data.trace != null) setMainTrace(ev.data.trace)
          if (ev.data.fieldBursts) {
            useAppStore.setState({ fieldBursts: ev.data.fieldBursts })
          }
          if (ev.data.spectralAnalyses) {
            useAppStore.setState({ spectralAnalyses: ev.data.spectralAnalyses })
          }
          if (ev.data.burstFormParams) {
            useAppStore.setState({ burstFormParams: ev.data.burstFormParams })
          }
          if (ev.data.burstDualForm) {
            useAppStore.setState({ burstDualForm: ev.data.burstDualForm })
          }
          if (ev.data.trainParams) {
            useAppStore.setState({ trainParams: ev.data.trainParams })
          }
          if (ev.data.ivCurves) {
            useAppStore.setState({ ivCurves: ev.data.ivCurves })
          }
          if (ev.data.fpspCurves) {
            useAppStore.setState({ fpspCurves: ev.data.fpspCurves })
          }
          if (ev.data.cursorAnalyses) {
            useAppStore.setState({ cursorAnalyses: ev.data.cursorAnalyses })
          }
          if (ev.data.apAnalyses) {
            useAppStore.setState({ apAnalyses: ev.data.apAnalyses })
          }
          if (ev.data.eventsAnalyses) {
            useAppStore.setState({ eventsAnalyses: ev.data.eventsAnalyses })
          }
          if (ev.data.pairedAnalyses) {
            useAppStore.setState({ pairedAnalyses: ev.data.pairedAnalyses })
          }
          if (ev.data.pairedForm) {
            useAppStore.setState({ pairedForm: ev.data.pairedForm })
          }
          if (ev.data.eventsTemplates) {
            useAppStore.setState({ eventsTemplates: ev.data.eventsTemplates })
          }
          if (ev.data.excludedSweeps) {
            useAppStore.setState({ excludedSweeps: ev.data.excludedSweeps })
          }
          if (ev.data.traceNotes) {
            useAppStore.setState({ traceNotes: ev.data.traceNotes })
          }
          if (ev.data.averagedSweeps) {
            useAppStore.setState({ averagedSweeps: ev.data.averagedSweeps })
          }
          if (ev.data.resistanceResults) {
            useAppStore.setState({ resistanceResults: ev.data.resistanceResults })
          }
          if (ev.data.recordingMeta !== undefined) {
            useAppStore.setState({ recordingMeta: ev.data.recordingMeta })
          }
          if (ev.data.scaleOverrides) {
            useAppStore.setState({ scaleOverrides: ev.data.scaleOverrides })
          }
          // The metadata window needs full recording info (filePath +
          // groups → series labels) to drive its left-pane file list and
          // the per-series chip rows. Other analysis windows ignore this
          // field; it's harmless for them.
          if (ev.data.recording) {
            useAppStore.setState({ recording: ev.data.recording })
          }
        }
        // Live tag-edit pushes from another window (typically the
        // metadata window) → adopt into this window's store instance
        // so the toolbar status dot + any series-tag overlays update
        // without a round-trip through state-request.
        if (ev.data?.type === 'meta-update' && ev.data.recordingMeta !== undefined) {
          // Same file-path guard as CursorPanel — see the rationale
          // there. Older broadcasts without ``file_path`` still
          // pass through.
          const targetPath = ev.data.file_path
          const currentPath = useAppStore.getState().recording?.filePath
          if (targetPath === undefined || targetPath === currentPath) {
            useAppStore.setState({ recordingMeta: ev.data.recordingMeta })
          }
        }
        // Bursts from another window (or a newly opened file): without
        // this an open Burst window kept the previous file's bursts.
        if (ev.data?.type === 'bursts-update' && ev.data.fieldBursts) {
          useAppStore.setState({ fieldBursts: ev.data.fieldBursts })
        }
        if (ev.data?.type === 'spectral-update' && ev.data.spectralAnalyses) {
          useAppStore.setState({ spectralAnalyses: ev.data.spectralAnalyses })
        }
        if (ev.data?.type === 'iv-update' && ev.data.ivCurves) {
          useAppStore.setState({ ivCurves: ev.data.ivCurves })
        }
        if (ev.data?.type === 'fpsp-update' && ev.data.fpspCurves) {
          useAppStore.setState({ fpspCurves: ev.data.fpspCurves })
        }
        if (ev.data?.type === 'cursor-analyses-update' && ev.data.cursorAnalyses) {
          useAppStore.setState({ cursorAnalyses: ev.data.cursorAnalyses })
        }
        if (ev.data?.type === 'ap-update' && ev.data.apAnalyses) {
          useAppStore.setState({ apAnalyses: ev.data.apAnalyses })
        }
        if (ev.data?.type === 'paired-update') {
          if (ev.data.pairedAnalyses) {
            useAppStore.setState({ pairedAnalyses: ev.data.pairedAnalyses })
          }
          if (ev.data.pairedForm) {
            useAppStore.setState({ pairedForm: ev.data.pairedForm })
          }
        }
        if (ev.data?.type === 'resistance-update' && ev.data.resistanceResults) {
          useAppStore.setState({ resistanceResults: ev.data.resistanceResults })
        }
        // Event-detection cross-window sync: sub-windows (template
        // generator, refine) save/select/delete templates into their
        // own store instance; the parent main events window listens
        // for these to keep its Template library dropdown in lockstep.
        if (ev.data?.type === 'events-templates-update' && ev.data.eventsTemplates) {
          useAppStore.setState({ eventsTemplates: ev.data.eventsTemplates })
        }
        if (ev.data?.type === 'events-update' && ev.data.eventsAnalyses) {
          useAppStore.setState({ eventsAnalyses: ev.data.eventsAnalyses })
        }
        if (ev.data?.type === 'excluded-update' && ev.data.excludedSweeps) {
          useAppStore.setState({ excludedSweeps: ev.data.excludedSweeps })
        }
        if (ev.data?.type === 'notes-update' && ev.data.traceNotes) {
          useAppStore.setState({ traceNotes: ev.data.traceNotes })
        }
        if (ev.data?.type === 'averaged-update' && ev.data.averagedSweeps) {
          useAppStore.setState({ averagedSweeps: ev.data.averagedSweeps })
        }
        // Burst-detection form-state broadcast from another window (e.g.
        // the main window pushing freshly-loaded prefs on file open).
        if (ev.data?.type === 'burst-dual-form-update' && ev.data.burstDualForm) {
          useAppStore.setState({ burstDualForm: ev.data.burstDualForm })
        }
        if (ev.data?.type === 'burst-form-params-update' && ev.data.burstFormParams) {
          useAppStore.setState({ burstFormParams: ev.data.burstFormParams })
        }
        // Train-grouping params from any window — keep this window's
        // store in sync so the TrainOptions sidepanel rehydrates and
        // the live `useMemo`-driven train overlay picks up changes.
        if (ev.data?.type === 'train-params-update' && ev.data.trainParams) {
          useAppStore.setState({ trainParams: ev.data.trainParams })
        }
        // Scale overrides changed elsewhere → adopt into this window's
        // store. Analysis windows fetch their own trace data on every
        // run / sweep change, so they don't need an explicit refetch
        // here; the new RecordingInfo carrying corrected channels[]
        // .units arrives via the next state-update / state-request
        // cycle if axis labels need refreshing.
        if (ev.data?.type === 'scale-overrides-update' && ev.data.scaleOverrides) {
          useAppStore.setState({ scaleOverrides: ev.data.scaleOverrides })
        }
      }

      // Request current state
      ch.postMessage({ type: 'state-request' })

      return () => ch.close()
    } catch { /* BroadcastChannel not available */ }
  }, [])

  const TITLES: Record<string, string> = {
    cursors: 'Cursor Measurements',
    resistance: 'Rs / Rin / Cm',
    iv: 'I-V Curve',
    action_potential: 'Action Potentials',
    paired: 'Paired Recording',
    events: 'Event Detection',
    events_template_generator: 'Events — Template Generator',
    events_template_refinement: 'Events — Refine Template',
    events_browser: 'Events — Browser & Overlay',
    metadata: 'Metadata',
    cohort_analysis: 'Cohort Analysis',
    trace_export: 'Trace Export',
    bursts: 'Burst Detection',
    kinetics: 'Kinetics & Fitting',
    field_potential: 'Field PSP',
    spectral: 'Spectral Analysis',
  }

  const title = TITLES[view] || view

  // The native title bar shows the window name and recording, so the
  // page itself needs no header strip.
  useEffect(() => {
    document.title = fileInfo?.fileName ? `${title} — ${fileInfo.fileName}` : title
  }, [title, fileInfo?.fileName])

  if (!backendReady) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-muted)',
      }}>
        Connecting to backend…
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
    }}>
      {/* Analysis content. Each window is its own lazy chunk —
          Suspense covers the brief disk read + parse on first open. */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <WindowErrorBoundary>
        <Suspense fallback={
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--text-muted)',
            fontSize: 'var(--font-size-label)', fontStyle: 'italic',
          }}>
            Loading…
          </div>
        }>
        {view === 'resistance' ? (
          <ResistanceWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            cursors={cursors}
            currentSweep={currentSweep}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
          />
        ) : view === 'bursts' ? (
          <FieldBurstWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            currentSweep={currentSweep}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
          />
        ) : view === 'spectral' ? (
          <SpectralWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            currentSweep={currentSweep}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
          />
        ) : view === 'iv' ? (
          <IVCurveWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            currentSweep={currentSweep}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'field_potential' ? (
          <FPspWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'cursors' ? (
          <CursorAnalysisWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'action_potential' ? (
          <APWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
          />
        ) : view === 'paired' ? (
          <PairedWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
          />
        ) : view === 'events' ? (
          <EventDetectionWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'events_template_generator' ? (
          <EventsTemplateGeneratorWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'events_template_refinement' ? (
          <EventsTemplateRefinementWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
          />
        ) : view === 'events_browser' ? (
          <EventsBrowserWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
          />
        ) : view === 'metadata' ? (
          <MetadataWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
          />
        ) : view === 'cohort_analysis' ? (
          <CohortWindow
            backendUrl={backendUrl}
          />
        ) : view === 'trace_export' ? (
          <TraceExportWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
          />
        ) : view === 'batch_analysis' ? (
          <BatchWindow
            backendUrl={backendUrl}
          />
        ) : view === 'manual' ? (
          <Manual />
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>
            {title} — coming soon
          </div>
        )}
        </Suspense>
        </WindowErrorBoundary>
      </div>
    </div>
  )
}
