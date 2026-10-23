import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  BugDiagnostics, buildTallyEmbedUrl, gatherDiagnostics,
} from '../../utils/diagnostics'

/**
 * In-app bug-report modal. Hosts a Tally form (form ID ``ZjvoQB``)
 * inside an iframe so researchers can submit bugs without leaving
 * TRACER and without needing a GitHub / Google account.
 *
 * The user-visible fields (title, description, severity, …) live
 * inside the Tally form. The hidden fields (app version, OS, last
 * error, …) are prefilled via URL parameters built by
 * ``buildTallyEmbedUrl`` so the user doesn't have to type any of
 * that. Submission lands in whatever Tally webhook the form owner
 * configured (email / Discord / etc.) — not in this app.
 *
 * Trust nudge: a "What we'll send" expander shows the diagnostic
 * fields verbatim so researchers can see exactly what's leaving the
 * machine before clicking submit. No file paths, no recording names,
 * no traces — just a coarse summary that helps triage.
 */
export function BugReportModal({
  open, onClose, view,
}: {
  open: boolean
  onClose: () => void
  /** Identifier for the calling window — main, events, ap, … —
   *  shipped as the ``view`` diagnostic field. */
  view: string
}) {
  // Re-snapshot every time the modal opens so a stale "last_error"
  // from an earlier session doesn't get attached to a fresh report.
  const [diagnostics, setDiagnostics] = useState<BugDiagnostics | null>(null)
  const [showDiag, setShowDiag] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    if (!open) return
    setDiagnostics(gatherDiagnostics(view))
    setShowDiag(false)
    setSubmitted(false)
  }, [open, view])

  // Listen for Tally's postMessage events. Tally emits a structured
  // message (``Tally.FormSubmitted``) on the parent window when the
  // user successfully submits the embedded form. We catch that and
  // flip into a thank-you state instead of leaving the iframe stuck
  // on Tally's "Thanks for submitting" view.
  useEffect(() => {
    if (!open) return
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return
      try {
        const parsed = JSON.parse(e.data)
        if (parsed?.event === 'Tally.FormSubmitted') {
          setSubmitted(true)
        }
      } catch { /* not a Tally message — ignore */ }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open])

  // Esc closes the modal — same affordance HelpModal uses.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const embedUrl = useMemo(
    () => (diagnostics ? buildTallyEmbedUrl(diagnostics) : ''),
    [diagnostics],
  )

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.18)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 100%)', maxHeight: '92vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-popover), 0 24px 60px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px 10px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 600 }}>
            Report a bug
          </span>
          <span style={{
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-xs)',
          }}>
            No account needed · stays inside the app
          </span>
          <button
            className="btn"
            onClick={onClose}
            style={{ marginLeft: 'auto' }}
            aria-label="Close"
          >Close</button>
        </div>

        {/* Body */}
        {submitted ? (
          <div style={{
            padding: '32px 20px',
            textAlign: 'center',
            color: 'var(--text-primary)',
            fontSize: 'var(--font-size-base)',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ fontSize: '2.4em' }}>✓</div>
            <div><strong>Thanks — your report was submitted.</strong></div>
            <div style={{
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)',
              maxWidth: 460, margin: '0 auto',
            }}>
              We'll triage and get back to you if you left an email. You can
              close this dialog and keep working — nothing else needs to
              happen on your end.
            </div>
            <button
              className="btn btn-primary"
              onClick={onClose}
              style={{ alignSelf: 'center', marginTop: 6, padding: '0 18px' }}
            >Close</button>
          </div>
        ) : (
          <>
            {/* Iframe — fills the body, dynamicHeight=1 lets Tally
                grow to fit so the user doesn't get a nested scrollbar
                on top of ours. We still cap the modal height on the
                outer wrapper. */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {embedUrl && (
                <iframe
                  ref={iframeRef}
                  src={embedUrl}
                  title="TRACER bug report"
                  style={{
                    width: '100%', minHeight: 580,
                    border: 'none', display: 'block',
                  }}
                />
              )}
            </div>

            {/* Trust footer — show exactly what's being attached. */}
            {diagnostics && (
              <div style={{
                flexShrink: 0,
                padding: '8px 16px',
                borderTop: '1px solid var(--border)',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-muted)',
              }}>
                <button
                  onClick={() => setShowDiag((v) => !v)}
                  style={{
                    background: 'transparent', border: 'none',
                    color: 'var(--text-muted)',
                    padding: 0, fontSize: 'inherit',
                  }}
                  type="button"
                >
                  {showDiag ? '▾' : '▸'} What we'll send along with your description
                </button>
                {showDiag && (
                  <pre style={{
                    margin: '6px 0 0',
                    padding: 8,
                    background: 'var(--bg-field)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    fontSize: 'var(--font-size-xs)',
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>{
                    Object.entries(diagnostics)
                      .map(([k, v]) => `${k} = ${v || '(empty)'}`)
                      .join('\n')
                  }</pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
