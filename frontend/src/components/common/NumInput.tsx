import React, { useEffect, useState } from 'react'

/** Number input that doesn't lose focus on every keystroke.
 *
 * Uses ``type="text"`` + ``inputMode="decimal"`` rather than ``type="number"``
 * on purpose: native number inputs format their displayed value with the
 * user's locale, which shows decimal commas (1,5) on European systems and
 * makes the UI inconsistent with our dot-separated tables/CSV. We render the
 * value using JavaScript's default ``String(n)`` (always dot) and accept
 * either dot or comma when parsing so users can type naturally either way.
 *
 * Keeps a local string buffer while focused and only calls
 * ``onChange(numericValue)`` on blur or Enter. Re-syncs from the external
 * value whenever it changes, as long as the input is not focused. */
export function NumInput({
  value,
  onChange,
  step: _step,
  min,
  max,
  placeholder,
  style,
  disabled,
  title,
  className,
  decimals,
}: {
  value: number
  onChange: (v: number) => void
  /** Kept for API compat; unused now that we render as text. */
  step?: number
  min?: number
  max?: number
  placeholder?: string
  style?: React.CSSProperties
  disabled?: boolean
  title?: string
  className?: string
  /** When set, the displayed value is formatted via ``.toFixed(decimals)``
   *  so long floats (e.g. 0.12345678) don't spill outside the input
   *  box. Applies only when the input isn't focused — the user can
   *  still type any precision they want. Trailing zeros are trimmed
   *  to avoid showing "1.5000" when the user typed "1.5". */
  decimals?: number
}) {
  // Format a number for display. Respects `decimals` if provided,
  // else uses JavaScript's default String(n) (no truncation).
  const fmt = (n: number): string => {
    if (decimals == null) return String(n)
    if (!isFinite(n)) return String(n)
    let s = n.toFixed(decimals)
    // Trim trailing zeros after the decimal point ("1.5000" → "1.5").
    // Also trim a trailing bare dot left behind ("1." → "1").
    if (s.includes('.')) {
      s = s.replace(/0+$/, '').replace(/\.$/, '')
    }
    return s
  }
  const [local, setLocal] = useState(fmt(value))
  const [focused, setFocused] = useState(false)

  // Sync from external value when NOT focused (store changed elsewhere)
  useEffect(() => {
    if (!focused) setLocal(fmt(value))
  }, [value, focused])

  const commit = () => {
    // Accept comma OR dot as decimal separator — we normalize either way.
    const n = parseFloat(local.replace(',', '.'))
    if (isFinite(n)) {
      let clamped = n
      if (min != null) clamped = Math.max(min, clamped)
      if (max != null) clamped = Math.min(max, clamped)
      onChange(clamped)
      // Snap the displayed value to the canonical dot form.
      setLocal(fmt(clamped))
    } else {
      setLocal(fmt(value))
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      // Accept dot or comma as decimal separator; commit() normalizes to
      // dot on blur. No ``pattern`` attribute because modern Chromium
      // validates patterns in ``/v`` mode, which rejects an unescaped
      // dot inside a character class ([.,]) that used to be fine.
      value={local}
      placeholder={placeholder}
      style={style}
      disabled={disabled}
      title={title}
      className={`num${className ? ` ${className}` : ''}`}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}
