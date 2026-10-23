import React from 'react'
import { useTraceExportStore } from '../../stores/traceExportStore'

/**
 * "Figure" tab on the right pane — controls that apply to the whole
 * figure rather than a single trace: axis style toggle, axis manager
 * (rename, reposition, manual limits), scalebar config.
 */
export function FigurePanel() {
  const axisStyle = useTraceExportStore((s) => s.axisStyle)
  const setAxisStyle = useTraceExportStore((s) => s.setAxisStyle)
  const panelLayout = useTraceExportStore((s) => s.panelLayout)
  const setPanelLayout = useTraceExportStore((s) => s.setPanelLayout)
  const axes = useTraceExportStore((s) => s.axes)
  const updateAxis = useTraceExportStore((s) => s.updateAxis)
  const addAxis = useTraceExportStore((s) => s.addAxis)
  const removeAxis = useTraceExportStore((s) => s.removeAxis)
  const items = useTraceExportStore((s) => s.items)
  const updateItem = useTraceExportStore((s) => s.updateItem)
  const scalebar = useTraceExportStore((s) => s.scalebar)
  const setScalebar = useTraceExportStore((s) => s.setScalebar)
  const legend = useTraceExportStore((s) => s.legend)
  const setLegend = useTraceExportStore((s) => s.setLegend)

  const width_cm = useTraceExportStore((s) => s.width_cm)
  const height_cm = useTraceExportStore((s) => s.height_cm)
  const dpi = useTraceExportStore((s) => s.dpi)
  const setSize = useTraceExportStore((s) => s.setSize)
  const setDpi = useTraceExportStore((s) => s.setDpi)

  function safeRemoveAxis(id: string) {
    if (axes.length <= 1) return
    const fallback = axes.find((a) => a.id !== id)?.id
    if (!fallback) return
    items.filter((i) => i.axis_id === id).forEach((i) => updateItem(i.id, { axis_id: fallback }))
    removeAxis(id)
  }

  return (
    <div style={{
      padding: 10, display: 'flex', flexDirection: 'column', gap: 10,
      fontSize: 'var(--font-size-sm)',
      fontFamily: 'var(--font-ui)',
      background: 'var(--bg-secondary)',
    }}>
      {/* Layout */}
      <Section title="Panel layout">
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          {(['overlay', 'stacked'] as const).map((l) => (
            <button
              key={l}
              className={panelLayout === l ? 'active' : undefined}
              onClick={() => setPanelLayout(l)}
              title={l === 'overlay'
                ? 'All y-axes share one panel (twin axes).'
                : 'One panel per y-axis stacked vertically with a shared x-axis.'}
            >{l === 'overlay' ? 'Overlay' : 'Stacked'}</button>
          ))}
        </div>
        {panelLayout === 'stacked' && axes.length < 2 && (
          <div className="notice notice-info" style={{ marginTop: 4, fontSize: 'var(--font-size-xs)' }}>
            Stacked layout needs at least two y-axes. Add a second axis below
            (or pull in a trace with a different unit) to see panels split.
            Until then the preview shows the overlay view.
          </div>
        )}
      </Section>

      {/* Axis style toggle */}
      <Section title="Axis style">
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          {(['scalebars', 'axes'] as const).map((s) => (
            <button
              key={s}
              className={axisStyle === s ? 'active' : undefined}
              onClick={() => setAxisStyle(s)}
            >{s === 'scalebars' ? 'Scalebars' : 'Axes'}</button>
          ))}
        </div>
      </Section>

      {/* Y axes manager */}
      <Section title={`Y axes (${axes.length})`}>
        {axes.map((a) => (
          <div key={a.id} style={{
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-field)',
            padding: 6, marginBottom: 4,
          }}>
            <Row label="Label">
              <input value={a.label} onChange={(e) => updateAxis(a.id, { label: e.target.value })} style={{ flex: 1 }} />
            </Row>
            <Row label="Unit">
              <input value={a.unit} onChange={(e) => updateAxis(a.id, { unit: e.target.value })} style={{ flex: 1 }} />
            </Row>
            <Row label="Side">
              <select value={a.side} onChange={(e) => updateAxis(a.id, { side: e.target.value as any })}>
                <option value="left">left</option>
                <option value="right">right</option>
                <option value="right2">right (offset)</option>
              </select>
            </Row>
            <Row>
              <label>
                <input
                  type="checkbox"
                  checked={!a.auto_limits}
                  onChange={(e) => updateAxis(a.id, { auto_limits: !e.target.checked })}
                /> Manual limits
              </label>
            </Row>
            {!a.auto_limits && (
              <Row>
                <span>Min</span>
                <NumField value={a.min ?? 0} onChange={(v) => updateAxis(a.id, { min: v })} />
                <span>Max</span>
                <NumField value={a.max ?? 0} onChange={(v) => updateAxis(a.id, { max: v })} />
              </Row>
            )}
            {panelLayout === 'stacked' && (
              <Row label="Height">
                <NumField
                  value={a.height_weight}
                  step={0.5} min={0.25} max={10}
                  onChange={(v) => updateAxis(a.id, { height_weight: Math.max(0.25, v) })}
                />
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
                  relative weight (1 = normal)
                </span>
              </Row>
            )}
            <div style={{ marginTop: 4 }}>
              <button className="btn" onClick={() => safeRemoveAxis(a.id)} disabled={axes.length <= 1}>Remove</button>
            </div>
          </div>
        ))}
        <button className="btn" onClick={() => addAxis()}>+ Add axis</button>
      </Section>

      {/* Scalebar */}
      {axisStyle === 'scalebars' && (
        <Section title="Scalebar">
          <Row>
            <label>
              <input type="checkbox" checked={scalebar.enabled} onChange={(e) => setScalebar({ enabled: e.target.checked })} /> Enabled
            </label>
          </Row>
          {scalebar.enabled && (
            <>
              <Row label="Corner">
                <select value={scalebar.corner} onChange={(e) => setScalebar({ corner: e.target.value as any })}>
                  <option value="br">bottom-right</option>
                  <option value="bl">bottom-left</option>
                  <option value="tr">top-right</option>
                  <option value="tl">top-left</option>
                </select>
              </Row>
              <Row label="Color">
                <input type="color" value={scalebar.color} onChange={(e) => setScalebar({ color: e.target.value })} />
              </Row>
              <Row label="Thickness">
                <NumField value={scalebar.thickness_pt} step={0.1} onChange={(v) => setScalebar({ thickness_pt: v })} />
              </Row>
              <Row label="Font size">
                <NumField value={scalebar.font_size} step={0.5} onChange={(v) => setScalebar({ font_size: v })} />
              </Row>
              <Row>
                <label><input type="checkbox" checked={scalebar.show_labels} onChange={(e) => setScalebar({ show_labels: e.target.checked })} /> Labels</label>
              </Row>

              <SubBlock title="Time bar">
                {/* x_value lives in seconds in the store (so backend +
                    scalebar drawing don't have to know about display
                    units), but we let the user TYPE the value in their
                    chosen unit — much friendlier than expecting them
                    to enter 0.01 for 10 ms. */}
                <Row>
                  <label>
                    <input
                      type="checkbox"
                      checked={scalebar.x_value !== null}
                      onChange={(e) => setScalebar({
                        x_value: e.target.checked ? 0.01 : null,  // 10 ms default
                        x_unit: e.target.checked ? (scalebar.x_unit ?? 'ms') : null,
                      })}
                    /> Manual override
                  </label>
                </Row>
                {scalebar.x_value !== null && (() => {
                  const unit = scalebar.x_unit ?? 'ms'
                  const factor = unit === 'min' ? 60 : unit === 's' ? 1 : unit === 'ms' ? 1e-3 : 1e-6
                  const valueInUnit = scalebar.x_value / factor
                  return (
                    <Row>
                      <NumField
                        value={valueInUnit}
                        step={unit === 'µs' ? 1 : unit === 'ms' ? 0.5 : 0.001}
                        onChange={(v) => setScalebar({ x_value: v * factor })}
                      />
                      <select
                        value={unit}
                        onChange={(e) => setScalebar({ x_unit: e.target.value })}
                      >
                        <option value="min">min</option>
                        <option value="s">s</option>
                        <option value="ms">ms</option>
                        <option value="µs">µs</option>
                      </select>
                    </Row>
                  )
                })()}
              </SubBlock>

              <SubBlock title="Y bars (per axis)">
                {axes.map((a) => {
                  const ov = scalebar.y_overrides[a.id] ?? {}
                  return (
                    <div key={a.id} style={{ marginBottom: 4 }}>
                      <div style={{ color: 'var(--text-muted)' }}>{a.label || a.id}</div>
                      <Row>
                        <label>
                          <input
                            type="checkbox"
                            checked={ov.value !== undefined}
                            onChange={(e) => setScalebar({
                              y_overrides: {
                                ...scalebar.y_overrides,
                                [a.id]: e.target.checked ? { value: 1, unit: a.unit } : {},
                              },
                            })}
                          /> Manual override
                        </label>
                      </Row>
                      {ov.value !== undefined && (
                        <Row>
                          <NumField value={ov.value} step={0.1} onChange={(v) => setScalebar({
                            y_overrides: { ...scalebar.y_overrides, [a.id]: { ...ov, value: v } },
                          })} />
                          <input
                            value={ov.unit ?? a.unit}
                            onChange={(e) => setScalebar({
                              y_overrides: { ...scalebar.y_overrides, [a.id]: { ...ov, unit: e.target.value } },
                            })}
                            style={{ width: 50 }}
                          />
                        </Row>
                      )}
                    </div>
                  )
                })}
              </SubBlock>
            </>
          )}
        </Section>
      )}

      {/* Legend */}
      <Section title="Legend">
        <Row>
          <label>
            <input type="checkbox" checked={legend.enabled} onChange={(e) => setLegend({ enabled: e.target.checked })} /> Enabled
          </label>
        </Row>
        {legend.enabled && (
          <>
            <Row label="Position">
              <select value={legend.position} onChange={(e) => setLegend({ position: e.target.value as any })}>
                <option value="tl">top-left</option>
                <option value="tr">top-right</option>
                <option value="bl">bottom-left</option>
                <option value="br">bottom-right</option>
                <option value="outside-right">outside (right)</option>
              </select>
            </Row>
            <Row label="Font">
              <NumField value={legend.font_size} step={0.5} onChange={(v) => setLegend({ font_size: v })} />
            </Row>
            <Row>
              <label>
                <input type="checkbox" checked={legend.only_named} onChange={(e) => setLegend({ only_named: e.target.checked })} />
                {' '}Only show traces with a custom name
              </label>
            </Row>
          </>
        )}
      </Section>

      {/* Figure size in centimeters — matplotlib figsize takes
          inches; the renderer converts at the edge. */}
      <Section title="Figure size">
        <Row>
          <span>w</span>
          <NumField value={width_cm} step={0.5} onChange={(v) => setSize(v, height_cm)} />
          <span>h</span>
          <NumField value={height_cm} step={0.5} onChange={(v) => setSize(width_cm, v)} />
          <span style={{ color: 'var(--text-muted)' }}>cm</span>
        </Row>
        <Row label="DPI">
          <NumField value={dpi} step={50} onChange={(v) => setDpi(Math.max(72, Math.round(v)))} />
        </Row>
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

function NumField({ value, onChange, step, min, max }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(v) }}
      step={step ?? 0.1}
      min={min}
      max={max}
      style={{ width: 80 }}
    />
  )
}
