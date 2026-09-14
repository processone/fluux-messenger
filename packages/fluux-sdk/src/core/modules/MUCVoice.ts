import { xml, type Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getBareJid } from '../jid'
import { NS_DATA_FORMS } from '../namespaces'
import type { RoomVoiceRequest } from '../types/events'
import { generateUUID } from '../../utils/uuid'
import { buildDataFormSubmit } from '../../utils/dataForm'
import { formatXMPPError, parseXMPPError } from '../../utils/xmppError'

const FORM_TYPE = 'http://jabber.org/protocol/muc#request'

/** Session-scoped XEP-0045 voice requests and service approval forms. */
export class MUCVoice extends BaseModule {
  private approvals = new Map<string, RoomVoiceRequest>()
  private submissions = new Map<string, { id: string; failed: boolean }>()

  handle(stanza: Element): boolean {
    const roomJid = stanza.attrs.from ?? ''
    const room = this.deps.stores?.room.getRoom(roomJid)
    // Only a bare, joined room service can generate approval forms or errors.
    if (roomJid.includes('/') || !room?.joined) return false
    if (stanza.attrs.type === 'error') {
      const submission = this.submissions.get(roomJid)
      const approvalKey = `${roomJid}\0${stanza.attrs.id}`
      const approval = this.approvals.get(approvalKey)
      const isSubmission = submission !== undefined && submission.id === stanza.attrs.id
      if (!isSubmission && !approval) return false
      if (isSubmission) submission.failed = true
      this.approvals.delete(approvalKey)
      const error = parseXMPPError(stanza)
      this.deps.emitSDK('events:voice-request-status', {
        roomJid, status: 'error', error: error ? formatXMPPError(error) : 'Voice request rejected',
        ...(approval ? { requestId: approval.id } : {}),
      })
      return true
    }
    if (stanza.attrs.type && stanza.attrs.type !== 'normal') return false
    const form = stanza.getChild('x', NS_DATA_FORMS)
    if (form?.attrs.type !== 'form') return false
    const values = new Map<string, string>()
    for (const field of form.getChildren('field')) {
      // Ambiguous identities must never become actionable approvals.
      if (values.has(field.attrs.var) || field.getChildren('value').length !== 1) return false
      values.set(field.attrs.var, field.getChildText('value') ?? '')
    }
    if (values.get('FORM_TYPE') !== FORM_TYPE) return false
    if (room.selfOccupant?.role !== 'moderator' || values.get('muc#role') !== 'participant') return true
    const jid = values.get('muc#jid')
    const nick = values.get('muc#roomnick')
    if (!jid || !nick || !values.has('muc#request_allow')) return true
    this.deps.emitSDK('events:voice-request', {
      roomJid, jid, nick, id: stanza.attrs.id || generateUUID(),
    })
    return true
  }

  async requestVoice(roomJid: string): Promise<void> {
    const room = this.deps.stores?.room.getRoom(roomJid)
    if (!room?.joined || room.selfOccupant?.role !== 'visitor') {
      throw new Error('Only a joined visitor can request voice')
    }
    const submission = { id: `voice_${generateUUID()}`, failed: false }
    this.submissions.set(roomJid, submission)
    try {
      await this.deps.sendStanza(xml('message', { to: roomJid, id: submission.id },
        buildDataFormSubmit({ 'muc#role': 'participant' }, FORM_TYPE)))
      if (!submission.failed && this.submissions.get(roomJid) === submission) {
        this.deps.emitSDK('events:voice-request-status', { roomJid, status: 'sent' })
      }
    } catch (error) {
      this.submissions.delete(roomJid)
      throw error
    }
  }

  async approveVoiceRequest(request: RoomVoiceRequest): Promise<void> {
    const room = this.deps.stores?.room.getRoom(request.roomJid)
    if (!room?.joined || room.selfOccupant?.role !== 'moderator') {
      throw new Error('Only a joined moderator can grant voice')
    }
    const occupant = room.occupants.get(request.nick)
    if (occupant && (occupant.role !== 'visitor' || (occupant.jid && getBareJid(occupant.jid) !== getBareJid(request.jid)))) {
      throw new Error('This voice request no longer matches the room occupant')
    }
    const key = `${request.roomJid}\0${request.id}`
    if (this.approvals.size >= 200) this.approvals.delete(this.approvals.keys().next().value!)
    this.approvals.set(key, request)
    // XEP-0045 §8.6 submits the full requesting JID together with the nickname.
    try {
      await this.deps.sendStanza(xml('message', { to: request.roomJid, id: request.id },
        buildDataFormSubmit({
          'muc#role': 'participant', 'muc#jid': request.jid,
          'muc#roomnick': request.nick, 'muc#request_allow': 'true',
        }, FORM_TYPE)))
    } catch (error) {
      this.approvals.delete(key)
      throw error
    }
    // The presence update, not transport submission, removes the pending request.
  }

  handlePresence(roomJid: string, nick: string, role: string, isSelf: boolean, unavailable: boolean): void {
    if (isSelf && (unavailable || role !== 'visitor')) this.submissions.delete(roomJid)
    for (const [key, request] of this.approvals) {
      if (request.roomJid !== roomJid) continue
      if ((isSelf && (unavailable || role !== 'moderator')) || (request.nick === nick && (unavailable || role !== 'visitor'))) {
        this.approvals.delete(key)
      }
    }
  }

  cleanup(): void {
    this.approvals.clear()
    this.submissions.clear()
    this.deps.emitSDK('events:voice-requests-cleared', {})
  }
}
