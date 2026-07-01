import { contextBridge, ipcRenderer } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'

// ---------------------------------------------------------------------------
// Read preferences SYNCHRONOUSLY at preload time
// ---------------------------------------------------------------------------
// The directory name MUST match ``app.getPath('userData')`` in the main
// process, which derives from ``app.setName('TRACER')`` (main.ts) — so it
// is "TRACER" (upper-case), not the package.json name "tracer". macOS /
// Windows filesystems are case-insensitive by default and mask a mismatch;
// Linux (ext4) is case-sensitive, so a lower-case "tracer" here reads a
// non-existent file and every sync-hydrated pref (recentFiles, …) comes
// back empty.
const APP_DIR = 'TRACER'
function getPrefsPath(): string {
  const home = homedir()
  const p = platform()
  if (p === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR, 'preferences.json')
  } else if (p === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIR, 'preferences.json')
  } else {
    return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), APP_DIR, 'preferences.json')
  }
}

let syncPrefs: Record<string, unknown> = {}
try {
  const path = getPrefsPath()
  if (existsSync(path)) {
    syncPrefs = JSON.parse(readFileSync(path, 'utf-8'))
  }
} catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Expose API to the renderer
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('electronAPI', {
  syncPreferences: syncPrefs,

  // Synchronous platform tag — exposed at preload time so the renderer
  // can set the `data-platform` body attribute before first paint and
  // avoid a flash of wrong toolbar layout on macOS.
  platform: platform(),

  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('open-external', url),

  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('get-backend-url'),
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('open-file-dialog'),
  openFolderDialog: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('open-folder-dialog', defaultPath),
  saveFileDialog: (defaultName: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke('save-file-dialog', defaultName, filters),

  // Write a UTF-8 text file at ``targetPath`` (already chosen via
  // ``saveFileDialog``). Returns ``{ ok: true }`` on success or
  // ``{ ok: false, error }`` on failure. Used by the cohort modal's
  // SVG export, where the renderer holds the SVG string and just
  // needs to flush it to the user's chosen path.
  writeTextFile: (targetPath: string, contents: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('write-text-file', targetPath, contents),

  // Write a binary file at ``targetPath`` from a base64-encoded
  // payload. The base64 hop avoids passing raw Buffers across the
  // IPC bridge (renderer → main loses the Buffer type). Used for
  // PNG / PDF exports — the backend returns base64, the renderer
  // forwards it through this channel to the main process which
  // decodes once and writes.
  writeBinaryFile: (targetPath: string, base64: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('write-binary-file', targetPath, base64),
  getPreferences: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('get-preferences'),
  setPreferences: (prefs: Record<string, unknown>): Promise<boolean> => ipcRenderer.invoke('set-preferences', prefs),

  // Per-recording sidecar files. Each recording at ``<path>`` has an
  // optional ``<path>.tracer`` JSON next to it carrying all
  // analysis params + results for that recording. Writes are atomic
  // (tmp + rename). Reads return null when absent or corrupt.
  readSidecar: (recordingPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('read-sidecar', recordingPath),
  writeSidecar: (recordingPath: string, payload: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('write-sidecar', recordingPath, payload),

  // Cohort session (.tracer_cohort) — Phase B.9 portable cohort-run
  // file. Same atomic-write semantics as the per-recording sidecar.
  // Reads return null on missing / corrupt / wrong-format files so
  // the renderer can treat absence as "no session" without throwing.
  readCohortSession: (sessionPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('read-cohort-session', sessionPath),
  writeCohortSession: (sessionPath: string, payload: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('write-cohort-session', sessionPath, payload),
  openCohortSessionDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-cohort-session-dialog'),

  // Trace Export figure sessions (.tracer_figure). Same shape as
  // the cohort session — atomic write, format-tagged JSON, dedicated
  // open-dialog with the right filter so users see only figure files.
  readFigureSession: (sessionPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('read-figure-session', sessionPath),
  writeFigureSession: (sessionPath: string, payload: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('write-figure-session', sessionPath, payload),
  openFigureSessionDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-figure-session-dialog'),

  // Folder listing for the Metadata window's left pane. ``anchorPath``
  // can be either a folder or a file inside it (we use the active
  // recording's path). Returns every recording-shaped file in the
  // folder along with its sidecar status + parsed ``meta`` block.
  listFolderRecordings: (anchorPath: string): Promise<{
    folder: string | null
    entries: Array<{
      filePath: string
      fileName: string
      hasSidecar: boolean
      meta?: Record<string, unknown> | null
    }>
  }> => ipcRenderer.invoke('list-folder-recordings', anchorPath),

  // Analysis windows
  openAnalysisWindow: (type: string): Promise<boolean> => ipcRenderer.invoke('open-analysis-window', type),
  closeAnalysisWindow: (type: string): Promise<boolean> => ipcRenderer.invoke('close-analysis-window', type),
  getOpenAnalysisWindows: (): Promise<string[]> => ipcRenderer.invoke('get-open-analysis-windows'),
  onAnalysisWindowClosed: (callback: (type: string) => void) => {
    const handler = (_event: any, type: string) => callback(type)
    ipcRenderer.on('analysis-window-closed', handler)
    return () => ipcRenderer.removeListener('analysis-window-closed', handler)
  },
})
