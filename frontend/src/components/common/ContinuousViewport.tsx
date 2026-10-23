import React, { useRef } from 'react'
import { NumInput } from './NumInput'

/**
 * Reusable continuous-trace viewport navigation — preset buttons, nav
 * arrows, custom-length input, time readout, minimap slider. Originally
 * lifted out of FieldBurstWindow so the EventDetectionWindow can share
 * the exact same UX.
 *
 * Viewport is stored as `{ tStart, tEnd }` in seconds, or null to mean
 * "full sweep". The minimap only renders when a proper windowed viewport
 * is set (i.e. less than the full sweep duration).
 */

export const VIEWPORT_PRESETS: { label: string; seconds: number | null }[] = [
  { label: 'Full',  seconds: null },
  { label: '5 min', seconds: 300 },
  { label: '1 min', seconds: 60 },
  { label: '30 s',  seconds: 30 },
  { label: '10 s',  seconds: 10 },
  { label: '1 s',   seconds: 1 },
]

export function fmtViewportTime(s: number): string {
  if (!isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`
}

export type Viewport = { tStart: number; tEnd: number } | null
export type SetViewport = React.Dispatch<React.SetStateAction<Viewport>>

export function ViewportBar({
  viewport, sweepDuration, setViewport, shiftViewport, goHome, goEnd,
}: {
  viewport: Viewport
  sweepDuration: number
  setViewport: SetViewport
  shiftViewport: (widthsFactor: number) => void
  goHome: () => void
  goEnd: () => void
}) {
  const len = viewport ? viewport.tEnd - viewport.tStart : sweepDuration
  const start = viewport ? viewport.tStart : 0
  const end = viewport ? viewport.tEnd : sweepDuration
  const atStart = start <= 1e-6
  const atEnd = sweepDuration > 0 && end >= sweepDuration - 1e-6

  const presetLabel = (() => {
    if (!viewport || (sweepDuration > 0 && len >= sweepDuration - 1e-3)) return 'Full'
    for (const p of VIEWPORT_PRESETS) {
      if (p.seconds !== null && Math.abs(p.seconds - len) < 0.01) return p.label
    }
    return 'Custom'
  })()

  const setWindow = (seconds: number | null) => {
    if (seconds == null) {
      if (sweepDuration <= 0) { setViewport({ tStart: 0, tEnd: 10 }); return }
      setViewport({ tStart: 0, tEnd: sweepDuration })
      return
    }
    const curStart = viewport?.tStart ?? 0
    const ns = Math.max(0, Math.min(curStart, Math.max(0, sweepDuration - seconds)))
    const ne = sweepDuration > 0 ? Math.min(sweepDuration, ns + seconds) : ns + seconds
    setViewport({ tStart: ns, tEnd: ne })
  }

  const customValue = len || 10
  const commitCustom = (v: number) => {
    if (!isFinite(v) || v <= 0) return
    setWindow(v)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '2px 8px',
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border)',
      fontSize: 'var(--font-size-xs)',
      color: 'var(--text-secondary)',
      flexShrink: 0, minHeight: 22,
    }}>
      <span style={{ color: 'var(--text-muted)' }}>View:</span>
      <div style={{ display: 'flex', gap: 2 }}>
        {VIEWPORT_PRESETS.map((p) => {
          const active = p.label === presetLabel
          return (
            <button key={p.label} className="zoom-btn"
              onClick={() => setWindow(p.seconds)}
              aria-pressed={active}
              style={active ? {
                background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                color: 'var(--accent)', fontWeight: 600,
              } : undefined}
              title={p.seconds ? `Show a ${p.label} window` : 'Show the entire sweep'}>
              {p.label}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>Custom:</span>
        <NumInput value={customValue} min={0.001} step={0.1} onChange={commitCustom}
          style={{ width: 56, padding: '0 4px' }} title="Custom window length in seconds" />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>s</span>
      </div>
      <div style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
        <button className="zoom-btn" onClick={goHome} disabled={atStart} title="Jump to start">⟨⟨</button>
        <button className="zoom-btn" onClick={() => shiftViewport(-2)} disabled={atStart} title="Scroll back 2 windows">⟪</button>
        <button className="zoom-btn" onClick={() => shiftViewport(-1)} disabled={atStart} title="Previous window">◀</button>
        <button className="zoom-btn" onClick={() => shiftViewport(1)} disabled={atEnd} title="Next window">▶</button>
        <button className="zoom-btn" onClick={() => shiftViewport(2)} disabled={atEnd} title="Scroll forward 2 windows">⟫</button>
        <button className="zoom-btn" onClick={goEnd} disabled={atEnd} title="Jump to end">⟩⟩</button>
      </div>
      <span className="num" style={{
        marginLeft: 'auto', color: 'var(--text-muted)',
      }}>
        {fmtViewportTime(start)} – {fmtViewportTime(end)}
        {sweepDuration > 0 ? ` / ${fmtViewportTime(sweepDuration)}` : ''}
      </span>
    </div>
  )
}

export function ViewportSlider({
  viewport, sweepDuration, setViewport,
}: {
  viewport: Viewport
  sweepDuration: number
  setViewport: SetViewport
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const vpRef = useRef(viewport)
  vpRef.current = viewport

  const len = viewport ? viewport.tEnd - viewport.tStart : 0
  const visible = viewport != null && sweepDuration > 0 && len < sweepDuration - 1e-6

  const viewportFromX = (clientX: number) => {
    const el = trackRef.current
    if (!el || !vpRef.current || sweepDuration <= 0) return null
    const winLen = vpRef.current.tEnd - vpRef.current.tStart
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    let newStart = frac * sweepDuration - winLen / 2
    newStart = Math.max(0, Math.min(sweepDuration - winLen, newStart))
    return { tStart: newStart, tEnd: newStart + winLen }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (!visible) return
    draggingRef.current = true
    const vp = viewportFromX(e.clientX)
    if (vp) setViewport(vp)
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const v = viewportFromX(ev.clientX)
      if (v) setViewport(v)
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!visible || !viewport) return null
  const startFrac = viewport.tStart / sweepDuration
  const lenFrac = len / sweepDuration

  return (
    <div ref={trackRef} onMouseDown={onMouseDown}
      style={{
        position: 'relative', height: 12,
        background: 'var(--bg-primary)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0, userSelect: 'none',
      }}
      title="Drag or click to scroll the viewport">
      <div style={{
        position: 'absolute', top: 2, bottom: 2,
        left: `${startFrac * 100}%`,
        width: `${Math.max(2, lenFrac * 100)}%`,
        background: 'var(--accent)', opacity: 0.55, borderRadius: 2,
      }} />
    </div>
  )
}

/** Utility: shift the viewport by `factor × width`, clamping to [0, duration]. */
export function shiftViewportBy(
  vp: Viewport, duration: number, factor: number,
): Viewport {
  if (!vp) return vp
  const w = vp.tEnd - vp.tStart
  const dx = w * factor
  let ns = vp.tStart + dx
  let ne = vp.tEnd + dx
  if (ns < 0) { ne -= ns; ns = 0 }
  if (duration > 0 && ne > duration) {
    const over = ne - duration
    ns = Math.max(0, ns - over)
    ne = duration
  }
  return { tStart: ns, tEnd: ne }
}
