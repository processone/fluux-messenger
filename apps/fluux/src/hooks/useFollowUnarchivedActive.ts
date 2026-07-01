import { useEffect, useRef } from 'react'

interface FollowUnarchivedActiveParams {
  /** Currently open conversation id, or null when none is active. */
  activeConversationId: string | null
  /** Whether the active conversation is currently archived. */
  isActiveArchived: boolean
  /** Whether the sidebar is currently showing the archived list. */
  showArchived: boolean
  /** Called to return the sidebar to the active (non-archived) list. */
  onShowActive: () => void
}

/**
 * Returns the sidebar to the active conversation list when the conversation
 * you are viewing gets unarchived.
 *
 * Writing in (or receiving a message on) an archived conversation unarchives
 * it. If the sidebar is showing the archived list, the now-unarchived
 * conversation would be filtered out and vanish from the list — forcing the
 * user to manually toggle back to the active list to keep it in context.
 *
 * This hook detects the archived → unarchived transition of the *same* active
 * conversation and flips the sidebar back to the active list so the
 * conversation stays visible. It fires only for the conversation currently
 * open (same id across the transition), so unarchiving a different, non-active
 * conversation — or merely switching/closing conversations — never moves the
 * view.
 */
export function useFollowUnarchivedActive({
  activeConversationId,
  isActiveArchived,
  showArchived,
  onShowActive,
}: FollowUnarchivedActiveParams): void {
  const prevRef = useRef({ id: activeConversationId, archived: isActiveArchived })

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { id: activeConversationId, archived: isActiveArchived }

    if (
      showArchived &&
      activeConversationId != null &&
      prev.id === activeConversationId &&
      prev.archived &&
      !isActiveArchived
    ) {
      onShowActive()
    }
  }, [activeConversationId, isActiveArchived, showArchived, onShowActive])
}
