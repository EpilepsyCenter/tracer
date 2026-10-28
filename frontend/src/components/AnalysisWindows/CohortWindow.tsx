import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useThemeStore } from '../../stores/themeStore'
import { usePlotMenu } from '../common/PlotMenu'
import { displayGroupSeries } from '../../utils/groupSeriesKey'

/**
 * Cohort Analysis window — Phases B.2 + B.3.
 *
 * Top toolbar: folder + analysis-type pickers + Aggregate button.
 *
 * After aggregation lands, the body splits into a sticky-left
 * **wizard column** (Phase B.3) and the **preview pane** on the right.
 *
 * Wizard columns walk the user through the comparison setup:
 *   1. Comparison shape — Within recordings / Between groups
 *   2. Tags to compare — multi-select from the union of tags
 *      present in the aggregated cells (file-level tags for
 *      "between", series-level for "within")
 *   3. Optional filter — narrow the universe of contributing
 *      cells (e.g. limit to "male" + "P30" before picking genotype)
 *   4. What is N? — sweep / series / cell / animal; explicit so
 *      the user can't accidentally pseudoreplicate
 *   5. Design preview — shows the inferred design name, per-group
 *      n, and the test that will run (Pingouin in B.4); user
 *      confirms before stats happen
 *
 * Later phases bolt on:
 *   - B.4: Pingouin stats runner (the "Run stats" button below the
 *     design preview)
 *   - B.5: metric tree + per-cell subsampling controls
 *   - B.6: graph panel (dot plots + ECDF / time-series overlays)
 *   - B.7: stats table panel
 *   - B.8: export (Prism / Excel / _cells.xlsx)
 *   - B.9: .tracer_cohort session save/load
 */

interface AnalysesIndex {
  analyses: string[]
  default_metrics: Record<string, { scalars: string[]; distributions: string[] }>
}

interface SkippedFile {
  file_path: string
  file_name?: string
}

interface AggregateError {
  file_path: string
  series_key?: string
  reason: string
}

interface Cell {
  file_path: string
  file_name: string
  cell_id: string | null
  animal_id: string | null
  group_tags: string[]
  series_tags: Record<string, string[]>
  series_key: string
  series_specific_tags: string[]
  scalars: Record<string, number | null>
  distributions: Record<string, number[]>
  meta: Record<string, unknown>
}

interface AggregateResponse {
  analysis_type: string
  folder: string
  cells: Cell[]
  errors: AggregateError[]
  skipped_no_meta: SkippedFile[]
  skipped_no_analysis: SkippedFile[]
  summary: {
    n_cells: number
    n_files_scanned: number
    n_files_filtered_out: number
  }
}

// Display names for the analysis-type dropdown. Sourced server-side
// would be cleaner long-term, but this list rarely changes and the
// display strings are UI concerns the backend doesn't need to ship.
const ANALYSIS_LABELS: Record<string, string> = {
  events: 'Events (spontaneous PSCs / minis)',
  ap: 'Action Potentials',
  ap_spont: 'Action Potentials — spontaneous',
  iv_curves: 'I-V Curve',
  bursts: 'Bursts',
  cursors: 'Cursor Measurements',
  paired: 'Paired Recording',
  fpsp_io: 'fPSP — Input-Output',
  fpsp_ppr: 'fPSP — Paired-Pulse Ratio',
  fpsp_ltp: 'fPSP — LTP / LTD',
  resistance: 'Resistance (Rs / Rin / Cm)',
}

// ---------------------------------------------------------------------
// Wizard (B.3) — comparison shape + tag picker + design preview
// ---------------------------------------------------------------------

type ComparisonShape = 'within' | 'between'
type NUnit = 'cell' | 'series' | 'sweep' | 'animal'

/** Manual stats-test override. ``auto`` runs Shapiro-Wilk per group
 *  and picks the parametric or non-parametric branch; the explicit
 *  overrides skip the normality check entirely and force the chosen
 *  branch. Useful when:
 *    - the user knows the data shape (e.g. bounded latencies that
 *      are never normal → always Wilcoxon)
 *    - the paper / pre-registration committed to a specific test
 *    - small N where Shapiro-Wilk is unreliable */
type TestOverride = 'auto' | 'parametric' | 'nonparametric'

const N_UNIT_LABELS: Record<NUnit, string> = {
  cell: 'cell (one number per recording)',
  series: 'series (one number per series)',
  sweep: 'sweep (one number per sweep — pseudoreplication risk)',
  animal: 'animal (collapse cells from same animal)',
}

interface DesignInfo {
  name: string
  test_normal: string
  test_nonparam: string
  /** The test that will actually run given the override. ``null``
   *  when override is ``auto`` — the runner decides at execution
   *  time after Shapiro-Wilk on each group. */
  test_chosen: string | null
  /** Per-group cell counts after the filter + tag selection. */
  groups: { tag: string; n: number; cells: Cell[] }[]
  /** Cells that pass the filter but don't fit any selected tag —
   *  surfaced so the user can see exactly what's being dropped. */
  unassigned: Cell[]
  /** Cells that have no ``animal_id`` set when ``nUnit='animal'``
   *  is selected. Surfaced separately from ``unassigned`` because
   *  the fix is "go tag the file in the metadata window", not
   *  "pick a different tag here". Empty for other N units. */
  missingAnimalId: Cell[]
  /** True when there's no assignment ambiguity within the chosen
   *  shape — drives the "Run stats" button enabled state in B.4. */
  ready: boolean
  /** Plain-English explanation of what was inferred. */
  why: string
}

/** Pull every distinct file-level tag (group_tags) seen across cells. */
function collectFileTags(cells: Cell[]): string[] {
  const set = new Set<string>()
  for (const c of cells) for (const t of c.group_tags) set.add(t)
  return Array.from(set).sort()
}

/** Pull every distinct series-level tag (series_tags values, flattened)
 *  across cells. Used as the "Within recordings" tag pool — these are
 *  the per-condition labels users put on individual series. */
function collectSeriesTags(cells: Cell[]): string[] {
  const set = new Set<string>()
  for (const c of cells) {
    for (const tags of Object.values(c.series_tags ?? {})) {
      for (const t of tags) set.add(t)
    }
  }
  return Array.from(set).sort()
}

/** Apply a free-text filter: row must carry ALL filter tags in its
 *  file-level tags. AND across filter tags. Empty filter = pass
 *  everything. Operates on raw (file, series) rows; collapsing to
 *  per-file unique rows happens later in the grouping helpers. */
function applyFilter(cells: Cell[], filterTags: string[]): Cell[] {
  if (filterTags.length === 0) return cells
  const need = filterTags.map((t) => t.toLowerCase())
  return cells.filter((c) => {
    const have = new Set(c.group_tags.map((t) => t.toLowerCase()))
    return need.every((t) => have.has(t))
  })
}

/** Collapse multiple (file, series) rows for the same file into one
 *  representative row. The aggregator returns one row per analyzed
 *  series — but the cohort N is "cells" (= unique files) by default,
 *  not series. Without this collapse, a file with 3 analyzed series
 *  was counted three times. The first row's metadata stands in for
 *  the file (group_tags + cell_id + series_tags map are identical
 *  across siblings; only ``series_key`` / ``series_specific_tags``
 *  differ — the wizard treats the file as one entry regardless). */
function uniqueByFile(cells: Cell[]): Cell[] {
  const byFile = new Map<string, Cell>()
  for (const c of cells) {
    if (!byFile.has(c.file_path)) byFile.set(c.file_path, c)
  }
  return Array.from(byFile.values())
}

/** Collapse cells to one representative per ``animal_id`` (used when
 *  ``nUnit === 'animal'``). Cells with no animal_id are kept as
 *  separate "anonymous animal" entries — surfaced as a warning so
 *  the user knows their grouping is incomplete. The representative's
 *  group_tags + series_tags are taken from the first cell of that
 *  animal; if siblings disagree (e.g. one cell tagged WT and another
 *  KO under the same animal_id) the user has bigger problems but we
 *  don't try to detect that here. */
function uniqueByAnimal(cells: Cell[]): { animals: Cell[]; missingAnimalId: Cell[] } {
  const byFile = uniqueByFile(cells)
  const byAnimal = new Map<string, Cell>()
  const missingAnimalId: Cell[] = []
  for (const c of byFile) {
    const aid = (c.animal_id ?? '').trim()
    if (!aid) {
      // Cell with no animal_id — can't be grouped; show as separate
      // problem in the warning band.
      missingAnimalId.push(c)
      continue
    }
    if (!byAnimal.has(aid)) byAnimal.set(aid, c)
  }
  return { animals: Array.from(byAnimal.values()), missingAnimalId }
}

/** N=series variant: each (file, series) row is its own datapoint.
 *  Use case: comparing "all baseline-tagged series across all files"
 *  vs "all TTX-tagged series" without collapsing to per-cell means.
 *  Pseudoreplication-prone; we surface the warning in N-unit hint. */
function groupBetweenPerSeries(cells: Cell[], selectedTags: string[]) {
  const groups: { tag: string; n: number; cells: Cell[] }[] =
    selectedTags.map((t) => ({ tag: t, n: 0, cells: [] }))
  const unassigned: Cell[] = []
  for (const c of cells) {
    // Match either file-level (group) tags or this row's series-
    // specific tag — between-mode at series granularity is rare;
    // most users will pick within-mode + N=series instead. Still
    // honour the file-level pool to keep the UX consistent.
    const candidates = new Set(
      [...c.group_tags, ...c.series_specific_tags].map((t) => t.toLowerCase())
    )
    const hits = selectedTags.filter((t) => candidates.has(t.toLowerCase()))
    if (hits.length === 1) {
      const g = groups.find((g) => g.tag === hits[0])!
      g.cells.push(c)
      g.n += 1
    } else {
      unassigned.push(c)
    }
  }
  return { groups, unassigned }
}

/** N=series, within-mode variant: each (file, series) row whose
 *  per-series tag matches one of the selected tags becomes a
 *  datapoint. Different cells contribute different counts depending
 *  on how many series carried each condition tag. */
function groupWithinPerSeries(cells: Cell[], selectedTags: string[]) {
  const groups: { tag: string; n: number; cells: Cell[] }[] =
    selectedTags.map((t) => ({ tag: t, n: 0, cells: [] }))
  const unassigned: Cell[] = []
  for (const c of cells) {
    const seriesTagsLc = c.series_specific_tags.map((t) => t.toLowerCase())
    const hits = selectedTags.filter((t) => seriesTagsLc.includes(t.toLowerCase()))
    if (hits.length === 1) {
      const g = groups.find((g) => g.tag === hits[0])!
      g.cells.push(c)
      g.n += 1
    } else {
      unassigned.push(c)
    }
  }
  return { groups, unassigned }
}

/** Group cells by selected file-level tags (between mode). Each
 *  unique FILE belongs to AT MOST one group — if it carries
 *  multiple selected tags, it goes to ``unassigned`` (ambiguous).
 *  Operates on per-file unique rows so multi-series files don't
 *  inflate N (the original bug: 4 files × 3 series = N of 12
 *  instead of N of 4).
 *
 *  ``seriesRole`` (optional) filters cells out when the file
 *  doesn't have any series carrying that role tag — without it the
 *  cohort would silently use whichever series came first in the
 *  aggregator, picking different roles per cell.
 */
function groupBetween(cells: Cell[], selectedTags: string[], seriesRole: string) {
  const groups: { tag: string; n: number; cells: Cell[] }[] =
    selectedTags.map((t) => ({ tag: t, n: 0, cells: [] }))
  const unassigned: Cell[] = []
  // Build a per-file lookup of all series-tag sets so the
  // role-presence check works on the file as a whole, even though
  // the row we keep is just the first series.
  const fileSeriesTags = new Map<string, Set<string>>()
  for (const c of cells) {
    if (!fileSeriesTags.has(c.file_path)) {
      const s = new Set<string>()
      for (const tags of Object.values(c.series_tags ?? {})) {
        for (const t of tags) s.add(t.toLowerCase())
      }
      fileSeriesTags.set(c.file_path, s)
    }
  }
  for (const c of uniqueByFile(cells)) {
    // Role gate: when the user picked a specific series role, files
    // without any series tagged with that role can't contribute and
    // surface in the unassigned list with a clear reason.
    if (seriesRole) {
      const present = fileSeriesTags.get(c.file_path) ?? new Set()
      if (!present.has(seriesRole.toLowerCase())) {
        unassigned.push(c)
        continue
      }
    }
    const hits = selectedTags.filter((t) =>
      c.group_tags.map((g) => g.toLowerCase()).includes(t.toLowerCase()))
    if (hits.length === 1) {
      const g = groups.find((g) => g.tag === hits[0])!
      g.cells.push(c)
      g.n += 1
    } else {
      unassigned.push(c)
    }
  }
  return { groups, unassigned }
}

/** Group cells by selected series-level tags (within mode). For a
 *  paired / RM design every FILE needs to contribute ONE value per
 *  selected condition tag — so files missing any selected tag in
 *  their series_tags go to ``unassigned``. Operates on per-file
 *  unique rows so a file with 3 analyzed series doesn't get
 *  triple-counted (the original bug). */
function groupWithin(cells: Cell[], selectedTags: string[]) {
  const groups: { tag: string; n: number; cells: Cell[] }[] =
    selectedTags.map((t) => ({ tag: t, n: 0, cells: [] }))
  const unassigned: Cell[] = []
  for (const c of uniqueByFile(cells)) {
    const cellSeriesTagsLc = new Set<string>()
    for (const tags of Object.values(c.series_tags ?? {})) {
      for (const t of tags) cellSeriesTagsLc.add(t.toLowerCase())
    }
    const hasAll = selectedTags.every((t) => cellSeriesTagsLc.has(t.toLowerCase()))
    if (hasAll) {
      for (const g of groups) {
        g.cells.push(c)
        g.n += 1
      }
    } else {
      unassigned.push(c)
    }
  }
  return { groups, unassigned }
}

/** Mean of one scalar metric across a set of (file, series) rows.
 *  Used by the B.4 stats runner's value extractor to reduce a
 *  multi-series file to a single per-file number when the user
 *  hasn't pinned a series role. ``null`` when no row has a
 *  numeric value for the metric. */
function _meanScalar(rows: Cell[], metric: string): number | null {
  const vals: number[] = []
  for (const r of rows) {
    const v = r.scalars?.[metric]
    if (v == null || Number.isNaN(v)) continue
    vals.push(Number(v))
  }
  if (vals.length === 0) return null
  return vals.reduce((s, x) => s + x, 0) / vals.length
}

// ---------------------------------------------------------------------
// Per-cell event subsampling — used by both the cohort modal's
// distribution graphs and the export payload. Five modes match what
// the modal's "Events per cell" picker exposes; 'auto' equalises N
// to the smallest in-scope cell so cells with many events don't
// dominate group means / pooled distributions.
// ---------------------------------------------------------------------

type SubsampleMode = 'all' | 'first' | 'last' | 'random' | 'auto'

/** Mulberry32 — small deterministic PRNG, seeded by a string hash.
 *  Lets ``random`` mode produce a stable sample across re-renders so
 *  the user's chart and the user's export agree. We don't reach for
 *  Math.random() because it's globally non-deterministic — repeated
 *  renders would shuffle differently and the export would diverge
 *  from what was on screen. */
function _seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  }
  let s = h >>> 0
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296
    const j = Math.floor(r * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** Apply the user's subsample mode to one cell's distribution
 *  array. ``autoN`` is the cohort-wide minimum count (computed
 *  separately so caller can scope it to "min across all in-scope
 *  cells for this metric") and is only consulted when mode='auto'.
 *  ``seed`` makes 'random' deterministic per (cell, metric). */
function applySubsample(
  arr: number[],
  mode: SubsampleMode,
  n: number,
  autoN: number,
  seed: string,
): number[] {
  if (mode === 'all' || arr.length === 0) return arr
  let target: number
  if (mode === 'auto') {
    target = Math.max(1, autoN)
  } else {
    target = Math.max(1, n | 0)
  }
  if (target >= arr.length) return arr  // can't take more than we have
  if (mode === 'first') return arr.slice(0, target)
  if (mode === 'last') return arr.slice(arr.length - target)
  if (mode === 'random') return _seededShuffle(arr, seed).slice(0, target)
  return arr
}

/** Compute the auto-N (min count across all in-scope cells for one
 *  distribution metric). Cells with zero events are excluded — they
 *  don't contribute to the comparison anyway and would force N=0
 *  which would discard everything. */
function computeAutoN(designGroups: { cells: Cell[] }[], metric: string,
                      seriesRole: string, comparisonShape: string): number {
  let minN = Infinity
  for (const g of designGroups) {
    for (const c of g.cells) {
      const arr = c.distributions?.[metric]
      if (Array.isArray(arr) && arr.length > 0) {
        if (arr.length < minN) minN = arr.length
      }
    }
  }
  return Number.isFinite(minN) ? minN : 0
}


/** Compute the design info from the wizard state. */
function inferDesign(
  cells: Cell[],
  shape: ComparisonShape,
  selectedTags: string[],
  filterTags: string[],
  nUnit: NUnit,
  seriesRole: string,
  testOverride: TestOverride,
): DesignInfo {
  const filtered = applyFilter(cells, filterTags)
  if (selectedTags.length < 2) {
    return {
      name: '—',
      test_normal: '—',
      test_nonparam: '—',
      test_chosen: null,
      groups: selectedTags.map((t) => ({ tag: t, n: 0, cells: [] })),
      unassigned: uniqueByFile(filtered),
      missingAnimalId: [],
      ready: false,
      why: 'Pick at least two tags to compare.',
    }
  }
  // Collapse rows to the right granularity BEFORE grouping:
  //   * N=series: keep all (file, series) rows
  //   * N=cell:   one row per file (uniqueByFile inside groupers)
  //   * N=animal: one row per animal_id; cells without animal_id
  //               surface as a separate warning band so the user
  //               knows which files to fix in the metadata window
  //   * N=sweep:  per-sweep rows aren't exposed yet → fall back to
  //               cell-level (Phase B follow-up).
  let groupingInput: Cell[]
  let missingAnimalId: Cell[] = []
  const groupedAtSeriesLevel = nUnit === 'series'
  if (nUnit === 'animal') {
    const { animals, missingAnimalId: missing } = uniqueByAnimal(filtered)
    groupingInput = animals
    missingAnimalId = missing
  } else {
    // groupBetween/groupWithin handle uniqueByFile internally for
    // N=cell; for N=series we want raw rows; either way, pass the
    // filtered list straight through.
    groupingInput = filtered
  }
  // When the grouping input is already pre-collapsed (animal), the
  // groupers' internal uniqueByFile is a no-op (each animal is its
  // own "file" by construction since they came from uniqueByFile
  // first). For N=series we route to the per-series variants.
  const { groups, unassigned } = groupedAtSeriesLevel
    ? (shape === 'within'
        ? groupWithinPerSeries(groupingInput, selectedTags)
        : groupBetweenPerSeries(groupingInput, selectedTags))
    : (shape === 'within'
        ? groupWithin(groupingInput, selectedTags)
        : groupBetween(groupingInput, selectedTags, seriesRole))

  const k = selectedTags.length
  let name: string
  let test_normal: string
  let test_nonparam: string
  let why: string

  if (shape === 'within') {
    if (k === 2) {
      name = 'Paired comparison (within recording)'
      test_normal = 'Paired t-test'
      test_nonparam = 'Wilcoxon signed-rank'
      why = 'Two conditions measured in the same cells → paired design.'
    } else {
      name = 'Repeated-measures ANOVA'
      test_normal = 'RM-ANOVA + post-hoc'
      test_nonparam = 'Friedman + post-hoc'
      why = '≥ 3 conditions in the same cells → repeated-measures.'
    }
  } else {
    if (k === 2) {
      name = 'Two-group comparison (between recordings)'
      test_normal = 'Unpaired t-test'
      test_nonparam = 'Mann-Whitney U'
      why = 'Two independent groups → unpaired comparison.'
    } else {
      name = 'Multi-group comparison (between recordings)'
      test_normal = 'One-way ANOVA + Tukey'
      test_nonparam = 'Kruskal-Wallis + Dunn'
      why = '≥ 3 independent groups → one-way design.'
    }
  }

  // Readiness: every group needs at least 2 cells for any meaningful
  // test; below that the assumption checks (Shapiro-Wilk, Levene)
  // can't even be computed. The user can still proceed to graphs but
  // we surface the warning so they're not surprised.
  const minN = Math.min(...groups.map((g) => g.n))
  const ready = minN >= 2

  // The test that will actually run depends on the override:
  //   ``auto`` → null (Shapiro-Wilk decides at runtime in B.4)
  //   ``parametric`` → the normal-theory test
  //   ``nonparametric`` → the rank-based test
  const test_chosen: string | null =
    testOverride === 'parametric' ? test_normal
    : testOverride === 'nonparametric' ? test_nonparam
    : null

  return {
    name, test_normal, test_nonparam, test_chosen,
    groups, unassigned, missingAnimalId, ready, why,
  }
}

export function CohortWindow({ backendUrl }: { backendUrl: string }) {
  const [folder, setFolder] = useState<string | null>(null)
  const [analyses, setAnalyses] = useState<AnalysesIndex | null>(null)
  const [analysisType, setAnalysisType] = useState<string>('events')
  const [aggResult, setAggResult] = useState<AggregateResponse | null>(null)
  const [aggLoading, setAggLoading] = useState(false)
  const [aggError, setAggError] = useState<string | null>(null)

  // ------------------------------------------------------------------
  // Wizard state (B.3) — comparison shape + tag selection + N choice.
  // Shape and N-unit persist across aggregations because they reflect
  // the user's experimental intent. Tag selections reset on every
  // re-aggregation since they're tied to the dataset that just landed.
  // ------------------------------------------------------------------
  const [comparisonShape, setComparisonShape] = useState<ComparisonShape>('between')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [nUnit, setNUnit] = useState<NUnit>('cell')
  // "Series role" — between-mode only. Tells the cohort which
  // series within each file contributes the metric value (e.g. for
  // a WT-vs-KO baseline comparison, set role to "baseline" so the
  // cohort reads each cell's baseline-tagged series, not whatever
  // series came first in the aggregator response). Empty string =
  // ``<any>`` = average across all series in the file. Per-metric
  // overrides land in B.5; this is the global default.
  const [seriesRole, setSeriesRole] = useState<string>('')
  const [testOverride, setTestOverride] = useState<TestOverride>('auto')
  // Distribution-metric test settings. ``pooled_ks`` is the textbook
  // mEPSC-style choice and the most common in the literature;
  // ``per_cell_ks_d`` avoids pseudoreplication; ``off`` disables the
  // distribution stats call entirely. ``andersonDarling`` only kicks
  // in for 3+ group designs under ``pooled_ks``. ``referenceTag`` is
  // the per_cell_ks_d reference; empty string = first group.
  type DistMode = 'pooled_ks' | 'per_cell_ks_d' | 'off'
  const [distMode, setDistMode] = useState<DistMode>('pooled_ks')
  const [distAndersonDarling, setDistAndersonDarling] = useState(false)
  const [distReferenceTag, setDistReferenceTag] = useState<string>('')

  // ------------------------------------------------------------------
  // Session file (.tracer_cohort) — Phase B.9
  // ------------------------------------------------------------------
  // ``sessionPath`` is the file the current state is associated with;
  // null for an untitled session. ``Save`` writes to that path,
  // ``Save As`` opens a dialog and updates the path, ``Open`` reads
  // a file and restores the entire wizard + selected metrics +
  // graph prefs + cached stats. Auto-save / prefs migration land in
  // a follow-up slice (next-session todo).
  const [sessionPath, setSessionPath] = useState<string | null>(null)
  const [sessionDirty, setSessionDirty] = useState(false)
  // ``sessionLoading`` defends against state thrash while a load is
  // restoring values — prevents downstream effects from clobbering
  // the loaded state with their reset-on-folder-change handlers.
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  // After applySession sets the wizard state and kicks off
  // aggregation, this flag tells the post-aggregate effect to
  // automatically re-run stats so the cards repopulate without the
  // user having to click ``Run stats``. Cleared once stats fire so
  // subsequent aggregations don't accidentally trigger.
  const [pendingSessionRunStats, setPendingSessionRunStats] = useState(false)
  // Ref (NOT state) used to suppress the reset-on-aggregate-change
  // effects below while a ``.tracer_cohort`` load is in flight.
  // ``sessionLoading`` (a state variable) can't do this reliably
  // because applySession's ``try/finally`` flips it back to false
  // synchronously, BEFORE the async ``runAggregate`` lands the new
  // ``aggResult``. A ref updates synchronously without triggering
  // a re-render, so we can keep it ``true`` from "applySession
  // started" until "session-restore stats run completed", spanning
  // the async aggregate hop cleanly.
  const sessionRestoringRef = useRef(false)
  useEffect(() => {
    // Reset on every aggregate response — tags + role are dataset-
    // specific. Shape / N-unit / filter / override survive so a
    // re-run with the same study design doesn't lose the setup.
    // Skipped during a session restore: the loaded values would
    // otherwise be wiped the moment runAggregate's response lands.
    if (sessionRestoringRef.current) return
    setSelectedTags([])
    setSeriesRole('')
  }, [aggResult])

  // ------------------------------------------------------------------
  // Load supported analyses on mount so the dropdown is populated.
  // No fallback — if the backend can't answer, the user sees an empty
  // dropdown + an error, which is the truthful UX (we can't aggregate
  // anyway without the backend).
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!backendUrl) return
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/cohort/analyses`)
        if (!resp.ok) return
        const data = (await resp.json()) as AnalysesIndex
        if (cancelled) return
        setAnalyses(data)
        // Pin the dropdown to the first analysis the backend knows about
        // when the default ('events') isn't in the list (would happen
        // only if extractors get reshuffled).
        if (!data.analyses.includes(analysisType) && data.analyses.length > 0) {
          setAnalysisType(data.analyses[0])
        }
      } catch { /* swallow — UI shows the empty state */ }
    })()
    return () => { cancelled = true }
    // intentionally only re-run on backendUrl change; we don't want
    // re-fetching every time the user toggles analysisType in the
    // dropdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl])

  // Restore the most recent folder from prefs so the user doesn't
  // re-pick on every window open. We persist back via the same key
  // after a successful aggregation.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const api = window.electronAPI
      if (!api?.getPreferences) return
      try {
        const prefs = await api.getPreferences()
        if (cancelled) return
        const recent = (prefs?.cohortLastFolder as string | undefined) ?? null
        if (recent) setFolder(recent)
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])

  const persistFolder = useCallback(async (f: string) => {
    const api = window.electronAPI
    if (!api?.getPreferences || !api?.setPreferences) return
    try {
      const prefs = (await api.getPreferences()) ?? {}
      await api.setPreferences({ ...prefs, cohortLastFolder: f })
    } catch { /* ignore */ }
  }, [])

  // ------------------------------------------------------------------
  // Folder picker — uses the new ``open-folder-dialog`` IPC. On the
  // chance the IPC is missing (older preload), we fall back to a
  // text-edit affordance the user can paste into.
  // ------------------------------------------------------------------
  const pickFolder = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.openFolderDialog) {
      const typed = window.prompt('Folder path:', folder ?? '')
      if (typed) setFolder(typed)
      return
    }
    const picked = await api.openFolderDialog(folder ?? undefined)
    if (picked) setFolder(picked)
  }, [folder])

  // ------------------------------------------------------------------
  // Run aggregation. Surfaces backend errors verbatim so the user can
  // see whether it was a parse failure, an unknown analysis, etc.
  // ------------------------------------------------------------------
  const runAggregate = useCallback(async () => {
    if (!folder || !backendUrl) return
    setAggLoading(true)
    setAggError(null)
    setAggResult(null)
    try {
      const resp = await fetch(`${backendUrl}/api/cohort/aggregate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, analysis_type: analysisType }),
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`)
      }
      const data = (await resp.json()) as AggregateResponse
      setAggResult(data)
      persistFolder(folder)
    } catch (err) {
      setAggError(err instanceof Error ? err.message : String(err))
    } finally {
      setAggLoading(false)
    }
  }, [folder, backendUrl, analysisType, persistFolder])

  // ------------------------------------------------------------------
  // Derived: union of scalar metric names across all cells, used to
  // build the preview-table column header. Cells with missing metrics
  // (extractor returned None for that cell) render an em-dash in
  // their cell so the table is rectangular even with sparse data.
  // ------------------------------------------------------------------
  const scalarColumns: string[] = useMemo(() => {
    if (!aggResult) return []
    const seen = new Set<string>()
    for (const c of aggResult.cells) {
      for (const k of Object.keys(c.scalars)) seen.add(k)
    }
    // Preserve curated DEFAULT_METRICS order at the front, then any
    // remaining metrics alphabetically. Makes the preview consistent
    // with what the metric tree (B.5) will show as pre-checked.
    const curated = analyses?.default_metrics?.[aggResult.analysis_type]?.scalars ?? []
    const front = curated.filter((k) => seen.has(k))
    const remaining = Array.from(seen)
      .filter((k) => !front.includes(k))
      .sort()
    return [...front, ...remaining]
  }, [aggResult, analyses])

  // ------------------------------------------------------------------
  // Wizard derived state (B.3): tag pools + design inference.
  // Recomputed cheaply on each render — the cell counts are O(N) and
  // datasets are small enough (typically 10-100 cells) that
  // memoisation overhead would exceed the savings.
  // ------------------------------------------------------------------
  const fileTagPool = useMemo(
    () => aggResult ? collectFileTags(aggResult.cells) : [],
    [aggResult],
  )
  const seriesTagPool = useMemo(
    () => aggResult ? collectSeriesTags(aggResult.cells) : [],
    [aggResult],
  )
  const tagPool = comparisonShape === 'within' ? seriesTagPool : fileTagPool
  const design = useMemo(
    () => aggResult
      ? inferDesign(aggResult.cells, comparisonShape, selectedTags, filterTags, nUnit, seriesRole, testOverride)
      : null,
    [aggResult, comparisonShape, selectedTags, filterTags, nUnit, seriesRole, testOverride],
  )

  // ------------------------------------------------------------------
  // B.4: stats runner — picks one metric to test (B.5 will expand
  // this into the full metric tree). The runner needs values per
  // group, derived from the cohort response + wizard state. Default
  // metric is the first curated scalar for the analysis type so the
  // user sees a sensible starting point without picking.
  // ------------------------------------------------------------------
  // All metric names across the three kinds: scalar (one value per
  // cell), distribution (events array per cell, ECDF plot),
  // timeseries (bin-by-bin trace per cell, line plot). Each gets a
  // ``kind`` tag so the picker can label them and Run can dispatch
  // to the right backend path. Distribution kind comes from
  // ``meta.distribution_kinds`` (set per-extractor) — anything not
  // listed there is treated as ``samples`` (= distribution).
  type MetricKind = 'scalar' | 'distribution' | 'timeseries'
  interface MetricEntry { name: string; kind: MetricKind }
  const metricOptions: MetricEntry[] = useMemo(() => {
    if (!aggResult) return []
    const scalarSet = new Set<string>()
    const distSet = new Set<string>()
    const distKindMap = new Map<string, 'samples' | 'timeseries'>()
    for (const c of aggResult.cells) {
      for (const k of Object.keys(c.scalars)) scalarSet.add(k)
      for (const k of Object.keys(c.distributions ?? {})) distSet.add(k)
      const kinds = (c.meta as any)?.distribution_kinds
      if (kinds && typeof kinds === 'object') {
        for (const [k, v] of Object.entries(kinds)) {
          if (v === 'timeseries') distKindMap.set(k, 'timeseries')
          else distKindMap.set(k, 'samples')
        }
      }
    }
    const curatedScalars = analyses?.default_metrics?.[aggResult.analysis_type]?.scalars ?? []
    const curatedDists = analyses?.default_metrics?.[aggResult.analysis_type]?.distributions ?? []
    const front: MetricEntry[] = [
      ...curatedScalars.filter((k) => scalarSet.has(k)).map((name) => ({ name, kind: 'scalar' as MetricKind })),
      ...curatedDists.filter((k) => distSet.has(k)).map((name) => ({
        name,
        kind: (distKindMap.get(name) === 'timeseries' ? 'timeseries' : 'distribution') as MetricKind,
      })),
    ]
    const seen = new Set(front.map((e) => e.name))
    const otherScalars = Array.from(scalarSet).filter((k) => !seen.has(k)).sort()
      .map((name) => ({ name, kind: 'scalar' as MetricKind }))
    const otherDists = Array.from(distSet).filter((k) => !seen.has(k)).sort()
      .map((name) => ({
        name,
        kind: (distKindMap.get(name) === 'timeseries' ? 'timeseries' : 'distribution') as MetricKind,
      }))
    return [...front, ...otherScalars, ...otherDists]
  }, [aggResult, analyses])
  // Convenience: just the scalar names (for stats — distributions
  // and timeseries don't go through the stats runner yet).
  const scalarMetricOptions: string[] = useMemo(
    () => metricOptions.filter((m) => m.kind === 'scalar').map((m) => m.name),
    [metricOptions],
  )
  const metricKindOf = (name: string): MetricKind | null =>
    metricOptions.find((m) => m.name === name)?.kind ?? null
  // Multi-select metric set. ``runStats`` fires one /run_stats per
  // scalar metric AND one /render_graph per metric (regardless of
  // kind) in parallel. Defaults to the analysis type's curated
  // scalars + distributions so the user gets a sensible pre-pick.
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([])

  // ---- Per-cell event subsampling (B.5) -----------------------------
  // Distribution metrics live in the world of "this cell has N events,
  // that one has 5N — the cell with N can swamp or starve the
  // statistical comparison depending on direction". The cohort modal
  // and stats runner now offer five modes:
  //   * 'all'    → use every event the cell has (default, no change)
  //   * 'first'  → keep the first N events (chronological)
  //   * 'last'   → keep the last N events (most recent)
  //   * 'random' → uniformly sample N events without replacement, with
  //               a deterministic seed per (cell, metric) so the same
  //               sample is drawn on every re-render
  //   * 'auto'   → N = min event count across in-scope cells (the
  //               equalising sample that prevents any one cell from
  //               dominating mean ECDFs / pooled events)
  // The same config is applied to graphs (via
  // ``extractGraphGroupsForMetric``) AND to the export payload so all
  // three downstream paths see identical subsampled data.
  const [subsampleMode, setSubsampleMode] = useState<SubsampleMode>('all')
  const [subsampleN, setSubsampleN] = useState<number>(100)
  const allMetricNames = useMemo(
    () => metricOptions.map((m) => m.name),
    [metricOptions],
  )
  useEffect(() => {
    if (!aggResult) return
    // Don't apply curated defaults during a session restore — the
    // loaded ``selected_metrics`` already represent the user's
    // explicit choice and we want them to land verbatim. Without
    // this guard, the defaults effect would race with applySession
    // and overwrite a loaded selection that happens to contain
    // metrics outside the curated list (e.g. user selected
    // ``rise_ms`` distribution for events).
    if (sessionRestoringRef.current) return
    const curated = [
      ...(analyses?.default_metrics?.[aggResult.analysis_type]?.scalars ?? []),
      ...(analyses?.default_metrics?.[aggResult.analysis_type]?.distributions ?? []),
    ]
    const valid = curated.filter((m) => allMetricNames.includes(m))
    setSelectedMetrics((prev) => {
      const stillValid = prev.filter((m) => allMetricNames.includes(m))
      if (stillValid.length > 0) return stillValid
      return valid.length > 0 ? valid : allMetricNames.slice(0, 1)
    })
  }, [aggResult, analyses, allMetricNames])

  // Stats + graph results, keyed per metric. ``runStats`` populates
  // both in one shot (parallel HTTP). Graph entries carry the SVG
  // payload + plot meta (axis units, ymin/ymax for the modal).
  const [statsResults, setStatsResults] = useState<Record<string, any> | null>(null)
  const [graphResults, setGraphResults] = useState<Record<string, any> | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState<string | null>(null)

  // ---- Graph customisation prefs ------------------------------------
  // Survives modal close so the user doesn't re-do their work each
  // time. Two scopes:
  //   * cohort-wide (groupColors / groupLabels) — applied to every
  //     graph that shows those tags. Set once, propagates everywhere.
  //   * perMetric — axis range, labels, title, log scales, and
  //     kind-specific toggles. Stays with the metric.
  // Persistence lives in the ``.tracer_cohort`` session file (B.9):
  // saving the session writes ``graph_prefs``; opening restores
  // them via ``applySession``. The cohort window itself keeps the
  // prefs in memory only — closing without saving discards them
  // by design, matching the "session = explicit save" mental model
  // the rest of the file (folder, design, metrics) follows.
  const [graphPrefs, setGraphPrefs] = useState<CohortGraphPrefs>(() => emptyGraphPrefs())
  const graphPrefsRef = useRef(graphPrefs)
  graphPrefsRef.current = graphPrefs

  // Imperative updater used by the modal. Wraps ``setGraphPrefs``
  // so callers can pass a partial-update function or a literal slice.
  const updateGraphPrefs = useCallback((updater: (prev: CohortGraphPrefs) => CohortGraphPrefs) => {
    setGraphPrefs(updater)
  }, [])

  // Invalidate on any change that would make the displayed numbers
  // OR graphs stale relative to the current wizard state.
  useEffect(() => {
    setStatsResults(null)
    setGraphResults(null)
    setStatsError(null)
  }, [aggResult, comparisonShape, selectedTags, filterTags,
      seriesRole, nUnit, testOverride, selectedMetrics])

  /** Map the wizard's design state to the backend ``design_kind``
   *  enum so the stats endpoint knows which Pingouin path to call. */
  const designKind: string | null = useMemo(() => {
    if (!design || !design.ready) return null
    const k = design.groups.length
    if (comparisonShape === 'within') return k === 2 ? 'paired_2' : 'rm_n'
    return k === 2 ? 'unpaired_2' : 'oneway_n'
  }, [design, comparisonShape])

  /** Extract per-group numeric values for one metric. Same per-mode
   *  rules as before — within-mode pairs by file, between-mode
   *  honours the seriesRole filter. */
  const extractValuesForMetric = useCallback((metric: string): { tag: string; values: (number | null)[] }[] | null => {
    if (!aggResult || !design || !design.ready || !metric) return null
    const cellsByFile = new Map<string, Cell[]>()
    for (const c of aggResult.cells) {
      if (!cellsByFile.has(c.file_path)) cellsByFile.set(c.file_path, [])
      cellsByFile.get(c.file_path)!.push(c)
    }
    if (comparisonShape === 'within') {
      const fileOrder = design.groups[0].cells.map((c) => c.file_path)
      return design.groups.map((g) => ({
        tag: g.tag,
        values: fileOrder.map((fp) => {
          const fileRows = cellsByFile.get(fp) ?? []
          const matches = fileRows.filter((r) =>
            r.series_specific_tags.map((t) => t.toLowerCase())
              .includes(g.tag.toLowerCase()))
          return _meanScalar(matches, metric)
        }),
      }))
    }
    return design.groups.map((g) => ({
      tag: g.tag,
      values: g.cells.map((c) => {
        const fileRows = cellsByFile.get(c.file_path) ?? []
        const sourceRows = seriesRole
          ? fileRows.filter((r) =>
              r.series_specific_tags.map((t) => t.toLowerCase())
                .includes(seriesRole.toLowerCase()))
          : fileRows
        return _meanScalar(sourceRows, metric)
      }),
    }))
  }, [aggResult, design, comparisonShape, seriesRole])

  // Per-cell array extraction for graphs. Same per-mode rules as
  // the stats extractor (within = paired by file, between = role-
  // gated), but each cell contributes an ARRAY of values:
  //   - scalar metric → singleton array of the per-cell mean
  //   - distribution / timeseries metric → the full distribution
  //     array stored under cell.distributions[metric]
  // For LTP timeseries we also pull bin_width_s + bins_consistent
  // from the cell's meta so the backend's time-axis check has data.
  const extractGraphGroupsForMetric = useCallback((metric: string, kind: MetricKind) => {
    if (!aggResult || !design || !design.ready) return null
    const cellsByFile = new Map<string, Cell[]>()
    for (const c of aggResult.cells) {
      if (!cellsByFile.has(c.file_path)) cellsByFile.set(c.file_path, [])
      cellsByFile.get(c.file_path)!.push(c)
    }
    // Auto-N for this metric = min event count across in-scope cells
    // (only meaningful for distribution kind). Computed once per
    // call so 'auto' mode equalises consistently across groups.
    const autoN = kind === 'distribution'
      ? computeAutoN(design.groups, metric, seriesRole, comparisonShape)
      : 0
    /** Pull the metric's value(s) from a set of cell rows for ONE
     *  file. Returns one array (multi values for distributions, one
     *  number for scalars). Subsampling is applied here for
     *  distribution kind so every downstream consumer (graphs,
     *  stats, exports) sees the SAME values. ``seed`` makes 'random'
     *  mode deterministic per (file, metric, mode). */
    const valuesFromRows = (rows: Cell[], seed: string): number[] => {
      if (kind === 'scalar') {
        const m = _meanScalar(rows, metric)
        return m == null ? [] : [m]
      }
      // Distribution / timeseries: pool the per-row arrays for the
      // file (multi-series files contribute the union of their
      // events for that metric).
      const out: number[] = []
      for (const r of rows) {
        const arr = r.distributions?.[metric]
        if (Array.isArray(arr)) {
          for (const v of arr) {
            if (v != null && !Number.isNaN(v)) out.push(Number(v))
          }
        }
      }
      // Subsampling only kicks in for distribution metrics.
      // Timeseries distributions (LTP normalised series, etc.) are
      // bin-by-bin traces — slicing them would corrupt the time
      // axis, so we leave them untouched.
      if (kind === 'distribution') {
        return applySubsample(out, subsampleMode, subsampleN, autoN,
          `${seed}::${metric}::${subsampleMode}::${subsampleN}::${autoN}`)
      }
      return out
    }
    /** Bin-width metadata reduce across the rows for one file. */
    const binWidthFromRows = (rows: Cell[]): {
      bin_width_s: number | null
      bins_consistent: boolean | null
      induction_bin_idx: number | null
    } => {
      for (const r of rows) {
        const meta = (r.meta as any) ?? {}
        if (meta.bin_width_s != null || meta.induction_bin_idx != null) {
          return {
            bin_width_s: meta.bin_width_s != null ? Number(meta.bin_width_s) : null,
            bins_consistent: meta.bins_consistent ?? null,
            induction_bin_idx: meta.induction_bin_idx != null
              ? Number(meta.induction_bin_idx) : null,
          }
        }
      }
      return { bin_width_s: null, bins_consistent: null, induction_bin_idx: null }
    }

    if (comparisonShape === 'within') {
      const fileOrder = design.groups[0].cells.map((c) => c.file_path)
      return design.groups.map((g) => ({
        tag: g.tag,
        values_per_cell: fileOrder.map((fp) => {
          const fileRows = cellsByFile.get(fp) ?? []
          const matches = fileRows.filter((r) =>
            r.series_specific_tags.map((t) => t.toLowerCase())
              .includes(g.tag.toLowerCase()))
          return valuesFromRows(matches, `${fp}|${g.tag}`)
        }).filter((arr) => arr.length > 0),
        ...(kind === 'timeseries'
          ? binWidthFromRows((cellsByFile.get(fileOrder[0]) ?? []))
          : {}),
      }))
    }
    return design.groups.map((g) => ({
      tag: g.tag,
      values_per_cell: g.cells.map((c) => {
        const fileRows = cellsByFile.get(c.file_path) ?? []
        const sourceRows = seriesRole
          ? fileRows.filter((r) =>
              r.series_specific_tags.map((t) => t.toLowerCase())
                .includes(seriesRole.toLowerCase()))
          : fileRows
        return valuesFromRows(sourceRows, `${c.file_path}|${g.tag}`)
      }).filter((arr) => arr.length > 0),
      ...(kind === 'timeseries' && g.cells.length > 0
        ? binWidthFromRows((cellsByFile.get(g.cells[0].file_path) ?? []))
        : {}),
    }))
  }, [aggResult, design, comparisonShape, seriesRole, subsampleMode, subsampleN])

  const themeName = useThemeStore((s) => s.theme)

  // ------------------------------------------------------------------
  // Session file (.tracer_cohort) — Phase B.9 save / open.
  //
  // ``buildSession`` collects in-memory state into a JSON-serialisable
  // blob; ``applySession`` restores it (kicking off a fresh aggregate
  // against the saved folder so the cards have data to render).
  // Auto-save / aggregate-snapshot reproducibility / prefs migration
  // land in a follow-up slice — this iteration covers manual Save /
  // Save As / Open round-trip only.
  //
  // Placed AFTER all the state these functions reference so the
  // closures bind to the correct identifiers — block-scoped state
  // declared lower in the function body would otherwise be
  // referenced before initialisation.
  // ------------------------------------------------------------------
  const buildSession = useCallback((): Record<string, unknown> => {
    return {
      folder,
      analysis_type: analysisType,
      design: {
        comparison_shape: comparisonShape,
        selected_tags: selectedTags,
        filter_tags: filterTags,
        series_role: seriesRole,
        n_unit: nUnit,
        test_override: testOverride,
        // Distribution-metric K-S settings — saved alongside the
        // scalar test override so reopening a session restores the
        // exact stats configuration the figures were built with.
        dist_mode: distMode,
        dist_anderson_darling: distAndersonDarling,
        dist_reference_tag: distReferenceTag,
        subsample: { mode: subsampleMode, n: subsampleN },
      },
      selected_metrics: selectedMetrics,
      // Cached so reopening shows the result cards instantly; the
      // user can still re-run stats explicitly to refresh.
      stats_results: statsResults,
      graph_prefs: graphPrefs,
    }
  }, [folder, analysisType, comparisonShape, selectedTags, filterTags,
      seriesRole, nUnit, testOverride, subsampleMode, subsampleN,
      selectedMetrics, statsResults, graphPrefs,
      distMode, distAndersonDarling, distReferenceTag])

  const applySession = useCallback(async (data: Record<string, unknown>) => {
    setSessionLoading(true)
    setSessionError(null)
    // Mark the restore in flight BEFORE any setState calls so the
    // first reset-on-aggregate-change effect that fires sees the
    // ref already set and skips. Cleared either by the post-
    // aggregate stats effect on success, or by the catch / "no
    // folder" branches on failure.
    sessionRestoringRef.current = true
    try {
      // Pull each field defensively — the file may have been written
      // by an older or newer schema; missing fields fall back to
      // the same defaults we'd use for a fresh session.
      const f = typeof data.folder === 'string' ? data.folder : null
      const at = typeof data.analysis_type === 'string' ? data.analysis_type : 'events'
      const design = (data.design as Record<string, unknown>) || {}
      const cs = (design.comparison_shape as ComparisonShape) || 'between'
      const st = Array.isArray(design.selected_tags) ? (design.selected_tags as string[]) : []
      const ft = Array.isArray(design.filter_tags) ? (design.filter_tags as string[]) : []
      const sr = typeof design.series_role === 'string' ? design.series_role : ''
      const nu = (design.n_unit as NUnit) || 'cell'
      const to = (design.test_override as TestOverride) || 'auto'
      const dm = (design.dist_mode as 'pooled_ks' | 'per_cell_ks_d' | 'off') || 'pooled_ks'
      const dad = !!design.dist_anderson_darling
      const drt = typeof design.dist_reference_tag === 'string' ? design.dist_reference_tag : ''
      const ss = (design.subsample as Record<string, unknown>) || {}
      const sm = (ss.mode as SubsampleMode) || 'all'
      const sn = typeof ss.n === 'number' ? ss.n : 100
      const sel = Array.isArray(data.selected_metrics) ? (data.selected_metrics as string[]) : []
      const stats = (data.stats_results as Record<string, any>) || null
      const gp = normalizeGraphPrefs(data.graph_prefs)

      // Apply state. We explicitly do NOT clear graphPrefs first —
      // normalize already returns a clean object; setting it
      // directly avoids a flicker where the cards would briefly
      // render with no styling.
      setFolder(f)
      setAnalysisType(at)
      setComparisonShape(cs)
      setSelectedTags(st)
      setFilterTags(ft)
      setSeriesRole(sr)
      setNUnit(nu)
      setTestOverride(to)
      setDistMode(dm)
      setDistAndersonDarling(dad)
      setDistReferenceTag(drt)
      setSubsampleMode(sm)
      setSubsampleN(sn)
      setSelectedMetrics(sel)
      // Don't restore ``statsResults`` from the file: the existing
      // "wipe on wizard change" effect (line ~921) will clobber any
      // value we put in here as soon as state batches commit, since
      // selectedTags / filterTags / etc. are all in its dep list.
      // Instead we re-run stats after the aggregate lands —
      // deterministic given same data + design, and ensures the
      // numbers reflect the CURRENT state of the recording files
      // rather than a stale cache. Acknowledge the cached value by
      // ignoring it intentionally:
      void stats
      setStatsResults(null)
      setGraphResults(null)
      setGraphPrefs(gp)
      // Aggregation needs to run AFTER the state above lands so
      // it picks up the saved folder + analysis type. Once the
      // aggregate response arrives, the post-session effect below
      // sees ``pendingSessionRunStats`` and auto-fires runStats.
      if (f) {
        setPendingSessionRunStats(sel.length > 0)
        setTimeout(() => { void runAggregate() }, 0)
      } else {
        // No folder in the file — nothing to aggregate, so we're
        // done restoring. Drop the ref here so reset effects can
        // resume normal behaviour the next time wizard state moves.
        sessionRestoringRef.current = false
      }
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
      sessionRestoringRef.current = false
    } finally {
      setSessionLoading(false)
    }
  }, [runAggregate])

  const saveSession = useCallback(async (path: string | null = sessionPath): Promise<boolean> => {
    const api = window.electronAPI
    if (!api?.writeCohortSession) {
      setSessionError('Save not available — Electron bridge missing.')
      return false
    }
    let target = path
    if (!target) {
      // Save As — suggest <folder-basename>.tracer_cohort when we have
      // a folder; otherwise just ``cohort.tracer_cohort``.
      const defaultName = folder
        ? `${folder.split(/[/\\]/).pop() || 'cohort'}.tracer_cohort`
        : 'cohort.tracer_cohort'
      const picked = await api.saveFileDialog?.(defaultName, [
        { name: 'TRACER Cohort Session', extensions: ['tracer_cohort'] },
      ])
      if (!picked) return false
      target = picked
    }
    const ok = await api.writeCohortSession(target, buildSession())
    if (ok) {
      setSessionPath(target)
      setSessionDirty(false)
      setSessionError(null)
      return true
    } else {
      setSessionError('Failed to write session file.')
      return false
    }
  }, [sessionPath, folder, buildSession])

  const openSession = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.openCohortSessionDialog || !api?.readCohortSession) {
      setSessionError('Open not available — Electron bridge missing.')
      return
    }
    const path = await api.openCohortSessionDialog()
    if (!path) return
    const data = await api.readCohortSession(path)
    if (!data) {
      setSessionError('Could not read session file (missing or wrong format).')
      return
    }
    setSessionPath(path)
    void applySession(data)
  }, [applySession])

  // Mark session dirty whenever any persisted slice of state moves.
  // Skipped while a session is loading so a freshly-opened file
  // doesn't immediately display as "dirty".
  useEffect(() => {
    if (sessionLoading) return
    setSessionDirty(true)
  }, [folder, analysisType, comparisonShape, selectedTags, filterTags,
      seriesRole, nUnit, testOverride, subsampleMode, subsampleN,
      selectedMetrics, statsResults, graphPrefs, sessionLoading])

  // Hint text for the subsampling control: smallest event count
  // across in-scope cells per distribution metric — what the user
  // would land on if they picked 'auto'. Computed once across all
  // distribution metrics; we surface the global min so the hint is
  // a conservative, single-line answer ("auto = N events"). When
  // there are no distribution metrics the hint stays blank.
  const autoNHint: number | null = useMemo(() => {
    if (!design || !design.ready) return null
    const dists = new Set<string>()
    for (const g of design.groups) {
      for (const c of g.cells) {
        for (const k of Object.keys(c.distributions ?? {})) dists.add(k)
      }
    }
    if (dists.size === 0) return null
    let minN = Infinity
    for (const m of dists) {
      const n = computeAutoN(design.groups, m, seriesRole, comparisonShape)
      if (n > 0 && n < minN) minN = n
    }
    return Number.isFinite(minN) ? minN : null
  }, [design, seriesRole, comparisonShape])

  // Build the export payload's grouped cells: deep-copy the wizard's
  // design.groups, then apply the same subsampling to each cell's
  // distribution arrays so the exported file shows the same numbers
  // as the on-screen graphs / stats. Scalar metrics are untouched.
  // Per-distribution-metric autoN is computed once and reused for
  // every cell so 'auto' equalises consistently across groups.
  const designGroupsForExport = useMemo(() => {
    if (!design || !design.ready) return null
    // Per-metric autoN cache so 'auto' picks the same N for a given
    // metric across all cells/groups (otherwise each cell would get
    // a different N which defeats the equalisation).
    const autoNByMetric = new Map<string, number>()
    const allDistMetrics = new Set<string>()
    for (const g of design.groups) {
      for (const c of g.cells) {
        for (const k of Object.keys(c.distributions ?? {})) {
          allDistMetrics.add(k)
        }
      }
    }
    for (const m of allDistMetrics) {
      autoNByMetric.set(m, computeAutoN(design.groups, m, seriesRole, comparisonShape))
    }
    return design.groups.map((g) => ({
      tag: g.tag,
      cells: g.cells.map((c) => {
        const subsampledDists: Record<string, number[]> = {}
        for (const [m, arr] of Object.entries(c.distributions ?? {})) {
          if (Array.isArray(arr)) {
            subsampledDists[m] = applySubsample(
              arr.filter((v) => v != null && !Number.isNaN(v)).map(Number),
              subsampleMode, subsampleN,
              autoNByMetric.get(m) ?? 0,
              `${c.file_path}|${g.tag}::${m}::${subsampleMode}::${subsampleN}`,
            )
          } else {
            subsampledDists[m] = []
          }
        }
        return { ...c, distributions: subsampledDists }
      }),
    }))
  }, [design, subsampleMode, subsampleN, seriesRole, comparisonShape])

  const runStats = useCallback(async () => {
    if (!designKind || !backendUrl || selectedMetrics.length === 0) return
    setStatsLoading(true)
    setStatsResults(null)
    setGraphResults(null)
    setStatsError(null)
    try {
      // Two parallel fan-outs:
      //   1. /run_stats (scalars) + /run_distribution_stats (event
      //      distributions). Both write into one ``statsOut`` map so
      //      the card UI doesn't have to know which path produced it.
      //   2. /render_graph per metric, in the right plot kind
      // Awaited together so the UI flips from "Running…" to fully-
      // populated results in one paint.
      const statsCalls = selectedMetrics
        .map(async (metric) => {
          const kind = metricKindOf(metric)
          if (kind === 'scalar') {
            const groups = extractValuesForMetric(metric)
            if (!groups) return [metric, { error: 'no values' }] as const
            const resp = await fetch(`${backendUrl}/api/cohort/run_stats`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                groups, design_kind: designKind,
                test_override: testOverride, metric,
              }),
            })
            if (!resp.ok) return [metric, { error: `HTTP ${resp.status}: ${await resp.text()}` }] as const
            return [metric, await resp.json()] as const
          }
          if (kind === 'distribution' && distMode !== 'off' && designKind) {
            // Distribution stats path. Pooled K-S works for any
            // design (paired or unpaired); the pooling discards the
            // pairing for the headline number. Per-cell K-S D goes
            // through the design-aware scalar test so paired pre/
            // post comparisons run Wilcoxon on the per-cell D's
            // automatically.
            const groups = extractGraphGroupsForMetric(metric, 'distribution')
            if (!groups) return [metric, { error: 'no values' }] as const
            // Resolve reference group index for per_cell_ks_d. Empty
            // tag = first group (default behaviour).
            const refIdx = distReferenceTag
              ? Math.max(0, groups.findIndex((g) => g.tag === distReferenceTag))
              : 0
            const resp = await fetch(`${backendUrl}/api/cohort/run_distribution_stats`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                groups: groups.map((g) => ({ tag: g.tag, values_per_cell: g.values_per_cell })),
                design_kind: designKind,
                mode: distMode,
                anderson_darling: distAndersonDarling,
                reference_group_idx: refIdx,
                metric,
              }),
            })
            if (!resp.ok) return [metric, { error: `HTTP ${resp.status}: ${await resp.text()}` }] as const
            return [metric, await resp.json()] as const
          }
          return [metric, null] as const  // no stats for this metric kind
        })
      const graphCalls = selectedMetrics.map(async (metric) => {
        const kind = metricKindOf(metric)
        if (!kind) return [metric, { error: 'unknown metric kind' }] as const
        const groups = extractGraphGroupsForMetric(metric, kind)
        if (!groups || groups.every((g) => g.values_per_cell.length === 0)) {
          return [metric, { error: 'no values to plot' }] as const
        }
        // Build the request body up-front so we can both POST it now
        // AND stash it in the cached graph for the modal to replay
        // later with axis / label / colour overrides. The modal
        // reconstructs the original chart from this seed and only
        // injects the user's tweaks on top.
        const requestBody = {
          kind, groups,
          title: metric,
          ylabel: kind === 'scalar' ? metric : (kind === 'timeseries' ? '× baseline' : ''),
          xlabel: kind === 'distribution' ? metric : '',
          theme: themeName === 'light' ? 'light' : 'dark',
          reference_y: kind === 'timeseries' && metric.includes('normalized') ? 1.0 : null,
          output_format: 'svg',
        }
        const resp = await fetch(`${backendUrl}/api/cohort/render_graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        })
        if (!resp.ok) return [metric, { error: `HTTP ${resp.status}: ${await resp.text()}` }] as const
        const json = await resp.json()
        // Attach the request payload so ``GraphModal`` can replay it
        // with overrides without recomputing groups from the source
        // sidecars. This makes the modal open instantly even on big
        // cohorts — only the re-render hits the backend.
        return [metric, { ...json, request: requestBody }] as const
      })

      const [statsResponses, graphResponses] = await Promise.all([
        Promise.all(statsCalls),
        Promise.all(graphCalls),
      ])
      const statsOut: Record<string, any> = {}
      for (const [metric, result] of statsResponses) {
        if (result == null) continue   // metric kind has no stats
        statsOut[metric] = result
      }
      const graphOut: Record<string, any> = {}
      for (const [metric, result] of graphResponses) graphOut[metric] = result
      setStatsResults(statsOut)
      setGraphResults(graphOut)
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : String(err))
    } finally {
      setStatsLoading(false)
    }
  }, [designKind, backendUrl, selectedMetrics, extractValuesForMetric,
      extractGraphGroupsForMetric, testOverride, themeName, metricKindOf,
      distMode, distAndersonDarling, distReferenceTag])

  // Auto-run stats after a session restore completes its aggregate
  // step. The flow is:
  //   1. ``applySession`` sets folder / design / metrics / prefs and
  //      arms ``pendingSessionRunStats``.
  //   2. ``runAggregate`` fires (via setTimeout in applySession) and
  //      ``aggResult`` lands.
  //   3. The "wipe on wizard change" effect clears stats (expected
  //      — we want fresh, not stale).
  //   4. THIS effect sees ``pendingSessionRunStats`` set and a
  //      stable ``aggResult``, fires ``runStats`` once, then clears
  //      the flag so subsequent aggregations don't accidentally
  //      auto-run.
  // Without this, a session reopen would just leave the user with
  // an aggregated cohort and empty stats / graphs panel — defeats
  // the point of saving the session.
  useEffect(() => {
    if (!pendingSessionRunStats) return
    if (!aggResult || aggLoading) return
    // ``designKind`` derives from selectedTags. If the design isn't
    // ready (< 2 tags etc.), runStats will no-op anyway, but
    // clearing the flag here keeps the state consistent.
    if (!designKind || selectedMetrics.length === 0) {
      setPendingSessionRunStats(false)
      // Restoration is complete (or impossible — no design / no
      // metrics). Drop the ref so wizard-state reset effects
      // resume normal behaviour for subsequent user edits.
      sessionRestoringRef.current = false
      return
    }
    setPendingSessionRunStats(false)
    void runStats()
    // Drop the ref AFTER runStats fires. ``runStats`` reads
    // closures over the current state, so by this point the
    // wizard state is the loaded one — safe to allow reset
    // effects to fire normally for any subsequent edit.
    sessionRestoringRef.current = false
  }, [pendingSessionRunStats, aggResult, aggLoading, designKind,
      selectedMetrics, runStats])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      fontSize: 'var(--font-size-base)',
    }}>
      {/* ---- Top toolbar — folder + analysis-type pickers + run ---- */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center',
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 600 }}>Folder:</span>
        <button
          className="btn"
          onClick={pickFolder}
        >Pick…</button>
        <span style={{
          flex: 1, minWidth: 200,
          fontSize: 'var(--font-size-sm)',
          color: folder ? 'var(--text-primary)' : 'var(--text-muted)',
          fontStyle: folder ? 'normal' : 'italic',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={folder ?? ''}>
          {folder ?? 'No folder picked'}
        </span>

        <span style={{ fontWeight: 600, marginLeft: 12 }}>Analysis:</span>
        <select
          value={analysisType}
          onChange={(e) => setAnalysisType(e.target.value)}
          disabled={!analyses || analyses.analyses.length === 0}
          style={{ minWidth: 200 }}
        >
          {analyses?.analyses.map((a) => (
            <option key={a} value={a}>
              {ANALYSIS_LABELS[a] ?? a}
            </option>
          ))}
        </select>

        <button
          className="btn btn-primary"
          onClick={runAggregate}
          disabled={!folder || aggLoading}
          style={{ padding: '0 16px' }}
        >{aggLoading ? 'Aggregating…' : 'Aggregate'}</button>

        {/* Session file — Save / Save As / Open. Sits at the
            far right of the top bar so the load/save flow has
            its own visual grouping, separate from "do work
            with the current cohort". The Save button label
            tracks dirty state so the user can tell at a glance
            whether the on-screen state matches the saved file. */}
        <div style={{
          marginLeft: 'auto',
          display: 'flex', gap: 6, alignItems: 'center',
          fontSize: 'var(--font-size-xs)',
        }}>
          <button
            className="btn"
            onClick={openSession}
            disabled={sessionLoading}
            title="Open a saved cohort session (.tracer_cohort) — restores folder, wizard state, selected metrics, stats, and graph styling."
          >Open…</button>
          <button
            className="btn"
            onClick={() => { void saveSession() }}
            disabled={sessionLoading}
            title={sessionPath
              ? `Save changes to ${sessionPath.split(/[/\\]/).pop()}`
              : 'Save the current session as a .tracer_cohort file.'}
          >{sessionPath
              ? (sessionDirty ? 'Save*' : 'Save')
              : 'Save…'}</button>
          {sessionPath && (
            <button
              className="btn"
              onClick={() => { void saveSession(null) }}
              disabled={sessionLoading}
                title="Save the current session to a new file."
            >Save As…</button>
          )}
          {sessionPath && (
            <span style={{
              color: 'var(--text-muted)',
              maxWidth: 220,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={sessionPath}>
              {sessionPath.split(/[/\\]/).pop()}
            </span>
          )}
          {sessionError && (
            <span style={{ color: 'var(--error)' }}>{sessionError}</span>
          )}
        </div>
      </div>

      {/* ---- Body ----
          Pre-aggregation: full-width empty state.
          Post-aggregation: wizard column + preview column. */}
      {!aggResult && !aggError && !aggLoading && (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>
          <EmptyState />
        </div>
      )}
      {aggError && (
        <div style={{ padding: '12px 14px', flexShrink: 0 }}>
          <div className="notice notice-error">{aggError}</div>
        </div>
      )}

      {aggResult && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* ---- Left: wizard ---- */}
          <div style={{
            width: 340, flexShrink: 0,
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            overflowY: 'auto',
            padding: '12px 14px',
          }}>
            <Wizard
              cells={aggResult.cells}
              tagPool={tagPool}
              fileTagPool={fileTagPool}
              seriesTagPool={seriesTagPool}
              comparisonShape={comparisonShape}
              setComparisonShape={(s) => {
                setComparisonShape(s)
                // Switching shape changes which tag pool is relevant.
                // Drop selections so the user doesn't get cells
                // assigned by tags from the wrong pool. Role only
                // applies to between mode so reset it as well.
                setSelectedTags([])
                setSeriesRole('')
              }}
              selectedTags={selectedTags}
              setSelectedTags={setSelectedTags}
              filterTags={filterTags}
              setFilterTags={setFilterTags}
              seriesRole={seriesRole}
              setSeriesRole={setSeriesRole}
              nUnit={nUnit}
              setNUnit={setNUnit}
              testOverride={testOverride}
              setTestOverride={setTestOverride}
              distMode={distMode}
              setDistMode={setDistMode}
              distAndersonDarling={distAndersonDarling}
              setDistAndersonDarling={setDistAndersonDarling}
              distReferenceTag={distReferenceTag}
              setDistReferenceTag={setDistReferenceTag}
              design={design}
              metricOptions={scalarMetricOptions}
              selectedMetrics={selectedMetrics}
              setSelectedMetrics={setSelectedMetrics}
              defaultMetrics={analyses?.default_metrics?.[aggResult.analysis_type]?.scalars ?? []}
              statsLoading={statsLoading}
              statsError={statsError}
              hasResults={statsResults != null}
              onRunStats={runStats}
              subsampleMode={subsampleMode}
              setSubsampleMode={setSubsampleMode}
              subsampleN={subsampleN}
              setSubsampleN={setSubsampleN}
              autoNHint={autoNHint}
            />
          </div>

          {/* ---- Right: stats results (when present) + cell
                  preview + skip section. Stats sit at the top so a
                  fresh run is immediately visible without scrolling
                  past the cell table. */}
          <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px', minWidth: 0 }}>
            {(statsResults || graphResults) && (
              <StatsResultsPanel
                results={statsResults ?? {}}
                graphs={graphResults ?? {}}
                metrics={selectedMetrics}
                metricKindOf={metricKindOf}
                backendUrl={backendUrl}
                themeName={themeName}
                graphPrefs={graphPrefs}
                onUpdateGraphPrefs={updateGraphPrefs}
                onClear={() => {
                  setStatsResults(null)
                  setGraphResults(null)
                }}
              />
            )}
            <ResultSummary result={aggResult} />
            <ExportButtons
              backendUrl={backendUrl}
              aggregate={aggResult}
              designGroups={designGroupsForExport}
              stats={statsResults}
              selectedMetrics={selectedMetrics}
              comparisonShape={comparisonShape}
              selectedTags={selectedTags}
              filterTags={filterTags}
              seriesRole={seriesRole}
              nUnit={nUnit}
              testOverride={testOverride}
              subsampleMode={subsampleMode}
              subsampleN={subsampleN}
            />
            <CellTable cells={aggResult.cells} columns={scalarColumns} />
            <SkippedSection result={aggResult} />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Wizard panel (B.3) — drives the comparison setup. Stateless: all
// state lives in CohortWindow + flows through props. Lets the parent
// own the round-trip into the future stats / session-save layer.
// ---------------------------------------------------------------------
function Wizard(props: {
  cells: Cell[]
  tagPool: string[]
  fileTagPool: string[]
  seriesTagPool: string[]
  comparisonShape: ComparisonShape
  setComparisonShape: (s: ComparisonShape) => void
  selectedTags: string[]
  setSelectedTags: (t: string[]) => void
  filterTags: string[]
  setFilterTags: (t: string[]) => void
  seriesRole: string
  setSeriesRole: (r: string) => void
  nUnit: NUnit
  setNUnit: (n: NUnit) => void
  testOverride: TestOverride
  setTestOverride: (o: TestOverride) => void
  distMode: 'pooled_ks' | 'per_cell_ks_d' | 'off'
  setDistMode: (m: 'pooled_ks' | 'per_cell_ks_d' | 'off') => void
  distAndersonDarling: boolean
  setDistAndersonDarling: (v: boolean) => void
  distReferenceTag: string
  setDistReferenceTag: (t: string) => void
  design: DesignInfo | null
  metricOptions: string[]
  selectedMetrics: string[]
  setSelectedMetrics: React.Dispatch<React.SetStateAction<string[]>>
  defaultMetrics: string[]
  statsLoading: boolean
  statsError: string | null
  hasResults: boolean
  onRunStats: () => void
  subsampleMode: SubsampleMode
  setSubsampleMode: (m: SubsampleMode) => void
  subsampleN: number
  setSubsampleN: (n: number) => void
  autoNHint: number | null
}) {
  const {
    tagPool, fileTagPool, seriesTagPool,
    comparisonShape, setComparisonShape,
    selectedTags, setSelectedTags,
    filterTags, setFilterTags,
    seriesRole, setSeriesRole,
    nUnit, setNUnit,
    testOverride, setTestOverride,
    distMode, setDistMode,
    distAndersonDarling, setDistAndersonDarling,
    distReferenceTag, setDistReferenceTag,
    design,
    metricOptions, selectedMetrics, setSelectedMetrics, defaultMetrics,
    statsLoading, statsError, hasResults, onRunStats,
    subsampleMode, setSubsampleMode, subsampleN, setSubsampleN, autoNHint,
  } = props
  void props.cells  // available if a future section needs the raw list

  const toggleTag = (t: string) => {
    if (selectedTags.includes(t)) {
      setSelectedTags(selectedTags.filter((x) => x !== t))
    } else {
      setSelectedTags([...selectedTags, t])
    }
  }
  const toggleFilter = (t: string) => {
    if (filterTags.includes(t)) {
      setFilterTags(filterTags.filter((x) => x !== t))
    } else {
      setFilterTags([...filterTags, t])
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Step 1: comparison shape */}
      <Section title="1. Comparison shape" hint={
        comparisonShape === 'within'
          ? 'Paired across series within each cell (e.g. baseline vs treatment in the same recording).'
          : 'Unpaired across cells (e.g. wildtype vs knockout from different recordings).'
      }>
        <RadioRow
          name="comparisonShape"
          options={[
            { value: 'between', label: 'Between groups' },
            { value: 'within', label: 'Within recordings' },
          ]}
          value={comparisonShape}
          onChange={(v) => setComparisonShape(v as ComparisonShape)}
        />
      </Section>

      {/* Step 2: tag picker */}
      <Section
        title={comparisonShape === 'within' ? '2. Series tags to compare' : '2. File tags to compare'}
        hint={comparisonShape === 'within'
          ? 'Pick the per-series condition labels. Each becomes one bar; only cells carrying ALL of them contribute (paired design).'
          : 'Pick the file-level group labels. Each becomes one bar; cells with exactly one of these tags get assigned to that group.'}
      >
        {tagPool.length === 0 ? (
          <EmptyHint>
            No {comparisonShape === 'within' ? 'series-level' : 'file-level'} tags
            in the aggregated cells. Open the metadata window to tag your
            recordings first.
          </EmptyHint>
        ) : (
          <TagToggleList
            pool={tagPool}
            selected={selectedTags}
            onToggle={toggleTag}
          />
        )}
      </Section>

      {/* Step 2b: series-role selector — between mode only.
          Within mode already pins the per-cell value to a specific
          series via the selected tags themselves. */}
      {comparisonShape === 'between' && (
        <Section
          title="3. Series role (which series feeds the metric?)"
          hint={
            seriesRole
              ? `Each cell contributes its "${seriesRole}"-tagged series. Files without that role get excluded.`
              : 'Default <any>: average across every analyzed series in the file. Pick a tag if you want only that role to contribute (e.g. baseline-only for an Rs comparison).'
          }
        >
          {seriesTagPool.length === 0 ? (
            <EmptyHint>
              No series-level tags in the aggregated cells. Defaulting
              to ``&lt;any&gt;`` — each cell's value is the mean across
              its analyzed series.
            </EmptyHint>
          ) : (
            <select
              value={seriesRole}
              onChange={(e) => setSeriesRole(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">{'<any> — average across all series in each file'}</option>
              {seriesTagPool.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </Section>
      )}

      {/* Step 3 / 4: optional filter */}
      <Section
        title={comparisonShape === 'between' ? '4. Filter (optional)' : '3. Filter (optional)'}
        hint="Narrow the universe of contributing cells before group assignment. AND across chips. Always uses file-level tags."
      >
        {fileTagPool.length === 0 ? (
          <EmptyHint>No file-level tags available.</EmptyHint>
        ) : (
          <TagToggleList
            pool={fileTagPool}
            selected={filterTags}
            onToggle={toggleFilter}
          />
        )}
      </Section>

      {/* Step N: N choice — use 5 in between (after series role)
          and 4 in within (no series-role step). Keeps numbering
          sensible in either mode. */}
      <Section title={`${comparisonShape === 'between' ? 5 : 4}. What is N?`} hint={
        nUnit === 'cell'
          ? 'One number per cell (= unique recording file). Most common, defensible default. Multi-series files contribute once.'
          : nUnit === 'series'
          ? 'One number per series. ⚠ Risks pseudoreplicating when several series come from the same cell — only use when series are biologically independent.'
          : nUnit === 'sweep'
          ? 'Per-sweep N not yet wired — falls back to cell-level grouping for now (sweep-level rows arrive in a later phase).'
          : 'One number per animal. Cells sharing an Animal ID (set in the metadata window) collapse into one entry — the rigorous denominator for between-animal comparisons. Cells without an Animal ID are flagged below.'
      }>
        <select
          value={nUnit}
          onChange={(e) => setNUnit(e.target.value as NUnit)}
          style={{ width: '100%' }}
        >
          {(Object.keys(N_UNIT_LABELS) as NUnit[]).map((u) => (
            <option key={u} value={u}>{N_UNIT_LABELS[u]}</option>
          ))}
        </select>
      </Section>

      {/* Step 5: design preview */}
      <Section title={`${comparisonShape === 'between' ? 6 : 5}. Design preview`} hint={design?.why ?? ''}>
        {design && (
          <DesignPreview
            design={design}
            testOverride={testOverride}
            setTestOverride={setTestOverride}
            distMode={distMode}
            setDistMode={setDistMode}
            distAndersonDarling={distAndersonDarling}
            setDistAndersonDarling={setDistAndersonDarling}
            distReferenceTag={distReferenceTag}
            setDistReferenceTag={setDistReferenceTag}
            metricOptions={metricOptions}
            selectedMetrics={selectedMetrics}
            setSelectedMetrics={setSelectedMetrics}
            defaultMetrics={defaultMetrics}
            statsLoading={statsLoading}
            statsError={statsError}
            hasResults={hasResults}
            onRunStats={onRunStats}
            subsampleMode={subsampleMode}
            setSubsampleMode={setSubsampleMode}
            subsampleN={subsampleN}
            setSubsampleN={setSubsampleN}
            autoNHint={autoNHint}
          />
        )}
      </Section>
    </div>
  )
}

function Section({ title, hint, children }: {
  title: string; hint?: string; children: React.ReactNode
}) {
  return (
    <div className="section-card">
      <div className="section-card-title">{title}</div>
      {hint && (
        <div style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-muted)',
          marginBottom: 2,
          lineHeight: 1.4,
        }}>{hint}</div>
      )}
      {children}
    </div>
  )
}

function RadioRow<T extends string>(props: {
  name: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {props.options.map((o) => (
        <label
          key={o.value}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 'var(--font-size-sm)',
          }}
        >
          <input
            type="radio"
            name={props.name}
            checked={props.value === o.value}
            onChange={() => props.onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  )
}

function TagToggleList({ pool, selected, onToggle }: {
  pool: string[]
  selected: string[]
  onToggle: (t: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {pool.map((t) => {
        const active = selected.includes(t)
        return (
          <button
            key={t}
            onClick={() => onToggle(t)}
            style={{
              padding: '3px 9px',
              borderRadius: 12,
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border-control)'}`,
              background: active
                ? 'var(--accent-muted)'
                : 'var(--bg-field)',
              color: 'var(--text-primary)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: active ? 600 : 400,
            }}
          >{t}</button>
        )
      })}
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      color: 'var(--text-muted)', fontStyle: 'italic',
      fontSize: 'var(--font-size-sm)',
      padding: '6px 0',
    }}>{children}</div>
  )
}

function DesignPreview({
  design, testOverride, setTestOverride,
  distMode, setDistMode,
  distAndersonDarling, setDistAndersonDarling,
  distReferenceTag, setDistReferenceTag,
  metricOptions, selectedMetrics, setSelectedMetrics, defaultMetrics,
  statsLoading, statsError, hasResults, onRunStats,
  subsampleMode, setSubsampleMode, subsampleN, setSubsampleN, autoNHint,
}: {
  design: DesignInfo
  testOverride: TestOverride
  setTestOverride: (o: TestOverride) => void
  distMode: 'pooled_ks' | 'per_cell_ks_d' | 'off'
  setDistMode: (m: 'pooled_ks' | 'per_cell_ks_d' | 'off') => void
  distAndersonDarling: boolean
  setDistAndersonDarling: (v: boolean) => void
  distReferenceTag: string
  setDistReferenceTag: (t: string) => void
  metricOptions: string[]
  selectedMetrics: string[]
  setSelectedMetrics: React.Dispatch<React.SetStateAction<string[]>>
  defaultMetrics: string[]
  statsLoading: boolean
  statsError: string | null
  hasResults: boolean
  onRunStats: () => void
  subsampleMode: SubsampleMode
  setSubsampleMode: (m: SubsampleMode) => void
  subsampleN: number
  setSubsampleN: (n: number) => void
  autoNHint: number | null
}) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-field)',
      padding: 10,
      fontSize: 'var(--font-size-sm)',
    }}>
      <div style={{
        fontWeight: 600, marginBottom: 6,
        color: design.ready ? 'var(--text-primary)' : 'var(--text-muted)',
      }}>
        {design.name}
      </div>

      {/* Per-group n table */}
      {design.groups.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: '2px 12px',
          fontSize: 'var(--font-size-xs)',
          marginBottom: 8,
        }}>
          {design.groups.map((g) => (
            <React.Fragment key={g.tag}>
              <span>{g.tag}</span>
              <span className="num" style={{
                color: g.n < 2 ? 'var(--error)' : 'var(--text-primary)',
                fontWeight: g.n < 2 ? 700 : 400,
              }}>n = {g.n}</span>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Test recommendation + manual override.
          Auto: show both options + the Shapiro-decides note.
          Override: show only the chosen test + a note that the
          normality check is skipped. */}
      {design.ready && (
        <div style={{
          padding: '6px 8px',
          background: 'var(--bg-tertiary)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--font-size-xs)',
          marginBottom: 6,
        }}>
          {testOverride === 'auto' ? (
            <>
              <div style={{ marginBottom: 2 }}>
                <span style={{ color: 'var(--text-muted)' }}>If normal: </span>
                <span>{design.test_normal}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>If non-normal: </span>
                <span>{design.test_nonparam}</span>
              </div>
              <div style={{
                color: 'var(--text-muted)',
                marginTop: 4,
                fontStyle: 'italic',
              }}>
                Shapiro-Wilk on each group decides which branch runs.
              </div>
            </>
          ) : (
            <>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Forced: </span>
                <span style={{ fontWeight: 600 }}>
                  {design.test_chosen ?? '—'}
                </span>
              </div>
              <div style={{
                color: 'var(--text-muted)',
                marginTop: 4,
                fontStyle: 'italic',
              }}>
                Normality check skipped — using your override.
              </div>
            </>
          )}

          {/* Override radio. Stays visible even when ``auto`` is
              selected so the user can flip without hunting. Compact
              row of three radios; same pattern as the comparison-
              shape selector at the top of the wizard. */}
          <div style={{
            marginTop: 8,
            paddingTop: 6,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}>
            <div style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-muted)',
              fontWeight: 600,
              marginBottom: 2,
            }}>Override:</div>
            {([
              ['auto', 'Auto (Shapiro-Wilk decides)'],
              ['parametric', `Force parametric (${design.test_normal})`],
              ['nonparametric', `Force non-parametric (${design.test_nonparam})`],
            ] as [TestOverride, string][]).map(([value, label]) => (
              <label
                key={value}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 'var(--font-size-xs)',
                }}
              >
                <input
                  type="radio"
                  name="testOverride"
                  checked={testOverride === value}
                  onChange={() => setTestOverride(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {/* Distribution-metric tests (K-S family). Works for both
              unpaired and paired designs — pooled K-S asks "do the
              two distributions differ" regardless of whether the
              cells were matched, which is what mEPSC pre/post and
              minis-vs-treatment papers report. Per-cell K-S D feeds
              its scalars through the design-aware test runner so
              paired designs get Wilcoxon on the per-cell D's. */}
          <div style={{
            marginTop: 8,
            paddingTop: 6,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}>
            <div style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-muted)',
              fontWeight: 600,
              marginBottom: 2,
            }}>Distribution metrics:</div>
            {([
              ['pooled_ks', 'Pooled K-S (mEPSC convention)'],
              ['per_cell_ks_d', 'Per-cell K-S D vs reference'],
              ['off', 'Off (graphs only)'],
            ] as ['pooled_ks' | 'per_cell_ks_d' | 'off', string][]).map(([value, label]) => (
              <label
                key={value}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 'var(--font-size-xs)',
                }}
              >
                <input
                  type="radio"
                  name="distMode"
                  checked={distMode === value}
                  onChange={() => setDistMode(value)}
                />
                <span>{label}</span>
              </label>
            ))}
            {/* Anderson-Darling toggle — only relevant for 3+ groups
                under pooled K-S (oneway_n or rm_n). Otherwise hidden
                so the panel doesn't carry a useless control. */}
            {distMode === 'pooled_ks' && design.groups.length > 2 && (
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-xs)',
                marginTop: 4,
                marginLeft: 16,
              }}>
                <input
                  type="checkbox"
                  checked={distAndersonDarling}
                  onChange={(e) => setDistAndersonDarling(e.target.checked)}
                />
                <span>Use Anderson-Darling k-sample (one p across all groups)</span>
              </label>
            )}
            {/* Reference-group picker for per-cell K-S D — only
                rendered when that mode is active. Empty string
                falls through to "first group". */}
            {distMode === 'per_cell_ks_d' && design.groups.length >= 2 && (
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-xs)',
                marginTop: 4,
                marginLeft: 16,
              }}>
                <span style={{ color: 'var(--text-muted)' }}>Reference:</span>
                <select
                  value={distReferenceTag || design.groups[0].tag}
                  onChange={(e) => setDistReferenceTag(e.target.value)}
                  style={{ fontSize: 'var(--font-size-xs)' }}
                >
                  {design.groups.map((g) => (
                    <option key={g.tag} value={g.tag}>{g.tag}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      )}

      {/* Unassigned cells warning */}
      {design.unassigned.length > 0 && (
        <div className="notice notice-warning" style={{
          fontSize: 'var(--font-size-xs)',
          marginBottom: 6,
        }}>
          <div style={{ fontWeight: 600 }}>
            {design.unassigned.length} cell{design.unassigned.length === 1 ? '' : 's'} excluded
          </div>
          <div style={{ marginTop: 2, lineHeight: 1.4 }}>
            They don't carry exactly one of the selected tags
            {design.groups.length > 0 ? '' : ' (or no tags are selected yet)'}.
            Hover the file names in the cell preview to inspect.
          </div>
        </div>
      )}

      {/* Missing-animal-id warning — only shows under N=animal. */}
      {design.missingAnimalId.length > 0 && (
        <div
          title={design.missingAnimalId.map((c) => c.file_name).join('\n')}
          className="notice notice-error"
          style={{
            fontSize: 'var(--font-size-xs)',
            marginBottom: 6,
            cursor: 'help',
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {design.missingAnimalId.length} cell{design.missingAnimalId.length === 1 ? '' : 's'} missing Animal ID
          </div>
          <div style={{ marginTop: 2, lineHeight: 1.4 }}>
            N = animal can't group these — set their Animal ID in the
            metadata window. Hover for file names.
          </div>
        </div>
      )}

      {/* Metric multi-select. Pre-checked entries come from the
          analysis type's curated default list; everything else is
          one click away. This is a focused subset of what the full
          B.5 metric tree will offer (per-metric role + subsampling
          controls land there). */}
      {design.ready && metricOptions.length > 0 && (
        <MetricMultiSelect
          options={metricOptions}
          selected={selectedMetrics}
          setSelected={setSelectedMetrics}
          defaults={defaultMetrics}
          disabled={statsLoading}
        />
      )}

      {/* Per-cell event subsampling. Only visible when there's at
          least one distribution metric in scope (autoNHint != null
          implies the design has distributions). Same config is
          applied to graphs, stats and exports so all three views
          show identical subsampled values. */}
      {autoNHint !== null && (
        <div style={{
          marginTop: 8,
          padding: '6px 8px',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-secondary)',
        }}>
          <div style={{
            fontSize: 'var(--font-size-xs)',
            fontWeight: 600,
            color: 'var(--text-muted)',
            marginBottom: 4,
          }}>Events per cell</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={subsampleMode}
              onChange={(e) => setSubsampleMode(e.target.value as SubsampleMode)}
            >
              <option value="all">All events</option>
              <option value="first">First N</option>
              <option value="last">Last N</option>
              <option value="random">Random N</option>
              <option value="auto">Auto (= min)</option>
            </select>
            {(subsampleMode === 'first' || subsampleMode === 'last' || subsampleMode === 'random') && (
              <input
                type="number"
                min={1}
                value={subsampleN}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v) && v > 0) setSubsampleN(v)
                }}
                style={{ width: 70 }}
                title="N events to keep per cell"
              />
            )}
            <span style={{
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-xs)',
            }}>
              {subsampleMode === 'auto' && `auto = ${autoNHint} (smallest cell's count)`}
              {subsampleMode === 'all' && 'all events kept'}
              {subsampleMode === 'random' && '(deterministic seed per cell)'}
              {(subsampleMode === 'first' || subsampleMode === 'last')
                && (autoNHint > 0 ? `min cell has ${autoNHint}` : '')}
            </span>
          </div>
        </div>
      )}

      {/* Run-stats button. Live-wired to /api/cohort/run_stats —
          one POST per selected metric, in parallel. */}
      <button
        className={design.ready ? 'btn btn-primary btn-lg' : 'btn btn-lg'}
        onClick={onRunStats}
        disabled={!design.ready || statsLoading || selectedMetrics.length === 0}
        title={!design.ready
          ? 'Pick at least 2 tags with ≥ 2 cells each before running stats.'
          : selectedMetrics.length === 0
          ? 'Tick at least one metric to test.'
          : `Run the inferred test on ${selectedMetrics.length} metric${selectedMetrics.length === 1 ? '' : 's'}.`}
        style={{
          width: '100%', marginTop: 8,
          fontSize: 'var(--font-size-sm)', fontWeight: 600,
        }}
      >{statsLoading
          ? `Running… (${selectedMetrics.length})`
          : `Run stats on ${selectedMetrics.length} metric${selectedMetrics.length === 1 ? '' : 's'}`}</button>

      {statsError && (
        <div className="notice notice-error" style={{
          marginTop: 8,
          fontSize: 'var(--font-size-xs)',
        }}>{statsError}</div>
      )}

      {hasResults && (
        <div className="notice notice-info" style={{
          marginTop: 8,
          fontSize: 'var(--font-size-xs)',
          fontStyle: 'italic',
        }}>
          Results panel on the right. Edit the design or metrics above
          to invalidate them.
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Metric multi-select panel (B.4 — precursor to the full metric tree
// in B.5). Compact checkbox list with a "reset to defaults" affordance
// and a quick all/none pair. Sorted: defaults first (in their curated
// order), then the rest alphabetically.
// ---------------------------------------------------------------------
function MetricMultiSelect({
  options, selected, setSelected, defaults, disabled,
}: {
  options: string[]
  selected: string[]
  setSelected: React.Dispatch<React.SetStateAction<string[]>>
  defaults: string[]
  disabled: boolean
}) {
  const selectedSet = new Set(selected)
  const ordered = (() => {
    const front = defaults.filter((m) => options.includes(m))
    const rest = options.filter((m) => !front.includes(m)).sort()
    return [...front, ...rest]
  })()
  const toggle = (m: string) => {
    setSelected((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m])
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginBottom: 4,
      }}>
        <span style={{
          fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
          fontWeight: 600, flex: 1,
        }}>Metrics to test ({selected.length}/{options.length}):</span>
        <button
          className="btn btn-sm"
          onClick={() => setSelected(options)}
          disabled={disabled || selected.length === options.length}
        >All</button>
        <button
          className="btn btn-sm"
          onClick={() => setSelected([])}
          disabled={disabled || selected.length === 0}
        >None</button>
        <button
          className="btn btn-sm"
          onClick={() => setSelected(defaults.filter((m) => options.includes(m)))}
          disabled={disabled}
          title="Re-check the curated default metrics for this analysis type"
        >Defaults</button>
      </div>
      <div style={{
        border: '1px solid var(--border-control)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-field)',
        maxHeight: 180,
        overflowY: 'auto',
      }}>
        {ordered.map((m) => {
          const checked = selectedSet.has(m)
          const isDefault = defaults.includes(m)
          return (
            <label
              key={m}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 6px',
                fontSize: 'var(--font-size-xs)',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(m)}
                disabled={disabled}
              />
              <span style={{
                flex: 1,
                color: isDefault ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>{m}</span>
              {isDefault && (
                <span style={{
                  color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)',
                  fontStyle: 'italic',
                }}>default</span>
              )}
            </label>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Stats results panel — appears at the top of the right pane after
// a Run. One card per metric. Sorted to match the metric-picker
// order so the user reads them in the same sequence they ticked.
// ---------------------------------------------------------------------
function StatsResultsPanel({
  results, graphs, metrics, metricKindOf, onClear, backendUrl, themeName,
  graphPrefs, onUpdateGraphPrefs,
}: {
  results: Record<string, any>
  graphs: Record<string, any>
  metrics: string[]
  metricKindOf: (name: string) => 'scalar' | 'distribution' | 'timeseries' | null
  onClear: () => void
  backendUrl: string
  themeName: string
  graphPrefs: CohortGraphPrefs
  onUpdateGraphPrefs: (updater: (prev: CohortGraphPrefs) => CohortGraphPrefs) => void
}) {
  // Show a card for any metric that has a graph OR a stats result —
  // distribution/timeseries metrics only have graphs; scalars have
  // both. Order follows the user's pick order.
  const ordered = metrics.filter((m) => results[m] || graphs[m])
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards')
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center',
        gap: 8, marginBottom: 8,
      }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--font-size-base)' }}>
          Results ({ordered.length})
        </span>
        {/* View toggle. ``cards`` is the original grid with inline
            graphs and stats — best for visual exploration. ``table``
            is a compact tabular summary — best for scanning many
            metrics at once and copy-paste into a manuscript. */}
        <div className="segmented" style={{ marginLeft: 12 }}>
          {(['cards', 'table'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={viewMode === m ? 'active' : undefined}
              title={m === 'cards'
                ? 'Visual cards with inline graphs (default)'
                : 'Compact summary table — sortable, copyable'}
            >{m === 'cards' ? 'Cards' : 'Table'}</button>
          ))}
        </div>
        <button
          className="btn"
          onClick={onClear}
          style={{ marginLeft: 'auto' }}
        >Clear</button>
      </div>
      {viewMode === 'cards' ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
          gap: 10,
        }}>
          {ordered.map((m) => (
            <StatsResult
              key={m}
              metric={m}
              kind={metricKindOf(m)}
              result={results[m]}
              graph={graphs[m]}
              backendUrl={backendUrl}
              themeName={themeName}
              graphPrefs={graphPrefs}
              onUpdateGraphPrefs={onUpdateGraphPrefs}
            />
          ))}
        </div>
      ) : (
        <StatsTable
          metrics={ordered}
          results={results}
          metricKindOf={metricKindOf}
        />
      )}
    </div>
  )
}

function StatsResult({ metric, kind, result, graph, backendUrl, themeName,
  graphPrefs, onUpdateGraphPrefs,
}: {
  metric: string
  kind: 'scalar' | 'distribution' | 'timeseries' | null
  result: any | undefined        // optional — distribution/timeseries metrics have no stats
  graph: any | undefined         // optional — every metric should have a graph
  backendUrl: string
  themeName: string
  graphPrefs: CohortGraphPrefs
  onUpdateGraphPrefs: (updater: (prev: CohortGraphPrefs) => CohortGraphPrefs) => void
}) {
  // Empty placeholder for metrics with neither a stats result nor a
  // graph (shouldn't happen in practice — the panel filters them).
  if (!result && !graph) return null
  // Stats-side error (paired-length mismatch, n<2). Distribution
  // metrics have no stats path so a missing result here is normal —
  // only treat as an error when ``result.error`` is set.
  const statsError = result?.error ?? null
  const graphError = graph?.error ?? null
  const pStr = result?.p != null ? formatP(result.p) : null

  // Modal open/close. ``request`` is the original /render_graph
  // payload that produced ``graph.payload`` — the modal replays it
  // with axis / label / colour overrides on top, so opening the
  // modal is instant (only re-renders touch the backend).
  const [modalOpen, setModalOpen] = useState(false)
  const canOpenModal = !!(graph && graph.format === 'svg' && graph.payload && graph.request)

  // Inline SVG state. Starts from the runStats-cached payload, then
  // re-renders when ``graphPrefs`` change so cohort-wide group
  // styling propagates to every card and per-metric overrides
  // persist after the modal is closed. The re-render uses the same
  // ``graph.request`` seed as the original render — only ``overrides``
  // changes — so it's cheap.
  const [inlineSvg, setInlineSvg] = useState<string | null>(null)
  const initialRenderRef = useRef(true)

  useEffect(() => {
    // First effect run on mount: defer to the cached
    // ``graph.payload`` rather than fire a redundant render. We
    // only round-trip when prefs actually change.
    if (initialRenderRef.current) {
      initialRenderRef.current = false
      return
    }
    if (!canOpenModal || !backendUrl) return
    // If neither cohort-wide styling nor per-metric overrides are
    // set, the cached payload already reflects defaults — skip the
    // round-trip. Saves a request when the user only edited an
    // unrelated metric's per-metric overrides.
    const hasCohortWide =
      Object.keys(graphPrefs.groupColors).length > 0 ||
      Object.keys(graphPrefs.groupLabels).length > 0
    const hasPerMetric = !!graphPrefs.perMetric[metric]
    if (!hasCohortWide && !hasPerMetric) {
      // Wipe any stale custom render so the original payload shows.
      setInlineSvg(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const body = {
          ...graph.request,
          theme: themeName === 'light' ? 'light' : 'dark',
          width_in: 5.5,
          height_in: 4.0,
          output_format: 'svg',
          overrides: buildBackendOverrides(
            prefsForMetric(graphPrefs, metric),
            { groupColors: graphPrefs.groupColors, groupLabels: graphPrefs.groupLabels },
          ),
        }
        const resp = await fetch(`${backendUrl}/api/cohort/render_graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!resp.ok) return
        const json = await resp.json()
        if (!cancelled && json?.format === 'svg' && typeof json.payload === 'string') {
          setInlineSvg(json.payload)
        }
      } catch {
        // Best-effort — leave the cached payload up if the
        // re-render fails. We deliberately don't surface an error
        // here so a transient network blip doesn't paint every
        // card red.
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [graphPrefs, backendUrl, themeName, metric, canOpenModal,
      graph?.request])

  // The SVG actually displayed: prefer the prefs-aware re-render
  // when present, fall back to the runStats-cached payload.
  const displaySvg: string = inlineSvg ?? (graph?.payload ?? '')
  return (
    <div style={{
      padding: '8px 10px',
      border: `1px solid ${statsError || graphError ? 'var(--error)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-secondary)',
      fontSize: 'var(--font-size-xs)',
    }}>
      {/* Metric name as the card title; kind tag in muted small. */}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 6,
        paddingBottom: 4, marginBottom: 6,
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontWeight: 600,
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-primary)',
        }}>{metric}</span>
        {kind && (
          <span style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-muted)',
          }}>· {kind}</span>
        )}
        {canOpenModal && (
          <button
            className="btn btn-sm"
            onClick={() => setModalOpen(true)}
            title="Open in fullscreen modal — adjust axes, labels, colours, and export."
            style={{ marginLeft: 'auto' }}
          >Expand</button>
        )}
      </div>

      {/* Inline graph (SVG). When the backend returned an SVG payload
          it carries its own viewBox; we drop it into a constrained
          height and let it scale fluidly to the card width. Click
          opens the modal — same behaviour as the Expand button so
          users can hit either. Right-click → Copy/Save SVG or PNG
          via the shared PlotMenu. */}
      {graph && graph.format === 'svg' && displaySvg && (
        <CohortGraphInline
          svg={displaySvg}
          metric={metric}
          canOpenModal={canOpenModal}
          onOpenModal={() => setModalOpen(true)}
          marginBottom={result?.test ? 8 : 0}
        />
      )}
      {modalOpen && canOpenModal && (
        <GraphModal
          metric={metric}
          kind={kind}
          request={graph.request}
          initialSvg={displaySvg}
          backendUrl={backendUrl}
          themeName={themeName}
          graphPrefs={graphPrefs}
          onUpdatePrefs={onUpdateGraphPrefs}
          onClose={() => setModalOpen(false)}
        />
      )}
      {graphError && (
        <div style={{
          marginBottom: 6,
          color: 'var(--error)',
        }}>Graph: {graphError}</div>
      )}

      {/* Stats body — only for scalar metrics. Distribution &
          timeseries metrics show graph-only cards. */}
      {statsError ? (
        <div style={{
          color: 'var(--error)',
        }}>{statsError}</div>
      ) : result?.test ? (
        <>
          <div style={{
            fontWeight: 600,
            marginBottom: 4,
            color: 'var(--text-muted)',
          }}>{result.test}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
            {result.statistic != null && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{result.statistic_label}:</span>
                <span className="num">{Number(result.statistic).toFixed(3)}{result.df != null ? ` (df=${Number(result.df).toFixed(1)})` : ''}</span>
              </>
            )}
            <span style={{ color: 'var(--text-muted)' }}>p:</span>
            <span className="num" style={{ fontWeight: 700, color: result.p < 0.05 ? 'var(--success)' : 'var(--text-primary)' }}>
              {pStr}
            </span>
            {result.effect_size != null && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{result.effect_size_label}:</span>
                <span className="num">{Number(result.effect_size).toFixed(3)}</span>
              </>
            )}
          </div>
          {/* Per-group descriptives + Shapiro-Wilk normality. Shown
              unconditionally so users overriding to parametric still
              see the verdict. n<3 → 'no Shapiro'. */}
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {Object.entries(result.descriptives ?? {}).map(([tag, d]: [string, any]) => {
              const norm = result.normality?.[tag]
              const shapiroLabel = norm
                ? (norm.verdict === 'unknown'
                    ? 'n<3, no Shapiro'
                    : `Shapiro p=${formatP(norm.p)} (${norm.verdict})`)
                : null
              return (
                <div key={tag}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{tag}</span>
                    <span className="num" style={{ color: 'var(--text-muted)' }}>
                      n={d.n}{d.mean != null ? ` · ${Number(d.mean).toPrecision(3)}` : ''}
                      {d.sd != null ? ` ± ${Number(d.sd).toPrecision(3)}` : ''}
                    </span>
                  </div>
                  {shapiroLabel && (
                    <div style={{
                      display: 'flex', justifyContent: 'flex-end',
                      fontSize: 'var(--font-size-xs)',
                      color: norm?.verdict === 'non-normal' ? 'var(--warning)' : 'var(--text-muted)',
                    }}>{shapiroLabel}</div>
                  )}
                </div>
              )
            })}
          </div>
          {Array.isArray(result.posthoc) && result.posthoc.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>
                Post-hoc ({result.posthoc[0]?.method}):
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {result.posthoc.map((ph: any, i: number) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{ph.a} vs {ph.b}</span>
                    <span className="num" style={{
                      fontWeight: ph.p < 0.05 ? 700 : 400,
                      color: ph.p < 0.05 ? 'var(--success)' : 'var(--text-primary)',
                    }}>
                      p={formatP(ph.p)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Bottom note. Scalar tests carry an override/branch from
              the Shapiro gate; distribution K-S tests don't, but
              ``run_distribution_test`` returns its own ``note`` field
              with a one-line caveat (pseudoreplication / k-sample
              context). Render whichever is present. */}
          <div style={{
            marginTop: 6,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
            fontSize: 'var(--font-size-xs)',
          }}>
            {result.override
              ? (result.override === 'auto'
                  ? `Branch chosen automatically (${result.branch}); Shapiro decided.`
                  : `Branch forced (${result.branch}) by override.`)
              : (typeof result.note === 'string' ? result.note : '')}
          </div>
        </>
      ) : kind && kind !== 'scalar' ? (
        // Distribution / timeseries metrics with no stats result.
        // For distributions: either grouping is paired (K-S not
        // applicable) or the user set distMode=off. Timeseries has
        // no stats path implemented yet.
        <div style={{
          color: 'var(--text-muted)',
          fontStyle: 'italic',
          fontSize: 'var(--font-size-xs)',
        }}>
          {kind === 'distribution'
            ? 'Distribution stats turned off in the wizard. The graph above shows the per-cell ECDFs.'
            : 'Group mean ± SEM time series — no formal stats path.'}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------
// GraphModal — fullscreen overlay for editing + exporting a single
// cohort plot. Driven by the original /render_graph request payload
// that produced the inline preview; user tweaks (axis limits, labels,
// log-scale, per-group rename / recolor) are layered on top via the
// ``overrides`` field and the backend re-renders. SVG / PNG / PDF
// export uses the same overrides so the saved file matches what the
// user sees.
// ---------------------------------------------------------------------

/** Per-metric graph customisation. Stored under
 *  ``CohortGraphPrefs.perMetric[metric]`` so the modal can rehydrate
 *  the user's edits when re-opened, and inline cards can re-render
 *  with the same overrides applied. Group-level styling lives at the
 *  cohort-wide level (see ``CohortGraphPrefs.groupColors`` /
 *  ``.groupLabels``) since users almost always want consistent group
 *  identity across every chart in a cohort. */
type Overrides = {
  xlim_min: string  // text fields: empty string means "auto" (don't override)
  xlim_max: string
  ylim_min: string
  ylim_max: string
  xlabel: string | null  // null = keep server default
  ylabel: string | null
  title: string | null
  log_x: boolean
  log_y: boolean
  // Distribution-only flags. Ignored by scalar/timeseries plots
  // server-side, so safe to always send. Defaults match the
  // pre-modal inline render so the initial preview doesn't shift.
  abs_values: boolean
  show_individuals: boolean
  show_mean: boolean
  gaussian_overlay: boolean
  // Scalar-only. Stored even when kind!='scalar' so resetting and
  // switching plots later doesn't lose the user's preference.
  central_tendency: 'mean' | 'median'
  error_bar: 'sem' | 'sd' | 'ci95' | 'iqr' | 'range' | 'none'
  // Timeseries-only. ``show_individuals`` is shared with
  // distribution (same intent: faint per-cell traces underneath
  // the group summary).
  connect_lines: boolean
  show_band: boolean
  align_to_induction: boolean
}

function emptyOverrides(): Overrides {
  return {
    xlim_min: '', xlim_max: '',
    ylim_min: '', ylim_max: '',
    xlabel: null, ylabel: null, title: null,
    log_x: false,
    log_y: false,
    abs_values: false,
    show_individuals: true,
    show_mean: true,
    gaussian_overlay: false,
    central_tendency: 'mean',
    error_bar: 'sem',
    connect_lines: false,
    show_band: false,
    align_to_induction: true,
  }
}

/** Cohort-wide graph customisation persistence.
 *
 *  Two scopes deliberately separated so the propagation behaviour
 *  matches user intent:
 *    * ``groupColors`` / ``groupLabels`` — cohort-wide. Set the WT
 *      colour once in any modal and it shows up in every chart that
 *      contains the WT tag, including the inline cards. Users almost
 *      never want different colours for the same group across charts
 *      — that defeats the point of grouping.
 *    * ``perMetric`` — per-graph. Axis ranges, labels, log scales,
 *      kind-specific toggles. Each metric has its own appropriate
 *      view; e.g. ``events.iei_ms`` wants log-X but
 *      ``events.amplitude_pa`` doesn't.
 *
 *  Persisted to Electron preferences keyed by absolute folder path,
 *  so the same cohort folder retains its styling across sessions but
 *  unrelated folders start fresh. */
type CohortGraphPrefs = {
  groupColors: Record<string, string>  // canonical_tag → '#hex'
  groupLabels: Record<string, string>  // canonical_tag → display name
  perMetric: Record<string, Overrides> // metric_name → per-metric overrides
}

function emptyGraphPrefs(): CohortGraphPrefs {
  return { groupColors: {}, groupLabels: {}, perMetric: {} }
}

/** Coerce a previously-persisted prefs blob (loaded from Electron
 *  preferences) into a well-shaped ``CohortGraphPrefs``. Defends
 *  against schema drift between releases — anything missing or with
 *  the wrong type collapses to the safe default. Old entries that
 *  predate a new field still load cleanly. */
function normalizeGraphPrefs(raw: any): CohortGraphPrefs {
  const out = emptyGraphPrefs()
  if (raw && typeof raw === 'object') {
    if (raw.groupColors && typeof raw.groupColors === 'object') {
      for (const [k, v] of Object.entries(raw.groupColors)) {
        if (typeof v === 'string' && v.startsWith('#')) out.groupColors[k] = v
      }
    }
    if (raw.groupLabels && typeof raw.groupLabels === 'object') {
      for (const [k, v] of Object.entries(raw.groupLabels)) {
        if (typeof v === 'string') out.groupLabels[k] = v
      }
    }
    if (raw.perMetric && typeof raw.perMetric === 'object') {
      for (const [metric, ov] of Object.entries(raw.perMetric)) {
        if (ov && typeof ov === 'object') {
          out.perMetric[metric] = { ...emptyOverrides(), ...(ov as Partial<Overrides>) }
        }
      }
    }
  }
  return out
}

/** Read the effective per-metric overrides — falls back to a fresh
 *  empty Overrides when the user hasn't customised this metric yet.
 *  Centralised here so every site that consumes prefs handles the
 *  "no overrides yet" path identically. */
function prefsForMetric(prefs: CohortGraphPrefs, metric: string): Overrides {
  return prefs.perMetric[metric] || emptyOverrides()
}

/** Translate per-metric ``Overrides`` + cohort-wide group styling
 *  into the wire shape the backend expects. Empty strings collapse
 *  to ``null`` so the backend knows to keep its own default; numbers
 *  parse leniently (NaN drops the override rather than crashing).
 *  Group colours / labels live in the cohort-wide map and are
 *  injected here at request time so every metric's request inherits
 *  the same styling. */
function buildBackendOverrides(
  o: Overrides,
  cohortWide: { groupColors: Record<string, string>; groupLabels: Record<string, string> },
): any {
  // Each axis range is sent as ``[min|null, max|null]`` — null
  // means "leave matplotlib's autoscale alone for this side". The
  // backend reads the current limit when it sees null and only
  // overrides the side the user actually filled in. Lets the user
  // pin one bound (e.g. force min to 0) without having to type
  // both. Empty string → null; non-numeric (parseFloat NaN) → null.
  const parseSide = (s: string): number | null => {
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : null
  }
  const xMinN = parseSide(o.xlim_min)
  const xMaxN = parseSide(o.xlim_max)
  const yMinN = parseSide(o.ylim_min)
  const yMaxN = parseSide(o.ylim_max)
  const xlim = (xMinN !== null || xMaxN !== null) ? [xMinN, xMaxN] : null
  const ylim = (yMinN !== null || yMaxN !== null) ? [yMinN, yMaxN] : null
  const labels: Record<string, string> = {}
  for (const [k, v] of Object.entries(cohortWide.groupLabels)) if (v) labels[k] = v
  const colors: Record<string, string> = {}
  for (const [k, v] of Object.entries(cohortWide.groupColors)) if (v) colors[k] = v
  return {
    xlim, ylim,
    xlabel: o.xlabel,
    ylabel: o.ylabel,
    title: o.title,
    log_x: o.log_x,
    log_y: o.log_y,
    group_labels: Object.keys(labels).length ? labels : null,
    group_colors: Object.keys(colors).length ? colors : null,
    abs_values: o.abs_values,
    show_individuals: o.show_individuals,
    show_mean: o.show_mean,
    gaussian_overlay: o.gaussian_overlay,
    central_tendency: o.central_tendency,
    error_bar: o.error_bar,
    connect_lines: o.connect_lines,
    show_band: o.show_band,
    align_to_induction: o.align_to_induction,
  }
}

/** Sanitise a metric name into a filesystem-friendly default
 *  filename. Replaces non-alphanumeric / non-dash / non-dot with
 *  underscores so the user's chosen path is well-formed without
 *  needing an explicit rename step. */
function safeFileName(s: string): string {
  return (s || 'graph').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
}

function GraphModal({
  metric, kind, request, initialSvg, onClose, backendUrl, themeName,
  graphPrefs, onUpdatePrefs,
}: {
  metric: string
  kind: 'scalar' | 'distribution' | 'timeseries' | null
  request: any
  initialSvg: string
  onClose: () => void
  backendUrl: string
  themeName: string
  graphPrefs: CohortGraphPrefs
  onUpdatePrefs: (updater: (prev: CohortGraphPrefs) => CohortGraphPrefs) => void
}) {
  const groupTags: string[] = useMemo(
    () => (request?.groups || []).map((g: any) => String(g?.tag ?? '')).filter((s: string) => s),
    [request],
  )
  // The modal is controlled by the parent's ``graphPrefs``. Every
  // tweak commits straight back through ``onUpdatePrefs`` so the
  // edit survives modal close AND propagates to inline cards (for
  // cohort-wide group colour / label changes) without a separate
  // "save" step. Keeps two scopes deliberately separate:
  //   * per-metric → ``prefs.perMetric[metric]``
  //   * cohort-wide → ``prefs.groupColors`` / ``prefs.groupLabels``
  const overrides = prefsForMetric(graphPrefs, metric)
  const [currentSvg, setCurrentSvg] = useState<string>(initialSvg)
  const [rendering, setRendering] = useState(false)
  const [renderErr, setRenderErr] = useState<string | null>(null)
  const [savingFmt, setSavingFmt] = useState<null | 'svg' | 'png' | 'pdf'>(null)

  // Modal render dimensions. INTENTIONALLY match the inline render
  // (5.5×4 in) so the visual proportions of text, line widths,
  // marker sizes and axis spines stay identical — matplotlib
  // treats those as absolute points, not relative units, so a
  // larger figure makes everything look proportionally smaller
  // even though it's the "same" chart. The modal scales the SVG
  // up to fill its chart pane via ``viewBox`` (vector, no quality
  // loss), so the user gets a bigger view of identical proportions.
  // PNG/PDF exports inherit the same 5.5×4 base, which at 300 dpi
  // is 1650×1200 px — publication-grade. A future "figure size"
  // control in the modal can override per-export when needed.
  const widthIn = 5.5
  const heightIn = 4.0

  // Track whether the initial mount has happened. The very first
  // render uses ``initialSvg`` (the parent's already-rendered card)
  // and skips the round-trip; subsequent prefs changes do hit the
  // backend. This stops "open modal → useEffect on mount" from
  // doing a redundant render when prefs haven't changed yet.
  const firstRenderRef = useRef(true)
  useEffect(() => {
    // ``graphPrefs`` is the dep that triggers re-render. Both
    // per-metric and cohort-wide changes flow through here since
    // both are slices of the same prefs object.
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      // Only skip the initial render when there are NO existing
      // prefs for this metric or group styling — otherwise the
      // user opens the modal and sees an unstyled chart while
      // the backend catches up. With prefs already populated, we
      // do want an immediate round-trip so the modal preview
      // reflects them.
      const ov = prefsForMetric(graphPrefs, metric)
      const hasPerMetric = Object.values(ov).some(
        (v) => v !== '' && v !== null && v !== false &&
               !(typeof v === 'string' && v === 'mean') &&
               !(typeof v === 'string' && v === 'sem') &&
               !(v === true && true),  // booleans default true (show_individuals etc.) need explicit check
      )
      // Cheap heuristic: if any prefs at all, do the initial render.
      const hasCohortWide =
        Object.keys(graphPrefs.groupColors).length > 0 ||
        Object.keys(graphPrefs.groupLabels).length > 0
      if (!hasPerMetric && !hasCohortWide) {
        return
      }
    }
    let cancelled = false
    const t = setTimeout(async () => {
      if (!backendUrl) return
      setRendering(true)
      setRenderErr(null)
      try {
        const body = {
          ...request,
          theme: themeName === 'light' ? 'light' : 'dark',
          width_in: widthIn,
          height_in: heightIn,
          output_format: 'svg',
          overrides: buildBackendOverrides(
            prefsForMetric(graphPrefs, metric),
            { groupColors: graphPrefs.groupColors, groupLabels: graphPrefs.groupLabels },
          ),
        }
        const resp = await fetch(`${backendUrl}/api/cohort/render_graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
        const json = await resp.json()
        if (cancelled) return
        if (json?.format === 'svg' && typeof json.payload === 'string') {
          setCurrentSvg(json.payload)
        } else if (json?.error) {
          setRenderErr(String(json.error))
        }
      } catch (err) {
        if (!cancelled) setRenderErr(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setRendering(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [graphPrefs, backendUrl, request, themeName, widthIn, heightIn, metric])

  // Patch helpers commit straight to ``graphPrefs``. The modal
  // becomes a thin view of prefs; closing it doesn't lose state.
  const patch = useCallback(<K extends keyof Overrides>(key: K, value: Overrides[K]) => {
    onUpdatePrefs((prev) => ({
      ...prev,
      perMetric: {
        ...prev.perMetric,
        [metric]: {
          ...prefsForMetric(prev, metric),
          [key]: value,
        },
      },
    }))
  }, [onUpdatePrefs, metric])

  const patchGroupLabel = useCallback((tag: string, label: string) => {
    onUpdatePrefs((prev) => ({
      ...prev,
      groupLabels: { ...prev.groupLabels, [tag]: label },
    }))
  }, [onUpdatePrefs])
  const patchGroupColor = useCallback((tag: string, color: string) => {
    onUpdatePrefs((prev) => ({
      ...prev,
      groupColors: { ...prev.groupColors, [tag]: color },
    }))
  }, [onUpdatePrefs])

  // Reset the per-metric overrides for THIS metric only. Group
  // colours / labels (cohort-wide) are NOT cleared — those
  // intentionally span every chart and the user almost always
  // wants them to persist. ``Reset all groups`` below clears
  // those when the user explicitly asks.
  const reset = useCallback(() => {
    onUpdatePrefs((prev) => {
      const nextPerMetric = { ...prev.perMetric }
      delete nextPerMetric[metric]
      return { ...prev, perMetric: nextPerMetric }
    })
    setCurrentSvg(initialSvg)
    setRenderErr(null)
  }, [onUpdatePrefs, metric, initialSvg])

  const resetGroupStyling = useCallback(() => {
    onUpdatePrefs((prev) => ({ ...prev, groupColors: {}, groupLabels: {} }))
  }, [onUpdatePrefs])

  // Esc closes the modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const exportFormat = useCallback(async (fmt: 'svg' | 'png' | 'pdf') => {
    const api = window.electronAPI
    if (!api?.saveFileDialog) {
      setRenderErr('Save not available — Electron bridge missing.')
      return
    }
    setSavingFmt(fmt)
    setRenderErr(null)
    try {
      let payload: string
      let isBinary: boolean
      if (fmt === 'svg') {
        // SVG is already current in ``currentSvg``; no need to round-trip.
        payload = currentSvg
        isBinary = false
      } else {
        const body = {
          ...request,
          theme: themeName === 'light' ? 'light' : 'dark',
          width_in: widthIn,
          height_in: heightIn,
          output_format: fmt,
          dpi: 300,  // export-quality
          overrides: buildBackendOverrides(
            prefsForMetric(graphPrefs, metric),
            { groupColors: graphPrefs.groupColors, groupLabels: graphPrefs.groupLabels },
          ),
        }
        const resp = await fetch(`${backendUrl}/api/cohort/render_graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
        const json = await resp.json()
        if (typeof json?.payload !== 'string') {
          throw new Error('Backend returned no payload')
        }
        payload = json.payload
        isBinary = true
      }
      const ext = fmt
      const filterName = fmt.toUpperCase()
      const defaultName = `${safeFileName(metric)}.${ext}`
      const target = await api.saveFileDialog(defaultName, [
        { name: filterName, extensions: [ext] },
      ])
      if (!target) return  // user cancelled
      const writer = isBinary ? api.writeBinaryFile : api.writeTextFile
      if (!writer) throw new Error(`writer for ${fmt} not exposed`)
      const result = await writer(target, payload)
      if (!result?.ok) throw new Error(result?.error || 'write failed')
    } catch (err) {
      setRenderErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingFmt(null)
    }
  }, [currentSvg, request, backendUrl, themeName, metric, widthIn, heightIn])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        zIndex: 1000,
        display: 'flex', alignItems: 'stretch', justifyContent: 'stretch',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: 24,
          flex: 1,
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-popover)',
          display: 'grid',
          gridTemplateColumns: '1fr 320px',
          gridTemplateRows: 'auto 1fr',
          overflow: 'hidden',
        }}
      >
        <div style={{
          gridColumn: '1 / span 2',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <button
            className="btn"
            onClick={onClose}
            title="Close (Esc)"
          >×</button>
          <span style={{
            fontWeight: 600,
            fontSize: 'var(--font-size-sm)',
          }}>{metric}</span>
          {kind && (
            <span style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-muted)',
            }}>· {kind}</span>
          )}
          {rendering && (
            <span style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-muted)',
            }}>Rendering…</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              className="btn"
              onClick={() => exportFormat('svg')}
              disabled={savingFmt !== null}
              title="Export as SVG (vector, JetBrains Mono preserved as font reference, editable in Illustrator/Inkscape)"
            >{savingFmt === 'svg' ? 'Saving…' : 'Save SVG'}</button>
            <button
              className="btn"
              onClick={() => exportFormat('png')}
              disabled={savingFmt !== null}
              title="Export as PNG (raster, 300 dpi, JetBrains Mono baked in as glyphs)"
            >{savingFmt === 'png' ? 'Saving…' : 'Save PNG'}</button>
            <button
              className="btn"
              onClick={() => exportFormat('pdf')}
              disabled={savingFmt !== null}
              title="Export as PDF (vector, JetBrains Mono subset embedded — fully portable)"
            >{savingFmt === 'pdf' ? 'Saving…' : 'Save PDF'}</button>
          </div>
        </div>

        <CohortGraphModalView svg={currentSvg} metric={metric} />


        <div style={{
          borderLeft: '1px solid var(--border)',
          padding: 12,
          overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10,
          fontSize: 'var(--font-size-xs)',
        }}>
          {renderErr && (
            <div className="notice notice-error" style={{
              fontSize: 'var(--font-size-xs)',
              wordBreak: 'break-word',
            }}>{renderErr}</div>
          )}

          <ModalSection title="Title & labels">
            <ModalTextRow
              label="Title"
              placeholder={request?.title ?? ''}
              value={overrides.title ?? ''}
              onChange={(v) => patch('title', v)}
            />
            <ModalTextRow
              label="X label"
              placeholder={request?.xlabel ?? '(auto)'}
              value={overrides.xlabel ?? ''}
              onChange={(v) => patch('xlabel', v)}
            />
            <ModalTextRow
              label="Y label"
              placeholder={request?.ylabel ?? '(auto)'}
              value={overrides.ylabel ?? ''}
              onChange={(v) => patch('ylabel', v)}
            />
          </ModalSection>

          <ModalSection title="Axes">
            <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr', gap: 4, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>X range</span>
              <input
                type="number"
                placeholder="auto min"
                value={overrides.xlim_min}
                onChange={(e) => patch('xlim_min', e.target.value)}
                style={modalInputStyle}
              />
              <input
                type="number"
                placeholder="auto max"
                value={overrides.xlim_max}
                onChange={(e) => patch('xlim_max', e.target.value)}
                style={modalInputStyle}
              />
              <span style={{ color: 'var(--text-muted)' }}>Y range</span>
              <input
                type="number"
                placeholder="auto min"
                value={overrides.ylim_min}
                onChange={(e) => patch('ylim_min', e.target.value)}
                style={modalInputStyle}
              />
              <input
                type="number"
                placeholder="auto max"
                value={overrides.ylim_max}
                onChange={(e) => patch('ylim_max', e.target.value)}
                style={modalInputStyle}
              />
            </div>
            {/* Log axis toggle. For ECDFs the metric value lives on
                X (cumulative probability is on Y, fixed at [0,1]),
                so we offer Log X. For scalar/timeseries the metric
                value lives on Y, so Log Y. Showing only the
                relevant one keeps the surface honest. */}
            {kind === 'distribution' ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={overrides.log_x}
                  onChange={(e) => patch('log_x', e.target.checked)}
                />
                <span>Log X axis</span>
              </label>
            ) : (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={overrides.log_y}
                  onChange={(e) => patch('log_y', e.target.checked)}
                />
                <span>Log Y axis</span>
              </label>
            )}
          </ModalSection>

          {/* Scalar-specific options. Pairing convention:
                * mean   → SEM / SD / 95 % CI / none
                * median → IQR / range / none
              We filter the spread choices by the central tendency
              so the modal can't propose nonsensical combinations
              like "median ± SEM". The chart auto-captions itself
              with whatever was actually drawn so figures saved
              from the modal stay self-documenting. */}
          {kind === 'scalar' && (
            <ModalSection title="Strip plot">
              <div style={{ marginBottom: 4, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Dots = individual cells. Heavy line = central
                tendency. Whiskers = chosen spread.
              </div>
              <label style={{ display: 'grid', gridTemplateColumns: '80px 1fr', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>Centre</span>
                <select
                  value={overrides.central_tendency}
                  onChange={(e) => {
                    const ct = e.target.value as 'mean' | 'median'
                    // When switching central tendency, snap the
                    // error-bar choice to a sensible default for
                    // the new pairing rather than leaving the user
                    // with a mismatched combo. Combined patch so
                    // both fields commit in one prefs update.
                    onUpdatePrefs((prev) => {
                      const cur = prefsForMetric(prev, metric)
                      const newEB =
                        ct === 'median'
                          ? (['iqr', 'range', 'none'].includes(cur.error_bar) ? cur.error_bar : 'iqr')
                          : (['sem', 'sd', 'ci95', 'none'].includes(cur.error_bar) ? cur.error_bar : 'sem')
                      return {
                        ...prev,
                        perMetric: {
                          ...prev.perMetric,
                          [metric]: {
                            ...cur,
                            central_tendency: ct,
                            error_bar: newEB as Overrides['error_bar'],
                          },
                        },
                      }
                    })
                  }}
                  style={modalInputStyle}
                >
                  <option value="mean">mean</option>
                  <option value="median">median</option>
                </select>
              </label>
              <label style={{ display: 'grid', gridTemplateColumns: '80px 1fr', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>Whiskers</span>
                <select
                  value={overrides.error_bar}
                  onChange={(e) => patch('error_bar', e.target.value as Overrides['error_bar'])}
                  style={modalInputStyle}
                >
                  {overrides.central_tendency === 'mean' ? (
                    <>
                      <option value="sem">± SEM</option>
                      <option value="sd">± SD</option>
                      <option value="ci95">± 95 % CI</option>
                      <option value="none">none</option>
                    </>
                  ) : (
                    <>
                      <option value="iqr">IQR (Q1–Q3)</option>
                      <option value="range">range (min–max)</option>
                      <option value="none">none</option>
                    </>
                  )}
                </select>
              </label>
            </ModalSection>
          )}

          {/* Time-series-specific options. Default is markers +
              error bars + faint per-cell traces — the canonical
              LTP / fEPSP plot style. Connecting lines and SEM
              band are opt-in for users with continuous-signal
              data or who prefer the older aesthetic. */}
          {kind === 'timeseries' && (
            <ModalSection title="Time series">
              <div style={{ marginBottom: 4, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Markers = bin means. Error bars = chosen spread.
                Faint lines = individual cells.
              </div>
              <label style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>Error bars</span>
                <select
                  value={overrides.error_bar}
                  onChange={(e) => patch('error_bar', e.target.value as Overrides['error_bar'])}
                  style={modalInputStyle}
                >
                  <option value="sem">± SEM</option>
                  <option value="sd">± SD</option>
                  <option value="ci95">± 95 % CI</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.connect_lines}
                  onChange={(e) => patch('connect_lines', e.target.checked)}
                />
                <span title="Draw a thin line connecting bin means across time. Off = pure markers, the canonical LTP plot style.">
                  Connect markers with line
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.show_band}
                  onChange={(e) => patch('show_band', e.target.checked)}
                />
                <span title="Draw a filled ±spread band under the markers. Use the matching error_bar choice for the band width.">
                  Show SEM band
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.show_individuals}
                  onChange={(e) => patch('show_individuals', e.target.checked)}
                />
                <span title="Show one faded trace per cell underneath the group markers. Hide when individual cells add too much visual noise.">
                  Show individual cells
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.align_to_induction}
                  onChange={(e) => patch('align_to_induction', e.target.checked)}
                />
                <span title="Re-zero each group's time axis at its own induction bin: baseline becomes negative, tetanus is at 0, post-tetanus is positive (canonical LTP plot layout). Off = absolute time from recording start.">
                  Time 0 at induction
                </span>
              </label>
            </ModalSection>
          )}

          {/* Distribution-specific toggles. ``abs_values`` folds
              signed amplitudes (EPSC events at negative pA) into
              the positive half-line — required to make Log X mean
              anything. ``show_individuals`` / ``show_mean`` let
              the user diagnose the mean-ECDF artifact that shows
              up when cells have wildly different value ranges
              (common for IEI distributions). ``gaussian_overlay``
              fits N(μ, σ) on each group's pooled events and draws
              the analytic CDF as a dashed reference. */}
          {kind === 'distribution' && (
            <ModalSection title="Distribution">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.abs_values}
                  onChange={(e) => patch('abs_values', e.target.checked)}
                />
                <span title="Plot |x| instead of x. Fold signed amplitudes (EPSCs at negative pA) onto the positive half-line — required for log X.">
                  Absolute values
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.show_individuals}
                  onChange={(e) => patch('show_individuals', e.target.checked)}
                />
                <span title="Show one faded ECDF per cell.">
                  Show individual cells
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.show_mean}
                  onChange={(e) => patch('show_mean', e.target.checked)}
                />
                <span title="Show the bold per-group mean ECDF. Hide it when cells have very different value ranges and the mean curve looks misleading.">
                  Show group mean
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overrides.gaussian_overlay}
                  onChange={(e) => patch('gaussian_overlay', e.target.checked)}
                />
                <span title="Overlay each group's fitted N(μ, σ) CDF as a dashed line — visual normality reference (Lilliefors-style).">
                  Gaussian overlay
                </span>
              </label>
            </ModalSection>
          )}

          {groupTags.length > 0 && (
            <ModalSection title={`Groups (${groupTags.length})`}>
              {groupTags.map((tag) => (
                <div key={tag} style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr',
                  gap: 6,
                  alignItems: 'center',
                  marginBottom: 4,
                }}>
                  <input
                    type="color"
                    value={graphPrefs.groupColors[tag] || '#888888'}
                    onChange={(e) => patchGroupColor(tag, e.target.value)}
                    style={{
                      width: 36, height: 22, padding: 0, border: '1px solid var(--border-control)',
                      borderRadius: 'var(--radius-sm)', background: 'transparent',
                    }}
                    title={`Colour for ${tag} (cohort-wide — applies to every chart in this cohort)`}
                  />
                  <input
                    type="text"
                    placeholder={tag}
                    value={graphPrefs.groupLabels[tag] || ''}
                    onChange={(e) => patchGroupLabel(tag, e.target.value)}
                    style={modalInputStyle}
                    title={`Display name for "${tag}" (cohort-wide — empty = use canonical tag)`}
                  />
                </div>
              ))}
            </ModalSection>
          )}

          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <button
              className="btn"
              onClick={reset}
              title={`Clear per-metric overrides for "${metric}" only. Group colours / labels (cohort-wide) are kept.`}
            >Reset this graph</button>
            <button
              className="btn"
              onClick={resetGroupStyling}
              title="Clear all cohort-wide group colours and display names so every chart falls back to the default palette + canonical tags."
            >Reset all groups</button>
          </div>
        </div>
      </div>
    </div>
  )
}

const modalInputStyle: React.CSSProperties = {
  width: '100%',
}

/**
 * Inline cohort graph card with right-click → Copy/Save SVG/PNG via
 * the shared ``usePlotMenu`` hook. Filename defaults to ``<metric>``
 * so users get e.g. ``rate_hz.svg`` straight out of the dialog.
 *
 * Click still opens the modal (existing behavior) — the context
 * menu intercepts right-click before that.
 */
function CohortGraphInline({
  svg, metric, canOpenModal, onOpenModal, marginBottom,
}: {
  svg: string
  metric: string
  canOpenModal: boolean
  onOpenModal: () => void
  marginBottom: number
}) {
  const { onContextMenu, menu } = usePlotMenu({
    getSvg: () => svg,
    defaultName: metric,
  })
  return (
    <div
      onClick={canOpenModal ? onOpenModal : undefined}
      onContextMenu={onContextMenu}
      title={canOpenModal ? 'Click to expand and edit axes / colours / labels.' : undefined}
      style={{
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 3,
        padding: 4,
        marginBottom,
        overflow: 'hidden',
        cursor: canOpenModal ? 'zoom-in' : 'default',
        position: 'relative',
      }}
    >
      {menu}
      <div dangerouslySetInnerHTML={{ __html: stripSvgFixedSize(svg) }} />
    </div>
  )
}

/** Modal-view counterpart to ``CohortGraphInline`` — same right-click
 *  affordances, no click-to-expand (we're already in the modal). */
function CohortGraphModalView({ svg, metric }: { svg: string; metric: string }) {
  const { onContextMenu, menu } = usePlotMenu({
    getSvg: () => svg,
    defaultName: metric,
  })
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        padding: 14,
        overflow: 'auto',
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}
    >
      {menu}
      <div
        style={{ width: '100%', maxWidth: '100%' }}
        dangerouslySetInnerHTML={{ __html: stripSvgFixedSize(svg) }}
      />
    </div>
  )
}

function ModalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section-card" style={{ fontSize: 'var(--font-size-xs)' }}>
      <div className="section-card-title">{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children}
      </div>
    </div>
  )
}

function ModalTextRow({ label, placeholder, value, onChange }: {
  label: string
  placeholder?: string
  value: string
  onChange: (next: string) => void
}) {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '60px 1fr', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={modalInputStyle}
      />
    </label>
  )
}

// ---------------------------------------------------------------------
// StatsTable — compact tabular summary of every metric's stats run.
// Sortable, copyable to clipboard as TSV, exportable to CSV via the
// Electron save dialog. Sits under the "Table" view toggle in
// ``StatsResultsPanel`` as a sibling to the cards grid.
// ---------------------------------------------------------------------

type SortColumn = 'metric' | 'test' | 'p' | 'effect' | null

/** ``ns`` / ``*`` / ``**`` / ``***`` matches the convention most
 *  journals use. Centralised here so the table and the inline cards
 *  agree on what counts as significant. */
function pStars(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return ''
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return 'ns'
}

/** Compact "n=… per group" label, e.g. ``WT=8, KO=7`` — derived from
 *  the descriptives block. Falls back to '—' when no data. */
function nPerGroupLabel(result: any): string {
  const desc = result?.descriptives
  if (!desc || typeof desc !== 'object') return '—'
  const parts: string[] = []
  for (const [tag, d] of Object.entries(desc)) {
    const n = (d as any)?.n
    if (typeof n === 'number') parts.push(`${tag}=${n}`)
  }
  return parts.length ? parts.join(', ') : '—'
}

/** Compact normality verdict across all groups. Returns
 *  ``"all normal"``, ``"<tag>, <tag>: not normal"``, or ``"—"``
 *  when normality isn't reported (Wilcoxon / Friedman branches
 *  skip the test). */
function normalityLabel(result: any): string {
  const norm = result?.normality
  if (!norm || typeof norm !== 'object') return '—'
  const failed: string[] = []
  let any = false
  for (const [tag, d] of Object.entries(norm)) {
    const verdict = (d as any)?.verdict
    if (verdict === 'unknown') continue
    any = true
    if (verdict === 'fail' || (d as any)?.is_normal === false) failed.push(tag)
  }
  if (!any) return '—'
  if (failed.length === 0) return '✓ all'
  return `✗ ${failed.join(', ')}`
}

/** Compact post-hoc summary, e.g. ``WT-KO ***, WT-rescue ns``.
 *  Skips when the test had no posthoc (two-group designs etc.). */
function posthocLabel(result: any): string {
  const ph = result?.posthoc
  if (!Array.isArray(ph) || ph.length === 0) return '—'
  return ph.map((row: any) => {
    const a = String(row.a ?? '')
    const b = String(row.b ?? '')
    const p = typeof row.p === 'number' ? row.p : null
    return `${a}-${b} ${pStars(p) || '?'}`
  }).join(', ')
}

/** Format a numeric statistic + df, e.g. ``t = 3.21 (df=12.4)`` or
 *  ``F = 5.87 (df=2,11)``. Returns '—' when missing. */
function statLabel(result: any): string {
  const s = result?.statistic
  const lbl = result?.statistic_label || 'stat'
  const df = result?.df
  if (typeof s !== 'number') return '—'
  let out = `${lbl} = ${Number(s).toFixed(3)}`
  if (typeof df === 'number') {
    out += ` (df=${Number(df).toFixed(df === Math.round(df) ? 0 : 1)})`
  } else if (Array.isArray(df) && df.length === 2) {
    out += ` (df=${df[0]},${df[1]})`
  }
  return out
}

function effectLabel(result: any): string {
  const v = result?.effect_size
  const lbl = result?.effect_size_label || ''
  if (typeof v !== 'number') return '—'
  return `${lbl ? lbl + ' = ' : ''}${Number(v).toFixed(3)}`
}

function StatsTable({ metrics, results, metricKindOf }: {
  metrics: string[]
  results: Record<string, any>
  metricKindOf: (name: string) => 'scalar' | 'distribution' | 'timeseries' | null
}) {
  // Only metrics with a stats result land in the table — distribution
  // and timeseries metrics are graph-only (no Pingouin path).
  // Errors still appear so the user can see which metrics failed and
  // why, with the failure message in the Test column.
  const rows = useMemo(
    () => metrics
      .filter((m) => results[m] && metricKindOf(m) === 'scalar')
      .map((metric) => {
        const r = results[metric]
        return {
          metric,
          test: r?.error ? `error: ${r.error}` : (r?.test || '—'),
          stat: r?.error ? '' : statLabel(r),
          p: typeof r?.p === 'number' ? (r.p as number) : null,
          effect: typeof r?.effect_size === 'number' ? (r.effect_size as number) : null,
          effectStr: r?.error ? '' : effectLabel(r),
          n: nPerGroupLabel(r),
          normality: r?.error ? '' : normalityLabel(r),
          posthoc: r?.error ? '' : posthocLabel(r),
          isError: !!r?.error,
        }
      }),
    [metrics, results, metricKindOf],
  )

  // Default sort: ascending p — most useful for scanning significance.
  const [sortCol, setSortCol] = useState<SortColumn>('p')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const sortedRows = useMemo(() => {
    if (!sortCol) return rows
    const sign = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      let av: any
      let bv: any
      if (sortCol === 'metric') { av = a.metric; bv = b.metric }
      else if (sortCol === 'test') { av = a.test; bv = b.test }
      else if (sortCol === 'p') { av = a.p; bv = b.p }
      else if (sortCol === 'effect') { av = a.effect != null ? Math.abs(a.effect) : null; bv = b.effect != null ? Math.abs(b.effect) : null }
      // Push nulls to the bottom regardless of direction — they're
      // "no value", not "biggest" or "smallest".
      const aN = av === null || av === undefined
      const bN = bv === null || bv === undefined
      if (aN && bN) return 0
      if (aN) return 1
      if (bN) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
      return String(av).localeCompare(String(bv)) * sign
    })
  }, [rows, sortCol, sortDir])

  const toggleSort = useCallback((col: Exclude<SortColumn, null>) => {
    if (sortCol !== col) {
      setSortCol(col)
      setSortDir(col === 'p' || col === 'effect' ? 'asc' : 'asc')
    } else {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    }
  }, [sortCol])

  // ---- Export helpers -------------------------------------------------
  // Build the table as TSV (clipboard) or CSV (file). Same row order
  // the user is currently looking at — sort persists into the export.
  const buildRows = useCallback((delim: string, quote: boolean): string => {
    const esc = quote
      ? (s: string) => `"${String(s).replace(/"/g, '""')}"`
      : (s: string) => String(s)
    const header = ['metric', 'n', 'test', 'statistic', 'p', 'stars', 'effect_size', 'normality', 'posthoc']
    const lines = [header.map(esc).join(delim)]
    for (const r of sortedRows) {
      lines.push([
        esc(r.metric),
        esc(r.n),
        esc(r.test),
        esc(r.stat),
        esc(r.p != null ? String(r.p) : ''),
        esc(pStars(r.p)),
        esc(r.effectStr),
        esc(r.normality),
        esc(r.posthoc),
      ].join(delim))
    }
    return lines.join('\n')
  }, [sortedRows])

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTSV = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildRows('\t', false))
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1500)
    } catch {
      setCopyState('failed')
      setTimeout(() => setCopyState('idle'), 2000)
    }
  }, [buildRows])

  const exportCSV = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.saveFileDialog || !api?.writeTextFile) return
    const target = await api.saveFileDialog('cohort_stats.csv', [
      { name: 'CSV', extensions: ['csv'] },
    ])
    if (!target) return
    await api.writeTextFile(target, buildRows(',', true))
  }, [buildRows])

  if (rows.length === 0) {
    return (
      <div style={{
        padding: 12,
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-xs)',
      }}>
        No scalar-metric stats results yet. Distribution / time-series
        metrics are graph-only and don't appear here.
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button
          className="btn btn-sm"
          onClick={copyTSV}
          title="Copy the table to the clipboard as tab-separated values. Paste straight into Excel / Numbers / Prism / a manuscript."
        >{copyState === 'copied' ? 'Copied ✓' : copyState === 'failed' ? 'Copy failed' : 'Copy as TSV'}</button>
        <button
          className="btn btn-sm"
          onClick={exportCSV}
          title="Save the table as a CSV file."
        >Export CSV</button>
      </div>
      <div style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-field)',
        overflow: 'auto',
        maxHeight: '60vh',
      }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 'var(--font-size-xs)',
        }}>
          <thead style={{
            position: 'sticky',
            top: 0,
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border)',
          }}>
            <tr>
              <SortableHeader col="metric" label="Metric" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
              <StTh>n</StTh>
              <SortableHeader col="test" label="Test" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
              <StTh>Statistic</StTh>
              <SortableHeader col="p" label="p" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
              <StTh>Sig.</StTh>
              <SortableHeader col="effect" label="Effect" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
              <StTh>Normality</StTh>
              <StTh>Post-hoc</StTh>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const stars = pStars(r.p)
              const sigColor =
                r.isError ? 'var(--error)'
                : (r.p != null && r.p < 0.05) ? 'var(--success)'
                : 'var(--text-primary)'
              return (
                <tr key={r.metric} style={{
                  borderBottom: '1px solid var(--border-subtle)',
                  background: r.isError ? 'color-mix(in oklab, var(--error) 6%, transparent)' : 'transparent',
                }}>
                  <StTd><span style={{ fontWeight: 600 }}>{r.metric}</span></StTd>
                  <StTd num>{r.n}</StTd>
                  <StTd title={r.test}>{r.test}</StTd>
                  <StTd num>{r.stat}</StTd>
                  <StTd num><span style={{ color: sigColor, fontWeight: 700 }}>
                    {r.p != null ? formatP(r.p) : '—'}
                  </span></StTd>
                  <StTd num>{stars}</StTd>
                  <StTd num>{r.effectStr}</StTd>
                  <StTd>{r.normality}</StTd>
                  <StTd>{r.posthoc}</StTd>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{
        marginTop: 4,
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-xs)',
      }}>
        Sig. legend: *** p&lt;0.001, ** p&lt;0.01, * p&lt;0.05, ns p≥0.05.
        Click column headers to sort.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// ExportButtons — Excel summary, per-cell, and Prism .pzfx export.
// Sits between the aggregate summary and the cell table so it's
// available immediately after aggregation (without requiring a stats
// run). When stats results are present they're folded into the Excel
// summary's stats sheet — otherwise that sheet is skipped silently.
// ---------------------------------------------------------------------

function ExportButtons({
  backendUrl, aggregate, designGroups, stats, selectedMetrics,
  comparisonShape, selectedTags, filterTags, seriesRole, nUnit, testOverride,
  subsampleMode, subsampleN,
}: {
  backendUrl: string
  aggregate: any
  // Wizard's grouped cells (with subsampling already applied to
  // distributions). NULL when the wizard isn't ready — in that
  // case the export endpoint falls back to a raw "every cell in
  // the folder" dump under group ''.
  designGroups: any[] | null
  stats: Record<string, any> | null
  selectedMetrics: string[]
  comparisonShape: string
  selectedTags: string[]
  filterTags: string[]
  seriesRole: string
  nUnit: string
  testOverride: string
  subsampleMode: SubsampleMode
  subsampleN: number
}) {
  const [busy, setBusy] = useState<null | 'excel_summary' | 'excel_cells' | 'prism'>(null)
  const [error, setError] = useState<string | null>(null)

  const doExport = useCallback(async (format: 'excel_summary' | 'excel_cells' | 'prism') => {
    const api = window.electronAPI
    if (!api?.saveFileDialog || !api?.writeBinaryFile) {
      setError('Save not available — Electron bridge missing.')
      return
    }
    setBusy(format)
    setError(null)
    try {
      // Send the in-memory aggregate + stats so the export reflects
      // exactly what the user is looking at — no server-side
      // re-aggregation that could quietly diverge from the UI.
      const body = {
        format,
        aggregate,
        // The wizard's actual analysed cells, grouped + subsampled
        // exactly as they appear in the on-screen cards. Backend
        // uses these directly without re-filtering — ensures the
        // exported file matches the UI 1:1.
        design_groups: designGroups,
        // Stats only used for the Excel-summary sheet. ``excel_cells``
        // and ``prism`` ignore it server-side, but we send it anyway
        // so a single payload works for any format.
        stats: stats ?? null,
        selected_metrics: selectedMetrics,
        design: {
          comparison_shape: comparisonShape,
          selected_tags: selectedTags,
          filter_tags: filterTags,
          series_role: seriesRole,
          n_unit: nUnit,
          test_override: testOverride,
          subsample: { mode: subsampleMode, n: subsampleN },
        },
      }
      const resp = await fetch(`${backendUrl}/api/cohort/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
      const json = await resp.json()
      if (typeof json?.base64 !== 'string') throw new Error('Backend returned no payload')
      // File-extension picker per format. Prism uses ``.pzfx``;
      // Excel uses ``.xlsx``. The default filename mirrors what the
      // backend suggested but stays customisable in the dialog.
      const ext = json.format === 'pzfx' ? 'pzfx' : 'xlsx'
      const filterName = json.format === 'pzfx' ? 'Prism' : 'Excel'
      const target = await api.saveFileDialog(
        json.filename || `cohort.${ext}`,
        [{ name: filterName, extensions: [ext] }],
      )
      if (!target) return
      const result = await api.writeBinaryFile(target, json.base64)
      if (!result?.ok) throw new Error(result?.error || 'write failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [backendUrl, aggregate, designGroups, stats, selectedMetrics,
      comparisonShape, selectedTags, filterTags, seriesRole, nUnit,
      testOverride, subsampleMode, subsampleN])

  // Disable when there's nothing useful to export. ``aggregate`` is
  // always defined here (we render inside the post-aggregate
  // block), but guard for the empty-cells edge case. Use the
  // design-grouped cell count when available so the user sees the
  // ACTUAL N going into the file (after wizard filtering), not
  // the raw folder count.
  const nCellsInGroups = designGroups
    ? designGroups.reduce((s, g) => s + (g.cells?.length ?? 0), 0)
    : (aggregate?.cells?.length ?? 0)
  const disabled = nCellsInGroups === 0 || busy !== null

  return (
    <div style={{
      display: 'flex',
      gap: 6,
      alignItems: 'center',
      flexWrap: 'wrap',
      marginBottom: 8,
      padding: '6px 8px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--bg-secondary)',
      fontSize: 'var(--font-size-xs)',
    }}>
      <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>Export:</span>
      <button
        className="btn btn-sm"
        onClick={() => doExport('excel_summary')}
        disabled={disabled}
        title={"Multi-sheet Excel workbook: cohort metadata, stats summary "
             + "(if stats run), cells (wide + long), one sheet per "
             + "distribution metric. The full archive of this run."}
      >{busy === 'excel_summary' ? 'Saving…' : 'Excel (full)'}</button>
      <button
        className="btn btn-sm"
        onClick={() => doExport('excel_cells')}
        disabled={disabled}
        title={"Single-sheet Excel: one row per cell, every scalar metric "
             + "as a column, plus meta fields. The shape stats packages "
             + "(R, Python, JMP, etc.) expect on import."}
      >{busy === 'excel_cells' ? 'Saving…' : 'Per-cell Excel'}</button>
      <button
        className="btn btn-sm"
        onClick={() => doExport('prism')}
        disabled={disabled}
        title={"GraphPad Prism project (.pzfx). One Grouped data table per "
             + "scalar metric, one Column table per distribution metric × "
             + "group. Open in Prism to continue your figure work."}
      >{busy === 'prism' ? 'Saving…' : 'Prism (.pzfx)'}</button>
      {!stats && nCellsInGroups > 0 && (
        <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
          (run stats first to include the stats sheet)
        </span>
      )}
      {designGroups && (
        <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
          {nCellsInGroups} cell{nCellsInGroups === 1 ? '' : 's'} in {designGroups.length} group{designGroups.length === 1 ? '' : 's'}
        </span>
      )}
      {error && (
        <span style={{ color: 'var(--error)', marginLeft: 4 }}>{error}</span>
      )}
    </div>
  )
}


// Stats-table-local th/td helpers. Named ``StTh`` / ``StTd`` to
// avoid colliding with the other plain-table helpers used elsewhere
// in this file (cell preview etc.).
function StTh({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      textAlign: 'left',
      padding: '6px 10px',
      fontWeight: 600,
      color: 'var(--text-muted)',
      whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}

function StTd({ children, title, num }: { children: React.ReactNode; title?: string; num?: boolean }) {
  return (
    <td title={title} style={{
      padding: '5px 10px',
      verticalAlign: 'top',
      whiteSpace: 'nowrap',
      fontFamily: num ? 'var(--font-mono)' : 'var(--font-ui)',
    }}>{children}</td>
  )
}

function SortableHeader({ col, label, sortCol, sortDir, onSort }: {
  col: Exclude<SortColumn, null>
  label: string
  sortCol: SortColumn
  sortDir: 'asc' | 'desc'
  onSort: (col: Exclude<SortColumn, null>) => void
}) {
  const active = sortCol === col
  const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
  return (
    <th style={{
      textAlign: 'left',
      padding: '6px 10px',
      fontWeight: 600,
      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
      whiteSpace: 'nowrap',
      userSelect: 'none',
    }} onClick={() => onSort(col)} title={`Sort by ${label.toLowerCase()}`}>
      {label}{arrow}
    </th>
  )
}

/** Strip ``width`` / ``height`` attributes from an SVG so it scales
 *  to its container instead of being pinned at matplotlib's
 *  default-DPI pixel size. ``viewBox`` already encodes the aspect
 *  ratio so removing the explicit dimensions just unlocks the
 *  layout. */
function stripSvgFixedSize(svg: string): string {
  return svg
    .replace(/(<svg[^>]*?)\s+width="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\s+height="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)>/, '$1 width="100%" style="display:block;">')
}

/** Format a p-value: scientific for very small, 3dp otherwise.
 *  Mirrors the convention most journals use (``< 0.001`` is shown
 *  literally rather than ``2e-7``). */
function formatP(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return '—'
  if (p < 0.001) return '<0.001'
  return p.toFixed(3)
}

// ---------------------------------------------------------------------
// Pre-aggregation empty state — points the user to the "Aggregate"
// button and explains what's about to happen, since the wizard
// doesn't exist yet.
// ---------------------------------------------------------------------
function EmptyState() {
  return (
    <div style={{
      padding: '32px 16px',
      color: 'var(--text-muted)',
      lineHeight: 1.6,
      maxWidth: 640,
    }}>
      <div style={{ fontSize: 'var(--font-size-base)', marginBottom: 8 }}>
        Pick the folder of <code style={mono}>.tracer</code> sidecars you
        want to aggregate, choose an analysis type, then click <b>Aggregate</b>.
      </div>
      <div style={{ fontSize: 'var(--font-size-sm)' }}>
        The backend will walk every recording in the folder, pull per-cell
        scalars + distributions for the chosen analysis, and surface skipped
        files (no tags / no analysis run) so you can fix them before running
        statistics.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Top-of-result summary banner: cell count + scanned count + skip
// counts. Quick at-a-glance check that the aggregator saw what the
// user expected before they scroll into the cell table.
// ---------------------------------------------------------------------
function ResultSummary({ result }: { result: AggregateResponse }) {
  const { cells, summary, skipped_no_meta, skipped_no_analysis, errors } = result
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '8px 12px',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      marginBottom: 12,
      fontSize: 'var(--font-size-sm)',
      flexWrap: 'wrap',
    }}>
      <Pill
        label={`${cells.length} cell${cells.length === 1 ? '' : 's'}`}
        color="var(--success)"
      />
      <Pill
        label={`${summary.n_files_scanned} scanned`}
        color="var(--text-muted)"
      />
      {skipped_no_meta.length > 0 && (
        <Pill
          label={`${skipped_no_meta.length} no tags`}
          color="var(--error)"
          tooltip="These files have no file-level tags. Open them in the metadata window and add at least one tag."
        />
      )}
      {skipped_no_analysis.length > 0 && (
        <Pill
          label={`${skipped_no_analysis.length} no analysis`}
          color="var(--warning)"
          tooltip={`These files don't carry results for ${result.analysis_type}.`}
        />
      )}
      {errors.length > 0 && (
        <Pill
          label={`${errors.length} error${errors.length === 1 ? '' : 's'}`}
          color="var(--error)"
          tooltip="Click to inspect — see the section below."
        />
      )}
    </div>
  )
}

function Pill({ label, color, tooltip }: { label: string; color: string; tooltip?: string }) {
  return (
    <span
      title={tooltip}
      style={{
        padding: '2px 8px',
        borderRadius: 10,
        background: 'var(--bg-tertiary)',
        color, fontWeight: 600,
        cursor: tooltip ? 'help' : 'default',
      }}
    >{label}</span>
  )
}

// ---------------------------------------------------------------------
// Per-cell preview table. Sticky header row; rows are scrollable in
// the parent container. Numbers are formatted to 4 sig figs to keep
// the table dense without losing precision; nulls render as em-dash.
// ---------------------------------------------------------------------
function CellTable({ cells, columns }: { cells: Cell[]; columns: string[] }) {
  if (cells.length === 0) {
    return (
      <div style={{
        padding: 16, color: 'var(--text-muted)',
        fontStyle: 'italic',
      }}>
        No cells contributed. Check the skip / error sections below.
      </div>
    )
  }
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--bg-field)',
      overflow: 'auto',
      maxHeight: '60vh',
    }}>
      <table style={{
        borderCollapse: 'collapse',
        width: '100%',
        fontSize: 'var(--font-size-sm)',
      }}>
        <thead style={{
          position: 'sticky', top: 0, zIndex: 1,
          background: 'var(--bg-secondary)',
        }}>
          <tr>
            <Th>File</Th>
            <Th>Recording ID</Th>
            <Th>Animal</Th>
            <Th>Series</Th>
            <Th>File tags</Th>
            <Th>Series tags</Th>
            {columns.map((c) => <Th key={c}>{c}</Th>)}
          </tr>
        </thead>
        <tbody>
          {cells.map((cell, i) => (
            <tr key={`${cell.file_path}::${cell.series_key}`}
                style={{
                  background: i % 2 === 0 ? 'transparent'
                    : 'var(--bg-hover)',
                }}>
              <Td title={cell.file_path}>{cell.file_name}</Td>
              <Td>{cell.cell_id ?? '—'}</Td>
              <Td>{cell.animal_id ?? '—'}</Td>
              <Td>{displayGroupSeries(cell.series_key)}</Td>
              <Td>{cell.group_tags.join(', ')}</Td>
              <Td>{cell.series_specific_tags.join(', ') || '—'}</Td>
              {columns.map((col) => {
                const v = cell.scalars[col]
                return <Td key={col} numeric>{fmtScalar(v)}</Td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      textAlign: 'left',
      padding: '6px 8px',
      borderBottom: '1px solid var(--border)',
      fontWeight: 600,
      color: 'var(--text-muted)',
      whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}

function Td({ children, title, numeric }: {
  children: React.ReactNode; title?: string; numeric?: boolean
}) {
  return (
    <td title={title}
        style={{
          padding: '4px 8px',
          borderBottom: '1px solid var(--border-subtle)',
          textAlign: numeric ? 'right' : 'left',
          fontFamily: numeric ? 'var(--font-mono)' : 'var(--font-ui)',
          maxWidth: 220,
          overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
      {children}
    </td>
  )
}

function fmtScalar(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  // 4-sig-fig display with sensible exponent fallback for very
  // small / very large numbers (e.g. tau in s vs Hz). The cohort
  // table is preview-grade, not publication-grade.
  if (Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.001)) {
    return v.toExponential(2)
  }
  // 4 sig figs equivalent: precision based on magnitude.
  const decimals = Math.abs(v) >= 100 ? 1
    : Math.abs(v) >= 10 ? 2
    : Math.abs(v) >= 1 ? 3
    : 4
  return v.toFixed(decimals)
}

// ---------------------------------------------------------------------
// Skip + error section — collapsible lists of files the aggregator
// dropped, with the concrete reason. The metadata-tag prompt and
// the events / AP / etc. analysis windows are how the user actually
// fixes these; this section just makes the situation legible.
// ---------------------------------------------------------------------
function SkippedSection({ result }: { result: AggregateResponse }) {
  const { skipped_no_meta, skipped_no_analysis, errors } = result
  const total = skipped_no_meta.length + skipped_no_analysis.length + errors.length
  const [expanded, setExpanded] = useState(false)
  if (total === 0) return null
  return (
    <div style={{ marginTop: 14 }}>
      <button
        onClick={() => setExpanded((x) => !x)}
        style={{
          background: 'transparent', border: 'none',
          padding: 0, marginBottom: 6,
          color: 'var(--text-muted)',
          fontSize: 'var(--font-size-sm)',
        }}
      >
        {expanded ? '▼' : '▶'} {total} file{total === 1 ? '' : 's'} skipped or failed — details
      </button>
      {expanded && (
        <div style={{
          padding: '8px 12px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          fontSize: 'var(--font-size-sm)',
        }}>
          {skipped_no_meta.length > 0 && (
            <SkipList
              title="No file-level tags"
              hint="Open these in the metadata window and add at least one file tag."
              items={skipped_no_meta.map((s) => s.file_name ?? s.file_path)}
            />
          )}
          {skipped_no_analysis.length > 0 && (
            <SkipList
              title={`No ${result.analysis_type} results`}
              hint="These files haven't had this analysis run yet — or the slices are stored under a different shape than the cohort expects. The reason after the colon shows what the backend actually saw in each sidecar."
              items={skipped_no_analysis.map((s) => {
                const name = s.file_name ?? s.file_path
                return (s as any).reason ? `${name} — ${(s as any).reason}` : name
              })}
            />
          )}
          {errors.length > 0 && (
            <SkipList
              title="Errors"
              hint="Backend extractor failed for these slices."
              items={errors.map((e) =>
                `${e.file_path.split(/[/\\]/).pop()}${e.series_key ? ' (' + displayGroupSeries(e.series_key) + ')' : ''}: ${e.reason}`)}
              error
            />
          )}
        </div>
      )}
    </div>
  )
}

function SkipList({ title, hint, items, error }: {
  title: string; hint: string; items: string[]; error?: boolean
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontWeight: 600,
        color: error ? 'var(--error)' : 'var(--text-primary)',
        marginBottom: 2,
        fontSize: 'var(--font-size-sm)',
      }}>{title} ({items.length})</div>
      <div style={{
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-xs)',
        marginBottom: 4,
      }}>{hint}</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  )
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-tertiary)',
  padding: '0 4px',
  borderRadius: 'var(--radius-sm)',
}
