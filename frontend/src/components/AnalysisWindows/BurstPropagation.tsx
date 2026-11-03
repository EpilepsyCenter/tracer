import React, { useEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { FieldBurstsData } from '../../stores/appStore'
import { useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { usePlotMenu } from '../common/PlotMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'
import { columnsTable } from '../../utils/plotExport'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import type {
  BurstDualForm, LagMethod, PropagationBlock, PropagationParams, PropagationPair,
} from '../../utils/propagation'

/**
 * Dual-site (e.g. CA3 → CA1) pieces of the Burst Detection window:
 * the second-channel settings card and the Propagation results panel.
 * Pairing and lags are computed by the backend (analysis/propagation.py).
 */

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const LAG_LABEL: Record<LagMethod, string> = {
  xcorr: 'Cross-correlation',
  onset: 'Onset',
  peak: 'Peak',
}

function fmt(v: number | null | undefined, d = 2): string {
  if (v == null || !isFinite(v)) return '—'
  return v.toFixed(d)
}
function pct(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—'
  return `${(v * 100).toFixed(0)}%`
}

// ------------------------------------------------------------------
// Settings card (left panel)
// ------------------------------------------------------------------

export function DualChannelCard({
  channels, refChannel, dual, setDual,
}: {
  channels: any[]
  refChannel: number
  dual: BurstDualForm
  setDual: (patch: Partial<BurstDualForm>) => void
}) {
  const others = channels.filter((c: any) => c.index !== refChannel)
  const pp = dual.propagation
  const setProp = (patch: Partial<PropagationParams>) => setDual({ propagation: { ...pp, ...patch } })
  const row = (label: string, child: React.ReactNode, hint?: string) => (
    <label title={hint} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
      <span style={{ flex: 1 }}>{label}</span>{child}
    </label>
  )
  if (channels.length < 2) {
    return (
      <div className="section-card">
        <div className="section-card-title">Second channel</div>
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
          This series has one channel. Dual-site propagation needs two simultaneously recorded channels.
        </div>
      </div>
    )
  }
  return (
    <div className="section-card">
      <div className="section-card-title">Second channel</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)' }}
        title="Detect discharges on a second channel too, pair them with this channel's, and measure the delay">
        <input type="checkbox" checked={dual.enabled}
          onChange={(e) => setDual({ enabled: e.target.checked })} />
        Dual-site propagation
      </label>
      {dual.enabled && (
        <>
          {row('Partner channel',
            <select value={dual.channel} onChange={(e) => setDual({ channel: Number(e.target.value) })}>
              {others.map((c: any) => <option key={c.index} value={c.index}>{c.label} ({c.units})</option>)}
            </select>)}
          {dual.channel === refChannel && (
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--warning)' }}>
              The partner is the same as the reference channel. Pick another.
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}
            title="Names used in tables, plots, exports and Cohort metric descriptions">
            <span style={{ flex: 1 }}>Names</span>
            <input type="text" value={dual.refLabel} onChange={(e) => setDual({ refLabel: e.target.value })}
              style={{ width: 52, fontSize: 'var(--font-size-label)' }} />
            <span>→</span>
            <input type="text" value={dual.partnerLabel} onChange={(e) => setDual({ partnerLabel: e.target.value })}
              style={{ width: 52, fontSize: 'var(--font-size-label)' }} />
          </div>
          {row('Pairing window (± ms)',
            <NumInput value={pp.max_lag_ms} min={1} onChange={(v) => v > 0 && setProp({ max_lag_ms: v })} style={{ width: 58 }} />,
            'A partner discharge is paired with a reference discharge when their peaks are at most this far apart. Closest peaks are paired first, one to one. Also the cross-correlation search range.')}
          {row('Main lag measure',
            <select value={pp.primary} onChange={(e) => setProp({ primary: e.target.value as LagMethod })}>
              <option value="xcorr">Cross-correlation</option>
              <option value="onset">Onset</option>
              <option value="peak">Peak</option>
            </select>,
            'Used for the lag histogram, the "leads" share and Cohort distributions. All three are always computed. Onset = when each discharge first reaches 20 % of its peak.')}
          {row('Polarity',
            <select value={pp.polarity} onChange={(e) => setProp({ polarity: e.target.value as any })}>
              <option value="auto">Auto (per discharge)</option>
              <option value="same">Same</option>
              <option value="opposite">Opposite</option>
            </select>,
            'Whether the partner\'s discharge has the same sign as the reference. Auto uses the sign of each detected peak.')}
          {row('Waveform window (ms)',
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <NumInput value={pp.xcorr_pre_ms} min={0} onChange={(v) => setProp({ xcorr_pre_ms: Math.max(0, v) })} style={{ width: 44 }} />
              <span>before,</span>
              <NumInput value={pp.xcorr_max_ms} min={10} onChange={(v) => v > 0 && setProp({ xcorr_max_ms: v })} style={{ width: 50 }} />
              <span>max</span>
            </span>,
            'Cross-correlation compares the two waveforms from this long before the reference onset to the end of the discharge, capped at the max.')}
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Lags are {dual.partnerLabel || 'partner'} − {dual.refLabel || 'reference'}: positive means{' '}
            {dual.refLabel || 'the reference'} leads. Results update automatically after detection or edits.
          </div>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------
// Results panel
// ------------------------------------------------------------------

export function PropagationPanel({
  entry, block, dual, stale, onSelectPair, onExport,
}: {
  entry: FieldBurstsData
  block: PropagationBlock | undefined
  dual: BurstDualForm
  stale: boolean
  onSelectPair: (sweep: number, t: number) => void
  onExport: () => void
}) {
  const res = block?.result
  const R = dual.refLabel || 'Reference'
  const P = dual.partnerLabel || 'Partner'
  if (!entry.partner) {
    return (
      <div style={{ padding: 12, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
        Press <strong>Run</strong> to detect discharges on both channels.
      </div>
    )
  }
  if (!res) {
    return (
      <div style={{ padding: 12, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
        Computing propagation…
      </div>
    )
  }
  const s = res.summary
  const prim = s.primary
  const pl = s.lagMs[prim]
  const tile = (label: string, value: React.ReactNode, hint?: string) => (
    <div title={hint} style={{
      padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--bg-primary)', minWidth: 96,
    }}>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>{label}</div>
      <div className="num" style={{ fontSize: 'var(--font-size-base, 13px)' }}>{value}</div>
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 }}>
      {stale && (
        <div className="notice notice-warning" style={{ flexShrink: 0 }}>Updating…</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0, alignItems: 'stretch' }}>
        {tile(`${R} discharges`, s.nRef)}
        {tile(`${P} discharges`, s.nPartner)}
        {tile('Paired', s.nPairs)}
        {tile(`Reached ${P}`, pct(s.propagationFraction), `Share of ${R} discharges with a ${P} discharge within the pairing window`)}
        {tile(`${P} only`, <>{s.nPartner - s.nPairs}{s.partnerOnlyPerMin != null && <span style={{ color: 'var(--text-muted)' }}> · {fmt(s.partnerOnlyPerMin, 2)}/min</span>}</>,
          `${P} discharges with no ${R} discharge within the window`)}
        {tile(`Lag (${LAG_LABEL[prim].toLowerCase()})`, <>{fmt(pl.median)} ms <span style={{ color: 'var(--text-muted)' }}>[{fmt(pl.q25, 1)}, {fmt(pl.q75, 1)}]</span></>,
          'Median and interquartile range')}
        {tile(`${R} leads`, pct(s.refLeadsFraction), `Share of pairs with a positive lag (${R} first)`)}
        {tile(`Amplitude ${P}/${R}`, fmt(s.ampRatio.median, 2), 'Median ratio of peak amplitudes')}
        <button className="btn btn-sm" style={{ marginLeft: 'auto', alignSelf: 'center' }} onClick={onExport}
          title="Pairs with their lags, plus the unpaired discharges of each channel">Export CSV</button>
      </div>
      <div style={{ display: 'flex', gap: 6, height: 200, flexShrink: 0 }}>
        <LagHistogram pairs={res.pairs} method={prim} refLabel={R} partnerLabel={P} />
        <AlignedAverage block={block!} refLabel={R} partnerLabel={P} />
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        Median lags: cross-correlation {fmt(s.lagMs.xcorr.median)} ms · onset {fmt(s.lagMs.onset.median)} ms ·
        peak {fmt(s.lagMs.peak.median)} ms. Median waveform match r = {fmt(s.xcorrR.median, 2)}.
        {s.nXcorrAtLimit > 0 && <span style={{ color: 'var(--warning)' }}> {s.nXcorrAtLimit} pair(s) hit the search limit; widen the pairing window.</span>}
      </div>
      <div style={{ flex: 1, minHeight: 80, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        <PairsTable pairs={res.pairs} refLabel={R} partnerLabel={P} onSelect={onSelectPair} />
      </div>
    </div>
  )
}

function PairsTable({
  pairs, refLabel, partnerLabel, onSelect,
}: {
  pairs: PropagationPair[]
  refLabel: string
  partnerLabel: string
  onSelect: (sweep: number, t: number) => void
}) {
  // Row selection + right-click "Copy as TSV", same as the other
  // results tables (click / shift-click / ⌘-click to select).
  const sel = useRowSelection(pairs.length)
  const headers = ['#', 'Sweep', `${refLabel} peak (s)`, `${partnerLabel} peak (s)`,
    'Xcorr lag (ms)', 'r', 'Onset lag (ms)', 'Peak lag (ms)', 'Amp ratio', 'Polarity']
  // Missing values copy as empty cells (shown as "—").
  const c = (v: number | null | undefined, d = 2) => (v == null || !isFinite(v) ? null : v.toFixed(d))
  const rowToCells = (i: number): Array<string | number | null> => {
    const p = pairs[i]
    return [
      i + 1, p.sweep + 1,
      c(p.refPeakS ?? p.refStartS, 3), c(p.partnerPeakS ?? p.partnerStartS, 3),
      p.xcorrAtLimit ? 'at limit' : c(p.xcorrLagMs),
      c(p.xcorrR), c(p.onsetLagMs), c(p.peakLagMs), c(p.ampRatio), p.polarity,
    ]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(headers, sel.selectedIndexes.map(rowToCells)),
  })
  return (
    <>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {pairs.map((p, i) => {
            const cells = rowToCells(i)
            return (
              <tr
                key={i}
                onClick={(ev) => {
                  sel.onRowClick(i, ev)
                  if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) onSelect(p.sweep, p.refPeakS ?? p.refStartS)
                }}
                onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                  if (!sel.isSelected(i)) sel.setSelected([i])
                })}
                style={{
                  cursor: 'pointer',
                  background: sel.isSelected(i) ? 'var(--accent-muted)' : 'transparent',
                }}
              >
                {cells.map((v, k) => (
                  <td key={k} className={k < 9 ? 'num' : undefined}
                    style={k === 4 && p.xcorrAtLimit ? { color: 'var(--warning)' } : undefined}>
                    {v ?? '—'}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {copyMenu.menu}
    </>
  )
}

function plotAxes() {
  const axis = {
    stroke: cssVar('--chart-axis'),
    grid: { stroke: cssVar('--chart-grid'), width: 1 },
    ticks: { stroke: cssVar('--chart-tick'), width: 1 },
    font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
    labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
  }
  return axis
}

function usePlot(build: (el: HTMLDivElement) => uPlot | null, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const themeKey = useThemeKey()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    plot.current?.destroy()
    plot.current = build(el)
    return () => { plot.current?.destroy(); plot.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, themeKey])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plot.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, plot }
}

function LagHistogram({
  pairs, method, refLabel, partnerLabel,
}: { pairs: PropagationPair[]; method: LagMethod; refLabel: string; partnerLabel: string }) {
  const lags = useMemo(() => pairs
    .map((p) => (method === 'xcorr' ? p.xcorrLagMs : method === 'onset' ? p.onsetLagMs : p.peakLagMs))
    .filter((v): v is number => v != null && isFinite(v)), [pairs, method])
  const { ref, plot } = usePlot((el) => {
    if (lags.length === 0) return null
    const lo = Math.min(...lags), hi = Math.max(...lags)
    // Freedman–Diaconis bin width, bounded to 5–60 bins.
    const sorted = [...lags].sort((a, b) => a - b)
    const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))]
    const iqr = q(0.75) - q(0.25)
    let w = iqr > 0 ? 2 * iqr / Math.cbrt(lags.length) : (hi - lo) / 10 || 1
    const nb = Math.max(5, Math.min(60, Math.ceil((hi - lo) / w) || 5))
    w = (hi - lo) / nb || 1
    const centres: number[] = [], counts: number[] = []
    for (let i = 0; i < nb; i++) { centres.push(lo + (i + 0.5) * w); counts.push(0) }
    for (const v of lags) counts[Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / w)))]++
    const axis = plotAxes()
    const opts: uPlot.Options = {
      width: el.clientWidth || 300, height: el.clientHeight || 180,
      legend: { show: false },
      scales: { x: { time: false, range: () => [lo - w, hi + w] }, y: { range: (_u, _a, b) => [0, Math.max(1, b * 1.1)] } },
      axes: [{ ...axis, label: `${LAG_LABEL[method]} lag, ${partnerLabel} − ${refLabel} (ms)` }, { ...axis, size: 40, label: 'Pairs' }],
      cursor: { drag: { x: false, y: false } },
      series: [{}, {
        // Theme colours are oklch(); translucency via the series alpha.
        label: 'pairs', fill: cssVar('--accent'), stroke: cssVar('--accent'), width: 1, alpha: 0.7,
        paths: uPlot.paths.bars!({ size: [0.9, 100] }), points: { show: false },
        vectorStyle: 'bars',
      } as uPlot.Series],
      hooks: {
        draw: [(u: uPlot) => {
          // Zero line: left of it the partner leads.
          const ctx = u.ctx
          const x0 = u.valToPos(0, 'x', true)
          if (x0 < u.bbox.left || x0 > u.bbox.left + u.bbox.width) return
          ctx.save()
          ctx.strokeStyle = cssVar('--text-muted')
          ctx.setLineDash([4, 3])
          ctx.beginPath(); ctx.moveTo(x0, u.bbox.top); ctx.lineTo(x0, u.bbox.top + u.bbox.height); ctx.stroke()
          ctx.restore()
        }],
      },
    }
    const attach = attachHoverCoords(opts, { xUnit: 'ms', xDigits: 2, yDigits: 0 })
    const u = new uPlot(opts, [centres, counts], el)
    attach(el)
    return u
  }, [lags, method, refLabel, partnerLabel])
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plot.current?.ctx?.canvas ?? null,
    getUplot: () => plot.current ?? null, defaultName: 'propagation-lags',
    // Raw per-pair lags, not bin counts.
    asterism: () => lags.length === 0 ? null
      : columnsTable([{ header: `${LAG_LABEL[method]} lag, ${partnerLabel} − ${refLabel} (ms)`, values: lags }]),
  })
  return (
    <div ref={ref} onContextMenu={onContextMenu} style={{
      flex: 1, minWidth: 0, position: 'relative',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-primary)',
    }}>
      {menu}
      {lags.length === 0 && <div style={{ padding: 10, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>No lags yet.</div>}
    </div>
  )
}

function AlignedAverage({
  block, refLabel, partnerLabel,
}: { block: PropagationBlock; refLabel: string; partnerLabel: string }) {
  const avg = block.result?.average ?? null
  const units = block.result?.unitsRef ?? ''
  const { ref, plot } = usePlot((el) => {
    if (!avg) return null
    const axis = plotAxes()
    const cR = cssVar('--trace-color-1'), cP = cssVar('--trace-color-3')
    const opts: uPlot.Options = {
      width: el.clientWidth || 300, height: el.clientHeight || 180,
      legend: { show: false },
      scales: { x: { time: false }, y: {} },
      axes: [
        { ...axis, label: `Time from ${refLabel} onset (ms)` },
        { ...axis, size: 55, label: units },
      ],
      cursor: { drag: { x: true, y: false } },
      series: [
        {},
        // ±SEM bands are painted in a hook; ``vectorBand`` carries them
        // into vector exports.
        { label: refLabel, stroke: cR, width: 1.5, points: { show: false },
          vectorBand: { lo: avg.refMean.map((m, i) => m - avg.refSem[i]), hi: avg.refMean.map((m, i) => m + avg.refSem[i]) } } as uPlot.Series,
        { label: partnerLabel, stroke: cP, width: 1.5, points: { show: false },
          vectorBand: { lo: avg.partnerMean.map((m, i) => m - avg.partnerSem[i]), hi: avg.partnerMean.map((m, i) => m + avg.partnerSem[i]) } } as uPlot.Series,
      ],
      hooks: {
        drawAxes: [(u: uPlot) => {
          // ± SEM bands under the mean lines.
          const ctx = u.ctx
          const band = (mean: number[], sem: number[], color: string) => {
            ctx.beginPath()
            for (let i = 0; i < mean.length; i++) {
              const x = u.valToPos(avg.tMs[i], 'x', true), y = u.valToPos(mean[i] + sem[i], 'y', true)
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
            }
            for (let i = mean.length - 1; i >= 0; i--) {
              ctx.lineTo(u.valToPos(avg.tMs[i], 'x', true), u.valToPos(mean[i] - sem[i], 'y', true))
            }
            ctx.closePath()
            ctx.fillStyle = color
            ctx.globalAlpha = 0.18
            ctx.fill()
            ctx.globalAlpha = 1
          }
          ctx.save()
          ctx.beginPath()
          ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height)
          ctx.clip()
          band(avg.refMean, avg.refSem, cR)
          band(avg.partnerMean, avg.partnerSem, cP)
          ctx.restore()
        }],
      },
    }
    const attach = attachHoverCoords(opts, { xUnit: 'ms', xDigits: 1, yDigits: 3 })
    const u = new uPlot(opts, [avg.tMs, avg.refMean, avg.partnerMean], el)
    attach(el)
    return u
  }, [avg, refLabel, partnerLabel, units])
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plot.current?.ctx?.canvas ?? null,
    getUplot: () => plot.current ?? null, defaultName: 'propagation-average',
  })
  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-primary)',
    }}>
      <div style={{ display: 'flex', gap: 10, padding: '2px 8px', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 3, background: 'var(--trace-color-1)' }} />{refLabel}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 3, background: 'var(--trace-color-3)' }} />
          {partnerLabel}{avg?.partnerFlipped ? ' (sign flipped)' : ''}
        </span>
        {avg && <span style={{ marginLeft: 'auto' }}>mean ± SEM · n = {avg.n}</span>}
      </div>
      <div ref={ref} onContextMenu={onContextMenu} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {menu}
        {!avg && <div style={{ padding: 10, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>No paired discharges.</div>}
      </div>
    </div>
  )
}
