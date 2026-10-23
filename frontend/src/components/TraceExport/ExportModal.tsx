import React, { useEffect, useState } from 'react'
import { currentViewRef, useTraceExportStore } from '../../stores/traceExportStore'

interface Props {
  backendUrl: string
  onClose: () => void
}

/**
 * Export-preview modal — renders the matplotlib output as SVG and
 * shows it inline before the user commits to saving. The same
 * payload is then re-rendered (in PDF or PNG) when the user picks
 * a non-SVG format at save time.
 *
 * The SVG preview is the truth check: if the user sees something
 * weird here that they don't see in the live uPlot panel, that's a
 * matplotlib rendering quirk and we want to surface it BEFORE the
 * file lands on disk.
 */
export function ExportModal({ backendUrl, onClose }: Props) {
  const items = useTraceExportStore((s) => s.items)
  const seriesCfgs = useTraceExportStore((s) => s.seriesCfgs)
  const axes = useTraceExportStore((s) => s.axes)
  const scalebar = useTraceExportStore((s) => s.scalebar)
  const legend = useTraceExportStore((s) => s.legend)
  const axisStyle = useTraceExportStore((s) => s.axisStyle)
  const panelLayout = useTraceExportStore((s) => s.panelLayout)
  const width_cm = useTraceExportStore((s) => s.width_cm)
  const height_cm = useTraceExportStore((s) => s.height_cm)
  const dpi = useTraceExportStore((s) => s.dpi)

  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [format, setFormat] = useState<'svg' | 'pdf' | 'png'>('svg')

  function buildPayload(fmt: 'svg' | 'pdf' | 'png') {
    // Snapshot the live preview's current zoom so the export matches
    // what the user is looking at on screen. PreviewPanel writes the
    // current scale ranges into ``currentViewRef`` on every wheel /
    // pan / Fit; we read them here and override each axis's min/max
    // (and the figure's x-range) regardless of the FigurePanel's
    // "Manual limits" toggle. Without this the matplotlib renderer
    // would auto-fit the data envelope, ignoring the user's zoom.
    const viewRanges = currentViewRef.ranges
    const axesWithLiveView = axes.map((a) => {
      const v = viewRanges[a.id]
      if (!v) return a
      return { ...a, auto_limits: false, min: v.min, max: v.max }
    })
    const xView = viewRanges['x']
    return {
      items: items.map((i) => ({
        id: i.id,
        file_path: i.file_path,
        group: i.group,
        series: i.series,
        trace: i.trace,
        sweeps: i.sweeps,
        show_individuals: i.show_individuals,
        show_mean: i.show_mean,
        style: i.style,
        x_offset: i.x_offset,
        y_offset: i.y_offset,
        x_range: i.x_range,
        axis_id: i.axis_id,
        display_name: i.display_name,
      })),
      series_cfgs: seriesCfgs,
      axes: axesWithLiveView,
      scalebar,
      legend,
      axis_style: axisStyle,
      panel_layout: panelLayout,
      width_cm, height_cm, dpi,
      format: fmt,
      figure_x_range: xView ? [xView.min, xView.max] : null,
    }
  }

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    ;(async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/trace_export/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload('svg')),
        })
        if (cancelled) return
        if (!resp.ok) {
          setError(`Render failed: ${resp.status} ${await resp.text()}`)
          setSvg(null)
        } else {
          setSvg(await resp.text())
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
    const api = window.electronAPI
    if (!api) return
    const ext = format
    const path = await api.saveFileDialog?.(`figure.${ext}`, [
      { name: ext.toUpperCase(), extensions: [ext] },
    ])
    if (!path) return
    try {
      setBusy(true)
      if (format === 'svg' && svg) {
        const result = await api.writeTextFile(path, svg)
        if (!result.ok) throw new Error(result.error || 'write failed')
      } else {
        const resp = await fetch(`${backendUrl}/api/trace_export/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload(format)),
        })
        if (!resp.ok) throw new Error(`Render failed: ${resp.status}`)
        if (format === 'pdf' || format === 'png') {
          const buf = await resp.arrayBuffer()
          const base64 = arrayBufferToBase64(buf)
          const result = await api.writeBinaryFile(path, base64)
          if (!result.ok) throw new Error(result.error || 'write failed')
        }
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '80vw', maxWidth: 1100, height: '85vh',
          background: 'var(--bg-primary)', color: 'var(--text-primary)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-popover)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
        }}>
          <strong>Export preview</strong>
          <button className="btn" onClick={onClose} style={{ padding: '2px 8px' }}>×</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12, background: 'white' }}>
          {error && (
            <div className="notice notice-error" style={{ marginBottom: 8 }}>{error}</div>
          )}
          {busy && !svg && <div style={{ color: 'var(--text-muted)' }}>Rendering…</div>}
          {svg && (
            <div
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: 8,
          borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)',
        }}>
          <span>Format:</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as any)}>
            <option value="svg">SVG (vector)</option>
            <option value="pdf">PDF (vector)</option>
            <option value="png">PNG (raster)</option>
          </select>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !!error}
          >
            Save…
          </button>
        </div>
      </div>
    </div>
  )
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bytes.subarray(i, Math.min(i + chunk, bytes.byteLength)) as any,
    )
  }
  return btoa(binary)
}
