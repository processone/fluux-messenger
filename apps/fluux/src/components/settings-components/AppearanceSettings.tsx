import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sun, Moon, Monitor, Upload, Trash2, Pencil, Plus, RotateCcw } from 'lucide-react'
import { useSettingsStore, type ThemeMode } from '@/stores/settingsStore'
import { useThemeStore } from '@/stores/themeStore'
import type { ThemeDefinition, AccentPreset } from '@/themes/types'
import { getBuiltinTheme } from '@/themes/builtins'
import { ModalShell } from '@/components/ModalShell'
import { TextInput, TextArea } from '../ui/TextInput'

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
          className="absolute -top-1.5 -end-1.5 p-0.5 rounded-full bg-fluux-surface text-fluux-muted hover:text-fluux-red hover:bg-fluux-hover transition-colors cursor-pointer"
          title="Remove"
        >
          <Trash2 className="w-3 h-3" />
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
      className={`w-7 h-7 rounded-full shrink-0 transition-all ring-offset-2 ring-offset-fluux-bg
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
  const fontSize = useSettingsStore((s) => s.fontSize)
  const setFontSize = useSettingsStore((s) => s.setFontSize)

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
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.appearance')}
      </h3>

      <div className="space-y-6">
        {/* 1. Mode */}
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

        {/* 2. Font size */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-fluux-text">{t('settings.fontSize')}</label>
            <span className="text-sm text-fluux-muted">{fontSize}%</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setFontSize(fontSize - FONT_SIZE_STEP)}
              className="text-xs text-fluux-muted shrink-0 cursor-pointer hover:text-fluux-text transition-colors"
              aria-label={t('settings.decreaseFontSize')}
            >A</button>
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={FONT_SIZE_STEP}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-full accent-fluux-brand"
            />
            <button
              type="button"
              onClick={() => setFontSize(fontSize + FONT_SIZE_STEP)}
              className="text-base font-medium text-fluux-muted shrink-0 cursor-pointer hover:text-fluux-text transition-colors"
              aria-label={t('settings.increaseFontSize')}
            >A</button>
          </div>
          <p className="text-xs text-fluux-muted">
            {t('settings.fontSizeDescription')}
          </p>
        </div>

        {/* 3. Theme picker */}
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
          <button
            onClick={() => themeInputRef.current?.click()}
            className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
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
              className={`w-7 h-7 rounded-full shrink-0 transition-all ring-offset-2 ring-offset-fluux-bg
                flex items-center justify-center border-2 border-dashed
                ${!accentPreset
                  ? 'ring-2 ring-fluux-brand scale-110 border-fluux-brand'
                  : 'border-fluux-muted hover:scale-110 hover:border-fluux-text'
                }`}
            >
              <RotateCcw className="w-3 h-3 text-fluux-muted" />
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

        {/* 5. CSS Snippets (advanced) */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-fluux-text">{t('settings.cssSnippets')}</label>
          {snippets.length > 0 && (
            <div className="space-y-1">
              {snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-fluux-bg"
                >
                  <span className="text-sm text-fluux-text truncate flex-1">{snippet.filename}</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setEditingSnippet(snippet)}
                      className="p-1 text-fluux-muted hover:text-fluux-text transition-colors"
                      title={t('settings.editSnippet')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
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
                        className={`absolute top-0.5 start-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          snippet.enabled ? 'translate-x-4' : ''
                        }`}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => setShowNewSnippet(true)}
            className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('settings.addCustomCss')}
          </button>
        </div>
      </div>

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
