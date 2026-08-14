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
    mockClient.messages.sendMessage.mockClear()
    mockClient.messages.sendMessage.mockResolvedValue('msg-id-1')
  })

  it('sends a plain message with no options at all', async () => {
    const { result } = renderHook(() => useChatActions(), { wrapper })

    await act(async () => {
      await result.current.sendMessage('bob@example.com', 'hi')
    })

    expect(mockClient.messages.sendMessage).toHaveBeenCalledWith('bob@example.com', 'hi', undefined)
  })

  it('passes the options object straight through to the SDK', async () => {
    const { result } = renderHook(() => useChatActions(), { wrapper })

    const replyTo = { id: 'm1', to: 'bob@example.com', fallback: { author: 'Bob', body: 'earlier' } }
    const attachment = { url: 'https://x/y.png', mediaType: 'image/png' }
    await act(async () => {
      await result.current.sendMessage('bob@example.com', 'see this', { replyTo, attachment })
    })

    expect(mockClient.messages.sendMessage).toHaveBeenCalledWith('bob@example.com', 'see this', {
      replyTo,
      attachment,
    })
  })
})
