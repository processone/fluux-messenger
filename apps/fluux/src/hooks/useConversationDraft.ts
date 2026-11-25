import { DRAFT_SAVE_DELAY_MS } from '@/constants/ui'
import { useState, useRef, useEffect, useCallback } from 'react'
import { getStorageScopeJid, type MentionReference } from '@fluux/sdk'
import { mergeFailedDraft } from '@/utils/mergeFailedDraft'
import type { MessageComposerHandle } from '@/components/MessageComposer'

export interface DraftOperations {
  /** Stable backing-store identity, shared by remounted editors. */
  owner: object
  getDraft: (conversationId: string) => string
  setDraft: (conversationId: string, text: string, options?: { ordinary?: boolean }) => void
  getOrdinary?: (conversationId: string, text: string) => boolean
  clearDraft: (conversationId: string) => void
}

interface DraftSnapshot {
  ordinary?: boolean
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
// What each mounted editor currently holds, so text added from outside can tell it is already there.
const draftReaders = new WeakMap<object, Map<string, () => string>>()
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
  // Recovery must not expose unclassified text by merging it into a public draft.
  const ordinary = (!current.text.trim() || current.ordinary === true) && (!failed.text.trim() || failed.ordinary === true)
  if (current.text === failed.text) {
    return { text, ordinary: current.ordinary === true || failed.ordinary === true, references: current.references.length ? current.references : failed.references }
  }
  const offset = current.text ? current.text.length + 2 : 0
  return { text, ordinary, references: [...current.references, ...failed.references.map(ref => ({
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
  onDraftRecovered?: (text: string, references: MentionReference[], ordinary?: boolean) => void
}

/** Persist ordinary drafts; hold failed sends outside an active edit buffer. */
export function useConversationDraft({
  conversationId, draftOperations, composerRef, onDraftRestored,
  editingConversationId, getReferences, onDraftRecovered,
}: UseConversationDraftOptions): [
  string, React.Dispatch<React.SetStateAction<string>>,
  (canRecover?: () => boolean) => () => boolean, () => void, () => boolean,
] {
  const { owner, getDraft, setDraft, clearDraft, getOrdinary } = draftOperations
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
    messageDraftRef.current.ordinary = getOrdinary?.(conversationIdRef.current, next)
    textConversationIdRef.current = conversationIdRef.current
  }, [cancelPendingSave, getOrdinary])

  const persist = useCallback((id: string, snapshot: DraftSnapshot) => {
    if (getStorageScopeJid() !== account) return
    const key = JSON.stringify([account, id])
    if (snapshot.text.trim()) {
      if (getOrdinary) setDraft(id, snapshot.text, { ordinary: snapshot.ordinary === true })
      else setDraft(id, snapshot.text)
      if (snapshot.references.length) put(draftMentions, owner, key, {
        text: snapshot.text, references: [...snapshot.references],
      })
      else remove(draftMentions, owner, key)
    } else {
      clearDraft(id)
      remove(draftMentions, owner, key)
    }
  }, [account, owner, setDraft, clearDraft, getOrdinary])

  const readMessageDraft = useCallback((id: string): DraftSnapshot => {
    const pending = deferredDrafts.get(owner)?.get(JSON.stringify([account, id]))
    if (pending) return deferredSnapshot(pending)
    if (editingRef.current || wasEditingRef.current) return messageDraftRef.current
    const text = composerRef.current?.getText() ?? currentTextRef.current
    return { text, ordinary: getOrdinary?.(id, text),
      references: callbacks.current.getReferences?.() ?? [] }
  }, [account, owner, composerRef, getOrdinary])

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
      const snapshot = { text: draft, ordinary: getOrdinary?.(conversationId, draft), references: metadata?.text === draft ? metadata.references : [] }
      messageDraftRef.current = snapshot
      if (!editingRef.current) {
        currentTextRef.current = draft
        setText(draft)
        callbacks.current.onDraftRestored?.()
        callbacks.current.onDraftRecovered?.(draft, snapshot.references, snapshot.ordinary)
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
        : (() => {
          const text = composer?.getText() ?? ''
          return { text, ordinary: getOrdinary?.(conversationId, text), references: callbacks.current.getReferences?.() ?? [] }
        })()
      if (snapshot.text.trim() || pending) persist(conversationId, snapshot)
    }
  }, [conversationId, owner, ownerKey, getDraft, composerRef, persist, readMessageDraft, cancelPendingSave, getOrdinary])

  useEffect(() => {
    if (isEditing || wasEditingRef.current || textConversationIdRef.current !== conversationId || text !== currentTextRef.current) return
    cancelPendingSave()
    if (!text.trim()) persist(conversationId, { text, references: [] })
    else debounceTimerRef.current = setTimeout(() => persist(conversationId, {
      text, ordinary: getOrdinary?.(conversationId, text), references: callbacks.current.getReferences?.() ?? [],
    }), DRAFT_SAVE_DELAY_MS)
    return cancelPendingSave
  }, [text, isEditing, conversationId, persist, cancelPendingSave, getOrdinary])

  const applySnapshot = useCallback((snapshot: DraftSnapshot) => {
    cancelPendingSave()
    messageDraftRef.current = { ...snapshot, references: [...snapshot.references] }
    currentTextRef.current = snapshot.text
    callbacks.current.onDraftRecovered?.(snapshot.text, snapshot.references, snapshot.ordinary)
    if (composerRef.current) composerRef.current.setText(snapshot.text)
    else userSetText(snapshot.text)
    persist(conversationId, snapshot)
  }, [cancelPendingSave, composerRef, userSetText, persist, conversationId])

  useEffect(() => {
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
      applySnapshot(mergeSnapshots(current, failed))
      return !current.text
    }
    put(draftOwners, owner, ownerKey, recoverHere)
    put(draftReaders, owner, ownerKey, () => readMessageDraft(conversationId).text)
    if (!isEditing) {
      const pending = deferredDrafts.get(owner)?.get(ownerKey)
      if (pending) {
        remove(deferredDrafts, owner, ownerKey)
        applySnapshot(deferredSnapshot(pending))
      } else if (wasEditingRef.current) {
        // Without a failed send, keep the existing edit-finish behavior.
        const text = composerRef.current?.getText() ?? currentTextRef.current
        messageDraftRef.current = {
          text, ordinary: getOrdinary?.(conversationId, text),
          references: callbacks.current.getReferences?.() ?? [],
        }
        persist(conversationId, messageDraftRef.current)
      }
    } else cancelPendingSave()
    wasEditingRef.current = isEditing
    return () => {
      if (draftOwners.get(owner)?.get(ownerKey) === recoverHere) {
        remove(draftOwners, owner, ownerKey)
        remove(draftReaders, owner, ownerKey)
      }
    }
  }, [owner, ownerKey, conversationId, isEditing, composerRef, cancelPendingSave, userSetText, persist, readMessageDraft, getOrdinary, applySnapshot])

  const consumeDraft = useCallback((canRecover?: () => boolean) => {
    const id = conversationId
    const scope = getStorageScopeJid()
    const key = JSON.stringify([scope, id])
    const text = composerRef.current?.getText() ?? currentTextRef.current
    const submitted: FailedDraft = {
      text, ordinary: getOrdinary?.(id, text),
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
          base: { text: saved, ordinary: getOrdinary?.(id, saved), references: metadata?.text === saved ? metadata.references : [] }, failures: [],
        }
        pending.failures.push(submitted)
        put(deferredDrafts, owner, key, pending)
        persist(id, deferredSnapshot(pending))
      }
      return false
    }
  }, [conversationId, owner, composerRef, cancelPendingSave, clearDraft, getDraft, persist, getOrdinary])

  const discardDraft = useCallback(() => {
    remove(deferredDrafts, owner, ownerKey)
    messageDraftRef.current = { text: '', references: [] }
    userSetText('')
    callbacks.current.onDraftRecovered?.('', [])
    persist(conversationId, messageDraftRef.current)
  }, [owner, ownerKey, userSetText, persist, conversationId])

  const restoreMessageDraft = useCallback(() => {
    if (getStorageScopeJid() !== account) return false
    const pending = deferredDrafts.get(owner)?.get(ownerKey)
    let snapshot = pending ? deferredSnapshot(pending) : messageDraftRef.current
    if (!snapshot.text.trim()) {
      const saved = getDraft(conversationId)
      const metadata = draftMentions.get(owner)?.get(ownerKey)
      snapshot = { text: saved, ordinary: getOrdinary?.(conversationId, saved), references: metadata?.text === saved ? metadata.references : [] }
    }
    if (!snapshot.text.trim()) return false
    remove(deferredDrafts, owner, ownerKey)
    wasEditingRef.current = false
    textConversationIdRef.current = conversationId
    applySnapshot({ ...snapshot, references: [...snapshot.references] })
    return true
  }, [account, owner, ownerKey, conversationId, getDraft, getOrdinary, applySnapshot])

  return [text, userSetText, consumeDraft, discardDraft, restoreMessageDraft]
}

/**
 * Add text from outside the composer (a link's `body`) to a conversation's
 * draft, below what is already there, whether or not its editor is open. The
 * same text already at the end of the draft is not added again. Never sends.
 */
export function addDraftText(draftOperations: DraftOperations, conversationId: string, text: string): void {
  const { owner, getDraft, setDraft } = draftOperations
  const key = JSON.stringify([getStorageScopeJid(), conversationId])
  const editor = draftOwners.get(owner)?.get(key)
  const current = draftReaders.get(owner)?.get(key)?.() ?? getDraft(conversationId)
  if (!text.trim() || current === text || current.endsWith(`\n\n${text}`)) return
  if (editor) {
    editor({ text, references: [], canRecover: () => true })
    return
  }
  setDraft(conversationId, mergeFailedDraft(current, text))
}
