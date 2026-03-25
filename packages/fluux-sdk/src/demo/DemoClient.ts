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
 *
 * const client = new DemoClient()
 * client.populateDemo()
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
import {
  DEMO_CONTACTS,
  DEMO_PRESENCES,
  SELF,
  getDemoConversations,
  getDemoMessages,
  getDemoRooms,
  getDemoAnimation,
  getDemoActivityEvents,
} from './demoData'

/**
 * A demo XMPPClient that populates stores with realistic data.
 *
 * Call {@link populateDemo} after construction to seed all stores.
 * Optionally call {@link startAnimation} to schedule live events
 * (typing indicators, incoming messages) on timers.
 */
export class DemoClient extends XMPPClient {
  private animationTimers: ReturnType<typeof setTimeout>[] = []

  // No-op stanza sending — no real XMPP connection exists.
  // Modules call sendStanza/sendIQ via the deps closure, which dispatches
  // to these overrides. This allows chat.sendMessage() etc. to work:
  // the stanza is silently dropped but the SDK events still fire.
  protected override async sendStanza(): Promise<void> {}
  protected override async sendIQ(): Promise<any> {
    return null as any
  }

  /**
   * Synchronously populate all stores with demo data.
   *
   * Must be called after construction and before React renders
   * so the UI sees the populated state on first paint.
   */
  populateDemo(): void {
    // Set the current JID so modules (e.g., chat.sendMessage) can read it
    this.currentJid = SELF.jid

    // Connection store is updated directly (not via SDK events)
    // because Connection.ts handles these outside of store bindings.
    connectionStore.getState().setStatus('online')
    connectionStore.getState().setJid(SELF.jid)
    connectionStore.getState().setOwnAvatar('./demo/avatar-self.webp')

    // Roster: load contacts then set presence per-resource
    this.emitSDK('roster:loaded', { contacts: DEMO_CONTACTS })
    for (const presence of DEMO_PRESENCES) {
      this.emitSDK('roster:presence', presence)
    }

    // Conversations: create each, then add messages
    const conversations = getDemoConversations()
    for (const conversation of conversations) {
      this.emitSDK('chat:conversation', { conversation })
    }

    const allMessages = getDemoMessages()
    for (const [, messages] of allMessages) {
      for (const message of messages) {
        this.emitSDK('chat:message', { message })
      }
    }

    // Rooms: add, mark joined, populate occupants and messages
    const rooms = getDemoRooms()
    for (const { room, occupants, messages } of rooms) {
      this.emitSDK('room:added', { room })
      this.emitSDK('room:joined', { roomJid: room.jid, joined: true })

      const selfOccupant = occupants.find(o => o.jid === SELF.jid)
      if (selfOccupant) {
        this.emitSDK('room:self-occupant', { roomJid: room.jid, occupant: selfOccupant })
      }
      this.emitSDK('room:occupants-batch', { roomJid: room.jid, occupants })

      for (const message of messages) {
        this.emitSDK('room:message', { roomJid: room.jid, message })
      }
    }

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
    for (const conv of conversations) {
      chatMAM.set(conv.id, completedState)
    }
    chatStore.setState({ mamQueryStates: chatMAM })

    const roomMAM = new Map<string, typeof completedState>()
    for (const { room } of rooms) {
      roomMAM.set(room.jid, completedState)
    }
    roomStore.setState({ mamQueryStates: roomMAM })

    // Activity log: seed with demo events (direct store access since
    // ActivityLogHook may not be registered yet at this point)
    for (const event of getDemoActivityEvents()) {
      activityLogStore.getState().addEvent(event)
    }
  }

  /**
   * Start animated demo sequence — scheduled events that make the
   * UI feel alive. Call after {@link populateDemo}.
   *
   * @returns A cleanup function that cancels all pending timers.
   */
  startAnimation(): () => void {
    const steps = getDemoAnimation()

    for (const step of steps) {
      const timer = setTimeout(() => {
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
            this.emitSDK('room:reactions', step.data as Parameters<typeof this.emitSDK<'room:reactions'>>[1])
            break
          case 'presence':
            this.emitSDK('roster:presence', step.data as Parameters<typeof this.emitSDK<'roster:presence'>>[1])
            break
        }
      }, step.delayMs)
      this.animationTimers.push(timer)
    }

    return () => this.stopAnimation()
  }

  /** Cancel all pending animation timers. */
  stopAnimation(): void {
    for (const timer of this.animationTimers) {
      clearTimeout(timer)
    }
    this.animationTimers = []
  }

  override destroy(): void {
    this.stopAnimation()
    super.destroy()
  }
}
