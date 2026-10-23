import React, { useEffect, useState, useCallback } from 'react'
import { useThemeStore } from './stores/themeStore'

/**
 * Standalone Results window — mounts when `?view=results` is present.
 * Polls the Python backend for the current file info and displays the
 * results from the main app's analysis runs.
 *
 * Since this is a separate Electron renderer window, it doesn't share
 * the Zustand store with the main window. It maintains its own state
 * and refreshes from the backend on a 1-second interval.
 */

interface ResultRow {
  [key: string]: number | string | null | undefined
}

export function ResultsApp() {
  const { initTheme } = useThemeStore()
  const [backendUrl, setBackendUrl] = useState('')
  const [fileName, setFileName] = useState('')
  const [results, setResults] = useState<ResultRow[]>([])

  // Initialize theme + backend URL
  useEffect(() => {
    initTheme();
    (async () => {
      const url = window.electronAPI
        ? await window.electronAPI.getBackendUrl()
        : 'http://localhost:8321'
      setBackendUrl(url)
    })()
  }, [initTheme])

  // Poll backend for file info
  const refresh = useCallback(async () => {
    if (!backendUrl) return
    try {
      const resp = await fetch(`${backendUrl}/api/files/info`)
      if (resp.ok) {
        const data = await resp.json()
        setFileName(data.fileName || '')
      }
    } catch { /* backend not ready */ }
  }, [backendUrl])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [refresh])

  // Listen for result broadcasts from main window via BroadcastChannel
  // This is a browser API that works across same-origin windows (including Electron renderer windows
  // that share the same origin via Vite dev server or file:// protocol).
  useEffect(() => {
    try {
      const channel = new BroadcastChannel('tracer-results')
      channel.onmessage = (ev) => {
        if (ev.data?.type === 'results-update') {
          setResults(ev.data.results ?? [])
        }
      }
      // Request current state
      channel.postMessage({ type: 'results-request' })
      return () => channel.close()
    } catch {
      // BroadcastChannel not available — fall back to no live updates
    }
  }, [])

  const columns = results.length > 0
    ? Object.keys(results[0]).filter((k) => results.some((r) => r[k] !== undefined))
    : []

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--font-size-sm)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600 }}>Results</span>
        <span style={{ color: 'var(--text-muted)' }}>
          {fileName || 'No file loaded'}
          {results.length > 0 && ` · ${results.length} rows`}
        </span>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {results.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            Run an analysis in the main window to see results here.
          </p>
        ) : (
          <table className="data-table" style={{ border: '1px solid var(--border)' }}>
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
              {results.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td key={col}>
                      {typeof row[col] === 'number' ? (row[col] as number).toFixed(4) : row[col] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
