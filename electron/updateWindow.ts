// The "Updating TRACER" window: shows what an in-app update is doing.
//
//   1. Downloading — determinate bar, size, time left, Cancel.
//   2. Getting ready — moving bar while the download is checked and
//      unpacked (macOS).
//   3. Ready — says what happens next (TRACER closes, installs, opens
//      again) with Restart and Install / Later.
//
// A small native window with a self-contained data: page, like the
// splash. The updater drives it with setState() (executeJavaScript); the
// page's buttons navigate to ``tracer-update:<action>``, which is caught
// in ``will-navigate`` — no preload or IPC needed. The page follows the
// app's light/dark appearance (nativeTheme drives prefers-color-scheme).

import { BrowserWindow, nativeTheme } from 'electron'

export type UpdateAction = 'cancel' | 'install' | 'later'

export interface DownloadProgress {
  received: number
  total: number
  /** Bytes per second, when known. */
  rate?: number
}

const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Updating TRACER</title>
<style>
  :root { --bg:#f8f7f4; --text:#15171b; --muted:#5f636b; --field:#ffffff;
          --accent:oklch(0.54 0.10 215); --on-accent:#ffffff;
          --track:rgba(20,22,28,0.10); --control:rgba(20,22,28,0.22); }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#13171b; --text:#e6e8ec; --muted:#8f96a1; --field:#1b2026;
            --accent:oklch(0.78 0.10 215); --on-accent:#0b0d10;
            --track:rgba(255,255,255,0.10); --control:rgba(255,255,255,0.16); }
  }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--text);
    font:13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    -webkit-user-select:none; user-select:none; cursor:default; overflow:hidden; }
  .wrap { box-sizing:border-box; height:100%; padding:18px 20px 16px; display:flex; flex-direction:column; gap:10px; }
  .head { font-size:14px; font-weight:600; }
  .track { position:relative; height:6px; border-radius:3px; background:var(--track); overflow:hidden; }
  .fill { position:absolute; top:0; bottom:0; left:0; width:0; border-radius:3px; background:var(--accent);
          transition:width .2s linear; }
  .track.busy .fill { width:32%; transition:none; animation:slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { left:-32%; } to { left:100%; } }
  .meta { display:flex; justify-content:space-between; gap:12px; font-size:12px; color:var(--muted);
          font-variant-numeric:tabular-nums; min-height:17px; }
  .note { color:var(--muted); }
  .steps { display:flex; gap:14px; font-size:11px; color:var(--muted); margin-top:auto; }
  .steps .done { color:var(--text); }
  .steps .now { color:var(--accent); font-weight:600; }
  .btns { display:flex; justify-content:flex-end; gap:8px; }
  button { font:inherit; font-weight:500; border-radius:6px; padding:4px 14px; cursor:default;
           border:1px solid var(--control); background:var(--field); color:var(--text); }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
  button:disabled { opacity:.45; }
  button:focus { outline:none; }
  button:focus-visible { outline:2px solid color-mix(in oklab, var(--accent) 55%, transparent); outline-offset:1px; }
  [hidden] { display:none !important; }
</style></head>
<body><div class="wrap">
  <div class="head" id="head">Preparing the update…</div>
  <div class="track busy" id="track" role="progressbar"><div class="fill" id="fill"></div></div>
  <div class="meta"><span id="left"></span><span id="right"></span></div>
  <div class="note" id="note" hidden></div>
  <div class="steps" id="steps"></div>
  <div class="btns">
    <button id="later" hidden>Later</button>
    <button id="cancel">Cancel</button>
    <button id="install" class="primary" hidden>Restart and Install</button>
  </div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  for (const a of ['cancel', 'later', 'install']) {
    $(a).addEventListener('click', () => { location.href = 'tracer-update:' + a; });
  }
  const STEPS = ['Download', 'Check and unpack', 'Install'];
  window.setState = (s) => {
    $('head').textContent = s.head;
    const track = $('track');
    track.classList.toggle('busy', s.fraction == null);
    $('fill').style.width = s.fraction == null ? '' : (Math.round(s.fraction * 1000) / 10) + '%';
    if (s.fraction == null) track.removeAttribute('aria-valuenow');
    else track.setAttribute('aria-valuenow', String(Math.round(s.fraction * 100)));
    $('left').textContent = s.left || '';
    $('right').textContent = s.right || '';
    $('note').textContent = s.note || '';
    $('note').hidden = !s.note;
    $('steps').innerHTML = STEPS.slice(0, s.stepCount).map((name, i) =>
      '<span class="' + (i < s.step ? 'done' : i === s.step ? 'now' : '') + '">' + (i + 1) + ' ' + name + '</span>'
    ).join('');
    $('cancel').hidden = s.buttons !== 'cancel';
    $('cancel').disabled = !!s.cancelDisabled;
    $('later').hidden = $('install').hidden = s.buttons !== 'ready';
    if (s.buttons === 'ready') $('install').focus();
  };
</script></body></html>`

interface ViewState {
  head: string
  /** 0..1 for a determinate bar, null for a moving one. */
  fraction: number | null
  left?: string
  right?: string
  note?: string
  /** Index of the current step (0 Download, 1 Check and unpack, 2 Install). */
  step: number
  /** 3 on macOS (it unpacks the update itself), 2 elsewhere (Download, Install). */
  stepCount: number
  buttons: 'cancel' | 'ready'
  cancelDisabled?: boolean
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)
}

function timeLeft(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 10) return 'a few seconds left'
  if (seconds < 90) return `about ${Math.round(seconds / 5) * 5} s left`
  return `about ${Math.round(seconds / 60)} min left`
}

export class UpdateWindow {
  private win: BrowserWindow
  private loaded: Promise<void>
  private actionHandler: ((a: UpdateAction) => void) | null = null
  private mode: 'cancel' | 'ready' = 'cancel'
  private closingByCode = false
  private stepCount: number
  private lastSent = 0
  private rateAvg = 0
  private lastSample: { t: number; bytes: number } | null = null

  constructor(private version: string, parent: BrowserWindow | null, opts: { unpacks: boolean }) {
    this.stepCount = opts.unpacks ? 3 : 2
    this.win = new BrowserWindow({
      width: 460,
      height: 240,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Updating TRACER',
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#13171b' : '#f8f7f4',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    this.win.setMenuBarVisibility(false)
    this.win.webContents.on('will-navigate', (e, url) => {
      e.preventDefault()
      const action = url.replace(/^tracer-update:/, '') as UpdateAction
      if (action === 'cancel' || action === 'install' || action === 'later') this.actionHandler?.(action)
    })
    // Closing the window: Cancel while downloading, Later once it's ready.
    this.win.on('close', (e) => {
      if (this.closingByCode) return
      e.preventDefault()
      this.actionHandler?.(this.mode === 'ready' ? 'later' : 'cancel')
    })
    this.loaded = new Promise((resolve) => this.win.webContents.once('did-finish-load', () => resolve()))
    void this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
    this.win.once('ready-to-show', () => { if (!this.win.isDestroyed()) this.win.show() })
  }

  onAction(handler: (a: UpdateAction) => void) { this.actionHandler = handler }

  private async send(state: ViewState) {
    this.mode = state.buttons
    await this.loaded
    if (this.win.isDestroyed()) return
    try {
      await this.win.webContents.executeJavaScript(`window.setState(${JSON.stringify(state)})`)
    } catch { /* window closing */ }
  }

  downloading(p: DownloadProgress) {
    const now = Date.now()
    // Smoothed rate when the caller doesn't supply one (macOS download).
    if (this.lastSample && now > this.lastSample.t) {
      const r = (p.received - this.lastSample.bytes) / ((now - this.lastSample.t) / 1000)
      this.rateAvg = this.rateAvg ? this.rateAvg * 0.8 + r * 0.2 : r
    }
    this.lastSample = { t: now, bytes: p.received }
    if (now - this.lastSent < 150 && p.received < p.total) return   // ~7 updates/s is plenty
    this.lastSent = now
    const rate = p.rate || this.rateAvg
    void this.send({
      head: `Downloading TRACER ${this.version}`,
      fraction: p.total > 0 ? Math.min(1, p.received / p.total) : null,
      left: p.total > 0 ? `${mb(p.received)} of ${mb(p.total)} MB` : `${mb(p.received)} MB`,
      right: p.total > 0 && rate > 0 ? timeLeft((p.total - p.received) / rate) : '',
      step: 0, stepCount: this.stepCount, buttons: 'cancel',
    })
  }

  preparing() {
    void this.send({
      head: 'Getting the update ready',
      fraction: null,
      left: 'Checking the download and unpacking it…',
      step: 1, stepCount: this.stepCount, buttons: 'cancel', cancelDisabled: true,
    })
  }

  /** Show "ready to install" and wait for Restart and Install / Later. */
  ready(note: string): Promise<'install' | 'later'> {
    void this.send({
      head: `TRACER ${this.version} is ready to install`,
      fraction: 1,
      note,
      step: this.stepCount - 1, stepCount: this.stepCount, buttons: 'ready',
    })
    if (!this.win.isDestroyed()) this.win.focus()
    return new Promise((resolve) => {
      this.onAction((a) => resolve(a === 'install' ? 'install' : 'later'))
    })
  }

  close() {
    this.closingByCode = true
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}
