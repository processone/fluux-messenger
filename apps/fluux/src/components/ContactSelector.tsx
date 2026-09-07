import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import { useRoster, matchNameOrJid, chatStore } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { X } from 'lucide-react'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { anchorMenuToTrigger } from '@/hooks/useAnchoredMenu'

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
  /** Additional JID suggestions beyond roster contacts (e.g., room occupants, affiliated members) */
  extraSuggestions?: Array<{ jid: string; name?: string }>
  /** Single-pick mode: when set, selecting a contact or typing a JID + Enter calls this once and skips chip selection. */
  onPick?: (jid: string) => void
}

/** Unified contact entry for the dropdown */
interface UnifiedContact {
  jid: string
  name: string
  isExtra?: boolean
  presence?: string
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
export function ContactSelector({
  selectedContacts,
  onSelectionChange,
  placeholder,
  addMorePlaceholder,
  disabled = false,
  excludeJids = [],
  extraSuggestions = [],
  onPick,
}: ContactSelectorProps) {
  const { t } = useTranslation()
  const { contacts } = useRoster()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const [search, setSearch] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Recent-activity ordering is a one-shot nicety for the dropdown. Read it
  // non-reactively (getState, not a subscription) so the picker does NOT re-render
  // on every conversation change while open — the combined conversations map churns
  // on every new message / typing / meta update.
  const recentActivityMap = (() => {
    const map = new Map<string, number>()
    for (const conv of chatStore.getState().conversations.values()) {
      if (conv.lastMessage?.timestamp) {
        map.set(conv.id, conv.lastMessage.timestamp.getTime())
      }
    }
    return map
  })()

  // Build a set of roster JIDs for fast deduplication
  const rosterJids = new Set(contacts.map(c => c.jid))

  // Filter and sort contacts, merging extra suggestions
  // - Map roster contacts to unified type
  // - Append extra suggestions not already in roster (dedupe by JID)
  // - Exclude already selected and excluded JIDs
  // - Filter by search if provided (match on name or username, not domain)
  // - Sort: roster contacts by recent activity first, then extra suggestions alphabetically
  const filteredContacts = (() => {
    // Map roster contacts to unified type
    const rosterEntries: UnifiedContact[] = contacts
      .filter(contact => {
        if (selectedContacts.includes(contact.jid)) return false
        if (excludeJids.includes(contact.jid)) return false
        if (search.trim() && !matchNameOrJid(contact.name, contact.jid, search)) return false
        return true
      })
      .map(contact => ({
        jid: contact.jid,
        name: contact.name,
        presence: contact.presence,
      }))

    // Sort roster entries by recent activity
    rosterEntries.sort((a, b) => {
      const aTime = recentActivityMap.get(a.jid) || 0
      const bTime = recentActivityMap.get(b.jid) || 0
      if (aTime !== bTime) return bTime - aTime
      return a.name.localeCompare(b.name)
    })

    // Map and filter extra suggestions (dedupe against roster)
    const extraEntries: UnifiedContact[] = extraSuggestions
      .filter(s => {
        if (rosterJids.has(s.jid)) return false
        if (selectedContacts.includes(s.jid)) return false
        if (excludeJids.includes(s.jid)) return false
        if (search.trim() && !matchNameOrJid(s.name || s.jid, s.jid, search)) return false
        return true
      })
      .map(s => ({
        jid: s.jid,
        name: s.name || s.jid,
        isExtra: true,
      }))

    // Sort extra entries alphabetically by name
    extraEntries.sort((a, b) => a.name.localeCompare(b.name))

    return [...rosterEntries, ...extraEntries]
  })()

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightedIndex(0)
  }, [search])

  const cancelPendingBlur = () => {
    if (blurTimerRef.current === null) return
    clearTimeout(blurTimerRef.current)
    blurTimerRef.current = null
  }

  useEffect(() => cancelPendingBlur, [])

  // Whether the search text is a JID the user can add outright.
  const searchIsValidJid = isValidJid(search)
  const searchJidNormalized = search.trim().toLowerCase()
  const canAddAsJid = searchIsValidJid &&
    !selectedContacts.includes(searchJidNormalized) &&
    !excludeJids.includes(searchJidNormalized)

  // The popover shows suggestions, an add-this-JID row, or a no-match notice.
  const isPopoverOpen = isFocused && (filteredContacts.length > 0 || !!search)

  // Place the popover against the input, in viewport coordinates.
  //
  // Keep the popover portalled to the document body: modal bodies may use
  // `overflow-y-auto`, so an absolutely positioned descendant would be clipped
  // and would enlarge the body's scrollable overflow (#1281). A viewport-anchored
  // popover has no clipping ancestor, and the modal remains sized to its content.
  //
  // Measuring the rendered popover — rather than estimating its height — is also
  // what makes the flip-up decision honest: it flips when the popover truly does
  // not fit below the input, and is pinned inside the viewport as a last resort.
  useLayoutEffect(() => {
    if (!isPopoverOpen) return

    const place = (): string | null => {
      const anchor = containerRef.current
      const menu = popoverRef.current
      if (!anchor || !menu) return null
      const anchorRect = anchor.getBoundingClientRect()
      const menuHeight = menu.getBoundingClientRect().height
      const { x, y } = anchorMenuToTrigger(
        { left: anchorRect.left, top: anchorRect.top, bottom: anchorRect.bottom },
        { width: anchorRect.width, height: menuHeight },
        { width: window.innerWidth, height: window.innerHeight },
      )
      menu.style.left = `${x}px`
      menu.style.top = `${y}px`
      menu.style.width = `${anchorRect.width}px`
      menu.style.visibility = ''
      return [anchorRect.left, anchorRect.top, anchorRect.bottom, anchorRect.width, menuHeight].join(':')
    }

    place()
    let animationFrame: number | null = null
    let previousGeometry: string | null = null
    let stableFrames = 0
    const ancestorIsAnimating = () => {
      let element: Element | null = containerRef.current
      while (element) {
        if (element.getAnimations().some(animation => animation.playState === 'running')) return true
        element = element.parentElement
      }
      return false
    }
    const trackFrame = () => {
      animationFrame = null
      const geometry = place()
      if (!geometry) return
      stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
      previousGeometry = geometry
      if (stableFrames < 2 || ancestorIsAnimating()) {
        animationFrame = window.requestAnimationFrame(trackFrame)
      }
    }
    const trackAnchor = () => {
      stableFrames = 0
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(trackFrame)
    }
    trackAnchor()
    const handleViewportChange = () => {
      place()
      trackAnchor()
    }
    const resizeObserver = new ResizeObserver(trackAnchor)
    let observed: Element | null = containerRef.current
    while (observed) {
      resizeObserver.observe(observed)
      observed = observed.parentElement
    }
    if (popoverRef.current) resizeObserver.observe(popoverRef.current)
    // Capture phase: the anchor rides an ancestor's scrollbar (a modal body, the
    // member list behind an add-member form), and those scrolls do not bubble.
    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('animationstart', trackAnchor, true)
    window.addEventListener('transitionrun', trackAnchor, true)
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('animationstart', trackAnchor, true)
      window.removeEventListener('transitionrun', trackAnchor, true)
    }
  }, [isPopoverOpen, filteredContacts.length, search, canAddAsJid, selectedContacts.length])

  const selectContact = (jid: string) => {
    if (onPick) {
      onPick(jid)
      setSearch('')
      setHighlightedIndex(0)
      return
    }
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
            const extra = !contact ? extraSuggestions.find(s => s.jid === jid) : undefined
            const displayName = contact?.name || extra?.name || jid
            return (
              <span
                key={jid}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-fluux-brand/20 text-fluux-brand rounded-full text-sm"
              >
                {displayName}
                <button
                  type="button"
                  onClick={() => removeContact(jid)}
                  className="hover:text-fluux-text"
                  disabled={disabled}
                >
                  <X className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Contact search with keyboard navigation */}
      <div ref={containerRef}>
        <TextInput
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { cancelPendingBlur(); setIsFocused(true) }}
          // Closing is deferred so a click can land on the popover before it goes
          // away — but the pending close MUST be cancelled when focus comes back,
          // or a blur immediately followed by a refocus closes the list 150ms
          // later while the field still holds focus.
          onBlur={() => {
            cancelPendingBlur()
            blurTimerRef.current = setTimeout(() => {
              blurTimerRef.current = null
              setIsFocused(false)
            }, 150)
          }}
          placeholder={selectedContacts.length > 0
            ? (addMorePlaceholder || defaultAddMorePlaceholder)
            : (placeholder || defaultPlaceholder)}
          disabled={disabled}
          className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                     border border-transparent focus:border-fluux-brand
                     placeholder:text-fluux-muted disabled:opacity-50"
        />

        {isPopoverOpen && createPortal(
          <div
            ref={popoverRef}
            data-testid="contact-suggestions"
            // `fixed`, and outside the modal tree, so no ancestor scroll container
            // can clip it. Hidden until the layout effect has measured it, which
            // happens before the first paint.
            className="fixed max-h-40 overflow-y-auto fluux-popover rounded z-[60]"
            style={{
              left: 0,
              top: 0,
              visibility: 'hidden',
            }}
          >
            {/* Keyboard-highlighted contacts */}
            {filteredContacts.length > 0 && (
              <>
                {filteredContacts.map((contact, index) => {
                  const presenceColor = contact.isExtra
                    ? 'bg-fluux-muted/50'
                    : forceOffline
                      ? APP_OFFLINE_PRESENCE_COLOR
                      : PRESENCE_COLORS[contact.presence as keyof typeof PRESENCE_COLORS]
                  return (
                    <div
                      key={contact.jid}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectContact(contact.jid)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectContact(contact.jid) } }}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer ${
                        index === highlightedIndex
                          ? 'bg-fluux-brand/20 text-fluux-text'
                          : 'hover:bg-fluux-hover text-fluux-text'
                      }`}
                    >
                      <span className={`size-2 rounded-full flex-shrink-0 ${presenceColor}`} />
                      <span className="text-sm truncate flex-1">{contact.name}</span>
                      <span className="text-xs text-fluux-muted truncate">{contact.jid}</span>
                      {index === highlightedIndex && (
                        <span className="text-xs text-fluux-muted ms-1">↵</span>
                      )}
                    </div>
                  )
                })}
                <div className="px-3 py-1.5 text-xs text-fluux-muted border-t border-fluux-hover bg-fluux-sidebar">
                  {t('contacts.keyboardHint')}
                </div>
              </>
            )}

            {/* Hint when input is a valid JID but no contacts match */}
            {filteredContacts.length === 0 && canAddAsJid && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => selectContact(searchJidNormalized)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectContact(searchJidNormalized) } }}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer bg-fluux-brand/20 text-fluux-text"
              >
                <span className="size-2 rounded-full flex-shrink-0 bg-fluux-muted" />
                <span className="text-sm truncate flex-1">{searchJidNormalized}</span>
                <span className="text-xs text-fluux-muted">{t('contacts.pressEnterToAdd')}</span>
                <span className="text-xs text-fluux-muted">↵</span>
              </div>
            )}

            {/* No contacts found hint */}
            {filteredContacts.length === 0 && !canAddAsJid && search && (
              <div className="px-3 py-2 text-sm text-fluux-muted">
                {t('contacts.noContactsFound')}
              </div>
            )}
          </div>,
          document.body,
        )}
      </div>
    </div>
  )
}
