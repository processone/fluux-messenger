import React, { lazy, Suspense, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useClickOutside, useIsMobileWeb, useAnchoredMenu } from '@/hooks'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'
import { useModalStore } from '@/stores/modalStore'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'
import { usePresence, useConsole, useXMPP, getLocalPart, type PresenceStatus } from '@fluux/sdk'
import { useConnectionStore, useEventsStore } from '@fluux/sdk/react'
import {
  ChevronsUpDown,
  Check,
  LogOut,
  RefreshCw,
  Terminal,
  Info,
  Sparkles,
  Bug,
  Keyboard,
  User,
  X,
} from 'lucide-react'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'
import { ModalOverlay } from '../ModalOverlay'
import { AboutModal } from '../AboutModal'
import { TextInput } from '../ui/TextInput'
import { BottomSheet } from '../ui/BottomSheet'
import { DEGRADED_STATUS_GRACE_MS, useConnectionStep } from '../ConnectionStep'
import { PRESENCE_COLORS } from '@/constants/ui'

const ChangelogModal = lazy(() => import('../ChangelogModal').then((m) => ({ default: m.ChangelogModal })))

export { DEGRADED_STATUS_GRACE_MS }

const presenceOptions: { value: Exclude<PresenceStatus, 'offline'>; labelKey: string; color: string }[] = [
  { value: 'online', labelKey: 'presence.online', color: PRESENCE_COLORS.online },
  { value: 'away', labelKey: 'presence.away', color: PRESENCE_COLORS.away },
  { value: 'dnd', labelKey: 'presence.dnd', color: PRESENCE_COLORS.dnd },
]

/** Selector for every control the arrow keys walk through inside the open menu. */
const ITEM_SELECTOR = '[data-account-item]:not(:disabled)'

interface AccountMenuProps {
  onLogout: (shouldCleanLocalData: boolean) => void | Promise<void>
  onOpenProfile: () => void
  /** Tab-cycling zone ref (the account row is the fourth keyboard area). */
  zoneRef?: React.MutableRefObject<HTMLElement | null>
}

type StatusTone = 'busy' | 'error' | 'muted'

/**
 * The one line under the account name, resolved once so the row, its tooltip and its
 * spoken name all say the same thing: connection state while degraded, a persistent
 * sign-in alert, otherwise the status message or presence label. Transient states
 * (reconnecting, connecting, verifying) arrive as `step`, already past their grace
 * delay; terminal ones show at once. The retry target is selected as null unless
 * reconnecting, so a healthy row never re-renders on retry churn.
 */
function useAccountStatus(
  step: string | null,
  status: string,
  presenceLabel: string,
  statusMessage: string,
): { text: string; tone: StatusTone } {
  const { t } = useTranslation()
  const current = step ?? (status === 'error' || status === 'disconnected' ? status : null)
  const reconnecting = current === 'reconnecting'
  const reconnectTargetTime = useConnectionStore((s) => reconnecting ? s.reconnectTargetTime : null)
  const reconnectAttempt = useConnectionStore((s) => reconnecting ? s.reconnectAttempt : 0)
  const persistentAlert = useEventsStore((s) => {
    for (let i = s.systemNotifications.length - 1; i >= 0; i--) {
      const n = s.systemNotifications[i]
      if (n.type === 'auth-error' || n.type === 'resource-conflict') return n
    }
    return null
  })
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  useEffect(() => {
    if (!reconnectTargetTime) {
      setSecondsLeft(null)
      return
    }
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((reconnectTargetTime - Date.now()) / 1000)))
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [reconnectTargetTime])

  if (reconnecting) {
    return {
      tone: 'busy',
      text: secondsLeft !== null
        ? t('status.reconnectingIn', { seconds: secondsLeft, attempt: reconnectAttempt })
        : t('status.reconnecting'),
    }
  }
  if (current === 'verifying') return { tone: 'busy', text: t('status.verifying') }
  if (current === 'connecting') return { tone: 'busy', text: t('status.connecting') }
  if (current === 'error') return { tone: 'error', text: t('status.connectionError') }
  if (current === 'disconnected') return { tone: 'muted', text: t('status.disconnected') }
  if (persistentAlert) return { tone: 'error', text: persistentAlert.title }
  return { tone: 'muted', text: statusMessage || presenceLabel }
}

function AccountStatusLine({ text, tone }: { text: string; tone: StatusTone }) {
  const color = tone === 'busy' ? 'text-fluux-yellow' : tone === 'error' ? 'text-fluux-error' : 'text-fluux-muted'
  return (
    <span className={`flex min-w-0 items-center gap-1 text-xs leading-4 ${color}`}>
      {tone === 'busy' && <RefreshCw className="size-3 animate-spin flex-shrink-0" aria-hidden="true" />}
      <span className="truncate">{text}</span>
    </span>
  )
}

export function AccountMenu({ onLogout, onOpenProfile, zoneRef }: AccountMenuProps) {
  const { t } = useTranslation()
  const isOpen = useModalStore((s) => s.presenceMenu)
  const modalOpen = useModalStore((s) => s.open)
  const modalClose = useModalStore((s) => s.close)
  const openShortcutHelp = useCallback(() => modalOpen('shortcutHelp'), [modalOpen])
  const isMobile = useIsMobileWeb()
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)
  const { toggle: toggleConsole, isOpen: consoleOpen } = useConsole()
  const { client } = useXMPP()
  const { presenceStatus: presenceShow, statusMessage, setPresence } = usePresence()
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const status = useConnectionStore((s) => s.status)
  const step = useConnectionStep()

  const [statusInput, setStatusInput] = useState(statusMessage || '')
  const [showAbout, setShowAbout] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [cleanLocalData, setCleanLocalData] = useState(() => localStorage.getItem('xmpp-remember-me') !== 'true')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sheetBodyRef = useRef<HTMLDivElement>(null)
  const menu = useAnchoredMenu(isOpen && !isMobile, { direction: 'up' })
  const rowRef = useRef<HTMLButtonElement | null>(null)

  // The row is both the menu's anchor and the account Tab zone.
  const setTrigger = useCallback(
    (el: HTMLButtonElement | null) => {
      rowRef.current = el
      // The anchored-menu hook measures its trigger through this ref object.
      ;(menu.triggerRef as React.MutableRefObject<HTMLElement | null>).current = el
      if (zoneRef) zoneRef.current = el
    },
    [menu.triggerRef, zoneRef],
  )

  const name = ownNickname || (jid ? getLocalPart(jid) : '')
  const currentOption = presenceOptions.find((p) => p.value === presenceShow) || presenceOptions[0]
  const presenceLabel = t(currentOption.labelKey)
  // Presence can only change on a live connection; the rest of the menu (log out) stays available.
  const connected = status === 'online'
  const line = useAccountStatus(step, status, presenceLabel, statusMessage || '')
  const showCancel = step === 'reconnecting'

  // The console is an advanced-only surface: close it if the flag turns off while open.
  useEffect(() => {
    if (!advancedMode && consoleOpen) toggleConsole()
  }, [advancedMode, consoleOpen, toggleConsole])

  useEffect(() => {
    setStatusInput(statusMessage || '')
  }, [statusMessage])

  const close = useCallback(
    (restoreFocus = false) => {
      modalClose('presenceMenu')
      if (restoreFocus) rowRef.current?.focus()
    },
    [modalClose],
  )
  useClickOutside(wrapperRef, () => close(), isOpen && !isMobile)
  // Escape closes the menu when it is the overlay on top and goes no further (see useCloseOnEscape).
  // The phone sheet handles its own Escape.
  useCloseOnEscape(() => close(true), isOpen && !isMobile)

  const getMenuEl = useCallback(
    () => (isMobile ? sheetBodyRef.current : menu.menuRef.current),
    [isMobile, menu.menuRef],
  )

  // Move focus as the menu mounts, before a later frame could steal it from the status field.
  useLayoutEffect(() => {
    if (!isOpen) return
    const el = getMenuEl()
    const checked = el?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)')
    ;(checked ?? el?.querySelector<HTMLElement>(ITEM_SELECTOR))?.focus()
  }, [isOpen, getMenuEl])

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab']
    if (!keys.includes(e.key)) return
    // The phone sheet's own focus trap already wraps Tab; handling it again would skip an item.
    if (e.key === 'Tab' && isMobile) return
    const items = Array.from(getMenuEl()?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])
    if (items.length === 0) return
    // Typing in the status field keeps Home/End for the caret.
    const inInput = e.target === inputRef.current
    if (inInput && (e.key === 'Home' || e.key === 'End')) return
    e.preventDefault()
    e.stopPropagation()
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next = index
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) next = (index + 1) % items.length
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) next = (index - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    items[next].focus()
  }

  const choosePresence = (value: Exclude<PresenceStatus, 'offline'>) => {
    setPresence(value, statusMessage || undefined)
    close(true)
  }

  const submitStatus = (e: React.FormEvent) => {
    e.preventDefault()
    if (presenceShow !== 'offline') setPresence(presenceShow, statusInput.trim() || undefined)
    close(true)
  }

  const clearStatus = () => {
    if (presenceShow !== 'offline') setPresence(presenceShow, undefined)
    setStatusInput('')
  }

  const rowPad = isMobile ? 'py-3 min-h-11' : 'py-2'
  const itemClass = `focus-ring-inset w-full px-3 ${rowPad} flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent focus-visible:bg-fluux-hover transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fluux-text`
  const run = (fn: () => void) => () => {
    close()
    fn()
  }

  const menuBody = (
    <>
      <button type="button" role="menuitem" data-account-item onClick={run(() => setShowChangelog(true))} className={itemClass}>
        <Sparkles className="size-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{t('menu.whatsNew')}</span>
      </button>
      {!isMobile && (
        <button type="button" role="menuitem" data-account-item onClick={run(openShortcutHelp)} className={itemClass}>
          <Keyboard className="size-4 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{t('menu.keyboardShortcuts')}</span>
        </button>
      )}
      <a
        href="https://github.com/processone/fluux-messenger/issues"
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        data-account-item
        onClick={() => close()}
        className={itemClass}
      >
        <Bug className="size-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{t('menu.reportIssue')}</span>
      </a>
      <button type="button" role="menuitem" data-account-item onClick={run(() => setShowAbout(true))} className={itemClass}>
        <Info className="size-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{t('menu.about')}</span>
      </button>

      <div className="my-1 border-t border-fluux-hover" role="separator" />

      <button type="button" role="menuitem" data-account-item onClick={run(onOpenProfile)} className={itemClass}>
        <User className="size-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{t('sidebar.viewProfile')}</span>
      </button>

      {!isMobile && advancedMode && (
        <button type="button" role="menuitem" data-account-item onClick={run(toggleConsole)} className={itemClass}>
          <Terminal className="size-4 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{consoleOpen ? t('menu.hideConsole') : t('menu.showConsole')}</span>
        </button>
      )}

      <div className="my-1 border-t border-fluux-hover" role="separator" />

      <div role="group" aria-label={presenceLabel}>
        {presenceOptions.map((option) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={presenceShow === option.value}
            key={option.value}
            data-account-item
            disabled={!connected}
            onClick={() => choosePresence(option.value)}
            className={itemClass}
          >
            <span className={`size-2.5 rounded-full flex-shrink-0 ${option.color}`} aria-hidden="true" />
            <span className="flex-1 min-w-0 truncate">{t(option.labelKey)}</span>
            {presenceShow === option.value && <Check className="size-4 text-fluux-green flex-shrink-0" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div className="my-1 border-t border-fluux-hover" role="separator" />

      <form onSubmit={submitStatus} className="px-3 py-2">
        <label className="text-xs text-fluux-muted mb-1.5 block" htmlFor="account-status-input">
          {t('presence.statusMessage')}
        </label>
        <TextInput
          id="account-status-input"
          ref={inputRef}
          type="text"
          data-account-item
          disabled={!connected}
          value={statusInput}
          onChange={(e) => setStatusInput(e.target.value)}
          placeholder={t('presence.statusPlaceholder')}
          maxLength={100}
          className="w-full min-w-0 px-2 py-1.5 text-sm bg-fluux-sidebar text-fluux-text rounded border border-fluux-hover placeholder:text-fluux-muted"
        />
        <div className="flex gap-2 mt-2">
          <button
            type="submit"
            data-account-item
            disabled={!connected}
            className={`flex-1 px-2 ${isMobile ? 'py-2.5' : 'py-1'} text-xs bg-fluux-brand text-fluux-text-on-accent rounded hover:bg-fluux-brand/80 transition-colors disabled:opacity-50`}
          >
            {t('common.save')}
          </button>
          {statusMessage && (
            <button
              type="button"
              data-account-item
              disabled={!connected}
              onClick={clearStatus}
              className={`px-2 ${isMobile ? 'py-2.5' : 'py-1'} text-xs text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover transition-colors disabled:opacity-50`}
            >
              {t('common.clear')}
            </button>
          )}
        </div>
      </form>

      <div className="my-1 border-t border-fluux-hover" role="separator" />

      <button
        type="button"
        role="menuitem"
        data-account-item
        onClick={run(() => setShowLogoutConfirm(true))}
        className={`focus-ring-inset w-full px-3 ${rowPad} flex items-center gap-3 text-start text-fluux-error hover:bg-fluux-red hover:text-white focus-visible:bg-fluux-hover transition-colors`}
      >
        <LogOut className="size-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{t('menu.logOut')}</span>
      </button>
    </>
  )

  const rowTooltip = `${name} · ${line.text}`
  const rowLabel = `${name}, ${line.text}`

  return (
    <>
      <div className="relative flex items-center gap-1 min-w-0" ref={wrapperRef}>
        <div className="min-w-0 flex-1">
          <Tooltip content={rowTooltip} position="top" disabled={isOpen} className="min-w-0 block">
            <button
              type="button"
              ref={setTrigger}
              aria-label={rowLabel}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              data-testid="account-row"
              onClick={() => (isOpen ? close() : modalOpen('presenceMenu'))}
              className="focus-ring flex h-12 w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 text-start hover:bg-fluux-hover transition-colors"
            >
              <Avatar
                identifier={jid || ''}
                name={name || undefined}
                avatarUrl={ownAvatar || undefined}
                size="header"
                presence={connected ? presenceShow : 'offline'}
                fallbackColor="var(--fluux-bg-accent)"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium leading-5 text-fluux-text">{name}</span>
                <AccountStatusLine text={line.text} tone={line.tone} />
              </span>
              <ChevronsUpDown className="size-4 flex-shrink-0 text-fluux-muted" aria-hidden="true" />
            </button>
          </Tooltip>
        </div>

        {showCancel && (
          <Tooltip content={t('status.cancelReconnection')} position="top">
            <button
              type="button"
              onClick={() => client.cancelReconnect()}
              aria-label={t('status.cancelReconnection')}
              className="focus-ring flex size-8 flex-shrink-0 items-center justify-center rounded text-fluux-muted hover:text-fluux-error hover:bg-fluux-hover"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </Tooltip>
        )}

        {isOpen && !isMobile && (
          <div
            ref={menu.menuRef}
            role="menu"
            aria-label={name}
            onKeyDown={handleMenuKeyDown}
            style={{ left: menu.position.x, top: menu.position.y }}
            className="fixed w-64 max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-y-auto fluux-popover rounded-lg py-1 z-50 outline-none"
          >
            {menuBody}
          </div>
        )}
      </div>

      <BottomSheet open={isOpen && isMobile} onClose={() => close(true)} ariaLabel={name}>
        <div ref={sheetBodyRef} role="menu" aria-label={name} onKeyDown={handleMenuKeyDown}>
          {menuBody}
        </div>
      </BottomSheet>

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {showChangelog && (
        <Suspense fallback={null}>
          <ChangelogModal onClose={() => setShowChangelog(false)} />
        </Suspense>
      )}

      {showLogoutConfirm && (
        <ModalOverlay onClose={() => setShowLogoutConfirm(false)} width="max-w-xs" panelClassName="overflow-hidden">
          {({ close: closeConfirm }) => (
            <div className="p-6 text-center">
              <LogOut className="size-12 mx-auto mb-4 text-fluux-muted" />
              <h3 className="text-lg font-semibold text-fluux-text mb-2">{t('menu.logOut')}</h3>
              <p className="text-fluux-muted text-sm mb-4">{t('menu.logoutConfirm')}</p>
              <label className="flex items-center gap-2 text-sm text-fluux-text cursor-pointer mb-6">
                <input
                  type="checkbox"
                  checked={cleanLocalData}
                  onChange={(e) => setCleanLocalData(e.target.checked)}
                  className="size-4 rounded border border-fluux-border bg-fluux-bg
                             checked:bg-fluux-brand checked:border-fluux-brand"
                />
                {t('menu.cleanLocalData')}
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeConfirm}
                  className="flex-1 px-4 py-2 text-fluux-text bg-fluux-hover rounded hover:bg-fluux-hover/80 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLogoutConfirm(false)
                    void onLogout(cleanLocalData)
                  }}
                  className="flex-1 px-4 py-2 text-white bg-fluux-red rounded hover:bg-fluux-red/80 transition-colors"
                >
                  {t('menu.disconnect')}
                </button>
              </div>
            </div>
          )}
        </ModalOverlay>
      )}
    </>
  )
}
