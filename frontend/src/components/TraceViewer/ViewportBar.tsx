import React from 'react'
import { useAppStore, Viewport } from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

/** Preset window sizes, in seconds. `null` means "full sweep". */
const WINDOW_PRESETS: { label: string; seconds: number | null }[] = [
  { label: 'Full',  seconds: null },
  { label: '5 min', seconds: 300 },
  { label: '1 min', seconds: 60 },
  { label: '30 s',  seconds: 30 },
  { label: '10 s',  seconds: 10 },
  { label: '1 s',   seconds: 1 },
]

/** Format seconds as M:SS.s — e.g. 123.4 -> "2:03.4" */
function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`
}

function currentPresetLabel(viewport: Viewport | null): string {
  if (!viewport) return 'Full'
  const len = viewport.end - viewport.start
  for (const p of WINDOW_PRESETS) {
    if (p.seconds !== null && Math.abs(p.seconds - len) < 0.01) return p.label
  }
  return 'Custom'
}

/** Thin bar sitting above the plot, giving the user control over the
 *  currently-visible time window on a long (continuous) sweep. */
export function ViewportBar() {
  const {
    viewport, sweepDuration,
    setViewportWindowSize, scrollViewport, setViewportStart,
  } = useAppStore()

  // Track the user-typed custom value separately so the field stays editable
  // without re-rendering away mid-keystroke.
  const customValue = viewport ? viewport.end - viewport.start : 1
  const commitCustom = (v: number) => {
    if (!isFinite(v) || v <= 0) return
    setViewportWindowSize(v)
  }

  // Hide the bar entirely for short sweeps where there's nothing to scroll.
  // (Threshold: anything under 10s of data is typical test-pulse territory.)
  if (sweepDuration <= 10) return null

  const len = viewport ? viewport.end - viewport.start : sweepDuration
  const start = viewport ? viewport.start : 0
  const end = viewport ? viewport.end : sweepDuration
  const atStart = start <= 1e-6
  const atEnd = end >= sweepDuration - 1e-6

  const presetLabel = currentPresetLabel(viewport)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '2px 8px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-secondary)',
        flexShrink: 0,
        minHeight: 22,
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>View:</span>

      {/* Window-size presets */}
      <div style={{ display: 'flex', gap: 2 }}>
        {WINDOW_PRESETS.map((p) => {
          const active = p.label === presetLabel
          return (
            <button
              key={p.label}
              className="zoom-btn"
              onClick={() => setViewportWindowSize(p.seconds)}
              aria-pressed={active}
              style={
                active
                  ? {
                      background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                      color: 'var(--accent)',
                      fontWeight: 600,
                    }
                  : undefined
              }
              title={p.seconds ? `Show a ${p.label} window` : 'Show the entire sweep'}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      {/* Custom window size input */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>Custom:</span>
        <NumInput
          value={customValue}
          min={0.001}
          step={0.1}
          onChange={commitCustom}
          style={{ width: 56, padding: '0 4px' }}
          title="Custom window length in seconds (Enter to apply)"
        />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>s</span>
      </div>

      {/* Scroll controls: |◀  ◀◀  ◀  ▶  ▶▶  ▶| */}
      <div style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
        <button
          className="zoom-btn"
          onClick={() => setViewportStart(0)}
          disabled={!viewport || atStart}
          title="Jump to start (Home)"
        >
          ⟨⟨
        </button>
        <button
          className="zoom-btn"
          onClick={() => scrollViewport(-2 * len)}
          disabled={!viewport || atStart}
          title="Scroll back 2 windows (Shift+←)"
        >
          ⟪
        </button>
        <button
          className="zoom-btn"
          onClick={() => scrollViewport(-len)}
          disabled={!viewport || atStart}
          title="Previous window (←)"
        >
          ◀
        </button>
        <button
          className="zoom-btn"
          onClick={() => scrollViewport(len)}
          disabled={!viewport || atEnd}
          title="Next window (→)"
        >
          ▶
        </button>
        <button
          className="zoom-btn"
          onClick={() => scrollViewport(2 * len)}
          disabled={!viewport || atEnd}
          title="Scroll forward 2 windows (Shift+→)"
        >
          ⟫
        </button>
        <button
          className="zoom-btn"
          onClick={() => setViewportStart(Math.max(0, sweepDuration - len))}
          disabled={!viewport || atEnd}
          title="Jump to end (End)"
        >
          ⟩⟩
        </button>
      </div>

      {/* Time readout */}
      <span
        className="num"
        style={{
          marginLeft: 'auto',
          color: 'var(--text-muted)',
        }}
      >
        {fmtTime(start)} – {fmtTime(end)} / {fmtTime(sweepDuration)}
      </span>
    </div>
  )
}

/** Thin horizontal slider under the plot showing the current viewport's
 *  position within the whole sweep. Drag to scroll. Click to center.
 *
 *  During drag we only update the *handle position* (viewport state), NOT
 *  the fetched data — otherwise every mousemove spams the backend with a
 *  refetch and the trace stalls for seconds waiting for the queue to drain.
 *  On mouseup we fire a single refetch for the final position. */
export function ViewportSlider() {
  const { viewport, sweepDuration, setViewport } = useAppStore()
  const trackRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)

  const len = viewport ? viewport.end - viewport.start : 0
  const visible =
    viewport != null && sweepDuration > 0 && len < sweepDuration - 1e-6

  /** Compute viewport for a given pointer X (centered on click). */
  const viewportFromX = (clientX: number): Viewport | null => {
    const el = trackRef.current
    if (!el) return null
    const st = useAppStore.getState()
    const vp = st.viewport
    if (!vp || st.sweepDuration <= 0) return null
    const winLen = vp.end - vp.start
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    let newStart = frac * st.sweepDuration - winLen / 2
    newStart = Math.max(0, Math.min(st.sweepDuration - winLen, newStart))
    return { start: newStart, end: newStart + winLen }
  }

  /** Update viewport state without triggering a backend fetch. */
  const setViewportPreview = (vp: Viewport) => {
    // Direct setState bypass: we only want the slider handle to move, not
    // issue a new fetch.
    useAppStore.setState({ viewport: vp })
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (!visible) return
    draggingRef.current = true
    const vp = viewportFromX(e.clientX)
    if (vp) setViewportPreview(vp)
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const v = viewportFromX(ev.clientX)
      if (v) setViewportPreview(v)
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // Commit: fire a single fetch for the final position.
      const finalVp = useAppStore.getState().viewport
      if (finalVp) setViewport(finalVp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!visible || !viewport) return null

  const startFrac = viewport.start / sweepDuration
  const lenFrac = len / sweepDuration

  return (
    <div
      ref={trackRef}
      onMouseDown={onMouseDown}
      style={{
        position: 'relative',
        height: 12,
        background: 'var(--bg-primary)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
        userSelect: 'none',
      }}
      title="Drag or click to scroll the viewport"
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: `${startFrac * 100}%`,
          width: `${Math.max(2, lenFrac * 100)}%`,
          background: 'var(--accent)',
          opacity: 0.55,
          borderRadius: 2,
        }}
      />
    </div>
  )
}
