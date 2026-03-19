import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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

  useEffect(() => {
    if (!containerRef.current) return

    // emoji-mart Picker is a web component — mount it imperatively
    const picker = new Picker({
      data,
      theme,
      onEmojiSelect: (emoji: { native: string }) => onSelect(emoji.native),
      searchPosition: 'sticky',
      previewPosition: 'none',
      skinTonePosition: 'search',
      perLine: 8,
      maxFrequentRows: 1,
      locale: i18n.language.split('-')[0], // e.g. 'en' from 'en-US'
      autoFocus: true,
    })

    pickerRef.current = picker
    containerRef.current.appendChild(picker as unknown as Node)

    return () => {
      pickerRef.current = null
      // Clean up: remove the picker element
      if (containerRef.current) {
        containerRef.current.replaceChildren()
      }
    }
    // Re-create picker when theme or locale changes
  }, [theme, i18n.language, onSelect])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return <div ref={containerRef} />
}
