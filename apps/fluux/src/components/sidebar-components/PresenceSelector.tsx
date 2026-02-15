import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useClickOutside } from '@/hooks'
import { usePresence, type PresenceStatus } from '@fluux/sdk'
import { ChevronDown, Check, RefreshCw } from 'lucide-react'
import { Tooltip } from '../Tooltip'

const presenceOptions: { value: PresenceStatus; labelKey: string; color: string }[] = [
  { value: 'online', labelKey: 'presence.online', color: 'bg-fluux-green' },
  { value: 'away', labelKey: 'presence.away', color: 'bg-fluux-yellow' },
  { value: 'dnd', labelKey: 'presence.dnd', color: 'bg-fluux-red' },
]

interface PresenceSelectorProps {
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function PresenceSelector({ isOpen: isOpenProp, onOpenChange }: PresenceSelectorProps) {
  const { t } = useTranslation()
  const { presenceStatus: presenceShow, statusMessage, setPresence } = usePresence()
  const [isOpenInternal, setIsOpenInternal] = useState(false)

  // Use controlled state if prop is provided, otherwise use internal state
  const isOpen = isOpenProp ?? isOpenInternal
  const setIsOpen = onOpenChange ?? setIsOpenInternal
  const [statusInput, setStatusInput] = useState(statusMessage || '')
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const menuRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const currentOption = presenceOptions.find(p => p.value === presenceShow) || presenceOptions[0]

  // Sync input with store when it changes externally
  useEffect(() => {
    setStatusInput(statusMessage || '')
  }, [statusMessage])

  // Reset focused index when menu opens, set to current selection
  useEffect(() => {
    if (isOpen) {
      const currentIndex = presenceOptions.findIndex(p => p.value === presenceShow)
      setFocusedIndex(currentIndex >= 0 ? currentIndex : 0)
    } else {
      setFocusedIndex(-1)
    }
  }, [isOpen, presenceShow])

  // Close menu when clicking outside
  const closeMenu = useCallback(() => setIsOpen(false), [setIsOpen])
  useClickOutside(menuRef, closeMenu, isOpen)

  // Handle keyboard navigation - use capture phase to intercept before sidebar list
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere if user is typing in the status input
      const target = e.target as HTMLElement
      const isInStatusInput = inputRef.current && target === inputRef.current

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setIsOpen(false)
      } else if (e.key === 'ArrowDown' && !isInStatusInput) {
        e.preventDefault()
        e.stopPropagation()
        // Focus dropdown to prevent focus moving to other elements
        dropdownRef.current?.focus()
        setFocusedIndex(prev => Math.min(prev + 1, presenceOptions.length - 1))
      } else if (e.key === 'ArrowUp' && !isInStatusInput) {
        e.preventDefault()
        e.stopPropagation()
        // Focus dropdown to prevent focus moving to other elements
        dropdownRef.current?.focus()
        setFocusedIndex(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && !isInStatusInput && focusedIndex >= 0) {
        e.preventDefault()
        e.stopPropagation()
        const option = presenceOptions[focusedIndex]
        // presenceOptions only contains online/away/dnd (no offline)
        if (option.value !== 'offline') {
          setPresence(option.value, statusMessage || undefined)
        }
        setIsOpen(false)
      }
    }

    // Use capture phase to intercept events before other handlers
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, focusedIndex, setPresence, statusMessage, setIsOpen])

  const handleSelectPresence = (value: PresenceStatus) => {
    // PresenceStatus includes 'offline' but we only show online/away/dnd options
    if (value !== 'offline') {
      setPresence(value, statusMessage || undefined)
    }
    setIsOpen(false)
  }

  const handleStatusSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // presenceShow comes from the machine, will be 'online', 'away', or 'dnd'
    if (presenceShow !== 'offline') {
      setPresence(presenceShow, statusInput.trim() || undefined)
    }
    setIsOpen(false)
  }

  const handleClearStatus = () => {
    // presenceShow comes from the machine, will be 'online', 'away', or 'dnd'
    if (presenceShow !== 'offline') {
      setPresence(presenceShow, undefined)
    }
    setStatusInput('')
  }

  return (
    <div className="relative" ref={menuRef}>
      {/* Trigger - styled as a distinct chip */}
      <Tooltip content={t('presence.changeStatus')} position="top" disabled={isOpen}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-full bg-fluux-hover hover:bg-fluux-bg border border-transparent hover:border-fluux-muted/30 transition-colors group"
        >
          <span className={`w-2 h-2 rounded-full ${currentOption.color}`} />
          <span className="text-fluux-muted group-hover:text-fluux-text truncate max-w-[80px]">
            {statusMessage || t(currentOption.labelKey)}
          </span>
          <ChevronDown className={`w-3 h-3 text-fluux-muted group-hover:text-fluux-text flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </Tooltip>

      {/* Dropdown */}
      {isOpen && (
        <div
          ref={dropdownRef}
          tabIndex={-1}
          className="absolute bottom-full left-0 mb-2 w-56 bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50 overflow-hidden outline-none"
        >
          {/* Presence options */}
          {presenceOptions.map((option, index) => (
            <button
              key={option.value}
              onClick={() => void handleSelectPresence(option.value)}
              onMouseEnter={() => setFocusedIndex(index)}
              className={`w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text transition-colors ${
                focusedIndex === index ? 'bg-fluux-hover' : 'hover:bg-fluux-hover'
              }`}
            >
              <span className={`w-2.5 h-2.5 rounded-full ${option.color}`} />
              <span className="flex-1">{t(option.labelKey)}</span>
              {presenceShow === option.value && (
                <Check className="w-4 h-4 text-fluux-green" />
              )}
            </button>
          ))}

          {/* Divider */}
          <div className="my-1 border-t border-fluux-hover" />

          {/* Status message input */}
          <form onSubmit={(e) => void handleStatusSubmit(e)} className="px-3 py-2">
            <label className="text-xs text-fluux-muted mb-1.5 block">{t('presence.statusMessage')}</label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={statusInput}
                onChange={(e) => setStatusInput(e.target.value)}
                placeholder={t('presence.statusPlaceholder')}
                maxLength={100}
                className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-fluux-sidebar text-fluux-text rounded border border-fluux-hover focus:outline-none focus:border-fluux-brand placeholder:text-fluux-muted"
              />
            </div>
            <div className="flex gap-2 mt-2">
              <button
                type="submit"
                className="flex-1 px-2 py-1 text-xs bg-fluux-brand text-white rounded hover:bg-fluux-brand/80 transition-colors"
              >
                {t('common.save')}
              </button>
              {statusMessage && (
                <button
                  type="button"
                  onClick={() => void handleClearStatus()}
                  className="px-2 py-1 text-xs text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover transition-colors"
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

interface StatusDisplayProps {
  status: string
  reconnectTargetTime: number | null
  reconnectAttempt: number
}

export function StatusDisplay({
  status,
  reconnectTargetTime,
  reconnectAttempt
}: StatusDisplayProps) {
  const { t } = useTranslation()

  // Local countdown state — only this component re-renders every second,
  // not the entire Sidebar tree.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  useEffect(() => {
    if (!reconnectTargetTime) {
      setSecondsLeft(null)
      return
    }
    const update = () => {
      const remaining = Math.max(0, Math.ceil((reconnectTargetTime - Date.now()) / 1000))
      setSecondsLeft(remaining)
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [reconnectTargetTime])

  if (status === 'verifying') {
    return (
      <p className="text-xs text-fluux-yellow truncate flex items-center gap-1">
        <RefreshCw className="w-3 h-3 animate-spin" />
        {t('status.verifying')}
      </p>
    )
  }

  if (status === 'reconnecting') {
    return (
      <p className="text-xs text-fluux-yellow truncate flex items-center gap-1">
        <RefreshCw className="w-3 h-3 animate-spin" />
        {secondsLeft !== null
          ? t('status.reconnectingIn', { seconds: secondsLeft, attempt: reconnectAttempt })
          : t('status.reconnecting')}
      </p>
    )
  }

  if (status === 'connecting') {
    return (
      <p className="text-xs text-fluux-yellow truncate flex items-center gap-1">
        <RefreshCw className="w-3 h-3 animate-spin" />
        {t('status.connecting')}
      </p>
    )
  }

  if (status === 'error') {
    return <p className="text-xs text-fluux-red truncate">{t('status.connectionError')}</p>
  }

  return <p className="text-xs text-fluux-muted truncate">{t('status.disconnected')}</p>
}
