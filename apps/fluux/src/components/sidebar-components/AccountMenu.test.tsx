/**
 * The sidebar account row (FLM-508 layout B): one row opens one menu holding presence, the
 * status message, Profile, the former three-dot items and Log out. Ported from the UserMenu,
 * PresenceSelector and StatusOrPresence tests, whose rules still stand: console gating,
 * Escape closes only the overlay on top, degraded states surface after a grace delay, the
 * retry countdown ticks, and the healthy row ignores reconnect churn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Profiler, useRef, useSyncExternalStore } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AccountMenu, DEGRADED_STATUS_GRACE_MS } from './AccountMenu'
import { EscapeModal } from '@/test-utils/escapeModal'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'
import { useModalStore } from '@/stores/modalStore'

interface ConnState {
  status: string
  isVerifying: boolean
  reconnectTargetTime: number | null
  reconnectAttempt: number
  jid: string
  ownNickname: string
  ownAvatar: string | null
}

const initialState: ConnState = {
  status: 'online',
  isVerifying: false,
  reconnectTargetTime: null,
  reconnectAttempt: 0,
  jid: 'me@example.com',
  ownNickname: 'Mickaël',
  ownAvatar: null,
}

const store = {
  state: { ...initialState },
  listeners: new Set<() => void>(),
  setState(partial: Partial<ConnState>) {
    store.state = { ...store.state, ...partial }
    store.listeners.forEach((l) => l())
  },
  subscribe(listener: () => void) {
    store.listeners.add(listener)
    return () => store.listeners.delete(listener)
  },
}

let mobile = false
let consoleIsOpen = false
let presence = 'online'
let statusMessage = ''
const toggleConsoleSpy = vi.fn()
const setPresence = vi.fn()
const cancelReconnect = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
  }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: <T,>(selector: (s: ConnState) => T): T =>
    useSyncExternalStore(store.subscribe, () => selector(store.state)),
  useEventsStore: (selector: (s: { systemNotifications: unknown[] }) => unknown) =>
    selector({ systemNotifications: [] }),
}))

vi.mock('@fluux/sdk', () => ({
  useConsole: () => ({ toggle: toggleConsoleSpy, isOpen: consoleIsOpen }),
  useXMPP: () => ({ client: { cancelReconnect } }),
  usePresence: () => ({ presenceStatus: presence, statusMessage, setPresence }),
  getLocalPart: (jid: string) => jid.split('@')[0],
}))

vi.mock('@/hooks', () => ({
  useClickOutside: () => {},
  useIsMobileWeb: () => mobile,
  useAnchoredMenu: () => ({
    triggerRef: useRef(null),
    menuRef: useRef(null),
    position: { x: 0, y: 0 },
  }),
}))

vi.mock('../AboutModal', () => ({ AboutModal: () => <div>about-modal</div> }))
vi.mock('../ChangelogModal', () => ({ ChangelogModal: () => null }))
vi.mock('../Avatar', () => ({ Avatar: () => null }))
vi.mock('../Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

const row = () => screen.getByTestId('account-row')

beforeEach(() => {
  mobile = false
  consoleIsOpen = false
  presence = 'online'
  statusMessage = ''
  store.state = { ...initialState }
  toggleConsoleSpy.mockClear()
  setPresence.mockClear()
  cancelReconnect.mockClear()
  useAdvancedModeStore.setState({ advancedMode: false })
  useModalStore.getState().close('presenceMenu')
})

describe('AccountMenu row and menu', () => {
  it('is one button with name and status and a spoken label, and no separate three-dot button', () => {
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(row()).toHaveAccessibleName('Mickaël, presence.online')
    expect(row()).toHaveAttribute('aria-haspopup', 'menu')
    expect(row()).toHaveAttribute('aria-expanded', 'false')
    expect(row().textContent).toContain('Mickaël')
    expect(row().textContent).toContain('presence.online')
  })

  it('shows the status message in place of the presence label', () => {
    statusMessage = 'In a meeting'
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    expect(row().textContent).toContain('In a meeting')
    expect(row()).toHaveAccessibleName('Mickaël, In a meeting')
  })

  it('opens one menu with presence, status message, profile, general items and log out', () => {
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    fireEvent.click(row())
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitemradio').map((e) => e.textContent)).toEqual([
      'presence.online',
      'presence.away',
      'presence.dnd',
    ])
    expect(screen.getByText('presence.statusMessage')).toBeInTheDocument()
    for (const key of ['sidebar.viewProfile', 'menu.whatsNew', 'menu.keyboardShortcuts', 'menu.reportIssue', 'menu.about', 'menu.logOut']) {
      expect(screen.getByRole('menuitem', { name: key })).toBeInTheDocument()
    }
  })

  it('opens when the Alt+Y shortcut opens the presence menu', () => {
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    act(() => useModalStore.getState().toggle('presenceMenu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(row()).toHaveAttribute('aria-expanded', 'true')
  })

  it('moves focus into the menu on the current presence, walks it with the arrow keys, and Escape returns focus to the row', async () => {
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    row().focus()
    fireEvent.click(row())
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))) })
    const [online, away] = screen.getAllByRole('menuitemradio')
    expect(document.activeElement).toBe(online)
    fireEvent.keyDown(online, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(away)
    fireEvent.keyDown(away, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(online)
    fireEvent.keyDown(online, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'menu.logOut' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(row())
  })

  it('sets presence from a menu item, keeping the status message, then closes', () => {
    statusMessage = 'Busy'
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    fireEvent.click(row())
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'presence.away' }))
    expect(setPresence).toHaveBeenCalledWith('away', 'Busy')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('saves a trimmed status message', () => {
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    fireEvent.click(row())
    fireEvent.change(screen.getByLabelText('presence.statusMessage'), { target: { value: '  Lunch ' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    expect(setPresence).toHaveBeenCalledWith('online', 'Lunch')
  })

  it('opens the profile from the menu', () => {
    const onOpenProfile = vi.fn()
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={onOpenProfile} />)
    fireEvent.click(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.viewProfile' }))
    expect(onOpenProfile).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('logs out only after confirming', () => {
    const onLogout = vi.fn()
    render(<AccountMenu onLogout={onLogout} onOpenProfile={vi.fn()} />)
    fireEvent.click(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'menu.logOut' }))
    expect(onLogout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'menu.disconnect' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  it('opens as a bottom sheet on a phone, without console and shortcut entries', () => {
    mobile = true
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    fireEvent.click(row())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'menu.logOut' })).toBeInTheDocument()
    expect(screen.queryByText('menu.keyboardShortcuts')).not.toBeInTheDocument()
    expect(screen.queryByText('menu.showConsole')).not.toBeInTheDocument()
  })
})

describe('AccountMenu console gating', () => {
  it('hides the console toggle when advanced mode is off and shows it when on', () => {
    const { unmount } = render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    fireEvent.click(row())
    expect(screen.queryByText('menu.showConsole')).not.toBeInTheDocument()
    unmount()
    act(() => useModalStore.getState().close('presenceMenu'))
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    fireEvent.click(row())
    expect(screen.getByText('menu.showConsole')).toBeInTheDocument()
  })

  it('closes the console when advanced mode is turned off while it is open', () => {
    consoleIsOpen = true
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    expect(toggleConsoleSpy).not.toHaveBeenCalled()
    act(() => useAdvancedModeStore.getState().setAdvancedMode(false))
    expect(toggleConsoleSpy).toHaveBeenCalledTimes(1)
  })
})

// The captain's rulings on review R1 and R3: Escape closes the menu and goes no further,
// and with stacked overlays it closes only the one on top.
describe('AccountMenu Escape', () => {
  it('closes shortcut help opened over it first, then closes and consumes Escape', () => {
    const closeHelp = vi.fn()
    const windowKeydown = vi.fn()
    const Page = ({ help }: { help: boolean }) => (
      <>
        <AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />
        {help && <EscapeModal onClose={closeHelp} />}
      </>
    )
    const { rerender } = render(<Page help={false} />)
    fireEvent.click(row())
    rerender(<Page help />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
    expect(screen.getByText('menu.about')).toBeInTheDocument()
    rerender(<Page help={false} />)
    window.addEventListener('keydown', windowKeydown)
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByText('menu.about')).not.toBeInTheDocument()
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })
})

describe('AccountMenu connection states', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the presence line during the grace window, then shows the reconnect line', () => {
    store.setState({ status: 'reconnecting' })
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 500))
    expect(row().textContent).toContain('presence.online')
    expect(row().querySelector('.animate-spin')).toBeNull()
    act(() => vi.advanceTimersByTime(500))
    expect(row().querySelector('.animate-spin')).not.toBeNull()
    expect(row().textContent).toContain('status.reconnecting')
  })

  it('never flashes when the connection recovers within the grace window', () => {
    store.setState({ status: 'reconnecting' })
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 500))
    act(() => store.setState({ status: 'online' }))
    act(() => vi.advanceTimersByTime(10_000))
    expect(row().textContent).toContain('presence.online')
    expect(row().querySelector('.animate-spin')).toBeNull()
  })

  it('gives every flapping drop a full fresh grace window', () => {
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    act(() => store.setState({ status: 'reconnecting' }))
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 200))
    act(() => store.setState({ status: 'online' }))
    act(() => store.setState({ status: 'reconnecting' }))
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS - 200))
    expect(row().textContent).toContain('presence.online')
    act(() => vi.advanceTimersByTime(200))
    expect(row().textContent).toContain('status.reconnecting')
  })

  it('surfaces a stalled post-wake verification while status stays online', () => {
    store.setState({ isVerifying: true })
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    expect(row().querySelector('.animate-spin')).toBeNull()
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS))
    expect(row().textContent).toContain('status.verifying')
  })

  it.each([
    ['error', 'status.connectionError'],
    ['disconnected', 'status.disconnected'],
  ])('shows terminal state %s at once', (status, text) => {
    store.setState({ status })
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    expect(row().textContent).toContain(text)
  })

  it('ticks the retry countdown each second and saturates at zero', () => {
    store.setState({ status: 'reconnecting', reconnectTargetTime: Date.now() + DEGRADED_STATUS_GRACE_MS + 5000, reconnectAttempt: 2 })
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS))
    expect(row().textContent).toContain('"seconds":5')
    expect(row().textContent).toContain('"attempt":2')
    act(() => vi.advanceTimersByTime(2000))
    expect(row().textContent).toContain('"seconds":3')
    act(() => vi.advanceTimersByTime(10_000))
    expect(row().textContent).toContain('"seconds":0')
  })

  it('offers Cancel reconnection beside the row, and keeps log out reachable with presence disabled', () => {
    store.setState({ status: 'reconnecting' })
    render(<AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'status.cancelReconnection' })).toBeNull()
    act(() => vi.advanceTimersByTime(DEGRADED_STATUS_GRACE_MS))
    fireEvent.click(screen.getByRole('button', { name: 'status.cancelReconnection' }))
    expect(cancelReconnect).toHaveBeenCalledTimes(1)
    fireEvent.click(row())
    for (const radio of screen.getAllByRole('menuitemradio')) expect(radio).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'menu.logOut' })).toBeEnabled()
  })

  it('ignores reconnect-metadata churn while healthy', () => {
    let commits = 0
    render(
      <Profiler id="row" onRender={() => commits++}>
        <AccountMenu onLogout={vi.fn()} onOpenProfile={vi.fn()} />
      </Profiler>,
    )
    const baseline = commits
    act(() => store.setState({ reconnectTargetTime: Date.now() + 5000, reconnectAttempt: 1 }))
    act(() => store.setState({ reconnectTargetTime: null, reconnectAttempt: 0 }))
    expect(commits).toBe(baseline)
  })
})
