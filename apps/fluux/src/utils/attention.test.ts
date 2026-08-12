import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setPlatformForTesting } from '@/platform'

const mockRequestUserAttention = vi.fn().mockResolvedValue(undefined)
let mockWindowVisible = false
let restorePlatform: () => void

vi.mock('@fluux/sdk', () => ({
  connectionStore: { getState: () => ({ windowVisible: mockWindowVisible }) },
}))
vi.mock('@tauri-apps/api/window', () => ({
  UserAttentionType: { Critical: 1 },
  getCurrentWindow: () => ({ requestUserAttention: mockRequestUserAttention }),
}))

import { requestAttention } from './attention'

describe('requestAttention', () => {
  beforeEach(() => {
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'windows' })
    mockWindowVisible = false
    mockRequestUserAttention.mockClear()
  })

  afterEach(() => {
    restorePlatform()
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
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    requestAttention()
    restorePlatform = setPlatformForTesting({ shell: 'web', os: 'windows' })
    requestAttention()
    expect(mockRequestUserAttention).not.toHaveBeenCalled()
  })
})
