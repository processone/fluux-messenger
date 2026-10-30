import { useState, useRef, useEffect, useCallback } from 'react'
import { getStorageScopeJid } from '@fluux/sdk'
import { mergeFailedDraft } from '@/utils/mergeFailedDraft'
import type { MessageComposerHandle } from '@/components/MessageComposer'

export interface DraftOperations {
  /** Stable backing-store identity, shared by remounted editors. */
  owner: object
  getDraft: (conversationId: string) => string
  setDraft: (conversationId: string, text: string) => void
  clearDraft: (conversationId: string) => void
}

// Recovery targets the currently mounted editor, not the instance that sent.
// Action wrappers can change on remount, so the backing store owns this key.
const draftOwners = new WeakMap<object, Map<string, (failed: string) => boolean>>()

export interface UseConversationDraftOptions {
  /** Current conversation/room ID */
  conversationId: string
  /** Draft operations from useChat() or useRoom() */
  draftOperations: DraftOperations
  /** Ref to the MessageComposer for getting current text */
  composerRef: React.RefObject<MessageComposerHandle | null>
  /** Optional callback when draft is restored (e.g., to reset mention references) */
  onDraftRestored?: () => void
}

/**
 * Hook to manage draft persistence for message input.
 *
 * Handles:
 * - Saving draft when switching conversations
 * - Restoring draft when entering a conversation
 * - Saving draft on component unmount
 * - Clearing draft immediately when text becomes empty
 * - Debounced saving while typing (for sidebar preview)
 *
 * @returns [text, setText, consumeDraft] - controlled text state for the input
 */
export function useConversationDraft({
  conversationId,
  draftOperations,
  composerRef,
  onDraftRestored,
}: UseConversationDraftOptions): [string, React.Dispatch<React.SetStateAction<string>>, () => () => boolean] {
  const { owner, getDraft, setDraft, clearDraft } = draftOperations

  // Controlled text state
  const [text, setText] = useState('')
  const currentTextRef = useRef('')

  // Track previous conversationId to detect changes
  const prevConversationIdRef = useRef<string | null>(null)

  // Track which conversation the current text was typed in.
  // Set to conversationId when the user types (via userSetText),
  // set to null when text is restored programmatically.
  // This prevents saving restored/stale text to the wrong conversation.
  const textConversationIdRef = useRef<string | null>(null)

  // Current conversationId ref (for userSetText closure)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  // Stable ref for onDraftRestored callback (avoids effect re-runs)
  const onDraftRestoredRef = useRef(onDraftRestored)
  onDraftRestoredRef.current = onDraftRestored

  // Debounce timer ref
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingSave = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = null
  }, [])

  // Wrapper around setText that tags the text as belonging to the current conversation
  const userSetText: React.Dispatch<React.SetStateAction<string>> = useCallback(
    (action) => {
      textConversationIdRef.current = conversationIdRef.current
      cancelPendingSave()
      const next = typeof action === 'function' ? action(currentTextRef.current) : action
      currentTextRef.current = next
      setText(next)
    },
    [cancelPendingSave]
  )

  // Save draft on conversation change or unmount, restore draft on conversation change
  useEffect(() => {
    const isConversationChange = prevConversationIdRef.current !== conversationId

    // Save draft for previous conversation if there was one
    if (prevConversationIdRef.current && isConversationChange) {
      const currentText = composerRef.current?.getText() || ''
      if (currentText.trim()) {
        setDraft(prevConversationIdRef.current, currentText)
      } else {
        clearDraft(prevConversationIdRef.current)
      }
    }

    // Restore draft for new conversation (only when conversation actually changed)
    // This prevents re-restoring the draft when the effect runs due to function reference changes
    if (isConversationChange) {
      // Mark text as not from user typing — prevents the save effect from
      // writing stale text to the new conversation
      textConversationIdRef.current = null
      const draft = getDraft(conversationId)
      currentTextRef.current = draft
      setText(draft)

      // Notify caller that draft was restored (e.g., to reset mention references)
      onDraftRestoredRef.current?.()

      // Update prev ref
      prevConversationIdRef.current = conversationId
    }

    // Capture ref for cleanup (avoid stale closure warning)
    const composer = composerRef.current

    // Cleanup: save draft on unmount, cancel pending debounce
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      const currentText = composer?.getText() || ''
      if (currentText.trim()) {
        setDraft(conversationId, currentText)
      }
    }
  }, [conversationId, getDraft, setDraft, clearDraft, composerRef])

  // Update store when text changes (debounced for non-empty, immediate for empty)
  useEffect(() => {
    // Skip if text doesn't belong to the current conversation
    // (e.g., it was restored programmatically during a conversation switch)
    if (textConversationIdRef.current !== conversationId || text !== currentTextRef.current) return

    // Clear any pending debounce
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    if (!text.trim()) {
      // Text is empty - clear draft immediately for instant sidebar update
      clearDraft(conversationId)
    } else {
      // Text has content - debounce the save (300ms)
      debounceTimerRef.current = setTimeout(() => {
        setDraft(conversationId, text)
      }, 300)
    }

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [text, conversationId, setDraft, clearDraft])

  const account = getStorageScopeJid()
  const ownerKey = JSON.stringify([account, conversationId])
  useEffect(() => {
    let editors = draftOwners.get(owner)
    if (!editors) {
      editors = new Map()
      draftOwners.set(owner, editors)
    }
    const recoverHere = (failed: string) => {
      if (getStorageScopeJid() !== account || !failed.trim()) return false
      const current = composerRef.current?.getText() ?? currentTextRef.current
      const recovered = mergeFailedDraft(current, failed)
      cancelPendingSave()
      if (composerRef.current) composerRef.current.setText(recovered)
      else userSetText(recovered)
      setDraft(conversationId, recovered)
      // Only an exact restoration can reuse the submitted mention references.
      return !current
    }
    editors.set(ownerKey, recoverHere)
    return () => {
      if (editors.get(ownerKey) === recoverHere) editors.delete(ownerKey)
      if (editors.size === 0) draftOwners.delete(owner)
    }
  }, [owner, ownerKey, account, conversationId, composerRef, cancelPendingSave, userSetText, setDraft])

  // Consume before awaiting; rollback belongs to the original account and ID,
  // but reads the current editor (or persisted draft) to preserve newer input.
  const consumeDraft = useCallback(() => {
    const id = conversationId
    const scope = getStorageScopeJid()
    const key = JSON.stringify([scope, id])
    const submitted = composerRef.current?.getText() ?? currentTextRef.current
    let recovered = false
    cancelPendingSave()
    clearDraft(id)
    return () => {
      if (recovered || getStorageScopeJid() !== scope) return false
      recovered = true
      const editor = draftOwners.get(owner)?.get(key)
      if (editor) return editor(submitted)
      if (submitted.trim()) setDraft(id, mergeFailedDraft(getDraft(id), submitted))
      return false
    }
  }, [conversationId, owner, composerRef, cancelPendingSave, clearDraft, getDraft, setDraft])

  return [text, userSetText, consumeDraft]
}
