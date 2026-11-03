/**
 * Trace Export — Phase C dedicated store.
 *
 * Cross-recording by design: each TraceItem points at an absolute
 * file path + group/series/sweeps. Lives in its own store rather
 * than the giant appStore because:
 *   - the working state is not keyed per-recording,
 *   - it doesn't need the BroadcastChannel sync mesh other windows
 *     rely on, and
 *   - templates persist globally under prefs.traceExport.* rather
 *     than per-file.
 */
import { create } from 'zustand'

// ----- Types -------------------------------------------------------------

export interface FilterCfg {
  enabled: boolean
  type: 'lowpass' | 'highpass' | 'bandpass'
  low_hz: number
  high_hz: number
  order: number
}

export interface BaselineCfg {
  enabled: boolean
  t0: number
  t1: number
}

export interface BlankingCfg {
  enabled: boolean
  t0: number
  t1: number
  mode: 'interp' | 'hide'
}

export interface SeriesCfg {
  filter: FilterCfg
  baseline: BaselineCfg
  blanking: BlankingCfg
}

export interface TraceStyle {
  /** Individuals (and single-sweep) line color, weight, dash, alpha. */
  color: string
  weight: number
  dash: string
  alpha: number
  /** Backwards-compat: was the old "individuals alpha". Kept as the
   *  per-sweep alpha when both mean and individuals are shown.       */
  individuals_alpha: number
  /** Mean-overlay style — used only when ``show_mean`` is on AND the
   *  trace has ≥2 sweeps (single sweeps render via the base style).
   *  Defaults seeded from the base style at item-create time so the
   *  mean shares the trace's color until the user customises.        */
  mean_color: string
  mean_weight: number
  mean_dash: string
  mean_alpha: number
}

export interface TraceItem {
  id: string
  /** Display label for the list pane (e.g. "cell01.dat · g0:s2 · sweeps 1–5") */
  label: string
  /** Custom display name for the legend. Falls back to ``label`` when
   *  empty. Lets the user write something like "WT baseline" instead
   *  of the verbose file/group/series breadcrumb in the legend. */
  display_name: string
  file_path: string
  /** Cached file basename so we don't redo path parsing in render. */
  file_name: string
  group: number
  series: number
  trace: number
  sweeps: number[]
  show_individuals: boolean
  show_mean: boolean
  style: TraceStyle
  x_offset: number
  /** Vertical offset added to every value at draw time. Lets the user
   *  drag traces up/down to separate them in the figure. Stored in the
   *  source's y-units (pA, mV, …). */
  y_offset: number
  /** Optional [start, end] in source-time seconds, before x_offset. */
  x_range: [number, number] | null
  axis_id: string
}

export interface YAxis {
  id: string
  side: 'left' | 'right' | 'right2' | 'right3'
  label: string
  unit: string
  auto_limits: boolean
  min: number | null
  max: number | null
  /** Relative panel height in stacked layout. Ignored in overlay.
   *  Defaults to 1; a user can set 2 to make this axis's panel
   *  twice as tall as a sibling weighted 1. */
  height_weight: number
}

export interface ScalebarCfg {
  enabled: boolean
  corner: 'br' | 'bl' | 'tr' | 'tl'
  pad_x: number
  pad_y: number
  thickness_pt: number
  color: string
  show_labels: boolean
  label_gap_pt: number
  font_size: number
  /** Override: time bar value in seconds (null = auto). */
  x_value: number | null
  /** Override: time bar display unit (null = auto). */
  x_unit: string | null
  /** Per-axis y-bar overrides keyed by axis id. */
  y_overrides: Record<string, { value?: number; unit?: string }>
}

export type AxisStyle = 'scalebars' | 'axes'

/** Single overlay panel (twinx siblings) vs one panel per axis
 *  stacked vertically with shared x. Affects matplotlib layout, the
 *  uPlot preview's panel composition, and where scalebars / legends
 *  end up. */
export type PanelLayout = 'overlay' | 'stacked'

export interface LegendCfg {
  enabled: boolean
  position: 'tl' | 'tr' | 'bl' | 'br' | 'outside-right'
  font_size: number
  /** Hide list-pane verbose labels from the legend; show only items
   *  the user has explicitly named via display_name. */
  only_named: boolean
}

// ----- Lab default palette (Okabe-Ito, colorblind-safe) -------------------
//
// 8 colors that round-trip clean through CVD simulations. The exporter
// cycles through these as new traces are added; user can override per item.
export const OKABE_ITO = [
  '#000000', // black
  '#E69F00', // orange
  '#56B4E9', // sky blue
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#CC79A7', // reddish purple
] as const

// ----- File info cache ---------------------------------------------------
//
// The picker fetches /api/trace_export/file_info on demand. We cache
// the parsed info so repeated picks within the same window don't
// re-fetch. Keyed by absolute file path.

export interface FileSeriesInfo {
  index: number
  label: string
  sweepCount: number
  channels: { index: number; label: string; units: string }[]
}

export interface FileGroupInfo {
  index: number
  label: string
  series: FileSeriesInfo[]
}

export interface FileInfo {
  filePath: string
  fileName: string
  format: string | null
  groups: FileGroupInfo[]
}

// ----- Templates ----------------------------------------------------------
//
// A template captures the figure's "look" — axes, scalebar, legend,
// axis style, figure size, palette — but NOT the trace items (their
// sources are by definition tied to specific recordings) and NOT the
// per-series filter / baseline / blanking (those are tied to the
// source data, applying a template to a different cohort wouldn't
// know what to do with them). Saved globally under
// ``prefs.traceExport.templates``.
export interface TraceExportTemplate {
  name: string
  saved_at: string
  axes: YAxis[]
  scalebar: ScalebarCfg
  legend: LegendCfg
  axis_style: AxisStyle
  panel_layout: PanelLayout
  width_cm: number
  height_cm: number
  dpi: number
}

// ----- Live view ref ------------------------------------------------------
//
// The live preview's current scale ranges (after the user has wheel-
// zoomed, panned, or hit Fit) live OUTSIDE Zustand state because every
// scroll would otherwise re-render every subscriber. PreviewPanel
// mutates ``ranges`` on each setScale; ExportModal reads from it at
// export time so the matplotlib output matches what the user is
// looking at on screen.
//
// ``hydrated`` is set when ``loadSessionPayload`` writes restored
// ranges into the ref. PreviewPanel checks this flag on its next
// rebuild and skips its "fresh-state reset" guard so the hydrated
// zoom survives the rebuild instead of being clobbered by auto-fit.
// The flag clears once consumed.
export const currentViewRef: {
  ranges: Record<string, { min: number; max: number }>
  hydrated: boolean
} = { ranges: {}, hydrated: false }

// ----- Store -------------------------------------------------------------

interface TraceExportState {
  backendUrl: string
  setBackendUrl: (url: string) => void

  // Picker state — files the user has opened this session
  knownFiles: Record<string, FileInfo>
  registerFile: (info: FileInfo) => void

  // Working figure
  items: TraceItem[]
  seriesCfgs: Record<string, SeriesCfg>
  axes: YAxis[]
  scalebar: ScalebarCfg
  axisStyle: AxisStyle
  panelLayout: PanelLayout
  legend: LegendCfg
  width_cm: number
  height_cm: number
  dpi: number

  // Actions
  addItem: (partial: Partial<TraceItem> & {
    file_path: string; file_name: string; group: number; series: number; sweeps: number[]
  }) => void
  removeItem: (id: string) => void
  updateItem: (id: string, patch: Partial<TraceItem>) => void
  reorderItem: (id: string, direction: -1 | 1) => void

  ensureSeriesCfg: (key: string) => SeriesCfg
  updateSeriesCfg: (key: string, patch: Partial<SeriesCfg>) => void

  addAxis: (unit?: string, label?: string) => string
  removeAxis: (id: string) => void
  updateAxis: (id: string, patch: Partial<YAxis>) => void

  setScalebar: (patch: Partial<ScalebarCfg>) => void
  setLegend: (patch: Partial<LegendCfg>) => void
  setAxisStyle: (style: AxisStyle) => void
  setPanelLayout: (layout: PanelLayout) => void
  setSize: (w: number, h: number) => void
  setDpi: (dpi: number) => void

  resetAll: () => void

  // ----- Templates -------------------------------------------------------
  templates: TraceExportTemplate[]
  loadTemplates: () => Promise<void>
  saveTemplate: (name: string) => Promise<void>
  deleteTemplate: (name: string) => Promise<void>
  applyTemplate: (name: string) => void

  // ----- Sessions --------------------------------------------------------
  /** Hydrate every slice the user can edit from a session payload.
   *  Used when opening a .tracer_figure JSON file. */
  loadSessionPayload: (payload: SessionPayload) => void
  /** Build a serializable snapshot of the entire working figure for
   *  saving to .tracer_figure JSON. */
  buildSessionPayload: () => SessionPayload
}

export interface SessionPayload {
  items: TraceItem[]
  seriesCfgs: Record<string, SeriesCfg>
  axes: YAxis[]
  scalebar: ScalebarCfg
  legend: LegendCfg
  axis_style: AxisStyle
  panel_layout: PanelLayout
  width_cm: number
  height_cm: number
  dpi: number
  /** Which files were referenced. Lets us re-register them in the
   *  picker on load even if the user picks the session file from a
   *  fresh window with nothing loaded yet. */
  knownFiles: Record<string, FileInfo>
  /** Live view ranges per scale id (the user's last zoom/pan).
   *  Restored into ``currentViewRef`` on session load so reopening a
   *  session shows the exact view the user saved, not an auto-fit. */
  view_ranges: Record<string, { min: number; max: number }>
}

function defaultLegend(): LegendCfg {
  return { enabled: false, position: 'tr', font_size: 10, only_named: false }
}

function defaultScalebar(): ScalebarCfg {
  return {
    enabled: true,
    corner: 'br',
    pad_x: 0.04,
    pad_y: 0.06,
    thickness_pt: 1.8,
    color: '#222222',
    show_labels: true,
    label_gap_pt: 4,
    font_size: 10,
    x_value: null,
    x_unit: null,
    y_overrides: {},
  }
}

function defaultSeriesCfg(): SeriesCfg {
  return {
    filter: { enabled: false, type: 'lowpass', low_hz: 0, high_hz: 1000, order: 4 },
    baseline: { enabled: false, t0: 0, t1: 0.05 },
    blanking: { enabled: false, t0: 0, t1: 0, mode: 'interp' },
  }
}

function defaultAxis(id: string, unit = '', label = ''): YAxis {
  return {
    id,
    side: 'left',
    label,
    unit,
    auto_limits: true,
    min: null,
    max: null,
    height_weight: 1,
  }
}

export function seriesCfgKey(filePath: string, group: number, series: number): string {
  return `${filePath}|${group}:${series}`
}

export const useTraceExportStore = create<TraceExportState>((set, get) => ({
  backendUrl: '',
  setBackendUrl: (url) => set({ backendUrl: url }),

  knownFiles: {},
  registerFile: (info) =>
    set((s) => ({ knownFiles: { ...s.knownFiles, [info.filePath]: info } })),

  items: [],
  seriesCfgs: {},
  axes: [defaultAxis('y0', '', 'Signal')],
  scalebar: defaultScalebar(),
  axisStyle: 'scalebars',
  panelLayout: 'overlay',
  legend: defaultLegend(),
  width_cm: 15,
  height_cm: 10,
  dpi: 300,

  addItem: (partial) => {
    const id = `tr-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const idx = get().items.length
    const color = OKABE_ITO[idx % OKABE_ITO.length]
    const cfgKey = seriesCfgKey(partial.file_path, partial.group, partial.series)
    const seriesCfgs = { ...get().seriesCfgs }
    if (!seriesCfgs[cfgKey]) seriesCfgs[cfgKey] = defaultSeriesCfg()

    // Pick / create an axis matching the source unit if we know it.
    const file = get().knownFiles[partial.file_path]
    const ser = file?.groups?.[partial.group]?.series?.[partial.series]
    const ch = ser?.channels?.[partial.trace ?? 0]
    const unit = ch?.units ?? ''
    let axisId = get().axes[0].id
    if (unit) {
      const match = get().axes.find((a) => a.unit === unit)
      if (match) axisId = match.id
      else if (!get().axes[0].unit) {
        // First axis is generic — adopt this unit
        const updated = { ...get().axes[0], unit, label: ch?.label || unit }
        set({ axes: [updated, ...get().axes.slice(1)] })
        axisId = updated.id
      } else {
        // Need a new axis
        const newId = `y${get().axes.length}`
        const newAxis: YAxis = { ...defaultAxis(newId, unit, ch?.label || unit), side: 'right' }
        set({ axes: [...get().axes, newAxis] })
        axisId = newId
      }
    }

    const sweepsLabel = (() => {
      const sw = partial.sweeps
      if (!sw || sw.length === 0) return 'no sweeps'
      if (sw.length === 1) return `sweep ${sw[0] + 1}`
      const sorted = [...sw].sort((a, b) => a - b)
      const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1)
      return contiguous ? `sweeps ${sorted[0] + 1}–${sorted[sorted.length - 1] + 1}` : `${sw.length} sweeps`
    })()

    const item: TraceItem = {
      id,
      label: `${partial.file_name} · g${partial.group}:s${partial.series} · ${sweepsLabel}`,
      display_name: '',
      file_path: partial.file_path,
      file_name: partial.file_name,
      group: partial.group,
      series: partial.series,
      trace: partial.trace ?? 0,
      sweeps: partial.sweeps ?? [],
      show_individuals: partial.show_individuals ?? false,
      show_mean: partial.show_mean ?? true,
      style: partial.style ?? {
        color, weight: 1.5, dash: '', alpha: 1.0, individuals_alpha: 0.25,
        // Mean defaults: same color, slightly heavier so it stands out
        // over the faint individual sweeps.
        mean_color: color, mean_weight: 2.25, mean_dash: '', mean_alpha: 1.0,
      },
      x_offset: partial.x_offset ?? 0,
      y_offset: partial.y_offset ?? 0,
      x_range: partial.x_range ?? null,
      axis_id: partial.axis_id ?? axisId,
    }
    set({ items: [...get().items, item], seriesCfgs })
  },

  removeItem: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
  updateItem: (id, patch) => set({
    items: get().items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
  }),
  reorderItem: (id, direction) => {
    const items = [...get().items]
    const idx = items.findIndex((i) => i.id === id)
    if (idx < 0) return
    const j = idx + direction
    if (j < 0 || j >= items.length) return
    ;[items[idx], items[j]] = [items[j], items[idx]]
    set({ items })
  },

  ensureSeriesCfg: (key) => {
    const cur = get().seriesCfgs[key]
    if (cur) return cur
    const fresh = defaultSeriesCfg()
    set({ seriesCfgs: { ...get().seriesCfgs, [key]: fresh } })
    return fresh
  },
  updateSeriesCfg: (key, patch) => set({
    seriesCfgs: {
      ...get().seriesCfgs,
      [key]: { ...(get().seriesCfgs[key] ?? defaultSeriesCfg()), ...patch },
    },
  }),

  addAxis: (unit = '', label = '') => {
    const id = `y${get().axes.length}-${Math.floor(Math.random() * 1e4).toString(36)}`
    const side = get().axes.length === 0 ? 'left' : 'right'
    const axis: YAxis = { ...defaultAxis(id, unit, label || unit), side }
    set({ axes: [...get().axes, axis] })
    return id
  },
  removeAxis: (id) => set({ axes: get().axes.filter((a) => a.id !== id) }),
  updateAxis: (id, patch) => {
    set({
      axes: get().axes.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })
    // When the user edits manual axis limits or toggles auto, drop
    // the live drag/zoom range for this axis so the new manual
    // numbers actually take effect on the next draw. Without this,
    // the range hook returns the stale live range (which wins over
    // manual) and the user's typed values appear ignored.
    if ('min' in patch || 'max' in patch || 'auto_limits' in patch) {
      delete currentViewRef.ranges[id]
    }
  },

  setScalebar: (patch) => set({ scalebar: { ...get().scalebar, ...patch } }),
  setLegend: (patch) => set({ legend: { ...get().legend, ...patch } }),
  setAxisStyle: (style) => set({ axisStyle: style }),
  setPanelLayout: (layout) => set({ panelLayout: layout }),
  setSize: (w, h) => set({ width_cm: w, height_cm: h }),
  setDpi: (dpi) => set({ dpi }),

  resetAll: () =>
    set({
      items: [],
      seriesCfgs: {},
      axes: [defaultAxis('y0', '', 'Signal')],
      scalebar: defaultScalebar(),
      axisStyle: 'scalebars',
      panelLayout: 'overlay',
      legend: defaultLegend(),
      width_cm: 15,
      height_cm: 10,
      dpi: 300,
    }),

  // ----- Templates -------------------------------------------------------
  templates: [],
  loadTemplates: async () => {
    const api = window.electronAPI
    if (!api) return
    try {
      const prefs = await api.getPreferences()
      const stored = (prefs as any)?.traceExport?.templates
      if (Array.isArray(stored)) set({ templates: stored as TraceExportTemplate[] })
    } catch { /* ignore */ }
  },
  saveTemplate: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const tpl: TraceExportTemplate = {
      name: trimmed,
      saved_at: new Date().toISOString(),
      axes: get().axes,
      scalebar: get().scalebar,
      legend: get().legend,
      axis_style: get().axisStyle,
      panel_layout: get().panelLayout,
      width_cm: get().width_cm,
      height_cm: get().height_cm,
      dpi: get().dpi,
    }
    // Replace existing entry with same name (last write wins).
    const next = [...get().templates.filter((t) => t.name !== trimmed), tpl]
      .sort((a, b) => a.name.localeCompare(b.name))
    set({ templates: next })
    const api = window.electronAPI
    if (!api) return
    try {
      const prefs = await api.getPreferences()
      const cur = ((prefs as any)?.traceExport ?? {}) as Record<string, unknown>
      await api.patchPreferences({ traceExport: { ...cur, templates: next } })
    } catch { /* ignore */ }
  },
  deleteTemplate: async (name) => {
    const next = get().templates.filter((t) => t.name !== name)
    set({ templates: next })
    const api = window.electronAPI
    if (!api) return
    try {
      const prefs = await api.getPreferences()
      const cur = ((prefs as any)?.traceExport ?? {}) as Record<string, unknown>
      await api.patchPreferences({ traceExport: { ...cur, templates: next } })
    } catch { /* ignore */ }
  },
  applyTemplate: (name) => {
    const tpl = get().templates.find((t) => t.name === name)
    if (!tpl) return
    set({
      axes: tpl.axes,
      scalebar: tpl.scalebar,
      legend: tpl.legend,
      axisStyle: tpl.axis_style,
      panelLayout: tpl.panel_layout ?? 'overlay',
      width_cm: tpl.width_cm,
      height_cm: tpl.height_cm,
      dpi: tpl.dpi,
    })
  },

  // ----- Sessions --------------------------------------------------------
  loadSessionPayload: (payload) => {
    // Hydrate the live view ref BEFORE updating store state — by the
    // time PreviewPanel's rebuild effect fires (triggered by the
    // items/axes change below) it'll find the restored ranges and use
    // them. ``hydrated: true`` tells PreviewPanel to skip the
    // empty-state reset guard so the ranges survive.
    if (payload.view_ranges && typeof payload.view_ranges === 'object') {
      currentViewRef.ranges = { ...payload.view_ranges }
      currentViewRef.hydrated = true
    } else {
      currentViewRef.ranges = {}
      currentViewRef.hydrated = false
    }
    set({
      items: payload.items,
      seriesCfgs: payload.seriesCfgs,
      axes: payload.axes,
      scalebar: payload.scalebar,
      legend: payload.legend,
      axisStyle: payload.axis_style,
      panelLayout: payload.panel_layout ?? 'overlay',
      width_cm: payload.width_cm,
      height_cm: payload.height_cm,
      dpi: payload.dpi,
      // Merge known files so files already registered in this session
      // aren't dropped — sessions may legitimately reference a subset.
      knownFiles: { ...get().knownFiles, ...payload.knownFiles },
    })
  },
  buildSessionPayload: () => ({
    items: get().items,
    seriesCfgs: get().seriesCfgs,
    axes: get().axes,
    scalebar: get().scalebar,
    legend: get().legend,
    axis_style: get().axisStyle,
    panel_layout: get().panelLayout,
    width_cm: get().width_cm,
    height_cm: get().height_cm,
    dpi: get().dpi,
    knownFiles: get().knownFiles,
    view_ranges: { ...currentViewRef.ranges },
  }),
}))
