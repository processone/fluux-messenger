/**
 * Demo XMPP client that populates the UI with realistic fake data.
 *
 * Extends {@link XMPPClient} and seeds Zustand stores via SDK events,
 * without connecting to any XMPP server. Useful for screenshots,
 * screen recordings, and marketing demos.
 *
 * @example
 * ```tsx
 * import { DemoClient, XMPPProvider } from '@fluux/sdk'
 * import { buildDemoData, buildDemoAnimation } from './demoData'
 *
 * const client = new DemoClient()
 * client.populateDemo(buildDemoData())
 * client.startAnimation(buildDemoAnimation())
 *
 * <XMPPProvider client={client}>
 *   <App />
 * </XMPPProvider>
 * ```
 *
 * @packageDocumentation
 * @module Demo
 */

import { XMPPClient } from '../core/XMPPClient'
import { connectionStore } from '../stores/connectionStore'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { eventsStore } from '../stores/eventsStore'
import type { Contact } from '../core/types/roster'
import type { Room, RoomMessage, RoomOccupant } from '../core/types/room'
import type { DemoData, DemoAnimationStep } from './types'
import { buildStressEvents, type StressScenario } from './stress'
import { parsePollElement, parsePollClosedElement } from '../core/poll'
import { generateUUID } from '../utils/uuid'
import type { PollData, PollClosedData } from '../core/types/message-base'

type AnimationState = 'idle' | 'playing' | 'paused' | 'stopped'

// XMPP namespace constants used for IQ routing
const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
const NS_DISCO_ITEMS = 'http://jabber.org/protocol/disco#items'
const NS_RSM = 'http://jabber.org/protocol/rsm'
const NS_MUC = 'http://jabber.org/protocol/muc'
const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner'
const NS_MUC_ADMIN = 'http://jabber.org/protocol/muc#admin'
const NS_VCARD_TEMP = 'vcard-temp'
const NS_PUBSUB = 'http://jabber.org/protocol/pubsub'
const NS_BLOCKING = 'urn:xmpp:blocking'
const NS_MAM = 'urn:xmpp:mam:2'
const NS_COMMANDS = 'http://jabber.org/protocol/commands'
const NS_DATA_FORMS = 'jabber:x:data'
const NS_VERSION = 'jabber:iq:version'
const NS_LAST = 'jabber:iq:last'
const NS_MDS = 'urn:xmpp:mds:displayed:0'
const NS_STANZA_ID = 'urn:xmpp:sid:0'

/**
 * Default an XEP-0359 stanza-id onto a seeded demo message. MDS (XEP-0490)
 * marker resolution matches on `stanzaId`, so id-less demo messages could
 * never be referenced by a simulated read position. Deterministic (`sid-<id>`)
 * so demo scripts can point a marker at any seeded message.
 */
function withDefaultStanzaId<T extends { id: string; stanzaId?: string }>(message: T): T {
  return message.stanzaId ? message : { ...message, stanzaId: `sid-${message.id}` }
}

/** Minimal Element-like object returned by mock IQ responses. */
interface MockElement {
  name: string
  attrs: Record<string, string>
  /** Text content as a property (legacy mock shape). */
  _text?: string
  children: MockElement[]
  getChild: (name: string, xmlns?: string) => MockElement | undefined
  getChildren: (name: string) => MockElement[]
  getChildText: (name: string) => string | null
  getText: () => string
  /** Text content as a method — matches ltx/@xmpp Element.text() used by parseDataForm/version parsing. */
  text: () => string
  toString: () => string
}

/** Room entry in the internal registry for IQ routing. */
interface KnownRoom {
  name: string
  occupantCount?: number
}

/**
 * A demo XMPPClient that populates stores with app-provided data.
 *
 * Call {@link populateDemo} after construction to seed all stores.
 * Optionally call {@link startAnimation} to schedule live events
 * (typing indicators, incoming messages) on timers.
 *
 * Supports pause/resume for interactive tutorial walkthroughs.
 */
export class DemoClient extends XMPPClient {
  private animationTimers: ReturnType<typeof setTimeout>[] = []
  private allSteps: DemoAnimationStep[] = []
  private firedStepCount = 0
  private animationStartTime = 0
  private elapsedAtPause = 0
  private _animationState: AnimationState = 'idle'

  // Registries for simulating IQ responses (populated by populateDemo)
  private conferenceService = ''
  private selfJid = ''
  private knownRooms = new Map<string, KnownRoom>()
  private seededRoomOccupants = new Map<string, RoomOccupant[]>()
  private seededContacts = new Map<string, Contact>()
  private seededRooms = new Map<string, Room>()
  // Simulated XEP-0490 MDS PEP node: conversation bare JID → last-displayed
  // marker. Backs the pubsub publish/items/retract IQs so client.mds.* and the
  // fresh-session seed (fetchAllDisplayed) work in demo mode.
  private mdsNodeItems = new Map<string, { stanzaId: string; by: string }>()

  /** Current animation state. */
  get animationState(): AnimationState {
    return this._animationState
  }

  /**
   * Register additional rooms that appear in Browse Rooms results
   * but are not pre-joined. Call after {@link populateDemo}.
   */
  setDiscoverableRooms(rooms: Array<{ jid: string; name: string; occupantCount?: number }>): void {
    for (const room of rooms) {
      if (!this.knownRooms.has(room.jid)) {
        this.knownRooms.set(room.jid, { name: room.name, occupantCount: room.occupantCount })
      }
    }
  }

  /**
   * DEV/DEMO ONLY. Simulate another of our own devices publishing an MDS
   * (XEP-0490) read position for a conversation or room: upserts the marker
   * on the simulated PEP node (so a later `fetchAllDisplayed` seed sees it)
   * and emits the live `read:displayed-synced` notify, exactly like PubSub
   * does for a real +notify event.
   *
   * With seeded/stress messages carrying `sid-<messageId>` stanza-ids, this
   * reproduces cross-device read-sync flows from the console, e.g.:
   * `__demoClient.simulateRemoteDisplayed(roomJid, 'sid-stress-0-850')`
   */
  simulateRemoteDisplayed(conversationJid: string, stanzaId: string): void {
    // XEP-0359 `by`: the archive that assigned the id — the room for MUC,
    // our own bare JID for 1:1 (mirrors mdsSideEffects.stanzaIdBy).
    const by = this.knownRooms.has(conversationJid) ? conversationJid : this.selfJid
    this.mdsNodeItems.set(conversationJid, { stanzaId, by })
    this.emitSDK('read:displayed-synced', { conversationId: conversationJid, stanzaId })
  }

  /**
   * DEV/DEMO ONLY. Replays a synthetic load (e.g. joining many large rooms) by
   * scheduling SDK events over timers, to reproduce render-performance issues
   * deterministically. Returns a handle whose stop() cancels pending events.
   */
  runStressScenario(scenario: StressScenario): { stop: () => void } {
    const selfNick = this.selfJid.split('@')[0] || 'you'
    const events = buildStressEvents(scenario, {
      selfJid: this.selfJid,
      selfNick,
      conferenceService: this.conferenceService,
    })
    let timers: ReturnType<typeof setTimeout>[] = [
      ...events.map(ev =>
        setTimeout(() => {
          // Same cast style as dispatchStep(): payloads are generated to match the event.
          this.emitSDK(ev.type as Parameters<typeof this.emitSDK>[0], ev.payload as never)
        }, ev.delayMs),
      ),
    ]
    return {
      stop: () => {
        for (const t of timers) clearTimeout(t)
        timers = []
      },
    }
  }

  // -------------------------------------------------------------------------
  // Stanza/IQ overrides — simulate XMPP server responses in demo mode
  // -------------------------------------------------------------------------

  // Modules call sendStanza/sendIQ via the deps closure, which dispatches
  // to these overrides. This allows chat.sendMessage() etc. to work:
  // the stanza is silently dropped but the SDK events still fire.
  //
  // For groupchat messages we simulate the server echo: a real MUC server
  // reflects the message back to the sender, which is what triggers the
  // store update. Without this echo the sent message would vanish.
  //
  // For MUC join presence we simulate the server's self-presence response
  // so that joinRoom() completes successfully.
  protected override async sendStanza(stanza: any): Promise<void> {
    // Groupchat message echo
    if (stanza?.name === 'message' && stanza?.attrs?.type === 'groupchat') {
      this.handleGroupchatEcho(stanza)
      return
    }

    // MUC join presence: <presence to="room/nick"><x xmlns="...muc"/></presence>
    if (stanza?.name === 'presence' && !stanza?.attrs?.type) {
      const hasMucChild = stanza.children?.some?.(
        (c: any) => c.name === 'x' && c.attrs?.xmlns === NS_MUC
      )
      if (hasMucChild) {
        this.handleDemoJoinPresence(stanza)
        return
      }
    }

    // All other stanzas silently dropped (leave presence, etc.)
  }

  protected override async sendIQ(stanza: any): Promise<any> {
    const to = stanza?.attrs?.to as string | undefined

    // Inspect children to route IQ responses by namespace
    const queryChild = stanza?.children?.find?.(
      (c: any) => c.name === 'query'
    )
    const xmlns = queryChild?.attrs?.xmlns as string | undefined

    // --- Service Discovery ---

    // disco#info to a known room → return room features for queryRoomFeatures()
    if (xmlns === NS_DISCO_INFO && to && this.knownRooms.has(to)) {
      return this.buildDiscoInfoResponse(to)
    }

    // disco#info to our own bare JID → account entity capabilities.
    // The demo simulates a full-featured server, so advertise PEP
    // (XEP-0163) — the encryption settings probe (checkPepSupport)
    // targets this JID and would otherwise warn about a missing PEP.
    if (xmlns === NS_DISCO_INFO && to && to === this.selfJid) {
      return this.buildAccountDiscoInfoResponse()
    }

    // disco#items to the conference service → return room list for fetchRoomList()
    if (xmlns === NS_DISCO_ITEMS && to === this.conferenceService) {
      return this.buildDiscoItemsResponse()
    }

    // --- Server version (XEP-0092) ---
    // fetchServerVersion() queries jabber:iq:version on the domain.
    if (xmlns === NS_VERSION) {
      return this.buildVersionResponse()
    }

    // --- Last activity (XEP-0012) ---
    // The admin user list lazily queries jabber:iq:last per offline row.
    if (xmlns === NS_LAST) {
      return this.buildLastActivityResponse(to)
    }

    // --- vCard-temp (XEP-0054) ---

    const vcardChild = stanza?.children?.find?.(
      (c: any) => c.name === 'vCard' && c.attrs?.xmlns === NS_VCARD_TEMP
    )
    if (vcardChild) {
      return this.buildVCardResponse(to)
    }

    // --- PubSub items (avatars, nicknames) ---

    const pubsubChild = stanza?.children?.find?.(
      (c: any) => c.name === 'pubsub' && c.attrs?.xmlns === NS_PUBSUB
    )
    if (pubsubChild) {
      // XEP-0490 MDS node traffic is served from the in-memory node registry;
      // other pubsub requests (avatars, nicknames) fall through to the
      // generic empty-items response.
      const mdsResponse = this.handleMdsPubSubIQ(pubsubChild)
      if (mdsResponse) return mdsResponse
      return this.buildPubSubResponse(pubsubChild)
    }

    // --- Blocklist (XEP-0191) ---

    const blocklistChild = stanza?.children?.find?.(
      (c: any) => c.name === 'blocklist' && c.attrs?.xmlns === NS_BLOCKING
    )
    if (blocklistChild) {
      return this.buildBlocklistResponse()
    }

    // --- MAM queries (XEP-0313) ---

    const mamChild = stanza?.children?.find?.(
      (c: any) => c.name === 'query' && c.attrs?.xmlns === NS_MAM
    )
    if (mamChild) {
      return this.buildMAMResponse()
    }

    // --- MUC owner: room config (XEP-0045) ---

    if (xmlns === NS_MUC_OWNER) {
      return this.buildRoomConfigResponse(to)
    }

    // --- MUC admin: affiliation lists (XEP-0045) ---

    if (xmlns === NS_MUC_ADMIN) {
      return this.buildRoomAffiliationResponse(to, queryChild)
    }

    // --- Ad-hoc commands (XEP-0050) ---

    const commandChild = stanza?.children?.find?.(
      (c: any) => c.name === 'command' && c.attrs?.xmlns === NS_COMMANDS
    )
    if (commandChild) {
      return this.buildAdminCommandResponse(commandChild)
    }

    // Fallback: return empty stub so callers using .getChild() etc.
    // get null/empty results instead of crashing on null.
    return this.buildEmptyStub()
  }

  /**
   * Synchronously populate all stores with demo data.
   *
   * Must be called after construction and before React renders
   * so the UI sees the populated state on first paint.
   *
   * @param data - All demo content (contacts, messages, rooms, etc.)
   */
  populateDemo(data: DemoData): void {
    // Set the current JID so modules (e.g., chat.sendMessage) can read it
    this.currentJid = data.self.jid
    this.selfJid = data.self.jid

    // Derive conference service from domain
    this.conferenceService = `conference.${data.self.domain}`

    // Connection store is updated directly (not via SDK events)
    // because Connection.ts handles these outside of store bindings.
    connectionStore.getState().setStatus('online')
    connectionStore.getState().setJid(data.self.jid)
    if (data.self.avatar) {
      connectionStore.getState().setOwnAvatar(data.self.avatar)
    }

    // Own resources (other connected devices)
    if (data.ownResources) {
      for (const res of data.ownResources) {
        connectionStore.getState().updateOwnResource(
          res.resource, res.show, res.priority, res.status, new Date(), res.client,
        )
      }
    }

    // Store contacts for IQ response generation (vCard, PubSub)
    for (const contact of data.contacts) {
      this.seededContacts.set(contact.jid, contact)
    }

    // Roster: load contacts then set presence per-resource
    this.emitSDK('roster:loaded', { contacts: data.contacts })
    for (const presence of data.presences) {
      this.emitSDK('roster:presence', presence)
    }

    // Conversations: create each, then add messages
    for (const conversation of data.conversations) {
      this.emitSDK('chat:conversation', { conversation })
    }

    for (const [, messages] of data.messages) {
      for (const message of messages) {
        this.emitSDK('chat:message', { message: withDefaultStanzaId(message) })
      }
    }

    // Rooms: add, mark joined, populate occupants and messages
    for (const { room, occupants, messages } of data.rooms) {
      this.emitSDK('room:added', { room })
      this.emitSDK('room:joined', { roomJid: room.jid, joined: true })

      const selfOccupant = occupants.find(o => o.jid === data.self.jid)
      if (selfOccupant) {
        this.emitSDK('room:self-occupant', { roomJid: room.jid, occupant: selfOccupant })
      }
      this.emitSDK('room:occupants-batch', { roomJid: room.jid, occupants })

      for (const message of messages) {
        this.emitSDK('room:message', { roomJid: room.jid, message: withDefaultStanzaId(message) })
      }

      // Register seeded rooms in the internal registry
      this.knownRooms.set(room.jid, { name: room.name, occupantCount: occupants.length })
      this.seededRoomOccupants.set(room.jid, occupants)
      this.seededRooms.set(room.jid, room)
    }

    // Set MUC service JID so BrowseRoomsModal can discover it
    this.emitSDK('admin:muc-service', { mucServiceJid: this.conferenceService })

    // Mark all history as complete so the "load earlier messages" spinner
    // never appears — there is no MAM server to query in demo mode.
    const completedState = {
      isLoading: false,
      error: null,
      hasQueried: true,
      isHistoryComplete: true,
      isCaughtUpToLive: true,
    }
    const chatMAM = new Map<string, typeof completedState>()
    for (const conv of data.conversations) {
      chatMAM.set(conv.id, completedState)
    }
    chatStore.setState({ mamQueryStates: chatMAM })

    const roomMAM = new Map<string, typeof completedState>()
    for (const { room } of data.rooms) {
      roomMAM.set(room.jid, completedState)
    }
    roomStore.setState({ mamQueryStates: roomMAM })

    // Events store: seed pending subscription (add-contact) requests so the Contacts
    // destination shows them (badge + Requests section). Direct store access, same as
    // the activity-log seed above.
    for (const from of data.subscriptionRequests ?? []) {
      eventsStore.getState().addSubscriptionRequest(from)
    }

    // Seed room invitations so the Rooms "Invitations" banner is visible in demo.
    for (const inv of data.mucInvitations ?? []) {
      eventsStore.getState().addMucInvitation(inv.roomJid, inv.from, inv.reason)
    }

    // Seed stranger messages so the Messages "Message requests" banner is visible in demo.
    for (const sm of data.strangerMessages ?? []) {
      eventsStore.getState().addStrangerMessage(sm.from, sm.body)
    }
  }

  /**
   * Start animated demo sequence — scheduled events that make the
   * UI feel alive. Call after {@link populateDemo}.
   *
   * @param steps - Timed animation events to schedule.
   * @returns A cleanup function that cancels all pending timers.
   */
  startAnimation(steps: DemoAnimationStep[]): () => void {
    this.allSteps = steps
    this.firedStepCount = 0
    this.elapsedAtPause = 0
    this._animationState = 'playing'
    this.animationStartTime = Date.now()
    this.scheduleSteps(steps, 0)
    return () => this.stopAnimation()
  }

  /**
   * Pause the animation timeline. Pending steps are cancelled and
   * can be resumed later with {@link resumeAnimation}.
   */
  pauseAnimation(): void {
    if (this._animationState !== 'playing') return
    this.elapsedAtPause += Date.now() - this.animationStartTime
    this.clearTimers()
    this._animationState = 'paused'
  }

  /**
   * Resume a paused animation. Remaining steps are rescheduled
   * with adjusted delays.
   */
  resumeAnimation(): void {
    if (this._animationState !== 'paused') return
    this._animationState = 'playing'
    this.animationStartTime = Date.now()
    const remaining = this.allSteps.slice(this.firedStepCount)
    this.scheduleSteps(remaining, this.elapsedAtPause)
  }

  /** Cancel all pending animation timers and mark as stopped. */
  stopAnimation(): void {
    this.clearTimers()
    this._animationState = 'stopped'
  }

  override destroy(): void {
    this.stopAnimation()
    super.destroy()
  }

  // -------------------------------------------------------------------------
  // Private helpers — animation
  // -------------------------------------------------------------------------

  private clearTimers(): void {
    for (const timer of this.animationTimers) {
      clearTimeout(timer)
    }
    this.animationTimers = []
  }

  /**
   * Schedule a list of steps, subtracting `elapsedOffset` from each delay
   * so that pause/resume preserves the timeline's relative timing.
   */
  private scheduleSteps(steps: DemoAnimationStep[], elapsedOffset: number): void {
    for (const step of steps) {
      const adjustedDelay = Math.max(0, step.delayMs - elapsedOffset)
      const timer = setTimeout(() => {
        this.firedStepCount++
        this.dispatchStep(step)
      }, adjustedDelay)
      this.animationTimers.push(timer)
    }
  }

  /** Dispatch a single animation step by emitting the appropriate SDK event. */
  private dispatchStep(step: DemoAnimationStep): void {
    switch (step.action) {
      case 'typing':
      case 'stop-typing':
        this.emitSDK('chat:typing', step.data as Parameters<typeof this.emitSDK<'chat:typing'>>[1])
        break
      case 'message':
        this.emitSDK('chat:message', step.data as Parameters<typeof this.emitSDK<'chat:message'>>[1])
        break
      case 'room-message':
        this.emitSDK('room:message', step.data as Parameters<typeof this.emitSDK<'room:message'>>[1])
        break
      case 'reaction':
      case 'room-reaction':
        this.emitSDK('room:reactions', step.data as Parameters<typeof this.emitSDK<'room:reactions'>>[1])
        break
      case 'chat-reaction':
        this.emitSDK('chat:reactions', step.data as Parameters<typeof this.emitSDK<'chat:reactions'>>[1])
        break
      case 'presence':
        this.emitSDK('roster:presence', step.data as Parameters<typeof this.emitSDK<'roster:presence'>>[1])
        break
      case 'room-typing':
        this.emitSDK('room:typing', step.data as Parameters<typeof this.emitSDK<'room:typing'>>[1])
        break
      case 'message-updated':
        this.emitSDK('chat:message-updated', step.data as Parameters<typeof this.emitSDK<'chat:message-updated'>>[1])
        break
      case 'room-message-updated':
        this.emitSDK('room:message-updated', step.data as Parameters<typeof this.emitSDK<'room:message-updated'>>[1])
        break
      case 'custom':
        this.emitSDK('demo:custom', step.data as Parameters<typeof this.emitSDK<'demo:custom'>>[1])
        break
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers — groupchat echo
  // -------------------------------------------------------------------------

  private handleGroupchatEcho(stanza: any): void {
    const roomJid = stanza.attrs.to as string
    const room = roomStore.getState().getRoom(roomJid)
    if (!room) return

    // Reaction stanzas (votes, emoji reactions): Chat.sendReaction() already
    // emits room:reactions directly after sendStanza(), so no echo needed.
    // Returning early prevents a spurious empty message in the room.
    if (stanza.getChild('reactions')) return

    const nick = room.nickname
    const body = stanza.getChildText('body') ?? ''
    // A stanza without an id attribute must not echo an id-less message —
    // `RoomMessage.id` is a string invariant the UI relies on (row keys, dedup).
    const id = (stanza.attrs.id as string | undefined) || generateUUID()

    // Parse reply info from the stanza (XEP-0461)
    const replyEl = stanza.getChild('reply')
    const replyTo = replyEl
      ? { id: replyEl.attrs.id as string, to: replyEl.attrs.to as string | undefined }
      : undefined

    // Parse attachment from OOB element (XEP-0066)
    const oobEl = stanza.getChild('x')
    const fileEl = stanza.getChild('file')
    let attachment: RoomMessage['attachment'] | undefined
    if (oobEl?.getChildText('url')) {
      const thumbEl = oobEl.getChild('thumbnail')
      attachment = {
        url: oobEl.getChildText('url')!,
        ...(fileEl?.getChildText('media-type') && { mediaType: fileEl.getChildText('media-type')! }),
        ...(fileEl?.getChildText('name') && { name: fileEl.getChildText('name')! }),
        ...(fileEl?.getChildText('size') && { size: Number(fileEl.getChildText('size')) }),
        ...(fileEl?.getChildText('width') && { width: Number(fileEl.getChildText('width')) }),
        ...(fileEl?.getChildText('height') && { height: Number(fileEl.getChildText('height')) }),
        ...(thumbEl && {
          thumbnail: {
            uri: thumbEl.attrs.uri as string,
            mediaType: thumbEl.attrs['media-type'] as string,
            width: Number(thumbEl.attrs.width),
            height: Number(thumbEl.attrs.height),
          },
        }),
      }
    }

    // Strip reply fallback from body (everything before user's actual text)
    const fallbackEl = stanza.getChildren('fallback')?.find(
      (f: any) => f.attrs?.for?.includes('reply')
    )
    let processedBody = body
    if (fallbackEl) {
      const bodyRange = fallbackEl.getChild('body')
      if (bodyRange?.attrs?.end) {
        processedBody = body.slice(Number(bodyRange.attrs.end))
      }
    }
    // Also strip OOB fallback (URL appended at end)
    const oobFallbackEl = stanza.getChildren('fallback')?.find(
      (f: any) => f.attrs?.for?.includes('oob')
    )
    if (oobFallbackEl) {
      const bodyRange = oobFallbackEl.getChild('body')
      if (bodyRange?.attrs?.start) {
        processedBody = processedBody.slice(0, Number(bodyRange.attrs.start)).trimEnd()
      }
    }

    // Parse poll elements so creating/closing polls works in demo
    const pollEl = stanza.getChild('poll')
    const poll: PollData | null = pollEl ? parsePollElement(pollEl) : null

    const pollClosedEl = stanza.getChild('poll-closed')
    const pollClosed: PollClosedData | null = pollClosedEl ? parsePollClosedElement(pollClosedEl) : null

    const message: RoomMessage = {
      type: 'groupchat',
      id,
      originId: id,
      roomJid,
      from: `${roomJid}/${nick}`,
      nick,
      body: processedBody,
      timestamp: new Date(),
      isOutgoing: true,
      ...(replyTo && { replyTo }),
      ...(attachment && { attachment }),
      ...(poll && { poll }),
      ...(pollClosed && { pollClosed }),
    }

    this.emitSDK('room:message', { roomJid, message, incrementUnread: false })
  }

  // -------------------------------------------------------------------------
  // Private helpers — MUC join simulation
  // -------------------------------------------------------------------------

  /** Simulate a MUC server's self-presence response after receiving join presence. */
  private handleDemoJoinPresence(stanza: any): void {
    const to = stanza.attrs.to as string
    const slashIdx = to.indexOf('/')
    if (slashIdx === -1) return

    const roomJid = to.slice(0, slashIdx)
    const nick = to.slice(slashIdx + 1)

    // Emit join events asynchronously so MUC.startJoinTimeout() runs first,
    // then our events clear the pending join (same timing as a real server).
    queueMicrotask(() => {
      // Build self occupant
      const selfOccupant: RoomOccupant = {
        nick,
        jid: this.selfJid,
        affiliation: 'member',
        role: 'participant',
      }

      // If this is a seeded room being re-joined, check if we had a specific
      // self occupant (e.g. owner/admin)
      const seededOccupants = this.seededRoomOccupants.get(roomJid)
      if (seededOccupants) {
        const originalSelf = seededOccupants.find(o => o.jid === this.selfJid)
        if (originalSelf) {
          selfOccupant.affiliation = originalSelf.affiliation
          selfOccupant.role = originalSelf.role
        }
      }

      // Emit SDK events in the same order as the real MUC.handlePresence
      this.emitSDK('room:joined', { roomJid, joined: true })
      this.emitSDK('room:self-occupant', { roomJid, occupant: selfOccupant })

      // Settle the joinResult() deferred created by the real MUC.joinRoom():
      // we emit join events directly rather than routing a status-110
      // self-presence through muc.handle(), so the success path that normally
      // settles it never runs. Without this, awaiting joinResult() (e.g. in
      // JoinRoomModal) would hang forever in demo mode.
      this.muc.confirmSimulatedJoin(roomJid)

      // Populate occupants: restore seeded occupants or create minimal list
      const occupants = seededOccupants ?? [selfOccupant]
      this.emitSDK('room:occupants-batch', { roomJid, occupants })

      // Mark MAM as complete for this room
      const mamStates = new Map(roomStore.getState().mamQueryStates)
      mamStates.set(roomJid, {
        isLoading: false,
        error: null,
        hasQueried: true,
        isHistoryComplete: true,
        isCaughtUpToLive: true,
      })
      roomStore.setState({ mamQueryStates: mamStates })
    })
  }

  // -------------------------------------------------------------------------
  // Private helpers — mock IQ responses
  // -------------------------------------------------------------------------

  /** Build a mock Element-like object for IQ response routing. */
  private mockElement(
    name: string,
    attrs: Record<string, string>,
    children: MockElement[] = [],
    text?: string
  ): MockElement {
    return {
      name,
      attrs,
      _text: text,
      children,
      getChild: (childName: string, xmlns?: string) =>
        children.find(c => c.name === childName && (!xmlns || c.attrs.xmlns === xmlns)),
      getChildren: (childName: string) =>
        children.filter(c => c.name === childName),
      getChildText: (childName: string) => {
        const child = children.find(c => c.name === childName)
        return child?._text ?? null
      },
      getText: () => text ?? '',
      // ltx/@xmpp Element exposes text() as a method; parseDataForm and the
      // XEP-0092 version parser both call .text(), so mirror that shape.
      text: () => text ?? '',
      toString: () => `<${name}/>`,
    }
  }

  /** Return an empty stub IQ result (existing fallback behavior). */
  private buildEmptyStub(): MockElement {
    return this.mockElement('iq', { type: 'result' })
  }

  /**
   * Build a disco#info response for a known room.
   * Used by MUC.queryRoomFeatures() during joinRoom().
   */
  private buildDiscoInfoResponse(roomJid: string): MockElement {
    const known = this.knownRooms.get(roomJid)
    const roomName = known?.name ?? roomJid.split('@')[0]

    const queryChildren: MockElement[] = [
      // Identity
      this.mockElement('identity', { category: 'conference', type: 'text', name: roomName }),
      // Features — MAM, stable occupant ID (needed for reactions), MUC
      this.mockElement('feature', { var: 'urn:xmpp:mam:2' }),
      this.mockElement('feature', { var: 'http://jabber.org/protocol/muc#stable_id' }),
      this.mockElement('feature', { var: 'urn:xmpp:occupant-id:0' }),
      this.mockElement('feature', { var: NS_MUC }),
    ]

    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('query', { xmlns: NS_DISCO_INFO }, queryChildren),
    ])
  }

  /**
   * Build a disco#info response for the demo account bare JID.
   * Advertises PEP (XEP-0163) so account-capability probes — notably
   * the encryption settings' `checkPepSupport` — see the same answer a
   * full-featured server (ejabberd, Prosody) would give.
   */
  private buildAccountDiscoInfoResponse(): MockElement {
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('query', { xmlns: NS_DISCO_INFO }, [
        this.mockElement('identity', { category: 'account', type: 'registered' }),
        this.mockElement('identity', { category: 'pubsub', type: 'pep' }),
        this.mockElement('feature', { var: NS_PUBSUB }),
        this.mockElement('feature', { var: `${NS_PUBSUB}#publish-options` }),
      ]),
    ])
  }

  /**
   * Build a disco#items response listing all known rooms.
   * Used by Admin.fetchRoomList() during browsePublicRooms().
   */
  private buildDiscoItemsResponse(): MockElement {
    const items: MockElement[] = []
    for (const [jid, room] of this.knownRooms) {
      items.push(this.mockElement('item', { jid, name: room.name }))
    }

    const count = items.length.toString()
    const firstJid = items.length > 0 ? items[0].attrs.jid : ''
    const lastJid = items.length > 0 ? items[items.length - 1].attrs.jid : ''

    // RSM pagination response
    const rsmChildren: MockElement[] = [
      this.mockElement('count', {}, [], count),
      this.mockElement('first', { index: '0' }, [], firstJid),
      this.mockElement('last', {}, [], lastJid),
    ]
    const rsmSet = this.mockElement('set', { xmlns: NS_RSM }, rsmChildren)

    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('query', { xmlns: NS_DISCO_ITEMS }, [...items, rsmSet]),
    ])
  }

  /**
   * Build a vCard-temp response from seeded contact data.
   * Returns the contact's display name; for room occupant JIDs (with /)
   * derives the name from the nick portion.
   */
  private buildVCardResponse(to: string | undefined): MockElement {
    let displayName: string | undefined

    if (to) {
      // Room occupant JID: room@conf/nick → use nick as display name
      const slashIdx = to.indexOf('/')
      if (slashIdx !== -1) {
        displayName = to.slice(slashIdx + 1)
      } else {
        // Look up contact by bare JID
        const contact = this.seededContacts.get(to)
        displayName = contact?.name
      }
    }

    const vcardChildren: MockElement[] = []
    if (displayName) {
      vcardChildren.push(this.mockElement('FN', {}, [], displayName))
    }

    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('vCard', { xmlns: NS_VCARD_TEMP }, vcardChildren),
    ])
  }

  /**
   * Serve XEP-0490 MDS node requests from the in-memory node registry:
   * publish upserts an item (current-value semantics, one item per JID),
   * retract deletes it, items returns the full node contents in the shape
   * `parseMdsItems` expects. Returns undefined for non-MDS pubsub traffic.
   *
   * Works on both real ltx Elements (publish/retract are built with xml()
   * by the Mds module) and mock elements, by navigating `children` directly.
   */
  private handleMdsPubSubIQ(pubsubChild: any): MockElement | undefined {
    const childNamed = (parent: any, name: string) =>
      parent?.children?.find?.((c: any) => c?.name === name)

    const publish = childNamed(pubsubChild, 'publish')
    if (publish?.attrs?.node === NS_MDS) {
      const item = childNamed(publish, 'item')
      const stanzaIdEl = childNamed(childNamed(item, 'displayed'), 'stanza-id')
      const conversationJid = item?.attrs?.id
      const stanzaId = stanzaIdEl?.attrs?.id
      if (conversationJid && stanzaId) {
        this.mdsNodeItems.set(conversationJid, { stanzaId, by: stanzaIdEl?.attrs?.by ?? '' })
      }
      return this.buildEmptyStub()
    }

    const retract = childNamed(pubsubChild, 'retract')
    if (retract?.attrs?.node === NS_MDS) {
      const itemId = childNamed(retract, 'item')?.attrs?.id
      if (itemId) this.mdsNodeItems.delete(itemId)
      return this.buildEmptyStub()
    }

    const items = childNamed(pubsubChild, 'items')
    if (items?.attrs?.node === NS_MDS) {
      const itemEls = [...this.mdsNodeItems].map(([jid, { stanzaId, by }]) =>
        this.mockElement('item', { id: jid }, [
          this.mockElement('displayed', { xmlns: NS_MDS }, [
            this.mockElement('stanza-id', { xmlns: NS_STANZA_ID, id: stanzaId, ...(by ? { by } : {}) }),
          ]),
        ])
      )
      return this.mockElement('iq', { type: 'result' }, [
        this.mockElement('pubsub', { xmlns: NS_PUBSUB }, [
          this.mockElement('items', { node: NS_MDS }, itemEls),
        ]),
      ])
    }

    return undefined
  }

  /**
   * Build a PubSub items response. Returns an empty items node so callers
   * (avatar fetch, nickname fetch) gracefully fall back without errors.
   */
  private buildPubSubResponse(pubsubChild: any): MockElement {
    // Extract the requested node from the items child
    const itemsChild = pubsubChild?.children?.find?.(
      (c: any) => c.name === 'items'
    )
    const node = itemsChild?.attrs?.node as string | undefined

    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('pubsub', { xmlns: NS_PUBSUB }, [
        this.mockElement('items', { ...(node ? { node } : {}) }),
      ]),
    ])
  }

  /** Build an empty blocklist response (XEP-0191). */
  private buildBlocklistResponse(): MockElement {
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('blocklist', { xmlns: NS_BLOCKING }),
    ])
  }

  /**
   * Build a MAM response signaling an empty, complete archive.
   * Callers like catchUpAllConversations() will see "no more history".
   */
  private buildMAMResponse(): MockElement {
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('fin', { xmlns: NS_MAM, complete: 'true' }, [
        this.mockElement('set', { xmlns: NS_RSM }, [
          this.mockElement('count', {}, [], '0'),
        ]),
      ]),
    ])
  }

  /**
   * Build a MUC owner room config form response from seeded room data.
   * Returns a data form with common room configuration fields.
   */
  private buildRoomConfigResponse(roomJid: string | undefined): MockElement {
    const room = roomJid ? this.seededRooms.get(roomJid) : undefined
    const roomName = room?.name ?? roomJid?.split('@')[0] ?? ''

    // Build x:data form fields from room data
    const fields: MockElement[] = [
      this.buildFormField('FORM_TYPE', 'http://jabber.org/protocol/muc#roomconfig', 'hidden'),
      this.buildFormField('muc#roomconfig_roomname', roomName),
      this.buildFormField('muc#roomconfig_roomdesc', room?.subject ?? ''),
      this.buildFormField('muc#roomconfig_persistentroom', '1'),
      this.buildFormField('muc#roomconfig_publicroom', '1'),
      this.buildFormField('muc#roomconfig_membersonly', '0'),
    ]

    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('query', { xmlns: NS_MUC_OWNER }, [
        this.mockElement('x', { xmlns: NS_DATA_FORMS, type: 'form' }, fields),
      ]),
    ])
  }

  /** Build a data form field element for room config responses. */
  private buildFormField(varName: string, value: string, type?: string): MockElement {
    const attrs: Record<string, string> = { var: varName }
    if (type) attrs.type = type
    return this.mockElement('field', attrs, [
      this.mockElement('value', {}, [], value),
    ])
  }

  /**
   * Build a MUC admin affiliation list response from seeded occupant data.
   * Filters occupants by the requested affiliation.
   */
  private buildRoomAffiliationResponse(
    roomJid: string | undefined,
    queryChild: any
  ): MockElement {
    const items: MockElement[] = []

    if (roomJid) {
      // Extract requested affiliation from the query's <item affiliation="...">
      const requestedAffiliation = queryChild?.children?.find?.(
        (c: any) => c.name === 'item'
      )?.attrs?.affiliation as string | undefined

      const occupants = this.seededRoomOccupants.get(roomJid) ?? []
      for (const occupant of occupants) {
        if (requestedAffiliation && occupant.affiliation !== requestedAffiliation) continue
        if (!occupant.jid) continue
        items.push(this.mockElement('item', {
          jid: occupant.jid,
          affiliation: occupant.affiliation,
          ...(occupant.nick ? { nick: occupant.nick } : {}),
        }))
      }
    }

    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('query', { xmlns: NS_MUC_ADMIN }, items),
    ])
  }

  /** Build a generic ad-hoc command completed response (XEP-0050) fallback. */
  private buildCommandResponse(): MockElement {
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('command', {
        xmlns: NS_COMMANDS,
        status: 'completed',
      }, [
        this.mockElement('note', { type: 'info' }, [], 'Demo mode — command simulated'),
      ]),
    ])
  }

  // -------------------------------------------------------------------------
  // Private helpers — admin / server-overview seed data (dev-only)
  // -------------------------------------------------------------------------

  /** Build a XEP-0092 (jabber:iq:version) response for the demo server. */
  private buildVersionResponse(): MockElement {
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('query', { xmlns: NS_VERSION }, [
        this.mockElement('name', {}, [], 'ejabberd'),
        this.mockElement('version', {}, [], '26.01 (demo)'),
        this.mockElement('os', {}, [], 'Demo OS'),
      ]),
    ])
  }

  /**
   * Deterministic ~30-user directory for the friendly admin user list.
   * Includes the demo personas plus filler accounts, with a stable
   * online/offline split so the list, presence dots, and last-login column
   * all show a realistic spread without a server.
   */
  private demoAdminUsers(): { jid: string; online: boolean }[] {
    const domain = this.selfJid.split('@')[1] || 'fluux.chat'
    const names = [
      'you', 'emma', 'james', 'sophia', 'olivia', 'mia', 'liam', 'ava', 'alex',
      'noah', 'isabella', 'ethan', 'charlotte', 'lucas', 'amelia', 'mason', 'harper',
      'logan', 'evelyn', 'jackson', 'abigail', 'aiden', 'emily', 'elijah', 'elizabeth',
      'grayson', 'sofia', 'carter', 'avery', 'jack',
    ]
    // Stable split: roughly two thirds online (offline every third index).
    return names.map((n, i) => ({ jid: `${n}@${domain}`, online: i % 3 !== 0 }))
  }

  /**
   * Deterministic seconds-since-last-logout for a JID, spread across buckets
   * from minutes to ~1.4 years so the last-login column shows variety.
   */
  private demoLastActivitySeconds(jid: string): number {
    let hash = 0
    for (let i = 0; i < jid.length; i++) {
      hash = (hash * 31 + jid.charCodeAt(i)) >>> 0
    }
    const buckets = [90, 1800, 7200, 86400 * 2, 86400 * 9, 86400 * 40, 86400 * 200, 86400 * 500]
    return buckets[hash % buckets.length]
  }

  /**
   * Build a completed XEP-0133 command response whose result form carries a
   * single multi-value JID field (e.g. registereduserjids / onlineuserjids).
   * No RSM `<set>` is included, so the full-fetch loop terminates after one page.
   */
  private buildUserListResponse(jids: string[], fieldVar: string): MockElement {
    const valueChildren = jids.map((j) => this.mockElement('value', {}, [], j))
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('command', { xmlns: NS_COMMANDS, status: 'completed' }, [
        this.mockElement('x', { xmlns: NS_DATA_FORMS, type: 'result' }, [
          this.mockElement('field', { var: fieldVar }, valueChildren),
        ]),
      ]),
    ])
  }

  /** Build a XEP-0012 (jabber:iq:last) response with a deterministic interval. */
  private buildLastActivityResponse(jid?: string): MockElement {
    const seconds = jid ? this.demoLastActivitySeconds(jid) : 0
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('query', { xmlns: NS_LAST, seconds: String(seconds) }),
    ])
  }

  /**
   * Dispatch an ad-hoc / api command IQ to a seeded response so
   * fetchServerStats() can populate all six overview cards.
   *
   * Handles the two-step api-commands (stats, muc_online_rooms_count): the
   * first `execute` returns status="executing" with a form; the follow-up
   * `complete` returns the result form.
   */
  private buildAdminCommandResponse(commandChild: any): MockElement {
    const node = (commandChild?.attrs?.node as string | undefined) ?? ''
    const action = (commandChild?.attrs?.action as string | undefined) ?? 'execute'

    // --- XEP-0133 single-step stat commands ---
    if (node.endsWith('#get-registered-users-num')) {
      return this.buildStatFormResponse('registeredusersnum', String(this.demoAdminUsers().length))
    }
    if (node.endsWith('#get-online-users-num')) {
      const onlineCount = this.demoAdminUsers().filter((u) => u.online).length
      return this.buildStatFormResponse('onlineusersnum', String(onlineCount))
    }

    // --- XEP-0133 user-directory commands (drive the friendly user list) ---
    if (node.endsWith('#get-registered-users-list')) {
      return this.buildUserListResponse(
        this.demoAdminUsers().map((u) => u.jid),
        'registereduserjids'
      )
    }
    if (node.endsWith('#get-online-users-list')) {
      return this.buildUserListResponse(
        this.demoAdminUsers().filter((u) => u.online).map((u) => u.jid),
        'onlineuserjids'
      )
    }

    // get-user-lastlogin: execute → form requiring accountjid; complete →
    // a raw, server-formatted string (mirrors real ejabberd traffic: "Online"
    // for an online user, a "YYYY-MM-DD HH:MM:SS" timestamp otherwise).
    if (node.endsWith('#get-user-lastlogin')) {
      if (action === 'execute') {
        return this.buildExecutingFormResponse(node, 'lastlogin-sess', 'accountjid')
      }
      const accountjid = this.extractSubmittedFieldValue(commandChild, 'accountjid')
      const user = accountjid ? this.demoAdminUsers().find((u) => u.jid === accountjid) : undefined
      if (user?.online) {
        return this.buildStatFormResponse('lastlogin', 'Online')
      }
      const seconds = accountjid ? this.demoLastActivitySeconds(accountjid) : 86400
      return this.buildStatFormResponse('lastlogin', this.formatDemoTimestamp(Date.now() - seconds * 1000))
    }

    // --- ejabberd two-step api-commands ---
    // muc_online_rooms_count: execute → form requiring `service`; complete → count.
    if (node === 'api-commands/muc_online_rooms_count') {
      if (action === 'execute') {
        return this.buildExecutingFormResponse(node, 'muc-rooms-sess', 'service')
      }
      return this.buildStatFormResponse('count', '5')
    }
    // stats: execute → form requiring `name`; complete → numeric stat value.
    if (node === 'api-commands/stats') {
      if (action === 'execute') {
        return this.buildExecutingFormResponse(node, 'stats-sess', 'name')
      }
      // 259200 seconds = 3 days uptime
      return this.buildStatFormResponse('stat', '259200')
    }

    // Anything else: generic "command simulated" completed note.
    return this.buildCommandResponse()
  }

  /**
   * Build a completed command response carrying a single result field
   * (`<field var=...><value>...</value></field>`) inside a result form.
   */
  private buildStatFormResponse(fieldVar: string, value: string): MockElement {
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('command', { xmlns: NS_COMMANDS, status: 'completed' }, [
        this.mockElement('x', { xmlns: NS_DATA_FORMS, type: 'result' }, [
          this.buildFormField(fieldVar, value),
        ]),
      ]),
    ])
  }

  /**
   * Build an executing (multi-step) command response with a form that
   * requires a single field, so executeApiCommand() submits the override
   * value and then issues the `complete` step.
   */
  /** Read a submitted field's value from a two-step command's `complete` request. */
  private extractSubmittedFieldValue(commandChild: any, fieldVar: string): string | undefined {
    const submittedForm = commandChild?.getChild?.('x', NS_DATA_FORMS)
    const field = submittedForm
      ?.getChildren?.('field')
      ?.find((f: any) => f?.attrs?.var === fieldVar)
    return field?.getChild?.('value')?.text?.()
  }

  /** Format an epoch ms as `YYYY-MM-DD HH:MM:SS` (the raw shape ejabberd's get-user-lastlogin returns). */
  private formatDemoTimestamp(epochMs: number): string {
    const d = new Date(epochMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  private buildExecutingFormResponse(
    node: string,
    sessionId: string,
    fieldVar: string
  ): MockElement {
    return this.mockElement('iq', { type: 'result' }, [
      this.mockElement('command', {
        xmlns: NS_COMMANDS,
        node,
        status: 'executing',
        sessionid: sessionId,
      }, [
        this.mockElement('actions', { execute: 'complete' }, [
          this.mockElement('complete', {}),
        ]),
        this.mockElement('x', { xmlns: NS_DATA_FORMS, type: 'form' }, [
          this.buildFormField(fieldVar, ''),
        ]),
      ]),
    ])
  }
}
