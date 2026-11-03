import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import { usePlotMenu } from '../common/PlotMenu'
import { useThemeKey } from '../../stores/themeStore'
import type { AsterismTable } from '../../utils/plotExport'

/**
 * Cohort ▸ Quality: judge cells from the Resistance (Rs, Rin, Cm,
 * holding) and Cursor (Vm) results users already ran on tagged series.
 *
 * The user lists conditions (two by default, "Add another"), each
 * picking the series tag its measurements come from. Rules, conditions
 * and overrides are saved to ``tracer_qc.json`` in the folder as soon
 * as they change; QC never writes the recordings' own result files.
 * Verdicts come from the backend (analysis/qc.py) every time. See
 * docs/QC_PLAN.md.
 */

type Level = 'pass' | 'warn' | 'fail'
interface Threshold { op: string; value: number }
interface QcRule {
  metric: string
  enabled: boolean
  required?: boolean
  warn: Threshold | null
  fail: Threshold | null
}
/** ``tags``: the series tags measurements come from — several when cells
 *  differ (Rs in the data sweeps in some, a test-pulse series in others). */
interface QcCondition { name: string; tags: string[]; applies_to?: string[] }
interface QcOverride { verdict: Level; reason: string; date: string }
interface QcConfig {
  format?: string
  version?: number
  conditions: QcCondition[]
  reference: number
  cell_rule: 'exclude-condition' | 'exclude-cell'
  rules: QcRule[]
  missing: Level | 'ignore'
  overrides: Record<string, { cell?: QcOverride; conditions?: Record<string, QcOverride> }>
}
interface QcMetric { label: string; unit: string; source: string; kind: 'value' | 'change'; of?: string }
interface QcTag { tag: string; n_resistance: number; n_cursor: number }
interface QcCheck { metric: string; value: number | null; level: Level | null; text: string; missing?: boolean }
interface QcCondResult {
  name: string
  tag: string
  series: string[]
  recorded: boolean
  values: Record<string, number | null>
  changes: Record<string, number | null>
  checks: QcCheck[]
  status: 'judged' | 'not recorded'
  verdict: Level | null
  auto_verdict?: Level | null
  override?: QcOverride
}
interface QcCell {
  file_name: string
  file_path: string
  cell_id?: string | null
  conditions: QcCondResult[]
  verdict: Level | null
  auto_verdict: Level | null
  override: QcOverride | null
  reasons: string[]
}
interface QcResult {
  cells: QcCell[]
  unmatched: { file_name: string }[]
  missing: { condition: string; tag: string; analysis: string; files: string[] }[]
  summary: Record<string, number>
}

/** Table / rules order, and decimals shown per measure. */
const METRIC_ORDER = ['rs_mohm', 'rs_change_pct', 'rin_mohm', 'cm_pf',
  'holding_pa', 'holding_change_pa', 'vm_mv', 'vm_change_mv']
const DECIMALS: Record<string, number> = {
  rs_mohm: 1, rs_change_pct: 0, rin_mohm: 0, cm_pf: 1,
  holding_pa: 0, holding_change_pa: 0, vm_mv: 1, vm_change_mv: 1,
}

const LEVEL_COLOR: Record<Level, string> = {
  pass: 'var(--success)', warn: 'var(--warning)', fail: 'var(--error)',
}
const LEVEL_LABEL: Record<Level, string> = { pass: 'Pass', warn: 'Warn', fail: 'Fail' }

function VerdictBadge({ level, overridden }: { level: Level | null; overridden?: boolean }) {
  if (!level) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return (
    <span title={overridden ? 'Set by hand' : undefined} style={{
      display: 'inline-block', padding: '0 6px', borderRadius: 4,
      border: `1px solid ${LEVEL_COLOR[level]}`, color: LEVEL_COLOR[level],
      fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
    }}>{LEVEL_LABEL[level]}{overridden ? ' ✎' : ''}</span>
  )
}

const fmt = (v: number | null | undefined, d = 1) => {
  if (v == null || !Number.isFinite(v)) return '—'
  const t = v.toFixed(d)
  return /^-0(\.0+)?$/.test(t) ? t.slice(1) : t   // no "−0"
}
const fmtSigned = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`

async function post<T>(backendUrl: string, path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${backendUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!resp.ok) {
    let detail = resp.statusText
    try { detail = (await resp.json()).detail ?? detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  return resp.json()
}

export function CohortQuality({ backendUrl, folder }: { backendUrl: string; folder: string | null }) {
  const [config, setConfig] = useState<QcConfig | null>(null)
  const [metrics, setMetrics] = useState<Record<string, QcMetric>>({})
  const [tags, setTags] = useState<QcTag[]>([])
  const [savedFile, setSavedFile] = useState(false)
  const [result, setResult] = useState<QcResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [overrideFor, setOverrideFor] = useState<string | null>(null)
  // True once the user changed something: only then is the rules file written.
  const editedRef = useRef(false)

  // ---- Load the folder's rules + the tags that carry results ----
  const reload = useCallback(async () => {
    if (!folder) return
    setError(null)
    try {
      const [cfg, tg] = await Promise.all([
        post<{ config: QcConfig; exists: boolean; metrics: Record<string, QcMetric> }>(
          backendUrl, '/api/qc/config', { folder }),
        post<{ tags: QcTag[] }>(backendUrl, '/api/qc/tags', { folder }),
      ])
      editedRef.current = false
      setConfig({
        ...cfg.config,
        conditions: cfg.config.conditions.map((c: QcCondition & { tag?: string }) => ({
          ...c, tags: Array.isArray(c.tags) ? c.tags : (c.tag ? [c.tag] : []),
        })),
      })
      setMetrics(cfg.metrics)
      setSavedFile(cfg.exists)
      setTags(tg.tags)
    } catch (e: any) { setError(e.message) }
  }, [backendUrl, folder])
  useEffect(() => { void reload() }, [reload])

  // ---- Evaluate whenever the config changes (debounced) ----
  useEffect(() => {
    if (!folder || !config) return
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        setResult(await post<QcResult>(backendUrl, '/api/qc/evaluate', { folder, config }))
        setError(null)
      } catch (e: any) { setError(e.message) }
      setBusy(false)
    }, 250)
    return () => clearTimeout(t)
  }, [backendUrl, folder, config])

  // ---- Save the rules file after the user's edits (debounced) ----
  useEffect(() => {
    if (!folder || !config || !editedRef.current) return
    const t = setTimeout(async () => {
      try {
        await post(backendUrl, '/api/qc/save', { folder, config })
        setSavedFile(true)
      } catch (e: any) { setError(e.message) }
    }, 700)
    return () => clearTimeout(t)
  }, [backendUrl, folder, config])

  const edit = useCallback((fn: (c: QcConfig) => QcConfig) => {
    editedRef.current = true
    setConfig((c) => (c ? fn(c) : c))
  }, [])

  // ---- Conditions ----
  const setCondition = (i: number, patch: Partial<QcCondition>) => edit((c) => ({
    ...c, conditions: c.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)),
  }))
  const addCondition = () => edit((c) => ({
    ...c, conditions: [...c.conditions, { name: `Condition ${c.conditions.length + 1}`, tags: [], applies_to: [] }],
  }))
  const removeCondition = (i: number) => edit((c) => {
    const conditions = c.conditions.filter((_, j) => j !== i)
    let reference = c.reference
    if (i === reference) reference = 0
    else if (i < reference) reference -= 1
    return { ...c, conditions, reference }
  })

  // ---- Rules: one row per metric; absent rules are shown switched off ----
  const ruleFor = (metric: string): QcRule =>
    config?.rules.find((r) => r.metric === metric)
    ?? { metric, enabled: false, required: metric.startsWith('rs_'), warn: null, fail: null }
  const setRule = (metric: string, patch: Partial<QcRule>) => edit((c) => {
    const existing = c.rules.find((r) => r.metric === metric)
    const next = { ...(existing ?? ruleFor(metric)), ...patch }
    return {
      ...c,
      rules: existing ? c.rules.map((r) => (r.metric === metric ? next : r)) : [...c.rules, next],
    }
  })

  const tagOptions = useMemo(() => tags.map((t) => {
    const parts = []
    if (t.n_resistance) parts.push(`Rs ${t.n_resistance}`)
    if (t.n_cursor) parts.push(`Vm ${t.n_cursor}`)
    return { value: t.tag, label: `${t.tag} — ${parts.join(', ')} cell${(t.n_resistance || t.n_cursor) === 1 ? '' : 's'}` }
  }), [tags])

  // ---- Table rows ----
  const cells = useMemo(() => {
    const all = result?.cells ?? []
    return problemsOnly ? all.filter((c) => c.verdict === 'warn' || c.verdict === 'fail') : all
  }, [result, problemsOnly])
  const conds = config?.conditions ?? []
  const sel = useRowSelection(cells.length)

  // Columns follow the rules: Rs always, plus every measure whose rule is on.
  const shownMetrics = useMemo(() => METRIC_ORDER.filter((m) =>
    metrics[m] && (m === 'rs_mohm' || config?.rules.some((r) => r.metric === m && r.enabled))),
  [metrics, config])
  const valueOf = (c: QcCondResult, m: string) =>
    (metrics[m]?.kind === 'change' ? c.changes[m] : c.values[m]) ?? null
  // A missing measurement is shown in grey: the row's badge and reason say it.
  const levelOf = (c: QcCondResult, m: string) => {
    const k = c.checks.find((x) => x.metric === m)
    return k && !k.missing ? k.level : null
  }
  /** Reasons for one condition row: failed / warned checks, or the override. */
  const conditionReasons = (c: QcCondResult): string[] => {
    if (c.override) return [`Set to ${c.verdict} by hand — ${c.override.reason}`]
    return c.checks.filter((k) => (k.level === 'warn' || k.level === 'fail') && k.text).map((k) => k.text)
  }
  const measureHeader = (m: string) => {
    const info = metrics[m]
    if (!info) return m
    const label = info.kind === 'change' ? `Δ${info.label.replace(/ change$/, '')}` : info.label
    return `${label} (${info.unit})`
  }

  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => {
      if (sel.selectedIndexes.length === 0) return null
      const header = ['File', 'Cell ID', 'Cell verdict', 'Condition', 'Condition verdict',
        ...shownMetrics.map(measureHeader), 'Reasons']
      const rows: (string | number | null)[][] = []
      for (const i of sel.selectedIndexes) {
        const cell = cells[i]
        for (const c of cell.conditions) {
          rows.push([cell.file_name, cell.cell_id ?? '', cell.verdict ?? '', c.name,
            c.recorded ? (c.verdict ?? '') : 'not recorded',
            ...shownMetrics.map((m) => {
              const v = valueOf(c, m)
              return v == null ? null : Number(v.toFixed((DECIMALS[m] ?? 1) + 2))
            }),
            conditionReasons(c).join('; ')])
        }
      }
      return buildTSV(header, rows)
    },
  })

  // ---- Overrides ----
  const setOverride = (file: string, scope: string, verdict: Level | 'auto', reason: string) => edit((c) => {
    const overrides = { ...c.overrides }
    const entry = { ...(overrides[file] ?? {}) }
    const value = verdict === 'auto' ? undefined
      : { verdict, reason: reason.trim(), date: new Date().toISOString().slice(0, 10) }
    if (scope === '__cell__') {
      if (value) entry.cell = value; else delete entry.cell
    } else {
      const cs = { ...(entry.conditions ?? {}) }
      if (value) cs[scope] = value; else delete cs[scope]
      entry.conditions = cs
      if (Object.keys(cs).length === 0) delete entry.conditions
    }
    if (entry.cell || entry.conditions) overrides[file] = entry
    else delete overrides[file]
    return { ...c, overrides }
  })

  if (!folder) {
    return <div style={{ padding: 14, color: 'var(--text-muted)' }}>Pick a folder to check the quality of its recordings.</div>
  }
  if (!config) {
    return <div style={{ padding: 14 }}>{error ? <div className="notice notice-error">{error}</div> : 'Loading…'}</div>
  }

  const metricOrder = METRIC_ORDER.filter((m) => metrics[m])
  const summary = result?.summary

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* ---- Left: conditions and rules ---- */}
      <div style={{
        width: 420, flexShrink: 0, overflow: 'auto', padding: 12,
        borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div className="section-card">
          <div className="section-card-title">Conditions</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
            In order. Each takes its Rs and holding (Resistance) and Vm (Cursor) from the series with
            its tag. Changes are measured against the reference.
          </div>
          {tags.length === 0 && (
            <div className="notice notice-warning" style={{ marginBottom: 8 }}>
              No tagged series in this folder have Resistance or Cursor results yet. Run them on the
              tagged series (Batch can do the whole folder).
            </div>
          )}
          {conds.map((c, i) => (
            <div key={i} style={{
              border: '1px solid var(--border)', borderRadius: 6, padding: 8, marginBottom: 8,
              background: 'var(--bg-primary)',
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <input
                  value={c.name}
                  onChange={(e) => setCondition(i, { name: e.target.value })}
                  placeholder={c.tags.join(' / ') || 'Name'}
                  style={{ flex: 1, fontWeight: 600 }}
                />
                <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 'var(--font-size-xs)' }}
                  title="Changes in the other conditions are measured against this one">
                  <input type="radio" checked={config.reference === i}
                    onChange={() => edit((cc) => ({ ...cc, reference: i }))} />
                  Reference
                </label>
                <button className="icon-btn" title="Remove this condition"
                  disabled={conds.length <= 1} onClick={() => removeCondition(i)}>×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 6, alignItems: 'center',
                fontSize: 'var(--font-size-sm)' }}>
                <span style={{ alignSelf: 'start', paddingTop: 3 }}>Measured in</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                  {c.tags.map((t) => {
                    const known = tags.find((x) => x.tag === t)
                    return (
                      <span key={t} title={known ? undefined : 'No results under this tag in this folder'} style={{
                        display: 'inline-flex', gap: 4, alignItems: 'center', padding: '0 4px 0 6px',
                        border: '1px solid var(--border-control)', borderRadius: 4,
                        color: known ? undefined : 'var(--text-muted)',
                      }}>
                        {t}
                        <button className="icon-btn" style={{ padding: 0, minWidth: 0 }} title={`Remove ${t}`}
                          onClick={() => {
                            const next = c.tags.filter((x) => x !== t)
                            const unnamed = c.name === c.tags.join(' / ')
                            setCondition(i, unnamed ? { tags: next, name: next.join(' / ') || `Condition ${i + 1}` } : { tags: next })
                          }}>×</button>
                      </span>
                    )
                  })}
                  <select value="" style={{ flex: 1, minWidth: 110 }}
                    title="Add another tag when cells differ: e.g. Rs in the drug sweeps in some cells, in a separate test-pulse series in others"
                    onChange={(e) => {
                      const tag = e.target.value
                      if (!tag || c.tags.includes(tag)) return
                      const next = [...c.tags, tag]
                      const unnamed = !c.name.trim() || /^Condition \d+$/.test(c.name) || c.name === c.tags.join(' / ')
                      setCondition(i, unnamed ? { tags: next, name: next.join(' / ') } : { tags: next })
                    }}>
                    <option value="">{c.tags.length ? 'Add a tag…' : 'Choose a tag…'}</option>
                    {tagOptions.filter((o) => !c.tags.includes(o.value)).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <span title="The data series this condition judges, for Cohort's Include switch">Judges</span>
                <select
                  value={c.applies_to?.[0] ?? ''}
                  onChange={(e) => setCondition(i, { applies_to: e.target.value ? [e.target.value] : [] })}
                  title="Usually the same series. Pick another tag when Rs is measured in a separate test-pulse series."
                >
                  <option value="">The same series</option>
                  {tags.filter((t) => !c.tags.includes(t.tag)).map((t) => (
                    <option key={t.tag} value={t.tag}>Series tagged {t.tag}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
          <button className="btn btn-sm" onClick={addCondition}>Add another</button>
        </div>

        <div className="section-card">
          <div className="section-card-title">Rules</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
            Leave a level empty to skip it. Changes are judged on their size, in either direction.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
                <th></th><th style={{ textAlign: 'left' }}>Measure</th><th>Warn if</th><th>Fail if</th>
              </tr>
            </thead>
            <tbody>
              {metricOrder.map((m) => {
                const r = ruleFor(m)
                const info = metrics[m]
                const label = info.kind === 'change' ? `|${info.label}|` : info.label
                const level = (lv: 'warn' | 'fail') => {
                  const t = r[lv]
                  return (
                    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                      <select value={t?.op ?? '>'} disabled={!r.enabled} style={{ width: 36, padding: '0 2px' }}
                        onChange={(e) => setRule(m, { [lv]: { op: e.target.value, value: t?.value ?? 0 } })}>
                        <option value=">">&gt;</option>
                        <option value="<">&lt;</option>
                      </select>
                      <input type="number" className="num" disabled={!r.enabled} style={{ width: 60 }}
                        value={t?.value ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setRule(m, { [lv]: v === '' ? null : { op: t?.op ?? '>', value: Number(v) } })
                        }} />
                    </span>
                  )
                }
                return (
                  <tr key={m}>
                    <td><input type="checkbox" checked={r.enabled}
                      onChange={(e) => setRule(m, { enabled: e.target.checked })} /></td>
                    <td style={{ color: r.enabled ? undefined : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {label} <span style={{ color: 'var(--text-muted)' }}>({info.unit})</span>
                    </td>
                    <td style={{ textAlign: 'center' }}>{level('warn')}</td>
                    <td style={{ textAlign: 'center' }}>{level('fail')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, alignItems: 'center',
            marginTop: 10, fontSize: 'var(--font-size-sm)' }}>
            <span title="A condition whose tagged series has no Resistance (or Cursor) result">
              Measurement missing
            </span>
            <select value={config.missing} onChange={(e) => edit((c) => ({ ...c, missing: e.target.value as QcConfig['missing'] }))}>
              <option value="warn">Warn</option>
              <option value="fail">Fail</option>
              <option value="ignore">Ignore</option>
            </select>
            <span>When a condition fails</span>
            <select value={config.cell_rule}
              onChange={(e) => edit((c) => ({ ...c, cell_rule: e.target.value as QcConfig['cell_rule'] }))}>
              <option value="exclude-condition">Exclude that condition</option>
              <option value="exclude-cell">Exclude the whole cell</option>
            </select>
          </div>
        </div>

        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          {savedFile
            ? 'Saved in this folder as tracer_qc.json — everyone analysing it uses the same rules.'
            : 'Defaults — saved to tracer_qc.json in this folder as soon as you change something.'}
        </div>
      </div>

      {/* ---- Right: results ---- */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <div className="notice notice-error">{error}</div>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {summary && (['pass', 'warn', 'fail'] as Level[]).map((lv) => (
            <span key={lv} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <VerdictBadge level={lv} /> <span className="num">{summary[lv] ?? 0}</span>
            </span>
          ))}
          {summary && (
            <span style={{ color: 'var(--text-muted)' }}>
              {summary.judged} cell{summary.judged === 1 ? '' : 's'} checked
              {summary.not_checked ? `, ${summary.not_checked} not matching any condition` : ''}
            </span>
          )}
          {busy && <span style={{ color: 'var(--text-muted)' }}>Updating…</span>}
          <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
            Warn and fail only
          </label>
          <button className="btn btn-sm" onClick={() => void reload()}
            title="Read the folder again (after running Resistance or Batch)">Refresh</button>
        </div>

        {cells.length > 0 && (
          <QcPlot
            cells={cells}
            conditions={conds}
            reference={config.reference}
            metrics={metrics}
            rules={config.rules}
            choices={shownMetrics}
          />
        )}

        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>File</th>
              <th>Verdict</th>
              <th>Condition</th>
              {shownMetrics.map((m) => <th key={m} style={{ textAlign: 'right' }}>{measureHeader(m)}</th>)}
              <th>Reasons</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {cells.map((cell, i) => {
              const n = cell.conditions.length
              const selected = sel.isSelected(i)
              const rowProps = {
                onClick: (ev: React.MouseEvent) => sel.onRowClick(i, ev),
                onContextMenu: (ev: React.MouseEvent) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                }),
              }
              return (
                <React.Fragment key={cell.file_path}>
                  {cell.conditions.map((c, j) => (
                    <tr key={j} {...rowProps} style={{
                      background: selected ? 'var(--bg-active)' : undefined, cursor: 'default',
                      borderTop: j === 0 ? '2px solid var(--border)' : undefined,
                    }}>
                      {j === 0 && (
                        <>
                          <td rowSpan={n} title={cell.file_path} style={{ verticalAlign: 'top' }}>
                            {cell.file_name}
                            {cell.cell_id ? <div style={{ color: 'var(--text-muted)' }}>{cell.cell_id}</div> : null}
                          </td>
                          <td rowSpan={n} style={{ verticalAlign: 'top' }}>
                            <VerdictBadge level={cell.verdict} overridden={!!cell.override} />
                          </td>
                        </>
                      )}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          {c.name}{config.reference === j ? <span style={{ color: 'var(--text-muted)' }}>(ref.)</span> : null}
                          {c.recorded && c.verdict !== 'pass' && <VerdictBadge level={c.verdict} overridden={!!c.override} />}
                          {c.recorded && c.verdict === 'pass' && c.override && <VerdictBadge level="pass" overridden />}
                        </span>
                      </td>
                      {!c.recorded ? (
                        <td colSpan={shownMetrics.length} style={{ color: 'var(--text-muted)' }}>not recorded</td>
                      ) : shownMetrics.map((m) => {
                        const v = valueOf(c, m)
                        const lv = levelOf(c, m)
                        const isChange = metrics[m]?.kind === 'change'
                        const text = v == null ? '—'
                          : isChange ? fmtSigned(v, DECIMALS[m] ?? 1) : fmt(v, DECIMALS[m] ?? 1)
                        return (
                          <td key={m} className="num" style={{
                            textAlign: 'right',
                            color: lv === 'fail' || lv === 'warn' ? LEVEL_COLOR[lv] : (v == null ? 'var(--text-muted)' : undefined),
                            fontWeight: lv === 'fail' || lv === 'warn' ? 600 : undefined,
                          }} title={c.checks.find((k) => k.metric === m)?.text || undefined}>{text}</td>
                        )
                      })}
                      <td style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', whiteSpace: 'normal', maxWidth: 360 }}>
                        {j === 0 && cell.override && (
                          <div>Cell set to {cell.verdict} by hand — {cell.override.reason}</div>
                        )}
                        {conditionReasons(c).map((r, k) => <div key={k}>{r}</div>)}
                      </td>
                      {j === 0 && (
                        <td rowSpan={n} style={{ verticalAlign: 'top' }}>
                          <button className="btn btn-sm" onClick={(e) => {
                            e.stopPropagation()
                            setOverrideFor(overrideFor === cell.file_name ? null : cell.file_name)
                          }}>Override…</button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {overrideFor === cell.file_name && (
                    <tr>
                      <td colSpan={shownMetrics.length + 5} style={{ background: 'var(--bg-secondary)' }}>
                        <OverrideEditor
                          cell={cell}
                          onApply={(scope, verdict, reason) => {
                            setOverride(cell.file_name, scope, verdict, reason)
                            setOverrideFor(null)
                          }}
                          onCancel={() => setOverrideFor(null)}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
            {cells.length === 0 && (
              <tr><td colSpan={shownMetrics.length + 5} style={{ color: 'var(--text-muted)' }}>
                {result && result.cells.length > 0
                  ? 'No cells with a warning or failure.'
                  : 'No cells yet: choose a tag for each condition.'}
              </td></tr>
            )}
          </tbody>
        </table>
        {copyMenu.menu}

        {(result?.missing.length ?? 0) > 0 && (
          <div className="section-card">
            <div className="section-card-title">Missing measurements</div>
            {result!.missing.map((m, k) => (
              <div key={k} style={{ marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                <b>{m.condition}</b>: {m.files.length} cell{m.files.length === 1 ? '' : 's'} with series
                tagged <code>{m.tag}</code> but no {m.analysis} result — run {m.analysis} on them
                {m.analysis === 'Resistance' ? ' (Batch can do the whole folder)' : ''}.
                <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>{m.files.join(', ')}</div>
              </div>
            ))}
          </div>
        )}

        {(result?.unmatched.length ?? 0) > 0 && (
          <div className="section-card">
            <div className="section-card-title">Not checked</div>
            <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
              No series in these recordings has a condition's tag, so QC doesn't judge them; Cohort
              still includes them.
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
              {result!.unmatched.map((u) => u.file_name).join(', ')}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function OverrideEditor({ cell, onApply, onCancel }: {
  cell: QcCell
  onApply: (scope: string, verdict: Level | 'auto', reason: string) => void
  onCancel: () => void
}) {
  const [scope, setScope] = useState('__cell__')
  const current = scope === '__cell__'
    ? cell.override
    : cell.conditions.find((c) => c.name === scope)?.override
  const [verdict, setVerdict] = useState<Level | 'auto'>(current?.verdict ?? 'pass')
  const [reason, setReason] = useState(current?.reason ?? '')
  useEffect(() => {
    setVerdict(current?.verdict ?? 'pass')
    setReason(current?.reason ?? '')
  }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps
  const needsReason = verdict !== 'auto' && reason.trim() === ''
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: 4 }}>
      <span style={{ fontWeight: 600 }}>Override</span>
      <select value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="__cell__">Whole cell</option>
        {cell.conditions.filter((c) => c.recorded).map((c) => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </select>
      <select value={verdict} onChange={(e) => setVerdict(e.target.value as Level | 'auto')}>
        <option value="pass">Pass</option>
        <option value="warn">Warn</option>
        <option value="fail">Fail</option>
        <option value="auto">Automatic (remove override)</option>
      </select>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        style={{ flex: 1, minWidth: 220 }}
        disabled={verdict === 'auto'}
      />
      <button className="btn btn-sm btn-primary" disabled={needsReason}
        onClick={() => onApply(scope, verdict, reason)}>Apply</button>
      <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Plot: one measure across the conditions, one line per cell
// ---------------------------------------------------------------------------

interface PlotColors {
  bg: string; text: string; muted: string; grid: string
  pass: string; warn: string; fail: string; none: string
}

/** Print colours for exported figures (exports are never themed). */
const EXPORT_COLORS: PlotColors = {
  bg: '#ffffff', text: '#222222', muted: '#666666', grid: '#dddddd',
  pass: '#3d7f5c', warn: '#c98a14', fail: '#c0392b', none: '#888888',
}

function themeColors(): PlotColors {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f
  return {
    bg: 'none', text: v('--text-primary', '#222'), muted: v('--text-muted', '#777'),
    grid: v('--border', '#ddd'), pass: v('--success', '#3d7f5c'), warn: v('--warning', '#c98a14'),
    fail: v('--error', '#c0392b'), none: v('--text-muted', '#888'),
  }
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) { hi = lo + 1 }
  const raw = (hi - lo) / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? raw
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)))
  return out
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function buildPlotSvg(args: {
  cells: QcCell[]; metric: string; info: QcMetric; rule: QcRule | null; reference: number
  conditionNames: string[]; colors: PlotColors; width: number; height: number
  allMetrics: Record<string, QcMetric>
}): string {
  const { cells, metric, info, rule, conditionNames, colors: C, width: W, height: H } = args
  const isChange = info.kind === 'change'
  // Changes start at 0 at the reference, so every line is anchored there.
  const val = (c: QcCondResult, i: number) => {
    if (isChange && i === args.reference && c.recorded && c.values[info.of ?? ''] != null) return 0
    return (isChange ? c.changes[metric] : c.values[metric]) ?? null
  }
  // A line is coloured by the checks on the quantity it shows (the value
  // and its change), not by the cell's overall verdict.
  const family = new Set([metric, info.of ?? '', ...Object.entries(args.allMetrics)
    .filter(([, m]) => m.of === metric).map(([k]) => k)].filter(Boolean))
  const levelFor = (cell: QcCell): Level | null => {
    let worst: Level | null = null
    for (const c of cell.conditions) for (const k of c.checks) {
      if (!family.has(k.metric) || k.missing || !k.level) continue
      if (!worst || (k.level === 'fail') || (k.level === 'warn' && worst === 'pass')) worst = k.level
    }
    return worst
  }
  const pts: number[] = []
  for (const cell of cells) cell.conditions.forEach((c, i) => { const v = val(c, i); if (v != null) pts.push(v) })
  const thresholds: { y: number; level: 'warn' | 'fail' }[] = []
  if (rule?.enabled) {
    for (const lv of ['warn', 'fail'] as const) {
      const t = rule[lv]
      if (t && Number.isFinite(t.value)) {
        thresholds.push({ y: t.value, level: lv })
        if (isChange) thresholds.push({ y: -t.value, level: lv })   // changes are judged on their size
      }
    }
  }
  const all = [...pts, ...thresholds.map((t) => t.y)]
  let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1
  if (isChange) { lo = Math.min(lo, 0); hi = Math.max(hi, 0) }
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08
  lo -= pad; hi += pad
  const ticks = niceTicks(lo, hi)
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1])

  const L = 62, R = 16, T = 14, B = 40
  const n = conditionNames.length
  const x = (i: number) => L + (n <= 1 ? (W - L - R) / 2 : ((W - L - R) * (i + 0.5)) / n)
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo))
  const font = `font-family="-apple-system, Helvetica, Arial, sans-serif"`
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${font}>`)
  parts.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`)
  for (const t of ticks) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${C.grid}" stroke-width="1"/>`)
    parts.push(`<text x="${L - 6}" y="${y(t) + 4}" font-size="11" text-anchor="end" fill="${C.muted}">${t}</text>`)
  }
  if (isChange) parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${C.muted}" stroke-width="1"/>`)
  for (const t of thresholds) {
    const col = t.level === 'fail' ? C.fail : C.warn
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(t.y)}" y2="${y(t.y)}" stroke="${col}" stroke-width="1.2" stroke-dasharray="5 4"/>`)
  }
  conditionNames.forEach((name, i) => {
    const label = esc(name) + (i === args.reference ? ' (ref.)' : '')
    parts.push(`<text x="${x(i)}" y="${H - B + 18}" font-size="12" text-anchor="middle" fill="${C.text}">${label}</text>`)
  })
  const yLabel = `${isChange ? 'Δ' + info.label.replace(/ change$/, '') : info.label} (${info.unit})`
  parts.push(`<text transform="translate(14 ${T + (H - T - B) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${C.text}">${esc(yLabel)}</text>`)
  parts.push(`<line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="${C.muted}" stroke-width="1"/>`)
  // Draw passing cells first so problems sit on top.
  const rank = (l: Level | null) => (l === 'fail' ? 2 : l === 'warn' ? 1 : 0)
  const order = [...cells].sort((a, b) => rank(levelFor(a)) - rank(levelFor(b)))
  for (const cell of order) {
    const lvl = levelFor(cell)
    const col = lvl ? C[lvl] : C.none
    const seg: string[] = []
    let path = ''
    cell.conditions.forEach((c, i) => {
      const v = val(c, i)
      if (v == null) { if (path) { seg.push(path); path = '' } return }
      path += `${path ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
    })
    if (path) seg.push(path)
    const title = `<title>${esc(cell.file_name)}${lvl ? ' — ' + lvl : ''}</title>`
    parts.push(`<g opacity="${lvl === 'warn' || lvl === 'fail' ? 1 : 0.75}">${title}`)
    for (const d of seg) parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6"/>`)
    cell.conditions.forEach((c, i) => {
      const v = val(c, i)
      if (v == null) return
      const lv = c.checks.find((k) => k.metric === metric && !k.missing)?.level
      const r = lv === 'fail' || lv === 'warn' ? 4 : 3
      parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${r}" fill="${lv === 'fail' || lv === 'warn' ? C[lv] : col}"/>`)
    })
    parts.push('</g>')
  }
  parts.push('</svg>')
  return parts.join('')
}

function QcPlot({ cells, conditions, reference, metrics, rules, choices }: {
  cells: QcCell[]
  conditions: QcCondition[]
  reference: number
  metrics: Record<string, QcMetric>
  rules: QcRule[]
  choices: string[]
}) {
  const [metric, setMetric] = useState('rs_mohm')
  const [width, setWidth] = useState(640)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(360, Math.min(1400, el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => { if (!choices.includes(metric)) setMetric(choices[0] ?? 'rs_mohm') }, [choices, metric])
  const info = metrics[metric]
  const rule = rules.find((r) => r.metric === metric) ?? null
  const names = conditions.map((c, i) => c.name || c.tags.join(' / ') || `Condition ${i + 1}`)
  const H = 280
  const themeKey = useThemeKey()
  const svgFor = (colors: PlotColors, w: number) => (info ? buildPlotSvg({
    cells, metric, info, rule, reference, conditionNames: names, colors, width: w, height: H, allMetrics: metrics,
  }) : '')
  const shown = useMemo(() => svgFor(themeColors(), width),   // eslint-disable-line react-hooks/exhaustive-deps
    [cells, metric, info, rule, reference, names.join('|'), width, themeKey])
  const label = info ? `${info.kind === 'change' ? 'Δ' + info.label.replace(/ change$/, '') : info.label} (${info.unit})` : metric

  const asterism = (): AsterismTable | null => {
    if (!info || cells.length === 0) return null
    const val = (c: QcCondResult) => (info.kind === 'change' ? c.changes[metric] : c.values[metric]) ?? null
    return {
      columns: [
        { header: 'Cell', values: cells.map((c) => c.cell_id || c.file_name) },
        ...names.map((n, i) => ({
          header: `${n} — ${label}`,
          values: cells.map((c) => (c.conditions[i] ? val(c.conditions[i]) : null)),
        })),
        { header: 'QC verdict', values: cells.map((c) => c.verdict ?? '') },
      ],
    }
  }
  const { onContextMenu, menu } = usePlotMenu({
    getSvg: () => (info && cells.length ? svgFor(EXPORT_COLORS, 640) : null),
    asterism,
    defaultName: `qc-${metric.replace(/_/g, '-')}`,
  })

  return (
    <div className="section-card" style={{ padding: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
        <span className="section-card-title" style={{ margin: 0 }}>Across conditions</span>
        <div className="segmented">
          {choices.map((m) => (
            <button key={m} className={m === metric ? 'active' : undefined} onClick={() => setMetric(m)}>
              {metrics[m]?.kind === 'change' ? 'Δ' + metrics[m].label.replace(/ change$/, '') : metrics[m]?.label ?? m}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          One line per cell, coloured by this measure's checks · dashed: thresholds · right-click to export
        </span>
      </div>
      <div ref={boxRef} onContextMenu={onContextMenu} style={{ width: '100%', lineHeight: 0 }}
        dangerouslySetInnerHTML={{ __html: shown }} />
      {menu}
    </div>
  )
}
