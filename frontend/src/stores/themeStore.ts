import { create } from 'zustand'

/** The theme actually applied to the page. */
export type ThemeName = 'dark' | 'light'
/** What the user picked in Settings. ``system`` follows the OS
 *  light / dark setting live. */
export type ThemePref = 'system' | 'light' | 'dark'

export const FONT_SIZES = [11, 12, 13, 14, 15] as const

/** Slots: indices 0..4 → ``--trace-color-1`` .. ``--trace-color-5``,
 *  index 5 → ``--stimulus-color``. Empty string = inherit the
 *  stylesheet default (so the user's customisation can be cleared
 *  per-slot without losing the others). */
export const TRACE_COLOR_SLOT_COUNT = 6

interface ThemeState {
  /** Resolved theme (what components should draw with). */
  theme: ThemeName
  themePref: ThemePref
  fontSize: number
  /** Per-slot custom colours overlaid on the theme. Length 6 —
   *  see ``TRACE_COLOR_SLOT_COUNT``. */
  traceColors: string[]

  /** Pick an explicit light / dark theme. */
  setTheme: (t: ThemeName) => void
  setThemePref: (p: ThemePref) => void
  toggleTheme: () => void
  setFontSize: (s: number) => void
  /** Set the colour at one slot. Pass empty string to clear. */
  setTraceColor: (slot: number, color: string) => void
  /** Reset every slot to stylesheet defaults. */
  resetTraceColors: () => void
  initTheme: () => Promise<void>
}

const LS_KEY = 'tracer-theme-prefs'

interface PersistedPrefs {
  /** Legacy: the resolved theme. Still written so older builds
   *  reading the same prefs file keep working. */
  theme?: ThemeName
  themePref?: ThemePref
  fontSize?: number
  traceColors?: string[]
}

/** Load preferences synchronously — tries Electron's preload-read file first,
 *  then falls back to localStorage. */
function loadPrefsSync(): PersistedPrefs {
  try {
    const sp = (window as any).electronAPI?.syncPreferences
    if (sp && (sp.theme || sp.themePref || sp.fontSize)) return sp as PersistedPrefs
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

/** Load preferences from Electron's userData file if available, else localStorage. */
async function loadPrefsAsync(): Promise<PersistedPrefs> {
  if (window.electronAPI?.getPreferences) {
    try {
      const prefs = await window.electronAPI.getPreferences()
      return prefs as PersistedPrefs
    } catch { /* fall through */ }
  }
  return loadPrefsSync()
}

function prefsFromState(state: ThemeState): PersistedPrefs {
  return {
    theme: state.theme,
    themePref: state.themePref,
    fontSize: state.fontSize,
    traceColors: state.traceColors,
  }
}

/** Save preferences to BOTH localStorage and the Electron userData file.
 *  The localStorage write also notifies the other open windows
 *  (``storage`` event), so a theme change applies everywhere. */
function savePrefs(state: ThemeState) {
  const data = prefsFromState(state)
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch { /* ignore */ }
  // preferences.json also holds window bounds, recent files etc., and
  // set-preferences replaces the whole file — so read, merge, write.
  const api = window.electronAPI
  if (api?.getPreferences && api?.setPreferences) {
    api.getPreferences().then((prefs) => {
      const next: Record<string, unknown> = { ...(prefs ?? {}), ...data }
      // Keys from the old palette / font pickers.
      delete next.palette; delete next.fontFamily; delete next.monoFont
      return api.setPreferences(next)
    }).catch(() => { /* ignore */ })
  }
}

const darkQuery: MediaQueryList | null =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

function resolveTheme(pref: ThemePref): ThemeName {
  if (pref === 'system') return darkQuery?.matches ? 'dark' : 'light'
  return pref
}

/** Push current theme values to the DOM so CSS variables take effect. */
function applyToDOM(state: ThemeState) {
  const root = document.documentElement
  root.dataset.theme = state.theme
  // Older builds set these; make sure nothing stale lingers.
  delete root.dataset.palette
  root.style.removeProperty('--font-ui')
  root.style.removeProperty('--font-mono')

  const fs = state.fontSize
  root.style.setProperty('--font-size-base', `${fs}px`)
  root.style.setProperty('--font-size-sm', `${fs - 1}px`)
  root.style.setProperty('--font-size-xs', `${fs - 2}px`)
  root.style.setProperty('--font-size-label', `${fs - 2}px`)
  root.style.setProperty('--font-size-lg', `${fs + 2}px`)

  // Trace-color overrides. Slot indices 0..4 map to ``--trace-color-N``,
  // slot 5 maps to ``--stimulus-color``. An empty entry removes the
  // inline override so the stylesheet's value cascades.
  const TRACE_VARS = ['--trace-color-1', '--trace-color-2', '--trace-color-3',
                      '--trace-color-4', '--trace-color-5', '--stimulus-color']
  for (let i = 0; i < TRACE_VARS.length; i++) {
    const v = state.traceColors[i] ?? ''
    if (v) root.style.setProperty(TRACE_VARS[i], v)
    else root.style.removeProperty(TRACE_VARS[i])
  }

  // Native menus, dialogs and (on Windows / Linux) the title bar
  // follow the same choice.
  try { window.electronAPI?.setThemeSource?.(state.themePref) } catch { /* ignore */ }
}

const defaults = {
  themePref: 'system' as ThemePref,
  fontSize: 13,
  traceColors: Array(TRACE_COLOR_SLOT_COUNT).fill('') as string[],
}

function validatePref(p: PersistedPrefs): ThemePref {
  if (p.themePref === 'system' || p.themePref === 'light' || p.themePref === 'dark') return p.themePref
  // Prefs written before the System option existed: light was the
  // default, so only an explicit dark choice is kept.
  if (p.theme === 'dark') return 'dark'
  return defaults.themePref
}

function validateFontSize(s: unknown): number {
  const n = typeof s === 'number' ? s : defaults.fontSize
  return (FONT_SIZES as readonly number[]).includes(n) ? n : defaults.fontSize
}

function validateTraceColors(arr: unknown): string[] {
  const out = Array(TRACE_COLOR_SLOT_COUNT).fill('') as string[]
  if (!Array.isArray(arr)) return out
  for (let i = 0; i < TRACE_COLOR_SLOT_COUNT; i++) {
    const v = arr[i]
    if (typeof v === 'string') out[i] = v
  }
  return out
}

function stateFromPrefs(p: PersistedPrefs) {
  const themePref = validatePref(p)
  return {
    themePref,
    theme: resolveTheme(themePref),
    fontSize: validateFontSize(p.fontSize),
    traceColors: validateTraceColors(p.traceColors),
  }
}

// Sync load for immediate store creation (prevents first-paint flash)
const saved = loadPrefsSync()

export const useThemeStore = create<ThemeState>((set, get) => {
  const commit = (patch: Partial<ThemeState>) => {
    set(patch)
    const s = get(); applyToDOM(s); savePrefs(s)
  }

  return {
    ...stateFromPrefs(saved),

    setTheme: (t) => commit({ themePref: t, theme: t }),

    setThemePref: (p) => commit({ themePref: p, theme: resolveTheme(p) }),

    toggleTheme: () => {
      const next: ThemeName = get().theme === 'dark' ? 'light' : 'dark'
      commit({ themePref: next, theme: next })
    },

    setFontSize: (sz) => commit({ fontSize: sz }),

    setTraceColor: (slot, color) => {
      if (slot < 0 || slot >= TRACE_COLOR_SLOT_COUNT) return
      const next = [...get().traceColors]
      next[slot] = color
      commit({ traceColors: next })
    },

    resetTraceColors: () => commit({ traceColors: Array(TRACE_COLOR_SLOT_COUNT).fill('') }),

    /**
     * Called once on mount in every window. Applies the synchronously
     * loaded values, hydrates from the Electron prefs file, then keeps
     * the window in step with the OS setting and with other windows.
     */
    initTheme: async () => {
      applyToDOM(get())

      const filePrefs = await loadPrefsAsync()
      if (filePrefs && Object.keys(filePrefs).length > 0) {
        set(stateFromPrefs(filePrefs))
        const s = get()
        applyToDOM(s)
        try { localStorage.setItem(LS_KEY, JSON.stringify(prefsFromState(s))) } catch { /* ignore */ }
      }

      if (!(window as any).__tracerThemeListeners) {
        (window as any).__tracerThemeListeners = true
        // OS light / dark changes while "System" is selected.
        darkQuery?.addEventListener('change', () => {
          const s = get()
          if (s.themePref !== 'system') return
          const theme = resolveTheme('system')
          if (theme !== s.theme) { set({ theme }); applyToDOM(get()) }
        })
        // Another window saved new prefs.
        window.addEventListener('storage', (e) => {
          if (e.key !== LS_KEY || !e.newValue) return
          try {
            set(stateFromPrefs(JSON.parse(e.newValue)))
            applyToDOM(get())
          } catch { /* ignore */ }
        })
      }
    },
  }
})

/** Changes whenever anything a plot bakes into its uPlot options
 *  changes (theme, text size, trace colours). Add it to the deps of
 *  the effect that builds the plot so it rebuilds on a theme switch. */
export function useThemeKey(): string {
  return useThemeStore((s) => `${s.theme}|${s.fontSize}|${s.traceColors.join(',')}`)
}
