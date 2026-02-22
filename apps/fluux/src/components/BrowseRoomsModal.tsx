import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useModalInput, useListKeyboardNav } from '@/hooks'
import {
  useConnection,
  useRoom,
  WELL_KNOWN_MUC_SERVERS,
  getLocalPart,
  generateConsistentColorHexSync,
} from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { X, Search, Hash, Loader2, ChevronDown, Server } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface BrowseRoomsModalProps {
  onClose: () => void
}

export function BrowseRoomsModal({ onClose }: BrowseRoomsModalProps) {
  const { t } = useTranslation()
  const { jid: userJid, ownNickname } = useConnection()
  const { browsePublicRooms, joinRoom, getRoom, setActiveRoom, mucServiceJid } = useRoom()
  // NOTE: Use direct store subscription to avoid re-renders from activeMessages changes
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const [rooms, setRooms] = useState<{ jid: string; name: string; occupants?: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [joiningRoom, setJoiningRoom] = useState<string | null>(null)
  const [nickname, setNickname] = useState('')
  const nicknameInitialized = useRef(false)
  const inputRef = useModalInput<HTMLInputElement>(onClose)
  const listRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // MUC service selection
  const [selectedService, setSelectedService] = useState<string>(mucServiceJid || '')
  const [customService, setCustomService] = useState('') // Input value (updates on every keystroke)
  const [committedCustomService, setCommittedCustomService] = useState('') // Only updates on submit
  const [showCustomInput, setShowCustomInput] = useState(false)

  // Build list of available MUC services (auto-discovered + well-known)
  const availableServices = useMemo(() => {
    const services: string[] = []
    // Add auto-discovered service first if available
    if (mucServiceJid) {
      services.push(mucServiceJid)
    }
    // Add well-known servers that aren't already in the list
    for (const server of WELL_KNOWN_MUC_SERVERS) {
      if (!services.includes(server)) {
        services.push(server)
      }
    }
    return services
  }, [mucServiceJid])

  // Initialize selected service when mucServiceJid becomes available
  useEffect(() => {
    if (mucServiceJid && !selectedService) {
      setSelectedService(mucServiceJid)
    }
  }, [mucServiceJid, selectedService])

  // Default nickname from PEP nick (XEP-0172) or JID local part (only once)
  useEffect(() => {
    if (!nicknameInitialized.current) {
      // Prefer PEP nickname if available, otherwise use JID local part
      if (ownNickname) {
        setNickname(ownNickname)
        nicknameInitialized.current = true
      } else if (userJid) {
        setNickname(userJid.split('@')[0])
        nicknameInitialized.current = true
      }
    }
  }, [ownNickname, userJid])

  // The effective service to query (either selected from dropdown or committed custom value)
  const effectiveService = showCustomInput ? committedCustomService : selectedService

  // Fetch rooms when effective service changes
  useEffect(() => {
    const fetchRooms = async () => {
      // If custom input is shown but not yet committed, don't fetch
      if (showCustomInput && !committedCustomService) {
        setRooms([])
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      try {
        // Call browsePublicRooms - if no service provided, it will auto-discover
        const result = await browsePublicRooms(effectiveService || undefined)
        setRooms(result.rooms)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('rooms.failedToLoadRooms'))
        setRooms([])
      } finally {
        setLoading(false)
      }
    }
    void fetchRooms()
  }, [effectiveService, showCustomInput, committedCustomService, browsePublicRooms, t])

  // Handle service selection from dropdown
  const handleServiceChange = (value: string) => {
    if (value === '__custom__') {
      setShowCustomInput(true)
      setCustomService('')
    } else {
      setShowCustomInput(false)
      setSelectedService(value)
    }
  }

  // Handle custom service input submission (Enter key or Discover button)
  const handleCustomServiceSubmit = () => {
    const trimmed = customService.trim()
    if (trimmed) {
      // Validate it looks like a domain
      if (trimmed.includes('.')) {
        setError(null)
        setCommittedCustomService(trimmed) // This triggers the fetch
      } else {
        setError(t('rooms.invalidMucService'))
      }
    }
  }

  // Filter rooms by search query (match name and room local part, not domain)
  const filteredRooms = useMemo(() => {
    if (!searchQuery.trim()) return rooms
    const query = searchQuery.toLowerCase()
    return rooms.filter(
      (room) =>
        (room.name ?? '').toLowerCase().includes(query) ||
        getLocalPart(room.jid).toLowerCase().includes(query)
    )
  }, [rooms, searchQuery])

  const isRoomJoined = useCallback((roomJid: string) => {
    const room = getRoom(roomJid)
    return room?.joined === true
  }, [getRoom])

  // Join a room
  const handleJoinRoom = useCallback(async (roomJid: string) => {
    if (!nickname.trim()) {
      setError(t('rooms.pleaseEnterNickname'))
      return
    }

    setJoiningRoom(roomJid)
    setError(null)
    try {
      await joinRoom(roomJid, nickname.trim())
      void setActiveConversation(null)
      void setActiveRoom(roomJid)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.failedToJoinRoom'))
    } finally {
      setJoiningRoom(null)
    }
  }, [nickname, t, joinRoom, setActiveConversation, setActiveRoom, onClose])

  // Handle room selection (Enter key or click)
  const handleSelectRoom = useCallback((room: { jid: string; name: string; occupants?: number }) => {
    if (isRoomJoined(room.jid)) {
      // Already joined - just open it
      void setActiveConversation(null)
      void setActiveRoom(room.jid)
      onClose()
    } else {
      // Need to join
      void handleJoinRoom(room.jid)
    }
  }, [isRoomJoined, setActiveConversation, setActiveRoom, onClose, handleJoinRoom])

  // Keyboard navigation for room list
  const { selectedIndex, getItemProps, getItemAttribute } = useListKeyboardNav({
    items: filteredRooms,
    onSelect: handleSelectRoom,
    enabled: !loading,
    listRef,
    searchInputRef,
    getItemId: (room) => room.jid,
    itemAttribute: 'data-room-jid',
  })


  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-fluux-sidebar rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <h2 className="text-lg font-semibold text-fluux-text">{t('rooms.browseRoomsTitle')}</h2>
          <Tooltip content={t('common.close')}>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

        {/* MUC Service selector */}
        <div className="px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <label htmlFor="muc-service" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('rooms.mucService')}
          </label>
          {showCustomInput ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={customService}
                onChange={(e) => setCustomService(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCustomServiceSubmit()}
                placeholder={t('rooms.customMucPlaceholder')}
                className="flex-1 px-3 py-2 bg-fluux-bg text-fluux-text rounded
                           border border-transparent focus:border-fluux-brand
                           placeholder:text-fluux-muted"
                autoFocus
              />
              <Tooltip content={t('rooms.discover')}>
                <button
                  onClick={handleCustomServiceSubmit}
                  disabled={!customService.trim()}
                  aria-label={t('rooms.discover')}
                  className="px-3 py-2 text-sm text-white bg-fluux-brand rounded
                             hover:bg-fluux-brand/80 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Search className="w-4 h-4" />
                </button>
              </Tooltip>
              <Tooltip content={t('common.cancel')}>
                <button
                  onClick={() => {
                    setShowCustomInput(false)
                    setCustomService('')
                    setCommittedCustomService('')
                    setSelectedService(availableServices[0] || '')
                  }}
                  aria-label={t('common.cancel')}
                  className="px-3 py-2 text-sm text-fluux-muted hover:text-fluux-text
                             bg-fluux-bg rounded hover:bg-fluux-hover"
                >
                  <X className="w-4 h-4" />
                </button>
              </Tooltip>
            </div>
          ) : (
            <div className="relative">
              <Server className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fluux-muted pointer-events-none" />
              <select
                id="muc-service"
                value={selectedService}
                onChange={(e) => handleServiceChange(e.target.value)}
                className="w-full appearance-none pl-10 pr-10 py-2.5 rounded-lg
                           bg-fluux-bg text-fluux-text cursor-pointer
                           border-2 border-fluux-hover
                           hover:border-fluux-muted focus:border-fluux-brand focus:outline-none
                           transition-colors
                           dark:[color-scheme:dark]"
              >
                {availableServices.map((service) => (
                  <option key={service} value={service} className="bg-fluux-bg text-fluux-text">
                    {service}{service === mucServiceJid ? ` (${t('rooms.yourServer')})` : ''}
                  </option>
                ))}
                <option value="__custom__" className="bg-fluux-bg text-fluux-text">{t('rooms.customMucServer')}</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fluux-muted pointer-events-none" />
            </div>
          )}
        </div>

        {/* Nickname input */}
        <div className="px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <label htmlFor="browse-nickname" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('rooms.nickname')}
          </label>
          <input
            ref={inputRef}
            id="browse-nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={t('rooms.nicknamePlaceholder')}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted"
          />
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fluux-muted" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('rooms.searchRooms')}
              className="w-full pl-10 pr-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-transparent focus:border-fluux-brand
                         placeholder:text-fluux-muted"
            />
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="px-4 py-2 bg-fluux-red/10 border-b border-fluux-hover flex-shrink-0">
            <p className="text-sm text-fluux-red">{error}</p>
          </div>
        )}

        {/* Room list */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 text-fluux-muted animate-spin" />
            </div>
          ) : filteredRooms.length === 0 ? (
            <div className="text-center py-8 text-fluux-muted">
              {searchQuery ? t('rooms.noRoomsFound') : t('rooms.noPublicRooms')}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredRooms.map((room, index) => {
                const joined = isRoomJoined(room.jid)
                const isJoining = joiningRoom === room.jid
                const isSelected = index === selectedIndex

                return (
                  <div
                    key={room.jid}
                    {...getItemAttribute(index)}
                    {...getItemProps(index)}
                    onClick={() => handleSelectRoom(room)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer group transition-colors
                               ${isSelected
                                 ? 'bg-fluux-hover ring-1 ring-fluux-brand/50'
                                 : 'hover:bg-fluux-hover'}`}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: generateConsistentColorHexSync(room.jid, { saturation: 60, lightness: 45 }) }}
                    >
                      <Hash className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-fluux-text truncate">{room.name}</p>
                      <p className="text-xs text-fluux-muted truncate">
                        {room.jid}
                        {room.occupants !== undefined && (
                          <span className="ml-2">
                            • {room.occupants} {t('rooms.occupants')}
                          </span>
                        )}
                      </p>
                    </div>
                    {joined ? (
                      <span className="text-xs text-fluux-brand font-medium px-2 py-1 bg-fluux-brand/10 rounded">
                        {t('rooms.joined')}
                      </span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleJoinRoom(room.jid)
                        }}
                        disabled={isJoining || !nickname.trim()}
                        className={`px-3 py-1 text-sm text-white bg-fluux-brand rounded hover:bg-fluux-brand/80
                                   disabled:opacity-50 disabled:cursor-not-allowed transition-colors
                                   ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                      >
                        {isJoining ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          t('rooms.join')
                        )}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-fluux-hover flex-shrink-0">
          <p className="text-xs text-fluux-muted">
            {t('rooms.browseRoomsHint', { count: rooms.length })}
          </p>
        </div>
      </div>
    </div>
  )
}
