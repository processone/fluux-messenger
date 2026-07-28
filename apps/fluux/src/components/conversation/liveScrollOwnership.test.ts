import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const chatViewSource = readFileSync(
  resolve(process.cwd(), 'src/components/ChatView.tsx'),
  'utf8',
)
const roomViewSource = readFileSync(
  resolve(process.cwd(), 'src/components/RoomView.tsx'),
  'utf8',
)

const directMessageListWrite =
  /\bscrollRef\.current\.(?:scrollTo\s*\(|scrollTop\s*=)/

describe('live message-list scroll ownership', () => {
  it('keeps ChatView and RoomView from writing the live message-list position directly', () => {
    expect(chatViewSource).not.toMatch(directMessageListWrite)
    expect(roomViewSource).not.toMatch(directMessageListWrite)
  })

  it('does not restore post-send or composer-resize callback escape hatches', () => {
    expect(chatViewSource).not.toMatch(/\bonMessageSent\b/)
    expect(chatViewSource).not.toMatch(/\bonInputResize\b/)
    expect(roomViewSource).not.toMatch(/\bonMessageSent\b/)
    expect(roomViewSource).not.toMatch(/\bonInputResize\b/)
  })

  it('routes room media through the callback supplied by MessageList', () => {
    const renderStart = roomViewSource.indexOf('const renderMessage =')
    const listStart = roomViewSource.indexOf('return (\n    <MessageList', renderStart)
    expect(renderStart).toBeGreaterThan(-1)
    expect(listStart).toBeGreaterThan(renderStart)
    const renderMessageSource = roomViewSource.slice(renderStart, listStart)

    expect(renderMessageSource).toContain('onMediaLoad: () => void')
    expect(renderMessageSource).toContain('onMediaLoad={onMediaLoad}')
  })

  it('would fail against both former direct-write shapes', () => {
    expect(directMessageListWrite.test(
      'scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight })',
    )).toBe(true)
    expect(directMessageListWrite.test(
      'scrollRef.current.scrollTop = scrollRef.current.scrollHeight',
    )).toBe(true)
  })
})
