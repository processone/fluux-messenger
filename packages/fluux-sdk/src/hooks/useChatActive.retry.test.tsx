/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatActive } from './useChatActive'
import { useXMPPContext } from '../provider'
import { chatStore } from '../stores'
import { wrapper, createConversation, createMessage } from './renderStability.helpers'

// A retry the SDK refuses (an encrypted-source forward with no encryption) sends nothing, so the row stays failed.
describe('useChatActive retryMessage', () => {
  it('restores the failed status and rethrows when the resend is refused, and clears it when the resend succeeds', async () => {
    act(() => {
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addMessage(createMessage('bob@example.com', 'quote', { id: 'm1', isOutgoing: true }))
      chatStore.getState().updateMessage('bob@example.com', 'm1', { deliveryError: { text: 'Failed to send' } as never })
    })
    expect(chatStore.getState().getMessage('bob@example.com', 'm1')?.deliveryError).toBeDefined()
    const { result } = renderHook(() => ({ active: useChatActive(), ctx: useXMPPContext() }), { wrapper })
    const resend = vi.spyOn(result.current.ctx.client.messages, 'resendMessage').mockRejectedValueOnce(new Error('encryption required'))
    await expect(result.current.active.retryMessage('bob@example.com', 'm1')).rejects.toThrow('encryption required')
    expect(chatStore.getState().getMessage('bob@example.com', 'm1')?.deliveryError).toEqual({ text: 'Failed to send' })
    resend.mockResolvedValueOnce(undefined)
    await result.current.active.retryMessage('bob@example.com', 'm1')
    expect(chatStore.getState().getMessage('bob@example.com', 'm1')?.deliveryError).toBeUndefined()
  })
})
