import React, { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { APData, APPerSweep } from '../../stores/appStore'
import { useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { usePlotMenu } from '../common/PlotMenu'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import {
  firingSummary, isisOf, isiHistogram, peakTimesIn, rateBins,
  type FiringSummary,
} from '../../utils/apSpontaneous'

/**
 * Counting-tab results for spontaneous AP runs (continuous recordings,
 * no stimulus). Replaces the F-I curve + rheobase of evoked runs with:
 *
 *   - left column: per-sweep firing table (rate, ISI mean / median /
 *     CV, LV) with a ``Trains`` sub-tab, same strip as evoked mode
 *   - right column: firing rate over time (adjustable bin) above an
 *     ISI histogram (linear or log ms axis)
 *
 * Everything is derived live from ``entry.perSpike`` via
 * ``utils/apSpontaneous.ts`` so manual add / remove updates the
 * numbers without a re-run.
 */

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Analysed time window of one sweep: detection bounds, with the
 *  end taken from the backend's reported duration when bounds_end is
 *  0 ("full sweep"). */
export function firingWindowFor(entry: APData, p: APPerSweep): [number, number] {
  const t0 = Math.max(0, entry.detection.bounds_start_s || 0)
  if (p.durationS != null && p.durationS > 0) return [t0, t0 + p.durationS]
  const end = entry.detection.bounds_end_s
  if (end > t0) return [t0, end]
  const last = p.peakTimes.length ? p.peakTimes[p.peakTimes.length - 1] : t0
  return [t0, Math.max(last, t0)]
}

export function firingRows(entry: APData): Array<{ sweep: number; window: [number, number]; s: FiringSummary }> {
  return entry.perSweep.map((p) => {
    const w = firingWindowFor(entry, p)
    return { sweep: p.sweep, window: w, s: firingSummary(peakTimesIn(entry.perSpike, p.sweep, w[0], w[1]), w[0], w[1]) }
  })
}

const fmt = (v: number | null | undefined, d: number) => (v == null || !isFinite(v) ? '—' : v.toFixed(d))

export function APFiringPanel({
  entry, previewSweep, setPreviewSweep, heightSignal,
  trainsEnabled, trainsCount, trainsSlot, onJumpToTime,
  rateBinS, onRateBinSChange,
}: {
  entry: APData | undefined
  previewSweep: number
  setPreviewSweep: (n: number) => void
  heightSignal?: number
  trainsEnabled: boolean
  trainsCount: number
  /** The Trains sub-tab body (shared with evoked mode). */
  trainsSlot: React.ReactNode
  /** Click on the rate plot → centre the trace viewer on this time. */
  onJumpToTime?: (t: number) => void
  /** Rate-over-time bin (s). Owned by the window so the CSV export
   *  uses the same bin as the plot. */
  rateBinS: number
  onRateBinSChange: (v: number) => void
}) {
  const [resultTab, setResultTab] = useState<'sweeps' | 'trains'>('sweeps')
  const trainsAvailable = trainsEnabled && trainsCount > 0
  const lastTrainsAvailRef = useRef(false)
  useEffect(() => {
    if (trainsAvailable && !lastTrainsAvailRef.current) setResultTab('trains')
    lastTrainsAvailRef.current = trainsAvailable
  }, [trainsAvailable])
  useEffect(() => {
    if (!trainsEnabled && resultTab === 'trains') setResultTab('sweeps')
  }, [trainsEnabled, resultTab])

  const rows = useMemo(() => (entry ? firingRows(entry) : []), [entry])
  const current = rows.find((r) => r.sweep === previewSweep) ?? rows[0]
  const times = useMemo(
    () => (entry && current ? peakTimesIn(entry.perSpike, current.sweep, current.window[0], current.window[1]) : []),
    [entry, current],
  )

  if (!entry || entry.perSweep.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Run to populate the firing statistics.
      </div>
    )
  }
  return (
    <div style={{ flex: 1, display: 'flex', gap: 6, minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
        <div className="segmented" style={{ alignSelf: 'flex-start', flexShrink: 0 }}>
          {(['sweeps', 'trains'] as const).map((k) => (
            <button key={k}
              className={resultTab === k ? 'active' : undefined}
              aria-selected={resultTab === k}
              onClick={() => setResultTab(k)}
              style={{ minWidth: 80 }}>
              {k === 'sweeps' ? 'Per sweep' : `Trains${trainsAvailable ? ` (${trainsCount})` : ''}`}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {resultTab === 'sweeps' && (
            <FiringTable rows={rows} previewSweep={previewSweep} onSelectSweep={setPreviewSweep} />
          )}
          {resultTab === 'trains' && trainsSlot}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <RatePlot times={times} window={current?.window ?? [0, 0]}
            binS={rateBinS} setBinS={onRateBinSChange}
            heightSignal={heightSignal} onJumpToTime={onJumpToTime} />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <IsiHistogramPlot times={times} heightSignal={heightSignal} />
        </div>
      </div>
    </div>
  )
}

const FIRING_HEADERS = ['Sweep', 'Spikes', 'Duration (s)', 'Rate (Hz)', 'Mean ISI (s)', 'Median ISI (s)', 'CV ISI', 'LV']

function FiringTable({
  rows, previewSweep, onSelectSweep,
}: {
  rows: Array<{ sweep: number; window: [number, number]; s: FiringSummary }>
  previewSweep: number
  onSelectSweep: (sweep: number) => void
}) {
  const sel = useRowSelection(rows.length)
  const rowToCells = (i: number): Array<string | number | null> => {
    const { sweep, s } = rows[i]
    return [sweep + 1, s.nSpikes, s.durationS, s.rateHz, s.meanIsiS, s.medianIsiS, s.cvIsi, s.lv]
  }
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(FIRING_HEADERS, sel.selectedIndexes.map(rowToCells)),
  })
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'auto', height: '100%' }}>
      <table className="data-table">
        <thead>
          <tr>{FIRING_HEADERS.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.sweep}
              onClick={(ev) => {
                sel.onRowClick(i, ev)
                if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) onSelectSweep(r.sweep)
              }}
              onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                if (!sel.isSelected(i)) sel.setSelected([i])
              })}
              style={{
                background: sel.isSelected(i) ? 'var(--accent-muted)'
                  : r.sweep === previewSweep ? 'var(--bg-selected)' : 'transparent',
              }}>
              <td className="num">{r.sweep + 1}</td>
              <td className="num">{r.s.nSpikes}</td>
              <td className="num">{fmt(r.s.durationS, 1)}</td>
              <td className="num">{fmt(r.s.rateHz, 3)}</td>
              <td className="num">{fmt(r.s.meanIsiS, 4)}</td>
              <td className="num">{fmt(r.s.medianIsiS, 4)}</td>
              <td className="num">{fmt(r.s.cvIsi, 3)}</td>
              <td className="num">{fmt(r.s.lv, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {copyMenu.menu}
    </div>
  )
}

/** Shared shell for the two small plots: header strip + uPlot that is
 *  rebuilt whenever its data changes (the app-wide mini-viewer rule). */
function MiniPlotFrame({
  title, controls, empty, children,
}: {
  title: string
  controls?: React.ReactNode
  empty: string | null
  children: React.ReactNode
}) {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-primary)', minHeight: 0,
    }}>
      <div className="viewer-header" style={{
        fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
        borderRadius: 'var(--radius) var(--radius) 0 0',
      }}>
        <span>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>{controls}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {empty ? (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 'var(--font-size-label)',
          }}>{empty}</div>
        ) : children}
      </div>
    </div>
  )
}

function useMiniPlot(
  build: (el: HTMLDivElement) => uPlot | null,
  deps: React.DependencyList,
  heightSignal?: number,
) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  useEffect(() => {
    const el = containerRef.current
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!el) return
    plotRef.current = build(el)
    return () => { if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, themeKey])
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const r = requestAnimationFrame(() => {
      const u = plotRef.current, el = containerRef.current
      if (u && el && el.clientWidth > 0 && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    return () => cancelAnimationFrame(r)
  }, [heightSignal])
  return { containerRef, plotRef }
}

function axis(label: string): uPlot.Axis {
  return {
    stroke: cssVar('--chart-axis'),
    grid: { stroke: cssVar('--chart-grid'), width: 1 },
    ticks: { stroke: cssVar('--chart-tick'), width: 1 },
    font: `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`,
    label, labelSize: 16,
    labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
  }
}

function RatePlot({
  times, window: win, binS, setBinS, heightSignal, onJumpToTime,
}: {
  times: number[]
  window: [number, number]
  binS: number
  setBinS: (v: number) => void
  heightSignal?: number
  onJumpToTime?: (t: number) => void
}) {
  const bins = useMemo(() => rateBins(times, win[0], win[1], binS), [times, win, binS])
  const jumpRef = useRef(onJumpToTime)
  jumpRef.current = onJumpToTime
  const empty = bins.t.length === 0 ? 'No analysed time window.' : null
  const { containerRef, plotRef } = useMiniPlot((el) => {
    if (bins.t.length === 0) return null
    // Step plot: repeat the last value at the window end so the final
    // bin is drawn across its full width.
    const xs = [...bins.t, win[1]]
    const ys = [...bins.rate, bins.rate[bins.rate.length - 1] ?? 0]
    const u = new uPlot({
      width: el.clientWidth || 300, height: Math.max(80, el.clientHeight || 120),
      legend: { show: false },
      scales: { x: { time: false }, y: { range: (_u, _lo, hi) => [0, Math.max(1, hi * 1.1)] } },
      axes: [axis('Time (s)'), axis('Rate (Hz)')],
      cursor: { drag: { x: false, y: false } },
      series: [{}, {
        stroke: cssVar('--trace-color-1'), width: 1.5,
        fill: cssVar('--accent-muted'),
        paths: uPlot.paths.stepped!({ align: 1 }),
        points: { show: false },
      }],
    }, [xs, ys], el)
    const over = el.querySelector<HTMLDivElement>('.u-over')
    if (over) {
      over.style.cursor = jumpRef.current ? 'pointer' : ''
      over.addEventListener('click', (ev) => {
        const rect = over.getBoundingClientRect()
        const t = u.posToVal(ev.clientX - rect.left, 'x')
        if (isFinite(t)) jumpRef.current?.(t)
      })
    }
    return u
  }, [bins, win[1]], heightSignal)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'ap-rate-over-time',
  })
  return (
    <MiniPlotFrame
      title="Rate over time"
      empty={empty}
      controls={(
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title="Bin width for the firing-rate histogram. Click the plot to jump the trace viewer there.">
          <span>Bin (s)</span>
          <NumInput value={binS} step={1} min={0.1}
            onChange={(v) => { if (v > 0) setBinS(v) }} style={{ width: 60 }} />
        </label>
      )}
    >
      <div ref={containerRef} onContextMenu={onContextMenu}
        style={{ position: 'absolute', inset: 0 }}>{menu}</div>
    </MiniPlotFrame>
  )
}

function IsiHistogramPlot({ times, heightSignal }: { times: number[]; heightSignal?: number }) {
  const [logX, setLogX] = useState(true)
  const hist = useMemo(() => isiHistogram(isisOf(times), { log: logX }), [times, logX])
  const empty = hist.counts.length === 0 ? 'Needs at least two spikes.' : null
  const { containerRef, plotRef } = useMiniPlot((el) => {
    if (hist.counts.length === 0) return null
    // Bar centres (geometric centre on the log axis).
    const xs = hist.edgesMs.map((e) => (hist.log ? e * 10 ** (hist.binMs / 2) : e + hist.binMs / 2))
    return new uPlot({
      width: el.clientWidth || 300, height: Math.max(80, el.clientHeight || 120),
      legend: { show: false },
      scales: {
        x: hist.log ? { time: false, distr: 3 } : { time: false },
        y: { range: (_u, _lo, hi) => [0, Math.max(1, hi * 1.1)] },
      },
      axes: [axis('ISI (ms)'), axis('Count')],
      cursor: { drag: { x: false, y: false } },
      series: [{}, {
        stroke: cssVar('--trace-color-1'), width: 1,
        fill: cssVar('--accent-muted'),
        paths: uPlot.paths.bars!({ size: [0.9, Infinity] }),
        points: { show: false },
      }],
    }, [xs, hist.counts], el)
  }, [hist], heightSignal)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    defaultName: 'ap-isi-histogram',
  })
  return (
    <MiniPlotFrame
      title="ISI distribution"
      empty={empty}
      controls={(
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={logX} onChange={(e) => setLogX(e.target.checked)} />
          <span>Log axis</span>
        </label>
      )}
    >
      <div ref={containerRef} onContextMenu={onContextMenu}
        style={{ position: 'absolute', inset: 0 }}>{menu}</div>
    </MiniPlotFrame>
  )
}

// ---------------------------------------------------------------------------
// CSV exports (spontaneous mode)
// ---------------------------------------------------------------------------

function download(csv: string, name: string) {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

const cell = (v: number | null, d: number) => (v == null || !isFinite(v) ? '' : v.toFixed(d))

export function exportApFiringCSV(entry: APData, fileName: string, group: number, series: number) {
  const rows = firingRows(entry)
  if (rows.length === 0) return
  const header = [
    'file', 'group', 'series', 'sweep', 'window_start_s', 'window_end_s',
    'spike_count', 'duration_s', 'spike_rate_hz',
    'mean_isi_s', 'median_isi_s', 'cv_isi', 'local_variance',
  ]
  const lines = rows.map((r) => [
    JSON.stringify(fileName), group, series, r.sweep + 1,
    r.window[0].toFixed(4), r.window[1].toFixed(4),
    r.s.nSpikes, r.s.durationS.toFixed(4), cell(r.s.rateHz, 5),
    cell(r.s.meanIsiS, 6), cell(r.s.medianIsiS, 6), cell(r.s.cvIsi, 4), cell(r.s.lv, 4),
  ].join(','))
  download([header.join(','), ...lines].join('\n'), fileName.replace(/\.[^.]+$/, '') + '_ap_firing.csv')
}

export function exportApRateCSV(
  entry: APData, fileName: string, group: number, series: number, binS: number,
) {
  const rows = firingRows(entry)
  if (rows.length === 0) return
  const header = ['file', 'group', 'series', 'sweep', 'bin_start_s', 'bin_s', 'spike_count', 'rate_hz']
  const lines: string[] = []
  for (const r of rows) {
    const times = peakTimesIn(entry.perSpike, r.sweep, r.window[0], r.window[1])
    const b = rateBins(times, r.window[0], r.window[1], binS)
    for (let i = 0; i < b.t.length; i++) {
      const w = Math.min(binS, r.window[1] - b.t[i])
      lines.push([
        JSON.stringify(fileName), group, series, r.sweep + 1,
        b.t[i].toFixed(4), binS, Math.round(b.rate[i] * w), b.rate[i].toFixed(5),
      ].join(','))
    }
  }
  download([header.join(','), ...lines].join('\n'), fileName.replace(/\.[^.]+$/, '') + `_ap_rate_${binS}s.csv`)
}
