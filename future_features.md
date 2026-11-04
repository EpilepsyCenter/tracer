# TRACER — future features

Ideas being considered, with what was decided about each. Not a
commitment. Last reviewed 2026-11-04 (before the 1.2.0 release).

Shipped from earlier versions of this list: startup splash screen,
Spectral Analysis, dual-site propagation (Burst window), two-channel
coupling (Spectral window), per-cell quality control in Cohort, the
Batch fidelity audit, readable metric names and notes on the trace.

---

## Useful, not scheduled

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
