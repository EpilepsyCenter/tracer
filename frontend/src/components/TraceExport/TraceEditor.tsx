import React from 'react'
import {
  TraceItem, OKABE_ITO,
  seriesCfgKey, useTraceExportStore,
} from '../../stores/traceExportStore'

interface Props {
  item: TraceItem
}

const DASH_PRESETS = [
  { label: 'solid', value: '' },
  { label: 'dashed', value: '6,4' },
  { label: 'dotted', value: '2,3' },
  { label: 'dash-dot', value: '6,3,2,3' },
]

/**
 * Right-pane editor for the selected trace.
 *
 * Per CLAUDE.md and the design doc: filter / baseline / blanking are
 * keyed per (file, group, series). Editing them here notifies the
 * user that the change applies to every trace from the same series.
 */
export function TraceEditor({ item }: Props) {
  const updateItem = useTraceExportStore((s) => s.updateItem)
  const cfgKey = seriesCfgKey(item.file_path, item.group, item.series)
  const seriesCfg = useTraceExportStore((s) => s.seriesCfgs[cfgKey])
  const updateSeriesCfg = useTraceExportStore((s) => s.updateSeriesCfg)
  const items = useTraceExportStore((s) => s.items)
  const axes = useTraceExportStore((s) => s.axes)

  const sharedItems = items.filter(
    (i) => i.file_path === item.file_path && i.group === item.group && i.series === item.series,
  )
  const shareCount = sharedItems.length

  return (
    <div style={{
      padding: 10,
      fontSize: 'var(--font-size-sm)',
      fontFamily: 'var(--font-ui)',
      display: 'flex', flexDirection: 'column', gap: 10,
      overflow: 'auto',
      // Match the side-panel background used by other analysis
      // windows (CursorAnalysisWindow, CohortWindow, etc.) so the
      // editor rail visually reads as a chrome surface, not main
      // content.
      background: 'var(--bg-secondary)',
    }}>
      {/* Source */}
      <Section title="Source">
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
          {item.file_name}<br />
          group {item.group} · series {item.series} · channel {item.trace}
          <br />sweeps: {item.sweeps.map((s) => s + 1).join(', ')}
        </div>
      </Section>

      {/* Display */}
      <Section title="Display">
        <Row label="Legend">
          <input
            value={item.display_name}
            onChange={(e) => updateItem(item.id, { display_name: e.target.value })}
            placeholder={item.label}
            style={{ flex: 1 }}
            title="Custom name shown in the legend. Leave empty to fall back to the source-path label."
          />
        </Row>
        <Row>
          <label>
            <input
              type="checkbox"
              checked={item.show_mean}
              onChange={(e) => updateItem(item.id, { show_mean: e.target.checked })}
            /> Mean
          </label>
          <label>
            <input
              type="checkbox"
              checked={item.show_individuals}
              onChange={(e) => updateItem(item.id, { show_individuals: e.target.checked })}
            /> Individuals
          </label>
        </Row>
        <Row label="Axis">
          <select value={item.axis_id} onChange={(e) => updateItem(item.id, { axis_id: e.target.value })}>
            {axes.map((a) => (
              <option key={a.id} value={a.id}>{a.label || a.id}{a.unit ? ` (${a.unit})` : ''}</option>
            ))}
          </select>
        </Row>
      </Section>

      {/* Style — split into "Individuals" and "Mean" so the user can
          pick distinct colors/weights for the two layers when both
          are drawn. The mean controls only show when there's actually
          a mean overlay (≥2 sweeps with show_mean on); single-sweep
          "single" lines render with the individuals style and don't
          need the second knob set. */}
      <Section title="Style — individuals">
        {item.show_mean && item.sweeps.length > 1 && (
          <Row>
            <button
              className="btn"
              onClick={() => updateItem(item.id, {
                style: {
                  ...item.style,
                  color: item.style.mean_color,
                  weight: item.style.mean_weight,
                  dash: item.style.mean_dash,
                  alpha: item.style.mean_alpha,
                },
              })}
              title="Copy the mean overlay style onto the individuals"
            >Match ← mean</button>
          </Row>
        )}
        <Row label="Color">
          <input
            type="color"
            value={item.style.color}
            onChange={(e) => updateItem(item.id, { style: { ...item.style, color: e.target.value } })}
          />
          <span style={{ display: 'inline-flex', gap: 2, marginLeft: 6 }}>
            {OKABE_ITO.map((c) => (
              <button
                key={c}
                onClick={() => updateItem(item.id, { style: { ...item.style, color: c } })}
                title={c}
                style={{
                  width: 14, height: 14, borderRadius: 2,
                  border: '1px solid var(--border)',
                  background: c, padding: 0,
                }}
              />
            ))}
          </span>
        </Row>
        <Row label="Weight">
          <NumField
            value={item.style.weight}
            min={0.5} max={6} step={0.25}
            onChange={(v) => updateItem(item.id, { style: { ...item.style, weight: v } })}
          />
        </Row>
        <Row label="Dash">
          <select
            value={item.style.dash}
            onChange={(e) => updateItem(item.id, { style: { ...item.style, dash: e.target.value } })}
          >
            {DASH_PRESETS.map((p) => <option key={p.label} value={p.value}>{p.label}</option>)}
          </select>
        </Row>
        <Row label="Alpha">
          <NumField
            value={item.style.alpha}
            min={0} max={1} step={0.05}
            onChange={(v) => updateItem(item.id, { style: { ...item.style, alpha: v } })}
          />
        </Row>
        {item.show_individuals && item.show_mean && (
          <Row label="Indiv. α">
            <NumField
              value={item.style.individuals_alpha}
              min={0} max={1} step={0.05}
              onChange={(v) => updateItem(item.id, { style: { ...item.style, individuals_alpha: v } })}
            />
          </Row>
        )}
      </Section>

      {item.show_mean && item.sweeps.length > 1 && (
        <Section title="Style — mean overlay">
          <Row>
            <button
              className="btn"
              onClick={() => updateItem(item.id, {
                style: {
                  ...item.style,
                  mean_color: item.style.color,
                  mean_weight: item.style.weight,
                  mean_dash: item.style.dash,
                  mean_alpha: item.style.alpha,
                },
              })}
              title="Copy the individuals style onto the mean overlay"
            >Match ← individuals</button>
          </Row>
          <Row label="Color">
            <input
              type="color"
              value={item.style.mean_color}
              onChange={(e) => updateItem(item.id, { style: { ...item.style, mean_color: e.target.value } })}
            />
            <span style={{ display: 'inline-flex', gap: 2, marginLeft: 6 }}>
              {OKABE_ITO.map((c) => (
                <button
                  key={c}
                  onClick={() => updateItem(item.id, { style: { ...item.style, mean_color: c } })}
                  title={c}
                  style={{
                    width: 14, height: 14, borderRadius: 2,
                    border: '1px solid var(--border)',
                    background: c, padding: 0,
                  }}
                />
              ))}
            </span>
          </Row>
          <Row label="Weight">
            <NumField
              value={item.style.mean_weight}
              min={0.5} max={6} step={0.25}
              onChange={(v) => updateItem(item.id, { style: { ...item.style, mean_weight: v } })}
            />
          </Row>
          <Row label="Dash">
            <select
              value={item.style.mean_dash}
              onChange={(e) => updateItem(item.id, { style: { ...item.style, mean_dash: e.target.value } })}
            >
              {DASH_PRESETS.map((p) => <option key={p.label} value={p.value}>{p.label}</option>)}
            </select>
          </Row>
          <Row label="Alpha">
            <NumField
              value={item.style.mean_alpha}
              min={0} max={1} step={0.05}
              onChange={(v) => updateItem(item.id, { style: { ...item.style, mean_alpha: v } })}
            />
          </Row>
        </Section>
      )}

      {/* Position */}
      <Section title="Position">
        <Row label="X offset (s)">
          <NumField
            value={item.x_offset}
            step={0.001}
            onChange={(v) => updateItem(item.id, { x_offset: v })}
          />
        </Row>
        <Row label="Y offset">
          <NumField
            value={item.y_offset}
            step={1}
            onChange={(v) => updateItem(item.id, { y_offset: v })}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
            drag the trace in the preview to set
          </span>
        </Row>
        <Row>
          <label>
            <input
              type="checkbox"
              checked={!!item.x_range}
              onChange={(e) => updateItem(item.id, {
                x_range: e.target.checked ? [0, 1] : null,
              })}
            /> Window source range
          </label>
        </Row>
        {item.x_range && (
          <Row>
            <span>from</span>
            <NumField
              value={item.x_range[0]}
              step={0.001}
              onChange={(v) => updateItem(item.id, {
                x_range: [v, item.x_range![1]],
              })}
            />
            <span>to</span>
            <NumField
              value={item.x_range[1]}
              step={0.001}
              onChange={(v) => updateItem(item.id, {
                x_range: [item.x_range![0], v],
              })}
            />
            <span style={{ color: 'var(--text-muted)' }}>s</span>
          </Row>
        )}
      </Section>

      {/* Series-level processing */}
      <Section title={`Filter / baseline / blanking ${shareCount > 1 ? `(applies to ${shareCount} traces)` : ''}`}>
        {shareCount > 1 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', marginBottom: 4 }}>
            Settings are keyed per series — every trace from <code>{item.file_name}</code> g{item.group}:s{item.series} shares them.
          </div>
        )}
        {/* Filter */}
        <SubBlock title="Filter">
          <Row>
            <label>
              <input
                type="checkbox"
                checked={!!seriesCfg?.filter.enabled}
                onChange={(e) => updateSeriesCfg(cfgKey, {
                  filter: { ...(seriesCfg?.filter ?? { type: 'lowpass', low_hz: 0, high_hz: 1000, order: 4 }), enabled: e.target.checked, type: seriesCfg?.filter.type ?? 'lowpass', low_hz: seriesCfg?.filter.low_hz ?? 0, high_hz: seriesCfg?.filter.high_hz ?? 1000, order: seriesCfg?.filter.order ?? 4 },
                })}
              /> Enabled
            </label>
          </Row>
          {seriesCfg?.filter.enabled && (
            <>
              <Row label="Type">
                <select
                  value={seriesCfg.filter.type}
                  onChange={(e) => updateSeriesCfg(cfgKey, { filter: { ...seriesCfg.filter, type: e.target.value as any } })}
                >
                  <option value="lowpass">lowpass</option>
                  <option value="highpass">highpass</option>
                  <option value="bandpass">bandpass</option>
                </select>
              </Row>
              {seriesCfg.filter.type !== 'lowpass' && (
                <Row label="Low Hz">
                  <NumField
                    value={seriesCfg.filter.low_hz}
                    onChange={(v) => updateSeriesCfg(cfgKey, { filter: { ...seriesCfg.filter, low_hz: v } })}
                  />
                </Row>
              )}
              {seriesCfg.filter.type !== 'highpass' && (
                <Row label="High Hz">
                  <NumField
                    value={seriesCfg.filter.high_hz}
                    onChange={(v) => updateSeriesCfg(cfgKey, { filter: { ...seriesCfg.filter, high_hz: v } })}
                  />
                </Row>
              )}
              <Row label="Order">
                <NumField
                  value={seriesCfg.filter.order}
                  step={1}
                  onChange={(v) => updateSeriesCfg(cfgKey, { filter: { ...seriesCfg.filter, order: Math.max(1, Math.round(v)) } })}
                />
              </Row>
            </>
          )}
        </SubBlock>

        {/* Baseline */}
        <SubBlock title="Baseline subtract">
          <Row>
            <label>
              <input
                type="checkbox"
                checked={!!seriesCfg?.baseline.enabled}
                onChange={(e) => updateSeriesCfg(cfgKey, {
                  baseline: { ...(seriesCfg?.baseline ?? { t0: 0, t1: 0.05 }), enabled: e.target.checked, t0: seriesCfg?.baseline.t0 ?? 0, t1: seriesCfg?.baseline.t1 ?? 0.05 },
                })}
              /> Enabled
            </label>
          </Row>
          {seriesCfg?.baseline.enabled && (
            <Row>
              <span>from</span>
              <NumField value={seriesCfg.baseline.t0} step={0.001}
                onChange={(v) => updateSeriesCfg(cfgKey, { baseline: { ...seriesCfg.baseline, t0: v } })} />
              <span>to</span>
              <NumField value={seriesCfg.baseline.t1} step={0.001}
                onChange={(v) => updateSeriesCfg(cfgKey, { baseline: { ...seriesCfg.baseline, t1: v } })} />
              <span style={{ color: 'var(--text-muted)' }}>s</span>
            </Row>
          )}
        </SubBlock>

        {/* Blanking */}
        <SubBlock title="Stim-artifact blanking">
          <Row>
            <label>
              <input
                type="checkbox"
                checked={!!seriesCfg?.blanking.enabled}
                onChange={(e) => updateSeriesCfg(cfgKey, {
                  blanking: { ...(seriesCfg?.blanking ?? { t0: 0, t1: 0, mode: 'interp' }), enabled: e.target.checked, t0: seriesCfg?.blanking.t0 ?? 0, t1: seriesCfg?.blanking.t1 ?? 0, mode: seriesCfg?.blanking.mode ?? 'interp' },
                })}
              /> Enabled
            </label>
          </Row>
          {seriesCfg?.blanking.enabled && (
            <>
              <Row>
                <span>from</span>
                <NumField value={seriesCfg.blanking.t0} step={0.001}
                  onChange={(v) => updateSeriesCfg(cfgKey, { blanking: { ...seriesCfg.blanking, t0: v } })} />
                <span>to</span>
                <NumField value={seriesCfg.blanking.t1} step={0.001}
                  onChange={(v) => updateSeriesCfg(cfgKey, { blanking: { ...seriesCfg.blanking, t1: v } })} />
                <span style={{ color: 'var(--text-muted)' }}>s</span>
              </Row>
              <Row label="Mode">
                <select
                  value={seriesCfg.blanking.mode}
                  onChange={(e) => updateSeriesCfg(cfgKey, { blanking: { ...seriesCfg.blanking, mode: e.target.value as any } })}
                >
                  <option value="interp">Interpolate (straight line)</option>
                  <option value="hide">Hide (gap in line)</option>
                </select>
              </Row>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', paddingLeft: 8 }}>
                {seriesCfg.blanking.mode === 'interp'
                  ? 'Replaces the artifact window with a straight line bridging the values just before and after.'
                  : 'Drops the artifact window entirely — the trace shows a gap. Useful when you don\'t want to imply a continuous signal.'}
              </div>
            </>
          )}
        </SubBlock>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section-card">
      <div className="section-card-title">{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  )
}

function SubBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ paddingLeft: 8, borderLeft: '2px solid var(--border)', marginTop: 4 }}>
      <div style={{ fontStyle: 'italic', color: 'var(--text-muted)', marginBottom: 2 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>{children}</div>
    </div>
  )
}

function Row({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {label && <span style={{ minWidth: 60, color: 'var(--text-muted)' }}>{label}</span>}
      {children}
    </div>
  )
}

function NumField({ value, onChange, min, max, step }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const v = parseFloat(e.target.value)
        if (Number.isFinite(v)) onChange(v)
      }}
      min={min} max={max} step={step ?? 0.1}
      style={{ width: 80 }}
    />
  )
}
