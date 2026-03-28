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
import { activityLogStore } from '../stores/activityLogStore'
import type { ActivityEventInput } from '../core/types/activity'
import type { Contact } from '../core/types/roster'
import type { Room, RoomMessage, RoomOccupant } from '../core/types/room'
import type { DemoData, DemoAnimationStep } from './types'
import { parsePollElement, parsePollClosedElement } from '../core/poll'
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

/** Minimal Element-like object returned by mock IQ responses. */
interface MockElement {
  name: string
  attrs: Record<string, string>
  text?: string
  children: MockElement[]
  getChild: (name: string, xmlns?: string) => MockElement | undefined
  getChildren: (name: string) => MockElement[]
  getChildText: (name: string) => string | null
  getText: () => string
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

    // disco#items to the conference service → return room list for fetchRoomList()
    if (xmlns === NS_DISCO_ITEMS && to === this.conferenceService) {
      return this.buildDiscoItemsResponse()
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
      return this.buildCommandResponse()
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
        this.emitSDK('chat:message', { message })
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
        this.emitSDK('room:message', { roomJid: room.jid, message })
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

    // Activity log: seed with demo events (direct store access since
    // ActivityLogHook may not be registered yet at this point)
    for (const event of data.activityEvents) {
      activityLogStore.getState().addEvent(event)
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
      case 'activity-event':
        activityLogStore.getState().addEvent(step.data as ActivityEventInput)
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
    const id = stanza.attrs.id as string

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
      text,
      children,
      getChild: (childName: string, xmlns?: string) =>
        children.find(c => c.name === childName && (!xmlns || c.attrs.xmlns === xmlns)),
      getChildren: (childName: string) =>
        children.filter(c => c.name === childName),
      getChildText: (childName: string) => {
        const child = children.find(c => c.name === childName)
        return child?.text ?? null
      },
      getText: () => text ?? '',
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

  /** Build an ad-hoc command completed response (XEP-0050). */
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
}
