import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PollBanner } from './PollBanner'
import type { RoomMessage } from '@fluux/sdk'

// Mock scrollToMessage
vi.mock('./messageGrouping', () => ({
  scrollToMessage: vi.fn(),
}))

import { scrollToMessage } from './messageGrouping'

function makePollMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: 'poll-1',
    type: 'groupchat',
    from: 'room@conf/alice',
    roomJid: 'room@conf',
    nick: 'alice',
    body: '',
    timestamp: new Date(),
    isOutgoing: false,
    isDelayed: false,
    poll: {
      title: 'What for lunch?',
      options: [
        { emoji: '1️⃣', label: 'Pizza' },
        { emoji: '2️⃣', label: 'Sushi' },
      ],
      settings: { allowMultiple: false, hideResultsBeforeVote: false },
    },
    reactions: {},
    ...overrides,
  } as RoomMessage
}

const emptySet = new Set<string>()

describe('PollBanner', () => {
  it('should render nothing when there are no polls', () => {
    const { container } = render(
      <PollBanner
        messages={[]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should render nothing when user has already voted (reactions)', () => {
    const msg = makePollMessage({
      reactions: { '1️⃣': ['bob'] },
    })

    const { container } = render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should render nothing when user has voted (persisted votedPollIds)', () => {
    const msg = makePollMessage()

    const { container } = render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={new Set(['poll-1'])}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should render banner for unanswered poll', () => {
    const msg = makePollMessage()

    render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText(/What for lunch/)).toBeInTheDocument()
  })

  it('should not render dismissed polls', () => {
    const msg = makePollMessage()

    const { container } = render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={new Set(['poll-1'])}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should not render expired polls', () => {
    const msg = makePollMessage({
      poll: {
        title: 'Old poll',
        options: [
          { emoji: '1️⃣', label: 'A' },
          { emoji: '2️⃣', label: 'B' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
        deadline: '2020-01-01T00:00:00.000Z', // past
      },
    })

    const { container } = render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should scroll to the most recent poll on click', () => {
    const msg1 = makePollMessage({ id: 'poll-1' })
    const msg2 = makePollMessage({ id: 'poll-2', poll: { ...msg1.poll!, title: 'Second poll' } })

    render(
      <PollBanner
        messages={[msg1, msg2]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )

    // Should show multiple count
    expect(screen.getByText(/2 unanswered polls/)).toBeInTheDocument()

    // Click scrolls to most recent (poll-2)
    fireEvent.click(screen.getByText(/2 unanswered polls/))
    expect(scrollToMessage).toHaveBeenCalledWith('poll-2')
  })

  it('should call onDismiss when dismiss button is clicked', () => {
    const msg = makePollMessage()
    const onDismiss = vi.fn()

    render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={onDismiss}
      />
    )

    const dismissBtn = screen.getByLabelText('Dismiss')
    fireEvent.click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledWith('poll-1')
  })

  it('should render nothing when myNick is undefined', () => {
    const msg = makePollMessage()

    const { container } = render(
      <PollBanner
        messages={[msg]}
        myNick={undefined}
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should not render retracted (deleted) polls', () => {
    const msg = makePollMessage({ isRetracted: true })

    const { container } = render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should not render closed polls', () => {
    const pollMsg = makePollMessage({ id: 'poll-1' })
    // A separate message that closes poll-1
    const closeMsg = makePollMessage({
      id: 'close-1',
      poll: undefined,
      pollClosed: {
        title: 'What for lunch?',
        pollMessageId: 'poll-1',
        results: [
          { emoji: '1️⃣', label: 'Pizza', count: 3 },
          { emoji: '2️⃣', label: 'Sushi', count: 1 },
        ],
      },
    })

    const { container } = render(
      <PollBanner
        messages={[pollMsg, closeMsg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('should still show unclosed polls when another poll is closed', () => {
    const pollMsg1 = makePollMessage({ id: 'poll-1' })
    const pollMsg2 = makePollMessage({ id: 'poll-2', poll: { ...pollMsg1.poll!, title: 'Second poll' } })
    // Only poll-1 is closed
    const closeMsg = makePollMessage({
      id: 'close-1',
      poll: undefined,
      pollClosed: {
        title: 'What for lunch?',
        pollMessageId: 'poll-1',
        results: [{ emoji: '1️⃣', label: 'Pizza', count: 3 }],
      },
    })

    render(
      <PollBanner
        messages={[pollMsg1, pollMsg2, closeMsg]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText(/Second poll/)).toBeInTheDocument()
  })

  it('should show the latest unanswered poll when one is dismissed', () => {
    const msg1 = makePollMessage({ id: 'poll-1' })
    const msg2 = makePollMessage({
      id: 'poll-2',
      poll: { ...msg1.poll!, title: 'Second poll' },
    })

    // Dismiss the latest (poll-2), should fall back to poll-1
    render(
      <PollBanner
        messages={[msg1, msg2]}
        myNick="bob"
        votedPollIds={emptySet}
        dismissedPollIds={new Set(['poll-2'])}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByText(/What for lunch/)).toBeInTheDocument()
  })

  it('should hide banner when votedPollIds covers poll even without reactions', () => {
    // Simulates: user voted in this browser, reactions not yet loaded from MAM
    const msg = makePollMessage({ reactions: {} })

    const { container } = render(
      <PollBanner
        messages={[msg]}
        myNick="bob"
        votedPollIds={new Set(['poll-1'])}
        dismissedPollIds={emptySet}
        onDismiss={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })
})
