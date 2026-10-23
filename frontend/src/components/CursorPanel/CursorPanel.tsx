import React, { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore, CursorPositions, fileCloseResetSlices, FilterState, RecordingInfo } from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

// ---- Stable, module-level sub-components ----
//
// Previously these were defined INSIDE CursorPanel. Every re-render of the
// parent created a new function identity for each, so React saw them as
// different component types and fully unmounted + remounted all descendants.
// That killed focus on any `<input>` the user was typing into whenever a
// sibling input caused the parent to re-render — which is exactly why typing
// in the axis-range boxes kept dropping on the second keystroke. Hoisting
// these out fixes it.

/** Section wraps a labelled block. ``accent`` colour-codes the title
 *  + left edge — used to map cursor sections to their cursor token
 *  (baseline = green, peak = orange, fit = purple). */
function Section({
  title, accent, children,
}: { title: string; accent?: string; children: React.ReactNode }) {
  const style = accent ? { ['--section-accent' as string]: accent } : undefined
  return (
    <div className={`cp-section ${accent ? 'cp-section-accent' : ''}`} style={style}>
      {title && (
        <div className="cp-section-title">
          <span className="cp-section-tick" />
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

function Divider() {
  return <div className="cp-divider" aria-hidden="true" />
}

/** Readout — label left, mono value right (tabular figures). The
 *  primary measurement display surface in the cursor panel. */
function Readout({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="cp-readout">
      <span className="cp-readout-label">{label}</span>
      <span className="cp-readout-value">
        <span className="num">{value.toFixed(2)}</span>
        {unit && <span className="cp-readout-unit">{unit}</span>}
      </span>
    </div>
  )
}

function CursorInput({
  label, color, startKey, endKey, visKey,
}: {
  label: string; color: string
  startKey: keyof CursorPositions; endKey: keyof CursorPositions
  visKey: 'baseline' | 'peak' | 'fit'
}) {
  // Read what we need directly from the store — keeps this a stable
  // module-level component and avoids threading props through every render.
  const cursors = useAppStore((s) => s.cursors)
  const setCursors = useAppStore((s) => s.setCursors)
  const cursorVisibility = useAppStore((s) => s.cursorVisibility)
  const setCursorVisibility = useAppStore((s) => s.setCursorVisibility)

  return (
    <div style={{ marginBottom: 6, opacity: cursorVisibility[visKey] ? 1 : 0.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        <input
          type="checkbox"
          checked={cursorVisibility[visKey]}
          onChange={() => setCursorVisibility({ [visKey]: !cursorVisibility[visKey] })}
          style={{ margin: 0, accentColor: color }}
        />
        <span
          style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color }}
          onClick={() => setCursorVisibility({ [visKey]: !cursorVisibility[visKey] })}
        >
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, alignItems: 'center', paddingLeft: 18 }}>
        <NumInput
          value={cursors[startKey]}
          step={0.001}
          onChange={(v) => setCursors({ [startKey]: v })}
          style={{ width: 70 }}
        />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
        <NumInput
          value={cursors[endKey]}
          step={0.001}
          onChange={(v) => setCursors({ [endKey]: v })}
          style={{ width: 70 }}
        />
      </div>
    </div>
  )
}

// ---- String input for axis ranges (allows empty = "auto") ----
// Uses type="text" with inputMode="decimal" so intermediate states like
// "", "-", "1.", "-1.2e" stay editable — the browser's native type="number"
// control rejects these and forces React to reset the value mid-keystroke.
// State is updated on every keystroke so the Apply button reads fresh values.
function RangeInput({
  value, onChange, step: _step, placeholder, style,
}: {
  value: string; onChange: (v: string) => void; step?: number; placeholder?: string; style?: React.CSSProperties
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      className="num"
      value={value}
      placeholder={placeholder}
      style={style}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function quickMeasure(
  time: Float64Array, values: Float64Array, cursors: CursorPositions, sr: number,
) {
  // Binary-search the time array for the index whose sample time is >= t.
  // traceData.time comes from the backend's LTTB decimator — the spacing is
  // non-uniform, so `Math.round(t * sr)` (which assumes time[i] = i / sr)
  // would return indices pointing to wrong samples, especially for cursors
  // later in the sweep. Search explicitly instead.
  const n = values.length
  if (n === 0 || time.length === 0) {
    return { baseline: 0, peak: 0, amplitude: 0, peakTime: 0 }
  }
  const idx = (t: number): number => {
    if (t <= time[0]) return 0
    if (t >= time[n - 1]) return n - 1
    let lo = 0, hi = n - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (time[mid] <= t) lo = mid
      else hi = mid
    }
    // lo has time[lo] <= t < time[hi]. Pick the closer of the two.
    return (t - time[lo]) <= (time[hi] - t) ? lo : hi
  }

  const blI0 = idx(cursors.baselineStart)
  const blI1 = Math.max(blI0 + 1, idx(cursors.baselineEnd))
  const pkI0 = idx(cursors.peakStart)
  const pkI1 = Math.max(pkI0 + 1, idx(cursors.peakEnd))

  let blSum = 0
  let blN = 0
  for (let i = blI0; i < blI1 && i < n; i++) { blSum += values[i]; blN++ }
  const baseline = blN > 0 ? blSum / blN : (values[blI0] ?? 0)

  let peakVal = values[pkI0] ?? 0
  let peakIdx = pkI0
  for (let i = pkI0; i < pkI1 && i < n; i++) {
    if (Math.abs(values[i] - baseline) > Math.abs(peakVal - baseline)) {
      peakVal = values[i]; peakIdx = i
    }
  }
  void sr
  return { baseline, peak: peakVal, amplitude: peakVal - baseline, peakTime: time[peakIdx] }
}

export function CursorPanel() {
  const {
    cursors, setCursors, traceData,
    showCursors, toggleCursors, resetCursorsToDefaults,
    cursorVisibility, setCursorVisibility,
    filter, setFilter,
    filtersByChannel, setFilterFor, getFilterForChannel,
    recording,
    zeroOffset, toggleZeroOffset,
    showBurstMarkers, toggleBurstMarkers,
    showEventMarkers, toggleEventMarkers,
    fieldBursts,
    eventsAnalyses,
  } = useAppStore()

  // Does the CURRENT sweep in the CURRENT series have any detected bursts?
  // Drives the enabled/disabled state of the Bursts visibility checkbox.
  const hasBurstsInCurrentSweep = useAppStore((s) => {
    const key = `${s.currentGroup}:${s.currentSeries}`
    const entry = s.fieldBursts[key]
    if (!entry || entry.bursts.length === 0) return false
    return entry.bursts.some((b) => b.sweepIndex === s.currentSweep)
  })
  // Total burst count in the current series (shown next to the label).
  const currentSeriesBurstCount = useAppStore((s) => {
    const key = `${s.currentGroup}:${s.currentSeries}`
    return s.fieldBursts[key]?.bursts.filter((b) => b.sweepIndex === s.currentSweep).length ?? 0
  })
  void fieldBursts  // subscribe the component to changes
  // Event analyses: do we have anything for the current series' sweep?
  // Drives the "Show events" checkbox enabled state.
  const hasEventsInCurrentSweep = useAppStore((s) => {
    const key = `${s.currentGroup}:${s.currentSeries}`
    const entry = s.eventsAnalyses[key]
    return !!entry && entry.events.length > 0 && entry.sweep === s.currentSweep
  })
  const currentSeriesEventCount = useAppStore((s) => {
    const key = `${s.currentGroup}:${s.currentSeries}`
    const entry = s.eventsAnalyses[key]
    return entry && entry.sweep === s.currentSweep ? entry.events.length : 0
  })
  void eventsAnalyses

  const measurements = useMemo(() => {
    if (!traceData) return null
    return quickMeasure(traceData.time, traceData.values, cursors, traceData.samplingRate)
  }, [traceData, cursors])

  // Broadcast cursors + sweep to analysis windows; also receive pushes from
  // analysis windows (burst-detection results + filter config).
  const channelRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('tracer-sync')
      channelRef.current = ch
      ch.onmessage = (ev) => {
        // Cross-window file close — when another window (currently
        // the Batch window before kicking off a multi-file run)
        // posts ``file-close``, clear the main window's per-recording
        // state so its TraceViewer / TreeNavigator don't keep showing
        // the closed file. Shared slice list with ``closeFile``.
        if (ev.data?.type === 'file-close') {
          useAppStore.setState(fileCloseResetSlices() as any)
        }
        if (ev.data?.type === 'state-request' || ev.data?.type === 'cursor-request') {
          const state = useAppStore.getState()
          ch.postMessage({
            type: 'state-update',
            cursors: state.cursors,
            sweep: state.currentSweep,
            group: state.currentGroup,
            series: state.currentSeries,
            trace: state.currentTrace,
            fieldBursts: state.fieldBursts,
            burstFormParams: state.burstFormParams,
            trainParams: state.trainParams,
            ivCurves: state.ivCurves,
            fpspCurves: state.fpspCurves,
            cursorAnalyses: state.cursorAnalyses,
            apAnalyses: state.apAnalyses,
            eventsAnalyses: state.eventsAnalyses,
            pairedAnalyses: state.pairedAnalyses,
            pairedForm: state.pairedForm,
            eventsTemplates: state.eventsTemplates,
            excludedSweeps: state.excludedSweeps,
            averagedSweeps: state.averagedSweeps,
            resistanceResults: state.resistanceResults,
            recordingMeta: state.recordingMeta,
            scaleOverrides: state.scaleOverrides,
            recording: state.recording ? {
              filePath: state.recording.filePath,
              fileName: state.recording.fileName,
              format: state.recording.format,
              groupCount: state.recording.groupCount,
              groups: state.recording.groups,
            } : null,
          })
        }
        // Bursts pushed from an analysis window → adopt them here so the
        // main TraceViewer's burst-marker overlay has data to draw.
        if (ev.data?.type === 'bursts-update' && ev.data.fieldBursts) {
          useAppStore.setState({ fieldBursts: ev.data.fieldBursts })
        }
        // Burst-detection form state (method + params) pushed from the
        // analysis window — adopt so the main-window store can persist
        // it to electron prefs. Without this the settings wouldn't
        // survive an app restart because only the main window has
        // `recording.filePath` set for the persistence subscribe.
        if (ev.data?.type === 'burst-form-params-update' && ev.data.burstFormParams) {
          useAppStore.setState({ burstFormParams: ev.data.burstFormParams })
        }
        // Train-detection params (Burst / Event / AP windows). Adopted
        // here so the sidecar auto-save subscribe block writes them to
        // disk — analysis windows have no `recording.filePath` and so
        // can't persist on their own.
        if (ev.data?.type === 'train-params-update' && ev.data.trainParams) {
          useAppStore.setState({ trainParams: ev.data.trainParams })
        }
        // I-V curves pushed from an analysis window → adopt here so the main
        // window's store has them for persistence.
        if (ev.data?.type === 'iv-update' && ev.data.ivCurves) {
          useAppStore.setState({ ivCurves: ev.data.ivCurves })
        }
        // fPSP data from analysis window.
        if (ev.data?.type === 'fpsp-update' && ev.data.fpspCurves) {
          useAppStore.setState({ fpspCurves: ev.data.fpspCurves })
        }
        // Cursor analysis data from analysis window → adopt here so
        // the main store's subscribe can persist to electron prefs.
        // Without this, the analysis window's broadcasts were ignored
        // and nothing ever got saved to disk, which is why reopening
        // the window showed defaults.
        if (ev.data?.type === 'cursor-analyses-update' && ev.data.cursorAnalyses) {
          useAppStore.setState({ cursorAnalyses: ev.data.cursorAnalyses })
        }
        // AP analyses pushed from the analysis window — same purpose
        // as the cursor-analyses adoption above (main window owns
        // disk persistence).
        if (ev.data?.type === 'ap-update' && ev.data.apAnalyses) {
          useAppStore.setState({ apAnalyses: ev.data.apAnalyses })
        }
        // Paired-recording analyses pushed from the analysis window —
        // adopt so the main store's sidecar auto-save persists them.
        if (ev.data?.type === 'paired-update') {
          const patch: Partial<typeof useAppStore extends { getState: () => infer S } ? S : never> = {}
          if (ev.data.pairedAnalyses) (patch as any).pairedAnalyses = ev.data.pairedAnalyses
          if (ev.data.pairedForm) (patch as any).pairedForm = ev.data.pairedForm
          if (Object.keys(patch).length > 0) {
            useAppStore.setState(patch as any)
          }
        }
        // Per-series resistance results from the ResistanceWindow.
        // Drives the TreeNavigator R badge + the cohort extractor's
        // resistance slice on next sidecar save.
        if (ev.data?.type === 'resistance-update' && ev.data.resistanceResults) {
          useAppStore.setState({ resistanceResults: ev.data.resistanceResults })
        }
        // Event-detection data + template-library updates — adopted
        // by the main window so a) state-update responses to newly-
        // opened sub-windows carry the current state, b) future disk
        // persistence lives in one place.
        if (ev.data?.type === 'events-update' && ev.data.eventsAnalyses) {
          useAppStore.setState({ eventsAnalyses: ev.data.eventsAnalyses })
        }
        if (ev.data?.type === 'events-templates-update' && ev.data.eventsTemplates) {
          useAppStore.setState({ eventsTemplates: ev.data.eventsTemplates })
        }
        // Excluded-sweep changes from any window — adopt so the main
        // store persists to electron prefs and other windows see the
        // same exclusion set.
        if (ev.data?.type === 'excluded-update' && ev.data.excludedSweeps) {
          useAppStore.setState({ excludedSweeps: ev.data.excludedSweeps })
        }
        // User-created averaged sweeps (virtual tree entries).
        if (ev.data?.type === 'averaged-update' && ev.data.averagedSweeps) {
          useAppStore.setState({ averagedSweeps: ev.data.averagedSweeps })
        }
        // Recording-level metadata pushed from the metadata window
        // (file tags / per-series tags / cell_id / notes / toast
        // suppression). Adopt into the main store so the auto-save
        // subscriber persists it to the .tracer sidecar — the
        // metadata window can't write to disk itself because it
        // doesn't own the recording.filePath link.
        if (ev.data?.type === 'meta-update' && ev.data.recordingMeta !== undefined) {
          // File-path guard: drop the update unless it targets the
          // currently-loaded recording. Without this, a tag edit
          // racing with an openFile would land the previous file's
          // tags into the new recording's state and silently save
          // them to the wrong sidecar (the user sees them
          // "disappear" from the file they thought they tagged).
          // ``file_path === undefined`` falls through to the
          // legacy unconditional behavior so older sub-windows
          // that haven't been rebuilt still work — once everything
          // ships the verified path, this fallback can go.
          const targetPath = ev.data.file_path
          const currentPath = useAppStore.getState().recording?.filePath
          if (targetPath !== undefined && targetPath !== currentPath) {
            // Stale broadcast — drop silently.
          } else {
            useAppStore.setState({ recordingMeta: ev.data.recordingMeta })
          }
        }
        // Scale-overrides pushed from another window → adopt + refetch
        // the displayed trace so the main viewer reflects the corrected
        // units. The backend has already been told via the originating
        // window's setScaleOverrides call. Only the main window owns
        // recording.filePath, so it's also responsible for sidecar save.
        if (ev.data?.type === 'scale-overrides-update' && ev.data.scaleOverrides) {
          const ov = ev.data.scaleOverrides
          useAppStore.setState({ scaleOverrides: ov })
          // Refetch the current sweep so axes + values match the new
          // scaling. selectSweep with the same indices is a clean
          // re-fetch path that also restores cursor placement.
          const s = useAppStore.getState()
          if (s.recording) {
            void s.selectSweep(s.currentGroup, s.currentSeries, s.currentSweep, s.currentTrace)
          }
        }
        // Detection filter pushed from an analysis window → adopt in the
        // main viewer's filter panel so the displayed trace has the same
        // processing as what the markers were computed against.
        if (ev.data?.type === 'detection-filter' && ev.data.filter) {
          const f = ev.data.filter
          useAppStore.getState().setFilter({
            enabled: !!f.enabled,
            type: f.type,
            lowCutoff: Number(f.lowCutoff ?? 1),
            highCutoff: Number(f.highCutoff ?? 50),
            order: Number(f.order ?? 4),
          })
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    channelRef.current?.postMessage({ type: 'cursor-update', cursors })
  }, [cursors])

  const currentSweep = useAppStore((s) => s.currentSweep)
  const currentGroup = useAppStore((s) => s.currentGroup)
  const currentSeries = useAppStore((s) => s.currentSeries)
  const currentTrace = useAppStore((s) => s.currentTrace)
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'sweep-update', sweep: currentSweep })
  }, [currentSweep])
  // Live-sync the group/series/trace selection so analysis windows can
  // follow along (e.g. FieldBurstWindow preselects the same series as the
  // main tree).
  useEffect(() => {
    channelRef.current?.postMessage({
      type: 'selection-update',
      group: currentGroup,
      series: currentSeries,
      trace: currentTrace,
    })
  }, [currentGroup, currentSeries, currentTrace])

  // Axis range state (local strings, applied on button click)
  const [xMin, setXMin] = useState('')
  const [xMax, setXMax] = useState('')
  const [yMin, setYMin] = useState('')
  const [yMax, setYMax] = useState('')

  const applyAxisRange = () => {
    try {
      const ch = new BroadcastChannel('tracer-axis-range')
      const range: any = {}
      if (xMin !== '' && xMax !== '') range.x = { min: parseFloat(xMin), max: parseFloat(xMax) }
      if (yMin !== '' && yMax !== '') range.y = { min: parseFloat(yMin), max: parseFloat(yMax) }
      ch.postMessage({ type: 'set-axis-range', ...range })
      ch.close()
    } catch { /* ignore */ }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ---- Cursors ---- */}
      <Section title="">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 6,
            userSelect: 'none',
            fontSize: 'var(--font-size-xs)', fontWeight: 600,
            color: 'var(--text-muted)',
          }}>
            <input type="checkbox" checked={showCursors} onChange={toggleCursors}
              style={{ margin: 0, accentColor: 'var(--accent)' }} />
            Cursors
          </label>
          <button className="btn btn-sm" onClick={resetCursorsToDefaults} disabled={!traceData}>
            Reset
          </button>
        </div>
        <CursorInput label="Baseline" color="var(--cursor-baseline)" startKey="baselineStart" endKey="baselineEnd" visKey="baseline" />
        <CursorInput label="Peak" color="var(--cursor-peak)" startKey="peakStart" endKey="peakEnd" visKey="peak" />
        <CursorInput label="Fit" color="var(--cursor-fit)" startKey="fitStart" endKey="fitEnd" visKey="fit" />
      </Section>

      {/* ---- Quick Readout ---- */}
      {measurements && (
        <Section title="Readout">
          <Readout label="Baseline" value={measurements.baseline} unit={traceData?.units || ''} />
          <Readout label="Peak" value={measurements.peak} unit={traceData?.units || ''} />
          <Readout label="Amplitude" value={measurements.amplitude} unit={traceData?.units || ''} />
          <Readout label="Peak time" value={measurements.peakTime * 1000} unit="ms" />
        </Section>
      )}

      <Divider />

      {/* ---- Detected events visibility toggle ----
           Generic label ("Show/hide detected events") so this reuses cleanly
           when we add minis, action potentials, etc. — not just bursts. */}
      <Section title="">
        <label
          title={
            hasBurstsInCurrentSweep
              ? 'Toggle markers (baseline / threshold lines + event dots) for all detected events on the main viewer'
              : 'No detected events for the current sweep — run detection in an Analyses window first'
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            userSelect: 'none',
            fontSize: 'var(--font-size-sm)',
            color: hasBurstsInCurrentSweep ? 'var(--text-secondary)' : 'var(--text-disabled)',
          }}
        >
          <input
            type="checkbox"
            checked={showBurstMarkers}
            onChange={toggleBurstMarkers}
            disabled={!hasBurstsInCurrentSweep}
            style={{ margin: 0, accentColor: 'var(--accent)' }}
          />
          Show detected bursts
          {hasBurstsInCurrentSweep && (
            <span style={{ marginLeft: 2, color: 'var(--text-muted)' }}>
              ({currentSeriesBurstCount})
            </span>
          )}
        </label>
        {/* Event-detection markers — independent toggle, same pattern
            as bursts. Disabled when there are no events for the
            current sweep. */}
        <label
          title={
            hasEventsInCurrentSweep
              ? 'Toggle peak / foot / decay markers for detected events (mEPSC / mIPSC)'
              : 'No events detected for the current sweep — run detection in the Events window'
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            marginTop: 4,
            userSelect: 'none',
            fontSize: 'var(--font-size-sm)',
            color: hasEventsInCurrentSweep ? 'var(--text-secondary)' : 'var(--text-disabled)',
          }}
        >
          <input
            type="checkbox"
            checked={showEventMarkers}
            onChange={toggleEventMarkers}
            disabled={!hasEventsInCurrentSweep}
            style={{ margin: 0, accentColor: 'var(--accent)' }}
          />
          Show detected events
          {hasEventsInCurrentSweep && (
            <span style={{ marginLeft: 2, color: 'var(--text-muted)' }}>
              ({currentSeriesEventCount})
            </span>
          )}
        </label>
      </Section>

      <Divider />

      {/* ---- Axis Ranges ---- */}
      <Section title="Axis ranges">
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', width: 14 }}>X</span>
          <RangeInput step={0.01} placeholder="min" value={xMin} onChange={setXMin} style={{ width: 65 }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
          <RangeInput step={0.01} placeholder="max" value={xMax} onChange={setXMax} style={{ width: 65 }} />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>s</span>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', width: 14 }}>Y</span>
          <RangeInput
            step={1}
            placeholder="min"
            value={yMin}
            onChange={(v) => {
              setYMin(v)
              // When zero-offset is on, mirror to enforce symmetry around 0.
              if (zeroOffset && v !== '') {
                const n = parseFloat(v)
                if (isFinite(n)) setYMax(String(Math.abs(n)))
              }
            }}
            style={{ width: 65 }}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
          <RangeInput
            step={1}
            placeholder="max"
            value={yMax}
            onChange={(v) => {
              setYMax(v)
              if (zeroOffset && v !== '') {
                const n = parseFloat(v)
                if (isFinite(n)) setYMin(String(-Math.abs(n)))
              }
            }}
            style={{ width: 65 }}
          />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
            {traceData?.units || ''}{zeroOffset && ' (symmetric)'}
          </span>
        </div>
        <button className="btn" onClick={applyAxisRange} style={{ width: '100%', fontSize: 'var(--font-size-xs)' }}>
          Apply ranges
        </button>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 5, marginTop: 6,
          cursor: 'pointer', userSelect: 'none', fontSize: 'var(--font-size-xs)',
        }}>
          <input type="checkbox" checked={zeroOffset} onChange={toggleZeroOffset}
            style={{ margin: 0 }} />
          Subtract zero offset
        </label>
        {zeroOffset && (
          <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2 }}>
            Baseline (first 3 ms) subtracted — traces start at 0
          </p>
        )}
      </Section>

      <Divider />

      {/* ---- Filter ---- */}
      <FilterSection
        currentGroup={currentGroup}
        currentSeries={currentSeries}
        currentTrace={currentTrace}
        recording={recording}
        filter={filter}
        setFilter={setFilter}
        filtersByChannel={filtersByChannel}
        setFilterFor={setFilterFor}
        getFilterForChannel={getFilterForChannel}
      />
    </div>
  )
}

interface FilterSectionProps {
  currentGroup: number
  currentSeries: number
  currentTrace: number
  recording: RecordingInfo | null
  filter: FilterState
  setFilter: (f: Partial<FilterState>) => void
  filtersByChannel: Record<number, FilterState>
  setFilterFor: (channel: number, patch: Partial<FilterState> | null) => void
  getFilterForChannel: (channel: number) => FilterState
}

/** Filter panel — supports per-channel configs.
 *
 *  A channel picker selects which slot the inputs read/write. A
 *  "Default" option targets the global ``filter`` state, which is
 *  the fallback for any channel that has no explicit per-channel
 *  override. The Reset button removes the per-channel entry so the
 *  channel falls back to default again. */
function FilterSection(props: FilterSectionProps) {
  const {
    currentGroup, currentSeries, currentTrace, recording,
    filter, setFilter, filtersByChannel, setFilterFor, getFilterForChannel,
  } = props

  const channels = recording?.groups[currentGroup]?.series[currentSeries]?.channels ?? []

  // Selected slot: number = channel index, 'default' = global filter.
  const [slot, setSlot] = useState<number | 'default'>(currentTrace)

  // Follow currentTrace when the user navigates channels.
  useEffect(() => { setSlot(currentTrace) }, [currentTrace])

  const active: FilterState = slot === 'default'
    ? filter
    : getFilterForChannel(slot)
  const isOverride = slot !== 'default' && filtersByChannel[slot] != null

  const apply = (patch: Partial<FilterState>) => {
    if (slot === 'default') setFilter(patch)
    else setFilterFor(slot, patch)
  }

  return (
    <Section title="Filter">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>Channel</span>
        <select
          value={String(slot)}
          onChange={(e) => {
            const v = e.target.value
            setSlot(v === 'default' ? 'default' : Number(v))
          }}
          style={{ flex: 1 }}
        >
          <option value="default">Default (all)</option>
          {channels.map((c) => (
            <option key={c.index} value={c.index}>
              {c.label || `Ch ${c.index + 1}`}{c.units ? ` (${c.units})` : ''}
            </option>
          ))}
        </select>
        {isOverride && (
          <button
            className="btn"
            onClick={() => setFilterFor(slot as number, null)}
            title="Drop this channel's override and use the default filter"
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
          >reset</button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <input type="checkbox" checked={active.enabled}
          onChange={() => apply({ enabled: !active.enabled })}
          style={{ margin: 0 }} />
        <select value={active.type} onChange={(e) => apply({ type: e.target.value as any })}
          style={{ flex: 1 }}>
          <option value="lowpass">Lowpass</option>
          <option value="highpass">Highpass</option>
          <option value="bandpass">Bandpass</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {(active.type === 'highpass' || active.type === 'bandpass') && (
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Low</span>
            <NumInput value={active.lowCutoff} min={0.1} step={1}
              onChange={(v) => apply({ lowCutoff: v })} style={{ width: 55 }} />
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Hz</span>
          </div>
        )}
        {(active.type === 'lowpass' || active.type === 'bandpass') && (
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>High</span>
            <NumInput value={active.highCutoff} min={1} step={100}
              onChange={(v) => apply({ highCutoff: v })} style={{ width: 55 }} />
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Hz</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Order</span>
          <NumInput value={active.order} min={1} max={8} step={1}
            onChange={(v) => apply({ order: v })} style={{ width: 40 }} />
        </div>
      </div>
      <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4 }}>
        {active.enabled
          ? (slot === 'default'
              ? 'Default filter applied to channels with no override'
              : `Filter applied to ${channels.find((c) => c.index === slot)?.label || `Ch ${(slot as number) + 1}`}`)
          : 'Filter disabled'}
      </p>
    </Section>
  )
}
