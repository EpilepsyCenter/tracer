import React from 'react'
import { NumInput } from './NumInput'
import type { ImSource } from '../../stores/appStore'

/**
 * Shared Im-source configuration card used by the AP and IV analysis
 * windows. Three modes:
 *
 *   - Auto   — backend reconstructs Im from the recording's stimulus
 *              protocol (HEKA). The card only shows an info line with
 *              what the last run actually picked, so users can tell auto
 *              worked (or failed).
 *   - Trace  — a recorded channel holds the stimulus (NWB stimulus, ABF
 *              command, HEKA monitor); the user picks it, and each
 *              sweep's level and timing come from its step.
 *   - Manual — user supplies start/step/window and Im is computed as
 *              `start_pa + sweep_index * step_pa` within [start_s, end_s].
 *
 * The `detected` field is populated from the last run's backend
 * response (via `APData.imSource` / `IVCurveData.imSource`) and is
 * null before the first run. Null → "Auto-detect runs when you click
 * Run." Non-null → formatted sentence describing the actual source.
 *
 * This component is deliberately self-contained: it owns no state and
 * just forwards changes up. Both windows keep their own state vars
 * for the manual fields so existing persistence keeps working.
 */

interface ManualIm {
  startS: number
  endS: number
  startPA: number
  stepPA: number
}

export type ImSourceMode = 'auto' | 'trace' | 'manual'

export interface StimTraceOption { index: number; label: string; units: string }

/** The channel to offer first: one named like a stimulus, else the first
 *  channel that isn't the analysed one. The user can always change it. */
export function defaultStimTrace(channels: StimTraceOption[], analysed: number): number | null {
  const named = channels.find((c) => /^stim/i.test(c.label) && c.index !== analysed)
  if (named) return named.index
  return channels.find((c) => c.index !== analysed)?.index ?? null
}

export function ImSourceCard({
  mode, onModeChange,
  manual, onManualChange,
  detected,
  traces = [], traceIndex = null, onTraceChange,
  levelUnit = 'pA',
}: {
  mode: ImSourceMode
  onModeChange: (m: ImSourceMode) => void
  manual: ManualIm
  onManualChange: (patch: Partial<ManualIm>) => void
  /** Populated from the last run's response. null before first run. */
  detected: ImSource | null | undefined
  /** Channels of the series, for the Trace mode. */
  traces?: StimTraceOption[]
  traceIndex?: number | null
  onTraceChange?: (index: number) => void
  /** Unit of the manual levels: pA (current clamp) or mV (voltage clamp). */
  levelUnit?: string
}) {
  return (
    <div className="section-card" style={{
      gap: 6,
      fontSize: 'var(--font-size-label)',
    }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: 'var(--text-muted)' }}>Im source</span>
        <select value={mode}
          onChange={(e) => onModeChange(e.target.value as ImSourceMode)}
          style={{ width: '100%' }}>
          <option value="auto">Auto (from stimulus protocol)</option>
          <option value="trace" disabled={traces.length === 0}>Recorded trace</option>
          <option value="manual">Manual (start / step)</option>
        </select>
      </label>

      {mode === 'trace' && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text-muted)' }}>Stimulus trace</span>
          <select value={traceIndex ?? ''}
            onChange={(e) => onTraceChange?.(Number(e.target.value))}
            style={{ width: '100%' }}>
            {traceIndex == null && <option value="">— pick a channel —</option>}
            {traces.map((c) => (
              <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
            ))}
          </select>
          {detected?.mode === 'trace' && (
            <span style={{ color: 'var(--text-muted)' }}>● Used: {detected.label}</span>
          )}
        </label>
      )}

      {mode === 'auto' && (
        <div style={{
          fontSize: 'var(--font-size-label)',
          color: detected?.mode === 'none' ? 'var(--error)' : 'var(--text-muted)',
          padding: '3px 6px',
          borderLeft: '2px solid var(--border)',
          background: 'var(--bg-hover)',
          borderRadius: 'var(--radius-sm)',
        }}>
          {describeDetected(detected)}
        </div>
      )}

      {mode === 'manual' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 6,
        }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)' }}>Start (s)</span>
            <NumInput value={manual.startS} step={0.01}
              onChange={(v) => onManualChange({ startS: v })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)' }}>End (s)</span>
            <NumInput value={manual.endS} step={0.01}
              onChange={(v) => onManualChange({ endS: v })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)' }}>Start ({levelUnit})</span>
            <NumInput value={manual.startPA} step={1}
              onChange={(v) => onManualChange({ startPA: v })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)' }}>Step ({levelUnit})</span>
            <NumInput value={manual.stepPA} step={1}
              onChange={(v) => onManualChange({ stepPA: v })} />
          </label>
          <span style={{
            gridColumn: '1 / -1',
            color: 'var(--text-muted)', fontStyle: 'italic',
          }}>
            level(sweep n) = start + n · step
          </span>
        </div>
      )}
    </div>
  )
}

function describeDetected(d: ImSource | null | undefined): string {
  if (d == null) return 'Auto-detect runs on Run.'
  if (d.mode === 'protocol') {
    return `● Detected: ${d.label || 'stimulus protocol'}`
  }
  if (d.mode === 'manual') {
    // Shouldn't happen in Auto mode, but just in case.
    return 'Manual Im values in use.'
  }
  if (d.mode === 'trace') return `● Recorded trace: ${d.label}`
  // d.mode === 'none'
  return '⚠ No stimulus protocol — pick the stimulus channel (Recorded trace) or use Manual.'
}
