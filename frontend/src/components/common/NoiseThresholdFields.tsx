import React from 'react'
import { NumInput } from './NumInput'

/**
 * Field components for noise-relative threshold detection, shared by
 * the Burst Detection window (``threshold`` / ``oscillation`` methods)
 * and the AP window (``Threshold (noise-relative)`` method). Both run
 * the same backend detector (``detect_threshold_epochs`` in
 * ``backend/analysis/bursts.py``), so labels, options and tooltips are
 * defined once here and each window places the pieces in its own
 * layout.
 *
 * Every component is stateless: values in, ``onChange(name, value)``
 * out, with ``name`` being the backend param key.
 */

export type NoiseBaselineMode = 'percentile' | 'robust' | 'rolling' | 'fixed_start'
export type NoiseMethod = 'sd' | 'mad' | 'mad_diff'
export type PeakDirection = 'auto' | 'positive' | 'negative'

/** Backend param keys consumed by ``detect_threshold_epochs``. */
export interface NoiseThresholdParams {
  baseline_mode: NoiseBaselineMode
  baseline_percentile: number
  baseline_window_s: number
  baseline_end_s: number
  noise_method: NoiseMethod
  n_sd: number
  smooth_ms: number
  min_duration_ms: number
  min_gap_ms: number
  peak_direction: PeakDirection
}

type NumChange = (name: string, v: number) => void

const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)',
}

export function NoiseParamRow({
  label, value, step, min, max, onChange, title,
}: {
  label: string; value: number; step: number; min?: number; max?: number
  onChange: (v: number) => void
  title?: string
}) {
  return (
    <label style={labelStyle} title={title}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange} />
    </label>
  )
}

/** Baseline-mode dropdown (stacked label). */
export function BaselineModeSelect({
  value, onChange,
}: {
  value: NoiseBaselineMode
  onChange: (v: NoiseBaselineMode) => void
}) {
  return (
    <label style={{ ...labelStyle, gap: 2 }}>
      <span style={{ color: 'var(--text-muted)' }}>Baseline</span>
      <select value={value} onChange={(e) => onChange(e.target.value as NoiseBaselineMode)}>
        <option value="percentile">Percentile (default)</option>
        <option value="robust">Robust (median + MAD)</option>
        <option value="rolling">Rolling median</option>
        <option value="fixed_start">Fixed start</option>
      </select>
    </label>
  )
}

/** Noise-estimator dropdown. ``inline`` puts the label beside the
 *  select (Burst window's filter row); ``stacked`` puts it above. */
export function NoiseMethodSelect({
  value, onChange, layout = 'stacked', style,
}: {
  value: NoiseMethod
  onChange: (v: NoiseMethod) => void
  layout?: 'inline' | 'stacked'
  style?: React.CSSProperties
}) {
  const select = (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as NoiseMethod)}
      style={layout === 'inline' ? { fontSize: 'var(--font-size-label)' } : undefined}
      title="SD: classical standard deviation. MAD: robust to outliers. MAD-diff: robust to outliers AND drift."
    >
      <option value="sd">SD</option>
      <option value="mad">MAD</option>
      <option value="mad_diff">MAD-diff</option>
    </select>
  )
  if (layout === 'inline') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)', ...style }}>
        <span style={{ color: 'var(--text-muted)' }}>Noise</span>
        {select}
      </label>
    )
  }
  return (
    <label style={{ ...labelStyle, ...style }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Noise</span>
      {select}
    </label>
  )
}

/** n × noise, smoothing, min duration, min gap — a fragment so the
 *  caller's grid lays the four rows out. */
export function ThresholdEpochFields({
  params, onChange,
}: {
  params: Pick<NoiseThresholdParams, 'n_sd' | 'smooth_ms' | 'min_duration_ms' | 'min_gap_ms'>
  onChange: NumChange
}) {
  return (
    <>
      <NoiseParamRow label="n_sd" value={Number(params.n_sd ?? 0)} step={0.1} min={0}
        title="Threshold = n × noise estimate, applied to the smoothed |signal − baseline|."
        onChange={(v) => onChange('n_sd', v)} />
      <NoiseParamRow label="Smooth (ms)" value={Number(params.smooth_ms ?? 0)} step={1} min={1}
        onChange={(v) => onChange('smooth_ms', v)} />
      <NoiseParamRow label="Min dur (ms)" value={Number(params.min_duration_ms ?? 0)} step={1} min={1}
        onChange={(v) => onChange('min_duration_ms', v)} />
      <NoiseParamRow label="Min gap (ms)" value={Number(params.min_gap_ms ?? 0)} step={1} min={0}
        title="Detections closer than this are merged into one."
        onChange={(v) => onChange('min_gap_ms', v)} />
    </>
  )
}

/** The one extra knob each baseline mode needs (none for robust). */
export function BaselineModeFields({
  mode, params, onChange,
}: {
  mode: NoiseBaselineMode
  params: Pick<NoiseThresholdParams, 'baseline_percentile' | 'baseline_window_s' | 'baseline_end_s'>
  onChange: NumChange
}) {
  if (mode === 'percentile') {
    return (
      <NoiseParamRow label="Percentile (%)" value={Number(params.baseline_percentile ?? 0)} step={1} min={0} max={100}
        onChange={(v) => onChange('baseline_percentile', Math.max(0, Math.min(100, v)))} />
    )
  }
  if (mode === 'rolling') {
    return (
      <NoiseParamRow label="Window (s)" value={Number(params.baseline_window_s ?? 0)} step={0.5} min={0.1}
        onChange={(v) => onChange('baseline_window_s', v)} />
    )
  }
  if (mode === 'fixed_start') {
    return (
      <NoiseParamRow label="Baseline end (s)" value={Number(params.baseline_end_s ?? 0)} step={0.1} min={0.01}
        onChange={(v) => onChange('baseline_end_s', v)} />
    )
  }
  return null
}

/** Peak-direction dropdown. ``autoLabel`` lets each window describe
 *  what its auto mode does. */
export function PeakDirectionSelect({
  value, onChange, autoLabel = 'Auto (|max dev|)', title,
}: {
  value: PeakDirection
  onChange: (v: PeakDirection) => void
  autoLabel?: string
  title?: string
}) {
  return (
    <label style={labelStyle} title={title}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Peak direction</span>
      <select value={value} onChange={(e) => onChange(e.target.value as PeakDirection)}>
        <option value="auto">{autoLabel}</option>
        <option value="positive">Positive</option>
        <option value="negative">Negative</option>
      </select>
    </label>
  )
}
