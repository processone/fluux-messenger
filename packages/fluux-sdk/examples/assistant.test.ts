import type { RoomMessage, XMPPClient } from '@fluux/sdk/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  questionFromRoom,
  respond,
  respondInBackground,
  type Question,
} from './assistant'

function createClient() {
  const messages = {
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendChatState: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue('placeholder-id'),
    sendCorrection: vi.fn().mockResolvedValue(undefined),
  }

  return {
    client: { messages } as unknown as XMPPClient,
    messages,
  }
}

const question: Question = {
  to: 'room@conference.example.com',
  messageId: 'question-id',
  messageFrom: 'room@conference.example.com/alice',
  text: '@assistant Can you help?',
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('assistant example', () => {
  it('keeps the full room occupant JID needed by XEP-0461 replies', () => {
    const message = {
      id: 'question-id',
      from: 'room@conference.example.com/alice',
      roomJid: 'room@conference.example.com',
      nick: 'alice',
      body: '@assistant Can you help?',
      isOutgoing: false,
      isDelayed: false,
    } as RoomMessage

    expect(questionFromRoom(message, 'assistant')).toMatchObject({
      messageFrom: message.from,
    })
  })

  it('includes the original sender when replying to a room message', async () => {
    vi.useFakeTimers()
    const { client, messages } = createClient()

    const response = respond(client, question)
    await vi.runAllTimersAsync()
    await response

    expect(messages.sendMessage).toHaveBeenCalledWith(
      question.to,
      'Working on it…',
      { replyTo: { id: question.messageId, to: question.messageFrom } },
    )
  })

  it('reports initial response failures instead of rejecting in the background', async () => {
    const { client, messages } = createClient()
    const error = new Error('reaction failed')
    messages.sendReaction.mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(respondInBackground(client, question)).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith('Could not answer question-id: reaction failed')
  })
})
