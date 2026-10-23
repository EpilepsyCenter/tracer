import React, { useEffect, useCallback, useState } from 'react'
import { useAppStore } from './stores/appStore'
import { useThemeStore } from './stores/themeStore'
import { useLayoutStore } from './stores/layoutStore'
import { TreeNavigator } from './components/TreeNavigator/TreeNavigator'
import { TraceViewer } from './components/TraceViewer/TraceViewer'
import { CursorPanel } from './components/CursorPanel/CursorPanel'
import { Toolbar } from './components/Toolbar/Toolbar'
import { StatusBar } from './components/StatusBar/StatusBar'
import { ResizeHandle } from './components/ResizeHandle/ResizeHandle'
import { TagToast } from './components/TagToast/TagToast'
import { CommandPalette } from './components/CommandPalette/CommandPalette'
import { HelpModal } from './components/HelpModal/HelpModal'
import { BugReportModal } from './components/BugReportModal/BugReportModal'
import { useGlobalTooltips } from './hooks/useGlobalTooltips'

const MIN_SIDEBAR = 160
const MIN_TRACE = 200

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val))
}

export default function App() {
  const { initBackend } = useAppStore()
  const hasRecording = useAppStore((s) => !!s.recording)
  const { initTheme, setThemePref } = useThemeStore()
  const {
    leftCollapsed, rightCollapsed, focusMode,
    leftWidth, rightWidth,
    toggleLeft, toggleRight, toggleFocus,
    setLeftWidth, setRightWidth,
    initLayout, persistLayout,
  } = useLayoutStore()

  useEffect(() => {
    initTheme()
    initLayout()
    initBackend()
  }, [initTheme, initLayout, initBackend])

  useGlobalTooltips()

  // Help modal — mounted at the App root so it's reachable by the
  // ? keyboard shortcut, the toolbar button, and the command palette.
  const [showHelp, setShowHelp] = useState(false)
  useEffect(() => {
    const onOpen = () => setShowHelp(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      // ``?`` is shift+/ on most keyboards — accept either
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault()
        setShowHelp((v) => !v)
      }
    }
    window.addEventListener('open-help', onOpen)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('open-help', onOpen)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Bug-report modal — same mount pattern as HelpModal. Listens for
  // the ``open-bug-report`` window event, dispatched by the toolbar
  // button (and by analysis windows over BroadcastChannel below).
  const [showBugReport, setShowBugReport] = useState(false)
  useEffect(() => {
    const onOpen = () => setShowBugReport(true)
    window.addEventListener('open-bug-report', onOpen)
    // Analysis windows can ask the main window to open the modal —
    // they have their own renderer, but landing the modal in main
    // keeps the user-action / view diagnostics consistent.
    let ch: BroadcastChannel | null = null
    try {
      ch = new BroadcastChannel('tracer-sync')
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'open-bug-report') setShowBugReport(true)
      }
    } catch { /* BroadcastChannel unavailable */ }
    return () => {
      window.removeEventListener('open-bug-report', onOpen)
      ch?.close()
    }
  }, [])

  // --- Keyboard shortcuts for panel toggles ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key) {
        case 'F1': e.preventDefault(); toggleLeft(); break
        case 'F2': e.preventDefault(); toggleRight(); break
        case 'f':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            toggleFocus()
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleLeft, toggleRight, toggleFocus])

  // Native menu bar: enable the Analysis items only with a recording
  // open, and route menu commands into the app.
  useEffect(() => {
    window.electronAPI?.setMenuState?.({ hasRecording })
  }, [hasRecording])

  useEffect(() => {
    const off = window.electronAPI?.onMenuAction?.((action, arg) => {
      switch (action) {
        case 'open-file': window.dispatchEvent(new CustomEvent('menu-open-file')); break
        case 'open-settings': window.dispatchEvent(new CustomEvent('open-settings')); break
        case 'open-scaling': window.dispatchEvent(new CustomEvent('open-scaling-modal', { detail: {} })); break
        case 'open-help': setShowHelp(true); break
        case 'open-bug-report': setShowBugReport(true); break
        case 'command-palette': window.dispatchEvent(new CustomEvent('open-command-palette')); break
        case 'toggle-left': toggleLeft(); break
        case 'toggle-right': toggleRight(); break
        case 'toggle-focus': toggleFocus(); break
        case 'set-theme':
          if (arg === 'system' || arg === 'light' || arg === 'dark') setThemePref(arg)
          break
      }
    })
    return () => { off?.() }
  }, [toggleLeft, toggleRight, toggleFocus, setThemePref])

  const leftHidden = focusMode || leftCollapsed
  const rightHidden = focusMode || rightCollapsed

  const onResizeLeft = useCallback((delta: number) => {
    const current = useLayoutStore.getState().leftWidth
    setLeftWidth(clamp(current + delta, MIN_SIDEBAR, window.innerWidth * 0.35))
  }, [setLeftWidth])

  const onResizeRight = useCallback((delta: number) => {
    const current = useLayoutStore.getState().rightWidth
    setRightWidth(clamp(current - delta, MIN_SIDEBAR, window.innerWidth * 0.35))
  }, [setRightWidth])

  return (
    <div className="app">
      <div className="app-main">
        {/* ---- Left: recording tree, full window height ---- */}
        {!leftHidden && (
          <>
            <nav
              className="app-sidebar"
              aria-label="Recording navigator"
              style={{ width: leftWidth, minWidth: MIN_SIDEBAR }}
            >
              <div className="app-sidebar-header">
                <span className="app-wordmark">TRACER</span>
                <button
                  className="collapse-btn"
                  onClick={toggleLeft}
                  title="Hide navigator (F1)"
                  aria-label="Hide navigator"
                >
                  <SidebarIcon side="left" />
                </button>
              </div>
              <div className="app-sidebar-body">
                <TreeNavigator />
              </div>
            </nav>
            <ResizeHandle direction="horizontal" onResize={onResizeLeft} onResizeEnd={persistLayout} />
          </>
        )}

        {/* ---- Right: toolbar, viewer + inspector, status bar ---- */}
        <div className="app-center">
          <Toolbar
            leftHidden={leftHidden}
            rightHidden={rightHidden}
            onToggleLeft={focusMode ? toggleFocus : toggleLeft}
            onToggleRight={focusMode ? toggleFocus : toggleRight}
          />
          <div className="app-trace-area" style={{ minHeight: MIN_TRACE }}>
            <TraceViewer />
            {!rightHidden && (
              <>
                <ResizeHandle direction="horizontal" onResize={onResizeRight} onResizeEnd={persistLayout} />
                <aside
                  className="app-cursor-sidebar"
                  aria-label="Inspector"
                  style={{ width: rightWidth, minWidth: MIN_SIDEBAR }}
                >
                  <CursorPanel />
                </aside>
              </>
            )}
          </div>
          <StatusBar />
        </div>
      </div>
      <TagToast />
      <CommandPalette />
      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} />
      <BugReportModal
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
        view="main"
      />
    </div>
  )
}

/** Sidebar / inspector toggle glyph (window with a side panel). */
export function SidebarIcon({ side }: { side: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d={side === 'left' ? 'M6 2.5v11' : 'M10 2.5v11'} />
    </svg>
  )
}
