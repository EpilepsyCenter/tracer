import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { useAppStore } from '../../stores/appStore'
import { useThemeStore, FONT_SIZES } from '../../stores/themeStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { Icon, IconName } from '../common/Icon'

const TEXT_EXTS = ['.csv', '.tsv', '.txt', '.atf']
function isTextLikeExt(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.\\/]+$/)?.[0]
  return ext != null && TEXT_EXTS.includes(ext)
}

interface Cmd {
  id: string
  label: string
  group: string
  icon?: IconName
  hint?: string
  keywords?: string
  run: () => void | Promise<void>
}

const ANALYSES: Array<{ key: string; label: string; icon: IconName }> = [
  // Order mirrors the Toolbar's Analyses dropdown for consistency.
  { key: 'cursors',          label: 'Cursor Measurements', icon: 'chart' },
  { key: 'resistance',       label: 'Rs / Rin / Cm',       icon: 'chart' },
  { key: 'iv',               label: 'I-V Curve',           icon: 'chart' },
  { key: 'action_potential', label: 'Action Potentials',   icon: 'chart' },
  { key: 'paired',           label: 'Paired Recording',    icon: 'chart' },
  { key: 'events',           label: 'Event Detection',     icon: 'chart' },
  { key: 'bursts',           label: 'Burst Detection',     icon: 'chart' },
  { key: 'field_potential',  label: 'Field Potential',     icon: 'chart' },
  { key: 'spectral',         label: 'Spectral Analysis',   icon: 'chart' },
]

/**
 * Cmd+K command palette — fuzzy-searchable launcher for every
 * action in the app.
 *
 * Mounted once in App.tsx. Listens globally for ⌘K / Ctrl+K, opens
 * a centered modal, and runs the highlighted command on Enter.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Pull every store action we need to wire commands ----------
  const {
    recording, recentFiles, openFile,
    showOverlay, toggleOverlay, clearOverlays, overlayAllSweeps,
    showAverage, loadAverageTrace,
    currentGroup, currentSeries, currentSweep, currentTrace,
    selectSweep,
  } = useAppStore()
  const { theme, themePref, fontSize, toggleTheme, setThemePref, setFontSize } =
    useThemeStore()
  const { toggleLeft, toggleRight, toggleFocus } = useLayoutStore()

  const totalSweeps = recording
    ? recording.groups[currentGroup]?.series[currentSeries]?.sweepCount ?? 0
    : 0

  // Open / close with Cmd+K / Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmd = e.metaKey || e.ctrlKey
      if (isCmd && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('open-command-palette', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('open-command-palette', onOpen)
    }
  }, [open])

  // Reset + focus when opening
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  const close = useCallback(() => setOpen(false), [])

  const openAnalysis = useCallback(async (key: string) => {
    if (window.electronAPI?.openAnalysisWindow) {
      await window.electronAPI.openAnalysisWindow(key)
    }
  }, [])

  const handleOpenFile = useCallback(async () => {
    if (!window.electronAPI) {
      const fp = prompt('Enter file path:')
      if (fp) await openFile(fp)
      return
    }
    const fp = await window.electronAPI.openFileDialog()
    if (!fp) return
    if (isTextLikeExt(fp)) {
      window.dispatchEvent(
        new CustomEvent('welcome-open-text', { detail: { filePath: fp } })
      )
      return
    }
    await openFile(fp)
  }, [openFile])

  const handleOpenRecent = useCallback(async (fp: string) => {
    if (isTextLikeExt(fp)) {
      window.dispatchEvent(
        new CustomEvent('welcome-open-text', { detail: { filePath: fp } })
      )
      return
    }
    try { await openFile(fp) } catch { /* ignore */ }
  }, [openFile])

  // Build the command list -----------------------------------
  const commands: Cmd[] = useMemo(() => {
    const cmds: Cmd[] = []

    // ---- File ----
    cmds.push({
      id: 'file.open', group: 'File', icon: 'folder',
      label: 'Open File…', hint: '⌘O',
      keywords: 'browse load recording',
      run: handleOpenFile,
    })

    recentFiles.slice(0, 8).forEach((p) => {
      const fname = p.split(/[/\\]/).pop() || p
      cmds.push({
        id: `recent:${p}`, group: 'Recent Files', icon: 'folder',
        label: fname,
        keywords: p,
        hint: p.length > 60 ? '…' + p.slice(-58) : p,
        run: () => handleOpenRecent(p),
      })
    })

    // ---- Navigation ----
    if (recording) {
      cmds.push({
        id: 'nav.prev', group: 'Navigation', icon: 'arrow-left',
        label: 'Previous sweep', hint: '←',
        keywords: 'back',
        run: () => {
          if (currentSweep > 0) selectSweep(currentGroup, currentSeries, currentSweep - 1, currentTrace)
        },
      })
      cmds.push({
        id: 'nav.next', group: 'Navigation', icon: 'arrow-right',
        label: 'Next sweep', hint: '→',
        keywords: 'forward',
        run: () => {
          if (currentSweep < totalSweeps - 1) selectSweep(currentGroup, currentSeries, currentSweep + 1, currentTrace)
        },
      })
      cmds.push({
        id: 'nav.first', group: 'Navigation',
        label: 'First sweep', hint: 'Home',
        run: () => selectSweep(currentGroup, currentSeries, 0, currentTrace),
      })
      cmds.push({
        id: 'nav.last', group: 'Navigation',
        label: 'Last sweep', hint: 'End',
        run: () => selectSweep(currentGroup, currentSeries, totalSweeps - 1, currentTrace),
      })
    }

    // ---- View ----
    if (recording) {
      cmds.push({
        id: 'view.overlay', group: 'View', icon: 'layers',
        label: showOverlay ? 'Clear overlays' : 'Overlay all sweeps', hint: 'O',
        keywords: 'overlay sweeps stack',
        run: () => {
          if (showOverlay) clearOverlays()
          else overlayAllSweeps()
        },
      })
      cmds.push({
        id: 'view.average', group: 'View', icon: 'sigma',
        label: showAverage ? 'Hide average' : 'Show average of all sweeps',
        keywords: 'mean',
        run: () => loadAverageTrace(),
      })
    }

    cmds.push({
      id: 'view.toggleNavigator', group: 'View',
      label: 'Toggle navigator panel', hint: 'F1',
      keywords: 'left sidebar tree',
      run: toggleLeft,
    })
    cmds.push({
      id: 'view.toggleCursors', group: 'View',
      label: 'Toggle cursors panel', hint: 'F2',
      keywords: 'right sidebar',
      run: toggleRight,
    })
    cmds.push({
      id: 'view.focus', group: 'View',
      label: 'Toggle focus mode', hint: 'F',
      keywords: 'distraction zen full',
      run: toggleFocus,
    })

    // ---- Analyses ----
    if (recording) {
      ANALYSES.forEach((a) => {
        cmds.push({
          id: `analyses:${a.key}`, group: 'Analyses', icon: a.icon,
          label: `Open ${a.label}`,
          keywords: a.key,
          run: () => openAnalysis(a.key),
        })
      })
    }

    // Always-available analysis windows (no recording dependency)
    cmds.push({
      id: 'analyses:tags', group: 'Analyses', icon: 'tag',
      label: 'Open Tags',
      keywords: 'metadata cohort',
      run: () => openAnalysis('metadata'),
    })
    cmds.push({
      id: 'analyses:batch', group: 'Analyses', icon: 'grid',
      label: 'Open Batch Analysis',
      keywords: 'replay template',
      run: () => openAnalysis('batch_analysis'),
    })
    cmds.push({
      id: 'analyses:cohort', group: 'Analyses', icon: 'users',
      label: 'Open Cohort Analysis',
      keywords: 'aggregate folder',
      run: () => openAnalysis('cohort_analysis'),
    })
    cmds.push({
      id: 'analyses:export', group: 'Analyses', icon: 'download',
      label: 'Open Trace Export',
      keywords: 'figure publication',
      run: () => openAnalysis('trace_export'),
    })

    // ---- Theme ----
    cmds.push({
      id: 'theme.toggle', group: 'Theme',
      label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`,
      keywords: 'theme appearance',
      run: toggleTheme,
    })
    if (themePref !== 'system') cmds.push({
      id: 'theme.system', group: 'Theme', label: 'Appearance · Use system setting',
      keywords: 'theme dark light auto', run: () => setThemePref('system'),
    })
    if (themePref !== 'light') cmds.push({
      id: 'theme.light', group: 'Theme', label: 'Appearance · Light', run: () => setThemePref('light'),
    })
    if (themePref !== 'dark') cmds.push({
      id: 'theme.dark', group: 'Theme', label: 'Appearance · Dark', run: () => setThemePref('dark'),
    })

    // ---- Help ----
    cmds.push({
      id: 'help.open', group: 'Help', icon: 'help',
      label: 'Open help & shortcuts', hint: '?',
      keywords: 'manual documentation cheat sheet keyboard',
      run: () => { window.dispatchEvent(new CustomEvent('open-help')) },
    })
    cmds.push({
      id: 'help.manual', group: 'Help', icon: 'book',
      label: 'Open user manual',
      keywords: 'documentation help',
      run: () => openAnalysis('manual'),
    })
    cmds.push({
      id: 'help.bug', group: 'Help', icon: 'bug',
      label: 'Report a bug or send feedback',
      keywords: 'issue feedback report tally',
      run: () => { window.dispatchEvent(new CustomEvent('open-bug-report')) },
    })

    FONT_SIZES.forEach((sz) => {
      if (sz === fontSize) return
      cmds.push({
        id: `font.${sz}`, group: 'Settings',
        label: `Text size · ${sz} px`,
        run: () => setFontSize(sz),
      })
    })

    return cmds
  }, [
    recording, recentFiles, currentGroup, currentSeries, currentSweep, currentTrace,
    totalSweeps, showOverlay, showAverage, theme, themePref, fontSize,
    handleOpenFile, handleOpenRecent, openAnalysis,
    selectSweep, clearOverlays, overlayAllSweeps, loadAverageTrace,
    toggleLeft, toggleRight, toggleFocus, toggleTheme, setThemePref, setFontSize,
  ])

  // Filter ----
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return commands
    const tokens = q.split(/\s+/).filter(Boolean)
    return commands
      .map((c) => {
        const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase()
        let score = 0
        for (const t of tokens) {
          const idx = hay.indexOf(t)
          if (idx < 0) return null
          score += 100 - Math.min(idx, 80)
          if (c.label.toLowerCase().startsWith(t)) score += 50
        }
        return { c, score }
      })
      .filter((x): x is { c: Cmd; score: number } => x != null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c)
  }, [commands, q])

  // Clamp active when filtered changes
  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1))
  }, [filtered.length, active])

  // Group for rendering
  const grouped = useMemo(() => {
    const g: Array<{ name: string; items: Cmd[]; startIdx: number }> = []
    let idx = 0
    filtered.forEach((c) => {
      let bucket = g.find((b) => b.name === c.group)
      if (!bucket) {
        bucket = { name: c.group, items: [], startIdx: idx }
        g.push(bucket)
      }
      bucket.items.push(c)
      idx++
    })
    return g
  }, [filtered])

  // Scroll active row into view
  useEffect(() => {
    if (!open) return
    const row = listRef.current?.querySelector<HTMLDivElement>(`[data-cmd-idx="${active}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[active]
      if (cmd) {
        close()
        Promise.resolve(cmd.run()).catch(() => { /* ignore */ })
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  if (!open) return null

  return ReactDOM.createPortal(
    <div className="cmdk-overlay" onMouseDown={close}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-search">
          <Icon name="chevron-down" size={14} className="cmdk-search-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            placeholder="Search commands, files, analyses…"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="cmdk-hint-key">ESC</span>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {grouped.length === 0 && (
            <div className="cmdk-empty">No commands match.</div>
          )}
          {grouped.map((bucket) => (
            <div key={bucket.name} className="cmdk-group">
              <div className="cmdk-group-title">
                <span className="tick" />{bucket.name}
              </div>
              {bucket.items.map((cmd, i) => {
                const idx = bucket.startIdx + i
                const isActive = idx === active
                return (
                  <div
                    key={cmd.id}
                    data-cmd-idx={idx}
                    className={`cmdk-row ${isActive ? 'active' : ''}`}
                    onMouseEnter={() => setActive(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      close()
                      Promise.resolve(cmd.run()).catch(() => { /* ignore */ })
                    }}
                  >
                    {cmd.icon && <Icon name={cmd.icon} size={14} />}
                    <span className="cmdk-row-label">{cmd.label}</span>
                    {cmd.hint && <span className="cmdk-row-hint">{cmd.hint}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="cmdk-footer">
          <span><span className="cmdk-kbd">↑</span><span className="cmdk-kbd">↓</span> navigate</span>
          <span><span className="cmdk-kbd">↵</span> run</span>
          <span><span className="cmdk-kbd">⌘K</span> toggle</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
