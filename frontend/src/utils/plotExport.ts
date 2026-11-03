/**
 * Exports for uPlot figures, used by the right-click plot menu:
 *
 * - `uplotToSvg`: a vector redraw of the plot (series as paths / points /
 *   bars, axes with their ticks, tick labels and titles) for Illustrator
 *   or Affinity. Overlays the app draws on separate canvases (cursors,
 *   detection markers, shading) are not part of it — the export is the
 *   data and its axes. Not themed: black axes on white, series keep
 *   their colours (converted to plain sRGB so every editor reads them).
 * - `uplotToTable`: the plotted data as a table in ASTERISM's "wide"
 *   layout — an X column, then one named column per visible series.
 * - `tableToCsv` / `tableToTsv`: text for a file / for pasting.
 *
 * Series may carry two optional extra fields read here:
 *   `vectorStyle: 'bars' | 'stepped'` (default line), `vectorBarFrac`
 *   (bar width as a fraction of the bin spacing, default 0.9), and
 *   `asterism: false` to leave a helper series (guide line, fit) out of
 *   the table; `vectorBand: { lo, hi, alpha? }` for a shaded band (SD /
 *   SEM) the plot draws in a hook, filled in the series' colour.
 * uPlot's own `bands` option is exported too.
 */

import type uPlot from 'uplot'

export interface AsterismColumn {
  header: string
  values: (number | string | null)[]
}

export interface AsterismTable {
  columns: AsterismColumn[]
}

// ---------------------------------------------------------------------------
// Colour normalisation
// ---------------------------------------------------------------------------

let _colorCanvas: CanvasRenderingContext2D | null = null

/** Any CSS colour (oklch(), var-resolved strings, names…) → `#rrggbb`
 *  plus opacity, by painting one pixel. Editors don't all read oklch(). */
export function toRgb(color: unknown): { hex: string; alpha: number } {
  if (typeof color !== 'string' || !color) return { hex: '#000000', alpha: 1 }
  if (!_colorCanvas) {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    _colorCanvas = c.getContext('2d', { willReadFrequently: true })
  }
  const ctx = _colorCanvas!
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  const h = (v: number) => v.toString(16).padStart(2, '0')
  return { hex: `#${h(r)}${h(g)}${h(b)}`, alpha: Math.round((a / 255) * 1000) / 1000 }
}

function resolveColor(v: any, u: uPlot, i: number): string {
  return typeof v === 'function' ? v(u, i) : v
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const n2 = (v: number) => (Math.round(v * 100) / 100).toString()

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** First index with xs[k] >= v (xs ascending). */
function lowerBound(xs: number[], v: number): number {
  let lo = 0, hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function uplotToSvg(u: uPlot): { svg: string; width: number; height: number } {
  const dpr = devicePixelRatio || 1
  const W = u.width
  const H = u.height
  const L = u.bbox.left / dpr
  const T = u.bbox.top / dpr
  const PW = u.bbox.width / dpr
  const PH = u.bbox.height / dpr
  const FONT = 'Helvetica, Arial, sans-serif'
  const out: string[] = []
  const clipId = `plot${Math.floor(Math.random() * 1e9).toString(36)}`

  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`)
  out.push(`<defs><clipPath id="${clipId}"><rect x="${n2(L)}" y="${n2(T)}" width="${n2(PW)}" height="${n2(PH)}"/></clipPath></defs>`)

  // ---- series ----
  const xs = u.data[0] as unknown as number[]
  const xMin = u.scales.x?.min ?? -Infinity
  const xMax = u.scales.x?.max ?? Infinity
  const seriesOut: string[] = []

  // Shaded bands go underneath every line.
  const k0all = Math.max(0, lowerBound(xs ?? [], xMin) - 1)
  const k1all = Math.min((xs?.length ?? 1) - 1, lowerBound(xs ?? [], xMax))
  const bandPath = (sk: string, hi: ArrayLike<number | null | undefined>, lo: ArrayLike<number | null | undefined>) => {
    // One polygon per run of points where both edges exist.
    const polys: string[] = []
    let up: string[] = [], down: string[] = []
    const flush = () => {
      if (up.length > 1) polys.push(`M${up.join('L')}L${down.reverse().join('L')}Z`)
      up = []; down = []
    }
    for (let k = k0all; k <= k1all; k++) {
      const h = hi[k], l = lo[k]
      if (h == null || l == null || !isFinite(h) || !isFinite(l)) { flush(); continue }
      const x = n2(L + u.valToPos(xs[k], 'x'))
      up.push(`${x} ${n2(T + u.valToPos(h, sk))}`)
      down.push(`${x} ${n2(T + u.valToPos(l, sk))}`)
    }
    flush()
    return polys.join('')
  }
  for (const b of ((u as any).bands ?? []) as any[]) {
    const [hiIdx, loIdx] = b.series ?? []
    const hs = u.series[hiIdx] as any
    if (hiIdx == null || loIdx == null || !hs || hs.show === false) continue
    const fill = toRgb(typeof b.fill === 'function' ? b.fill(u, hiIdx) : b.fill)
    const d = bandPath(hs.scale ?? 'y', u.data[hiIdx] as any, u.data[loIdx] as any)
    if (d) seriesOut.push(`<g clip-path="url(#${clipId})"><path d="${d}" fill="${fill.hex}" fill-opacity="${fill.alpha}" stroke="none"/></g>`)
  }
  for (let i = 1; i < u.series.length; i++) {
    const s = u.series[i] as any
    const vb = s.vectorBand
    if (!vb || s.show === false) continue
    const fill = toRgb(resolveColor(s.stroke, u, i))
    const d = bandPath(s.scale ?? 'y', vb.hi, vb.lo)
    if (d) seriesOut.push(`<g clip-path="url(#${clipId})"><path d="${d}" fill="${fill.hex}" fill-opacity="${vb.alpha ?? 0.18}" stroke="none"/></g>`)
  }
  for (let i = 1; i < u.series.length; i++) {
    const s = u.series[i] as any
    if (s.show === false) continue
    const ys = u.data[i] as unknown as (number | null | undefined)[]
    if (!ys || !xs) continue
    const sk: string = s.scale ?? 'y'
    const sc = u.scales[sk]
    if (!sc || sc.min == null || sc.max == null) continue
    // Visible range plus one point either side so lines run to the edge.
    const k0 = Math.max(0, lowerBound(xs, xMin) - 1)
    const k1 = Math.min(xs.length - 1, lowerBound(xs, xMax))
    const px = (k: number) => L + u.valToPos(xs[k], 'x')
    const py = (v: number) => T + u.valToPos(v, sk)
    const stroke = toRgb(resolveColor(s.stroke, u, i))
    const width: number = typeof s.width === 'number' ? s.width : 1
    const dash: number[] | undefined = Array.isArray(s.dash) ? s.dash : undefined
    const style: string = s.vectorStyle ?? 'line'
    const g: string[] = []

    if (style === 'bars') {
      const frac = typeof s.vectorBarFrac === 'number' ? s.vectorBarFrac : 0.9
      const fill = toRgb(resolveColor(s.fill ?? s.stroke, u, i))
      const fillAlpha = (typeof s.alpha === 'number' ? s.alpha : 1) * fill.alpha
      const y0 = py(Math.max(sc.min, Math.min(sc.max, 0)))
      for (let k = k0; k <= k1; k++) {
        const v = ys[k]
        if (v == null || !isFinite(v)) continue
        // Bar width from the spacing to the neighbouring bars in SCREEN
        // space, so bars on a log axis come out right too.
        const xk = px(k)
        const dl = k > 0 ? Math.abs(xk - px(k - 1)) : Infinity
        const dr = k + 1 < xs.length ? Math.abs(px(k + 1) - xk) : Infinity
        const sp = Math.min(dl, dr)
        const half = ((isFinite(sp) ? sp : 10) * frac) / 2
        const a = xk - half
        const b = xk + half
        const yv = py(v)
        g.push(`<rect x="${n2(Math.min(a, b))}" y="${n2(Math.min(yv, y0))}" width="${n2(Math.abs(b - a))}" height="${n2(Math.abs(y0 - yv))}" fill="${fill.hex}" fill-opacity="${fillAlpha}"/>`)
      }
    } else if (width > 0) {
      let d = ''
      let pen = false
      let lastX = 0
      for (let k = k0; k <= k1; k++) {
        const v = ys[k]
        if (v == null || !isFinite(v as number)) {
          if (!s.spanGaps) pen = false
          continue
        }
        const x = px(k), y = py(v as number)
        if (!pen) {
          d += `M${n2(x)} ${n2(y)}`
          pen = true
        } else if (style === 'stepped') {
          d += `H${n2(x)}V${n2(y)}`
        } else {
          d += `L${n2(x)} ${n2(y)}`
        }
        lastX = x
      }
      void lastX
      if (d) {
        g.push(`<path d="${d}" fill="none" stroke="${stroke.hex}" stroke-opacity="${stroke.alpha}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash.join(' ')}"` : ''}/>`)
      }
    }

    // Points (scatter series, or line series that show their points).
    const pts = s.points ?? {}
    const showPts = typeof pts.show === 'function' ? !!pts.show(u, i) : !!pts.show
    if (showPts && style !== 'bars') {
      const r = (typeof pts.size === 'number' ? pts.size : 5) / 2
      const pf = toRgb(resolveColor(pts.fill ?? s.stroke, u, i))
      const ps = toRgb(resolveColor(pts.stroke ?? s.stroke, u, i))
      for (let k = k0; k <= k1; k++) {
        const v = ys[k]
        if (v == null || !isFinite(v as number)) continue
        g.push(`<circle cx="${n2(px(k))}" cy="${n2(py(v as number))}" r="${n2(r)}" fill="${pf.hex}" stroke="${ps.hex}" stroke-width="1"/>`)
      }
    }
    if (g.length) seriesOut.push(`<g clip-path="url(#${clipId})">${g.join('')}</g>`)
  }
  out.push(...seriesOut)

  // ---- axes ----
  for (const a of u.axes as any[]) {
    if (a.show === false || a._show === false || a._pos == null) continue
    const side: number = a.side ?? 2
    const horizontal = side === 0 || side === 2
    const sk: string = a.scale ?? (horizontal ? 'x' : 'y')
    const sc = u.scales[sk]
    if (!sc || sc.min == null) continue
    const base: number = a._pos
    const dir = side === 0 || side === 3 ? -1 : 1
    const tick = a.ticks?.show === false ? 0 : (a.ticks?.size ?? 10)
    const gap = a.gap ?? 5
    const fs = 10
    const g: string[] = []
    // Axis line along the plot edge.
    if (horizontal) g.push(`<line x1="${n2(L)}" y1="${n2(base)}" x2="${n2(L + PW)}" y2="${n2(base)}" stroke="#000" stroke-width="1"/>`)
    else g.push(`<line x1="${n2(base)}" y1="${n2(T)}" x2="${n2(base)}" y2="${n2(T + PH)}" stroke="#000" stroke-width="1"/>`)
    const splits: number[] = a._splits ?? []
    const vals: (string | number | null)[] = a._values ?? []
    for (let k = 0; k < splits.length; k++) {
      const pos = horizontal ? L + u.valToPos(splits[k], sk) : T + u.valToPos(splits[k], sk)
      if (!isFinite(pos)) continue
      if (horizontal ? (pos < L - 0.5 || pos > L + PW + 0.5) : (pos < T - 0.5 || pos > T + PH + 0.5)) continue
      if (tick > 0) {
        if (horizontal) g.push(`<line x1="${n2(pos)}" y1="${n2(base)}" x2="${n2(pos)}" y2="${n2(base + dir * tick * 0.6)}" stroke="#000" stroke-width="1"/>`)
        else g.push(`<line x1="${n2(base)}" y1="${n2(pos)}" x2="${n2(base + dir * tick * 0.6)}" y2="${n2(pos)}" stroke="#000" stroke-width="1"/>`)
      }
      const label = vals[k]
      if (label == null || label === '') continue
      const off = base + dir * (tick * 0.6 + gap)
      if (horizontal) {
        g.push(`<text x="${n2(pos)}" y="${n2(side === 2 ? off + fs : off)}" font-family="${FONT}" font-size="${fs}" text-anchor="middle" fill="#000">${esc(String(label))}</text>`)
      } else {
        g.push(`<text x="${n2(off)}" y="${n2(pos + fs * 0.35)}" font-family="${FONT}" font-size="${fs}" text-anchor="${side === 3 ? 'end' : 'start'}" fill="#000">${esc(String(label))}</text>`)
      }
    }
    // Axis title.
    const title = typeof a.label === 'function' ? a.label(u, 0) : a.label
    if (title && a._lpos != null) {
      const ls = a.labelSize ?? 20
      const c = side === 0 || side === 3 ? a._lpos - ls / 2 : a._lpos + ls / 2
      if (horizontal) {
        g.push(`<text x="${n2(L + PW / 2)}" y="${n2(c + fs * 0.35)}" font-family="${FONT}" font-size="${fs + 1}" text-anchor="middle" fill="#000">${esc(String(title))}</text>`)
      } else {
        const rot = side === 3 ? -90 : 90
        g.push(`<text transform="translate(${n2(c)} ${n2(T + PH / 2)}) rotate(${rot})" y="${n2(fs * 0.35)}" font-family="${FONT}" font-size="${fs + 1}" text-anchor="middle" fill="#000">${esc(String(title))}</text>`)
      }
    }
    out.push(`<g>${g.join('')}</g>`)
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>`
  return { svg, width: W, height: H }
}

// ---------------------------------------------------------------------------
// ASTERISM table
// ---------------------------------------------------------------------------

/** Series' y-axis title (units), from the axis on the same scale. */
function axisTitleForScale(u: uPlot, scale: string): string {
  for (const a of u.axes as any[]) {
    const sk = a.scale ?? ((a.side ?? 2) % 2 === 0 ? 'x' : 'y')
    if (sk === scale) {
      const t = typeof a.label === 'function' ? a.label(u, 0) : a.label
      if (t) return String(t)
    }
  }
  return ''
}

/** The plotted data, one X column and one column per visible series. */
export function uplotToTable(u: uPlot): AsterismTable {
  const xs = u.data[0] as unknown as number[]
  const xTitle = axisTitleForScale(u, 'x') || 'X'
  const cols: AsterismColumn[] = [{ header: xTitle, values: Array.from(xs ?? []) }]
  const used = new Set<string>([xTitle])
  for (let i = 1; i < u.series.length; i++) {
    const s = u.series[i] as any
    if (s.show === false || s.asterism === false) continue
    const ys = u.data[i] as unknown as (number | null)[]
    if (!ys) continue
    const title = axisTitleForScale(u, s.scale ?? 'y')
    // Unlabelled series take their axis title (e.g. "Rate (Hz)").
    // Labelled ones get the title's units: "delta" + "Band power (mV²)"
    // → "delta (mV²)"; a title without units is appended whole.
    const units = /\(([^()]*)\)\s*$/.exec(title)?.[1] ?? title
    // uPlot names unlabelled series "Value"; treat that as no label.
    const label = s.label && s.label !== 'Value' ? String(s.label) : ''
    let name = label || title || `Series ${i}`
    // Skip only when the name already carries these units in brackets
    // (a bare substring test misfires on short units like "r").
    if (label && units && !name.includes(`(${units})`)) name = `${name} (${units})`
    let unique = name, k = 2
    while (used.has(unique)) unique = `${name} ${k++}`
    used.add(unique)
    cols.push({ header: unique, values: Array.from(ys, (v) => (v == null || !isFinite(v) ? null : v)) })
  }
  return { columns: cols }
}

/** Columns of raw values (e.g. one per channel / group), possibly of
 *  different lengths — the shape ASTERISM turns into data sets. */
export function columnsTable(columns: { header: string; values: number[] }[]): AsterismTable {
  return { columns: columns.map((c) => ({ header: c.header, values: c.values })) }
}

function cellText(v: number | string | null | undefined, sep: string): string {
  if (v == null) return ''
  // 10 significant digits: plenty for any measurement, and it drops
  // float noise such as 5.000000000165983.
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(10))) : ''
  return v.includes(sep) || v.includes('"') || v.includes('\n') ? JSON.stringify(v) : v
}

function rowsOf(t: AsterismTable): number {
  return Math.max(0, ...t.columns.map((c) => c.values.length))
}

export function tableToCsv(t: AsterismTable): string {
  const n = rowsOf(t)
  const lines = [t.columns.map((c) => cellText(c.header, ',')).join(',')]
  for (let r = 0; r < n; r++) lines.push(t.columns.map((c) => cellText(c.values[r], ',')).join(','))
  return lines.join('\n') + '\n'
}

/** Values only (no header row): ASTERISM's paste fills cells from the
 *  selected cell, and a header row would land as an empty data row. */
export function tableToTsv(t: AsterismTable): string {
  const n = rowsOf(t)
  const lines: string[] = []
  for (let r = 0; r < n; r++) lines.push(t.columns.map((c) => cellText(c.values[r], '\t')).join('\t'))
  return lines.join('\n') + '\n'
}
