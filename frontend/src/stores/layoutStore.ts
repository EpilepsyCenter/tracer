import { create } from 'zustand'

export interface PanelLayout {
  leftCollapsed: boolean
  rightCollapsed: boolean
  leftWidth: number
  rightWidth: number
  focusMode: boolean
}

interface LayoutState extends PanelLayout {
  toggleLeft: () => void
  toggleRight: () => void
  toggleFocus: () => void
  setLeftWidth: (w: number) => void
  setRightWidth: (w: number) => void
  persistLayout: () => void
  initLayout: () => Promise<void>
}

const LS_KEY = 'tracer-layout'

const defaults: PanelLayout = {
  leftCollapsed: false,
  rightCollapsed: false,
  leftWidth: 260,
  rightWidth: 240,
  focusMode: false,
}

function loadSync(): Partial<PanelLayout> {
  try {
    const sp = (window as any).electronAPI?.syncPreferences
    if (sp?.layout) return sp.layout as Partial<PanelLayout>
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

function persist(state: LayoutState) {
  const data: PanelLayout = {
    leftCollapsed: state.leftCollapsed,
    rightCollapsed: state.rightCollapsed,
    leftWidth: state.leftWidth,
    rightWidth: state.rightWidth,
    focusMode: false,
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)) } catch { /* ignore */ }
  window.electronAPI?.patchPreferences?.({ layout: data }).catch(() => { /* ignore */ })
}

const saved = loadSync()

export const useLayoutStore = create<LayoutState>((set, get) => ({
  leftCollapsed: saved.leftCollapsed ?? defaults.leftCollapsed,
  rightCollapsed: saved.rightCollapsed ?? defaults.rightCollapsed,
  leftWidth: saved.leftWidth ?? defaults.leftWidth,
  rightWidth: saved.rightWidth ?? defaults.rightWidth,
  focusMode: defaults.focusMode,

  toggleLeft: () => {
    set((s) => ({ leftCollapsed: !s.leftCollapsed, focusMode: false }))
    persist(get())
  },
  toggleRight: () => {
    set((s) => ({ rightCollapsed: !s.rightCollapsed, focusMode: false }))
    persist(get())
  },
  toggleFocus: () => {
    set((s) => ({ focusMode: !s.focusMode }))
  },

  setLeftWidth: (w) => set({ leftWidth: w }),
  setRightWidth: (w) => set({ rightWidth: w }),
  persistLayout: () => persist(get()),

  initLayout: async () => {
    const state = get()
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        leftWidth: state.leftWidth,
        rightWidth: state.rightWidth,
        focusMode: false,
      }))
    } catch { /* ignore */ }
  },
}))
