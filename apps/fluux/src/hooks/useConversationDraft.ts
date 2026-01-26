import { useState, useRef, useEffect } from 'react'
import type { MessageComposerHandle } from '@/components/MessageComposer'

export interface DraftOperations {
  getDraft: (conversationId: string) => string
  setDraft: (conversationId: string, text: string) => void
  clearDraft: (conversationId: string) => void
}

export interface UseConversationDraftOptions {
  /** Current conversation/room ID */
  conversationId: string
  /** Draft operations from useChat() or useRoom() */
  draftOperations: DraftOperations
  /** Ref to the MessageComposer for getting current text */
  composerRef: React.RefObject<MessageComposerHandle>
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
 * @returns [text, setText] - controlled text state for the input
 */
export function useConversationDraft({
  conversationId,
  draftOperations,
  composerRef,
  onDraftRestored,
}: UseConversationDraftOptions): [string, React.Dispatch<React.SetStateAction<string>>] {
  const { getDraft, setDraft, clearDraft } = draftOperations

  // Controlled text state
  const [text, setText] = useState('')

  // Track previous conversationId to detect changes
  const prevConversationIdRef = useRef<string | null>(null)

  // Track if we're restoring a draft (to avoid immediate save)
  const isRestoringRef = useRef(false)

  // Debounce timer ref
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      isRestoringRef.current = true
      const draft = getDraft(conversationId)
      setText(draft)

      // Reset restoring flag after state update
      requestAnimationFrame(() => {
        isRestoringRef.current = false
      })

      // Notify caller that draft was restored (e.g., to reset mention references)
      onDraftRestored?.()

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
  }, [conversationId, getDraft, setDraft, clearDraft, composerRef, onDraftRestored])

  // Update store when text changes (debounced for non-empty, immediate for empty)
  useEffect(() => {
    // Skip if we're restoring a draft (avoid saving what we just restored)
    if (isRestoringRef.current) return

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

  return [text, setText]
}
