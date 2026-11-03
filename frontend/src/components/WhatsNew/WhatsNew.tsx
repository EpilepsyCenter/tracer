import React, { useEffect, useMemo } from 'react'
import ReactDOM from 'react-dom'
import ReactMarkdown from 'react-markdown'
import changelogMd from '../../../../docs/CHANGELOG.md?raw'
import { Icon } from '../common/Icon'
import { openManualAt } from '../../utils/manualLink'
import {
  type ChangelogEntry, LAST_SEEN_PREF, decideStartup, entriesForMenu as menuEntries, parseChangelog,
} from '../../utils/whatsNew'

/**
 * "What's new" dialog: the release notes from docs/CHANGELOG.md.
 *
 * Shown once, the first time a newer version starts (after an in-app
 * update or a manual install), and any time from Help ▸ What's New.
 * Fresh installs record their version silently. If several versions were
 * skipped, all of their notes are shown, newest first.
 */

export type { ChangelogEntry }

export const CHANGELOG = parseChangelog(changelogMd)

export function currentVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
}

/** Decide at startup whether to show the dialog, recording the running
 *  version as seen (see ``decideStartup``). */
export async function checkWhatsNewOnStartup(): Promise<ChangelogEntry[]> {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences) return []
  let prefs: Record<string, unknown> = {}
  try { prefs = ((await api.getPreferences()) ?? {}) as Record<string, unknown> } catch { return [] }
  const current = currentVersion()
  const { show, record } = decideStartup(prefs, current, CHANGELOG)
  if (record) {
    try { await api.patchPreferences({ [LAST_SEEN_PREF]: current }) } catch { /* ignore */ }
  }
  return show
}

export function entriesForMenu(): ChangelogEntry[] {
  return menuEntries(CHANGELOG, currentVersion())
}

export function WhatsNewDialog({ entries, onClose }: { entries: ChangelogEntry[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const title = entries.length === 1
    ? `What's new in TRACER ${entries[0].version}`
    : `What's new since TRACER ${entries[entries.length - 1].version}`

  const components = useMemo(() => ({
    // `manual:` links open the manual at that section.
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href?.startsWith('manual:')) {
        const path = decodeURIComponent(href.slice('manual:'.length))
        return (
          <button className="whats-new-link" onClick={() => { void openManualAt(path) }}
            title={`Open the manual at ${path.replace(/\s*>\s*/g, ' ▸ ')}`}>
            {children}
          </button>
        )
      }
      return <a href={href} onClick={(e) => { e.preventDefault(); if (href) void window.electronAPI?.openExternal?.(href) }}>{children}</a>
    },
  }), [])

  return ReactDOM.createPortal(
    <div className="help-overlay" onMouseDown={onClose}>
      <div className="help-panel whats-new-panel" role="dialog" aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-header">
          <div className="help-title">
            <Icon name="help" size={16} />
            {title}
          </div>
          <button className="btn btn-compact btn-ghost" onClick={onClose} title="Close (Esc)">Esc</button>
        </div>
        <div className="help-body whats-new-body">
          {entries.map((e) => (
            <section key={e.version} className="whats-new-version">
              {entries.length > 1 && <h2>{e.version}</h2>}
              <ReactMarkdown
                // Manual links use a custom scheme; let them through.
                urlTransform={(url) => url}
                components={components as any}
              >{e.body}</ReactMarkdown>
            </section>
          ))}
        </div>
        <div className="whats-new-footer">
          <button className="btn" onClick={() => { void openManualAt() }}>
            <Icon name="book" size={14} />
            Open the manual
          </button>
          <button className="btn btn-primary" onClick={onClose} autoFocus>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
