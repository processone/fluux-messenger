/**
 * Modal for managing MUC room affiliations (owners, admins, members, banned).
 *
 * Features:
 * - Tab-based view for each affiliation level
 * - Lazy loading: each tab queries on first activation
 * - Search/filter within the active tab
 * - Add new JID to an affiliation
 * - Change or remove affiliation per row
 * - Permission-aware: only shows actions the current user can perform
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import type { Room, RoomAffiliation } from '@fluux/sdk'
import { useRoom, getAvailableAffiliations } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { ContactSelector } from './ContactSelector'
import { buildRoomContactSuggestions } from '@/utils/roomSuggestions'
import { useToastStore } from '@/stores/toastStore'
import { Crown, Shield, UserCheck, Ban, UserPlus, Loader2, Search, X, ChevronDown } from 'lucide-react'

interface RoomMembersModalProps {
  room: Room
  onClose: () => void
}

type AffiliationTab = 'owner' | 'admin' | 'member' | 'outcast'

interface MemberEntry {
  jid: string
  nick?: string
  affiliation: RoomAffiliation
}

const TABS: AffiliationTab[] = ['owner', 'admin', 'member', 'outcast']

export function RoomMembersModal({ room, onClose }: RoomMembersModalProps) {
  const { t } = useTranslation()
  const { setAffiliation, queryAffiliationList } = useRoom()
  const addToast = useToastStore((s) => s.addToast)

  const selfOccupant = room.nickname ? room.occupants.get(room.nickname) : undefined
  const selfAffiliation: RoomAffiliation = selfOccupant?.affiliation ?? 'none'

  const [activeTab, setActiveTab] = useState<AffiliationTab>('member')
  const [members, setMembers] = useState<Record<AffiliationTab, MemberEntry[]>>({
    owner: [],
    admin: [],
    member: [],
    outcast: [],
  })
  const [loadedTabs, setLoadedTabs] = useState<Set<AffiliationTab>>(new Set())
  const [loadingTabs, setLoadingTabs] = useState<Set<AffiliationTab>>(new Set())
  const [search, setSearch] = useState('')
  const [jidSelection, setJidSelection] = useState<string[]>([])
  const [addingAffiliation, setAddingAffiliation] = useState<RoomAffiliation>('member')
  const [isAdding, setIsAdding] = useState(false)
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

  // Use a ref for the loading guard so useCallback doesn't re-create on every load cycle
  const loadingTabsRef = useRef(new Set<AffiliationTab>())

  const loadTab = useCallback(async (tab: AffiliationTab) => {
    if (loadingTabsRef.current.has(tab)) return
    loadingTabsRef.current.add(tab)
    setLoadingTabs(prev => new Set(prev).add(tab))
    try {
      const result = await queryAffiliationList(room.jid, tab)
      if (!mountedRef.current) return
      setMembers(prev => ({ ...prev, [tab]: result }))
      setLoadedTabs(prev => new Set(prev).add(tab))
    } catch {
      if (!mountedRef.current) return
      addToast('error', t('rooms.affiliationError'))
    } finally {
      loadingTabsRef.current.delete(tab)
      if (mountedRef.current) {
        setLoadingTabs(prev => {
          const next = new Set(prev)
          next.delete(tab)
          return next
        })
      }
    }
  }, [queryAffiliationList, room.jid, addToast, t])

  // Load initial tab on mount
  useEffect(() => {
    void loadTab(activeTab)
  }, [loadTab, activeTab])

  const handleTabChange = (tab: AffiliationTab) => {
    setActiveTab(tab)
    if (!loadedTabs.has(tab)) {
      void loadTab(tab)
    }
  }

  const handleChangeAffiliation = async (jid: string, currentAff: RoomAffiliation, newAff: RoomAffiliation) => {
    setActionInProgress(jid)
    try {
      await setAffiliation(room.jid, jid, newAff)
      addToast('success', t('rooms.affiliationChanged'))
      // Refresh both the source and target tabs
      const affectedTabs = new Set<AffiliationTab>()
      if (TABS.includes(currentAff as AffiliationTab)) affectedTabs.add(currentAff as AffiliationTab)
      if (TABS.includes(newAff as AffiliationTab)) affectedTabs.add(newAff as AffiliationTab)
      // Also reload 'none' targets by removing from current tab locally
      if (newAff === 'none') {
        setMembers(prev => ({
          ...prev,
          [currentAff]: prev[currentAff as AffiliationTab]?.filter(m => m.jid !== jid) ?? [],
        }))
      }
      for (const tab of affectedTabs) {
        // Re-query the tab to get fresh data
        try {
          const result = await queryAffiliationList(room.jid, tab)
          if (mountedRef.current) {
            setMembers(prev => ({ ...prev, [tab]: result }))
          }
        } catch { /* tab refresh failure is non-critical */ }
      }
    } catch {
      addToast('error', t('rooms.affiliationError'))
    } finally {
      if (mountedRef.current) setActionInProgress(null)
    }
  }

  const handleAddMember = async () => {
    const jid = jidSelection[0]
    if (!jid || !jid.includes('@')) return
    setIsAdding(true)
    try {
      await setAffiliation(room.jid, jid, addingAffiliation)
      addToast('success', t('rooms.memberAdded'))
      setJidSelection([])
      // Refresh the target tab
      if (TABS.includes(addingAffiliation as AffiliationTab)) {
        try {
          const result = await queryAffiliationList(room.jid, addingAffiliation as AffiliationTab)
          if (mountedRef.current) {
            setMembers(prev => ({ ...prev, [addingAffiliation]: result }))
          }
        } catch { /* non-critical */ }
      }
    } catch {
      addToast('error', t('rooms.affiliationError'))
    } finally {
      if (mountedRef.current) setIsAdding(false)
    }
  }

  const filteredMembers = (() => {
    const list = members[activeTab] || []
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter(m =>
      m.jid.toLowerCase().includes(q) ||
      (m.nick && m.nick.toLowerCase().includes(q))
    )
  })()

  const getTabIcon = (tab: AffiliationTab) => {
    switch (tab) {
      case 'owner': return <Crown className="w-3.5 h-3.5" />
      case 'admin': return <Shield className="w-3.5 h-3.5" />
      case 'member': return <UserCheck className="w-3.5 h-3.5" />
      case 'outcast': return <Ban className="w-3.5 h-3.5" />
    }
  }

  const getTabLabel = (tab: AffiliationTab) => {
    switch (tab) {
      case 'owner': return t('rooms.owners')
      case 'admin': return t('rooms.admins')
      case 'member': return t('rooms.members')
      case 'outcast': return t('rooms.banned')
    }
  }

  const getTabCount = (tab: AffiliationTab) => {
    return loadedTabs.has(tab) ? members[tab].length : undefined
  }

  // Determine which affiliations the current user can add
  const canAddAffiliations = (() => {
    const result: RoomAffiliation[] = []
    // For adding, we treat the "target" as having no current affiliation
    for (const aff of ['owner', 'admin', 'member', 'outcast'] as RoomAffiliation[]) {
      if (getAvailableAffiliations(selfAffiliation, 'none').includes(aff)) {
        result.push(aff)
      }
    }
    return result
  })()

  const canManage = selfAffiliation === 'owner' || selfAffiliation === 'admin'

  const extraSuggestions = buildRoomContactSuggestions(room)

  // Build excludeJids from all loaded affiliation members
  const selectorExcludeJids = (() => {
    const jids = new Set<string>()
    for (const tab of TABS) {
      for (const member of members[tab]) {
        jids.add(member.jid)
      }
    }
    return Array.from(jids)
  })()

  return (
    <ModalShell
      title={t('rooms.manageMembership')}
      onClose={onClose}
      width="max-w-xl"
      panelClassName="max-h-[80vh] flex flex-col"
    >
      {/* Segmented control */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex flex-wrap rounded-lg bg-fluux-hover/60 p-0.5">
          {TABS.map(tab => {
            const isActive = activeTab === tab
            const count = getTabCount(tab)
            return (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                className={`flex-1 min-w-[calc(50%-2px)] flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all
                  ${isActive
                    ? 'bg-fluux-bg text-fluux-text shadow-sm'
                    : 'text-fluux-muted hover:text-fluux-text'
                  }`}
              >
                {getTabIcon(tab)}
                <span className="truncate">{getTabLabel(tab)}</span>
                {count !== undefined && (
                  <span className={`text-[10px] ${isActive ? 'text-fluux-muted' : 'text-fluux-muted/60'}`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-fluux-hover">
        <div className="relative">
          <Search className="w-4 h-4 absolute start-2.5 top-1/2 -translate-y-1/2 text-fluux-muted" />
          <TextInput
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('rooms.searchMembers')}
            className="w-full ps-8 pe-8 py-1.5 text-sm bg-fluux-hover/50 rounded-lg border border-transparent
                       focus:border-fluux-brand/50 focus:outline-none text-fluux-text placeholder-fluux-muted"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-fluux-muted hover:text-fluux-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Member list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loadingTabs.has(activeTab) && !loadedTabs.has(activeTab) ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-fluux-muted" />
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="px-4 py-8 text-center text-fluux-muted text-sm">
            {t('rooms.noMembersInList')}
          </div>
        ) : (
          <div className="py-1">
            {filteredMembers.map(member => {
              const availableAffs = getAvailableAffiliations(selfAffiliation, member.affiliation)
              const isLoading = actionInProgress === member.jid

              return (
                <div
                  key={member.jid}
                  className="px-4 py-2 flex items-center gap-3 hover:bg-fluux-hover/50"
                >
                  {/* JID and nick */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fluux-text truncate">{member.jid}</p>
                    {member.nick && (
                      <p className="text-xs text-fluux-muted truncate">{member.nick}</p>
                    )}
                  </div>

                  {/* Action dropdown */}
                  {canManage && availableAffs.length > 0 && (
                    <div className="relative">
                      {isLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin text-fluux-muted" />
                      ) : (
                        <AffiliationDropdown
                          availableAffiliations={availableAffs}
                          currentAffiliation={member.affiliation}
                          onSelect={(newAff) => handleChangeAffiliation(member.jid, member.affiliation, newAff)}
                          t={t}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add member form */}
      {canManage && canAddAffiliations.length > 0 && (
        <div className="px-4 py-3 border-t border-fluux-hover">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <ContactSelector
                selectedContacts={jidSelection}
                onSelectionChange={setJidSelection}
                placeholder={t('rooms.jidPlaceholder')}
                excludeJids={selectorExcludeJids}
                extraSuggestions={extraSuggestions}
              />
            </div>
            <select
              id="add-member-affiliation"
              name="affiliation"
              aria-label={t('rooms.affiliationRole')}
              value={addingAffiliation}
              onChange={(e) => setAddingAffiliation(e.target.value as RoomAffiliation)}
              className="px-2 py-1.5 text-sm bg-fluux-hover/50 rounded-lg border border-transparent
                         focus:border-fluux-brand/50 focus:outline-none text-fluux-text"
            >
              {canAddAffiliations.map(aff => (
                <option key={aff} value={aff}>{getAffiliationLabel(aff, t)}</option>
              ))}
            </select>
            <button
              onClick={handleAddMember}
              disabled={jidSelection.length === 0 || isAdding}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-fluux-text-on-accent
                         bg-fluux-brand hover:bg-fluux-brand/80 disabled:opacity-50
                         rounded-lg transition-colors"
            >
              {isAdding ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4" />
              )}
              {t('rooms.addMember')}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  )
}

function getAffiliationLabel(aff: RoomAffiliation, t: (key: string) => string): string {
  switch (aff) {
    case 'owner': return t('rooms.affiliationOwner')
    case 'admin': return t('rooms.affiliationAdmin')
    case 'member': return t('rooms.affiliationMember')
    case 'outcast': return t('rooms.affiliationOutcast')
    case 'none': return t('rooms.affiliationNone')
    default: return aff
  }
}

/** Dropdown for changing a member's affiliation */
function AffiliationDropdown({
  availableAffiliations,
  currentAffiliation,
  onSelect,
  t,
}: {
  availableAffiliations: RoomAffiliation[]
  currentAffiliation: RoomAffiliation
  onSelect: (aff: RoomAffiliation) => void
  t: (key: string) => string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const getLabel = (aff: RoomAffiliation) => {
    switch (aff) {
      case 'owner': return t('rooms.makeOwner')
      case 'admin': return t('rooms.makeAdmin')
      case 'member': return t('rooms.makeMember')
      case 'none': return t('rooms.removeAffiliation')
      case 'outcast': return t('rooms.ban')
      default: return aff
    }
  }

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-fluux-muted hover:text-fluux-text
                   bg-fluux-hover/50 hover:bg-fluux-hover rounded transition-colors"
      >
        {getAffiliationLabel(currentAffiliation, t)}
        <ChevronDown className="w-3 h-3" />
      </button>
      {isOpen && (
        <div className="absolute end-0 top-full mt-1 bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50 min-w-36">
          {availableAffiliations.map(aff => (
            <button
              key={aff}
              onClick={() => {
                onSelect(aff)
                setIsOpen(false)
              }}
              className={`w-full px-3 py-1.5 text-start text-sm hover:bg-fluux-hover transition-colors
                ${aff === 'outcast' ? 'text-fluux-red' : 'text-fluux-text'}`}
            >
              {getLabel(aff)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
