import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

const mockConnect = vi.fn()

// Mock the SDK hooks
const mockUseConnection = vi.fn(() => ({
    status: 'offline',
    error: null as string | null,
    connect: mockConnect,
}))

const mockDeleteFastToken = vi.fn()

// LoginScreen now reads status/error via useConnectionStatus() and the connect
// action via useConnectionActions(). Both are driven from the single
// mockUseConnection fixture so existing test cases keep setting one object.
vi.mock('@fluux/sdk', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@fluux/sdk')>()),
    useConnectionStatus: () => {
        const { status, error } = mockUseConnection()
        return { status, error }
    },
    useConnectionActions: () => ({ connect: mockUseConnection().connect }),
    deleteFastToken: (...args: unknown[]) => mockDeleteFastToken(...args),
    classifyConnectionError: (error: string) => {
        if (!error) return 'unknown'
        const m = error.match(/tls-error[:\s]+([a-z][a-z-]*)/i)
        if (m) {
            const c = m[1].toLowerCase()
            if (c.startsWith('certificate')) return 'tls-certificate'
            if (c === 'timeout') return 'timeout'
            if (c === 'refused') return 'connection-refused'
            return 'tls-other'
        }
        const lower = error.toLowerCase()
        if (lower.includes('not-authorized') || lower.includes('authentication failed')) return 'auth'
        return 'unknown'
    },
    extractTransportErrorClass: (text: string) => {
        const m = text.match(/tls-error[:\s]+([a-z][a-z-]*)/i)
        return m ? m[1].toLowerCase() : null
    },
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) => {
            if (opts) return `${key}:${JSON.stringify(opts)}`
            return key
        },
        i18n: { language: 'en', changeLanguage: vi.fn() },
    }),
}))

// Mock useLoginPrefillDeepLink — no-op in unit tests (desktop-only Tauri hook)
vi.mock('@/hooks/useLoginPrefillDeepLink', () => ({
    useLoginPrefillDeepLink: vi.fn(),
}))

// Mock hooks
vi.mock('@/hooks', () => ({
    useWindowDrag: () => ({
        dragRegionProps: {},
    }),
}))

// Mock useSessionPersistence
vi.mock('@/hooks/useSessionPersistence', () => ({
    saveSession: vi.fn(),
}))

// Mock utils
vi.mock('@/utils/xmppResource', () => ({
    getResource: () => 'test-resource',
}))

const { mockGetDomainFromJid, mockGetWebsocketUrlForDomain } = vi.hoisted(() => ({
    mockGetDomainFromJid: vi.fn(),
    mockGetWebsocketUrlForDomain: vi.fn(),
}))

vi.mock('@/utils/keychain', () => ({
    hasSavedCredentials: () => false,
    getCredentials: vi.fn(),
    saveCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
}))

vi.mock('@/utils/tauri', () => ({
    isTauri: () => false,
}))

vi.mock('@/config/wellKnownServers', () => ({
    getDomainFromJid: (...args: unknown[]) => mockGetDomainFromJid(...args),
    getWebsocketUrlForDomain: (...args: unknown[]) => mockGetWebsocketUrlForDomain(...args),
}))

describe('LoginScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        mockConnect.mockResolvedValue(undefined)
        mockGetDomainFromJid.mockReturnValue(null)
        mockGetWebsocketUrlForDomain.mockReturnValue(null)
        // Reset to default offline state
        mockUseConnection.mockReturnValue({
            status: 'offline',
            error: null,
            connect: mockConnect,
        })
        // Reset advanced mode so tests don't leak into each other
        useAdvancedModeStore.setState({ advancedMode: false })
    })

    describe('rendering', () => {
        it('should render login form with JID and password fields', () => {
            render(<LoginScreen />)

            expect(screen.getByLabelText('login.jidLabel')).toBeInTheDocument()
            expect(screen.getByLabelText('login.passwordLabel')).toBeInTheDocument()
        })

        it('should hide server field by default', () => {
            render(<LoginScreen />)

            // Server label and input should not be rendered by default
            expect(screen.queryByText('login.serverLabel')).not.toBeInTheDocument()
            expect(screen.queryByPlaceholderText('login.serverPlaceholder')).not.toBeInTheDocument()
        })

        it('should show server field when advanced mode is toggled via kebab', async () => {
            render(<LoginScreen />)

            // Open the kebab menu and click Advanced mode
            fireEvent.click(screen.getByRole('button', { name: 'common.options' }))
            fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'login.advancedMode' }))

            // Server input should now be visible
            expect(await screen.findByPlaceholderText('login.serverPlaceholder')).toBeInTheDocument()
        })

        it('should render connect button', () => {
            render(<LoginScreen />)

            expect(screen.getByRole('button', { name: 'login.connect' })).toBeInTheDocument()
        })

        it('should reveal server field on non-auth connection error', () => {
            mockUseConnection.mockReturnValue({
                status: 'error',
                error: 'Connection refused',
                connect: vi.fn(),
            })

            render(<LoginScreen />)

            // Server input should be automatically revealed for non-auth errors
            expect(screen.getByPlaceholderText('login.serverPlaceholder')).toBeInTheDocument()
        })

        it('should not reveal server field on auth error', () => {
            mockUseConnection.mockReturnValue({
                status: 'error',
                error: 'Authentication failed',
                connect: vi.fn(),
            })

            render(<LoginScreen />)

            // Server input should remain hidden for auth errors
            expect(screen.queryByPlaceholderText('login.serverPlaceholder')).not.toBeInTheDocument()
        })
    })

    describe('password visibility toggle', () => {
        it('should render password field with type="password" by default', () => {
            render(<LoginScreen />)

            const passwordInput = screen.getByLabelText('login.passwordLabel')
            expect(passwordInput).toHaveAttribute('type', 'password')
        })

        it('should render toggle button with show password label', () => {
            render(<LoginScreen />)

            const toggleButton = screen.getByRole('button', { name: 'login.showPassword' })
            expect(toggleButton).toBeInTheDocument()
        })

        it('should toggle password visibility when clicking the toggle button', () => {
            render(<LoginScreen />)

            const passwordInput = screen.getByLabelText('login.passwordLabel')
            const toggleButton = screen.getByRole('button', { name: 'login.showPassword' })

            // Initially password is hidden
            expect(passwordInput).toHaveAttribute('type', 'password')

            // Click to show password
            fireEvent.click(toggleButton)
            expect(passwordInput).toHaveAttribute('type', 'text')

            // Button label should now be "hide password"
            expect(screen.getByRole('button', { name: 'login.hidePassword' })).toBeInTheDocument()

            // Click again to hide password
            fireEvent.click(screen.getByRole('button', { name: 'login.hidePassword' }))
            expect(passwordInput).toHaveAttribute('type', 'password')

            // Button label should be back to "show password"
            expect(screen.getByRole('button', { name: 'login.showPassword' })).toBeInTheDocument()
        })

        it('should keep password value when toggling visibility', () => {
            render(<LoginScreen />)

            const passwordInput = screen.getByLabelText('login.passwordLabel')
            const toggleButton = screen.getByRole('button', { name: 'login.showPassword' })

            // Enter a password
            fireEvent.change(passwordInput, { target: { value: 'mySecretPassword' } })
            expect(passwordInput).toHaveValue('mySecretPassword')

            // Toggle to show
            fireEvent.click(toggleButton)
            expect(passwordInput).toHaveValue('mySecretPassword')

            // Toggle to hide
            fireEvent.click(screen.getByRole('button', { name: 'login.hidePassword' }))
            expect(passwordInput).toHaveValue('mySecretPassword')
        })

        it('should disable toggle button when connecting', () => {
            mockUseConnection.mockReturnValue({
                status: 'connecting',
                error: null,
                connect: vi.fn(),
            })

            render(<LoginScreen />)

            const toggleButton = screen.getByRole('button', { name: 'login.showPassword' })
            expect(toggleButton).toBeDisabled()
        })

        it('should not be focusable via tab navigation', () => {
            render(<LoginScreen />)

            const toggleButton = screen.getByRole('button', { name: 'login.showPassword' })
            expect(toggleButton).toHaveAttribute('tabIndex', '-1')
        })
    })

    describe('server resolution priority', () => {
        it('should prefer well-known websocket URL when server field is empty', async () => {
            mockGetDomainFromJid.mockReturnValue('process-one.net')
            mockGetWebsocketUrlForDomain.mockReturnValue('wss://chat.process-one.net/xmpp')

            render(<LoginScreen />)

            fireEvent.change(screen.getByLabelText('login.jidLabel'), { target: { value: 'alice@process-one.net' } })
            fireEvent.change(screen.getByLabelText('login.passwordLabel'), { target: { value: 'secret' } })
            fireEvent.click(screen.getByRole('button', { name: 'login.connect' }))

            await waitFor(() => {
                expect(mockConnect).toHaveBeenCalledWith(
                    'alice@process-one.net',
                    'secret',
                    'wss://chat.process-one.net/xmpp',
                    undefined,
                    'test-resource',
                    'en',
                    false,
                    false
                )
            })
        })

        it('should keep explicit server input over well-known mapping', async () => {
            mockGetDomainFromJid.mockReturnValue('process-one.net')
            mockGetWebsocketUrlForDomain.mockReturnValue('wss://chat.process-one.net/xmpp')

            render(<LoginScreen />)

            fireEvent.change(screen.getByLabelText('login.jidLabel'), { target: { value: 'alice@process-one.net' } })
            await waitFor(() => {
                expect(screen.getByPlaceholderText('login.serverPlaceholder')).toBeInTheDocument()
            })
            fireEvent.change(screen.getByLabelText('login.passwordLabel'), { target: { value: 'secret' } })
            fireEvent.change(screen.getByPlaceholderText('login.serverPlaceholder'), { target: { value: 'chat.custom.net' } })
            fireEvent.click(screen.getByRole('button', { name: 'login.connect' }))

            await waitFor(() => {
                expect(mockConnect).toHaveBeenCalledWith(
                    'alice@process-one.net',
                    'secret',
                    'chat.custom.net',
                    undefined,
                    'test-resource',
                    'en',
                    false,
                    false
                )
            })
        })
    })

    describe('server persistence on submit', () => {
        it('should store resolved domain when server field is empty', async () => {
            // Domain not in well-known list, so resolveServerForConnection falls back to bare domain
            mockGetDomainFromJid.mockReturnValue('chat.example.com')
            mockGetWebsocketUrlForDomain.mockReturnValue(null)

            render(<LoginScreen />)

            fireEvent.change(screen.getByLabelText('login.jidLabel'), { target: { value: 'alice@chat.example.com' } })
            fireEvent.change(screen.getByLabelText('login.passwordLabel'), { target: { value: 'secret' } })
            fireEvent.click(screen.getByRole('button', { name: 'login.connect' }))

            await waitFor(() => {
                expect(mockConnect).toHaveBeenCalled()
            })

            // Should store the domain (from resolveServerForConnection), not empty string
            expect(localStorage.getItem('xmpp-last-server')).toBe('chat.example.com')
        })

        it('should store well-known WebSocket URL when available', async () => {
            mockGetDomainFromJid.mockReturnValue('process-one.net')
            mockGetWebsocketUrlForDomain.mockReturnValue('wss://chat.process-one.net/xmpp')

            render(<LoginScreen />)

            fireEvent.change(screen.getByLabelText('login.jidLabel'), { target: { value: 'alice@process-one.net' } })
            fireEvent.change(screen.getByLabelText('login.passwordLabel'), { target: { value: 'secret' } })
            fireEvent.click(screen.getByRole('button', { name: 'login.connect' }))

            await waitFor(() => {
                expect(mockConnect).toHaveBeenCalled()
            })

            expect(localStorage.getItem('xmpp-last-server')).toBe('wss://chat.process-one.net/xmpp')
        })

        it('should store explicit server input as-is', async () => {
            mockGetDomainFromJid.mockReturnValue('example.com')
            mockGetWebsocketUrlForDomain.mockReturnValue(null)

            render(<LoginScreen />)

            fireEvent.change(screen.getByLabelText('login.jidLabel'), { target: { value: 'alice@example.com' } })
            fireEvent.change(screen.getByLabelText('login.passwordLabel'), { target: { value: 'secret' } })
            // Show and fill server field via the kebab menu
            fireEvent.click(screen.getByRole('button', { name: 'common.options' }))
            fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'login.advancedMode' }))
            const serverInput = await screen.findByPlaceholderText('login.serverPlaceholder')
            fireEvent.change(serverInput, { target: { value: 'wss://custom.example.com/ws' } })
            fireEvent.click(screen.getByRole('button', { name: 'login.connect' }))

            await waitFor(() => {
                expect(mockConnect).toHaveBeenCalled()
            })

            expect(localStorage.getItem('xmpp-last-server')).toBe('wss://custom.example.com/ws')
        })
    })

    describe('LoginErrorPanel integration', () => {
        it('renders the structured cert panel for a TLS certificate error', () => {
            mockUseConnection.mockReturnValue({
                status: 'error',
                error: 'Bridge closed: tls-error certificate-expired',
                connect: mockConnect,
            })
            render(<LoginScreen />)
            expect(screen.getByRole('alert')).toBeInTheDocument()
            expect(screen.getByText('login.errors.tlsCertTitle')).toBeInTheDocument()
        })

        it('renders the raw string (no alert role) for an unknown connection error', () => {
            mockUseConnection.mockReturnValue({
                status: 'error',
                error: 'WebSocket ECONNERROR',
                connect: mockConnect,
            })
            render(<LoginScreen />)
            expect(screen.getByText('WebSocket ECONNERROR')).toBeInTheDocument()
            expect(screen.queryByRole('alert')).toBeNull()
        })
    })

    describe('FAST token cleanup on auth error', () => {
        it('should delete FAST token on authentication error', () => {
            localStorage.setItem('xmpp-last-jid', 'user@example.com')

            mockUseConnection.mockReturnValue({
                status: 'error',
                error: 'not-authorized: invalid credentials',
                connect: mockConnect,
            })

            render(<LoginScreen />)

            expect(mockDeleteFastToken).toHaveBeenCalledWith('user@example.com')
        })

        it('should NOT delete FAST token on non-auth connection errors', () => {
            localStorage.setItem('xmpp-last-jid', 'user@example.com')

            mockUseConnection.mockReturnValue({
                status: 'error',
                error: 'Connection refused',
                connect: mockConnect,
            })

            render(<LoginScreen />)

            expect(mockDeleteFastToken).not.toHaveBeenCalled()
        })

        it('should not crash when no saved JID exists', () => {
            mockUseConnection.mockReturnValue({
                status: 'error',
                error: 'not-authorized: bad password',
                connect: mockConnect,
            })

            // No xmpp-last-jid in localStorage
            expect(() => render(<LoginScreen />)).not.toThrow()
        })
    })
})

describe('LoginScreen prefill', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        useLoginPrefillStore.getState().clearPrefill()
        mockGetDomainFromJid.mockReturnValue(null)
        mockGetWebsocketUrlForDomain.mockReturnValue(null)
        mockConnect.mockResolvedValue(undefined)
        mockUseConnection.mockReturnValue({
            status: 'offline',
            error: null,
            connect: mockConnect,
        })
        // Reset advanced mode so tests don't leak into each other
        useAdvancedModeStore.setState({ advancedMode: false })
    })

    it('seeds the JID field from a prefill', async () => {
        useLoginPrefillStore.getState().setPrefill({ jid: 'alice@example.com' })
        const { container } = render(<LoginScreen />)
        const jidInput = container.querySelector('#jid')
        await waitFor(() => expect((jidInput as HTMLInputElement).value).toBe('alice@example.com'))
        // prefill is one-shot: cleared after consumption
        expect(useLoginPrefillStore.getState().prefill).toBeNull()
    })

    it('reveals the server field and shows the custom-server note', async () => {
        useLoginPrefillStore.getState().setPrefill({
            jid: 'alice@example.com',
            server: 'wss://custom.example.com:5443/ws',
        })
        const { container } = render(<LoginScreen />)
        const serverInput = container.querySelector('#server')
        await waitFor(() =>
            expect((serverInput as HTMLInputElement).value).toBe('wss://custom.example.com:5443/ws')
        )
        // host shown in the calm note
        expect(await screen.findByText(/custom\.example\.com/)).toBeTruthy()
    })

    it('reveals the field and shows the note for a native (bare-domain) server', async () => {
        useLoginPrefillStore.getState().setPrefill({
            jid: 'alice@example.com',
            server: 'process-one.net',
        })
        const { container } = render(<LoginScreen />)
        const serverInput = container.querySelector('#server')
        await waitFor(() =>
            expect((serverInput as HTMLInputElement).value).toBe('process-one.net')
        )
        // host shown in the calm note even though the value is not a URL
        expect(await screen.findByText(/process-one\.net/)).toBeTruthy()
    })

    it('lets a prefill JID override the localStorage seed', async () => {
        localStorage.setItem('xmpp-last-jid', 'old@example.com')
        useLoginPrefillStore.getState().setPrefill({ jid: 'new@example.com' })
        const { container } = render(<LoginScreen />)
        const jidInput = container.querySelector('#jid')
        await waitFor(() => expect((jidInput as HTMLInputElement).value).toBe('new@example.com'))
    })
})

describe('LoginScreen — Aurora branding', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
    mockUseConnection.mockReturnValue({ status: 'offline', error: null, connect: mockConnect })
  })

  it('renders the aurora glass mark + display-font heading (no flat logo img)', () => {
    render(<LoginScreen />)
    // display-font heading
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.className).toMatch(/font-display/)
    // the brand mark is the AuroraMark svg — no <img>, no legacy gradient tile
    expect(screen.queryByRole('img')).toBeNull()
    expect(document.querySelector('svg.aurora-mark')).not.toBeNull()
    expect(document.querySelector('[style*="--fluux-grad"]')).toBeNull()
  })
})

describe('LoginScreen — advanced-mode kebab', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
    mockUseConnection.mockReturnValue({ status: 'offline', error: null, connect: mockConnect })
  })

  it('renders the kebab and hides the server field by default', () => {
    render(<LoginScreen />)
    expect(screen.getByRole('button', { name: 'common.options' })).toBeInTheDocument()
    expect(screen.queryByText('login.serverLabel')).not.toBeInTheDocument()
    // The old inline advanced-mode checkbox is gone.
    expect(document.querySelector('#advanced-mode')).toBeNull()
  })

  it('reveals the server field when advanced mode is enabled via the kebab', async () => {
    render(<LoginScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'common.options' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'login.advancedMode' }))

    await waitFor(() => {
      expect(screen.getByText('login.serverLabel')).toBeInTheDocument()
    })
    expect(useAdvancedModeStore.getState().advancedMode).toBe(true)
  })
})
