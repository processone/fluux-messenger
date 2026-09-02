// @vitest-environment jsdom
import { useEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AnomalyInstaller from './AnomalyInstaller'

const runtime = vi.hoisted(() => {
  const client = { id: 'client' }
  return {
    client,
    events: [] as string[],
    install: vi.fn(),
  }
})

vi.mock('@fluux/sdk', () => ({
  useXMPPContext: () => ({ client: runtime.client }),
}))

vi.mock('./install', () => ({
  install: (client: unknown) => runtime.install(client),
}))

function ConnectionOwner(): null {
  useEffect(() => {
    runtime.events.push('child-mounted')
  }, [])
  return null
}

beforeEach(() => {
  runtime.events.length = 0
  runtime.install.mockReset()
  runtime.install.mockImplementation(() => {
    runtime.events.push('installed')
    return () => runtime.events.push('detached')
  })
})

afterEach(cleanup)

describe('AnomalyInstaller', () => {
  it('attaches before mounting a connection-owning child', async () => {
    const view = render(
      <AnomalyInstaller>
        <ConnectionOwner />
      </AnomalyInstaller>,
    )

    await waitFor(() => expect(runtime.events).toEqual(['installed', 'child-mounted']))
    expect(runtime.install).toHaveBeenCalledWith(runtime.client)

    view.unmount()
    expect(runtime.events).toEqual(['installed', 'child-mounted', 'detached'])
  })
})
