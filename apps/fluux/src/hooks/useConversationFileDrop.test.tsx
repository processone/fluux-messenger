import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConversationFileDrop } from './useConversationFileDrop'
import { useConversationFileDropStore } from '@/stores/conversationFileDropStore'
import { dispatchNativeDrop } from '@/utils/tauriFileDrop'
import { setPlatformForTesting } from '@/platform'

const h = vi.hoisted(() => ({ read: vi.fn(), active: null as string | null }))
vi.mock('@fluux/sdk', () => ({
  chatStore: { getState: () => ({ activeConversationId: h.active }) },
  getStorageScopeJid: () => null,
}))
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
    expect(useConversationFileDropStore.getState().pending).toEqual({ conversationId: 'bob@example.com', file, account: null })
  })

  const row = () => {
    const el = document.createElement('div')
    el.setAttribute('data-conv-id', 'bob@example.com')
    document.body.append(el)
    document.elementFromPoint = vi.fn(() => el)
    return el
  }
  const drop = async () => act(async () => { dispatchNativeDrop(['/tmp/x.png'], { x: 200, y: 100 }) })

  it('routes a desktop drop that lands on a row to that row, not to the open chat', async () => {
    const restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    const select = vi.fn()
    renderHook(() => useConversationFileDrop(select))
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    h.read.mockResolvedValue(file)
    const el = row()
    window.devicePixelRatio = 2

    await drop()

    // macOS reports logical points: no scale applies
    expect(document.elementFromPoint).toHaveBeenCalledWith(200, 100)
    expect(select).toHaveBeenCalledExactlyOnceWith('bob@example.com')
    expect(useConversationFileDropStore.getState().pending?.file).toBe(file)
    el.remove()
    restore()
  })

  it('converts the physical position Windows reports by the display scale', async () => {
    const restore = setPlatformForTesting({ shell: 'desktop', os: 'windows' })
    renderHook(() => useConversationFileDrop(vi.fn()))
    h.read.mockResolvedValue(new File(['x'], 'x.png'))
    const el = row()
    window.devicePixelRatio = 2

    await drop()

    expect(document.elementFromPoint).toHaveBeenCalledWith(100, 50)
    el.remove()
    restore()
  })

  it('ignores a drop that is not on a row, leaving it to the open chat', async () => {
    const restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    const select = vi.fn()
    renderHook(() => useConversationFileDrop(select))
    document.elementFromPoint = vi.fn(() => document.body)

    await drop()

    expect(h.read).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    restore()
  })

  it('drops a slow read when a newer drop, a navigation or unmounting came first', async () => {
    const restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    const select = vi.fn()
    const { unmount } = renderHook(() => useConversationFileDrop(select))
    const el = row()
    const slow: Array<(f: File) => void> = []
    h.read.mockImplementation(() => new Promise<File>((resolve) => slow.push(resolve)))
    const file = (n: string) => new File(['x'], n)

    await drop(); await drop()
    await act(async () => { slow[0](file('old')) })
    expect(select).not.toHaveBeenCalled()
    await act(async () => { slow[1](file('new')) })
    expect(select).toHaveBeenCalledTimes(1)

    select.mockClear()
    await drop()
    h.active = 'carol@example.com'
    await act(async () => { slow[2](file('navigated')) })
    expect(select).not.toHaveBeenCalled()

    await drop()
    unmount()
    await act(async () => { slow[3](file('unmounted')) })
    expect(select).not.toHaveBeenCalled()
    h.active = null
    el.remove()
    restore()
  })
})
