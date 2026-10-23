/**
 * Batch Analysis window — Phase 4b.
 *
 * Workflow:
 *   1. Pick a TEMPLATE file (an already-analyzed recording).
 *   2. The window scans its .tracer sidecar and derives a "recipe
 *      set": for every analysis blob in `analyses.*`, look up the
 *      ``${group}:${series}`` key in `meta.series_tags` and record
 *      ``(tag → analysis_type, params, channel)``. Manual events /
 *      kinetic edits are NOT carried — batch detects fresh.
 *   3. User picks a TARGET FOLDER. The window scans every recording
 *      and (lazily) reads each one's tree + sidecar tags.
 *   4. Cohort-style table: rows = files, columns = recipes (one per
 *      tag the template covers). Per-recipe checkbox lets the user
 *      opt files in / out. Files with NO tag matching any template
 *      recipe show greyed-out with a "tag this file first" hint.
 *   5. Run → sequential per-file, per-recipe; progress + per-file log;
 *      results land in each target's sidecar (so the cohort module
 *      picks them up afterwards).
 *
 * This file ships steps 1 and 2 — the recipe extraction + template
 * picker. Folder/table and the run loop come in subsequent commits.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { displayGroupSeries } from '../../utils/groupSeriesKey'

// All analysis-data shapes share a similar "blob keyed by group:series"
// pattern. We don't need their full type info here; we only inspect
// `params` (where present) and the key. Cast loosely to keep this
// window decoupled from the per-analysis data definitions.
type AnyBlob = Record<string, unknown>

/** Every analysis-type slot the .tracer sidecar carries. The order
 *  here matches the order of recipes shown in the table — events first
 *  (most common), resistance last. Used both for iterating sidecar
 *  slots during scan and for the recipe-extraction emit calls below
 *  so the two loops stay in sync. */
const ANALYSIS_TYPES = [
  'events',
  'bursts',
  'ap',
  'iv_curves',
  'fpsp_curves',
  'cursor_analyses',
  'resistance',
  'paired',
] as const
type AnalysisType = (typeof ANALYSIS_TYPES)[number]

interface SidecarMetaShape {
  group_tags?: string[]
  series_tags?: Record<string, string[]>
}

interface SidecarShape {
  format?: string
  meta?: SidecarMetaShape
  analyses?: {
    events?: Record<string, AnyBlob>
    bursts?: Record<string, AnyBlob>
    ap?: Record<string, AnyBlob>
    iv_curves?: Record<string, AnyBlob>
    fpsp_curves?: Record<string, AnyBlob>
    cursor_analyses?: Record<string, AnyBlob>
    resistance?: Record<string, AnyBlob[]>
    paired?: Record<string, AnyBlob>
  }
  forms?: Record<string, AnyBlob>
  cursors?: {
    baselineStart: number; baselineEnd: number
    peakStart: number; peakEnd: number
    fitStart: number; fitEnd: number
  }
  /** Per-module train-grouping form state, keyed by ``${group}:
   *  ${series}``. Batch propagates the template's value for each
   *  recipe to the matched target's sidecar so cohort metrics are
   *  computed consistently across the cohort. */
  train_params?: {
    bursts?: Record<string, AnyBlob>
    events?: Record<string, AnyBlob>
    ap?: Record<string, AnyBlob>
  }
}

interface TargetEntry {
  filePath: string
  fileName: string
  hasSidecar: boolean
  /** File-level tags from the sidecar (or empty when none yet). */
  fileTags: string[]
  /** Series-level tags map; ``${group}:${series}`` → list of tags. */
  seriesTags: Record<string, string[]>
  /** Per-analysis-type list of (g:s[:subtype]) keys already present
   *  in the sidecar's ``analyses.*``. Used to flag overwrite cells. */
  existingAnalyses: Record<string, string[]>
}

interface RecipeMatch {
  /** ``${group}:${series}`` keys in this file matching the recipe's
   *  primary tag. Multiple = the analysis runs once per matched
   *  series (consistent with EE's per-series duplication behaviour). */
  primary: string[]
  /** Per-role secondary matches (FPsp LTP role 'B' → post-tetanus
   *  series). Empty for single-series analyses. */
  secondary: Record<string, string[]>
  /** True when at least one of the primary keys (with subtype
   *  suffix where applicable) already has a result blob in this
   *  file's sidecar. The runner skips such pairs unless overwrite. */
  alreadyHasResults: boolean
  /** True when the recipe is fully matchable in this file (primary
   *  has ≥ 1 hit, AND every secondary role also has ≥ 1 hit). */
  matched: boolean
}

/** Stable identifier for a recipe — used as a key in the
 *  ``selections`` map and as a column header lookup. */
function recipeId(r: BatchRecipe): string {
  return `${r.analysisType}|${r.subtype ?? ''}|${r.sourceKey}|${r.tag}`
}

/** One unit of work the run loop produces from the selection map. */
interface RunPlanItem {
  recipe: BatchRecipe
  match: RecipeMatch
}
interface RunPlanFile {
  entry: TargetEntry
  items: RunPlanItem[]
}

/** Per-file log entry shown in the summary panel. ``level`` colours
 *  the row + lets the summary count successes / failures / skips. */
interface RunLogEntry {
  filePath: string
  fileName: string
  level: 'ok' | 'error' | 'skip'
  message: string
}

/** One entry in the template's recipe set. The batch runner uses this
 *  to drive per-file detection: for each target file, find every
 *  series whose tags include ``tag``, and run ``analysisType`` on
 *  it with ``params`` + ``channel``. */
export interface BatchRecipe {
  /** Series tag from the template that anchors this recipe. The
   *  batch runner matches target files by tag, not by group/series
   *  index — so a target file with the same protocol on different
   *  group/series indices still picks up the right analysis. */
  tag: string
  /** Which analysis to run (events / bursts / ap / iv / fpsp / etc.). */
  analysisType: string
  /** Source ``${group}:${series}`` key in the template — surfaced in
   *  the UI so the user can verify which series of the template the
   *  recipe came from. */
  sourceKey: string
  /** Optional analysis-specific subtype carried in the storage key.
   *  Currently only FPsp uses this (3-part keys ``g:s:mode`` with
   *  ``mode`` ∈ {ltp, io, ppr}); other analyses leave it null. The
   *  runner uses this to dispatch to the right FPsp endpoint. */
  subtype: string | null
  /** Snapshot of the template's params blob for that analysis +
   *  series. Shape varies by analysis type. */
  params: AnyBlob
  /** Channel the template's analysis ran on. The batch runner uses
   *  this index on each target file unless overridden later. */
  channel: number | null
  /** For analyses that span multiple series (FPsp LTP needs a baseline
   *  series AND a post-tetanus one), this captures the tags of any
   *  *secondary* series the template references. The runner uses these
   *  to remap the secondary series indices on a target file via tag
   *  match. Keyed by role (``'B'`` for FPsp.seriesB, future roles for
   *  other analyses). Empty when the recipe needs only the primary
   *  series. */
  secondaryTags: Record<string, string[]>
  /** Snapshot of the recording's global cursor positions at template
   *  extraction time. Currently only populated for ``resistance`` —
   *  it's the only analysis type that doesn't store its cursor
   *  windows on its own data blob, leaning on the top-level
   *  ``cursors`` slot instead. ``null`` for analyses that ignore the
   *  global cursors. */
  cursors: { baselineStart: number; baselineEnd: number;
             peakStart: number; peakEnd: number;
             fitStart: number; fitEnd: number } | null
  /** Snapshot of the template's ``train_params`` for the matching
   *  module + ``${group}:${series}``. Only populated for analyses
   *  that support train grouping (events / bursts / ap); ``null``
   *  for everything else. The runner writes this onto the target's
   *  store after the recipe runs so the next sidecar save persists
   *  it — cohort then sees consistent train params across the
   *  whole batch. */
  trainParams: AnyBlob | null
}

/** Parse an analysis-storage key into its (group, series, subtype)
 *  parts. Most analyses key by ``${group}:${series}`` (2 parts);
 *  FPsp adds a 3rd ``mode`` component. Tag lookups always use just
 *  the first two parts since series-level tags don't know about
 *  analysis subtypes. */
function parseAnalysisKey(key: string): {
  groupSeries: string
  subtype: string | null
} {
  const parts = key.split(':')
  if (parts.length >= 3) {
    return { groupSeries: `${parts[0]}:${parts[1]}`, subtype: parts.slice(2).join(':') }
  }
  return { groupSeries: key, subtype: null }
}

// displayGroupSeries lives in src/utils/groupSeriesKey.ts — shared
// with the cohort window so 1-indexed display stays consistent.

/** Pull a channel index out of an analysis blob — different analyses
 *  store it under slightly different field names. Returns ``null`` if
 *  not found (template might omit it for some analysis types). */
function pickChannel(blob: AnyBlob): number | null {
  const c = (blob as any).channel
  if (typeof c === 'number') return c
  const t = (blob as any).trace
  if (typeof t === 'number') return t
  // Paired stores channels as ``preTrace`` / ``postTrace``. Surface
  // the pre channel here so the recipe table's "channel" column shows
  // a sensible value; the runner reads both channels off ``params``
  // (see runPairedRecipe).
  const pre = (blob as any).preTrace
  if (typeof pre === 'number') return pre
  return null
}

/** Pull the params sub-object from an analysis blob. Events / bursts
 *  store params under ``.params``; other analyses inline their fields
 *  on the blob itself. We snapshot the whole blob in those cases —
 *  the runner knows which fields apply to which analysis. */
function pickParams(blob: AnyBlob): AnyBlob {
  const p = (blob as any).params
  if (p && typeof p === 'object') return p as AnyBlob
  return blob
}

/** Walk every analysis slot in the sidecar and emit a recipe per
 *  (analysis, group:series) entry that has at least one series tag.
 *  Untagged analyses are skipped — they can't be matched against
 *  target files in the tag-driven flow. */
export function extractRecipes(sidecar: SidecarShape): {
  recipes: BatchRecipe[]
  warnings: string[]
} {
  const warnings: string[] = []
  const recipes: BatchRecipe[] = []
  const meta = sidecar.meta ?? {}
  const seriesTags = meta.series_tags ?? {}
  const analyses = sidecar.analyses ?? {}

  // Per-type emit. For ``resistance`` the value is an array; we still
  // tag once per (group:series) key — only the params/forms differ.
  const emit = (type: string, blobs: Record<string, AnyBlob | AnyBlob[]> | undefined) => {
    if (!blobs) return
    for (const [key, raw] of Object.entries(blobs)) {
      // FPsp keys analyses 3-part (``g:s:mode``); strip the subtype
      // before looking up series_tags, which only ever uses g:s.
      const { groupSeries, subtype } = parseAnalysisKey(key)
      const tags = seriesTags[groupSeries] ?? []
      if (tags.length === 0) {
        warnings.push(`${type} on ${displayGroupSeries(key)} has no series tags on ${displayGroupSeries(groupSeries)} — skipped (tag the series in the template, then re-pick).`)
        continue
      }
      // ``raw`` is either the analysis blob (most analyses) or an
      // array (resistance). For arrays we use the first row to read
      // channel; params come from sidecar.forms.<type> if present
      // (resistance keeps form state in the top-level forms slot).
      const blob: AnyBlob = Array.isArray(raw)
        ? ((sidecar.forms?.[type] as AnyBlob | undefined) ?? {})
        : raw
      const channel = pickChannel(Array.isArray(raw) ? (raw[0] ?? {}) : raw)
      const params = pickParams(blob)

      // Capture secondary-series tags. FPsp LTP mode references a
      // post-tetanus series via params.seriesB; the runner needs to
      // find an equivalent series in the target file by tag, since
      // raw indices won't carry across files. Other analyses leave
      // ``secondaryTags`` empty — they're single-series.
      const secondaryTags: Record<string, string[]> = {}
      if (type === 'fpsp_curves' && subtype === 'ltp') {
        const groupNum = Number(parseAnalysisKey(key).groupSeries.split(':')[0])
        const seriesB = (blob as any).seriesB
        if (typeof seriesB === 'number' && Number.isFinite(seriesB)) {
          const bKey = `${groupNum}:${seriesB}`
          const bTags = seriesTags[bKey] ?? []
          if (bTags.length > 0) {
            secondaryTags['B'] = bTags
          } else {
            warnings.push(`fpsp_curves [ltp] on ${displayGroupSeries(groupSeries)} references seriesB ${displayGroupSeries(bKey)} but that series has no tags. Tag the post-tetanus series so target files can match it.`)
          }
        }
      }

      // Resistance is the only analysis that doesn't store its
      // cursor windows on its own data blob — it leans on the
      // recording's global cursors slot. Capture that snapshot so
      // the batch runner can apply the same windows to target files.
      const cursors = (type === 'resistance' && sidecar.cursors)
        ? { ...sidecar.cursors }
        : null
      // Train-grouping params travel alongside the analysis params
      // for the three modules that support it. Map analysis_type →
      // train module key (events / bursts / ap; others are null).
      const trainModule: 'events' | 'bursts' | 'ap' | null =
        type === 'events' ? 'events'
        : type === 'bursts' ? 'bursts'
        : type === 'ap' ? 'ap'
        : null
      const trainParams: AnyBlob | null = trainModule
        ? ((sidecar.train_params?.[trainModule]?.[groupSeries] as AnyBlob | undefined) ?? null)
        : null

      // Emit one recipe per tag on the series — multiple tags = the
      // recipe matches any of those tags on a target file.
      for (const tag of tags) {
        recipes.push({
          tag, analysisType: type, sourceKey: key,
          subtype, params, channel, secondaryTags, cursors,
          trainParams,
        })
      }
    }
  }

  for (const type of ANALYSIS_TYPES) {
    emit(type, (analyses as Record<string, unknown>)[type] as
      Record<string, AnyBlob | AnyBlob[]> | undefined)
  }

  return { recipes, warnings }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  backendUrl: string
}

export function BatchWindow({ backendUrl }: Props) {
  // Active recording in the parent window (if any). Used to pre-load
  // the currently-open file as the template — most users land here
  // right after analysing a file and want to apply it across the rest
  // of the folder.
  const recording = useAppStore((s) => s.recording)
  const [templatePath, setTemplatePath] = useState<string | null>(null)
  const [templateMeta, setTemplateMeta] = useState<SidecarMetaShape | null>(null)
  const [recipes, setRecipes] = useState<BatchRecipe[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Raw sidecar fields surfaced under "Detected analyses" so the user
  // can see what the sidecar actually contains when no recipes were
  // produced (catches the common "tagged file-level only, not series-
  // level" misconfiguration). Empty when the template hasn't loaded.
  const [diagAnalyses, setDiagAnalyses] = useState<string[]>([])
  const [diagSeriesTags, setDiagSeriesTags] = useState<Record<string, string[]>>({})

  /** Load + parse a template path. Shared by the explicit picker and
   *  the "pre-load active recording" effect below. */
  const loadTemplate = useCallback(async (path: string) => {
    const api = window.electronAPI
    if (!api?.readSidecar) return
    setTemplatePath(path)
    setLoading(true)
    setLoadError(null)
    setRecipes([])
    setWarnings([])
    setDiagAnalyses([])
    setDiagSeriesTags({})
    try {
      const sidecar = (await api.readSidecar(path)) as SidecarShape | null
      if (!sidecar || sidecar.format !== 'tracer-sidecar') {
        throw new Error('No TRACER sidecar found for this file. Open + analyse it once first.')
      }
      const { recipes, warnings } = extractRecipes(sidecar)
      // Always commit the diagnostic + meta state, even with 0 recipes
      // — the user needs to see what the sidecar actually contains so
      // the warnings point at the right series. The throw-on-empty
      // earlier swallowed that detail and produced a generic error.
      setTemplateMeta(sidecar.meta ?? null)
      setDiagSeriesTags(sidecar.meta?.series_tags ?? {})
      const a = sidecar.analyses ?? {}
      const found: string[] = []
      const probe = (label: string, slot: any) => {
        if (slot && typeof slot === 'object') {
          const keys = Object.keys(slot)
          if (keys.length > 0) {
            // Translate 0-indexed storage keys to the HEKA-natural
            // 1-indexed form before showing the user — keeps the
            // diagnostic strings consistent with the tree labels.
            found.push(`${label}: ${keys.map(displayGroupSeries).join(', ')}`)
          }
        }
      }
      probe('events', a.events); probe('bursts', a.bursts); probe('ap', a.ap)
      probe('iv_curves', a.iv_curves); probe('fpsp_curves', a.fpsp_curves)
      probe('cursor_analyses', a.cursor_analyses); probe('resistance', a.resistance)
      probe('paired', a.paired)
      setDiagAnalyses(found)
      setRecipes(recipes)
      setWarnings(warnings)
    } catch (err: any) {
      setLoadError(String(err?.message ?? err))
      setTemplateMeta(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Pre-load the active recording on first mount, if there is one. The
  // user can override via "Change template…". Tracked by a ref so we
  // don't re-pre-load if the active file changes mid-session — that
  // would clobber a deliberate template pick.
  const preloadDoneRef = useRef(false)
  useEffect(() => {
    if (preloadDoneRef.current) return
    if (recording?.filePath) {
      preloadDoneRef.current = true
      void loadTemplate(recording.filePath)
    }
  }, [recording?.filePath, loadTemplate])

  const pickTemplate = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.openFileDialog) return
    const path = await api.openFileDialog()
    if (!path) return
    await loadTemplate(path)
  }, [loadTemplate])

  // ---------------------------------------------------------------
  // Target folder + per-file table
  // ---------------------------------------------------------------
  const [targetFolder, setTargetFolder] = useState<string | null>(null)
  const [targetEntries, setTargetEntries] = useState<TargetEntry[]>([])
  const [targetLoading, setTargetLoading] = useState(false)
  const [targetError, setTargetError] = useState<string | null>(null)
  // Per-(file, recipe) opt-in. Keys are ``${filePath}||${recipeId}``;
  // values are booleans. Default selection is "checked when there's a
  // match", computed on scan; user clicks toggle individual cells.
  const [selections, setSelections] = useState<Record<string, boolean>>({})
  const [overwriteAll, setOverwriteAll] = useState(false)

  const scanTargetFolder = useCallback(async (folder: string) => {
    const api = window.electronAPI
    if (!api?.listFolderRecordings) return
    setTargetLoading(true)
    setTargetError(null)
    try {
      const result = await api.listFolderRecordings(folder)
      setTargetFolder(result.folder ?? folder)
      // Read every file's sidecar in parallel — the previous loop
      // awaited each ``readSidecar`` before starting the next, which
      // serialised 100 file reads on big folders. ``Promise.all``
      // lets Electron's IPC pipeline service them concurrently.
      const sidecars = await Promise.all(result.entries.map((e) => {
        if (!e.hasSidecar || !api.readSidecar) return Promise.resolve(null)
        return (api.readSidecar(e.filePath) as Promise<SidecarShape | null>)
          .catch(() => null)
      }))
      const entries: TargetEntry[] = result.entries.map((e, i) => {
        const meta = (e.meta ?? null) as SidecarMetaShape | null
        const sc = sidecars[i]
        const a = sc?.analyses ?? {}
        const analyses: Record<string, string[]> = {}
        for (const type of ANALYSIS_TYPES) {
          const slot = (a as Record<string, unknown>)[type]
          if (slot && typeof slot === 'object') {
            analyses[type] = Object.keys(slot as Record<string, unknown>)
          }
        }
        return {
          filePath: e.filePath, fileName: e.fileName,
          hasSidecar: e.hasSidecar,
          fileTags: meta?.group_tags ?? [],
          seriesTags: meta?.series_tags ?? {},
          existingAnalyses: analyses,
        }
      })
      setTargetEntries(entries)
    } catch (err: any) {
      setTargetError(String(err?.message ?? err))
    } finally {
      setTargetLoading(false)
    }
  }, [])

  const pickTargetFolder = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.openFolderDialog) return
    const folder = await api.openFolderDialog(targetFolder ?? undefined)
    if (!folder) return
    await scanTargetFolder(folder)
  }, [targetFolder, scanTargetFolder])


  /** Compute, for each (file, recipe) pair: which series in the file
   *  match the recipe's primary tag, plus secondary-series matches
   *  for cross-series analyses (FPsp LTP). Returned per-file so the
   *  table render can iterate cheaply. */
  const matches = useMemo(() => {
    const out: Record<string, Record<string, RecipeMatch>> = {}
    for (const ent of targetEntries) {
      const perRecipe: Record<string, RecipeMatch> = {}
      for (const r of recipes) {
        const id = recipeId(r)
        // Primary: any (g:s) in this file whose tags include r.tag.
        const primary: string[] = []
        for (const [k, ts] of Object.entries(ent.seriesTags)) {
          if (ts.includes(r.tag) && !primary.includes(k)) primary.push(k)
        }
        // Secondary: same logic per role.
        const secondary: Record<string, string[]> = {}
        for (const [role, roleTags] of Object.entries(r.secondaryTags)) {
          const hits: string[] = []
          for (const [k, ts] of Object.entries(ent.seriesTags)) {
            if (roleTags.some((t) => ts.includes(t)) && !hits.includes(k)) hits.push(k)
          }
          secondary[role] = hits
        }
        // Existing-results check: do any of the primary keys already
        // have a result blob for this analysis type? For FPsp we also
        // need to consider the subtype (fpsp_curves keys are 3-part).
        const existingForType = ent.existingAnalyses[r.analysisType] ?? []
        const alreadyHasResults = primary.some((pk) => {
          if (r.subtype) {
            return existingForType.includes(`${pk}:${r.subtype}`)
          }
          return existingForType.includes(pk)
        })
        perRecipe[id] = {
          primary, secondary, alreadyHasResults,
          matched: primary.length > 0
            && Object.keys(r.secondaryTags).every((role) =>
              (secondary[role]?.length ?? 0) > 0),
        }
      }
      out[ent.filePath] = perRecipe
    }
    return out
  }, [targetEntries, recipes])

  // Whenever the matches table is recomputed, default-select every
  // (file, recipe) pair that has a primary match — the user's
  // expected starting state. Existing results also default to
  // "skip" (off) unless overwriteAll is on. Manual toggles via
  // ``selections`` override these computed defaults.
  const effectiveSelected = useCallback((filePath: string, rId: string): boolean => {
    const k = `${filePath}||${rId}`
    if (k in selections) return selections[k]
    const m = matches[filePath]?.[rId]
    if (!m || !m.matched) return false
    if (m.alreadyHasResults && !overwriteAll) return false
    return true
  }, [selections, matches, overwriteAll])

  const toggleSelection = useCallback((filePath: string, rId: string) => {
    setSelections((prev) => {
      const k = `${filePath}||${rId}`
      const cur = effectiveSelected(filePath, rId)
      return { ...prev, [k]: !cur }
    })
  }, [effectiveSelected])

  /** Bulk-select operations for the target table. ``All matched``
   *  forces every (file, recipe) cell where the recipe matches to
   *  ON (overrides existing-results skip). ``None`` explicitly turns
   *  every visible cell OFF. ``Reset`` drops all manual overrides
   *  and falls back to the default (matched-and-not-already-existing
   *  → on, everything else → off). */
  const onSelectAllMatched = useCallback(() => {
    setSelections(() => {
      const next: Record<string, boolean> = {}
      for (const ent of targetEntries) {
        const perRecipe = matches[ent.filePath] ?? {}
        for (const r of recipes) {
          const rId = recipeId(r)
          if (perRecipe[rId]?.matched) {
            next[`${ent.filePath}||${rId}`] = true
          }
        }
      }
      return next
    })
  }, [targetEntries, matches, recipes])

  const onSelectNone = useCallback(() => {
    setSelections(() => {
      const next: Record<string, boolean> = {}
      for (const ent of targetEntries) {
        for (const r of recipes) {
          next[`${ent.filePath}||${recipeId(r)}`] = false
        }
      }
      return next
    })
  }, [targetEntries, recipes])

  const onResetDefaults = useCallback(() => setSelections({}), [])

  // ---------------------------------------------------------------
  // Run loop
  // ---------------------------------------------------------------
  const [running, setRunning] = useState(false)
  // Auto-rescan when the window regains focus. Catches the common
  // workflow where the user pops over to delete sidecars / edit tags
  // in another window (or the OS file manager) and comes back here
  // expecting fresh state.
  useEffect(() => {
    if (!targetFolder) return
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return
      if (running) return
      void scanTargetFolder(targetFolder)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [targetFolder, running, scanTargetFolder])
  /** Soft-cancel flag — reads as a ref so the in-flight loop can
   *  observe a cancel request without re-rendering. The loop checks
   *  it between files and returns early; the current file finishes. */
  const cancelRef = useRef(false)
  const [currentFileIdx, setCurrentFileIdx] = useState(0)
  const [filesPlanned, setFilesPlanned] = useState(0)
  const [currentFileName, setCurrentFileName] = useState<string | null>(null)
  const [currentFileFraction, setCurrentFileFraction] = useState(0)
  const [runLog, setRunLog] = useState<RunLogEntry[]>([])
  const [runDone, setRunDone] = useState(false)

  const appOpenFile = useAppStore((s) => s.openFile)
  const appCloseFile = useAppStore((s) => s.closeFile)
  const appRunEvents = useAppStore((s) => s.runEvents)
  const appRunAP = useAppStore((s) => s.runAP)
  const appRunIV = useAppStore((s) => s.runIVCurve)
  const appRunBursts = useAppStore((s) => s.runFieldBurstsOnSeries)
  const appRunFPsp = useAppStore((s) => s.runFPsp)
  const appRunResistanceOnSweep = useAppStore((s) => s.runResistanceOnSweep)
  const appRunResistanceOnAverage = useAppStore((s) => s.runResistanceOnAverage)
  const appRunPaired = useAppStore((s) => s.runPaired)
  const eventsTemplates = useAppStore((s) => s.eventsTemplates)

  /** Plan the run — flatten the selection map into a list of work
   *  items keyed by file. Each file gets a list of recipes the user
   *  opted into AND that match in this file. */
  const buildPlan = useCallback((): RunPlanFile[] => {
    const plan: RunPlanFile[] = []
    for (const ent of targetEntries) {
      const items: RunPlanItem[] = []
      const perRecipe = matches[ent.filePath] ?? {}
      for (const r of recipes) {
        const rId = recipeId(r)
        if (!effectiveSelected(ent.filePath, rId)) continue
        const m = perRecipe[rId]
        if (!m || !m.matched) continue
        items.push({ recipe: r, match: m })
      }
      if (items.length > 0) {
        plan.push({ entry: ent, items })
      }
    }
    return plan
  }, [targetEntries, matches, recipes, effectiveSelected])

  /** Single canonical view of the run plan. Memoizing once and
   *  reusing in ``totalSelected`` / ``conflicts`` / RunBar avoids
   *  three independent ``buildPlan()`` traversals per render. */
  const plan = useMemo(() => buildPlan(), [buildPlan])
  const totalSelected = useMemo(
    () => plan.reduce((acc, f) => acc + f.items.length, 0),
    [plan])

  /** Multi-tag conflicts: a single ``${group}:${series}`` in a target
   *  file matches *multiple selected* recipes. Running both would
   *  either run twice on the same series with different params (one
   *  overwriting the other in the sidecar) or be ambiguous about
   *  which params apply. We surface these as a blocking warning so
   *  the user resolves before run — typically by un-checking one
   *  recipe in the table or fixing the duplicate tag.
   *
   *  A given series with multiple primary-tag matches (e.g. tagged
   *  both ``mEPSC`` and ``mIPSC`` against two different events
   *  recipes) is the canonical conflict. Same-recipe-multiple-series
   *  (one tag → 2 series in the same file) is NOT a conflict — it's
   *  the intended behaviour (run on each).
   *
   *  ``conflicts`` keys are file paths; values list the conflicting
   *  series + the recipes hitting it. */
  const conflicts = useMemo(() => {
    const out: Array<{
      filePath: string; fileName: string
      seriesKey: string
      recipes: BatchRecipe[]
    }> = []
    for (const file of plan) {
      // Group selected recipes by which g:s key they hit on this
      // file. We use the analysis type + subtype + sourceKey as a
      // grouping bucket so two distinct recipes (different tags but
      // same underlying analysis) sharing a series are flagged.
      const perSeries = new Map<string, BatchRecipe[]>()
      for (const item of file.items) {
        for (const k of item.match.primary) {
          const list = perSeries.get(k) ?? []
          list.push(item.recipe)
          perSeries.set(k, list)
        }
      }
      for (const [seriesKey, recipes] of perSeries) {
        if (recipes.length >= 2) {
          out.push({
            filePath: file.entry.filePath,
            fileName: file.entry.fileName,
            seriesKey, recipes,
          })
        }
      }
    }
    return out
  }, [plan])

  /** Run a single events-detection recipe against the *currently open*
   *  recording. We rely on the store's existing event-detection
   *  pipeline (subscriber writes results to sidecar automatically),
   *  so no manual sidecar I/O here. */
  /** Helper — iterate the matched primary series for a recipe and
   *  call ``inner`` for each, scaling the progress fraction so the
   *  caller's slice is divided evenly across hits. */
  const forEachMatch = useCallback(async (
    item: RunPlanItem,
    fileFraction: (frac: number) => void,
    inner: (group: number, series: number, idx: number) => Promise<void>,
  ) => {
    const hits = item.match.primary
    for (let i = 0; i < hits.length; i++) {
      const [g, s] = hits[i].split(':').map(Number)
      const partFrac = (frac: number) =>
        fileFraction((i + frac) / hits.length)
      partFrac(0)
      // eslint-disable-next-line no-await-in-loop
      await inner(g, s, i)
      partFrac(1)
    }
  }, [])

  /** AP: extract the kitchen-sink runAP args from the template's
   *  APData blob. The store action takes them as separate fields
   *  rather than a single params object. */
  const runAPRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const p = item.recipe.params as any
    // Sweep-range translation. Template's runMode is 'all' / 'range'
    // / 'one'; runAP takes either an explicit list of sweep indices
    // (range/one) or null (all). For batch we trust the template's
    // selection — slice indices remain valid because the .pgf
    // protocol typically matches across files of the same kind.
    let sweepIndices: number[] | null = null
    if (p.runMode === 'one' && typeof p.sweepOne === 'number') {
      sweepIndices = [p.sweepOne]
    } else if (p.runMode === 'range'
        && typeof p.sweepFrom === 'number'
        && typeof p.sweepTo === 'number') {
      sweepIndices = []
      for (let i = p.sweepFrom; i <= p.sweepTo; i++) sweepIndices.push(i)
    }
    const imSource = {
      manualEnabled: !!p.manualImEnabled,
      manualStartS: Number(p.manualImStartS ?? 0),
      manualEndS: Number(p.manualImEndS ?? 0),
      manualStartPA: Number(p.manualImStartPA ?? 0),
      manualStepPA: Number(p.manualImStepPA ?? 0),
    }
    // Manual edits / kinetics flag — start from a clean slate per
    // target file (manual events are file-specific) but inherit the
    // measurement choices.
    const manualEdits = p.manualEdits ?? { added: [], removed: [] }
    const measureKinetics = !!(p.kinetics && Object.keys(p.kinetics).length > 0)
    await forEachMatch(item, fileFraction, async (g, s) => {
      const channel = item.recipe.channel ?? 0
      await appRunAP(
        g, s, channel,
        imSource, sweepIndices,
        p.detection,
        p.kinetics,
        p.rheobaseMode,
        p.rampParams ?? null,
        manualEdits,
        measureKinetics,
      )
      if (item.recipe.trainParams) {
        useAppStore.getState().setTrainParams('ap', g, s, item.recipe.trainParams as any)
      }
    })
  }, [forEachMatch, appRunAP])

  /** IV: simpler — single params object the action accepts almost
   *  verbatim, just need to drop fields the action doesn't expect. */
  const runIVRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const p = item.recipe.params as any
    const params = {
      baselineStartS: Number(p.baselineStartS ?? 0),
      baselineEndS: Number(p.baselineEndS ?? 0),
      peakStartS: Number(p.peakStartS ?? 0),
      peakEndS: Number(p.peakEndS ?? 0),
      sweepIndices: null,                 // batch always runs all sweeps
      manualImEnabled: !!p.manualImEnabled,
      manualImStartS: p.manualImStartS,
      manualImEndS: p.manualImEndS,
      manualImStartPA: p.manualImStartPA,
      manualImStepPA: p.manualImStepPA,
    }
    await forEachMatch(item, fileFraction, async (g, s) => {
      const channel = item.recipe.channel ?? 0
      await appRunIV(g, s, channel, params)
    })
  }, [forEachMatch, appRunIV])

  /** Bursts: per-series detection (no per-sweep mode for batch — too
   *  ambiguous when sweep indices differ across files). */
  const runBurstsRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const params = item.recipe.params as any
    await forEachMatch(item, fileFraction, async (g, s) => {
      const channel = item.recipe.channel ?? 0
      await appRunBursts(g, s, channel, params)
      if (item.recipe.trainParams) {
        useAppStore.getState().setTrainParams('bursts', g, s, item.recipe.trainParams as any)
      }
    })
  }, [forEachMatch, appRunBursts])

  /** Paired recording: needs BOTH a pre and a post channel, plus
   *  the four param sub-blobs (pre / post / failure / latency). The
   *  template stashes preTrace / postTrace inline on the analysis
   *  blob (no separate ``channel`` field), so we read them off
   *  ``recipe.params`` rather than ``recipe.channel``. Manual edits
   *  are NOT carried — batch detects fresh, same as the other
   *  analyses. */
  const runPairedRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const p = item.recipe.params as any
    const preTrace = typeof p.preTrace === 'number'
      ? p.preTrace
      : (item.recipe.channel ?? 0)
    const postTrace = typeof p.postTrace === 'number'
      ? p.postTrace
      : (preTrace === 0 ? 1 : 0)
    await forEachMatch(item, fileFraction, async (g, s) => {
      await appRunPaired(g, s, preTrace, postTrace, {
        preMode: p.preMode,
        preParams: p.preParams ?? {},
        postParams: p.postParams ?? {},
        failureParams: p.failureParams ?? {},
        latencyParams: p.latencyParams ?? {},
        postSearchStartS: p.postSearchStartS ?? null,
        postSearchEndS: p.postSearchEndS ?? null,
        // Manual edits: clear per-target file. Batch's whole point
        // is fresh detection — carrying the template's per-trial
        // overrides to a different recording would be nonsense.
        manualEdits: { added: {}, removed: {}, postFailed: {} },
        sweeps: null,
      })
    })
  }, [forEachMatch, appRunPaired])

  /** FPsp / LTP / IO / PPR. Mode is on the recipe subtype; LTP also
   *  needs a target-file series mapped to ``seriesB`` via the
   *  secondary tags captured at extraction. */
  const runFPspRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const p = item.recipe.params as any
    const mode = (item.recipe.subtype ?? p.mode ?? 'ltp') as any
    // For LTP, locate the matching post-tetanus series in the target
    // file. ``match.secondary['B']`` contains every g:s key whose
    // tags overlap with the template's seriesB tags. Take the first
    // hit (multiple-match disambiguation can come later).
    let seriesB: number | null = null
    if (mode === 'ltp') {
      const hits = item.match.secondary['B'] ?? []
      if (hits.length > 0) {
        seriesB = Number(hits[0].split(':')[1])
      }
    }
    const fpspParams = {
      mode,
      seriesB,
      baselineStartS: Number(p.baselineStartS ?? 0),
      baselineEndS: Number(p.baselineEndS ?? 0),
      volleyStartS: Number(p.volleyStartS ?? 0),
      volleyEndS: Number(p.volleyEndS ?? 0),
      fepspStartS: Number(p.fepspStartS ?? 0),
      fepspEndS: Number(p.fepspEndS ?? 0),
      method: p.measurementMethod ?? p.method,
      slopeLowPct: Number(p.slopeLowPct ?? 20),
      slopeHighPct: Number(p.slopeHighPct ?? 80),
      peakDirection: p.peakDirection,
      avgN: Number(p.avgN ?? 1),
      sweepIndices: null,
      // Filter passthrough.
      filterEnabled: !!p.filterEnabled,
      filterType: p.filterType,
      filterLow: p.filterLow,
      filterHigh: p.filterHigh,
      filterOrder: p.filterOrder,
      // I-O extras.
      ioInitialIntensity: p.ioInitialIntensity,
      ioIntensityStep: p.ioIntensityStep,
      ioUnit: p.ioUnit,
      ioMetric: p.ioMetric,
      // PPR extras.
      volley2StartS: p.volley2StartS,
      volley2EndS: p.volley2EndS,
      fepsp2StartS: p.fepsp2StartS,
      fepsp2EndS: p.fepsp2EndS,
      pprIsiMs: p.pprIsiMs,
      pprMetric: p.pprMetric,
    }
    await forEachMatch(item, fileFraction, async (g, s) => {
      const channel = item.recipe.channel ?? 0
      await appRunFPsp(g, s, channel, fpspParams)
    })
  }, [forEachMatch, appRunFPsp])

  /** Resistance: the only analysis that uses the recording's global
   *  cursors slot rather than per-blob cursor windows. We snapshot
   *  those at extraction time onto ``recipe.cursors``; here we push
   *  them into the store before invoking the run action so its
   *  in-flight read of ``state.cursors`` sees the right windows.
   *  ``runResistanceOnSweep`` / ``OnAverage`` also read currentGroup
   *  / currentSeries / currentTrace / currentSweep, so we set those
   *  too. The next ``openFile`` clears all of this for the next file. */
  const runResistanceRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const p = item.recipe.params as any
    const channel = item.recipe.channel ?? 0
    const vStep = Number(p.vStep ?? 0)
    if (item.recipe.cursors) {
      // Patch cursors first; the resistance action reads them at
      // call time. Other cursor consumers (events viewer etc.) are
      // not open during batch so the side-effect is harmless.
      useAppStore.setState({ cursors: { ...item.recipe.cursors } })
    }
    await forEachMatch(item, fileFraction, async (g, s) => {
      // Resistance reads currentGroup/Series/Trace/Sweep from the
      // store — set them via setState so the action picks up the
      // right context without us having to navigate via selectSweep
      // (which would also fetch + render trace data).
      useAppStore.setState({
        currentGroup: g, currentSeries: s, currentTrace: channel,
        currentSweep: 0,
      })
      // Run mode → which action. 'all'/'range' average; 'one' single.
      if (p.runMode === 'one' && typeof p.sweepOne === 'number') {
        useAppStore.setState({ currentSweep: p.sweepOne })
        await appRunResistanceOnSweep(vStep)
      } else if (p.runMode === 'range'
          && typeof p.avgFrom === 'number'
          && typeof p.avgTo === 'number') {
        const sweeps: number[] = []
        for (let i = p.avgFrom; i <= p.avgTo; i++) sweeps.push(i)
        await appRunResistanceOnAverage(vStep, sweeps)
      } else {
        // 'all' or anything unknown → average across every sweep.
        await appRunResistanceOnAverage(vStep, null)
      }
    })
  }, [forEachMatch, appRunResistanceOnSweep, appRunResistanceOnAverage])

  /** Cursor measurements: no public store action; the cursor window
   *  POSTs ``/api/cursors/run`` directly and writes the result back
   *  via ``useAppStore.setState({ cursorAnalyses })``. We do the same
   *  here. The recipe's ``params`` is the prior CursorAnalysisData
   *  blob; its slot configs + baseline + run-mode all replay. */
  const runCursorRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const p = item.recipe.params as any
    await forEachMatch(item, fileFraction, async (g, s) => {
      const channel = item.recipe.channel ?? 0
      const slotsAll = Array.isArray(p.slots) ? p.slots : []
      const slotCount = Number(p.slotCount ?? slotsAll.length)
      const visible = slotsAll.slice(0, slotCount)
      // Sweep set: 'all' → null, 'one' → [sweepOne], 'range' → [from..to].
      let sweeps: number[] | null = null
      if (p.runMode === 'one' && typeof p.sweepOne === 'number') {
        sweeps = [p.sweepOne]
      } else if (p.runMode === 'range'
          && typeof p.sweepFrom === 'number'
          && typeof p.sweepTo === 'number') {
        sweeps = []
        for (let i = p.sweepFrom; i <= p.sweepTo; i++) sweeps.push(i)
      }
      const body = {
        group: g, series: s, trace: channel,
        sweeps,
        average: !!p.average,
        baseline: p.baseline ?? { start: 0, end: 0 },
        baseline_method: p.baselineMethod ?? 'mean',
        slots: visible.map((slot: any) => ({
          enabled: !!slot.enabled,
          peak: slot.peak ?? null,
          fit: slot.fit ?? null,
          fit_function: slot.fit && slot.fitFunction ? slot.fitFunction : null,
          fit_options: slot.fitOptions ? {
            maxfev: slot.fitOptions.maxfev,
            ftol: slot.fitOptions.ftol,
            xtol: slot.fitOptions.xtol,
            initial_guess: slot.fitOptions.initialGuess ?? null,
          } : null,
        })),
        compute_ap: !!p.computeAP,
      }
      const resp = await fetch(`${backendUrl}/api/cursors/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'Run failed' }))
        throw new Error(err.detail || 'Cursor run failed')
      }
      const data = await resp.json()
      // Write the new analysis blob into the store. The sidecar
      // subscriber will persist it on the next state change.
      const key = `${g}:${s}`
      useAppStore.setState((state) => {
        const prev = state.cursorAnalyses[key] ?? p
        const next = {
          ...prev,
          group: g, series: s, trace: channel,
          slotCount, slots: slotsAll,
          baseline: body.baseline,
          baselineMethod: body.baseline_method,
          measurements: data.measurements ?? [],
          traceUnit: data.trace_unit ?? '',
          // Preserve average / runMode flags so re-opens look right.
          average: !!p.average,
          runMode: p.runMode ?? 'all',
          sweepFrom: p.sweepFrom,
          sweepTo: p.sweepTo,
          sweepOne: p.sweepOne,
          // AP stuff defaults off in batch.
          computeAP: !!p.computeAP,
          apSlope: p.apSlope ?? 20,
        }
        return {
          cursorAnalyses: { ...state.cursorAnalyses, [key]: next },
        }
      })
    })
  }, [forEachMatch, backendUrl])

  const runEventsRecipe = useCallback(async (
    item: RunPlanItem, fileFraction: (frac: number) => void,
  ) => {
    const params = item.recipe.params as any  // EventsParams shape
    // Look up the biexp template from the library by id. Templates
    // are stored separately from per-file analyses; the library is
    // shared across files so the same template id is valid here.
    const tmplId = params.templateId
    const template = tmplId
      ? (eventsTemplates.entries[tmplId] ?? null)
      : null
    // Run once per matched (group, series) — multiple matches on the
    // same file are normal (e.g. two series both tagged "mEPSC").
    for (let i = 0; i < item.match.primary.length; i++) {
      const key = item.match.primary[i]
      const [g, s] = key.split(':').map(Number)
      const channel = item.recipe.channel ?? 0
      // Sweep arg: events typically run on a single starting sweep
      // and use ``params.sweepMode`` ('current' / 'all') to expand.
      // We pass 0 as the seed; the runner respects sweepMode.
      const seedSweep = 0
      const partFrac = (frac: number) => {
        const before = i / item.match.primary.length
        const within = frac / item.match.primary.length
        fileFraction(before + within)
      }
      // eslint-disable-next-line no-await-in-loop
      await appRunEvents(g, s, channel, seedSweep, params, template, partFrac)
      // Propagate the template's train-grouping params (if any) so
      // the cohort extractor on this target sees the same grouping.
      if (item.recipe.trainParams) {
        useAppStore.getState().setTrainParams('events', g, s, item.recipe.trainParams as any)
      }
    }
  }, [appRunEvents, eventsTemplates])

  const runBatch = useCallback(async () => {
    const plan = buildPlan()
    if (plan.length === 0) return
    cancelRef.current = false
    setRunning(true)
    setRunDone(false)
    setRunLog([])
    setFilesPlanned(plan.length)
    setCurrentFileIdx(0)

    // Stash the user's currently-open file so we can restore at the
    // end. ``recording`` may be null if they entered the batch
    // window without opening anything first.
    const originalPath = useAppStore.getState().recording?.filePath ?? null
    const log: RunLogEntry[] = []

    for (let i = 0; i < plan.length; i++) {
      if (cancelRef.current) break
      const file = plan[i]
      setCurrentFileIdx(i)
      setCurrentFileName(file.entry.fileName)
      setCurrentFileFraction(0)
      try {
        await appOpenFile(file.entry.filePath)
      } catch (err: any) {
        log.push({
          filePath: file.entry.filePath,
          fileName: file.entry.fileName,
          level: 'error',
          message: `Couldn't open file: ${err?.message ?? err}`,
        })
        setRunLog([...log])
        continue
      }
      // Per-recipe loop within this file. Equal-share progress per
      // recipe — events streaming reports its own fraction which we
      // map onto the within-file slice.
      for (let j = 0; j < file.items.length; j++) {
        if (cancelRef.current) break
        const item = file.items[j]
        const rec = `${ANALYSIS_LABELS[item.recipe.analysisType] ?? item.recipe.analysisType}` +
          (item.recipe.subtype ? ` [${item.recipe.subtype}]` : '') +
          ` · ${item.recipe.tag}`
        const slice = (frac: number) => setCurrentFileFraction((j + frac) / file.items.length)
        try {
          let didRun = true
          switch (item.recipe.analysisType) {
            case 'events':
              // eslint-disable-next-line no-await-in-loop
              await runEventsRecipe(item, slice); break
            case 'ap':
              // eslint-disable-next-line no-await-in-loop
              await runAPRecipe(item, slice); break
            case 'iv_curves':
              // eslint-disable-next-line no-await-in-loop
              await runIVRecipe(item, slice); break
            case 'bursts':
              // eslint-disable-next-line no-await-in-loop
              await runBurstsRecipe(item, slice); break
            case 'fpsp_curves':
              // eslint-disable-next-line no-await-in-loop
              await runFPspRecipe(item, slice); break
            case 'resistance':
              // eslint-disable-next-line no-await-in-loop
              await runResistanceRecipe(item, slice); break
            case 'cursor_analyses':
              // eslint-disable-next-line no-await-in-loop
              await runCursorRecipe(item, slice); break
            case 'paired':
              // eslint-disable-next-line no-await-in-loop
              await runPairedRecipe(item, slice); break
            default:
              didRun = false
              log.push({
                filePath: file.entry.filePath,
                fileName: file.entry.fileName,
                level: 'skip',
                message: `${rec} — unknown analysis type ${item.recipe.analysisType}`,
              })
          }
          if (didRun) {
            log.push({
              filePath: file.entry.filePath,
              fileName: file.entry.fileName,
              level: 'ok',
              message: `${rec} ✓`,
            })
          }
        } catch (err: any) {
          log.push({
            filePath: file.entry.filePath,
            fileName: file.entry.fileName,
            level: 'error',
            message: `${rec} failed: ${err?.message ?? err}`,
          })
        }
        setRunLog([...log])
      }
      setCurrentFileFraction(1)
    }

    // No auto-restore: the confirmation modal closed the active
    // recording explicitly before the run, and re-opening here would
    // load a sidecar that may now contain the just-batched analyses
    // without the user expecting it. ``originalPath`` is logged in
    // ``log`` so the user can manually reopen if they want. The
    // re-open path used to be here — kept the variable hoisted just
    // so future tweaks can resurrect it without rewiring closures.
    void originalPath
    setRunning(false)
    setRunDone(true)
    setCurrentFileName(null)
    cancelRef.current = false
  }, [buildPlan, appOpenFile,
      runEventsRecipe, runAPRecipe, runIVRecipe,
      runBurstsRecipe, runFPspRecipe,
      runResistanceRecipe, runCursorRecipe, runPairedRecipe])

  const cancelRun = useCallback(() => {
    cancelRef.current = true
  }, [])

  // Confirmation gate before kicking off a run. Shows a modal with
  // the planned task count + a heads-up that any open file will be
  // closed first. The "close first" step prevents two classes of
  // problems we hit during testing:
  //   (a) Other analysis windows (events viewer, AP, etc.) seeing
  //       transient state per file as the loop opens/closes.
  //   (b) Surprise inclusion of the open file when it happens to
  //       live in the target folder + match a recipe (default-on
  //       checkbox in the table can be missed).
  const [confirmOpen, setConfirmOpen] = useState(false)
  const recordingPath = useAppStore((s) => s.recording?.filePath ?? null)
  const recordingName = useAppStore((s) => s.recording?.fileName ?? null)
  const requestRun = useCallback(() => {
    const plan = buildPlan()
    if (plan.length === 0) return
    setConfirmOpen(true)
  }, [buildPlan])
  const confirmAndRun = useCallback(async () => {
    setConfirmOpen(false)
    // Close the active recording across the whole app before
    // starting. ``closeFile`` hits the backend's /api/files/close
    // (so its ``_current_recording`` is null) AND broadcasts a
    // ``file-close`` message that other windows (main TraceViewer,
    // analysis sub-windows) listen for to clear their own copies.
    // Without this, the BatchWindow's local setState only cleared
    // its own renderer's store — the main window kept the file open
    // and its sidecar got overwritten when batch happened to target it.
    if (recordingPath) {
      await appCloseFile()
    }
    await runBatch()
  }, [recordingPath, appCloseFile, runBatch])

  const openCohort = useCallback(async () => {
    const api = window.electronAPI
    if (api?.openAnalysisWindow) await api.openAnalysisWindow('cohort_analysis')
  }, [])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      fontFamily: 'var(--font-ui)', fontSize: 'var(--font-size-base)',
    }}>
      {/* Top bar — always visible. Houses the template picker + (later
          in this phase) the folder picker, run button, etc. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600 }}>Template:</span>
        <span style={{
          flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: templatePath ? 'var(--text-primary)' : 'var(--text-muted)',
        }} title={templatePath ?? undefined}>
          {templatePath
            ? templatePath.split(/[/\\]/).pop()
            : 'No template selected'}
        </span>
        <button className="btn btn-primary" onClick={pickTemplate}
          disabled={running}>
          {templatePath ? 'Change template…' : 'Pick template…'}
        </button>
      </div>

      {/* RUN bar — drives the whole batch loop. The total-progress
          fraction lives on the button as a CSS-painted overlay (same
          pattern the Events RUN button uses). */}
      <RunBar
        running={running}
        runDone={runDone}
        canRun={recipes.length > 0 && totalSelected > 0 && conflicts.length === 0}
        totalSelected={totalSelected}
        conflictCount={conflicts.length}
        currentFileIdx={currentFileIdx}
        filesPlanned={filesPlanned}
        currentFileName={currentFileName}
        currentFileFraction={currentFileFraction}
        onRun={requestRun}
        onCancel={cancelRun}
        onOpenCohort={openCohort}
      />

      {/* Pre-run confirmation modal. Surfaces the planned task count
          and warns about closing the active recording. */}
      {confirmOpen && (
        <ConfirmRunModal
          totalTasks={totalSelected}
          totalFiles={plan.length}
          activeRecordingName={recordingName}
          onConfirm={() => void confirmAndRun()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
        {!templatePath ? (
          <div style={{
            color: 'var(--text-muted)', fontStyle: 'italic',
            padding: 24, textAlign: 'center',
          }}>
            Pick a recording you've already analysed and tagged. The
            batch module reads its sidecar to derive a per-tag recipe
            set, then applies the same recipes to every target file
            you select.
          </div>
        ) : loading ? (
          <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Reading template…
          </div>
        ) : loadError ? (
          <div className="notice notice-error">⚠ {loadError}</div>
        ) : (
          <>
            <RecipeList
              recipes={recipes}
              warnings={warnings}
              meta={templateMeta}
              diagAnalyses={diagAnalyses}
              diagSeriesTags={diagSeriesTags}
            />
            {recipes.length > 0 && (
              <div style={{ marginTop: 18, maxWidth: '100%' }}>
                <TargetSection
                  recipes={recipes}
                  targetFolder={targetFolder}
                  targetEntries={targetEntries}
                  targetLoading={targetLoading}
                  targetError={targetError}
                  matches={matches}
                  effectiveSelected={effectiveSelected}
                  toggleSelection={toggleSelection}
                  overwriteAll={overwriteAll}
                  setOverwriteAll={setOverwriteAll}
                  pickTargetFolder={pickTargetFolder}
                  rescan={() => targetFolder && void scanTargetFolder(targetFolder)}
                  onSelectAllMatched={onSelectAllMatched}
                  onSelectNone={onSelectNone}
                  onResetDefaults={onResetDefaults}
                />
              </div>
            )}
            {conflicts.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <ConflictPanel conflicts={conflicts} />
              </div>
            )}
            {runLog.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <RunLogPanel entries={runLog} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recipe list — read-only summary of what the template will do.
// ---------------------------------------------------------------------------

const ANALYSIS_LABELS: Record<string, string> = {
  events: 'Events',
  bursts: 'Bursts',
  ap: 'Action potentials',
  iv_curves: 'I-V curve',
  fpsp_curves: 'Field PSP',
  cursor_analyses: 'Cursor measurements',
  resistance: 'Resistance',
  paired: 'Paired recording',
}

/** Map a secondary-series role key to a human label per analysis +
 *  subtype. Currently only FPsp LTP uses this — role 'B' is the
 *  post-tetanus series. Unknown role keys fall back to themselves. */
function roleLabel(analysisType: string, subtype: string | null, role: string): string {
  if (analysisType === 'fpsp_curves' && subtype === 'ltp' && role === 'B') {
    return 'post-tetanus'
  }
  return role
}

function RecipeList({
  recipes, warnings, meta, diagAnalyses, diagSeriesTags,
}: {
  recipes: BatchRecipe[]
  warnings: string[]
  meta: SidecarMetaShape | null
  /** Lines like "events: 0:1, 0:3" — every analysis blob present in
   *  the sidecar, regardless of tag status. Used in the empty-recipe
   *  state so users can see WHICH series have analyses but no tags. */
  diagAnalyses: string[]
  /** Raw series_tags dump — same purpose as ``diagAnalyses`` but for
   *  the tag side. Helps spot the "tagged the wrong series" case. */
  diagSeriesTags: Record<string, string[]>
}) {
  // Group recipes by (analysisType, subtype, sourceKey) — that's the
  // unit-of-work for the runner. A given source-key may collect
  // multiple tags (the user can tag a series with several names) and
  // we want all of them visible as "match this OR that tag" on the
  // right-hand side. Grouping by source-key dedupes the recipe rows
  // even when a series has multiple tags.
  type Group = {
    analysisType: string
    subtype: string | null
    sourceKey: string
    channel: number | null
    primaryTags: string[]
    secondaryTags: Record<string, string[]>
  }
  const grouped = new Map<string, Group>()
  for (const r of recipes) {
    const k = `${r.analysisType}|${r.subtype ?? ''}|${r.sourceKey}`
    let g = grouped.get(k)
    if (!g) {
      g = {
        analysisType: r.analysisType,
        subtype: r.subtype,
        sourceKey: r.sourceKey,
        channel: r.channel,
        primaryTags: [],
        secondaryTags: r.secondaryTags ?? {},
      }
      grouped.set(k, g)
    }
    if (!g.primaryTags.includes(r.tag)) g.primaryTags.push(r.tag)
  }
  const groups = Array.from(grouped.values())
  groups.sort((a, b) =>
    a.analysisType.localeCompare(b.analysisType)
    || (a.subtype ?? '').localeCompare(b.subtype ?? '')
    || a.sourceKey.localeCompare(b.sourceKey))

  const fileTags = meta?.group_tags ?? []

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      maxWidth: 720,
    }}>
      {fileTags.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
          fontSize: 'var(--font-size-label)',
        }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>
            File-level tags:
          </span>
          {fileTags.map((t) => (
            <span key={t} style={{
              padding: '1px 6px',
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--bg-secondary)',
            }}>{t}</span>
          ))}
        </div>
      )}

      {recipes.length === 0 && (
        <div style={{
          padding: '10px 12px',
          border: '1px solid color-mix(in oklab, var(--error) 45%, transparent)',
          borderRadius: 'var(--radius-md)',
          background: 'color-mix(in oklab, var(--error) 7%, transparent)',
          fontSize: 'var(--font-size-label)',
          lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--error)' }}>
            No usable recipes derived from this template
          </div>
          <div style={{ marginBottom: 6 }}>
            Recipes need <strong>series-level tags</strong>: each (group:series)
            with an analysis must carry at least one tag in the file's
            metadata. File-level tags alone aren't enough — they say
            "what cell this is", not "what this series captures".
          </div>
          {diagAnalyses.length > 0 ? (
            <>
              <div style={{ marginTop: 8, fontWeight: 600 }}>
                Analyses found in this sidecar:
              </div>
              <ul style={{
                margin: '4px 0', paddingLeft: 18,
                fontFamily: 'var(--font-mono)',
              }}>
                {diagAnalyses.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </>
          ) : (
            <div style={{ marginTop: 8, fontStyle: 'italic' }}>
              No analyses found in the sidecar — open + run an
              analysis on this file before using as a template.
            </div>
          )}
          {Object.keys(diagSeriesTags).length > 0 ? (
            <>
              <div style={{ marginTop: 8, fontWeight: 600 }}>
                Series-level tags currently set:
              </div>
              <ul style={{
                margin: '4px 0', paddingLeft: 18,
                fontFamily: 'var(--font-mono)',
              }}>
                {Object.entries(diagSeriesTags).map(([k, ts]) => (
                  <li key={k}>{displayGroupSeries(k)}: {ts.join(', ')}</li>
                ))}
              </ul>
              <div style={{ marginTop: 4, fontStyle: 'italic' }}>
                If the (group:series) keys above don't match the
                analyses, open Tags… and add tags to the right series.
              </div>
            </>
          ) : (
            <div style={{ marginTop: 8, fontStyle: 'italic' }}>
              No series-level tags at all. Open Tags…, expand this
              file's series rows, and tag the analysed ones.
            </div>
          )}
        </div>
      )}
      {recipes.length > 0 && (
      <div>
        <div style={{
          fontWeight: 600, marginBottom: 6,
          color: 'var(--text-primary)',
        }}>
          Detected recipes ({groups.length})
        </div>
        <div style={{
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          background: 'var(--bg-field)',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1.5fr 2fr 1fr',
            padding: '6px 10px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)',
            fontWeight: 600,
          }}>
            <span>Analysis</span>
            <span>Matches series tagged…</span>
            <span style={{ textAlign: 'right' }}>Source</span>
          </div>
          {/* Rows */}
          {groups.map((g, i) => (
            <div key={i} style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 2fr 1fr',
              padding: '6px 10px',
              borderBottom: i < groups.length - 1
                ? '1px solid var(--border-subtle)' : 'none',
              alignItems: 'center',
              fontSize: 'var(--font-size-label)',
            }}>
              {/* Left: analysis type + subtype */}
              <span>
                <span style={{ fontWeight: 600 }}>
                  {ANALYSIS_LABELS[g.analysisType] ?? g.analysisType}
                </span>
                {g.subtype && (
                  <span style={{
                    marginLeft: 6,
                    padding: '0 6px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--bg-secondary)',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 500,
                    color: 'var(--text-muted)',
                  }}>{g.subtype}</span>
                )}
              </span>
              {/* Middle: tags. Primary tags on top, secondary tags
                  (LTP post-tetanus etc.) below with role label. */}
              <span style={{
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                <span style={{
                  display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
                }}>
                  {g.primaryTags.map((t) => (
                    <span key={t} style={{
                      padding: '0 7px',
                      border: '1px solid var(--accent)',
                      borderRadius: 10,
                      background: 'var(--bg-secondary)',
                      fontWeight: 600,
                      color: 'var(--accent)',
                    }}>{t}</span>
                  ))}
                </span>
                {Object.entries(g.secondaryTags).map(([role, tags]) => (
                  <span key={role} style={{
                    display: 'flex', flexWrap: 'wrap', gap: 4,
                    alignItems: 'center', fontSize: 'var(--font-size-xs)',
                  }}>
                    <span style={{
                      color: 'var(--text-muted)', fontStyle: 'italic',
                    }}>
                      + secondary ({roleLabel(g.analysisType, g.subtype, role)}):
                    </span>
                    {tags.map((t) => (
                      <span key={t} style={{
                        padding: '0 6px',
                        border: '1px dashed var(--accent)',
                        borderRadius: 10,
                        color: 'var(--accent)',
                      }}>{t}</span>
                    ))}
                  </span>
                ))}
              </span>
              {/* Right: source key + channel */}
              <span style={{
                textAlign: 'right',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--font-size-xs)',
              }}>
                {displayGroupSeries(g.sourceKey)}
                {g.channel != null ? ` · ch ${g.channel + 1}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
      )}

      {warnings.length > 0 && (
        <div style={{
          padding: '8px 10px',
          border: '1px solid color-mix(in oklab, var(--warning) 50%, transparent)',
          borderRadius: 'var(--radius-md)',
          background: 'color-mix(in oklab, var(--warning) 8%, transparent)',
          fontSize: 'var(--font-size-label)',
        }}>
          <div style={{
            fontWeight: 600, marginBottom: 4, color: 'var(--warning)',
          }}>
            ⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <div style={{
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Next step: pick a target folder. Files matching at least one
        recipe tag will be selectable for batch processing.
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Target folder + per-file recipe-match table.
// ---------------------------------------------------------------------------

/** Open the Metadata (Tags) window focused on a specific file path.
 *  Two-pronged delivery so we cover both "window already open" and
 *  "window opens fresh after this call":
 *    1. Stash the focus target in Electron prefs (one-shot — the
 *       metadata window reads + clears on mount).
 *    2. Broadcast a ``metadata-focus-file`` message for the live case.
 *  Then call ``openAnalysisWindow('metadata')`` which is a no-op if
 *  the window is already up. */
async function openTagsForFile(filePath: string) {
  const api = window.electronAPI
  if (!api) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    await api.setPreferences({ ...prefs, metadataFocusPath: filePath })
  } catch { /* fall through — broadcast still works for open windows */ }
  try {
    const ch = new BroadcastChannel('tracer-sync')
    ch.postMessage({ type: 'metadata-focus-file', file_path: filePath })
    ch.close()
  } catch { /* ignore */ }
  if (api.openAnalysisWindow) {
    await api.openAnalysisWindow('metadata')
  }
}

function TargetSection({
  recipes, targetFolder, targetEntries, targetLoading, targetError,
  matches, effectiveSelected, toggleSelection,
  overwriteAll, setOverwriteAll,
  pickTargetFolder, rescan,
  onSelectAllMatched, onSelectNone, onResetDefaults,
}: {
  recipes: BatchRecipe[]
  targetFolder: string | null
  targetEntries: TargetEntry[]
  targetLoading: boolean
  targetError: string | null
  matches: Record<string, Record<string, RecipeMatch>>
  effectiveSelected: (filePath: string, rId: string) => boolean
  toggleSelection: (filePath: string, rId: string) => void
  overwriteAll: boolean
  setOverwriteAll: React.Dispatch<React.SetStateAction<boolean>>
  pickTargetFolder: () => Promise<void>
  rescan: () => void
  onSelectAllMatched: () => void
  onSelectNone: () => void
  onResetDefaults: () => void
}) {
  // Recipe-column ordering: keep template order so the user reads the
  // table left-to-right consistent with how recipes were derived.
  const recipeCols = recipes
  const fullyMatchedCount = useMemo(() => {
    let n = 0
    for (const ent of targetEntries) {
      const any = recipeCols.some((r) => matches[ent.filePath]?.[recipeId(r)]?.matched)
      if (any) n++
    }
    return n
  }, [targetEntries, recipeCols, matches])

  return (
    <div style={{
      borderTop: '1px solid var(--border)',
      paddingTop: 14,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 8,
      }}>
        <span style={{ fontWeight: 600 }}>Target folder:</span>
        <span style={{
          flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: targetFolder ? 'var(--text-primary)' : 'var(--text-muted)',
        }} title={targetFolder ?? undefined}>
          {targetFolder ?? 'No folder selected'}
        </span>
        {targetFolder && (
          <button className="btn" onClick={rescan}
            title="Re-scan the folder for sidecar updates">
            Rescan
          </button>
        )}
        <button className="btn btn-primary" onClick={pickTargetFolder}>
          {targetFolder ? 'Change folder…' : 'Pick folder…'}
        </button>
      </div>

      {targetError && (
        <div className="notice notice-error" style={{ marginBottom: 8 }}>⚠ {targetError}</div>
      )}

      {targetLoading ? (
        <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Scanning folder…
        </div>
      ) : !targetFolder ? (
        <div style={{
          color: 'var(--text-muted)', fontStyle: 'italic',
          fontSize: 'var(--font-size-label)',
          padding: '12px 0',
        }}>
          Pick a folder of recordings to apply the template's recipes
          across. Files need at least one series-level tag matching a
          recipe to be runnable — open Tags… on a target file to add
          tags.
        </div>
      ) : targetEntries.length === 0 ? (
        <div style={{ color: 'var(--text-muted)' }}>
          No recordings found in this folder.
        </div>
      ) : (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            flexWrap: 'wrap',
            marginBottom: 8, fontSize: 'var(--font-size-label)',
          }}>
            <span style={{ color: 'var(--text-muted)' }}>
              {targetEntries.length} file{targetEntries.length === 1 ? '' : 's'} ·{' '}
              {fullyMatchedCount} matchable
            </span>
            {/* Bulk select — overrides the default-checked-when-matched
                logic with explicit user choice. ``Reset`` drops all
                manual overrides so cells fall back to the default
                (matched + no existing results → on). */}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              borderLeft: '1px solid var(--border)', paddingLeft: 12,
            }}>
              <span style={{ color: 'var(--text-muted)' }}>Select:</span>
              <button className="btn"
                onClick={onSelectAllMatched}
                title="Check every cell where the recipe matches at least one series in the file">
                All matched
              </button>
              <button className="btn"
                onClick={onSelectNone}
                title="Uncheck every cell">
                None
              </button>
              <button className="btn"
                onClick={onResetDefaults}
                title="Drop manual overrides and use the default (matched + no existing results → on)">
                Reset
              </button>
            </span>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }} title="Re-run analyses on files that already have results in their sidecar (otherwise those cells default to off).">
              <input type="checkbox" checked={overwriteAll}
                onChange={(e) => setOverwriteAll(e.target.checked)} />
              <span>Overwrite existing results</span>
            </label>
          </div>

          <div style={{
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-field)',
            overflow: 'auto',
            maxHeight: 480,
          }}>
            <table style={{
              borderCollapse: 'collapse', width: '100%',
              fontSize: 'var(--font-size-label)',
              fontFamily: 'var(--font-ui)',
            }}>
              <thead>
                <tr style={{
                  background: 'var(--bg-secondary)',
                  position: 'sticky', top: 0, zIndex: 1,
                }}>
                  <th style={{
                    ...thStyle, textAlign: 'left',
                    minWidth: 220,
                  }}>File</th>
                  <th style={{ ...thStyle, textAlign: 'left', minWidth: 140 }}>
                    Series tags
                  </th>
                  {recipeCols.map((r) => (
                    <th key={recipeId(r)} style={{
                      ...thStyle, textAlign: 'center',
                      minWidth: 160,
                    }} title={`${r.analysisType}${r.subtype ? ` [${r.subtype}]` : ''} on series tagged "${r.tag}"`}>
                      <div style={{ fontWeight: 600 }}>
                        {ANALYSIS_LABELS[r.analysisType] ?? r.analysisType}
                        {r.subtype && (
                          <span style={{
                            marginLeft: 4,
                            padding: '0 5px',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            background: 'var(--bg-primary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 500,
                            color: 'var(--text-muted)',
                          }}>{r.subtype}</span>
                        )}
                      </div>
                      <div style={{
                        marginTop: 2,
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--accent)',
                      }}>
                        {r.tag}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {targetEntries.map((ent) => {
                  const perRecipe = matches[ent.filePath] ?? {}
                  const hasAnyMatch = recipeCols.some((r) =>
                    perRecipe[recipeId(r)]?.matched)
                  // Show the inline "Tag…" affordance whenever the
                  // user can't run anything on this file as-is. Three
                  // overlapping cases all collapse to "open Tags…":
                  // no sidecar, no series-level tags, OR no recipe
                  // matched any tagged series.
                  const needsTagging = !ent.hasSidecar
                    || Object.keys(ent.seriesTags).length === 0
                    || !hasAnyMatch
                  return (
                    <tr key={ent.filePath} style={{
                      borderTop: '1px solid var(--border-subtle)',
                      opacity: hasAnyMatch ? 1 : 0.5,
                    }}>
                      <td style={tdStyle} title={ent.filePath}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          <span>
                            {ent.fileName}
                          </span>
                          {!ent.hasSidecar && (
                            <span style={{
                              color: 'var(--error)',
                              fontSize: 'var(--font-size-xs)',
                            }}>· no sidecar</span>
                          )}
                          {needsTagging && (
                            <button className="btn btn-sm"
                              onClick={() => void openTagsForFile(ent.filePath)}
                              style={{ marginLeft: 'auto' }}
                              title="Open this file in the Tags window so you can tag its series, then come back and rescan.">
                              Tag…
                            </button>
                          )}
                        </div>
                        {ent.fileTags.length > 0 && (
                          <div style={{
                            marginTop: 2,
                            display: 'flex', flexWrap: 'wrap', gap: 3,
                          }}>
                            {ent.fileTags.map((t) => (
                              <span key={t} style={{
                                padding: '0 5px',
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                background: 'var(--bg-secondary)',
                                fontSize: 'var(--font-size-xs)',
                              }}>{t}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {Object.keys(ent.seriesTags).length === 0 ? (
                          <span style={{
                            color: 'var(--text-muted)', fontStyle: 'italic',
                          }}>
                            untagged
                          </span>
                        ) : (
                          <div style={{
                            display: 'flex', flexDirection: 'column', gap: 1,
                            fontSize: 'var(--font-size-xs)',
                          }}>
                            {Object.entries(ent.seriesTags)
                              .sort(([a], [b]) => a.localeCompare(b))
                              .map(([k, ts]) => (
                                <div key={k}>
                                  <span className="num" style={{
                                    color: 'var(--text-muted)',
                                  }}>{displayGroupSeries(k)}</span>
                                  : {ts.join(', ')}
                                </div>
                              ))}
                          </div>
                        )}
                      </td>
                      {recipeCols.map((r) => {
                        const rId = recipeId(r)
                        const m = perRecipe[rId]
                        return (
                          <td key={rId} style={{
                            ...tdStyle, textAlign: 'center',
                            verticalAlign: 'top',
                          }}>
                            <RecipeCell
                              filePath={ent.filePath}
                              recipe={r}
                              match={m}
                              checked={effectiveSelected(ent.filePath, rId)}
                              overwriteAll={overwriteAll}
                              onToggle={() => toggleSelection(ent.filePath, rId)}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function RecipeCell({
  recipe, match, checked, overwriteAll, onToggle,
}: {
  filePath: string
  recipe: BatchRecipe
  match: RecipeMatch | undefined
  checked: boolean
  overwriteAll: boolean
  onToggle: () => void
}) {
  if (!match || !match.matched) {
    return (
      <span style={{
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-xs)',
      }}>
        no match
      </span>
    )
  }
  const exists = match.alreadyHasResults
  const showOverwriteHint = exists && !overwriteAll && !checked
  return (
    <label style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
      gap: 2,
    }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)',
      }}>
        {match.primary.map(displayGroupSeries).join(', ')}
        {Object.entries(match.secondary).map(([role, hits]) => (
          <span key={role}> + {hits.map(displayGroupSeries).join(', ')}</span>
        ))}
      </span>
      {exists && (
        <span style={{
          fontSize: 'var(--font-size-xs)',
          color: showOverwriteHint ? 'var(--warning)' : 'var(--text-muted)',
          fontStyle: 'italic',
        }} title={recipe.analysisType + ' results already exist for this series'}>
          {showOverwriteHint ? 'has results · skip' : 'overwrite'}
        </span>
      )}
    </label>
  )
}

const thStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  textAlign: 'center',
  fontWeight: 500,
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
}

const tdStyle: React.CSSProperties = {
  padding: '6px 10px',
  verticalAlign: 'middle',
  fontFamily: 'var(--font-ui)',
}

// ---------------------------------------------------------------------------
// RUN bar — pinned under the template/folder pickers. RUN button doubles
// as the overall progress indicator; cancel button lets users soft-stop.
// ---------------------------------------------------------------------------

/** Tooltip copy for the RUN button — drove the disabled-state mystery
 *  during testing (button greyed out with no explanation). Branched
 *  out of an inline ternary chain that was hard to read. */
function runButtonTitle(canRun: boolean, conflictCount: number): string {
  if (canRun) return 'Run all selected recipes across the target files'
  if (conflictCount > 0) {
    return `${conflictCount} multi-tag conflict${conflictCount === 1 ? '' : 's'} — resolve below before running`
  }
  return 'Pick a template + folder + at least one recipe to run'
}

function RunBar({
  running, runDone, canRun, totalSelected,
  conflictCount,
  currentFileIdx, filesPlanned, currentFileName, currentFileFraction,
  onRun, onCancel, onOpenCohort,
}: {
  running: boolean
  runDone: boolean
  canRun: boolean
  totalSelected: number
  /** When > 0, RUN is force-disabled — the conflict panel below
   *  shows the user what to fix. Surfaced in the button title so
   *  the disabled state isn't mysterious. */
  conflictCount: number
  currentFileIdx: number
  filesPlanned: number
  currentFileName: string | null
  currentFileFraction: number
  onRun: () => void
  onCancel: () => void
  onOpenCohort: () => void
}) {
  // Total-progress fraction — files completed + within-file progress.
  // Clamped to [0, 1] so a stale state can't push the bar past full.
  const totalFrac = filesPlanned === 0
    ? 0
    : Math.max(0, Math.min(1,
        (currentFileIdx + currentFileFraction) / filesPlanned))
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-primary)',
      flexShrink: 0,
    }}>
      <button
        className="btn btn-primary btn-lg"
        onClick={onRun}
        disabled={!canRun || running}
        style={{
          minWidth: 120,
          position: 'relative', overflow: 'hidden',
        }}
        title={runButtonTitle(canRun, conflictCount)}>
        {/* Progress overlay — covers the button left-to-right by
            ``totalFrac``. Sits BEHIND the label via z-index. */}
        {running && (
          <span style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${totalFrac * 100}%`,
            background: 'color-mix(in oklab, var(--on-accent) 25%, transparent)',
            transition: 'width 120ms linear',
            pointerEvents: 'none',
          }} />
        )}
        <span style={{ position: 'relative', zIndex: 1 }}>
          {running
            ? `Running… ${Math.round(totalFrac * 100)}%`
            : runDone
              ? `Run again (${totalSelected})`
              : `Run ${totalSelected} task${totalSelected === 1 ? '' : 's'}`}
        </span>
      </button>
      {running && (
        <button className="btn btn-lg" onClick={onCancel}
          title="Stop after the current file finishes">
          Cancel
        </button>
      )}
      <span style={{
        flex: 1, color: 'var(--text-muted)',
        fontSize: 'var(--font-size-label)',
        fontFamily: 'var(--font-mono)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {running && currentFileName
          ? `${currentFileIdx + 1} / ${filesPlanned} — ${currentFileName} (${Math.round(currentFileFraction * 100)}%)`
          : runDone
            ? 'Done — review the log below.'
            : ''}
      </span>
      {runDone && (
        <button className="btn btn-lg" onClick={onOpenCohort}
          title="Aggregate the freshly-written results in the cohort window">
          Open in Cohort…
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Run log — per-file results + skips + errors. Grouped by file so a
// 30-file batch with 3 recipes each doesn't drown the user in 90 rows.
// ---------------------------------------------------------------------------

function RunLogPanel({ entries }: { entries: RunLogEntry[] }) {
  const byFile = useMemo(() => {
    const m = new Map<string, { fileName: string; lines: RunLogEntry[] }>()
    for (const e of entries) {
      const cur = m.get(e.filePath)
      if (cur) cur.lines.push(e)
      else m.set(e.filePath, { fileName: e.fileName, lines: [e] })
    }
    return Array.from(m.entries())
  }, [entries])
  const totals = useMemo(() => {
    let ok = 0, err = 0, skip = 0
    for (const e of entries) {
      if (e.level === 'ok') ok++
      else if (e.level === 'error') err++
      else skip++
    }
    return { ok, err, skip }
  }, [entries])
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      padding: '8px 12px',
      background: 'var(--bg-secondary)',
      fontSize: 'var(--font-size-label)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 6, fontWeight: 600,
      }}>
        Run log
        <span style={{ color: 'var(--success)' }}>{totals.ok} ok</span>
        {totals.err > 0 && <span style={{ color: 'var(--error)' }}>· {totals.err} error</span>}
        {totals.skip > 0 && <span style={{ color: 'var(--warning)' }}>· {totals.skip} skipped</span>}
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        maxHeight: 320, overflow: 'auto',
      }}>
        {byFile.map(([fp, { fileName, lines }]) => (
          <div key={fp} style={{
            paddingTop: 4, borderTop: '1px solid var(--border-subtle)',
          }}>
            <div style={{
              color: 'var(--text-muted)',
            }} title={fp}>{fileName}</div>
            <ul style={{ margin: '2px 0 4px 0', paddingLeft: 16 }}>
              {lines.map((l, i) => (
                <li key={i} style={{
                  color: l.level === 'error' ? 'var(--error)'
                       : l.level === 'skip' ? 'var(--warning)'
                       : 'var(--text-primary)',
                }}>{l.message}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pre-run confirmation modal — gates the batch loop behind an explicit
// user OK so default-checked rows can't run by surprise. Also closes
// the active recording first so other open analysis windows don't race
// with the loop.
// ---------------------------------------------------------------------------

function ConfirmRunModal({
  totalTasks, totalFiles, activeRecordingName,
  onConfirm, onCancel,
}: {
  totalTasks: number
  totalFiles: number
  activeRecordingName: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onCancel}>
      <div style={{
        background: 'var(--bg-primary)',
        borderRadius: 'var(--radius-lg)',
        padding: '18px 22px',
        maxWidth: 480, width: '90%',
        boxShadow: 'var(--shadow-popover)',
        fontSize: 'var(--font-size-base)',
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{
          fontSize: 'var(--font-size-lg)', fontWeight: 600,
          marginBottom: 10,
        }}>
          Run batch analysis?
        </div>
        <div style={{ marginBottom: 12, lineHeight: 1.5 }}>
          About to run <strong>{totalTasks}</strong> task{totalTasks === 1 ? '' : 's'}
          {' '}across <strong>{totalFiles}</strong> file{totalFiles === 1 ? '' : 's'}.
        </div>
        {activeRecordingName && (
          <div style={{
            marginBottom: 12,
            padding: '8px 10px',
            border: '1px solid color-mix(in oklab, var(--warning) 50%, transparent)',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in oklab, var(--warning) 8%, transparent)',
            fontSize: 'var(--font-size-label)',
            lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--warning)' }}>
              {activeRecordingName} is currently open.
            </strong>{' '}
            It will be closed before the batch starts so other open
            analysis windows don't display transient state, and to
            avoid surprise inclusion if it lives in the target folder.
            Any unsaved curation in other windows will be lost — close
            this dialog and save first if needed.
          </div>
        )}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          marginTop: 6,
        }}>
          <button className="btn btn-lg" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary btn-lg" onClick={onConfirm}
            autoFocus>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Multi-tag conflict panel — surfaces target-file series that match
// multiple selected recipes. Blocks RUN until the user resolves so
// no series gets two competing runs (which would clobber each other
// in the sidecar). Resolution is either un-checking one recipe in
// the table for that file, or fixing the duplicate tag in the
// metadata window.
// ---------------------------------------------------------------------------

function ConflictPanel({
  conflicts,
}: {
  conflicts: Array<{
    filePath: string; fileName: string
    seriesKey: string
    recipes: BatchRecipe[]
  }>
}) {
  // Group conflicts by file so a single file with multiple bad
  // series shows once at the file level + each series listed under it.
  const byFile = useMemo(() => {
    const m = new Map<string, {
      fileName: string
      rows: Array<{ seriesKey: string; recipes: BatchRecipe[] }>
    }>()
    for (const c of conflicts) {
      const cur = m.get(c.filePath)
      if (cur) cur.rows.push({ seriesKey: c.seriesKey, recipes: c.recipes })
      else m.set(c.filePath, {
        fileName: c.fileName,
        rows: [{ seriesKey: c.seriesKey, recipes: c.recipes }],
      })
    }
    return Array.from(m.entries())
  }, [conflicts])
  return (
    <div style={{
      border: '1px solid color-mix(in oklab, var(--error) 55%, transparent)',
      borderRadius: 'var(--radius-md)',
      padding: '10px 14px',
      background: 'color-mix(in oklab, var(--error) 7%, transparent)',
      fontSize: 'var(--font-size-label)',
    }}>
      <div style={{
        fontWeight: 600, marginBottom: 6, color: 'var(--error)',
      }}>
        ⚠ {conflicts.length} multi-tag conflict{conflicts.length === 1 ? '' : 's'} — resolve before running
      </div>
      <div style={{ marginBottom: 8, lineHeight: 1.5 }}>
        The series below match more than one selected recipe in the
        template. Running both would write competing results to the
        same series. Either un-check one recipe for the affected file
        in the table above, or fix the duplicate tag in Tags…
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {byFile.map(([fp, { fileName, rows }]) => (
          <li key={fp} style={{ marginBottom: 4 }}>
            <span title={fp}>
              {fileName}
            </span>
            <ul style={{
              margin: '2px 0 4px 0', paddingLeft: 18,
              fontSize: 'var(--font-size-xs)',
            }}>
              {rows.map((r, i) => (
                <li key={i}>
                  series{' '}
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                  }}>{displayGroupSeries(r.seriesKey)}</span>
                  {' '}matches{' '}
                  {r.recipes.map((rc, j) => (
                    <span key={j} style={{
                      marginRight: 4,
                      padding: '0 5px',
                      border: '1px solid var(--accent)',
                      borderRadius: 8,
                      color: 'var(--accent)',
                    }}>{ANALYSIS_LABELS[rc.analysisType] ?? rc.analysisType}{rc.subtype ? ` [${rc.subtype}]` : ''} · {rc.tag}</span>
                  ))}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}
