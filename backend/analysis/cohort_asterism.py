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

PAIRED_KINDS = {'paired_2', 'rm_n'}


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

    for t in payload.get('tables') or []:
        tags = [str(x) for x in t.get('tags') or []]
        cols = [[_num(v) for v in col] for col in t.get('values') or []]
        if not tags or len(cols) != len(tags) or not any(v is not None for c in cols for v in c):
            continue
        name = str(t.get('label') or t.get('metric') or 'Metric')
        tid = _id()
        row_titles = [str(x) for x in (t.get('row_titles') or [])] if paired else []
        tables.append({
            'id': tid, 'name': name, 'type': 'column', 'y_format': 'single', 'replicates': 1,
            'x_format': 'none', 'has_row_titles': bool(row_titles),
            'titles': tags, 'sub_titles': [[''] for _ in tags],
            'y': cols, 'x': [], 'x_err': [], 'row_titles': row_titles, 'excluded': [],
        })
        style = _BEFORE_AFTER if paired else _SCATTER_SEM
        graphs.append({
            'id': _id(), 'name': name, 'auto_name': False, 'table': tid,
            'spec': {'title': name, 'default_style': dict(style), 'connect_rows': paired,
                     'y': {'title': name}},
        })
        # The test Cohort ran — or, when its statistics weren't run, the
        # one it would choose (normality, no-variation data → rank test),
        # so the file never carries a t-test Cohort would refuse.
        metric = t.get('metric')
        branch = (stats.get(metric) or {}).get('branch') or branches.get(metric)
        if not branch:
            from analysis import cohort_stats
            r = cohort_stats.run_test([{'tag': g, 'values': v} for g, v in zip(tags, cols)],
                                      design_kind, override if override in cohort_stats.TEST_OVERRIDES else 'auto')
            branch = r.get('branch') or ('nonparametric' if override == 'nonparametric' else 'parametric')
            stats.setdefault(metric, r)
        an = _analysis(design_kind, branch, len(tags))
        if an:
            analyses.append({'id': _id(), 'name': '', 'auto_name': True, 'type': an[0],
                             'table': tid, 'columns': list(range(len(tags))), 'params': an[1]})

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
    skipped = payload.get('skipped_metrics') or []
    if skipped:
        lines.append('')
        lines.append('Not included (distribution metrics; use the Excel or Prism export): '
                     + ', '.join(skipped))
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
        raise ValueError('No scalar metric with values to export.')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), MIMETYPE, zipfile.ZIP_STORED)
        z.writestr('project.json', json.dumps(project, indent=1, ensure_ascii=False).encode('utf-8'),
                   zipfile.ZIP_DEFLATED)
    return buf.getvalue()
