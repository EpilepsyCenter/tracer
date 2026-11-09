# TRACER — future features

Ideas being considered, with what was decided about each. Not a
commitment. Last reviewed 2026-11-04 (before the 1.2.0 release).

Shipped from earlier versions of this list: startup splash screen,
Spectral Analysis, dual-site propagation (Burst window), two-channel
coupling (Spectral window), per-cell quality control in Cohort, the
Batch fidelity audit, readable metric names, notes on the trace,
stacked channels and NWB reading / export.

---

## Useful, not scheduled

### Seizure-like event classification ("perhaps later")

For in-vitro seizure models: separate interictal-like discharges from
seizure-like events, with frequency, duration, latency to the first
seizure-like event, and tonic / clonic phases. Builds on the Burst
window's detection.

### Smaller ideas

- **NWB community listing** — pull request to nwb-overview adding
  TRACER to the community tools page (reads and writes icephys and
  ecephys NWB; files checked with the NWB Inspector).
- **Comparing analysis states** — the same recording's results under
  two parameter sets or two dates: what changed?
- **Custom export columns** — user-defined CSV columns computed from
  existing per-event fields.
- **Copy series tags between files** — tagging a folder for Batch means
  tagging every file by hand. When files have the same structure (same
  groups and series), copy the series tags from one file to the others
  in one step, e.g. from the Batch template. Raised 2026-11-09 while
  tagging the ground-truth recordings.

---

## Parked

- **Python console** (and the plugin system that would build on it).
  A live Python prompt with the open recording loaded. Doubtful how
  many lab members would use it, it's the largest item here, and it
  creates a programming interface that must stay stable. Revisit only
  if someone asks for it.

## Dropped

- **Command-line runs** (`tracer run --folder … --template …`) — no
  one in the lab would use it, the data isn't heavy enough to need a
  cluster, and Batch already runs unattended. It would also mean a
  second copy of Batch's logic in Python.
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
