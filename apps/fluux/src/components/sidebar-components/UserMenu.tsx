import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useClickOutside, useIsMobileWeb, useAnchoredMenu } from '@/hooks'
import { useModalStore } from '@/stores/modalStore'
import { useConsole } from '@fluux/sdk'
import { AboutModal } from '../AboutModal'
import { ChangelogModal } from '../ChangelogModal'
import { Tooltip } from '../Tooltip'
import { ModalOverlay } from '../ModalOverlay'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'
import {
  LogOut,
  MoreVertical,
  Terminal,
  Info,
  Sparkles,
  Bug,
  Keyboard,
} from 'lucide-react'

interface UserMenuProps {
  onLogout: (shouldCleanLocalData: boolean) => void | Promise<void>
}

export function UserMenu({ onLogout }: UserMenuProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [cleanLocalData, setCleanLocalData] = useState(() => {
    // Default to cleaning local data unless "Remember Me" was checked
    return localStorage.getItem('xmpp-remember-me') !== 'true'
  })
  const menuRef = useRef<HTMLDivElement>(null)
  const menu = useAnchoredMenu(isOpen, { direction: 'up' })
  const { toggle: toggleConsole, isOpen: consoleOpen } = useConsole()
  // Action-only consumer: subscribes to the stable `open` store method, so it
  // never re-renders on modal state changes.
  const modalOpen = useModalStore((s) => s.open)
  const isMobile = useIsMobileWeb()
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)

  // The console is an advanced-only surface: if the flag is turned off while it
  // is open, close it so no orphaned console view remains.
  useEffect(() => {
    if (!advancedMode && consoleOpen) {
      toggleConsole()
    }
  }, [advancedMode, consoleOpen, toggleConsole])

  // Close menu when clicking outside
  const closeMenu = () => setIsOpen(false)
  useClickOutside(menuRef, closeMenu, isOpen)

  // Close menu on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <>
      <div className="relative flex-shrink-0" ref={menuRef}>
        <Tooltip content={t('common.options')} position="top" disabled={isOpen}>
          <button
            ref={menu.triggerRef}
            onClick={() => setIsOpen(!isOpen)}
            className="p-2 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
          >
            <MoreVertical className="size-4" />
          </button>
        </Tooltip>

        {isOpen && (
          <div
            ref={menu.menuRef}
            style={{ left: menu.position.x, top: menu.position.y }}
            className="fixed w-48 max-w-[calc(100vw-1rem)] fluux-popover rounded-lg py-1 z-50">
            {/* Console toggle - hidden on mobile and behind advanced mode */}
            {!isMobile && advancedMode && (
              <button
                onClick={() => {
                  toggleConsole()
                  setIsOpen(false)
                }}
                className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
              >
                <Terminal className="size-4" />
                <span>{consoleOpen ? t('menu.hideConsole') : t('menu.showConsole')}</span>
              </button>
            )}

            {/* What's New */}
            <button
              onClick={() => {
                setShowChangelog(true)
                setIsOpen(false)
              }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
            >
              <Sparkles className="size-4" />
              <span>{t('menu.whatsNew')}</span>
            </button>

            {/* Keyboard Shortcuts - hidden on mobile */}
            {!isMobile && (
              <button
                onClick={() => {
                  modalOpen('shortcutHelp')
                  setIsOpen(false)
                }}
                className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
              >
                <Keyboard className="size-4" />
                <span>{t('menu.keyboardShortcuts')}</span>
              </button>
            )}

            {/* Report an issue */}
            <a
              href="https://github.com/processone/fluux-messenger/issues"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setIsOpen(false)}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
            >
              <Bug className="size-4" />
              <span>{t('menu.reportIssue')}</span>
            </a>

            {/* About */}
            <button
              onClick={() => {
                setShowAbout(true)
                setIsOpen(false)
              }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
            >
              <Info className="size-4" />
              <span>{t('menu.about')}</span>
            </button>

            {/* Divider */}
            <div className="my-1 border-t border-fluux-hover" />

            {/* Log out */}
            <button
              onClick={() => {
                setShowLogoutConfirm(true)
                setIsOpen(false)
              }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-error hover:bg-fluux-red hover:text-white transition-colors"
            >
              <LogOut className="size-4" />
              <span>{t('menu.logOut')}</span>
            </button>
          </div>
        )}
      </div>

      {/* About Modal */}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}

      {/* Changelog Modal */}
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <ModalOverlay
          onClose={() => setShowLogoutConfirm(false)}
          width="max-w-xs"
          panelClassName="overflow-hidden"
        >
          {({ close }) => (
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
                             checked:bg-fluux-brand checked:border-fluux-brand
                             focus:ring-fluux-brand focus:ring-offset-0"
                />
                {t('menu.cleanLocalData')}
              </label>
              <div className="flex gap-3">
                <button
                  onClick={close}
                  className="flex-1 px-4 py-2 text-fluux-text bg-fluux-hover rounded hover:bg-fluux-hover/80 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
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
