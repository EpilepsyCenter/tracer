"""Quality control: judge cells from measurements users already made.

QC measures nothing itself. Per recording (one file = one cell) it reads
the sidecar's existing results on tagged series:

- Resistance (``analyses.resistance["g:s"]``): Rs, Rin, Cm, and the
  pre-pulse ``baseline``, i.e. the holding current in voltage clamp;
- Cursor (``analyses.cursor_analyses["g:s"]``): the baseline, i.e. the
  resting Vm in current clamp.

The user lists **conditions** (e.g. baseline → drug 1 → washout), each
naming the series tags its measurements come from — several are allowed,
because a lab may measure Rs inside the data sweeps in some cells
(``drug``) and in a separate test-pulse series in others (``tp_drug``) —
and, optionally, the tags of the series it judges (default: the same
tags). Values are
compared with the reference condition, rules are applied, and each
condition and cell gets a verdict: ``pass`` / ``warn`` / ``fail``.

Everything the user decides — conditions, rules, overrides — lives in
``tracer_qc.json`` in the folder. QC never writes sidecars, and
verdicts are never stored: they are worked out from the results and
the current rules every time. See docs/QC_PLAN.md.
"""

from __future__ import annotations

import copy
import json
import math
import os
from pathlib import Path
from typing import Any, Optional

RULES_FILE = 'tracer_qc.json'
FORMAT = 'tracer-qc-rules'
VERSION = 1

LEVELS = ('pass', 'warn', 'fail')
_RANK = {'pass': 0, 'warn': 1, 'fail': 2}

# Metric → (label, unit, source). Absolute metrics are judged in every
# condition; change metrics only in non-reference conditions and on
# their absolute size (|ΔRs| etc.).
METRICS: dict[str, dict[str, str]] = {
    'rs_mohm':           {'label': 'Rs', 'unit': 'MΩ', 'source': 'resistance', 'kind': 'value'},
    # Within one condition: (max − min) / mean of its Rs measurements,
    # e.g. a test pulse in every sweep of a stimulation protocol. Only
    # for series with 2+ measurements; an averaged run has no drift.
    # ``of``: it is an Rs check, so the Rs plot colours lines by it too.
    'rs_drift_pct':      {'label': 'Rs drift', 'unit': '%', 'source': 'resistance', 'kind': 'value',
                          'of': 'rs_mohm'},
    'rin_mohm':          {'label': 'Rin', 'unit': 'MΩ', 'source': 'resistance', 'kind': 'value'},
    'cm_pf':             {'label': 'Cm', 'unit': 'pF', 'source': 'resistance', 'kind': 'value'},
    'holding_pa':        {'label': 'Holding', 'unit': 'pA', 'source': 'resistance', 'kind': 'value'},
    'vm_mv':             {'label': 'Vm', 'unit': 'mV', 'source': 'cursor', 'kind': 'value'},
    'rs_change_pct':     {'label': 'Rs change', 'unit': '%', 'source': 'resistance', 'kind': 'change',
                          'of': 'rs_mohm', 'how': 'pct'},
    'holding_change_pa': {'label': 'Holding change', 'unit': 'pA', 'source': 'resistance', 'kind': 'change',
                          'of': 'holding_pa', 'how': 'diff'},
    'vm_change_mv':      {'label': 'Vm change', 'unit': 'mV', 'source': 'cursor', 'kind': 'change',
                          'of': 'vm_mv', 'how': 'diff'},
}

DEFAULT_CONFIG: dict[str, Any] = {
    'format': FORMAT,
    'version': VERSION,
    # Two conditions by default; the user picks their tags.
    'conditions': [
        {'name': 'Baseline', 'tags': [], 'applies_to': []},
        {'name': 'Condition 2', 'tags': [], 'applies_to': []},
    ],
    'reference': 0,
    # 'exclude-condition': only failing conditions drop out;
    # 'exclude-cell': any failing condition drops the whole cell.
    'cell_rule': 'exclude-condition',
    # Agreed defaults (2026-11-02), all editable. ``required``: a cell
    # with no measurement of this kind at all gets ``missing`` (Rs is
    # the core check); otherwise the rule is "not applicable" (e.g. Vm
    # on a voltage-clamp cell).
    'rules': [
        {'metric': 'rs_mohm', 'enabled': True, 'required': True,
         'warn': None, 'fail': {'op': '>', 'value': 25}},
        {'metric': 'rs_change_pct', 'enabled': True, 'required': True,
         'warn': None, 'fail': {'op': '>', 'value': 20}},
        {'metric': 'rs_drift_pct', 'enabled': True, 'required': False,
         'warn': None, 'fail': {'op': '>', 'value': 20}},
        {'metric': 'holding_pa', 'enabled': True, 'required': False,
         'warn': None, 'fail': {'op': '<', 'value': -200}},
        {'metric': 'vm_mv', 'enabled': True, 'required': False,
         'warn': None, 'fail': {'op': '>', 'value': -55}},
    ],
    # Level for a condition whose tagged series exist but carry no
    # result the rule needs.
    'missing': 'warn',
    # {file_name: {'cell': {...}, 'conditions': {condition name: {...}}}},
    # each {'verdict', 'reason', 'date'}.
    'overrides': {},
}


def default_config() -> dict:
    return copy.deepcopy(DEFAULT_CONFIG)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def _mean(xs) -> Optional[float]:
    vals = [x for x in (_num(v) for v in xs) if x is not None]
    return sum(vals) / len(vals) if vals else None


def _drift_pct(xs) -> Optional[float]:
    """(max − min) / |mean| × 100 — Cohort's ``rs_drift_pct``. None with
    fewer than two values."""
    vals = [x for x in (_num(v) for v in xs) if x is not None]
    if len(vals) < 2:
        return None
    m = sum(vals) / len(vals)
    return None if abs(m) < 1e-12 else (max(vals) - min(vals)) / abs(m) * 100.0


def _worst(levels) -> Optional[str]:
    present = [lv for lv in levels if lv in _RANK]
    return max(present, key=_RANK.__getitem__) if present else None


def _norm_tag(t: Any) -> str:
    return str(t or '').strip().lower()


def condition_tags(c: dict) -> list[str]:
    """The tags a condition takes its measurements from (``tags``, or a
    single ``tag``)."""
    raw = c.get('tags')
    if raw is None:
        raw = [c.get('tag')] if c.get('tag') else []
    out: list[str] = []
    for t in raw if isinstance(raw, list) else [raw]:
        if _norm_tag(t) and _norm_tag(t) not in {_norm_tag(x) for x in out}:
            out.append(str(t).strip())
    return out


def _compare(value: float, op: str, threshold: float) -> bool:
    return {
        '>': value > threshold, '>=': value >= threshold,
        '<': value < threshold, '<=': value <= threshold,
    }.get(op, False)


def rule_text(rule: dict, level: str) -> str:
    """Human wording of one level of a rule, e.g. "Rs > 25 MΩ"."""
    m = METRICS.get(rule.get('metric', ''), {})
    cond = rule.get(level) or {}
    label = m.get('label', rule.get('metric', ''))
    if m.get('kind') == 'change':
        label = f'|{label}|'
    return f"{label} {cond.get('op', '')} {cond.get('value', '')} {m.get('unit', '')}".strip()


# ---------------------------------------------------------------------------
# Reading one sidecar
# ---------------------------------------------------------------------------

def series_measurements(sidecar: dict) -> dict[str, dict[str, Any]]:
    """Per series key ``g:s``: the QC quantities found in its results.

    Resistance rows are averaged (one row per sweep, or one per averaged
    run). Cursor baselines are averaged over sweeps, once per sweep —
    the baseline window is shared by every slot, so slots repeat it.
    """
    analyses = sidecar.get('analyses') or {}
    out: dict[str, dict[str, Any]] = {}

    for key, rows in (analyses.get('resistance') or {}).items():
        if not isinstance(rows, list) or not rows:
            continue
        rec = out.setdefault(str(key), {})
        rec['rs_mohm'] = _mean(r.get('rs') for r in rows if isinstance(r, dict))
        rec['rin_mohm'] = _mean(r.get('rin') for r in rows if isinstance(r, dict))
        rec['cm_pf'] = _mean(r.get('cm') for r in rows if isinstance(r, dict))
        rec['holding_pa'] = _mean(r.get('baseline') for r in rows if isinstance(r, dict))
        rec['rs_drift_pct'] = _drift_pct(r.get('rs') for r in rows if isinstance(r, dict))
        rec['n_resistance'] = len(rows)

    for key, entry in (analyses.get('cursor_analyses') or {}).items():
        if not isinstance(entry, dict):
            continue
        per_sweep: dict[Any, float] = {}
        for m in entry.get('measurements') or []:
            if not isinstance(m, dict):
                continue
            b = _num(m.get('baseline'))
            if b is not None and m.get('sweep') not in per_sweep:
                per_sweep[m.get('sweep')] = b
        if not per_sweep:
            continue
        rec = out.setdefault(str(key), {})
        rec['vm_mv'] = sum(per_sweep.values()) / len(per_sweep)
        rec['vm_unit'] = entry.get('traceUnit') or ''
        rec['n_cursor'] = len(per_sweep)
    return out


def series_tags(sidecar: dict) -> dict[str, list[str]]:
    meta = sidecar.get('meta') or {}
    return {str(k): [str(t) for t in (v or [])] for k, v in (meta.get('series_tags') or {}).items()}


# ---------------------------------------------------------------------------
# Judging one cell
# ---------------------------------------------------------------------------

def _condition_values(tagged_keys: list[str], measured: dict[str, dict]) -> dict[str, Any]:
    """Mean of each quantity over the condition's series (usually one)."""
    vals: dict[str, Any] = {}
    for metric in ('rs_mohm', 'rin_mohm', 'cm_pf', 'holding_pa', 'vm_mv'):
        vals[metric] = _mean(measured.get(k, {}).get(metric) for k in tagged_keys)
    # Drift: the worst of the condition's series.
    drifts = [d for d in (_num(measured.get(k, {}).get('rs_drift_pct')) for k in tagged_keys) if d is not None]
    vals['rs_drift_pct'] = max(drifts) if drifts else None
    vals['has_resistance'] = any('n_resistance' in measured.get(k, {}) for k in tagged_keys)
    vals['has_cursor'] = any('n_cursor' in measured.get(k, {}) for k in tagged_keys)
    return vals


def _change(how: str, value: Optional[float], ref: Optional[float]) -> Optional[float]:
    if value is None or ref is None:
        return None
    if how == 'pct':
        return None if abs(ref) < 1e-12 else (value - ref) / abs(ref) * 100.0
    return value - ref


def evaluate_cell(sidecar: dict, config: dict, file_name: str = '') -> dict:
    """Verdicts for one recording. ``matched`` is False when no series
    carries any condition's tag (the cell is not judged)."""
    conditions = config.get('conditions') or []
    ref_i = int(config.get('reference') or 0)
    if not (0 <= ref_i < len(conditions)):
        ref_i = 0
    rules = [r for r in (config.get('rules') or []) if r.get('enabled', True) and r.get('metric') in METRICS]
    missing_level = config.get('missing', 'warn')
    if missing_level not in _RANK:
        missing_level = None  # 'ignore'

    tags = series_tags(sidecar)
    measured = series_measurements(sidecar)

    cond_out: list[dict] = []
    for c in conditions:
        ctags = condition_tags(c)
        wanted = {_norm_tag(t) for t in ctags}
        keys = sorted(k for k, ts in tags.items() if wanted & {_norm_tag(t) for t in ts})
        values = _condition_values(keys, measured) if keys else {}
        cond_out.append({
            'name': c.get('name') or ' / '.join(ctags),
            'tag': ' / '.join(ctags),
            'tags': ctags,
            'applies_to': [t for t in (c.get('applies_to') or []) if _norm_tag(t)] or ctags,
            'series': keys,
            'recorded': bool(keys),
            'values': {k: values.get(k) for k in ('rs_mohm', 'rs_drift_pct', 'rin_mohm', 'cm_pf', 'holding_pa', 'vm_mv')},
            'has_resistance': bool(values.get('has_resistance')),
            'has_cursor': bool(values.get('has_cursor')),
            'changes': {},
            'checks': [],
        })

    matched = any(c['recorded'] for c in cond_out)
    ref = cond_out[ref_i] if cond_out else None

    # Changes against the reference.
    for i, c in enumerate(cond_out):
        for metric, m in METRICS.items():
            if m['kind'] != 'change':
                continue
            c['changes'][metric] = None if (i == ref_i or ref is None) else \
                _change(m['how'], c['values'].get(m['of']), ref['values'].get(m['of']))

    # Does the cell have this kind of measurement anywhere?
    cell_has = {
        'resistance': any(c['has_resistance'] for c in cond_out),
        'cursor': any(c['has_cursor'] for c in cond_out),
    }

    for i, c in enumerate(cond_out):
        if not c['recorded']:
            c['status'] = 'not recorded'
            c['verdict'] = None
            continue
        told: set[str] = set()   # one "missing" reason per analysis per condition
        for rule in rules:
            m = METRICS[rule['metric']]
            if m['kind'] == 'change' and i == ref_i:
                continue
            if m['kind'] == 'value':
                value = c['values'].get(rule['metric'])
            else:
                value = c['changes'].get(rule['metric'])
            check = {'metric': rule['metric'], 'value': value, 'level': None, 'text': ''}
            if value is None and rule['metric'] == 'rs_drift_pct' and c['has_resistance']:
                continue   # one averaged result: no drift to judge, not "missing"
            if value is None:
                # Missing only matters when the cell has this kind of
                # measurement somewhere (or the rule is required);
                # otherwise it doesn't apply (e.g. Vm on a VC cell).
                needed = cell_has[m['source']] or rule.get('required', False)
                if not needed:
                    continue
                if missing_level:
                    tool = 'Resistance' if m['source'] == 'resistance' else 'Cursor'
                    has_here = c['has_resistance'] if m['source'] == 'resistance' else c['has_cursor']
                    check['level'] = missing_level
                    check['missing'] = True
                    # Report each absent analysis once; a change that can't be
                    # worked out because the reference lacks it says so.
                    key = m['source'] if not has_here else f"ref:{m['source']}"
                    if key not in told:
                        told.add(key)
                        if not has_here:
                            check['text'] = (f"no {tool} result — run {tool} on the series tagged "
                                             f"{' or '.join(repr(t) for t in c['tags'])}")
                        else:
                            check['text'] = f"{m['label']}: can't compare — the reference has no {tool} result"
                c['checks'].append(check)
                continue
            judged = abs(value) if m['kind'] == 'change' else value
            level = 'pass'
            for lv in ('fail', 'warn'):
                cond = rule.get(lv)
                if cond and _num(cond.get('value')) is not None and _compare(judged, cond.get('op', '>'), float(cond['value'])):
                    level = lv
                    check['text'] = rule_text(rule, lv)
                    break
            check['level'] = level
            c['checks'].append(check)
        c['status'] = 'judged'
        c['verdict'] = _worst(ch['level'] for ch in c['checks']) or 'pass'

    # Overrides (by file name, so the folder can move).
    ov = (config.get('overrides') or {}).get(file_name) or {}
    for c in cond_out:
        o = (ov.get('conditions') or {}).get(c['name'])
        if o and o.get('verdict') in _RANK and c['recorded']:
            c['auto_verdict'] = c['verdict']
            c['verdict'] = o['verdict']
            c['override'] = o

    auto_cell = _worst(c['verdict'] for c in cond_out) if matched else None
    cell_verdict = auto_cell
    cell_override = ov.get('cell') if isinstance(ov.get('cell'), dict) else None
    if matched and cell_override and cell_override.get('verdict') in _RANK:
        cell_verdict = cell_override['verdict']

    reasons: list[str] = []
    for c in cond_out:
        if c.get('override'):
            reasons.append(f"{c['name']}: set to {c['verdict']} by hand — {c['override'].get('reason', '')}")
            continue
        for ch in c['checks']:
            if ch['level'] in ('warn', 'fail') and ch['text']:
                reasons.append(f"{c['name']}: {ch['text']}")
    if cell_override and cell_override.get('verdict') in _RANK and matched:
        reasons.insert(0, f"Cell set to {cell_verdict} by hand — {cell_override.get('reason', '')}")

    from analysis.cohort import notes_text
    notes: list[str] = []
    for key in sorted(((sidecar or {}).get('notes') or {}).keys(),
                      key=lambda k: [int(x) if x.isdigit() else x for x in str(k).split(':')]):
        try:
            g, s = (int(x) for x in str(key).split(':')[:2])
            where = f'G{g + 1} S{s + 1}, '
        except ValueError:
            where = ''
        notes += [where + line for line in notes_text(sidecar, key).split('\n') if line]
    return {
        'file_name': file_name,
        'matched': matched,
        'notes': notes,
        'conditions': cond_out,
        'verdict': cell_verdict,
        'auto_verdict': auto_cell,
        'override': cell_override if matched else None,
        'reasons': reasons,
    }


# ---------------------------------------------------------------------------
# Deciding whether a Cohort row is included
# ---------------------------------------------------------------------------

def row_status(cell: Optional[dict], series_key: str, row_tags: list[str], cell_rule: str) -> dict:
    """QC status of one Cohort row (one analysed series of a cell).

    - cell not judged by QC (no condition tag in the file) → ``not checked``;
    - ``exclude-cell``: the cell's verdict;
    - ``exclude-condition``: the worst verdict of the conditions that
      judge this series (by tag); a series no condition judges →
      ``not judged`` (included).
    """
    if not cell or not cell.get('matched'):
        return {'status': 'not checked', 'reason': 'No series tagged with a QC condition'}
    if cell_rule == 'exclude-cell':
        return {'status': cell.get('verdict') or 'not checked',
                'reason': '; '.join(cell.get('reasons') or [])}
    tags = {_norm_tag(t) for t in row_tags}
    hits = [c for c in cell.get('conditions') or []
            if c.get('recorded') and tags & {_norm_tag(t) for t in c.get('applies_to') or []}]
    if not hits:
        return {'status': 'not judged', 'reason': 'Series not covered by any QC condition'}
    verdict = _worst(c.get('verdict') for c in hits) or 'pass'
    reasons = [r for r in cell.get('reasons') or []
               if any(r.startswith(c['name'] + ':') for c in hits)]
    return {'status': verdict, 'reason': '; '.join(reasons)}


def included(status: str, include: str) -> bool:
    """``include``: 'all' | 'pass' | 'pass_warn'. Rows QC doesn't judge
    are always included (they're listed in the report instead)."""
    if include == 'all' or status not in _RANK:
        return True
    if include == 'pass':
        return status == 'pass'
    return status in ('pass', 'warn')


# ---------------------------------------------------------------------------
# Folder level (I/O)
# ---------------------------------------------------------------------------

def _sidecars(folder: str):
    """(recording path, sidecar) for every readable sidecar in the
    folder — the same files Cohort reads."""
    from analysis.cohort import _list_sidecars, _load_sidecar
    folder_path = Path(folder).expanduser().resolve()
    for sc_path in _list_sidecars(folder_path):
        sidecar = _load_sidecar(sc_path)
        if sidecar is not None:
            yield str(sc_path)[: -len('.tracer')], sidecar


def available_tags(folder: str) -> list[dict]:
    """Series tags that carry Resistance or Cursor results, with how many
    cells have each — the choices for a condition's tag dropdown."""
    counts: dict[str, dict[str, Any]] = {}
    for _path, sidecar in _sidecars(folder):
        measured = series_measurements(sidecar)
        seen: dict[str, set] = {}
        for key, ts in series_tags(sidecar).items():
            m = measured.get(key)
            if not m:
                continue
            for t in ts:
                s = seen.setdefault(_norm_tag(t), set())
                if 'n_resistance' in m:
                    s.add('resistance')
                if 'n_cursor' in m:
                    s.add('cursor')
                counts.setdefault(_norm_tag(t), {'tag': t, 'n_resistance': 0, 'n_cursor': 0})
        for nt, kinds in seen.items():
            if 'resistance' in kinds:
                counts[nt]['n_resistance'] += 1
            if 'cursor' in kinds:
                counts[nt]['n_cursor'] += 1
    return sorted(counts.values(), key=lambda d: d['tag'].lower())


def evaluate_folder(folder: str, config: dict) -> dict:
    cells: list[dict] = []
    unmatched: list[dict] = []
    for rec_path, sidecar in _sidecars(folder):
        name = os.path.basename(rec_path)
        cell = evaluate_cell(sidecar, config, name)
        meta = sidecar.get('meta') or {}
        cell.update({'file_path': rec_path, 'cell_id': meta.get('cell_id'),
                     'animal_id': meta.get('animal_id'), 'group_tags': list(meta.get('group_tags') or [])})
        if cell['matched']:
            cells.append(cell)
        else:
            unmatched.append({'file_name': name, 'file_path': rec_path})

    # What's missing, per condition: cells with the tagged series but
    # no result of a kind a rule needs.
    missing: list[dict] = []
    for i, c in enumerate(config.get('conditions') or []):
        no_rs = [x['file_name'] for x in cells
                 if x['conditions'][i]['recorded'] and not x['conditions'][i]['has_resistance']]
        if no_rs:
            missing.append({'condition': c.get('name') or ' / '.join(condition_tags(c)),
                            'tag': ' or '.join(condition_tags(c)), 'analysis': 'Resistance', 'files': no_rs})
        no_vm = [x['file_name'] for x in cells
                 if x['conditions'][i]['recorded'] and not x['conditions'][i]['has_cursor']
                 and any(cc['has_cursor'] for cc in x['conditions'])]
        if no_vm:
            missing.append({'condition': c.get('name') or ' / '.join(condition_tags(c)),
                            'tag': ' or '.join(condition_tags(c)), 'analysis': 'Cursor', 'files': no_vm})

    summary = {lv: sum(1 for x in cells if x['verdict'] == lv) for lv in LEVELS}
    summary['judged'] = len(cells)
    summary['not_checked'] = len(unmatched)
    return {'cells': cells, 'unmatched': unmatched, 'missing': missing, 'summary': summary}


def rules_path(folder: str) -> Path:
    return Path(folder).expanduser().resolve() / RULES_FILE


def load_config(folder: str) -> Optional[dict]:
    """The folder's ``tracer_qc.json``, or None when it has none."""
    p = rules_path(folder)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('format') != FORMAT:
        return None
    merged = default_config()
    merged.update(data)
    return merged


def save_config(folder: str, config: dict) -> None:
    """Atomic write of the folder's rules file."""
    p = rules_path(folder)
    data = {**config, 'format': FORMAT, 'version': VERSION}
    tmp = p.with_name(p.name + '.tmp')
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
    os.replace(tmp, p)
