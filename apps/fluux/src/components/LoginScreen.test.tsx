import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'

const mockConnect = vi.fn()

// Mock the SDK hooks
const mockUseConnection = vi.fn(() => ({
    status: 'offline',
    error: null as string | null,
    connect: mockConnect,
}))

vi.mock('@fluux/sdk', () => ({
    useConnection: () => mockUseConnection(),
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
        i18n: { language: 'en' },
    }),
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
    })

    describe('rendering', () => {
        it('should render login form with JID and password fields', () => {
            render(<LoginScreen />)

            expect(screen.getByLabelText('login.jidLabel')).toBeInTheDocument()
            expect(screen.getByLabelText('login.passwordLabel')).toBeInTheDocument()
        })

        it('should hide server field by default', () => {
            render(<LoginScreen />)

            // Server toggle button should be visible
            expect(screen.getByText('login.serverLabel')).toBeInTheDocument()
            // But the server input should not be rendered
            expect(screen.queryByPlaceholderText('login.serverPlaceholder')).not.toBeInTheDocument()
        })

        it('should show server field when toggle is clicked', () => {
            render(<LoginScreen />)

            // Click the server toggle button
            fireEvent.click(screen.getByText('login.serverLabel'))

            // Server input should now be visible
            expect(screen.getByPlaceholderText('login.serverPlaceholder')).toBeInTheDocument()
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
                    false
                )
            })
        })
    })
})
