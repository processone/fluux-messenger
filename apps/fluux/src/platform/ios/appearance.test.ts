import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { setIosAppearance } from './appearance'
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
let restore = () => {}
afterEach(() => { restore(); invoke.mockClear() })
describe('native appearance boundary', () => {
  it.each(['light', 'dark', null] as const)('sends %s on iOS', async style => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    setIosAppearance(style)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin:ios-feedback|set_appearance', { style }))
  })
  it.each([{ shell: 'web', os: 'ios' }, { shell: 'mobile', os: 'android' }, { shell: 'desktop', os: 'macos' }] as const)('does nothing on $shell/$os', async host => {
    restore = setPlatformForTesting(host)
    setIosAppearance('dark')
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })
})
