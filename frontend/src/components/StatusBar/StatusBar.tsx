import React from 'react'
import { useAppStore } from '../../stores/appStore'

/**
 * App footer status bar: backend state (dot), recording format,
 * sampling details, any error, and the app version.
 */
export function StatusBar() {
  const { backendReady, recording, traceData, error } = useAppStore()
  const backendClass = backendReady ? 'led ok' : 'led off'
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className={backendClass}>
          {backendReady ? 'Backend connected' : 'Connecting…'}
        </span>
        {recording && (
          <span>
            {recording.format} · {recording.groupCount} group{recording.groupCount === 1 ? '' : 's'}
          </span>
        )}
        {traceData && (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {/* en-US locale for the thousands separator keeps the output
                consistent on European systems where toLocaleString()
                would otherwise render "20.000 Hz" (dot as thousands
                separator), which reads as a decimal. */}
            {traceData.samplingRate.toLocaleString('en-US')} Hz ·{' '}
            {traceData.values.length.toLocaleString('en-US')} samples
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {error && <span className="led err">{error}</span>}
        {!window.electronAPI && <span>Browser preview</span>}
        <span>TRACER {typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== 'dev' ? `v${__APP_VERSION__}` : 'dev'}</span>
      </div>
    </div>
  )
}
