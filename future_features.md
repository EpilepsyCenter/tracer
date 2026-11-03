# TRACER — future features

Ideas being considered, with what was decided about each. Not a
commitment. Last reviewed 2026-11-03 (after the 1.1.0 release).

Shipped from earlier versions of this list: startup splash screen,
Spectral Analysis, dual-site propagation (Burst window) and two-channel
coupling (Spectral window).

---

## Next: per-cell quality control

Planned in detail in **`docs/QC_PLAN.md`** (agreed 2026-11-03). In
short: a **Quality tab in Cohort** that measures nothing itself. It
reads the Resistance (Rs, Rin, Cm, holding) and Cursor (Vm) results
users already ran on tagged series. It compares them between
conditions the user picks from tag dropdowns (two by default, *Add
another*), applies editable rules saved in the folder, and lets every
Cohort analysis include only cells that pass, with an exclusion report.

## To check: every Batch recipe repeats its template exactly

Found 2026-11-03 for Resistance (fixed in `ce43901`): Batch saved a
different result shape than the window, ignored the template's run mode
and fit settings, was one sweep off, and the window's settings were
never saved. Audit the other recipes (Cursor, I-V, AP, Paired, Events,
Bursts, Field Potential, Spectral) the same way: same saved shape as the
window, same parameters per series, same sweeps, and the batched file
opens in its window.

## Useful, not scheduled

### Notes on the trace

Click on a trace, type a note, save. Notes live in the sidecar, show
as flags on the trace, and appear as a column in Cohort exports —
*"pulled out of cell at sweep 87"* written where you'll find it
again. Free-form, separate from event / burst markers. Could also
cover flagging interesting sweeps for later review. Low cost.

### Command-line runs

Run TRACER's analyses without the GUI on many recordings, e.g.
overnight or on a cluster:

```bash
tracer run --folder recordings/ --template cell_a2.dat --out results/
```

Same Python backend, invoked as `python -m tracer`, reusing Batch's
"apply a template recording's analyses to a folder" logic. Low cost:
the analysis layer already runs without Electron; the work is the
entry point, packaging and documentation.

### Seizure-like event classification ("perhaps later")

For in-vitro seizure models: separate interictal-like discharges from
seizure-like events, with frequency, duration, latency to the first
seizure-like event, and tonic / clonic phases. Builds on the Burst
window's detection.

### Smaller ideas

- **Comparing analysis states** — the same recording's results under
  two parameter sets or two dates: what changed?
- **NWB export** — write recordings back as NWB (read already works
  via Neo).
- **Custom export columns** — user-defined CSV columns computed from
  existing per-event fields.

---

## Parked

- **Python console** (and the plugin system that would build on it).
  A live Python prompt with the open recording loaded. Doubtful how
  many lab members would use it, it's the largest item here, and it
  creates a programming interface that must stay stable. Revisit only
  if someone asks for it.

## Dropped

- **Macro recorder** — Batch and Cohort already cover it.
- **Overlay viewer** (traces from two recordings on one axis) and
  **time-synced crosshair across windows** — not needed.
- **Custom keyboard shortcuts** — the fixed set (manual chapter 8) is
  enough.
- **Drug timeline / wash-in plots** — the lab uses a separate series
  per drug period, and Cohort tags already cover that.
- **High-frequency oscillation detection** — not part of the lab's
  work.
- **Live spike sorting, AI parameter tuning, cloud sync of results** —
  out of scope.
