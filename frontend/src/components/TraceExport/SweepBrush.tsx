import React, { useEffect, useRef, useState } from 'react'

interface Props {
  count: number
  selected: Set<number>
  onChange: (next: Set<number>) => void
}

// Layout constants
const MAX_PER_ROW = 40
const STRIP_H = 28      // sweep cell row height (CSS px)
const TICK_H = 14       // tick + label row height
const ROW_GAP = 6       // gap between row blocks

/**
 * Brushable horizontal strip of N sweeps. Wraps into multiple rows of
 * up to ``MAX_PER_ROW`` (40) cells when the count is large, so the
 * cells stay readable instead of shrinking to slivers.
 *
 * Interactions:
 *   - Plain click + drag      → set selection to the dragged range
 *                               (replaces). Single-cell click toggles.
 *   - Shift / Cmd / Ctrl drag → additive: union the dragged range
 *                               into the current selection.
 *   - Drag spans rows         → range is in sweep-index order
 *                               (1-based contiguous), regardless of
 *                               which row the cursor is on.
 *   - Hover shows the sweep number tooltip.
 */
export function SweepBrush({ count, selected, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerW, setContainerW] = useState(0)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (e) setContainerW(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowCount = Math.max(1, Math.ceil(count / MAX_PER_ROW))
  // Use the smaller of MAX_PER_ROW or the total count for cell width
  // sizing. With <40 sweeps, cells expand to fill the container; with
  // ≥40, cells are sized for 40 per row and remaining rows use the
  // same cell width so columns line up vertically.
  const cellsPerRow = Math.min(MAX_PER_ROW, Math.max(1, count))
  const cellW = count > 0
    ? Math.max(4, Math.floor(containerW / cellsPerRow))
    : 0

  function idxFromEvent(ev: React.PointerEvent | PointerEvent): number {
    const el = containerRef.current
    if (!el || count === 0) return 0
    const rect = el.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    const rowBlockH = STRIP_H + TICK_H + ROW_GAP
    const row = Math.max(0, Math.min(rowCount - 1, Math.floor(y / rowBlockH)))
    const col = Math.max(0, Math.min(cellsPerRow - 1, Math.floor(x / cellW)))
    return Math.max(0, Math.min(count - 1, row * MAX_PER_ROW + col))
  }

  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return
    ev.preventDefault()
    const startIdx = idxFromEvent(ev)
    const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey
    const baseline = additive ? new Set(selected) : new Set<number>()
    let lastEnd = startIdx
    const apply = (endIdx: number) => {
      const next = new Set(baseline)
      const lo = Math.min(startIdx, endIdx)
      const hi = Math.max(startIdx, endIdx)
      for (let i = lo; i <= hi; i++) next.add(i)
      onChange(next)
      lastEnd = endIdx
    }
    apply(startIdx)
    const target = ev.currentTarget
    target.setPointerCapture(ev.pointerId)
    const onMove = (moveEv: PointerEvent) => apply(idxFromEvent(moveEv))
    const onUp = (upEv: PointerEvent) => {
      // Click (no drag) on a single already-selected cell → deselect.
      if (lastEnd === startIdx && !additive && selected.has(startIdx) && selected.size === 1) {
        onChange(new Set())
      } else if (lastEnd === startIdx && additive && selected.has(startIdx)) {
        const next = new Set(selected)
        next.delete(startIdx)
        onChange(next)
      }
      try { target.releasePointerCapture(upEv.pointerId) } catch { /* ignore */ }
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
  }

  // Tick interval picked once based on cell width — every row uses
  // the same interval so labels line up vertically across rows.
  const tickInterval = pickTickInterval(cellW)

  // ----- Per-row geometry --------------------------------------------------

  const rows = Array.from({ length: rowCount }, (_, r) => {
    const startIdx = r * MAX_PER_ROW
    const endIdxExclusive = Math.min(startIdx + MAX_PER_ROW, count)
    const rowCount_ = endIdxExclusive - startIdx
    return { startIdx, endIdxExclusive, rowCount: rowCount_ }
  })

  // Hover tooltip position — needs to know which row the hovered cell
  // is on so the tooltip floats above the right strip.
  const hoverRow = hoverIdx != null ? Math.floor(hoverIdx / MAX_PER_ROW) : -1
  const hoverCol = hoverIdx != null ? hoverIdx % MAX_PER_ROW : -1

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={(ev) => setHoverIdx(idxFromEvent(ev))}
      onPointerLeave={() => setHoverIdx(null)}
      style={{
        position: 'relative',
        width: '100%',
        userSelect: 'none',
        cursor: count > 0 ? 'crosshair' : 'default',
      }}
    >
      {rows.map((row, r) => {
        // Build tick indices for THIS row. We always show the very
        // first sweep of the row (gives row-start orientation) and
        // the very last sweep of the row, plus interior ticks at the
        // chosen interval.
        const ticks: number[] = [row.startIdx]
        let next = Math.ceil(row.startIdx / tickInterval) * tickInterval
        if (next === row.startIdx) next += tickInterval
        while (next < row.endIdxExclusive - 1) {
          // Skip ticks too close to the row-start label.
          if ((next - row.startIdx) * cellW > 22) ticks.push(next)
          next += tickInterval
        }
        const lastIdx = row.endIdxExclusive - 1
        if (lastIdx > row.startIdx
            && lastIdx - (ticks[ticks.length - 1] ?? row.startIdx) >= Math.max(1, Math.floor(tickInterval / 2))) {
          ticks.push(lastIdx)
        }
        return (
          <div
            key={r}
            style={{
              position: 'relative',
              marginTop: r > 0 ? ROW_GAP : 0,
            }}
          >
            {/* Sweep cells */}
            <div style={{
              position: 'relative',
              height: STRIP_H,
              width: cellW * cellsPerRow,
              maxWidth: '100%',
              background: 'var(--bg-field)',
              border: '1px solid var(--border-control)',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
            }}>
              {Array.from({ length: row.rowCount }, (_, k) => {
                const i = row.startIdx + k
                const isSelected = selected.has(i)
                const isHover = hoverIdx === i
                return (
                  <div
                    key={i}
                    style={{
                      position: 'absolute',
                      left: k * cellW,
                      top: 0,
                      width: cellW,
                      height: '100%',
                      background: isSelected
                        ? 'var(--accent)'
                        : isHover
                          ? 'var(--bg-active)'
                          : 'transparent',
                      borderRight: cellW >= 8 ? '1px solid var(--border)' : 'none',
                      transition: 'background 80ms',
                    }}
                  />
                )
              })}
              {/* Hover tooltip — only on the row the cursor is on. */}
              {hoverRow === r && hoverCol >= 0 && cellW >= 6 && (
                <div style={{
                  position: 'absolute',
                  left: Math.min(
                    Math.max(0, hoverCol * cellW + cellW / 2 - 16),
                    Math.max(0, cellW * row.rowCount - 32),
                  ),
                  top: -22,
                  fontSize: 'var(--font-size-xs)',
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg-field)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0 4px',
                  pointerEvents: 'none',
                  color: 'var(--text-primary)',
                  zIndex: 2,
                }}>{hoverIdx! + 1}</div>
              )}
            </div>
            {/* Tick row for this strip */}
            <div style={{
              position: 'relative',
              width: cellW * cellsPerRow,
              maxWidth: '100%',
              height: TICK_H,
              marginTop: 1,
            }}>
              {ticks.map((i) => {
                const k = i - row.startIdx
                const x = k * cellW + cellW / 2
                return (
                  <React.Fragment key={i}>
                    <div style={{
                      position: 'absolute',
                      left: x - 0.5,
                      top: 0,
                      width: 1,
                      height: 3,
                      background: 'var(--text-muted)',
                    }} />
                    <div style={{
                      position: 'absolute',
                      left: Math.min(Math.max(0, x - 14), Math.max(0, cellW * row.rowCount - 28)),
                      top: 3,
                      width: 28,
                      textAlign: 'center',
                      fontSize: 'var(--font-size-xs)',
                      lineHeight: 1,
                      color: 'var(--text-muted)',
                      pointerEvents: 'none',
                      fontFamily: 'var(--font-mono)',
                    }}>{i + 1}</div>
                  </React.Fragment>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Pick a "nice" tick interval (1, 2, 5, 10, 20, 50, 100, …) such
 *  that adjacent labels are at least ~30 CSS px apart at the given
 *  cell width. */
function pickTickInterval(cellW: number): number {
  if (cellW <= 0) return 1
  const minSpacingPx = 30
  const rawInterval = Math.max(1, minSpacingPx / cellW)
  const exp = Math.floor(Math.log10(rawInterval))
  const base = 10 ** exp
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= rawInterval) return m * base
  }
  return Math.ceil(rawInterval)
}

// ---------------------------------------------------------------------------
// Range-text helpers — shared between the picker and any future
// "type a sweep range" affordance.
// ---------------------------------------------------------------------------

/** Format a Set of 0-indexed sweep ids as a 1-indexed range string.
 *  Example: {0,1,2,3,4,6,8,9,10,11} → "1-5, 7, 9-12". */
export function formatRanges(set: Set<number>): string {
  const sorted = Array.from(set).sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const parts: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i]
    if (v === prev + 1) {
      prev = v
      continue
    }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`)
    start = v
    prev = v
  }
  parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`)
  return parts.join(', ')
}

/** Parse a 1-indexed range string into a 0-indexed Set, clamped to
 *  [0, max). Lenient: ignores empty tokens and reversed ranges. */
export function parseRanges(text: string, max: number): Set<number> {
  const out = new Set<number>()
  if (!text.trim()) return out
  for (const raw of text.split(/[,\s]+/)) {
    if (!raw) continue
    const m = raw.match(/^(\d+)\s*(?:-|–|–|—|to)\s*(\d+)$/)
    if (m) {
      let a = parseInt(m[1], 10) - 1
      let b = parseInt(m[2], 10) - 1
      if (Number.isNaN(a) || Number.isNaN(b)) continue
      if (a > b) [a, b] = [b, a]
      a = Math.max(0, a); b = Math.min(max - 1, b)
      for (let i = a; i <= b; i++) out.add(i)
    } else {
      const n = parseInt(raw, 10) - 1
      if (!Number.isNaN(n) && n >= 0 && n < max) out.add(n)
    }
  }
  return out
}
