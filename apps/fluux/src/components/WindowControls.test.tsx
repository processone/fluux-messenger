import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setCustomWindowChromeForTesting } from '@/platform/windowChrome'
import { WindowControls } from './WindowControls'

let mockIsFullscreen = false
vi.mock('@/hooks/useFullscreen', () => ({
  useFullscreen: () => mockIsFullscreen,
}))

let resized: (() => void) | undefined
const win = {
  minimize: vi.fn(async () => {}),
  maximize: vi.fn(async () => {}),
  unmaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async (handler: () => void) => {
    resized = handler
    return () => {
      resized = undefined
    }
  }),
}
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => win,
}))

describe('WindowControls', () => {
  let restoreChrome: (() => void) | undefined

  function customChrome(value: boolean) {
    restoreChrome?.()
    restoreChrome = setCustomWindowChromeForTesting(value)
  }

  beforeEach(() => {
    mockIsFullscreen = false
    resized = undefined
    vi.clearAllMocks()
    win.isMaximized.mockResolvedValue(false)
    customChrome(true)
  })

  afterEach(() => {
    restoreChrome?.()
    restoreChrome = undefined
  })

  /**
   * Render and wait until the controls have subscribed to the window.
   *
   * A click dispatched while that first `import()` of the mocked window module
   * is still in flight starts a second, concurrent one, which vitest resolves
   * to the real module.
   */
  async function renderReady() {
    const view = render(<WindowControls />)
    await waitFor(() => expect(resized).toBeDefined())
    return view
  }

  it('renders nothing while the OS draws the window frame', () => {
    customChrome(false)
    const { container } = render(<WindowControls />)
    expect(container).toBeEmptyDOMElement()
  })

  it('appears as soon as the window reports it has no native frame', () => {
    customChrome(false)
    render(<WindowControls />)
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    act(() => customChrome(true))

    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('renders nothing in fullscreen', () => {
    mockIsFullscreen = true
    const { container } = render(<WindowControls />)
    expect(container).toBeEmptyDOMElement()
  })

  it('orders the buttons minimize, maximize, close so the layout direction mirrors them', () => {
    render(<WindowControls />)
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Minimize',
      'Maximize',
      'Close',
    ])
  })

  it('minimizes the window', async () => {
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    await waitFor(() => expect(win.minimize).toHaveBeenCalledTimes(1))
  })

  it('maximizes a window that is not maximized', async () => {
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
    await waitFor(() => expect(win.maximize).toHaveBeenCalledTimes(1))
    expect(win.unmaximize).not.toHaveBeenCalled()
  })

  it('offers restore, and restores, when the window is maximized', async () => {
    win.isMaximized.mockResolvedValue(true)
    render(<WindowControls />)

    const restore = await screen.findByRole('button', { name: 'Restore' })
    expect(screen.queryByRole('button', { name: 'Maximize' })).not.toBeInTheDocument()

    fireEvent.click(restore)
    await waitFor(() => expect(win.unmaximize).toHaveBeenCalledTimes(1))
    expect(win.maximize).not.toHaveBeenCalled()
  })

  it.each([
    ['Minimize', win.minimize, false],
    ['Maximize', win.maximize, false],
    ['Restore', win.unmaximize, true],
    ['Close', win.close, false],
  ] as const)('keeps %s focusable and operable without pointer events', async (label, action, maximized) => {
    win.isMaximized.mockResolvedValue(maximized)
    await renderReady()
    const button = screen.getByRole('button', { name: label })
    button.focus()
    expect(button).toHaveFocus()
    expect(button.tabIndex).toBe(0)
    fireEvent.click(button, { detail: 0 })
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(button).toHaveFocus()
  })

  it('follows the window when it is maximized or restored from outside', async () => {
    await renderReady()

    win.isMaximized.mockResolvedValue(true)
    act(() => resized?.())
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()

    win.isMaximized.mockResolvedValue(false)
    act(() => resized?.())
    expect(await screen.findByRole('button', { name: 'Maximize' })).toBeInTheDocument()
  })

  it('shows the real maximize state again after leaving fullscreen', async () => {
    mockIsFullscreen = true
    const { rerender } = render(<WindowControls />)

    win.isMaximized.mockResolvedValue(true)
    mockIsFullscreen = false
    rerender(<WindowControls />)

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('closes through close(), which the tray preference intercepts, never destroy()', async () => {
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1))
    expect(win.destroy).not.toHaveBeenCalled()
  })

  it('dims the buttons while the window is inactive', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { container } = render(<WindowControls />)
    const controls = container.firstElementChild!
    expect(controls).toHaveAttribute('data-window-focused', 'true')

    hasFocus.mockReturnValue(false)
    fireEvent.blur(window)
    expect(controls).toHaveAttribute('data-window-focused', 'false')

    hasFocus.mockReturnValue(true)
    fireEvent.focus(window)
    expect(controls).toHaveAttribute('data-window-focused', 'true')
    hasFocus.mockRestore()
  })
})
