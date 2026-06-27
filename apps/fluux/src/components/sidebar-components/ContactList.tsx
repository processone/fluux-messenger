import React, { useState, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useContextMenu, useTypeToFocus, useListKeyboardNav } from '@/hooks'
import { useContactIdentities, useRosterActions, useAdminPermissions, rosterStore, type Contact } from '@fluux/sdk'
import { useConnectionStore, useRosterStore } from '@fluux/sdk/react'
import { Avatar } from '../Avatar'
import { RenameContactModal } from '../RenameContactModal'
import { Tooltip } from '../Tooltip'
import { useSidebarZone, ContactTooltipContent } from './types'
import { useSettingsStore } from '@/stores/settingsStore'
import { getTranslatedStatusText } from '@/utils/statusText'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { MessageCircle, Trash2, Pencil, Server } from 'lucide-react'
import { TextInput } from '../ui/TextInput'

interface ContactListProps {
  onStartChat?: (contact: Contact) => void
  onSelectContact?: (contact: Contact) => void
  onManageUser?: (jid: string) => void
  activeContactJid?: string | null
}

export function ContactList({ onStartChat, onSelectContact, onManageUser, activeContactJid }: ContactListProps) {
  detectRenderLoop('ContactList')
  const { t } = useTranslation()
  // Subscribe to the group-encoded, sidebar-ordered contact entries (presence-stable
  // under useShallow: a flap that stays in the same group does NOT re-render the list)
  // and to identity-only data for search (also presence-stable). Each ContactItem
  // self-subscribes to its own contact by jid. (Mirrors RoomsList / ConversationList.)
  const entries = useRosterStore(useShallow((s) => s.contactSidebarEntries()))
  const identities = useContactIdentities()
  const { removeContact, renameContact } = useRosterActions()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Type-to-focus: focus search input when user starts typing anywhere
  useTypeToFocus(searchInputRef)

  // Search matches name (from identity-only data, presence-stable) or the local part.
  const query = searchQuery.trim().toLowerCase()
  const matchesQuery = (jid: string) => {
    if (!query) return true
    const name = identities.get(jid)?.name.toLowerCase() ?? ''
    return name.includes(query) || jid.split('@')[0].toLowerCase().includes(query)
  }

  // Decode entries into display sections (jids). When disconnected (forceOffline),
  // every non-errored contact shows in the offline section. flatJids is the flat
  // top-to-bottom order used for keyboard navigation.
  const online: string[] = []
  const offline: string[] = []
  const errored: string[] = []
  const flatJids: string[] = []
  for (const entry of entries) {
    const sep = entry.indexOf(' ')
    const group = entry.slice(0, sep)
    const jid = entry.slice(sep + 1)
    if (!matchesQuery(jid)) continue
    flatJids.push(jid)
    if (group === 'errored') errored.push(jid)
    else if (forceOffline || group === 'offline') offline.push(jid)
    else online.push(jid)
  }
  const jidToIndex = new Map(flatJids.map((jid, i) => [jid, i]))

  // Reference-STABLE row callbacks for the memoized ContactItem. Their identity must stay
  // fixed across re-renders or the memo no-ops and the WHOLE roster re-renders row by row.
  // Same lazy-init + "latest" ref pattern as RoomsList (compiler-proof; useCallback is
  // stripped). onSelect / onStartChat take the Contact (ContactItem self-subscribes and
  // passes its own); the rest take a jid.
  const latestRef = useRef({ onSelectContact, onStartChat, removeContact, renameContact, onManageUser })
  latestRef.current = { onSelectContact, onStartChat, removeContact, renameContact, onManageUser }
  const rowHandlersRef = useRef<{
    onSelect: (contact: Contact) => void
    onStartChat: (contact: Contact) => void
    onRemove: (jid: string) => void
    onRename: (jid: string, name: string) => Promise<void>
    onManageUser: (jid: string) => void
  } | null>(null)
  if (!rowHandlersRef.current) {
    rowHandlersRef.current = {
      onSelect: (contact) => latestRef.current.onSelectContact?.(contact),
      onStartChat: (contact) => latestRef.current.onStartChat?.(contact),
      onRemove: (jid) => latestRef.current.removeContact(jid),
      onRename: (jid, name) => latestRef.current.renameContact(jid, name),
      onManageUser: (jid) => latestRef.current.onManageUser?.(jid),
    }
  }
  const rowHandlers = rowHandlersRef.current
  const onManageUserStable = onManageUser ? rowHandlers.onManageUser : undefined

  // Keyboard navigation works over the flat jid list; onSelect resolves jid -> contact.
  const selectByJidRef = useRef<((jid: string) => void) | null>(null)
  if (!selectByJidRef.current) {
    selectByJidRef.current = (jid: string) => {
      const c = rosterStore.getState().contacts.get(jid)
      if (c) rowHandlers.onSelect(c)
    }
  }
  const { selectedIndex, isKeyboardNav, getItemProps, getContainerProps } = useListKeyboardNav<string>({
    items: flatJids,
    onSelect: selectByJidRef.current,
    listRef,
    searchInputRef,
    getItemId: (jid) => jid,
    itemAttribute: 'data-contact-jid',
    zoneRef,
    enableBounce: true,
    activateOnAltNav: true, // Alt+arrow opens the contact profile
  })

  // Active contact gets the marker-bar treatment (parity with Messages/Rooms).
  // Keyboard-nav highlight is a separate, transient state that can coexist with active.
  const activeJid = activeContactJid ?? null
  const selectedJid = selectedIndex >= 0 ? (flatJids[selectedIndex] ?? null) : null

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="px-2 pt-2 pb-3">
        <TextInput
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.currentTarget.blur()
            }
          }}
          placeholder={t('contacts.searchContacts')}
          className="w-full px-3 py-2 bg-fluux-bg text-fluux-text text-sm rounded
                     border border-transparent focus:border-fluux-brand
                     placeholder:text-fluux-muted"
        />
      </div>

      {/* Contact list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2" {...getContainerProps()}>
        {entries.length === 0 ? (
          <div className="px-1 py-4 text-fluux-muted text-sm text-center">
            {t('contacts.noContacts')}
          </div>
        ) : flatJids.length === 0 ? (
          <div className="px-1 py-4 text-fluux-muted text-sm text-center">
            {t('contacts.noContactsFound')}
          </div>
        ) : (
          <>
            {online.length > 0 && (
              <ContactGroup
                title={`${t('contacts.online')} — ${online.length}`}
                jids={online}
                activeJid={activeJid}
                selectedJid={selectedJid}
                isKeyboardNav={isKeyboardNav}
                jidToIndex={jidToIndex}
                onSelect={rowHandlers.onSelect}
                onStartChat={rowHandlers.onStartChat}
                onRemove={rowHandlers.onRemove}
                onRename={rowHandlers.onRename}
                onManageUser={onManageUserStable}
                getItemProps={getItemProps}
                forceOffline={forceOffline}
              />
            )}
            {offline.length > 0 && (
              <ContactGroup
                title={`${t('contacts.offline')} — ${offline.length}`}
                jids={offline}
                activeJid={activeJid}
                selectedJid={selectedJid}
                isKeyboardNav={isKeyboardNav}
                jidToIndex={jidToIndex}
                onSelect={rowHandlers.onSelect}
                onStartChat={rowHandlers.onStartChat}
                onRemove={rowHandlers.onRemove}
                onRename={rowHandlers.onRename}
                onManageUser={onManageUserStable}
                getItemProps={getItemProps}
                forceOffline={forceOffline}
              />
            )}
            {errored.length > 0 && (
              <ContactGroup
                title={`${t('contacts.error')} — ${errored.length}`}
                jids={errored}
                activeJid={activeJid}
                selectedJid={selectedJid}
                isKeyboardNav={isKeyboardNav}
                jidToIndex={jidToIndex}
                onSelect={rowHandlers.onSelect}
                onStartChat={rowHandlers.onStartChat}
                onRemove={rowHandlers.onRemove}
                onRename={rowHandlers.onRename}
                onManageUser={onManageUserStable}
                getItemProps={getItemProps}
                forceOffline={forceOffline}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface ContactGroupProps {
  title: string
  jids: string[]
  activeJid: string | null
  selectedJid: string | null
  isKeyboardNav: boolean
  jidToIndex: Map<string, number>
  onSelect: (contact: Contact) => void
  onStartChat: (contact: Contact) => void
  onRemove: (jid: string) => void
  onRename: (jid: string, name: string) => Promise<void>
  onManageUser?: (jid: string) => void
  getItemProps: (index: number) => {
    'data-selected': boolean
    onMouseEnter: (e: React.MouseEvent) => void
    onMouseMove: (e: React.MouseEvent) => void
  }
  forceOffline: boolean
}

function ContactGroup({
  title,
  jids,
  activeJid,
  selectedJid,
  isKeyboardNav,
  jidToIndex,
  onSelect,
  onStartChat,
  onRemove,
  onRename,
  onManageUser,
  getItemProps,
  forceOffline,
}: ContactGroupProps) {
  return (
    <div className="mb-4">
      <h3 className="px-2 mb-1 text-xs font-semibold text-fluux-muted uppercase">
        {title}
      </h3>
      <div className="space-y-0.5">
        {jids.map((jid) => {
          const flatIndex = jidToIndex.get(jid) ?? -1
          const itemProps = getItemProps(flatIndex)
          return (
            <ContactItem
              key={jid}
              jid={jid}
              isActive={jid === activeJid}
              isSelected={jid === selectedJid}
              isKeyboardNav={isKeyboardNav}
              onSelect={onSelect}
              onStartChat={onStartChat}
              onRemove={onRemove}
              onRename={onRename}
              onManageUser={onManageUser}
              onMouseEnter={itemProps.onMouseEnter}
              onMouseMove={itemProps.onMouseMove}
              forceOffline={forceOffline}
            />
          )
        })}
      </div>
    </div>
  )
}

interface ContactItemProps {
  jid: string
  isActive?: boolean
  isSelected?: boolean
  isKeyboardNav?: boolean
  onSelect: (contact: Contact) => void
  onStartChat: (contact: Contact) => void
  onRemove: (jid: string) => void
  onRename: (jid: string, name: string) => Promise<void>
  onManageUser?: (jid: string) => void
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseMove?: (e: React.MouseEvent) => void
  forceOffline: boolean
}

const ContactItem = memo(function ContactItem({
  jid,
  isActive,
  isSelected,
  isKeyboardNav,
  onSelect,
  onStartChat,
  onRemove,
  onRename,
  onManageUser,
  onMouseEnter,
  onMouseMove,
  forceOffline,
}: ContactItemProps) {
  const { t } = useTranslation()
  const menu = useContextMenu()
  const [showRenameModal, setShowRenameModal] = useState(false)
  // Focused permission hook — useAdmin() subscribes to ~15 admin store
  // values; ContactItem only needs these three. Each ContactItem instance
  // gets its own subscription, so narrower selectors mean fewer rows
  // re-render on unrelated admin store updates.
  const { isAdmin, hasUserCommands, canManageUser } = useAdminPermissions()
  // Per-row subscription: this row re-renders only when ITS contact changes
  // (presence, avatar, name), not when any other contact's presence flaps.
  const contact = useRosterStore((s) => s.contacts.get(jid))
  const densityMode = useSettingsStore((s) => s.densityMode)

  if (!contact) return null

  const avatarSize = densityMode === 'compact' ? 'sm' : 'md'

  // Check if admin can manage this specific user (based on vhost rights)
  const showManageOption = isAdmin && hasUserCommands && onManageUser && canManageUser(jid)

  // Handle single-click to select contact (shows profile view)
  const handleClick = () => {
    if (menu.isOpen) return
    onSelect(contact)
  }

  const handleStartChat = () => {
    menu.close()
    onStartChat(contact)
  }

  const handleRemove = () => {
    menu.close()
    onRemove(jid)
  }

  const handleRename = () => {
    menu.close()
    setShowRenameModal(true)
  }

  const handleManage = () => {
    menu.close()
    onManageUser?.(jid)
  }

  return (
    <>
      <Tooltip
        content={<ContactTooltipContent contact={contact} t={t} forceOffline={forceOffline} />}
        position="right"
        delay={600}
        maxWidth={280}
        className="w-full"
      >
        <div
          data-contact-jid={contact.jid}
          onClick={handleClick}
          onDoubleClick={() => onStartChat(contact)}
          onContextMenu={menu.handleContextMenu}
          onTouchStart={menu.handleTouchStart}
          onTouchEnd={menu.handleTouchEnd}
          onTouchMove={menu.handleTouchEnd}
          onMouseEnter={onMouseEnter}
          onMouseMove={onMouseMove}
          className={`w-full relative px-2 sidebar-row rounded border flex items-center text-start
                     transition-colors cursor-pointer ${
                       isActive
                         ? "bg-fluux-sidebar-item-active text-fluux-text border-transparent before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-fluux-sidebar-item-active-accent"
                         : isSelected
                           ? 'bg-fluux-hover text-fluux-text border-fluux-brand'
                           : isKeyboardNav
                             ? 'text-fluux-muted border-transparent'
                             : 'text-fluux-muted border-transparent hover:bg-fluux-hover hover:text-fluux-text'
                     }`}
        >
          {/* Avatar with presence indicator */}
          <Avatar
            identifier={contact.jid}
            name={contact.name}
            avatarUrl={contact.avatar}
            size={avatarSize}
            presence={forceOffline ? 'offline' : contact.presence}
            forceOffline={forceOffline}
          />

          <div className="flex-1 min-w-0">
            <p dir="auto" className="truncate font-medium">{contact.name}</p>
            {contact.presenceError ? (
              <p className="truncate text-xs opacity-75">{contact.presenceError}</p>
            ) : forceOffline ? (
              <p className="truncate text-xs opacity-75">{t('presence.offline')}</p>
            ) : contact.statusMessage ? (
              <p className="truncate text-xs opacity-75">{contact.statusMessage}</p>
            ) : (
              <p className="truncate text-xs opacity-75">{getTranslatedStatusText(contact, t)}</p>
            )}
          </div>
        </div>
      </Tooltip>

      {/* Context Menu */}
      {menu.isOpen && (
        <div
          ref={menu.menuRef}
          className="fixed bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50 min-w-40"
          style={{ left: menu.position.x, top: menu.position.y }}
        >
          <button
            onClick={handleStartChat}
            className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
          >
            <MessageCircle className="size-4" />
            <span>{t('contacts.startChat')}</span>
          </button>
          <button
            onClick={handleRename}
            className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
          >
            <Pencil className="size-4" />
            <span>{t('contacts.rename')}</span>
          </button>
          {showManageOption && (
            <>
              <div className="my-1 border-t border-fluux-hover" />
              <button
                onClick={handleManage}
                className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
              >
                <Server className="size-4" />
                <span>{t('contacts.manage')}</span>
              </button>
            </>
          )}
          <div className="my-1 border-t border-fluux-hover" />
          <button
            onClick={handleRemove}
            className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-error hover:bg-fluux-red hover:text-white transition-colors"
          >
            <Trash2 className="size-4" />
            <span>{t('contacts.removeContact')}</span>
          </button>
        </div>
      )}

      {/* Rename Modal */}
      {showRenameModal && (
        <RenameContactModal
          contact={contact}
          onRename={(name) => onRename(contact.jid, name)}
          onClose={() => setShowRenameModal(false)}
        />
      )}
    </>
  )
})
