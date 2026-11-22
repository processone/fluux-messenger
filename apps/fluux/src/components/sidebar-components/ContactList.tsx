import React, { useState, useRef, useLayoutEffect, useMemo, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useContextMenu, useTypeToFocus, useListKeyboardNav } from '@/hooks'
import { useContactIdentities, useRosterActions, useAdminPermissions, useEvents, useBlocking, rosterStore, matchNameOrJid, type Contact } from '@fluux/sdk'
import { useConnectionStore, useRosterStore } from '@fluux/sdk/react'
import { SubscriptionRequestItem } from './SubscriptionRequestItem'
import { Avatar } from '../Avatar'
import { RenameContactModal } from '../RenameContactModal'
import { Tooltip } from '../Tooltip'
import { useSidebarZone, ContactTooltipContent } from './types'
import { useSettingsStore } from '@/stores/settingsStore'
import { getTranslatedStatusText } from '@/utils/statusText'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { MessageCircle, Trash2, Pencil, Server, Users, Search } from 'lucide-react'
import { TextInput } from '../ui/TextInput'
import { ListEmpty } from '../ui/ListEmpty'
import { SidebarMenuPortal } from './SidebarMenuPortal'

interface ContactListProps {
  onStartChat?: (contact: Contact) => void
  onSelectContact?: (contact: Contact) => void
  onManageUser?: (jid: string) => void
  activeContactJid?: string | null
}

type ListRow =
  | { kind: 'requests'; key: string }
  | { kind: 'header'; key: string; title: string }
  | { kind: 'empty'; key: string; hasContacts: boolean }
  | { kind: 'contact'; key: string; jid: string; group: 'online' | 'offline' | 'errored'; lastInGroup: boolean }

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
  const { subscriptionRequests, acceptSubscription, rejectSubscription } = useEvents()
  const { blockJid } = useBlocking()
  const handleBlockRequest = async (jid: string) => {
    await rejectSubscription(jid)
    await blockJid(jid)
  }
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const [searchQuery, setSearchQuery] = useState('')
  const [renamingJid, setRenamingJid] = useState<string | null>(null)
  const renamingContact = useRosterStore((state) => renamingJid ? state.contacts.get(renamingJid) : undefined)
  // Removal ends this edit session, even if the same address is added later.
  useLayoutEffect(() => {
    if (renamingJid && !renamingContact) setRenamingJid(null)
  }, [renamingJid, renamingContact])
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Type-to-focus: focus search input when user starts typing anywhere
  useTypeToFocus(searchInputRef)

  // Search matches name (from identity-only data, presence-stable) or the local part.
  const query = searchQuery.trim().toLowerCase()
  const { online, offline, errored, flatJids } = useMemo(() => {
    const online: string[] = []
    const offline: string[] = []
    const errored: string[] = []
    const flatJids: string[] = []
    for (const entry of entries) {
      const sep = entry.indexOf(' ')
      const group = entry.slice(0, sep)
      const jid = entry.slice(sep + 1)
      if (query && !matchNameOrJid(identities.get(jid)?.name ?? '', jid, query)) continue
      flatJids.push(jid)
      if (group === 'errored') errored.push(jid)
      else if (forceOffline || group === 'offline') offline.push(jid)
      else online.push(jid)
    }
    return { online, offline, errored, flatJids }
  }, [entries, identities, query, forceOffline])
  const jidToIndex = useMemo(() => new Map(flatJids.map((jid, i) => [jid, i])), [flatJids])

  // Mount-scoped handlers keep row props stable. Publish the latest actions
  // after commit, so an abandoned render cannot change a visible row's actions.
  const latestRef = useRef({ onSelectContact, onStartChat, removeContact, onManageUser })
  useLayoutEffect(() => { latestRef.current = { onSelectContact, onStartChat, removeContact, onManageUser } })
  const [rowHandlers] = useState(() => ({
    onSelect: (contact: Contact) => latestRef.current.onSelectContact?.(contact),
    onStartChat: (contact: Contact) => latestRef.current.onStartChat?.(contact),
    onRemove: (jid: string) => latestRef.current.removeContact(jid),
    onRename: (contact: Contact) => setRenamingJid(contact.jid),
    onManageUser: (jid: string) => latestRef.current.onManageUser?.(jid),
  }))
  const onManageUserStable = onManageUser ? rowHandlers.onManageUser : undefined

  // Keyboard navigation works over the flat jid list; onSelect resolves jid -> contact.
  const [selectByJid] = useState(() => (jid: string) => {
    const contact = rosterStore.getState().contacts.get(jid)
    if (contact) rowHandlers.onSelect(contact)
  })
  const { selectedIndex, isKeyboardNav, getItemProps, getContainerProps } = useListKeyboardNav<string>({
    items: flatJids,
    onSelect: selectByJid,
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

  // Headers and requests share the contact scroll surface, so they participate
  // in the same measured window rather than shifting its offsets externally.
  const hasRequests = subscriptionRequests.length > 0
  const rows = useMemo(() => {
    const rows: ListRow[] = []
    if (hasRequests) rows.push({ kind: 'requests', key: 'requests' })
    for (const [group, title, jids] of [
      ['online', t('contacts.online'), online],
      ['offline', t('contacts.offline'), offline],
      ['errored', t('contacts.error'), errored],
    ] as const) {
      if (jids.length === 0) continue
      rows.push({ kind: 'header', key: `header:${group}`, title: `${title} — ${jids.length}` })
      jids.forEach((jid, index) => rows.push({ kind: 'contact', key: jid, jid, group, lastInGroup: index === jids.length - 1 }))
    }
    if (flatJids.length === 0) rows.push({ kind: 'empty', key: 'empty', hasContacts: entries.length > 0 })
    return rows
  }, [hasRequests, online, offline, errored, flatJids.length, entries.length, t])
  const rowIndexByJid = useMemo(() => new Map(rows.flatMap((row, index) => row.kind === 'contact' ? [[row.jid, index] as const] : [])), [rows])
  const selectedRowIndex = selectedJid ? rowIndexByJid.get(selectedJid) : undefined

  const renderRow = (row: ListRow) => {
    if (row.kind === 'requests') return (
      <div className="pb-2">
        <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 mt-2">
          {t('contacts.requestsHeading')} — {subscriptionRequests.length}
        </h3>
        {subscriptionRequests.map((request) => (
          <SubscriptionRequestItem
            key={request.id}
            request={request}
            onAccept={() => acceptSubscription(request.from)}
            onReject={() => rejectSubscription(request.from)}
            onBlock={() => handleBlockRequest(request.from)}
          />
        ))}
      </div>
    )
    if (row.kind === 'empty') return <ListEmpty icon={row.hasContacts ? Search : Users} title={t(row.hasContacts ? 'contacts.noContactsFound' : 'contacts.noContacts')} />
    if (row.kind === 'header') return <h3 className="px-2 pb-1 text-xs font-semibold text-fluux-muted uppercase">{row.title}</h3>
    const itemProps = getItemProps(jidToIndex.get(row.jid) ?? -1)
    return (
      <div data-contact-group={row.group} style={{ paddingBottom: row.lastInGroup ? 16 : 2 }}>
        <ContactItem
          jid={row.jid}
          isActive={row.jid === activeJid}
          isSelected={row.jid === selectedJid}
          isKeyboardNav={isKeyboardNav}
          onSelect={rowHandlers.onSelect}
          onStartChat={rowHandlers.onStartChat}
          onRemove={rowHandlers.onRemove}
          onRename={rowHandlers.onRename}
          onManageUser={onManageUserStable}
          onMouseEnter={itemProps.onMouseEnter}
          onMouseMove={itemProps.onMouseMove}
          forceOffline={forceOffline}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
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
                     border border-transparent
                     placeholder:text-fluux-muted"
        />
      </div>

      {/* Contact list */}
      <ContactListWindow
        rows={rows}
        listRef={listRef}
        containerProps={getContainerProps()}
        selectedJid={selectedJid}
        selectedRowIndex={selectedRowIndex}
        isKeyboardNav={isKeyboardNav}
        renderRow={renderRow}
      />
      {renamingContact && (
        <RenameContactModal
          contact={renamingContact}
          onRename={async (name) => {
            // Recheck at the write boundary as well as hiding the dialog on removal.
            if (rosterStore.getState().contacts.has(renamingContact.jid)) {
              await renameContact(renamingContact.jid, name)
            }
          }}
          onClose={() => setRenamingJid(null)}
        />
      )}
    </div>
  )
}

// TanStack's mutable instance cannot be memoized by React Compiler. Keep all
// instance reads/commands here; the required ContactList stays compiled and only
// passes immutable row data, selection and its renderer across this boundary.
function ContactListWindow({ rows, listRef, containerProps, selectedJid, selectedRowIndex, isKeyboardNav, renderRow }: {
  rows: ListRow[]
  listRef: React.RefObject<HTMLDivElement | null>
  containerProps: React.HTMLAttributes<HTMLDivElement>
  selectedJid: string | null
  selectedRowIndex: number | undefined
  isKeyboardNav: boolean
  renderRow: (row: ListRow) => React.ReactNode
}) {
  const getRowKey = useMemo(() => (index: number) => rows[index].key, [rows])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    getItemKey: getRowKey,
    estimateSize: (index) => rows[index].kind === 'header' ? 20 : 60,
    overscan: 6,
  })
  // The shared navigation hook targets mounted nodes synchronously. A keyboard
  // move outside the window has no node yet, so reveal it after selection commits.
  // Track identity rather than position to avoid jumping on a presence reorder.
  const lastKeyboardJid = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!isKeyboardNav) {
      lastKeyboardJid.current = null
      return
    }
    if (selectedJid === lastKeyboardJid.current) return
    lastKeyboardJid.current = selectedJid
    if (selectedRowIndex !== undefined) virtualizer.scrollToIndex(selectedRowIndex, { align: 'auto' })
  }, [selectedJid, isKeyboardNav, selectedRowIndex, virtualizer])

  return (
    // Own the host node so its ref attaches before this component's layout
    // effects connect the virtualizer, including a non-replaying release mount.
    <div ref={listRef} className="sidebar-scroll flex-1 min-h-0 overflow-y-auto px-2 pb-2" {...containerProps}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
          >
            {renderRow(rows[item.index])}
          </div>
        ))}
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
  onRename: (contact: Contact) => void
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
    onRename(contact)
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
          onTouchCancel={menu.handleTouchEnd}
          onMouseEnter={onMouseEnter}
          onMouseMove={onMouseMove}
          className={`w-full relative px-2 sidebar-row touch-menu-row ${isSelected && isKeyboardNav ? 'keyboard-focus-row' : ''} rounded border flex items-center text-start
                     transition-colors cursor-pointer ${
                       isActive
                         ? "bg-fluux-sidebar-item-active text-fluux-text border-transparent before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-fluux-sidebar-item-active-accent"
                         : isSelected
                           ? 'bg-fluux-hover text-fluux-text border-transparent'
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
        <SidebarMenuPortal menuRef={menu.menuRef} position={menu.position}>
          <button
            type="button"
            onClick={handleStartChat}
            className="focus-ring-inset w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
          >
            <MessageCircle className="size-4" />
            <span>{t('contacts.startChat')}</span>
          </button>
          <button
            type="button"
            onClick={handleRename}
            className="focus-ring-inset w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
          >
            <Pencil className="size-4" />
            <span>{t('contacts.rename')}</span>
          </button>
          {showManageOption && (
            <>
              <div className="my-1 border-t border-fluux-hover" />
              <button
                type="button"
                onClick={handleManage}
                className="focus-ring-inset w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
              >
                <Server className="size-4" />
                <span>{t('contacts.manage')}</span>
              </button>
            </>
          )}
          <div className="my-1 border-t border-fluux-hover" />
          <button
            type="button"
            onClick={handleRemove}
            className="focus-ring-inset w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-error hover:bg-fluux-red hover:text-white transition-colors"
          >
            <Trash2 className="size-4" />
            <span>{t('contacts.removeContact')}</span>
          </button>
        </SidebarMenuPortal>
      )}
    </>
  )
})
