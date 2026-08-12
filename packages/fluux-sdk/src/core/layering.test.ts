import { describe, it, expect } from 'vitest'
import { importCycles } from '../importGraph.testHelpers'

/**
 * The SDK core is layered, and stays layered.
 *
 * It used to be one strongly connected component of 64 modules: XMPPClient,
 * every protocol module, every store and every side effect could only be read,
 * typechecked or replaced together. Nothing in the code said so, so it grew
 * that way one convenient import at a time.
 *
 * What is left is listed below. Two modules that genuinely describe each other
 * are a cycle a reader can hold in their head; anything wider is the old shape
 * coming back, and it always arrives as a single innocuous import — a barrel
 * that re-exports the client, a contract typed as its own implementation, a
 * helper that names the object it is called from.
 *
 * Adding an entry here is a decision, not a formality: say why the two modules
 * cannot be split, in the entry itself.
 */
const KNOWN_CYCLES = [
  // A message's base shape and the chat message that extends it. Splitting
  // these would mean a third module naming both halves of one type.
  ['core/types/chat.ts', 'core/types/message-base.ts'],
  // The room store and its selectors: the selectors read the store's state
  // type, the store reuses their derivations to keep results referentially
  // stable for React.
  ['stores/roomSelectors.ts', 'stores/roomStore.ts'],
]

describe('core layering', () => {
  const cycles = importCycles()

  it('has no import cycle beyond the documented pairs', () => {
    expect(cycles).toEqual(KNOWN_CYCLES.map(cycle => [...cycle].sort()))
  })

  it('holds every cycle to two modules', () => {
    expect(cycles.map(cycle => cycle.length)).toEqual(cycles.map(() => 2))
  })
})
