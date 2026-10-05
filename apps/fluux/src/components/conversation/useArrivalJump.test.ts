import { describe, it, expect } from 'vitest'
import { arrivalTargetRowId } from './useArrivalJump'
import { messageRowId } from './messageRowIdentity'

const message = (id: string, isOutgoing = false) => ({ id, type: 'chat' as const, isOutgoing })
const messages = [message('a'), message('b'), message('mine', true), message('c')]

describe('arrivalTargetRowId', () => {
  it('lands on the divider when there is one', () => {
    expect(arrivalTargetRowId(messages, 'divider-row', { id: 'a' })).toBe('divider-row')
  })

  it('lands on the first incoming message after the read pointer', () => {
    expect(arrivalTargetRowId(messages, undefined, { id: 'b' })).toBe(messageRowId(message('c')))
  })

  it('has no target while nothing arrived after the pointer, or without a pointer', () => {
    expect(arrivalTargetRowId(messages, undefined, { id: 'c' })).toBeUndefined()
    expect(arrivalTargetRowId(messages, undefined, null)).toBeUndefined()
    expect(arrivalTargetRowId(messages, undefined, { id: 'unknown' })).toBeUndefined()
  })
})
