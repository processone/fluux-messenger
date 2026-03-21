import { create } from 'zustand'
import type { ThemeDefinition, SnippetState } from '@/themes/types'
import { builtinThemes, getBuiltinTheme } from '@/themes/builtins'

const THEME_STORE_KEY = 'fluux-theme-store'

interface PersistedThemeState {
  activeThemeId: string
  customThemes: ThemeDefinition[]
  snippets: SnippetState[]
}

interface ThemeState extends PersistedThemeState {
  /** Set the active theme by ID (built-in or custom) */
  setActiveTheme: (id: string) => void
  /** Install a custom theme (replaces if same ID exists) */
  installTheme: (theme: ThemeDefinition) => void
  /** Remove a custom theme by ID (cannot remove built-in themes) */
  removeTheme: (id: string) => void
  /** Toggle a snippet on/off */
  toggleSnippet: (id: string) => void
  /** Add a new CSS snippet */
  addSnippet: (filename: string, css: string) => void
  /** Remove a snippet by ID */
  removeSnippet: (id: string) => void
  /** Get the active theme definition (built-in or custom) */
  getActiveTheme: () => ThemeDefinition | undefined
  /** Get all available themes (built-in + custom) */
  getAllThemes: () => ThemeDefinition[]
}

function loadPersistedState(): PersistedThemeState {
  try {
    const stored = localStorage.getItem(THEME_STORE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        activeThemeId: parsed.activeThemeId || 'fluux',
        customThemes: Array.isArray(parsed.customThemes) ? parsed.customThemes : [],
        snippets: Array.isArray(parsed.snippets) ? parsed.snippets : [],
      }
    }
  } catch {
    // localStorage not available or corrupted
  }
  return { activeThemeId: 'fluux', customThemes: [], snippets: [] }
}

function persistState(state: PersistedThemeState) {
  try {
    localStorage.setItem(THEME_STORE_KEY, JSON.stringify({
      activeThemeId: state.activeThemeId,
      customThemes: state.customThemes,
      snippets: state.snippets,
    }))
  } catch {
    // localStorage not available
  }
}

/** Derive a snippet ID from its filename */
function snippetId(filename: string): string {
  return filename.replace(/\.css$/i, '').replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = loadPersistedState()

  return {
    ...initial,

    setActiveTheme: (id) => {
      set({ activeThemeId: id })
      persistState({ ...get(), activeThemeId: id })
    },

    installTheme: (theme) => {
      const current = get().customThemes.filter((t) => t.id !== theme.id)
      const customThemes = [...current, theme]
      set({ customThemes })
      persistState({ ...get(), customThemes })
    },

    removeTheme: (id) => {
      // Cannot remove built-in themes
      if (getBuiltinTheme(id)) return

      const customThemes = get().customThemes.filter((t) => t.id !== id)
      const activeThemeId = get().activeThemeId === id ? 'fluux' : get().activeThemeId
      set({ customThemes, activeThemeId })
      persistState({ ...get(), customThemes, activeThemeId })
    },

    toggleSnippet: (id) => {
      const snippets = get().snippets.map((s) =>
        s.id === id ? { ...s, enabled: !s.enabled } : s
      )
      set({ snippets })
      persistState({ ...get(), snippets })
    },

    addSnippet: (filename, css) => {
      const id = snippetId(filename)
      const existing = get().snippets.filter((s) => s.id !== id)
      const snippets = [...existing, { id, filename, enabled: true, css }]
      set({ snippets })
      persistState({ ...get(), snippets })
    },

    removeSnippet: (id) => {
      const snippets = get().snippets.filter((s) => s.id !== id)
      set({ snippets })
      persistState({ ...get(), snippets })
    },

    getActiveTheme: () => {
      const { activeThemeId, customThemes } = get()
      return getBuiltinTheme(activeThemeId) ?? customThemes.find((t) => t.id === activeThemeId)
    },

    getAllThemes: () => {
      return [...builtinThemes, ...get().customThemes]
    },
  }
})
