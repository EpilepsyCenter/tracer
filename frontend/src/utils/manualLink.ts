/**
 * Open the bundled manual at a given section.
 *
 * A section is named by its heading path, e.g.
 * `22. Spectral Analysis > Coupling with a second channel` — chapter, then
 * section — because section titles like "When to use this window" repeat in
 * every chapter. Matching is case-insensitive on the heading text.
 *
 * The manual opens in its own window. If it is already open it gets a
 * BroadcastChannel message; if not, the request waits in localStorage and
 * the new window picks it up when it mounts.
 */

const PENDING_KEY = 'tracer-manual-goto'

export async function openManualAt(path?: string): Promise<void> {
  if (path) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ path, t: Date.now() })) } catch { /* ignore */ }
    try {
      const ch = new BroadcastChannel('tracer-sync')
      ch.postMessage({ type: 'manual-goto', path })
      ch.close()
    } catch { /* ignore */ }
  }
  await window.electronAPI?.openAnalysisWindow?.('manual')
}

/** A recent (≤ 15 s) pending section request, consumed on read. */
export function takePendingManualPath(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    localStorage.removeItem(PENDING_KEY)
    if (!raw) return null
    const { path, t } = JSON.parse(raw)
    return typeof path === 'string' && Date.now() - Number(t) < 15000 ? path : null
  } catch { return null }
}

export function clearPendingManualPath(): void {
  try { localStorage.removeItem(PENDING_KEY) } catch { /* ignore */ }
}

/** Heading id for a `Chapter > Section` path, searching each part after the
 *  previous one. Falls back to the deepest part that was found. */
export function resolveManualPath(
  headings: { text: string; id: string }[], path: string,
): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const parts = path.split('>').map(norm).filter(Boolean)
  let from = 0
  let found: string | null = null
  for (const part of parts) {
    let hit = -1
    for (let i = from; i < headings.length; i++) {
      if (norm(headings[i].text) === part) { hit = i; break }
    }
    if (hit < 0) {
      for (let i = from; i < headings.length; i++) {
        if (norm(headings[i].text).includes(part)) { hit = i; break }
      }
    }
    if (hit < 0) break
    found = headings[hit].id
    from = hit + 1
  }
  return found
}
