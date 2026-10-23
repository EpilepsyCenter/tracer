import React from 'react'
import { NumInput } from './NumInput'
import type { ImSource } from '../../stores/appStore'

/**
 * Shared Im-source configuration card used by the AP and IV analysis
 * windows. Two modes:
 *
 *   - Auto   — backend reconstructs Im from the recording's stimulus
 *              protocol. The card only shows an info line with what
 *              the last run actually picked, so users can tell auto
 *              worked (or failed).
 *   - Manual — user supplies start/step/window and Im is computed as
 *              `start_pa + sweep_index * step_pa` within [start_s, end_s].
 *              Fallback when the recording has no stimulus protocol.
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

export function ImSourceCard({
  mode, onModeChange,
  manual, onManualChange,
  detected,
}: {
  mode: 'auto' | 'manual'
  onModeChange: (m: 'auto' | 'manual') => void
  manual: ManualIm
  onManualChange: (patch: Partial<ManualIm>) => void
  /** Populated from the last run's response. null before first run. */
  detected: ImSource | null | undefined
}) {
  return (
    <div className="section-card" style={{
      gap: 6,
      fontSize: 'var(--font-size-label)',
    }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: 'var(--text-muted)' }}>Im source</span>
        <select value={mode}
          onChange={(e) => onModeChange(e.target.value as 'auto' | 'manual')}
          style={{ width: '100%' }}>
          <option value="auto">Auto (from stimulus protocol)</option>
          <option value="manual">Manual (start / step)</option>
        </select>
      </label>

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
            <span style={{ color: 'var(--text-muted)' }}>Start Im (pA)</span>
            <NumInput value={manual.startPA} step={1}
              onChange={(v) => onManualChange({ startPA: v })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)' }}>Step (pA)</span>
            <NumInput value={manual.stepPA} step={1}
              onChange={(v) => onManualChange({ stepPA: v })} />
          </label>
          <span style={{
            gridColumn: '1 / -1',
            color: 'var(--text-muted)', fontStyle: 'italic',
          }}>
            Im(sweep n) = startPA + n · stepPA
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
  // d.mode === 'none'
  return '⚠ No Im source found — switch to Manual to provide values.'
}
