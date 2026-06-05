import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState, type ComponentProps } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

// Count MessageComposer renders via a spy module mock.
const composerRenders = { count: 0 }
vi.mock('./MessageComposer', () => ({
  MessageComposer: () => { composerRenders.count++; return <div data-testid="composer" /> },
  MESSAGE_INPUT_BASE_CLASSES: '',
  MESSAGE_INPUT_OVERLAY_CLASSES: '',
}))

import { RoomMessageInput } from './RoomView'

// Stable props defined once so only the parent's own state changes between renders.
const STABLE: ComponentProps<typeof RoomMessageInput> = {
  roomJid: 'room@conf.example.com',
  sendMessage: vi.fn(), sendCorrection: vi.fn(), retractMessage: vi.fn(),
  sendChatState: vi.fn(), sendEasterEgg: vi.fn(), sendPoll: vi.fn(),
  replyingTo: null, onCancelReply: vi.fn(), editingMessage: null, onCancelEdit: vi.fn(),
  isConnected: true, sendWhisper: vi.fn(), whisperTarget: null,
}

function Harness() {
  const [, setTick] = useState(0)
  return (
    <>
      <button onClick={() => setTick((t) => t + 1)}>tick</button>
      <RoomMessageInput {...STABLE} />
    </>
  )
}

describe('RoomMessageInput memoization', () => {
  beforeEach(() => { composerRenders.count = 0 })

  it('does not re-render MessageComposer when the parent re-renders with identical props', () => {
    render(<Harness />)
    const afterMount = composerRenders.count
    fireEvent.click(screen.getByText('tick'))
    fireEvent.click(screen.getByText('tick'))
    expect(composerRenders.count).toBe(afterMount) // memo bailout
  })
})
