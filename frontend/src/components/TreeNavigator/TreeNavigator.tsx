import React, { useState } from 'react'
import { useAppStore, SeriesInfo } from '../../stores/appStore'

/** Guess recording type from series label, protocol, or units */
function guessRecordingType(series: SeriesInfo): 'vc' | 'cc' | 'field' | 'unknown' {
  const label = (series.label || '').toLowerCase()
  const protocol = (series.protocol || '').toLowerCase()
  const combined = label + ' ' + protocol

  if (/\bcc\b|current.?clamp|i.?clamp|c-clamp/.test(combined)) return 'cc'
  if (/\bvc\b|voltage.?clamp|v.?clamp|test.?pulse|i-v|ramp|seal/.test(combined)) return 'vc'
  if (/field|fepsp|epsp|pop.?spike|lfp|extracell/.test(combined)) return 'field'

  if (series.holding !== undefined && series.holding !== null) return 'vc'
  return 'unknown'
}

const TYPE_COLORS: Record<string, string> = {
  vc: 'var(--trace-color-1)',
  cc: 'var(--trace-color-2)',
  field: 'var(--trace-color-3)',
  unknown: 'var(--text-secondary)',
}

const TYPE_LABELS: Record<string, string> = {
  vc: 'VC',
  cc: 'CC',
  field: 'FP',
  unknown: '',
}

// Visual identity for the analysis-presence badges shown next to each
// series in the tree navigator. Each present analysis type contributes
// one small coloured pill carrying a short letter code; hovering the
// cluster lists the analyses by full name. Letters are short enough
// that 4-5 badges fit in the row without crowding the type-pill / tag
// chip / sweep count that already live there.
const ANALYSIS_BADGES: { id: string; code: string; label: string; color: string }[] = [
  { id: 'events',     code: 'E',  label: 'Events',            color: '#42a5f5' },
  { id: 'ap',         code: 'AP', label: 'Action potentials', color: '#ff7043' },
  { id: 'bursts',     code: 'B',  label: 'Bursts',            color: '#ab47bc' },
  { id: 'iv',         code: 'IV', label: 'I-V curve',         color: '#66bb6a' },
  { id: 'cursors',    code: 'C',  label: 'Cursors',           color: '#ffca28' },
  { id: 'fpsp',       code: 'FP', label: 'fPSP',              color: '#ec407a' },
  { id: 'resistance', code: 'R',  label: 'Resistance (Rs/Rin/Cm)', color: '#26c6da' },
  { id: 'paired',     code: 'P',  label: 'Paired recording',  color: '#7e57c2' },
]

export function TreeNavigator() {
  const {
    recording, currentGroup, currentSeries, currentSweep,
    selectSweep,
    excludedSweeps, toggleSweepExcluded, clearExcludedSweeps,
    selectedSweeps, handleSweepSelection, clearSweepSelection,
    averagedSweeps, deleteAveragedSweep, selectAveragedSweep,
    renameAveragedSweep, currentAveragedSweep,
  } = useAppStore()
  // Per-series tag map (Metadata module). Subscribed separately so
  // tree rows re-render when the user edits tags in the metadata
  // window — broadcasts arrive via the cross-window meta-update sync.
  const seriesTagMap = useAppStore((s) => s.recordingMeta?.series_tags)
  // Analysis-presence subscriptions — drive the small "what's been
  // analyzed" badges shown next to each series. Each subscription
  // returns the per-(group,series) keyset, which is small (one entry
  // per analysed series), so re-renders are cheap. fpsp is keyed
  // ``g:s:mode`` so we strip the mode suffix when matching.
  const eventsKeys = useAppStore((s) => Object.keys(s.eventsAnalyses))
  const apKeys = useAppStore((s) => Object.keys(s.apAnalyses))
  const burstKeys = useAppStore((s) => Object.keys(s.fieldBursts))
  const ivKeys = useAppStore((s) => Object.keys(s.ivCurves))
  const cursorKeys = useAppStore((s) => Object.keys(s.cursorAnalyses))
  const fpspKeys = useAppStore((s) => Object.keys(s.fpspCurves))
  const resistanceKeys = useAppStore((s) => Object.keys(s.resistanceResults))
  const pairedKeys = useAppStore((s) => Object.keys(s.pairedAnalyses))
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set([0]))
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set())
  const [hoveredSweep, setHoveredSweep] = useState<string | null>(null)
  const [hoveredAvg, setHoveredAvg] = useState<string | null>(null)
  const [editingAvg, setEditingAvg] = useState<string | null>(null)

  const toggleGroup = (idx: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  const toggleSeries = (gIdx: number, sIdx: number) => {
    const key = `${gIdx}-${sIdx}`
    setExpandedSeries((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const handleSeriesClick = (gIdx: number, sIdx: number) => {
    toggleSeries(gIdx, sIdx)
    clearSweepSelection(gIdx, sIdx)
    selectSweep(gIdx, sIdx, 0)
  }

  // Presence map: which analyses have data for ``g:s``. Cheap O(1)
  // membership checks built from the keyset selectors above. fpsp keys
  // include a ``:mode`` suffix so we match by prefix.
  const presenceFor = (g: number, s: number) => {
    const k = `${g}:${s}`
    const fpspPrefix = `${g}:${s}:`
    return {
      events: eventsKeys.includes(k),
      ap: apKeys.includes(k),
      bursts: burstKeys.includes(k),
      iv: ivKeys.includes(k),
      cursors: cursorKeys.includes(k),
      fpsp: fpspKeys.some((fk) => fk.startsWith(fpspPrefix)),
      resistance: resistanceKeys.includes(k),
      paired: pairedKeys.includes(k),
    }
  }

  if (!recording) {
    return (
      <div className="panel">
        <div className="panel-title">Navigator</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', fontStyle: 'italic' }}>
          No file loaded
        </p>
      </div>
    )
  }

  return (
    <div role="tree" aria-label={recording.fileName}
      style={{ fontSize: 'var(--font-size-base)', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div title={recording.filePath} style={{ padding: '4px 8px 4px', fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {recording.fileName}
      </div>

      {recording.groups.map((group) => (
        <div key={group.index}>
          <div
            onClick={() => toggleGroup(group.index)}
            style={{
              height: 24,
              padding: '0 8px 0 4px',
              borderRadius: 5,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              userSelect: 'none',
            }}
            className="tree-row"
          >
            <Chevron open={expandedGroups.has(group.index)} />
            <span title={group.label || undefined} style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.label || `Group ${group.index + 1}`}</span>
            <span style={{ color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap', fontSize: 'var(--font-size-xs)' }}>
              {group.seriesCount} series
            </span>
          </div>

          {expandedGroups.has(group.index) &&
            group.series.map((series) => {
              const recType = guessRecordingType(series)
              const isSelected = currentGroup === group.index && currentSeries === series.index
              const isExpanded = expandedSeries.has(`${group.index}-${series.index}`)
              const seriesKey = `${group.index}:${series.index}`
              const excludedList = excludedSweeps[seriesKey] ?? []
              const excludedCount = excludedList.length
              const selectedList = selectedSweeps[seriesKey] ?? []
              const averagedList = averagedSweeps[seriesKey] ?? []

              return (
                <div key={series.index}>
                  <div
                    onClick={() => handleSeriesClick(group.index, series.index)}
                    style={{
                      minHeight: 24,
                      padding: '0 8px 0 18px',
                      borderRadius: 5,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      background: isSelected ? 'var(--bg-active)' : 'transparent',
                      fontWeight: isSelected ? 600 : 400,
                      userSelect: 'none',
                    }}
                    className="tree-row"
                  >
                    <Chevron open={isExpanded} />

                    <span style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: TYPE_COLORS[recType],
                      flexShrink: 0,
                    }} />

                    <span className="tree-node-label"
                      style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {series.label || `Series ${series.index + 1}`}
                    </span>

                    {(() => {
                      // Analysis-presence badges: one tiny coloured
                      // pill per analysis type with stored data for
                      // this series. Lets the user see at a glance
                      // what's been worked on without opening every
                      // analysis window. Tooltip on the cluster
                      // wrapper enumerates the analyses in plain
                      // English; individual badges also have their
                      // own tooltip for the single-analysis case.
                      const presence = presenceFor(group.index, series.index)
                      const present = ANALYSIS_BADGES.filter((b) =>
                        presence[b.id as keyof typeof presence])
                      if (present.length === 0) return null
                      const tooltip = `Analyses present: ${present.map((b) => b.label).join(', ')}`
                      return (
                        <span
                          title={tooltip}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            flexShrink: 0,
                          }}
                        >
                          {present.map((b) => (
                            <span
                              key={b.id}
                              title={b.label}
                              style={{
                                display: 'inline-block',
                                padding: '0 4px',
                                borderRadius: 3,
                                background: 'var(--bg-active)',
                                color: 'var(--text-secondary)',
                                fontSize: 10,
                                fontWeight: 600,
                                lineHeight: '15px',
                              }}
                            >{b.code}</span>
                          ))}
                        </span>
                      )
                    })()}

                    {(() => {
                      // Per-series metadata tags. Show the first tag as
                      // a chip (themed to match the metadata window),
                      // with a ``+N`` suffix when more exist. Tooltip
                      // lists every tag so the user can read them
                      // without opening the metadata window.
                      const tags = seriesTagMap?.[`${group.index}:${series.index}`]
                      if (!tags || tags.length === 0) return null
                      const first = tags[0]
                      const extra = tags.length - 1
                      return (
                        <span
                          title={tags.join(', ')}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            maxWidth: 120,
                            padding: '0 5px',
                            borderRadius: 8,
                            background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                            color: 'var(--text-primary)',
                            fontSize: 11,
                            fontWeight: 400,
                            lineHeight: 1.4,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            flexShrink: 0,
                          }}
                        >
                          <span style={{
                            overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>{first}</span>
                          {extra > 0 && (
                            <span style={{
                              color: 'var(--text-muted)',
                              fontSize: '0.85em',
                            }}>+{extra}</span>
                          )}
                        </span>
                      )
                    })()}

                    {selectedList.length > 0 && (
                      <span
                        title={`${selectedList.length} sweep${selectedList.length === 1 ? '' : 's'} selected — click a sweep to clear`}
                        style={{
                          fontSize: 11, fontWeight: 600,
                          color: 'var(--accent)',
                          padding: '0 5px', borderRadius: 4,
                          background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                        }}
                      >
                        {selectedList.length} sel
                      </span>
                    )}

                    {excludedCount > 0 && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          clearExcludedSweeps(group.index, series.index)
                        }}
                        title={`${excludedCount} sweep${excludedCount === 1 ? '' : 's'} excluded — click to restore all`}
                        style={{
                          fontSize: 11, fontWeight: 600,
                          color: 'var(--warning)',
                          padding: '0 5px', borderRadius: 4,
                          background: 'color-mix(in oklab, var(--warning) 16%, transparent)',
                        }}
                      >
                        {excludedCount}⊘
                      </span>
                    )}

                    {TYPE_LABELS[recType] && (
                      <span style={{
                        fontSize: 10, fontWeight: 600, color: TYPE_COLORS[recType],
                        padding: '0 4px', borderRadius: 4,
                        background: `color-mix(in oklab, ${TYPE_COLORS[recType]} 12%, transparent)`,
                      }}>
                        {TYPE_LABELS[recType]}
                      </span>
                    )}

                    <span title={`${series.sweepCount} sweeps`} style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontWeight: 400, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 16, textAlign: 'right' }}>
                      {series.sweepCount}
                    </span>
                  </div>

                  {isSelected && (
                    <div style={{
                      padding: '1px 8px 3px 48px',
                      fontSize: 'var(--font-size-xs)',
                      fontVariantNumeric: 'tabular-nums',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      gap: 10,
                    }}>
                      {series.rs != null && <span>Rs: {series.rs.toFixed(1)}M\u03A9</span>}
                      {series.cm != null && <span>Cm: {series.cm.toFixed(1)}pF</span>}
                      {series.holding != null && <span>Vh: {series.holding.toFixed(0)}mV</span>}
                    </div>
                  )}

                  {isExpanded && series.sweeps.map((sweep) => {
                    const isSweepSelected =
                      isSelected && currentSweep === sweep.index && !currentAveragedSweep
                    const isMultiSelected = selectedList.includes(sweep.index)
                    const isExcluded = excludedList.includes(sweep.index)
                    const hoverKey = `${group.index}-${series.index}-${sweep.index}`
                    const isHovered = hoveredSweep === hoverKey

                    return (
                      <div
                        key={sweep.index}
                        onClick={(e) => {
                          e.stopPropagation()
                          const modifier: 'shift' | 'cmd' | 'none' =
                            e.shiftKey ? 'shift'
                            : (e.metaKey || e.ctrlKey) ? 'cmd'
                            : 'none'
                          if (modifier !== 'none') {
                            // Multi-selection — do NOT navigate.
                            handleSweepSelection(group.index, series.index, sweep.index, modifier)
                          } else {
                            // Plain click → navigate + clear multi-selection.
                            clearSweepSelection(group.index, series.index)
                            selectSweep(group.index, series.index, sweep.index)
                          }
                        }}
                        onMouseEnter={() => setHoveredSweep(hoverKey)}
                        onMouseLeave={() =>
                          setHoveredSweep((cur) => (cur === hoverKey ? null : cur))
                        }
                        style={{
                          minHeight: 22,
                          padding: '0 8px 0 48px',
                          borderRadius: 5,
                          fontVariantNumeric: 'tabular-nums',
                          background: isSweepSelected
                            ? 'var(--accent)'
                            : isMultiSelected
                              ? 'color-mix(in oklab, var(--accent) 16%, transparent)'
                              : undefined,
                          color: isSweepSelected
                            ? 'var(--on-accent)'
                            : isExcluded
                              ? 'var(--text-disabled)'
                              : 'var(--text-primary)',
                          userSelect: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                        className={isSweepSelected ? undefined : 'tree-row'}
                        aria-current={isSweepSelected ? 'true' : undefined}
                      >
                        <span className="tree-node-label"
                          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: isExcluded ? 'line-through' : 'none' }}>
                          {sweep.label || `Sweep ${sweep.index + 1}`}
                        </span>
                        {(isExcluded || isHovered) && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSweepExcluded(group.index, series.index, sweep.index)
                            }}
                            title={
                              isExcluded
                                ? 'Click to include this sweep again'
                                : 'Click to exclude this sweep from analyses'
                            }
                            style={{
                              flexShrink: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '0 6px',
                              borderRadius: 4,
                              fontSize: 'var(--font-size-xs)',
                              lineHeight: '17px',
                              textDecoration: 'none',
                              color: isSweepSelected
                                ? 'var(--on-accent)'
                                : isExcluded ? 'var(--warning)' : 'var(--text-secondary)',
                              background: isSweepSelected
                                ? 'color-mix(in oklab, var(--on-accent) 20%, transparent)'
                                : isExcluded
                                  ? 'color-mix(in oklab, var(--warning) 16%, transparent)'
                                  : 'var(--bg-active)',
                            }}
                          >
                            <span>{isExcluded ? 'Include' : 'Exclude'}</span>
                          </span>
                        )}
                      </div>
                    )
                  })}

                  {/* Averaged virtual sweeps — appear below real sweeps
                      with a small divider. Italic label + Σ badge so they
                      visually stand out from recorded sweeps. */}
                  {isExpanded && averagedList.length > 0 && (
                    <div style={{
                      margin: '3px 8px 3px 48px',
                      borderTop: '1px solid var(--border)',
                    }} />
                  )}
                  {isExpanded && averagedList.map((avg) => {
                    const isAvgSelected =
                      currentAveragedSweep != null &&
                      currentAveragedSweep.group === group.index &&
                      currentAveragedSweep.series === series.index &&
                      currentAveragedSweep.id === avg.id
                    const hovKey = `avg-${avg.id}`
                    const isHovered = hoveredAvg === hovKey
                    const isEditing = editingAvg === avg.id

                    return (
                      <div
                        key={avg.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (isEditing) return
                          selectAveragedSweep(group.index, series.index, avg.id)
                        }}
                        onMouseEnter={() => setHoveredAvg(hovKey)}
                        onMouseLeave={() => setHoveredAvg((cur) => (cur === hovKey ? null : cur))}
                        style={{
                          minHeight: 22,
                          padding: '0 8px 0 48px',
                          borderRadius: 5,
                          cursor: isEditing ? 'text' : undefined,
                          background: isAvgSelected ? 'var(--accent)' : undefined,
                          color: isAvgSelected ? 'var(--on-accent)' : 'var(--text-primary)',
                          userSelect: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                        className={isAvgSelected ? undefined : 'tree-row'}
                      >
                        <span style={{
                          fontSize: 11, fontWeight: 600,
                          color: isAvgSelected ? 'var(--on-accent)' : 'var(--cursor-fit)',
                          flexShrink: 0,
                        }}>Σ</span>
                        {isEditing ? (
                          <input
                            autoFocus
                            type="text"
                            defaultValue={avg.label}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                renameAveragedSweep(group.index, series.index, avg.id, (e.target as HTMLInputElement).value)
                                setEditingAvg(null)
                              } else if (e.key === 'Escape') {
                                setEditingAvg(null)
                              }
                            }}
                            onBlur={(e) => {
                              renameAveragedSweep(group.index, series.index, avg.id, e.target.value)
                              setEditingAvg(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              flex: 1, fontSize: 'inherit', fontFamily: 'inherit',
                              height: 20, padding: '0 4px',
                            }}
                          />
                        ) : (
                          <span
                            className="tree-node-label"
                            onDoubleClick={(e) => { e.stopPropagation(); setEditingAvg(avg.id) }}
                            title={`Sources: sweeps ${avg.sourceSweepIndices.map((i) => i + 1).join(', ')} — double-click to rename`}
                            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {avg.label}
                          </span>
                        )}
                        {isHovered && !isEditing && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              if (window.confirm(`Delete averaged sweep "${avg.label}"?`)) {
                                deleteAveragedSweep(group.index, series.index, avg.id)
                              }
                            }}
                            title="Delete this averaged sweep"
                            style={{
                              flexShrink: 0,
                              color: isAvgSelected ? 'var(--on-accent)' : 'var(--text-muted)',
                              fontSize: '0.9em',
                              padding: '0 4px',
                              lineHeight: 1,
                              fontStyle: 'normal',
                            }}
                          >
                            ✕
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
        </div>
      ))}
    </div>
  )
}

/** Disclosure chevron for tree rows. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0 }}>
      <path d={open ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} />
    </svg>
  )
}
