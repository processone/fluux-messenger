import { useTranslation } from 'react-i18next'
import { Monitor, Sparkles, CircleSlash } from 'lucide-react'
import { useSettingsStore, READING_WIDTH_MIN, READING_WIDTH_MAX, READING_WIDTH_STEP, type MotionPreference, type TransparencyMode } from '@/stores/settingsStore'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { SettingsRow } from '@/components/ui/SettingsRow'
import { Toggle } from '@/components/ui/Toggle'
import { platform } from '@/platform'

const motionOptions: { value: MotionPreference; labelKey: string; icon: typeof Monitor; descriptionKey: string }[] = [
  { value: 'full', labelKey: 'settings.motionFull', icon: Sparkles, descriptionKey: 'settings.motionFullDescription' },
  { value: 'reduced', labelKey: 'settings.motionReduced', icon: CircleSlash, descriptionKey: 'settings.motionReducedDescription' },
  { value: 'system', labelKey: 'settings.system', icon: Monitor, descriptionKey: 'settings.motionSystemDescription' },
]

const transparencyOptions: { value: TransparencyMode; labelKey: string; icon: typeof Monitor; descriptionKey: string }[] = [
  { value: 'full', labelKey: 'settings.transparencyFull', icon: Sparkles, descriptionKey: 'settings.transparencyFullDescription' },
  { value: 'reduced', labelKey: 'settings.transparencyReduced', icon: CircleSlash, descriptionKey: 'settings.transparencyReducedDescription' },
  { value: 'system', labelKey: 'settings.system', icon: Monitor, descriptionKey: 'settings.transparencySystemDescription' },
]

const FONT_SIZE_MIN = 75
const FONT_SIZE_MAX = 150
const FONT_SIZE_STEP = 5

export function AccessibilitySettings() {
  const { t } = useTranslation()
  const motionPreference = useSettingsStore((s) => s.motionPreference)
  const setMotionPreference = useSettingsStore((s) => s.setMotionPreference)
  const transparencyMode = useSettingsStore((s) => s.transparencyMode)
  const setTransparencyMode = useSettingsStore((s) => s.setTransparencyMode)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const setFontSize = useSettingsStore((s) => s.setFontSize)

  const readingWidthEnabled = useSettingsStore((s) => s.readingWidthEnabled)
  const setReadingWidthEnabled = useSettingsStore((s) => s.setReadingWidthEnabled)
  const readingWidth = useSettingsStore((s) => s.readingWidth)
  const setReadingWidth = useSettingsStore((s) => s.setReadingWidth)

  return (
    <section className="w-full max-w-md space-y-8">
      <SettingsSection title={t('settings.readingSection')}>
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label htmlFor="accessibility-font-size" className="text-sm font-medium text-fluux-text">{t('settings.fontSize')}</label>
              <output htmlFor="accessibility-font-size" className="text-sm text-fluux-muted">{fontSize}%</output>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setFontSize(fontSize - FONT_SIZE_STEP)}
                disabled={fontSize <= FONT_SIZE_MIN}
                className="tap-target text-xs text-fluux-muted shrink-0 hover:text-fluux-text transition-colors disabled:opacity-40 disabled:cursor-default"
                aria-label={t('settings.decreaseFontSize')}
              >A</button>
              <input
                type="range"
                id="accessibility-font-size"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={FONT_SIZE_STEP}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="w-full min-w-0 accent-fluux-brand"
              />
              <button
                type="button"
                onClick={() => setFontSize(fontSize + FONT_SIZE_STEP)}
                disabled={fontSize >= FONT_SIZE_MAX}
                className="tap-target text-base font-medium text-fluux-muted shrink-0 hover:text-fluux-text transition-colors disabled:opacity-40 disabled:cursor-default"
                aria-label={t('settings.increaseFontSize')}
              >A</button>
            </div>
            {platform().followsSystemTextSize && (
              <p className="text-xs text-fluux-muted">{t('settings.fontSizeSystemDescription')}</p>
            )}
          </div>

          <div className="space-y-3">
            <SettingsRow label={t('settings.limitReadingWidth')} description={t('settings.readingWidthDescription')} className="!p-0">
              <Toggle checked={readingWidthEnabled} onChange={setReadingWidthEnabled} aria-label={t('settings.limitReadingWidth')} />
            </SettingsRow>
            {readingWidthEnabled && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="reading-width" className="text-sm font-medium text-fluux-text">{t('settings.readingWidth')}</label>
                  <output htmlFor="reading-width" className="text-sm text-fluux-muted shrink-0">{readingWidth} px</output>
                </div>
                <input
                  id="reading-width"
                  type="range"
                  min={READING_WIDTH_MIN}
                  max={READING_WIDTH_MAX}
                  step={READING_WIDTH_STEP}
                  value={readingWidth}
                  onChange={(e) => setReadingWidth(Number(e.target.value))}
                  className="w-full min-w-0 accent-fluux-brand"
                />
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.visualEffectsSection')}>
        <div className="space-y-6">
          <div role="group" aria-labelledby="accessibility-motion" className="space-y-3">
            <h4 id="accessibility-motion" className="text-sm font-medium text-fluux-text">{t('settings.motion')}</h4>
            <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-3">
              {motionOptions.map((option) => {
                const Icon = option.icon
                const isSelected = motionPreference === option.value
                return (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => setMotionPreference(option.value)}
                    aria-pressed={isSelected}
                    className={`flex min-h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border-2 p-3 text-center transition-all
                      ${isSelected
                        ? 'border-fluux-brand bg-fluux-brand/10'
                        : 'border-fluux-border bg-fluux-bg hover:border-fluux-muted'
                      }`}
                  >
                    <Icon className={`size-5 ${isSelected ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                    <span className={`min-w-0 text-sm font-medium leading-tight ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
                      {t(option.labelKey)}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-fluux-muted mt-2">
              {t(motionOptions.find(o => o.value === motionPreference)?.descriptionKey || '')}
            </p>
          </div>

          <div role="group" aria-labelledby="accessibility-transparency" className="space-y-3">
            <h4 id="accessibility-transparency" className="text-sm font-medium text-fluux-text">{t('settings.transparency')}</h4>
            <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-3">
              {transparencyOptions.map((option) => {
                const Icon = option.icon
                const isSelected = transparencyMode === option.value
                return (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => setTransparencyMode(option.value)}
                    aria-pressed={isSelected}
                    className={`flex min-h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border-2 p-3 text-center transition-all
                      ${isSelected
                        ? 'border-fluux-brand bg-fluux-brand/10'
                        : 'border-fluux-border bg-fluux-bg hover:border-fluux-muted'
                      }`}
                  >
                    <Icon className={`size-5 ${isSelected ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                    <span className={`min-w-0 text-sm font-medium leading-tight ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
                      {t(option.labelKey)}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-fluux-muted mt-2">
              {t(transparencyOptions.find(o => o.value === transparencyMode)?.descriptionKey || '')}
            </p>
          </div>
        </div>
      </SettingsSection>
    </section>
  )
}
