import React, { useEffect, useRef, useState } from 'react'
import { useAppStore, getMetaStatus } from '../../stores/appStore'

/**
 * Auto-dismissing toast that nudges the user to tag a freshly-opened
 * recording. Fires when:
 *   - a recording loads
 *   - its sidecar status is ``red`` (no file-level tags yet)
 *   - the recording's ``meta.suppressTagToast`` is not set
 *   - the user has not already dismissed the toast for this file
 *     during the current session
 *
 * Crucially, the decision waits for ``recordingMetaReady``: between
 * ``set({ recording })`` and the sidecar actually loading off disk,
 * ``recordingMeta`` is null and would falsely look red. Without this
 * gate, every freshly-opened green-status file would briefly trigger
 * the toast before the meta hydrated. Once meta is ready, the toast
 * is derived from current state on every render — if the user adds
 * tags (or the metadata window broadcasts a meta-update), the toast
 * disappears automatically.
 *
 * Auto-dismisses after 8 seconds. The user can:
 *   - click "Open metadata" → fires the same IPC the toolbar's
 *     "Tags…" button uses, opens the metadata window
 *   - click "Don't ask again for this file" → flips
 *     ``meta.suppressTagToast`` so this file never prompts again,
 *     persisted into the sidecar. Per-file rather than global so
 *     users don't accidentally turn the prompt off forever.
 *   - click ``×`` → in-session dismissal only; same file re-opened
 *     in a future session prompts again.
 */
const AUTO_DISMISS_MS = 8000

export function TagToast() {
  const recording = useAppStore((s) => s.recording)
  const meta = useAppStore((s) => s.recordingMeta)
  const ready = useAppStore((s) => s.recordingMetaReady)

  // In-session dismissal set keyed by filePath. Survives meta edits
  // within the session but resets on app restart.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Derived visibility — recomputed on every render. This is what
  // fixes the original bug: any meta change immediately re-evaluates
  // whether the toast should show, instead of locking in a "shown"
  // decision based on the very first (possibly null) read.
  const filePath = recording?.filePath ?? null
  const status = recording ? getMetaStatus(meta) : null
  const suppressed = !!meta?.suppressTagToast
  const userDismissed = filePath ? dismissed.has(filePath) : false
  const shouldShow = !!recording && ready
    && status === 'red' && !suppressed && !userDismissed

  // Auto-dismiss timer. Re-arms whenever the toast becomes visible
  // for a new file, and is cleared if visibility flips off (e.g.
  // user added a tag, status went red → green) so we don't fire
  // a stale dismissal seconds later.
  const timerRef = useRef<number | null>(null)
  useEffect(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!shouldShow || !filePath) return
    timerRef.current = window.setTimeout(() => {
      setDismissed((prev) => {
        const n = new Set(prev)
        n.add(filePath)
        return n
      })
    }, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [shouldShow, filePath])

  if (!shouldShow || !filePath) return null

  const dismiss = () => {
    setDismissed((prev) => {
      const n = new Set(prev)
      n.add(filePath)
      return n
    })
  }

  const openMetadata = async () => {
    const api = window.electronAPI
    if (api?.openAnalysisWindow) {
      await api.openAnalysisWindow('metadata')
    }
    dismiss()
  }

  const suppressForever = async () => {
    // Persistence of the meta block is exclusively owned by direct
    // writeSidecar calls — main's debounced auto-save preserves
    // disk's meta verbatim (see _saveSidecar). So we MUST write
    // the suppress flag to disk here, not just ``setState``.
    const prev = useAppStore.getState().recordingMeta ?? {}
    const next = { ...prev, suppressTagToast: true }
    const api = window.electronAPI
    if (api?.readSidecar && api?.writeSidecar) {
      try {
        const existing = (await api.readSidecar(filePath)) ?? {}
        await api.writeSidecar(filePath, {
          ...existing,
          format: 'tracer-sidecar',
          version: (existing as any).version ?? 2,
          meta: next,
        })
      } catch { /* ignore */ }
    }
    // Local store + broadcast so this window's UI hides the toast
    // and other windows refresh their meta view.
    useAppStore.setState({ recordingMeta: next })
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.postMessage({
        type: 'meta-update',
        file_path: filePath,
        recordingMeta: next,
      })
      ch.close()
    } catch { /* ignore */ }
    dismiss()
  }

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        bottom: 40, right: 16,
        zIndex: 9999,
        width: 360,
        padding: '12px 14px',
        background: 'var(--bg-field)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-popover)',
        fontSize: 'var(--font-size-base, 13px)',
        color: 'var(--text-primary)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        marginBottom: 10,
      }}>
        <div style={{ flex: 1, lineHeight: 1.4 }}>
          <div style={{ fontWeight: 600, marginBottom: 3, fontSize: 'var(--font-size-base, 14px)' }}>
            This recording has no tags
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm, 12px)' }}>
            Add a few tags now so it shows up in cohort analyses later.
          </div>
        </div>
        <button
          onClick={dismiss}
          title="Dismiss"
          style={{
            background: 'transparent', border: 'none',
            color: 'var(--text-muted)',
            padding: 0, fontSize: 18, lineHeight: 1,
          }}
        >×</button>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          className="btn"
          onClick={suppressForever}
          title="Don't show this prompt for this file again"
        >Don't ask for this file</button>
        <button
          className="btn btn-primary"
          onClick={openMetadata}
        >Add tags…</button>
      </div>
    </div>
  )
}
