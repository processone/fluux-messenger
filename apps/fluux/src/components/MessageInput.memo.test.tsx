import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState, type ComponentProps } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

// Count MessageComposer renders via a spy module mock.
const composerRenders = { count: 0 }
vi.mock('./MessageComposer', () => ({
  MessageComposer: () => { composerRenders.count++; return <div data-testid="composer" /> },
  MESSAGE_INPUT_BASE_CLASSES: '',
  MESSAGE_INPUT_TEXT_CLASSES: '',
  MESSAGE_INPUT_OVERLAY_CLASSES: '',
}))

import { MessageInput } from './ChatView'

// Stable props defined once so only the parent's own state changes between renders.
// This proves MessageInput stays decoupled from ChatView's per-message re-renders:
// the 1:1 composer used to re-render once per incoming message (RenderLoopDetector
// warning) because ChatView fed it fresh closures every render.
const STABLE: ComponentProps<typeof MessageInput> = {
  composerRef: { current: null },
  conversationId: 'alice@example.com',
  conversationName: 'Alice',
  type: 'chat',
  onMessageSent: vi.fn(),
  onMessageIdSent: vi.fn(),
  onInputResize: vi.fn(),
  replyingTo: null,
  onCancelReply: vi.fn(),
  editingMessage: null,
  onCancelEdit: vi.fn(),
  onEditLastMessage: vi.fn(),
  sendMessage: vi.fn(async () => 'id'),
  sendCorrection: vi.fn(async () => {}),
  retractMessage: vi.fn(async () => {}),
  sendChatState: vi.fn(async () => {}),
  isArchived: vi.fn(() => false),
  unarchiveConversation: vi.fn(),
  setDraft: vi.fn(),
  getDraft: vi.fn(() => ''),
  clearDraft: vi.fn(),
  clearFirstNewMessageId: vi.fn(),
  contactsByJid: new Map(),
  onComposingChange: vi.fn(),
  sendEasterEgg: vi.fn(async () => {}),
  isConnected: true,
  uploadState: { isUploading: false, progress: 0, error: null, clearError: vi.fn() },
  isUploadSupported: false,
  onFileSelect: vi.fn(),
  uploadFile: vi.fn(async () => null),
  pendingAttachment: null,
  onRemovePendingAttachment: vi.fn(),
  processLinkPreview: vi.fn(async () => {}),
  onSwitchToMessages: vi.fn(),
  encryptionState: { kind: 'disabled' } as ComponentProps<typeof MessageInput>['encryptionState'],
}

function Harness() {
  const [, setTick] = useState(0)
  return (
    <>
      <button type="button" onClick={() => setTick((t) => t + 1)}>tick</button>
      <MessageInput {...STABLE} />
    </>
  )
}

describe('MessageInput memoization (1:1 composer decoupling)', () => {
  beforeEach(() => { composerRenders.count = 0 })

  it('does not re-render MessageComposer when the parent re-renders with identical props', () => {
    render(<Harness />)
    const afterMount = composerRenders.count
    fireEvent.click(screen.getByText('tick'))
    fireEvent.click(screen.getByText('tick'))
    expect(composerRenders.count).toBe(afterMount) // memo bailout — composer decoupled
  })
})
