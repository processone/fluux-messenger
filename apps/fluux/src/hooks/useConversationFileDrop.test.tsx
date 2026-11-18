import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConversationFileDrop } from './useConversationFileDrop'
import { useConversationFileDropStore } from '@/stores/conversationFileDropStore'
import { dispatchNativeDrop } from '@/utils/tauriFileDrop'

const h = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/utils/nativeDroppedFile', () => ({ readNativeDroppedFile: h.read }))

// Intent: a drop on a sidebar conversation opens it and hands the file over, never sending it (FLM-196 option A).
describe('useConversationFileDrop', () => {
  beforeEach(() => {
    useConversationFileDropStore.setState({ pending: null })
    h.read.mockReset()
  })

  it('opens the conversation, then offers the file to it', () => {
    const order: string[] = []
    const select = vi.fn(() => order.push(`select:${useConversationFileDropStore.getState().pending ? 'offered' : 'empty'}`))
    const { result } = renderHook(() => useConversationFileDrop(select))
    const file = new File(['x'], 'x.png', { type: 'image/png' })

    result.current('bob@example.com', file)

    expect(select).toHaveBeenCalledExactlyOnceWith('bob@example.com')
    expect(order).toEqual(['select:empty'])
    expect(useConversationFileDropStore.getState().pending).toEqual({ conversationId: 'bob@example.com', file })
  })

  it('routes a desktop drop that lands on a row to that row, not to the open chat', async () => {
    const select = vi.fn()
    renderHook(() => useConversationFileDrop(select))
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    h.read.mockResolvedValue(file)
    const row = document.createElement('div')
    row.setAttribute('data-conv-id', 'bob@example.com')
    document.body.append(row)
    document.elementFromPoint = vi.fn(() => row)
    window.devicePixelRatio = 2

    await act(async () => { dispatchNativeDrop(['/tmp/x.png'], { x: 200, y: 100 }) })

    expect(document.elementFromPoint).toHaveBeenCalledWith(100, 50)
    expect(h.read).toHaveBeenCalledWith('/tmp/x.png')
    expect(select).toHaveBeenCalledExactlyOnceWith('bob@example.com')
    expect(useConversationFileDropStore.getState().pending?.file).toBe(file)
    row.remove()
  })
})
