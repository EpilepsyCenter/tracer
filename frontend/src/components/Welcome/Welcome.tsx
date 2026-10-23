import React, { useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { Icon } from '../common/Icon'

const lockup = new URL('../../assets/lockup-horizontal.png', import.meta.url).href

const SUPPORTED_FORMATS = [
  'HEKA DAT', 'Axon ABF', 'Neuralynx', 'CSV', 'TSV', 'ATF',
] as const

const TEXT_EXTS = ['.csv', '.tsv', '.txt', '.atf']
function isTextLikeExt(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.\\/]+$/)?.[0]
  return ext != null && TEXT_EXTS.includes(ext)
}

/**
 * Welcome surface shown when no recording is loaded.
 *
 * Replaces the previous "logo + paragraph" placeholder with a real
 * landing experience: hero, primary action, drag-and-drop zone,
 * recent files list, supported-formats footer.
 *
 * Sits inside the trace viewer's empty area; absolutely positioned
 * to fill its container.
 */
export function Welcome() {
  const { openFile, recentFiles } = useAppStore()
  const [dragActive, setDragActive] = useState(false)

  const onOpenClick = useCallback(async () => {
    if (!window.electronAPI) {
      const fp = prompt('Enter file path:')
      if (fp) await openFile(fp)
      return
    }
    const fp = await window.electronAPI.openFileDialog()
    if (fp) {
      // Text-format files normally trigger the import wizard from the
      // toolbar; from the welcome surface we dispatch a custom event
      // so the toolbar's wizard logic still runs.
      if (isTextLikeExt(fp)) {
        window.dispatchEvent(
          new CustomEvent('welcome-open-text', { detail: { filePath: fp } })
        )
        return
      }
      await openFile(fp)
    }
  }, [openFile])

  const onRecentClick = useCallback(async (fp: string) => {
    if (isTextLikeExt(fp)) {
      window.dispatchEvent(
        new CustomEvent('welcome-open-text', { detail: { filePath: fp } })
      )
      return
    }
    try { await openFile(fp) } catch { /* ignore */ }
  }, [openFile])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
  }, [])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    // Electron exposes the absolute filesystem path on dropped File
    // objects via the non-standard ``.path`` property.
    const file = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined
    const fp = file?.path
    if (!fp) return
    if (isTextLikeExt(fp)) {
      window.dispatchEvent(
        new CustomEvent('welcome-open-text', { detail: { filePath: fp } })
      )
      return
    }
    await openFile(fp)
  }, [openFile])

  return (
    <div
      className={`welcome ${dragActive ? 'welcome-drag' : ''}`}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Engineered crop marks — match the trace-viewer corners */}
      <span className="welcome-corner welcome-corner-tl" />
      <span className="welcome-corner welcome-corner-br" />

      <div className="welcome-inner">
        <div className="welcome-hero">
          <img src={lockup} alt="TRACER" className="welcome-lockup" />
          <div className="welcome-tagline">
            Electrophysiology workbench
          </div>
          <p className="welcome-description">
            Load a HEKA, Axon, or Neuralynx recording — then run cursors,
            bursts, action potentials, fPSPs, I-V curves and event detection
            as live analyses on whichever sweep you're looking at.
          </p>
        </div>

        <div className="welcome-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={onOpenClick}
            title="Browse for a recording (Cmd+O)"
          >
            <Icon name="folder" size={15} />
            Open file…
          </button>
          <div className="welcome-drop-hint">
            <span className="dot" /> or drop a file anywhere on this window
          </div>
        </div>

        {recentFiles.length > 0 && (
          <div className="welcome-section">
            <div className="welcome-section-title">
              <span className="tick" /> Recent
            </div>
            <ul className="welcome-recent">
              {recentFiles.slice(0, 6).map((p) => {
                const fname = p.split(/[/\\]/).pop() || p
                const dir = p.slice(0, p.length - fname.length).replace(/[/\\]$/, '')
                return (
                  <li key={p}>
                    <button
                      className="welcome-recent-row"
                      onClick={() => onRecentClick(p)}
                      title={p}
                    >
                      <span className="welcome-recent-dot" />
                      <span className="welcome-recent-name">{fname}</span>
                      <span className="welcome-recent-dir">{dir}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        <div className="welcome-formats">
          <span className="welcome-formats-key">Supported formats</span>
          {SUPPORTED_FORMATS.map((f, i) => (
            <React.Fragment key={f}>
              {i > 0 && <span className="welcome-formats-sep">·</span>}
              <span className="welcome-formats-val">{f}</span>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}
