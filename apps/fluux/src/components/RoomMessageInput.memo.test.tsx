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

// RoomMessageInput now builds a slash-command context (useRoomCommandContext ->
// useRoomActions/useRoomModeration/useRoomManagement). Those hooks reach
// useXMPPContext via a relative import inside the SDK package, so mocking the
// @fluux/sdk barrel's useXMPPContext export does not intercept it -- stub the
// three composed hooks directly instead (same pattern as RoomView.test.tsx).
// Keep everything else from the real SDK (the global test-setup mock already
// spreads the actual module).
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useRoomActions: () => ({
      joinRoom: vi.fn(),
      joinResult: vi.fn(),
      leaveRoom: vi.fn(),
    }),
    useRoomModeration: () => ({
      setRole: vi.fn(),
      setAffiliation: vi.fn(),
    }),
    useRoomManagement: () => ({
      setSubject: vi.fn(),
      inviteToRoom: vi.fn(),
    }),
  }
})

import { RoomMessageInput } from './RoomView'

// Stable props defined once so only the parent's own state changes between renders.
const STABLE: ComponentProps<typeof RoomMessageInput> = {
  roomJid: 'room@conf.example.com',
  sendMessage: vi.fn(), sendCorrection: vi.fn(), retractMessage: vi.fn(),
  sendChatState: vi.fn(), sendWhisperChatState: vi.fn(), sendEasterEgg: vi.fn(), sendPoll: vi.fn(),
  replyingTo: null, onCancelReply: vi.fn(), editingMessage: null, onCancelEdit: vi.fn(),
  isConnected: true, sendWhisper: vi.fn(), whisperTarget: null,
}

function Harness() {
  const [, setTick] = useState(0)
  return (
    <>
      <button type="button" onClick={() => setTick((t) => t + 1)}>tick</button>
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
