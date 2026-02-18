import { useState, useRef, useCallback, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useContextMenu, useTypeToFocus, useListKeyboardNav } from '@/hooks'
import { useRoster, useAdmin, type Contact } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { Avatar } from '../Avatar'
import { RenameContactModal } from '../RenameContactModal'
import { Tooltip } from '../Tooltip'
import { useSidebarZone, ContactDevicesTooltip } from './types'
import { getTranslatedStatusText } from '@/utils/statusText'
import { MessageCircle, Trash2, Pencil, Wrench } from 'lucide-react'

interface ContactListProps {
  onStartChat?: (contact: Contact) => void
  onSelectContact?: (contact: Contact) => void
  onManageUser?: (jid: string) => void
  activeContactJid?: string | null
}

export function ContactList({ onStartChat, onSelectContact, onManageUser, activeContactJid }: ContactListProps) {
  const { t } = useTranslation()
  const { sortedContacts, removeContact, renameContact } = useRoster()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Type-to-focus: focus search input when user starts typing anywhere
  useTypeToFocus(searchInputRef)

  // Filter contacts based on search query
  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) {
      return sortedContacts
    }
    const query = searchQuery.toLowerCase()
    return sortedContacts.filter(contact => {
      const username = contact.jid.split('@')[0].toLowerCase()
      return contact.name.toLowerCase().includes(query) || username.includes(query)
    })
  }, [sortedContacts, searchQuery])

  const getDisplayPresence = useCallback(
    (contact: Contact) => (forceOffline ? 'offline' : contact.presence),
    [forceOffline]
  )

  // Flat list of contacts in display order (online, offline, errored)
  const flatContactList = useMemo(() => {
    const errored = filteredContacts.filter(c => c.presenceError)
    const online = filteredContacts.filter(c => !c.presenceError && getDisplayPresence(c) !== 'offline')
    const offline = filteredContacts.filter(c => !c.presenceError && getDisplayPresence(c) === 'offline')
    return [...online, ...offline, ...errored]
  }, [filteredContacts, getDisplayPresence])

  // Map from jid to flat index for quick lookup
  const jidToIndex = useMemo(() => new Map(flatContactList.map((c, i) => [c.jid, i])), [flatContactList])

  // Handle contact selection - single click opens profile and updates highlight
  const handleSelectContact = useCallback((contact: Contact) => {
    onSelectContact?.(contact)
  }, [onSelectContact])

  // Handle starting a chat - double click
  const handleStartChat = useCallback((contact: Contact) => {
    onStartChat?.(contact)
  }, [onStartChat])

  // Keyboard navigation using the hook
  // Plain arrows: just highlight, Alt+arrows: navigate AND open contact profile
  const { selectedIndex, isKeyboardNav, getItemProps, getContainerProps } = useListKeyboardNav({
    items: flatContactList,
    onSelect: handleSelectContact,
    listRef,
    searchInputRef,
    getItemId: (contact) => contact.jid,
    itemAttribute: 'data-contact-jid',
    zoneRef,
    enableBounce: true,
    activateOnAltNav: true, // Alt+arrow opens the contact profile
  })

  // Group filtered contacts
  const errored = filteredContacts.filter(c => c.presenceError)
  const online = filteredContacts.filter(c => !c.presenceError && getDisplayPresence(c) !== 'offline')
  const offline = filteredContacts.filter(c => !c.presenceError && getDisplayPresence(c) === 'offline')

  // Get selected contact JID for highlighting (keyboard selection takes precedence for navigation)
  const selectedJid = selectedIndex >= 0 ? (flatContactList[selectedIndex]?.jid ?? null) : (activeContactJid ?? null)

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="px-2 pt-2 pb-3">
        <input
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
        {sortedContacts.length === 0 ? (
          <div className="px-1 py-4 text-fluux-muted text-sm text-center">
            {t('contacts.noContacts')}
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="px-1 py-4 text-fluux-muted text-sm text-center">
            {t('contacts.noContactsFound')}
          </div>
        ) : (
          <>
            {online.length > 0 && (
              <ContactGroup
                title={`${t('contacts.online')} — ${online.length}`}
                contacts={online}
                selectedJid={selectedJid}
                isKeyboardNav={isKeyboardNav}
                jidToIndex={jidToIndex}
                onSelect={handleSelectContact}
                onStartChat={handleStartChat}
                onRemove={removeContact}
                onRename={renameContact}
                onManageUser={onManageUser}
                getItemProps={getItemProps}
                forceOffline={forceOffline}
              />
            )}
            {offline.length > 0 && (
              <ContactGroup
                title={`${t('contacts.offline')} — ${offline.length}`}
                contacts={offline}
                selectedJid={selectedJid}
                isKeyboardNav={isKeyboardNav}
                jidToIndex={jidToIndex}
                onSelect={handleSelectContact}
                onStartChat={handleStartChat}
                onRemove={removeContact}
                onRename={renameContact}
                onManageUser={onManageUser}
                getItemProps={getItemProps}
                forceOffline={forceOffline}
              />
            )}
            {errored.length > 0 && (
              <ContactGroup
                title={`${t('contacts.error')} — ${errored.length}`}
                contacts={errored}
                selectedJid={selectedJid}
                isKeyboardNav={isKeyboardNav}
                jidToIndex={jidToIndex}
                onSelect={handleSelectContact}
                onStartChat={handleStartChat}
                onRemove={removeContact}
                onRename={renameContact}
                onManageUser={onManageUser}
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
  contacts: Contact[]
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
    onMouseEnter: () => void
    onMouseMove: () => void
  }
  forceOffline: boolean
}

function ContactGroup({
  title,
  contacts,
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
        {contacts.map((contact) => {
          const flatIndex = jidToIndex.get(contact.jid) ?? -1
          const itemProps = getItemProps(flatIndex)
          return (
            <ContactItem
              key={contact.jid}
              contact={contact}
              isSelected={contact.jid === selectedJid}
              isKeyboardNav={isKeyboardNav}
              onSelect={() => onSelect(contact)}
              onStartChat={() => onStartChat(contact)}
              onRemove={() => onRemove(contact.jid)}
              onRename={(name) => onRename(contact.jid, name)}
              onManageUser={onManageUser ? () => onManageUser(contact.jid) : undefined}
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
  contact: Contact
  isSelected?: boolean
  isKeyboardNav?: boolean
  onSelect: () => void
  onStartChat: () => void
  onRemove: () => void
  onRename: (name: string) => Promise<void>
  onManageUser?: () => void
  onMouseEnter?: () => void
  onMouseMove?: () => void
  forceOffline: boolean
}

const ContactItem = memo(function ContactItem({
  contact,
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
  const { isAdmin, hasUserCommands, canManageUser } = useAdmin()

  // Check if admin can manage this specific user (based on vhost rights)
  const showManageOption = isAdmin && hasUserCommands && onManageUser && canManageUser(contact.jid)

  // Handle single-click to select contact (shows profile view)
  const handleClick = () => {
    if (menu.isOpen) return
    onSelect()
  }

  const handleStartChat = () => {
    menu.close()
    onStartChat()
  }

  const handleRemove = () => {
    menu.close()
    onRemove()
  }

  const handleRename = () => {
    menu.close()
    setShowRenameModal(true)
  }

  const handleManage = () => {
    menu.close()
    onManageUser?.()
  }

  return (
    <>
      <Tooltip
        content={<ContactDevicesTooltip contact={contact} t={t} forceOffline={forceOffline} />}
        position="right"
        delay={600}
        maxWidth={280}
        className="w-full"
      >
        <div
          data-contact-jid={contact.jid}
          onClick={handleClick}
          onDoubleClick={onStartChat}
          onContextMenu={menu.handleContextMenu}
          onTouchStart={menu.handleTouchStart}
          onTouchEnd={menu.handleTouchEnd}
          onTouchMove={menu.handleTouchEnd}
          onMouseEnter={onMouseEnter}
          onMouseMove={onMouseMove}
          className={`w-full px-2 py-1.5 rounded flex items-center gap-3 text-left
                     transition-colors cursor-pointer ${
                       isSelected
                         ? 'bg-fluux-hover text-fluux-text ring-1 ring-fluux-brand/50'
                         : isKeyboardNav
                           ? 'text-fluux-muted'
                           : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
                     }`}
        >
          {/* Avatar with presence indicator */}
          <Avatar
            identifier={contact.jid}
            name={contact.name}
            avatarUrl={contact.avatar}
            size="sm"
            presence={forceOffline ? 'offline' : contact.presence}
          />

          <div className="flex-1 min-w-0">
            <p className="truncate font-medium">{contact.name}</p>
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
            className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
          >
            <MessageCircle className="w-4 h-4" />
            <span>{t('contacts.startChat')}</span>
          </button>
          <button
            onClick={handleRename}
            className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
          >
            <Pencil className="w-4 h-4" />
            <span>{t('contacts.rename')}</span>
          </button>
          {showManageOption && (
            <>
              <div className="my-1 border-t border-fluux-hover" />
              <button
                onClick={handleManage}
                className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
              >
                <Wrench className="w-4 h-4" />
                <span>{t('contacts.manage')}</span>
              </button>
            </>
          )}
          <div className="my-1 border-t border-fluux-hover" />
          <button
            onClick={handleRemove}
            className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-red hover:bg-fluux-red hover:text-white transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            <span>{t('contacts.removeContact')}</span>
          </button>
        </div>
      )}

      {/* Rename Modal */}
      {showRenameModal && (
        <RenameContactModal
          contact={contact}
          onRename={onRename}
          onClose={() => setShowRenameModal(false)}
        />
      )}
    </>
  )
})
