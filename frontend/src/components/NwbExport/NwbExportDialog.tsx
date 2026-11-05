/**
 * File ▸ Export as NWB…: writes the open recording as an NWB file
 * (backend ``/api/nwb/export``), then shows the NWB Inspector's report.
 *
 * Lab-level fields (experimenter, lab, institution, location, species)
 * and the last subject are remembered in preferences (``nwbExport``);
 * the animal ID and keywords start from the recording's tags.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../stores/appStore'

export type Kind = 'vc' | 'cc' | 'field' | 'skip'

export interface PlanSeries {
  group: number
  series: number
  groupLabel: string
  label: string
  sweeps: number
  channels: { label: string; units: string }[]
  kind: Kind
}

export interface Plan {
  fileName: string
  format: string
  series: PlanSeries[]
  recordingStart: number | null
}

export interface InspectorRow {
  level: 'error' | 'critical' | 'violation' | 'suggestion'
  importance: string
  message: string
  check: string
  object: string
}

export interface Result {
  path: string
  sizeBytes: number
  seriesWritten: number
  sweepsWritten: number
  notes: string[]
  messages: InspectorRow[]
  inspectError: string | null
}

interface Meta {
  subjectId: string
  species: string
  sex: string
  age: string
  ageUnit: string
  genotype: string
  strain: string
  subjectDescription: string
  sessionDescription: string
  sessionStart: string
  experimentDescription: string
  keywords: string
  experimenter: string
  lab: string
  institution: string
  location: string
}

/** Remembered between exports (preferences ``nwbExport``). */
const REMEMBERED: (keyof Meta)[] = [
  'experimenter', 'lab', 'institution', 'location', 'species', 'sex', 'age', 'ageUnit',
  'genotype', 'strain', 'subjectId', 'subjectDescription',
]

export const SPECIES = ['Mus musculus', 'Rattus norvegicus', 'Homo sapiens', 'Macaca mulatta']

export const KIND_LABEL: Record<Kind, string> = {
  vc: 'Voltage clamp', cc: 'Current clamp', field: 'Field / extracellular', skip: 'Skip',
}

export const LEVEL_STYLE: Record<InspectorRow['level'], { color: string; title: string }> = {
  error: { color: 'var(--danger, #c62828)', title: 'Errors' },
  critical: { color: 'var(--danger, #c62828)', title: 'Must fix before depositing on DANDI' },
  violation: { color: 'var(--warning, #b26a00)', title: 'Should fix' },
  suggestion: { color: 'var(--text-muted)', title: 'Suggestions' },
}

/** Unix seconds → value for <input type="datetime-local"> (local time). */
function toLocalInput(t: number | null): string {
  if (t == null) return ''
  const d = new Date(t * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function NwbExportDialog({ onClose }: { onClose: () => void }) {
  const backendUrl = useAppStore((s) => s.backendUrl)
  const recording = useAppStore((s) => s.recording)
  const recordingMeta = useAppStore((s) => s.recordingMeta)
  const excludedSweeps = useAppStore((s) => s.excludedSweeps)

  const [plan, setPlan] = useState<Plan | null>(null)
  const [kinds, setKinds] = useState<Record<string, Kind>>({})
  const [meta, setMeta] = useState<Meta | null>(null)
  const [leaveOutExcluded, setLeaveOutExcluded] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [openLevels, setOpenLevels] = useState<Record<string, boolean>>({ error: true, critical: true })

  // Plan + remembered fields.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/nwb/plan`)
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || `HTTP ${resp.status}`)
        const p: Plan = await resp.json()
        const prefs = (await window.electronAPI?.getPreferences?.().catch(() => ({}))) ?? {}
        const saved = ((prefs as any).nwbExport ?? {}) as Partial<Meta>
        if (cancelled) return
        const tags = new Set<string>()
        for (const t of recordingMeta?.group_tags ?? []) tags.add(t)
        for (const list of Object.values(recordingMeta?.series_tags ?? {})) for (const t of list) tags.add(t)
        setPlan(p)
        setKinds(Object.fromEntries(p.series.map((s) => [`${s.group}:${s.series}`, s.kind])))
        setMeta({
          subjectId: recordingMeta?.animal_id || saved.subjectId || '',
          species: saved.species || 'Mus musculus',
          sex: saved.sex || 'U',
          age: saved.age ?? '',
          ageUnit: saved.ageUnit || 'days',
          genotype: saved.genotype || '',
          strain: saved.strain || '',
          subjectDescription: saved.subjectDescription || '',
          sessionDescription: `${p.fileName} (${p.format} recording)`,
          sessionStart: toLocalInput(p.recordingStart),
          experimentDescription: recordingMeta?.notes || '',
          keywords: [...tags].join('; '),
          experimenter: saved.experimenter || '',
          lab: saved.lab || '',
          institution: saved.institution || '',
          location: saved.location || '',
        })
      } catch (e: any) {
        if (!cancelled) setError(`Could not prepare the export: ${e?.message ?? e}`)
      }
    })()
    return () => { cancelled = true }
  }, [backendUrl])  // eslint-disable-line react-hooks/exhaustive-deps

  const excludedCount = useMemo(() => {
    if (!plan) return 0
    let n = 0
    for (const s of plan.series) {
      const key = `${s.group}:${s.series}`
      if (kinds[key] !== 'skip') n += (excludedSweeps[key] ?? []).length
    }
    return n
  }, [plan, kinds, excludedSweeps])

  const set = (patch: Partial<Meta>) => setMeta((m) => (m ? { ...m, ...patch } : m))
  const writable = plan?.series.filter((s) => kinds[`${s.group}:${s.series}`] !== 'skip').length ?? 0
  const missingForDandi = meta
    ? [!meta.subjectId && 'animal ID', !meta.species && 'species', (!meta.sex || meta.sex === 'U') && 'sex',
       !meta.age && 'age'].filter(Boolean) as string[]
    : []

  const doExport = async () => {
    if (!meta || !plan || !recording) return
    setError(null)
    const dir = recording.filePath.replace(/[/\\][^/\\]*$/, '')
    const stem = plan.fileName.replace(/\.[^.]+$/, '')
    const sep = recording.filePath.includes('\\') ? '\\' : '/'
    const target = await window.electronAPI?.saveFileDialog?.(`${dir}${sep}${stem}.nwb`,
      [{ name: 'NWB', extensions: ['nwb'] }])
    if (!target) return
    setBusy(true)
    try {
      const sessionStart = meta.sessionStart ? new Date(meta.sessionStart).toISOString() : ''
      const resp = await fetch(`${backendUrl}/api/nwb/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: target.toLowerCase().endsWith('.nwb') ? target : `${target}.nwb`,
          meta: { ...meta, sessionStart, tracerVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '' },
          kinds,
          excluded: leaveOutExcluded ? excludedSweeps : null,
        }),
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`)
      setResult(body as Result)
      const remembered = Object.fromEntries(REMEMBERED.map((k) => [k, meta[k]]))
      window.electronAPI?.patchPreferences?.({ nwbExport: remembered }).catch(() => { /* ignore */ })
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const grouped = useMemo(() => {
    const out: Record<string, InspectorRow[]> = { error: [], critical: [], violation: [], suggestion: [] }
    for (const m of result?.messages ?? []) (out[m.level] ??= []).push(m)
    return out
  }, [result])

  return (
    <div onClick={busy ? undefined : onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={panel} role="dialog" aria-label="Export as NWB">
        <div style={header}>
          <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 600 }}>
            {result ? 'NWB file written' : 'Export as NWB'}
          </span>
          <button className="icon-btn" onClick={onClose} disabled={busy} title="Close">×</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '10px 16px' }}>
          {error && <div className="notice notice-error" style={{ marginBottom: 10 }}>{error}</div>}
          {!result && !meta && !error && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

          {/* ---------------- Form ---------------- */}
          {!result && meta && plan && (
            <>
              <p style={intro}>
                Writes this recording as a <b>Neurodata Without Borders</b> file, the format the
                DANDI archive and many journals ask for. The file keeps the recorded traces, the
                stimuli and the details below; analyses stay in TRACER.
              </p>

              <Section title="Subject">
                <Row label="Animal ID" hint="Unique within your lab; DANDI requires it">
                  <input type="text" value={meta.subjectId} onChange={(e) => set({ subjectId: e.target.value })} style={{ width: 200 }} />
                </Row>
                <Row label="Species">
                  <select
                    value={SPECIES.includes(meta.species) ? meta.species : '__other'}
                    onChange={(e) => set({ species: e.target.value === '__other' ? '' : e.target.value })}
                  >
                    {SPECIES.map((s) => <option key={s} value={s}>{s}</option>)}
                    <option value="__other">Other…</option>
                  </select>
                  {!SPECIES.includes(meta.species) && (
                    <input type="text" placeholder="Latin name, e.g. Danio rerio" value={meta.species}
                      onChange={(e) => set({ species: e.target.value })} style={{ width: 200, marginLeft: 6 }} />
                  )}
                </Row>
                <Row label="Sex">
                  <select value={meta.sex} onChange={(e) => set({ sex: e.target.value })}>
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                    <option value="U">Unknown</option>
                    <option value="O">Other</option>
                  </select>
                </Row>
                <Row label="Age" hint="At the time of recording">
                  <input type="number" min={0} value={meta.age} onChange={(e) => set({ age: e.target.value })} style={{ width: 80 }} />
                  <select value={meta.ageUnit} onChange={(e) => set({ ageUnit: e.target.value })} style={{ marginLeft: 6 }}>
                    <option value="days">days</option>
                    <option value="weeks">weeks</option>
                    <option value="months">months</option>
                    <option value="years">years</option>
                  </select>
                </Row>
                <Row label="Genotype">
                  <input type="text" value={meta.genotype} placeholder="e.g. Scn1a+/−" onChange={(e) => set({ genotype: e.target.value })} style={{ width: 200 }} />
                </Row>
                <Row label="Strain">
                  <input type="text" value={meta.strain} placeholder="e.g. C57BL/6J" onChange={(e) => set({ strain: e.target.value })} style={{ width: 200 }} />
                </Row>
                <Row label="Description">
                  <input type="text" value={meta.subjectDescription} onChange={(e) => set({ subjectDescription: e.target.value })} style={{ width: 360 }} />
                </Row>
              </Section>

              <Section title="Recording">
                <Row label="Description">
                  <input type="text" value={meta.sessionDescription} onChange={(e) => set({ sessionDescription: e.target.value })} style={{ width: 360 }} />
                </Row>
                <Row label="Started" hint={plan.recordingStart == null ? 'The file does not store this — please fill it in' : 'From the file'}>
                  <input type="datetime-local" step={1} value={meta.sessionStart}
                    onChange={(e) => set({ sessionStart: e.target.value })} style={dateInput} />
                </Row>
                <Row label="Experiment">
                  <input type="text" value={meta.experimentDescription} placeholder="What the experiment tests"
                    onChange={(e) => set({ experimentDescription: e.target.value })} style={{ width: 360 }} />
                </Row>
                <Row label="Keywords" hint="Separate with ;">
                  <input type="text" value={meta.keywords} onChange={(e) => set({ keywords: e.target.value })} style={{ width: 360 }} />
                </Row>
                <Row label="Brain region" hint="Allen Brain Atlas names pass DANDI's check, e.g. “Field CA1”">
                  <input type="text" value={meta.location} onChange={(e) => set({ location: e.target.value })} style={{ width: 200 }} />
                </Row>
                <Row label="Experimenter" hint="Last, First; separate several with ;">
                  <input type="text" value={meta.experimenter} onChange={(e) => set({ experimenter: e.target.value })} style={{ width: 240 }} />
                </Row>
                <Row label="Lab">
                  <input type="text" value={meta.lab} onChange={(e) => set({ lab: e.target.value })} style={{ width: 240 }} />
                </Row>
                <Row label="Institution">
                  <input type="text" value={meta.institution} onChange={(e) => set({ institution: e.target.value })} style={{ width: 240 }} />
                </Row>
              </Section>

              <Section title="Series">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Check the recording type of each series; it decides how NWB stores it.
                  </span>
                  <span style={{ flex: 1 }} />
                  <select value="" onChange={(e) => {
                    const k = e.target.value as Kind
                    if (k) setKinds(Object.fromEntries(Object.keys(kinds).map((key) => [key, k])))
                  }}>
                    <option value="">Set all to…</option>
                    {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                </div>
                <table className="data-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={th}>Series</th>
                      <th style={th}>Sweeps</th>
                      <th style={th}>Channels</th>
                      <th style={th}>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.series.map((s) => {
                      const key = `${s.group}:${s.series}`
                      const multiGroup = new Set(plan.series.map((x) => x.group)).size > 1
                      return (
                        <tr key={key} style={{ opacity: kinds[key] === 'skip' ? 0.5 : 1 }}>
                          <td style={td}>{multiGroup ? `${s.groupLabel} · ` : ''}{s.label}</td>
                          <td style={{ ...td, color: 'var(--text-muted)' }}>{s.sweeps}</td>
                          <td style={{ ...td, color: 'var(--text-muted)' }}>
                            {s.channels.map((c) => c.label || c.units).join(', ')}
                          </td>
                          <td style={td}>
                            <select value={kinds[key]} onChange={(e) => setKinds({ ...kinds, [key]: e.target.value as Kind })}>
                              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                            </select>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {excludedCount > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 'var(--font-size-sm)' }}>
                    <input type="checkbox" checked={leaveOutExcluded} onChange={(e) => setLeaveOutExcluded(e.target.checked)} />
                    Leave out the {excludedCount} sweep{excludedCount === 1 ? '' : 's'} marked as excluded
                  </label>
                )}
              </Section>
            </>
          )}

          {/* ---------------- Result ---------------- */}
          {result && (
            <>
              <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 10 }}>
                <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{result.path}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                  {formatBytes(result.sizeBytes)} · {result.seriesWritten} series · {result.sweepsWritten} sweeps
                </div>
              </div>
              {result.notes.map((n, i) => (
                <div key={i} className="notice notice-warning" style={{ marginBottom: 6 }}>{n}</div>
              ))}
              <div style={{ fontWeight: 600, margin: '12px 0 6px', fontSize: 'var(--font-size-sm)' }}>
                NWB Inspector
              </div>
              {result.inspectError && <div className="notice notice-error">{result.inspectError}</div>}
              {!result.inspectError && result.messages.length === 0 && (
                <div className="notice notice-info">No issues found. The file follows NWB best practices.</div>
              )}
              {!result.inspectError && result.messages.length > 0 && grouped.error.length + grouped.critical.length === 0 && (
                <div className="notice notice-info" style={{ marginBottom: 8 }}>
                  No errors or critical issues: the file is valid NWB and ready for DANDI. The notes below are best-practice advice.
                </div>
              )}
              {(['error', 'critical', 'violation', 'suggestion'] as const).map((level) => {
                const rows = grouped[level]
                if (!rows?.length) return null
                const open = !!openLevels[level]
                return (
                  <div key={level} style={{ marginBottom: 6 }}>
                    <button
                      className="btn"
                      style={{ width: '100%', justifyContent: 'flex-start', gap: 6 }}
                      onClick={() => setOpenLevels({ ...openLevels, [level]: !open })}
                    >
                      <span style={{ color: LEVEL_STYLE[level].color, fontWeight: 600 }}>
                        {open ? '▾' : '▸'} {LEVEL_STYLE[level].title}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>({rows.length})</span>
                    </button>
                    {open && (
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 'var(--font-size-sm)' }}>
                        {rows.map((m, i) => (
                          <li key={i} style={{ marginBottom: 3 }}>
                            {m.message}
                            {m.object && <span style={{ color: 'var(--text-muted)' }}> · {m.object}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div style={footer}>
          {!result && missingForDandi.length > 0 && meta && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginRight: 'auto' }}>
              DANDI also needs: {missingForDandi.join(', ')}
            </span>
          )}
          {result ? (
            <>
              <button className="btn" onClick={() => window.electronAPI?.showItemInFolder?.(result.path)}>
                Show in folder
              </button>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" onClick={doExport} disabled={busy || !meta || writable === 0}>
                {busy ? 'Writing…' : 'Export…'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 'var(--font-size-sm)' }}>
      <span style={{ width: 110, flexShrink: 0, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center' }}>{children}</span>
      {hint && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>{hint}</span>}
    </div>
  )
}

export const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.18)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
export const panel: React.CSSProperties = {
  width: 'min(760px, 92vw)', maxHeight: '88vh', background: 'var(--bg-secondary)',
  color: 'var(--text-primary)', borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-popover), 0 24px 60px rgba(0,0,0,0.25)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-ui)',
}
export const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 12px 10px 16px', borderBottom: '1px solid var(--border)',
}
export const footer: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
  padding: '10px 12px', borderTop: '1px solid var(--border)',
}
export const intro: React.CSSProperties = {
  margin: '0 0 12px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.45,
}
const dateInput: React.CSSProperties = {
  height: 24, padding: '0 6px', background: 'var(--bg-field)', border: '1px solid var(--border-control)',
  borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)',
  fontSize: 'var(--font-size-sm)',
}
export const th: React.CSSProperties = { padding: '5px 8px', textAlign: 'left' }
export const td: React.CSSProperties = { padding: '4px 8px', verticalAlign: 'middle' }
