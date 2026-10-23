import React from 'react'
import { useAppStore, getMetaStatus } from '../../stores/appStore'

/**
 * Title block at the start of the main toolbar: tag-status dot,
 * file name and file-level tag chips on the first line; format,
 * position and sampling details on the second.
 */
export function RecordingTitle() {
  const { recording, traceData, currentGroup, currentSeries } = useAppStore()

  if (!recording) {
    return (
      <div className="toolbar-title">
        <span className="toolbar-title-name" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
          No recording open
        </span>
      </div>
    )
  }

  const group = recording.groups[currentGroup]
  const series = group?.series[currentSeries]
  const seriesLabel = series?.label || `Series ${currentSeries + 1}`
  const sampleRate = traceData?.samplingRate
  const sampleCount = traceData?.values.length

  const detail = [
    recording.format,
    group?.label || `Group ${currentGroup + 1}`,
    seriesLabel,
    sampleRate != null ? `${sampleRate.toLocaleString('en-US')} Hz` : null,
    sampleCount != null ? `${sampleCount.toLocaleString('en-US')} samples` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="toolbar-title">
      <span className="toolbar-title-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <MetaStatusDot />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={recording.filePath}>
          {recording.fileName}
        </span>
        <FileTagChips />
      </span>
      <span className="toolbar-title-detail" style={{ fontVariantNumeric: 'tabular-nums' }}>{detail}</span>
    </div>
  )
}

/** Tag-status dot — green / yellow / red based on file & series
 *  tagging completeness. Moved out of the toolbar so the header
 *  becomes the canonical place to see "is this file ready for
 *  cohort analysis". */
function MetaStatusDot() {
  const meta = useAppStore((s) => s.recordingMeta)
  const groups = useAppStore((s) => s.recording?.groups ?? [])
  const status = getMetaStatus(meta)
  const colour =
    status === 'green' ? 'var(--success)'
      : status === 'yellow' ? 'var(--warning)'
        : 'var(--error)'
  const label = status === 'green' ? 'Tagged'
    : status === 'yellow' ? 'No series tagged'
      : 'Untagged'
  const tooltip = (() => {
    const fileTags = meta?.group_tags ?? []
    const seriesTags = meta?.series_tags ?? {}
    const taggedSeries = Object.values(seriesTags).filter(
      (t) => Array.isArray(t) && t.length > 0).length
    const totalSeries = groups.reduce(
      (acc: number, g: any) => acc + (g.series?.length ?? 0), 0)
    if (status === 'red') {
      return 'No file-level tags. Cohort Analysis needs at least one (e.g. "WT", "male"). Click "Tags…" to add.'
    }
    if (status === 'yellow') {
      return `File tagged with ${fileTags.length} tag${fileTags.length === 1 ? '' : 's'}, but no series tagged yet (0 / ${totalSeries}).`
    }
    return `File tagged with ${fileTags.length} tag${fileTags.length === 1 ? '' : 's'}; ${taggedSeries} of ${totalSeries} series tagged.`
  })()
  return (
    <span
      className="meta-status-dot"
      title={`${label} — ${tooltip}`}
      aria-label={label}
      style={{
        display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
        flexShrink: 0, background: colour,
      }}
    />
  )
}

/** File-level tag chips. */
function FileTagChips() {
  const fileTags = useAppStore((s) => s.recordingMeta?.group_tags)
  if (!fileTags || fileTags.length === 0) return null
  const tooltip = fileTags.join(', ')
  return (
    <span title={tooltip} style={{ display: 'inline-flex', gap: 4, flexShrink: 1, overflow: 'hidden' }}>
      {fileTags.map((tag, i) => (
        <span key={`${tag}-${i}`} style={{ padding: '0 7px', borderRadius: 999, background: 'color-mix(in oklab, var(--accent) 14%, transparent)', fontSize: 11, fontWeight: 400, lineHeight: '17px', whiteSpace: 'nowrap' }}>
          {tag}
        </span>
      ))}
    </span>
  )
}
