import { expect } from 'vitest'
import type { ScrollWrite, ScrollWriteOwner } from './messageVirtualizer'

/** The receipt a virtualizer test double returns when the test does not read it. */
export const appliedWrite = (offset = 0): ScrollWrite => ({
  id: 0,
  outcome: () => ({ status: 'applied', offset }),
})

/** An owner for a lease double: current until the test says its request was superseded. */
export const currentOwner = (conversationId = 'conv', generation = 1): ScrollWriteOwner => ({
  conversationId,
  generation,
  isCurrent: () => true,
})

/** Matches the owner an adapter passes with a write: the lease's, whatever the test named it. */
export const anOwner = () =>
  expect.objectContaining({ conversationId: expect.any(String), isCurrent: expect.any(Function) })
