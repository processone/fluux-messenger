import { useTranslation } from 'react-i18next'
import { Monitor, Sparkles, CircleSlash } from 'lucide-react'
import { useSettingsStore, type MotionPreference, type TransparencyMode } from '@/stores/settingsStore'
import { SettingsSection } from '@/components/ui/SettingsSection'

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

  return (
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.accessibility')}>
        <div className="space-y-6">
        {/* Animation */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-fluux-text">{t('settings.motion')}</label>
          <div className="grid w-full grid-cols-3 gap-3">
            {motionOptions.map((option) => {
              const Icon = option.icon
              const isSelected = motionPreference === option.value
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => setMotionPreference(option.value)}
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
            {t(motionOptions.find(o => o.value === motionPreference)?.descriptionKey || '')}
          </p>
        </div>

        {/* Transparency */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-fluux-text">{t('settings.transparency')}</label>
          <div className="grid w-full grid-cols-3 gap-3">
            {transparencyOptions.map((option) => {
              const Icon = option.icon
              const isSelected = transparencyMode === option.value
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => setTransparencyMode(option.value)}
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
            {t(transparencyOptions.find(o => o.value === transparencyMode)?.descriptionKey || '')}
          </p>
        </div>

        {/* Character size */}
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
        </div>
      </SettingsSection>
    </section>
  )
}
