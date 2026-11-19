import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TrustStateCompromisedBanner } from './TrustStateCompromisedBanner'
import { setOpenPGPTrustView, type OpenPGPTrustView } from '@/e2ee/openpgpTrustView'
import { useToastStore } from '@/stores/toastStore'
import type { TrustStateVerdict } from '@fluux/openpgp-plugin'

// Mock react-i18next — returns the key as the translation (avoids missing-key fallback noise)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}))

// The OpenPGP plugin the banner asks to seal the trust state again, if any.
const sdk = vi.hoisted(() => ({ plugin: null as { resealTrustState(): Promise<void> } | null }))

// Mock @fluux/sdk — only useXMPPContext is needed by this component
vi.mock('@fluux/sdk', () => ({
  useXMPPContext: () => ({
    client: { e2ee: { getPlugin: () => sdk.plugin } },
  }),
}))

/** A plugin trust view whose verdict the test sets, as the plugin reports it. */
function pluginWithVerdict(initial: TrustStateVerdict) {
  let verdict = initial
  const listeners = new Set<(peers: readonly string[] | null) => void>()
  const view: OpenPGPTrustView = {
    getTrustState: () => verdict,
    getOwnKeyConflict: () => null,
    getKeyDecisions: () => ({}),
    subscribeTrustView: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  setOpenPGPTrustView(view, { onConversationSecurityChanged: () => () => {} })
  return {
    report(next: TrustStateVerdict) {
      verdict = next
      listeners.forEach((listener) => listener([]))
    },
  }
}

afterEach(() => {
  setOpenPGPTrustView(null)
  sdk.plugin = null
  useToastStore.setState({ toasts: [] })
})

const silent: TrustStateVerdict['status'][] = ['uninitialized', 'sealed', 'pending-seal', 'awaiting-key']

describe('TrustStateCompromisedBanner', () => {
  it.each(silent)('renders nothing for status %s', (status) => {
    pluginWithVerdict({ status })
    const { container } = render(<TrustStateCompromisedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing before the plugin registers', () => {
    const { container } = render(<TrustStateCompromisedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the warning when the plugin reports the trust state compromised', () => {
    const plugin = pluginWithVerdict({ status: 'sealed' })
    render(<TrustStateCompromisedBanner />)
    expect(screen.queryByText('Trust state integrity check failed')).not.toBeInTheDocument()
    act(() => plugin.report({ status: 'compromised', details: ['verified peers differ'] }))
    expect(screen.getByText('Trust state integrity check failed')).toBeInTheDocument()
  })

  it('tells the person why the plugin refused to seal the trust state again', async () => {
    // As the plugin refuses while trust data of an earlier version waits to be moved.
    const refusal = new Error(
      'SequoiaPgpPlugin: trust decisions cannot be saved until the trust data of an earlier version is moved; restart the app to try again',
    )
    sdk.plugin = { resealTrustState: () => Promise.reject(refusal) }
    pluginWithVerdict({ status: 'compromised', details: ['trust decisions differ'] })
    render(<TrustStateCompromisedBanner />)
    const button = screen.getByRole('button', { name: 'Re-verify and continue' })
    fireEvent.click(button)
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'error', message: refusal.message })]),
    )
    expect(screen.getByRole('button', { name: 'Re-verify and continue' })).toBeEnabled()
  })
})
