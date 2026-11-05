"""NWB export round trip: what TRACER writes opens again with the same
series, sweeps, channels, values and times, and passes the NWB Inspector
(DANDI settings) without errors or critical issues.
Run: python tests/nwb_export_check.py → "OK"."""
import glob, sys, tempfile, warnings
from pathlib import Path
import numpy as np
warnings.filterwarnings('ignore')
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from readers.models import Recording, Group, Series, Sweep, Trace      # noqa: E402
from readers.nwb_reader import NwbReader                              # noqa: E402
from export.nwb_export import plan, write_nwb, inspect                 # noqa: E402

fail = []
META = dict(subjectId='M1', species='Mus musculus', sex='M', age=30, ageUnit='days',
            experimenter='Tester, A', lab='Lab', institution='Uni', location='Field CA1',
            sessionDescription='Round-trip test', tracerVersion='test')


def check(cond, msg):
    if not cond:
        fail.append(msg)


def same(a, b, rel=1e-6):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    return a.shape == b.shape and np.max(np.abs(a - b)) <= rel * (np.max(np.abs(a)) + 1e-30)


def written(rec, kinds):
    """Series that should come back, in order: (series, kind)."""
    out = []
    for g in rec.groups:
        for s in g.series_list:
            k = kinds.get(f'{g.index}:{s.index}')
            if k in (None, 'vc', 'cc', 'field'):
                out.append(s)
    return out


def bad_messages(path):
    return [m for m in inspect(path) if m['level'] in ('error', 'critical')]


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)

    # 1. HEKA: VC test pulses and CC I-V steps, stimulus rebuilt from the .pgf.
    heka = ROOT / 'sample_data' / 'heka_test_files' / 'IV_1.dat'
    if heka.exists():
        from readers.heka_native.reader import HekaNativeReader
        r = HekaNativeReader()
        rec = r.read(str(heka))
        kinds = {f"{p['group']}:{p['series']}": p['kind'] for p in plan(rec)['series']}
        check(kinds.get('0:4') == 'cc' and kinds.get('0:0') == 'vc',
              f'HEKA guesses: {kinds}')
        out = tmp / 'heka.nwb'
        res = write_nwb(rec, str(out), META, kinds, None, r._last_pgf)
        check(res.series_written == 11 and not res.notes, f'HEKA written {res}')
        back = NwbReader().read(str(out))
        src = written(rec, kinds)
        got = [s for g in back.groups for s in g.series_list]
        check(len(got) == len(src), f'HEKA series {len(got)} != {len(src)}')
        for s0, s1 in zip(src, got):
            check(s1.sweep_count == s0.sweep_count, f'{s0.label}: sweeps')
            check(s1.kind == kinds[f'0:{s0.index}'], f'{s0.label}: kind {s1.kind}')
            check(s1.label == s0.protocol or s1.label == s0.label, f'{s0.label}: label {s1.label}')
            for w0, w1 in zip(s0.sweeps, s1.sweeps):
                check(same(w0.traces[0].data, w1.traces[0].data), f'{s0.label}: values')
                check(w1.traces[0].units == w0.traces[0].units, f'{s0.label}: units')
                check(abs((w1.time or 0) - (w0.time or 0)) < 1e-3, f'{s0.label}: sweep time')
            check(len(s1.sweeps[0].traces) == 2 and s1.sweeps[0].traces[1].label == 'Stimulus',
                  f'{s0.label}: stimulus from the protocol')
        check(not bad_messages(str(out)), f'HEKA inspector: {bad_messages(str(out))[:2]}')

        # Excluded sweeps left out; Channel Scaling applied.
        rec.groups[0].series_list[0].sweeps[0].traces[0].y_scale = 2.0
        out2 = tmp / 'heka2.nwb'
        write_nwb(rec, str(out2), META, {**kinds, '0:1': 'skip'}, {'0:0': [1, 2]}, r._last_pgf)
        b2 = NwbReader().read(str(out2))
        s0 = b2.groups[0].series_list[0]
        check(s0.sweep_count == 12, f'excluded sweeps: {s0.sweep_count}')
        check(same(s0.sweeps[0].traces[0].data, rec.groups[0].series_list[0].sweeps[0].traces[0].data * 2),
              'channel scaling not applied')
        check(len(b2.groups[0].series_list) == 10, 'skip not honoured')

    # 2. ABF.
    abfs = sorted(glob.glob(str(ROOT / 'sample_data' / 'abfs' / '*.abf')))
    if abfs:
        from readers.abf_reader import AbfReader
        rec = AbfReader().read(abfs[0])
        out = tmp / 'abf.nwb'
        write_nwb(rec, str(out), META, {}, None, None)
        back = NwbReader().read(str(out))
        s0 = rec.groups[0].series_list[0]
        s1 = back.groups[0].series_list[0]
        check(s1.sweep_count == s0.sweep_count, 'ABF sweeps')
        check(all(same(a.traces[0].data, b.traces[0].data) for a, b in zip(s0.sweeps, s1.sweeps)), 'ABF values')
        check(abs(s1.sweeps[-1].time - s0.sweeps[-1].time) < 1e-3, 'ABF sweep times')
        check(not bad_messages(str(out)), f'ABF inspector: {bad_messages(str(out))[:2]}')

    # 3. Field recording: 3 channels × 4 sweeps, one in µV.
    rng = np.random.default_rng(0)
    g = Group(index=0, label='Slice 2')
    ser = Series(index=0, label='fEPSP IO', protocol='IO', timestamp=1_700_000_000.0)
    for k in range(4):
        sw = Sweep(index=k, time=1_700_000_000.0 + 10 * k)
        sw.traces = [Trace(rng.normal(size=2000), 10000.0, 'mV', 'CA1'),
                     Trace(rng.normal(size=2000), 10000.0, 'mV', 'CA3'),
                     Trace(rng.normal(size=2000) * 1000, 10000.0, 'µV', 'DG')]
        ser.sweeps.append(sw)
    g.series_list.append(ser)
    rec = Recording(file_path=str(tmp / 'field.csv'), file_name='field.csv', format='Text', groups=[g])
    out = tmp / 'field.nwb'
    write_nwb(rec, str(out), META, {'0:0': 'field'}, None, None)
    back = NwbReader().read(str(out))
    check([(gg.label, len(gg.series_list)) for gg in back.groups] == [('Slice 2', 1)],
          f'field groups {[(gg.label, len(gg.series_list)) for gg in back.groups]}')
    s1 = back.groups[0].series_list[0] if back.groups else None
    if s1:
        check(s1.label == 'fEPSP IO' and s1.sweep_count == 4 and s1.kind == 'field', 'field series')
        tr = s1.sweeps[3].traces
        check([t.label for t in tr] == ['CA1', 'CA3', 'DG'], f'field channels {[t.label for t in tr]}')
        check(same(tr[2].data, ser.sweeps[3].traces[2].data / 1000), 'field µV → mV values')
        check(abs(s1.sweeps[3].time - (1_700_000_000.0 + 30)) < 1e-3, 'field sweep time')
    check(not bad_messages(str(out)), f'field inspector: {bad_messages(str(out))[:2]}')

    # 4. Paired patch from a public NWB file: two electrodes per sweep, recorded commands.
    pub = ROOT / 'sample_data' / 'nwb_public' / 'icephys_000245_spinal.nwb'
    if pub.exists():
        rec = NwbReader().read(str(pub))
        out = tmp / 'pair.nwb'
        write_nwb(rec, str(out), META, {}, None, None)
        back = NwbReader().read(str(out))
        a = rec.groups[0].series_list[0]
        b = back.groups[0].series_list[0] if back.groups else None
        check(b is not None and b.sweep_count == a.sweep_count
              and [t.label for t in b.sweeps[0].traces] == [t.label for t in a.sweeps[0].traces],
              f'paired: {b and [t.label for t in b.sweeps[0].traces]}')
        if b:
            check(all(same(x.data, y.data) for x, y in zip(a.sweeps[5].traces, b.sweeps[5].traces)),
                  'paired values')

# 5. Folder export helpers: what the scan includes, output names, sidecar
#    scaling, and the type guess on the sample files.
from export.nwb_export import scan_folder, output_path, apply_scale_overrides, guess_kind  # noqa: E402
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    (tmp / 'sub').mkdir()
    (tmp / 'out').mkdir()
    for name in ('a.dat', 'a.abf', 'sub/b.abf', 'c.csv', 'd.nwb', 'out/e.abf', 'notes.txt'):
        (tmp / name).write_bytes(b'x')
    (tmp / 'a.dat.tracer').write_text('{"meta": {"animal_id": "M7", "group_tags": ["WT"]}, '
                                      '"excluded_sweeps": {"0:0": [1, 2]}, "scale_overrides": {"0|mV": {}}}')
    sc = scan_folder(str(tmp), True, str(tmp / 'out'))
    rels = [f['rel'] for f in sc['files']]
    check(rels == ['a.abf', 'a.dat', 'sub/b.abf'], f'scan: {rels}')
    check(sc['skippedText'] == 2 and sc['skippedNwb'] == 1, f'scan skipped: {sc}')
    a = next(f for f in sc['files'] if f['rel'] == 'a.dat')
    check(a['animalId'] == 'M7' and a['tags'] == ['WT'] and a['excludedSweeps'] == 2 and a['scaled'],
          f'scan sidecar: {a}')
    check(len(scan_folder(str(tmp), False)['files']) == 2, 'scan without subfolders')
    taken = set()
    outs = [output_path(str(tmp / r), str(tmp), str(tmp / 'out'), taken) for r in rels]
    check(len(set(outs)) == 3 and outs[2].endswith('out/sub/b.nwb'), f'output names: {outs}')

g = Group(index=0)
ser = Series(index=0, label='x')
ser.sweeps.append(Sweep(index=0, traces=[Trace(np.ones(4), 1000.0, 'mV', 'V')]))
g.series_list.append(ser)
rec = Recording(file_path='x', file_name='x', format='T', groups=[g])
apply_scale_overrides(rec, {'0|mV': {'units': 'pA', 'y_scale': 2.0, 'y_offset': 1.0}})
tr = ser.sweeps[0].traces[0]
check((tr.units, tr.y_scale, tr.y_offset) == ('pA', 2.0, 1.0), 'sidecar scaling not applied')

# Type guess: names say VC but only mV is recorded → CC; mV command with
# only mV channels → field; a non-electrical first channel is passed over.
def series(label, units, stim=None):
    from readers.models import StimulusInfo
    s = Series(index=0, label=label)
    s.sweeps.append(Sweep(index=0, traces=[Trace(np.zeros(2), 1.0, u, u) for u in units]))
    if stim:
        s.stimulus = StimulusInfo(unit=stim, v_hold=0, v_step=1, v_step_absolute=1, pulse_start=0,
                                  pulse_end=1, baseline_start=0, baseline_end=0)
    return s
cases = [(series('ramp', ['mV']), 'cc'), (series('LTP_BASE', ['mV'], 'mV'), 'field'),
         (series('I-V (Dep)', ['mV'], 'pA'), 'cc'), (series('Test pulse', ['pA'], 'mV'), 'vc'),
         (series('gapfree', ['dB', 'mV']), 'cc'), (series('sine', ['?']), 'skip')]
for s, want in cases:
    check(guess_kind(s) == want, f'guess {s.label}: {guess_kind(s)} != {want}')

print('\n'.join(fail) if fail else 'OK')
sys.exit(1 if fail else 0)
