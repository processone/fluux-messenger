import { useLayoutEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { BottomSheet } from '../ui/BottomSheet'
import { Avatar } from '../Avatar'

export interface ReactorDetails {
  name: string
  avatarUrl?: string
  avatarIdentifier: string
}

interface MessageReactorsSheetProps {
  reactions: Record<string, string[]>
  initialEmoji: string
  getReactorName: (id: string) => string
  getReactorDetails?: (id: string) => ReactorDetails
  onClose: () => void
}

export function MessageReactorsSheet({ reactions, initialEmoji, getReactorName, getReactorDetails, onClose }: MessageReactorsSheetProps) {
  const { t } = useTranslation()
  const id = useId()
  const tabsRef = useRef<HTMLDivElement>(null)
  const focusedTab = useRef<HTMLElement | null>(null)
  const [selectedEmoji, setSelectedEmoji] = useState(initialEmoji)
  const entries = Object.entries(reactions).filter(([, reactors]) => reactors.length > 0).sort((a, b) => b[1].length - a[1].length)
  const selectedIndex = Math.max(0, entries.findIndex(([emoji]) => emoji === selectedEmoji))
  const [emoji, reactors] = entries[selectedIndex] ?? ['', []]

  useLayoutEffect(() => {
    const selected = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (focusedTab.current && !focusedTab.current.isConnected) selected?.focus({ preventScroll: true })
  }, [emoji, reactions])

  useLayoutEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selectedEmoji])

  return (
    <BottomSheet open onClose={onClose} ariaLabel={t('chat.reactions')}>
      <div className="flex items-center justify-between px-4 pb-2">
        <h2 className="text-base font-semibold text-fluux-text">{t('chat.reactions')}</h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex size-11 items-center justify-center rounded-lg text-fluux-muted hover:bg-fluux-hover">
          <X className="size-5" />
        </button>
      </div>
      <div ref={tabsRef} role="tablist" aria-label={t('chat.reactions')} className="flex gap-2 overflow-x-auto border-b border-fluux-border px-4 pb-3" onFocusCapture={(event) => { focusedTab.current = event.target as HTMLElement }} onBlurCapture={() => { focusedTab.current = null }}>
        {entries.map(([tabEmoji, users], index) => (
          <button
            key={tabEmoji}
            type="button"
            role="tab"
            aria-label={`${tabEmoji} ${users.length}`}
            id={`${id}-tab-${index}`}
            aria-controls={`${id}-panel`}
            aria-selected={tabEmoji === emoji}
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => setSelectedEmoji(tabEmoji)}
            onKeyDown={(event) => {
              const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
              const delta = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0
              if (!delta && event.key !== 'Home' && event.key !== 'End') return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + delta + entries.length) % entries.length
              setSelectedEmoji(entries[next][0])
              const target = tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
              target?.focus()
              target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
            }}
            className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 ${index === selectedIndex ? 'border-fluux-brand bg-fluux-brand/20' : 'border-fluux-border hover:bg-fluux-hover'}`}
          >
            <span className="text-xl">{tabEmoji}</span>
            <span className="text-sm text-fluux-muted">{users.length}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${selectedIndex}`} tabIndex={0} className="px-4 py-2">
        <ul>
          {reactors.map((reactor) => {
            const details = getReactorDetails?.(reactor) ?? { name: getReactorName(reactor), avatarIdentifier: reactor }
            return (
              <li key={reactor} className="flex min-h-14 items-center gap-3 py-2">
                <Avatar identifier={details.avatarIdentifier} name={details.name} avatarUrl={details.avatarUrl} size="md" />
                <span className="min-w-0 break-words text-sm text-fluux-text">{details.name}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </BottomSheet>
  )
}
