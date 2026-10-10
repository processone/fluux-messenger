import { CHAT_SCOPE, canonicalReference, tierKey, chatStore, connectionStore, isAhead, makeReadPointer, subscribeLocalReads } from '@fluux/sdk'
import type { Message, LocalReadEvent } from '@fluux/sdk'
import { getMessages, getMessage } from '@fluux/sdk/cache'
import { platform } from '@/platform'
import { useIOSPreviewSettingsStore } from './previewSettings'

interface Session { account: string; epoch: string }
let session: Session | undefined
let writes = Promise.resolve()
type ReadMessage = Pick<Message, 'id' | 'ownArchiveId' | 'ownArchiveBy' | 'isOutgoing'>
interface ReadEvidence { event: LocalReadEvent; resident: ReadMessage[] }
let pendingReads: ReadEvidence[] = []
let lifetime = {}

export function setPreviewLedgerSession(value: Session): void {
  if (session && (session.account !== value.account || session.epoch !== value.epoch)) clearPreviewLedgerSession()
  if (!session) session = value
  const bound = session
  const pending = pendingReads
  pendingReads = []
  for (const evidence of pending) {
    if (evidence.event.account === bound.account && owner() === bound.account) {
      void queue(() => recordRead(evidence, bound))
    }
  }
}
export function clearPreviewLedgerSession(): void { session = undefined; pendingReads = []; lifetime = {} }
const enabled = () => platform().usesNativePush && platform().os === 'ios'
const owner = () => connectionStore.getState().jid?.split('/')[0]

export function messageLedgerIdentity(message: Pick<Message, 'id' | 'ownArchiveId' | 'ownArchiveBy'>, account: string) {
  if (!message.ownArchiveId || message.ownArchiveBy !== account) return undefined
  const uid = canonicalReference({ id: message.id, stanzaId: message.ownArchiveId })
  return { uid, key: tierKey(CHAT_SCOPE, 'stanzaId', uid), archiveAuthority: account }
}
async function merge(messages: ReadMessage[], conversation: string, read: boolean, notified: boolean, bound: Session): Promise<void> {
  if (!enabled() || session !== bound || owner() !== bound.account) return
  const deltas = messages.filter(message => !message.isOutgoing).flatMap(message => {
    const identity = messageLedgerIdentity(message, bound.account)
    return identity ? [{ ...identity, account: bound.account, epoch: bound.epoch, conversation, read, notified }] : []
  })
  const { invoke } = await import('@tauri-apps/api/core')
  for (let index = 0; index < deltas.length; index += 256) {
    if (session !== bound || owner() !== bound.account) return
    await invoke('plugin:push|set_notification_preview', { operation: 'merge', snapshot: null, deltas: deltas.slice(index, index + 256) })
  }
}
function queue(work: () => Promise<void>): Promise<void> {
  writes = writes.then(work).catch(() => {})
  return writes
}
async function recordRead(evidence: ReadEvidence, bound: Session): Promise<void> {
  if (session !== bound || owner() !== bound.account) return
  const { event, resident } = evidence
  const cached = event.messageOnly ? [] : await getMessages(event.conversationId, {
    before: new Date(event.pointer.order.timestamp + 1), limit: 4096,
  })
  const readCached = cached.filter(message => !isAhead(makeReadPointer(message, 'chat'), event.pointer))
  const unique = new Map<string, ReadMessage>(readCached.map(message => [message.id, message]))
  for (const message of resident) {
    const cachedMessage = unique.get(message.id)
    if (!cachedMessage || !messageLedgerIdentity(cachedMessage, bound.account)) unique.set(message.id, message)
  }
  await merge([...unique.values()], event.conversationId, true, false, bound)
}
/** Union exact locally-read IDs; a cache/window import never replaces notification history. */
export function startIOSReadLedger(): () => void {
  if (!enabled()) return () => {}
  const discardRetired = () => {
    const settings = useIOSPreviewSettingsStore.getState()
    if ((session && owner() !== session.account) || pendingReads.some(({ event }) => event.account !== owner() || settings.account !== event.account || !settings.enabled)) {
      clearPreviewLedgerSession()
    }
  }
  const stop = subscribeLocalReads((event: LocalReadEvent) => {
    discardRetired()
    const bound = session
    const settings = useIOSPreviewSettingsStore.getState()
    if (event.kind !== 'chat' || event.account !== owner() || event.pointer.order.role !== 'exact') return
    if (bound ? event.account !== bound.account : settings.account !== event.account || !settings.enabled) return
    const resident = (chatStore.getState().messages.get(event.conversationId) ?? []).filter(message => event.messageOnly
      ? message.id === event.pointer.identity.messageId
      : !isAhead(makeReadPointer(message, 'chat'), event.pointer)).map(({ id, ownArchiveId, ownArchiveBy, isOutgoing }) => ({ id, ownArchiveId, ownArchiveBy, isOutgoing }))
    const evidence = { event, resident }
    if (!bound) {
      const remaining = 4096 - pendingReads.reduce((count, read) => count + read.resident.length, 0)
      if (pendingReads.length < 64) pendingReads.push({ event, resident: resident.slice(0, remaining) })
      return
    }
    const capturedLifetime = lifetime
    void queue(async () => {
      if (lifetime === capturedLifetime) await recordRead(evidence, bound)
    })
  }, 'chat')
  const unsubscribeAccount = connectionStore.subscribe(discardRetired)
  const unsubscribeSettings = useIOSPreviewSettingsStore.subscribe(discardRetired)
  return () => { stop(); unsubscribeAccount(); unsubscribeSettings() }
}
function residentMessage(conversation: string, messageId: string): Message | undefined {
  const state = chatStore.getState()
  return state.messages.get(conversation)?.find(message => message.id === messageId)
    ?? (state.conversationMeta?.get(conversation)?.lastMessage?.id === messageId ? state.conversationMeta.get(conversation)?.lastMessage : undefined)
}
export function isIOSNotificationCurrent(conversation: string, messageId: string, account: string): boolean {
  return owner() === account && !residentMessage(conversation, messageId)?.isRetracted
}
/** Reserve an app notification before OS submission to share at-most-once claims with the NSE. */
export async function reserveIOSNotification(conversation: string, messageId: string, account: string, requestId: string): Promise<boolean> {
  const bound = session
  if (!enabled()) return true
  if (!isIOSNotificationCurrent(conversation, messageId, account)) return false
  if (!bound) {
    const settings = useIOSPreviewSettingsStore.getState()
    // An opted-in startup must wait for its shared claim capability before OS submission.
    return settings.account !== account || !settings.enabled
  }
  if (bound.account !== account || owner() !== account) return false
  let message = residentMessage(conversation, messageId) ?? await getMessage(conversation, messageId)
  message = residentMessage(conversation, messageId) ?? message
  if (!message || message.isRetracted || session !== bound || !isIOSNotificationCurrent(conversation, messageId, account)) return false
  const identity = messageLedgerIdentity(message, account)
  if (!identity) return false
  const { invoke } = await import('@tauri-apps/api/core')
  if (session !== bound || !isIOSNotificationCurrent(conversation, messageId, account)) return false
  const result = await invoke<{ allowed: boolean }>('plugin:push|set_notification_preview', {
    operation: 'claimApp', snapshot: null, requestId,
    deltas: [{ ...identity, account, epoch: bound.epoch, conversation, read: false, notified: true }],
  })
  if (!result.allowed || session !== bound || !isIOSNotificationCurrent(conversation, messageId, account)) return false
  const current = residentMessage(conversation, messageId) ?? await getMessage(conversation, messageId)
  return !!current && !current.isRetracted && session === bound && isIOSNotificationCurrent(conversation, messageId, account)
}
