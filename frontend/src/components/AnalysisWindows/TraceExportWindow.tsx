import React, { useEffect, useRef, useState } from 'react'
import { useTraceExportStore, FileInfo, SessionPayload } from '../../stores/traceExportStore'
import { TraceList } from '../TraceExport/TraceList'
import { TraceSourcePicker } from '../TraceExport/TraceSourcePicker'
import { TraceEditor } from '../TraceExport/TraceEditor'
import { FigurePanel } from '../TraceExport/FigurePanel'
import { PreviewPanel } from '../TraceExport/PreviewPanel'
import { StackedPreview } from '../TraceExport/StackedPreview'
import { PreviewContextMenu } from '../TraceExport/PreviewContextMenu'
import { ExportModal } from '../TraceExport/ExportModal'

// Pane widths persist in Electron prefs so the layout sticks across
// app restarts. Same shape as the other analysis windows' UI prefs.
const PREFS_KEY = 'traceExportPanes'
const DEFAULT_LEFT = 260
const DEFAULT_RIGHT = 320
const MIN_LEFT = 180
const MIN_RIGHT = 220
const MAX_SIDE = 600

async function loadPaneWidths(): Promise<{ left: number; right: number }> {
  try {
    const api = window.electronAPI
    if (!api) return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
    const prefs = await api.getPreferences()
    const stored = prefs?.[PREFS_KEY] as { left?: number; right?: number } | undefined
    return {
      left: clamp(stored?.left ?? DEFAULT_LEFT, MIN_LEFT, MAX_SIDE),
      right: clamp(stored?.right ?? DEFAULT_RIGHT, MIN_RIGHT, MAX_SIDE),
    }
  } catch {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
  }
}

async function savePaneWidths(widths: { left: number; right: number }) {
  try {
    const api = window.electronAPI
    if (!api) return
    const prefs = await api.getPreferences()
    await api.setPreferences({ ...prefs, [PREFS_KEY]: widths })
  } catch { /* ignore */ }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

interface Props {
  backendUrl: string
  fileInfo: { fileName: string | null; format: string | null; groupCount: number; groups: any[] } | null
}

/**
 * Trace Export window — Phase C v1.
 *
 * Three-pane layout:
 *   [list] · [preview] · [editor]
 *
 * Editor switches between per-trace ("Trace") and figure-wide
 * ("Figure") views via tabs. The current recording (if any) is
 * pre-registered with the picker so the user can add traces from it
 * without going through "Add file…" first.
 */
export function TraceExportWindow({ backendUrl, fileInfo }: Props) {
  const setBackendUrl = useTraceExportStore((s) => s.setBackendUrl)
  const items = useTraceExportStore((s) => s.items)
  const knownFiles = useTraceExportStore((s) => s.knownFiles)
  const registerFile = useTraceExportStore((s) => s.registerFile)
  const resetAll = useTraceExportStore((s) => s.resetAll)
  const templates = useTraceExportStore((s) => s.templates)
  const loadTemplates = useTraceExportStore((s) => s.loadTemplates)
  const saveTemplate = useTraceExportStore((s) => s.saveTemplate)
  const deleteTemplate = useTraceExportStore((s) => s.deleteTemplate)
  const applyTemplate = useTraceExportStore((s) => s.applyTemplate)
  const buildSessionPayload = useTraceExportStore((s) => s.buildSessionPayload)
  const loadSessionPayload = useTraceExportStore((s) => s.loadSessionPayload)
  const removeItem = useTraceExportStore((s) => s.removeItem)
  const reorderItem = useTraceExportStore((s) => s.reorderItem)
  const panelLayout = useTraceExportStore((s) => s.panelLayout)
  const axesCount = useTraceExportStore((s) => s.axes.length)

  // Multi-select: a Set of trace ids. Clicking a row replaces the
  // selection; Shift-click extends a range from the last anchor; Cmd/
  // Ctrl-click toggles a single row in or out. ``anchorId`` is what
  // Shift-click measures from — the most recently single-clicked row.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  // Convenience for the editor branch — show the single-trace
  // editor when exactly one trace is selected.
  const selectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null
  const [showPicker, setShowPicker] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [tab, setTab] = useState<'trace' | 'figure'>('trace')
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT)
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT)
  const [showTemplates, setShowTemplates] = useState(false)
  const templatesAnchorRef = useRef<HTMLDivElement | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    loadPaneWidths().then(({ left, right }) => {
      setLeftWidth(left); setRightWidth(right)
    })
  }, [])

  // Debounce-write so a single drag doesn't hammer the prefs file.
  useEffect(() => {
    const t = setTimeout(() => savePaneWidths({ left: leftWidth, right: rightWidth }), 250)
    return () => clearTimeout(t)
  }, [leftWidth, rightWidth])

  const startResize = (which: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startLeft = leftWidth
    const startRight = rightWidth
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      if (which === 'left') {
        setLeftWidth(clamp(startLeft + delta, MIN_LEFT, MAX_SIDE))
      } else {
        setRightWidth(clamp(startRight - delta, MIN_RIGHT, MAX_SIDE))
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  useEffect(() => { setBackendUrl(backendUrl) }, [backendUrl, setBackendUrl])

  // Hydrate templates list from prefs on mount.
  useEffect(() => { loadTemplates() }, [loadTemplates])

  // Close the templates popover on outside click.
  useEffect(() => {
    if (!showTemplates) return
    const onClick = (e: MouseEvent) => {
      if (templatesAnchorRef.current && !templatesAnchorRef.current.contains(e.target as Node)) {
        setShowTemplates(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showTemplates])

  // ----- Session save / load --------------------------------------------
  async function handleSaveSession() {
    const api = window.electronAPI
    if (!api) return
    const path = await api.saveFileDialog('figure.tracer_figure', [
      { name: 'TRACER Figure Session', extensions: ['tracer_figure'] },
    ])
    if (!path) return
    const ok = await api.writeFigureSession(path, buildSessionPayload() as unknown as Record<string, unknown>)
    if (!ok) {
      // eslint-disable-next-line no-alert
      alert('Could not save figure session.')
    }
  }

  async function handleOpenSession() {
    const api = window.electronAPI
    if (!api) return
    const path = await api.openFigureSessionDialog()
    if (!path) return
    const data = await api.readFigureSession(path)
    if (!data) {
      // eslint-disable-next-line no-alert
      alert('Could not read figure session — file missing or wrong format.')
      return
    }
    // Cast through unknown — runtime shape was validated by the IPC
    // handler's format check (it returns null for non-figure JSON).
    loadSessionPayload(data as unknown as SessionPayload)
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  async function handleSaveTemplate() {
    // eslint-disable-next-line no-alert
    const name = prompt('Template name?')
    if (!name) return
    await saveTemplate(name)
    setShowTemplates(false)
  }

  // ----- Selection logic ------------------------------------------------
  //
  // Click semantics (matches Finder / VSCode / most file lists):
  //   - plain click           → replace selection with this id
  //   - Shift + click         → extend range from anchor to id
  //   - Cmd/Ctrl + click      → toggle id in selection
  // ``anchorId`` resets to the clicked id on plain click and on
  // Cmd/Ctrl-click (the new "starting point"); Shift-click leaves it
  // alone so successive shifts grow/shrink from the same anchor.
  function handleSelectRow(id: string | null, mode: 'replace' | 'extend' | 'toggle') {
    if (id == null) {
      setSelectedIds(new Set())
      setAnchorId(null)
      return
    }
    if (mode === 'replace') {
      setSelectedIds(new Set([id]))
      setAnchorId(id)
      return
    }
    if (mode === 'toggle') {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setAnchorId(id)
      return
    }
    // extend (Shift-click): pick the contiguous range in items order
    // from anchor to clicked.
    const ids = items.map((i) => i.id)
    const anchor = anchorId ?? id
    const a = ids.indexOf(anchor)
    const b = ids.indexOf(id)
    if (a < 0 || b < 0) {
      setSelectedIds(new Set([id]))
      setAnchorId(id)
      return
    }
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    setSelectedIds(new Set(ids.slice(lo, hi + 1)))
  }

  function handleBulkDelete() {
    if (selectedIds.size === 0) return
    for (const id of selectedIds) removeItem(id)
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  function handleMoveSelection(direction: -1 | 1) {
    if (selectedIds.size === 0) return
    // Move each selected item one step. To avoid swapping with another
    // selected item (which would be a no-op visually), we iterate in
    // order based on direction.
    const ids = Array.from(selectedIds)
    const sortedByOrder = ids
      .map((id) => ({ id, idx: items.findIndex((i) => i.id === id) }))
      .filter((e) => e.idx >= 0)
      .sort((a, b) => direction === -1 ? a.idx - b.idx : b.idx - a.idx)
    for (const e of sortedByOrder) reorderItem(e.id, direction)
  }

  // ----- Keyboard shortcuts ---------------------------------------------
  //
  // Bound to the window (not a specific element) so users don't have
  // to first click into the trace list to use them. We bail out if
  // the user is typing in a text input or contenteditable, otherwise
  // hitting Delete in the legend-name field would nuke their traces.
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!t || !(t instanceof HTMLElement)) return false
      const tag = t.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (t.isContentEditable) return true
      return false
    }
    const onKey = (ev: KeyboardEvent) => {
      if (isTypingTarget(ev.target)) return
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (selectedIds.size > 0) {
          ev.preventDefault()
          handleBulkDelete()
        }
        return
      }
      if (ev.key === 'ArrowUp') {
        if (selectedIds.size > 0) {
          ev.preventDefault()
          handleMoveSelection(-1)
        }
        return
      }
      if (ev.key === 'ArrowDown') {
        if (selectedIds.size > 0) {
          ev.preventDefault()
          handleMoveSelection(1)
        }
        return
      }
      if (ev.key === 'r' || ev.key === 'R') {
        // R = fit (matches Photoshop / Lightroom). Dispatched as a
        // window event the PreviewPanel listens for; that way we
        // don't need a ref-based handle.
        if (!ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          ev.preventDefault()
          window.dispatchEvent(new CustomEvent('trace-export-fit'))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, items])

  // Register the currently-loaded recording so the picker can use it
  // without forcing the user to re-pick the same file.
  useEffect(() => {
    if (!fileInfo || !fileInfo.fileName) return
    // The fileInfo.groups[].series[].channels structure already matches
    // FileInfo's shape — we just need a filePath. Pull it from the
    // backend's /api/files/info response.
    ;(async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/files/info`)
        if (!resp.ok) return
        const info = await resp.json()
        if (!info.filePath) return
        const out: FileInfo = {
          filePath: info.filePath,
          fileName: info.fileName,
          format: info.format,
          groups: (info.groups ?? []).map((g: any) => ({
            index: g.index,
            label: g.label,
            series: (g.series ?? []).map((s: any) => ({
              index: s.index,
              label: s.label,
              sweepCount: s.sweepCount,
              channels: s.channels ?? [],
            })),
          })),
        }
        if (!knownFiles[out.filePath]) registerFile(out)
      } catch { /* ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileInfo?.fileName, backendUrl])

  const selected = items.find((i) => i.id === selectedId) ?? null

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      {/* Top toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: 6,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        fontSize: 'var(--font-size-sm)',
        fontFamily: 'var(--font-ui)',
      }}>
        <button className="btn" onClick={() => setShowPicker(true)}>+ Add traces…</button>
        <button className="btn" onClick={() => resetAll()} title="Clear figure and start over">Reset</button>

        <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />

        {/* Session — full state (sources + style) to a JSON file. */}
        <button
          className="btn"
          onClick={handleOpenSession}
          title="Open a saved figure session (.tracer_figure)"
        >Open…</button>
        <button
          className="btn"
          onClick={handleSaveSession}
          disabled={items.length === 0}
          title="Save the current figure (sources + style) as a session file"
        >Save…</button>

        {/* Templates — style/scalebar/legend only, no sources. */}
        <div ref={templatesAnchorRef} style={{ position: 'relative' }}>
          <button
            className="btn"
            onClick={() => setShowTemplates((s) => !s)}
            title="Save / apply named style templates"
          >Templates ▾</button>
          {showTemplates && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4,
              background: 'var(--bg-field)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-popover)',
              minWidth: 220, zIndex: 30,
              fontSize: 'var(--font-size-sm)',
            }}>
              <div style={{ padding: 6 }}>
                <button
                  className="btn"
                  onClick={handleSaveTemplate}
                  style={{ width: '100%', textAlign: 'left' }}
                >+ Save current as template…</button>
              </div>
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {templates.length === 0 && (
                  <div style={{ padding: 8, color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
                    No templates yet. Save the current figure's style as a template, then re-apply it later.
                  </div>
                )}
                {templates.map((t) => (
                  <div key={t.name} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 6px',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <button
                      className="btn"
                      onClick={() => { applyTemplate(t.name); setShowTemplates(false) }}
                      style={{ flex: 1, textAlign: 'left' }}
                      title={`Saved ${new Date(t.saved_at).toLocaleString()}`}
                    >{t.name}</button>
                    <button
                      className="btn"
                      onClick={() => deleteTemplate(t.name)}
                      title="Delete template"
                      style={{ padding: '0 6px', fontSize: 'var(--font-size-xs)' }}
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <span style={{ flex: 1 }} />
        <button
          className={items.length > 0 ? 'btn btn-primary' : 'btn'}
          onClick={() => setShowExport(true)}
          disabled={items.length === 0}
        >
          Export…
        </button>
      </div>

      {/* Three-pane layout with draggable splitters */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `${leftWidth}px 3px 1fr 3px ${rightWidth}px`,
      }}>
        <div style={{ minHeight: 0, overflow: 'hidden' }}>
          <TraceList
            selectedIds={selectedIds}
            onSelect={handleSelectRow}
            onAddClick={() => setShowPicker(true)}
          />
        </div>
        <div
          onMouseDown={startResize('left')}
          title="Drag to resize"
          style={{ cursor: 'col-resize', background: 'var(--border)' }}
        />
        <div
          style={{ minWidth: 0, minHeight: 0, position: 'relative' }}
          onContextMenu={(e) => {
            // Only intercept the menu when there's actually a figure
            // to copy. Empty state → let the platform menu through
            // (it's harmless and avoids confusing right-click behavior).
            if (items.length === 0) return
            e.preventDefault()
            setContextMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          {panelLayout === 'stacked' && axesCount > 1
            ? <StackedPreview backendUrl={backendUrl} />
            : <PreviewPanel backendUrl={backendUrl} />}
        </div>
        <div
          onMouseDown={startResize('right')}
          title="Drag to resize"
          style={{ cursor: 'col-resize', background: 'var(--border)' }}
        />
        <div style={{
          minHeight: 0, display: 'flex', flexDirection: 'column',
          // The right-rail container also carries the secondary bg so
          // the tab row + scroll area read as one chrome surface.
          background: 'var(--bg-secondary)',
          fontFamily: 'var(--font-ui)',
        }}>
          <div style={{ padding: 6, borderBottom: '1px solid var(--border)' }}>
            <div className="segmented" style={{ display: 'inline-flex' }}>
              {(['trace', 'figure'] as const).map((t) => (
                <button
                  key={t}
                  className={tab === t ? 'active' : undefined}
                  onClick={() => setTab(t)}
                >
                  {t === 'trace' ? 'Trace' : 'Figure'}
                </button>
              ))}
            </div>
          </div>
          <div
            // ``key`` on the scroll container forces a remount when
            // the selected trace changes, which (a) auto-scrolls the
            // editor to the top and (b) discards any in-flight uPlot
            // refs from the previous selection's mini-viewers (none
            // here yet, but cheap insurance for later additions).
            key={selectedId ?? '__none__'}
            style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
          >
            {tab === 'trace' ? (
              selectedIds.size === 0 ? (
                <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  Select a trace from the left to edit its style and processing.
                  <br />
                  Shift- or Cmd/Ctrl-click to select multiple.
                </div>
              ) : selectedIds.size === 1 && selected ? (
                <TraceEditor item={selected} />
              ) : (
                <BulkActions
                  count={selectedIds.size}
                  onDelete={handleBulkDelete}
                  onClear={() => handleSelectRow(null, 'replace')}
                />
              )
            ) : (
              <FigurePanel />
            )}
          </div>
        </div>
      </div>

      {showPicker && (
        <TraceSourcePicker
          backendUrl={backendUrl}
          onClose={() => setShowPicker(false)}
        />
      )}
      {showExport && (
        <ExportModal
          backendUrl={backendUrl}
          onClose={() => setShowExport(false)}
        />
      )}
      {contextMenu && (
        <PreviewContextMenu
          backendUrl={backendUrl}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onOpenExport={() => setShowExport(true)}
        />
      )}
    </div>
  )
}

function BulkActions({
  count, onDelete, onClear,
}: { count: number; onDelete: () => void; onClear: () => void }) {
  return (
    <div style={{
      padding: 12,
      fontSize: 'var(--font-size-sm)',
      fontFamily: 'var(--font-ui)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontWeight: 600 }}>{count} traces selected</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
        Per-trace style is hidden in multi-select mode.
        Press <kbd>Delete</kbd> or use the button below to remove all selected traces.
        Use <kbd>↑</kbd>/<kbd>↓</kbd> to reorder, <kbd>R</kbd> to reset the zoom.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn" onClick={onDelete}>Delete selected</button>
        <button className="btn" onClick={onClear}>Clear selection</button>
      </div>
    </div>
  )
}
