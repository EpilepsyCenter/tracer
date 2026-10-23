import React, { useEffect, useMemo, useState, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useThemeStore, FONT_SIZES, TRACE_COLOR_SLOT_COUNT, ThemePref } from '../../stores/themeStore'
import { RecordingTitle } from '../RecordingHeader/RecordingHeader'
import { SidebarIcon } from '../../App'
import { NumInput } from '../common/NumInput'
import { Icon } from '../common/Icon'
import { TracesDropdown } from '../TraceViewer/TracesDropdown'
import { ScalingModal } from '../Scaling/ScalingModal'
import { TextImportWizard } from '../Scaling/TextImportWizard'

/** Convert a CSS colour string (any form: hex, rgb, oklch, named) to
 *  ``#rrggbb`` so it can be assigned as the value of a native
 *  ``<input type="color">``.
 *
 *  Implementation: render the colour into a 1×1 canvas and read the
 *  resulting pixel back via ``getImageData``. The browser's compositor
 *  performs whatever colour-space conversion is needed (oklch → sRGB
 *  in modern Chromium ≥ 111), and ``getImageData`` always returns
 *  sRGB integers regardless of the input form. A magenta sentinel
 *  primed before the assignment lets us detect the rare case where
 *  ``ctx.fillStyle = css`` was rejected (engine doesn't recognise
 *  the input) — we fall back to a hidden DOM probe which uses the
 *  CSS engine itself to resolve the colour (and re-canvases the
 *  resolved value to convert into hex).
 *
 *  The earlier "read ctx.fillStyle" path failed because the getter
 *  returns the colour in its specified form (e.g. ``oklch(...)``)
 *  rather than auto-converting to ``#rrggbb`` — so swatches on
 *  Telegraph / Precision themes stuck on the sentinel. */
function cssColorToHex(css: string): string {
  if (!css) return '#888888'
  const direct = renderToHex(css)
  if (direct) return direct
  // Fallback: ask the CSS engine to resolve the value via
  // ``getComputedStyle``, then run THAT through the canvas. Handles
  // edge cases where ctx.fillStyle rejects the input form even
  // though style.color accepts it.
  try {
    const probe = document.createElement('span')
    probe.style.color = css
    if (!probe.style.color) return '#888888'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.pointerEvents = 'none'
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    document.body.removeChild(probe)
    if (resolved) {
      const second = renderToHex(resolved)
      if (second) return second
    }
  } catch { /* fall through */ }
  return '#888888'
}

/** Helper: render ``css`` into a 1×1 canvas, read the pixel back as
 *  ``#rrggbb``. Returns null when the browser rejected the input
 *  (sentinel survived). */
function renderToHex(css: string): string | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // Magenta sentinel — if the assignment below is rejected, the
    // pixel reads back as #ff00ff and we know to bail.
    ctx.fillStyle = '#ff00ff'
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const data = ctx.getImageData(0, 0, 1, 1).data
    if (data[0] === 0xff && data[1] === 0 && data[2] === 0xff) return null
    const toHex = (n: number) => n.toString(16).padStart(2, '0')
    return `#${toHex(data[0])}${toHex(data[1])}${toHex(data[2])}`
  } catch {
    return null
  }
}

const TRACE_COLOR_LABELS = [
  'Channel 1', 'Channel 2', 'Channel 3', 'Channel 4', 'Channel 5', 'Stimulus',
]
const TRACE_COLOR_VAR_NAMES = [
  '--trace-color-1', '--trace-color-2', '--trace-color-3',
  '--trace-color-4', '--trace-color-5', '--stimulus-color',
]

// Extensions the text reader claims. ``.dat`` is intentionally
// excluded — HEKA's binary .dat would match here too, but its
// reader sits earlier in the dispatch list and we don't want to
// blanket-trigger the wizard for those.
const TEXT_EXTS = ['.csv', '.tsv', '.txt', '.atf']

function isTextLikeExt(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.\\/]+$/)?.[0]
  return ext != null && TEXT_EXTS.includes(ext)
}

const ANALYSIS_TYPES = [
  { type: 'cursors', label: 'Cursor Measurements' },
  { type: 'resistance', label: 'Rs / Rin / Cm' },
  { type: 'iv', label: 'I-V Curve' },
  { type: 'action_potential', label: 'Action Potentials' },
  { type: 'paired', label: 'Paired Recording' },
  { type: 'events', label: 'Event Detection' },
  { type: 'bursts', label: 'Burst Detection' },
  { type: 'field_potential', label: 'Field Potential' },
  { type: 'spectral', label: 'Spectral Analysis' },
]

// Cross-recording / tagging tools. Folded into the single "Tools ▾"
// dropdown so the toolbar's right-hand cluster stays narrow on small
// screens. All four operate across files (no open recording required),
// and read top-to-bottom in the workflow order tag → batch → aggregate
// → export. Each opens a dedicated window via openAnalysisWindow().
const TOOL_TYPES = [
  { type: 'metadata', label: 'Tags…', icon: 'tag', title: 'Tag recordings, groups and series (works without an open file)' },
  { type: 'batch_analysis', label: 'Batch…', icon: 'grid', title: "Replay a template's analyses across a folder of tagged recordings" },
  { type: 'cohort_analysis', label: 'Cohort…', icon: 'users', title: 'Aggregate per-cell metrics across a folder of recordings' },
  { type: 'trace_export', label: 'Export Traces…', icon: 'download', title: 'Build publication-ready figures from sweeps across one or more recordings' },
] as const

interface ToolbarProps {
  leftHidden: boolean
  rightHidden: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
}

export function Toolbar({ leftHidden, rightHidden, onToggleLeft, onToggleRight }: ToolbarProps) {
  const {
    recording, openFile, loading,
    currentSweep, currentSeries, currentGroup, currentTrace,
    selectSweep,
    showOverlay, toggleOverlay, overlayAllSweeps, clearOverlays,
    showAverage, toggleAverage, loadAverageTrace,
    zoomMode, toggleZoomMode,
    selectedSweeps, includedSweepsFor, filterExcludedSweeps,
    createAveragedSweep,
    recentFiles, clearRecentFiles,
  } = useAppStore()
  void toggleOverlay  // currently unused; reference retained to keep the prop picked

  const {
    themePref, setThemePref,
    fontSize, setFontSize,
    traceColors, setTraceColor, resetTraceColors,
  } = useThemeStore()

  const [showSettings, setShowSettings] = useState(false)
  const [showAnalyses, setShowAnalyses] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [showAverageMenu, setShowAverageMenu] = useState(false)
  const [showRecent, setShowRecent] = useState(false)
  const [showScaling, setShowScaling] = useState(false)
  const [scalingFocusKey, setScalingFocusKey] = useState<string | undefined>(undefined)
  const [textImportPath, setTextImportPath] = useState<string | null>(null)

  // Listen for right-click-on-channel events from the TracesDropdown so
  // the same modal can open pre-focused on a specific channel row.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<{ key?: string; matchByIndex?: boolean }>
      // ``matchByIndex`` means the caller passed only the channel
      // index (e.g. from TracesDropdown which doesn't know file
      // units) — prefix the value with ``index:`` so the modal can
      // distinguish from a full composite key.
      const k = ce.detail?.key
      const tagged = ce.detail?.matchByIndex && k != null ? `index:${k}` : k
      setScalingFocusKey(tagged)
      setShowScaling(true)
    }
    window.addEventListener('open-scaling-modal', onOpen as EventListener)
    return () => window.removeEventListener('open-scaling-modal', onOpen as EventListener)
  }, [])

  // Welcome-surface drag-drop / Open click can produce a text-format
  // path; route it through the existing import wizard instead of
  // openFile() so users still get delimiter/units confirmation.
  useEffect(() => {
    const onWelcomeText = (e: Event) => {
      const ce = e as CustomEvent<{ filePath?: string }>
      const fp = ce.detail?.filePath
      if (fp) setTextImportPath(fp)
    }
    window.addEventListener('welcome-open-text', onWelcomeText as EventListener)
    return () => window.removeEventListener('welcome-open-text', onWelcomeText as EventListener)
  }, [])
  // Native menu: File ▸ Open… and Settings…
  useEffect(() => {
    const onOpenFile = () => { void handleOpenFile() }
    const onSettings = () => setShowSettings(true)
    window.addEventListener('menu-open-file', onOpenFile)
    window.addEventListener('open-settings', onSettings)
    return () => {
      window.removeEventListener('menu-open-file', onOpenFile)
      window.removeEventListener('open-settings', onSettings)
    }
  })
  const settingsRef = useRef<HTMLDivElement>(null)
  const analysesRef = useRef<HTMLDivElement>(null)
  const toolsRef = useRef<HTMLDivElement>(null)
  const averageRef = useRef<HTMLDivElement>(null)
  const recentRef = useRef<HTMLDivElement>(null)

  // State for the Average popover.
  const selectedList = selectedSweeps[`${currentGroup}:${currentSeries}`] ?? []
  const [avgMode, setAvgMode] = useState<'all' | 'selected' | 'range'>('all')
  const [avgFrom, setAvgFrom] = useState(1)
  const [avgTo, setAvgTo] = useState(1)
  const [avgLabel, setAvgLabel] = useState('')

  const totalSweeps = recording?.groups[currentGroup]?.series[currentSeries]?.sweepCount ?? 0

  // Close popovers on outside click
  useEffect(() => {
    if (!showSettings && !showAnalyses && !showTools && !showAverageMenu && !showRecent) return
    const onClick = (e: MouseEvent) => {
      if (showSettings && settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false)
      }
      if (showAnalyses && analysesRef.current && !analysesRef.current.contains(e.target as Node)) {
        setShowAnalyses(false)
      }
      if (showTools && toolsRef.current && !toolsRef.current.contains(e.target as Node)) {
        setShowTools(false)
      }
      if (showAverageMenu && averageRef.current && !averageRef.current.contains(e.target as Node)) {
        setShowAverageMenu(false)
      }
      if (showRecent && recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setShowRecent(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showSettings, showAnalyses, showTools, showAverageMenu, showRecent])

  // Reset popover defaults every time it opens.
  useEffect(() => {
    if (!showAverageMenu) return
    setAvgFrom(1)
    setAvgTo(Math.max(1, totalSweeps))
    setAvgMode(selectedList.length >= 2 ? 'selected' : 'all')
    setAvgLabel('')
  }, [showAverageMenu, totalSweeps, selectedList.length])

  const handleOpenFile = async () => {
    let filePath: string | null = null
    if (window.electronAPI) {
      filePath = await window.electronAPI.openFileDialog()
    } else {
      filePath = prompt('Enter file path:')
    }
    if (!filePath) return
    // Text-formatted files get the import wizard first so the user
    // can confirm delimiter / sample rate / units before commit.
    // Binary readers always win on extension dispatch (HEKA, ABF,
    // Neo) so .dat / .abf / etc. skip this branch even though .dat
    // is technically in the text-extension list.
    if (isTextLikeExt(filePath)) {
      setTextImportPath(filePath)
      return
    }
    await openFile(filePath)
  }

  const handlePrevSweep = () => {
    if (currentSweep > 0) selectSweep(currentGroup, currentSeries, currentSweep - 1, currentTrace)
  }

  const handleNextSweep = () => {
    if (currentSweep < totalSweeps - 1) selectSweep(currentGroup, currentSeries, currentSweep + 1, currentTrace)
  }

  const handleOverlayAll = async () => {
    if (showOverlay) clearOverlays()
    else await overlayAllSweeps()
  }

  // handleAverage was the old show/hide toggle for the overlay-style
  // average. Superseded by the popover below that creates a permanent
  // averaged sweep in the tree. Retained for legacy callers; silence
  // the unused warnings.
  void showAverage; void toggleAverage; void loadAverageTrace

  // Chosen sweep indices for the Average popover, based on the mode.
  // Always filters out excluded sweeps.
  const chosenSweeps = useMemo<number[]>(() => {
    if (!recording) return []
    if (avgMode === 'all') {
      return includedSweepsFor(currentGroup, currentSeries, totalSweeps)
    }
    if (avgMode === 'selected') {
      return filterExcludedSweeps(currentGroup, currentSeries, selectedList)
    }
    // range
    const lo = Math.max(1, Math.min(avgFrom, totalSweeps))
    const hi = Math.max(lo, Math.min(avgTo, totalSweeps))
    const raw: number[] = []
    for (let i = lo - 1; i <= hi - 1; i++) raw.push(i)
    return filterExcludedSweeps(currentGroup, currentSeries, raw)
  }, [avgMode, avgFrom, avgTo, currentGroup, currentSeries, totalSweeps, selectedList, recording, includedSweepsFor, filterExcludedSweeps])

  const defaultLabel = useMemo(() => {
    if (avgMode === 'all') return `Avg all (${chosenSweeps.length})`
    if (avgMode === 'selected') return `Avg sel (${chosenSweeps.length})`
    const lo = Math.max(1, Math.min(avgFrom, totalSweeps))
    const hi = Math.max(lo, Math.min(avgTo, totalSweeps))
    return `Avg ${lo}–${hi}`
  }, [avgMode, avgFrom, avgTo, chosenSweeps.length, totalSweeps])

  const handleCreateAverage = async () => {
    if (!recording || chosenSweeps.length === 0) return
    const label = avgLabel.trim() || defaultLabel
    await createAveragedSweep(currentGroup, currentSeries, currentTrace, chosenSweeps, label)
    setShowAverageMenu(false)
  }

  const handleOpenAnalysis = async (type: string) => {
    setShowAnalyses(false)
    if (window.electronAPI?.openAnalysisWindow) {
      await window.electronAPI.openAnalysisWindow(type)
    }
  }

  const handleOpenTool = async (type: string) => {
    setShowTools(false)
    if (window.electronAPI?.openAnalysisWindow) {
      await window.electronAPI.openAnalysisWindow(type)
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (!recording) return

      switch (e.key) {
        case 'ArrowLeft': case ',':
          e.preventDefault(); handlePrevSweep(); break
        case 'ArrowRight': case '.':
          e.preventDefault(); handleNextSweep(); break
        case 'Home':
          e.preventDefault(); selectSweep(currentGroup, currentSeries, 0, currentTrace); break
        case 'End':
          e.preventDefault(); selectSweep(currentGroup, currentSeries, totalSweeps - 1, currentTrace); break
        case 'o':
          if (!e.ctrlKey && !e.metaKey) handleOverlayAll(); break
        case 'a':
          if (!e.ctrlKey && !e.metaKey) setShowAverageMenu((v) => !v); break
        case 'z':
          if (!e.ctrlKey && !e.metaKey) toggleZoomMode(); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
    <div className={`toolbar${leftHidden ? ' toolbar-mac-inset' : ''}`}>
      {leftHidden && (
        <button className="icon-btn" onClick={onToggleLeft} title="Show navigator (F1)" aria-label="Show navigator">
          <SidebarIcon side="left" />
        </button>
      )}
      <RecordingTitle />
      <div className="toolbar-spacer" />

      <div className="toolbar-group" style={{ position: 'relative' }} ref={recentRef}>
        <button className="btn" onClick={handleOpenFile} disabled={loading} title="Open a recording (⌘O / Ctrl+O)">
          <Icon name="folder" size={14} />
          Open…
        </button>
        <button
          className="icon-btn"
          style={{ width: 20 }}
          onClick={() => setShowRecent((v) => !v)}
          disabled={loading || recentFiles.length === 0}
          title={recentFiles.length === 0 ? 'No recent files' : 'Recent files'}
          aria-label="Recent files"
        ><Icon name="chevron-down" size={12} /></button>
        {showRecent && recentFiles.length > 0 && (
          <div
            className="settings-popover menu"
            style={{ left: 0, right: 'auto', minWidth: 320, maxWidth: 600, width: 'auto' }}
          >
            <div style={{
              fontSize: 'var(--font-size-xs)',
              fontWeight: 600,
              padding: '4px 8px',
              color: 'var(--text-muted)',
            }}>Recent files</div>
            {recentFiles.map((p) => {
              const fname = p.split('/').pop() || p
              const dir = p.slice(0, p.length - fname.length).replace(/\/$/, '')
              return (
                <div
                  key={p}
                  onClick={async () => {
                    setShowRecent(false)
                    if (isTextLikeExt(p)) {
                      setTextImportPath(p)
                      return
                    }
                    try { await openFile(p) } catch { /* ignore */ }
                  }}
                  title={p}
                  className="analysis-menu-item"
                  style={{
                    padding: '4px 8px',
                    borderRadius: 4,
                    fontSize: 'var(--font-size-sm)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <span>{fname}</span>
                  <span style={{ opacity: 0.65, marginLeft: 8, fontSize: 'var(--font-size-xs)' }}>{dir}</span>
                </div>
              )
            })}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
              <div
                onClick={() => { clearRecentFiles(); setShowRecent(false) }}
                className="analysis-menu-item"
                style={{
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: 'var(--font-size-sm)',
                  color: 'var(--text-muted)',
                }}
              >Clear recent</div>
            </div>
          </div>
        )}
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group" role="group" aria-label="Sweep">
        <button className="icon-btn" onClick={handlePrevSweep} disabled={!recording || currentSweep === 0} title="Previous sweep (←)" aria-label="Previous sweep">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11 3.5v9L5 8z" /></svg>
        </button>
        <span className="toolbar-readout" style={{ minWidth: 92, justifyContent: 'center', color: recording ? undefined : 'var(--text-muted)' }}>
          {recording ? `Sweep ${currentSweep + 1} of ${totalSweeps}` : 'No sweep'}
        </span>
        <button className="icon-btn" onClick={handleNextSweep} disabled={!recording || currentSweep >= totalSweeps - 1} title="Next sweep (→)" aria-label="Next sweep">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.5v9L11 8z" /></svg>
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group" style={{ gap: 4 }}>
        {/* Traces dropdown — front-and-centre so users discover the
            stimulus-overlay and multi-channel visibility controls
            without hunting. */}
        <TracesDropdown />

        <button className="icon-btn" aria-pressed={showOverlay} onClick={handleOverlayAll} disabled={!recording || loading} title="Overlay all sweeps (O)" aria-label="Overlay all sweeps">
          <Icon name="layers" size={16} />
        </button>

        {/* Average: click shows a popover to pick the sweeps to average.
            Result is written into the tree as a virtual sweep and
            navigated to immediately. */}
        <div style={{ position: 'relative' }} ref={averageRef}>
          <button
            className="icon-btn"
            style={{ width: 'auto', padding: '0 4px 0 6px', gap: 2 }}
            aria-pressed={showAverageMenu}
            aria-label="Average sweeps"
            onClick={() => setShowAverageMenu((v) => !v)}
            disabled={!recording || loading}
            title="Create an averaged trace from all / selected / range of sweeps (A)"
          >
            <Icon name="sigma" size={16} />
            <Icon name="chevron-down" size={10} />
          </button>

          {showAverageMenu && (
            <div className="settings-popover" style={{ left: 0, right: 'auto', width: 280, padding: 10 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
                Create averaged sweep from:
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 'var(--font-size-sm)' }}>
                <input
                  type="radio" name="avg-mode"
                  checked={avgMode === 'all'} onChange={() => setAvgMode('all')}
                />
                All sweeps
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
                  ({includedSweepsFor(currentGroup, currentSeries, totalSweeps).length})
                </span>
              </label>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0',
                fontSize: 'var(--font-size-sm)',
                opacity: selectedList.length < 2 ? 0.55 : 1,
              }}>
                <input
                  type="radio" name="avg-mode"
                  disabled={selectedList.length < 2}
                  checked={avgMode === 'selected'} onChange={() => setAvgMode('selected')}
                />
                Selected
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
                  ({filterExcludedSweeps(currentGroup, currentSeries, selectedList).length})
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 'var(--font-size-sm)' }}>
                <input
                  type="radio" name="avg-mode"
                  checked={avgMode === 'range'} onChange={() => setAvgMode('range')}
                />
                Range
                <NumInput
                  value={avgFrom} min={1} max={Math.max(1, totalSweeps)} step={1}
                  onChange={(v) => { setAvgMode('range'); setAvgFrom(Math.max(1, Math.round(v))) }}
                  style={{ width: 48 }}
                />
                <span style={{ color: 'var(--text-muted)' }}>–</span>
                <NumInput
                  value={avgTo} min={1} max={Math.max(1, totalSweeps)} step={1}
                  onChange={(v) => { setAvgMode('range'); setAvgTo(Math.max(1, Math.round(v))) }}
                  style={{ width: 48 }}
                />
              </label>
              <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>Label:</div>
              <input
                type="text"
                value={avgLabel} placeholder={defaultLabel}
                onChange={(e) => setAvgLabel(e.target.value)}
                style={{ width: '100%', marginTop: 2 }}
              />
              <div style={{
                marginTop: 8, fontSize: 'var(--font-size-label)',
                color: chosenSweeps.length === 0 ? 'var(--error)' : 'var(--text-muted)',
              }}>
                {chosenSweeps.length === 0
                  ? 'No sweeps selected (all may be excluded)'
                  : `Averaging ${chosenSweeps.length} sweep${chosenSweeps.length === 1 ? '' : 's'}`}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setShowAverageMenu(false)}>Cancel</button>
                <button
                  className="btn btn-primary"
                  onClick={handleCreateAverage}
                  disabled={chosenSweeps.length === 0}
                >
                  Create
                </button>
              </div>
            </div>
          )}
        </div>

        <button className="icon-btn" aria-pressed={zoomMode} onClick={toggleZoomMode} title="Drag-to-zoom mode (Z)" aria-label="Drag-to-zoom mode">
          <Icon name="zoom-in" size={16} />
        </button>
      </div>

      <div className="toolbar-separator" />

      {/* Analyses dropdown */}
      <div style={{ position: 'relative' }} ref={analysesRef}>
        <button
          className="btn"
          onClick={() => setShowAnalyses(!showAnalyses)}
          disabled={!recording}
          title="Open an analysis window"
        >
          <Icon name="chart" size={14} />
          Analyses
          <Icon name="chevron-down" size={11} />
        </button>

        {showAnalyses && (
          <div className="settings-popover menu" style={{ left: 0, right: 'auto', width: 210 }}>
            {ANALYSIS_TYPES.map((a) => (
              <button
                key={a.type}
                onClick={() => handleOpenAnalysis(a.type)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 10px',
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--font-size-sm)',
                  borderRadius: 4,
                }}
                className="analysis-menu-item"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tools dropdown — folds the cross-recording / tagging actions
          (Tags, Batch, Cohort, Export Traces) into one menu so the
          toolbar's right-hand cluster stays narrow on small screens.
          All four operate across files, so the button is always
          enabled even with no recording open. Menu order mirrors the
          workflow: tag → batch → aggregate → export. */}
      <div style={{ position: 'relative' }} ref={toolsRef}>
        <button
          className="btn"
          onClick={() => setShowTools(!showTools)}
          title="Tagging and cross-recording tools"
        >
          <Icon name="grid" size={14} />
          Tools
          <Icon name="chevron-down" size={11} />
        </button>

        {showTools && (
          <div className="settings-popover menu" style={{ left: 'auto', right: 0, width: 210 }}>
            {TOOL_TYPES.map((t) => (
              <button
                key={t.type}
                onClick={() => handleOpenTool(t.type)}
                title={t.title}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 10px',
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--font-size-sm)',
                  borderRadius: 4,
                }}
                className="analysis-menu-item"
              >
                <Icon name={t.icon} />
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && (
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>Loading…</span>
      )}

      <div className="toolbar-separator" />

      {/* Settings gear */}
      <div style={{ position: 'relative' }} ref={settingsRef}>
        <button
          className="icon-btn"
          aria-pressed={showSettings}
          onClick={() => setShowSettings(!showSettings)}
          title="Settings"
          aria-label="Settings"
        >
          <Icon name="gear" size={15} />
        </button>

        {showSettings && (
          <div className="settings-popover">
            <div className="settings-section">
              <div className="settings-label">Appearance</div>
              <div className="theme-toggle" role="group" aria-label="Appearance">
                {([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [ThemePref, string][]).map(([p, label]) => (
                  <button key={p} className={themePref === p ? 'active' : ''} aria-pressed={themePref === p}
                    onClick={() => setThemePref(p)}
                    title={p === 'system' ? 'Follow the system light / dark setting' : undefined}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Text size</div>
              <div className="font-size-row">
                {FONT_SIZES.map((sz) => (
                  <button key={sz} className={fontSize === sz ? 'active' : ''} onClick={() => setFontSize(sz)} style={{ fontSize: sz - 1 }}>{sz}</button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Trace colours</span>
                <button
                  className="btn btn-sm"
                  onClick={resetTraceColors}
                  disabled={traceColors.every((c) => !c)}
                  title="Restore the default colour for every slot"
                >Reset all</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', columnGap: 6, rowGap: 4, alignItems: 'center' }}>
                {Array.from({ length: TRACE_COLOR_SLOT_COUNT }).map((_, i) => {
                  const userVal = traceColors[i] || ''
                  // When the user hasn't picked a colour, show the
                  // palette default in the swatch by reading the CSS
                  // variable's resolved value. Convert to hex so the
                  // native <input type="color"> can ingest it.
                  const cssDefault = cssColorToHex(
                    getComputedStyle(document.documentElement)
                      .getPropertyValue(TRACE_COLOR_VAR_NAMES[i]).trim()
                  )
                  const swatch = userVal || cssDefault
                  return (
                    <React.Fragment key={i}>
                      <span style={{ fontSize: 'var(--font-size-xs)' }}>{TRACE_COLOR_LABELS[i]}</span>
                      <input
                        type="color"
                        value={swatch}
                        onChange={(e) => setTraceColor(i, e.target.value)}
                        style={{ width: 28, height: 18, padding: 0, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent' }}
                        title={userVal ? 'Custom colour — click to change' : 'Default colour — click to override'}
                      />
                      <button
                        className="btn btn-sm"
                        style={{ visibility: userVal ? 'visible' : 'hidden' }}
                        onClick={() => setTraceColor(i, '')}
                        title="Clear override"
                      >×</button>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>

          </div>
        )}
      </div>

      <button
        className="icon-btn"
        aria-pressed={!rightHidden}
        onClick={onToggleRight}
        title={rightHidden ? 'Show inspector (F2)' : 'Hide inspector (F2)'}
        aria-label={rightHidden ? 'Show inspector' : 'Hide inspector'}
      >
        <SidebarIcon side="right" />
      </button>
    </div>
    {showScaling && (
      <ScalingModal
        focusKey={scalingFocusKey}
        onClose={() => setShowScaling(false)}
      />
    )}
    {textImportPath && (
      <TextImportWizard
        filePath={textImportPath}
        onClose={async (opts) => {
          const fp = textImportPath
          setTextImportPath(null)
          if (opts && fp) await openFile(fp, opts)
        }}
      />
    )}
    </>
  )
}

