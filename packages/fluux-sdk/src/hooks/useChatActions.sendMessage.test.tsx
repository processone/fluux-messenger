/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'
import { useChatActions } from './useChatActions'

const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return {
    ...actual,
    useXMPPContext: () => ({ client: mockClient }),
  }
})

function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

/**
 * The 1:1 chat hook's sendMessage takes an options object and never exposes
 * the wire-level message `type` — it always sends a 'chat' message. replyTo
 * and attachment ride in the options object instead of positional args.
 */
describe('useChatActions.sendMessage (options object)', () => {
  beforeEach(() => {
    mockClient.chat.sendMessage.mockClear()
    mockClient.chat.sendMessage.mockResolvedValue('msg-id-1')
  })

  it('sends a plain message as type "chat" with no reply/attachment', async () => {
    const { result } = renderHook(() => useChatActions(), { wrapper })

    await act(async () => {
      await result.current.sendMessage('bob@example.com', 'hi')
    })

    expect(mockClient.chat.sendMessage).toHaveBeenCalledWith(
      'bob@example.com', 'hi', 'chat', undefined, undefined, undefined
    )
  })

  it('forwards replyTo and attachment from the options object', async () => {
    const { result } = renderHook(() => useChatActions(), { wrapper })

    const replyTo = { id: 'm1', to: 'bob@example.com', fallback: { author: 'Bob', body: 'earlier' } }
    const attachment = { url: 'https://x/y.png', mediaType: 'image/png' }
    await act(async () => {
      await result.current.sendMessage('bob@example.com', 'see this', { replyTo, attachment })
    })

    expect(mockClient.chat.sendMessage).toHaveBeenCalledWith(
      'bob@example.com', 'see this', 'chat', replyTo, undefined, attachment
    )
  })
})
