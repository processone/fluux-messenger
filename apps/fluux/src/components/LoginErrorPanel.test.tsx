import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoginErrorPanel } from './LoginErrorPanel'

// t returns the key so we can assert on which key was chosen.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

vi.mock('@fluux/sdk', () => ({
  extractTransportErrorClass: (text: string) => {
    const m = text.match(/tls-error[:\s]+([a-z][a-z-]*)/i)
    return m ? m[1].toLowerCase() : null
  },
}))

describe('LoginErrorPanel', () => {
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
})
