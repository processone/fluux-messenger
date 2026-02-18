import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoster, useChat, matchNameOrJid } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { X } from 'lucide-react'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'

/**
 * Check if a string looks like a valid JID (user@domain).
 * Simple validation: must have exactly one @, with non-empty parts before and after.
 */
function isValidJid(input: string): boolean {
  const trimmed = input.trim().toLowerCase()
  const atIndex = trimmed.indexOf('@')
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return false
  // Check there's only one @
  if (trimmed.indexOf('@', atIndex + 1) !== -1) return false
  // Check domain has at least one dot (basic domain validation)
  const domain = trimmed.slice(atIndex + 1)
  return domain.includes('.')
}

export interface ContactSelectorProps {
  /** List of selected contact JIDs */
  selectedContacts: string[]
  /** Called when selection changes */
  onSelectionChange: (jids: string[]) => void
  /** Placeholder text when no contacts selected */
  placeholder?: string
  /** Placeholder text when contacts are already selected */
  addMorePlaceholder?: string
  /** Whether the selector is disabled */
  disabled?: boolean
  /** JIDs to exclude from the contact list */
  excludeJids?: string[]
}

/**
 * Keyboard-oriented contact selector with Emacs-style navigation.
 *
 * Keyboard shortcuts:
 * - Tab/Shift+Tab: cycle through matching contacts
 * - Arrow Up/Down: navigate dropdown list
 * - Enter: select highlighted contact
 * - Escape: clear search
 * - Backspace (empty input): remove last selected contact
 */
// Estimated dropdown height (max-h-40 = 160px + hint bar ~30px)
const DROPDOWN_HEIGHT = 190

export function ContactSelector({
  selectedContacts,
  onSelectionChange,
  placeholder,
  addMorePlaceholder,
  disabled = false,
  excludeJids = [],
}: ContactSelectorProps) {
  const { t } = useTranslation()
  const { contacts } = useRoster()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { conversations } = useChat()
  const [search, setSearch] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [flipUp, setFlipUp] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Build a map of JID -> last activity timestamp for sorting
  const recentActivityMap = useMemo(() => {
    const map = new Map<string, number>()
    conversations.forEach(conv => {
      if (conv.lastMessage?.timestamp) {
        const time = conv.lastMessage.timestamp.getTime()
        map.set(conv.id, time)
      }
    })
    return map
  }, [conversations])

  // Filter and sort contacts
  // - Exclude already selected and excluded JIDs
  // - Filter by search if provided (match on name or username, not domain)
  // - Sort by recent conversation activity
  const filteredContacts = useMemo(() => {
    const result = contacts.filter(contact => {
      if (selectedContacts.includes(contact.jid)) return false
      if (excludeJids.includes(contact.jid)) return false

      // If search is provided, filter by name or username (not domain)
      if (search.trim() && !matchNameOrJid(contact.name, contact.jid, search)) {
        return false
      }
      return true
    })

    // Sort by recent activity (most recent first), then by name
    result.sort((a, b) => {
      const aTime = recentActivityMap.get(a.jid) || 0
      const bTime = recentActivityMap.get(b.jid) || 0
      if (aTime !== bTime) return bTime - aTime // Most recent first
      return a.name.localeCompare(b.name) // Alphabetical fallback
    })

    return result
  }, [contacts, selectedContacts, excludeJids, search, recentActivityMap])

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightedIndex(0)
  }, [search])

  // Calculate if dropdown should flip up based on available space
  // Use useLayoutEffect to measure synchronously before paint
  useLayoutEffect(() => {
    if (filteredContacts.length === 0 || !containerRef.current) {
      setFlipUp(false)
      return
    }

    const container = containerRef.current
    const containerRect = container.getBoundingClientRect()

    // Find the closest scrollable parent (modal container)
    let scrollParent: Element | null = container.parentElement
    while (scrollParent) {
      const style = window.getComputedStyle(scrollParent)
      const overflow = style.overflow + style.overflowY
      if (overflow.includes('auto') || overflow.includes('scroll')) {
        break
      }
      scrollParent = scrollParent.parentElement
    }

    // Calculate available space
    let spaceBelow: number
    let spaceAbove: number

    if (scrollParent) {
      // Use scrollable parent bounds
      const parentRect = scrollParent.getBoundingClientRect()
      spaceBelow = parentRect.bottom - containerRect.bottom
      spaceAbove = containerRect.top - parentRect.top
    } else {
      // Fallback to window
      spaceBelow = window.innerHeight - containerRect.bottom
      spaceAbove = containerRect.top
    }

    // Flip up if not enough space below but more space above
    setFlipUp(spaceBelow < DROPDOWN_HEIGHT && spaceAbove > spaceBelow)
  }, [filteredContacts.length, search])

  const selectContact = (jid: string) => {
    if (!selectedContacts.includes(jid)) {
      onSelectionChange([...selectedContacts, jid])
    }
    setSearch('')
    setHighlightedIndex(0)
    inputRef.current?.focus()
  }

  const removeContact = (jid: string) => {
    onSelectionChange(selectedContacts.filter(j => j !== jid))
  }

  // Check if current search input is a valid JID that can be added directly
  const searchIsValidJid = isValidJid(search)
  const searchJidNormalized = search.trim().toLowerCase()
  const canAddAsJid = searchIsValidJid &&
    !selectedContacts.includes(searchJidNormalized) &&
    !excludeJids.includes(searchJidNormalized)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Backspace removes last selected contact when input is empty
    if (e.key === 'Backspace' && !search && selectedContacts.length > 0) {
      removeContact(selectedContacts[selectedContacts.length - 1])
      return
    }

    // Enter can add a JID even if no contacts match
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredContacts[highlightedIndex]) {
        // Select highlighted contact from dropdown
        selectContact(filteredContacts[highlightedIndex].jid)
      } else if (canAddAsJid) {
        // Add arbitrary JID
        selectContact(searchJidNormalized)
      }
      return
    }

    // Escape clears search
    if (e.key === 'Escape') {
      e.preventDefault()
      setSearch('')
      return
    }

    // Navigation only works when there are contacts to navigate
    if (filteredContacts.length === 0) {
      return
    }

    switch (e.key) {
      case 'Tab':
        e.preventDefault()
        if (e.shiftKey) {
          // Shift+Tab: previous
          setHighlightedIndex(prev =>
            prev <= 0 ? filteredContacts.length - 1 : prev - 1
          )
        } else {
          // Tab: next
          setHighlightedIndex(prev =>
            prev >= filteredContacts.length - 1 ? 0 : prev + 1
          )
        }
        break
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex(prev =>
          prev >= filteredContacts.length - 1 ? 0 : prev + 1
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex(prev =>
          prev <= 0 ? filteredContacts.length - 1 : prev - 1
        )
        break
    }
  }

  const defaultPlaceholder = t('contacts.searchContacts')
  const defaultAddMorePlaceholder = t('contacts.addMoreContacts')

  return (
    <div>
      {/* Selected contacts chips */}
      {selectedContacts.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {selectedContacts.map(jid => {
            const contact = contacts.find(c => c.jid === jid)
            return (
              <span
                key={jid}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-fluux-brand/20 text-fluux-brand rounded-full text-sm"
              >
                {contact?.name || jid}
                <button
                  type="button"
                  onClick={() => removeContact(jid)}
                  className="hover:text-fluux-text"
                  disabled={disabled}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Contact search with keyboard navigation */}
      <div ref={containerRef} className="relative">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setTimeout(() => setIsFocused(false), 150)} // Delay to allow click on dropdown
          placeholder={selectedContacts.length > 0
            ? (addMorePlaceholder || defaultAddMorePlaceholder)
            : (placeholder || defaultPlaceholder)}
          disabled={disabled}
          className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                     border border-transparent focus:border-fluux-brand
                     placeholder:text-fluux-muted disabled:opacity-50"
        />

        {/* Dropdown with keyboard-highlighted contacts - flips up when near bottom */}
        {isFocused && filteredContacts.length > 0 && (
          <div className={`absolute left-0 right-0 max-h-40 overflow-y-auto bg-fluux-bg rounded border border-fluux-hover shadow-lg z-10 ${
            flipUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}>
            {filteredContacts.map((contact, index) => {
              const presenceColor = forceOffline
                ? APP_OFFLINE_PRESENCE_COLOR
                : PRESENCE_COLORS[contact.presence]
              return (
                <div
                  key={contact.jid}
                  onClick={() => selectContact(contact.jid)}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer ${
                    index === highlightedIndex
                      ? 'bg-fluux-brand/20 text-fluux-text'
                      : 'hover:bg-fluux-hover text-fluux-text'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${presenceColor}`} />
                  <span className="text-sm truncate flex-1">{contact.name}</span>
                  <span className="text-xs text-fluux-muted truncate">{contact.jid}</span>
                  {index === highlightedIndex && (
                    <span className="text-xs text-fluux-muted ml-1">↵</span>
                  )}
                </div>
              )
            })}
            <div className="px-3 py-1.5 text-xs text-fluux-muted border-t border-fluux-hover bg-fluux-sidebar">
              {t('contacts.keyboardHint')}
            </div>
          </div>
        )}

        {/* Hint when input is a valid JID but no contacts match */}
        {isFocused && filteredContacts.length === 0 && canAddAsJid && (
          <div className={`absolute left-0 right-0 bg-fluux-bg rounded border border-fluux-hover shadow-lg z-10 ${
            flipUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}>
            <div
              onClick={() => selectContact(searchJidNormalized)}
              className="flex items-center gap-2 px-3 py-2 cursor-pointer bg-fluux-brand/20 text-fluux-text"
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0 bg-fluux-muted" />
              <span className="text-sm truncate flex-1">{searchJidNormalized}</span>
              <span className="text-xs text-fluux-muted">{t('contacts.pressEnterToAdd')}</span>
              <span className="text-xs text-fluux-muted">↵</span>
            </div>
          </div>
        )}

        {/* No contacts found hint */}
        {isFocused && filteredContacts.length === 0 && search && !canAddAsJid && (
          <div className={`absolute left-0 right-0 bg-fluux-bg rounded border border-fluux-hover shadow-lg z-10 px-3 py-2 text-sm text-fluux-muted ${
            flipUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}>
            {t('contacts.noContactsFound')}
          </div>
        )}
      </div>
    </div>
  )
}
