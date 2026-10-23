import React, { useState } from 'react'
import { useAppStore } from '../../stores/appStore'

const DEFAULT_MACRO = `# TRACER Python Macro
# Available API: stf.get_trace(), stf.get_sampling_rate(), stf.measure_peak(), etc.

import numpy as np

# Get current trace data
trace = stf.get_trace()
sr = stf.get_sampling_rate()
time = np.arange(len(trace)) / sr

# Example: compute peak amplitude
baseline = np.mean(trace[:int(0.01 * sr)])  # first 10ms
peak = np.min(trace) - baseline
print(f"Peak amplitude: {peak:.2f}")

# Send result to table
stf.to_table({"peak": peak, "baseline": baseline})
`

export function MacroEditor() {
  const { backendUrl } = useAppStore()
  const [code, setCode] = useState(DEFAULT_MACRO)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)

  const runMacro = async () => {
    setRunning(true)
    setOutput('')
    try {
      const resp = await fetch(`${backendUrl}/api/macros/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const result = await resp.json()
      setOutput(result.output || result.error || JSON.stringify(result))
    } catch (err: any) {
      setOutput(`Error: ${err.message}`)
    }
    setRunning(false)
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', background: 'var(--bg-secondary)' }}>
          <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--text-muted)' }}>Macro editor</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn btn-primary" onClick={runMacro} disabled={running}>
              {running ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            height: 'auto',
            background: 'var(--bg-field)',
            color: 'var(--text-primary)',
            border: 'none',
            borderRadius: 0,
            boxShadow: 'none',
            padding: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-sm)',
            lineHeight: 1.5,
            resize: 'none',
            outline: 'none',
            tabSize: 4,
          }}
        />
      </div>
      <div style={{ width: 300, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '4px 8px', background: 'var(--bg-secondary)', fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--text-muted)' }}>
          Output
        </div>
        <pre style={{
          flex: 1,
          padding: 12,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-xs)',
          lineHeight: 1.4,
          color: output.startsWith('Error') ? 'var(--error)' : 'var(--text-secondary)',
          whiteSpace: 'pre-wrap',
          overflow: 'auto',
        }}>
          {output || 'Run a macro to see output here'}
        </pre>
      </div>
    </div>
  )
}
