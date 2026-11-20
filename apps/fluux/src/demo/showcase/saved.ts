/**
 * Saved messages of the showcase scene. They are seeded through the same path
 * as a person's save (build the entry from the message, put it in the saved
 * store), so the list, the highlighted original and the Saved icon behave as
 * they do after a real save. The default demo keeps an empty list: e2e/saved-messages.ts
 * depends on it.
 *
 * Every pick shows its own text in the list: no deleted, encrypted-placeholder or
 * unverified rows.
 */

import { buildSavedMessage, savedStore, type Message, type RoomMessage } from '@fluux/sdk'
import type { DemoData } from '@fluux/sdk/demo'
import { SELF_JID } from '../constants'

/** Message ids to save, newest save first. */
const SAVED_IDS = [
  'showcase-emma-1',
  'showcase-ava-4',
  'showcase-liam-3',
  'showcase-launch-3',
  'showcase-design-1',
]

/** Save the curated messages of the showcase data; call once after the demo data is seeded. */
export function seedShowcaseSaved(data: DemoData): void {
  const pool: (Message | RoomMessage)[] = [
    ...[...data.messages.values()].flat(),
    ...data.rooms.flatMap((entry) => entry.messages),
  ]
  const now = Date.now()
  // The list shows the newest save first, so earlier ids get later save times.
  SAVED_IDS.forEach((id, index) => {
    const message = pool.find((candidate) => candidate.id === id)
    if (!message) throw new Error(`Showcase saved message not found: ${id}`)
    savedStore.getState().save(buildSavedMessage(message, SELF_JID, now - (index + 1) * 60_000))
  })
}
