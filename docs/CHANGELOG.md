# What's new in TRACER

<!--
Shown in the app's "What's new" dialog the first time a new version
starts, and from Help ▸ What's New. Newest version first.

- One `## <version>` heading per release (must match package.json).
- Optional `### New`, `### Improved`, `### Fixed` groups.
- Short bullets written for users, not developers.
- Link to the manual with `[Read more](manual:<Chapter heading> > <Section heading>)`,
  using the headings exactly as they appear in docs/MANUAL.md.
-->

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
- **This window.** New versions now tell you what changed. [Read more](manual:1. Getting Started > What's new after an update)

### Fixed

- **Cohort** now includes burst train metrics; they were silently missing when train grouping was on. [Read more](manual:21. Train Grouping (events, APs, bursts) > Cohort integration)
- An analysis window that hits an error now shows a message instead of going blank.
