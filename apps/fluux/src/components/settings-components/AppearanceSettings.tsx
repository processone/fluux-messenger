import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sun, Moon, Monitor, Upload, Trash2, Pencil, Plus, RotateCcw } from 'lucide-react'
import { useSettingsStore, type ThemeMode, type DensityMode } from '@/stores/settingsStore'
import { useThemeStore } from '@/stores/themeStore'
import type { ThemeDefinition, AccentPreset } from '@/themes/types'
import { getBuiltinTheme } from '@/themes/builtins'
import { ModalShell } from '@/components/ModalShell'
import { TextInput, TextArea } from '../ui/TextInput'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { SettingsGroup } from '@/components/ui/SettingsGroup'
import { SettingsRow } from '@/components/ui/SettingsRow'
import { Toggle } from '@/components/ui/Toggle'

const themeOptions: { value: ThemeMode; labelKey: string; icon: typeof Sun; descriptionKey: string }[] = [
  { value: 'dark', labelKey: 'settings.dark', icon: Moon, descriptionKey: 'settings.darkDescription' },
  { value: 'light', labelKey: 'settings.light', icon: Sun, descriptionKey: 'settings.lightDescription' },
  { value: 'system', labelKey: 'settings.system', icon: Monitor, descriptionKey: 'settings.systemDescription' },
]

const densityOptions: { value: DensityMode; labelKey: string; descriptionKey: string }[] = [
  { value: 'comfortable', labelKey: 'settings.comfortable', descriptionKey: 'settings.densityComfortableDescription' },
  { value: 'compact', labelKey: 'settings.compact', descriptionKey: 'settings.densityCompactDescription' },
]

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
      className={`relative flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all text-start
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
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              e.preventDefault()
              onRemove()
            }
          }}
          className="absolute -top-1.5 -end-1.5 p-0.5 rounded-full bg-fluux-surface text-fluux-muted hover:text-fluux-error hover:bg-fluux-hover transition-colors cursor-pointer"
          title="Remove"
        >
          <Trash2 className="size-3" />
        </div>
      )}
    </button>
  )
}

/** Accent color dot for the accent picker */
function AccentDot({
  preset,
  isSelected,
  isDark,
  onSelect,
}: {
  preset: AccentPreset
  isSelected: boolean
  isDark: boolean
  onSelect: () => void
}) {
  const hsl = isDark ? preset.dark : preset.light
  const color = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`
  return (
    <button
      onClick={onSelect}
      title={preset.name}
      className={`size-7 rounded-full shrink-0 transition-all ring-offset-2 ring-offset-fluux-bg
        ${isSelected ? 'ring-2 ring-fluux-brand scale-110' : 'hover:scale-110'}`}
      style={{ backgroundColor: color }}
    />
  )
}

/** Modal for editing CSS snippet content */
function SnippetEditorModal({
  snippet,
  onClose,
  onSave,
}: {
  snippet: { id: string; filename: string; css: string } | null
  onClose: () => void
  onSave: (filename: string, css: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(snippet?.filename ?? 'custom.css')
  const [css, setCss] = useState(snippet?.css ?? '')

  function handleSave() {
    const filename = name.endsWith('.css') ? name : `${name}.css`
    onSave(filename, css)
    onClose()
  }

  return (
    <ModalShell title={snippet ? t('settings.editSnippet') : t('settings.addCustomCss')} onClose={onClose} width="max-w-lg">
      <div className="p-4 space-y-4">
        {/* Name field */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-fluux-muted">{t('settings.snippetName')}</label>
          <TextInput
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-fluux-bg text-fluux-text rounded-lg border border-fluux-hover focus:border-fluux-brand outline-none"
            placeholder="my-tweaks.css"
          />
        </div>

        {/* CSS editor */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-fluux-muted">CSS</label>
          <TextArea
            value={css}
            onChange={(e) => setCss(e.target.value)}
            className="w-full h-48 px-3 py-2 text-sm font-mono bg-fluux-bg text-fluux-text rounded-lg border border-fluux-hover focus:border-fluux-brand outline-none resize-y"
            placeholder={`/* Example: make the sidebar wider */\n.sidebar {\n  min-width: 300px;\n}\n\n/* Override a theme variable */\n:root {\n  --fluux-bg-accent: #e06c75;\n}`}
            spellCheck={false}
          />
        </div>

        <p className="text-xs text-fluux-muted">
          {t('settings.snippetsDescription')}
        </p>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-fluux-muted hover:text-fluux-text rounded-lg hover:bg-fluux-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!css.trim()}
            className="px-3 py-1.5 text-sm text-fluux-text-on-accent bg-fluux-brand hover:bg-fluux-brand-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}


export function AppearanceSettings() {
  const { t } = useTranslation()
  const themeMode = useSettingsStore((s) => s.themeMode)
  const setThemeMode = useSettingsStore((s) => s.setThemeMode)
  const densityMode = useSettingsStore((s) => s.densityMode)
  const setDensityMode = useSettingsStore((s) => s.setDensityMode)

  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme)
  const getAllThemes = useThemeStore((s) => s.getAllThemes)
  const installTheme = useThemeStore((s) => s.installTheme)
  const removeTheme = useThemeStore((s) => s.removeTheme)
  const accentPreset = useThemeStore((s) => s.accentPreset)
  const setAccentPreset = useThemeStore((s) => s.setAccentPreset)
  const clearAccentPreset = useThemeStore((s) => s.clearAccentPreset)
  const getAccentPresets = useThemeStore((s) => s.getAccentPresets)
  const snippets = useThemeStore((s) => s.snippets)
  const toggleSnippet = useThemeStore((s) => s.toggleSnippet)
  const addSnippet = useThemeStore((s) => s.addSnippet)
  const removeSnippet = useThemeStore((s) => s.removeSnippet)

  const themeInputRef = useRef<HTMLInputElement>(null)
  const [editingSnippet, setEditingSnippet] = useState<{ id: string; filename: string; css: string } | null>(null)
  const [showNewSnippet, setShowNewSnippet] = useState(false)

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
    e.target.value = ''
  }

  return (
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.appearance')}>
        <div className="space-y-6">
          {/* 1. Mode */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-fluux-text">{t('settings.mode')}</label>
            <div className="grid w-full grid-cols-3 gap-3">
              {themeOptions.map((option) => {
                const Icon = option.icon
                const isSelected = themeMode === option.value
                return (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => setThemeMode(option.value)}
                    aria-pressed={isSelected}
                    className={`flex min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border-2 p-4 text-center transition-all
                      ${isSelected
                        ? 'border-fluux-brand bg-fluux-brand/10'
                        : 'border-fluux-hover bg-fluux-bg hover:border-fluux-muted'
                      }`}
                  >
                    <Icon className={`size-6 ${isSelected ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                    <span className={`min-w-0 text-sm font-medium leading-tight ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
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

          {/* Display density */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-fluux-text">{t('settings.density')}</label>
            <div className="grid w-full grid-cols-2 gap-3">
              {densityOptions.map((option) => {
                const isSelected = densityMode === option.value
                return (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => setDensityMode(option.value)}
                    aria-pressed={isSelected}
                    className={`flex min-h-16 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border-2 p-4 text-center transition-all
                      ${isSelected ? 'border-fluux-brand bg-fluux-brand/10' : 'border-fluux-hover bg-fluux-bg hover:border-fluux-muted'}`}
                  >
                    <span className={`min-w-0 text-sm font-medium leading-tight ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
                      {t(option.labelKey)}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-fluux-muted mt-2">
              {t(densityOptions.find(o => o.value === densityMode)?.descriptionKey || '')}
            </p>
          </div>

          {/* 2. Theme picker */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-fluux-text">{t('settings.theme')}</label>
            <div className="grid w-full grid-cols-4 gap-2">
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
            <button
              onClick={() => themeInputRef.current?.click()}
              className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
            >
              <Upload className="size-3.5" />
              {t('settings.importTheme')}
            </button>
            <input
              ref={themeInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleThemeImport}
            />
          </div>

          {/* 4. Accent color picker */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-fluux-text">{t('settings.accentColor')}</label>
            <div className="flex flex-wrap gap-2 items-center">
              {/* Theme Default reset button */}
              <button
                onClick={() => clearAccentPreset()}
                title={t('settings.accentThemeDefault')}
                className={`size-7 rounded-full shrink-0 transition-all ring-offset-2 ring-offset-fluux-bg
                  flex items-center justify-center border-2 border-dashed
                  ${!accentPreset
                    ? 'ring-2 ring-fluux-brand scale-110 border-fluux-brand'
                    : 'border-fluux-muted hover:scale-110 hover:border-fluux-text'
                  }`}
              >
                <RotateCcw className="size-3 text-fluux-muted" />
              </button>
              {/* Accent presets */}
              {getAccentPresets().map((preset) => (
                <AccentDot
                  key={preset.name}
                  preset={preset}
                  isSelected={accentPreset?.name === preset.name}
                  isDark={isDark}
                  onSelect={() => setAccentPreset(preset)}
                />
              ))}
            </div>
          </div>
        </div>
      </SettingsSection>

      {/* 5. CSS Snippets (advanced) */}
      <SettingsSection title={t('settings.cssSnippets')} className="mt-6">
        {snippets.length > 0 && (
          <SettingsGroup className="mb-3">
            {snippets.map((snippet) => (
              <SettingsRow key={snippet.id} label={snippet.filename}>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setEditingSnippet(snippet)}
                    className="p-1 text-fluux-muted hover:text-fluux-text transition-colors"
                    title={t('settings.editSnippet')}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    onClick={() => removeSnippet(snippet.id)}
                    className="p-1 text-fluux-muted hover:text-fluux-error transition-colors"
                    title={t('settings.removeTheme')}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                  <Toggle
                    checked={snippet.enabled}
                    onChange={() => toggleSnippet(snippet.id)}
                    aria-label={snippet.filename}
                  />
                </div>
              </SettingsRow>
            ))}
          </SettingsGroup>
        )}
        <button
          onClick={() => setShowNewSnippet(true)}
          className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
        >
          <Plus className="size-3.5" />
          {t('settings.addCustomCss')}
        </button>
      </SettingsSection>

      {/* Snippet editor modal */}
      {(showNewSnippet || editingSnippet) && (
        <SnippetEditorModal
          snippet={editingSnippet}
          onClose={() => {
            setShowNewSnippet(false)
            setEditingSnippet(null)
          }}
          onSave={(filename, css) => {
            addSnippet(filename, css)
          }}
        />
      )}
    </section>
  )
}
