import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The handler dynamically imports the Tauri shell plugin; capture the mock.
const openMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }))
const openUrlMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }))

import { setPlatformForTesting } from '@/platform'
import { setupExternalLinkHandler } from './externalLinkHandler'

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('setupExternalLinkHandler', () => {
  let cleanup: (() => void) | undefined
  let restorePlatform: () => void

  beforeEach(() => {
    // The handler only registers where in-app navigation is intercepted.
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    openMock.mockClear()
    openUrlMock.mockClear()
    cleanup = setupExternalLinkHandler()
  })

  afterEach(() => {
    cleanup?.()
    restorePlatform()
    document.body.innerHTML = ''
  })

  it('opens an external link in the system browser', async () => {
    document.body.innerHTML = '<a href="https://example.com/x">link text</a>'
    click(document.querySelector('a')!)
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledWith('https://example.com/x'))
  })

  it('opens a tapped message link through the iOS opener', async () => {
    cleanup?.()
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    cleanup = setupExternalLinkHandler()
    document.body.innerHTML = '<a href="https://example.com/x"><span>link text</span></a>'
    click(document.querySelector('span')!)
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith('https://example.com/x'))
    expect(openMock).not.toHaveBeenCalled()
  })

  it('opens an iOS link tap even when WebKit does not emit a click', async () => {
    cleanup?.()
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    cleanup = setupExternalLinkHandler()
    document.body.innerHTML = '<a href="https://example.com/x"><span>link text</span></a>'
    const label = document.querySelector('span')!
    const touch = { identifier: 1, clientX: 80, clientY: 100 } as Touch

    label.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch] }))
    label.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch] }))

    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith('https://example.com/x'))
    click(label)
    expect(openUrlMock).toHaveBeenCalledTimes(1)
  })

  it('does not open an iOS link while scrolling over it', async () => {
    cleanup?.()
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    cleanup = setupExternalLinkHandler()
    document.body.innerHTML = '<a href="https://example.com/x">link text</a>'
    const link = document.querySelector('a')!
    const start = { identifier: 1, clientX: 80, clientY: 100 } as Touch
    const moved = { identifier: 1, clientX: 80, clientY: 160 } as Touch

    link.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [start] }))
    link.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [moved] }))
    link.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [moved] }))

    await Promise.resolve()
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('does not open an iOS link after a long press opens the message actions', async () => {
    cleanup?.()
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    cleanup = setupExternalLinkHandler()
    document.body.innerHTML = '<a href="https://example.com/x">link text</a>'
    const link = document.querySelector('a')!
    const touch = { identifier: 1, clientX: 80, clientY: 100 } as Touch
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)

    try {
      link.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch] }))
      now.mockReturnValue(600)
      link.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch] }))
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(click)

      expect(click.defaultPrevented).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(openUrlMock).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })

  it('leaves a nested preview control to its own touch handler on iOS', async () => {
    cleanup?.()
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    cleanup = setupExternalLinkHandler()
    document.body.innerHTML = '<a href="https://example.com/x"><div role="button">Show image</div></a>'
    const control = document.querySelector('[role="button"]')!
    const touch = { identifier: 1, clientX: 80, clientY: 100 } as Touch

    control.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch] }))
    control.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch] }))

    await Promise.resolve()
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('opens when clicking non-interactive content inside the link', async () => {
    document.body.innerHTML = '<a href="https://example.com/y"><span>inner</span></a>'
    click(document.querySelector('span')!)
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledWith('https://example.com/y'))
  })

  it('does NOT open when the click lands on a <button> nested in the link', async () => {
    document.body.innerHTML = '<a href="https://example.com/z"><button type="button">go</button></a>'
    const btn = document.querySelector('button')!
    // The control handles its own click (as the real React component does),
    // so the anchor never navigates.
    btn.addEventListener('click', (e) => e.preventDefault())
    click(btn)
    await Promise.resolve()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('does NOT open when the click lands on a role="button" control nested in the link (deferred media)', async () => {
    document.body.innerHTML = '<a href="https://example.com/w"><div role="button">Show image</div></a>'
    const control = document.querySelector('[role="button"]')!
    control.addEventListener('click', (e) => e.preventDefault())
    click(control)
    await Promise.resolve()
    expect(openMock).not.toHaveBeenCalled()
  })
})
