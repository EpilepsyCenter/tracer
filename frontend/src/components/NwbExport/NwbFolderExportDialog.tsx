/**
 * File ▸ Export Folder as NWB…: one NWB file per recording in a folder,
 * written to a separate output folder, each checked with the NWB
 * Inspector. Works without a recording open.
 *
 * The backend scans the folder (sidecars only, quick), then the dialog
 * exports file by file (``/api/nwb/export_file``) so it can show
 * progress and stop between files. Each file's own Channel Scaling and
 * excluded sweeps come from its sidecar; its series types are guessed as
 * on the tree badges and can be reviewed per file.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import {
  Kind, Plan, InspectorRow, Result, SPECIES, KIND_LABEL, LEVEL_STYLE, formatBytes,
  Section, Row, overlay, header, footer, intro, th, td,
} from './NwbExportDialog'

interface ScannedFile {
  path: string
  rel: string
  target: string
  sizeBytes: number
  animalId: string
  tags: string[]
  notes: string
  excludedSweeps: number
  scaled: boolean
  hasSidecar: boolean
}

interface FileRow {
  subjectId: string
  sex: string
  age: string
  genotype: string
  include: boolean
}

interface Shared {
  species: string
  ageUnit: string
  strain: string
  experimenter: string
  lab: string
  institution: string
  location: string
  experimentDescription: string
  keywords: string
}

type Status =
  | { state: 'pending' }
  | { state: 'running' }
  | { state: 'done'; result: Result }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; reason: string }

const SHARED_KEYS: (keyof Shared)[] = [
  'species', 'ageUnit', 'strain', 'experimenter', 'lab', 'institution', 'location',
]

function counts(messages: InspectorRow[]) {
  const c = { bad: 0, violation: 0, suggestion: 0 }
  for (const m of messages) {
    if (m.level === 'error' || m.level === 'critical') c.bad++
    else if (m.level === 'violation') c.violation++
    else c.suggestion++
  }
  return c
}

export function NwbFolderExportDialog({ onClose }: { onClose: () => void }) {
  const backendUrl = useAppStore((s) => s.backendUrl)

  const [folder, setFolder] = useState('')
  const [outDir, setOutDir] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [files, setFiles] = useState<ScannedFile[] | null>(null)
  const [skipped, setSkipped] = useState<{ text: number; nwb: number }>({ text: 0, nwb: 0 })
  const [rows, setRows] = useState<Record<string, FileRow>>({})
  const [shared, setShared] = useState<Shared | null>(null)
  const [leaveOutExcluded, setLeaveOutExcluded] = useState(true)
  const [kinds, setKinds] = useState<Record<string, Record<string, Kind>>>({})
  const [plans, setPlans] = useState<Record<string, Plan | 'loading' | string>>({})
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [phase, setPhase] = useState<'setup' | 'running' | 'done'>('setup')
  const [error, setError] = useState<string | null>(null)
  const [openDetail, setOpenDetail] = useState<string | null>(null)
  const stopRef = useRef(false)
  const savedRowsRef = useRef<Record<string, Partial<FileRow>>>({})

  // Remembered settings: shared fields (also used by the single-file
  // export) and the last folder with its per-file rows.
  useEffect(() => {
    ;(async () => {
      const prefs = ((await window.electronAPI?.getPreferences?.().catch(() => ({}))) ?? {}) as any
      const one = prefs.nwbExport ?? {}
      const last = prefs.nwbFolderExport ?? {}
      setShared({
        species: one.species || 'Mus musculus',
        ageUnit: one.ageUnit || 'days',
        strain: one.strain || '',
        experimenter: one.experimenter || '',
        lab: one.lab || '',
        institution: one.institution || '',
        location: one.location || '',
        experimentDescription: '',
        keywords: '',
      })
      savedRowsRef.current = last.rows ?? {}
      if (last.folder) {
        setFolder(last.folder)
        setOutDir(last.outDir || '')
        setRecursive(last.recursive ?? true)
      }
    })()
  }, [])

  // Scan whenever the source / output / subfolder choice changes.
  useEffect(() => {
    if (!folder) return
    let cancelled = false
    ;(async () => {
      setError(null)
      setFiles(null)
      try {
        const resp = await fetch(`${backendUrl}/api/nwb/scan_folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder, recursive, outDir: outDir || defaultOut(folder) }),
        })
        const body = await resp.json().catch(() => ({}))
        if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`)
        if (cancelled) return
        const list = body.files as ScannedFile[]
        setFiles(list)
        setSkipped({ text: body.skippedText ?? 0, nwb: body.skippedNwb ?? 0 })
        setRows((prev) => {
          const next: Record<string, FileRow> = {}
          for (const f of list) {
            const saved = savedRowsRef.current[f.path] ?? {}
            next[f.path] = prev[f.path] ?? {
              subjectId: f.animalId || saved.subjectId || '',
              sex: saved.sex || 'U',
              age: saved.age ?? '',
              genotype: saved.genotype || '',
              include: true,
            }
          }
          return next
        })
        setStatus({})
        setPhase('setup')
      } catch (e: any) {
        if (!cancelled) setError(`Could not read the folder: ${e?.message ?? e}`)
      }
    })()
    return () => { cancelled = true }
  }, [backendUrl, folder, recursive, outDir])

  const chooseFolder = async () => {
    const p = await window.electronAPI?.openFolderDialog?.(folder || undefined)
    if (p) setFolder(p)
  }
  const chooseOut = async () => {
    const p = await window.electronAPI?.openFolderDialog?.(outDir || defaultOut(folder) || folder || undefined)
    if (p) setOutDir(p)
  }

  const setRow = (path: string, patch: Partial<FileRow>) =>
    setRows((r) => ({ ...r, [path]: { ...r[path], ...patch } }))
  const fillAll = (key: keyof FileRow) => {
    if (!files?.length) return
    const v = rows[files[0].path]?.[key]
    setRows((r) => Object.fromEntries(Object.entries(r).map(([p, row]) => [p, { ...row, [key]: v }])))
  }

  const review = async (path: string) => {
    setReviewing(reviewing === path ? null : path)
    if (plans[path]) return
    setPlans((p) => ({ ...p, [path]: 'loading' }))
    try {
      const resp = await fetch(`${backendUrl}/api/nwb/plan_file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`)
      setPlans((p) => ({ ...p, [path]: body as Plan }))
      setKinds((k) => ({
        ...k,
        [path]: k[path] ?? Object.fromEntries((body as Plan).series.map((s) => [`${s.group}:${s.series}`, s.kind])),
      }))
    } catch (e: any) {
      setPlans((p) => ({ ...p, [path]: String(e?.message ?? e) }))
    }
  }

  const included = (files ?? []).filter((f) => rows[f.path]?.include)
  const excludedTotal = included.reduce((n, f) => n + f.excludedSweeps, 0)
  const outFolder = outDir || defaultOut(folder)
  const missing = included.filter((f) => !rows[f.path]?.subjectId).length

  const run = async () => {
    if (!shared || !files) return
    stopRef.current = false
    setPhase('running')
    setStatus(Object.fromEntries(included.map((f) => [f.path, { state: 'pending' } as Status])))
    // Remember settings before the (possibly long) run.
    const rememberRows: Record<string, Partial<FileRow>> = {}
    for (const f of files) {
      const r = rows[f.path]
      if (r) rememberRows[f.path] = { subjectId: r.subjectId, sex: r.sex, age: r.age, genotype: r.genotype }
    }
    window.electronAPI?.patchPreferences?.({
      nwbFolderExport: { folder, outDir, recursive, rows: rememberRows },
    }).catch(() => { /* ignore */ })
    const prefs = ((await window.electronAPI?.getPreferences?.().catch(() => ({}))) ?? {}) as any
    window.electronAPI?.patchPreferences?.({
      nwbExport: { ...(prefs.nwbExport ?? {}), ...Object.fromEntries(SHARED_KEYS.map((k) => [k, shared[k]])) },
    }).catch(() => { /* ignore */ })

    const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
    for (const f of included) {
      if (stopRef.current) break
      setStatus((s) => ({ ...s, [f.path]: { state: 'running' } }))
      const r = rows[f.path]
      const keywords = [...f.tags, ...shared.keywords.split(';').map((x) => x.trim()).filter(Boolean)]
      try {
        const resp = await fetch(`${backendUrl}/api/nwb/export_file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: f.path,
            target: f.target,
            meta: {
              ...shared,
              keywords: keywords.join('; '),
              experimentDescription: shared.experimentDescription || f.notes || '',
              subjectId: r.subjectId, sex: r.sex, age: r.age, genotype: r.genotype,
              sessionDescription: `${f.rel}, exported by TRACER`,
              tracerVersion: version,
            },
            kinds: kinds[f.path] ?? {},
            leaveOutExcluded,
          }),
        })
        const body = await resp.json().catch(() => ({}))
        if (resp.status === 400 && String(body.detail || '').startsWith('Nothing to write')) {
          setStatus((s) => ({ ...s, [f.path]: { state: 'skipped', reason: 'No voltage or current recordings to write' } }))
        } else if (!resp.ok) {
          setStatus((s) => ({ ...s, [f.path]: { state: 'failed', reason: body.detail || `HTTP ${resp.status}` } }))
        } else {
          setStatus((s) => ({ ...s, [f.path]: { state: 'done', result: body as Result } }))
        }
      } catch (e: any) {
        setStatus((s) => ({ ...s, [f.path]: { state: 'failed', reason: String(e?.message ?? e) } }))
      }
    }
    setPhase('done')
  }

  const summary = useMemo(() => {
    const out = { done: 0, ready: 0, needsFix: 0, skipped: 0, failed: 0, stopped: 0, bytes: 0 }
    for (const st of Object.values(status)) {
      if (st.state === 'done') {
        out.done++
        out.bytes += st.result.sizeBytes
        if (counts(st.result.messages).bad > 0 || st.result.inspectError) out.needsFix++
        else out.ready++
      } else if (st.state === 'skipped') out.skipped++
      else if (st.state === 'failed') out.failed++
      else if (st.state === 'pending') out.stopped++
    }
    return out
  }, [status])

  const progress = Object.values(status).filter((s) => s.state !== 'pending' && s.state !== 'running').length

  return (
    <div onClick={phase === 'running' ? undefined : onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panelWide }} role="dialog" aria-label="Export folder as NWB">
        <div style={header}>
          <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 600 }}>Export folder as NWB</span>
          <button className="icon-btn" onClick={onClose} disabled={phase === 'running'} title="Close">×</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '10px 16px' }}>
          {error && <div className="notice notice-error" style={{ marginBottom: 10 }}>{error}</div>}

          {phase === 'setup' && (
            <>
              <p style={intro}>
                Writes one NWB file per recording into a separate folder, ready to deposit on
                DANDI, and checks each with the NWB Inspector. Each file keeps its own Channel
                Scaling and excluded sweeps; its series types are set as on the tree badges.
              </p>

              <Section title="Folders">
                <Row label="Recordings">
                  <input type="text" readOnly value={folder} placeholder="Choose a folder…" style={{ width: 380 }} />
                  <button className="btn" style={{ marginLeft: 6 }} onClick={chooseFolder}>Choose…</button>
                </Row>
                <Row label="">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
                    Include subfolders
                  </label>
                </Row>
                <Row label="Write to" hint={!outDir && folder ? 'Created if needed' : undefined}>
                  <input type="text" readOnly value={outFolder} placeholder="Output folder" style={{ width: 380 }} />
                  <button className="btn" style={{ marginLeft: 6 }} onClick={chooseOut} disabled={!folder}>Choose…</button>
                </Row>
              </Section>

              {shared && files && (
                <>
                  <Section title="Shared by every file">
                    <Row label="Species">
                      <select
                        value={SPECIES.includes(shared.species) ? shared.species : '__other'}
                        onChange={(e) => setShared({ ...shared, species: e.target.value === '__other' ? '' : e.target.value })}
                      >
                        {SPECIES.map((s) => <option key={s} value={s}>{s}</option>)}
                        <option value="__other">Other…</option>
                      </select>
                      {!SPECIES.includes(shared.species) && (
                        <input type="text" value={shared.species} placeholder="Latin name"
                          onChange={(e) => setShared({ ...shared, species: e.target.value })} style={{ width: 180, marginLeft: 6 }} />
                      )}
                    </Row>
                    <Row label="Strain">
                      <input type="text" value={shared.strain} placeholder="e.g. C57BL/6J" onChange={(e) => setShared({ ...shared, strain: e.target.value })} style={{ width: 200 }} />
                    </Row>
                    <Row label="Experiment" hint="Else each file's notes from the Metadata window">
                      <input type="text" value={shared.experimentDescription} placeholder="What the experiment tests"
                        onChange={(e) => setShared({ ...shared, experimentDescription: e.target.value })} style={{ width: 360 }} />
                    </Row>
                    <Row label="Keywords" hint="Added to each file's tags; separate with ;">
                      <input type="text" value={shared.keywords} onChange={(e) => setShared({ ...shared, keywords: e.target.value })} style={{ width: 260 }} />
                    </Row>
                    <Row label="Brain region" hint="Allen Brain Atlas name, e.g. “Field CA1”">
                      <input type="text" value={shared.location} onChange={(e) => setShared({ ...shared, location: e.target.value })} style={{ width: 200 }} />
                    </Row>
                    <Row label="Experimenter" hint="Last, First; separate several with ;">
                      <input type="text" value={shared.experimenter} onChange={(e) => setShared({ ...shared, experimenter: e.target.value })} style={{ width: 240 }} />
                    </Row>
                    <Row label="Lab">
                      <input type="text" value={shared.lab} onChange={(e) => setShared({ ...shared, lab: e.target.value })} style={{ width: 240 }} />
                    </Row>
                    <Row label="Institution">
                      <input type="text" value={shared.institution} onChange={(e) => setShared({ ...shared, institution: e.target.value })} style={{ width: 240 }} />
                    </Row>
                  </Section>

                  <Section title={`Recordings (${files.length})`}>
                    {files.length === 0 && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                        No HEKA, ABF or other binary recordings in this folder.
                      </div>
                    )}
                    {(skipped.text > 0 || skipped.nwb > 0) && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', marginBottom: 6 }}>
                        Not included: {[
                          skipped.text > 0 && `${skipped.text} text file${skipped.text === 1 ? '' : 's'} (export those one at a time after the import wizard)`,
                          skipped.nwb > 0 && `${skipped.nwb} file${skipped.nwb === 1 ? '' : 's'} already in NWB`,
                        ].filter(Boolean).join('; ')}.
                      </div>
                    )}
                    {files.length > 0 && (
                      <table className="data-table" style={{ width: '100%' }}>
                        <thead>
                          <tr>
                            <th style={th}></th>
                            <th style={th}>Recording</th>
                            <th style={th}>Animal ID <FillBtn onClick={() => fillAll('subjectId')} /></th>
                            <th style={th}>Sex <FillBtn onClick={() => fillAll('sex')} /></th>
                            <th style={th}>
                              Age ({shared.ageUnit}) <FillBtn onClick={() => fillAll('age')} />
                              <select value={shared.ageUnit} onChange={(e) => setShared({ ...shared, ageUnit: e.target.value })}
                                style={{ marginLeft: 4, height: 20 }} title="Unit for every age">
                                <option value="days">days</option>
                                <option value="weeks">weeks</option>
                                <option value="months">months</option>
                                <option value="years">years</option>
                              </select>
                            </th>
                            <th style={th}>Genotype <FillBtn onClick={() => fillAll('genotype')} /></th>
                            <th style={th}>Types</th>
                          </tr>
                        </thead>
                        <tbody>
                          {files.map((f) => {
                            const r = rows[f.path]
                            if (!r) return null
                            const plan = plans[f.path]
                            return (
                              <React.Fragment key={f.path}>
                                <tr style={{ opacity: r.include ? 1 : 0.45 }}>
                                  <td style={td}>
                                    <input type="checkbox" checked={r.include} onChange={(e) => setRow(f.path, { include: e.target.checked })} />
                                  </td>
                                  <td style={{ ...td, fontFamily: 'var(--font-ui)' }} title={f.path}>
                                    <div>{f.rel}</div>
                                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
                                      {[formatBytes(f.sizeBytes), f.tags.slice(0, 4).join(', '),
                                        f.excludedSweeps > 0 && `${f.excludedSweeps} excluded`,
                                        f.scaled && 'scaled'].filter(Boolean).join(' · ')}
                                    </div>
                                  </td>
                                  <td style={td}>
                                    <input type="text" value={r.subjectId} onChange={(e) => setRow(f.path, { subjectId: e.target.value })} style={{ width: 110 }} />
                                  </td>
                                  <td style={td}>
                                    <select value={r.sex} onChange={(e) => setRow(f.path, { sex: e.target.value })}>
                                      <option value="M">M</option>
                                      <option value="F">F</option>
                                      <option value="U">?</option>
                                      <option value="O">Other</option>
                                    </select>
                                  </td>
                                  <td style={td}>
                                    <input type="number" min={0} value={r.age} onChange={(e) => setRow(f.path, { age: e.target.value })} style={{ width: 70 }} />
                                  </td>
                                  <td style={td}>
                                    <input type="text" value={r.genotype} onChange={(e) => setRow(f.path, { genotype: e.target.value })} style={{ width: 100 }} />
                                  </td>
                                  <td style={td}>
                                    <button className="btn btn-sm" onClick={() => review(f.path)}>
                                      {reviewing === f.path ? 'Hide' : kinds[f.path] ? 'Edited' : 'Review'}
                                    </button>
                                  </td>
                                </tr>
                                {reviewing === f.path && (
                                  <tr>
                                    <td style={td} />
                                    <td style={{ ...td, paddingBottom: 10 }} colSpan={6}>
                                      {plan === 'loading' && <span style={{ color: 'var(--text-muted)' }}>Reading…</span>}
                                      {typeof plan === 'string' && plan !== 'loading' && <span className="notice notice-error">{plan}</span>}
                                      {plan && typeof plan === 'object' && plan.series.map((s) => {
                                        const key = `${s.group}:${s.series}`
                                        return (
                                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, fontSize: 'var(--font-size-sm)' }}>
                                            <span style={{ width: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                                            <span style={{ width: 160, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                              {s.sweeps} sweeps · {s.channels.map((c) => c.units).join(', ')}
                                            </span>
                                            <select value={kinds[f.path]?.[key] ?? s.kind}
                                              onChange={(e) => setKinds((k) => ({ ...k, [f.path]: { ...k[f.path], [key]: e.target.value as Kind } }))}>
                                              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                                            </select>
                                          </div>
                                        )
                                      })}
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                    {excludedTotal > 0 && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 'var(--font-size-sm)' }}>
                        <input type="checkbox" checked={leaveOutExcluded} onChange={(e) => setLeaveOutExcluded(e.target.checked)} />
                        Leave out the {excludedTotal} sweep{excludedTotal === 1 ? '' : 's'} marked as excluded
                      </label>
                    )}
                  </Section>
                </>
              )}
              {folder && !files && !error && <div style={{ color: 'var(--text-muted)' }}>Reading the folder…</div>}
            </>
          )}

          {phase !== 'setup' && (
            <>
              <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 8 }}>
                {phase === 'running'
                  ? `Exporting ${Math.min(progress + 1, included.length)} of ${included.length}…`
                  : <>
                      <b>{summary.done}</b> written ({formatBytes(summary.bytes)}) to <span style={{ wordBreak: 'break-all' }}>{outFolder}</span>
                      {' · '}<span style={{ color: LEVEL_STYLE.suggestion.color }}>{summary.ready} ready for DANDI</span>
                      {summary.needsFix > 0 && <> · <span style={{ color: LEVEL_STYLE.critical.color }}>{summary.needsFix} need fixes</span></>}
                      {summary.skipped > 0 && <> · {summary.skipped} skipped</>}
                      {summary.failed > 0 && <> · <span style={{ color: LEVEL_STYLE.error.color }}>{summary.failed} failed</span></>}
                      {summary.stopped > 0 && <> · {summary.stopped} not exported (stopped)</>}
                    </>}
              </div>
              <div style={{ height: 4, background: 'var(--bg-surface)', borderRadius: 2, marginBottom: 10 }}>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--accent)',
                  width: `${included.length ? (100 * progress) / included.length : 0}%`, transition: 'width 0.2s' }} />
              </div>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={th}>Recording</th>
                    <th style={th}>Result</th>
                    <th style={th}>NWB Inspector</th>
                  </tr>
                </thead>
                <tbody>
                  {included.map((f) => {
                    const st = status[f.path] ?? { state: 'pending' }
                    const c = st.state === 'done' ? counts(st.result.messages) : null
                    const open = openDetail === f.path
                    return (
                      <React.Fragment key={f.path}>
                        <tr>
                          <td style={{ ...td, fontFamily: 'var(--font-ui)' }}>{f.rel}</td>
                          <td style={{ ...td, fontFamily: 'var(--font-ui)' }}>
                            {st.state === 'pending' && <span style={{ color: 'var(--text-muted)' }}>{phase === 'done' ? 'Not exported' : 'Waiting'}</span>}
                            {st.state === 'running' && <span>Writing…</span>}
                            {st.state === 'done' && <span>{formatBytes(st.result.sizeBytes)} · {st.result.seriesWritten} series</span>}
                            {st.state === 'skipped' && <span style={{ color: 'var(--text-muted)' }}>Skipped: {st.reason}</span>}
                            {st.state === 'failed' && <span style={{ color: LEVEL_STYLE.error.color }}>Failed: {st.reason}</span>}
                          </td>
                          <td style={{ ...td, fontFamily: 'var(--font-ui)' }}>
                            {st.state === 'done' && c && (
                              <button className="btn btn-sm" onClick={() => setOpenDetail(open ? null : f.path)}
                                style={{ gap: 6 }}>
                                {c.bad > 0
                                  ? <span style={{ color: LEVEL_STYLE.critical.color, fontWeight: 600 }}>{c.bad} must fix</span>
                                  : <span>Ready</span>}
                                {(c.violation > 0 || c.suggestion > 0) && (
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    {[c.violation > 0 && `${c.violation} should fix`, c.suggestion > 0 && `${c.suggestion} tips`].filter(Boolean).join(', ')}
                                  </span>
                                )}
                              </button>
                            )}
                          </td>
                        </tr>
                        {open && st.state === 'done' && (
                          <tr>
                            <td colSpan={3} style={{ ...td, fontFamily: 'var(--font-ui)' }}>
                              {st.result.notes.map((n, i) => <div key={i} className="notice notice-warning" style={{ marginBottom: 4 }}>{n}</div>)}
                              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-sm)' }}>
                                {st.result.messages.map((m, i) => (
                                  <li key={i}>
                                    <span style={{ color: LEVEL_STYLE[m.level].color }}>{m.importance}:</span> {m.message}
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div style={footer}>
          {phase === 'setup' && files && included.length > 0 && missing > 0 && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginRight: 'auto' }}>
              {missing} recording{missing === 1 ? ' has' : 's have'} no animal ID (DANDI requires one)
            </span>
          )}
          {phase === 'setup' && (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={run} disabled={!files || included.length === 0}>
                Export {included.length || ''} file{included.length === 1 ? '' : 's'}
              </button>
            </>
          )}
          {phase === 'running' && (
            <button className="btn" onClick={() => { stopRef.current = true }}>Stop after this file</button>
          )}
          {phase === 'done' && (
            <>
              <button className="btn" onClick={() => setPhase('setup')}>Back</button>
              <button className="btn" onClick={() => {
                const first = Object.entries(status).find(([, s]) => s.state === 'done')
                window.electronAPI?.showItemInFolder?.(first ? (first[1] as any).result.path : outFolder)
              }}>Show in folder</button>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FillBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn" onClick={onClick} title="Use the first row's value for every recording"
      style={{ width: 18, height: 18, fontSize: 11, verticalAlign: 'middle' }}>↓</button>
  )
}

/** "<folder> NWB" next to the source folder. */
function defaultOut(folder: string): string {
  if (!folder) return ''
  const trimmed = folder.replace(/[/\\]+$/, '')
  return `${trimmed} NWB`
}

const panelWide: React.CSSProperties = {
  width: 'min(1040px, 94vw)', maxHeight: '90vh', background: 'var(--bg-secondary)',
  color: 'var(--text-primary)', borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-popover), 0 24px 60px rgba(0,0,0,0.25)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-ui)',
}
