# TRACER User Manual — Structural Outline

Hierarchical reference of every user-facing surface, parameter, and
persistence slot. Structure is split into Part I (general app) and
Part II (analysis modules). Algorithms live inline in the chapter
where the option is exposed.

---

## Note to self — picking up the manual

The actual prose lives in `docs/MANUAL.md`. This file is the
structural outline only; treat it as a map, **not** as ground
truth. Several entries here turned out to be wrong on first
contact with the code (fictional cursor colours, non-existent
launchers, wrong response metrics, missing timecourse plot, etc.)
— always verify against the source before writing prose.

### Progress

- **Part I (chapters 1–8):** drafted and code-verified, **but a
  large UI refresh landed after this drafting** — see "Design
  refresh — to incorporate" below for the full diff list.
- **Part II (analysis modules):** chapters 9 (Cursor Measurements),
  10 (Resistance), 11 (I-V Curve) are drafted. Chapter 16 (Paired
  Recording) is outlined here but prose is not yet written.
- **Chapter 12 — Action Potentials** drafted; eight threshold-
  detection variants, two-tab layout (phase plot is the right
  pane of Kinetics, not a separate tab — outline was wrong).
- **Next chapter to write: 13 — Event Detection.**
- **Also planned: chapter 21 — Manual Viewer & Help** (the new
  in-app manual + `?` modal + ⌘K palette — see refresh notes).

### Functional additions — to document (added 2026-05-04)

A pile of new user-facing functionality landed in the `restyle`
branch. Visual / styling changes are **not** in this list — only
new things the user can do or new behaviours they will encounter.

**New surfaces / commands:**

- **Welcome screen** (replaces the previous logo-only empty
  state) — appears whenever no recording is loaded. Provides:
  - `Open file…` button (same dialog as the toolbar's Open File)
  - **Drag-and-drop**: dropping any supported file anywhere on
    the welcome area opens it. Text formats still route through
    the Text Import Wizard.
  - Clickable **Recent files** list (first 6 entries) — same
    behaviour as the toolbar's Recent ▾ menu, just always
    visible at the landing.
  - Supported-formats footer (informational).
  - **Document under chapter 1 (Getting Started)** as "First
    launch / Welcome screen".

- **Command palette** — `⌘K` / `Ctrl+K` opens a search-driven
  launcher for every action in the app: open file, recent
  files, sweep navigation, view toggles, all analysis windows,
  theme / palette / font-size, open manual, open help. Type
  to filter, ↑↓ to navigate, ↵ to run, Esc to close. **This is
  the fastest way to reach anything that isn't on the toolbar.**
  - **New section in chapter 8 (Keyboard Shortcuts)** — list
    the major command groups so users know what to type. Also
    add a one-liner under each Part-II analysis chapter:
    "*Reach this window with `⌘K` → 'cursors'* (etc.)".

- **Help modal** — opened by the `?` button in the toolbar
  (right of the loading area, before the gear) **or** by
  pressing `?` anywhere outside an input. Shows a keyboard
  shortcut cheat sheet grouped by category, plus an
  `Open user manual` button that opens the in-app manual.
  - **Update chapter 1 (Help / About)** — the existing entry
    "Help button — opens this user manual" is no longer
    accurate; the button opens the modal first, manual is one
    click further. Mention the `?` shortcut.

- **In-app Manual viewer** — opens in its own Electron window
  (via `Open user manual` in the help modal, or `⌘K` →
  "manual"). Two panes:
  - **Left**: filterable table of contents auto-built from the
    manual's headings. Type in the search box at the top to
    narrow it down. The current section highlights as you
    scroll the right pane.
  - **Right**: the manual itself, scrolling. Clicking a TOC
    entry jumps to that section. External links open in the
    OS browser.
  - The manual is **bundled with the app** — no internet
    required. Whatever ships with the build is what users see.
  - **New chapter 20 — Manual Viewer & Help** (or fold into
    chapter 1's Help section if you'd rather keep Part II
    purely about analysis modules).

- **Recording header strip** — when a recording is open, a
  thin strip between the toolbar and the trace viewer shows:
  - Tag-status dot (green / yellow / red — same semantics as
    before) · filename · file-level tag chips
  - Format · group / series / sweep position · sample rate ·
    sample count
  - This **replaces the right-hand side of the toolbar** that
    used to show the same info. Functionally: same content,
    better location (always visible, doesn't compete with
    toolbar buttons for space).
  - **Update chapter 2 (Toolbar)** — remove the right-side
    walkthrough (`MetaStatusDot`, filename label, FileTagChips)
    and add a short section "Recording header" under chapter 4
    or chapter 2.

**New keyboard shortcuts to add to chapter 8:**

- `⌘K` / `Ctrl+K` — open command palette
- `?` — open help modal
- `Esc` — close any open modal / popover / palette
- `⌘O` is **still not bound** (file open is toolbar / welcome
  / `⌘K` only) — the help modal lists it as a hint but it
  doesn't actually fire. Either wire it or drop the hint.

**Settings popover — new options to document in chapter 6:**

- **Palette → Precision** — third option alongside Classic and
  Telegraph. **It's now the default for new installs.**
- **Default theme changed from dark to light.** Existing users
  keep whatever they had persisted; only fresh installs are
  affected.
- The font-family / mono-font dropdowns are unchanged in
  options, but their descriptions can now say "the default is
  IBM Plex Sans / JetBrains Mono on every palette" (was
  Telegraph-only).

**Toolbar (chapter 2) — single functional change worth a line:**

- New `?` button between the loading-status area and the gear.
  Opens the help modal. Everything else on the toolbar (Open
  File, Recent ▾, sweep nav, Scaling, Traces, Overlay, Average,
  Analyses ▾, Tools ▾ [Tags / Batch / Cohort / Export Traces],
  gear) is unchanged in function — only how it looks.

**Chapters that do NOT need updates** (style-only changes):

- Chapter 4 trace viewer interactions (zoom / pan / cursor /
  coordinates / right-click menu) — same behaviour, restyled.
- Chapter 5 cursor panel measurements — same readouts, same
  filter controls, same auto-place broadcast.
- Chapter 7 persisted state — schema unchanged.
- All Part II analysis chapters that exist — internal logic
  is unchanged. Add the `⌘K` one-liner per the note above and
  you're done.

### Workflow for each new analysis chapter

1. Spawn an Explore agent first. Hand it the frontend window file
   (`frontend/src/components/AnalysisWindows/<Name>Window.tsx`) and
   the backend module(s) (`backend/analysis/<name>.py` and/or
   `backend/api/<name>.py`). Tell it explicitly **not to trust
   this outline**, and ask for a structured bullet report on:
   scope, layout, cursors, parameters, algorithms (one line per
   computation), results, persistence, keyboard shortcuts, status
   flags, and 2–4 screenshot suggestions.
2. Read the report. Note divergences from this outline before
   writing.
3. Draft the chapter directly into `docs/MANUAL.md`, slotted under
   the previous chapter's `---` divider.
4. After writing, report back to the user: line count, screenshot
   count, what differed from the outline, and any honest gaps.
   Wait for corrections before continuing.

### Style rules (established with the user)

- **Prose-led, second person.** Open each chapter with one or two
  paragraphs setting context — what the window is for, when to
  use it. Bullet lists only where genuinely list-shaped (column
  enumerations, run modes, fit-function tables).
- **Methods inline.** Where a parameter selects an algorithm
  (threshold method, fit function, baseline mode), describe the
  algorithm in one or two sentences right next to the parameter,
  not in a separate appendix.
- **No invented surfaces.** If a control isn't in the code, it
  doesn't go in the manual. If a feature is half-built, omit it
  rather than flag it as WIP — this is a user manual, not a
  development log.
- **Tables for genuinely tabular content** — file formats, badge
  legends, fit-function catalogues, response-metric definitions,
  etc. Avoid tables for prose that flows.
- **Screenshots inline** at the natural reading point, with
  Markdown image syntax: `![alt](screenshots/<name>.png)`.
  Filenames are lowercase-kebab-case under `screenshots/`. The
  user is taking the actual screenshots; we just leave the
  references.
- **Cross-references by chapter number.** "See chapter 8 for the
  full keyboard reference."
- **Honesty over polish.** When something is missing in code (e.g.
  the I-V window has no timecourse plot the outline mentions), say
  so plainly and suggest the workaround. Don't paper over it.

### Per-chapter conventions for analysis windows

Each Part II chapter follows roughly this order:

1. Intro paragraph(s) — what it does, the physics, when to reach
   for it.
2. *When to use this window* — three or four concrete workflow
   examples.
3. *Window layout* — top bar, left pane, right pane (mini-viewer
   over results). Note where it diverges from the established
   pattern.
4. *Mini-viewer and cursors* — table of cursor pairs with colour
   and purpose. Mention the header strip controls (Zero offset,
   Reset cursors, Reset zoom).
5. *Parameters / fit options* — the left-panel form. Methods
   explained inline.
6. *Run controls* — All / Range / Single / Selected /
   averaged-range, plus Clear / Export CSV / Run.
7. *How the numbers are computed* — step-by-step algorithm prose
   with formulas as block-quoted equations where they help.
8. *Results table / plot* — columns, decimals, selection, copy.
9. *Persistence* — short paragraph on sidecar vs global prefs.

### Hard-won facts to keep in mind

- Cursor colours are **green / yellow / purple** for Baseline / Peak
  / Fit (not grey / pink / orange — that was an outline error).
- Mouse wheel **zooms X by default**, not pans. Alt-wheel zooms Y;
  Shift-wheel zooms stim.
- Drag pans with Zoom mode off (default); drag-rectangle zooms
  with it on.
- AP markers are **dots**, not vertical lines, and form a
  constellation when kinetics are measured.
- The viewport bottom slider is a **plain scrollbar**, not a
  draggable rectangle with resize-edges.
- The Cursor Panel **does not launch analyses** — those are only
  on the toolbar's Analyses dropdown.
- There is **no native menu bar and no `⌘O`** — file open is
  toolbar-only.
- Single-letter shortcuts (`o`, `a`, `z`, `f`) are **lowercase, no
  modifiers**.
- File menu, File→Close, Help button: **none of these exist** in
  the toolbar — don't reintroduce them.
- The sidecar holds analysis results plus UI state, but **not**
  raw samples — except for averaged sweeps, which do store their
  computed samples.

### Screenshot index (already referenced in the manual)

All paths relative to `docs/`:

- `screenshots/main-window-overview.png`
- `screenshots/toolbar-open-file-dropdown.png`
- `screenshots/toolbar-full-left-to-right.png`
- `screenshots/toolbar-average-popover.png`
- `screenshots/tree-navigator-series-row.png`
- `screenshots/tree-navigator-sweep-multi-select.png`
- `screenshots/trace-viewer-right-click-menu.png`
- `screenshots/trace-viewer-cursors.png`
- `screenshots/cursor-panel-readout.png`
- `screenshots/settings-popover-palettes-fonts.png`
- `screenshots/settings-popover-trace-colors.png`
- `screenshots/sidecar-json-excerpt.png`
- `screenshots/cursor-window-overview.png`
- `screenshots/cursor-window-mini-viewer.png`
- `screenshots/cursor-window-results-table.png`
- `screenshots/resistance-window-main-layout.png`
- `screenshots/resistance-window-fit-overlay.png`
- `screenshots/iv-window-full-layout.png`
- `screenshots/iv-window-curve-tab.png`
- `screenshots/ap-window-counting-tab.png`
- `screenshots/ap-window-kinetics-tab.png`
- `screenshots/paired-window-overview.png`
- `screenshots/paired-overlay-viewer.png`
- `screenshots/paired-statistics-tab.png`
- `screenshots/paired-sta-tab.png`

The user is creating a `docs/screenshots/` directory and will fill
it in as we go. Don't gate prose on screenshots being present —
the references render as broken images until they land, which is
fine.

---

# Part I — General

## 1. Getting Started

### App shell (Electron)
- Window title: "TRACER"
- Min size: 1000×700 px
- Window bounds persisted in `preferences.json` → `windowBounds`
- Backend: Python FastAPI subprocess on a dynamically-allocated local port (fallback `8321`)
  - Health-checked via `GET /health` (60 s timeout)
  - Red banner on startup failure: "Backend failed to start"

### File operations
- File → Open... (`Cmd+O`)
  - Supported formats: `.dat` (HEKA), `.abf` (Axon), `.csv` / `.tsv` / `.txt` / `.atf` (text — TextImportWizard)
- File → Recent Files
  - Persisted in `preferences.json` → `recentFiles` (up to ~10)
  - "Clear recent" entry at the bottom of the submenu
- File → Close — POST `/api/files/close`, resets UI state

### Help / About
- Help button — opens this user manual
- Bug-report button — opens an in-app Tally form (form ID `ZjvoQB`); no GitHub account needed; auto-attaches `app_version, os, view, recording_format, recording_size, last_error, submission_id` (filenames / paths deliberately omitted); user-visible fields: title, description, steps, expected, severity, optional email, optional screenshot

---

## 2. Toolbar

Left-to-right.

### File & Settings
- Open File button (file picker; routes text formats to TextImportWizard)
- Settings popover
  - Theme: Dark / Light
  - Palette: Classic / Telegraph
  - Font family: IBM Plex Sans, Inter, SF Pro, Helvetica Neue, System default
  - Mono font: JetBrains Mono, Fira Code, SF Mono, Consolas
  - Font size slider (11–15 px)
  - Trace color pickers (6 slots: channels 1–5 + stimulus)
  - Reset trace colors

### Analyses dropdown (opens dedicated child windows)
Order in the actual menu (`Toolbar.tsx:98–108`):
- Cursor Measurements
- Rs / Rin / Cm
- I-V Curve
- Action Potentials
- **Paired Recording**
- Event Detection
- Burst Detection
- Field Potential (LTP / I-O / PPR)
- Spectral Analysis
- Metadata
- Trace Export
- Batch
- Cohort
_(Spectral is in the dropdown but its window is minimal — flag this when writing chapter 2 prose. Metadata (Tags), Trace Export, Batch, Cohort are NOT in the Analyses ▾ menu — they live in the separate **Tools ▾** dropdown immediately to its right.)_

### Sweep navigation (only visible when a file is open)
- Prev / Next buttons (`←` / `→`)
- Sweep status display: `currentSweep+1 / totalSweeps` (e.g. `3 / 47`); `-- / --` when no recording

### Trace display
- Scaling button — opens per-channel unit / scaling override modal
- Traces dropdown
  - Checkbox per recorded channel + stimulus trace
  - Right-click a channel → opens scaling modal pre-focused on that channel
- Overlay button — toggles overlaying all sweeps on the main trace (semi-transparent)
- Average popover
  - Mode: All sweeps / Selected / Range (with from/to inputs)
  - Label input
  - Create averaged sweep — adds a virtual entry to the tree, persisted to sidecar
  - List of existing averaged sweeps, each with a delete button

### Zoom mode toggle
- Off (default): wheel scrolls (pan)
- On: drag a rectangle to zoom

### Excluded sweeps (eye / filter button)
- Dropdown of currently excluded sweeps, checkbox per row to re-include
- "Clear excluded" action

---

## 3. Tree Navigator (left sidebar)

### Hierarchy
- Group level — label, expand/collapse chevron, series count badge
- Series level
  - Type badge (VC / CC / FP), color-coded; guessed from label / protocol / holding voltage
  - Sweep count badge
  - Analysis-presence pills: E (Events), AP, B (Bursts), IV, C (Cursors), FP, R (Resistance), P (Paired)
  - Tag chip (first tag from Metadata window, hover to see all)
- Sweep level
  - Excluded indicator (strikethrough / greyed)
  - Click to select sweep
  - Shift-click for range selection, Cmd/Ctrl-click for additive
- Averaged sweep entries (virtual)
  - Label `Avg: {custom name}`
  - Click to load into main viewer

### Selection state
- `selectedSweeps[group:series]` — sweep-index array, drives Average / Batch
- `excludedSweeps[group:series]` — sweep-index array, removed from analyses; persisted via sidecar

---

## 4. Main Trace Viewer

### Plot area
- uPlot-based interactive plot, dual Y-axes (primary recorded + secondary stimulus / additional)
- Auto-resizes via `ResizeObserver`; max-points target tied to pixel-width × DPR (debounced)

### Mouse interactions
- Wheel: pans by default; drag-rectangle zooms when Zoom mode is on
- Wheel near a Y-axis edge: zooms that axis only
- Click-drag on plot interior pans
- Right-click → context menu (`PlotMenu`):
  - Copy PNG
  - Save PNG…
  - SVG entries appear only when the viewer supplies a `getSvg` source — none of the trace / sweep viewers do; only `CohortWindow` (matplotlib SVG strings from the backend)

### Viewport bar (top)
- Reset zoom button
- Zoom / pan controls

### Viewport slider (bottom — continuous mode only)
- Single-sweep recordings > 60 s
- Draggable rectangle over the full timeline (drag to pan, edges to resize)
- Single-click on the strip jumps the viewport to that region

### Cursors (drawn overlay, transparent canvas)
Three pairs, each individually toggleable:
- Baseline (grey) — `cursors.baselineStart` / `baselineEnd`
- Peak (pink) — `cursors.peakStart` / `peakEnd`
- Fit (orange) — `cursors.fitStart` / `fitEnd`

Drag edges to resize; drag the band interior to translate both edges. Snap threshold 8 px.
Master `showCursors` toggle hides all three. Default: cursors OFF on the main viewer.

### Analysis markers
- Burst markers — shaded burst regions (`showBurstMarkers`)
- AP markers — vertical lines at peaks; auto = solid, manual = with a ring
- Event markers — dots at detected peaks (color-coded by event type) (`showEventMarkers`)
- Markers respect `data.zeroOffsetApplied` so they follow the shifted trace when zero-offset is on

### Stimulus overlay
- Reconstructed from `.pgf` (HEKA)
- Right-axis units: mV (VC) or pA (CC)
- Color via `--stimulus-color`
- Show/hide in Traces dropdown

### Coordinate readout (hover)
- `showCoordinates` toggle: tooltip following pointer with `(time_s, value_unit)`, snapped to nearest sample

### Trace data fetch
- `/api/traces/data?group=...&series=...&sweep=...&trace=...`
- Returns `{time, values, sampling_rate, units, label}`
- Optional `viewport={start_s, end_s}` for continuous mode
- Optional `filter={enabled, type, cutoff, order}`
- Decimated via LTTB to ~4000 points
  - **LTTB (Largest-Triangle-Three-Buckets, Steinarsson 2013):** divides x into `n_out` buckets; for each bucket picks the point that, together with the previously kept point and the next bucket's centroid, forms the triangle of largest area. Preserves visual peaks/valleys with non-uniform sampling.

### Zero-offset toggle
- `zeroOffset` per `(group, series, trace)`
- Subtracts the first sample from all samples (relative DC removal)
- Persisted via sidecar

### Filter controls (in CursorPanel; per channel)
- Enabled checkbox; type Lowpass / Highpass / Bandpass; cutoff(s) in Hz; order 1–4
- Backend: zero-phase Butterworth via SciPy `sosfiltfilt`
  - **`padtype='constant'`** (edge-value padding) instead of default odd-reflection — avoids ringing at t=0 on traces with non-zero DC
  - On signals shorter than `6 × n_sections`, falls back to one-way `sosfilt`
- State stored per `(group, series, trace)` in `filters`; persisted via sidecar
- Per-analysis windows inherit the main viewer's filter on mount

### Keyboard shortcuts (TraceViewer)
- `←` / `→` — scroll viewport by one window (continuous mode); previous / next sweep otherwise
- `Shift+←` / `Shift+→` — scroll by half / two windows (depending on handler)
- `Home` / `End` — jump to start / end of viewport
- Skipped while a text input or textarea has focus

---

## 5. Cursor Panel (right sidebar)

### Analysis selector (top of panel)
Run-Analysis dropdown opens the corresponding child window (or focuses an open one):
- Cursor Measurements, Resistance, I-V Curve, Action Potentials, Event Detection, Burst Detection, Field Potential

### Cursor configuration
Three rows (Baseline, Peak, Fit), each with:
- Show/hide checkbox
- Start / End numeric inputs (seconds, absolute)

### Quick readout (current sweep, computed in the renderer)
- Baseline (mean over baseline window) + unit
- Peak (sample with largest |deviation| from baseline within peak window) + unit
- Amplitude (peak − baseline) + unit
- Peak time (ms, relative to sweep start)
- _Note: SD / MAD noise stats and exponential-fit τ / R² are not part of the right-panel readout. The full cursor measurements (rise time, half-width, area, exponential fit, etc.) live in the Cursor Measurements child window — see chapter 9._

### Filter panel
- See main-viewer Filter Controls above

### Auto-place cursors
- Analysis windows can broadcast `auto-place-cursors` to suggest positions; the user can always edit the inputs manually

### BroadcastChannel listeners
- `auto-place-cursors`, `iv-update`, `fpsp-update`, `cursor-analyses-update`, `ap-update`, `bursts-update`, `paired-update`, `excluded-update`, `averaged-update`, `file-close`, `state-request` / `state-update`

---

## 6. Settings & Theme

### Theme (themeStore)
- Theme: dark | light
- Palette: classic (neutral grey + light blue) | telegraph (warm amber-on-black / vellum)
- Font family + mono font (drop-down lists; empty = theme default)
- Font size 11–15 px (`--font-size-base`)
- Trace colors (slots 0–4 = channels 1–5, slot 5 = stimulus); empty = stylesheet default

### CSS variables (consumed by components)
- `--theme`, `--palette`
- `--bg-primary`, `--bg-secondary`
- `--text-primary`, `--text-secondary`, `--text-muted`
- `--trace-color-1` … `--trace-color-5`, `--stimulus-color`
- `--cursor-baseline`, `--cursor-peak`, `--cursor-fit` (+ `-fill` variants)
- `--border`, `--border-subtle`
- `--success`, `--error`, `--warning`

### Persistence
- Primary: Electron `preferences.json` (loaded sync at startup)
- Fallback: localStorage when Electron is unavailable

---

## 7. Persisted State

### Electron prefs (`{appData}/preferences.json`)
- `windowBounds` — `{x, y, width, height, maximized}`
- `recentFiles` — array of paths (max ~10)
- `layout` — `leftCollapsed`, `rightCollapsed`, `focusMode`, `leftWidth`, `rightWidth`
- `theme` — see chapter 6
- `cursorWindowUI` — `visibleColumns`, `topHeight` (splitter position)
- `pairedWindowUI` — `topHeight` (results splitter), `leftPanelWidth` (sidebar splitter)
- Per-file slots, all keyed by `filePath`:
  - `savedFieldBursts`, `savedBurstFormParams`
  - `savedIVCurves`
  - `savedFPspCurves`
  - `savedCursorAnalyses`
  - `savedExcluded`
  - `savedAveraged`

Inside each per-file slot, per-series keying is always `${group}:${series}`.

### Sidecar file (`{recordingPath}.tracer`, JSON)
Created on first analysis run. Top-level shape:
```json
{
  "tracer_version": "...",
  "created": "...",
  "recording": {"source_file": "...", "format": "..."},
  "analyses": {
    "cursors":    {"<group>:<series>": { ... }},
    "resistance": {"<group>:<series>": { ... }},
    "iv":         {"<group>:<series>": { ... }},
    "fpsp":       {"<group>:<series>:<mode>": { ... }},
    "bursts":     {"<group>:<series>": { ... }},
    "ap":         {"<group>:<series>": { ... }},
    "events":     {"<group>:<series>": { ... }},
    "paired":     {"<group>:<series>": { ... }}
  },
  "forms": {
    "paired":     { ... last-used Paired form state, single-shot ... }
  },
  "ui_state": {
    "excluded_sweeps":  {"<g>:<s>": [..]},
    "averaged_sweeps":  {"<g>:<s>": [{label, sweeps, time, values}, ...]},
    "zero_offset":      {"<g>:<s>:<t>": bool},
    "visible_traces":   {"<g>:<s>": [trace indices]},
    "filters":          {"<g>:<s>:<t>": {enabled, type, cutoff, order}}
  }
}
```

### Cross-window sync (`BroadcastChannel('tracer-sync')`)
- `state-request` / `state-update`, `cursor-update`, `sweep-update`, `selection-update`,
  `bursts-update`, `iv-update`, `fpsp-update`, `cursor-analyses-update`, `paired-update`,
  `excluded-update`, `averaged-update`, `burst-form-params-update`, `detection-filter`,
  `auto-place-cursors`, `file-close`

---

## 8. Keyboard Shortcuts (consolidated)

### Global
- `F1` — toggle left sidebar
- `F2` — toggle right sidebar
- `F` — toggle focus mode (hide all panels)
- `Cmd+O` — open file

### Main TraceViewer (continuous mode)
- `←` / `→` — scroll one viewport width
- `Shift+←` / `Shift+→` — half- or double-step (handler-dependent)
- `Home` / `End` — jump to start / end

### Burst Detection viewer
- `←` / `→` — back / forward by viewport width
- `PageUp` / `PageDown` — `±3 × viewport`
- `Home` / `End` — sweep start / end
- Left-click adds a manual burst; right-click / double-click removes
- Active only while the viewer has focus

### Tables (most analysis windows)
- Shift-click — multi-select range
- Cmd/Ctrl-click — additive multi-select
- Right-click — Copy row as TSV (most tables)
- `Cmd+C` — copy selected rows as TSV (where wired)

_All key handlers skip when the focused element is `INPUT` / `TEXTAREA` / `contentEditable`._

---

# Part II — Analysis Modules

Each chapter documents one analysis window. Algorithms ("how does this method work") are listed inline, as a sub-bullet of the parameter that selects them.

---

## 9. Cursor Measurements

### Layout
- Top: Group / Series / Channel selectors + sweep arrows (`⟨⟨ ⟪ ◀ ▶ ⟫ ⟩⟩`)
- Mini-viewer (left, ~40 %)
  - Reset cursors + Zero offset toggles in header
  - Pre-detection filter applied live
  - Cursors draggable on the trace
- Slot controls
  - Slot count spinner (1–10)
  - Per-slot: independent baseline / peak / fit cursor windows + color
- Tab strip: Measurements / Kinetics / column toggles
- Columns toggle dropdown (persisted in `cursorWindowUI.visibleColumns`)
- Results table (right)
  - One row per (slot, sweep)
  - Click row → highlight on mini-viewer
  - Shift-click multi-select → Copy as TSV; right-click → Copy row as TSV

### Measurements (per slot, per sweep)
Backend: `analysis/cursors.py` (`CursorMeasurements`).
- baseline — mean over baseline window
- baseline_sd — std-dev over baseline window
- peak — sample within peak window with largest |deviation from baseline|; sign preserved
- amplitude — peak − baseline
- peak_time — sample index × dt
- riseTime — 10–90 % rise time
  - **10–90 % rise:** linear-interpolate the times at which the trace first crosses `baseline + 0.1·amp` and `baseline + 0.9·amp` between baseline window start and peak; report `|t90 − t10|`
- halfWidth — duration at 50 % amplitude
  - **Half-width:** linear-interpolate crossings of `baseline + 0.5·amp` immediately before and after the peak; report difference
- area — trapezoidal integral of `(values − baseline)` over the peak window

### Per-sweep exponential fit (within the Fit cursor window)
- tau (ms), fit_r_squared
- Available fit functions enumerated by `GET /api/cursors/fit_functions` — describe each one in user terms when writing prose

### Persistence
- Store key: `cursorAnalyses[group:series]`
- Window UI: `cursorWindowUI` (visibleColumns, topHeight)

### Keyboard
- `←` / `→` — previous / next sweep
- `Escape` — close window
- `Cmd+C` — copy selected rows as TSV

---

## 10. Resistance (Rs / Rin / Cm)

### Layout
- Group / Series / Channel / Source-mode selectors + sweep arrows
- Cursor windows: Baseline / Pulse (peak) / Fit
- Mini-viewer with draggable cursors, Reset cursors + Zero offset toggles, live pre-detection filter
- Results table — Sweep | Rs (MΩ) | Rin (MΩ) | Cm (pF) | Tau (ms) | R² | Source
- Monitor graph — Rs / Rin (left axis), Cm (right axis) over sweep number; click point → jump to that sweep

### Algorithm (`analysis/resistance.py`)
- **Baseline:** mean over the baseline cursor window
- **Peak current:** within the first 5 ms of the pulse window (or half the pulse length, whichever is shorter) take the most-deviating sample (`min` if `|min| ≥ |max|`, else `max`), measured baseline-subtracted
- **Steady-state:** mean of the last 20 % of the pulse window
- **Rs:** `|V_step| / |I_peak − baseline|` × 1000 → MΩ
- **Rin:** `|V_step| / |I_steady − baseline|` × 1000 → MΩ
- **Cm:** from the exponential decay fit starting at the measured peak (avoids the 1–2-sample command/response lag), via `scipy.optimize.curve_fit`
  - `n_exp = 1` → `a · exp(−t/τ) + offset` — single τ
  - `n_exp = 2` → `a1 · exp(−t/τ1) + a2 · exp(−t/τ2) + offset` — fast / slow components, sorted so τ_fast first; reported τ is the amplitude-weighted average
  - Bounds: τ ∈ `[0.01 ms, 0.9 × fit_duration_ms]`; `maxfev = 10000`
- **Cm = τ / Rs × 1000** (pF), accepted only when `0.1 < Cm < 2000`
- **R²:** `1 − SS_res / SS_tot` on the fitted slice

### Persistence
- Store key: `resistanceResults[group:series]`

### Keyboard
- `←` / `→` — previous / next sweep
- `Escape` — close window

---

## 11. I-V Curve

### Layout
- Group / Series / Channel selectors + sweep arrows
- Response metric selector: Peak | Slope | Area | Mean
- Baseline / Peak cursor windows
- Im-source selector — auto-detected from `.pgf`; manual override (start_s, end_s, im_start, im_step) when `.pgf` is unavailable
- Filter controls (live on mini-viewer)
- Mini-viewer with stimulus overlay, draggable cursors, Reset / Zero-offset toggles
- Results table — Sweep | Stim | Response | Slope | Area | …
- Curve graph — points + linear-fit overlay; summary box with Erev (intercept) and conductance (slope); click point → jump to sweep

### Algorithm
- For each included sweep:
  - Baseline = mean over baseline window
  - Response = chosen metric over peak window:
    - Peak — most-deviating sample relative to baseline
    - Slope — input resistance: linear regression of response vs. stim within the peak window (units/stim-unit)
    - Area — trapezoidal integral of `(values − baseline)` over peak window
    - Mean — mean over peak window
- Stim level: mean of the stimulus channel during the peak window (or value from auto-detected `.pgf` step / ramp)
- Linear fit (`scipy.stats.linregress`) → slope (conductance) + intercept (Erev) + R²

### Endpoint
- `POST /api/iv/run` with `{group, series, trace, sweeps, baseline_*, peak_*, response_metric, filter}`

### Persistence
- Store key: `ivCurves[group:series]`

### Keyboard
- `←` / `→` — previous / next sweep
- `Escape` — close window

---

## 12. Action Potentials

Backend: `analysis/ap.py`.

### Layout
- Group / Series / Vm channel / Im channel selectors + sweep arrows
- Detection params (shared across tabs)
  - Method dropdown:
    - **manual** — upward crossing of `manual_threshold_mv`, then within `width_ms` a downward crossing back; peak = argmax(Vm) between the two
    - **auto_spike** — `+dV/dt` crossing `pos_dvdt_mv_ms` opens a candidate; search up to `width_ms` for `−dV/dt` below `neg_dvdt_mv_ms`; peak = argmax(Vm) between them; reject when `peak − local_baseline < min_amplitude_mv`
    - **auto_rec** — same first pass as `auto_spike`, then re-runs detection with an adaptive level threshold `(median(peak_Vm) + median(threshold_Vm)) / 2`; helps catch lower-amplitude follow-on spikes during accommodation
  - Min amplitude (mV)
  - Pos/neg dV/dt thresholds (mV/ms)
  - Spike width (ms) — search horizon from rising edge to fall
  - Min refractory distance (ms) — merges peaks within this; keeps the highest
  - Bounds start / end (s)
  - Filter controls (lowpass / highpass / bandpass via `_apply_pre_detection_filter`)
- Run mode: All sweeps / Range / Single sweep + Run / Clear buttons

### Tab 1 — Counting
- Per-sweep table — Sweep | Spike count | Latency | Mean ISI | SFA | Local variance
  - **First-spike latency:** `first peak time − im_onset_s` (from `.pgf`)
  - **SFA divisor:** `ISI_first / ISI_last`
  - **Local variance (Shinomoto 2003):** `mean(3·(ISIᵢ − ISIᵢ₊₁)² / (ISIᵢ + ISIᵢ₊₁)²)` — robust accommodation metric; needs ≥ 2 ISIs
- F–I curve graph — `im_mean_pa` (over bounded window) vs `spike_rate_hz`, one point per sweep
- Rheobase readout
  - **Mode `record`** — Im of the first sweep that fired
  - **Mode `exact`** — Im at the exact sample of the first AP's peak, baseline-corrected by subtracting the median of the first 100 ms of the bounded window
  - **Mode `ramp`** — linear interpolation `i_start + frac·(i_end − i_start)` where `frac = (peak_t − t_start) / (t_end − t_start)`; uses user-supplied ramp params

### Tab 2 — Kinetics
Per-spike table; threshold method dropdown (8 variants):
- **first_deriv_cutoff** — first index in the search window where `dV/dt ≥ threshold_cutoff_mv_ms`
- **first_deriv_max** — `argmax(dV/dt)` in the search window
- **third_deriv_cutoff** — first index where `d³V/dt³ ≥ cutoff` (computed as two extra `np.gradient` passes scaled by `(sr/1000)²`); falls back to `argmax(d³V)` if no crossing
- **third_deriv_max** — `argmax(d³V/dt³)`
- **sekerli_I** — `argmax(d²V / dV)` (Sekerli et al. 2004), masked to samples where `dV/dt > sekerli_lower_bound_mv_ms` to avoid divide-by-near-zero
- **sekerli_II** — `argmax((d³V·dV − d²V²) / dV³)` with the same lower-bound mask
- **leading_inflection** — `argmin(dV/dt)` in the search window (most-negative `dV` just before the foot of the spike)
- **max_curvature** — `argmax(κ)` where `κ = d²V / (1 + dV²)^(3/2)` (Rossokhin & Saakian 1992)

Other kinetics options:
- Interpolate to 200 kHz (linear `np.interp` upsampling, used only for % crossing times — `dV/dt` is still computed on the original signal)
- Rise-time low / high % (default 10 / 90); decay low / high %
- Decay endpoint: `to_threshold` (default) | `to_fahp` (uses min Vm in the fAHP window as the floor)
- fAHP search window (ms after peak), mAHP search window (ms after peak)
- Max-slope window (ms) — sliding-mean window over `dV/dt` whose `argmax|·|` gives `max_rise_slope` / `max_decay_slope`

Kinetics columns: threshold_vm, threshold_t_s, peak_vm, peak_t_s, amplitude_mv, rise_time_s, decay_time_s, half_width_s, fahp_vm, fahp_t_s, mahp_vm, mahp_t_s, max_rise_slope_mv_ms, max_decay_slope_mv_ms, manual.

### Tab 3 — Phase plot
- Prev / next AP buttons + spike index spin-box
- Window-size slider (ms around peak)
- Cubic-spline-style upsampling factor slider
  - **Implementation:** `np.linspace` × `interp_factor`, linear `np.interp`, then `dV/dt` recomputed on the upsampled grid
- Plot: Vm (x) vs `dV/dt` (y, mV/ms)
- Threshold cutoff line at `dV/dt = threshold_cutoff_mv_ms`
- Metrics: max Vm, max dV/dt, min dV/dt

### Manual spike editing
- Left-click — add spike, snapped to local Vm max within ±`min_distance_ms / 2`; ignored if too close to an existing peak
- Right-click — remove spike (drops auto-detected peaks within `min_distance_ms` of the click)
- Stored as `manual_edits = {added: {sweep: [t_s,...]}, removed: {...}}`; replayed on every re-run so edits survive parameter tweaks
- Each output spike carries `manual: bool` for marker styling

### Endpoints
- `POST /api/ap/run`
- `GET /api/ap/phase_plot?...`
- `GET /api/ap/auto_im_params` — auto-detect ramp params from `.pgf`

### Persistence
- Store key: `apAnalyses[group:series]` — `detectionMethod`, `manual_threshold_mv`, kinetics params, `perSweep`, `perSpike`, `fiCurve`, `rheobase`, `manualEdits`, `selectedSpikeIdx`

### Keyboard
- `←` / `→` — previous / next sweep
- `Home` / `End` — first / last sweep
- `[` / `]` — previous / next spike
- `Escape` — close window

---

## 13. Event Detection

Backend: `analysis/events.py`. Spontaneous-event detection (mEPSCs, mIPSCs, ...).

### Layout
- Detection mode selector
- Mini-viewer with bounds, draggable cursors, Reset / Zero-offset toggles, live filter
- Event browser — navigate / accept / reject; per-event kinetics table; histograms (amplitude, IEI, decay τ); mean-event waveform; template-refinement flow

### Detection methods
- **Threshold** (`detect_threshold`)
  - User-defined threshold + direction (`negative` | `positive`)
  - Open a region whenever the signal is on the more-extreme side; close on return-crossing
  - Peak = most-extreme sample inside the region
  - Min IEI enforcement: thin retained peaks by descending extremity, dropping any closer than `min_iei_ms`
- **Template — correlation** (`detect_correlation`, Jonas et al. 1993)
  - Sliding Pearson r between data window and biexponential template (Clements–Bekkers formulation, O(N·W))
  - Accept windows where `r ≥ cutoff` (default 0.4); after run-start picking, refine each candidate to the data-space extremum within the template width
- **Template — deconvolution** (`detect_deconvolution`, Pernía-Andrade et al. 2012)
  - Fourier-domain deconvolution of data by template, then bandpass `[low_hz, high_hz]`
  - Fit a Gaussian to the deconvolution amplitude histogram → `(μ, σ)`; threshold = `cutoff_sd · σ`
  - Always look for positive peaks in the deconvolved trace (template polarity already inverts inside the FFT division); refine each peak to the data-space extremum within ~10 ms

### Template fitting (`fit_biexponential`)
- Model: `f(t) = b0 + b1·(1 − exp(−t/τ_rise))·exp(−t/τ_decay)`
- Direction: `auto` (sign inferred from data) | `negative` (force `b1 < 0`) | `positive` (force `b1 > 0`)
- Bounds: τ_rise ∈ [0.01 ms, min(span, 100 ms)]; τ_decay ∈ [0.1 ms, min(5×span, 2 s)]
- Reports `b0, b1, τ_rise, τ_decay, R²`

### Per-event kinetics (Jonas 1993 foot-intersect + standard metrics)
- **Baseline:** line through the 20–80 % rise points, back-extrapolated to the pre-event baseline level
- **Peak:** two-pass — detect on raw, refine on lightly-smoothed signal
- amplitude (signed)
- rise time at configurable %
- decay time at configurable %
- half-width (FWHM)
- AUC — trapezoidal integral over (foot, decay endpoint)
- decay τ — monoexponential `y = baseline + a·exp(−t/τ)` fit
- Per-event biexponential fit — full `b0, b1, τ_rise, τ_decay` plus `R²`

### Exclusion filters (post-kinetics)
- amplitude_min / amplitude_max
- min IEI
- min biexp R² (drops fits that didn't converge)

### Manual edits
- `added` (list of peak times, snapped to nearest local extremum within tolerance)
- `removed_peak_times` (drops auto peaks within tolerance)
- Each event carries `manual: bool`

### Endpoints
- `POST /api/events/detect`
- `POST /api/events/detect_stream` (server-sent events for long recordings)
- `POST /api/events/template_fit`
- `POST /api/events/refine_template`

### Persistence
- Store key: `events[group:series]` — method, params, events, accepted, kinetics

---

## 14. Burst Detection (Field Bursts)

Backend: `analysis/bursts.py`. Continuous-mode central viewer.

### Layout
- Group / Series / Channel selectors + sweep arrows
- Method tabs: Threshold / Oscillation / ISI
- Shared filter controls + noise estimator
- Method-specific params
- Pre-burst window (ms) — context shown before each burst
- Run controls (All / Range / Single)
- Central continuous-mode viewer with viewport presets (Full / 5 min / 1 min / 30 s / 10 s / 1 s + custom seconds), keyboard nav, draggable scroll-indicator slider
- Left-click adds a manual burst; right-click / double-click removes
- Results table with Accept checkbox per burst; right-click → Copy row as TSV
- Bursts-per-sweep graph; click point → jump to that sweep

### Filter (pre-detection)
- Bandpass / lowpass / highpass via `_apply_pre_detection_filter` (same Butterworth + `sosfiltfilt` as the global filter)
- Default for epileptiform: bandpass 1–50 Hz

### Noise estimator (`_noise_estimate`)
- **`sd`** — `np.std(signal)`. Sensitive to bursts; OK after a bandpass filter has cleaned drift.
- **`mad`** — `1.4826 · median(|x − median(x)|)`. Robust to bursts.
- **`mad_diff`** — MAD of first-differences, divided by √2 and scaled ×1.4826. Robust to bursts AND to slow drift.

### Baseline mode (shared by threshold + oscillation)
- **`percentile`** (default) — baseline = Nth percentile of the (filtered) sweep; threshold = baseline + `n_sd` · noise
- **`robust`** — baseline = median; threshold same form
- **`rolling`** — baseline = sliding-window median (default 5 s, kernel via `scipy.ndimage.median_filter`, reflect mode); signal is detrended before threshold comparison
- **`fixed_start`** (legacy) — baseline = mean of the first `baseline_end_s` of the sweep; noise from same window

### Method 1 — Threshold (`_threshold_method`)
- Params: `n_sd` (default 2.0), `smooth_ms` (10), `min_duration_ms` (50), `min_gap_ms` (100), `peak_direction` (auto/positive/negative)
- **Algorithm:** apply pre-detection filter → estimate baseline + noise → rectified `|signal − baseline|` → uniform-filter (`smooth_ms`) → mask `> n_sd · noise` → extract contiguous epochs (merge gaps shorter than `min_gap_ms`, drop epochs shorter than `min_duration_ms`) → measure each burst on the FILTERED signal

### Method 2 — Oscillation (`_oscillation_method`)
- Params: `low_freq` (4 Hz), `high_freq` (30 Hz), `n_sd` (2.0), `smooth_ms` (50), `min_duration_ms` (100), `min_gap_ms` (200)
- **Algorithm:** optional pre-detection filter → 4th-order Butterworth bandpass `[low_freq, high_freq]` via `sosfiltfilt` → Hilbert analytic signal → envelope = `|hilbert|` → uniform-filter → estimate baseline + noise on the envelope → threshold = `baseline + n_sd · noise` → extract epochs as above
- Per burst: also reports `mean_power` and `peak_power` (envelope mean/max within the burst)

### Method 3 — ISI (`_isi_method`)
- Params: `spike_threshold` (0 = auto = `4 · MAD(filtered)`), `min_spike_dist_ms` (2), `max_isi_ms` (100), `min_spikes_per_burst` (3)
- **Algorithm:** filter → centered = `|filtered − median|` → `scipy.signal.find_peaks(centered, height=threshold, distance=min_spike_dist)` → walk peaks: extend the current cluster while ISI ≤ `max_isi_ms`; emit a burst when ISI exceeds the cap and `len(cluster) ≥ min_spikes`
- Burst frequency reported as `1000 / mean_isi_ms` (overrides peak-counting frequency)

### Per-burst measurements (`_populate_burst_fields`)
Each burst's window is **extended outward** until the signal returns near its pre-burst baseline (stops at `tail_fraction · peak`, neighbouring burst's bound, or `max_extend_ms`). All metrics are then computed on the extended segment, against `pre_baseline` = mean of `pre_burst_window_ms` immediately before the burst (or after, if there isn't enough room before):
- `peak_amplitude` (`max |dev|` with sign per `peak_direction`), `peak_signed`, `peak_time_s`
- `mean_amplitude` (`mean |dev|`), `integral` (`sum |dev| / sr`)
- `rise_time_10_90_ms` — first sample where ascending `|dev|` ≥ 10 % to first ≥ 90 % of peak
- `decay_half_time_ms` — peak to first descending sample below 50 % of peak
- `mean_frequency_hz` — count of `find_peaks(smoothed, height=0.5·peak, prominence=0.3·peak, distance=20 ms)` over burst duration; ≥ 50 % peak height + ≥ 30 % prominence isolates real sub-peaks from envelope ripple

### Endpoints
- `POST /api/analysis/run` with `type="bursts"` (or method-specific via `/api/bursts/...`)

### Persistence
- `fieldBursts[group:series]` — bursts list + per-burst Accept state
- `burstFormParams[group:series]` — last-used params per method (per-method form state survives without Run)

### Keyboard
- See chapter 8 — `←` / `→`, `PgUp` / `PgDn`, `Home` / `End`
- `[` / `]` — previous / next burst
- `Escape` — close window

---

## 15. Field Potential (fEPSP / LTP)

Backend: `analysis/field_potential.py`.

### Modes (tabs)
- LTP — time-course
- I-O — stimulus intensity vs response
- PPR — paired-pulse ratio

### Shared layout
- Group / Series / Channel selectors + sweep arrows
- Measurement direction: auto | positive | negative
- Baseline / Volley / fEPSP cursor windows
- Auto-place cursors button (uses stim onset from `.pgf`)
- Filter controls (live on mini-viewer)
- Mini-viewer with stimulus overlay + Reset / Zero-offset toggles
- Results table — Sweep | Time (s) | Baseline | Volley | fEPSP | Slope | Amplitude | …; right-click → Copy row as TSV
- Time-course graph — baseline series + LTP series, distinct colors; horizontal 100 % line when normalized; click point → jump to sweep

### LTP-mode params
- Pick baseline series + LTP series separately
- Averaging — N consecutive sweeps per timecourse point
- Normalize — to % of baseline mean

### fEPSP slope (`_fepsp_slope`)
- **Trough:** `argmin(segment)` over the peak window
- **Local baseline:** mean of first `max(5 samples, 2 ms)` of the segment, used as the reference level
- **Slope-region detection:** scan from segment start to trough; first sample crossing `baseline + 0.1·amp` → `slope_start`; first crossing `baseline + 0.9·amp` → `slope_end`
- **Slope:** `linregress` of the slope segment in ms (slope in units/ms, plus R²)

### Population-spike mode (`_population_spike`)
- Find negative trough; bracket with the maximum sample to its left (`left_peak`) and to its right (`right_peak`)
- Linear-interpolate the baseline at the trough position: `left_peak + frac · (right_peak − left_peak)` where `frac = (trough − left_peak_idx) / (right_peak_idx − left_peak_idx)`
- Pop-spike amplitude = `interp_baseline − trough`

### PPR mode (`_paired_pulse_ratio`)
- Two pulse windows (pulse1, pulse2), measure either amplitude (min − pre-stim baseline) or slope on each
- PPR = `|val2 / val1|`; `facilitation = PPR > 1`

### Endpoint
- `POST /api/fpsp/run`

### Persistence
- Store key: `fpspCurves[group:series:mode]` (mode = `ltp` | `io` | `ppr`)

### Keyboard
- `←` / `→` — previous / next sweep
- `Escape` — close window

---

## 16. Paired Recording

Backend: `analysis/paired.py` (1075 lines), `api/paired.py` (222 lines).
Frontend: `components/AnalysisWindows/PairedWindow.tsx` (~2880 lines).

### What it does
Per-trial pre→post measurements on dual-channel sweeps. The user picks one channel as the "pre" trigger (action potential, electrical stim artefact, TTL pulse, or manually placed events) and a second channel as the "post" response. For each detected pre event the window measures amplitude / latency / kinetics on the post trace, classifies success vs failure, and aggregates across the series into release statistics (failure rate, potency, CV, 1/CV², paired-pulse ratio) and a spike-triggered average.

### Layout
- **Top bar:** Group, Series, Pre-channel, Post-channel selectors; sweep-mode picker (All / Range / Single); Run / Clear buttons; manual-edits clear button.
- **Left sidebar (resizable; width persisted in `pairedWindowUI.leftPanelWidth`):** parameter cards — Pre detection, Post window, Failure rule, Latency rule, Pre filter, Post filter.
- **Right top — overlay viewer:** single uPlot showing pre trace (left axis, primary colour) and post trace (right axis, secondary colour) on shared X. Pre-event markers and post-peak markers drawn on top. Two draggable cursor pairs delimit the post-search bounds.
- **Right bottom — results tabs (height persisted in `pairedWindowUI.topHeight`):**
  - Trials — per-trial table
  - Statistics — summary grid + PPR table + trial-sequence scatter
  - STA — spike-triggered average plot

### Selectors / channel pickers
- Group dropdown
- Series dropdown
- Pre trace index — must differ from Post; equal sampling rate enforced
- Post trace index — same
- Validation errors surface in a red banner under the Run button (e.g. "Pre and post channels must differ.", "Sampling rates differ.")

### Cursors / markers (overlay viewer)
- **Pre-event markers** — one dot per detected anchor on the pre trace (left axis). Click to prime, reclick to remove the trial.
- **Post-peak markers** — one dot per trial on the post trace (right axis). Green = success, pink = failure. Prime + reclick toggles a manual-failure flag (forces success = false).
- **Post-search bounds** — two band edges drawn when `showPostBounds = true`. Drag to set `postSearchStartS` / `postSearchEndS`; clips per-trial peak search.

### Parameters

Pre detection mode (`ap` | `stim` | `ttl` | `manual`):
- **AP** — reuses `_detect_spikes_sweep` from chapter 12. Params: method (`auto_spike` | `auto_rec`), `min_amplitude_mv`, `pos_dvdt_mv_ms`, `neg_dvdt_mv_ms`, `width_ms`, `manual_threshold_mv`.
- **Stim artefact** — `dvdt_threshold` (signal units / s) on `|d/dt|`, `min_distance_ms` debounce.
- **TTL** — `level_threshold` (auto = midpoint of trace if null), `edge` (rising / falling / both), `min_pulse_ms`.
- **Manual** — anchors come only from `manualEdits.added[sweep]`.
- Common: `min_distance_ms` (post-detection debounce), `bounds_start_s` / `bounds_end_s` (window within sweep where anchors are kept).

Pre filter (applied to pre trace before detection): `filter_enabled`, `filter_type` (lowpass / highpass / bandpass / notch), `filter_low`, `filter_high`, `filter_order`.

Post window:
- `preMs` — pre-anchor lookback before the baseline window (default 1.0)
- `baselineMs` — width of the per-trial baseline window (default 2.0); window = `[t_pre − preMs − baselineMs, t_pre − preMs]`
- `postMs` — post-anchor peak-search horizon (default 30); clipped by next anchor (with 0.2 ms guard) and by `postSearchStart/End`
- `peakDirection` — `auto` | `positive` | `negative`

Post filter (applied to post trace before measurement): same shape as Pre filter; default lowpass 1 kHz order 1.

Failure rule (`k_sd` | `absolute`):
- `kSd` — multiple of per-trial baseline σ; success when `|amp| ≥ k · σ` (default 3.0)
- `absolute` — absolute threshold in post units (default 0.0)

Latency rule (`fraction` | `onset_d2`):
- `fraction` — first time `|signal − baseline|` crosses `fraction · |peak|` (default 0.20 = 20 %)
- `onset_d2` — `argmax(d²/dt²)` of post over the search window

### Algorithms (one line each)
- **Anchor detection** — mode-dispatched (see above)
- **Pre amplitude per trial** — AP / manual: Vm at peak; stim: local `|d/dt|`; TTL: peak − min over preceding 1 ms
- **Per-trial baseline** — mean over `[t_pre − preMs − baselineMs, t_pre − preMs]`; baseline σ also computed here
- **Per-trial peak** — extremum (per `peakDirection`) over `[t_pre, t_pre + postMs]`, clipped by next anchor and by post-search bounds
- **Success** — `|peak − baseline| ≥ k · σ` (or ≥ absolute), unless manual-failure flag set
- **Latency** — fraction-crossing or `argmax(d²V/dt²)`, in ms relative to `t_pre`
- **Per-trial kinetics** — `measure_event_kinetics` on successes only (rise %, decay %, decay τ via monoexp, half-width)
- **Series summary** — n_trials, n_success, n_failures, failure_rate, mean_amplitude, mean_amplitude_zeroed (failures = 0), potency (mean of successes), CV, 1/CV², latency_mean_ms / latency_sd_ms
- **PPR** — `pulse_n / pulse_1` for each pulse n ≥ 2 within a sweep; only sweeps where pulse 1 is a success contribute
- **STA** — stack post windows aligned to `t_pre = 0`, NaN-padded for partial windows; mean + SEM; computed for `all`, `success`, `failure` subsets independently
- **STA decay fit** — monoexp `y = baseline + a·exp(−(t − t_peak)/τ)` on the decay phase (peak → end); reports τ (ms), R², fit curve

### Run modes
- **All** — runs every sweep in the series (default)
- **Range** — `sweepFrom` / `sweepTo` 1-indexed spinners
- **Single** — `sweepOne` spinner
- **Click-to-add manual events** — left-click on the pre trace adds a `manualEdits.added[sweep]` anchor at the click time; prime + reclick on a pre marker removes a trial; prime + reclick on a post marker sets `manualEdits.postFailed[sweep]`. Manual edits are replayed on every Run so they survive parameter changes (same pattern as AP / Events / Bursts windows).

### Results — tabs

**Trials** — per-trial table:
Sweep · # (trial index within sweep) · pre t (s) · amplitude · success (yes/no) · latency (ms) · rise (ms) · decay (ms) · τ_decay (ms) · half-width (ms) · baseline σ · truncated.
Failures shown with faint red row tint; manual-edited trials marked with `*`. Right-click → Copy row as TSV; Cmd+C copies multi-selected rows.

**Statistics** — three-panel grid:
- Series summary card — counts, failure_rate, mean_amp, mean_amp_zeroed, potency, CV, 1/CV², latency mean/SD
- PPR table — pulse n vs pulse 1, ratio, n contributing sweeps
- Trial-sequence scatter — X = trial index 1…N, Y = amplitude; blue dots = successes, red = failures

**STA** — spike-triggered average:
- Header — series picker (`all` / `success` / `failure`); checkboxes (overlay individual trials, include failures in overlay, show fit)
- Plot — X = time relative to `t_pre` (ms), Y = post amplitude. Bold mean curve + ±1 SEM ribbon; optional faint per-trial overlays; optional dashed monoexp fit line with τ label.
- Right-click → Copy / Save PNG (same `PlotMenu` as elsewhere; this viewer is canvas-based, no SVG source).

### Endpoints
- `POST /api/paired/run` — body: `{group, series, pre_trace, post_trace, sweeps?: int[], pre_mode, pre_params, post_params, failure_params, latency_params, manual_edits?}`. Returns `{per_trial[], per_sweep_summary[], series_summary{}, sta_all{}, sta_success{}, sta_failure{}, request, sampling_rate}`. 400 on validation errors.
- `GET /api/paired/trial_window` — query: `group, series, sweep, pre_trace, post_trace, t_pre_s, pre_ms (default 2.0), post_ms (default 30.0), max_points (default 2000)`. Returns LTTB-decimated pre/post windows for any time point — used by the overlay viewer when zooming into a single trial.

### Persistence
- **Sidecar** — `analyses.paired[group:series]` (results) and `forms.paired` (single-shot last-used form state — not per-series, unlike most other modules)
- **Electron prefs** — `pairedWindowUI = {topHeight, leftPanelWidth}`; saved on splitter `mouseup`
- **Store slice** — `pairedAnalyses` (`Record<"group:series", PairedData>`) + `pairedForm` (PairedFormState)

### Cross-window sync
- Emits `paired-update` carrying `{pairedAnalyses, pairedForm}` on every successful run, form change, or manual edit
- `CursorPanel.tsx` and `AnalysisWindow.tsx` adopt the slice in their `state-update` reply / receive handlers

### Keyboard
- No window-local key bindings beyond the global ones (Esc closes window). _NOT IN CODE_: ←/→ sweep nav, [/] trial nav. Worth flagging when prose lands.

### Status / UI states
- `running` — Run button label "Running…", form disabled
- `runError` — red banner under Run button (`"Pre and post channels must differ."`, etc.)
- Empty state — "No trials detected." in Trials tab when result is empty after a run

### Wiring status (verified 2026-05-07)
- ✅ Toolbar Analyses dropdown — label `Paired Recording`, position between Action Potentials and Event Detection
- ✅ TreeNavigator pill — letter **P**, colour `#7e57c2` (purple), shows when `pairedAnalyses` has any entry for that series
- ✅ Batch window — supports Paired recipes (`runPairedRecipe`)
- ✅ **Cohort export** — `extract_paired` registered in `EXTRACTORS` at `cohort.py:1155` with default metrics at `cohort.py:1248–1249` (failure rate, potency, CV, 1/CV², PPR). Flows through the generic export pipeline (Excel, Prism `.pzfx`).
- ✅ Sidecar — `analyses.paired` + `forms.paired` keys

### Suggested screenshots
- `screenshots/paired-window-overview.png` — full window, AP-mode detection, mid-run results
- `screenshots/paired-overlay-viewer.png` — pre/post overlay with markers, post-search bounds visible
- `screenshots/paired-statistics-tab.png` — series summary + PPR table + trial-sequence scatter
- `screenshots/paired-sta-tab.png` — STA mean ± SEM ribbon with fit overlay

---

## 17. Metadata

### Features
- Series-level tags (e.g. "baseline", "drug-washed", "post-tetanus")
- Group-level metadata (cell type, Vm at rest, Ra, ...)
- Free-text notes field
- Tag updates broadcast → TreeNavigator badge refresh

### Persistence
- `recordingMeta.series_tags[group:series]` — array of tag strings (sidecar)

---

## 18. Trace Export

### Features
- Sweep selector (multi-select grid)
- Preview panel (stacked or overlay)
- Per-channel trace editor (color, line width, scaling)
- Figure panel (layout, size, DPI, background color)
- Export buttons — PNG / PDF

### Endpoint
- `POST /api/trace_export/render` — returns rendered PNG/PDF

---

## 19. Batch

### Features
- Apply a single analysis to multiple files (folder / file-list pickers)
- Parameter inheritance from the main file
- Progress reporting per file
- Aggregated results panel

---

## 20. Cohort

### Features
- Aggregate analysis results across multiple files
- Population statistics (`analysis/cohort_stats.py`)
- Cohort graphs (`analysis/cohort_graphs.py`)
- Export to CSV / Excel; Prism `.pzfx` export pipeline (`analysis/cohort_export.py`) — per-analysis-type sheets

---

## 21. Train Grouping (events, APs, bursts)

### Features
- Cross-cutting post-detection feature: clusters of closely-spaced events labelled as trains (T1, T2, …)
- Off by default; one shared `Group into trains` panel per window (Burst / Event / AP), with module-aware defaults
- Algorithm shared between frontend (`utils/trains.ts`) and backend (`analysis/trains.py`); parity test in `tests/trains_parity.py`
- Live recompute on manual edits or parameter tweaks — never re-runs detection
- Visualisation: shaded amber spans + `T#` labels behind event markers
- Tables: per-event `Train` column + per-train summary (Burst card, Event Trains tab, AP sub-tab)
- CSV exports: `train_id` column on the main per-event CSV; dedicated `*_<module>_trains.csv` per-train summary CSV with parameters baked in
- Persistence: only the params are saved (`sidecar.train_params.<module>[group:series]`); results recomputed on demand
- Cohort: scalars (`n_trains`, `fraction_events_in_trains`, `mean_events_per_train`, `train_rate_per_min`, `mean_intra_train_iei_ms`, `mean_intra_train_freq_hz`) + distributions (`events_per_train`, `train_durations_ms`, `intra_train_iei_ms`, `inter_train_iei_ms`)
- Batch: template's `train_params` propagate to each target sidecar after the analysis runs

---

# Notes

- Cursor Measurements fit-function set: enumerate from `GET /api/cursors/fit_functions` when writing prose
- Spectral Analysis module: `backend/analysis/spectral.py` IS now surfaced in the toolbar Analyses dropdown (`Toolbar.tsx:107`), but the Spectral window is minimal. Decide when prose is written: document it briefly or mark "preview" / out of scope.
- Paired Recording: integrated with Cohort export via `extract_paired` (release stats: failure rate, potency, CV, 1/CV², PPR). No prose-side gap.
