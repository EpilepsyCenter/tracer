/**
 * Notes on the trace: flags drawn over the main viewer, the small editor
 * that adds / edits / deletes a note, the "note on this sweep" chip, and
 * the Notes list in the viewer bar. Notes live in the store's
 * ``traceNotes`` slice (saved in the sidecar); the viewer adds them from
 * its right-click menu.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, TraceNote } from '../../stores/appStore'

/** Where a flag sits, in the plot container's CSS pixels. */
export interface NoteFlagPos { id: string; x: number }

/** What the editor is working on: a new note (no ``id``) or an existing one. */
export interface NoteDraft {
  id?: string
  group: number
  series: number
  sweep: number
  time: number | null
  text: string
  /** Anchor in the plot container's CSS pixels. */
  x: number
  y: number
}

export function formatNoteTime(t: number | null): string {
  if (t == null) return 'whole sweep'
  if (Math.abs(t) >= 60) {
    const m = Math.floor(t / 60)
    return `${m} min ${(t - m * 60).toFixed(1)} s`
  }
  return t >= 1 ? `${t.toFixed(2)} s` : `${(t * 1000).toFixed(1)} ms`
}

function firstLine(text: string, max = 28): string {
  const line = text.split('\n')[0]
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Flags along the top of the plot, one per timed note on this sweep. */
export function NoteFlags({ notes, positions, top, onOpen }: {
  notes: TraceNote[]
  positions: NoteFlagPos[]
  top: number
  onOpen: (note: TraceNote, x: number, y: number) => void
}) {
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])
  return (
    <>
      {positions.map((p) => {
        const n = byId.get(p.id)
        if (!n) return null
        return (
          <button
            key={p.id}
            className="trace-note-flag"
            style={{ left: p.x, top }}
            title={`${formatNoteTime(n.time)}\n${n.text}\n\nClick to edit`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpen(n, p.x, top + 22) }}
            onContextMenu={(e) => e.stopPropagation()}
          >
            {firstLine(n.text)}
          </button>
        )
      })}
    </>
  )
}

/** Small popover to write, edit or delete a note. */
export function NoteEditor({ draft, onClose }: { draft: NoteDraft; onClose: () => void }) {
  const [text, setText] = useState(draft.text)
  const ref = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const { addTraceNote, updateTraceNote, removeTraceNote } = useAppStore.getState()

  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const save = () => {
    if (draft.id) updateTraceNote(draft.group, draft.series, draft.id, text)
    else addTraceNote(draft.group, draft.series, draft.sweep, draft.time, text)
    onClose()
  }

  return (
    <div
      ref={boxRef}
      className="trace-note-editor"
      style={{ left: Math.max(8, draft.x - 130), top: Math.max(8, draft.y) }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="trace-note-editor-head">
        {draft.id ? 'Note' : 'New note'} · sweep {draft.sweep + 1} · {formatNoteTime(draft.time)}
      </div>
      <textarea
        ref={ref}
        value={text}
        rows={3}
        placeholder="e.g. pulled out of cell, drug reached bath…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()       // keep the viewer's arrow / page keys out
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
        }}
      />
      <div className="trace-note-editor-actions">
        {draft.id && (
          <button
            className="btn btn-sm"
            onClick={() => { removeTraceNote(draft.group, draft.series, draft.id!); onClose() }}
          >Delete</button>
        )}
        <span style={{ flex: 1, color: 'var(--text-muted)' }}>Enter saves · Shift+Enter new line</span>
        <button className="btn btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={!text.trim() && !draft.id}>
          Save
        </button>
      </div>
    </div>
  )
}

/** Chips in the viewer bar for notes on the whole current sweep. */
export function SweepNoteChips({ onOpen }: { onOpen: (note: TraceNote, anchor: HTMLElement) => void }) {
  const group = useAppStore((s) => s.currentGroup)
  const series = useAppStore((s) => s.currentSeries)
  const sweep = useAppStore((s) => s.currentSweep)
  const averaged = useAppStore((s) => s.currentAveragedSweep)
  const list = useAppStore((s) => s.traceNotes[`${group}:${series}`])
  const notes = (list ?? []).filter((n) => n.sweep === sweep && n.time == null)
  if (averaged || notes.length === 0) return null
  return (
    <>
      {notes.map((n) => (
        <button
          key={n.id}
          className="trace-note-chip"
          title={`${n.text}\n\nClick to edit`}
          onClick={(e) => onOpen(n, e.currentTarget)}
        >✎ {firstLine(n.text, 40)}</button>
      ))}
    </>
  )
}

/** "Notes (n)" in the viewer bar: every note in the recording, click to go there. */
export function NotesMenu({ onGo }: {
  onGo: (group: number, series: number, note: TraceNote) => void
}) {
  const traceNotes = useAppStore((s) => s.traceNotes)
  const recording = useAppStore((s) => s.recording)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const out: { group: number; series: number; note: TraceNote }[] = []
    for (const [key, list] of Object.entries(traceNotes)) {
      const [g, s] = key.split(':').map(Number)
      for (const note of list) out.push({ group: g, series: s, note })
    }
    return out.sort((a, b) => a.group - b.group || a.series - b.series
      || a.note.sweep - b.note.sweep || (a.note.time ?? -1) - (b.note.time ?? -1))
  }, [traceNotes])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (rows.length === 0) return null
  const seriesLabel = (g: number, s: number) => {
    const ser = recording?.groups?.[g]?.series?.[s]
    return `G${g + 1} · S${s + 1}${ser?.label ? ` ${ser.label}` : ''}`
  }
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        className="btn btn-sm"
        onClick={() => setOpen((v) => !v)}
        title="Every note in this recording"
      >Notes ({rows.length})</button>
      {open && (
        <div className="trace-notes-menu">
          {rows.map(({ group, series, note }) => (
            <button
              key={note.id}
              className="analysis-menu-item trace-notes-menu-row"
              onClick={() => { setOpen(false); onGo(group, series, note) }}
            >
              <span className="trace-notes-menu-where">
                {seriesLabel(group, series)} · sweep {note.sweep + 1} · {formatNoteTime(note.time)}
              </span>
              <span className="trace-notes-menu-text">{note.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
