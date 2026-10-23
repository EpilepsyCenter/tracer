/**
 * Right-click "Copy as TSV" menu for result-table rows. Pops at the
 * click location; the parent table owns selection state and decides
 * what `getTSV()` returns (header line + each selected row as a
 * tab-separated record).
 *
 * Usage in a table:
 *
 *   const sel = useRowSelection(rows.length)
 *   const menu = useRowCopyMenu({
 *     getTSV: () => buildTSV(HEADERS, sel.selectedIndexes.map(rowToCells)),
 *     selectionCount: sel.selectedIndexes.length,
 *   })
 *
 *   <tr
 *     onClick={(e) => sel.onRowClick(i, e)}
 *     onContextMenu={(e) => menu.onContextMenu(e, () => {
 *       // Promote single-row right-click to a selection if the row
 *       // isn't already selected — prevents "Copy" copying the wrong
 *       // row when the user just right-clicked without a prior click.
 *       if (!sel.isSelected(i)) sel.setSelected([i])
 *     })}
 *   />
 *   {menu.menu}
 *
 * The menu auto-closes on outside click + Escape, and shows a small
 * "Copied N rows" toast for ~600 ms.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { copyTextToClipboard } from '../../utils/rowSelection'

interface UseRowCopyMenuArgs {
  /** Build the TSV at copy time so the latest selection is captured.
   *  Returns null when there's nothing to copy (caller should show
   *  the menu in disabled state). */
  getTSV: () => string | null
  /** Number of currently-selected rows — surfaces in the menu label
   *  so the user knows how many rows the action will copy. */
  selectionCount: number
}

export function useRowCopyMenu({ getTSV, selectionCount }: UseRowCopyMenuArgs) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const onContextMenu = useCallback((
    e: React.MouseEvent,
    promoteSelection?: () => void,
  ) => {
    promoteSelection?.()
    e.preventDefault()
    setPos({ x: e.clientX, y: e.clientY })
  }, [])

  const close = useCallback(() => setPos(null), [])

  const onCopy = useCallback(async () => {
    const tsv = getTSV()
    if (!tsv) { close(); return }
    const ok = await copyTextToClipboard(tsv)
    setToast(ok
      ? `Copied ${selectionCount} row${selectionCount === 1 ? '' : 's'}`
      : 'Copy failed')
    setTimeout(() => setToast(null), 1200)
    close()
  }, [getTSV, selectionCount, close])

  // Close menu on outside click / Escape.
  useEffect(() => {
    if (!pos) return
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement
      if (!t.closest('[data-row-copy-menu]')) close()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pos, close])

  const menu = (
    <>
      {pos && (
        <div data-row-copy-menu
          style={{
            position: 'fixed',
            left: Math.min(pos.x, window.innerWidth - 220),
            top: Math.min(pos.y, window.innerHeight - 60),
            zIndex: 200,
            minWidth: 200,
            padding: 5,
            background: 'var(--bg-field)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-popover)',
            fontSize: 'var(--font-size-base)',
            fontFamily: 'var(--font-ui)',
            overflow: 'hidden',
          }}>
          <button
            className={selectionCount === 0 ? undefined : 'analysis-menu-item'}
            onClick={onCopy}
            disabled={selectionCount === 0}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '4px 8px',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: 'var(--font-size-base)',
              fontFamily: 'var(--font-ui)',
              opacity: selectionCount === 0 ? 0.5 : 1,
            }}>
            Copy as TSV
            <span style={{
              marginLeft: 8, color: 'inherit', opacity: 0.6, fontSize: 'var(--font-size-xs)',
            }}>
              {selectionCount === 0
                ? 'select rows first'
                : `${selectionCount} row${selectionCount === 1 ? '' : 's'} · paste into Excel / Prism`}
            </span>
          </button>
        </div>
      )}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 16, right: 16,
          padding: '6px 12px',
          background: 'var(--bg-field)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--font-size-sm)',
          fontFamily: 'var(--font-ui)',
          boxShadow: 'var(--shadow-popover)',
          zIndex: 200,
          color: 'var(--text-primary)',
        }}>{toast}</div>
      )}
    </>
  )

  return { menu, onContextMenu }
}
