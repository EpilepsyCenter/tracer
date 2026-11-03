/**
 * Release-notes logic for the "What's new" dialog — pure functions, no
 * app or Electron dependencies, so they can be tested on their own.
 */

export interface ChangelogEntry {
  version: string
  body: string
}

/** `## 1.2.3` headings split the file into versions (newest first). */
export function parseChangelog(md: string): ChangelogEntry[] {
  const text = md.replace(/<!--[\s\S]*?-->/g, '')
  const out: ChangelogEntry[] = []
  const re = /^##\s+v?(\d+\.\d+\.\d+)\s*$/gm
  const marks: { version: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) marks.push({ version: m[1], start: m.index, end: re.lastIndex })
  marks.forEach((mk, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : text.length
    // `[Read more](manual:Chapter > Section)` at the end of a line: the
    // section names have spaces, which markdown link targets can't, so
    // encode them here and decode in the link renderer.
    const body = text.slice(mk.end, bodyEnd).trim()
      .replace(/\[([^\]]+)\]\(manual:(.+?)\)\s*$/gm,
        (_all, label: string, path: string) =>
          // Brackets too: headings like "14. Burst Detection (Field Bursts)".
          `[${label}](manual:${encodeURIComponent(path.trim()).replace(/\(/g, '%28').replace(/\)/g, '%29')})`)
    out.push({ version: mk.version, body })
  })
  return out
}

/** -1 / 0 / 1, numeric per part; non-numeric versions (e.g. "dev") sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10))
  const pb = b.split('.').map((x) => parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const x = isFinite(pa[i]) ? pa[i] : -1
    const y = isFinite(pb[i]) ? pb[i] : -1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Entries newer than ``lastSeen`` up to the running version. */
export function entriesSince(log: ChangelogEntry[], lastSeen: string | null, current: string): ChangelogEntry[] {
  return log.filter((e) =>
    compareVersions(e.version, current) <= 0
    && (lastSeen == null || compareVersions(e.version, lastSeen) > 0))
}

export const LAST_SEEN_PREF = 'lastSeenVersion'

/**
 * Startup decision. Returns what to show and whether to record the
 * running version as seen.
 *
 * - Development build ("dev"): nothing.
 * - Stored version ≥ running one: nothing.
 * - No stored version and no other preferences → fresh install: record,
 *   show nothing.
 * - No stored version but existing preferences → updated from a version
 *   that predates this dialog: show the running version's notes.
 * - Stored version older → show every version since, newest first.
 */
export function decideStartup(
  prefs: Record<string, unknown>, current: string, log: ChangelogEntry[],
): { show: ChangelogEntry[]; record: boolean } {
  if (!/^\d+\.\d+\.\d+/.test(current)) return { show: [], record: false }
  const stored = typeof prefs[LAST_SEEN_PREF] === 'string' ? prefs[LAST_SEEN_PREF] as string : null
  if (stored && compareVersions(stored, current) >= 0) return { show: [], record: false }
  const fresh = !stored && Object.keys(prefs).filter((k) => k !== LAST_SEEN_PREF).length === 0
  if (fresh) return { show: [], record: true }
  if (!stored) return { show: log.filter((e) => compareVersions(e.version, current) === 0), record: true }
  return { show: entriesSince(log, stored, current), record: true }
}

/** Help ▸ What's New: the running version's notes (or the newest version
 *  at or below it); the newest entry for builds newer than every entry's
 *  version, e.g. development builds. */
export function entriesForMenu(log: ChangelogEntry[], current: string): ChangelogEntry[] {
  const own = log.filter((e) => compareVersions(e.version, current) <= 0)
  return own.length > 0 ? own.slice(0, 1) : log.slice(0, 1)
}
