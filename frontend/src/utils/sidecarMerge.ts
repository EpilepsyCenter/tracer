/**
 * Merging one window's own edits into the sidecar on disk (#31).
 *
 * Every window keeps a copy of the recording's state and may save it. To
 * keep a window from writing an older copy over newer results, it writes
 * only the slices it changed itself; the rest come from the file.
 */

/** Where each tracked slice lives in the sidecar file. */
export const SIDECAR_SLOTS = {
  events: ['analyses', 'events'],
  bursts: ['analyses', 'bursts'],
  spectral: ['analyses', 'spectral'],
  ap: ['analyses', 'ap'],
  iv: ['analyses', 'iv_curves'],
  fpsp: ['analyses', 'fpsp_curves'],
  cursorAnalyses: ['analyses', 'cursor_analyses'],
  resistanceResults: ['analyses', 'resistance'],
  paired: ['analyses', 'paired'],
  pairedForm: ['forms', 'paired'],
  burstFormParams: ['burst_form_params'],
  burstDualForm: ['burst_dual_form'],
  trainParams: ['train_params'],
  excluded: ['excluded_sweeps'],
  averaged: ['averaged_sweeps'],
  notes: ['notes'],
  cursors: ['cursors'],
  resistanceForm: ['forms', 'resistance'],
  recordingMeta: ['meta'],
  scaleOverrides: ['scale_overrides'],
  filtersBySeries: ['filters_by_series'],
} as const
export type SidecarSlot = keyof typeof SIDECAR_SLOTS

/** ``existing`` with the given slots replaced by ``fresh``'s (a slot that's
 *  absent in ``fresh`` is removed). */
export function mergeSidecarSlots(existing: Record<string, any>, fresh: Record<string, any>, slots: SidecarSlot[]): Record<string, any> {
  const out: Record<string, any> = {
    ...existing,
    analyses: { ...(existing.analyses ?? {}) },
    forms: { ...(existing.forms ?? {}) },
  }
  for (const slot of slots) {
    const path = SIDECAR_SLOTS[slot]
    const src = path.length === 2 ? fresh[path[0]]?.[path[1]] : fresh[path[0]]
    const dst = path.length === 2 ? out[path[0]] : out
    const key = path[path.length - 1]
    if (src === undefined) delete dst[key]
    else dst[key] = src
  }
  for (const k of ['format', 'version', 'app_version', 'recording_name']) out[k] = fresh[k]
  delete out.saved_at
  return out
}
