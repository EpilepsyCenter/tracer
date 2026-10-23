// electron-builder afterPack hook: ad-hoc sign the macOS app.
//
// CI builds have no Apple Developer ID, so electron-builder skips signing.
// A downloaded unsigned app is reported by Gatekeeper as "damaged" with no
// way past it except Terminal. An ad-hoc signature turns that into the
// normal "unverified developer" prompt, which users can clear from
// System Settings → Privacy & Security → Open Anyway.
//
// Signing goes inside-out: every Mach-O file in the bundled Python backend
// first (codesign --deep doesn't reach into Contents/Resources), then the
// whole app with --deep for the Electron frameworks and helpers.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const MACHO_MAGIC = new Set([
  0xfeedface, 0xcefaedfe, // 32-bit
  0xfeedfacf, 0xcffaedfe, // 64-bit
  0xcafebabe, 0xbebafeca, // universal
])

function isMachO(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4)
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false
    return MACHO_MAGIC.has(buf.readUInt32BE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile() && isMachO(p)) out.push(p)
  }
  return out
}

function sign(target, extra = []) {
  // stderr is piped (codesign logs "replacing existing signature" for every
  // file); on failure execFileSync throws with it attached.
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', ...extra, target], {
    stdio: 'pipe',
  })
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.platform !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  const backendDir = path.join(appPath, 'Contents', 'Resources', 'backend')
  const backendBinaries = fs.existsSync(backendDir) ? walk(backendDir, []) : []
  // Deepest first so nested code is sealed before anything that contains it.
  backendBinaries.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
  for (const bin of backendBinaries) sign(bin)

  sign(appPath, ['--deep'])
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appName} (${backendBinaries.length} backend binaries)`)
}
