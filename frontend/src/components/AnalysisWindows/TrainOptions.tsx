import React from 'react'
import { useAppStore, TrainModule } from '../../stores/appStore'
import type { TrainParams } from '../../utils/trains'
import { NumInput } from '../common/NumInput'

/** Per-module starting values for the train sidepanel. Picked from
 *  the discussion in the train-detection plan: epileptiform bursts
 *  cluster on a much longer timescale (gap metric, ~hundreds of ms)
 *  than synaptic events or APs (peak-to-peak, tens of ms). */
const DEFAULTS: Record<TrainModule, TrainParams> = {
  bursts: {
    metric: 'gap',
    maxIeiMs: 500,
    minCount: 2,
    minDurationMs: 0,
    minInterTrainMs: 0,
  },
  events: {
    metric: 'peak_to_peak',
    maxIeiMs: 50,
    minCount: 3,
    minDurationMs: 0,
    minInterTrainMs: 0,
  },
  ap: {
    metric: 'peak_to_peak',
    maxIeiMs: 20,
    minCount: 3,
    minDurationMs: 0,
    minInterTrainMs: 0,
  },
}

/** Lazy enable flag: stored as a sibling key on the params object so
 *  the existing ``TrainParams`` type stays purely about the algorithm.
 *  Persisted alongside the params. */
type StoredTrainParams = TrainParams & { enabled?: boolean }

export function defaultTrainParamsFor(module: TrainModule): StoredTrainParams {
  return { ...DEFAULTS[module], enabled: false }
}

export interface TrainOptionsProps {
  module: TrainModule
  group: number
  series: number
  /** Optional hint when the host module's own merge / refractory
   *  threshold makes a smaller ``maxIeiMs`` meaningless (any pair of
   *  events that close together would already have been merged or
   *  rejected upstream). Shown as an inline warning. */
  hostMergeFloorMs?: number
}

const ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  fontSize: 'var(--font-size-label)', gap: 6,
}

const LABEL: React.CSSProperties = { color: 'var(--text-muted)' }

/** Shared sidepanel section for the train-grouping params, embedded
 *  by the Burst / Event / AP analysis windows. Reads + writes the
 *  per-module slot in ``trainParams`` keyed by ``${group}:${series}``.
 *  When the enable checkbox is off, body inputs are dimmed but kept
 *  visible so the user sees what they'd be turning on. */
export function TrainOptions({ module, group, series, hostMergeFloorMs }: TrainOptionsProps) {
  const trainParams = useAppStore((s) => s.trainParams)
  const setTrainParams = useAppStore((s) => s.setTrainParams)
  const key = `${group}:${series}`
  const stored = (trainParams[module]?.[key] as StoredTrainParams | undefined)
  const params: StoredTrainParams = stored ?? defaultTrainParamsFor(module)

  const update = (patch: Partial<StoredTrainParams>) => {
    setTrainParams(module, group, series, { ...params, ...patch })
  }

  const enabled = params.enabled === true
  const belowFloor = hostMergeFloorMs != null && params.maxIeiMs <= hostMergeFloorMs

  return (
    <div className="section-card">
      <label style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-label)',
      }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span style={{ fontWeight: 600 }}>Group into trains</span>
      </label>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        opacity: enabled ? 1 : 0.5,
        pointerEvents: enabled ? 'auto' : 'none',
      }}>
        <label style={ROW}>
          <span style={LABEL}>Metric</span>
          <select
            value={params.metric}
            onChange={(e) => update({ metric: e.target.value as TrainParams['metric'] })}
          >
            <option value="gap">Gap (end → start)</option>
            <option value="peak_to_peak">Peak-to-peak</option>
          </select>
        </label>

        <label style={ROW}>
          <span style={LABEL}>Max IEI (ms)</span>
          <NumInput
            value={params.maxIeiMs}
            min={0}
            onChange={(v) => update({ maxIeiMs: v })}
            style={{ width: 80 }}
          />
        </label>

        <label style={ROW}>
          <span style={LABEL}>Min events / train</span>
          <NumInput
            value={params.minCount}
            min={2}
            step={1}
            onChange={(v) => update({ minCount: Math.max(2, Math.round(v)) })}
            style={{ width: 80 }}
          />
        </label>

        <label style={ROW}>
          <span style={LABEL}>Min duration (ms)</span>
          <NumInput
            value={params.minDurationMs ?? 0}
            min={0}
            onChange={(v) => update({ minDurationMs: Math.max(0, v) })}
            style={{ width: 80 }}
            title="Drop trains shorter than this. 0 = no floor."
          />
        </label>

        <label style={ROW}>
          <span style={LABEL}>Min silence (ms)</span>
          <NumInput
            value={params.minInterTrainMs ?? 0}
            min={0}
            onChange={(v) => update({ minInterTrainMs: Math.max(0, v) })}
            style={{ width: 80 }}
            title="Merge two trains separated by less than this gap. 0 = no merge."
          />
        </label>

        {belowFloor && (
          <div className="notice notice-warning" style={{
            fontSize: 'var(--font-size-xs)',
            lineHeight: 1.3,
          }}>
            ⚠ Max IEI ≤ this module's merge threshold ({hostMergeFloorMs} ms);
            adjacent events that close are already combined upstream and won't
            cluster into a train.
          </div>
        )}
      </div>

      <div style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)',
        lineHeight: 1.3,
      }}>
        Trains are derived from your detection results — only these parameters
        are saved in the recording sidecar.
      </div>
    </div>
  )
}
