import React, { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'

export function ResultsTable() {
  const { results, clearResults } = useAppStore()
  const channelRef = useRef<BroadcastChannel | null>(null)

  // ---- BroadcastChannel for pushing results to detached window ----
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('tracer-results')
      channelRef.current = ch

      ch.onmessage = (ev) => {
        if (ev.data?.type === 'results-request') {
          ch.postMessage({
            type: 'results-update',
            results: useAppStore.getState().results,
          })
        }
      }

      return () => ch.close()
    } catch { /* BroadcastChannel not available */ }
  }, [])

  // Push results whenever they change
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'results-update', results })
  }, [results])

  const columns = results.length > 0
    ? Object.keys(results[0]).filter((k) => results.some((r: any) => r[k] !== undefined))
    : []

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          {results.length > 0 ? `${results.length} rows` : ''}
        </div>
        {results.length > 0 && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn" onClick={() => {
              const csv = [columns.join(','), ...results.map((r: any) => columns.map((c) => r[c] ?? '').join(','))].join('\n')
              navigator.clipboard.writeText(csv)
            }}>
              Copy CSV
            </button>
            <button className="btn" onClick={clearResults}>Clear</button>
          </div>
        )}
      </div>

      {results.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          No results yet. Run an analysis to populate this table.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((row: any, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td key={col}>
                      {typeof row[col] === 'number' ? row[col].toFixed(4) : row[col] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
