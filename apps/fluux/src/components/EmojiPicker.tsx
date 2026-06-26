import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasHover } from '@/hooks'
import { useSettingsStore, type ThemeMode } from '@/stores/settingsStore'
import data from '@emoji-mart/data'
import { Picker } from 'emoji-mart'

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return mode
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<InstanceType<typeof Picker> | null>(null)
  const { i18n } = useTranslation()
  const themeMode = useSettingsStore((s) => s.themeMode)
  const theme = resolveTheme(themeMode)
  // Only auto-focus the search on devices with a real keyboard. On touch the
  // emoji-mart search field would summon the on-screen keyboard, which covers
  // the emoji grid (especially inside the mobile reaction bottom sheet).
  const hasHover = useHasHover()

  // Callers pass fresh inline onSelect/onClose closures every render. Read them
  // through refs so the mount effect below does NOT depend on their identity —
  // otherwise a parent re-render while the picker is open (background presence/
  // typing/MAM churn re-rendering the message bubble) would tear down and
  // rebuild the emoji-mart web component, which reads as a flicker ("menu
  // disappears and reappears") and swallows the in-flight emoji click.
  const onSelectRef = useRef(onSelect)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onSelectRef.current = onSelect
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!containerRef.current) return

    // emoji-mart Picker is a web component — mount it imperatively
    const picker = new Picker({
      data,
      theme,
      onEmojiSelect: (emoji: { native: string }) => onSelectRef.current(emoji.native),
      searchPosition: 'sticky',
      previewPosition: 'none',
      skinTonePosition: 'search',
      perLine: 8,
      maxFrequentRows: 1,
      locale: i18n.language.split('-')[0], // e.g. 'en' from 'en-US'
      autoFocus: hasHover,
    })

    pickerRef.current = picker
    const container = containerRef.current
    container.appendChild(picker as unknown as Node)

    return () => {
      pickerRef.current = null
      // Clean up: remove the picker element
      container.replaceChildren()
    }
    // Re-create picker only when theme, locale, or hover capability changes —
    // never on callback identity (see the ref indirection above).
  }, [theme, i18n.language, hasHover])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return <div ref={containerRef} />
}
