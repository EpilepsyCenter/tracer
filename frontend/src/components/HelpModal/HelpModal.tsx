import React, { useEffect } from 'react'
import ReactDOM from 'react-dom'
import { Icon } from '../common/Icon'


interface ShortcutGroup {
  name: string
  items: Array<{ keys: string; label: string }>
}

const SHORTCUTS: ShortcutGroup[] = [
  {
    name: 'Navigation',
    items: [
      { keys: '←  /  →',     label: 'Previous / next sweep' },
      { keys: 'Home / End',  label: 'First / last sweep' },
      { keys: 'F',           label: 'Toggle focus mode' },
      { keys: 'F1',          label: 'Toggle navigator panel' },
      { keys: 'F2',          label: 'Toggle cursors panel' },
    ],
  },
  {
    name: 'Trace',
    items: [
      { keys: 'O',           label: 'Toggle overlay all sweeps' },
      { keys: 'A',           label: 'Open average menu' },
      { keys: 'Z',           label: 'Toggle zoom mode' },
    ],
  },
  {
    name: 'Application',
    items: [
      { keys: '⌘K  /  Ctrl+K', label: 'Open command palette' },
      { keys: '⌘O  /  Ctrl+O', label: 'Open file' },
      { keys: '?',             label: 'Open this help dialog' },
      { keys: 'Esc',           label: 'Close menus / dialogs' },
    ],
  },
]

interface HelpModalProps {
  open: boolean
  onClose: () => void
}

export function HelpModal({ open, onClose }: HelpModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const openManual = async () => {
    if (window.electronAPI?.openAnalysisWindow) {
      await window.electronAPI.openAnalysisWindow('manual')
      onClose()
    }
  }

  return ReactDOM.createPortal(
    <div className="help-overlay" onMouseDown={onClose}>
      <div
        className="help-panel"
        role="dialog"
        aria-label="Help"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-header">
          <div className="help-title">
            <Icon name="help" size={16} />
            Help &middot; TRACER
          </div>
          <button
            className="btn btn-compact btn-ghost"
            onClick={onClose}
            title="Close (Esc)"
          >Esc</button>
        </div>

        <div className="help-body">
          <div className="help-intro">
            An open electrophysiology workbench. Use the command palette
            (<span className="kbd">⌘K</span>) to find any action by
            name. The full user manual covers every analysis module
            in detail.
          </div>

          <div className="help-actions">
            <button
              className="btn btn-primary"
              onClick={openManual}
              title="Open the full user manual in your browser"
            >
              <Icon name="book" size={14} />
              Open user manual
            </button>
          </div>

          <div className="help-shortcuts">
            {SHORTCUTS.map((group) => (
              <div key={group.name} className="help-group">
                <div className="help-group-title">
                  <span className="tick" />{group.name}
                </div>
                <ul className="help-shortcut-list">
                  {group.items.map((item) => (
                    <li key={item.keys}>
                      <span className="help-shortcut-keys">{item.keys}</span>
                      <span className="help-shortcut-label">{item.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
