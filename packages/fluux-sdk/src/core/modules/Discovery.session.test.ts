import { beforeEach, describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { Discovery } from './Discovery'
import type { ModuleDependencies } from './BaseModule'
import { NS_DISCO_INFO, NS_MAM } from '../namespaces'

function deferred() {
  let resolve!: (value: Element) => void
  const promise = new Promise<Element>(done => { resolve = done })
  return { promise, resolve }
}
const response = (features: string[]) => xml('iq', { type: 'result' }, xml('query', { xmlns: NS_DISCO_INFO },
  ...features.map(feature => xml('feature', { var: feature }))))

describe('server discovery session ownership', () => {
  let jid: string
  let discovery: Discovery
  let sendIQ: ReturnType<typeof vi.fn<ModuleDependencies['sendIQ']>>
  let emitSDK: ReturnType<typeof vi.fn>
  const published = () => emitSDK.mock.calls.filter(([event]) => event === 'connection:server-info')
  beforeEach(() => {
    jid = 'fixture@example.test/one'
    sendIQ = vi.fn()
    emitSDK = vi.fn()
    discovery = new Discovery({ getCurrentJid: () => jid, sendIQ, emitSDK } as unknown as ModuleDependencies)
  })

  it.each(['session', 'account'] as const)('drops a late domain result after a %s change', async change => {
    const pending = deferred()
    sendIQ.mockReturnValue(pending.promise)
    const done = discovery.fetchServerInfo()
    if (change === 'session') discovery.resetSessionCache()
    else jid = 'other@elsewhere.test/two'
    pending.resolve(response([NS_MAM]))
    await done
    expect(published()).toEqual([])
    expect(sendIQ).toHaveBeenCalledTimes(1)
  })

  it('drops a late account-MAM fallback after its session is replaced', async () => {
    const account = deferred()
    sendIQ.mockResolvedValueOnce(response(['urn:xmpp:ping'])).mockReturnValueOnce(account.promise)
    const done = discovery.fetchServerInfo()
    await vi.waitFor(() => expect(sendIQ).toHaveBeenCalledTimes(2))
    discovery.resetSessionCache()
    account.resolve(response([NS_MAM]))
    await done
    expect(published()).toEqual([])
  })

  it('accepts the current reply without letting an older reply overwrite it', async () => {
    const old = deferred()
    const current = deferred()
    sendIQ.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldDone = discovery.fetchServerInfo()
    discovery.resetSessionCache()
    const currentDone = discovery.fetchServerInfo()
    current.resolve(response([NS_MAM]))
    await currentDone
    old.resolve(response(['urn:xmpp:ping']))
    await oldDone
    expect(published()).toHaveLength(1)
    expect(published()[0][1].info.features).toEqual([NS_MAM])
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })
})
