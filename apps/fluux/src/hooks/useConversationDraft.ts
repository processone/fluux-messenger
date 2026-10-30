import { useState, useRef, useEffect, useCallback } from 'react'
import { getStorageScopeJid, type MentionReference } from '@fluux/sdk'
import { mergeFailedDraft } from '@/utils/mergeFailedDraft'
import type { MessageComposerHandle } from '@/components/MessageComposer'

export interface DraftOperations {
  /** Stable backing-store identity, shared by remounted editors. */
  owner: object
  getDraft: (conversationId: string) => string
  setDraft: (conversationId: string, text: string) => void
  clearDraft: (conversationId: string) => void
}

interface DraftSnapshot {
  text: string
  references: MentionReference[]
}
interface FailedDraft extends DraftSnapshot {
  canRecover: () => boolean
}
interface DeferredDraft {
  base: DraftSnapshot
  failures: FailedDraft[]
}

// These belong to the backing store/account/conversation, never an old editor.
const draftOwners = new WeakMap<object, Map<string, (failed: FailedDraft) => boolean>>()
const deferredDrafts = new WeakMap<object, Map<string, DeferredDraft>>()
// Mention metadata survives view remounts, not application restarts. Only reuse
// it when its text still matches the string in the existing draft store.
const draftMentions = new WeakMap<object, Map<string, DraftSnapshot>>()
function put<T>(map: WeakMap<object, Map<string, T>>, owner: object, key: string, value: T) {
  let entries = map.get(owner)
  if (!entries) { entries = new Map(); map.set(owner, entries) }
  entries.set(key, value)
}
function remove<T>(map: WeakMap<object, Map<string, T>>, owner: object, key: string) {
  const entries = map.get(owner)
  entries?.delete(key)
  if (entries?.size === 0) map.delete(owner)
}
function mergeSnapshots(current: DraftSnapshot, failed: DraftSnapshot): DraftSnapshot {
  const text = mergeFailedDraft(current.text, failed.text)
  if (current.text === failed.text) {
    return { text, references: current.references.length ? current.references : failed.references }
  }
  const offset = current.text ? current.text.length + 2 : 0
  return { text, references: [...current.references, ...failed.references.map(ref => ({
    ...ref, begin: ref.begin + offset, end: ref.end + offset,
  }))] }
}
function deferredSnapshot(pending: DeferredDraft): DraftSnapshot {
  const valid = pending.failures.filter(failed => failed.canRecover())
  // In particular, leaving private mode invalidates the whole private draft.
  return valid.length ? valid.reduce(mergeSnapshots, pending.base) : { text: '', references: [] }
}

export interface UseConversationDraftOptions {
  conversationId: string
  draftOperations: DraftOperations
  composerRef: React.RefObject<MessageComposerHandle | null>
  onDraftRestored?: () => void
  /** The edit belongs to this ID, which can lag behind navigation by a render. */
  editingConversationId?: string
  getReferences?: () => MentionReference[]
  onDraftRecovered?: (text: string, references: MentionReference[]) => void
}

/** Persist ordinary drafts; hold failed sends outside an active edit buffer. */
export function useConversationDraft({
  conversationId, draftOperations, composerRef, onDraftRestored,
  editingConversationId, getReferences, onDraftRecovered,
}: UseConversationDraftOptions): [
  string, React.Dispatch<React.SetStateAction<string>>,
  (canRecover?: () => boolean) => () => boolean, () => void,
] {
  const { owner, getDraft, setDraft, clearDraft } = draftOperations
  const isEditing = editingConversationId === conversationId
  const account = getStorageScopeJid()
  const ownerKey = JSON.stringify([account, conversationId])
  const [text, setText] = useState('')
  const currentTextRef = useRef('')
  const messageDraftRef = useRef<DraftSnapshot>({ text: '', references: [] })
  const editingRef = useRef(isEditing)
  editingRef.current = isEditing
  const wasEditingRef = useRef(false)
  const callbacks = useRef({ onDraftRestored, getReferences, onDraftRecovered })
  callbacks.current = { onDraftRestored, getReferences, onDraftRecovered }
  // Freeze the ordinary message's references before the child populates an edit.
  if (!wasEditingRef.current) messageDraftRef.current.references = getReferences?.() ?? []

  const prevConversationIdRef = useRef<string | null>(null)
  const textConversationIdRef = useRef<string | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingSave = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = null
  }, [])
  const userSetText: React.Dispatch<React.SetStateAction<string>> = useCallback(action => {
    cancelPendingSave()
    const next = typeof action === 'function' ? action(currentTextRef.current) : action
    currentTextRef.current = next
    setText(next)
    if (editingRef.current) return
    messageDraftRef.current.text = next
    textConversationIdRef.current = conversationIdRef.current
  }, [cancelPendingSave])

  const persist = useCallback((id: string, snapshot: DraftSnapshot) => {
    if (getStorageScopeJid() !== account) return
    const key = JSON.stringify([account, id])
    if (snapshot.text.trim()) {
      setDraft(id, snapshot.text)
      if (snapshot.references.length) put(draftMentions, owner, key, {
        text: snapshot.text, references: [...snapshot.references],
      })
      else remove(draftMentions, owner, key)
    } else {
      clearDraft(id)
      remove(draftMentions, owner, key)
    }
  }, [account, owner, setDraft, clearDraft])

  const readMessageDraft = useCallback((id: string): DraftSnapshot => {
    const pending = deferredDrafts.get(owner)?.get(JSON.stringify([account, id]))
    if (pending) return deferredSnapshot(pending)
    if (editingRef.current || wasEditingRef.current) return messageDraftRef.current
    return { text: composerRef.current?.getText() ?? currentTextRef.current,
      references: callbacks.current.getReferences?.() ?? [] }
  }, [account, owner, composerRef])

  useEffect(() => {
    const changed = prevConversationIdRef.current !== conversationId
    if (prevConversationIdRef.current && changed) {
      persist(prevConversationIdRef.current, readMessageDraft(prevConversationIdRef.current))
    }
    if (changed) {
      wasEditingRef.current = false
      textConversationIdRef.current = null
      const draft = getDraft(conversationId)
      const metadata = draftMentions.get(owner)?.get(ownerKey)
      const snapshot = { text: draft, references: metadata?.text === draft ? metadata.references : [] }
      messageDraftRef.current = snapshot
      if (!editingRef.current) {
        currentTextRef.current = draft
        setText(draft)
        callbacks.current.onDraftRestored?.()
        callbacks.current.onDraftRecovered?.(draft, snapshot.references)
      }
      prevConversationIdRef.current = conversationId
    }
    // Read the live message draft, never the edit buffer, during cleanup.
    const composer = composerRef.current
    return () => {
      cancelPendingSave()
      const pending = deferredDrafts.get(owner)?.get(ownerKey)
      const snapshot = pending ? deferredSnapshot(pending)
        : (editingRef.current || wasEditingRef.current) ? messageDraftRef.current
        : { text: composer?.getText() ?? '', references: callbacks.current.getReferences?.() ?? [] }
      if (snapshot.text.trim() || pending) persist(conversationId, snapshot)
    }
  }, [conversationId, owner, ownerKey, getDraft, composerRef, persist, readMessageDraft, cancelPendingSave])

  useEffect(() => {
    if (isEditing || wasEditingRef.current || textConversationIdRef.current !== conversationId || text !== currentTextRef.current) return
    cancelPendingSave()
    if (!text.trim()) persist(conversationId, { text, references: [] })
    else debounceTimerRef.current = setTimeout(() => persist(conversationId, {
      text, references: callbacks.current.getReferences?.() ?? [],
    }), 300)
    return cancelPendingSave
  }, [text, isEditing, conversationId, persist, cancelPendingSave])

  useEffect(() => {
    const apply = (snapshot: DraftSnapshot) => {
      cancelPendingSave()
      messageDraftRef.current = snapshot
      currentTextRef.current = snapshot.text
      if (composerRef.current) composerRef.current.setText(snapshot.text)
      else userSetText(snapshot.text)
      callbacks.current.onDraftRecovered?.(snapshot.text, snapshot.references)
      persist(conversationId, snapshot)
    }
    const recoverHere = (failed: FailedDraft) => {
      if (!failed.canRecover() || !failed.text.trim()) return false
      if (editingRef.current || wasEditingRef.current) {
        const pending = deferredDrafts.get(owner)?.get(ownerKey) ?? { base: { ...messageDraftRef.current }, failures: [] }
        pending.failures.push(failed)
        put(deferredDrafts, owner, ownerKey, pending)
        cancelPendingSave()
        persist(conversationId, deferredSnapshot(pending))
        return false
      }
      const current = readMessageDraft(conversationId)
      apply(mergeSnapshots(current, failed))
      return !current.text
    }
    put(draftOwners, owner, ownerKey, recoverHere)
    if (!isEditing) {
      const pending = deferredDrafts.get(owner)?.get(ownerKey)
      if (pending) {
        remove(deferredDrafts, owner, ownerKey)
        apply(deferredSnapshot(pending))
      } else if (wasEditingRef.current) {
        // Without a failed send, keep the existing edit-finish behavior.
        messageDraftRef.current = {
          text: composerRef.current?.getText() ?? currentTextRef.current,
          references: callbacks.current.getReferences?.() ?? [],
        }
        persist(conversationId, messageDraftRef.current)
      }
    } else cancelPendingSave()
    wasEditingRef.current = isEditing
    return () => {
      if (draftOwners.get(owner)?.get(ownerKey) === recoverHere) remove(draftOwners, owner, ownerKey)
    }
  }, [owner, ownerKey, conversationId, isEditing, composerRef, cancelPendingSave, userSetText, persist, readMessageDraft])

  const consumeDraft = useCallback((canRecover?: () => boolean) => {
    const id = conversationId
    const scope = getStorageScopeJid()
    const key = JSON.stringify([scope, id])
    const submitted: FailedDraft = {
      text: composerRef.current?.getText() ?? currentTextRef.current,
      references: callbacks.current.getReferences?.() ?? [],
      canRecover: () => getStorageScopeJid() === scope && (canRecover?.() ?? true),
    }
    let recovered = false
    cancelPendingSave()
    clearDraft(id)
    remove(draftMentions, owner, key)
    return () => {
      if (recovered || !submitted.canRecover()) return false
      recovered = true
      const editor = draftOwners.get(owner)?.get(key)
      if (editor) return editor(submitted)
      if (submitted.text.trim()) {
        const saved = getDraft(id)
        const metadata = draftMentions.get(owner)?.get(key)
        const pending = deferredDrafts.get(owner)?.get(key) ?? {
          base: { text: saved, references: metadata?.text === saved ? metadata.references : [] }, failures: [],
        }
        pending.failures.push(submitted)
        put(deferredDrafts, owner, key, pending)
        persist(id, deferredSnapshot(pending))
      }
      return false
    }
  }, [conversationId, owner, composerRef, cancelPendingSave, clearDraft, getDraft, persist])

  const discardDraft = useCallback(() => {
    remove(deferredDrafts, owner, ownerKey)
    messageDraftRef.current = { text: '', references: [] }
    userSetText('')
    callbacks.current.onDraftRecovered?.('', [])
    persist(conversationId, messageDraftRef.current)
  }, [owner, ownerKey, userSetText, persist, conversationId])

  return [text, userSetText, consumeDraft, discardDraft]
}
