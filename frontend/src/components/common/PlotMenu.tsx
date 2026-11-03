import React, { useCallback, useEffect, useState } from 'react'
import type uPlot from 'uplot'
import {
  type AsterismTable, uplotToSvg, uplotToTable, tableToCsv, tableToTsv,
} from '../../utils/plotExport'

/**
 * Reusable right-click "Copy / Save as PNG / SVG" menu for any plot
 * surface in the app — uPlot canvas viewers, matplotlib SVG strings,
 * raw SVG elements, etc. Each call site provides whichever sources
 * it has (canvas getter, SVG-string getter, or both); the menu shows
 * only the actions backed by available sources.
 *
 * Usage:
 *   const { onContextMenu, menu } = usePlotMenu({
 *     getCanvas: () => uplotRef.current?.ctx.canvas ?? null,
 *     defaultName: 'trace',
 *   })
 *   return <div onContextMenu={onContextMenu}>{...children}{menu}</div>
 */

export interface PlotMenuExtraItem {
  /** Visible label. Empty string renders a separator divider. */
  label: string
  /** Optional right-side hint text. */
  hint?: string
  /** Click handler. The menu auto-closes after the click. Omit for
   *  disabled / informational items. */
  onClick?: () => void
}

export interface PlotMenuSources {
  /** Returns the canvas to copy/save as PNG, or null if unavailable
   *  (e.g. before a uPlot rebuild has populated the ref). */
  getCanvas?: () => HTMLCanvasElement | null
  /** Returns the SVG string to copy/save, or null if unavailable. */
  getSvg?: () => string | null
  /** The uPlot instance behind the canvas. Enables vector output
   *  (PDF / SVG redrawn from the plotted data and axes). */
  getUplot?: () => uPlot | null
  /** Enables "Export for ASTERISM": ``'xy'`` exports the plotted data
   *  (X column + one column per visible series); a function returns a
   *  custom table, e.g. raw values behind a histogram. */
  asterism?: 'xy' | (() => AsterismTable | null)
  /** ``false`` hides the vector items — for plots whose content is
   *  drawn in canvas hooks, where a redraw from the data would be empty. */
  vector?: boolean
  /** Default base filename used in Save dialogs (no extension). */
  defaultName?: string
  /** Caller-supplied items prepended above the Copy / Save block.
   *  Re-evaluated every time the menu opens (callback) so callers can
   *  pass live state (e.g. "Open in Event Browser at event #42")
   *  without rebuilding the source object. */
  getExtraItems?: () => PlotMenuExtraItem[]
}

interface MenuPos { x: number; y: number }

export function usePlotMenu(sources: PlotMenuSources) {
  const [pos, setPos] = useState<MenuPos | null>(null)

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    // Only fire when at least one source is actually available right
    // now — otherwise let the platform menu through (avoids confusing
    // empty-state menus on a viewer with nothing rendered yet).
    const hasCanvas = sources.getCanvas?.() != null || sources.getUplot?.() != null
    const hasSvg = sources.getSvg?.() != null
    const hasExtra = (sources.getExtraItems?.()?.length ?? 0) > 0
    if (!hasCanvas && !hasSvg && !hasExtra) return
    e.preventDefault()
    setPos({ x: e.clientX, y: e.clientY })
  }, [sources])

  const menu = pos && (
    <PlotContextMenu
      x={pos.x}
      y={pos.y}
      sources={sources}
      onClose={() => setPos(null)}
    />
  )

  return { onContextMenu, menu }
}

interface PlotContextMenuProps {
  x: number
  y: number
  sources: PlotMenuSources
  onClose: () => void
}

function PlotContextMenu({ x, y, sources, onClose }: PlotContextMenuProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement
      if (!target.closest('[data-plot-menu]')) onClose()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const baseName = sources.defaultName?.trim() || 'figure'

  // Re-evaluate availability on every render — the canvas pointer
  // changes when uPlot rebuilds, and SVG strings are passed through
  // closures that may have updated since the menu opened.
  const uplot = sources.getUplot?.() ?? null
  const canvas = sources.getCanvas?.() ?? uplot?.ctx?.canvas ?? null
  const svg = sources.getSvg?.() ?? null
  const hasCanvas = canvas != null
  const hasSvg = svg != null
  // Vector source: a caller-supplied SVG (Cohort) or one redrawn from
  // the uPlot instance.
  const hasVector = sources.vector !== false && (hasSvg || uplot != null)
  const vectorSvg = (): { svg: string; width: number; height: number } | null => {
    if (svg) {
      const w = Number(/\bwidth="([\d.]+)/.exec(svg)?.[1] ?? 600)
      const h = Number(/\bheight="([\d.]+)/.exec(svg)?.[1] ?? 400)
      return { svg, width: w, height: h }
    }
    return uplot ? uplotToSvg(uplot) : null
  }
  const asterismTable = (): AsterismTable | null => {
    if (!sources.asterism) return null
    if (sources.asterism === 'xy') return uplot ? uplotToTable(uplot) : null
    return sources.asterism()
  }

  async function ok(text: string) {
    setToast({ kind: 'ok', text })
    setTimeout(onClose, 600)
  }
  function err(text: string) { setToast({ kind: 'err', text }) }

  // ----- PNG actions ------------------------------------------------------
  async function copyPng() {
    setBusy('copy-png')
    try {
      const blob = await pngBlobFrom(sources)
      if (!blob) throw new Error('No PNG source.')
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('Image clipboard not available.')
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      ok('PNG copied to clipboard')
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function savePng() {
    setBusy('save-png')
    try {
      const api = window.electronAPI
      if (!api) throw new Error('Electron API unavailable.')
      const path = await api.saveFileDialog?.(`${baseName}.png`, [
        { name: 'PNG', extensions: ['png'] },
      ])
      if (!path) { setBusy(null); return }
      const blob = await pngBlobFrom(sources)
      if (!blob) throw new Error('No PNG source.')
      const buf = await blob.arrayBuffer()
      const result = await api.writeBinaryFile(path, arrayBufferToBase64(buf))
      if (!result.ok) throw new Error(result.error || 'write failed')
      ok('PNG saved')
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  // ----- ASTERISM actions -------------------------------------------------
  async function exportAsterism() {
    setBusy('asterism')
    try {
      const t = asterismTable()
      if (!t || t.columns.length === 0) throw new Error('Nothing to export yet.')
      const api = window.electronAPI
      if (!api) throw new Error('Electron API unavailable.')
      const path = await api.saveFileDialog?.(`${baseName}.csv`, [
        { name: 'CSV', extensions: ['csv'] },
      ])
      if (!path) { setBusy(null); return }
      const result = await api.writeTextFile(path, tableToCsv(t))
      if (!result.ok) throw new Error(result.error || 'write failed')
      ok('Saved — import it in ASTERISM')
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function copyAsterism() {
    setBusy('asterism-copy')
    try {
      const t = asterismTable()
      if (!t || t.columns.length === 0) throw new Error('Nothing to copy yet.')
      await navigator.clipboard.writeText(tableToTsv(t))
      ok(`${t.columns.length} columns copied — paste into an ASTERISM table`)
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  // ----- Vector actions (PDF / SVG) -----------------------------------------
  async function copyVector() {
    setBusy('copy-vector')
    try {
      const v = vectorSvg()
      if (!v) throw new Error('No vector source for this view.')
      const api = window.electronAPI
      if (api?.copyVector) {
        const r = await api.copyVector(v.svg, v.width, v.height)
        if (!r.ok) throw new Error(r.error || 'copy failed')
        ok(r.format === 'pdf' ? 'Vector copied — paste into Affinity / Illustrator' : 'SVG copied')
      } else {
        await navigator.clipboard.writeText(v.svg)
        ok('SVG copied')
      }
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function savePdf() {
    setBusy('save-pdf')
    try {
      const v = vectorSvg()
      if (!v) throw new Error('No vector source for this view.')
      const api = window.electronAPI
      if (!api?.svgToPdf) throw new Error('PDF export unavailable.')
      const path = await api.saveFileDialog?.(`${baseName}.pdf`, [
        { name: 'PDF', extensions: ['pdf'] },
      ])
      if (!path) { setBusy(null); return }
      const r = await api.svgToPdf(v.svg, v.width, v.height)
      if (!r.ok || !r.base64) throw new Error(r.error || 'PDF failed')
      const w = await api.writeBinaryFile(path, r.base64)
      if (!w.ok) throw new Error(w.error || 'write failed')
      ok('PDF saved')
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function saveVectorSvg() {
    setBusy('save-svg')
    try {
      const v = vectorSvg()
      if (!v) throw new Error('No vector source for this view.')
      const api = window.electronAPI
      if (!api) throw new Error('Electron API unavailable.')
      const path = await api.saveFileDialog?.(`${baseName}.svg`, [
        { name: 'SVG', extensions: ['svg'] },
      ])
      if (!path) { setBusy(null); return }
      const result = await api.writeTextFile(path, v.svg)
      if (!result.ok) throw new Error(result.error || 'write failed')
      ok('SVG saved')
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  // ----- SVG actions ------------------------------------------------------
  async function copySvg() {
    setBusy('copy-svg')
    try {
      if (!svg) throw new Error('No SVG source for this view.')
      let copied = false
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'image/svg+xml': new Blob([svg], { type: 'image/svg+xml' }),
              'text/plain': new Blob([svg], { type: 'text/plain' }),
            }),
          ])
          copied = true
        }
      } catch { /* fall through */ }
      if (!copied) await navigator.clipboard.writeText(svg)
      ok('SVG copied — paste in Illustrator')
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function saveSvg() {
    setBusy('save-svg')
    try {
      if (!svg) throw new Error('No SVG source for this view.')
      const api = window.electronAPI
      if (!api) throw new Error('Electron API unavailable.')
      const path = await api.saveFileDialog?.(`${baseName}.svg`, [
        { name: 'SVG', extensions: ['svg'] },
      ])
      if (!path) { setBusy(null); return }
      const result = await api.writeTextFile(path, svg)
      if (!result.ok) throw new Error(result.error || 'write failed')
      ok('SVG saved')
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  // Clamp inside viewport.
  const W = 260
  const H = 60 + (hasVector ? 80 : 0) + (sources.asterism ? 60 : 0) + (hasSvg ? 30 : 0)
  const left = Math.min(x, window.innerWidth - W - 4)
  const top = Math.min(y, window.innerHeight - H - 4)

  return (
    <div
      data-plot-menu
      style={{
        position: 'fixed', left, top, zIndex: 200,
        minWidth: W,
        padding: 5,
        background: 'var(--bg-field)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-popover)',
        fontSize: 'var(--font-size-base)',
        fontFamily: 'var(--font-ui)',
        overflow: 'hidden',
      }}
    >
      {(() => {
        const extra = sources.getExtraItems?.() ?? []
        if (extra.length === 0) return null
        return (
          <>
            {extra.map((it, i) => it.label === '' ? (
              <Divider key={`div-${i}`} />
            ) : (
              <Item key={`x-${i}`} label={it.label} hint={it.hint}
                onClick={it.onClick ? () => { it.onClick!(); onClose() } : undefined}
                disabled={!it.onClick} />
            ))}
            <Divider />
          </>
        )
      })()}
      {sources.asterism && (
        <>
          <Item label="Export for ASTERISM…" hint="CSV table" busy={busy === 'asterism'} onClick={exportAsterism} />
          <Item label="Copy values" hint="paste into a table" busy={busy === 'asterism-copy'} onClick={copyAsterism} />
          <Divider />
        </>
      )}
      {hasVector && (
        <>
          <Item label="Copy vector" hint="paste into Affinity / Illustrator" busy={busy === 'copy-vector'} onClick={copyVector} />
          <Item label="Save PDF…" hint="vector" busy={busy === 'save-pdf'} onClick={savePdf} />
          <Item label="Save SVG…" hint="vector, fully editable"
            busy={busy === 'save-svg'} onClick={hasSvg ? saveSvg : saveVectorSvg} />
          {hasSvg && (
            <Item label="Copy SVG code" hint="as text" busy={busy === 'copy-svg'} onClick={copySvg} />
          )}
          <Divider />
        </>
      )}
      {hasCanvas || hasSvg ? (
        <>
          <Item label="Copy PNG" hint="paste into Slack / docs" busy={busy === 'copy-png'} onClick={copyPng} />
          <Item label="Save PNG…" hint={hasSvg ? 'rasterized at view size' : 'at view resolution'} busy={busy === 'save-png'} onClick={savePng} />
        </>
      ) : (
        <Item label="No source available" disabled />
      )}
      {toast && (
        <div style={{
          marginTop: 4,
          padding: '4px 8px',
          fontSize: 'var(--font-size-xs)',
          borderRadius: 'var(--radius-sm)',
          background: toast.kind === 'err'
            ? 'color-mix(in oklab, var(--error) 14%, transparent)'
            : 'color-mix(in oklab, var(--success) 14%, transparent)',
          color: toast.kind === 'err' ? 'var(--error)' : 'var(--text-primary)',
        }}>{toast.text}</div>
      )}
    </div>
  )
}

function Item({ label, hint, onClick, busy, disabled }: {
  label: string; hint?: string; onClick?: () => void; busy?: boolean; disabled?: boolean
}) {
  return (
    <button
      className={disabled || busy ? undefined : 'analysis-menu-item'}
      onClick={onClick}
      disabled={busy || disabled}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '4px 8px',
        background: 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        cursor: busy ? 'wait' : 'default',
        fontSize: 'var(--font-size-base)',
        fontFamily: 'var(--font-ui)',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span>{busy ? `${label}…` : label}</span>
        {hint && (
          <span style={{ color: 'inherit', opacity: 0.6, fontSize: 'var(--font-size-xs)', marginLeft: 'auto' }}>{hint}</span>
        )}
      </div>
    </button>
  )
}

function Divider() {
  return <div style={{ height: 1, margin: '4px 6px', background: 'var(--border)' }} />
}

// ---------------------------------------------------------------------------
// PNG conversion helpers
// ---------------------------------------------------------------------------

/** Get a PNG blob from whichever source the call site provided.
 *  Canvas takes priority (faster, lossless DPR scaling already
 *  baked in). SVG-only sources rasterize via Image + canvas. */
async function pngBlobFrom(sources: PlotMenuSources): Promise<Blob | null> {
  const canvas = sources.getCanvas?.()
  if (canvas) {
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    )
  }
  const svg = sources.getSvg?.()
  if (svg) return await rasterizeSvgToPng(svg)
  return null
}

/** Rasterize an SVG string to a PNG blob via an offscreen canvas.
 *  The SVG's intrinsic width/height (or viewBox) drives the output
 *  resolution; we multiply by 2 so the result reads as ~retina. */
function rasterizeSvgToPng(svg: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const scale = 2
      const w = (img.naturalWidth || 600) * scale
      const h = (img.naturalHeight || 400) * scale
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); resolve(null); return }
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      canvas.toBlob((b) => resolve(b), 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
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
