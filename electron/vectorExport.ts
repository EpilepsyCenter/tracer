/**
 * Vector figures for the plot right-click menu.
 *
 * - `svgToPdf`: SVG → PDF through Chromium's print-to-PDF, which keeps
 *   paths and text as vectors. Rendered in a hidden window from a temp
 *   file (data: URLs have size limits that large plots exceed).
 * - `copyVectorToClipboard`: on macOS puts the PDF on the pasteboard as
 *   `com.adobe.pdf` — the type Affinity, Illustrator, Word and Keynote
 *   paste as editable vectors (ASTERISM does the same). Elsewhere the
 *   SVG text, which Illustrator and Inkscape paste as vectors.
 */

import { BrowserWindow, clipboard } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

export async function svgToPdf(svg: string, widthPx: number, heightPx: number, tmpDir: string): Promise<Buffer> {
  const w = Math.max(10, Math.ceil(widthPx))
  const h = Math.max(10, Math.ceil(heightPx))
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>'
    + `@page{size:${w}px ${h}px;margin:0}html,body{margin:0;padding:0;background:#fff}`
    + `svg{display:block;width:${w}px;height:${h}px}</style></head><body>${svg}</body></html>`
  const tmp = join(tmpDir, `tracer-vector-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.html`)
  writeFileSync(tmp, html, 'utf-8')
  const win = new BrowserWindow({
    show: false, width: w, height: h,
    webPreferences: { javascript: false, sandbox: true },
  })
  try {
    await win.loadFile(tmp)
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  } finally {
    win.destroy()
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

export async function copyVectorToClipboard(
  svg: string, widthPx: number, heightPx: number, tmpDir: string,
): Promise<'pdf' | 'svg'> {
  if (process.platform === 'darwin') {
    const pdf = await svgToPdf(svg, widthPx, heightPx, tmpDir)
    clipboard.writeBuffer('com.adobe.pdf', pdf)
    return 'pdf'
  }
  clipboard.writeText(svg)
  return 'svg'
}
