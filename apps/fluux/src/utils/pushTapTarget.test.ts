import { describe, it, expect } from 'vitest'
import { pushTapTarget } from './pushTapTarget'

const noRooms = () => false

describe('pushTapTarget', () => {
  it('opens the conversation with the sender of a pushgate payload', () => {
    const payload = {
      aps: { alert: 'Hello', 'mutable-content': 1, 'thread-id': 'mrtest' },
      from: 'mrtest@process-one.net',
    }

    expect(pushTapTarget(payload, noRooms)).toEqual({
      navType: 'conversation',
      navTarget: 'mrtest@process-one.net',
    })
  })

  it('opens the room when the sender is a joined room, dropping the nickname', () => {
    const isRoom = (jid: string) => jid === 'team@conference.example.com'

    expect(pushTapTarget({ from: 'team@conference.example.com/alice' }, isRoom)).toEqual({
      navType: 'room',
      navTarget: 'team@conference.example.com',
    })
  })

  it('opens nothing without a usable sender', () => {
    expect(pushTapTarget(null, noRooms)).toBeNull()
    expect(pushTapTarget({ aps: { alert: 'New message' } }, noRooms)).toBeNull()
    expect(pushTapTarget({ from: 'process-one.net' }, noRooms)).toBeNull()
  })
})
