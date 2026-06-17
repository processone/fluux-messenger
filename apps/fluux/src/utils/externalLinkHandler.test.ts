import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The handler dynamically imports the Tauri shell plugin; capture the mock.
const openMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }))
// Force the Tauri branch so the handler actually registers.
vi.mock('./tauri', () => ({ isTauri: () => true }))

import { setupExternalLinkHandler } from './externalLinkHandler'

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('setupExternalLinkHandler', () => {
  let cleanup: (() => void) | undefined

  beforeEach(() => {
    openMock.mockClear()
    cleanup = setupExternalLinkHandler()
  })

  afterEach(() => {
    cleanup?.()
    document.body.innerHTML = ''
  })

  it('opens an external link in the system browser', async () => {
    document.body.innerHTML = '<a href="https://example.com/x">link text</a>'
    click(document.querySelector('a')!)
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledWith('https://example.com/x'))
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
