import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TrustStateCompromisedBanner } from './TrustStateCompromisedBanner'
import { useTrustStateStatusStore } from '@/stores/trustStateStatusStore'
import type { TrustStateStatus } from '@/stores/trustStateStatusStore'

// Mock react-i18next — returns the key as the translation (avoids missing-key fallback noise)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}))

// Mock @fluux/sdk — only useXMPPContext is needed by this component
vi.mock('@fluux/sdk', () => ({
  useXMPPContext: () => ({
    client: { e2ee: null },
  }),
}))

beforeEach(() => {
  useTrustStateStatusStore.setState({ status: 'uninitialized', mismatchDetails: undefined })
})

const silent: TrustStateStatus[] = ['uninitialized', 'sealed', 'pending-seal', 'awaiting-key']

describe('TrustStateCompromisedBanner', () => {
  it.each(silent)('renders nothing for status %s', (status) => {
    useTrustStateStatusStore.setState({ status })
    const { container } = render(<TrustStateCompromisedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the warning only for compromised', () => {
    useTrustStateStatusStore.setState({ status: 'compromised' })
    render(<TrustStateCompromisedBanner />)
    expect(screen.getByText('Trust state integrity check failed')).toBeInTheDocument()
  })
})
