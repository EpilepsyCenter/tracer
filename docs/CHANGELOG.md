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

## 1.5.0

Event detection, Resistance (Cm), burst detection and action potential slopes give different, correct values when you run them again. Re-run analyses you report from.

### New

- **Debiased wPLI²** in spectral coupling (Vinck et al., 2011). Plain wPLI sits above 0 without any coupling (about 0.1 with 120 segments); the debiased version averages 0, so recordings of different lengths can be compared. In the Coupling tab, the Band CSV and Cohort. [Read more](manual:22. Spectral Analysis > Coupling with a second channel)

### Improved

- **Action potential +slope and −slope are the sample-to-sample dV/dt** by default, as in Stimfit and Clampfit. The old 0.5 ms window averaged over an upstroke that lasts about 0.2 ms and reported about a third of the maximum, so +slope values are now about three times higher. The window can still be widened. [Read more](manual:12. Action Potentials > The Kinetics tab)

### Fixed

- **Event detection counted some events more than once.** Candidates could land on the same peak and all be kept (up to 92 duplicates in 2 minutes), and deconvolution could count a large event a second time on its decay. Each event is now counted once, and it must deflect in the search direction. [Read more](manual:13. Event Detection > Choosing a detection method)

- **Deconvolution with a template fitted on the raw trace** divided by the holding current as well, which gave many false detections at low signal-to-noise (19–69 per minute at SNR 3–4, now 0–3).

- **Event rise and decay time constants could be swapped** in the per-event fits (10–28 % of events), and in the Template Generator. [Read more](manual:13. Event Detection > Per-event kinetics)

- **Resistance: Cm read low** by Rm / (Rs + Rm). It was τ / Rs and now uses the full formula. [Read more](manual:10. Resistance — Rs / Rin / Cm > How the numbers are computed)

- **Burst detection ignored Peak direction** when detecting: a discharge's rebound of the other sign was detected as a burst of its own, which also lowered the propagation fraction between two sites. Negative and Positive now detect only that side; Auto keeps both. [Read more](manual:14. Burst Detection (Field Bursts) > Method 1 — Threshold)

## 1.4.0

Several analyses now give different, correct values when you run them again: rheobase and the F–I curve with Manual Im, action potential slopes, rise times and half-widths, and the voltage-clamp reversal potential. Re-run analyses you report from, and re-run any Field Potential Batch made with 1.3.x.

### New

- **Im from a recorded stimulus trace.** When the stimulus is a channel in the file (an NWB stimulus series, an ABF command channel, a HEKA current or voltage monitor), pick *Recorded trace* as the Im source in the Action Potentials and I-V windows and choose the channel. TRACER finds each sweep's step on it for the F–I curve, rheobase, latency and I-V levels. Batch uses the template's choice. [Read more](manual:11. I-V Curve > Stimulus level: auto, recorded trace and manual)

- **Reversal potential in voltage clamp.** The I-V window shows *Erev*, where the absolute currents cross zero. [Read more](manual:11. I-V Curve > The I-V line)

### Improved

- **Checked against known answers.** Action potentials, I-V curves and the way results are saved are now tested on simulated recordings whose answers are known, every time TRACER changes.

- **Manual corrections** for Resistance (Cm units, the approximation it uses, how long the fit should be) and for how the fEPSP baseline and slope are measured. [Read more](manual:15. Field Potential (fEPSP / LTP) > The fEPSP slope algorithm)

### Fixed

- **Batch kept the Field Potential results of the last file only.** Every other file was saved and then emptied a second later. All files keep their results now. [Read more](manual:19. Batch > How each recipe is repeated)

- **Batch repeats normalisation and the time axis** of a Field Potential template.

- **F–I curve and rheobase with Manual Im** averaged the current over the analysis bounds, so with bounds over the whole sweep every point sat at a fraction of its step (half, for a 0.5 s step in a 1 s sweep). They now use the step's current. Rheobase from HEKA protocols had the same problem when the bounds covered more than the step. [Read more](manual:12. Action Potentials > The Counting tab)

- **+slope is reported for every spike** (it was empty at 20 kHz with later threshold methods such as Sekerli), and **−slope no longer picks up the next spike's upstroke** in fast trains. [Read more](manual:12. Action Potentials > The Kinetics tab)

- **Rise time and half-width**: the 200 kHz interpolation stretched rise times by up to about 20 % and shortened half-widths slightly.

- **First-spike latency** for ABF and NWB recordings: measured from the Manual Im start or the recorded step (it was empty).

- **Reversal potential in Cohort** was always the holding potential in voltage clamp; it now comes from the absolute currents, and current-clamp I-V curves no longer report one. With Manual Im in voltage clamp the levels are in mV, so the input resistance is shown.

- **Saving with several windows open**: each window saves only what it changed, so a window that hasn't caught up with another can't overwrite its results. [Read more](manual:7. Where Your Work is Stored > The recording sidecar)

- **Sidecars record the TRACER version** that wrote them (they all said 0.5.0).

## 1.3.1

### Improved

- **LTP time course in minutes for ABF and NWB recordings.** The time axis used to need a HEKA PatchMaster protocol; TRACER now also takes the sweep interval from the sweeps' recorded start times. [Read more](manual:15. Field Potential (fEPSP / LTP) > LTP-mode specifics)

### Fixed

- **NWB field recordings with 10 or more sweeps open in the right order.** Sweeps came back in name order (1, 10, 11 … 2), so analyses across sweeps saw them out of order. Files already exported are fine; only reading them was affected.

- **Reopening a saved LTP analysis** shows the time course straight away; it stayed blank until the analysis was run again or the axis switched between Time and Index. Plots in other analysis windows had the same problem and are fixed too.

- **Selecting a post-tetanus bin** shows its sweep from the post-tetanus series. The preview stayed on the baseline series and showed a baseline sweep with the same number, or nothing.

- **A saved Field Potential analysis restores its cursors**, so the bands on the trace match the windows the results were measured with.

- **No more stray dot** in the top-left corner of plots.

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
