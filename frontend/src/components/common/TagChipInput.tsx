import React, { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Multi-tag chip input.
 *
 * Reads / writes a ``string[]``. The user types into a textbox; pressing
 * Enter / comma / Tab commits the current text as a chip. Backspace on
 * an empty input removes the rightmost chip. Each chip has an inline
 * `×` to remove. Optional autocomplete from a flat ``suggestions`` list
 * — matches ranked by prefix first, then substring; pressing Enter on
 * a highlighted suggestion accepts it instead of the literal text.
 *
 * No store coupling — caller owns ``value`` + ``onChange``. Keeps the
 * component reusable for the metadata window's file-level tag input,
 * the per-series chips, the batch-tagging modal, etc.
 */
export function TagChipInput({
  value,
  onChange,
  placeholder,
  suggestions,
  inline,
  disabled,
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  /** Pool of tags already used elsewhere — drives the dropdown. The
   *  caller filters by source if needed (e.g. file-tag chips show only
   *  file-tag suggestions, not series-tag ones). */
  suggestions?: string[]
  /** When true, render the chip strip inline (single line, scroll
   *  horizontally on overflow). Used for the per-series chip rows in
   *  the metadata window's series list, where vertical space is tight.
   *  Default: wraps to multiple lines. */
  inline?: boolean
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Dropdown anchor coords — recomputed every time the dropdown
  // becomes visible so the portal-rendered list lines up with the
  // input even after the parent scrolls or the window resizes.
  const [dropdownPos, setDropdownPos] = useState<{
    left: number; top: number; width: number
  } | null>(null)

  // Filtered + ranked suggestions. Excludes already-applied tags so the
  // dropdown doesn't suggest things the user has just added.
  const ranked = (() => {
    if (!draft.trim() || !suggestions) return [] as string[]
    const q = draft.trim().toLowerCase()
    const have = new Set(value.map((v) => v.toLowerCase()))
    const startsWith: string[] = []
    const includes: string[] = []
    for (const s of suggestions) {
      if (have.has(s.toLowerCase())) continue
      const sl = s.toLowerCase()
      if (sl === q) continue
      if (sl.startsWith(q)) startsWith.push(s)
      else if (sl.includes(q)) includes.push(s)
    }
    return [...startsWith, ...includes].slice(0, 8)
  })()

  useEffect(() => {
    if (highlight >= ranked.length) setHighlight(0)
  }, [ranked.length, highlight])

  // Recompute dropdown anchor whenever it becomes visible. The
  // dropdown lives in a portal under document.body so parent
  // ``overflow: auto`` containers (e.g. the metadata window's right
  // pane) can't clip it. ``useLayoutEffect`` so the position is set
  // before the browser paints — avoids a one-frame flash where the
  // dropdown briefly anchors at (0,0).
  useLayoutEffect(() => {
    if (ranked.length === 0) {
      if (dropdownPos !== null) setDropdownPos(null)
      return
    }
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setDropdownPos({
      left: rect.left,
      top: rect.bottom + 2,
      width: Math.max(rect.width, 160),
    })
  }, [ranked.length, draft])

  // Close the dropdown if the user scrolls a parent — the cached
  // position would otherwise drift away from the input. Re-typing
  // triggers the layout effect above and restores it.
  useEffect(() => {
    if (!dropdownPos) return
    const onScroll = () => setDropdownPos(null)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [dropdownPos])

  const commit = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    if (value.some((x) => x.toLowerCase() === v.toLowerCase())) {
      // Duplicate — silently ignore but clear the input.
      setDraft('')
      return
    }
    onChange([...value, v])
    setDraft('')
    setHighlight(0)
  }

  const removeAt = (i: number) => {
    const next = value.slice()
    next.splice(i, 1)
    onChange(next)
  }

  return (
    <div
      ref={containerRef}
      onClick={() => inputRef.current?.focus()}
      style={{
        display: inline ? 'flex' : 'flex',
        flexWrap: inline ? 'nowrap' : 'wrap',
        overflowX: inline ? 'auto' : undefined,
        gap: 5, alignItems: 'center',
        padding: '4px 8px',
        border: '1px solid var(--border-control)',
        borderRadius: 'var(--radius)',
        background: disabled ? 'var(--bg-secondary)' : 'var(--bg-field)',
        minHeight: 32,
        cursor: 'text',
        position: 'relative',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 4px 1px 6px',
            borderRadius: 10,
            background: 'var(--accent-muted)',
            fontSize: 'var(--font-size-sm)',
            whiteSpace: 'nowrap',
            color: 'var(--text-primary)',
          }}>
          {tag}
          <button
            onClick={(e) => { e.stopPropagation(); removeAt(i) }}
            disabled={disabled}
            title="Remove tag"
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)',
              padding: 0, marginLeft: 2,
              fontSize: 14, lineHeight: 1,
            }}>×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        disabled={disabled}
        placeholder={value.length === 0 ? placeholder : ''}
        onChange={(e) => { setDraft(e.target.value); setHighlight(0) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
            // Tab still moves focus AFTER committing — avoid preventDefault
            // unless we actually consumed the keystroke.
            const consumed =
              ranked.length > 0 ? commitFrom(ranked[highlight]) : commitFromDraft()
            if (consumed) e.preventDefault()
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            e.preventDefault()
            removeAt(value.length - 1)
          } else if (e.key === 'ArrowDown' && ranked.length > 0) {
            e.preventDefault()
            setHighlight((h) => (h + 1) % ranked.length)
          } else if (e.key === 'ArrowUp' && ranked.length > 0) {
            e.preventDefault()
            setHighlight((h) => (h - 1 + ranked.length) % ranked.length)
          } else if (e.key === 'Escape') {
            setDraft('')
          }
        }}
        style={{
          flex: '1 1 80px', minWidth: 60,
          border: 'none', outline: 'none', boxShadow: 'none',
          background: 'transparent',
          color: 'var(--text-primary)',
          fontSize: 'var(--font-size-sm)',
          padding: '3px 0',
        }}
      />
      {ranked.length > 0 && dropdownPos && createPortal(
        // Portal-rendered dropdown — escapes any ancestor's
        // ``overflow: hidden / auto`` so suggestions stay visible
        // when the chip input lives inside a scrollable pane.
        // ``position: fixed`` plus the ref's bounding-rect means
        // the dropdown tracks the input even mid-render.
        <div style={{
          position: 'fixed',
          left: dropdownPos.left,
          top: dropdownPos.top,
          width: dropdownPos.width,
          zIndex: 9999,
          background: 'var(--bg-field)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--font-size-base)',
          fontFamily: 'var(--font-ui)',
          boxShadow: 'var(--shadow-popover)',
          padding: 5,
          maxHeight: 240,
          overflowY: 'auto',
        }}>
          {ranked.map((s, i) => (
            <div
              key={s}
              className="analysis-menu-item"
              onMouseDown={(e) => { e.preventDefault(); commit(s) }}
              style={{
                padding: '4px 8px',
                borderRadius: 'var(--radius-sm)',
                background: i === highlight ? 'var(--accent)' : 'transparent',
                color: i === highlight ? 'var(--on-accent)' : 'var(--text-primary)',
              }}>{s}</div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )

  // Helpers — declared after the JSX so they can close over the
  // current `draft` / `ranked` without prop drilling.
  function commitFrom(tag: string): boolean {
    commit(tag)
    return true
  }
  function commitFromDraft(): boolean {
    if (!draft.trim()) return false
    commit(draft)
    return true
  }
}
