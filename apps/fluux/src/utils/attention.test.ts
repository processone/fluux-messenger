import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequestUserAttention = vi.fn().mockResolvedValue(undefined)
let mockTauri = true
let mockWindows = true
let mockWindowVisible = false

vi.mock('@fluux/sdk', () => ({
  connectionStore: { getState: () => ({ windowVisible: mockWindowVisible }) },
}))
vi.mock('./tauri', () => ({
  isTauri: () => mockTauri,
  isWindows: () => mockWindows,
}))
vi.mock('@tauri-apps/api/window', () => ({
  UserAttentionType: { Critical: 1 },
  getCurrentWindow: () => ({ requestUserAttention: mockRequestUserAttention }),
}))

import { requestAttention } from './attention'

describe('requestAttention', () => {
  beforeEach(() => {
    mockTauri = true
    mockWindows = true
    mockWindowVisible = false
    mockRequestUserAttention.mockClear()
  })

  it('requests critical attention on unfocused Windows Tauri', async () => {
    requestAttention()
    await vi.waitFor(() => expect(mockRequestUserAttention).toHaveBeenCalledWith(1))
  })

  it('does nothing while focused', () => {
    mockWindowVisible = true
    requestAttention()
    expect(mockRequestUserAttention).not.toHaveBeenCalled()
  })

  it('does nothing outside Windows Tauri', () => {
    mockWindows = false
    requestAttention()
    mockWindows = true
    mockTauri = false
    requestAttention()
    expect(mockRequestUserAttention).not.toHaveBeenCalled()
  })
})
