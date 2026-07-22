import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useClickOutside, useAnchoredMenu } from '@/hooks'
import { usePresence, useXMPP, type PresenceStatus } from '@fluux/sdk'
import { useConnectionStore, useEventsStore } from '@fluux/sdk/react'
import { ChevronDown, Check, RefreshCw, X } from 'lucide-react'
import { TextInput } from '../ui/TextInput'
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
  const inputRef = useRef<HTMLInputElement>(null)
  const menu = useAnchoredMenu(isOpen, { direction: 'up' })

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
  const closeMenu = () => setIsOpen(false)
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
        menu.menuRef.current?.focus()
        setFocusedIndex(prev => Math.min(prev + 1, presenceOptions.length - 1))
      } else if (e.key === 'ArrowUp' && !isInStatusInput) {
        e.preventDefault()
        e.stopPropagation()
        // Focus dropdown to prevent focus moving to other elements
        menu.menuRef.current?.focus()
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
  }, [isOpen, focusedIndex, setPresence, statusMessage, setIsOpen, menu.menuRef])

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
    <div className="relative min-w-0" ref={menuRef}>
      {/* Trigger - styled as a distinct chip */}
      <Tooltip content={t('presence.changeStatus')} position="top" disabled={isOpen} className="min-w-0">
        <button
          type="button"
          ref={menu.triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-full bg-fluux-hover hover:bg-fluux-bg border border-transparent hover:border-fluux-muted/30 transition-colors group min-w-0 max-w-full overflow-hidden"
        >
          <span className={`size-2 rounded-full flex-shrink-0 ${currentOption.color}`} />
          <span className="text-fluux-muted group-hover:text-fluux-text truncate min-w-0">
            {statusMessage || t(currentOption.labelKey)}
          </span>
          <ChevronDown className={`size-3 text-fluux-muted group-hover:text-fluux-text flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </Tooltip>

      {/* Dropdown */}
      {isOpen && (
        <div
          ref={menu.menuRef}
          tabIndex={-1}
          style={{ left: menu.position.x, top: menu.position.y }}
          className="fixed w-56 max-w-[calc(100vw-1rem)] fluux-popover rounded-lg py-1 z-50 overflow-hidden outline-none"
        >
          {/* Presence options */}
          {presenceOptions.map((option, index) => (
            <button
              type="button"
              key={option.value}
              onClick={() => void handleSelectPresence(option.value)}
              onMouseEnter={() => setFocusedIndex(index)}
              className={`w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text transition-colors ${
                focusedIndex === index ? 'bg-fluux-hover' : 'hover:bg-fluux-hover'
              }`}
            >
              <span className={`size-2.5 rounded-full ${option.color}`} />
              <span className="flex-1">{t(option.labelKey)}</span>
              {presenceShow === option.value && (
                <Check className="size-4 text-fluux-green" />
              )}
            </button>
          ))}

          {/* Divider */}
          <div className="my-1 border-t border-fluux-hover" />

          {/* Status message input */}
          <form onSubmit={(e) => void handleStatusSubmit(e)} className="px-3 py-2">
            <label className="text-xs text-fluux-muted mb-1.5 block">{t('presence.statusMessage')}</label>
            <div className="flex gap-2">
              <TextInput
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
                className="flex-1 px-2 py-1 text-xs bg-fluux-brand text-fluux-text-on-accent rounded hover:bg-fluux-brand/80 transition-colors"
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

/** Grace before the chip surfaces a degraded connection state — fast
 * reconnects and post-wake verifications (e.g. silent SM resumptions)
 * come and go without flashing anything. */
export const DEGRADED_STATUS_GRACE_MS = 2000

interface StatusDisplayProps {
  status: string
}

/**
 * Connection-state line of the user-menu chip — the single connection-incident
 * surface (issue #515 reverted the top-of-layout ConnectionBanner: it lived in
 * normal flow, so every appearance reflowed the whole UI).
 *
 * Subscribes to the reconnect metadata itself so the Sidebar tree never
 * re-renders on retry-cycle churn; the per-second countdown is local state.
 * The cancel action sits inline next to the countdown — the UserMenu stays
 * available during reconnection (logout must remain reachable).
 */
export function StatusDisplay({ status }: StatusDisplayProps) {
  const { t } = useTranslation()
  const reconnectTargetTime = useConnectionStore((s) => s.reconnectTargetTime)
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt)
  const { client } = useXMPP()
  const persistentAlert = useEventsStore((s) => {
    // Latest (newest) persistent alert — addSystemNotification appends, so scan from the end.
    for (let i = s.systemNotifications.length - 1; i >= 0; i--) {
      const n = s.systemNotifications[i]
      if (n.type === 'auth-error' || n.type === 'resource-conflict') return n
    }
    return null
  })

  // Local countdown state — only this component re-renders every second,
  // not the entire Sidebar tree.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  useEffect(() => {
    if (status !== 'reconnecting' || !reconnectTargetTime) {
      setSecondsLeft(null)
      return
    }
    const update = () => {
      setSecondsLeft(Math.max(0, Math.ceil((reconnectTargetTime - Date.now()) / 1000)))
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [status, reconnectTargetTime])

  let statusLine: React.ReactNode

  if (status === 'reconnecting') {
    statusLine = (
      <div className="flex items-center gap-1 min-w-0">
        <p className="text-xs text-fluux-yellow truncate flex items-center gap-1 min-w-0">
          <RefreshCw className="size-3 animate-spin flex-shrink-0" />
          <span className="truncate">
            {secondsLeft !== null
              ? t('status.reconnectingIn', { seconds: secondsLeft, attempt: reconnectAttempt })
              : t('status.reconnecting')}
          </span>
        </p>
        <Tooltip content={t('status.cancelReconnection')} position="top">
          <button
            type="button"
            onClick={() => client.cancelReconnect()}
            aria-label={t('status.cancelReconnection')}
            className="p-0.5 text-fluux-muted hover:text-fluux-error rounded hover:bg-fluux-hover flex-shrink-0"
          >
            <X className="size-3" />
          </button>
        </Tooltip>
      </div>
    )
  } else if (status === 'verifying') {
    statusLine = (
      <p className="text-xs text-fluux-yellow truncate flex items-center gap-1">
        <RefreshCw className="size-3 animate-spin flex-shrink-0" />
        <span className="truncate">{t('status.verifying')}</span>
      </p>
    )
  } else if (status === 'connecting') {
    statusLine = (
      <p className="text-xs text-fluux-yellow truncate flex items-center gap-1">
        <RefreshCw className="size-3 animate-spin flex-shrink-0" />
        <span className="truncate">{t('status.connecting')}</span>
      </p>
    )
  } else if (status === 'error') {
    statusLine = <p className="text-xs text-fluux-error truncate">{t('status.connectionError')}</p>
  } else {
    statusLine = <p className="text-xs text-fluux-muted truncate">{t('status.disconnected')}</p>
  }

  return (
    <>
      {statusLine}
      {persistentAlert && (
        <p className="text-xs text-fluux-error truncate px-2" title={persistentAlert.message}>
          {persistentAlert.title}
        </p>
      )}
    </>
  )
}

interface StatusOrPresenceProps {
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * Chip line of the sidebar user panel: presence selector while healthy,
 * connection status while degraded.
 *
 * Owns the connection-state subscriptions (status, isVerifying) so the
 * Sidebar itself never re-renders on connection churn. Transient degraded
 * states ('reconnecting'/'connecting'/'verifying', or the post-wake
 * `online + isVerifying` machine sub-state) only surface after a grace
 * delay — until then the presence selector stays, swapping one fixed-height
 * line for another, so nothing in the layout ever moves.
 */
export function StatusOrPresence({ isOpen, onOpenChange }: StatusOrPresenceProps) {
  const status = useConnectionStore((s) => s.status)
  const isVerifying = useConnectionStore((s) => s.isVerifying)

  const isDegraded =
    status === 'reconnecting' ||
    status === 'connecting' ||
    status === 'verifying' ||
    (status === 'online' && isVerifying)

  const [showDegraded, setShowDegraded] = useState(false)
  useEffect(() => {
    if (!isDegraded) {
      setShowDegraded(false)
      return
    }
    const timer = setTimeout(() => setShowDegraded(true), DEGRADED_STATUS_GRACE_MS)
    return () => clearTimeout(timer)
  }, [isDegraded])

  // Terminal states surface immediately (App usually routes them to the
  // login screen anyway, unmounting this chip).
  if (status === 'error' || status === 'disconnected') {
    return <StatusDisplay status={status} />
  }

  if (isDegraded && showDegraded) {
    return <StatusDisplay status={status === 'online' ? 'verifying' : status} />
  }

  return <PresenceSelector isOpen={isOpen} onOpenChange={onOpenChange} />
}
