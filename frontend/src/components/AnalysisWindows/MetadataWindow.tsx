import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useAppStore,
  getMetaStatus,
  SidecarMeta,
  MetaStatus,
} from '../../stores/appStore'
import { TagChipInput } from '../common/TagChipInput'

/**
 * Metadata window — Phase A.2.
 *
 * Two-pane layout:
 *   Left  — list of recording-shaped files in the current folder, each
 *           with a tri-state status dot (red/yellow/green per
 *           ``getMetaStatus``). Clicking a file selects it for editing.
 *           Files without a sidecar still show, greyed out, so the
 *           user can pre-tag a whole cohort before any analysis starts.
 *   Right — single-file editor:
 *             - cell_id text field
 *             - file-level tag chip input (autocomplete from the pool of
 *               tags already used in the folder)
 *             - per-series chip rows (one row per HEKA series), with
 *               their own autocomplete pool
 *             - free-form notes textarea
 *
 * Architecture:
 *   - The "active recording" (the one currently loaded in the main
 *     window) is edited via the store so changes round-trip live to the
 *     main window's status dot and to other analysis windows. The store
 *     subscriber writes the sidecar to disk on a debounced 1s timer.
 *   - Other files in the folder are edited "off-store": we read their
 *     sidecar directly via the Electron IPC, edit a local copy, and
 *     write it back with ``writeSidecar``. This lets the user tag the
 *     whole cohort without having to open every file in the main
 *     viewer first.
 *   - Edits to the active file also broadcast a ``meta-update`` so any
 *     other open analysis window (and the main toolbar's status dot)
 *     re-render immediately.
 *
 * The Cohort Analysis module (Phase B) will read from these tags to
 * group cells; the consistency checker (Phase A.4) flags near-duplicate
 * tag spellings inside the same folder.
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

interface FolderEntry {
  filePath: string
  fileName: string
  hasSidecar: boolean
  meta: SidecarMeta | null
}

const STATUS_COLORS: Record<MetaStatus, string> = {
  red: 'var(--error)',
  yellow: 'var(--warning)',
  green: 'var(--success)',
}

const STATUS_TITLES: Record<MetaStatus, string> = {
  red: 'No file-level tags yet',
  yellow: 'File tags set; no series tagged yet',
  green: 'File tags set and ≥1 series tagged',
}

export function MetadataWindow({ backendUrl, fileInfo }: {
  backendUrl: string
  fileInfo: FileInfo | null
}) {
  // backendUrl drives the on-demand /api/files/tree fetch below — used
  // when the user picks a non-active file in the left pane and we need
  // its group/series tree to render per-series tag chips.

  const recording = useAppStore((s) => s.recording)
  const storeMeta = useAppStore((s) => s.recordingMeta)
  const setRecordingMeta = useAppStore((s) => s.setRecordingMeta)
  const setSeriesTags = useAppStore((s) => s.setSeriesTags)

  // Folder listing (left pane) and the cached meta for files that
  // *aren't* the active recording. The active recording's meta always
  // comes from `storeMeta`; everything else lives in this map.
  const [folder, setFolder] = useState<string | null>(null)
  const [entries, setEntries] = useState<FolderEntry[]>([])
  const [otherMeta, setOtherMeta] = useState<Record<string, SidecarMeta | null>>({})
  const [otherGroups, setOtherGroups] = useState<Record<string, any[] | null>>({})
  // Per-file tree-fetch status — drives the loading indicator and
  // prevents racing duplicate requests for the same path. ``loading``
  // is per-path so switching between files mid-fetch behaves sanely.
  const [treeLoading, setTreeLoading] = useState<Record<string, boolean>>({})
  const [treeError, setTreeError] = useState<Record<string, string | null>>({})

  // Which file is currently being edited in the right pane. When null
  // we fall back to the active recording. When a non-active file is
  // selected we edit its sidecar directly via writeSidecar.
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  // Batch-tag selection (Phase A.3). The right pane switches to a
  // batch-edit view whenever ``checked`` is non-empty. Tags committed
  // in batch mode are *added* to every checked file's existing tag
  // list — additive merge, never overwriting or removing.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [batchProgress, setBatchProgress] = useState<{
    total: number
    done: number
    errors: string[]
  } | null>(null)

  // Save status — shared across active + off-store paths since the
  // editor only ever shows one file at a time.
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Per-file timestamp of last successful save. The header shows
  // "Saved · just now" / "5s ago" so the user has positive
  // confirmation that their edits hit disk — addresses the user
  // request for an explicit save signal.
  const [lastSavedAt, setLastSavedAt] = useState<Record<string, number>>({})

  // Consistency-checker modal (Phase A.4). Opens on demand; computes
  // near-duplicate tag clusters across every sidecar in the folder
  // so the user can fix typos cohort-wide before running analyses.
  const [consistencyOpen, setConsistencyOpen] = useState(false)

  // Broadcast channel — for live meta-update sync to the main window
  // when the user edits the active recording's tags. Also listens
  // for ``metadata-focus-file`` requests posted by the Batch window
  // when the user clicks "Tag…" on a target row.
  const channelRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('tracer-sync')
      channelRef.current = ch
      ch.onmessage = (ev) => {
        const data = ev.data as any
        if (!data || data.type !== 'metadata-focus-file') return
        const fp = String(data.file_path ?? '')
        if (!fp) return
        focusFile(fp)
      }
      return () => ch.close()
    } catch { /* no-op */ }
  // ``focusFile`` is declared below; it captures setters that are
  // stable across renders, so this effect only needs to run once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------------
  // Folder listing
  // ------------------------------------------------------------------
  // User-picked folder takes priority over auto-anchored folder. Lets
  // users tag a directory of recordings without having one open. ``null``
  // means "use the auto-anchor (active recording or most-recent)".
  const [overrideFolder, setOverrideFolder] = useState<string | null>(null)

  const refreshFolder = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.listFolderRecordings) return
    // Anchor priority: explicit user-picked folder → active recording →
    // most-recent file from prefs. ``listFolderRecordings`` accepts
    // either a folder path or a file path and figures out the parent.
    let anchor = overrideFolder ?? recording?.filePath ?? null
    if (!anchor) {
      try {
        const prefs = await api.getPreferences()
        const recent = (prefs?.recentFiles as string[] | undefined)?.[0]
        if (recent) anchor = recent
      } catch { /* ignore */ }
    }
    if (!anchor) {
      setFolder(null)
      setEntries([])
      return
    }
    const result = await api.listFolderRecordings(anchor)
    setFolder(result.folder)
    setEntries(result.entries.map((e) => ({
      filePath: e.filePath,
      fileName: e.fileName,
      hasSidecar: e.hasSidecar,
      meta: (e.meta as SidecarMeta | null) ?? null,
    })))
    // Seed the off-store meta cache so the right pane can edit any
    // file in the folder without re-reading its sidecar on every
    // selection.
    setOtherMeta((prev) => {
      const next = { ...prev }
      for (const e of result.entries) {
        if (e.filePath !== recording?.filePath) {
          next[e.filePath] = (e.meta as SidecarMeta | null) ?? null
        }
      }
      return next
    })
  }, [overrideFolder, recording?.filePath])

  /** Focus a specific file (typically posted by the Batch window when
   *  the user clicks "Tag…" on an untagged row). Sets the override
   *  folder to the file's parent directory and selects the file in
   *  the left pane. The folder rescan + tree fetch then run as
   *  normal. */
  const focusFile = useCallback((filePath: string) => {
    if (!filePath) return
    const sep = filePath.lastIndexOf('/') >= 0 ? '/' : '\\'
    const parent = filePath.includes(sep)
      ? filePath.slice(0, filePath.lastIndexOf(sep))
      : null
    if (parent) setOverrideFolder(parent)
    setSelectedPath(filePath)
    setOtherMeta({})
    setOtherGroups({})
    setTreeLoading({})
    setTreeError({})
  }, [])

  // One-shot focus pickup — when another window writes
  // ``prefs.metadataFocusPath`` and then triggers our open, we
  // consume + clear the pref on mount. Covers the "metadata window
  // wasn't open yet" case that broadcast can't service.
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.getPreferences || !api.setPreferences) return
    let cancelled = false
    ;(async () => {
      try {
        const prefs = (await api.getPreferences()) ?? {}
        const fp = prefs.metadataFocusPath
        if (cancelled || typeof fp !== 'string' || !fp) return
        focusFile(fp)
        await api.setPreferences({ ...prefs, metadataFocusPath: undefined })
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [focusFile])

  /** Open a folder picker, point the metadata window at the result.
   *  Clears the per-file caches so stale data from the previous folder
   *  can't leak into the new one (different files may share a basename
   *  across folders, etc.). */
  const pickFolder = useCallback(async () => {
    const api = window.electronAPI
    const picked = await api?.openFolderDialog?.(overrideFolder ?? folder ?? undefined)
    if (!picked) return
    setOverrideFolder(picked)
    setSelectedPath(null)
    setOtherMeta({})
    setOtherGroups({})
    setTreeLoading({})
    setTreeError({})
  }, [overrideFolder, folder])

  useEffect(() => {
    refreshFolder()
  }, [refreshFolder])

  // ------------------------------------------------------------------
  // Active selection helpers
  // ------------------------------------------------------------------
  const activePath = selectedPath ?? recording?.filePath ?? null
  const isActiveRecording = activePath === recording?.filePath
  const activeMeta: SidecarMeta | null = isActiveRecording
    ? storeMeta
    : (activePath ? (otherMeta[activePath] ?? null) : null)

  // Lazy tree fetch for non-active files. /api/files/tree reads the
  // recording into a local variable on the backend and returns its
  // group/series tree without touching the active recording.
  //
  // Bug history: the previous version included ``otherGroups`` and
  // ``treeLoading`` in the deps array, which the effect updates via
  // ``setTreeLoading(...)`` itself. That triggered immediate re-runs +
  // cleanup-driven cancellation of the in-flight fetch — the loading
  // state stuck at ``true`` forever because the cancelled fetch never
  // wrote the resolution back. Fixed by holding the in-flight set in
  // a ref so the dep array contains only the trigger inputs (path).
  const treeFetchInFlightRef = useRef<Set<string>>(new Set())
  const otherGroupsRef = useRef(otherGroups)
  otherGroupsRef.current = otherGroups
  useEffect(() => {
    if (!activePath || isActiveRecording || !backendUrl) return
    if (otherGroupsRef.current[activePath] !== undefined) return
    if (treeFetchInFlightRef.current.has(activePath)) return
    treeFetchInFlightRef.current.add(activePath)
    setTreeLoading((prev) => ({ ...prev, [activePath]: true }))
    setTreeError((prev) => ({ ...prev, [activePath]: null }))
    fetch(`${backendUrl}/api/files/tree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: activePath }),
    })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => {
        const groups = Array.isArray(d?.groups) ? d.groups : []
        setOtherGroups((prev) => ({ ...prev, [activePath]: groups }))
      })
      .catch((err) => {
        setOtherGroups((prev) => ({ ...prev, [activePath]: null }))
        setTreeError((prev) => ({
          ...prev, [activePath]: String(err?.message ?? err),
        }))
      })
      .finally(() => {
        treeFetchInFlightRef.current.delete(activePath)
        setTreeLoading((prev) => ({ ...prev, [activePath]: false }))
      })
  }, [activePath, isActiveRecording, backendUrl])

  const activeTreeLoading = !!(activePath && treeLoading[activePath])
  const activeTreeError = activePath ? (treeError[activePath] ?? null) : null

  // For per-series chip rows we need the recording's group/series
  // tree. The active recording's tree comes from `recording.groups`;
  // closed files use the cache populated by the lazy fetch above.
  const activeGroups: any[] | null = isActiveRecording
    ? (recording?.groups ?? null)
    : (activePath ? (otherGroups[activePath] ?? null) : null)

  // ------------------------------------------------------------------
  // Tag suggestion pools — collected from every sidecar in the folder
  // so tag autocomplete spans the whole cohort (the main reason
  // people want a metadata module).
  // ------------------------------------------------------------------
  const { fileTagPool, seriesTagPool } = useMemo(() => {
    const fileSet = new Set<string>()
    const seriesSet = new Set<string>()
    const consume = (m: SidecarMeta | null | undefined) => {
      if (!m) return
      for (const t of m.group_tags ?? []) fileSet.add(t)
      for (const tags of Object.values(m.series_tags ?? {})) {
        for (const t of tags) seriesSet.add(t)
      }
    }
    consume(storeMeta)
    for (const e of entries) consume(e.meta)
    for (const m of Object.values(otherMeta)) consume(m)
    return {
      fileTagPool: Array.from(fileSet).sort(),
      seriesTagPool: Array.from(seriesSet).sort(),
    }
  }, [storeMeta, entries, otherMeta])

  // ------------------------------------------------------------------
  // Edit helpers — branch on whether we're editing the active record
  // or an off-store sidecar
  // ------------------------------------------------------------------
  const broadcastMetaUpdate = useCallback((filePath: string, meta: SidecarMeta | null) => {
    // Always carry the file_path the meta belongs to. The main
    // window's listener verifies its current recording matches
    // before adopting — without this, a tag edit racing with an
    // openFile would land the previous file's tags into the new
    // recording's state and silently save them to the wrong sidecar.
    channelRef.current?.postMessage({
      type: 'meta-update',
      file_path: filePath,
      recordingMeta: meta,
    })
  }, [])

  /** Apply an updater to the meta of the file at ``path``. Always
   *  writes directly to disk via ``writeSidecar`` — for both the
   *  active recording AND off-store files. The previous design
   *  routed active-recording edits through main's debounced
   *  auto-save, which raced with openFile: a tag edit followed by
   *  immediately opening a new file could either land the previous
   *  file's tags into the new recording's state (broadcast arriving
   *  too late) or just lose them entirely (no broadcast trigger to
   *  schedule a save). Direct-write is race-free because persistence
   *  happens at the moment of the user's action.
   *
   *  Main's auto-save still fires later via the broadcast → state
   *  listener path, but it just re-writes the same content (the
   *  metadata window already wrote it). Idempotent — minor disk
   *  churn, no correctness cost.
   */
  const updateMetaFor = useCallback(async (
    path: string,
    updater: (prev: SidecarMeta) => SidecarMeta,
  ) => {
    const api = window.electronAPI
    if (!api?.readSidecar || !api?.writeSidecar) return
    const isActive = path === recording?.filePath
    setSavingPath(path)
    setSaveError(null)
    try {
      // Read existing sidecar (preserves all other slices —
      // analyses, cursors, etc.), mutate only the meta block,
      // write back.
      const existing = (await api.readSidecar(path)) ?? {}
      const prevMeta = (existing.meta as SidecarMeta | undefined) ?? {}
      const nextMeta = updater(prevMeta)
      const payload = {
        ...existing,
        format: 'tracer-sidecar',
        version: existing.version ?? 2,
        meta: nextMeta,
      }
      const ok = await api.writeSidecar(path, payload)
      if (!ok) throw new Error('writeSidecar returned false')
      setLastSavedAt((m) => ({ ...m, [path]: Date.now() }))

      // UI sync. Active recording → update local store (so this
      // window's own metadata UI re-renders) + broadcast to main
      // (so the toolbar status dot, tree-navigator series chips,
      // cohort cells all reflect the new tags live). The broadcast
      // carries file_path so the main-window listener can verify
      // it's still on this recording before adopting.
      if (isActive) {
        useAppStore.setState({ recordingMeta: nextMeta })
        broadcastMetaUpdate(path, nextMeta)
      } else {
        setOtherMeta((m) => ({ ...m, [path]: nextMeta }))
      }
      setEntries((es) => es.map((e) => e.filePath === path
        ? { ...e, hasSidecar: true, meta: nextMeta }
        : e))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingPath(null)
    }
  }, [recording?.filePath, broadcastMetaUpdate])

  /** Force a re-write of the current meta to disk — the manual
   *  Save button. Useful as a safety net when the user wants
   *  positive confirmation that their edits are persisted, and as
   *  a way to flush in flight if anything went wrong with the
   *  per-edit auto-save. */
  const saveNow = useCallback(async (path: string) => {
    await updateMetaFor(path, (prev) => prev)
  }, [updateMetaFor])
  // ------------------------------------------------------------------
  // Batch-tag actions (Phase A.3)
  // ------------------------------------------------------------------
  const toggleChecked = useCallback((path: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const checkAll = useCallback(() => {
    setChecked(new Set(entries.map((e) => e.filePath)))
  }, [entries])

  const clearChecked = useCallback(() => setChecked(new Set()), [])

  /** Apply a meta-updater to every checked file in sequence. Routes
   *  through the same ``updateMetaFor`` helper used for single-file
   *  edits — that means the active recording's batch update goes
   *  through the store (and the auto-save subscriber + broadcast),
   *  while every other file gets a direct sidecar read-modify-write.
   *  Errors are collected per-file and displayed at the end without
   *  aborting the batch. */
  const runBatch = useCallback(async (
    updater: (prev: SidecarMeta) => SidecarMeta,
  ) => {
    const paths = Array.from(checked)
    if (paths.length === 0) return
    setBatchProgress({ total: paths.length, done: 0, errors: [] })
    const errors: string[] = []
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]
      try {
        await updateMetaFor(p, updater)
      } catch (err) {
        errors.push(`${p.split(/[/\\]/).pop()}: ${err instanceof Error ? err.message : String(err)}`)
      }
      setBatchProgress({ total: paths.length, done: i + 1, errors })
    }
    // Hold the completion banner briefly so the user sees "done N/N",
    // then collapse.
    window.setTimeout(() => setBatchProgress(null), 1500)
  }, [checked, updateMetaFor])

  // setRecordingMeta + setSeriesTags are kept in scope above as a
  // documented API surface; we currently bypass them in favor of
  // direct setState calls so wholesale replacements (e.g. clearing
  // an array) work without the merge-then-strip dance. Reference
  // them here so TS doesn't flag them as unused imports.
  void setRecordingMeta
  void setSeriesTags

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  void fileInfo  // currently mirrored via `recording`

  if (!folder) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12,
        height: '100%', padding: 24, color: 'var(--text-muted)',
        fontStyle: 'italic',
      }}>
        <span style={{ textAlign: 'center', maxWidth: 420 }}>
          Pick a folder of recordings to tag, or open a file in the main
          window — both produce the same per-folder list with editable
          tags on every file.
        </span>
        <button className="btn btn-primary btn-lg" onClick={pickFolder}>
          Pick folder…
        </button>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      fontSize: 'var(--font-size-base)',
    }}>
      {/* Top bar — folder context */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-sm)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Folder:</span>
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1,
        }} title={folder}>{folder}</span>
        <button
          className="btn"
          onClick={() => setConsistencyOpen(true)}
          title="Find near-duplicate tags across the folder (e.g. typos, case variants)"
        >Consistency check</button>
        <button
          className="btn"
          onClick={pickFolder}
          title="Switch to a different folder of recordings"
        >Pick folder…</button>
        <button
          className="btn"
          onClick={() => refreshFolder()}
          title="Re-scan folder for sidecars"
        >Refresh</button>
      </div>

      {consistencyOpen && (
        <ConsistencyCheckModal
          activeFilePath={recording?.filePath ?? null}
          activeMeta={storeMeta}
          entries={entries}
          otherMeta={otherMeta}
          onClose={() => setConsistencyOpen(false)}
          onRename={async (oldTag, newTag) => {
            // Apply across every file in the folder. Replaces the tag
            // case-insensitively in both file_tags and series_tags.
            const oldLower = oldTag.toLowerCase()
            const renameMeta = (m: SidecarMeta): SidecarMeta => {
              const next: SidecarMeta = { ...m }
              if (next.group_tags) {
                const replaced = next.group_tags.map((t) =>
                  t.toLowerCase() === oldLower ? newTag : t)
                // Dedupe in case the canonical name was already
                // present alongside the variant.
                const seen = new Set<string>()
                const dedup: string[] = []
                for (const t of replaced) {
                  const k = t.toLowerCase()
                  if (seen.has(k)) continue
                  seen.add(k)
                  dedup.push(t)
                }
                if (dedup.length === 0) delete next.group_tags
                else next.group_tags = dedup
              }
              if (next.series_tags) {
                const map: Record<string, string[]> = {}
                for (const [k, tags] of Object.entries(next.series_tags)) {
                  const replaced = tags.map((t) =>
                    t.toLowerCase() === oldLower ? newTag : t)
                  const seen = new Set<string>()
                  const dedup: string[] = []
                  for (const t of replaced) {
                    const lk = t.toLowerCase()
                    if (seen.has(lk)) continue
                    seen.add(lk)
                    dedup.push(t)
                  }
                  if (dedup.length > 0) map[k] = dedup
                }
                if (Object.keys(map).length === 0) delete next.series_tags
                else next.series_tags = map
              }
              return next
            }
            for (const e of entries) {
              await updateMetaFor(e.filePath, renameMeta)
            }
          }}
        />
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left pane — file list */}
        <div style={{
          width: 300,
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          overflowY: 'auto',
          flexShrink: 0,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Batch-selection header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px',
            borderBottom: '1px solid var(--border)',
            fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
            flexShrink: 0,
          }}>
            <span style={{ flex: 1 }}>
              {checked.size > 0
                ? `${checked.size} selected`
                : `${entries.length} file${entries.length === 1 ? '' : 's'}`}
            </span>
            <button
              className="btn btn-sm"
              onClick={checkAll}
              disabled={entries.length === 0 || checked.size === entries.length}
              title="Select every file in the folder"
            >All</button>
            <button
              className="btn btn-sm"
              onClick={clearChecked}
              disabled={checked.size === 0}
              title="Clear batch selection"
            >Clear</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
          {entries.length === 0 ? (
            <div style={{
              padding: 16, color: 'var(--text-muted)',
              fontStyle: 'italic',
            }}>No recordings in this folder.</div>
          ) : entries.map((e) => {
            const meta = e.filePath === recording?.filePath ? storeMeta : e.meta
            const status = getMetaStatus(meta)
            const isSelected = e.filePath === activePath
            const isActive = e.filePath === recording?.filePath
            const isChecked = checked.has(e.filePath)
            return (
              <div
                key={e.filePath}
                onClick={() => setSelectedPath(e.filePath)}
                title={e.filePath}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px',
                  borderBottom: '1px solid var(--border-subtle)',
                  background: isSelected ? 'var(--bg-selected)' : 'transparent',
                  opacity: e.hasSidecar || isActive ? 1 : 0.65,
                }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleChecked(e.filePath)}
                  onClick={(ev) => ev.stopPropagation()}
                  title="Include in batch tagging"
                  style={{ flexShrink: 0 }}
                />
                <span
                  title={STATUS_TITLES[status]}
                  style={{
                    width: 9, height: 9, borderRadius: '50%',
                    background: STATUS_COLORS[status],
                    flexShrink: 0,
                  }}
                />
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{e.fileName}</span>
                {isActive && (
                  <span style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-muted)',
                  }}>open</span>
                )}
              </div>
            )
          })}
          </div>
        </div>

        {/* Right pane — single-file editor or batch editor */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '12px 16px',
          minWidth: 0,
        }}>
          {checked.size > 0 ? (
            <BatchEditor
              checkedPaths={Array.from(checked)}
              fileTagSuggestions={fileTagPool}
              progress={batchProgress}
              onCancelSelection={clearChecked}
              onApplyFileTags={(tags) => runBatch((prev) => {
                const existing = new Set(prev.group_tags ?? [])
                for (const t of tags) existing.add(t)
                if (existing.size === 0) {
                  const next = { ...prev }
                  delete next.group_tags
                  return next
                }
                return { ...prev, group_tags: Array.from(existing) }
              })}
              onRemoveFileTags={(tags) => runBatch((prev) => {
                const drop = new Set(tags.map((t) => t.toLowerCase()))
                const kept = (prev.group_tags ?? [])
                  .filter((t) => !drop.has(t.toLowerCase()))
                const next = { ...prev }
                if (kept.length === 0) delete next.group_tags
                else next.group_tags = kept
                return next
              })}
              onSetAnimalId={(animalId) => runBatch((prev) => {
                const trimmed = animalId.trim()
                const next = { ...prev }
                if (trimmed) next.animal_id = trimmed
                else delete next.animal_id
                return next
              })}
            />
          ) : !activePath ? (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Select a recording from the left to edit its tags.
            </div>
          ) : (
            <FileEditor
              filePath={activePath}
              fileName={activePath.split(/[/\\]/).pop() ?? activePath}
              meta={activeMeta}
              groups={activeGroups}
              isActiveRecording={isActiveRecording}
              treeLoading={activeTreeLoading}
              treeError={activeTreeError}
              fileTagSuggestions={fileTagPool}
              seriesTagSuggestions={seriesTagPool}
              saving={savingPath === activePath}
              saveError={savingPath === null ? saveError : null}
              lastSavedAt={lastSavedAt[activePath] ?? null}
              onUpdate={(updater) => updateMetaFor(activePath, updater)}
              onSaveNow={() => saveNow(activePath)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Right-pane editor for a single file. Stateless — driven by `meta`
// from the parent and reports edits via `onUpdate`.
// ---------------------------------------------------------------------
function FileEditor({
  filePath, fileName, meta, groups,
  isActiveRecording,
  treeLoading, treeError,
  fileTagSuggestions, seriesTagSuggestions,
  saving, saveError, lastSavedAt,
  onUpdate, onSaveNow,
}: {
  filePath: string
  fileName: string
  meta: SidecarMeta | null
  groups: any[] | null
  isActiveRecording: boolean
  /** Tree-fetch status for non-active files. The parent runs an async
   *  read against /api/files/tree the first time a closed file is
   *  selected; until that resolves, the per-series chip section shows
   *  a placeholder rather than an empty list. */
  treeLoading: boolean
  treeError: string | null
  fileTagSuggestions: string[]
  seriesTagSuggestions: string[]
  saving: boolean
  saveError: string | null
  /** ms-since-epoch of the last successful save for this file.
   *  Drives the "Saved · 5s ago" relative-time label that ticks
   *  every few seconds via a small timer. */
  lastSavedAt: number | null
  onUpdate: (updater: (prev: SidecarMeta) => SidecarMeta) => void
  /** Force a re-write of the current meta. Wired to the Save
   *  button — the user-facing safety net even though every chip /
   *  field commit already auto-saves through ``onUpdate``. */
  onSaveNow: () => Promise<void> | void
}) {
  void filePath  // not currently displayed — fileName carries the label
  const fileTags = meta?.group_tags ?? []
  const seriesTags = meta?.series_tags ?? {}
  const cellId = meta?.cell_id ?? ''
  const animalId = meta?.animal_id ?? ''
  const notes = meta?.notes ?? ''

  // Fall back to whatever series_tags keys exist in the sidecar when
  // we don't have the recording's group tree (off-store edit).
  type SeriesRow = { groupIndex: number; seriesIndex: number; label: string }
  const seriesRows: SeriesRow[] = useMemo(() => {
    if (groups && groups.length > 0) {
      const rows: SeriesRow[] = []
      for (const g of groups) {
        const gIdx = g.index as number
        const gLabel = g.label as string | undefined
        for (const s of g.series ?? []) {
          rows.push({
            groupIndex: gIdx,
            seriesIndex: s.index,
            label: gLabel ? `${gLabel} / ${s.label}` : s.label,
          })
        }
      }
      return rows
    }
    // Off-store fallback: derive rows from the stored series_tags map.
    return Object.keys(seriesTags).map((k) => {
      const [g, s] = k.split(':').map(Number)
      return {
        groupIndex: g,
        seriesIndex: s,
        label: `Group ${g + 1} / Series ${s + 1}`,
      }
    }).sort((a, b) =>
      a.groupIndex - b.groupIndex || a.seriesIndex - b.seriesIndex)
  }, [groups, seriesTags])

  const updateField = <K extends keyof SidecarMeta>(key: K, value: SidecarMeta[K]) => {
    onUpdate((prev) => {
      const next: SidecarMeta = { ...prev }
      if (value === undefined || value === '' ||
          (Array.isArray(value) && value.length === 0)) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }

  const updateSeriesTags = (group: number, series: number, tags: string[]) => {
    onUpdate((prev) => {
      const next: SidecarMeta = { ...prev }
      const map = { ...(next.series_tags ?? {}) }
      const key = `${group}:${series}`
      const cleaned = tags.map((t) => t.trim()).filter(Boolean)
      if (cleaned.length === 0) delete map[key]
      else map[key] = cleaned
      if (Object.keys(map).length === 0) delete next.series_tags
      else next.series_tags = map
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      {/* File header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        paddingBottom: 6, borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: 'var(--font-size-base)',
          fontWeight: 600,
        }}>{fileName}</span>
        {!isActiveRecording && (
          <span style={{
            fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>not open in main window — editing sidecar directly</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <SaveStatus
            saving={saving}
            saveError={saveError}
            lastSavedAt={lastSavedAt}
          />
          <button
            className="btn btn-primary"
            onClick={() => { void onSaveNow() }}
            disabled={saving}
            title="Force-save this file's metadata to disk. Auto-save also fires on every chip / field change; this is the explicit safety button."
            style={{ cursor: saving ? 'wait' : undefined }}
          >Save</button>
        </div>
      </div>

      {/* Cell ID + Animal ID — paired row. Cell ID identifies the
          recording; Animal ID identifies the donor so the cohort
          module can collapse cells from the same animal when the
          user picks "N = animal". Both are free-text — any
          consistent naming works (e.g. mouse_42, slice7_cell3). */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Recording ID" hint="Optional human-readable identifier for this recording (works for cells, slices, field recordings, anything).">
          <input
            type="text"
            value={cellId}
            onChange={(e) => updateField('cell_id', e.target.value)}
            placeholder="rec_42"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="Animal ID" hint="Multiple cells from the same animal share this ID — used by Cohort Analysis to group with N=animal.">
          <input
            type="text"
            value={animalId}
            onChange={(e) => updateField('animal_id', e.target.value)}
            placeholder="mouse_07"
            style={{ width: '100%' }}
          />
        </Field>
      </div>

      {/* File-level tags */}
      <Field
        label="File tags"
        hint="Recording-level attributes (genotype, sex, age, treatment…). Type a tag and press Enter or comma to add."
      >
        <TagChipInput
          value={fileTags}
          onChange={(next) => updateField('group_tags', next)}
          suggestions={fileTagSuggestions}
          placeholder="add tag…"
        />
      </Field>

      {/* Per-series tags */}
      <Field
        label="Per-series tags"
        hint="Mark which series captured what (e.g. test_pulse, IV, evoked). Drag the main viewer's tree to load a series, then add tags here."
      >
        {treeLoading ? (
          <div style={{
            color: 'var(--text-muted)', fontStyle: 'italic',
            padding: '4px 0', fontSize: 'var(--font-size-xs)',
          }}>
            Loading recording tree…
          </div>
        ) : treeError ? (
          <div style={{
            color: 'var(--error)', fontStyle: 'italic',
            padding: '4px 0', fontSize: 'var(--font-size-xs)',
          }}>
            ⚠ Couldn't read recording tree: {treeError}
          </div>
        ) : seriesRows.length === 0 ? (
          <div style={{
            color: 'var(--text-muted)', fontStyle: 'italic',
            padding: '4px 0', fontSize: 'var(--font-size-xs)',
          }}>
            {isActiveRecording
              ? 'This recording has no series.'
              : 'No series found in this recording.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {seriesRows.map((row) => {
              const key = `${row.groupIndex}:${row.seriesIndex}`
              const tags = seriesTags[key] ?? []
              return (
                <div key={key} style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr',
                  alignItems: 'center', gap: 8,
                }}>
                  <span
                    title={key}
                    style={{
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--text-muted)',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >{row.label}</span>
                  <TagChipInput
                    value={tags}
                    onChange={(next) => updateSeriesTags(row.groupIndex, row.seriesIndex, next)}
                    suggestions={seriesTagSuggestions}
                    inline
                    placeholder="add tag…"
                  />
                </div>
              )
            })}
          </div>
        )}
      </Field>

      {/* Notes */}
      <Field label="Notes" hint="Free-form notes — quality issues, atypical conditions, anything that doesn't fit a tag.">
        <textarea
          value={notes}
          onChange={(e) => updateField('notes', e.target.value)}
          placeholder="any free-form notes about this recording…"
          rows={4}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>
    </div>
  )
}

// ---------------------------------------------------------------------
// Batch editor (Phase A.3)
//
// Shown when the user has ≥1 file checked in the left pane. Two
// staging chip-inputs:
//   - Add tags: chips committed here get merged into every checked
//     file's existing tag list (additive, never replaces).
//   - Remove tags: chips listed here get stripped from every checked
//     file (case-insensitive). Useful for fixing typos across a
//     cohort once the consistency checker (A.4) flags one.
//
// Per-series batch tagging is intentionally NOT included here yet —
// the per-series tag set varies file-by-file (different series
// counts, different protocols). A.3's value is the file-level case
// where users want to mark a whole cohort with shared attributes
// (genotype, treatment, slice batch).
// ---------------------------------------------------------------------
function BatchEditor({
  checkedPaths,
  fileTagSuggestions,
  progress,
  onCancelSelection,
  onApplyFileTags,
  onRemoveFileTags,
  onSetAnimalId,
}: {
  checkedPaths: string[]
  fileTagSuggestions: string[]
  progress: { total: number; done: number; errors: string[] } | null
  onCancelSelection: () => void
  onApplyFileTags: (tags: string[]) => void
  onRemoveFileTags: (tags: string[]) => void
  /** Set the same Animal ID on every selected file. Empty string
   *  clears the field. Common pattern: select every recording from
   *  one slice/animal at once and tag them with that animal's ID
   *  in a single click. */
  onSetAnimalId: (animalId: string) => void
}) {
  const [addTags, setAddTags] = useState<string[]>([])
  const [removeTags, setRemoveTags] = useState<string[]>([])
  const [animalIdDraft, setAnimalIdDraft] = useState('')
  const busy = progress !== null && progress.done < progress.total

  const apply = () => {
    if (addTags.length === 0) return
    onApplyFileTags(addTags)
    setAddTags([])
  }
  const remove = () => {
    if (removeTags.length === 0) return
    onRemoveFileTags(removeTags)
    setRemoveTags([])
  }
  const applyAnimalId = () => {
    onSetAnimalId(animalIdDraft)
    setAnimalIdDraft('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        paddingBottom: 6, borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: 'var(--font-size-base)', fontWeight: 600,
        }}>Batch tagging — {checkedPaths.length} file{checkedPaths.length === 1 ? '' : 's'}</span>
        <button
          className="btn"
          onClick={onCancelSelection}
          disabled={busy}
          style={{ marginLeft: 'auto' }}
        >Cancel selection</button>
      </div>

      <div style={{
        fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
        padding: '6px 8px',
        background: 'var(--bg-field)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        maxHeight: 100, overflowY: 'auto',
      }}>
        {checkedPaths.map((p) => (
          <div key={p} style={{
            overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{p.split(/[/\\]/).pop()}</div>
        ))}
      </div>

      <Field
        label="Set Animal ID"
        hint="Sets the same Animal ID on every selected file (overwrites any existing). Leave blank + Apply to clear. Common pattern: select all recordings from one animal, type the ID, Apply."
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <input
            type="text"
            value={animalIdDraft}
            onChange={(e) => setAnimalIdDraft(e.target.value)}
            placeholder="mouse_07"
            disabled={busy}
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-primary"
            onClick={applyAnimalId}
            disabled={busy}
          >Apply</button>
        </div>
      </Field>

      <Field
        label="Add file tags"
        hint="These tags get merged into every selected file's existing list. No file ever loses a tag this way."
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <TagChipInput
              value={addTags}
              onChange={setAddTags}
              suggestions={fileTagSuggestions}
              disabled={busy}
              placeholder="add tag…"
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={apply}
            disabled={busy || addTags.length === 0}
          >Apply</button>
        </div>
      </Field>

      <Field
        label="Remove file tags"
        hint="Listed tags are stripped from every selected file (case-insensitive). Files that don't carry the tag are skipped silently."
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <TagChipInput
              value={removeTags}
              onChange={setRemoveTags}
              suggestions={fileTagSuggestions}
              disabled={busy}
              placeholder="tag to remove…"
            />
          </div>
          <button
            className="btn"
            onClick={remove}
            disabled={busy || removeTags.length === 0}
          >Remove</button>
        </div>
      </Field>

      {progress && (
        <div style={{
          padding: '6px 10px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--font-size-xs)',
        }}>
          <div>
            {progress.done < progress.total
              ? `Applying… ${progress.done} / ${progress.total}`
              : progress.errors.length === 0
                ? `Done — updated ${progress.total} file${progress.total === 1 ? '' : 's'}.`
                : `Done with ${progress.errors.length} error${progress.errors.length === 1 ? '' : 's'} (${progress.done - progress.errors.length} updated).`
            }
          </div>
          {progress.errors.length > 0 && (
            <ul style={{
              marginTop: 4, paddingLeft: 18,
              color: 'var(--error)',
            }}>
              {progress.errors.map((err, i) => <li key={i}>{err}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Consistency checker (Phase A.4)
//
// Scans every sidecar in the folder, collects all tags + occurrences,
// then groups near-duplicates into clusters. A pair is "near" if any
// of:
//   - case-insensitive equal (e.g. "WT" vs "wt")
//   - whitespace / punctuation collapse equal (e.g. "test pulse" vs "test_pulse")
//   - Levenshtein distance ≤ 1 for short tags, ≤ 2 for ≥ 8-char tags
//
// The user picks the canonical form for each cluster and clicks Apply,
// which renames the variants to the canonical form across every
// sidecar in the folder.
// ---------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length
  const n = b.length
  // Two-row DP — sufficient for our short tag strings.
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      )
    }
    [prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Loose equality for clustering — matches case-only and
 *  whitespace/underscore-only differences exactly, plus small edit
 *  distances proportional to length. */
function isNearDuplicate(a: string, b: string): boolean {
  if (a === b) return false
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  if (al === bl) return true
  const ac = al.replace(/[\s_\-.]/g, '')
  const bc = bl.replace(/[\s_\-.]/g, '')
  if (ac === bc) return true
  const d = levenshtein(ac, bc)
  const maxLen = Math.max(ac.length, bc.length)
  if (maxLen < 4) return false       // too short — false positives explode
  if (maxLen <= 7) return d <= 1
  return d <= 2
}

interface TagOccurrence {
  tag: string
  count: number
  scope: 'file' | 'series' | 'mixed'
}

function ConsistencyCheckModal({
  activeFilePath, activeMeta, entries, otherMeta,
  onClose, onRename,
}: {
  activeFilePath: string | null
  activeMeta: SidecarMeta | null
  entries: FolderEntry[]
  otherMeta: Record<string, SidecarMeta | null>
  onClose: () => void
  onRename: (oldTag: string, newTag: string) => Promise<void>
}) {
  const [working, setWorking] = useState(false)

  // Gather all tags + occurrences across the folder.
  const occurrences: TagOccurrence[] = useMemo(() => {
    const counts = new Map<string, { count: number; scopes: Set<'file' | 'series'> }>()
    const consume = (m: SidecarMeta | null | undefined) => {
      if (!m) return
      for (const t of m.group_tags ?? []) {
        const slot = counts.get(t) ?? { count: 0, scopes: new Set() }
        slot.count += 1
        slot.scopes.add('file')
        counts.set(t, slot)
      }
      for (const tags of Object.values(m.series_tags ?? {})) {
        for (const t of tags) {
          const slot = counts.get(t) ?? { count: 0, scopes: new Set() }
          slot.count += 1
          slot.scopes.add('series')
          counts.set(t, slot)
        }
      }
    }
    consume(activeMeta)
    for (const e of entries) {
      if (e.filePath !== activeFilePath) consume(otherMeta[e.filePath] ?? e.meta)
    }
    return Array.from(counts.entries()).map(([tag, v]) => ({
      tag,
      count: v.count,
      scope: v.scopes.size === 2 ? 'mixed' as const :
        (v.scopes.has('file') ? 'file' as const : 'series' as const),
    }))
  }, [activeFilePath, activeMeta, entries, otherMeta])

  // Cluster near-duplicates with a simple union-find.
  const clusters: TagOccurrence[][] = useMemo(() => {
    const n = occurrences.length
    const parent = Array.from({ length: n }, (_, i) => i)
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]]
        i = parent[i]
      }
      return i
    }
    const union = (a: number, b: number) => {
      const ra = find(a), rb = find(b)
      if (ra !== rb) parent[ra] = rb
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (isNearDuplicate(occurrences[i].tag, occurrences[j].tag)) {
          union(i, j)
        }
      }
    }
    const groups = new Map<number, TagOccurrence[]>()
    for (let i = 0; i < n; i++) {
      const r = find(i)
      const arr = groups.get(r) ?? []
      arr.push(occurrences[i])
      groups.set(r, arr)
    }
    return Array.from(groups.values())
      .filter((g) => g.length >= 2)
      // Sort each cluster: most-frequent first (good default canonical).
      .map((g) => g.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)))
  }, [occurrences])

  // Per-cluster: which variant the user has picked as canonical.
  // Defaults to the most-frequent (first) entry.
  const [picked, setPicked] = useState<Record<number, string>>({})
  const canonicalFor = (idx: number) =>
    picked[idx] ?? clusters[idx]?.[0]?.tag ?? ''

  const applyCluster = async (idx: number) => {
    const cluster = clusters[idx]
    const canon = canonicalFor(idx)
    if (!cluster || !canon) return
    setWorking(true)
    try {
      for (const occ of cluster) {
        if (occ.tag === canon) continue
        await onRename(occ.tag, canon)
      }
    } finally {
      setWorking(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640, maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-popover)',
          overflow: 'hidden',
          color: 'var(--text-primary)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}>
          <span style={{ fontWeight: 600, flex: 1 }}>Tag consistency check</span>
          <button
            className="icon-btn"
            onClick={onClose}
            disabled={working}
            style={{ fontSize: 18 }}
          >×</button>
        </div>

        <div style={{ padding: '10px 14px', overflowY: 'auto' }}>
          {clusters.length === 0 ? (
            <div style={{
              padding: '24px 8px', textAlign: 'center',
              color: 'var(--text-muted)', fontStyle: 'italic',
            }}>
              No near-duplicate tags found across {entries.length} file{entries.length === 1 ? '' : 's'}.
            </div>
          ) : (
            <>
              <div style={{
                fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
                marginBottom: 10,
              }}>
                Found {clusters.length} cluster{clusters.length === 1 ? '' : 's'} of
                near-duplicate tags. For each, pick the canonical spelling and
                click Apply to rename the variants across every sidecar in the folder.
              </div>
              {clusters.map((cluster, idx) => {
                const canon = canonicalFor(idx)
                return (
                  <div key={idx} className="section-card" style={{ marginBottom: 8 }}>
                    <div className="section-card-title">
                      Variants ({cluster.length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {cluster.map((occ) => {
                        const isCanon = occ.tag === canon
                        return (
                          <label key={occ.tag} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            fontSize: 'var(--font-size-base)',
                          }}>
                            <input
                              type="radio"
                              name={`canon-${idx}`}
                              checked={isCanon}
                              onChange={() => setPicked((p) => ({ ...p, [idx]: occ.tag }))}
                            />
                            <span style={{ flex: 1, fontWeight: isCanon ? 600 : 400 }}>{occ.tag}</span>
                            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                              {occ.count}× · {occ.scope}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                    <div style={{
                      marginTop: 8, display: 'flex', justifyContent: 'flex-end',
                    }}>
                      <button
                        className="btn btn-primary"
                        onClick={() => applyCluster(idx)}
                        disabled={working || cluster.every((c) => c.tag === canon)}
                      >Rename variants → "{canon}"</button>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button
            className="btn"
            onClick={onClose}
            disabled={working}
          >Done</button>
        </div>
      </div>
    </div>
  )
}

// Save status pill — "Saving…" / "Saved · 5s ago" / "Save failed".
// Re-renders every few seconds to keep the relative time fresh
// without the rest of the editor having to know about timers.
function SaveStatus({ saving, saveError, lastSavedAt }: {
  saving: boolean
  saveError: string | null
  lastSavedAt: number | null
}) {
  // Tick every 5s so "5s ago" → "10s ago" → "1m ago" updates without
  // the user having to click anything. Cheap (single setState per
  // tick); cleaner than a more frequent refresh.
  const [, force] = useState(0)
  useEffect(() => {
    if (lastSavedAt == null) return
    const id = setInterval(() => force((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [lastSavedAt])

  if (saving) {
    return (
      <span style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)',
      }}>Saving…</span>
    )
  }
  if (saveError) {
    return (
      <span
        title={saveError}
        style={{ fontSize: 'var(--font-size-xs)', color: 'var(--error)' }}
      >Save failed</span>
    )
  }
  if (lastSavedAt == null) {
    return (
      <span style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)',
      }}>Not yet saved this session</span>
    )
  }
  const sec = Math.max(0, Math.floor((Date.now() - lastSavedAt) / 1000))
  const label = sec < 5 ? 'just now'
    : sec < 60 ? `${sec}s ago`
    : sec < 3600 ? `${Math.floor(sec / 60)}m ago`
    : `${Math.floor(sec / 3600)}h ago`
  return (
    <span style={{
      fontSize: 'var(--font-size-xs)',
      color: 'var(--success)',
    }}>Saved · {label}</span>
  )
}

function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{
        fontWeight: 600,
        color: 'var(--text-primary)',
        fontSize: 'var(--font-size-sm)',
      }}>{label}</label>
      {hint && (
        <span style={{
          fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
          marginBottom: 2,
        }}>{hint}</span>
      )}
      {children}
    </div>
  )
}
