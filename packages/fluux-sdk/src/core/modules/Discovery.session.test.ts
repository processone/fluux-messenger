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

  it.each(['service-unavailable', 'feature-not-implemented'])('retains domain features after the account explicitly rejects disco: %s', async condition => {
    const refusal = Object.assign(new Error(condition), { name: 'StanzaError' })
    sendIQ.mockResolvedValueOnce(response(['urn:xmpp:carbons:2'])).mockRejectedValueOnce(refusal)
    await discovery.fetchServerInfo()
    expect(published()).toHaveLength(1)
    expect(published()[0][1].info.features).toEqual(['urn:xmpp:carbons:2'])
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'TimeoutError', message: 'IQ timeout' },
    { name: 'Error', message: 'connection lost' },
  ])('keeps $name account transport failures unknown', async failure => {
    sendIQ.mockResolvedValueOnce(response(['urn:xmpp:carbons:2']))
      .mockRejectedValueOnce(Object.assign(new Error(failure.message), { name: failure.name }))
    await discovery.fetchServerInfo()
    expect(published()).toEqual([])
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })

  it('does not apply the account refusal policy to domain discovery', async () => {
    sendIQ.mockRejectedValueOnce(Object.assign(new Error('service-unavailable'), { name: 'StanzaError' }))
    await discovery.fetchServerInfo()
    expect(published()).toEqual([])
    expect(sendIQ).toHaveBeenCalledTimes(1)
  })

  it('drops an explicit account refusal after its session is replaced', async () => {
    let reject!: (error: Error) => void
    const account = new Promise<Element>((_resolve, fail) => { reject = fail })
    sendIQ.mockResolvedValueOnce(response(['urn:xmpp:carbons:2'])).mockReturnValueOnce(account)
    const done = discovery.fetchServerInfo()
    await vi.waitFor(() => expect(sendIQ).toHaveBeenCalledTimes(2))
    discovery.resetSessionCache()
    reject(Object.assign(new Error('service-unavailable'), { name: 'StanzaError' }))
    await done
    expect(published()).toEqual([])
  })
})
