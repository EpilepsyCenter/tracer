# What's new in TRACER

<!--
Shown in the app's "What's new" dialog the first time a new version
starts, and from Help ▸ What's New. Newest version first.

- One `## <version>` heading per release (must match package.json).
- Optional `### New`, `### Improved`, `### Fixed` groups.
- Short bullets written for users, not developers.
- Link to the manual with `[Read more](manual:<Chapter heading> > <Section heading>)`,
  using the headings exactly as they appear in docs/MANUAL.md.
- The same entry becomes the GitHub release text:
  `python3 scripts/release_notes.py <version> --apply`.
-->

## 1.2.0

### New

- **Quality control in Cohort.** Check Rs, Rin, Cm, holding current and resting Vm between the conditions of your experiment (baseline, drug, washout…) with rules you set, override with a reason, and let every Cohort analysis include only the cells that pass — with a report of what was left out and why. [Read more](manual:20. Cohort > Quality control)

- **Cohort exports straight to ASTERISM.** One click writes an ASTERISM project with a data table, a graph and the matching test for each metric — ready to open, with nothing to import. [Read more](manual:20. Cohort > Export)

### Improved

- **Resistance remembers how each series was measured** (run mode, sweeps, fit, channel, cursors), and Batch repeats exactly that on the other files. [Read more](manual:10. Resistance — Rs / Rin / Cm > Persistence)

### Fixed

- **Batch Resistance** results opened with an error in the Resistance window and were missing from Cohort; Batch also ignored the template's run mode and fit settings.
- **What's new** appeared at every start instead of once after an update.
- **Cohort statistics:** identical values were treated as normally distributed and got a t-test with an infinite t; paired comparisons with a missing value could pair the wrong cells; the export's normality column always said "all normal". Paired tests now use the cells with a value in every condition and check normality on the differences.
- Settings could be lost when two windows saved them at the same moment.

## 1.1.0

### New

- **Spectral Analysis.** Power spectra for named stretches of a recording (baseline, drug, washout), band power from delta to fast ripples, line-noise checks, and a spectrogram under the trace. [Read more](manual:22. Spectral Analysis > When to use this window)
- **Band power over time.** Watch each band change across a recording, as absolute power, share of total, or % of a baseline region. [Read more](manual:22. Spectral Analysis > Band power over time)
- **Dual-site propagation.** In Burst Detection, detect discharges on two channels (e.g. CA3 and CA1), pair them, and measure how each one travels: share that propagates, lag, which site leads, amplitude ratio. [Read more](manual:14. Burst Detection (Field Bursts) > Dual-site propagation (two channels))
- **Two-channel coupling.** Coherence, wPLI and cross-correlation between two channels in the Spectral window — including measures that tell real coupling from volume conduction. [Read more](manual:22. Spectral Analysis > Coupling with a second channel)
- **Export figures to ASTERISM and to Illustrator / Affinity.** Right-click any plot to copy it as a vector drawing (or save PDF / SVG); plots of computed results also export their numbers straight into ASTERISM. [Read more](manual:4. The Trace Viewer > Mouse interactions)
- **File ▸ Open Recent and File ▸ Close Recording** in the menu bar. [Read more](manual:1. Getting Started > Recent files)

### Improved

- **Faster scrolling** through long recordings in every window.
- **Several channels in the main viewer:** extra channels now scroll with the view, sit at the right time, and can be dragged up and down on their own axis.
- **Copy as TSV** on the new results tables (propagation pairs, band power, line noise, coupling).
- **A What's new window** on the first start of each new version, with links into the manual. [Read more](manual:1. Getting Started > What's new after an update)

### Fixed

- **Cohort** now includes burst train metrics; they were silently missing when train grouping was on. [Read more](manual:21. Train Grouping (events, APs, bursts) > Cohort integration)
- An analysis window that hits an error now shows a message instead of going blank.
