"""Cohort Analysis API.

Phase B.1 deliverable — folder aggregation only. Stats running,
graph rendering, and export endpoints come in later phases.

# Endpoints

- ``GET  /api/cohort/analyses`` — list of analysis types the
  extractor registry knows about. Drives the wizard's analysis-type
  dropdown so the UI doesn't need to hardcode the list.

- ``POST /api/cohort/aggregate`` — walk a folder of ``.tracer``
  sidecars and return per-cell metric rows for the chosen analysis.
  Optional ``file_filter`` and ``series_filter`` honor the user's
  per-file checkbox selection and per-recording series trimming
  from the wizard.

# Why GET + POST split

Listing analyses is a constant-time lookup (no body needed → GET).
Aggregation has a meaningful body (filters, future stats config) and
returns a payload that can be MB-scale once distributions are
included → POST is the right verb.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from analysis import cohort
from analysis import cohort_stats
from analysis import cohort_graphs
from analysis import cohort_export

router = APIRouter()


class AggregateRequest(BaseModel):
    folder: str = Field(..., description="Absolute path to the folder containing .tracer sidecars.")
    analysis_type: str = Field(
        ..., description="One of the keys returned by /api/cohort/analyses."
    )
    file_filter: Optional[list[str]] = Field(
        default=None,
        description=(
            "Optional allow-list of recording file paths. When given, "
            "only sidecars next to these recordings contribute. Lets "
            "the cohort UI honor per-file checkbox selection."
        ),
    )
    qc_include: Optional[str] = Field(
        default=None,
        description=(
            "Quality control: 'all' | 'pass' | 'pass_warn'. Default: "
            "'pass_warn' when the folder has a tracer_qc.json, else 'all'."
        ),
    )
    series_filter: Optional[dict[str, list[str]]] = Field(
        default=None,
        description=(
            "Per-recording allow-list of '{group}:{series}' keys. "
            "When set for a recording, only those series contribute. "
            "Lets the user trim multi-series files."
        ),
    )


@router.get("/analyses")
def list_analyses() -> dict:
    """Return the analysis types the extractor registry handles.

    Also returns the curated default-checked metric lists so the
    metric tree (Phase B.5) doesn't have to call a separate endpoint.
    """
    return {
        "analyses": cohort.list_supported_analyses(),
        "default_metrics": cohort.DEFAULT_METRICS,
    }


@router.post("/aggregate")
def aggregate(req: AggregateRequest) -> dict:
    """Walk the folder and return per-cell metrics.

    Errors raised by individual extractors are caught inside
    :func:`cohort.aggregate_folder` and reported in ``errors`` so a
    single bad sidecar never aborts the whole scan. The HTTP layer
    only raises 400 for caller-fault problems (bad analysis type,
    folder not a string).
    """
    try:
        return cohort.aggregate_folder(
            folder=req.folder,
            analysis_type=req.analysis_type,
            file_filter=req.file_filter,
            series_filter=req.series_filter,
            qc_include=req.qc_include,
        )
    except ValueError as exc:
        # Unknown analysis_type — caller error.
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ---------------------------------------------------------------------
# /run_stats — Pingouin runner driven by the wizard's design
# ---------------------------------------------------------------------

class StatsGroup(BaseModel):
    tag: str
    values: list[Optional[float]]


class RunStatsRequest(BaseModel):
    groups: list[StatsGroup] = Field(
        ..., description=(
            "One entry per group: {tag, values}. For paired designs "
            "the values lists must align row-by-row across groups."
        ),
    )
    design_kind: str = Field(
        ..., description=(
            "One of: 'unpaired_2', 'oneway_n', 'paired_2', 'rm_n'. "
            "The cohort wizard derives this from the comparison "
            "shape + group count."
        ),
    )
    test_override: str = Field(
        default='auto',
        description=(
            "'auto' lets Shapiro-Wilk decide parametric vs non-parametric. "
            "'parametric' / 'nonparametric' force one branch and skip "
            "the normality check."
        ),
    )
    metric: Optional[str] = Field(
        default=None,
        description=(
            "Optional metric name being tested — echoed back in the "
            "result so the cohort UI / export layer can attribute "
            "the row without a side channel."
        ),
    )


@router.post("/run_stats")
def run_stats(req: RunStatsRequest) -> dict:
    """Run a single statistical test for the wizard's current design.

    Pingouin lives behind this endpoint — heavy import, slow first
    call after the backend boots. Subsequent calls are cheap.

    All exceptions (including pingouin's internal ``assert`` failures
    on degenerate inputs) are caught here and returned as a 400 with
    a structured ``detail`` so the cohort UI can surface a useful
    message rather than swallowing a generic "Failed to fetch".
    """
    try:
        payload = cohort_stats.run_test(
            groups=[g.model_dump() for g in req.groups],
            design_kind=req.design_kind,
            test_override=req.test_override,
        )
    except (AssertionError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    if req.metric is not None:
        payload['metric'] = req.metric
    return payload


# ---------------------------------------------------------------------
# /run_distribution_stats — K-S family for distribution metrics
# ---------------------------------------------------------------------

class DistStatsGroup(BaseModel):
    tag: str
    # Per-cell event arrays. The full distribution for one cell is one
    # inner list. Empty cells (zero events for the metric) get dropped
    # server-side.
    values_per_cell: list[list[Optional[float]]]


class RunDistributionStatsRequest(BaseModel):
    groups: list[DistStatsGroup] = Field(
        ..., description=(
            "One entry per group: {tag, values_per_cell}. The inner "
            "lists are the per-cell event arrays for the metric being "
            "tested (e.g. every IEI for one cell)."
        ),
    )
    design_kind: str = Field(
        ..., description=(
            "Only 'unpaired_2' and 'oneway_n' are supported. K-S on "
            "paired distributions isn't a coherent test."
        ),
    )
    mode: str = Field(
        default='pooled_ks',
        description=(
            "'pooled_ks'     — pool all events per group, run K-S "
            "(2 groups) or pairwise + Holm (3+).\n"
            "'per_cell_ks_d' — D vs reference group's pooled events, "
            "then run scalar Mann-Whitney / Kruskal-Wallis on the "
            "per-cell D's. Avoids pseudoreplication."
        ),
    )
    anderson_darling: bool = Field(
        default=False,
        description=(
            "If true and design_kind='oneway_n' and mode='pooled_ks', "
            "run k-sample Anderson-Darling instead of the pairwise "
            "pooled K-S. Returns a single p across all groups."
        ),
    )
    reference_group_idx: int = Field(
        default=0,
        description=(
            "Only used when mode='per_cell_ks_d'. Index into ``groups`` "
            "whose pooled events are the reference distribution for "
            "every cell's D computation. Default 0 = first group."
        ),
    )
    metric: Optional[str] = Field(
        default=None,
        description="Optional metric name — echoed back in the response.",
    )


@router.post("/run_distribution_stats")
def run_distribution_stats(req: RunDistributionStatsRequest) -> dict:
    """K-S-family test for a distribution metric (event IEI, amplitude,
    AUC, …). See ``cohort_stats.run_distribution_test`` for the modes."""
    try:
        payload = cohort_stats.run_distribution_test(
            groups=[g.model_dump() for g in req.groups],
            design_kind=req.design_kind,
            mode=req.mode,
            anderson_darling=req.anderson_darling,
            reference_group_idx=req.reference_group_idx,
        )
    except (AssertionError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    if req.metric is not None:
        payload['metric'] = req.metric
    return payload


# ---------------------------------------------------------------------
# /render_graph — matplotlib plot rendering for the cohort UI
# ---------------------------------------------------------------------

class GraphGroup(BaseModel):
    tag: str
    # Per-cell value arrays. For scalar plots each cell is a singleton
    # (or a multi-row file averaged downstream). For distributions
    # each cell is the full pooled-events array. For time-series each
    # cell is the bin-by-bin trace.
    values_per_cell: list[list[Optional[float]]]
    # Optional per-cell bin-width estimate (timeseries only). The
    # graph backend collapses these across cells to decide whether
    # the time axis can be rendered in minutes vs bin index.
    bin_width_s: Optional[float] = None
    bins_consistent: Optional[bool] = None
    # Per-cell induction bin index (timeseries / LTP only). Frontend
    # pulls this from each cell's meta when assembling the graph
    # request; the backend draws a vertical "induction" marker at
    # the median across cells.
    induction_bin_idx: Optional[float] = None
    color: Optional[str] = None


class GraphOverrides(BaseModel):
    """User-driven axis / label / color / scale overrides from the
    fullscreen modal. All fields are optional; None means
    "keep the plot's own default". The modal builds this object from
    its sidebar form state and posts it back with the same payload
    used for the inline render — server replays the plot with the
    edits applied."""
    # Each list is ``[min, max]``; either element may be ``None`` so
    # the user can pin one bound and leave the other on autoscale.
    xlim: Optional[list[Optional[float]]] = Field(
        default=None, description="[min|null, max|null]")
    ylim: Optional[list[Optional[float]]] = Field(
        default=None, description="[min|null, max|null]")
    xlabel: Optional[str] = None
    ylabel: Optional[str] = None
    title: Optional[str] = None
    log_x: bool = False
    log_y: bool = False
    # Per-group display name ({canonical_tag: visible_name}). Empty
    # string clears (falls back to canonical).
    group_labels: Optional[dict[str, str]] = None
    # Per-group color ({canonical_tag: '#RRGGBB'}). Hex strings only.
    group_colors: Optional[dict[str, str]] = None
    # Distribution-only flags. Ignored by scalar / timeseries plots,
    # so it's safe to leave them at their defaults always — they
    # only kick in when ``kind == 'distribution'``.
    abs_values: bool = Field(
        default=False,
        description="Fold values to |x| before building ECDFs. "
                    "Useful for signed amplitudes (EPSCs at negative "
                    "pA) so a log-X plot makes sense.",
    )
    show_individuals: bool = Field(
        default=True,
        description="Show faded per-cell ECDFs.",
    )
    show_mean: bool = Field(
        default=True,
        description="Show bold per-group mean ECDF.",
    )
    gaussian_overlay: bool = Field(
        default=False,
        description="Overlay each group's fitted N(μ, σ) CDF as a "
                    "dashed line — visual normality reference.",
    )
    # Scalar-only flags. Ignored by distribution / timeseries plots.
    central_tendency: Optional[str] = Field(
        default=None,
        description="'mean' (default) or 'median' — line drawn "
                    "through each strip in scalar plots.",
    )
    error_bar: Optional[str] = Field(
        default=None,
        description="Whisker style. Scalar plots accept 'sem' "
                    "(default), 'sd', 'ci95', 'iqr', 'range', 'none'. "
                    "Timeseries plots accept 'sem' (default), 'sd', "
                    "'ci95', 'none' — IQR / range don't make sense "
                    "for per-bin error bars.",
    )
    # Timeseries-only flags. Ignored by scalar / distribution plots.
    connect_lines: bool = Field(
        default=False,
        description="Draw a thin line connecting bin means across "
                    "time. Off by default — markers + error bars is "
                    "the canonical LTP / fEPSP plot style.",
    )
    show_band: bool = Field(
        default=False,
        description="Draw a filled ±spread band under the markers. "
                    "Off by default — discrete error bars are clearer "
                    "at LTP-bin granularity.",
    )
    align_to_induction: bool = Field(
        default=True,
        description="Re-zero each group's time axis at its own "
                    "induction bin so baseline bins have negative "
                    "time and tetanus is at 0 (canonical LTP plot "
                    "layout). Falls through to absolute time when "
                    "induction metadata is absent.",
    )


class RenderGraphRequest(BaseModel):
    kind: str = Field(..., description="'scalar' | 'distribution' | 'timeseries'")
    groups: list[GraphGroup]
    title: str = ''
    ylabel: str = ''
    xlabel: str = ''
    theme: str = Field(default='dark', description="'light' | 'dark'")
    palette: Optional[list[str]] = None
    p_value: Optional[float] = None
    posthoc: Optional[list[dict]] = None
    test_label: Optional[str] = None
    reference_y: Optional[float] = Field(
        default=None,
        description="Optional horizontal reference line (e.g. 1.0 for LTP normalized).",
    )
    output_format: str = Field(
        default='svg',
        description="'svg' (inline-friendly), 'png' (base64), or 'pdf' (base64).",
    )
    overrides: Optional[GraphOverrides] = None
    # Modal renders use a larger figure than the inline card (the
    # modal canvas is much wider). When None each plot kind keeps
    # its 5.5×4 in default.
    width_in: Optional[float] = None
    height_in: Optional[float] = None
    # PNG / PDF resolution. SVG ignores this (vector). Default 150
    # for inline preview; 300 for export-quality.
    dpi: int = 150


@router.post("/render_graph")
def render_graph(req: RenderGraphRequest) -> dict:
    """Render a single cohort plot. Matplotlib is heavy on first
    call after backend boot; subsequent calls are fast."""
    # Pull bin-width metadata onto the timeseries plot path. The
    # graph dispatcher does the consistency check across these.
    bin_widths_s = [g.bin_width_s for g in req.groups]
    bins_consistent = [g.bins_consistent for g in req.groups]
    induction_bins = [g.induction_bin_idx for g in req.groups]
    overrides_dict = req.overrides.model_dump() if req.overrides is not None else None
    return cohort_graphs.render_graph(
        kind=req.kind,
        groups=[g.model_dump() for g in req.groups],
        title=req.title,
        ylabel=req.ylabel,
        xlabel=req.xlabel,
        theme=req.theme,
        palette=req.palette,
        p_value=req.p_value,
        posthoc=req.posthoc,
        test_label=req.test_label,
        bin_widths_s=bin_widths_s,
        bins_consistent=bins_consistent,
        reference_y=req.reference_y,
        induction_bins=induction_bins,
        output_format=req.output_format,
        overrides=overrides_dict,
        width_in=req.width_in,
        height_in=req.height_in,
        dpi=req.dpi,
    )


# ---------------------------------------------------------------------
# /export — cohort export to Excel + Prism. Phase B.8.
# ---------------------------------------------------------------------

class ExportRequest(BaseModel):
    """Cohort export payload. The frontend sends the in-memory
    aggregate result (from ``/aggregate``) and optionally the stats
    map (from per-metric ``/run_stats`` calls) — we don't re-compute
    server-side, since that would cause inconsistency between what
    the user sees on screen and what they download.

    ``format``:
      * ``excel_summary`` — multi-sheet workbook (cohort meta, stats,
        wide cells, long cells, one sheet per distribution metric).
      * ``excel_cells``   — single-sheet ``_cells.xlsx`` per-cell wide
        format. The shape stats packages expect.
      * ``prism``         — GraphPad Prism ``.pzfx`` project file.
        One Grouped table per scalar metric, one Column table per
        (distribution metric × group).
    """
    format: str = Field(..., description="'excel_summary' | 'excel_cells' | 'prism' | 'asterism'")
    aggregate: dict
    stats: Optional[dict] = None
    selected_metrics: Optional[list[str]] = None
    design: Optional[dict] = None
    # Wizard's grouped cells — the source of truth for which cells
    # appear in each analysis card. When present, the export uses
    # this directly without re-filtering server-side, so the file
    # exactly matches the on-screen cards.
    design_groups: Optional[list[dict]] = None
    # ``asterism`` format: the per-metric tables the window built from
    # the same values its statistics used (see cohort_asterism.py).
    asterism: Optional[dict] = None


@router.post("/export")
def export(req: ExportRequest) -> dict:
    """Render the cohort to one of three file formats and return
    base64-encoded bytes plus a sensible default filename.

    The renderer base64-decodes via ``writeBinaryFile`` IPC and
    writes to whatever path the user picked in the save dialog.
    Single round-trip, no temp files server-side.
    """
    import base64
    fmt = req.format
    if fmt == 'excel_summary':
        data = cohort_export.write_excel_summary(
            req.aggregate, req.stats, req.selected_metrics, req.design,
            design_groups=req.design_groups,
        )
        return {
            'format': 'xlsx',
            'filename': 'cohort_summary.xlsx',
            'base64': base64.b64encode(data).decode('ascii'),
        }
    if fmt == 'excel_cells':
        data = cohort_export.write_excel_cells(
            req.aggregate, req.design, design_groups=req.design_groups,
        )
        return {
            'format': 'xlsx',
            'filename': 'cohort_cells.xlsx',
            'base64': base64.b64encode(data).decode('ascii'),
        }
    if fmt == 'prism':
        data = cohort_export.write_prism_pzfx(
            req.aggregate, req.design, design_groups=req.design_groups,
        )
        return {
            'format': 'pzfx',
            'filename': 'cohort.pzfx',
            'base64': base64.b64encode(data).decode('ascii'),
        }
    if fmt == 'asterism':
        from analysis import cohort_asterism
        try:
            data = cohort_asterism.write_asterism(req.asterism or {})
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            'format': 'asterism',
            'filename': 'cohort.asterism',
            'base64': base64.b64encode(data).decode('ascii'),
        }
    raise HTTPException(status_code=400, detail=f"Unknown export format: {fmt!r}")
