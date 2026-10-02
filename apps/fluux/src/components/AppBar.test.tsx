import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BrowserRouter, MemoryRouter } from 'react-router'
import { AppBar } from './AppBar'
import { ModalOverlay } from './ModalOverlay'
import { AvatarLightbox } from './AvatarLightbox'
import { ImageLightbox } from './ImageLightbox'
import { BottomSheet } from './ui/BottomSheet'
import { WINDOW_CONTROLS_WIDTH } from './WindowControls'
import { setPlatformForTesting } from '@/platform'
import { setCustomWindowChromeForTesting } from '@/platform/windowChrome'

vi.mock('./Avatar', () => ({ Avatar: () => null }))
vi.mock('@/hooks', () => ({ useAttachmentUrl: () => ({ url: null, isLoading: false }) }))
vi.mock('@/hooks/useCachedMediaUrl', () => ({ useCachedMediaUrl: () => ({ cachedUrl: null }) }))
vi.mock('./ImageContextMenu', () => ({ ImageContextMenu: () => null }))

// One seam for the platform, shared with the app code under test.
let restorePlatform: (() => void) | undefined
function usePlatform(shell: 'desktop' | 'web', os: 'macos' | 'windows' | 'linux' = 'macos') {
  restorePlatform?.()
  restorePlatform = setPlatformForTesting({ shell, os })
}

// Reactive gates — toggled per test.
let mockIsDesktop = true
let mockHasHover = true
vi.mock('@/hooks/useIsDesktop', () => ({
  useIsDesktop: () => mockIsDesktop,
}))
vi.mock('@/hooks/useHasHover', () => ({
  useHasHover: () => mockHasHover,
}))
let mockIsFullscreen = false
vi.mock('@/hooks/useFullscreen', () => ({
  useFullscreen: () => mockIsFullscreen,
}))

// The room slice the window title selects from, stated per case.
let roomState: { rooms: Map<string, { name: string }>; activeRoomJid: string | null } = {
  rooms: new Map(),
  activeRoomJid: null,
}
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ conversations: new Map(), activeConversationId: null }),
  useRoomStore: (selector: (state: typeof roomState) => unknown) => selector(roomState),
}))

const setTitle = vi.fn(async (_title: string) => {})
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle,
    startDragging: async () => {},
    toggleMaximize: async () => {},
  }),
}))

const navigateSpy = vi.fn()
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => navigateSpy }
})

const toggleSpy = vi.fn()
vi.mock('@/stores/modalStore', () => ({
  useModalStore: (selector: (s: { toggle: (m: string) => void }) => unknown) =>
    selector({ toggle: toggleSpy }),
}))

function renderAppBar() {
  return render(
    <MemoryRouter>
      <AppBar />
    </MemoryRouter>,
  )
}

describe('AppBar', () => {
  afterEach(() => {
    restorePlatform?.()
    restorePlatform = undefined
  })

  beforeEach(() => {
    mockIsDesktop = true
    mockHasHover = true
    mockIsFullscreen = false
    setTitle.mockClear()
    navigateSpy.mockClear()
    toggleSpy.mockClear()
    // Default to the web build; the desktop-app tests opt in explicitly.
    usePlatform('web')
    // Reset history position so each test starts at index 0 (start = end).
    window.history.replaceState(null, '')
  })

  it('renders nothing on mobile web (below the desktop breakpoint)', () => {
    mockIsDesktop = false
    const { container } = renderAppBar()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing on a touch device even when wide (e.g. phone in landscape)', () => {
    mockIsDesktop = true
    mockHasHover = false
    const { container } = renderAppBar()
    expect(container).toBeEmptyDOMElement()
  })

  it('still renders on the desktop app in a narrow window (Tauri, below the breakpoint)', () => {
    usePlatform('desktop')
    mockIsDesktop = false
    mockHasHover = false
    renderAppBar()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open command palette' })).toBeInTheDocument()
  })

  it('renders back, forward and command-palette controls on desktop', () => {
    renderAppBar()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open command palette' })).toBeInTheDocument()
  })

  it('does not duplicate the settings control (it lives in the rail)', () => {
    renderAppBar()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('disables back at the first history entry', () => {
    renderAppBar()
    // Fresh history starts at index 0 → nowhere to go back.
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('disables forward at the end of history', () => {
    renderAppBar()
    // At the furthest index reached → nowhere to go forward.
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
  })

  it('navigates back when not at the first history entry', () => {
    // Simulate being one step into the history stack.
    window.history.replaceState({ idx: 1 }, '')
    renderAppBar()
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back).toBeEnabled()
    fireEvent.click(back)
    expect(navigateSpy).toHaveBeenCalledWith(-1)
  })

  it('opens the command palette from the command-palette control', () => {
    renderAppBar()
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    expect(toggleSpy).toHaveBeenCalledWith('commandPalette')
  })

  describe.each(['windows', 'macos', 'linux'] as const)('modal isolation on %s', (os) => {
    it.each([
      ['dialog', <ModalOverlay dismissable={false} onClose={vi.fn()}><input aria-label="Dialog field" /></ModalOverlay>],
      ['image', <ImageLightbox src="https://example.com/image.png" downloadUrl="https://example.com/image.png" onClose={vi.fn()} />],
      ['avatar', <AvatarLightbox identifier="user@example.com" onClose={vi.fn()} />],
      ['sheet', <BottomSheet open onClose={vi.fn()}><input aria-label="Sheet field" /></BottomSheet>],
    ])('blocks both history directions while a %s is open and resumes after close', async (_name, overlay) => {
      usePlatform('desktop', os)
      const restoreChrome = setCustomWindowChromeForTesting(os === 'windows')
      try {
        window.history.replaceState({ idx: 2, key: 'later-entry' }, '')
        render(<BrowserRouter><AppBar /></BrowserRouter>)
        await act(async () => {
          window.history.replaceState({ idx: 1, key: 'earlier-entry' }, '')
          window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 1, key: 'earlier-entry' } }))
        })
        const back = screen.getByRole('button', { name: 'Back' })
        const forward = screen.getByRole('button', { name: 'Forward' })
        expect(back).toBeEnabled()
        expect(forward).toBeEnabled()
        const modal = render(overlay)
        const focused = document.activeElement
        for (const button of [back, forward]) {
          if (fireEvent.mouseDown(button)) button.focus()
          fireEvent.mouseUp(button)
          fireEvent.click(button)
          expect(document.activeElement).toBe(focused)
        }
        expect(navigateSpy).not.toHaveBeenCalled()
        const palette = screen.queryByRole('button', { name: 'Open command palette' })
        if (palette) {
          fireEvent.click(palette)
          expect(toggleSpy).not.toHaveBeenCalled()
        }

        modal.unmount()
        fireEvent.click(back)
        fireEvent.click(forward)
        expect(navigateSpy.mock.calls).toEqual([[-1], [1]])
        if (palette) {
          fireEvent.click(palette)
          expect(toggleSpy).toHaveBeenCalledWith('commandPalette')
        }
      } finally {
        act(restoreChrome)
      }
    })
  })

  describe('as the title bar of a frameless Windows window', () => {
    let restoreChrome: (() => void) | undefined

    beforeEach(() => {
      usePlatform('desktop', 'windows')
      restoreChrome = setCustomWindowChromeForTesting(true)
      roomState = { rooms: new Map(), activeRoomJid: null }
    })

    afterEach(() => {
      restoreChrome?.()
    })

    function openRoom(name: string) {
      const jid = 'team@conference.example.com'
      roomState = { rooms: new Map([[jid, { name }]]), activeRoomJid: jid }
    }

    it('shows the app name as the window title when no conversation is open', () => {
      renderAppBar()
      expect(screen.getByText('Fluux Messenger')).toBeInTheDocument()
    })

    it('follows the app name with the open conversation', () => {
      openRoom('Team Chat')
      const { container } = renderAppBar()
      expect(container).toHaveTextContent('Fluux Messenger — Team Chat')
    })

    it('gives the OS window the same title, for the taskbar and Alt+Tab', async () => {
      openRoom('Team Chat')
      renderAppBar()
      await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith('Fluux Messenger — Team Chat'))
    })

    it('hides the command-palette pill but keeps history navigation', () => {
      renderAppBar()
      expect(screen.queryByRole('button', { name: 'Open command palette' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Forward' })).toBeInTheDocument()
    })

    it('keeps its inline end clear for the window buttons', () => {
      const { container } = renderAppBar()
      expect(container.firstElementChild).toHaveStyle({ paddingInlineEnd: `${WINDOW_CONTROLS_WIDTH}px` })
    })

    it('gives that room back in fullscreen, where the buttons are not drawn', () => {
      mockIsFullscreen = true
      const { container } = renderAppBar()
      expect(container.firstElementChild).toHaveStyle({ paddingInlineEnd: '8px' })
    })

    it('is the native drag region', () => {
      const { container } = renderAppBar()
      expect(container.firstElementChild).toHaveClass('window-drag-region')
    })
  })

  describe('under a native window frame', () => {
    it.each(['macos', 'linux', 'windows'] as const)('keeps the pill and shows no title on %s', (os) => {
      usePlatform('desktop', os)
      const { container } = renderAppBar()
      expect(screen.getByRole('button', { name: 'Open command palette' })).toBeInTheDocument()
      expect(screen.queryByText(/Fluux Messenger/)).not.toBeInTheDocument()
      expect(container.firstElementChild).toHaveStyle({ paddingInlineEnd: '8px' })
      expect(setTitle).not.toHaveBeenCalled()
    })
  })
})
