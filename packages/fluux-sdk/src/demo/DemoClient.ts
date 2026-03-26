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
import type { RoomMessage, RoomOccupant } from '../core/types/room'
import type { DemoData, DemoAnimationStep } from './types'

type AnimationState = 'idle' | 'playing' | 'paused' | 'stopped'

// XMPP namespace constants used for IQ routing
const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
const NS_DISCO_ITEMS = 'http://jabber.org/protocol/disco#items'
const NS_RSM = 'http://jabber.org/protocol/rsm'
const NS_MUC = 'http://jabber.org/protocol/muc'

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

  // Room registry for simulating IQ responses
  private conferenceService = ''
  private selfJid = ''
  private knownRooms = new Map<string, KnownRoom>()
  private seededRoomOccupants = new Map<string, RoomOccupant[]>()

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
    // Inspect the query child to route demo IQ responses
    const queryChild = stanza?.children?.find?.(
      (c: any) => c.name === 'query'
    )
    const xmlns = queryChild?.attrs?.xmlns as string | undefined
    const to = stanza?.attrs?.to as string | undefined

    // disco#info to a known room → return room features for queryRoomFeatures()
    if (xmlns === NS_DISCO_INFO && to && this.knownRooms.has(to)) {
      return this.buildDiscoInfoResponse(to)
    }

    // disco#items to the conference service → return room list for fetchRoomList()
    if (xmlns === NS_DISCO_ITEMS && to === this.conferenceService) {
      return this.buildDiscoItemsResponse()
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
}
