"""Cohort → an ASTERISM project (``.asterism``) that opens directly.

One data table per scalar metric (the exact values Cohort's statistics
used), a graph of it in ASTERISM's own presets, and the matching
analysis, which ASTERISM recomputes when it opens the file. An info
sheet records where the numbers came from (folder, design, quality
control).

The file follows ASTERISM's project format, version 2 (``asterism/doc/
fileformat.py`` in the ASTERISM repo): a zip holding ``mimetype`` and
``project.json``. Only the fields we need are written; ASTERISM fills
in defaults for the rest, and it migrates older format versions, so a
version-2 file stays readable as ASTERISM moves on. The two apps share
no code (ASTERISM's rule): this module only writes the file.
tests/cohort_asterism_check.py loads the result with ASTERISM's own
reader when the ASTERISM repo sits next to TRACER.
"""

from __future__ import annotations

import io
import json
import math
import os
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any, Optional

FORMAT_ID = 'asterism-project'
FORMAT_VERSION = 2
MIMETYPE = b'application/x-asterism-project'

# ASTERISM column-graph presets (asterism/app/dialogs/graph_type.py).
_SCATTER_SEM = {'appearance': 'scatter', 'line_at': 'mean_sem', 'show_points': True,
                'bars': False, 'errors': True, 'spread': 'swarm'}
_BEFORE_AFTER = {'appearance': 'scatter', 'line_at': 'none', 'show_points': True,
                 'bars': False, 'errors': False, 'spread': 'aligned'}

# Nested SuperPlot (asterism/app/dialogs/graph_type.py NESTED_PRESETS),
# box without points (thousands of pooled events), XY lines / points.
_DOT = dict(_SCATTER_SEM)
_BOX = {'appearance': 'box', 'whiskers': 'minmax', 'show_points': False, 'errors': True, 'bars': False}
_XY_LINE = {'appearance': 'scatter', 'xy_show': 'mean', 'connect': True, 'show_points': False,
            'errors': False, 'fill': False}
_XY_POINTS_LINE = {'appearance': 'scatter', 'xy_show': 'mean', 'connect': True, 'show_points': True,
                   'line_at': 'mean_sem', 'errors': True, 'fill': False}

PAIRED_KINDS = {'paired_2', 'rm_n'}
SWARM_MAX_POINTS = 400   # per group, for nested SuperPlots


def _id() -> str:
    return uuid.uuid4().hex


def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _analysis(design_kind: str, branch: str, ncols: int) -> Optional[tuple[str, dict]]:
    """ASTERISM analysis type + params for Cohort's test."""
    nonpar = branch == 'nonparametric'
    if design_kind == 'unpaired_2' and ncols == 2:
        # Cohort's parametric two-group test is Welch's.
        return 'ttest', ({'design': 'unpaired', 'distribution': 'nonparametric', 'test': 'mw'} if nonpar
                         else {'design': 'unpaired', 'distribution': 'normal', 'test': 'welch'})
    if design_kind == 'paired_2' and ncols == 2:
        return 'ttest', ({'design': 'paired', 'distribution': 'nonparametric', 'test': 'wilcoxon'} if nonpar
                         else {'design': 'paired', 'distribution': 'normal', 'test': 'student'})
    if design_kind == 'oneway_n' and ncols >= 2:
        return 'anova1', {'design': 'ordinary', 'distribution': 'nonparametric' if nonpar else 'normal',
                          'compare': 'all'}
    if design_kind == 'rm_n' and ncols >= 2:
        # Cohort reports the uncorrected repeated-measures ANOVA, so the
        # Geisser-Greenhouse correction (ASTERISM's default) is off here:
        # the file reproduces Cohort's test. Users can switch it on.
        return 'anova1', {'design': 'rm', 'distribution': 'nonparametric' if nonpar else 'normal',
                          'compare': 'all', 'gg': False}
    return None


def build_project(payload: dict) -> dict:
    """``project.json`` contents from the Cohort window's payload.

    ``payload``: ``design_kind``, ``tables`` (``metric``, ``label``,
    ``tags``, ``values`` — one list per tag, rows aligned by cell for
    paired designs — and ``row_titles``), ``branches`` (metric →
    'parametric' | 'nonparametric'), ``stats`` (metric → Cohort's
    result, for the info sheet), ``design``, ``folder``,
    ``analysis_type``, ``qc``, ``skipped_metrics``, ``app_version``.
    """
    design_kind = payload.get('design_kind') or 'unpaired_2'
    paired = design_kind in PAIRED_KINDS
    branches = payload.get('branches') or {}
    stats = dict(payload.get('stats') or {})
    override = payload.get('test_override') or 'auto'
    tables, graphs, analyses = [], [], []

    from analysis import cohort_stats
    from analysis.cohort_export import _compute_ecdf_grid, _ecdf_at_grid

    def add_distribution(metric: str, tags: list[str], groups: list[list[dict]], label: str = '') -> None:
        """Many values per cell: per-cell mean, nested table, cumulative
        distribution, pooled events."""
        # 1. One value per cell (its mean), tested like a scalar. Paired
        #    designs keep every row (cells aligned across conditions).
        means = [[(sum(c['values']) / len(c['values'])) if c['values'] else None for c in g] for g in groups]
        if not paired:
            means = [[m for m in col if m is not None] for col in means]
        labels = [c['label'] for c in groups[0]] if groups else []
        lab = label or metric
        add_column_table(f'{lab} — per-cell mean', f'{metric}__cell_mean', tags, means, labels,
                         f'{lab}, mean per cell')

        # 2. Nested: each cell a sub-column of its own values; SuperPlot.
        #    Paired designs keep the same cell in the same sub-column in
        #    every condition (and its colour).
        kept = groups if paired else [[c for c in g if c['values']] for g in groups]
        width = max(1, max(len(g) for g in kept))
        y: list[list] = []
        subs: list[list[str]] = []
        for g in kept:
            for j in range(width):
                y.append(list(g[j]['values']) if j < len(g) else [])
            subs.append([g[j]['label'] if j < len(g) else '' for j in range(width)])
        tid = _id()
        name = f'{lab} — by cell'
        tables.append({
            'id': tid, 'name': name, 'type': 'nested', 'y_format': 'replicates', 'replicates': width,
            'x_format': 'none', 'has_row_titles': False, 'titles': tags, 'sub_titles': subs,
            'y': y, 'x': [], 'x_err': [], 'row_titles': [], 'excluded': [],
        })
        # A beeswarm of thousands of points takes ASTERISM seconds per
        # redraw; above a few hundred points per group the points are
        # drawn aligned instead (same data, instant).
        n_points = max((sum(len(c['values']) for c in g) for g in kept), default=0)
        dot = dict(_DOT, spread='swarm' if n_points <= SWARM_MAX_POINTS else 'aligned')
        graphs.append({'id': _id(), 'name': name, 'auto_name': False, 'table': tid,
                       'spec': {'title': name, 'default_style': dot, 'nested_layout': 'superplot',
                                'nested': {'restart': paired}, 'y': {'title': lab}}})
        # Nested t test / one-way ANOVA (cells as the random factor):
        # independent groups only, each with 2+ cells.
        if not paired and len(kept) >= 2 and all(len(g) >= 2 for g in kept):
            analyses.append({'id': _id(), 'name': '', 'auto_name': True, 'type': 'nested',
                             'table': tid, 'columns': list(range(len(tags))), 'params': {}})

        # 3. Cumulative distribution: one curve per cell on a shared grid
        #    (as Cohort's ECDF graph and the Prism export); the graph shows
        #    each group's mean curve — switch to "Each replicate" for cells.
        pooled = [v for g in groups for c in g for v in c['values']]
        grid = _compute_ecdf_grid(pooled)
        cells_with = [[c for c in g if c['values']] for g in groups]
        width = max(1, max(len(g) for g in cells_with))
        y = []
        subs = []
        for g in cells_with:
            for j in range(width):
                y.append([float(v) for v in _ecdf_at_grid(g[j]['values'], grid)] if j < len(g) else [])
            subs.append([g[j]['label'] if j < len(g) else '' for j in range(width)])
        tid = _id()
        name = f'{lab} — cumulative distribution'
        tables.append({
            'id': tid, 'name': name, 'type': 'xy', 'y_format': 'replicates', 'replicates': width,
            'x_format': 'numbers', 'has_row_titles': False, 'titles': tags, 'sub_titles': subs,
            'y': y, 'x': [float(v) for v in grid], 'x_err': [], 'row_titles': [], 'excluded': [],
        })
        graphs.append({'id': _id(), 'name': name, 'auto_name': False, 'table': tid,
                       'spec': {'title': name, 'default_style': dict(_XY_LINE), 'palette': True,
                                'x': {'title': lab}, 'y': {'title': 'Cumulative fraction'}}})

        # 4. Pooled events per group (Cohort's pooled K-S test for two
        #    independent groups).
        cols = [[v for c in g for v in c['values']] for g in groups]
        tid = _id()
        name = f'{lab} — pooled events'
        tables.append({
            'id': tid, 'name': name, 'type': 'column', 'y_format': 'single', 'replicates': 1,
            'x_format': 'none', 'has_row_titles': False, 'titles': tags, 'sub_titles': [[''] for _ in tags],
            'y': cols, 'x': [], 'x_err': [], 'row_titles': [], 'excluded': [],
        })
        graphs.append({'id': _id(), 'name': name, 'auto_name': False, 'table': tid,
                       'spec': {'title': name, 'default_style': dict(_BOX), 'y': {'title': lab}}})
        if design_kind == 'unpaired_2' and len(tags) == 2:
            analyses.append({'id': _id(), 'name': '', 'auto_name': True, 'type': 'ttest', 'table': tid,
                             'columns': [0, 1],
                             'params': {'design': 'unpaired', 'distribution': 'nonparametric', 'test': 'ks'}})

    def add_timeseries(metric: str, tags: list[str], groups: list[list[dict]],
                       bin_width_s: Optional[float], label: str = '') -> None:
        """A value per time bin per cell: XY, one replicate per cell; the
        graph shows mean ± SEM per bin; two-way ANOVA (time × group).
        Paired designs keep each cell in the same sub-column under every
        condition (the same cell measured in every column)."""
        cells_with = groups if paired else [[c for c in g if c['values']] for g in groups]
        n_bins = max(len(c['values']) for g in cells_with for c in g)
        width = max(1, max(len(g) for g in cells_with))
        y, subs = [], []
        for g in cells_with:
            for j in range(width):
                vals = list(g[j]['values']) if j < len(g) else []
                y.append((vals + [None] * n_bins)[:n_bins] if vals else [])
            subs.append([g[j]['label'] if j < len(g) else '' for j in range(width)])
        x = ([i * bin_width_s / 60.0 for i in range(n_bins)] if bin_width_s
             else [float(i) for i in range(n_bins)])
        tid = _id()
        lab = label or metric
        name = f'{lab} — time course'
        tables.append({
            'id': tid, 'name': name, 'type': 'xy', 'y_format': 'replicates', 'replicates': width,
            'x_format': 'numbers', 'has_row_titles': False, 'titles': tags, 'sub_titles': subs,
            'y': y, 'x': x, 'x_err': [], 'row_titles': [], 'excluded': [],
        })
        graphs.append({'id': _id(), 'name': name, 'auto_name': False, 'table': tid,
                       'spec': {'title': name, 'default_style': dict(_XY_POINTS_LINE), 'palette': True,
                                'x': {'title': 'Time (min)' if bin_width_s else 'Bin'},
                                'y': {'title': lab}}})
        # Two-way ANOVA, time × group. Each cell is a subject measured at
        # every time point (rows); between groups the cells differ by
        # column, within recordings the same cell is in every column. A
        # mixed-effects model takes over when a cell misses some bins.
        n_cols = len([g for g in cells_with if any(c['values'] for c in g)])
        if n_cols >= 2 and n_bins >= 2:
            analyses.append({'id': _id(), 'name': '', 'auto_name': True, 'type': 'anova2', 'table': tid,
                             'columns': list(range(len(tags))),
                             'params': {'design': 'rm_both' if paired else 'rm_rows', 'rm_method': 'auto',
                                        'compare': 'none',
                                        'row_factor': 'Time', 'col_factor': 'Condition' if paired else 'Group'}})

    def choose_branch(metric: str, tags: list[str], cols: list[list]) -> Optional[str]:
        """The test Cohort ran — or, when its statistics weren't run, the
        one it would choose (normality, no-variation data → rank test), so
        the file never carries a t-test Cohort would refuse."""
        branch = (stats.get(metric) or {}).get('branch') or branches.get(metric)
        if branch:
            return branch
        r = cohort_stats.run_test([{'tag': g, 'values': v} for g, v in zip(tags, cols)],
                                  design_kind, override if override in cohort_stats.TEST_OVERRIDES else 'auto')
        stats.setdefault(metric, r)
        if r.get('error'):
            return None    # Cohort can't test it (e.g. identical counts): no test in the file either
        return r.get('branch') or ('nonparametric' if override == 'nonparametric' else 'parametric')

    def add_column_table(name: str, metric: str, tags: list[str], cols: list[list],
                         row_titles: list[str], y_title: str) -> None:
        """One value per cell: table, scatter / before-after graph, test."""
        tid = _id()
        rows = [str(x) for x in row_titles] if paired else []
        tables.append({
            'id': tid, 'name': name, 'type': 'column', 'y_format': 'single', 'replicates': 1,
            'x_format': 'none', 'has_row_titles': bool(rows),
            'titles': tags, 'sub_titles': [[''] for _ in tags],
            'y': cols, 'x': [], 'x_err': [], 'row_titles': rows, 'excluded': [],
        })
        style = _BEFORE_AFTER if paired else _SCATTER_SEM
        graphs.append({
            'id': _id(), 'name': name, 'auto_name': False, 'table': tid,
            'spec': {'title': name, 'default_style': dict(style), 'connect_rows': paired,
                     'y': {'title': y_title}},
        })
        branch = choose_branch(metric, tags, cols)
        an = _analysis(design_kind, branch, len(tags)) if branch else None
        if an:
            analyses.append({'id': _id(), 'name': '', 'auto_name': True, 'type': an[0],
                             'table': tid, 'columns': list(range(len(tags))), 'params': an[1]})

    for t in payload.get('tables') or []:
        tags = [str(x) for x in t.get('tags') or []]
        cols = [[_num(v) for v in col] for col in t.get('values') or []]
        if not tags or len(cols) != len(tags) or not any(v is not None for c in cols for v in c):
            continue
        name = str(t.get('label') or t.get('metric') or 'Metric')
        add_column_table(name, str(t.get('metric') or name), tags, cols, t.get('row_titles') or [], name)

    for dist in payload.get('distributions') or []:
        metric = str(dist.get('metric') or 'Metric')
        tags = [str(x) for x in dist.get('tags') or []]
        groups = [[{'label': str(c.get('label') or ''), 'values': [x for x in (_num(v) for v in c.get('values') or [])
                                                                   if x is not None]}
                   for c in g] for g in dist.get('cells') or []]
        if not tags or len(groups) != len(tags) or not any(c['values'] for g in groups for c in g):
            continue
        label = str(dist.get('label') or metric)
        if dist.get('kind') == 'timeseries':
            add_timeseries(metric, tags, groups, _num(dist.get('bin_width_s')), label)
        else:
            add_distribution(metric, tags, groups, label)

    # Info sheet: provenance, so the numbers can be traced back.
    design = payload.get('design') or {}
    folder = str(payload.get('folder') or '')
    lines = [
        f"Exported from TRACER {payload.get('app_version') or ''} Cohort on "
        f"{datetime.now().strftime('%Y-%m-%d %H:%M')}.",
        f"Folder: {folder}",
        f"Analysis: {payload.get('analysis_type') or ''}",
        f"Design: {design.get('comparison_shape', '')} — {', '.join(design.get('selected_tags') or [])}"
        + (f"; filter {', '.join(design.get('filter_tags') or [])}" if design.get('filter_tags') else '')
        + (f"; series {design.get('series_role')}" if design.get('series_role') else ''),
        f"N: one value per {design.get('n_unit', 'cell')}.",
    ]
    qc = payload.get('qc') or {}
    if qc.get('active'):
        excl = qc.get('excluded') or []
        inc = {'all': 'all cells', 'pass': 'only cells passing QC',
               'pass_warn': 'cells passing QC or with a warning'}.get(qc.get('include'), qc.get('include'))
        lines.append(f"Quality control: {inc} included; {len(excl)} row(s) left out.")
        for x in excl:
            lines.append(f"  - {x.get('file_name', '')} {x.get('series_key', '')}: "
                         f"{x.get('status', '')} — {x.get('reason', '')}")
    if stats:
        lines.append('')
        lines.append("Cohort's results (ASTERISM recomputes its own from the tables):")
        for m, r in stats.items():
            if not r:
                continue
            if r.get('test') and r.get('p') is not None:
                lines.append(f"  {m}: {r['test']}, p = {float(r['p']):.4g}"
                             + (f" ({r['note']})" if r.get('note') else ''))
            elif r.get('error'):
                lines.append(f"  {m}: not computed — {r['error']}")
    if payload.get('distributions'):
        lines.append('')
        lines.append('Metrics with many values per cell (events, intervals …) have four tables: '
                     'the per-cell mean (one value per cell, tested like the others), "by cell" '
                     '(a nested table — each cell a sub-column; nested t test / ANOVA with the cell as '
                     'the random factor, for independent groups), the cumulative distribution (a curve '
                     'per cell; the graph shows each group\'s mean curve) and the pooled events '
                     '(Kolmogorov-Smirnov test for two independent groups, as Cohort\'s pooled K-S). '
                     'Time courses: an XY table, one replicate per cell, mean ± SEM per bin, with a '
                     'two-way repeated-measures ANOVA (time × group; mixed-effects model when bins are '
                     'missing).')
        sub = (design.get('subsample') or {})
        if sub.get('mode') and sub.get('mode') != 'all':
            lines.append(f"Events per cell: {sub.get('mode')} {sub.get('n') or ''} (as in Cohort's graphs).")
    info = {'id': _id(), 'name': 'TRACER cohort',
            'fields': {'Project': os.path.basename(folder.rstrip('/\\')),
                       'Protocol': str(payload.get('analysis_type') or '')},
            'notes': '\n'.join(lines)}

    return {
        'format': FORMAT_ID, 'version': FORMAT_VERSION,
        'app_version': f"TRACER {payload.get('app_version') or ''}".strip(),
        'saved': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'tables': tables, 'infos': [info], 'analyses': analyses, 'graphs': graphs,
        'figures': [], 'labels': {}, 'label_names': {}, 'imports': {},
    }


def write_asterism(payload: dict) -> bytes:
    """The ``.asterism`` file bytes (zip: ``mimetype`` stored first, then
    ``project.json``), the same layout ASTERISM writes."""
    project = build_project(payload)
    if not project['tables']:
        raise ValueError('No metric with values to export.')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), MIMETYPE, zipfile.ZIP_STORED)
        z.writestr('project.json', json.dumps(project, indent=1, ensure_ascii=False).encode('utf-8'),
                   zipfile.ZIP_DEFLATED)
    return buf.getvalue()
