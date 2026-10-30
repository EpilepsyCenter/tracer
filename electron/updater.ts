// In-app updates from GitHub Releases.
//
// Release metadata comes from electron-updater (the latest*.yml files
// electron-builder writes next to the installers). Installing differs
// by platform:
//
//   - Windows (NSIS) and Linux (AppImage): electron-updater downloads
//     and installs the update itself.
//   - macOS: electron-updater's installer (Squirrel.Mac) only accepts
//     apps signed with an Apple Developer ID, and TRACER is ad-hoc
//     signed. So the Mac update is done here instead: download the
//     release's .zip, check its SHA-512 against the release metadata,
//     unpack it, and after TRACER quits a small shell script swaps the
//     app bundle and reopens it. If the app sits somewhere it can't
//     replace itself (a DMG, App Translocation, a read-only folder) the
//     user is sent to the download page instead.
//
// Nothing is installed without the user clicking Install.
//
// Progress is shown in the "Updating TRACER" window (updateWindow.ts):
// download (with Cancel), checking/unpacking, then "ready to install"
// saying what happens next. On Windows the installer runs with its own
// progress window (not silently), and after a restart the new version's
// splash says it is finishing the update (``updatingTo`` below).

import { app, dialog, shell, BrowserWindow, net } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { spawn, execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { join, dirname, resolve } from 'path'
import {
  accessSync, constants as fsConstants, createWriteStream,
  mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'fs'
import { UpdateWindow } from './updateWindow'

const REPO = 'EpilepsyCenter/tracer'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const DAY_MS = 24 * 60 * 60 * 1000
const execFileAsync = promisify(execFile)

/** Testing only: point the updater at a local folder served over HTTP
 *  (containing latest*.yml and the update files) instead of GitHub. */
const TEST_FEED = process.env.TRACER_UPDATE_FEED || ''

interface UpdateState {
  /** Last automatic check (ms since epoch). */
  lastCheck?: number
  /** Version the user chose to skip in the launch-time prompt. */
  skipVersion?: string
  /** Automatic check at launch (default on). */
  auto?: boolean
  /** Work folder of a Mac install that ran after the last quit. */
  pendingWork?: string
  /** Version a restart is installing; the next start's splash says so. */
  updatingTo?: string
}

let getWindow: () => BrowserWindow | null = () => null
let busy = false
/** Mac update unpacked and waiting for the app to quit. */
let stagedMac: { newApp: string; target: string; work: string; version: string } | null = null
/** Progress window of the download in flight (Windows / Linux). */
let activeWindow: UpdateWindow | null = null

const stateFile = () => join(app.getPath('userData'), 'update-state.json')

function readState(): UpdateState {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')) as UpdateState } catch { return {} }
}

function writeState(patch: Partial<UpdateState>) {
  try {
    const next = { ...readState(), ...patch }
    for (const k of Object.keys(next) as (keyof UpdateState)[]) {
      if (next[k] === undefined) delete next[k]
    }
    writeFileSync(stateFile(), JSON.stringify(next, null, 2))
  } catch { /* ignore */ }
}

/** Numeric x.y.z comparison; a pre-release suffix sorts before the release. */
function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ?? '' }
  }
  const a = parse(candidate), b = parse(current)
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
    if (d !== 0) return d > 0
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true       // 1.2.0 > 1.2.0-beta
  if (!b.pre) return false
  return a.pre > b.pre
}

function releaseNotesText(info: UpdateInfo): string {
  const raw = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map((n) => n.note ?? '').join('\n')
    : (info.releaseNotes ?? '')
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim()
  return text.length > 900 ? text.slice(0, 900).trimEnd() + '…' : text
}

function releasePage(version?: string) {
  return version && !TEST_FEED ? `https://github.com/${REPO}/releases/tag/v${version}` : RELEASES_PAGE
}

async function messageBox(opts: Electron.MessageBoxOptions) {
  const win = getWindow()
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
}

function setProgress(frac: number) {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.setProgressBar(frac)
}

async function offerDownloadPage(message: string, detail: string, version?: string) {
  const r = await messageBox({
    type: 'info', message, detail,
    buttons: ['Open Download Page', 'Cancel'], defaultId: 0, cancelId: 1,
  })
  if (r.response === 0) void shell.openExternal(releasePage(version))
}

/** What the "ready to install" step says will happen. */
function readyNote(): string {
  if (process.platform === 'darwin') {
    return 'TRACER will close, install the update and open again by itself. '
      + 'The first start of the new version can take up to a minute while macOS checks it.'
  }
  if (process.platform === 'win32') {
    return 'TRACER will close and the installer will show its progress. '
      + 'TRACER opens again when it is done.'
  }
  return 'TRACER will close and open again with the new version.'
}

/** For the splash on the first start after an update restart: the version
 *  being finished, or null. main.ts reads it before the updater starts. */
export function finishingUpdateTo(): string | null {
  const { updatingTo } = readState()
  return updatingTo && updatingTo === app.getVersion() ? updatingTo : null
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/** Check GitHub for a newer release. ``interactive`` = started from the
 *  menu: report "up to date" and errors. Automatic checks stay silent
 *  unless an update is found (and not skipped). */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (busy) {
    if (interactive) {
      await messageBox({ type: 'info', message: 'An update is already being checked or downloaded.' })
    }
    return
  }
  if (stagedMac) {
    if (interactive) await promptRestartMac()
    return
  }
  if (!app.isPackaged && !TEST_FEED) {
    if (interactive) {
      await messageBox({
        type: 'info', message: 'Updates are only available in the installed app.',
        detail: 'This is a development build.',
      })
    }
    return
  }
  busy = true
  let info: UpdateInfo | null = null
  try {
    const result = await autoUpdater.checkForUpdates()
    info = result?.updateInfo ?? null
    if (!result) {
      // The updater is inactive here (e.g. a Linux build that isn't
      // running as an AppImage).
      if (interactive) {
        await offerDownloadPage(
          'Automatic updates aren’t available for this installation.',
          'Download the latest version from GitHub instead.',
        )
      }
      return
    }
  } catch (err) {
    if (interactive) {
      await offerDownloadPage(
        'Couldn’t check for updates.',
        `${(err as Error)?.message ?? err}\n\nCheck your internet connection, or download the latest version from GitHub.`,
      )
    }
    return
  } finally {
    busy = false
    if (!interactive) writeState({ lastCheck: Date.now() })
  }

  const current = app.getVersion()
  if (!info || !isNewer(info.version, current)) {
    if (interactive) {
      await messageBox({ type: 'info', message: 'TRACER is up to date.', detail: `You have version ${current}.` })
    }
    return
  }
  const state = readState()
  if (!interactive && state.skipVersion === info.version) return

  const notes = releaseNotesText(info)
  const buttons = ['Install Update', 'Release Notes', 'Later', ...(interactive ? [] : ['Skip This Version'])]
  const r = await messageBox({
    type: 'info',
    message: `TRACER ${info.version} is available`,
    detail: `You have version ${current}.` + (notes ? `\n\n${notes}` : '')
      + '\n\nTRACER shows the download’s progress, then restarts to finish.',
    buttons, defaultId: 0, cancelId: 2,
    checkboxLabel: 'Check for updates automatically',
    checkboxChecked: state.auto !== false,
  })
  writeState({ auto: r.checkboxChecked })
  const choice = buttons[r.response]
  if (choice === 'Release Notes') { void shell.openExternal(releasePage(info.version)); return }
  if (choice === 'Skip This Version') { writeState({ skipVersion: info.version }); return }
  if (choice !== 'Install Update') return

  if (process.platform === 'darwin') await installMac(info)
  else await installWithUpdater(info)
}

// ---------------------------------------------------------------------------
// Windows / Linux — electron-updater
// ---------------------------------------------------------------------------

async function installWithUpdater(info: UpdateInfo) {
  busy = true
  const ui = new UpdateWindow(info.version, getWindow(), { unpacks: false })
  activeWindow = ui
  const token = new CancellationToken()
  let cancelled = false
  ui.onAction((a) => { if (a === 'cancel') { cancelled = true; token.cancel() } })
  ui.downloading({ received: 0, total: 0 })
  try {
    await autoUpdater.downloadUpdate(token)
  } catch (err) {
    busy = false
    activeWindow = null
    ui.close()
    setProgress(-1)
    if (!cancelled) {
      await offerDownloadPage('The update couldn’t be downloaded.', String((err as Error)?.message ?? err), info.version)
    }
    return
  }
  busy = false
  activeWindow = null
  setProgress(-1)
  const choice = await ui.ready(readyNote())
  ui.close()
  if (choice === 'install') {
    writeState({ updatingTo: info.version })
    // Not silent: the Windows installer shows its own progress window.
    autoUpdater.quitAndInstall(false, true)
  } else {
    autoUpdater.autoInstallOnAppQuit = true
  }
}

// ---------------------------------------------------------------------------
// macOS — download, verify, unpack, swap after quit
// ---------------------------------------------------------------------------

/** The running .app bundle, e.g. /Applications/TRACER.app. */
function runningBundle(): string | null {
  const b = resolve(dirname(app.getPath('exe')), '..', '..')
  return b.endsWith('.app') ? b : null
}

function canReplace(bundle: string): string | null {
  if (bundle.includes('/AppTranslocation/')) {
    return 'macOS is running TRACER from a temporary location. Move TRACER.app to your Applications folder, open it from there, and check again.'
  }
  if (bundle.startsWith('/Volumes/')) {
    return 'TRACER is running from the disk image. Drag it to your Applications folder, open it from there, and check again.'
  }
  try {
    accessSync(dirname(bundle), fsConstants.W_OK)
    accessSync(bundle, fsConstants.W_OK)
  } catch {
    return `TRACER can’t replace itself in ${dirname(bundle)} (no write permission).`
  }
  return null
}

async function download(
  url: string, dest: string, expectedSha512: string, size: number | undefined,
  onProgress: (received: number, total: number) => void, signal: AbortSignal,
) {
  const res = await net.fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || size || 0
  const hash = createHash('sha512')
  const out = createWriteStream(dest)
  const reader = res.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      if (total > 0) setProgress(received / total)
      onProgress(received, total)
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  if (hash.digest('base64') !== expectedSha512) {
    throw new Error('The downloaded file failed its checksum check.')
  }
}

async function installMac(info: UpdateInfo) {
  const bundle = runningBundle()
  const blocked = bundle ? canReplace(bundle) : 'TRACER couldn’t find its own app bundle.'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const zips = (info.files ?? []).filter((f) => f.url.endsWith('.zip'))
  const file = zips.find((f) => f.url.includes(arch)) ?? zips[0]
  if (blocked || !bundle) {
    await offerDownloadPage('TRACER can’t update itself here.', blocked ?? '', info.version)
    return
  }
  if (!file) {
    await offerDownloadPage('This release has no in-place update for Mac.',
      'Download the new version from GitHub instead.', info.version)
    return
  }

  busy = true
  const ui = new UpdateWindow(info.version, getWindow(), { unpacks: true })
  const abort = new AbortController()
  ui.onAction((a) => { if (a === 'cancel') abort.abort() })
  ui.downloading({ received: 0, total: file.size ?? 0 })
  const work = join(app.getPath('temp'), `tracer-update-${info.version}-${Date.now()}`)
  try {
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    const base = TEST_FEED
      ? (TEST_FEED.endsWith('/') ? TEST_FEED : TEST_FEED + '/')
      : `https://github.com/${REPO}/releases/download/v${info.version}/`
    const zipPath = join(work, 'update.zip')
    await download(new URL(file.url, base).toString(), zipPath, file.sha512, file.size,
      (received, total) => ui.downloading({ received, total }), abort.signal)

    ui.preparing()
    setProgress(2)   // indeterminate on the Dock icon too
    // ditto keeps the bundle's symlinks, permissions and signature. Run it
    // asynchronously so the window keeps animating while it unpacks.
    const unpacked = join(work, 'unpacked')
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, unpacked])
    rmSync(zipPath, { force: true })
    const appName = readdirSync(unpacked).find((n) => n.endsWith('.app'))
    if (!appName) throw new Error('The update archive contains no app.')
    const newApp = join(unpacked, appName)
    const plistVersion = execFileSync('/usr/libexec/PlistBuddy',
      ['-c', 'Print CFBundleShortVersionString', join(newApp, 'Contents', 'Info.plist')],
    ).toString().trim()
    if (plistVersion !== info.version) {
      throw new Error(`The update archive holds version ${plistVersion}, expected ${info.version}.`)
    }
    stagedMac = { newApp, target: bundle, work, version: info.version }
  } catch (err) {
    rmSync(work, { recursive: true, force: true })
    ui.close()
    if (!abort.signal.aborted) {
      await offerDownloadPage('The update couldn’t be installed.', String((err as Error)?.message ?? err), info.version)
    }
    return
  } finally {
    busy = false
    setProgress(-1)
  }
  await promptRestartMac(ui)
}

/** "Ready to install" for a staged Mac update; reuses the progress window
 *  when there is one (otherwise opens it at the last step). */
async function promptRestartMac(existing?: UpdateWindow) {
  if (!stagedMac) return
  const ui = existing ?? new UpdateWindow(stagedMac.version, getWindow(), { unpacks: true })
  const choice = await ui.ready(readyNote())
  ui.close()
  if (choice === 'install' && stagedMac) {
    writeState({ updatingTo: stagedMac.version })
    launchMacSwap(true)
    app.quit()
  }
}

/** Start the detached script that waits for TRACER to exit, swaps the
 *  bundle (rolling back on failure) and optionally reopens it. */
function launchMacSwap(relaunch: boolean) {
  if (!stagedMac) return
  const { newApp, target, work } = stagedMac
  stagedMac = null
  const script = join(work, 'swap.sh')
  writeFileSync(script, `#!/bin/bash
PID="$1"; NEW="$2"; TARGET="$3"; RELAUNCH="$4"; WORK="$5"
exec >>"$WORK/update.log" 2>&1
echo "$(date) waiting for TRACER ($PID) to quit"
for _ in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
BACKUP="$TARGET.update-backup"
rm -rf "$BACKUP"
if mv "$TARGET" "$BACKUP"; then
  if mv "$NEW" "$TARGET" 2>/dev/null || /usr/bin/ditto "$NEW" "$TARGET"; then
    rm -rf "$BACKUP"
    /usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
    echo ok > "$WORK/status"
  else
    rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"
    echo failed > "$WORK/status"
  fi
else
  echo failed > "$WORK/status"
fi
echo "$(date) result: $(cat "$WORK/status")"
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$TARGET"
`, { mode: 0o755 })
  writeState({ pendingWork: work })
  spawn('/bin/bash', [script, String(process.pid), newApp, target, relaunch ? '1' : '0', work], {
    detached: true, stdio: 'ignore',
  }).unref()
}

/** After a Mac install: report a failed swap and clean up its folder. */
async function reportPreviousMacInstall() {
  const { pendingWork } = readState()
  if (!pendingWork) return
  writeState({ pendingWork: undefined })
  let status = ''
  try { status = readFileSync(join(pendingWork, 'status'), 'utf8').trim() } catch { /* none */ }
  if (status === 'failed') {
    await offerDownloadPage('The last update couldn’t be installed.',
      'TRACER was left at the previous version. Download the new version from GitHub instead.')
  }
  rmSync(pendingWork, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Call once the main window exists. Schedules the daily launch check. */
export function initUpdater(windowGetter: () => BrowserWindow | null) {
  getWindow = windowGetter
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = console
  if (TEST_FEED) {
    autoUpdater.setFeedURL({ provider: 'generic', url: TEST_FEED })
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
  }
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    setProgress((p.percent ?? 0) / 100)
    activeWindow?.downloading({ received: p.transferred, total: p.total, rate: p.bytesPerSecond })
  })

  // The splash of this start has shown "Finishing the update…" if needed.
  if (readState().updatingTo) writeState({ updatingTo: undefined })

  // A Mac update staged with "Later" installs when the app quits.
  app.on('will-quit', () => { if (stagedMac) launchMacSwap(false) })

  if (process.platform === 'darwin') void reportPreviousMacInstall()

  setTimeout(() => {
    const s = readState()
    if (s.auto === false) return
    if (s.lastCheck && Date.now() - s.lastCheck < DAY_MS) return
    void checkForUpdates(false)
  }, 15_000)
}
