import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'

// Mock the SDK hooks
const mockUseConnection = vi.fn(() => ({
    status: 'offline',
    error: null,
    connect: vi.fn(),
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
    getDomainFromJid: () => null,
    getWebsocketUrlForDomain: () => null,
}))

describe('LoginScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        // Reset to default offline state
        mockUseConnection.mockReturnValue({
            status: 'offline',
            error: null,
            connect: vi.fn(),
        })
    })

    describe('rendering', () => {
        it('should render login form with all fields', () => {
            render(<LoginScreen />)

            expect(screen.getByLabelText('login.jidLabel')).toBeInTheDocument()
            expect(screen.getByLabelText('login.passwordLabel')).toBeInTheDocument()
            expect(screen.getByLabelText('login.serverLabel')).toBeInTheDocument()
        })

        it('should render connect button', () => {
            render(<LoginScreen />)

            expect(screen.getByRole('button', { name: 'login.connect' })).toBeInTheDocument()
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
})
