import React, { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../stores/appStore'

interface ProbedColumn {
  index: number
  label: string
  units: string
  is_time: boolean
}

interface ProbeResponse {
  file_name: string
  delimiter: 'comma' | 'tab' | 'space' | string
  preview: string[]
  header: string[] | null
  columns: ProbedColumn[]
  time_column: number | null
  sample_rate_hz: number | null
  n_columns: number
}

interface Props {
  filePath: string
  /** Called with the user-confirmed import options (or ``null`` if cancelled). */
  onClose: (options: Record<string, unknown> | null) => void
}

export function TextImportWizard({ filePath, onClose }: Props) {
  const backendUrl = useAppStore((s) => s.backendUrl)

  const [probe, setProbe] = useState<ProbeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [delimiter, setDelimiter] = useState<'auto' | 'comma' | 'tab' | 'space'>('auto')
  const [timeColumn, setTimeColumn] = useState<number | 'none'>('none')
  const [sampleRate, setSampleRate] = useState<string>('')
  const [unitsPerCol, setUnitsPerCol] = useState<Record<number, string>>({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`${backendUrl}/api/files/probe_text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_path: filePath }),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
        const p = await r.json() as ProbeResponse
        if (cancelled) return
        setProbe(p)
        setDelimiter((p.delimiter as any) || 'auto')
        setTimeColumn(p.time_column ?? 'none')
        setSampleRate(p.sample_rate_hz ? String(round(p.sample_rate_hz)) : '')
        const u: Record<number, string> = {}
        for (const c of p.columns) u[c.index] = c.units || ''
        setUnitsPerCol(u)
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to probe file')
      }
    })()
    return () => { cancelled = true }
  }, [backendUrl, filePath])

  const channelCols = useMemo(() => {
    if (!probe) return []
    return probe.columns.filter((c) => c.index !== timeColumn)
  }, [probe, timeColumn])

  const canConfirm = useMemo(() => {
    if (!probe) return false
    if (timeColumn === 'none') {
      const sr = Number(sampleRate)
      if (!Number.isFinite(sr) || sr <= 0) return false
    }
    return true
  }, [probe, timeColumn, sampleRate])

  const confirm = () => {
    if (!probe) return
    const opts: Record<string, unknown> = {
      delimiter,
      time_column: timeColumn === 'none' ? 'none' : timeColumn,
    }
    if (timeColumn === 'none') {
      opts.sample_rate_hz = Number(sampleRate)
    }
    // Units list — one entry per channel column in the order they
    // appear after the time column is removed. Backend expects the
    // same ordering ``text_reader._read_delimited`` builds.
    opts.units_per_channel = channelCols.map((c) => unitsPerCol[c.index] ?? '')
    onClose(opts)
  }

  return (
    <div
      onClick={() => onClose(null)}
      style={{
        position: 'fixed', inset: 0, zIndex: 110,
        background: 'rgba(0,0,0,0.18)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 90vw)', maxHeight: '85vh',
          background: 'var(--bg-secondary)', color: 'var(--text-primary)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-popover), 0 24px 60px rgba(0,0,0,0.25)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px 10px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 600 }}>Import text file{probe ? ` — ${probe.file_name}` : ''}</span>
          <button className="icon-btn" onClick={() => onClose(null)} title="Close">×</button>
        </div>

        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
          Confirm how the file should be parsed. Defaults are auto-detected from the first ~50 rows.
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          {error && <div className="notice notice-error">{error}</div>}
          {!probe && !error && <div style={{ color: 'var(--text-muted)' }}>Probing file…</div>}
          {probe && (
            <>
              <Field label="Delimiter">
                <select
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value as any)}
                  style={selectStyle}
                >
                  <option value="auto">Auto ({probe.delimiter})</option>
                  <option value="comma">Comma</option>
                  <option value="tab">Tab</option>
                  <option value="space">Whitespace</option>
                </select>
              </Field>

              <Field label="Time column">
                <select
                  value={timeColumn === 'none' ? 'none' : String(timeColumn)}
                  onChange={(e) => {
                    const v = e.target.value
                    setTimeColumn(v === 'none' ? 'none' : Number(v))
                  }}
                  style={selectStyle}
                >
                  <option value="none">None — use sample rate</option>
                  {probe.columns.map((c) => (
                    <option key={c.index} value={c.index}>
                      Column {c.index + 1}{c.label ? ` (${c.label})` : ''}
                    </option>
                  ))}
                </select>
              </Field>

              {timeColumn === 'none' && (
                <Field label="Sample rate (Hz)">
                  <input
                    type="text"
                    value={sampleRate}
                    onChange={(e) => setSampleRate(e.target.value)}
                    placeholder="e.g. 10000"
                    className="num"
                    style={inputStyle(140)}
                  />
                </Field>
              )}

              <div style={{ marginTop: 12, marginBottom: 4, fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--text-muted)' }}>
                Channel columns ({channelCols.length})
              </div>
              <table className="data-table" style={{ border: '1px solid var(--border)' }}>
                <thead>
                  <tr>
                    <th style={th}>Column</th>
                    <th style={th}>Label</th>
                    <th style={th}>Units</th>
                  </tr>
                </thead>
                <tbody>
                  {channelCols.map((c) => (
                    <tr key={c.index}>
                      <td style={td}>{c.index + 1}</td>
                      <td style={{ ...td, fontFamily: 'var(--font-ui)' }}>{c.label || `Ch ${c.index + 1}`}</td>
                      <td style={{ ...td, fontFamily: 'var(--font-ui)' }}>
                        <input
                          type="text"
                          value={unitsPerCol[c.index] ?? ''}
                          onChange={(e) =>
                            setUnitsPerCol((u) => ({ ...u, [c.index]: e.target.value }))
                          }
                          placeholder="e.g. mV, pA"
                          style={inputStyle(100)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ marginTop: 12, marginBottom: 4, fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--text-muted)' }}>
                Preview
              </div>
              <pre style={{
                margin: 0, padding: 8, fontSize: 'var(--font-size-xs)',
                background: 'var(--bg-field)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                maxHeight: 180, overflow: 'auto',
                fontFamily: 'var(--font-mono)',
              }}>
                {probe.preview.join('\n')}
              </pre>
            </>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: 8, padding: '10px 12px',
          borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)',
        }}>
          <button className="btn" onClick={() => onClose(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={confirm} disabled={!canConfirm}>Open</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <label style={{ width: 130, fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>{label}</label>
      {children}
    </div>
  )
}

const selectStyle: React.CSSProperties = {}

function inputStyle(width: number): React.CSSProperties {
  return { width }
}

const th: React.CSSProperties = { padding: '5px 8px' }
const td: React.CSSProperties = { padding: '4px 8px' }

function round(x: number): number {
  if (!Number.isFinite(x)) return x
  if (Math.abs(x - Math.round(x)) < 1e-3) return Math.round(x)
  return Number(x.toFixed(3))
}
