import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { installMobilePageZoom } from './mobilePageZoom'

describe('mobile page zoom', () => {
  let dispose: (() => void) | undefined
  let restore: (() => void) | undefined
  afterEach(() => { dispose?.(); restore?.(); vi.unstubAllGlobals() })
  function setup(touch: boolean, native = false) {
    restore = setPlatformForTesting({ shell: native ? 'mobile' : 'web', os: native ? 'ios' : 'other' })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: touch })))
    dispose = installMobilePageZoom()
  }
  function move(fingers: number) {
    const event = new Event('touchmove', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: Array.from({ length: fingers }, () => ({})) })
    document.dispatchEvent(event)
    return event
  }
  it('blocks multitouch page zoom in a touch browser but preserves single-finger scrolling', () => {
    setup(true)
    expect(move(2).defaultPrevented).toBe(true)
    expect(move(1).defaultPrevented).toBe(false)
  })
  it('blocks Safari pinch gestures in the native iOS shell', () => {
    setup(false, true)
    for (const name of ['gesturestart', 'gesturechange']) {
      const event = new Event(name, { cancelable: true })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
  })
  it('does not intercept desktop gestures', () => {
    setup(false)
    const event = new Event('gesturestart', { cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(move(2).defaultPrevented).toBe(false)
  })
  it('removes its handlers when disposed', () => {
    setup(true)
    dispose?.()
    expect(move(2).defaultPrevented).toBe(false)
  })
})
