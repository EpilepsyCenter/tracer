// Checks for the "What's new" dialog:
//  - startup decisions (fresh install, update from a pre-dialog version,
//    skipped versions, already seen, development build);
//  - every `manual:` link in docs/CHANGELOG.md resolves to a real heading
//    in docs/MANUAL.md (catches renamed headings before a release);
//  - every changelog version is a plain x.y.z, newest first.
// Run from the repo root:  node tests/whats_new_check.mjs   → prints "OK"
import { buildSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import os from 'node:os'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsnew-'))
const load = async (rel) => {
  const out = path.join(tmp, path.basename(rel).replace(/\.ts$/, '.mjs'))
  buildSync({ entryPoints: [path.join(root, rel)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' })
  return import(pathToFileURL(out).href)
}
const W = await load('frontend/src/utils/whatsNew.ts')
const M = await load('frontend/src/utils/manualLink.ts')

const failures = []
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}: ${detail}`) }

// --- startup logic on a synthetic changelog ---
const log = W.parseChangelog(`# x
<!-- ## 9.9.9 in a comment is ignored -->
## 1.3.0
- c
## 1.2.0
- b [Read more](manual:2. Chapter (two) > Some section)
## 1.1.0
- a
`)
check('parse versions', log.map((e) => e.version).join(',') === '1.3.0,1.2.0,1.1.0', log.map((e) => e.version).join(','))
check('manual link encoded', log[1].body.includes('manual:2.%20Chapter%20%28two%29%20%3E%20Some%20section'), log[1].body)
const v = (r) => r.show.map((e) => e.version).join(',')
let r = W.decideStartup({}, '1.3.0', log)
check('fresh install: nothing, record', v(r) === '' && r.record, JSON.stringify(r))
r = W.decideStartup({ recentFiles: ['/a.dat'] }, '1.2.0', log)
check('update from pre-dialog version: current notes', v(r) === '1.2.0' && r.record, v(r))
r = W.decideStartup({ lastSeenVersion: '1.1.0', x: 1 }, '1.3.0', log)
check('skipped versions: all since, newest first', v(r) === '1.3.0,1.2.0', v(r))
r = W.decideStartup({ lastSeenVersion: '1.3.0' }, '1.3.0', log)
check('already seen: nothing, no write', v(r) === '' && !r.record, JSON.stringify(r))
r = W.decideStartup({ lastSeenVersion: '1.4.0' }, '1.3.0', log)
check('downgrade: nothing', v(r) === '' && !r.record)
r = W.decideStartup({ x: 1 }, 'dev', log)
check('dev build: nothing', v(r) === '' && !r.record)
check('menu: newest ≤ running', W.entriesForMenu(log, '1.2.5').map((e) => e.version).join() === '1.2.0')
check('menu: dev shows newest', W.entriesForMenu(log, 'dev').map((e) => e.version).join() === '1.3.0')
check('version compare', W.compareVersions('1.10.0', '1.9.0') === 1 && W.compareVersions('1.0.3', '1.0.3') === 0)

// --- the real changelog against the real manual ---
const real = W.parseChangelog(fs.readFileSync(path.join(root, 'docs/CHANGELOG.md'), 'utf-8'))
check('changelog has entries', real.length > 0)
for (let i = 1; i < real.length; i++) {
  check('changelog newest first', W.compareVersions(real[i - 1].version, real[i].version) > 0, `${real[i - 1].version} then ${real[i].version}`)
}
// Same heading extraction as the Manual window (levels 1–3, outside code fences).
const headings = []
let fence = false
for (const line of fs.readFileSync(path.join(root, 'docs/MANUAL.md'), 'utf-8').split('\n')) {
  if (line.startsWith('```')) { fence = !fence; continue }
  if (fence) continue
  const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
  if (m) headings.push({ text: m[2].replace(/`/g, ''), id: String(headings.length) })
}
let links = 0
for (const e of real) {
  for (const m of e.body.matchAll(/\]\(manual:([^)\s]+)\)/g)) {
    links++
    const p = decodeURIComponent(m[1])
    const parts = p.split('>').map((s) => s.trim())
    const id = M.resolveManualPath(headings, p)
    const last = parts[parts.length - 1].toLowerCase()
    const ok = id != null && headings[Number(id)].text.toLowerCase() === last
    check(`${e.version}: link "${p}" resolves`, ok, id == null ? 'no heading' : `landed on "${headings[Number(id)].text}"`)
  }
}
check('changelog links found', links > 0)

fs.rmSync(tmp, { recursive: true, force: true })
if (failures.length) { console.log('FAIL'); for (const f of failures) console.log('  -', f); process.exit(1) }
console.log(`OK — ${real.length} version(s), ${links} manual link(s) resolve`)
