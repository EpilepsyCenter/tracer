import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { join, dirname, basename } from 'path'
import { createServer } from 'net'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync } from 'fs'

// When the app is launched from a GUI (double-clicked AppImage, Finder,
// a .desktop entry) the main process's stdout/stderr are wired to a pipe
// with no reader — or one that closes. Our Python-backend log forwarding
// (console.log/console.error below) then writes into a broken pipe and
// Node raises EPIPE. Unhandled, that surfaces as "A JavaScript error
// occurred in the main process: Error: write EPIPE" and takes the whole
// app down — but only in packaged builds, never in dev where stdout is a
// real terminal. Swallow EPIPE on the stdio streams so logging can never
// crash the app; re-raise anything else so real faults still surface.
const ignoreEpipe = (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err }
process.stdout.on('error', ignoreEpipe)
process.stderr.on('error', ignoreEpipe)

// Pin the app name BEFORE the app ready event so the macOS application
// menu + dock both read "TRACER" instead of "Electron". In packaged
// builds electron-builder bakes ``productName`` into the bundle's
// Info.plist, but in dev the menu bar otherwise shows "Electron".
app.setName('TRACER')

// Absolute path to the app icon PNG. electron-builder auto-generates
// the platform-native icons (icns / ico) from this PNG at package
// time; in dev we also pass it directly to BrowserWindow so the dock
// / taskbar / window chrome picks it up live.
const ICON_PATH = join(__dirname, '..', 'build', 'icon.png')

// Splash lockup — bundled via ``extraResources`` so it lives at
// ``<resources>/lockup.png`` in packaged builds, and read straight
// from ``build/`` during dev. We inline it as a base64 data URI in
// the splash HTML so the splash window can stay a self-contained
// ``data:`` URL with no file:// fetches at runtime.
function loadSplashLockupDataUri(): string {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'lockup.png')
    : join(__dirname, '..', 'build', 'lockup.png')
  try {
    const buf = readFileSync(path)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let pythonProcess: ChildProcess | null = null
let backendPort: number = 0

// Track open analysis windows by type
const analysisWindows: Map<string, BrowserWindow> = new Map()

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error('Could not find free port'))
      }
    })
    server.on('error', reject)
  })
}

// Resolve the dev-mode Python interpreter. Packaged builds ship a frozen
// ``main`` executable (no interpreter needed); in dev we spawn one directly.
//   - ``TRACER_PYTHON`` wins if set — point it at a venv interpreter
//     (e.g. ``.venv\Scripts\python.exe`` on Windows, ``.venv/bin/python``
//     elsewhere) to run the backend without activating the venv first.
//   - Otherwise default per-platform: ``python`` on Windows, since its
//     venvs and python.org installs expose ``python.exe`` but not
//     ``python3.exe`` — a bare ``python3`` there resolves to the Microsoft
//     Store stub and the backend never starts. ``python3`` everywhere else.
function devPythonInterpreter(): string {
  if (process.env.TRACER_PYTHON) return process.env.TRACER_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

async function startPythonBackend(port: number): Promise<void> {
  const isDev = !app.isPackaged
  const pythonPath = isDev ? devPythonInterpreter() : join(process.resourcesPath, 'backend', 'main')
  const args = isDev ? [join(__dirname, '..', 'backend', 'main.py'), '--port', String(port)] : ['--port', String(port)]

  return new Promise((resolve, reject) => {
    pythonProcess = spawn(pythonPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TRACER_PORT: String(port) },
    })

    pythonProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.log('[Python]', output)
      if (output.includes('Application startup complete') || output.includes('Uvicorn running')) {
        resolve()
      }
    })

    pythonProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.error('[Python]', output)
      if (output.includes('Application startup complete') || output.includes('Uvicorn running')) {
        resolve()
      }
    })

    pythonProcess.on('error', (err) => {
      console.error('Failed to start Python backend:', err)
      reject(err)
    })

    pythonProcess.on('exit', (code) => {
      console.log(`Python backend exited with code ${code}`)
      pythonProcess = null
    })

    // First-run Gatekeeper / SmartScreen can add 20–30s of startup delay
    // for unsigned bundled backends; be generous with the safety timeout.
    setTimeout(() => resolve(), 60000)
  })
}

// -----------------------------------------------------------------
// Preferences
// -----------------------------------------------------------------
function prefsFilePath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'preferences.json')
}

function loadWindowBounds(): { x?: number; y?: number; width: number; height: number; maximized?: boolean } {
  try {
    const path = prefsFilePath()
    if (existsSync(path)) {
      const prefs = JSON.parse(readFileSync(path, 'utf-8'))
      if (prefs.windowBounds) return prefs.windowBounds
    }
  } catch { /* ignore */ }
  // 1080p-safe — leaves ~80 px of vertical margin for the macOS menu
  // bar + dock so the window doesn't immediately exceed the screen on
  // common laptop displays. Users on bigger monitors can resize once
  // and the new bounds get persisted.
  return { width: 1600, height: 1000 }
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    const maximized = mainWindow.isMaximized()
    const path = prefsFilePath()
    let prefs: Record<string, unknown> = {}
    try {
      if (existsSync(path)) prefs = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* ignore */ }
    prefs.windowBounds = { ...bounds, maximized }
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

// -----------------------------------------------------------------
// Splash screen — shown immediately on app launch so the user has
// visual feedback while the Python backend cold-starts (can take
// 20–30s on first run under Gatekeeper / SmartScreen). Frameless,
// always-on-top, destroyed once the main window is ready-to-show.
// HTML is inlined as a data URL so there's no extra file to bundle.
// -----------------------------------------------------------------
function buildSplashHtml(lockupDataUri: string): string {
  const lockupTag = lockupDataUri
    ? `<img class="lockup" src="${lockupDataUri}" alt="TRACER Suite" />`
    // Fallback: text wordmark if the lockup file is missing for any
    // reason (corrupt install, dev before ``build/lockup.png`` exists).
    : `<div class="wordmark"><span class="t">T</span><span class="rest">RACER Suite</span></div>`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: #f7f8fa;
    color: #2b3a4a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "IBM Plex Sans", Helvetica, Arial, sans-serif;
    -webkit-user-select: none;
    overflow: hidden;
  }
  .wrap {
    height: 100%;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 22px;
    border: 1px solid #d6dbe2;
    border-radius: 10px;
    box-sizing: border-box;
    padding: 0 32px;
  }
  .lockup {
    width: 360px; max-width: 100%; height: auto;
    image-rendering: -webkit-optimize-contrast;
  }
  .wordmark {
    font-size: 40px; letter-spacing: -1px; line-height: 1;
  }
  .wordmark .t { color: #0f1722; font-weight: 500; }
  .wordmark .rest { color: #2b3a4a; font-weight: 300; }
  .status {
    font-size: 11px; color: #6b7280; letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .bar {
    width: 240px; height: 3px; background: #e5e9ef;
    border-radius: 999px; overflow: hidden;
  }
  .bar::after {
    content: ""; display: block; width: 40%; height: 100%;
    background: #2b3a4a; border-radius: 999px;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    0%   { transform: translateX(-100%); }
    50%  { transform: translateX(150%); }
    100% { transform: translateX(250%); }
  }
</style>
</head>
<body>
  <div class="wrap">
    ${lockupTag}
    <div class="bar"></div>
    <div class="status">Starting backend…</div>
  </div>
</body>
</html>`
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 260,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    backgroundColor: '#f7f8fa',
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const html = buildSplashHtml(loadSplashLockupDataUri())
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })
  splashWindow.on('closed', () => {
    splashWindow = null
  })
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy()
  }
  splashWindow = null
}

// -----------------------------------------------------------------
// Main window
// -----------------------------------------------------------------
function createWindow() {
  const bounds = loadWindowBounds()

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1000,
    minHeight: 700,
    title: 'TRACER',
    icon: ICON_PATH,
    // Stay hidden until React has painted at least once so the user
    // never sees a flash of empty chrome between the splash closing
    // and the UI showing. Paired with the splash window's destroy()
    // in the ``ready-to-show`` handler below.
    show: false,
    backgroundColor: '#f7f8fa',
    // macOS: tuck the traffic-light controls into the toolbar by
    // hiding the native title bar but keeping the OS buttons inset
    // at the top-left. The renderer adds left padding to ``.toolbar``
    // (via the ``[data-platform="mac"]`` body attribute) so buttons
    // never sit underneath the controls.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (bounds.maximized) {
    mainWindow.maximize()
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    closeSplash()
  })

  mainWindow.on('resize', saveWindowBounds)
  mainWindow.on('move', saveWindowBounds)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// -----------------------------------------------------------------
// IPC handlers
// -----------------------------------------------------------------
ipcMain.handle('get-backend-url', () => {
  return `http://localhost:${backendPort}`
})

ipcMain.handle('open-file-dialog', async (event) => {
  // Parent the dialog to the calling window (not always the main one)
  // — without this, the Trace Export window loses focus to the main
  // app window after the user picks a file. Same fix already applied
  // to ``open-folder-dialog``.
  const sender = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
  if (!sender) return null
  const result = await dialog.showOpenDialog(sender, {
    properties: ['openFile'],
    filters: [
      { name: 'Electrophysiology Files', extensions: ['dat', 'abf', 'h5', 'nwb', 'wcp', 'axgd', 'smr', 'csv', 'tsv', 'txt', 'atf'] },
      { name: 'HEKA Patchmaster', extensions: ['dat'] },
      { name: 'Axon Binary', extensions: ['abf'] },
      { name: 'Text / CSV / ATF', extensions: ['csv', 'tsv', 'txt', 'atf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('open-folder-dialog', async (_event, defaultPath?: string) => {
  // Folder picker for the Cohort Analysis module — the user picks the
  // directory of ``.tracer`` sidecars they want to aggregate.
  // Falls back to the system home dir when no anchor is supplied.
  // Triggered from any window (main or analysis), so we look up the
  // sender's BrowserWindow rather than assuming ``mainWindow``.
  const sender = BrowserWindow.fromWebContents(_event.sender) ?? mainWindow
  if (!sender) return null
  const result = await dialog.showOpenDialog(sender, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined,
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('save-file-dialog', async (event, defaultName: string, filters: Electron.FileFilter[]) => {
  const sender = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
  if (!sender) return null
  const result = await dialog.showSaveDialog(sender, {
    defaultPath: defaultName,
    filters: filters || [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Excel', extensions: ['xlsx'] },
    ],
  })
  return result.canceled ? null : result.filePath
})

// Write a text file (UTF-8). Used by the cohort export modal for
// SVG output. Returns ``{ ok }`` so the renderer can show a clear
// error toast instead of a silent failure.
ipcMain.handle('write-text-file', (_event, targetPath: string, contents: string) => {
  try {
    writeFileSync(targetPath, contents, 'utf-8')
    return { ok: true }
  } catch (err) {
    console.error('Failed to write text file:', targetPath, err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// Write a binary file from base64. Used by the cohort export modal
// for PNG / PDF output (the backend returns base64-encoded bytes).
// Decoding lives here in main rather than the renderer to keep the
// hot path off the React thread for large rasters.
ipcMain.handle('write-binary-file', (_event, targetPath: string, base64: string) => {
  try {
    const buf = Buffer.from(base64, 'base64')
    writeFileSync(targetPath, buf)
    return { ok: true }
  } catch (err) {
    console.error('Failed to write binary file:', targetPath, err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('get-preferences', () => {
  try {
    const path = prefsFilePath()
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    console.error('Failed to load preferences:', err)
    return {}
  }
})

ipcMain.handle('set-preferences', (_event, prefs: Record<string, unknown>) => {
  try {
    const path = prefsFilePath()
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('Failed to save preferences:', err)
    return false
  }
})

// -----------------------------------------------------------------
// Per-recording sidecar (.tracer JSON next to the recording file)
// -----------------------------------------------------------------
//
// Convention: for a recording at ``/path/to/file.dat``, the sidecar
// lives at ``/path/to/file.dat.tracer``. Appending the extension
// (rather than replacing) keeps things unambiguous when labs have
// same-stemmed files in different formats.
//
// Writes go through a ``*.tmp`` + rename-over so a crash mid-write
// can't corrupt an existing sidecar. Reads silently return null on
// any parse / IO error; the caller treats that as "no sidecar".

function sidecarPathFor(recordingPath: string): string {
  return `${recordingPath}.tracer`
}

ipcMain.handle('read-sidecar', (_event, recordingPath: string) => {
  try {
    if (!recordingPath) return null
    const path = sidecarPathFor(recordingPath)
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    // Basic shape guard — reject anything that doesn't look like ours.
    if (parsed && typeof parsed === 'object'
        && parsed.format === 'tracer-sidecar') {
      return parsed
    }
    return null
  } catch (err) {
    console.error('Failed to read sidecar:', err)
    return null
  }
})

ipcMain.handle('write-sidecar', (_event, recordingPath: string, payload: Record<string, unknown>) => {
  try {
    if (!recordingPath) return false
    const path = sidecarPathFor(recordingPath)
    const tmp = `${path}.tmp`
    // Always stamp format + saved_at so the file is self-describing.
    const withMeta = {
      format: 'tracer-sidecar',
      version: 1,
      saved_at: new Date().toISOString(),
      ...payload,
    }
    writeFileSync(tmp, JSON.stringify(withMeta, null, 2), 'utf-8')
    renameSync(tmp, path)
    return true
  } catch (err) {
    console.error('Failed to write sidecar:', err)
    try { unlinkSync(sidecarPathFor(recordingPath) + '.tmp') } catch { /* ignore */ }
    return false
  }
})

// -----------------------------------------------------------------
// Cohort session files (.tracer_cohort) — Phase B.9
// -----------------------------------------------------------------
//
// Cohort-level counterpart to the per-recording ``.tracer``
// sidecar. Stores a single cohort run as a portable JSON document:
// folder + analysis type, wizard state, selected metrics, stats
// results, graph customisation prefs. Read/written atomically via
// the same ``.tmp + rename-over`` pattern so a mid-write crash
// can't corrupt an existing session file. Reads return null on
// any parse / IO error; the renderer surfaces that as "no
// session" rather than crashing.
//
// Path convention: the renderer picks the path via the standard
// open / save dialog. By default we suggest
// ``<folder>/<basename>.tracer_cohort`` so a cohort folder
// keeps its session next to the data. Users can save anywhere.

ipcMain.handle('read-cohort-session', (_event, sessionPath: string) => {
  try {
    if (!sessionPath) return null
    if (!existsSync(sessionPath)) return null
    const raw = readFileSync(sessionPath, 'utf-8')
    const parsed = JSON.parse(raw)
    // Shape guard — reject anything that isn't ours.
    if (parsed && typeof parsed === 'object'
        && parsed.format === 'tracer-cohort-session') {
      return parsed
    }
    return null
  } catch (err) {
    console.error('Failed to read cohort session:', err)
    return null
  }
})

ipcMain.handle('write-cohort-session', (_event, sessionPath: string, payload: Record<string, unknown>) => {
  try {
    if (!sessionPath) return false
    const tmp = `${sessionPath}.tmp`
    const withMeta = {
      format: 'tracer-cohort-session',
      version: 1,
      saved_at: new Date().toISOString(),
      ...payload,
    }
    writeFileSync(tmp, JSON.stringify(withMeta, null, 2), 'utf-8')
    renameSync(tmp, sessionPath)
    return true
  } catch (err) {
    console.error('Failed to write cohort session:', err)
    try { unlinkSync(`${sessionPath}.tmp`) } catch { /* ignore */ }
    return false
  }
})

// -----------------------------------------------------------------
// Trace Export figure sessions (.tracer_figure) — Phase C
// -----------------------------------------------------------------
//
// Cross-recording figure-state counterpart to ``.tracer_cohort``. Stores
// the entire Trace Export window state (items + style + axes +
// scalebar + legend + figure size) so users can resume the same
// figure later without re-picking sources or re-styling. Same atomic
// write pattern as the per-recording sidecar.

ipcMain.handle('read-figure-session', (_event, sessionPath: string) => {
  try {
    if (!sessionPath) return null
    if (!existsSync(sessionPath)) return null
    const raw = readFileSync(sessionPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object'
        && parsed.format === 'tracer-figure-session') {
      return parsed
    }
    return null
  } catch (err) {
    console.error('Failed to read figure session:', err)
    return null
  }
})

ipcMain.handle('write-figure-session', (_event, sessionPath: string, payload: Record<string, unknown>) => {
  try {
    if (!sessionPath) return false
    const tmp = `${sessionPath}.tmp`
    const withMeta = {
      format: 'tracer-figure-session',
      version: 1,
      saved_at: new Date().toISOString(),
      ...payload,
    }
    writeFileSync(tmp, JSON.stringify(withMeta, null, 2), 'utf-8')
    renameSync(tmp, sessionPath)
    return true
  } catch (err) {
    console.error('Failed to write figure session:', err)
    try { unlinkSync(`${sessionPath}.tmp`) } catch { /* ignore */ }
    return false
  }
})

ipcMain.handle('open-figure-session-dialog', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
  if (!sender) return null
  const result = await dialog.showOpenDialog(sender, {
    title: 'Open figure session',
    properties: ['openFile'],
    filters: [
      { name: 'TRACER Figure Session', extensions: ['tracer_figure'] },
    ],
  })
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
})

// Dedicated open dialog with the .tracer_cohort filter pre-set so
// users see only their session files. Returns the chosen path or
// null if cancelled.
ipcMain.handle('open-cohort-session-dialog', async (event) => {
  // Parent the dialog to the calling window so focus returns to the
  // Cohort Analysis window after the user picks a file (was rooting
  // to the main app window, same shape of bug as open-file-dialog).
  const sender = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
  if (!sender) return null
  const result = await dialog.showOpenDialog(sender, {
    title: 'Open cohort session',
    properties: ['openFile'],
    filters: [
      { name: 'TRACER Cohort Session', extensions: ['tracer_cohort'] },
    ],
  })
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
})

// List recording-shaped files (dat / abf / h5 / nwb / wcp / axgd / smr)
// in a folder, plus their sidecar status + parsed sidecar.meta. Used by
// the Metadata window's left pane so the user can tag the whole cohort
// without having to open every file. Returns paths sorted by name.
//
// We don't try to peek inside non-sidecar files — listing is metadata-
// only, so the cost is just a directory read + N small JSON parses.
const RECORDING_EXTENSIONS = new Set(['dat', 'abf', 'h5', 'nwb', 'wcp', 'axgd', 'smr'])

ipcMain.handle('list-folder-recordings', (_event, anchorPath: string) => {
  try {
    if (!anchorPath) return { folder: null, entries: [] }
    // Accept either a folder path or a file inside the folder. The
    // metadata window uses the active recording's path; a future
    // "open folder" entry point can pass the folder directly.
    let folder = anchorPath
    try {
      const st = statSync(anchorPath)
      if (st.isFile()) folder = dirname(anchorPath)
    } catch {
      folder = dirname(anchorPath)
    }
    const names = readdirSync(folder)
    const entries: Array<{
      filePath: string
      fileName: string
      hasSidecar: boolean
      meta?: Record<string, unknown> | null
    }> = []
    for (const name of names) {
      // Skip hidden files and the sidecars themselves (they live next
      // to recordings; we list the recordings).
      if (name.startsWith('.')) continue
      if (name.endsWith('.tracer')) continue
      if (name.endsWith('.tmp')) continue
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (!RECORDING_EXTENSIONS.has(ext)) continue
      const filePath = join(folder, name)
      try {
        const st = statSync(filePath)
        if (!st.isFile()) continue
      } catch { continue }
      const sidecarPath = sidecarPathFor(filePath)
      let hasSidecar = false
      let meta: Record<string, unknown> | null = null
      if (existsSync(sidecarPath)) {
        hasSidecar = true
        try {
          const parsed = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
          if (parsed && typeof parsed === 'object'
              && parsed.format === 'tracer-sidecar'
              && parsed.meta && typeof parsed.meta === 'object') {
            meta = parsed.meta
          }
        } catch { /* corrupt — leave meta null */ }
      }
      entries.push({ filePath, fileName: name, hasSidecar, meta })
    }
    entries.sort((a, b) => a.fileName.localeCompare(b.fileName))
    return { folder, entries }
  } catch (err) {
    console.error('Failed to list folder recordings:', err)
    return { folder: null, entries: [] }
  }
})

// -----------------------------------------------------------------
// Analysis windows — one per analysis type, opened on demand
// -----------------------------------------------------------------
const ANALYSIS_WINDOW_TITLES: Record<string, string> = {
  cursors: 'Cursor Measurements',
  resistance: 'Rs / Rin / Cm',
  iv: 'I-V Curve',
  action_potential: 'Action Potentials',
  paired: 'Paired Recording',
  events: 'Event Detection',
  // Sub-windows of Event Detection — open via a button in the main
  // events window. Open at the same time as the parent (keyed by
  // unique view names so they don't collide).
  events_template_generator: 'Events — Template Generator',
  events_template_refinement: 'Events — Refine Template',
  events_browser: 'Events — Browser & Overlay',
  metadata: 'Metadata',
  cohort_analysis: 'Cohort Analysis',
  trace_export: 'Trace Export',
  batch_analysis: 'Batch Analysis',
  bursts: 'Burst Detection',
  kinetics: 'Kinetics & Fitting',
  field_potential: 'Field PSP',
  spectral: 'Spectral Analysis',
  manual: 'User Manual',
}

function loadAnalysisWindowBounds(analysisType: string): { x?: number; y?: number; width: number; height: number } {
  try {
    const path = prefsFilePath()
    if (existsSync(path)) {
      const prefs = JSON.parse(readFileSync(path, 'utf-8'))
      const bounds = prefs.analysisWindowBounds?.[analysisType]
      if (bounds) return bounds
    }
  } catch { /* ignore */ }
  // 1080p-safe default for every analysis window — large enough to
  // render the params sidebar + multi-panel results without immediate
  // resizing (the old 900×650 clipped AP's F-I curve and Paired's STA
  // / Stats grid badly on first open) while still fitting a 1920×1080
  // display with margin for the macOS menu bar + dock.
  if (analysisType === 'manual') return { width: 1080, height: 760 }
  return { width: 1400, height: 950 }
}

function saveAnalysisWindowBounds(analysisType: string) {
  const win = analysisWindows.get(analysisType)
  if (!win || win.isDestroyed()) return
  try {
    const bounds = win.getBounds()
    const path = prefsFilePath()
    let prefs: Record<string, any> = {}
    try {
      if (existsSync(path)) prefs = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* ignore */ }
    if (!prefs.analysisWindowBounds) prefs.analysisWindowBounds = {}
    prefs.analysisWindowBounds[analysisType] = bounds
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

ipcMain.handle('open-analysis-window', (_event, analysisType: string) => {
  // If already open, focus it
  const existing = analysisWindows.get(analysisType)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return true
  }

  const title = ANALYSIS_WINDOW_TITLES[analysisType] || analysisType
  const bounds = loadAnalysisWindowBounds(analysisType)

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 500,
    minHeight: 400,
    title: `TRACER — ${title}`,
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?view=${analysisType}`)
  } else {
    win.loadFile(join(__dirname, '..', 'dist', 'index.html'), {
      query: { view: analysisType },
    })
  }

  analysisWindows.set(analysisType, win)

  // Persist window bounds on move/resize
  win.on('resize', () => saveAnalysisWindowBounds(analysisType))
  win.on('move', () => saveAnalysisWindowBounds(analysisType))

  win.on('closed', () => {
    analysisWindows.delete(analysisType)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('analysis-window-closed', analysisType)
    }
  })

  return true
})

ipcMain.handle('close-analysis-window', (_event, analysisType: string) => {
  const win = analysisWindows.get(analysisType)
  if (win && !win.isDestroyed()) {
    win.close()
  }
  analysisWindows.delete(analysisType)
  return true
})

ipcMain.handle('get-open-analysis-windows', () => {
  const open: string[] = []
  for (const [type, win] of analysisWindows) {
    if (!win.isDestroyed()) open.push(type)
  }
  return open
})

// Open an external URL or local path in the user's default browser
// / handler. Used by the Help modal to launch the manual.
ipcMain.handle('open-external', async (_event, url: string) => {
  try {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      await shell.openExternal(url)
    } else {
      // Local file path — opens with the OS default handler.
      await shell.openPath(url)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// Tell the renderer which OS we're on so it can apply platform-
// specific styling (e.g. macOS traffic-light gutter on the toolbar).
ipcMain.handle('get-platform', () => process.platform)

// -----------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------
app.whenReady().then(async () => {
  // Show the splash immediately so the user has visual feedback
  // during backend cold-start. ``createWindow`` will destroy it once
  // the main window's first paint is ready.
  createSplashWindow()

  try {
    backendPort = await findFreePort()
    console.log(`Starting Python backend on port ${backendPort}...`)
    await startPythonBackend(backendPort)
    console.log('Python backend started successfully')
  } catch (err) {
    console.error('Failed to start Python backend:', err)
  }

  createWindow()

  // Safety net: if ``ready-to-show`` never fires (hung renderer,
  // missing index.html, etc.) the splash would stay on top forever.
  // Force-close it after a generous wait so the user can at least
  // interact with whatever did paint.
  setTimeout(() => closeSplash(), 90_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
})
