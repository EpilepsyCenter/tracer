"""Notes on the trace reach Cohort: each cell row carries its series'
notes, the Excel cell sheet has a notes column, and the Quality report
lists every note in the recording. Run: python tests/notes_check.py → "OK"."""
import io, json, shutil, sys, tempfile, warnings
from pathlib import Path
warnings.filterwarnings('ignore')
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from analysis import cohort, cohort_export, qc  # noqa: E402
from analysis.cohort import notes_text           # noqa: E402

fail = []
side = {'notes': {'0:1': [
    {'id': 'a', 'sweep': 86, 'time': 12.3, 'text': 'pulled out\nof cell'},
    {'id': 'b', 'sweep': 2, 'time': None, 'text': 'drug on'},
    {'id': 'c', 'sweep': 3, 'time': 1.0, 'text': '   '},
]}}
got = notes_text(side, '0:1')
if got != 'sweep 87, 12.30 s: pulled out of cell\nsweep 3: drug on':
    fail.append(f'notes_text: {got!r}')
if notes_text(side, '0:0') != '' or notes_text({}, '0:1') != '':
    fail.append('notes_text on missing series')

src = ROOT / 'sample_data' / 'qc_demo'
if src.exists():
    with tempfile.TemporaryDirectory() as tmp:
        dst = Path(tmp) / 'qc'
        shutil.copytree(src, dst)
        sc = sorted(dst.glob('*.tracer'))[0]
        data = json.loads(sc.read_text())
        key = next(iter(data['analyses']['resistance']))
        data['notes'] = {key: [{'id': 'x', 'sweep': 0, 'time': 0.5, 'text': 'Rs jumped here'}]}
        sc.write_text(json.dumps(data))
        r = cohort.aggregate_folder(str(dst), 'resistance')
        cell = next((c for c in r['cells'] if c['file_name'] + '.tracer' == sc.name
                     and c['series_key'] == key), None)
        if not cell or 'Rs jumped here' not in cell.get('notes', ''):
            fail.append(f'cohort cell notes: {cell and cell.get("notes")!r}')
        others = [c for c in r['cells'] if c is not cell and c.get('notes')]
        if others:
            fail.append('notes leaked to other rows')
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(cohort_export.write_excel_cells(r)))
        ws = wb['Cells']
        hdr = [c.value for c in ws[1]]
        col = hdr.index('notes') if 'notes' in hdr else None
        vals = [row[col].value for row in ws.iter_rows(min_row=2)] if col is not None else []
        if not any(v and 'Rs jumped here' in v for v in vals):
            fail.append('Excel notes column')
        cfg = qc.load_config(str(dst)) if hasattr(qc, 'load_config') else None
        if not cfg:
            fail.append('qc_demo has no QC config')
        else:
            ev = qc.evaluate_cell(data, cfg, sc.name[:-len('.tracer')])
            if not any('Rs jumped here' in t for t in ev.get('notes', [])):
                fail.append(f'QC notes: {ev.get("notes")!r}')

print('\n'.join(fail) if fail else 'OK')
sys.exit(1 if fail else 0)
