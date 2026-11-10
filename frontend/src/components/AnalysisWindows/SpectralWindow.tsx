import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore } from '../../stores/appStore'
import { useThemeKey } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { ViewportBar, ViewportSlider, type Viewport } from '../common/ContinuousViewport'
import { usePlotMenu } from '../common/PlotMenu'
import { attachHoverCoords } from '../../utils/hoverCoords'
import { useRowSelection, buildTSV } from '../../utils/rowSelection'
import { useRowCopyMenu } from '../common/RowCopyMenu'
import {
  type SpectralBand, type SpectralData, type SpectralParams, type SpectralRegion,
  type SpectralRegionResult, type SpectralTimecourse,
  DEFAULT_SPECTRAL_BANDS, defaultSpectralData, describeRegion, newRegionId,
  powerUnits, spectralSignature, withSpectralDefaults,
  timecourseFromBackend, buildTimecourseCSV, downloadText,
} from '../../utils/spectral'

/**
 * Spectral analysis window.
 *
 * Left: named regions + PSD settings. Right: the trace (continuous
 * viewer, shift-drag marks a region, region edges drag to resize) with a
 * spectrogram of the visible stretch underneath, then tabs for the
 * overlaid spectra, band powers and line noise.
 *
 * The form (channel, params, regions) and the last results live in one
 * per-series store entry (`spectralAnalyses[g:s]`) that is broadcast and
 * persisted in the sidecar, so there is no local copy to rehydrate.
 */

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Region colours cycle through the theme's trace colours. */
function regionColorVar(i: number): string {
  return `--trace-color-${(i % 5) + 1}`
}

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

type ResultTab = 'spectrum' | 'bands' | 'line' | 'time' | 'coupling'

/** Compact number formatting for powers that span many decades. */
function fmtNum(v: number | null | undefined, digits = 3): string {
  if (v == null || !isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e4 || a < 1e-2) return v.toExponential(digits - 1)
  return Number(v.toPrecision(digits)).toString()
}

function fmtDb(db: number): string {
  const r = Number(db.toFixed(1))
  return `${r > 0 ? '+' : ''}${(r === 0 ? 0 : r).toFixed(1)} dB`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—'
  return `${(v * 100).toFixed(1)}%`
}

export function SpectralWindow({
  backendUrl, fileInfo, currentSweep, mainGroup, mainSeries, mainTrace,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  currentSweep: number
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
}) {
  const {
    spectralAnalyses, excludedSweeps,
    setSpectralForm, runSpectral, clearSpectralResults,
    exportSpectralCSV, exportSpectralPsdCSV,
    loading, error, setError,
  } = useAppStore()

  // ---- Scope: start from the main window's selection, then independent.
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
  }, [mainGroup, mainSeries])

  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const key = `${group}:${series}`
  const stored = spectralAnalyses[key]
  const channels: any[] = fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
  const fallbackChannel = Math.min(mainTrace ?? 0, Math.max(0, channels.length - 1))
  const entry: SpectralData = useMemo(
    () => stored
      ? { ...stored, params: withSpectralDefaults(stored.params) }
      : defaultSpectralData(group, series, fallbackChannel),
    [stored, group, series, fallbackChannel],
  )
  const params = entry.params
  const channel = entry.channel < channels.length || channels.length === 0 ? entry.channel : 0
  const channelUnits: string = channels.find((c: any) => c.index === channel)?.units ?? ''
  const excluded = excludedSweeps[key]
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  const multiSweep = totalSweeps > 1

  const patchForm = useCallback(
    (patch: Partial<Pick<SpectralData, 'channel' | 'params' | 'regions'>>) => {
      setSpectralForm(group, series, patch, fallbackChannel)
    },
    [group, series, fallbackChannel, setSpectralForm],
  )
  const setParams = useCallback(
    (patch: Partial<SpectralParams>) => patchForm({ params: { ...params, ...patch } }),
    [params, patchForm],
  )
  const setRegions = useCallback(
    (regions: SpectralRegion[]) => patchForm({ regions }),
    [patchForm],
  )

  const stale = !!entry.results && entry.runSignature !== spectralSignature(entry, excluded)

  // ---- Preview sweep + viewport.
  const [previewSweep, setPreviewSweep] = useState(currentSweep)
  const mainSyncedRef = useRef(false)
  useEffect(() => {
    if (mainSyncedRef.current) return
    mainSyncedRef.current = true
    setPreviewSweep(currentSweep)
  }, [currentSweep])
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, Math.max(0, totalSweeps - 1))))
  }, [key, totalSweeps])
  const [viewport, setViewport] = useState<Viewport>({ tStart: 0, tEnd: 60 })
  // A jump from the over-time plot sets the sweep AND the view; the
  // sweep-change reset below must not override that view.
  const pendingViewRef = useRef<Viewport>(null)
  useEffect(() => {
    if (pendingViewRef.current) {
      setViewport(pendingViewRef.current)
      pendingViewRef.current = null
      return
    }
    setViewport({ tStart: 0, tEnd: 60 })
  }, [previewSweep, key])
  const [sweepDuration, setSweepDuration] = useState(0)
  const [zeroOffset, setZeroOffset] = useState(false)
  const [showSpectrogram, setShowSpectrogram] = useState(true)
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  const [tab, setTab] = useState<ResultTab>('spectrum')
  useEffect(() => { if (tab === 'coupling' && !params.coupling_enabled) setTab('spectrum') }, [tab, params.coupling_enabled])

  // ---- Splitters (persisted in Electron prefs, like the other windows).
  const [miniHeight, setMiniHeight] = useState(420)
  const [leftPanelWidth, setLeftPanelWidth] = useState(330)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const ui = prefs?.spectralWindowUI
        if (cancelled || !ui) return
        if (typeof ui.leftPanelWidth === 'number' && ui.leftPanelWidth >= 240 && ui.leftPanelWidth <= 520) {
          setLeftPanelWidth(ui.leftPanelWidth)
        }
        if (typeof ui.miniHeight === 'number' && ui.miniHeight >= 200 && ui.miniHeight <= 900) {
          setMiniHeight(ui.miniHeight)
        }
        if (typeof ui.showSpectrogram === 'boolean') setShowSpectrogram(ui.showSpectrogram)
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  const writeUIPref = useCallback(async (patch: Record<string, any>) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      await api.patchPreferences({ spectralWindowUI: { ...(prefs.spectralWindowUI ?? {}), ...patch } })
    } catch { /* ignore */ }
  }, [])
  const startDrag = (
    e: React.MouseEvent, axis: 'x' | 'y', start: number,
    lo: number, hi: number, apply: (v: number) => void, persistKey: string,
  ) => {
    e.preventDefault()
    const origin = axis === 'x' ? e.clientX : e.clientY
    let latest = start
    const onMove = (ev: MouseEvent) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - origin
      latest = Math.max(lo, Math.min(hi, start + d))
      apply(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeUIPref({ [persistKey]: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ---- Region actions.
  const regionCount = entry.regions.length
  const nextRegionLabel = () => {
    const used = new Set(entry.regions.map((r) => r.label))
    for (let i = 1; ; i++) if (!used.has(`Region ${i}`)) return `Region ${i}`
  }
  const addRegion = (r: Omit<SpectralRegion, 'id' | 'label'>, label?: string) => {
    const region: SpectralRegion = { id: newRegionId(), label: label ?? nextRegionLabel(), ...r }
    setRegions([...entry.regions, region])
    setSelectedRegionId(region.id)
  }
  const onCreateRegion = useCallback((t0: number, t1: number) => {
    addRegion({
      sweepFrom: multiSweep ? previewSweep : null,
      sweepTo: multiSweep ? previewSweep : null,
      tStart: Math.max(0, t0), tEnd: t1,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.regions, multiSweep, previewSweep])
  const onResizeRegion = useCallback((id: string, t0: number, t1: number) => {
    setRegions(entry.regions.map((r) => r.id === id
      ? { ...r, tStart: Math.max(0, Math.min(t0, t1)), tEnd: Math.max(t0, t1) } : r))
  }, [entry.regions, setRegions])
  const addRegionFromView = () => {
    const v = viewport ?? { tStart: 0, tEnd: sweepDuration }
    const t1 = sweepDuration > 0 ? Math.min(v.tEnd, sweepDuration) : v.tEnd
    onCreateRegion(Math.max(0, v.tStart), t1)
  }

  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  /** Centre the trace view on a time in a sweep (from the over-time plot). */
  const jumpTo = useCallback((sw: number, t: number) => {
    const v = viewportRef.current
    const w = v ? v.tEnd - v.tStart : 60
    const next = { tStart: Math.max(0, t - w / 2), tEnd: Math.max(0, t - w / 2) + w }
    if (sw !== previewSweep) {
      pendingViewRef.current = next
      setPreviewSweep(sw)
    } else {
      setViewport(next)
    }
  }, [previewSweep])

  const onRun = async () => {
    if (!stored) setSpectralForm(group, series, {}, fallbackChannel)
    await runSpectral(group, series)
    setTab((t) => t)
  }

  const resultsByRegion = useMemo(() => {
    const m = new Map<string, SpectralRegionResult>()
    for (const r of entry.results ?? []) m.set(r.regionId, r)
    return m
  }, [entry.results])

  const unitsForDisplay = (entry.results ?? []).find((r) => r.units)?.units || channelUnits

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 10, gap: 10, minHeight: 0 }}>
      <TopBar
        fileInfo={fileInfo}
        group={group} setGroup={setGroup}
        series={series} setSeries={setSeries}
        channels={channels} channel={channel}
        setChannel={(c) => patchForm({ channel: c })}
        previewSweep={previewSweep} setPreviewSweep={setPreviewSweep}
        totalSweeps={totalSweeps}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* LEFT PANEL */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)', padding: 8,
          borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
        }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
            <RegionsCard
              regions={entry.regions}
              selectedId={selectedRegionId}
              onSelect={setSelectedRegionId}
              onChange={setRegions}
              multiSweep={multiSweep}
              totalSweeps={totalSweeps}
              resultsByRegion={resultsByRegion}
              onAddWhole={() => addRegion(
                { sweepFrom: null, sweepTo: null, tStart: null, tEnd: null },
                entry.regions.some((r) => r.label === 'Whole series') ? undefined : 'Whole series',
              )}
              onAddFromView={addRegionFromView}
            />
            <CouplingCard params={params} setParams={setParams} channels={channels} refChannel={channel} />
            <SpectrumCard params={params} setParams={setParams} />
            <BandsCard params={params} setParams={setParams} />
            <LineNoiseCard params={params} setParams={setParams} />
            <PrefilterCard params={params} setParams={setParams} />
          </div>

          <div className="section-card" style={{ flexShrink: 0 }}>
            <button className="btn btn-primary btn-lg" onClick={onRun}
              disabled={loading || !fileInfo || regionCount === 0}
              style={{ width: '100%' }}
              title="Compute the spectrum of every region">
              {loading ? 'Running…' : regionCount > 1 ? `Run ${regionCount} regions` : 'Run'}
            </button>
            <div style={{ display: 'flex', gap: 6, marginTop: 2, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <button className="btn" onClick={() => clearSpectralResults(group, series)}
                disabled={!entry.results}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>Clear</button>
              <button className="btn" onClick={() => exportSpectralCSV()}
                disabled={!Object.values(spectralAnalyses).some((e) => (e.results ?? []).length > 0)}
                title="Band powers, RMS and line noise for every series with results"
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>Band CSV</button>
              <button className="btn" onClick={() => exportSpectralPsdCSV(group, series)}
                disabled={!entry.results}
                title="The spectra of this series: frequency × region"
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>Spectra CSV</button>
            </div>
          </div>
          {error && (
            <div className="notice notice-error" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>⚠ {error}</span>
              <button className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
        </div>

        <Splitter axis="x" onMouseDown={(e) => startDrag(e, 'x', leftPanelWidth, 240, 520, setLeftPanelWidth, 'leftPanelWidth')} />

        {/* RIGHT PANEL */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, paddingLeft: 8 }}>
          <div style={{ height: miniHeight, minHeight: 200, flexShrink: 0 }}>
            <SpectralViewer
              backendUrl={backendUrl}
              group={group} series={series} channel={channel} sweep={previewSweep}
              viewport={viewport} setViewport={setViewport}
              onDuration={setSweepDuration}
              params={params} setParams={setParams}
              regions={entry.regions}
              selectedRegionId={selectedRegionId}
              onSelectRegion={setSelectedRegionId}
              onCreateRegion={onCreateRegion}
              onResizeRegion={onResizeRegion}
              onAddFromView={addRegionFromView}
              zeroOffset={zeroOffset} onZeroOffsetChange={setZeroOffset}
              showSpectrogram={showSpectrogram}
              onShowSpectrogramChange={(v) => { setShowSpectrogram(v); writeUIPref({ showSpectrogram: v }) }}
              heightSignal={miniHeight}
            />
          </div>

          <Splitter axis="y" onMouseDown={(e) => startDrag(e, 'y', miniHeight, 200, 900, setMiniHeight, 'miniHeight')} />

          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <div className="segmented">
                {([['spectrum', 'Spectrum'], ['bands', 'Band power'], ['line', 'Line noise'], ['time', 'Over time'],
                  ...(params.coupling_enabled ? [['coupling', 'Coupling'] as const] : [])] as const).map(([k, label]) => (
                  <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
                ))}
              </div>
              {entry.results && (
                <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                  {entry.results.filter((r) => !r.error).length} of {entry.results.length} regions
                  {entry.results[0] && !entry.results[0].error && (
                    <> · resolution <span className="num">{fmtNum(entry.results[0].freqResHz)}</span> Hz</>
                  )}
                </span>
              )}
            </div>
            {stale && tab !== 'time' && (
              <div className="notice notice-warning" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>Settings, regions or excluded sweeps changed since these results were computed.</span>
                <button className="btn btn-sm" onClick={onRun} disabled={loading}>Run again</button>
              </div>
            )}
            <div style={{
              flex: 1, minHeight: 0, overflow: 'auto',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
              background: 'var(--bg-primary)',
            }}>
              {tab === 'time' ? (
                <BandTimecourse
                  backendUrl={backendUrl}
                  group={group} series={series} channel={channel}
                  params={params} setParams={setParams}
                  excluded={excluded}
                  regions={entry.regions}
                  onJump={jumpTo}
                  heightSignal={miniHeight}
                />
              ) : !entry.results ? (
                <EmptyResults />
              ) : tab === 'spectrum' ? (
                <PsdPlot
                  results={entry.results}
                  regions={entry.regions}
                  params={params}
                  units={unitsForDisplay}
                  heightSignal={miniHeight}
                />
              ) : tab === 'coupling' ? (
                <CouplingPanel results={entry.results} regions={entry.regions} params={params} heightSignal={miniHeight} />
              ) : tab === 'bands' ? (
                <BandTable results={entry.results} regions={entry.regions} params={params} units={unitsForDisplay} />
              ) : (
                <LineNoiseTable results={entry.results} regions={entry.regions} params={params} units={unitsForDisplay} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// Layout bits
// ------------------------------------------------------------------

function Splitter({ axis, onMouseDown }: { axis: 'x' | 'y'; onMouseDown: (e: React.MouseEvent) => void }) {
  const vertical = axis === 'x'
  return (
    <div onMouseDown={onMouseDown} title="Drag to resize" style={{
      [vertical ? 'width' : 'height']: 3, flexShrink: 0,
      cursor: vertical ? 'col-resize' : 'row-resize',
      background: 'var(--border)', position: 'relative',
    }}>
      <div style={{
        position: 'absolute',
        ...(vertical
          ? { top: '50%', left: 0, transform: 'translateY(-50%)', width: 2, height: 40 }
          : { left: '50%', top: 0, transform: 'translateX(-50%)', width: 40, height: 2 }),
        background: 'var(--text-muted)', borderRadius: 1, opacity: 0.5,
      }} />
    </div>
  )
}

function EmptyResults() {
  return (
    <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'var(--font-size-label)', lineHeight: 1.6 }}>
      No results yet. Mark regions on the trace (shift-drag, or <em>Add from view</em>), then press <strong>Run</strong>.
      <br />
      Each sweep in a region is analysed separately and the spectra are pooled, so rhythms that
      aren't locked to the sweep start are kept.
    </div>
  )
}

function TopBar({
  fileInfo, group, setGroup, series, setSeries, channels, channel, setChannel,
  previewSweep, setPreviewSweep, totalSweeps,
}: {
  fileInfo: FileInfo | null
  group: number; setGroup: (n: number) => void
  series: number; setSeries: (n: number) => void
  channels: any[]; channel: number; setChannel: (n: number) => void
  previewSweep: number
  setPreviewSweep: React.Dispatch<React.SetStateAction<number>>
  totalSweeps: number
}) {
  const groups = fileInfo?.groups ?? []
  const seriesList = fileInfo?.groups?.[group]?.series ?? []
  return (
    <div style={{
      display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
      background: 'var(--bg-secondary)', padding: '6px 10px',
      borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
    }}>
      <Field label="Group">
        <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
          {groups.map((g: any, i: number) => <option key={i} value={i}>{g.label || `G${i + 1}`}</option>)}
        </select>
      </Field>
      <Field label="Series">
        <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
          {seriesList.map((s: any, i: number) => (
            <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
          ))}
        </select>
      </Field>
      <Field label="Channel">
        <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={channels.length === 0}>
          {channels.map((c: any) => <option key={c.index} value={c.index}>{c.label} ({c.units})</option>)}
        </select>
      </Field>
      <Field label="Sweep (preview)">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <button className="btn btn-compact" onClick={() => setPreviewSweep((s) => Math.max(0, s - 1))}
            disabled={previewSweep <= 0 || totalSweeps === 0} title="Previous sweep">←</button>
          <span className="num" style={{ minWidth: 58, textAlign: 'center', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
            {totalSweeps > 0 ? `${previewSweep + 1} / ${totalSweeps}` : '— / —'}
          </span>
          <button className="btn btn-compact" onClick={() => setPreviewSweep((s) => Math.min(totalSweeps - 1, s + 1))}
            disabled={previewSweep >= totalSweeps - 1 || totalSweeps === 0} title="Next sweep">→</button>
        </span>
      </Field>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label title={hint} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
    }}>
      <span style={{ flex: 1 }}>{label}</span>
      {children}
    </label>
  )
}

// ------------------------------------------------------------------
// Left-panel cards
// ------------------------------------------------------------------

function RegionsCard({
  regions, selectedId, onSelect, onChange, multiSweep, totalSweeps,
  resultsByRegion, onAddWhole, onAddFromView,
}: {
  regions: SpectralRegion[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (r: SpectralRegion[]) => void
  multiSweep: boolean
  totalSweeps: number
  resultsByRegion: Map<string, SpectralRegionResult>
  onAddWhole: () => void
  onAddFromView: () => void
}) {
  const update = (id: string, patch: Partial<SpectralRegion>) =>
    onChange(regions.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const remove = (id: string) => {
    onChange(regions.filter((r) => r.id !== id))
    if (selectedId === id) onSelect(null)
  }
  return (
    <div className="section-card">
      <div className="section-card-title">Regions</div>
      {regions.length === 0 && (
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
          No regions. Shift-drag on the trace to mark one.
        </div>
      )}
      {regions.map((r, i) => {
        const sel = r.id === selectedId
        const res = resultsByRegion.get(r.id)
        return (
          <div key={r.id} style={{
            border: `1px solid ${sel ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)', padding: '4px 6px',
            display: 'flex', flexDirection: 'column', gap: 4,
            background: sel ? 'var(--bg-active)' : 'transparent',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => onSelect(sel ? null : r.id)}>
              <span style={{
                width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                background: `var(${regionColorVar(i)})`,
              }} />
              <input
                type="text" value={r.label}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => update(r.id, { label: e.target.value })}
                style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-label)' }}
              />
              <button className="icon-btn" title="Remove region"
                onClick={(e) => { e.stopPropagation(); remove(r.id) }}>×</button>
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', cursor: 'pointer' }}
              onClick={() => onSelect(sel ? null : r.id)}>
              {describeRegion(multiSweep ? r : { ...r, sweepFrom: null, sweepTo: null }).replace(/^all sweeps · /, multiSweep ? 'all sweeps · ' : '')}
              {res?.error && <span style={{ color: 'var(--error)' }}> · {res.error}</span>}
              {!res?.error && res?.warnings?.map((w, i) => (
                <span key={i} style={{ color: 'var(--warning)' }}> · {w}</span>
              ))}
            </div>
            {sel && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 2 }}>
                {multiSweep && (
                  <RangeRow
                    label="Sweeps"
                    allLabel="All"
                    from={r.sweepFrom != null ? r.sweepFrom + 1 : null}
                    to={r.sweepTo != null ? r.sweepTo + 1 : null}
                    min={1} max={totalSweeps} integer
                    onChange={(from, to) => update(r.id, {
                      sweepFrom: from != null ? from - 1 : null,
                      sweepTo: to != null ? to - 1 : null,
                    })}
                  />
                )}
                <RangeRow
                  label="Time (s)"
                  allLabel="Full"
                  from={r.tStart} to={r.tEnd} min={0}
                  onChange={(from, to) => update(r.id, { tStart: from, tEnd: to })}
                />
              </div>
            )}
          </div>
        )
      })}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm" style={{ flex: 1 }} onClick={onAddFromView}
          title="New region covering the visible stretch of the previewed sweep">Add from view</button>
        <button className="btn btn-sm" style={{ flex: 1 }} onClick={onAddWhole}
          title="New region covering every sweep, full length">Add whole series</button>
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        Shift-drag on the trace marks a region; drag its edges to adjust.
      </div>
    </div>
  )
}

/** "from – to" pair where both ends can be left open (= All / Full). */
function RangeRow({
  label, allLabel, from, to, min, max, integer, onChange,
}: {
  label: string
  allLabel: string
  from: number | null
  to: number | null
  min?: number
  max?: number
  integer?: boolean
  onChange: (from: number | null, to: number | null) => void
}) {
  const all = from == null && to == null
  const clean = (v: number) => {
    let x = integer ? Math.round(v) : v
    if (min != null) x = Math.max(min, x)
    if (max != null) x = Math.min(max, x)
    return x
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
      <span style={{ width: 52 }}>{label}</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input type="checkbox" checked={all}
          onChange={(e) => e.target.checked
            ? onChange(null, null)
            : onChange(min ?? 0, max ?? (integer ? 1 : 10))} />
        {allLabel}
      </label>
      {!all && (
        <>
          <NumInput value={from ?? (min ?? 0)} decimals={integer ? 0 : 3}
            onChange={(v) => onChange(clean(v), to)} style={{ width: 64 }} />
          <span>–</span>
          <NumInput value={to ?? (max ?? 0)} decimals={integer ? 0 : 3}
            onChange={(v) => onChange(from, clean(v))} style={{ width: 64 }} />
        </>
      )}
    </div>
  )
}

function CouplingCard({ params, setParams, channels, refChannel }: {
  params: SpectralParams
  setParams: (p: Partial<SpectralParams>) => void
  channels: any[]
  refChannel: number
}) {
  const others = channels.filter((c: any) => c.index !== refChannel)
  if (channels.length < 2) return null
  const partnerOk = params.coupling_channel !== refChannel && others.some((c: any) => c.index === params.coupling_channel)
  return (
    <div className="section-card">
      <div className="section-card-title">Second channel</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)' }}
        title="Coherence, wPLI and cross-correlation between this channel and a partner, on the same regions">
        <input type="checkbox" checked={params.coupling_enabled}
          onChange={(e) => setParams({
            coupling_enabled: e.target.checked,
            ...(e.target.checked && !partnerOk && others[0] ? { coupling_channel: others[0].index } : {}),
          })} />
        Coupling with a second channel
      </label>
      {params.coupling_enabled && (
        <>
          <Row label="Partner channel">
            <select value={params.coupling_channel} onChange={(e) => setParams({ coupling_channel: Number(e.target.value) })}>
              {others.map((c: any) => <option key={c.index} value={c.index}>{c.label} ({c.units})</option>)}
            </select>
          </Row>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
            <span style={{ flex: 1 }}>Names</span>
            <input type="text" value={params.coupling_ref_label} onChange={(e) => setParams({ coupling_ref_label: e.target.value })}
              style={{ width: 52, fontSize: 'var(--font-size-label)' }} />
            <span>→</span>
            <input type="text" value={params.coupling_partner_label} onChange={(e) => setParams({ coupling_partner_label: e.target.value })}
              style={{ width: 52, fontSize: 'var(--font-size-label)' }} />
          </div>
          <Row label="Cross-corr. band (Hz)" hint="Band-pass applied to both channels before cross-correlation (0 = edge off)">
            <NumInput value={params.coupling_xcorr_low} min={0} onChange={(v) => setParams({ coupling_xcorr_low: Math.max(0, v) })} style={{ width: 46 }} />
            <span>–</span>
            <NumInput value={params.coupling_xcorr_high} min={0} onChange={(v) => setParams({ coupling_xcorr_high: Math.max(0, v) })} style={{ width: 50 }} />
          </Row>
          <Row label="Max lag (± ms)" hint="Cross-correlation search range">
            <NumInput value={params.coupling_max_lag_ms} min={1} onChange={(v) => v > 0 && setParams({ coupling_max_lag_ms: v })} style={{ width: 58 }} />
          </Row>
          <Row label="Delay needs coherence ≥" hint="Phase-slope delays are reported only for bands whose mean coherence reaches this">
            <NumInput value={params.coupling_min_coherence} min={0} max={1} onChange={(v) => setParams({ coupling_min_coherence: Math.max(0, Math.min(1, v)) })} style={{ width: 52 }} />
          </Row>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Lags are {params.coupling_partner_label || 'partner'} − {params.coupling_ref_label || 'reference'}:
            positive means {params.coupling_ref_label || 'the reference'} leads. Uses the Welch segment settings below.
          </div>
        </>
      )}
    </div>
  )
}

function SpectrumCard({ params, setParams }: { params: SpectralParams; setParams: (p: Partial<SpectralParams>) => void }) {
  const welch = params.method === 'welch'
  const res = welch && params.segment_s > 0 ? 1 / params.segment_s : null
  return (
    <div className="section-card">
      <div className="section-card-title">Spectrum</div>
      <Row label="Method" hint="Welch averages many overlapping segments (smooth, lower resolution). The periodogram uses each sweep's region whole (finest resolution, noisy).">
        <select value={params.method} onChange={(e) => setParams({ method: e.target.value as any })}>
          <option value="welch">Welch</option>
          <option value="periodogram">Periodogram</option>
        </select>
      </Row>
      {welch && (
        <>
          <Row label="Segment length (s)" hint="Longer segments give finer frequency resolution (1 / length) but fewer segments to average.">
            <NumInput value={params.segment_s} min={0.01} onChange={(v) => v > 0 && setParams({ segment_s: v })} style={{ width: 70 }} />
          </Row>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', textAlign: 'right', marginTop: -2 }}>
            Resolution <span className="num">{fmtNum(res)}</span> Hz
          </div>
          <Row label="Overlap (%)">
            <NumInput value={params.overlap_pct} min={0} max={95} onChange={(v) => setParams({ overlap_pct: Math.max(0, Math.min(95, v)) })} style={{ width: 70 }} />
          </Row>
          <Row label="Average" hint="Median is robust to occasional bursts or artefacts in some segments.">
            <select value={params.average} onChange={(e) => setParams({ average: e.target.value as any })}>
              <option value="mean">Mean</option>
              <option value="median">Median</option>
            </select>
          </Row>
        </>
      )}
      <Row label="Window">
        <select value={params.window} onChange={(e) => setParams({ window: e.target.value as any })}>
          <option value="hann">Hann</option>
          <option value="hamming">Hamming</option>
          <option value="blackman">Blackman</option>
          <option value="boxcar">Rectangular</option>
        </select>
      </Row>
      <Row label="Detrend" hint="Removed from each segment before the FFT.">
        <select value={params.detrend} onChange={(e) => setParams({ detrend: e.target.value as any })}>
          <option value="constant">Mean</option>
          <option value="linear">Linear</option>
          <option value="none">None</option>
        </select>
      </Row>
      <Row label="Analysis range (Hz)" hint="Total power, relative power and the dominant frequency refer to this range. The spectrum is stored up to the upper limit.">
        <NumInput value={params.fmin} min={0} onChange={(v) => setParams({ fmin: Math.max(0, v) })} style={{ width: 52 }} />
        <span>–</span>
        <NumInput value={params.fmax} min={1} onChange={(v) => v > params.fmin && setParams({ fmax: v })} style={{ width: 58 }} />
      </Row>
    </div>
  )
}

function BandsCard({ params, setParams }: { params: SpectralParams; setParams: (p: Partial<SpectralParams>) => void }) {
  const bands = params.bands
  const update = (i: number, patch: Partial<SpectralBand>) =>
    setParams({ bands: bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) })
  return (
    <div className="section-card">
      <div className="section-card-title">Bands (Hz)</div>
      {bands.map((b, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input type="text" value={b.name} onChange={(e) => update(i, { name: e.target.value })}
            style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-label)' }} />
          <NumInput value={b.low} min={0} onChange={(v) => update(i, { low: Math.max(0, v) })} style={{ width: 48 }} />
          <span style={{ color: 'var(--text-muted)' }}>–</span>
          <NumInput value={b.high} min={0} onChange={(v) => update(i, { high: Math.max(0, v) })} style={{ width: 52 }} />
          <button className="icon-btn" title="Remove band"
            onClick={() => setParams({ bands: bands.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      {bands.some((b) => b.high <= b.low || !b.name.trim()) && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--warning)' }}>
          Bands without a name, or with high ≤ low, are skipped.
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm" style={{ flex: 1 }} onClick={() => {
          const last = bands[bands.length - 1]
          const lo = last ? last.high : 1
          setParams({ bands: [...bands, { name: `band ${bands.length + 1}`, low: lo, high: lo * 2 }] })
        }}>Add band</button>
        <button className="btn btn-sm" style={{ flex: 1 }}
          onClick={() => setParams({ bands: DEFAULT_SPECTRAL_BANDS.map((b) => ({ ...b })) })}>Reset bands</button>
      </div>
    </div>
  )
}

function LineNoiseCard({ params, setParams }: { params: SpectralParams; setParams: (p: Partial<SpectralParams>) => void }) {
  return (
    <div className="section-card">
      <div className="section-card-title">Line noise</div>
      <Row label="Mains frequency">
        <select value={params.line_freq} onChange={(e) => setParams({ line_freq: Number(e.target.value) })}>
          <option value={50}>50 Hz</option>
          <option value={60}>60 Hz</option>
        </select>
      </Row>
      <Row label="Harmonics">
        <NumInput value={params.line_harmonics} min={1} max={20} onChange={(v) => setParams({ line_harmonics: Math.max(1, Math.min(20, Math.round(v))) })} style={{ width: 52 }} />
      </Row>
      <Row label="Half-width (Hz)" hint="Bins within ± this of each harmonic count as mains.">
        <NumInput value={params.line_bw_hz} min={0.1} onChange={(v) => setParams({ line_bw_hz: Math.max(0.1, v) })} style={{ width: 52 }} />
      </Row>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}
        title="Mains peaks sit inside the gamma band. When on, those bins are interpolated across before band powers are summed. The plotted spectrum is unchanged.">
        <input type="checkbox" checked={params.exclude_line_noise}
          onChange={(e) => setParams({ exclude_line_noise: e.target.checked })} />
        <span>Leave mains out of band powers (interpolate across the peaks)</span>
      </label>
    </div>
  )
}

function PrefilterCard({ params, setParams }: { params: SpectralParams; setParams: (p: Partial<SpectralParams>) => void }) {
  return (
    <div className="section-card">
      <div className="section-card-title">Pre-filter</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
        <input type="checkbox" checked={params.filter_enabled}
          onChange={(e) => setParams({ filter_enabled: e.target.checked })} />
        Filter before analysis
      </label>
      {params.filter_enabled && (
        <>
          <Row label="Type">
            <select value={params.filter_type} onChange={(e) => setParams({ filter_type: e.target.value as any })}>
              <option value="highpass">High-pass</option>
              <option value="lowpass">Low-pass</option>
              <option value="bandpass">Band-pass</option>
            </select>
          </Row>
          {params.filter_type !== 'lowpass' && (
            <Row label="Low cutoff (Hz)">
              <NumInput value={params.filter_low} min={0} onChange={(v) => setParams({ filter_low: v })} style={{ width: 60 }} />
            </Row>
          )}
          {params.filter_type !== 'highpass' && (
            <Row label="High cutoff (Hz)">
              <NumInput value={params.filter_high} min={0} onChange={(v) => setParams({ filter_high: v })} style={{ width: 60 }} />
            </Row>
          )}
          <Row label="Order">
            <NumInput value={params.filter_order} min={1} max={8} onChange={(v) => setParams({ filter_order: Math.max(1, Math.min(8, Math.round(v))) })} style={{ width: 52 }} />
          </Row>
        </>
      )}
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        A filter reshapes the spectrum it is measuring. Usually leave this off; use it only to
        remove something known, such as slow drift.
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// Trace viewer with regions + spectrogram
// ------------------------------------------------------------------

type PlotBox = { left: number; width: number }

function SpectralViewer({
  backendUrl, group, series, channel, sweep,
  viewport, setViewport, onDuration,
  params, setParams,
  regions, selectedRegionId, onSelectRegion, onCreateRegion, onResizeRegion, onAddFromView,
  zeroOffset, onZeroOffsetChange,
  showSpectrogram, onShowSpectrogramChange,
  heightSignal,
}: {
  backendUrl: string
  group: number; series: number; channel: number; sweep: number
  viewport: Viewport
  setViewport: React.Dispatch<React.SetStateAction<Viewport>>
  onDuration: (s: number) => void
  params: SpectralParams
  setParams: (p: Partial<SpectralParams>) => void
  regions: SpectralRegion[]
  selectedRegionId: string | null
  onSelectRegion: (id: string | null) => void
  onCreateRegion: (t0: number, t1: number) => void
  onResizeRegion: (id: string, t0: number, t1: number) => void
  onAddFromView: () => void
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  showSpectrogram: boolean
  onShowSpectrogramChange: (v: boolean) => void
  heightSignal: number
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [plotBox, setPlotBox] = useState<PlotBox | null>(null)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    getUplot: () => plotRef.current ?? null,
    defaultName: 'spectral-trace',
  })

  const [data, setData] = useState<{ time: Float64Array; values: Float64Array; sweepDurationS: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Filter shown live on the trace = the analysis pre-filter.
  const filterKey = params.filter_enabled
    ? `${params.filter_type}:${params.filter_low}:${params.filter_high}:${params.filter_order}` : ''

  useEffect(() => {
    if (!backendUrl) { setData(null); return }
    const parts = [
      `group=${group}`, `series=${series}`, `sweep=${sweep}`, `trace=${channel}`, 'max_points=4000',
    ]
    if (viewport) parts.push(`t_start=${viewport.tStart}`, `t_end=${viewport.tEnd}`)
    if (params.filter_enabled) {
      parts.push(`filter_type=${params.filter_type}`, `filter_low=${params.filter_low}`,
        `filter_high=${params.filter_high}`, `filter_order=${params.filter_order}`)
    }
    if (zeroOffset) parts.push('zero_offset=true')
    let cancelled = false
    fetch(`${backendUrl}/api/traces/data?${parts.join('&')}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        const n = Number(d.n_samples ?? 0)
        const sr = Number(d.sampling_rate ?? 1)
        const dur = sr > 0 ? n / sr : Number(d.duration ?? 0)
        setData({ time: new Float64Array(d.time ?? []), values: new Float64Array(d.values ?? []), sweepDurationS: dur })
        onDuration(dur)
        setErr(null)
      })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, group, series, channel, sweep, viewport, filterKey, zeroOffset])

  // Region overlay reads from refs so drags don't rebuild the plot.
  const regionsRef = useRef(regions)
  regionsRef.current = regions
  const selectedRef = useRef(selectedRegionId)
  selectedRef.current = selectedRegionId
  const draftRef = useRef<{ id: string | null; t0: number; t1: number } | null>(null)
  const durationRef = useRef(0)
  durationRef.current = data?.sweepDurationS ?? 0
  const redraw = useCallback(() => {
    drawRegions(plotRef.current, overlayRef.current, regionsRef.current, sweep,
      durationRef.current, selectedRef.current, draftRef.current)
  }, [sweep])
  useEffect(() => { redraw() }, [regions, selectedRegionId, redraw])

  const updateBox = () => {
    const u = plotRef.current
    if (!u) return
    const dpr = devicePixelRatio || 1
    const left = u.bbox.left / dpr
    const width = u.bbox.width / dpr
    setPlotBox((b) => (b && Math.abs(b.left - left) < 0.5 && Math.abs(b.width - width) < 0.5 ? b : { left, width }))
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || data.time.length === 0) return
    const axis = {
      stroke: cssVar('--chart-axis'),
      grid: { stroke: cssVar('--chart-grid'), width: 1 },
      ticks: { stroke: cssVar('--chart-tick'), width: 1 },
      font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
    }
    const opts: uPlot.Options = {
      width: container.clientWidth || 400,
      height: Math.max(80, container.clientHeight || 160),
      scales: { x: { time: false }, y: {} },
      legend: { show: false },
      axes: [axis, { ...axis, size: 60 }],
      cursor: { drag: { x: false, y: false } },
      series: [{}, { stroke: cssVar('--trace-color-1'), width: 1.1, points: { show: false } }],
      hooks: {
        draw: [() => redraw()],
        setSize: [() => updateBox()],
      },
    }
    const attachTip = attachHoverCoords(opts)
    plotRef.current = new uPlot(opts, [Array.from(data.time), Array.from(data.values)], container)
    attachTip(container)
    updateBox()
    redraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, themeKey])

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
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal, showSpectrogram])

  // ---- Interactions: wheel = zoom X, ⌥-wheel = zoom Y, drag = pan,
  // shift-drag = new region, drag a region edge = resize.
  useEffect(() => {
    const container = containerRef.current
    const u = plotRef.current
    if (!container || !u || !data) return
    const over = container.querySelector<HTMLDivElement>('.u-over')
    if (!over) return
    const EDGE_PX = 6
    const pxToX = (px: number) => u.posToVal(px, 'x')
    const effVp = () => viewport ?? { tStart: 0, tEnd: data.sweepDurationS }

    type Drag =
      | { kind: 'pan'; startPx: number; vpStart: number; vpEnd: number; moved: boolean }
      | { kind: 'create'; t0: number }
      | { kind: 'resize'; id: string; fixed: number; startPx: number; moved: boolean }
    let drag: Drag | null = null

    const edgeHit = (px: number): { id: string; fixed: number } | null => {
      let best: { id: string; fixed: number; d: number } | null = null
      for (const r of regionsRef.current) {
        if (!regionOnSweep(r, sweep) || (r.tStart == null && r.tEnd == null)) continue
        const t0 = r.tStart ?? 0
        const t1 = r.tEnd ?? data.sweepDurationS
        const p0 = u.valToPos(t0, 'x', false)
        const p1 = u.valToPos(t1, 'x', false)
        const d0 = Math.abs(px - p0), d1 = Math.abs(px - p1)
        if (d0 < EDGE_PX && (!best || d0 < best.d)) best = { id: r.id, fixed: t1, d: d0 }
        if (d1 < EDGE_PX && (!best || d1 < best.d)) best = { id: r.id, fixed: t0, d: d1 }
      }
      return best ? { id: best.id, fixed: best.fixed } : null
    }
    const regionAt = (t: number): string | null => {
      for (const r of [...regionsRef.current].reverse()) {
        if (!regionOnSweep(r, sweep) || (r.tStart == null && r.tEnd == null)) continue
        if (t >= (r.tStart ?? 0) && t <= (r.tEnd ?? Infinity)) return r.id
      }
      return null
    }

    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return
      // preventDefault below stops the browser focusing the viewer, so
      // focus it ourselves — keyboard paging depends on it.
      rootRef.current?.focus({ preventScroll: true })
      const px = ev.clientX - over.getBoundingClientRect().left
      const t = pxToX(px)
      if (ev.shiftKey) {
        drag = { kind: 'create', t0: t }
        draftRef.current = { id: null, t0: t, t1: t }
      } else {
        const hit = edgeHit(px)
        if (hit) {
          drag = { kind: 'resize', id: hit.id, fixed: hit.fixed, startPx: px, moved: false }
          onSelectRegion(hit.id)
        } else {
          const v = effVp()
          drag = { kind: 'pan', startPx: px, vpStart: v.tStart, vpEnd: v.tEnd, moved: false }
        }
      }
      over.setPointerCapture(ev.pointerId)
      ev.preventDefault()
    }
    const onMove = (ev: PointerEvent) => {
      const px = ev.clientX - over.getBoundingClientRect().left
      if (!drag) {
        over.style.cursor = ev.shiftKey ? 'crosshair' : edgeHit(px) ? 'ew-resize' : ''
        return
      }
      const t = Math.max(0, Math.min(data.sweepDurationS || Infinity, pxToX(px)))
      if (drag.kind === 'create') {
        draftRef.current = { id: null, t0: drag.t0, t1: t }
        redraw()
      } else if (drag.kind === 'resize') {
        // A click on an edge without moving only selects the region.
        if (!drag.moved && Math.abs(px - drag.startPx) <= 3) return
        drag.moved = true
        draftRef.current = { id: drag.id, t0: drag.fixed, t1: t }
        redraw()
      } else {
        const dx = px - drag.startPx
        if (!drag.moved && Math.abs(dx) > 3) { drag.moved = true; over.style.cursor = 'grabbing' }
        if (!drag.moved) return
        const w = drag.vpEnd - drag.vpStart
        const dt = -(dx / (u.bbox.width / (devicePixelRatio || 1))) * w
        setViewport({ tStart: drag.vpStart + dt, tEnd: drag.vpEnd + dt })
      }
    }
    const onUp = (ev: PointerEvent) => {
      if (!drag) return
      const d = drag
      drag = null
      try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      over.style.cursor = ''
      const draft = draftRef.current
      draftRef.current = null
      if (d.kind === 'create' && draft) {
        const a = Math.min(draft.t0, draft.t1), b = Math.max(draft.t0, draft.t1)
        if (b - a > 1e-4) onCreateRegion(a, b)
        else redraw()
      } else if (d.kind === 'resize' && draft) {
        const a = Math.min(draft.t0, draft.t1), b = Math.max(draft.t0, draft.t1)
        if (b - a > 1e-4) onResizeRegion(d.id, a, b)
        else redraw()
      } else if (d.kind === 'pan' && !d.moved) {
        const px = ev.clientX - over.getBoundingClientRect().left
        onSelectRegion(regionAt(pxToX(px)))
      }
    }
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = over.getBoundingClientRect()
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      if (ev.altKey) {
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (yMin == null || yMax == null) return
        const y = u.posToVal(ev.clientY - rect.top, 'y')
        u.setScale('y', { min: y - (y - yMin) * factor, max: y + (yMax - y) * factor })
      } else {
        const v = effVp()
        const x = pxToX(ev.clientX - rect.left)
        setViewport({ tStart: x - (x - v.tStart) * factor, tEnd: x + (v.tEnd - x) * factor })
      }
    }
    over.addEventListener('pointerdown', onDown)
    over.addEventListener('pointermove', onMove)
    over.addEventListener('pointerup', onUp)
    over.addEventListener('pointercancel', onUp)
    over.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      over.removeEventListener('pointerdown', onDown)
      over.removeEventListener('pointermove', onMove)
      over.removeEventListener('pointerup', onUp)
      over.removeEventListener('pointercancel', onUp)
      over.removeEventListener('wheel', onWheel)
    }
  }, [data, viewport, setViewport, sweep, redraw, onCreateRegion, onResizeRegion, onSelectRegion])

  // Keyboard nav, same keys as the Burst window.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (e: KeyboardEvent) => {
      if (!data || (e.target as HTMLElement)?.tagName === 'INPUT') return
      const dur = data.sweepDurationS
      const v = viewport ?? { tStart: 0, tEnd: dur }
      const w = v.tEnd - v.tStart
      const shift = (dt: number) => {
        const ne = Math.min(dur, Math.max(0, v.tStart + dt) + w)
        setViewport({ tStart: Math.max(0, ne - w), tEnd: ne })
      }
      if (e.key === 'ArrowRight') { e.preventDefault(); shift(w) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); shift(-w) }
      else if (e.key === 'PageDown') { e.preventDefault(); shift(3 * w) }
      else if (e.key === 'PageUp') { e.preventDefault(); shift(-3 * w) }
      else if (e.key === 'Home') { e.preventDefault(); setViewport({ tStart: 0, tEnd: Math.min(dur, w) }) }
      else if (e.key === 'End') { e.preventDefault(); setViewport({ tStart: Math.max(0, dur - w), tEnd: dur }) }
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [data, viewport, setViewport])

  const dur = data?.sweepDurationS ?? 0
  const shiftViewport = (f: number) => {
    const v = viewport ?? { tStart: 0, tEnd: Math.min(10, dur) }
    const w = v.tEnd - v.tStart
    const ns = Math.max(0, Math.min(dur - w, v.tStart + w * f))
    setViewport({ tStart: ns, tEnd: ns + w })
  }
  const goHome = () => {
    const v = viewport ?? { tStart: 0, tEnd: 10 }
    setViewport({ tStart: 0, tEnd: Math.min(dur, v.tEnd - v.tStart) })
  }
  const goEnd = () => {
    const v = viewport ?? { tStart: 0, tEnd: 10 }
    setViewport({ tStart: Math.max(0, dur - (v.tEnd - v.tStart)), tEnd: dur })
  }
  const fitY = () => {
    const u = plotRef.current
    if (!u || !data) return
    let lo = Infinity, hi = -Infinity
    for (const y of data.values) { if (y < lo) lo = y; if (y > hi) hi = y }
    if (isFinite(lo) && hi > lo) {
      const pad = (hi - lo) * 0.05
      u.setScale('y', { min: lo - pad, max: hi + pad })
    }
  }

  // Effective visible range for the spectrogram (clamped to the sweep).
  const visible = useMemo(() => {
    if (!dur) return null
    const v = viewport ?? { tStart: 0, tEnd: dur }
    return { tStart: Math.max(0, v.tStart), tEnd: Math.min(dur, v.tEnd) }
  }, [viewport, dur])

  return (
    <div ref={rootRef} tabIndex={0} style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-primary)', position: 'relative', outline: 'none',
    }}>
      <div className="viewer-header" style={{
        fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
        borderRadius: 'var(--radius) var(--radius) 0 0',
      }}>
        <span>Sweep <span className="num">{sweep + 1}</span></span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={onAddFromView}
            title="New region covering the visible stretch">Region from view</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}
            title="Show a spectrogram of the visible stretch under the trace">
            <input type="checkbox" checked={showSpectrogram} onChange={(e) => onShowSpectrogramChange(e.target.checked)} />
            Spectrogram
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}
            title="Subtract a per-sweep baseline from the displayed trace. The analysis is unaffected.">
            <input type="checkbox" checked={zeroOffset} onChange={(e) => onZeroOffsetChange(e.target.checked)} />
            Zero offset
          </label>
          <button className="btn btn-sm" onClick={fitY}>Fit Y</button>
        </span>
      </div>

      <ViewportBar
        viewport={viewport} sweepDuration={dur} setViewport={setViewport}
        shiftViewport={shiftViewport} goHome={goHome} goEnd={goEnd}
      />

      <div ref={containerRef} onContextMenu={onContextMenu}
        style={{ flex: showSpectrogram ? 1.1 : 1, position: 'relative', minHeight: 0 }}>
        {menu}
        <canvas ref={overlayRef} style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, width: '100%', height: '100%',
        }} />
      </div>

      {showSpectrogram && (
        <Spectrogram
          backendUrl={backendUrl}
          group={group} series={series} sweep={sweep} channel={channel}
          visible={visible}
          plotBox={plotBox}
          params={params}
          setParams={setParams}
        />
      )}

      <ViewportSlider viewport={viewport} sweepDuration={dur} setViewport={setViewport} />

      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)',
        borderRadius: '0 0 var(--radius) var(--radius)',
      }}>
        Scroll = zoom X · ⌥ scroll = zoom Y · drag = pan · shift-drag = new region · drag a region edge = resize · click = select
      </div>
      {err && (
        <div style={{ position: 'absolute', top: 30, left: 10, color: 'var(--error)', fontSize: 'var(--font-size-label)' }}>
          Fetch: {err}
        </div>
      )}
    </div>
  )
}

function regionOnSweep(r: SpectralRegion, sweep: number): boolean {
  const a = r.sweepFrom ?? -Infinity
  const b = r.sweepTo ?? Infinity
  return sweep >= a && sweep <= b
}

/** Shade the regions that cover this sweep. Full-length regions get a
 *  thin bar along the top instead of a fill, so the trace stays legible. */
function drawRegions(
  u: uPlot | null, canvas: HTMLCanvasElement | null,
  regions: SpectralRegion[], sweep: number, duration: number,
  selectedId: string | null,
  draft: { id: string | null; t0: number; t1: number } | null,
) {
  if (!u || !canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = devicePixelRatio || 1
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  const top = u.bbox.top / dpr
  const height = u.bbox.height / dpr
  const left = u.bbox.left / dpr
  const right = left + u.bbox.width / dpr
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, 0, right - left, cssH)
  ctx.clip()
  ctx.font = `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`
  let barRow = 0
  regions.forEach((r, i) => {
    if (!regionOnSweep(r, sweep)) return
    const color = cssVar(regionColorVar(i))
    const sel = r.id === selectedId
    const full = r.tStart == null && r.tEnd == null
    if (full) {
      const y = top + 2 + barRow * 6
      barRow++
      ctx.fillStyle = color
      ctx.globalAlpha = sel ? 0.9 : 0.6
      ctx.fillRect(left, y, right - left, 3)
      ctx.globalAlpha = 1
      return
    }
    let t0 = r.tStart ?? 0
    let t1 = r.tEnd ?? duration
    if (draft && draft.id === r.id) { t0 = Math.min(draft.t0, draft.t1); t1 = Math.max(draft.t0, draft.t1) }
    const p0 = u.valToPos(t0, 'x', true) / dpr
    const p1 = u.valToPos(t1, 'x', true) / dpr
    if (!isFinite(p0) || !isFinite(p1)) return
    ctx.fillStyle = color
    ctx.globalAlpha = sel ? 0.2 : 0.11
    ctx.fillRect(p0, top, Math.max(1, p1 - p0), height)
    ctx.globalAlpha = sel ? 1 : 0.7
    ctx.strokeStyle = color
    ctx.lineWidth = sel ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(p0, top); ctx.lineTo(p0, top + height)
    ctx.moveTo(p1, top); ctx.lineTo(p1, top + height)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    // No label for a region that is scrolled (almost) out of view.
    if (p1 < left + 8 || p0 > right - 8) return
    // Label on a backing pill so it reads over a dense trace; staggered
    // so regions starting at the same time don't overprint.
    const lx = Math.max(p0, left) + 4
    const ly = top + 12 + (i % 4) * 14
    const tw = ctx.measureText(r.label).width
    ctx.fillStyle = cssVar('--bg-primary')
    ctx.globalAlpha = 0.85
    ctx.fillRect(lx - 2, ly - 10, tw + 4, 13)
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    ctx.fillText(r.label, lx, ly)
  })
  if (draft && draft.id == null) {
    const p0 = u.valToPos(Math.min(draft.t0, draft.t1), 'x', true) / dpr
    const p1 = u.valToPos(Math.max(draft.t0, draft.t1), 'x', true) / dpr
    ctx.fillStyle = cssVar('--accent')
    ctx.globalAlpha = 0.18
    ctx.fillRect(p0, top, Math.max(1, p1 - p0), height)
    ctx.globalAlpha = 1
  }
  ctx.restore()
}

// ------------------------------------------------------------------
// Spectrogram strip
// ------------------------------------------------------------------

/** Perceptually uniform colour map (viridis control points). This is a
 *  data scale, not UI chrome, so it doesn't follow the theme tokens. */
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141],
  [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37],
]
const LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (VIRIDIS.length - 1)
    const k = Math.min(VIRIDIS.length - 2, Math.floor(x))
    const f = x - k
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = VIRIDIS[k][c] + (VIRIDIS[k + 1][c] - VIRIDIS[k][c]) * f
  }
  return lut
})()

interface SpecData {
  freqs: number[]
  times: number[]
  nF: number
  nT: number
  db: Float32Array
  dbMin: number
  dbMax: number
  windowS: number
  freqResHz: number
  units: string
}

function Spectrogram({
  backendUrl, group, series, sweep, channel, visible, plotBox, params, setParams,
}: {
  backendUrl: string
  group: number; series: number; sweep: number; channel: number
  visible: { tStart: number; tEnd: number } | null
  plotBox: PlotBox | null
  params: SpectralParams
  setParams: (p: Partial<SpectralParams>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [spec, setSpec] = useState<SpecData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const themeKey = useThemeKey()

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The whole sweep is computed once per sweep / setting and cropped
  // locally while panning and zooming, so scrolling never waits on the
  // backend. The view is NOT part of this key on purpose.
  const fetchKey = JSON.stringify({
    group, series, sweep, channel,
    w: params.spec_window_s, o: params.spec_overlap_pct, lo: params.spec_fmin, hi: params.spec_fmax,
    win: params.window, dt: params.detrend,
    f: params.filter_enabled ? [params.filter_type, params.filter_low, params.filter_high, params.filter_order] : null,
  })
  useEffect(() => {
    if (!backendUrl) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const resp = await fetch(`${backendUrl}/api/spectral/spectrogram`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group, series, sweep, trace: channel, params, max_cols: 20000 }),
        })
        const d = await resp.json()
        if (cancelled) return
        if (!resp.ok) { setErr(d.detail ?? String(resp.status)); setSpec(null); return }
        const bin = atob(d.power_db_b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        setSpec({
          freqs: d.freqs, times: d.times, nF: d.n_freqs, nT: d.n_times,
          db: new Float32Array(bytes.buffer), dbMin: d.db_min, dbMax: d.db_max,
          windowS: d.window_s, freqResHz: d.freq_res_hz, units: d.units,
        })
        setErr(null)
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 150)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, fetchKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = devicePixelRatio || 1
    const W = size.w, H = size.h
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!spec || !plotBox || !visible || spec.nT === 0 || spec.nF === 0) return
    const left = plotBox.left, width = plotBox.width
    // Leave room for the top / bottom tick labels.
    const top = 7, height = H - 14
    const nPx = Math.max(1, Math.round(width))
    const span = Math.max(1e-6, spec.dbMax - spec.dbMin)
    const tv = visible.tEnd - visible.tStart
    const times = spec.times
    const lastT = times[spec.nT - 1]
    const halfCol = spec.nT > 1 ? (lastT - times[0]) / (spec.nT - 1) / 2 : spec.windowS / 2
    // First column whose centre is ≥ t (binary search; columns may be
    // slightly non-uniform at the very end after server-side averaging).
    const lowerBound = (t: number) => {
      let lo = 0, hi = spec.nT
      while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid }
      return lo
    }
    // One image column per screen pixel: average every spectrogram column
    // whose centre falls in the pixel, or take the nearest when zoomed in
    // past the spectrogram's own time resolution.
    const img = new ImageData(nPx, spec.nF)
    const acc = new Float64Array(spec.nF)
    for (let px = 0; px < nPx; px++) {
      const t0 = visible.tStart + (px / nPx) * tv
      const t1 = visible.tStart + ((px + 1) / nPx) * tv
      if (t1 < times[0] - halfCol || t0 > lastT + halfCol) continue
      let i0 = lowerBound(t0)
      let i1 = lowerBound(t1) - 1
      if (i1 < i0) {
        const tm = (t0 + t1) / 2
        const j = lowerBound(tm)
        i0 = i1 = j >= spec.nT ? spec.nT - 1
          : j > 0 && tm - times[j - 1] < times[j] - tm ? j - 1 : j
      }
      acc.fill(0)
      const n = i1 - i0 + 1
      for (let fi = 0; fi < spec.nF; fi++) {
        const rowOff = fi * spec.nT
        let sum = 0
        for (let ti = i0; ti <= i1; ti++) sum += spec.db[rowOff + ti]
        acc[fi] = sum / n
      }
      for (let fi = 0; fi < spec.nF; fi++) {
        const k = Math.max(0, Math.min(255, Math.round(((acc[fi] - spec.dbMin) / span) * 255)))
        const o = ((spec.nF - 1 - fi) * nPx + px) * 4
        img.data[o] = LUT[k * 3]; img.data[o + 1] = LUT[k * 3 + 1]; img.data[o + 2] = LUT[k * 3 + 2]; img.data[o + 3] = 255
      }
    }
    const off = document.createElement('canvas')
    off.width = nPx
    off.height = spec.nF
    off.getContext('2d')!.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(off, left, top, width, height)
    // Frequency ticks in the left gutter.
    ctx.fillStyle = cssVar('--text-muted')
    ctx.strokeStyle = cssVar('--chart-tick')
    ctx.font = `${cssVar('--font-size-xs')} ${cssVar('--font-ui')}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const fLo = spec.freqs[0], fHi = spec.freqs[spec.nF - 1]
    const df = spec.nF > 1 ? (fHi - fLo) / (spec.nF - 1) : 1
    const f0 = fLo - df / 2, f1 = fHi + df / 2
    const ticks = niceTicks(Math.max(0, f0), f1, Math.max(2, Math.floor(height / 28)))
    for (const f of ticks) {
      const y = top + height - ((f - f0) / (f1 - f0)) * height
      if (y < top || y > top + height) continue
      ctx.beginPath(); ctx.moveTo(left - 4, y); ctx.lineTo(left, y); ctx.stroke()
      ctx.fillText(`${f}`, left - 6, y)
    }
    ctx.save()
    ctx.translate(10, top + height / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillText('Hz', 0, 0)
    ctx.restore()
  }, [spec, plotBox, visible, size, themeKey])

  const dbUnits = spec ? `dB re 1 ${powerUnits(spec.units).density}` : ''
  return (
    <div style={{ flex: 1, minHeight: 60, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '2px 8px',
        fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', flexShrink: 0,
      }}>
        <span>Spectrogram</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3 }} title="Window length — sets frequency resolution (1 / length) and time smoothing">
          window
          <NumInput value={params.spec_window_s} min={0.01} onChange={(v) => v > 0 && setParams({ spec_window_s: v })} style={{ width: 46 }} />
          s
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          range
          <NumInput value={params.spec_fmin} min={0} onChange={(v) => setParams({ spec_fmin: Math.max(0, v) })} style={{ width: 40 }} />
          –
          <NumInput value={params.spec_fmax} min={1} onChange={(v) => v > params.spec_fmin && setParams({ spec_fmax: v })} style={{ width: 46 }} />
          Hz
        </label>
        {busy && <span>computing…</span>}
        {spec && !err && (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }} className="num"
            title="Colour scale is fixed for the whole sweep, so views are comparable while you scroll">
            {spec.dbMin.toFixed(0)}
            <span style={{
              width: 60, height: 8, borderRadius: 2,
              background: `linear-gradient(to right, ${VIRIDIS.map((c) => `rgb(${c.join(',')})`).join(',')})`,
            }} />
            {spec.dbMax.toFixed(0)} {dbUnits}
          </span>
        )}
      </div>
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        {err && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontSize: 'var(--font-size-label)', padding: 8, textAlign: 'center',
          }}>{err}</div>
        )}
      </div>
    </div>
  )
}

function niceTicks(lo: number, hi: number, maxTicks: number): number[] {
  const range = hi - lo
  if (!(range > 0)) return []
  const raw = range / maxTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toPrecision(6)))
  return out
}

// ------------------------------------------------------------------
// Spectrum plot (overlaid regions)
// ------------------------------------------------------------------

function PsdPlot({
  results, regions, params, units, heightSignal,
}: {
  results: SpectralRegionResult[]
  regions: SpectralRegion[]
  params: SpectralParams
  units: string
  heightSignal: number
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [yMode, setYMode] = useState<'log' | 'db' | 'linear'>('log')
  const [xLog, setXLog] = useState(true)
  const [showBands, setShowBands] = useState(true)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    getUplot: () => plotRef.current ?? null,
    defaultName: 'power-spectrum',
    asterism: 'xy',
  })

  const ok = results.filter((r) => !r.error && r.freqs.length > 1)
  const colorIdx = (r: SpectralRegionResult, i: number) => {
    const j = regions.findIndex((x) => x.id === r.regionId)
    return j >= 0 ? j : i
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (ok.length === 0) return
    const tables: uPlot.AlignedData[] = ok.map((r) => {
      const xs: number[] = [], ys: (number | null)[] = []
      for (let i = 0; i < r.freqs.length; i++) {
        const f = r.freqs[i]
        if (xLog && f <= 0) continue
        const p = r.psd[i]
        let y: number | null = p
        if (yMode === 'log') y = p > 0 ? p : null
        else if (yMode === 'db') y = p > 0 ? 10 * Math.log10(p) : null
        xs.push(f); ys.push(y)
      }
      return [xs, ys] as uPlot.AlignedData
    })
    const joined = ok.length === 1 ? tables[0] : uPlot.join(tables)
    const axis = {
      stroke: cssVar('--chart-axis'),
      grid: { stroke: cssVar('--chart-grid'), width: 1 },
      ticks: { stroke: cssVar('--chart-tick'), width: 1 },
      font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
      labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
    }
    const dens = powerUnits(units).density
    const xMin = Math.max(xLog ? (ok[0].freqs.find((f) => f > 0) ?? 0.1) : 0, params.fmin > 0 ? params.fmin : 0)
    const xMax = Math.max(...ok.map((r) => r.freqs[r.freqs.length - 1]))
    const bandColor = cssVar('--text-muted')
    const opts: uPlot.Options = {
      width: el.clientWidth || 500,
      height: Math.max(140, el.clientHeight || 220),
      legend: { show: false },
      scales: {
        x: { time: false, distr: xLog ? 3 : 1, range: () => [xMin, xMax] },
        y: { distr: yMode === 'log' ? 3 : 1 },
      },
      axes: [
        { ...axis, label: 'Frequency (Hz)' },
        {
          ...axis, size: 70, label: yMode === 'db' ? `dB re 1 ${dens}` : dens,
          // uPlot's default formatter rounds small powers to 0.
          values: (_u: uPlot, splits: number[]) => splits.map((v) => (v == null ? '' : fmtNum(v, 2))),
        },
      ],
      cursor: { drag: { x: true, y: false } },
      series: [
        {},
        ...ok.map((r, i) => ({
          label: r.label,
          stroke: cssVar(regionColorVar(colorIdx(r, i))),
          width: 1.4,
          points: { show: false },
          spanGaps: true,
        })),
      ],
      hooks: {
        drawClear: [(u: uPlot) => {
          if (!showBands) return
          const ctx = u.ctx
          const { top, height } = u.bbox
          ctx.save()
          params.bands.forEach((b, i) => {
            if (!(b.high > b.low) || b.high < xMin || b.low > xMax) return
            const p0 = u.valToPos(Math.max(b.low, xMin), 'x', true)
            const p1 = u.valToPos(Math.min(b.high, xMax), 'x', true)
            ctx.fillStyle = bandColor
            ctx.globalAlpha = i % 2 === 0 ? 0.07 : 0.03
            ctx.fillRect(p0, top, p1 - p0, height)
          })
          ctx.restore()
        }],
        draw: [(u: uPlot) => {
          if (!showBands) return
          const ctx = u.ctx
          const dpr = devicePixelRatio || 1
          ctx.save()
          ctx.fillStyle = bandColor
          ctx.font = `${10 * dpr}px ${cssVar('--font-ui')}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          for (const b of params.bands) {
            if (!(b.high > b.low) || b.high < xMin || b.low > xMax) continue
            const p0 = u.valToPos(Math.max(b.low, xMin), 'x', true)
            const p1 = u.valToPos(Math.min(b.high, xMax), 'x', true)
            const w = p1 - p0
            if (w < ctx.measureText(b.name).width + 4 * dpr) continue
            ctx.fillText(b.name, (p0 + p1) / 2, u.bbox.top + 3 * dpr)
          }
          ctx.restore()
        }],
      },
    }
    const attachTip = attachHoverCoords(opts, { xUnit: 'Hz', xDigits: 2, yDigits: 3 })
    plotRef.current = new uPlot(opts, joined, el)
    attachTip(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, regions, params.bands, params.fmin, units, yMode, xLog, showBands, themeKey])

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
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 200 }}>
      <div className="viewer-header" style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        {ok.map((r, i) => (
          <span key={r.regionId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 3, borderRadius: 1, background: `var(${regionColorVar(colorIdx(r, i))})` }} />
            {r.label}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Power</span>
          <div className="segmented">
            {(['log', 'db', 'linear'] as const).map((m) => (
              <button key={m} className={yMode === m ? 'active' : ''} onClick={() => setYMode(m)}>
                {m === 'log' ? 'Log' : m === 'db' ? 'dB' : 'Linear'}
              </button>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={xLog} onChange={(e) => setXLog(e.target.checked)} />
            Log frequency
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={showBands} onChange={(e) => setShowBands(e.target.checked)} />
            Bands
          </label>
        </span>
      </div>
      <div ref={containerRef} onContextMenu={onContextMenu} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {menu}
        {ok.length === 0 && (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
            No region produced a spectrum. See the errors under each region on the left.
          </div>
        )}
      </div>
      <div style={{ padding: '2px 8px', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Drag to zoom frequency · double-click to reset · right-click to copy or save
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// Band power over time
// ------------------------------------------------------------------

type TcMode = 'abs' | 'rel' | 'norm'

/** Band colours: the five trace colours, then the same five dashed. */
function bandStyle(i: number): { colorVar: string; dash?: number[] } {
  return { colorVar: regionColorVar(i), ...(i >= 5 ? { dash: [5, 3] } : {}) }
}

function BandTimecourse({
  backendUrl, group, series, channel, params, setParams, excluded, regions, onJump, heightSignal,
}: {
  backendUrl: string
  group: number; series: number; channel: number
  params: SpectralParams
  setParams: (p: Partial<SpectralParams>) => void
  excluded: number[] | undefined
  regions: SpectralRegion[]
  onJump: (sweep: number, t: number) => void
  heightSignal: number
}) {
  const themeKey = useThemeKey()
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [tc, setTc] = useState<SpectralTimecourse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<TcMode>('abs')
  const [normRegionId, setNormRegionId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plotRef.current?.ctx?.canvas ?? null,
    getUplot: () => plotRef.current ?? null,
    defaultName: 'band-power-over-time',
    asterism: 'xy',
  })

  // Regions that can serve as a normalisation reference (any region
  // with a time window or sweep range — a whole-series region would just
  // divide by the overall mean, which is also allowed).
  const normRegion = regions.find((r) => r.id === normRegionId) ?? regions.find((r) => r.tStart != null || r.tEnd != null || r.sweepFrom != null) ?? regions[0] ?? null

  // Recompute when anything that changes the numbers changes. Spectrogram
  // display settings are left out so they don't trigger a refetch.
  const {
    spec_window_s: _a, spec_overlap_pct: _b, spec_fmin: _c, spec_fmax: _d, ...numberParams
  } = params
  const fetchKey = JSON.stringify({ group, series, channel, numberParams, excluded: excluded ?? [] })
  useEffect(() => {
    if (!backendUrl) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const resp = await fetch(`${backendUrl}/api/spectral/timecourse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group, series, trace: channel, params, excluded_sweeps: excluded ?? [],
            bin_s: params.tc_bin_s, step_s: params.tc_step_s > 0 ? params.tc_step_s : null,
          }),
        })
        const d = await resp.json()
        if (cancelled) return
        if (!resp.ok) { setErr(d.detail ?? String(resp.status)); setTc(null); return }
        setTc(timecourseFromBackend(d))
        setErr(null)
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, fetchKey])

  const multiSweep = !!tc && Object.keys(tc.sweepOffsets).length > 1
  const inRegion = useCallback((r: SpectralRegion, sw: number, t: number) =>
    regionOnSweep(r, sw) && t >= (r.tStart ?? -Infinity) && t <= (r.tEnd ?? Infinity), [])

  // Reference level per band for "% of region".
  const reference = useMemo(() => {
    const ref: Record<string, number | null> = {}
    if (!tc || !normRegion) return ref
    for (const n of tc.bandOrder) {
      let sum = 0, cnt = 0
      tc.bands[n].power.forEach((v, i) => {
        if (v != null && inRegion(normRegion, tc.sweeps[i], tc.times[i])) { sum += v; cnt++ }
      })
      ref[n] = cnt > 0 && sum > 0 ? sum / cnt : null
    }
    return ref
  }, [tc, normRegion, inRegion])
  const refBins = useMemo(() => {
    if (!tc || !normRegion) return 0
    return tc.times.filter((t, i) => inRegion(normRegion, tc.sweeps[i], t)).length
  }, [tc, normRegion, inRegion])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!tc || tc.times.length === 0) return
    const xs = tc.times.map((t, i) => t + (tc.sweepOffsets[String(tc.sweeps[i])] ?? 0))
    const shown = tc.bandOrder.filter((n) => !hidden.has(n))
    const ys = shown.map((n) => {
      const b = tc.bands[n]
      return b.power.map((v, i) => {
        if (mode === 'rel') { const r = b.relative[i]; return r == null ? null : r * 100 }
        if (mode === 'norm') { const ref = reference[n]; return v == null || ref == null ? null : (v / ref) * 100 }
        return v != null && v > 0 ? v : null
      })
    })
    const axis = {
      stroke: cssVar('--chart-axis'),
      grid: { stroke: cssVar('--chart-grid'), width: 1 },
      ticks: { stroke: cssVar('--chart-tick'), width: 1 },
      font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
      labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
    }
    const pu = powerUnits(tc.units)
    const yLabel = mode === 'abs' ? `Band power (${pu.power})`
      : mode === 'rel' ? 'Share of total power (%)'
        : `% of ${normRegion?.label ?? 'region'}`
    const shade = cssVar('--text-muted')
    const opts: uPlot.Options = {
      width: el.clientWidth || 500,
      height: Math.max(140, el.clientHeight || 220),
      legend: { show: false },
      scales: { x: { time: false }, y: { distr: mode === 'abs' ? 3 : 1 } },
      axes: [
        { ...axis, label: multiSweep ? 'Time (s, sweeps end to end)' : 'Time (s)' },
        {
          ...axis, size: 70, label: yLabel,
          values: (_u: uPlot, splits: number[]) => splits.map((v) => (v == null ? '' : fmtNum(v, 2))),
        },
      ],
      cursor: { drag: { x: true, y: false } },
      series: [
        {},
        ...shown.map((n) => {
          const st = bandStyle(tc.bandOrder.indexOf(n))
          return {
            label: n, stroke: cssVar(st.colorVar), width: 1.5, dash: st.dash,
            points: { show: tc.times.length <= 60, size: 4 }, spanGaps: false,
          }
        }),
      ],
      hooks: {
        drawClear: [(u: uPlot) => {
          const ctx = u.ctx
          const { top, height, left, width } = u.bbox
          ctx.save()
          ctx.beginPath()
          ctx.rect(left, top, width, height)
          ctx.clip()
          // Regions with a time window or sweep range, per covered sweep.
          regions.forEach((r, i) => {
            if (r.tStart == null && r.tEnd == null && r.sweepFrom == null && r.sweepTo == null) return
            for (const [swStr, off] of Object.entries(tc.sweepOffsets)) {
              const sw = Number(swStr)
              if (!regionOnSweep(r, sw)) continue
              const dur = tc.sweepDurations[swStr] ?? 0
              const p0 = u.valToPos(off + (r.tStart ?? 0), 'x', true)
              const p1 = u.valToPos(off + (r.tEnd ?? dur), 'x', true)
              ctx.fillStyle = cssVar(regionColorVar(i))
              ctx.globalAlpha = r.id === normRegion?.id && mode === 'norm' ? 0.16 : 0.08
              ctx.fillRect(p0, top, Math.max(1, p1 - p0), height)
            }
          })
          // Sweep boundaries.
          if (multiSweep) {
            ctx.globalAlpha = 0.5
            ctx.strokeStyle = shade
            ctx.setLineDash([3, 3])
            for (const off of Object.values(tc.sweepOffsets)) {
              if (off <= 0) continue
              const p = u.valToPos(off, 'x', true)
              ctx.beginPath(); ctx.moveTo(p, top); ctx.lineTo(p, top + height); ctx.stroke()
            }
          }
          ctx.restore()
        }],
      },
    }
    const data = [xs, ...ys] as uPlot.AlignedData
    const attachTip = attachHoverCoords(opts, { xUnit: 's', xDigits: 1, yDigits: 3 })
    const u = new uPlot(opts, data, el)
    plotRef.current = u
    attachTip(el)
    // Click (without dragging) → show that bin in the trace viewer.
    const over = el.querySelector<HTMLDivElement>('.u-over')
    let downX = 0
    over?.addEventListener('mousedown', (e) => { downX = e.clientX })
    over?.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - downX) > 3) return
      const idx = u.cursor.idx
      if (idx == null) return
      onJump(tc.sweeps[idx], tc.times[idx])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tc, mode, hidden, reference, regions, normRegion?.id, themeKey])

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
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  const toggleBand = (n: string) => setHidden((h) => {
    const next = new Set(h)
    if (next.has(n)) next.delete(n); else next.add(n)
    return next
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 220 }}>
      <div className="viewer-header" style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', flexWrap: 'wrap', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}
          title="Each bin gets its own Welch spectrum, so the bin must be at least one segment long">
          Bin
          <NumInput value={params.tc_bin_s} min={0.1} onChange={(v) => v > 0 && setParams({ tc_bin_s: v })} style={{ width: 50 }} />
          s
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}
          title="Distance between bin starts. Equal to the bin length = non-overlapping bins.">
          Step
          <NumInput value={params.tc_step_s > 0 ? params.tc_step_s : params.tc_bin_s} min={0.1}
            onChange={(v) => v > 0 && setParams({ tc_step_s: v === params.tc_bin_s ? 0 : v })} style={{ width: 50 }} />
          s
        </label>
        <div className="segmented">
          {([['abs', 'Power'], ['rel', '% of total'], ['norm', '% of region']] as const).map(([k, label]) => (
            <button key={k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{label}</button>
          ))}
        </div>
        {mode === 'norm' && (
          <select value={normRegion?.id ?? ''} onChange={(e) => setNormRegionId(e.target.value)}
            style={{ fontSize: 'var(--font-size-label)' }}>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        )}
        {busy && <span>computing…</span>}
        <button className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={!tc}
          onClick={() => tc && downloadText(buildTimecourseCSV(tc), `band_power_over_time_G${group + 1}S${series + 1}.csv`)}>
          Export CSV
        </button>
      </div>
      {tc && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 8px', fontSize: 'var(--font-size-label)' }}>
          {tc.bandOrder.map((n, i) => {
            const st = bandStyle(i)
            const off = hidden.has(n)
            return (
              <button key={n} className="btn btn-sm" onClick={() => toggleBand(n)}
                title={off ? 'Show this band' : 'Hide this band'}
                style={{ opacity: off ? 0.45 : 1, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <svg width="16" height="6">
                  <line x1="0" y1="3" x2="16" y2="3" stroke={`var(${st.colorVar})`} strokeWidth="2"
                    strokeDasharray={st.dash ? st.dash.join(' ') : undefined} />
                </svg>
                {n}
              </button>
            )
          })}
        </div>
      )}
      {mode === 'norm' && tc && refBins === 0 && (
        <div className="notice notice-warning" style={{ margin: '0 8px 4px' }}>
          No bins fall inside “{normRegion?.label}”. Pick another region or use shorter bins.
        </div>
      )}
      <div ref={containerRef} onContextMenu={onContextMenu} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {menu}
        {err && (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{err}</div>
        )}
      </div>
      <div style={{ padding: '2px 8px', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Uses the spectrum, band and line-noise settings on the left · drag to zoom time · double-click to reset ·
        click a point to show it in the trace · updates automatically, no Run needed
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// Tables
// ------------------------------------------------------------------

function RegionHeaderCells({ results, regions }: { results: SpectralRegionResult[]; regions: SpectralRegion[] }) {
  return (
    <>
      {results.map((r, i) => {
        const j = regions.findIndex((x) => x.id === r.regionId)
        return (
          <th key={r.regionId} colSpan={1} style={{ textAlign: 'right' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: `var(${regionColorVar(j >= 0 ? j : i)})` }} />
              {r.label}
            </span>
          </th>
        )
      })}
    </>
  )
}

// ------------------------------------------------------------------
// Coupling tab
// ------------------------------------------------------------------

type CouplingMeasure = 'coherence' | 'imag' | 'wpli' | 'dwpli' | 'phase'
const COUPLING_MEASURES: { key: CouplingMeasure; label: string; axis: string }[] = [
  { key: 'coherence', label: 'Coherence', axis: 'Coherence' },
  { key: 'imag', label: 'Imag. coherence', axis: 'Imaginary coherence' },
  { key: 'wpli', label: 'wPLI', axis: 'wPLI' },
  { key: 'dwpli', label: 'Debiased wPLI²', axis: 'Debiased wPLI²' },
  { key: 'phase', label: 'Phase', axis: 'Phase (rad)' },
]

function CouplingPanel({ results, regions, params, heightSignal }: {
  results: SpectralRegionResult[]
  regions: SpectralRegion[]
  params: SpectralParams
  heightSignal: number
}) {
  const [measure, setMeasure] = useState<CouplingMeasure>('coherence')
  const [xLog, setXLog] = useState(true)
  const ok = results.filter((r) => !r.error && r.coupling && !r.coupling.error)
  const failed = results.filter((r) => !r.error && r.coupling?.error)
  const R = params.coupling_ref_label || 'reference'
  const P = params.coupling_partner_label || 'partner'
  if (ok.length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
        {failed.length > 0
          ? failed.map((r) => <div key={r.regionId}>{r.label}: {r.coupling?.error}</div>)
          : <>Press <strong>Run</strong> to compute coupling between the two channels.</>}
      </div>
    )
  }
  const colorIdx = (r: SpectralRegionResult, i: number) => {
    const j = regions.findIndex((x) => x.id === r.regionId)
    return j >= 0 ? j : i
  }
  const bandNames: string[] = []
  for (const r of ok) for (const n of Object.keys(r.coupling!.bands)) if (!bandNames.includes(n)) bandNames.push(n)
  const f2 = (v: number | null | undefined, d = 2) => (v == null || !isFinite(v) ? '—' : v.toFixed(d))
  const rows: MeasureRow[] = [
    {
      key: 'xr', label: 'Cross-correlation peak r',
      cells: ok.map((r) => f2(r.coupling!.xcorr?.peakR)),
      copy: [{ label: 'Cross-correlation peak r', values: ok.map((r) => num(r.coupling!.xcorr?.peakR)) }],
    },
    {
      key: 'xl', label: `Lag at peak, ${P} − ${R} (ms)`,
      cells: ok.map((r) => {
        const x = r.coupling!.xcorr
        return x?.peakAtLimit ? <span style={{ color: 'var(--warning)' }} title="Best match at the edge of the search range — widen it">at limit</span> : f2(x?.peakLagMs)
      }),
      copy: [{ label: `Cross-correlation lag (ms)`, values: ok.map((r) => num(r.coupling!.xcorr?.peakLagMs)) }],
    },
    {
      key: 'x0', label: 'r at zero lag',
      cells: ok.map((r) => f2(r.coupling!.xcorr?.zeroLagR)),
      copy: [{ label: 'r at zero lag', values: ok.map((r) => num(r.coupling!.xcorr?.zeroLagR)) }],
    },
    ...bandNames.map((n): MeasureRow => {
      const b0 = ok.find((r) => r.coupling!.bands[n])?.coupling!.bands[n]
      const range = b0 ? `${b0.low}–${b0.high} Hz` : ''
      const get = (r: SpectralRegionResult) => r.coupling!.bands[n]
      return {
        key: `cb-${n}`,
        label: <>{n} <span style={{ color: 'var(--text-muted)' }}>{range}</span></>,
        cells: ok.map((r) => {
          const b = get(r)
          if (!b || b.coherence == null) return '—'
          return (
            <span title={`imaginary coherence ${f2(b.imagCoherence)} · debiased wPLI² ${f2(b.wpliDebiased)}`}>
              {f2(b.coherence)}
              <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>wPLI {f2(b.wpli)}</span>
              <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{b.phaseDelayMs != null ? `${b.phaseDelayMs >= 0 ? '+' : ''}${b.phaseDelayMs.toFixed(1)} ms` : '—'}</span>
            </span>
          )
        }),
        copy: [
          { label: `${n} ${range} coherence`, values: ok.map((r) => num(get(r)?.coherence)) },
          { label: `${n} ${range} imaginary coherence`, values: ok.map((r) => num(get(r)?.imagCoherence)) },
          { label: `${n} ${range} wPLI`, values: ok.map((r) => num(get(r)?.wpli)) },
          { label: `${n} ${range} debiased wPLI²`, values: ok.map((r) => num(get(r)?.wpliDebiased)) },
          { label: `${n} ${range} phase delay (ms)`, values: ok.map((r) => num(get(r)?.phaseDelayMs)) },
        ],
      }
    }),
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 6, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
        <div className="segmented">
          {COUPLING_MEASURES.map((m) => (
            <button key={m.key} className={measure === m.key ? 'active' : ''} onClick={() => setMeasure(m.key)}>{m.label}</button>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <input type="checkbox" checked={xLog} onChange={(e) => setXLog(e.target.checked)} />
          Log frequency
        </label>
        {ok.map((r, i) => (
          <span key={r.regionId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 3, borderRadius: 1, background: `var(${regionColorVar(colorIdx(r, i))})` }} />
            {r.label}
          </span>
        ))}
        {failed.length > 0 && <span style={{ color: 'var(--warning)' }}>{failed.map((r) => `${r.label}: ${r.coupling?.error}`).join(' · ')}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6, height: 230, flexShrink: 0 }}>
        <div style={{ flex: 1.6, minWidth: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
          <CouplingSpectrumPlot results={ok} colorIdx={colorIdx} measure={measure} xLog={xLog} params={params} heightSignal={heightSignal} />
        </div>
        <div style={{ flex: 1, minWidth: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
          <CrossCorrelationPlot results={ok} colorIdx={colorIdx} refLabel={R} partnerLabel={P} heightSignal={heightSignal} />
        </div>
      </div>
      <MeasureTable results={ok} regions={regions} rows={rows} />
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Each band shows coherence, wPLI and the phase-slope delay ({P} − {R}; positive = {R} leads).
        Coherence also counts the zero-lag signal two nearby electrodes pick up from the same field;
        imaginary coherence and wPLI ignore it, so a high coherence with wPLI near 0 points to volume
        conduction rather than coupling. With a finite number of segments wPLI reads above 0 even
        without coupling (about 0.1 with 120 segments); the debiased wPLI² (hover a band, or the
        plot) is 0 on average without coupling. Delays are shown only where coherence reaches {params.coupling_min_coherence}.
        A strong narrow rhythm pulls the phase-slope delay of its own band toward zero; the
        cross-correlation lag is the more robust overall delay. Select rows and right-click to copy.
      </div>
    </div>
  )
}

function useSimplePlot(build: (el: HTMLDivElement) => uPlot | null, deps: unknown[], heightSignal: number) {
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
  useEffect(() => {
    const u = plot.current, el = ref.current
    if (u && el && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])
  return { ref, plot }
}

function plotAxisStyle() {
  return {
    stroke: cssVar('--chart-axis'),
    grid: { stroke: cssVar('--chart-grid'), width: 1 },
    ticks: { stroke: cssVar('--chart-tick'), width: 1 },
    font: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
    labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
  }
}

function CouplingSpectrumPlot({ results, colorIdx, measure, xLog, params, heightSignal }: {
  results: SpectralRegionResult[]
  colorIdx: (r: SpectralRegionResult, i: number) => number
  measure: CouplingMeasure
  xLog: boolean
  params: SpectralParams
  heightSignal: number
}) {
  const def = COUPLING_MEASURES.find((m) => m.key === measure)!
  const { ref, plot } = useSimplePlot((el) => {
    const tables: uPlot.AlignedData[] = results.map((r) => {
      const c = r.coupling!
      const ys = measure === 'coherence' ? c.coherence : measure === 'imag' ? c.imagCoherence
        : measure === 'wpli' ? c.wpli : measure === 'dwpli' ? c.wpliDebiased : c.phase
      const xs: number[] = [], vs: (number | null)[] = []
      for (let i = 0; i < c.freqs.length; i++) {
        if (xLog && c.freqs[i] <= 0) continue
        xs.push(c.freqs[i]); vs.push(ys[i] ?? null)
      }
      return [xs, vs] as uPlot.AlignedData
    })
    const data = tables.length === 1 ? tables[0] : uPlot.join(tables)
    const xs0 = data[0] as unknown as number[]
    if (xs0.length === 0) return null
    const xMin = Math.max(xs0[0], params.fmin > 0 ? params.fmin : xs0[0])
    const xMax = xs0[xs0.length - 1]
    const yr: [number, number] = measure === 'phase' ? [-Math.PI, Math.PI] : measure === 'imag' ? [-1, 1] : measure === 'dwpli' ? [-0.2, 1] : [0, 1]
    const axis = plotAxisStyle()
    const shade = cssVar('--text-muted')
    const opts: uPlot.Options = {
      width: el.clientWidth || 400, height: el.clientHeight || 220,
      legend: { show: false },
      scales: { x: { time: false, distr: xLog ? 3 : 1, range: () => [xMin, xMax] }, y: { range: () => yr } },
      axes: [{ ...axis, label: 'Frequency (Hz)' }, { ...axis, size: 55, label: def.axis }],
      cursor: { drag: { x: true, y: false } },
      series: [{}, ...results.map((r, i) => ({
        label: r.label, stroke: cssVar(regionColorVar(colorIdx(r, i))), width: 1.4,
        points: { show: false }, spanGaps: true,
      }))],
      hooks: {
        drawClear: [(u: uPlot) => {
          const ctx = u.ctx
          ctx.save()
          params.bands.forEach((b, i) => {
            if (!(b.high > b.low) || b.high < xMin || b.low > xMax) return
            const p0 = u.valToPos(Math.max(b.low, xMin), 'x', true)
            const p1 = u.valToPos(Math.min(b.high, xMax), 'x', true)
            ctx.fillStyle = shade
            ctx.globalAlpha = i % 2 === 0 ? 0.07 : 0.03
            ctx.fillRect(p0, u.bbox.top, p1 - p0, u.bbox.height)
          })
          ctx.restore()
        }],
      },
    }
    const attach = attachHoverCoords(opts, { xUnit: 'Hz', xDigits: 2, yDigits: 3 })
    const u = new uPlot(opts, data, el)
    attach(el)
    return u
  }, [results, measure, xLog, params.bands, params.fmin], heightSignal)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plot.current?.ctx?.canvas ?? null,
    getUplot: () => plot.current ?? null,
    defaultName: `coupling-${measure}`,
    asterism: 'xy',
  })
  return <div ref={ref} onContextMenu={onContextMenu} style={{ width: '100%', height: '100%', position: 'relative' }}>{menu}</div>
}

function CrossCorrelationPlot({ results, colorIdx, refLabel, partnerLabel, heightSignal }: {
  results: SpectralRegionResult[]
  colorIdx: (r: SpectralRegionResult, i: number) => number
  refLabel: string
  partnerLabel: string
  heightSignal: number
}) {
  const { ref, plot } = useSimplePlot((el) => {
    const withX = results.filter((r) => r.coupling!.xcorr)
    if (withX.length === 0) return null
    const tables = withX.map((r) => [r.coupling!.xcorr!.lagsMs, r.coupling!.xcorr!.r] as uPlot.AlignedData)
    const data = tables.length === 1 ? tables[0] : uPlot.join(tables)
    const axis = plotAxisStyle()
    const opts: uPlot.Options = {
      width: el.clientWidth || 300, height: el.clientHeight || 220,
      legend: { show: false },
      scales: { x: { time: false }, y: { range: (_u, lo, hi) => [Math.min(-0.1, lo), Math.max(0.1, hi)] } },
      axes: [{ ...axis, label: `Lag, ${partnerLabel} − ${refLabel} (ms)` }, { ...axis, size: 45, label: 'r' }],
      cursor: { drag: { x: true, y: false } },
      series: [{}, ...withX.map((r) => ({
        label: r.label, stroke: cssVar(regionColorVar(colorIdx(r, results.indexOf(r)))), width: 1.4,
        points: { show: false }, spanGaps: true,
      }))],
      hooks: {
        draw: [(u: uPlot) => {
          const x0 = u.valToPos(0, 'x', true)
          const ctx = u.ctx
          ctx.save()
          ctx.strokeStyle = cssVar('--text-muted')
          ctx.setLineDash([4, 3])
          ctx.beginPath(); ctx.moveTo(x0, u.bbox.top); ctx.lineTo(x0, u.bbox.top + u.bbox.height); ctx.stroke()
          ctx.restore()
        }],
      },
    }
    const attach = attachHoverCoords(opts, { xUnit: 'ms', xDigits: 2, yDigits: 3 })
    const u = new uPlot(opts, data, el)
    attach(el)
    return u
  }, [results, refLabel, partnerLabel], heightSignal)
  const { onContextMenu, menu } = usePlotMenu({
    getCanvas: () => plot.current?.ctx?.canvas ?? null,
    getUplot: () => plot.current ?? null,
    defaultName: 'cross-correlation',
    asterism: 'xy',
  })
  return <div ref={ref} onContextMenu={onContextMenu} style={{ width: '100%', height: '100%', position: 'relative' }}>{menu}</div>
}

/** One displayed row of a measures × regions table. ``copy`` is what
 *  "Copy as TSV" writes for it — one or more rows of plain numbers (a
 *  "power + share" cell becomes two rows, so every TSV cell is one value). */
interface MeasureRow {
  key: string
  label: React.ReactNode
  cells: React.ReactNode[]
  copy: { label: string; values: (number | string | null)[] }[]
}

/** Measures × regions table with row selection and right-click
 *  "Copy as TSV", like the other results tables. */
function MeasureTable({ results, regions, rows }: {
  results: SpectralRegionResult[]
  regions: SpectralRegion[]
  rows: MeasureRow[]
}) {
  const sel = useRowSelection(rows.length)
  const copyMenu = useRowCopyMenu({
    selectionCount: sel.selectedIndexes.length,
    getTSV: () => sel.selectedIndexes.length === 0 ? null
      : buildTSV(['Measure', ...results.map((r) => r.label)],
        sel.selectedIndexes.flatMap((i) => rows[i].copy.map((c) => [c.label, ...c.values]))),
  })
  return (
    <>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr><th style={{ textAlign: 'left' }}>Measure</th><RegionHeaderCells results={results} regions={regions} /></tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key}
              onClick={(ev) => sel.onRowClick(i, ev)}
              onContextMenu={(ev) => copyMenu.onContextMenu(ev, () => {
                if (!sel.isSelected(i)) sel.setSelected([i])
              })}
              style={{ background: sel.isSelected(i) ? 'var(--accent-muted)' : 'transparent' }}>
              <td>{row.label}</td>
              {row.cells.map((c, k) => (
                <td key={k} className="num" style={{ textAlign: 'right' }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {copyMenu.menu}
    </>
  )
}

// 10 significant digits: drops float noise such as 120.00000000398359.
const num = (v: number | null | undefined) => (v == null || !isFinite(v) ? null : Number(v.toPrecision(10)))

function BandTable({
  results, regions, params, units,
}: {
  results: SpectralRegionResult[]
  regions: SpectralRegion[]
  params: SpectralParams
  units: string
}) {
  const pu = powerUnits(units)
  const bandNames: string[] = []
  for (const r of results) for (const n of Object.keys(r.bands ?? {})) if (!bandNames.includes(n)) bandNames.push(n)
  const ok = (r: SpectralRegionResult) => !r.error
  const simple = (key: string, label: string, get: (r: SpectralRegionResult) => number | null | undefined,
    show: (v: number | null | undefined, r: SpectralRegionResult) => React.ReactNode = (v) => fmtNum(v)): MeasureRow => ({
    key, label,
    cells: results.map((r) => (ok(r) ? show(get(r), r) : '—')),
    copy: [{ label, values: results.map((r) => (ok(r) ? num(get(r)) : null)) }],
  })
  const rows: MeasureRow[] = [
    simple('dur', 'Duration analysed (s)', (r) => r.durationS, (v) => fmtNum(v, 4)),
    {
      key: 'segs', label: 'Sweeps · segments',
      cells: results.map((r) => (ok(r) ? `${r.sweepsUsed.length} · ${r.nSegments}` : '—')),
      copy: [
        { label: 'Sweeps', values: results.map((r) => (ok(r) ? r.sweepsUsed.length : null)) },
        { label: 'Segments', values: results.map((r) => (ok(r) ? r.nSegments : null)) },
      ],
    },
    simple('rms', `RMS (${units || 'units'})`, (r) => r.rms),
    simple('total', `Total power ${params.fmin}–${params.fmax} Hz (${pu.power})`, (r) => r.totalPower),
    simple('dom', 'Dominant frequency (Hz)', (r) => r.dominantFreqHz),
    ...bandNames.map((n): MeasureRow => {
      const b0 = results.find((r) => r.bands?.[n])?.bands[n]
      const range = b0 ? `${b0.low}–${b0.high} Hz` : ''
      return {
        key: `band-${n}`,
        label: <>{n} <span style={{ color: 'var(--text-muted)' }}>{range}</span></>,
        cells: results.map((r) => {
          const b = r.bands?.[n]
          if (!ok(r) || !b || b.power == null) return <span title={b?.note}>—</span>
          return (
            <span title={`peak ${fmtNum(b.peakFreqHz)} Hz`}>
              {fmtNum(b.power)}
              <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{fmtPct(b.relative)}</span>
            </span>
          )
        }),
        copy: [
          { label: `${n} ${range} power (${pu.power})`, values: results.map((r) => (ok(r) ? num(r.bands?.[n]?.power) : null)) },
          { label: `${n} ${range} share of total`, values: results.map((r) => (ok(r) ? num(r.bands?.[n]?.relative) : null)) },
          { label: `${n} ${range} peak (Hz)`, values: results.map((r) => (ok(r) ? num(r.bands?.[n]?.peakFreqHz) : null)) },
        ],
      }
    }),
  ]
  return (
    <div style={{ padding: 6 }}>
      <MeasureTable results={results} regions={regions} rows={rows} />
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        Band power in {pu.power}; percentage = share of total power in {params.fmin}–{params.fmax} Hz
        (blank for bands outside that range). Hover a value for the band's peak frequency. Select rows
        and right-click to copy them.
        {params.exclude_line_noise && <> Mains bins ({params.line_freq} Hz and harmonics) are interpolated across.</>}
      </div>
    </div>
  )
}

function LineNoiseTable({
  results, regions, params, units,
}: {
  results: SpectralRegionResult[]
  regions: SpectralRegion[]
  params: SpectralParams
  units: string
}) {
  const freqs: number[] = []
  for (const r of results) for (const h of r.lineNoise?.harmonics ?? []) if (!freqs.includes(h.freqHz)) freqs.push(h.freqHz)
  freqs.sort((a, b) => a - b)
  const unreliable = results.some((r) => !r.error && r.lineNoise && !r.lineNoise.reliable)
  const ok = (r: SpectralRegionResult) => !r.error
  const u = units || 'units'
  const harm = (r: SpectralRegionResult, f: number) => r.lineNoise?.harmonics.find((hh) => hh.freqHz === f)
  const rows: MeasureRow[] = [
    {
      key: 'rms', label: `Broadband RMS (${u})`,
      cells: results.map((r) => (ok(r) ? fmtNum(r.rms) : '—')),
      copy: [{ label: `Broadband RMS (${u})`, values: results.map((r) => (ok(r) ? num(r.rms) : null)) }],
    },
    {
      key: 'mains', label: `Mains RMS, all harmonics (${u})`,
      cells: results.map((r) => (ok(r) ? fmtNum(r.lineNoise?.rms) : '—')),
      copy: [{ label: `Mains RMS, all harmonics (${u})`, values: results.map((r) => (ok(r) ? num(r.lineNoise?.rms) : null)) }],
    },
    ...freqs.map((f): MeasureRow => ({
      key: `h-${f}`,
      label: <>{f} Hz <span style={{ color: 'var(--text-muted)' }}>above floor · RMS</span></>,
      cells: results.map((r) => {
        const h = ok(r) ? harm(r, f) : undefined
        if (!h) return '—'
        const db = h.prominenceDb
        const strong = db != null && db >= 10
        return (
          <span>
            <span style={{ color: strong ? 'var(--warning)' : undefined }}>{db != null ? fmtDb(db) : '—'}</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{fmtNum(h.rms)}</span>
          </span>
        )
      }),
      copy: [
        { label: `${f} Hz above floor (dB)`, values: results.map((r) => (ok(r) ? num(harm(r, f)?.prominenceDb) : null)) },
        { label: `${f} Hz RMS (${u})`, values: results.map((r) => (ok(r) ? num(harm(r, f)?.rms) : null)) },
      ],
    })),
  ]
  return (
    <div style={{ padding: 6 }}>
      {unreliable && (
        <div className="notice notice-warning" style={{ marginBottom: 6 }}>
          Frequency resolution is coarser than 1 Hz, so mains peaks blur into their neighbours. Use a
          segment length of at least 1 s for line-noise checks.
        </div>
      )}
      <MeasureTable results={results} regions={regions} rows={rows} />
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        "Above floor" compares each {params.line_freq} Hz harmonic with the median of the spectrum 2–6 Hz
        either side; about +10 dB or more (amber) is clearly visible interference. RMS is the amplitude of
        the interference itself, after subtracting that floor.
      </div>
    </div>
  )
}
