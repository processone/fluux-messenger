import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { installMobileViewport } from './mobileViewport'

describe('native mobile viewport', () => {
  let root: HTMLDivElement
  let viewport: EventTarget & { height: number; offsetTop: number; scale: number }
  let restorePlatform: () => void
  let dispose: (() => void) | undefined

  beforeEach(() => {
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    viewport = Object.assign(new EventTarget(), { height: 874, offsetTop: 0, scale: 1 })
    vi.stubGlobal('visualViewport', viewport)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    root.remove()
    restorePlatform()
    vi.unstubAllGlobals()
  })

  it('keeps the app inside the visible area when keyboard focus pans and shrinks it', () => {
    dispose = installMobileViewport()
    expect(root.style.position).toBe('fixed')
    expect(root.style.height).toBe('874px')

    viewport.height = 806
    viewport.offsetTop = 68
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.top).toBe('68px')
    expect(root.style.height).toBe('806px')

    viewport.offsetTop = 80
    viewport.dispatchEvent(new Event('scroll'))
    expect(root.style.top).toBe('80px')

    viewport.height = 874
    viewport.offsetTop = 0
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.top).toBe('0px')
    expect(root.style.height).toBe('874px')
  })

  it('does not reflow the app while the user pinch-zooms', () => {
    dispose = installMobileViewport()
    viewport.scale = 2
    viewport.height = 437
    viewport.offsetTop = 90
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    expect(root.style.height).toBe('874px')
    expect(root.style.top).toBe('0px')
  })

  it('restores existing styles and removes listeners on disposal', () => {
    root.style.height = '90%'
    root.style.color = 'red'
    dispose = installMobileViewport()
    expect(root.style.height).toBe('874px')
    dispose()
    dispose = undefined
    viewport.height = 400
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.height).toBe('90%')
    expect(root.style.position).toBe('')
    expect(root.style.color).toBe('red')
  })

  it.each(['desktop', 'web'] as const)('leaves the %s shell untouched', (shell) => {
    const restore = setPlatformForTesting({ shell, os: 'macos' })
    dispose = installMobileViewport()
    viewport.height = 400
    viewport.dispatchEvent(new Event('resize'))
    expect(root.getAttribute('style')).toBeNull()
    restore()
  })

  it('leaves layout to CSS when VisualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', undefined)
    dispose = installMobileViewport()
    expect(root.getAttribute('style')).toBeNull()
  })
})
