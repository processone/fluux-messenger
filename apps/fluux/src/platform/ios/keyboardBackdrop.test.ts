import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { firstOpaque, syncKeyboardBackdrop, watchKeyboardBackdrop } from './keyboardBackdrop'

const setBackgroundColor = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ setBackgroundColor }) }))

const rgba = (css: string): [number, number, number, number] => {
  const m = css.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/)
  return m ? [+m[1], +m[2], +m[3], Math.round((m[4] === undefined ? 1 : +m[4]) * 255)] : [0, 0, 0, 0]
}

describe('firstOpaque', () => {
  it('skips transparent layers and takes the first opaque one, as in the captain screenshot (#212535)', () => {
    const stack = ['rgba(0, 0, 0, 0)', 'rgba(33, 37, 53, 0.5)', 'rgb(33, 37, 53)', 'rgb(24, 27, 39)']
    expect(firstOpaque(stack, rgba)).toEqual([33, 37, 53])
  })
  it('returns null when nothing is opaque', () => {
    expect(firstOpaque(['rgba(0, 0, 0, 0)'], rgba)).toBeNull()
  })
})

describe('native web view backdrop boundary', () => {
  let restore = () => {}
  afterEach(() => { restore(); setBackgroundColor.mockClear() })

  it('does nothing outside iOS', async () => {
    restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    syncKeyboardBackdrop()
    expect(watchKeyboardBackdrop()).toBeTypeOf('function')
    await Promise.resolve()
    expect(setBackgroundColor).not.toHaveBeenCalled()
  })
})
