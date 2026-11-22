import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { TextInput } from './ui/TextInput'
import { SuggestionLimitHint } from './ui/SuggestionLimitHint'
import { suggestionMatchRank } from '@/utils/suggestionMatchRank'
import { useTranslation } from 'react-i18next'
import { useRoster, matchNameOrJid, chatStore } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { X } from 'lucide-react'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS, MAX_SUGGESTIONS } from '@/constants/ui'
import { anchorMenuToTrigger } from '@/hooks/useAnchoredMenu'
import { getFloatingViewport, limitFloatingHeight } from '@/hooks/floatingViewport'

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
  /** Placeholder text when contacts are already selected; an empty string shows none */
  addMorePlaceholder?: string
  /** Whether the selector is disabled */
  disabled?: boolean
  /** JIDs to exclude from the contact list */
  excludeJids?: string[]
  /**
   * Returns a short note for a contact who stays listed but cannot be chosen.
   * Those contacts come after everyone else, and the note says why.
   */
  getUnavailableNote?: (jid: string) => string | undefined
  /** Additional JID suggestions beyond roster contacts (e.g., room occupants, affiliated members) */
  extraSuggestions?: Array<{ jid: string; name?: string }>
  /** Merge roster/suggestion case variants for account-level room management (default false). */
  caseInsensitiveRosterMerge?: boolean
  /** Single-pick mode: when set, selecting a contact or typing a JID + Enter calls this once and skips chip selection. */
  onPick?: (jid: string) => void
  /** Whether a typed address outside the list can be picked (default true). */
  allowTypedJid?: boolean
  /** Id for the search input, so a visible label can name it. */
  inputId?: string
}

/** Unified contact entry for the dropdown */
interface UnifiedContact {
  jid: string
  name: string
  matchRank: number
  isExtra?: boolean
  presence?: string
  unavailableNote?: string
  /** The row stands for the search text itself, so its name already is the address. */
  isTypedAddress?: boolean
}

/**
 * Keyboard-oriented contact selector with Emacs-style navigation.
 *
 * Keyboard shortcuts:
 * - Tab/Shift+Tab: cycle through matching contacts
 * - Arrow Up/Down: navigate dropdown list
 * - Enter: select highlighted contact
 * - Escape: step back one layer: clear the search, then close the list, then let the
 *   surrounding window handle it. With the list closed, Tab moves to the next control.
 * - Backspace (empty input): remove last selected contact
 * - Enter/Space on a remove button: remove that contact and move to the next remove
 *   button, the previous one at the end of the row, or the input when none remain
 */
export function ContactSelector({
  selectedContacts,
  onSelectionChange,
  placeholder,
  addMorePlaceholder,
  disabled = false,
  excludeJids = [],
  getUnavailableNote,
  extraSuggestions = [],
  caseInsensitiveRosterMerge = false,
  onPick,
  allowTypedJid = true,
  inputId,
}: ContactSelectorProps) {
  const { t } = useTranslation()
  const { contacts } = useRoster()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const [search, setSearch] = useState('')
  // The highlight is kept by address, not by position: the list can gain or lose an
  // entry while open (a first message from someone new, a room you leave), and Enter
  // must still pick the entry that is highlighted. `null` means the first entry.
  const [highlightedJid, setHighlightedJid] = useState<string | null>(null)
  const [isFocused, setIsFocused] = useState(false)
  // Escape closed the list. It stays closed when focus returns, so Tab can pass through the
  // picker, until the user asks for it again by typing, with an arrow key or with a click.
  const [isListDismissed, setIsListDismissed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chipRowRef = useRef<HTMLDivElement>(null)
  // The Enter that removed a contact may still be down when focus reaches the next control.
  const removalKeyHeldRef = useRef(false)

  // Recent-activity ordering is a one-shot nicety for the dropdown. Read it
  // non-reactively (getState, not a subscription) so the picker does NOT re-render
  // on every conversation change while open — the combined conversations map churns
  // on every new message / typing / meta update. Read it once, when the picker
  // mounts, so a parent re-render after a new message does not reshuffle the list
  // while the user is reading or navigating it.
  const [recentActivityMap] = useState(() => {
    const map = new Map<string, number>()
    for (const conv of chatStore.getState().conversations.values()) {
      if (conv.lastMessage?.timestamp) {
        map.set(conv.id, conv.lastMessage.timestamp.getTime())
      }
    }
    return map
  })

  // Room-management pickers merge account case variants; other callers can distinguish
  // exact destinations, such as a chat and a joined room with differently spelled addresses.
  const rosterMergeKey = (jid: string) => caseInsensitiveRosterMerge ? jid.toLowerCase() : jid
  const rosterJids = new Set(contacts.map(c => rosterMergeKey(c.jid)))
  // Selection and exclusion comparisons never rewrite values passed to callers.
  const selectedJids = new Set(selectedContacts.map(jid => jid.toLowerCase()))
  const excludedJids = new Set(excludeJids.map(jid => jid.toLowerCase()))

  // Search text naming someone who cannot be chosen gets its own marked row, so the reason
  // shows whatever else the search matches and even if the text could not be added as typed.
  const searchJidNormalized = search.trim().toLowerCase()
  const typedUnavailableNote = allowTypedJid && searchJidNormalized
    ? getUnavailableNote?.(searchJidNormalized)
    : undefined

  // Filter and sort contacts, merging extra suggestions
  // - Map roster contacts to unified type
  // - Append extra suggestions not already in roster (dedupe by JID)
  // - Exclude already selected and excluded JIDs
  // - Filter by search if provided (match on name or username, not domain)
  // - Rank exact and prefix matches first, then recent roster activity or extra suggestion names
  // - Move contacts who cannot be chosen after everyone else, keeping that order
  const { contacts: filteredContacts, total: matchingContactCount } = (() => {
    const compareMatches = (a: UnifiedContact, b: UnifiedContact) =>
      Number(!!a.unavailableNote) - Number(!!b.unavailableNote) ||
      a.matchRank - b.matchRank
    // Map roster contacts to unified type
    const rosterEntries: UnifiedContact[] = contacts
      .filter(contact => {
        const key = contact.jid.toLowerCase()
        if (selectedJids.has(key)) return false
        if (excludedJids.has(key)) return false
        if (search.trim() && !matchNameOrJid(contact.name, contact.jid, search)) return false
        return true
      })
      .map(contact => ({
        jid: contact.jid,
        name: contact.name,
        matchRank: suggestionMatchRank(search, contact.name, contact.jid),
        presence: contact.presence,
        unavailableNote: getUnavailableNote?.(contact.jid),
      }))

    // Sort roster entries by recent activity
    rosterEntries.sort((a, b) => {
      const aTime = recentActivityMap.get(a.jid) || 0
      const bTime = recentActivityMap.get(b.jid) || 0
      return compareMatches(a, b) || bTime - aTime || a.name.localeCompare(b.name)
    })

    // Map and filter extra suggestions (dedupe against roster)
    const extraEntries: UnifiedContact[] = extraSuggestions
      .filter(s => {
        const key = s.jid.toLowerCase()
        if (rosterJids.has(rosterMergeKey(s.jid))) return false
        if (selectedJids.has(key)) return false
        if (excludedJids.has(key)) return false
        if (search.trim() && !matchNameOrJid(s.name || s.jid, s.jid, search)) return false
        return true
      })
      .map(s => ({
        jid: s.jid,
        name: s.name || s.jid,
        matchRank: suggestionMatchRank(search, s.name || s.jid, s.jid),
        isExtra: true,
        unavailableNote: getUnavailableNote?.(s.jid),
      }))

    const typedBareJid = searchJidNormalized.split('/')[0]
    if (typedUnavailableNote && ![...rosterEntries, ...extraEntries].some(entry => entry.jid.toLowerCase().split('/')[0] === typedBareJid)) {
      extraEntries.push({
        jid: searchJidNormalized,
        name: searchJidNormalized,
        matchRank: suggestionMatchRank(search, searchJidNormalized, searchJidNormalized),
        isExtra: true,
        isTypedAddress: true,
        unavailableNote: typedUnavailableNote,
      })
    }
    extraEntries.sort((a, b) => compareMatches(a, b) || a.name.localeCompare(b.name))

    // Each source gets its own space: the roster must not crowd rooms, non-roster
    // chats or room members out of the opening suggestions.
    const cap = (entries: UnifiedContact[]) => {
      const visible = entries.slice(0, MAX_SUGGESTIONS)
      const typedUnavailable = typedUnavailableNote
        ? entries.find(entry => entry.jid.toLowerCase().split('/')[0] === typedBareJid)
        : undefined
      if (typedUnavailable && !visible.includes(typedUnavailable)) visible[visible.length - 1] = typedUnavailable
      return visible
    }
    return {
      contacts: [...cap(rosterEntries), ...cap(extraEntries)].sort(compareMatches),
      total: rosterEntries.length + extraEntries.length,
    }
  })()

  // A highlighted address that leaves the list highlights nothing until the user chooses again.
  const highlightedIndex = highlightedJid === null
    ? 0
    : filteredContacts.findIndex(contact => contact.jid === highlightedJid)
  const firstJid = filteredContacts[0]?.jid ?? null

  // A changed search starts over at the first match. The two updates render together
  // because a key pressed right after typing can arrive before any effect has run.
  const changeSearch = (next: string) => {
    if (next === search) return
    setSearch(next)
    setHighlightedJid(null)
    setIsListDismissed(false)
  }

  const cancelPendingBlur = () => {
    if (blurTimerRef.current === null) return
    clearTimeout(blurTimerRef.current)
    blurTimerRef.current = null
  }

  useEffect(() => cancelPendingBlur, [])

  // Whether the search text is a JID the user can add outright.
  const searchIsValidJid = isValidJid(search)
  const canAddAsJid = allowTypedJid && searchIsValidJid && !typedUnavailableNote &&
    !selectedJids.has(searchJidNormalized) &&
    !excludedJids.has(searchJidNormalized)

  // The popover shows suggestions, an add-this-JID row, or a no-match notice.
  const isPopoverOpen = isFocused && !isListDismissed && (filteredContacts.length > 0 || !!search)

  // Focus stays in the input, so a screen reader hears why the highlighted person
  // cannot be chosen only through a status message.
  const highlightedContact = filteredContacts[highlightedIndex]
  const unavailableAnnouncement = isPopoverOpen && highlightedContact?.unavailableNote
    ? `${highlightedContact.name}: ${highlightedContact.unavailableNote}`
    : ''

  // Pin the default highlight to the entry shown first, so a later list change keeps it.
  // Done while rendering: an effect's update could be overtaken by the next keystroke.
  if (isPopoverOpen && highlightedJid === null && firstJid !== null) setHighlightedJid(firstJid)

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

    let restoreHeight = () => {}
    const place = (): string | null => {
      const anchor = containerRef.current
      const menu = popoverRef.current
      if (!anchor || !menu) return null
      restoreHeight()
      const viewport = getFloatingViewport()
      restoreHeight = limitFloatingHeight(menu, viewport)
      const anchorRect = anchor.getBoundingClientRect()
      const menuHeight = menu.getBoundingClientRect().height
      const { x, y } = anchorMenuToTrigger(
        { left: anchorRect.left, top: anchorRect.top, bottom: anchorRect.bottom },
        { width: anchorRect.width, height: menuHeight },
        viewport,
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
      restoreHeight()
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('animationstart', trackAnchor, true)
      window.removeEventListener('transitionrun', trackAnchor, true)
    }
  }, [isPopoverOpen, filteredContacts.length, search, canAddAsJid, selectedContacts.length])

  // Keep the highlighted row visible: the list scrolls, and keyboard users move through it
  // from the input, so nothing else brings a row past its visible height into view.
  useLayoutEffect(() => {
    const list = popoverRef.current
    const row = list?.querySelector<HTMLElement>('[data-highlighted]')
    if (!list || !row) return
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    // The keyboard hint stays pinned over the bottom of the list.
    const visibleBottom = listRect.bottom - (hintRef.current?.offsetHeight ?? 0)
    if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top
    else if (rowRect.bottom > visibleBottom) list.scrollTop += rowRect.bottom - visibleBottom
  }, [isPopoverOpen, highlightedIndex])

  const selectContact = (jid: string) => {
    // The row already says why; stay on it with the list open.
    if (getUnavailableNote?.(jid)) {
      setHighlightedJid(jid)
      inputRef.current?.focus()
      return
    }
    if (onPick) {
      onPick(jid)
      setSearch('')
      setHighlightedJid(null)
      return
    }
    if (!selectedJids.has(jid.toLowerCase())) {
      onSelectionChange([...selectedContacts, jid])
    }
    setSearch('')
    setHighlightedJid(null)
    inputRef.current?.focus()
  }

  const removeContact = (jid: string) => {
    onSelectionChange(selectedContacts.filter(j => j !== jid))
  }

  // The focused button is about to leave the page, which would drop focus outside a modal
  // and its focus trap. A key press reports a click count of 0 and moves to a neighboring
  // control. A pointer press hands focus to the surrounding window, where WebKit already
  // leaves it, because focusing the field would open the suggestions.
  const removeChosenContact = (e: React.MouseEvent<HTMLButtonElement>, jid: string) => {
    const button = e.currentTarget
    const hadFocus = document.activeElement === button
    const byKeyboard = e.detail === 0
    const position = selectedContacts.indexOf(jid)
    // Commit now, so the control that receives focus is the one left after the removal.
    flushSync(() => removeContact(jid))
    if (!hadFocus || button.isConnected) return
    if (!byKeyboard) {
      containerRef.current?.closest<HTMLElement>('[tabindex]')?.focus({ preventScroll: true })
      return
    }
    const remaining = chipRowRef.current?.querySelectorAll<HTMLButtonElement>('button')
    const next = remaining?.[Math.min(position, remaining.length - 1)] ?? inputRef.current
    removalKeyHeldRef.current = true
    next?.focus()
  }

  // Enter presses a button on key-down, so its auto-repeat must not press the control focus
  // just moved to: holding it would remove every contact and then pick a suggestion. Only
  // Enter's own release or new press ends this; a released Shift says nothing about Enter.
  // Space presses a button on key-up, so it is never still held here.
  const handleRemovalKeyRepeat = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!removalKeyHeldRef.current || e.key !== 'Enter') return
    if (e.repeat) {
      e.preventDefault()
      e.stopPropagation()
    } else {
      removalKeyHeldRef.current = false
    }
  }

  // Move the highlight, wrapping at both ends; with nothing highlighted, start at an end.
  const moveHighlight = (step: 1 | -1) => {
    const count = filteredContacts.length
    const next = highlightedIndex < 0
      ? (step > 0 ? 0 : count - 1)
      : (highlightedIndex + step + count) % count
    setHighlightedJid(filteredContacts[next].jid)
  }

  // A modal's focus trap listens on its panel, so it sees Tab before React's bubble handlers
  // and would move focus out while the highlight moves too. The capture phase runs first and
  // marks the key as used. With no list to move through, Tab stays ordinary navigation.
  const handleKeyDownCapture = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Tab' || isListDismissed || filteredContacts.length === 0) return
    e.preventDefault()
    moveHighlight(e.shiftKey ? -1 : 1)
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
      // A closed list has no visible choice for Enter to confirm.
      if (isListDismissed) return
      if (filteredContacts[highlightedIndex]) {
        // Select highlighted contact from dropdown
        selectContact(filteredContacts[highlightedIndex].jid)
      } else if (canAddAsJid && filteredContacts.length === 0) {
        // Add arbitrary JID (offered only when no contact matches)
        selectContact(searchJidNormalized)
      }
      return
    }

    // Escape steps back one layer: the search, then the list, then the surrounding window.
    // Stopping it here keeps it from the window's Escape-to-close listener on the document.
    if (e.key === 'Escape') {
      if (!search && !isPopoverOpen) return
      e.preventDefault()
      e.stopPropagation()
      if (search) {
        changeSearch('')
      } else {
        setIsListDismissed(true)
        setHighlightedJid(null)
      }
      return
    }

    // Navigation only works when there are contacts to navigate
    if (filteredContacts.length === 0) {
      return
    }

    // An arrow key shows a closed list again, without moving past its first entry.
    if (isListDismissed) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setIsListDismissed(false)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveHighlight(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveHighlight(-1)
        break
    }
  }

  const defaultPlaceholder = t('contacts.searchContacts')
  const defaultAddMorePlaceholder = t('contacts.addMoreContacts')

  return (
    <div
      onKeyDownCapture={handleRemovalKeyRepeat}
      onKeyUpCapture={(e) => { if (e.key === 'Enter') removalKeyHeldRef.current = false }}
    >
      {/* Selected contacts chips */}
      {selectedContacts.length > 0 && (
        <div ref={chipRowRef} className="flex flex-wrap gap-1 mb-2">
          {selectedContacts.map(jid => {
            const key = rosterMergeKey(jid)
            const contact = contacts.find(c => rosterMergeKey(c.jid) === key)
            const extra = !contact ? extraSuggestions.find(s => rosterMergeKey(s.jid) === key) : undefined
            const displayName = contact?.name || extra?.name || jid
            return (
              <span
                key={jid}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-fluux-brand/20 text-fluux-brand-on-tint rounded-full text-sm"
              >
                {displayName}
                <button
                  type="button"
                  onClick={(e) => removeChosenContact(e, jid)}
                  aria-label={t('contacts.removeFromSelection', { name: displayName })}
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

      {getUnavailableNote && (
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {unavailableAnnouncement}
        </div>
      )}

      {/* Contact search with keyboard navigation */}
      <div ref={containerRef}>
        <TextInput
          ref={inputRef}
          id={inputId}
          type="text"
          value={search}
          onChange={(e) => changeSearch(e.target.value)}
          onClick={() => setIsListDismissed(false)}
          onKeyDownCapture={handleKeyDownCapture}
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
            ? (addMorePlaceholder ?? defaultAddMorePlaceholder)
            : (placeholder || defaultPlaceholder)}
          disabled={disabled}
          className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                     border border-transparent
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
                <SuggestionLimitHint shown={filteredContacts.length} total={matchingContactCount} />
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
                      aria-disabled={contact.unavailableNote ? true : undefined}
                      data-highlighted={index === highlightedIndex ? '' : undefined}
                      onClick={() => selectContact(contact.jid)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectContact(contact.jid) } }}
                      className={`focus-ring-inset flex items-center gap-2 px-3 py-2 ${
                        contact.unavailableNote
                          ? `cursor-not-allowed text-fluux-muted ${index === highlightedIndex ? 'bg-fluux-hover' : ''}`
                          : `cursor-pointer text-fluux-text ${index === highlightedIndex ? 'bg-fluux-brand/20' : 'hover:bg-fluux-hover'}`
                      }`}
                    >
                      <span className={`size-2 rounded-full flex-shrink-0 ${presenceColor}`} />
                      <span className="text-sm truncate flex-1">{contact.name}</span>
                      {!contact.isTypedAddress && (
                        <span className="text-xs text-fluux-muted truncate">{contact.jid}</span>
                      )}
                      {contact.unavailableNote ? (
                        <span className="flex-shrink-0 rounded border border-fluux-muted/40 px-1.5 py-0.5 text-xs text-fluux-text">
                          {contact.unavailableNote}
                        </span>
                      ) : index === highlightedIndex && (
                        <span className="text-xs text-fluux-muted ms-1">↵</span>
                      )}
                    </div>
                  )
                })}
                <div
                  ref={hintRef}
                  className="sticky bottom-0 px-3 py-1.5 text-xs text-fluux-muted border-t border-fluux-hover bg-fluux-sidebar"
                >
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
                className="focus-ring-inset flex items-center gap-2 px-3 py-2 cursor-pointer bg-fluux-brand/20 text-fluux-text"
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
