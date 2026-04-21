/**
 * Reusable helpers for multi-step network scenario tests.
 *
 * Builds on top of sideEffects.testHelpers to provide higher-level
 * abstractions for simulating connect → disconnect → reconnect journeys
 * and asserting state consistency across those transitions.
 */
import { vi } from 'vitest'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { setupRoomSideEffects } from './roomSideEffects'
import { setupChatSideEffects } from './chatSideEffects'
import { setupBackgroundSyncSideEffects } from './backgroundSync'
import {
  createMockClient,
  simulateFreshSession as baseFreshSession,
  simulateSmResumption as baseSmResumption,
} from './sideEffects.testHelpers'
import type { Room } from './types'

// Re-export base helpers for convenience
export { localStorageMock } from './sideEffects.testHelpers'

/** Minimal room config — sensible defaults for all other fields */
export interface TestRoomConfig {
  jid: string
  name?: string
  nickname?: string
  joined?: boolean
  isJoining?: boolean
  supportsMAM?: boolean
  isBookmarked?: boolean
  isQuickChat?: boolean
}

/** Snapshot of a single room's state for assertions */
export interface RoomStateSnapshot {
  joined: boolean
  isJoining: boolean
  supportsMAM: boolean
}

export type ScenarioMockClient = ReturnType<typeof createMockClient>

/**
 * Build a full Room object from minimal config with sensible defaults.
 */
export function makeRoom(config: TestRoomConfig): Room {
  return {
    jid: config.jid,
    name: config.name ?? config.jid.split('@')[0],
    nickname: config.nickname ?? 'testuser',
    joined: config.joined ?? false,
    isJoining: config.isJoining ?? false,
    supportsMAM: config.supportsMAM ?? true,
    supportsReactions: true,
    isBookmarked: config.isBookmarked ?? true,
    isQuickChat: config.isQuickChat ?? false,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

/**
 * Add multiple rooms to roomStore and optionally set one as active.
 */
export function seedRooms(rooms: TestRoomConfig[], activeJid?: string): void {
  for (const config of rooms) {
    roomStore.getState().addRoom(makeRoom(config))
  }
  if (activeJid) {
    roomStore.getState().setActiveRoom(activeJid)
  }
}

/**
 * Simulate a disconnect by setting connectionStore status to 'reconnecting'.
 * Optionally clears mock call history on the client's MAM methods.
 */
export function simulateDisconnect(
  client: ScenarioMockClient,
  options?: { clearMocks?: boolean }
): void {
  connectionStore.getState().setStatus('reconnecting')
  if (options?.clearMocks) {
    vi.mocked(client.chat.queryMAM).mockClear()
    vi.mocked(client.chat.queryRoomMAM).mockClear()
  }
}

/**
 * Simulate the full SM resumption flow as XMPPClient.handleSmResumption does:
 * 1. Emit 'resumed' event (side effects mark fetchInitiated)
 * 2. Leave room state intact — SM preserves MUC membership server-side; the
 *    client trusts its existing in-memory (or hydrated-from-storage) state.
 *
 * @param roomJids - rooms that were previously joined (unchanged by resumption)
 */
export async function simulateSmResumptionWithRejoin(
  client: ScenarioMockClient,
  _roomJids: string[]
): Promise<void> {
  baseSmResumption(client)
  await settle()
}

/**
 * Simulate the full fresh session flow:
 * 1. Emit 'online' event (side effects clear fetchInitiated, trigger MAM)
 * 2. markAllRoomsNotJoined()
 * 3. Re-join specified rooms
 */
export async function simulateFreshSessionWithRejoin(
  client: ScenarioMockClient,
  roomJids: string[]
): Promise<void> {
  baseFreshSession(client)
  await settle()

  roomStore.getState().markAllRoomsNotJoined()

  for (const jid of roomJids) {
    roomStore.getState().setRoomJoined(jid, true)
    client._emitSDK('room:joined', { roomJid: jid, joined: true })
  }
  await settle()
}

/**
 * Take a snapshot of room states for assertion.
 */
export function snapshotRoomStates(roomJids: string[]): Map<string, RoomStateSnapshot> {
  const result = new Map<string, RoomStateSnapshot>()
  const rooms = roomStore.getState().rooms
  for (const jid of roomJids) {
    const room = rooms.get(jid)
    if (room) {
      result.set(jid, {
        joined: room.joined,
        isJoining: room.isJoining ?? false,
        supportsMAM: room.supportsMAM ?? false,
      })
    }
  }
  return result
}

/**
 * Wait for async side effects to settle.
 */
export function settle(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Set up all side effects (room + chat + background sync) and return cleanup.
 */
export function setupAllSideEffects(client: ScenarioMockClient): () => void {
  const c1 = setupRoomSideEffects(client)
  const c2 = setupChatSideEffects(client)
  const c3 = setupBackgroundSyncSideEffects(client)
  return () => { c1(); c2(); c3() }
}

/**
 * Create a mock client — delegates to createMockClient from base helpers.
 */
export { createMockClient } from './sideEffects.testHelpers'
