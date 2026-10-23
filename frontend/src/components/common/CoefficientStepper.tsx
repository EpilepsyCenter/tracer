import React from 'react'
import { NumInput } from './NumInput'

/**
 * Biexponential-coefficient stepper widget — slider + numeric input
 * + ▼/▲ decrement/increment buttons. Matches EE's Generate Template
 * UX so the user can nudge τ_rise / τ_decay / b0 / b1 / width by
 * dragging a slider, clicking +/-, or typing a value.
 *
 * Values outside the slider range can still be typed into the box —
 * EE explicitly notes this in the manual.
 *
 * Signs:
 *   - The slider visually clamps to [min, max], but the typed input
 *     and the +/- buttons respect only `min` / `max` if both are set.
 *   - When either bound is unset (Infinity/−Infinity), the slider
 *     falls back to a heuristic range centred on the current value.
 */
export function CoefficientStepper({
  label, value, min, max, step,
  onChange, unit,
}: {
  label: string
  value: number
  /** Typed-input hard minimum (passed through to NumInput). */
  min?: number
  /** Typed-input hard maximum (passed through to NumInput). */
  max?: number
  /** Step size for the +/- buttons and the slider. */
  step: number
  onChange: (v: number) => void
  /** Display unit string to the right of the input (e.g. "ms"). */
  unit?: string
}) {
  // Slider range: prefer explicit min/max; otherwise derive a window
  // centred on the current value so dragging is useful even for
  // unbounded coefficients like b0/b1.
  const sliderMin = min != null && isFinite(min)
    ? min
    : Math.min(value - 10 * step * 10, value - Math.abs(value))
  const sliderMax = max != null && isFinite(max)
    ? max
    : Math.max(value + 10 * step * 10, value + Math.abs(value) + 10 * step)

  const decrement = () => {
    const nv = value - step
    if (min != null && nv < min) return onChange(min)
    onChange(nv)
  }
  const increment = () => {
    const nv = value + step
    if (max != null && nv > max) return onChange(max)
    onChange(nv)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 2,
      fontSize: 'var(--font-size-label)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: 'var(--text-muted)', flex: 1, minWidth: 60 }}>
          {label}
        </span>
        <button className="btn" onClick={decrement}
          style={{ padding: '0 6px', minWidth: 20, fontSize: 'var(--font-size-xs)' }}
          title={`−${step}`}>−</button>
        <NumInput value={value} step={step} min={min} max={max}
          onChange={onChange} style={{ width: 70 }} />
        <button className="btn" onClick={increment}
          style={{ padding: '0 6px', minWidth: 20, fontSize: 'var(--font-size-xs)' }}
          title={`+${step}`}>+</button>
        {unit && <span style={{ color: 'var(--text-muted)', minWidth: 16 }}>{unit}</span>}
      </div>
      <input
        type="range"
        min={sliderMin}
        max={sliderMax}
        step={step}
        value={Math.max(sliderMin, Math.min(sliderMax, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', height: 14, accentColor: 'var(--accent)' }}
      />
    </div>
  )
}
