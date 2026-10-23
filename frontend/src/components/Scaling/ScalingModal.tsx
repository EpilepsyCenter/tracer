import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, type ScaleOverride, type ScaleOverrides } from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

interface Props {
  onClose: () => void
  /** Optional channel index (as string) to highlight on open. */
  focusKey?: string
}

interface BackendChannel {
  /** Stable composite identifier ``${index}|${file_units}``. */
  key: string
  index: number
  file_units: string
  label: string
  occurrences: number
}

interface Row {
  key: string
  channelIdx: number
  channelLabel: string
  fileUnits: string
  occurrences: number
}

const PRESETS: { label: string; scale: number; units?: string }[] = [
  { label: 'V→mV', scale: 1000, units: 'mV' },
  { label: 'mV→V', scale: 0.001, units: 'V' },
  { label: 'A→pA', scale: 1e12, units: 'pA' },
  { label: 'pA→A', scale: 1e-12, units: 'A' },
  { label: '×10', scale: 10 },
  { label: '÷10', scale: 0.1 },
]

export function ScalingModal({ onClose, focusKey }: Props) {
  const recording = useAppStore((s) => s.recording)
  const overrides = useAppStore((s) => s.scaleOverrides)
  const setScaleOverrides = useAppStore((s) => s.setScaleOverrides)
  const backendUrl = useAppStore((s) => s.backendUrl)

  const [channels, setChannels] = useState<BackendChannel[] | null>(null)
  const [draft, setDraft] = useState<ScaleOverrides>(() => ({ ...overrides }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const focusRowRef = useRef<HTMLTableRowElement | null>(null)

  // Pull the authoritative channel list from the backend (walks every
  // sweep, so channels that only appear in later sweeps or in series
  // with heterogeneous layouts still surface).
  useEffect(() => {
    if (!recording) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`${backendUrl}/api/files/channels`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const resp = await r.json()
        if (!cancelled) setChannels(resp.channels ?? [])
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load channels')
      }
    })()
    return () => { cancelled = true }
  }, [backendUrl, recording])

  useEffect(() => { setDraft({ ...overrides }) }, [overrides])

  const rows = useMemo<Row[]>(() => {
    if (!channels) return []
    return channels.map((c) => ({
      key: c.key,
      channelIdx: c.index,
      channelLabel: c.label || `Ch ${c.index + 1}`,
      fileUnits: c.file_units,
      occurrences: c.occurrences,
    }))
  }, [channels])

  // Scroll the focused row into view once channels load.
  useEffect(() => {
    if (focusRowRef.current) {
      focusRowRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [rows.length])

  const update = (key: string, patch: Partial<ScaleOverride>) => {
    setDraft((prev) => {
      const row = rows.find((r) => r.key === key)
      const cur = prev[key] ?? { units: row?.fileUnits ?? '', y_scale: 1, y_offset: 0 }
      return { ...prev, [key]: { ...cur, ...patch } }
    })
  }

  const reset = (key: string) => {
    setDraft((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      // Drop dormant entries so the sidecar stays empty for unchanged channels.
      const cleaned: ScaleOverrides = {}
      for (const [k, v] of Object.entries(draft)) {
        if (v.y_scale === 1 && v.y_offset === 0 && !v.note) continue
        cleaned[k] = v
      }
      await setScaleOverrides(cleaned)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to apply')
    } finally {
      setBusy(false)
    }
  }

  if (!recording) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.18)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(900px, 90vw)', maxHeight: '85vh',
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
          <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 600 }}>Channel scaling</span>
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>

        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
          Override units and numeric scaling per channel. Applied before any analysis sees the data, across every series in the recording.
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {error && (
            <div className="notice notice-error" style={{ margin: '8px 12px' }}>{error}</div>
          )}
          {channels === null && !error && (
            <div style={{ padding: 16, color: 'var(--text-muted)' }}>Loading channels…</div>
          )}
          {channels && rows.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-muted)' }}>No channels found.</div>
          )}
          {rows.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th style={th}>Channel</th>
                  <th style={th}>File units</th>
                  <th style={th}>Override units</th>
                  <th style={th}>y_scale</th>
                  <th style={th}>y_offset</th>
                  <th style={th}>Presets</th>
                  <th style={{ ...th, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const o = draft[row.key] ?? { units: row.fileUnits, y_scale: 1, y_offset: 0 }
                  const active = o.y_scale !== 1 || o.y_offset !== 0
                  // ``focusKey`` may be either a full composite key
                  // (``${idx}|${units}``) or a tagged index-only
                  // form (``index:N``) when the caller couldn't
                  // resolve file units. Match either way.
                  const isFocus = focusKey === row.key
                    || (focusKey?.startsWith('index:') && Number(focusKey.slice(6)) === row.channelIdx)
                  return (
                    <tr
                      key={row.key}
                      ref={isFocus ? focusRowRef : null}
                      style={{
                        background: isFocus ? 'var(--bg-selected)' : (active ? 'var(--bg-hover)' : 'transparent'),
                      }}
                    >
                      <td style={td}>
                        <div style={{ fontWeight: 500 }}>{row.channelLabel}</div>
                        {row.occurrences > 1 && (
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                            in {row.occurrences} sweeps
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, color: 'var(--text-muted)' }}>{row.fileUnits || '—'}</td>
                      <td style={td}>
                        <input
                          type="text"
                          value={o.units}
                          onChange={(e) => update(row.key, { units: e.target.value })}
                          style={inputStyle(80)}
                        />
                      </td>
                      <td style={td}>
                        <NumInput value={o.y_scale} onChange={(v) => update(row.key, { y_scale: v })} step={1} />
                      </td>
                      <td style={td}>
                        <NumInput value={o.y_offset} onChange={(v) => update(row.key, { y_offset: v })} step={1} />
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {PRESETS.map((p) => (
                            <button
                              key={p.label}
                              className="btn"
                              style={{ padding: '0 6px', height: 22, fontSize: 'var(--font-size-xs)' }}
                              onClick={() => update(row.key, {
                                y_scale: o.y_scale * p.scale,
                                units: p.units ?? o.units,
                              })}
                              title={`Multiply scale by ${p.scale}${p.units ? `, set units to ${p.units}` : ''}`}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <button
                          className="btn"
                          onClick={() => reset(row.key)}
                          disabled={!active}
                          style={{ padding: '0 8px', height: 22, fontSize: 'var(--font-size-xs)' }}
                          title="Reset this channel to file-reported values"
                        >
                          ↺
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: 8, padding: '10px 12px',
          borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)',
        }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={apply} disabled={busy || channels === null}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '6px 10px' }
const td: React.CSSProperties = { padding: '5px 10px', verticalAlign: 'middle', fontFamily: 'var(--font-ui)' }

function inputStyle(width: number): React.CSSProperties {
  return { width }
}
