// Node runner for frontend/src/utils/sidecarMerge.ts (Node >= 22.6, native
// TS type stripping). Prints "OK" or the failures; sidecar_merge_check.py
// runs it.
import { mergeSidecarSlots, SIDECAR_SLOTS } from '../frontend/src/utils/sidecarMerge.ts'

const fails = []
const check = (name, ok) => { if (!ok) fails.push(name) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// On disk: results the Field Potential window saved, plus a field this
// version doesn't know.
const disk = {
  format: 'tracer-sidecar', version: 3, app_version: '1.3.1', saved_at: 'old',
  recording_name: 'slice01.nwb', meta: { series_tags: { '0:0': ['io'] } },
  analyses: { fpsp_curves: { '0:0:io': { points: [1, 2, 3] } }, ap: { '0:0': { n: 1 } }, spectral: { a: 1 } },
  forms: { resistance: { vStep: -10 }, paired: { preMode: 'ap' } },
  cursors: { baselineStart: 0, baselineEnd: 0.01 },
  future_field: { keep: true },
}
// The main window's copy: behind (no field results) but with a cursor move.
const main = {
  format: 'tracer-sidecar', version: 4, app_version: '1.4.0', recording_name: 'slice01.nwb',
  meta: { series_tags: {} },
  analyses: { fpsp_curves: {}, ap: {}, spectral: undefined },
  forms: { resistance: { vStep: -5 }, paired: { preMode: 'ttl' } },
  cursors: { baselineStart: 0, baselineEnd: 0.02 },
}

let m = mergeSidecarSlots(disk, main, ['cursors'])
check('own edit written', eq(m.cursors, main.cursors))
check('results it did not produce are kept', eq(m.analyses.fpsp_curves, disk.analyses.fpsp_curves) && eq(m.analyses.ap, disk.analyses.ap))
check('forms kept', eq(m.forms, disk.forms))
check('meta kept', eq(m.meta, disk.meta))
check('unknown fields kept', eq(m.future_field, disk.future_field))
check('version stamped from the writer', m.version === 4 && m.app_version === '1.4.0')
check('saved_at left to the main process', !('saved_at' in m))
check('disk object not modified', disk.cursors.baselineEnd === 0.01 && 'saved_at' in disk)

m = mergeSidecarSlots(disk, main, ['fpsp', 'spectral', 'resistanceForm'])
check('slot replaced when it is the writer\'s', eq(m.analyses.fpsp_curves, {}))
check('absent slot removed', !('spectral' in m.analyses))
check('one form replaced, the other kept', m.forms.resistance.vStep === -5 && m.forms.paired.preMode === 'ap')
check('other analyses kept', eq(m.analyses.ap, disk.analyses.ap))

m = mergeSidecarSlots({ format: 'tracer-sidecar' }, main, ['ap'])
check('old file without analyses/forms', eq(m.analyses, { ap: {} }) && eq(m.forms, {}))

// Every slot points at a top-level field or one level down, as the store
// writes them.
for (const [slot, path] of Object.entries(SIDECAR_SLOTS)) {
  check(`slot ${slot} path`, path.length === 1 || (path.length === 2 && ['analyses', 'forms'].includes(path[0])))
}

console.log(fails.length ? 'FAIL\n  ' + fails.join('\n  ') : 'OK')
