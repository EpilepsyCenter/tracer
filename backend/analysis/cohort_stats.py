"""Cohort statistical tests via Pingouin.

Phase B.4 deliverable. The cohort wizard (Phase B.3) classifies the
study design and assigns cells to groups; this module takes the
per-group numeric values, runs the appropriate test, and returns a
JSON-serialisable result with the test name, statistic, p-value,
effect size, and per-group descriptive stats.

# Design taxonomy

The wizard hands us one of four design kinds:

* ``unpaired_2``  — two independent groups (between recordings)
* ``oneway_n``    — three+ independent groups (between recordings)
* ``paired_2``    — two conditions in the same cells (within)
* ``rm_n``        — three+ conditions in the same cells (within RM)

Plus a ``test_override`` of ``auto`` / ``parametric`` / ``nonparametric``.
``auto`` runs Shapiro-Wilk on each group and picks the parametric
branch only if every group passes (p > .05); otherwise the rank-based
test runs. The override forces one branch and skips the normality
check.

# Why Pingouin

Pingouin's tidy-DataFrame APIs return effect sizes (Cohen's d, η²,
rank-biserial, …) alongside the stat + p, which is what reviewers
want to see in the table without a second computation step. It also
covers the post-hoc menu (Tukey, Dunn, pairwise t-tests with various
corrections) under one umbrella.

# What's NOT in here

* Methods-section blurb generation (intentionally dropped — see the
  spec; reviewers don't trust auto-generated methods text)
* Plot rendering (B.6 — matplotlib lives in a different module)
* Multi-metric runs (the metric tree in B.5 will iterate this
  runner; here we test one metric per call)
"""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
from scipy import stats as scistats

# Pingouin is heavy (pulls statsmodels + scikit-learn). Import is
# top-level since this module is only imported when the cohort stats
# endpoint is actually called.
import pingouin as pg


# Significance threshold for the Shapiro-Wilk normality gate. Hard-
# coded to the universal 0.05 — making it user-configurable in the
# UI is technically feasible but invites the wrong kind of fiddling.
SHAPIRO_ALPHA = 0.05


def _clean(xs) -> list[float]:
    """Drop None/NaN, coerce to float. Matches ``cohort._clean`` —
    duplicated to keep this module independently testable."""
    out: list[float] = []
    for x in xs or []:
        if x is None:
            continue
        try:
            f = float(x)
        except (TypeError, ValueError):
            continue
        if math.isnan(f):
            continue
        out.append(f)
    return out


def _descriptives(values: list[float]) -> dict:
    """Per-group mean / SD / SEM / median / IQR for the result table.
    Returns ``None``-shaped scalars when the group is too small."""
    n = len(values)
    if n == 0:
        return {'n': 0, 'mean': None, 'sd': None, 'sem': None,
                'median': None, 'q1': None, 'q3': None}
    arr = np.array(values, dtype=float)
    mean = float(np.mean(arr))
    sd = float(np.std(arr, ddof=1)) if n >= 2 else None
    sem = (sd / math.sqrt(n)) if sd is not None else None
    median = float(np.median(arr))
    q1 = float(np.percentile(arr, 25))
    q3 = float(np.percentile(arr, 75))
    return {
        'n': int(n), 'mean': mean, 'sd': sd, 'sem': sem,
        'median': median, 'q1': q1, 'q3': q3,
    }


def _no_variation(values: list[float]) -> bool:
    """All values (practically) identical: there is no spread, so
    normality can't be tested and a t-test / ANOVA is undefined."""
    if len(values) < 2:
        return False
    lo, hi = min(values), max(values)
    scale = max(1.0, abs(float(np.mean(values))))
    return (hi - lo) <= 1e-12 * scale


def _shapiro(values: list[float]) -> dict:
    """Shapiro-Wilk normality. Returns p plus a verdict. Skipped
    (verdict 'unknown') when n < 4 — pingouin's ``normality``
    asserts ``data.size > 3`` so anything below that crashes the
    request with an unhelpful 500.

    Identical values get ``'no variation'``: Shapiro-Wilk returns p = 1
    on them (it can't detect anything), which must not be read as
    "normal" — the parametric test would then divide by a zero spread
    (t = ∞, p = 0)."""
    n = len(values)
    if _no_variation(values):
        return {'n': n, 'p': None, 'is_normal': None, 'verdict': 'no variation'}
    if n < 4:
        return {'n': n, 'p': None, 'is_normal': None, 'verdict': 'unknown'}
    df = pg.normality(np.array(values, dtype=float))
    p = float(df.iloc[0]['pval'])
    is_normal = bool(p > SHAPIRO_ALPHA)
    return {
        'n': n, 'p': p, 'is_normal': is_normal,
        'verdict': 'normal' if is_normal else 'non-normal',
    }


def _decide_branch(group_normality: list[dict], override: str) -> str:
    """Map (Shapiro results, override) → 'parametric' or 'nonparametric'.

    Default policy when override = 'auto':
      * Every group with n ≥ 3 must pass Shapiro to qualify as
        parametric.
      * Groups with n < 3 are inconclusive — we err on the side of
        parametric there since the alternative is more likely to
        reject given small samples are noisy.
    """
    if override in ('parametric', 'nonparametric'):
        return override
    for g in group_normality:
        # 'unknown' (n<3) doesn't disqualify; 'non-normal' does.
        if g.get('verdict') == 'non-normal':
            return 'nonparametric'
    return 'parametric'


# ---------------------------------------------------------------------
# Test runners — one per design kind. Each returns a dict with the
# canonical fields the response carries:
#   test, statistic, statistic_label, p, effect_size, effect_size_label,
#   df (when applicable), posthoc (None or list of dicts)
# ---------------------------------------------------------------------

def _col(df, *candidates):
    """Return the first existing column from ``candidates``, or
    ``None`` if none match. Pingouin renamed several columns between
    0.5.x (``p-val``, ``cohen-d``) and 0.6.x (``p_val``, ``cohen_d``)
    — this lets the runner work across both."""
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _row_get(df, *candidates):
    """Same as :func:`_col` but returns the value at row 0 already
    coerced to float, or ``None``."""
    c = _col(df, *candidates)
    if c is None:
        return None
    val = df[c].iloc[0]
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _run_unpaired_2(group_values: list[list[float]],
                     group_tags: list[str], branch: str) -> dict:
    """Two independent groups — unpaired t / Mann-Whitney U."""
    a, b = np.array(group_values[0], dtype=float), np.array(group_values[1], dtype=float)
    if branch == 'parametric':
        # Welch's t-test by default — drops the equal-variance
        # assumption that Student's t needs; essentially free.
        df = pg.ttest(a, b, paired=False, correction='auto')
        return {
            'test': "Welch's t-test",
            'statistic': _row_get(df, 'T'),
            'statistic_label': 't',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': _row_get(df, 'dof'),
            'effect_size': _row_get(df, 'cohen_d', 'cohen-d'),
            'effect_size_label': "Cohen's d",
            'posthoc': None,
        }
    else:
        df = pg.mwu(a, b)
        return {
            'test': 'Mann-Whitney U',
            'statistic': _row_get(df, 'U_val', 'U-val'),
            'statistic_label': 'U',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': None,
            'effect_size': _row_get(df, 'RBC'),
            'effect_size_label': 'rank-biserial r',
            'posthoc': None,
        }


def _run_paired_2(group_values: list[list[float]],
                   group_tags: list[str], branch: str) -> dict:
    """Two paired conditions — paired t / Wilcoxon signed-rank."""
    a = np.array(group_values[0], dtype=float)
    b = np.array(group_values[1], dtype=float)
    if branch == 'parametric':
        df = pg.ttest(a, b, paired=True)
        return {
            'test': 'Paired t-test',
            'statistic': _row_get(df, 'T'),
            'statistic_label': 't',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': _row_get(df, 'dof'),
            'effect_size': _row_get(df, 'cohen_d', 'cohen-d'),
            'effect_size_label': "Cohen's d (paired)",
            'posthoc': None,
        }
    else:
        df = pg.wilcoxon(a, b)
        return {
            'test': 'Wilcoxon signed-rank',
            'statistic': _row_get(df, 'W_val', 'W-val'),
            'statistic_label': 'W',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': None,
            'effect_size': _row_get(df, 'RBC'),
            'effect_size_label': 'matched-pairs rank-biserial r',
            'posthoc': None,
        }


def _build_long_df(group_values: list[list[float]],
                   group_tags: list[str], paired: bool):
    """Tidy long-format DataFrame for pingouin's RM/ANOVA APIs.
    Columns: ``subject`` (only meaningful for paired/RM), ``group``,
    ``value``."""
    import pandas as pd
    rows = []
    if paired:
        # All groups have the same length (paired design); each row
        # index is the same subject across groups.
        n = min(len(v) for v in group_values)
        for i in range(n):
            for tag, vals in zip(group_tags, group_values):
                rows.append({'subject': i, 'group': tag, 'value': vals[i]})
    else:
        # Independent groups — assign unique subject IDs across groups
        # since pingouin's anova still needs a subject column for some
        # APIs (we'll use ``between`` design which doesn't need it,
        # but keep the column for shape consistency).
        sid = 0
        for tag, vals in zip(group_tags, group_values):
            for v in vals:
                rows.append({'subject': sid, 'group': tag, 'value': v})
                sid += 1
    return pd.DataFrame(rows)


def _ph_row(row, *p_candidates):
    """Helper for pairwise_tukey / pairwise_tests row extraction —
    handles both the ``A``/``B`` group columns and the per-method
    p-value column rename across pingouin versions."""
    return {
        'a': str(row['A']), 'b': str(row['B']),
        'p': next((float(row[c]) for c in p_candidates if c in row.index), None),
    }


def _run_oneway_n(group_values: list[list[float]],
                   group_tags: list[str], branch: str) -> dict:
    """3+ independent groups — one-way ANOVA + Tukey / Kruskal-Wallis + Dunn."""
    df = _build_long_df(group_values, group_tags, paired=False)
    if branch == 'parametric':
        anova = pg.anova(df, dv='value', between='group', detailed=True)
        row = anova.iloc[0]
        ph = pg.pairwise_tukey(df, dv='value', between='group')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_tukey', 'p-tukey')
            entry['mean_diff'] = float(r['diff']) if 'diff' in r.index else None
            entry['method'] = 'Tukey HSD'
            posthoc.append(entry)
        return {
            'test': 'One-way ANOVA',
            'statistic': float(row['F']),
            'statistic_label': 'F',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['DF']),
            'effect_size': float(row['np2']) if 'np2' in row.index else None,
            'effect_size_label': 'partial η²',
            'posthoc': posthoc,
        }
    else:
        kw = pg.kruskal(df, dv='value', between='group')
        row = kw.iloc[0]
        ph = pg.pairwise_tests(df, dv='value', between='group',
                               parametric=False, padjust='holm')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_corr', 'p-corr')
            entry['method'] = 'Dunn (Holm-corrected)'
            posthoc.append(entry)
        return {
            'test': 'Kruskal-Wallis',
            'statistic': float(row['H']),
            'statistic_label': 'H',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['ddof1']),
            'effect_size': None,
            'effect_size_label': None,
            'posthoc': posthoc,
        }


def _run_rm_n(group_values: list[list[float]],
               group_tags: list[str], branch: str) -> dict:
    """3+ paired conditions — RM-ANOVA + post-hoc / Friedman + Dunn."""
    df = _build_long_df(group_values, group_tags, paired=True)
    if branch == 'parametric':
        rm = pg.rm_anova(df, dv='value', within='group', subject='subject',
                         detailed=True)
        row = rm.iloc[0]
        ph = pg.pairwise_tests(df, dv='value', within='group',
                               subject='subject', parametric=True,
                               padjust='holm')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_corr', 'p-corr')
            entry['method'] = 'Paired t (Holm-corrected)'
            posthoc.append(entry)
        # RM-ANOVA effect size in pingouin 0.6 uses ``ng2`` (generalized
        # eta-squared); older versions had ``np2``. Fall back across
        # both so the runner doesn't bias the report towards one
        # pingouin release.
        eff = float(row['np2']) if 'np2' in row.index \
            else float(row['ng2']) if 'ng2' in row.index \
            else None
        return {
            'test': 'Repeated-measures ANOVA',
            'statistic': float(row['F']),
            'statistic_label': 'F',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['DF']) if 'DF' in row.index else None,
            'effect_size': eff,
            'effect_size_label': 'generalized η²' if 'ng2' in row.index else 'partial η²',
            'posthoc': posthoc,
        }
    else:
        fr = pg.friedman(df, dv='value', within='group', subject='subject')
        row = fr.iloc[0]
        ph = pg.pairwise_tests(df, dv='value', within='group',
                               subject='subject', parametric=False,
                               padjust='holm')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_corr', 'p-corr')
            entry['method'] = 'Wilcoxon (Holm-corrected)'
            posthoc.append(entry)
        return {
            'test': 'Friedman',
            'statistic': float(row['Q']),
            'statistic_label': 'Q',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['ddof1']) if 'ddof1' in row.index else None,
            'effect_size': None,
            'effect_size_label': None,
            'posthoc': posthoc,
        }


# ---------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------

DESIGN_KINDS = {'unpaired_2', 'oneway_n', 'paired_2', 'rm_n'}
TEST_OVERRIDES = {'auto', 'parametric', 'nonparametric'}


def run_test(
    groups: list[dict],
    design_kind: str,
    test_override: str = 'auto',
) -> dict:
    """Run the appropriate stats test for ``design_kind`` over the
    per-group numeric ``values``.

    Parameters
    ----------
    groups
        ``[{'tag': str, 'values': [float | None]}, …]`` — one entry
        per group. Order matters for paired designs (rows must align
        across groups).
    design_kind
        One of :data:`DESIGN_KINDS`.
    test_override
        One of :data:`TEST_OVERRIDES`. ``auto`` lets Shapiro decide.

    Returns
    -------
    dict
        Self-describing result payload. ``error`` is set instead of
        the test fields when something went wrong (e.g. degenerate
        sample, paired groups of unequal length).
    """
    if design_kind not in DESIGN_KINDS:
        return {'error': f'Unknown design_kind: {design_kind!r}'}
    if test_override not in TEST_OVERRIDES:
        return {'error': f'Unknown test_override: {test_override!r}'}

    # Clean numeric input. Drops None/NaN per group.
    cleaned = [_clean(g.get('values', [])) for g in groups]
    tags = [str(g.get('tag', f'group_{i}')) for i, g in enumerate(groups)]

    descriptives = [_descriptives(v) for v in cleaned]

    # Sanity: paired designs need every group at the same length AND
    # row alignment. Caller is responsible for alignment but we catch
    # the length mismatch here with a clear error rather than letting
    # pingouin throw.
    paired = design_kind in ('paired_2', 'rm_n')
    if paired:
        lens = [len(v) for v in cleaned]
        if min(lens) != max(lens):
            return {
                'error': (f'Paired design requires equal-length groups; '
                          f'got {dict(zip(tags, lens))}'),
                'descriptives': dict(zip(tags, descriptives)),
            }

    # Need ≥ 2 per group for any test to be meaningful.
    too_small = [tags[i] for i, v in enumerate(cleaned) if len(v) < 2]
    if too_small:
        return {
            'error': f'Groups too small (n < 2): {too_small}',
            'descriptives': dict(zip(tags, descriptives)),
        }

    # Normality per group (shown for every design). A paired design's
    # assumption is about the paired differences, so that is what
    # decides its branch.
    normality = [_shapiro(v) for v in cleaned]
    diff_normality: Optional[dict] = None
    basis = normality
    if design_kind == 'paired_2':
        diffs = list(np.asarray(cleaned[1], dtype=float) - np.asarray(cleaned[0], dtype=float))
        if all(abs(d) <= 1e-12 * max(1.0, abs(float(np.mean(cleaned[0])))) for d in diffs):
            return {
                'error': 'Every paired difference is zero — the conditions are identical, nothing to test.',
                'descriptives': dict(zip(tags, descriptives)),
                'normality': dict(zip(tags, normality)),
            }
        diff_normality = _shapiro(diffs)
        basis = [diff_normality]
    elif all(_no_variation(v) for v in cleaned) and len({round(v[0], 12) for v in cleaned}) == 1:
        return {
            'error': 'All values are identical in every group — nothing to compare.',
            'descriptives': dict(zip(tags, descriptives)),
            'normality': dict(zip(tags, normality)),
        }

    no_variation = [g for g in basis if g.get('verdict') == 'no variation']
    note = None
    if no_variation:
        what = 'the paired differences are all the same' if diff_normality is not None \
            else 'a group has no variation (all values identical)'
        if test_override == 'parametric':
            return {
                'error': (f'The parametric test is undefined here: {what}, so the spread is zero. '
                          f'Use the nonparametric test, or check the data.'),
                'descriptives': dict(zip(tags, descriptives)),
                'normality': dict(zip(tags, normality)),
                **({'normality_differences': diff_normality} if diff_normality else {}),
            }
        branch = 'nonparametric'
        note = (f'Normality can\'t be tested because {what}; a parametric test would be '
                f'undefined, so the rank-based test was used.')
    else:
        branch = _decide_branch(basis, test_override)

    runner = {
        'unpaired_2': _run_unpaired_2,
        'oneway_n': _run_oneway_n,
        'paired_2': _run_paired_2,
        'rm_n': _run_rm_n,
    }[design_kind]

    try:
        test_result = runner(cleaned, tags, branch)
    except Exception as exc:  # noqa: BLE001 — surface, don't crash
        return {
            'error': f'{type(exc).__name__}: {exc}',
            'descriptives': dict(zip(tags, descriptives)),
            'normality': dict(zip(tags, normality)),
            'branch': branch,
        }

    return {
        **test_result,
        'branch': branch,
        'override': test_override,
        **({'note': note} if note else {}),
        **({'normality_differences': diff_normality} if diff_normality else {}),
        'normality': dict(zip(tags, normality)),
        'descriptives': dict(zip(tags, descriptives)),
        'design_kind': design_kind,
        'group_tags': tags,
        'alpha': SHAPIRO_ALPHA,
    }


# ---------------------------------------------------------------------
# Distribution-metric tests (K-S family)
# ---------------------------------------------------------------------
#
# The scalar ``run_test`` above tests one number per cell. For
# distribution metrics — every event's IEI / amplitude / AUC — there
# isn't a single canonical test; the literature uses a few options
# depending on group count:
#
#   * 2 groups: pooled two-sample K-S (the textbook mEPSC test)
#   * 3+ groups: no consensus; defaults here are pairwise pooled K-S
#     with Holm correction. Anderson-Darling k-sample is offered as
#     an opt-in for users who want a single k-sample p.
#
# Pooled K-S pseudoreplicates events nested in cells — that's a real
# stats problem, but it's also what most published mini papers do.
# We surface it under a clear test name so the figure reader knows
# exactly what was run.
#
# Per-cell K-S D mode escapes the pseudoreplication problem: each
# cell contributes one D statistic vs a reference distribution, then
# those D's are fed through the regular scalar ``run_test``. Caller
# picks the reference (default = pooled events of group 0).

DISTRIBUTION_MODES = {'pooled_ks', 'per_cell_ks_d'}
# K-S is design-agnostic: ks_2samp on pooled events answers
# "do the two distributions differ" regardless of whether the
# cells are matched. Paired designs (paired_2, rm_n) still use
# the same pooled-K-S formula; the design only matters for the
# per-cell-D mode where the resulting D scalars feed through
# the design-aware ``run_test``.
DISTRIBUTION_DESIGN_KINDS = {'unpaired_2', 'oneway_n', 'paired_2', 'rm_n'}


def _holm_correct(p_values: list[float]) -> list[float]:
    """Holm-Bonferroni correction. Sort ascending, apply
    ``p * (m - i)`` with the monotone constraint that corrected
    values can't decrease as i increases. Returns corrected p's in
    the original input order."""
    m = len(p_values)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: p_values[i])
    corrected = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        adj = min(1.0, p_values[i] * (m - rank))
        running = max(running, adj)
        corrected[i] = running
    return corrected


def _pooled_ks_2(a: np.ndarray, b: np.ndarray) -> dict:
    """Two-sample K-S statistic + p. Wraps ``scipy.stats.ks_2samp``
    so the rest of the module doesn't have to know the SciPy API."""
    res = scistats.ks_2samp(a, b)
    return {
        'D': float(res.statistic),
        'p': float(res.pvalue),
        'n_a': int(a.size),
        'n_b': int(b.size),
    }


def _pooled_ks_unpaired_2(pooled: list[np.ndarray],
                           tags: list[str]) -> dict:
    """Pooled K-S for the 2-group unpaired case."""
    res = _pooled_ks_2(pooled[0], pooled[1])
    return {
        'test': 'Pooled two-sample K-S',
        'statistic': res['D'],
        'statistic_label': 'D',
        'p': res['p'],
        'df': None,
        'effect_size': res['D'],
        'effect_size_label': 'K-S D',
        'posthoc': None,
        'pooled_n': {tags[0]: res['n_a'], tags[1]: res['n_b']},
        'note': 'Pseudoreplicates events within cells — convention follows '
                'mini-EPSC literature. Per-cell-K-S-D mode avoids this.',
    }


def _pooled_ks_pairwise(pooled: list[np.ndarray],
                         tags: list[str]) -> dict:
    """Pairwise pooled K-S with Holm correction across the
    ``len(tags) choose 2`` comparisons."""
    pairs: list[tuple[int, int, dict]] = []
    raw_p: list[float] = []
    for i in range(len(tags)):
        for j in range(i + 1, len(tags)):
            res = _pooled_ks_2(pooled[i], pooled[j])
            pairs.append((i, j, res))
            raw_p.append(res['p'])
    holm_p = _holm_correct(raw_p)
    posthoc = []
    for (i, j, res), p_corr in zip(pairs, holm_p):
        posthoc.append({
            'a': tags[i], 'b': tags[j],
            'D': res['D'],
            'p_uncorrected': res['p'],
            'p': p_corr,
            'n_a': res['n_a'], 'n_b': res['n_b'],
            'method': 'Pooled K-S (Holm-corrected)',
        })
    headline = min(holm_p) if holm_p else None
    headline_pair = posthoc[holm_p.index(headline)] if headline is not None else None
    return {
        'test': 'Pairwise pooled K-S (Holm)',
        'statistic': headline_pair['D'] if headline_pair else None,
        'statistic_label': 'D (smallest-p pair)',
        'p': headline,
        'df': None,
        'effect_size': headline_pair['D'] if headline_pair else None,
        'effect_size_label': 'K-S D (smallest-p pair)',
        'posthoc': posthoc,
        'pooled_n': {tags[i]: int(pooled[i].size) for i in range(len(tags))},
        'note': 'Pseudoreplicates events within cells. Headline p is the '
                'minimum across pairs after Holm correction; full pair '
                'breakdown is in posthoc.',
    }


def _anderson_darling_ksamp(pooled: list[np.ndarray],
                             tags: list[str]) -> dict:
    """k-sample Anderson-Darling — a single p across all groups,
    proper generalisation of the 2-sample K-S to k > 2."""
    import warnings
    with warnings.catch_warnings():
        # SciPy floors A-D p-values at 1e-3 and warns each time —
        # noisy when many cells produce tiny p's. Also suppress the
        # ``midrank`` → ``variant`` deprecation chatter.
        warnings.simplefilter('ignore', UserWarning)
        res = scistats.anderson_ksamp([np.asarray(p, dtype=float) for p in pooled])
    # SciPy clamps significance_level to [0.001, 0.25]; the raw
    # p_value attribute (newer SciPy) is unclamped.
    p = float(getattr(res, 'pvalue', None)
              if getattr(res, 'pvalue', None) is not None
              else res.significance_level / 100.0)
    return {
        'test': 'Anderson-Darling k-sample',
        'statistic': float(res.statistic),
        'statistic_label': 'A²',
        'p': p,
        'df': None,
        'effect_size': None,
        'effect_size_label': None,
        'posthoc': None,
        'pooled_n': {tags[i]: int(pooled[i].size) for i in range(len(tags))},
        'note': 'k-sample generalisation of K-S; one p across all groups. '
                'Like pooled K-S, pseudoreplicates events within cells.',
    }


def _per_cell_ks_d(values_per_cell_per_group: list[list[list[float]]],
                    tags: list[str],
                    reference_group_idx: int) -> tuple[list[list[float]], np.ndarray]:
    """For each cell in each group, compute the K-S statistic D
    against the pooled events of ``reference_group_idx``. Returns
    ``(per_group_d_values, reference_pooled)`` so the caller can
    feed the D scalars into the regular ``run_test``."""
    ref_pooled = np.concatenate([
        np.asarray(c, dtype=float)
        for c in values_per_cell_per_group[reference_group_idx]
        if len(c) > 0
    ]) if values_per_cell_per_group[reference_group_idx] else np.array([], dtype=float)
    out: list[list[float]] = []
    for g_idx, cells in enumerate(values_per_cell_per_group):
        d_list: list[float] = []
        for cell in cells:
            arr = np.asarray(cell, dtype=float)
            if arr.size == 0 or ref_pooled.size == 0:
                continue
            d_list.append(float(scistats.ks_2samp(arr, ref_pooled).statistic))
        out.append(d_list)
    return out, ref_pooled


def run_distribution_test(
    groups: list[dict],
    design_kind: str,
    mode: str = 'pooled_ks',
    anderson_darling: bool = False,
    reference_group_idx: int = 0,
) -> dict:
    """Run a distribution-aware test on per-cell event arrays.

    Parameters
    ----------
    groups
        ``[{'tag': str, 'values_per_cell': [[float, …], …]}, …]`` — one
        entry per group, each with a list of per-cell arrays.
    design_kind
        Only ``'unpaired_2'`` and ``'oneway_n'`` are supported here —
        K-S between paired conditions isn't a coherent test (events
        aren't paired across conditions even if cells are).
    mode
        ``'pooled_ks'``       — pool all events per group, run K-S.
                                Pairwise + Holm for 3+ groups.
        ``'per_cell_ks_d'``   — D vs reference pooled, then scalar
                                ``run_test`` over the resulting D's.
    anderson_darling
        Only honoured when ``mode='pooled_ks'`` and ``design_kind ==
        'oneway_n'``. Replaces the pairwise pooled-K-S with the
        k-sample Anderson-Darling.
    reference_group_idx
        Only honoured when ``mode='per_cell_ks_d'``. Index into
        ``groups`` whose pooled events are the reference distribution.
    """
    if design_kind not in DISTRIBUTION_DESIGN_KINDS:
        return {'error': (f'Distribution tests support only '
                          f'{sorted(DISTRIBUTION_DESIGN_KINDS)}; '
                          f'got {design_kind!r}')}
    if mode not in DISTRIBUTION_MODES:
        return {'error': f'Unknown distribution mode: {mode!r}'}

    tags = [str(g.get('tag', f'group_{i}')) for i, g in enumerate(groups)]
    values_per_cell_per_group: list[list[list[float]]] = [
        [_clean(c) for c in (g.get('values_per_cell') or [])
         if c is not None]
        for g in groups
    ]
    # Drop empty cells (cells with zero events for this metric) so
    # they don't show up as zero-length distributions and crash K-S.
    values_per_cell_per_group = [
        [c for c in cells if len(c) > 0]
        for cells in values_per_cell_per_group
    ]

    if mode == 'pooled_ks':
        pooled = [np.concatenate([np.asarray(c, dtype=float) for c in cells])
                  if cells else np.array([], dtype=float)
                  for cells in values_per_cell_per_group]
        too_small = [tags[i] for i, p in enumerate(pooled) if p.size < 2]
        if too_small:
            return {'error': f'Pooled groups too small (n_events < 2): {too_small}',
                    'group_tags': tags}
        # 2-group designs (paired or unpaired) → single ks_2samp.
        # 3+-group designs → pairwise + Holm, or k-sample
        # Anderson-Darling. Pooling discards the pairing, so paired
        # designs yield the same number as their unpaired equivalents
        # — the test answers "do the distributions differ" either way.
        is_two_group = design_kind in ('unpaired_2', 'paired_2')
        is_paired = design_kind in ('paired_2', 'rm_n')
        try:
            if is_two_group:
                test_result = _pooled_ks_unpaired_2(pooled, tags)
                # Override the test name so the figure caption is
                # honest about which design was used.
                if is_paired:
                    test_result['test'] = 'Pooled two-sample K-S (paired pre/post)'
            else:  # 3+ groups: oneway_n or rm_n
                test_result = (_anderson_darling_ksamp(pooled, tags)
                               if anderson_darling
                               else _pooled_ks_pairwise(pooled, tags))
                if is_paired and not anderson_darling:
                    test_result['test'] = 'Pairwise pooled K-S, paired (Holm)'
        except Exception as exc:  # noqa: BLE001
            return {'error': f'{type(exc).__name__}: {exc}',
                    'group_tags': tags}
        return {
            **test_result,
            'mode': mode,
            'design_kind': design_kind,
            'group_tags': tags,
            'anderson_darling': bool(anderson_darling and not is_two_group),
        }

    # per_cell_ks_d: collapse to one scalar D per cell, then regular
    # run_test over those scalars. Inherits the parametric/non-
    # parametric branch logic for free.
    if not (0 <= reference_group_idx < len(groups)):
        return {'error': f'reference_group_idx {reference_group_idx} out of range',
                'group_tags': tags}
    d_per_group, ref_pooled = _per_cell_ks_d(
        values_per_cell_per_group, tags, reference_group_idx,
    )
    if ref_pooled.size == 0:
        return {'error': f'Reference group {tags[reference_group_idx]!r} '
                          f'has no events to compute D against',
                'group_tags': tags}
    scalar_groups = [{'tag': tag, 'values': vals}
                     for tag, vals in zip(tags, d_per_group)]
    inner = run_test(scalar_groups, design_kind, test_override='nonparametric')
    inner['mode'] = mode
    inner['reference_group'] = tags[reference_group_idx]
    inner['reference_n_events'] = int(ref_pooled.size)
    if 'test' in inner:
        # Make the test name self-describing — without this users see
        # "Mann-Whitney U" and have to read the mode field separately
        # to understand it was on the per-cell K-S Ds.
        inner['test'] = f"{inner['test']} on per-cell K-S D vs {tags[reference_group_idx]!r}"
    return inner
