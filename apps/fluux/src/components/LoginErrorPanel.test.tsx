import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import en from '../i18n/locales/en.json'
import fr from '../i18n/locales/fr.json'
import { LoginErrorPanel } from './LoginErrorPanel'

const { language } = vi.hoisted(() => ({ language: { current: 'en' } }))
// Resolve discovery strings to verify interpolation; keep other assertions key-based.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, values?: Record<string, string>) => {
    if (!k.includes('discoveryFailed')) return k
    const strings = language.current === 'fr' ? fr : en
    const key = k.endsWith('Tcp') ? 'discoveryFailedTcp' : 'discoveryFailed'
    return strings.login.errors[key].replace(/{{(\w+)}}/g, (_match, name) => values?.[name] ?? '')
  }, i18n: { language: 'en' } }),
}))

vi.mock('@fluux/sdk', () => ({
  extractTransportErrorClass: (text: string) => {
    const m = text.match(/tls-error[:\s]+([a-z][a-z-]*)/i)
    return m ? m[1].toLowerCase() : null
  },
}))

describe('LoginErrorPanel', () => {
  it.each(['auth', 'unknown', 'timeout', 'connection-refused', 'tls-certificate', 'tls-other'] as const)(
    'shows the discovery hint alongside a %s error', (kind) => {
      language.current = 'en'
      render(<LoginErrorPanel kind={kind} rawError="Connection failed" discoveryFailure={{
        domain: 'example.com', target: 'wss://fallback.example/ws', transport: 'websocket',
      }} />)
      expect(screen.getByText('Server discovery for example.com failed. Tried wss://fallback.example/ws instead.')).toBeInTheDocument()
    }
  )

  it('localizes the native TCP fallback in French', () => {
    language.current = 'fr'
    render(<LoginErrorPanel kind="unknown" rawError="Connection failed" discoveryFailure={{
      domain: 'example.com', target: 'example.com', transport: 'native-tcp',
    }} />)
    expect(screen.getByText('La découverte du serveur example.com a échoué. Une connexion TCP native à example.com a été tentée à la place.')).toBeInTheDocument()
  })

  it('omits the hint when discovery did not fail', () => {
    render(<LoginErrorPanel kind="unknown" rawError="Connection failed" />)
    expect(screen.queryByText(/discovery|découverte/)).toBeNull()
  })

  it('renders the raw error string for an unknown kind (no structured panel)', () => {
    render(<LoginErrorPanel kind="unknown" rawError="WebSocket ECONNERROR" />)
    expect(screen.getByText('WebSocket ECONNERROR')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the raw error string for an auth kind', () => {
    render(<LoginErrorPanel kind="auth" rawError="not-authorized" />)
    expect(screen.getByText('not-authorized')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the cert title and the expired sub-body for an expired cert', () => {
    render(<LoginErrorPanel kind="tls-certificate" rawError="Bridge closed: tls-error certificate-expired" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('login.errors.tlsCertTitle')).toBeInTheDocument()
    expect(screen.getByText('login.errors.cert.expired')).toBeInTheDocument()
  })

  it('falls back to the generic cert body when the sub-class is bare', () => {
    render(<LoginErrorPanel kind="tls-certificate" rawError="Bridge closed: tls-error certificate" />)
    expect(screen.getByText('login.errors.cert.generic')).toBeInTheDocument()
  })

  it('renders the unreachable title and refused body for a refused connection', () => {
    render(<LoginErrorPanel kind="connection-refused" rawError="Bridge closed: tls-error refused" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('login.errors.unreachableTitle')).toBeInTheDocument()
    expect(screen.getByText('login.errors.refusedBody')).toBeInTheDocument()
  })

  it('renders the unreachable title and timeout body for a timeout', () => {
    render(<LoginErrorPanel kind="timeout" rawError="Bridge closed: tls-error timeout" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('login.errors.unreachableTitle')).toBeInTheDocument()
    expect(screen.getByText('login.errors.timeoutBody')).toBeInTheDocument()
  })

  it('renders the tls-other title and body for a generic TLS failure', () => {
    render(<LoginErrorPanel kind="tls-other" rawError="Bridge closed: tls-error other" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('login.errors.tlsOtherTitle')).toBeInTheDocument()
    expect(screen.getByText('login.errors.tlsOtherBody')).toBeInTheDocument()
  })
})
