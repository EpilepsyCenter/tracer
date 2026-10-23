import React, { useEffect, useState } from 'react'
import { FileInfo, useTraceExportStore } from '../../stores/traceExportStore'
import { SweepBrush, formatRanges, parseRanges } from './SweepBrush'

interface Props {
  backendUrl: string
  initialFile?: FileInfo | null
  onClose: () => void
}

/**
 * Tree-modal source picker.
 * - Top: list of "known" files in this session. + Add file… opens a
 *   native dialog and fetches /api/trace_export/file_info for it.
 * - Middle: groups → series → sweeps tree for the active file.
 * - Bottom: "Add as overlay (one trace)" vs "Add as separate traces"
 *   toggle, and the Add button.
 */
export function TraceSourcePicker({ backendUrl, initialFile, onClose }: Props) {
  const knownFiles = useTraceExportStore((s) => s.knownFiles)
  const registerFile = useTraceExportStore((s) => s.registerFile)
  const addItem = useTraceExportStore((s) => s.addItem)

  const [activeFile, setActiveFile] = useState<string | null>(
    initialFile?.filePath ?? Object.keys(knownFiles)[0] ?? null,
  )
  const [activeGroup, setActiveGroup] = useState<number>(0)
  const [activeSeries, setActiveSeries] = useState<number>(0)
  const [activeTrace, setActiveTrace] = useState<number>(0)
  const [selectedSweeps, setSelectedSweeps] = useState<Set<number>>(new Set())
  const [combine, setCombine] = useState<'overlay' | 'separate'>('overlay')

  useEffect(() => {
    if (initialFile) registerFile(initialFile)
  }, [initialFile, registerFile])

  const file = activeFile ? knownFiles[activeFile] : null
  const group = file?.groups[activeGroup]
  const series = group?.series[activeSeries]
  const channels = series?.channels ?? []

  // Reset sweep selection on context change
  useEffect(() => { setSelectedSweeps(new Set()) }, [activeFile, activeGroup, activeSeries])

  async function pickFile() {
    const api = window.electronAPI
    if (!api) return
    // Use the standard open dialog — accepts ephys formats.
    const path = await api.openFileDialog?.()
    if (!path) return
    try {
      const url = `${backendUrl}/api/trace_export/file_info?path=${encodeURIComponent(path)}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(await resp.text())
      const info = await resp.json()
      const fileInfo: FileInfo = {
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
      registerFile(fileInfo)
      setActiveFile(fileInfo.filePath)
      setActiveGroup(0)
      setActiveSeries(0)
      setActiveTrace(0)
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Could not read file:\n${err instanceof Error ? err.message : err}`)
    }
  }

  function selectAll() {
    if (!series) return
    const next = new Set<number>()
    for (let i = 0; i < series.sweepCount; i++) next.add(i)
    setSelectedSweeps(next)
  }

  // Text-range input state. We keep a separate ``rangeText`` so the
  // user can type freely without each keystroke being parsed into the
  // selection (would clobber half-typed input). Sync goes:
  //   selectedSweeps changes (via brush, All, None) → rebuild text
  //   user edits text + commits (Enter / blur) → parse → setSelected
  const [rangeText, setRangeText] = useState('')
  useEffect(() => {
    setRangeText(formatRanges(selectedSweeps))
  }, [selectedSweeps])
  const commitRangeText = () => {
    if (!series) return
    const parsed = parseRanges(rangeText, series.sweepCount)
    setSelectedSweeps(parsed)
    // Re-format so the user sees the canonical string ("1, 2, 3" → "1-3").
    setRangeText(formatRanges(parsed))
  }

  function commit() {
    if (!file || !series) return
    const sweeps = Array.from(selectedSweeps).sort((a, b) => a - b)
    if (sweeps.length === 0) return
    if (combine === 'overlay') {
      addItem({
        file_path: file.filePath,
        file_name: file.fileName,
        group: activeGroup,
        series: activeSeries,
        trace: activeTrace,
        sweeps,
        show_individuals: sweeps.length > 1,
        show_mean: sweeps.length === 1 ? true : false,
      })
    } else {
      for (const sw of sweeps) {
        addItem({
          file_path: file.filePath,
          file_name: file.fileName,
          group: activeGroup,
          series: activeSeries,
          trace: activeTrace,
          sweeps: [sw],
          show_individuals: false,
          show_mean: true,
        })
      }
    }
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.4)',
    }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720, maxHeight: '80vh',
          background: 'var(--bg-primary)', color: 'var(--text-primary)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-popover)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          fontSize: 'var(--font-size-sm)',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
        }}>
          <strong>Add traces</strong>
          <button className="btn" onClick={onClose} style={{ padding: '2px 8px' }}>×</button>
        </div>

        {/* File list + add-file */}
        <div style={{ display: 'flex', gap: 8, padding: 8, alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text-muted)' }}>File:</span>
          <select
            value={activeFile ?? ''}
            onChange={(e) => { setActiveFile(e.target.value || null); setActiveGroup(0); setActiveSeries(0); setActiveTrace(0) }}
            style={{ flex: 1 }}
          >
            <option value="">— select —</option>
            {Object.values(knownFiles).map((f) => (
              <option key={f.filePath} value={f.filePath}>{f.fileName}</option>
            ))}
          </select>
          <button className="btn" onClick={pickFile} style={{ padding: '2px 8px' }}>+ Add file…</button>
        </div>

        {/* Group / series / channel selectors */}
        {file && (
          <div style={{ display: 'flex', gap: 8, padding: 8, borderBottom: '1px solid var(--border)' }}>
            <label>Group&nbsp;
              <select value={activeGroup} onChange={(e) => { setActiveGroup(Number(e.target.value)); setActiveSeries(0); setActiveTrace(0) }}>
                {file.groups.map((g, i) => <option key={i} value={i}>{g.label || `g${i}`}</option>)}
              </select>
            </label>
            <label>Series&nbsp;
              <select value={activeSeries} onChange={(e) => { setActiveSeries(Number(e.target.value)); setActiveTrace(0) }}>
                {(group?.series ?? []).map((s, i) => (
                  <option key={i} value={i}>{`s${i} — ${s.label || ''} (${s.sweepCount} sw)`}</option>
                ))}
              </select>
            </label>
            <label>Channel&nbsp;
              <select value={activeTrace} onChange={(e) => setActiveTrace(Number(e.target.value))}>
                {channels.map((c, i) => (
                  <option key={i} value={i}>{`${c.label || `Ch ${i + 1}`} (${c.units})`}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {/* Sweep selection — brushable strip on top, text input below.
            Both stay in sync: drag the strip to pick a range, or type
            "1-5, 7, 9-12" to enter sweeps directly. Shift/Cmd/Ctrl-drag
            on the strip is additive; plain drag replaces. */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {!series ? (
            <div style={{ color: 'var(--text-muted)' }}>No series selected.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  Sweeps (1–{series.sweepCount})
                </span>
                <span style={{ flex: 1 }} />
                <button className="btn" onClick={selectAll} style={{ padding: '2px 10px' }}>All</button>
                <button className="btn" onClick={() => setSelectedSweeps(new Set())} style={{ padding: '2px 10px' }}>None</button>
              </div>
              <div style={{ paddingTop: 18 }}>
                <SweepBrush
                  count={series.sweepCount}
                  selected={selectedSweeps}
                  onChange={setSelectedSweeps}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', minWidth: 56 }}>
                  Range:
                </span>
                <input
                  value={rangeText}
                  onChange={(e) => setRangeText(e.target.value)}
                  onBlur={commitRangeText}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.currentTarget.blur() }
                    if (e.key === 'Escape') { setRangeText(formatRanges(selectedSweeps)) }
                  }}
                  placeholder="e.g. 1-5, 7, 9-12"
                  className="num"
                  style={{ flex: 1 }}
                  spellCheck={false}
                />
              </div>
              <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                {selectedSweeps.size} of {series.sweepCount} selected
                {selectedSweeps.size > 0 && (
                  <>
                    {' · '}drag on the strip to pick a range; <kbd>Shift</kbd>+drag to add
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', padding: 8,
          borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)',
        }}>
          <label>
            <input
              type="radio"
              name="combine"
              checked={combine === 'overlay'}
              onChange={() => setCombine('overlay')}
            />{' '}Overlay (one trace, mean + individuals)
          </label>
          <label>
            <input
              type="radio"
              name="combine"
              checked={combine === 'separate'}
              onChange={() => setCombine('separate')}
            />{' '}Separate traces (one per sweep)
          </label>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={commit}
            disabled={selectedSweeps.size === 0}
          >
            Add {selectedSweeps.size > 0 ? `(${selectedSweeps.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

