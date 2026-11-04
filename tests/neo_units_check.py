"""Neo-read formats (WinWCP, Axograph, Spike2…): currents come out in pA
and voltages in mV with the values converted, every channel of a
multi-channel signal is its own trace, and unnamed signals get a label.
Run: python tests/neo_units_check.py → "OK"."""
import sys, warnings
from pathlib import Path
import numpy as np
warnings.filterwarnings('ignore')
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import neo                                              # noqa: E402
import quantities as pq                                 # noqa: E402
from readers.models import Recording                    # noqa: E402
from readers.neo_reader import _block_to_recording      # noqa: E402

fail = []
n = 100
block = neo.Block(name='cell 1')
for s in range(2):
    seg = neo.Segment()
    # Two channels in one signal, in nA, named per channel.
    two = np.column_stack([np.full(n, 1.5 + s), np.full(n, -0.25)])
    seg.analogsignals.append(neo.AnalogSignal(
        two, units='nA', sampling_rate=10 * pq.kHz, name='Im',
        array_annotations={'channel_names': np.array(['Im0', 'Im1'])}))
    # Volts → mV; unnamed.
    seg.analogsignals.append(neo.AnalogSignal(np.full((n, 1), -0.07), units='V',
                                              sampling_rate=10 * pq.kHz))
    # Microvolts → mV; amperes → pA; a non-electrical unit stays as is.
    seg.analogsignals.append(neo.AnalogSignal(np.full(n, 250.0), units='uV',
                                              sampling_rate=10 * pq.kHz, name='field'))
    seg.analogsignals.append(neo.AnalogSignal(np.full(n, 2e-12), units='A',
                                              sampling_rate=10 * pq.kHz, name='I'))
    seg.analogsignals.append(neo.AnalogSignal(np.full(n, 3.0), units='dimensionless',
                                              sampling_rate=10 * pq.kHz, name='aux'))
    block.segments.append(seg)

rec = _block_to_recording(block, Recording(file_path='x', file_name='x', format='Test'))
ser = rec.groups[0].series_list[0]
if ser.sweep_count != 2:
    fail.append(f'sweeps {ser.sweep_count}')
tr = ser.sweeps[1].traces
want = [('Im0', 'pA', 2500.0), ('Im1', 'pA', -250.0), ('Signal 3', 'mV', -70.0),
        ('field', 'mV', 0.25), ('I', 'pA', 2.0), ('aux', 'dimensionless', 3.0)]
got = [(t.label, t.units, round(float(t.data[0]), 9)) for t in tr]
if got != want:
    fail.append(f'traces\n  got  {got}\n  want {want}')
if any(len(t.data) != n for t in tr):
    fail.append(f'lengths {[len(t.data) for t in tr]} (channels interleaved?)')

print('\n'.join(fail) if fail else 'OK')
sys.exit(1 if fail else 0)
