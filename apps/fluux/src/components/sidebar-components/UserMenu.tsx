import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useClickOutside } from '@/hooks'
import { useModals } from '@/contexts'
import { useConsole } from '@fluux/sdk'
import { AboutModal } from '../AboutModal'
import { ChangelogModal } from '../ChangelogModal'
import { Tooltip } from '../Tooltip'
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
  onLogout: () => void
}

export function UserMenu({ onLogout }: UserMenuProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { toggle: toggleConsole, isOpen: consoleOpen } = useConsole()
  const { actions: modalActions } = useModals()

  // Close menu when clicking outside
  const closeMenu = useCallback(() => setIsOpen(false), [])
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
      <div className="relative" ref={menuRef}>
        <Tooltip content={t('common.options')} position="top" disabled={isOpen}>
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="p-2 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        </Tooltip>

        {isOpen && (
          <div className="absolute bottom-full right-0 mb-2 w-48 bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50">
            {/* Console toggle */}
            <button
              onClick={() => {
                toggleConsole()
                setIsOpen(false)
              }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              <Terminal className="w-4 h-4" />
              <span>{consoleOpen ? t('menu.hideConsole') : t('menu.showConsole')}</span>
            </button>

            {/* What's New */}
            <button
              onClick={() => {
                setShowChangelog(true)
                setIsOpen(false)
              }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              <span>{t('menu.whatsNew')}</span>
            </button>

            {/* Keyboard Shortcuts */}
            <button
              onClick={() => {
                modalActions.open('shortcutHelp')
                setIsOpen(false)
              }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              <Keyboard className="w-4 h-4" />
              <span>{t('menu.keyboardShortcuts')}</span>
            </button>

            {/* Report an issue */}
            <a
              href="https://github.com/processone/fluux-messenger/issues"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setIsOpen(false)}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              <Bug className="w-4 h-4" />
              <span>{t('menu.reportIssue')}</span>
            </a>

            {/* About */}
            <button
              onClick={() => {
                setShowAbout(true)
                setIsOpen(false)
              }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              <Info className="w-4 h-4" />
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
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-red hover:bg-fluux-red hover:text-white transition-colors"
            >
              <LogOut className="w-4 h-4" />
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
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowLogoutConfirm(false) }}
        >
          <div className="bg-fluux-sidebar rounded-lg shadow-xl border border-fluux-hover w-80 overflow-hidden">
            <div className="p-6 text-center">
              <LogOut className="w-12 h-12 mx-auto mb-4 text-fluux-muted" />
              <h3 className="text-lg font-semibold text-fluux-text mb-2">{t('menu.logOut')}</h3>
              <p className="text-fluux-muted text-sm mb-6">{t('menu.logoutConfirm')}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowLogoutConfirm(false)}
                  className="flex-1 px-4 py-2 text-fluux-text bg-fluux-hover rounded hover:bg-fluux-hover/80 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowLogoutConfirm(false)
                    onLogout()
                  }}
                  className="flex-1 px-4 py-2 text-white bg-fluux-red rounded hover:bg-fluux-red/80 transition-colors"
                >
                  {t('menu.disconnect')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
