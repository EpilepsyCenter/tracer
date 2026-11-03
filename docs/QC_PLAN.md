# Quality control — build plan (draft 4, agreed)

Status: agreed 2026-11-03, ready to build. Nothing built yet. Replaces drafts 1–2
(draft 1 re-measured everything; draft 2 built a time line and found
test pulses automatically — both rejected).

## Principle

QC **measures nothing and guesses nothing**. Users measure Rs, holding
and Vm with the existing modules on series they tagged; QC collects
those results per cell, compares them **between the conditions the
user lists** (e.g. baseline → drug 1 → drug 2 → washout), applies the
folder's rules, and lets Cohort include or exclude cells accordingly.

## The workflow it fits

```
1. Metadata     tag series: baseline, drug1, drug2, washout, …     exists
2. Resistance   measure Rs on the tagged series of one cell          exists
   Cursor       (current clamp) baseline = Vm on the tagged series   exists
3. Batch        use that cell as the template for the folder         exists
4. Cohort       Quality tab: pick conditions → rules → verdicts      NEW
5. Cohort       analyses with "Include: pass / pass + warn"          NEW
```

## Sources (all existing sidecar results)

| Quantity | From | Notes |
|---|---|---|
| Rs, Rin, Cm | Resistance results of the series | Mean of the series' rows (all sweeps, or the averaged run). |
| Holding current (VC) | The same Resistance rows' `baseline` | Already stored with every Rs value. |
| Resting Vm (CC) | The Cursor analysis the user ran on the series: its baseline value | Same logic as Rs: the user has already run it (per cell or with Batch). A Cursor analysis has one baseline window shared by all slots, so there is no slot to choose. Mean of the per-sweep baselines. |

Nothing is computed from raw data; nothing is read from files other
than the sidecars Cohort already reads.

## Conditions (set by the user in the Quality tab)

The tab starts with **two conditions** (the first is the reference);
**Add another** appends more, in order (e.g. baseline → drug 1 →
drug 2 → washout); any condition can be removed, renamed or made the
reference.

Each condition picks its tag from a **dropdown of the series tags that
carry Resistance or Cursor results in the folder**, with how many
cells have them (e.g. "drug1 — 12 cells"). These are the files where
the analyses were run on tagged series, by hand or with Batch.

| Condition | Measured in series tagged | Judges series tagged |
|---|---|---|
| baseline *(reference)* | `baseline` | `baseline` |
| drug 1 | `drug1` | `drug1` |
| washout | `tp_washout` | `washout` |

- **Several tags per condition** (added while building): "Measured in"
  takes a list, and each cell uses whichever of those series it has.
  This covers a folder where some cells have the test pulse inside the
  `drug` sweeps and others in a separate `tp_drug` series.
- By default both columns are the selected tag: the test pulse
  is inside the data sweeps, so Rs is measured on the data series
  itself.
- When a separate test-pulse series is used, the user tags it (e.g.
  `tp_washout`) and points the condition at it. QC never picks a
  test pulse by position or time.
- A separate tag for test-pulse series also keeps Batch correct: Batch
  applies recipes by tag, so a test-pulse series tagged `washout`
  would get the washout series' Events recipe.
- Several series with the same tag in one cell: their values are
  averaged, and the row notes "2 series".

## Metrics per cell

For each condition: Rs, Rin, Cm, holding, Vm.

Relative to the reference: **ΔRs %**, Δholding (pA) and ΔVm (mV) for
every other condition, plus the largest ΔRs % over all conditions.

## Rules

Defaults agreed 2026-11-02, all editable, each with an optional warn
and fail level:

- Rs ≤ 25 MΩ in every condition
- |ΔRs| ≤ 20 % against the reference
- holding ≥ −200 pA
- Vm ≤ −55 mV
- **Missing measurement** (a condition with no Resistance / Cursor
  result): *warn* by default, so a cell is never passed silently.

**Cell rule:**
- *exclude only the failing conditions* — e.g. the cell still counts
  for baseline vs drug 1 if only washout fails;
- or *exclude the whole cell* if any condition fails (strict paired
  designs).

The rules, the conditions and the manual overrides (with a required
reason and the date) are saved in **`tracer_qc.json` in the folder**.
Everyone analysing the folder applies the same rules, and **QC never
writes sidecars**. Verdicts are not stored; they are worked out each
time from the results and the current rules.

## Cohort ▸ Quality tab

- **Conditions** editor (above) and **rules** editor.
- **Table**, one row per cell:
  - Rs per condition, ΔRs %, holding, Vm;
  - the verdict per condition and the cell's verdict, with the reason;
  - sortable, with a "warn / fail only" filter;
  - **Override…**, **Copy as TSV**.
- **Plot:** Rs (or holding, Vm) per condition, one line per cell
  (before–after style), with the thresholds drawn; colour by verdict.
  It has the usual right-click export, including **Export for
  ASTERISM**.
- **What's missing:**
  - per condition: "5 cells have no Rs for *drug 1* — run Resistance
    on the series tagged `drug1` (Batch can do the folder)";
  - **recordings with no series matching any condition's tag**,
    listed by name. They are not judged by QC and stay included in
    Cohort.

## Effect on the rest of Cohort

- Every Cohort analysis gets **Include: all / pass / pass + warn**:
  - defaults to *all* when the folder has no rules file;
  - otherwise defaults to *pass + warn*.
- **Exclusion follows the condition.** When an analysis row comes from
  a series tagged `drug1` and the cell's *drug 1* condition fails, that
  row is excluded (or the whole cell, under the strict rule).
- **Exclusion report:**
  - *n* excluded per group and why, with overrides listed;
  - in the Cohort export and the ASTERISM export (`qc_status`,
    `qc_reason` columns).
- Cohort's existing Resistance analysis is unchanged.

## Build order

1. **QC engine** (`backend/analysis/qc.py`, pure functions) and
   `/api/qc/evaluate`:
   - collect results per cell and condition;
   - work out Δ against the reference;
   - apply the rules, the cell rule and overrides.

   Tests on synthetic sidecars: in-sweep and separate test-pulse
   tagging, missing results, several series per tag, both cell rules,
   overrides.
2. **Cohort ▸ Quality tab:** the condition and rule editors, the table,
   the plot, overrides, reading and writing `tracer_qc.json`.
3. **Include switch, row exclusion and the exclusion report** in every
   Cohort analysis and export.
4. **Manual:** a Quality section in the Cohort chapter, with a worked
   example of the full workflow. Then the What's new entry.

No changes to the readers, the Resistance module or the sidecar
format.
