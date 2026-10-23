import React from 'react'
import { useTraceExportStore } from '../../stores/traceExportStore'

interface Props {
  selectedIds: Set<string>
  onSelect: (id: string | null, mode: 'replace' | 'extend' | 'toggle') => void
  onAddClick: () => void
}

export function TraceList({ selectedIds, onSelect, onAddClick }: Props) {
  const items = useTraceExportStore((s) => s.items)
  const removeItem = useTraceExportStore((s) => s.removeItem)
  const reorderItem = useTraceExportStore((s) => s.reorderItem)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      // Side-panel convention used by Cursor / Cohort / etc. windows.
      // Secondary tint distinguishes the rail from the main viewer.
      background: 'var(--bg-secondary)',
      fontFamily: 'var(--font-ui)',
    }}>
      <div style={{
        padding: '6px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: 600,
      }}>
        Traces ({items.length})
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.length === 0 && (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            <p style={{ margin: '0 0 8px' }}>No traces yet.</p>
            <button className="btn" onClick={onAddClick}>+ Add traces…</button>
          </div>
        )}
        {items.map((item, idx) => {
          const sel = selectedIds.has(item.id)
          return (
            <div
              key={item.id}
              onClick={(e) => {
                const mode: 'replace' | 'extend' | 'toggle' = e.shiftKey
                  ? 'extend'
                  : (e.metaKey || e.ctrlKey) ? 'toggle' : 'replace'
                onSelect(item.id, mode)
              }}
              style={{
                padding: '6px 10px 6px 7px',
                borderBottom: '1px solid var(--border-subtle)',
                // Selected row: accent left-border + tinted background +
                // bolder text so the affordance reads clearly in light
                // and dark themes.
                borderLeft: sel ? '3px solid var(--accent)' : '3px solid transparent',
                background: sel ? 'var(--bg-selected)' : 'transparent',
                fontSize: 'var(--font-size-sm)',
                fontWeight: sel ? 600 : 400,
                color: sel ? 'var(--accent)' : 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{
                display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                background: item.style.color, flexShrink: 0,
                outline: sel ? '1px solid var(--accent)' : 'none',
                outlineOffset: 1,
              }} />
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: sel ? 'var(--text-primary)' : 'inherit',
              }}>
                {item.label}
              </span>
              <span style={{ display: 'flex', gap: 2 }}>
                <button
                  className="btn"
                  onClick={(e) => { e.stopPropagation(); reorderItem(item.id, -1) }}
                  disabled={idx === 0}
                  style={{ padding: '0 6px', fontSize: 'var(--font-size-xs)' }}
                  title="Move up"
                >↑</button>
                <button
                  className="btn"
                  onClick={(e) => { e.stopPropagation(); reorderItem(item.id, 1) }}
                  disabled={idx === items.length - 1}
                  style={{ padding: '0 6px', fontSize: 'var(--font-size-xs)' }}
                  title="Move down"
                >↓</button>
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (sel) onSelect(null, 'replace')
                    removeItem(item.id)
                  }}
                  style={{ padding: '0 6px', fontSize: 'var(--font-size-xs)' }}
                  title="Remove"
                >×</button>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
