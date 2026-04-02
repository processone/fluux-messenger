/**
 * Modal for managing XEP-0317 Hats in a MUC room.
 *
 * Two tabs:
 * - **Definitions** — CRUD for hat definitions (title, URI, optional color hue)
 * - **Assignments** — assign / unassign existing hats to room members by JID
 *
 * Owner-only: visibility is enforced by the caller (RoomHeader).
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import type { Room, Hat } from '@fluux/sdk'
import { useRoom, generateConsistentColorHexSync } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { ConfirmDialog } from './ConfirmDialog'
import { ContactSelector } from './ContactSelector'
import { buildRoomContactSuggestions } from '@/utils/roomSuggestions'
import { useToastStore } from '@/stores/toastStore'
import { Loader2, Search, X, Plus, Trash2 } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoomHatsModalProps {
  room: Room
  onClose: () => void
}

type Tab = 'definitions' | 'assignments'

interface HatAssignment {
  jid: string
  uri: string
  title: string
  hue?: number
}

// ---------------------------------------------------------------------------
// Hat color helper (same logic as OccupantPanel / RoomView)
// ---------------------------------------------------------------------------

function getHatColors(hat: { uri: string; hue?: number }) {
  if (hat.hue !== undefined) {
    return {
      backgroundColor: `hsl(${hat.hue}, 50%, 85%)`,
      color: `hsl(${hat.hue}, 70%, 25%)`,
    }
  }
  const bgColor = generateConsistentColorHexSync(hat.uri, { saturation: 50, lightness: 85 })
  const textColor = generateConsistentColorHexSync(hat.uri, { saturation: 70, lightness: 25 })
  return { backgroundColor: bgColor, color: textColor }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoomHatsModal({ room, onClose }: RoomHatsModalProps) {
  const { t } = useTranslation()
  const { listHats, createHat, destroyHat, listHatAssignments, assignHat, unassignHat } = useRoom()
  const addToast = useToastStore((s) => s.addToast)

  // --- Tab state ---
  const [activeTab, setActiveTab] = useState<Tab>('definitions')

  // --- Definitions state ---
  const [hats, setHats] = useState<Hat[]>([])
  const [hatsLoaded, setHatsLoaded] = useState(false)
  const [hatsLoading, setHatsLoading] = useState(false)

  // --- Assignments state ---
  const [assignments, setAssignments] = useState<HatAssignment[]>([])
  const [assignmentsLoaded, setAssignmentsLoaded] = useState(false)
  const [assignmentsLoading, setAssignmentsLoading] = useState(false)

  // --- Add-hat form ---
  const [newTitle, setNewTitle] = useState('')
  const [newUri, setNewUri] = useState('')
  const [newHue, setNewHue] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // --- Assign form ---
  const [jidSelection, setJidSelection] = useState<string[]>([])
  const [assignUri, setAssignUri] = useState('')
  const [isAssigning, setIsAssigning] = useState(false)

  // --- Confirm delete ---
  const [confirmDelete, setConfirmDelete] = useState<Hat | null>(null)

  // --- Action in progress (for per-row spinners) ---
  const [actionKey, setActionKey] = useState<string | null>(null)

  const [search, setSearch] = useState('')

  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const extraSuggestions = buildRoomContactSuggestions(room)

  // Exclude JIDs that already have the selected hat assigned
  const selectorExcludeJids = (() => {
    if (!assignUri) return []
    return assignments
      .filter(a => a.uri === assignUri)
      .map(a => a.jid)
  })()

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  // Use refs for loading guards so useCallback doesn't re-create on every load cycle
  const hatsLoadingRef = useRef(false)
  const assignmentsLoadingRef = useRef(false)

  const loadDefinitions = useCallback(async () => {
    if (hatsLoadingRef.current) return
    hatsLoadingRef.current = true
    setHatsLoading(true)
    try {
      const result = await listHats(room.jid)
      if (mountedRef.current) {
        setHats(result)
        setHatsLoaded(true)
      }
    } catch {
      if (mountedRef.current) addToast('error', t('rooms.hatCreateError'))
    } finally {
      hatsLoadingRef.current = false
      if (mountedRef.current) setHatsLoading(false)
    }
  }, [listHats, room.jid, addToast, t])

  const loadAssignments = useCallback(async () => {
    if (assignmentsLoadingRef.current) return
    assignmentsLoadingRef.current = true
    setAssignmentsLoading(true)
    try {
      const result = await listHatAssignments(room.jid)
      if (mountedRef.current) {
        setAssignments(result)
        setAssignmentsLoaded(true)
      }
    } catch {
      if (mountedRef.current) addToast('error', t('rooms.hatAssignError'))
    } finally {
      assignmentsLoadingRef.current = false
      if (mountedRef.current) setAssignmentsLoading(false)
    }
  }, [listHatAssignments, room.jid, addToast, t])

  // Load definitions on mount
  useEffect(() => {
    void loadDefinitions()
  }, [loadDefinitions])

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    setSearch('')
    if (tab === 'definitions' && !hatsLoaded) void loadDefinitions()
    if (tab === 'assignments' && !assignmentsLoaded) void loadAssignments()
  }

  // Also auto-load definitions for the assignments tab (needed for hat dropdown)
  useEffect(() => {
    if (activeTab === 'assignments' && !hatsLoaded) {
      void loadDefinitions()
    }
  }, [activeTab, hatsLoaded, loadDefinitions])

  // ---------------------------------------------------------------------------
  // Actions — Definitions
  // ---------------------------------------------------------------------------

  const handleCreate = async () => {
    const title = newTitle.trim()
    const uri = newUri.trim()
    if (!title || !uri) return
    setIsCreating(true)
    try {
      const hue = newHue.trim() ? parseFloat(newHue.trim()) : undefined
      await createHat(room.jid, title, uri, hue)
      addToast('success', t('rooms.hatCreated'))
      setNewTitle('')
      setNewUri('')
      setNewHue('')
      // Refresh
      const result = await listHats(room.jid)
      if (mountedRef.current) setHats(result)
    } catch {
      addToast('error', t('rooms.hatCreateError'))
    } finally {
      if (mountedRef.current) setIsCreating(false)
    }
  }

  const handleDestroy = async (hat: Hat) => {
    setActionKey(hat.uri)
    try {
      await destroyHat(room.jid, hat.uri)
      addToast('success', t('rooms.hatDestroyed'))
      // Refresh both tabs
      const result = await listHats(room.jid)
      if (mountedRef.current) setHats(result)
      if (assignmentsLoaded) {
        const a = await listHatAssignments(room.jid)
        if (mountedRef.current) setAssignments(a)
      }
    } catch {
      addToast('error', t('rooms.hatDestroyError'))
    } finally {
      if (mountedRef.current) {
        setActionKey(null)
        setConfirmDelete(null)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Actions — Assignments
  // ---------------------------------------------------------------------------

  const handleAssign = async () => {
    if (jidSelection.length === 0 || !assignUri) return
    setIsAssigning(true)
    try {
      for (const jid of jidSelection) {
        await assignHat(room.jid, jid, assignUri)
      }
      addToast('success', t('rooms.hatAssigned'))
      setJidSelection([])
      // Refresh
      const result = await listHatAssignments(room.jid)
      if (mountedRef.current) setAssignments(result)
    } catch {
      addToast('error', t('rooms.hatAssignError'))
    } finally {
      if (mountedRef.current) setIsAssigning(false)
    }
  }

  const handleUnassign = async (a: HatAssignment) => {
    const key = `${a.jid}:${a.uri}`
    setActionKey(key)
    try {
      await unassignHat(room.jid, a.jid, a.uri)
      addToast('success', t('rooms.hatUnassigned'))
      const result = await listHatAssignments(room.jid)
      if (mountedRef.current) setAssignments(result)
    } catch {
      addToast('error', t('rooms.hatUnassignError'))
    } finally {
      if (mountedRef.current) setActionKey(null)
    }
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  const filteredHats = (() => {
    if (!search) return hats
    const q = search.toLowerCase()
    return hats.filter(h => h.title.toLowerCase().includes(q) || h.uri.toLowerCase().includes(q))
  })()

  const filteredAssignments = (() => {
    if (!search) return assignments
    const q = search.toLowerCase()
    return assignments.filter(a =>
      a.jid.toLowerCase().includes(q) ||
      a.title.toLowerCase().includes(q) ||
      a.uri.toLowerCase().includes(q)
    )
  })()

  // Pre-select first hat in dropdown if none selected
  useEffect(() => {
    if (!assignUri && hats.length > 0) {
      setAssignUri(hats[0].uri)
    }
  }, [hats, assignUri])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isLoadingTab = activeTab === 'definitions'
    ? hatsLoading && !hatsLoaded
    : assignmentsLoading && !assignmentsLoaded

  return (
    <ModalShell
      title={t('rooms.manageHats')}
      onClose={onClose}
      width="max-w-xl"
      panelClassName="max-h-[80vh] flex flex-col"
    >
      {/* Tab bar */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex rounded-lg bg-fluux-hover/60 p-0.5">
          {(['definitions', 'assignments'] as Tab[]).map(tab => {
            const isActive = activeTab === tab
            const label = tab === 'definitions' ? t('rooms.hatsDefinitions') : t('rooms.hatsAssignments')
            const count = tab === 'definitions'
              ? (hatsLoaded ? hats.length : undefined)
              : (assignmentsLoaded ? assignments.length : undefined)
            return (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all
                  ${isActive
                    ? 'bg-fluux-bg text-fluux-text shadow-sm'
                    : 'text-fluux-muted hover:text-fluux-text'
                  }`}
              >
                <span>{label}</span>
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
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-fluux-muted" />
          <TextInput
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={activeTab === 'definitions' ? t('rooms.hatTitlePlaceholder') : t('rooms.hatJidPlaceholder')}
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-fluux-hover/50 rounded-lg border border-transparent
                       focus:border-fluux-brand/50 focus:outline-none text-fluux-text placeholder-fluux-muted"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fluux-muted hover:text-fluux-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoadingTab ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-fluux-muted" />
          </div>
        ) : activeTab === 'definitions' ? (
          /* ---- Definitions list ---- */
          filteredHats.length === 0 ? (
            <div className="px-4 py-8 text-center text-fluux-muted text-sm">
              {t('rooms.noHats')}
            </div>
          ) : (
            <div className="py-1">
              {filteredHats.map(hat => {
                const colors = getHatColors(hat)
                const isDeleting = actionKey === hat.uri
                return (
                  <div key={hat.uri} className="px-4 py-2 flex items-center gap-3 hover:bg-fluux-hover/50">
                    {/* Color badge */}
                    <span
                      className="inline-block px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap"
                      style={colors}
                    >
                      {hat.title}
                    </span>
                    {/* URI */}
                    <span className="flex-1 text-xs text-fluux-muted truncate">{hat.uri}</span>
                    {/* Delete */}
                    {isDeleting ? (
                      <Loader2 className="w-4 h-4 animate-spin text-fluux-muted" />
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(hat)}
                        className="p-1 text-fluux-muted hover:text-fluux-red transition-colors"
                        title={t('rooms.destroyHat')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        ) : (
          /* ---- Assignments list ---- */
          filteredAssignments.length === 0 ? (
            <div className="px-4 py-8 text-center text-fluux-muted text-sm">
              {t('rooms.noAssignments')}
            </div>
          ) : (
            <div className="py-1">
              {filteredAssignments.map((a) => {
                const colors = getHatColors(a)
                const key = `${a.jid}:${a.uri}`
                const isRemoving = actionKey === key
                return (
                  <div key={key} className="px-4 py-2 flex items-center gap-3 hover:bg-fluux-hover/50">
                    {/* JID */}
                    <span className="flex-1 text-sm text-fluux-text truncate">{a.jid}</span>
                    {/* Hat badge */}
                    <span
                      className="inline-block px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap"
                      style={colors}
                    >
                      {a.title}
                    </span>
                    {/* Unassign */}
                    {isRemoving ? (
                      <Loader2 className="w-4 h-4 animate-spin text-fluux-muted" />
                    ) : (
                      <button
                        onClick={() => void handleUnassign(a)}
                        className="text-xs text-fluux-muted hover:text-fluux-red transition-colors"
                      >
                        {t('rooms.unassignHat')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        )}
      </div>

      {/* ---- Add forms ---- */}
      {activeTab === 'definitions' && (
        <div className="px-4 py-3 border-t border-fluux-hover space-y-2">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label className="block text-xs text-fluux-muted">{t('rooms.hatTitle')}</label>
              <TextInput
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
                placeholder={t('rooms.hatTitlePlaceholder')}
                className="w-full px-3 py-1.5 text-sm bg-fluux-hover/50 rounded-lg border border-transparent
                           focus:border-fluux-brand/50 focus:outline-none text-fluux-text placeholder-fluux-muted"
              />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label className="block text-xs text-fluux-muted">{t('rooms.hatUri')}</label>
              <TextInput
                type="text"
                value={newUri}
                onChange={(e) => setNewUri(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
                placeholder={t('rooms.hatUriPlaceholder')}
                className="w-full px-3 py-1.5 text-sm bg-fluux-hover/50 rounded-lg border border-transparent
                           focus:border-fluux-brand/50 focus:outline-none text-fluux-text placeholder-fluux-muted"
              />
            </div>
            <button
              onClick={() => void handleCreate()}
              disabled={!newTitle.trim() || !newUri.trim() || isCreating}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-fluux-text-on-accent
                         bg-fluux-brand hover:bg-fluux-brand/80 disabled:opacity-50
                         rounded-lg transition-colors whitespace-nowrap"
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {t('rooms.addHat')}
            </button>
          </div>
          {/* Hue slider with live preview */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs text-fluux-muted">{t('rooms.hatHue')}</label>
              {/* Live preview badge */}
              {(newTitle.trim() || newUri.trim()) && (
                <span
                  className="inline-block px-2 py-0.5 text-xs font-medium rounded-full"
                  style={getHatColors({
                    uri: newUri.trim() || 'preview',
                    hue: newHue ? parseFloat(newHue) : undefined,
                  })}
                >
                  {newTitle.trim() || t('rooms.hatTitlePlaceholder')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="360"
                value={newHue || '180'}
                onChange={(e) => setNewHue(e.target.value)}
                className="flex-1 h-2 rounded-full appearance-none cursor-pointer
                           [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                           [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                           [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-fluux-muted/50 [&::-webkit-slider-thumb]:cursor-pointer"
                style={{
                  background: 'linear-gradient(to right, hsl(0,70%,55%), hsl(60,70%,55%), hsl(120,70%,55%), hsl(180,70%,55%), hsl(240,70%,55%), hsl(300,70%,55%), hsl(360,70%,55%))',
                }}
              />
              <span className="text-xs text-fluux-muted w-8 text-right tabular-nums">
                {newHue || '—'}
              </span>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'assignments' && (
        <div className="px-4 py-3 border-t border-fluux-hover">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <ContactSelector
                selectedContacts={jidSelection}
                onSelectionChange={setJidSelection}
                placeholder={t('rooms.hatJidPlaceholder')}
                excludeJids={selectorExcludeJids}
                extraSuggestions={extraSuggestions}
              />
            </div>
            <select
              id="assign-hat-select"
              name="hat"
              aria-label={t('rooms.selectHat')}
              value={assignUri}
              onChange={(e) => setAssignUri(e.target.value)}
              className="px-2 py-1.5 text-sm bg-fluux-hover/50 rounded-lg border border-transparent
                         focus:border-fluux-brand/50 focus:outline-none text-fluux-text"
            >
              {hats.length === 0 ? (
                <option value="">{t('rooms.noHats')}</option>
              ) : (
                hats.map(h => (
                  <option key={h.uri} value={h.uri}>{h.title}</option>
                ))
              )}
            </select>
            <button
              onClick={() => void handleAssign()}
              disabled={jidSelection.length === 0 || !assignUri || isAssigning}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-fluux-text-on-accent
                         bg-fluux-brand hover:bg-fluux-brand/80 disabled:opacity-50
                         rounded-lg transition-colors"
            >
              {isAssigning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {t('rooms.assignHat')}
            </button>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <ConfirmDialog
          title={t('rooms.destroyHat')}
          message={t('rooms.destroyHatConfirm', { title: confirmDelete.title })}
          confirmLabel={t('rooms.destroyHat')}
          onConfirm={() => void handleDestroy(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </ModalShell>
  )
}
