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
import { useWindowDrag, useAnchoredMenu } from '@/hooks'
import { getTranslatedStatusText } from '@/utils/statusText'
import { Tooltip } from './Tooltip'
import { Archive, ArchiveRestore, ArrowLeft, Clock, Hash, Loader2, Lock, Search, Shield, ShieldAlert, ShieldCheck, ShieldOff, ShieldX, User } from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { useWebUnlockDialogStore } from '@/stores/webUnlockDialogStore'
import { HeaderOverflowKebab, type OverflowEntry } from './header/HeaderOverflowKebab'
import { inlineClass, kebabClass } from './header/headerOverflow'
import { trustVisual } from '@/e2ee/trustVisual'

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
  /** Whether the conversation is archived — selects the menu's Archive vs Unarchive item. 1:1 chats only. */
  isArchived?: boolean
  /** Archive the conversation from the overflow menu. 1:1 chats only. */
  onArchive?: () => void
  /** Unarchive the conversation from the overflow menu. 1:1 chats only. */
  onUnarchive?: () => void
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
  isArchived,
  onArchive,
  onUnarchive,
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const isGroupChat = type === 'groupchat'
  const { dragRegionProps } = useWindowDrag()

  // Subscribe to this specific contact's full data from the roster store
  // for presence display. This is a focused selector — only re-renders when
  // this specific contact changes, not when other contacts update.
  const fullContact = useRosterStore((s) => jid ? s.contacts.get(jid) : undefined)
  const contactTime = useContactTime(!isGroupChat ? jid : null)
  useLastActivity(!isGroupChat ? jid : null)

  // 1:1 overflow entries: search (collapses on narrow widths) + profile/archive
  // (always in the kebab). Group chats expose none of these.
  const overflowEntries: OverflowEntry[] = []
  if (onSearchInConversation) {
    overflowEntries.push({ kind: 'action', key: 'search', label: t('chat.searchInConversation', 'Search in conversation'), icon: Search, onSelect: onSearchInConversation, kebabClassName: kebabClass('search') })
  }
  if (!isGroupChat) {
    if (onShowProfile) {
      overflowEntries.push({ kind: 'action', key: 'profile', label: t('sidebar.viewProfile'), icon: User, onSelect: onShowProfile })
    }
    if (isArchived && onUnarchive) {
      overflowEntries.push({ kind: 'action', key: 'unarchive', label: t('conversations.unarchive'), icon: ArchiveRestore, onSelect: onUnarchive })
    } else if (!isArchived && onArchive) {
      overflowEntries.push({ kind: 'action', key: 'archive', label: t('conversations.archive'), icon: Archive, onSelect: onArchive })
    }
  }

  // When the kebab holds an always-shown entry (profile/archive on a 1:1), it must
  // stay visible at every width. When its only entry is the tier-collapsible search
  // (e.g. a group chat), the trigger should hide once search goes inline — otherwise
  // a wide header shows a kebab whose single row is container-query-hidden, i.e. an
  // empty menu. kebabClass('search') matches search's reveal threshold.
  const hasAlwaysShownEntry = overflowEntries.some((e) => !e.kebabClassName)
  const kebabWrapperClass = hasAlwaysShownEntry ? undefined : kebabClass('search')

  return (
    <header className="@container relative aurora-horizon h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-2 md:gap-3" {...dragRegionProps}>
      {/* Back button - mobile only */}
      {onBack && (
        <button
          onClick={onBack}
          className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden tap-target"
          aria-label={t('conversations.backToConversations')}
        >
          <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
        </button>
      )}

      {/* Avatar / Icon */}
      {isGroupChat ? (
        <div className="size-9 bg-fluux-bg rounded-xl flex items-center justify-center flex-shrink-0">
          <Hash className="size-5 text-fluux-muted" />
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

      {/* Name and status — the name is intentionally not clickable; "View Profile" lives in the kebab menu */}
      <div className="flex-1 min-w-0">
        <h2 className="font-semibold text-fluux-text truncate leading-tight">{name}</h2>
        {!isGroupChat && (
          <div className="flex items-center gap-1.5">
            <p className="text-xs text-fluux-muted truncate">
              {fullContact ? getTranslatedStatusText(fullContact, t) : jid}
            </p>
            {contactTime && (
              <Tooltip content={t('presence.localTime')} position="bottom" className="hidden @[400px]:inline-flex items-center">
                <span className="text-xs text-fluux-muted flex-shrink-0 flex items-center gap-1">
                  · <Clock className="size-3" />{contactTime}
                </span>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Trailing action cluster — grouped tightly on mobile (gap-1) so the
          shield reads as part of the menu; desktop keeps the header's md gap. */}
      <div className="flex items-center gap-1 md:gap-3">
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

        {/* Search in conversation — inline copy (collapses on narrow widths) */}
        {onSearchInConversation && (
          <div className={inlineClass('search')}>
            <button
              onClick={onSearchInConversation}
              className="p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
              aria-label={t('chat.searchInConversation', 'Search in conversation')}
              title={t('chat.searchInConversation', 'Search in conversation')}
            >
              <Search className="size-4" />
            </button>
          </div>
        )}

        {/* Overflow (kebab) menu */}
        <div className={kebabWrapperClass}>
          <HeaderOverflowKebab ariaLabel={t('contacts.actionsMenu')} entries={overflowEntries} />
        </div>
      </div>
    </header>
  )
}

function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}

function KeyLockedIcon({ fingerprint }: { fingerprint?: string }) {
  const { t } = useTranslation()
  const openWebUnlockDialog = useWebUnlockDialogStore((s) => s.openWebUnlockDialog)
  const btnClass = 'p-1.5 rounded transition-colors tap-target'
  const tooltip = (
    <div>
      <div>{t('chat.encryption.keyLockedTooltip')}</div>
      {fingerprint && (
        <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(fingerprint)}</div>
      )}
    </div>
  )
  return (
    <Tooltip content={tooltip} position="bottom">
      <button
        type="button"
        onClick={() => openWebUnlockDialog()}
        className={`${btnClass} ${trustVisual('keyLocked').colorClass} hover:text-fluux-text cursor-pointer`}
        aria-label={t('chat.encryption.keyLocked')}
      >
        <Lock className="size-4" />
      </button>
    </Tooltip>
  )
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
  const menu = useAnchoredMenu(open)
  const btnClass = 'p-1.5 rounded transition-colors tap-target'

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
          <Loader2 className="size-4 animate-spin" />
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
    if (onVerifyClick) {
      return (
        <Tooltip content={tooltip} position="bottom">
          <button
            type="button"
            className={`${btnClass} ${trustVisual('keyChanged').colorClass} cursor-pointer`}
            aria-label={t('chat.encryption.blockedTooltip')}
            onClick={onVerifyClick}
          >
            <ShieldAlert className="size-4" />
          </button>
        </Tooltip>
      )
    }
    return (
      <Tooltip content={tooltip} position="bottom">
        <div className={`${btnClass} ${trustVisual('keyChanged').colorClass}`} role="status">
          <ShieldAlert className="size-4" />
        </div>
      </Tooltip>
    )
  }

  if (state.kind === 'keyLocked') {
    return <KeyLockedIcon fingerprint={state.fingerprint} />
  }

  if (state.kind === 'rejected') {
    return (
      <div ref={containerRef} className="relative">
        <Tooltip content={t('chat.encryption.rejectedTooltip')} position="bottom" disabled={open}>
          <button
            ref={menu.triggerRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`${btnClass} ${trustVisual('rejected').colorClass} cursor-pointer`}
            aria-label={t('chat.encryption.rejected')}
            aria-expanded={open}
          >
            <ShieldX className="size-4" />
          </button>
        </Tooltip>
        {open && (
          <div
            ref={menu.menuRef}
            style={{ left: menu.position.x, top: menu.position.y }}
            className="fixed w-72 max-w-[calc(100vw-1rem)] rounded-lg fluux-popover z-50 py-2 px-3 overflow-hidden">
            <div className="text-sm font-medium text-fluux-error mb-1.5">
              {t('chat.encryption.rejectedTitle')}
            </div>
            <ul className="space-y-1.5">
              {state.reasons.map((r, i) => (
                <li key={i} className="text-xs text-fluux-muted">
                  <span className="font-medium text-fluux-text">
                    {t(`chat.encryption.rejectionCode.${r.code}`)}
                  </span>
                  {r.detail && (
                    <span className="block text-xs text-fluux-muted mt-0.5 font-mono break-all">
                      {r.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  // plaintextForced — open lock icon + popover to re-enable.
  if (state.kind === 'plaintextForced') {
    return (
      <div ref={containerRef} className="relative">
        <Tooltip content={t('chat.encryption.plaintextForcedTooltip')} position="bottom" disabled={open}>
          <button
            ref={menu.triggerRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`${btnClass} text-fluux-muted hover:text-fluux-text cursor-pointer`}
            aria-label={t('chat.encryption.plaintextForced')}
            aria-expanded={open}
          >
            <ShieldOff className="size-4" />
          </button>
        </Tooltip>
        {open && (
          <div
            ref={menu.menuRef}
            style={{ left: menu.position.x, top: menu.position.y }}
            className="fixed w-56 max-w-[calc(100vw-1rem)] rounded-lg fluux-popover z-50 py-1 overflow-hidden">
            {onEnableClick && (
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
                onClick={() => { setOpen(false); onEnableClick() }}
              >
                <Shield className="size-4 flex-shrink-0 text-fluux-muted" />
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
  const tofuNew = state.kind === 'encrypted' && state.trust === 'tofu-new'
  // `tofu-new` (freshly TOFU-pinned, unchanged, not yet OOB-verified) renders
  // the same neutral gray Shield as `unverified` — homogeneous with the Settings
  // → Encryption screen and the Security tab. `tofuNew` survives only to pick a
  // gentler tooltip below. The yellow ShieldAlert is now reserved exclusively
  // for the genuine `blocked` (key-changed) alert, so the two states no longer
  // share an alarming icon.
  const Icon = verified ? ShieldCheck : Shield
  const colorClass = verified
    ? trustVisual('verified').colorClass
    : `${trustVisual('trusted').colorClass} hover:text-fluux-text`
  const hasActions = onVerifyClick || onDisableClick

  if (!hasActions) {
    const tooltip = (
      <div>
        <div>{verified
          ? t('chat.encryption.verifiedTooltip')
          : tofuNew
            ? t('chat.encryption.tofuNewTooltip', 'New contact — verify fingerprint for full trust')
            : t('chat.encryption.openpgpTooltip')
        }</div>
        {state.kind === 'encrypted' && (
          <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(state.fingerprint)}</div>
        )}
      </div>
    )
    return (
      <Tooltip content={tooltip} position="bottom">
        <div className={`${btnClass} ${colorClass}`} role="status">
          <Icon className="size-4" />
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
            <div>{verified
              ? t('chat.encryption.verifiedTooltip')
              : tofuNew
                ? t('chat.encryption.tofuNewTooltip', 'New contact — verify fingerprint for full trust')
                : t('chat.encryption.openpgpTooltip')
            }</div>
            <div className="font-mono text-xs mt-0.5 opacity-75">{formatFingerprint(state.fingerprint)}</div>
          </div>
        ) : null}
        position="bottom"
        disabled={open}
      >
        <button
          ref={menu.triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`${btnClass} ${colorClass} cursor-pointer`}
          aria-label={ariaLabel}
          aria-expanded={open}
        >
          <Icon className="size-4" />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={menu.menuRef}
          style={{ left: menu.position.x, top: menu.position.y }}
          className="fixed w-56 max-w-[calc(100vw-1rem)] rounded-lg fluux-popover z-50 py-1 overflow-hidden">
          {onVerifyClick && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
              onClick={() => { setOpen(false); onVerifyClick() }}
            >
              <ShieldCheck className={`size-4 flex-shrink-0 ${verified ? 'text-fluux-encryption' : 'text-fluux-muted'}`} />
              {verified
                ? t('chat.verifyPeer.menuViewVerified', { name: peerName })
                : t('chat.verifyPeer.dialogTitle', { name: peerName })}
            </button>
          )}
          {onDisableClick && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
              onClick={() => { setOpen(false); onDisableClick() }}
            >
              <ShieldOff className="size-4 flex-shrink-0 text-fluux-muted" />
              {t('chat.encryption.disableEncryption')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
