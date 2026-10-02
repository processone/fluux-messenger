import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setCustomWindowChromeForTesting } from '@/platform/windowChrome'
import { ModalOverlay } from './ModalOverlay'
import { AvatarLightbox } from './AvatarLightbox'
import { ImageLightbox } from './ImageLightbox'
import { BottomSheet } from './ui/BottomSheet'
import { RenderLoopBoundary } from './RenderLoopBoundary'
import { WindowControls } from './WindowControls'

vi.mock('./Avatar', () => ({ Avatar: () => null }))
vi.mock('@/hooks', () => ({ useAttachmentUrl: () => ({ url: null, isLoading: false }) }))
vi.mock('@/hooks/useCachedMediaUrl', () => ({ useCachedMediaUrl: () => ({ cachedUrl: null }) }))
vi.mock('./ImageContextMenu', () => ({ ImageContextMenu: () => null }))
vi.mock('@/hooks/useFullscreen', () => ({ useFullscreen: () => false }))

const win = {
  minimize: vi.fn(async () => {}),
  maximize: vi.fn(async () => {}),
  unmaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
}
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))

const actions = [
  { label: 'Minimize', action: win.minimize, maximized: false },
  { label: 'Maximize', action: win.maximize, maximized: false },
  { label: 'Restore', action: win.unmaximize, maximized: true },
  { label: 'Close', action: win.close, maximized: false },
]

let restoreChrome: () => void
beforeEach(() => {
  vi.clearAllMocks()
  win.isMaximized.mockResolvedValue(false)
  restoreChrome = setCustomWindowChromeForTesting(true)
})
afterEach(() => {
  restoreChrome()
  vi.restoreAllMocks()
})

function pointerClick(button: HTMLElement) {
  if (fireEvent.mouseDown(button)) button.focus()
  fireEvent.mouseUp(button)
  fireEvent.click(button)
}

describe.each([
  ['ModalOverlay', <ModalOverlay dismissable={false} onClose={vi.fn()}><input aria-label="Dialog field" /></ModalOverlay>],
  ['AvatarLightbox', <AvatarLightbox identifier="user@example.com" onClose={vi.fn()} />],
  ['ImageLightbox', <ImageLightbox src="https://example.com/image.png" downloadUrl="https://example.com/image.png" onClose={vi.fn()} />],
  ['BottomSheet', <BottomSheet open onClose={vi.fn()}><input aria-label="Sheet field" /></BottomSheet>],
])('window controls with %s open', (_name, overlay) => {
  it.each(actions)('$label preserves overlay focus when clicked', async ({ label, action, maximized }) => {
    win.isMaximized.mockResolvedValue(maximized)
    render(<><WindowControls />{overlay}</>)
    await waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1))
    const focused = document.activeElement
    expect(focused).not.toBe(document.body)

    pointerClick(screen.getByRole('button', { name: label }))

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(focused)
  })
})

describe('window controls outside the app error boundary', () => {
  it('keeps the window operable on the rendered crash screen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    function Thrower(): null {
      throw new Error('boom')
    }
    render(<><RenderLoopBoundary><Thrower /></RenderLoopBoundary><WindowControls /></>)
    await waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('heading', { name: 'Something Went Wrong' })).toBeInTheDocument()

    pointerClick(screen.getByRole('button', { name: 'Minimize' }))
    await waitFor(() => expect(win.minimize).toHaveBeenCalledTimes(1))
    pointerClick(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('heading', { name: 'Something Went Wrong' })).toBeInTheDocument()
  })
})
