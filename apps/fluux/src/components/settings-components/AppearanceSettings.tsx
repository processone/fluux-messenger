import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Sun, Moon, Monitor, Upload, Trash2, FolderOpen } from 'lucide-react'
import { useSettingsStore, type ThemeMode } from '@/stores/settingsStore'
import { useThemeStore } from '@/stores/themeStore'
import type { ThemeDefinition } from '@/themes/types'
import { getBuiltinTheme } from '@/themes/builtins'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const themeOptions: { value: ThemeMode; labelKey: string; icon: typeof Sun; descriptionKey: string }[] = [
  { value: 'dark', labelKey: 'settings.dark', icon: Moon, descriptionKey: 'settings.darkDescription' },
  { value: 'light', labelKey: 'settings.light', icon: Sun, descriptionKey: 'settings.lightDescription' },
  { value: 'system', labelKey: 'settings.system', icon: Monitor, descriptionKey: 'settings.systemDescription' },
]

const FONT_SIZE_MIN = 75
const FONT_SIZE_MAX = 150
const FONT_SIZE_STEP = 5

/** Render a strip of color swatches for a theme */
function ThemeSwatches({ colors }: { colors?: string[] }) {
  if (!colors?.length) return null
  return (
    <div className="flex gap-0.5 w-full h-3 rounded overflow-hidden">
      {colors.map((color, i) => (
        <div key={i} className="flex-1" style={{ backgroundColor: color }} />
      ))}
    </div>
  )
}

/** Theme card for the theme picker grid */
function ThemeCard({
  theme,
  isActive,
  isDark,
  onSelect,
  onRemove,
  isBuiltIn,
}: {
  theme: ThemeDefinition
  isActive: boolean
  isDark: boolean
  onSelect: () => void
  onRemove?: () => void
  isBuiltIn: boolean
}) {
  const swatches = isDark ? theme.swatches?.dark : theme.swatches?.light

  return (
    <button
      onClick={onSelect}
      className={`relative flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all text-left
        ${isActive
          ? 'border-fluux-brand bg-fluux-brand/10'
          : 'border-fluux-hover bg-fluux-bg hover:border-fluux-muted'
        }`}
    >
      <ThemeSwatches colors={swatches} />
      <span className={`text-xs font-medium truncate w-full text-center ${isActive ? 'text-fluux-text' : 'text-fluux-muted'}`}>
        {theme.name}
      </span>
      {!isBuiltIn && onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="absolute top-1 right-1 p-0.5 rounded text-fluux-muted hover:text-fluux-red hover:bg-fluux-hover transition-colors"
          title="Remove"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </button>
  )
}

export function AppearanceSettings() {
  const { t } = useTranslation()
  const themeMode = useSettingsStore((s) => s.themeMode)
  const setThemeMode = useSettingsStore((s) => s.setThemeMode)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const setFontSize = useSettingsStore((s) => s.setFontSize)

  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme)
  const getAllThemes = useThemeStore((s) => s.getAllThemes)
  const installTheme = useThemeStore((s) => s.installTheme)
  const removeTheme = useThemeStore((s) => s.removeTheme)
  const snippets = useThemeStore((s) => s.snippets)
  const toggleSnippet = useThemeStore((s) => s.toggleSnippet)
  const addSnippet = useThemeStore((s) => s.addSnippet)
  const removeSnippet = useThemeStore((s) => s.removeSnippet)

  const themeInputRef = useRef<HTMLInputElement>(null)
  const snippetInputRef = useRef<HTMLInputElement>(null)

  const allThemes = getAllThemes()
  const isDark = themeMode === 'dark' || (themeMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  /** Handle theme JSON file import */
  function handleThemeImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const theme = JSON.parse(reader.result as string) as ThemeDefinition
        if (!theme.id || !theme.name || !theme.variables) {
          console.error('Invalid theme file: missing required fields (id, name, variables)')
          return
        }
        installTheme(theme)
        setActiveTheme(theme.id)
      } catch {
        console.error('Failed to parse theme file')
      }
    }
    reader.readAsText(file)
    // Reset input so the same file can be re-imported
    e.target.value = ''
  }

  /** Handle CSS snippet file import */
  function handleSnippetImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      addSnippet(file.name, reader.result as string)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  /** Open themes/snippets folder (Tauri desktop only) */
  async function openFolder(subdir: string) {
    if (!isTauri) return
    try {
      const { appConfigDir } = await import('@tauri-apps/api/path')
      const { open } = await import('@tauri-apps/plugin-shell')
      const configDir = await appConfigDir()
      await open(`${configDir}${subdir}`)
    } catch {
      // Ignore errors
    }
  }

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.appearance')}
      </h3>

      <div className="space-y-6">
        {/* Theme picker */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-fluux-text">{t('settings.theme')}</label>
          <div className="grid grid-cols-4 gap-2">
            {allThemes.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                isActive={activeThemeId === theme.id}
                isDark={isDark}
                onSelect={() => setActiveTheme(theme.id)}
                onRemove={() => removeTheme(theme.id)}
                isBuiltIn={!!getBuiltinTheme(theme.id)}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => themeInputRef.current?.click()}
              className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              {t('settings.importTheme')}
            </button>
            {isTauri && (
              <button
                onClick={() => openFolder('themes')}
                className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t('settings.openThemesFolder')}
              </button>
            )}
          </div>
          <input
            ref={themeInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleThemeImport}
          />
        </div>

        {/* Theme mode */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-fluux-text">{t('settings.mode')}</label>
          <div className="grid grid-cols-3 gap-3">
            {themeOptions.map((option) => {
              const Icon = option.icon
              const isSelected = themeMode === option.value
              return (
                <button
                  key={option.value}
                  onClick={() => setThemeMode(option.value)}
                  className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all
                    ${isSelected
                      ? 'border-fluux-brand bg-fluux-brand/10'
                      : 'border-fluux-hover bg-fluux-bg hover:border-fluux-muted'
                    }`}
                >
                  <Icon className={`w-6 h-6 ${isSelected ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                  <span className={`text-sm font-medium ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
                    {t(option.labelKey)}
                  </span>
                </button>
              )
            })}
          </div>
          <p className="text-xs text-fluux-muted mt-2">
            {t(themeOptions.find(o => o.value === themeMode)?.descriptionKey || '')}
          </p>
        </div>

        {/* CSS Snippets */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-fluux-text">{t('settings.cssSnippets')}</label>
          {snippets.length > 0 ? (
            <div className="space-y-1">
              {snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-fluux-bg"
                >
                  <span className="text-sm text-fluux-text truncate flex-1">{snippet.filename}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => removeSnippet(snippet.id)}
                      className="p-1 text-fluux-muted hover:text-fluux-red transition-colors"
                      title={t('settings.removeTheme')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => toggleSnippet(snippet.id)}
                      className={`relative w-9 h-5 rounded-full transition-colors ${
                        snippet.enabled ? 'bg-fluux-brand' : 'bg-fluux-hover'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          snippet.enabled ? 'translate-x-4' : ''
                        }`}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-fluux-muted">{t('settings.noSnippets')}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => snippetInputRef.current?.click()}
              className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              {t('settings.importSnippet')}
            </button>
            {isTauri && (
              <button
                onClick={() => openFolder('snippets')}
                className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t('settings.openSnippetsFolder')}
              </button>
            )}
          </div>
          <input
            ref={snippetInputRef}
            type="file"
            accept=".css"
            className="hidden"
            onChange={handleSnippetImport}
          />
        </div>

        {/* Font size */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-fluux-text">{t('settings.fontSize')}</label>
            <span className="text-sm text-fluux-muted">{fontSize}%</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-fluux-muted shrink-0">A</span>
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={FONT_SIZE_STEP}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-full accent-fluux-brand"
            />
            <span className="text-base font-medium text-fluux-muted shrink-0">A</span>
          </div>
          <p className="text-xs text-fluux-muted">
            {t('settings.fontSizeDescription')}
          </p>
        </div>
      </div>
    </section>
  )
}
