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

## 1.3.0

### New

- **Native NWB reading.** Patch-clamp and field recordings in the Neurodata Without Borders format open with their full structure: one group per cell, one series per protocol run, the stimulus next to each response, and named electrodes for field and LFP recordings. [Read more](manual:1. Getting Started > Opening a recording)

- **Export as NWB.** *File ▸ Export as NWB…* writes the open recording as an NWB file, ready to deposit on DANDI or share with a paper: subject and recording details, the type of each series, traces after your Channel Scaling, and the stimuli. TRACER then checks the file with the NWB Inspector and shows what, if anything, needs fixing. [Read more](manual:1. Getting Started > Exporting as NWB)

- **Export a whole folder as NWB.** *File ▸ Export Folder as NWB…* writes one NWB file per recording into a separate folder, with each file's animal, sex and age in one table and a check of every file. [Read more](manual:1. Getting Started > Exporting a folder as NWB)

- **Stacked channels.** With three or more channels visible, each gets its own lane with its own scale: drag or Option-scroll a lane to adjust just that channel, while time, cursors and notes stay shared. The new button next to *Traces* switches it on or off. [Read more](manual:4. The Trace Viewer > Stacked channels)

- **TRACER is now free and open-source software**, released under the GNU General Public License (version 3 or later).

### Improved

- **Nine distinct channel colours** instead of five, matching between the viewer and the *Traces* menu. [Read more](manual:6. Settings and Appearance > Trace colours)

- **The VC / CC / FP badges are more accurate**: current-step protocols named "I-V" show CC, and field recordings made with a patch amplifier (fEPSP, LTP) show FP.

- **Recording times** are read from HEKA and ABF files and kept in NWB exports.

### Fixed

- **Formats read through Neo** (WinWCP, Axograph, Spike2 and others): currents and voltages are now converted to pA and mV (a recording in nA showed nA values labelled pA), channels stored together are no longer mixed into one trace, and a channel without a name no longer stops the file from opening. [Read more](manual:1. Getting Started > Opening a recording)

## 1.2.0

### New

- **Quality control in Cohort.** Check Rs, Rin, Cm, holding current and resting Vm between the conditions of your experiment (baseline, drug, washout…) with rules you set, override with a reason, and let every Cohort analysis include only the cells that pass — with a report of what was left out and why. [Read more](manual:20. Cohort > Quality control)

- **Cohort exports straight to ASTERISM.** One click writes an ASTERISM project with a data table, a graph and the matching test for every metric — for events and other many-values-per-cell measures, the per-cell means, a nested table (SuperPlot, nested test), the cumulative distributions and the pooled events. Ready to open, with nothing to import. [Read more](manual:20. Cohort > Export)

- **Notes on the trace.** Right-click the trace to write a note at that moment or on the whole sweep (*"pulled out of cell"*, *"drug reached bath"*). Notes show as flags on the trace, in the tree and in a Notes list, and they appear next to each cell in Cohort, its Excel exports and the Quality tab. [Read more](manual:4. The Trace Viewer > Notes on the trace)

### Improved

- **Readable metric names in Cohort.** The window, its graphs and the Excel, Prism and ASTERISM exports show *Amplitude, mean (pA)* instead of `amp_mean`, with units everywhere; Spectral metrics use your region and band names. [Read more](manual:20. Cohort > Export)

- **Resistance remembers how each series was measured** (run mode, sweeps, fit, channel, cursors), and Batch repeats exactly that on the other files. [Read more](manual:10. Resistance — Rs / Rin / Cm > Persistence)

- **Cohort reports amplitudes as positive values** (events, paired responses, bursts), whichever way the trace went — the usual convention. [Read more](manual:20. Cohort > What gets aggregated)

### Fixed

- **Typing F or ? in a text field no longer toggles Focus Mode or opens the shortcuts** (macOS). The single-key shortcuts now work only outside text fields, as intended.

- **Batch repeats the template exactly, for every analysis.** It used the wrong sweeps (one off, or all instead of the chosen range), ignored excluded sweeps, reused the template cell's RMS threshold and manual edits, could take the LTP post-tetanus series from the wrong group, dropped I-V's peak/steady choice and Field Potential's sweep range, and reported failed runs as done. Batch Resistance results also opened with an error. [Read more](manual:19. Batch > How each recipe is repeated)
- **Results lost or saved to the wrong place:** Paired results weren't saved; switching series in the Cursor window copied the previous series' measurements; an analysis window left open could save the previous file's results into the next file; turning dual-site off left old propagation numbers in Cohort.
- **AP and Paired** now leave out excluded sweeps, like the other analyses. **Cohort** I-V fits use baseline-subtracted responses (as the I-V window), and I-O intensities follow each point's sweep.
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
