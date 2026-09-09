import type { Element } from '@xmpp/client'
import type { ModuleDependencies } from './BaseModule'
import { getBareJid } from '../jid'
import { NS_OCCUPANT_ID } from '../namespaces'
import { captureStorageScope } from '../../utils/storageScope'
import { generateUUID } from '../../utils/uuid'
import { sameCorrection, type CorrectionRevision, type CorrectionReceiveOrder, type MessageImplState } from '../types/message-internal'
import { parseCorrectionIds } from './messagingUtils'

interface ReceiveObservation {
  scope: string
  correctionRevision: CorrectionRevision
  order: CorrectionReceiveOrder
  pending: number
}

export class CorrectionReceipts {
  private receiveOrders = new WeakMap<Element, ReceiveObservation>()
  private pendingReceives = new Set<ReceiveObservation>()
  private receiveSession?: { id: string; sequence: number; isCurrent: () => boolean }

  constructor(private deps: ModuleDependencies) {}

  begin(stanza: Element): () => void {
    const observation = this.receiveOrders.get(stanza)!
    observation.pending++
    this.pendingReceives.add(observation)
    return () => {
      if (--observation.pending === 0) this.pendingReceives.delete(observation)
    }
  }

  observe(stanza: Element, archive = false, archiveId?: string): void {
    const order = this.nextOrder()
    const existing = this.receiveOrders.get(stanza)
    if (existing?.order.session === order.session) {
      if (!archive && existing.order.archive) existing.order = { ...order, replay: true }
      return
    }
    const from = stanza.attrs.from ?? ''
    const bareFrom = getBareJid(from)
    const ownJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isRoom = stanza.attrs.type === 'groupchat' || this.deps.stores?.room?.getRoom(bareFrom)?.joined === true
    const conversation = isRoom || bareFrom !== ownJid ? bareFrom : getBareJid(stanza.attrs.to ?? '')
    const author = isRoom ? stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id ?? from : bareFrom
    const scope = JSON.stringify([isRoom, conversation, author])
    if (archive) order.archive = true
    const correctionRevision = { ids: parseCorrectionIds(stanza, isRoom ? conversation : ownJid, archiveId), supersedes: [] }
    const matches = [...this.pendingReceives].filter(observation =>
      observation.scope === scope && sameCorrection(observation, { correctionRevision }))
    if (matches.length === 1) {
      const observation = matches[0]
      if (!archive && observation.order.archive) observation.order = { ...order, replay: true }
      observation.correctionRevision.ids = [...new Set([...observation.correctionRevision.ids, ...correctionRevision.ids])]
      this.receiveOrders.set(stanza, observation)
      return
    }
    this.receiveOrders.set(stanza, { scope, correctionRevision, order, pending: 0 })
  }

  nextOrder(): CorrectionReceiveOrder {
    if (!this.receiveSession?.isCurrent()) {
      this.pendingReceives.clear()
      const scope = captureStorageScope()
      const jid = this.deps.getCurrentJid()
      const manager = this.deps.getE2EEManager?.()
      this.receiveSession = {
        id: generateUUID(), sequence: 0,
        isCurrent: () => scope.isCurrent() && jid === this.deps.getCurrentJid() && manager === this.deps.getE2EEManager?.(),
      }
    }
    return { session: this.receiveSession.id, sequence: ++this.receiveSession.sequence }
  }

  withOrder<T extends MessageImplState>(stanza: Element, updates: T): T {
    const observation = this.receiveOrders.get(stanza)
    return observation && updates.correctionRevision
      ? { ...updates, correctionRevision: {
        ...updates.correctionRevision,
        ...(sameCorrection(observation, updates) && {
          ids: [...new Set([...observation.correctionRevision.ids, ...updates.correctionRevision.ids])],
        }),
        receiveOrder: observation.order,
      } }
      : updates
  }

}
