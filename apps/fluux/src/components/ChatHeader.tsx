/**
 * Header component for 1:1 chat conversations.
 *
 * Displays contact avatar, name, and presence status.
 * Also supports group chat mode with a hash icon.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactIdentity } from '@fluux/sdk'
import { useRosterStore, useContactTime, useLastActivity } from '@fluux/sdk/react'
import { Avatar } from './Avatar'
import { useWindowDrag } from '@/hooks'
import { getTranslatedStatusText } from '@/utils/statusText'
import { Tooltip } from './Tooltip'
import { ArrowLeft, Clock, Hash, Lock, LockOpen, Loader2, Search, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

export interface ChatHeaderProps {
  name: string
  type: 'chat' | 'groupchat'
  contact?: ContactIdentity
  jid: string
  onBack?: () => void
  onSearchInConversation?: () => void
  encryptionState?: ConversationEncryptionState
  onEncryptionClick?: () => void
  onDisableEncryptionClick?: () => void
  onEnableEncryptionClick?: () => void
  /** Open the contact profile / management screen. 1:1 chats only. */
  onShowProfile?: () => void
}

export function ChatHeader({
  name,
  type,
  contact,
  jid,
  onBack,
  onSearchInConversation,
  encryptionState,
  onEncryptionClick,
  onDisableEncryptionClick,
  onEnableEncryptionClick,
  onShowProfile,
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const isGroupChat = type === 'groupchat'
  const { titleBarClass, dragRegionProps } = useWindowDrag()

  // Subscribe to this specific contact's full data from the roster store
  // for presence display. This is a focused selector — only re-renders when
  // this specific contact changes, not when other contacts update.
  const fullContact = useRosterStore((s) => jid ? s.contacts.get(jid) : undefined)
  const contactTime = useContactTime(!isGroupChat ? jid : null)
  useLastActivity(!isGroupChat ? jid : null)

  return (
    <header className={`h-14 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3`} {...dragRegionProps}>
      {/* Back button - mobile only */}
      {onBack && (
        <button
          onClick={onBack}
          className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden"
          aria-label={t('conversations.backToConversations')}
        >
          <ArrowLeft className="w-5 h-5 text-fluux-muted rtl-mirror" />
        </button>
      )}

      {/* Avatar / Icon */}
      {isGroupChat ? (
        <div className="w-9 h-9 bg-fluux-bg rounded-full flex items-center justify-center flex-shrink-0">
          <Hash className="w-5 h-5 text-fluux-muted" />
        </div>
      ) : (
        <Avatar
          identifier={jid}
          name={name}
          avatarUrl={contact?.avatar}
          size="header"
          presence={fullContact?.presence ?? 'offline'}
          presenceBorderColor="border-fluux-bg"
        />
      )}

      {/* Name and status */}
      <div className="flex-1 min-w-0">
        {!isGroupChat && onShowProfile ? (
          <button
            type="button"
            onClick={onShowProfile}
            className="block w-full text-start -mx-1 px-1 py-0.5 rounded hover:bg-fluux-hover transition-colors cursor-pointer"
            aria-label={t('sidebar.viewProfile')}
          >
            <h2 className="font-semibold text-fluux-text truncate leading-tight">{name}</h2>
            <div className="flex items-center gap-1.5">
              <p className="text-xs text-fluux-muted truncate">
                {fullContact ? getTranslatedStatusText(fullContact, t) : jid}
              </p>
              {contactTime && (
                <Tooltip content={t('presence.localTime')} position="bottom" className="inline-flex items-center">
                  <span className="text-xs text-fluux-muted flex-shrink-0 flex items-center gap-1">
                    · <Clock className="w-3 h-3" />{contactTime}
                  </span>
                </Tooltip>
              )}
            </div>
          </button>
        ) : (
          <>
            <h2 className="font-semibold text-fluux-text truncate leading-tight">{name}</h2>
            {!isGroupChat && (
              <div className="flex items-center gap-1.5">
                <p className="text-xs text-fluux-muted truncate">
                  {fullContact ? getTranslatedStatusText(fullContact, t) : jid}
                </p>
                {contactTime && (
                  <Tooltip content={t('presence.localTime')} position="bottom" className="inline-flex items-center">
                    <span className="text-xs text-fluux-muted flex-shrink-0 flex items-center gap-1">
                      · <Clock className="w-3 h-3" />{contactTime}
                    </span>
                  </Tooltip>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Encryption status icon — only for 1:1 chats with active E2EE */}
      {encryptionState && encryptionState.kind !== 'disabled' && encryptionState.kind !== 'unsupported' && (
        <EncryptionIcon
          state={encryptionState}
          peerName={name}
          onVerifyClick={onEncryptionClick}
          onDisableClick={onDisableEncryptionClick}
          onEnableClick={onEnableEncryptionClick}
        />
      )}

      {/* Search in conversation */}
      {onSearchInConversation && (
        <button
          onClick={onSearchInConversation}
          className="p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
          title={t('chat.searchInConversation', 'Search in conversation')}
        >
          <Search className="w-4 h-4" />
        </button>
      )}
    </header>
  )
}

function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}

function EncryptionIcon({
  state,
  peerName,
  onVerifyClick,
  onDisableClick,
  onEnableClick,
}: {
  state: ConversationEncryptionState
  peerName: string
  onVerifyClick?: () => void
  onDisableClick?: () => void
  onEnableClick?: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const btnClass = 'p-1.5 rounded transition-colors'

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  // Non-interactive states — no popover.
  if (state.kind === 'checking') {
    return (
      <Tooltip content={t('chat.encryption.checking')} position="bottom">
        <div className={`${btnClass} text-fluux-muted`} role="status" aria-live="polite">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      </Tooltip>
    )
  }

  if (state.kind === 'blocked') {
    const tooltip = (
      <div>
        <div>{t('chat.encryption.blockedTooltip')}</div>
        <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(state.advertisedFingerprint)}</div>
      </div>
    )
    return (
      <Tooltip content={tooltip} position="bottom">
        <div className={`${btnClass} text-yellow-500`} role="status">
          <ShieldAlert className="w-4 h-4" />
        </div>
      </Tooltip>
    )
  }

  // plaintextForced — open lock icon + popover to re-enable.
  if (state.kind === 'plaintextForced') {
    return (
      <div ref={containerRef} className="relative">
        <Tooltip content={t('chat.encryption.plaintextForcedTooltip')} position="bottom" disabled={open}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`${btnClass} text-fluux-muted hover:text-fluux-text cursor-pointer`}
            aria-label={t('chat.encryption.plaintextForced')}
            aria-expanded={open}
          >
            <LockOpen className="w-4 h-4" />
          </button>
        </Tooltip>
        {open && (
          <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-fluux-border bg-fluux-surface shadow-lg z-50 py-1 overflow-hidden">
            {onEnableClick && (
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
                onClick={() => { setOpen(false); onEnableClick() }}
              >
                <Lock className="w-4 h-4 flex-shrink-0 text-fluux-muted" />
                {t('chat.encryption.enableEncryption')}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // encrypted — shield/lock icon + popover with verify + disable options.
  const verified = state.kind === 'encrypted' && state.trust === 'verified'
  const Icon = verified ? ShieldCheck : Lock
  const colorClass = verified ? 'text-green-500' : 'text-fluux-muted hover:text-fluux-text'
  const hasActions = onVerifyClick || onDisableClick

  if (!hasActions) {
    const tooltip = (
      <div>
        <div>{verified ? t('chat.encryption.verifiedTooltip') : t('chat.encryption.openpgpTooltip')}</div>
        {state.kind === 'encrypted' && (
          <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(state.fingerprint)}</div>
        )}
      </div>
    )
    return (
      <Tooltip content={tooltip} position="bottom">
        <div className={`${btnClass} ${colorClass}`} role="status">
          <Icon className="w-4 h-4" />
        </div>
      </Tooltip>
    )
  }

  const ariaLabel = verified
    ? t('chat.encryption.encryptedTo', { name: peerName })
    : t('chat.verifyPeer.chipAriaLabel', { name: peerName })

  return (
    <div ref={containerRef} className="relative">
      <Tooltip
        content={state.kind === 'encrypted' ? (
          <div>
            <div>{verified ? t('chat.encryption.verifiedTooltip') : t('chat.encryption.openpgpTooltip')}</div>
            <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(state.fingerprint)}</div>
          </div>
        ) : null}
        position="bottom"
        disabled={open}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`${btnClass} ${colorClass} cursor-pointer`}
          aria-label={ariaLabel}
          aria-expanded={open}
        >
          <Icon className="w-4 h-4" />
        </button>
      </Tooltip>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-fluux-border bg-fluux-surface shadow-lg z-50 py-1 overflow-hidden">
          {onVerifyClick && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
              onClick={() => { setOpen(false); onVerifyClick() }}
            >
              <ShieldCheck className="w-4 h-4 flex-shrink-0 text-fluux-muted" />
              {t('chat.verifyPeer.dialogTitle', { name: peerName })}
            </button>
          )}
          {onDisableClick && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
              onClick={() => { setOpen(false); onDisableClick() }}
            >
              <ShieldOff className="w-4 h-4 flex-shrink-0 text-fluux-muted" />
              {t('chat.encryption.disableEncryption')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
