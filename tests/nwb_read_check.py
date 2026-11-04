"""NWB reader: sweeps, series, groups, units and values come out right for
the main ways NWB stores patch-clamp and extracellular data. Builds its
own small files; also checks the public DANDI files in
sample_data/nwb_public when present. Run: python tests/nwb_read_check.py → "OK"."""
import sys, tempfile, warnings
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
warnings.filterwarnings('ignore')
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from pynwb import NWBFile, NWBHDF5IO                                   # noqa: E402
from pynwb.icephys import (CurrentClampSeries, CurrentClampStimulusSeries,  # noqa: E402
                           VoltageClampSeries, VoltageClampStimulusSeries)
from pynwb.ecephys import ElectricalSeries, LFP                       # noqa: E402
from readers.nwb_reader import NwbReader                              # noqa: E402

fail = []
SR = 10000.0
T0 = datetime(2026, 1, 2, 10, 0, tzinfo=timezone.utc)


def new_file():
    return NWBFile(session_description='t', identifier='t', session_start_time=T0)


def step(i, n=2000):
    t = np.arange(n) / SR
    return np.where((t >= 0.05) & (t < 0.15), (i - 1) * 20e-12, 0.0)


def write(nwb, path):
    with NWBHDF5IO(str(path), 'w') as io:
        io.write(nwb)
    return NwbReader().read(str(path))


def check(cond, msg):
    if not cond:
        fail.append(msg)


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)

    # 1. Icephys tables: two protocol runs (3 CC sweeps, 2 VC sweeps).
    f = new_file()
    dev = f.create_device(name='amp')
    el = f.create_icephys_electrode(name='E1', description='pipette', device=dev)
    sims = {'IV': [], 'Seal': []}
    for i in range(3):
        stim = CurrentClampStimulusSeries(name=f'cs{i}', data=step(i), electrode=el, rate=SR, gain=1.)
        resp = CurrentClampSeries(name=f'cr{i}', data=-0.070 + step(i) * 1e8, electrode=el, rate=SR,
                                  gain=1., starting_time=float(i), stimulus_description='IV')
        r = f.add_intracellular_recording(electrode=el, stimulus=stim, response=resp)
        sims['IV'].append(f.add_icephys_simultaneous_recording(recordings=[r]))
    for i in range(2):
        vstim = VoltageClampStimulusSeries(name=f'vs{i}', data=np.full(1000, -0.07), electrode=el,
                                           rate=SR, gain=1.)
        # int16 data with a conversion factor, as many converters write it
        vresp = VoltageClampSeries(name=f'vr{i}', data=np.arange(1000, dtype=np.int16), electrode=el,
                                   rate=SR, gain=1., conversion=1e-12, starting_time=10. + i,
                                   whole_cell_series_resistance_comp=12e6,
                                   whole_cell_capacitance_comp=25e-12)
        r = f.add_intracellular_recording(electrode=el, stimulus=vstim, response=vresp)
        sims['Seal'].append(f.add_icephys_simultaneous_recording(recordings=[r]))
    for name, ids in sims.items():
        f.add_icephys_sequential_recording(simultaneous_recordings=ids, stimulus_type=name)
    rec = write(f, tmp / 'tables.nwb')
    check(rec.format == 'NWB' and len(rec.groups) == 1, 'tables: one group')
    ss = rec.groups[0].series_list
    check([s.label for s in ss] == ['IV', 'Seal'], f'tables: series {[s.label for s in ss]}')
    check([s.sweep_count for s in ss] == [3, 2], 'tables: sweep counts')
    tr = ss[0].sweeps[2].traces
    check([t.label for t in tr] == ['Vm', 'Stimulus'] and [t.units for t in tr] == ['mV', 'pA'],
          f'tables: CC channels {[(t.label, t.units) for t in tr]}')
    check(abs(tr[0].data[0] + 70) < 1e-9 and abs(tr[1].data.max() - 20) < 1e-6,
          'tables: CC values in mV / pA')
    st = ss[0].stimulus
    check(st is not None and st.unit == 'pA' and abs(st.v_hold) < 1e-9
          and abs(st.pulse_start - 0.05) < 1e-3 and abs(st.pulse_end - 0.15) < 1e-3,
          f'tables: stimulus info {st}')
    vt = ss[1].sweeps[1].traces
    check(vt[0].label == 'Im' and vt[0].units == 'pA' and abs(vt[0].data[999] - 999) < 1e-6,
          'tables: int16 data × conversion → pA')
    check([s.kind for s in ss] == ['cc', 'vc'], f'tables: kinds {[s.kind for s in ss]}')
    check(abs(ss[1].rs - 12) < 1e-9 and abs(ss[1].cm - 25) < 1e-9, 'tables: Rs / Cm')
    check(abs(ss[1].timestamp - (T0.timestamp() + 10)) < 1e-6, 'tables: series timestamp')

    # 2. Old style: no tables, sweep numbers, two protocols, two electrodes.
    f = new_file()
    dev = f.create_device(name='amp')
    e1 = f.create_icephys_electrode(name='A', description='', device=dev)
    e2 = f.create_icephys_electrode(name='B', description='', device=dev)
    for i in range(4):
        proto = 'steps' if i < 3 else 'ramp'
        for el in (e1, e2):
            f.add_stimulus(CurrentClampStimulusSeries(
                name=f's{i}{el.name}', data=step(i), electrode=el, rate=SR, gain=1., sweep_number=i))
            f.add_acquisition(CurrentClampSeries(
                name=f'r{i}{el.name}', data=np.full(2000, -0.06), electrode=el, rate=SR, gain=1.,
                sweep_number=i, starting_time=float(i), stimulus_description=proto))
    rec = write(f, tmp / 'legacy.nwb')
    ss = rec.groups[0].series_list if rec.groups else []
    check(len(rec.groups) == 1 and rec.groups[0].label == 'A + B', 'legacy: one dual group')
    check([(s.label, s.sweep_count) for s in ss] == [('steps', 3), ('ramp', 1)],
          f'legacy: series {[(s.label, s.sweep_count) for s in ss]}')
    labels = [t.label for t in ss[0].sweeps[0].traces] if ss else []
    check(labels == ['Vm A', 'Vm B', 'Stim A', 'Stim B'], f'legacy: channels {labels}')

    # 3. Extracellular: raw acquisition with per-channel conversion + LFP in processing.
    f = new_file()
    dev = f.create_device(name='probe')
    eg = f.create_electrode_group(name='shank', description='', location='CA1', device=dev)
    f.add_electrode_column(name='label', description='')
    for c in range(3):
        f.add_electrode(group=eg, location='CA1', label=f'ch{c}')
    region = f.create_electrode_table_region(region=[0, 1, 2], description='all')
    raw = np.tile(np.arange(5000, dtype=np.int16)[:, None], (1, 3))
    f.add_acquisition(ElectricalSeries(name='raw', data=raw, electrodes=region, rate=20000.,
                                       conversion=1e-6, channel_conversion=[1., 2., 3.]))
    mod = f.create_processing_module(name='ecephys', description='')
    mod.add(LFP(electrical_series=ElectricalSeries(
        name='lfp', data=np.ones((100, 3)) * 1e-4, electrodes=region, rate=1000.)))
    rec = write(f, tmp / 'ecephys.nwb')
    ss = rec.groups[0].series_list if rec.groups else []
    check(len(rec.groups) == 1 and rec.groups[0].label == 'Extracellular', 'ecephys: group')
    check(all(s.kind == 'field' for s in ss), 'ecephys: kind field')
    check([s.label for s in ss] == ['raw', 'lfp'], f'ecephys: series {[s.label for s in ss]}')
    if len(ss) == 2:
        tr = ss[0].sweeps[0].traces
        check([t.label for t in tr] == ['ch0', 'ch1', 'ch2'], 'ecephys: electrode labels')
        # 4999 counts × 1 µV × channel factor 3 → 14.997 mV
        check(abs(tr[2].data[-1] - 4999e-3 * 3) < 1e-9 and tr[2].units == 'mV',
              f'ecephys: conversion × channel_conversion ({tr[2].data[-1]})')
        check(abs(ss[1].sweeps[0].traces[0].data[0] - 0.1) < 1e-12, 'ecephys: LFP 1e-4 V → 0.1 mV')

    # 4. Nothing TRACER can show → clear error.
    try:
        write(new_file(), tmp / 'empty.nwb')
        fail.append('empty: no error')
    except ValueError as e:
        check('No patch-clamp' in str(e), f'empty: message {e}')

# Public DANDI files: (groups, series in group 1, sweeps in series 1, channels).
PUBLIC = {
    'icephys_000025_BBP_tables.nwb': (1, 44, 1, 2),
    'icephys_000245_spinal.nwb': (1, 2, 16, 4),
    'icephys_000020_Allen_MIES.nwb': (1, 12, 1, 2),
    'icephys_000292_UHN_mouse.nwb': (1, 1, 11, 2),
    'icephys_001544_pallidal.nwb': (1, 11, 1, 2),
    'ecephys_001044_rat_ictal_LFP.nwb': (1, 1, 1, 12),
    'ecephys_001054_NHP_seizure_stim.nwb': (1, 1, 1, 8),
    'ecephys_001333_LFP_small.nwb': (1, 1, 1, 1),
}
pub = ROOT / 'sample_data' / 'nwb_public'
for name, want in PUBLIC.items():
    p = pub / name
    if not p.exists():
        continue
    try:
        r = NwbReader().read(str(p))
        s = r.groups[0].series_list[0]
        got = (len(r.groups), len(r.groups[0].series_list), s.sweep_count, len(s.sweeps[0].traces))
        check(got == want, f'{name}: {got} != {want}')
    except Exception as e:
        fail.append(f'{name}: {type(e).__name__} {e}')

print('\n'.join(fail) if fail else 'OK')
sys.exit(1 if fail else 0)
