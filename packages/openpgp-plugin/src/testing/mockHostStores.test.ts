/** The shared host-store contract, run against the in-memory host the package's own tests use. */
import { runHostStoresContract } from './hostStoresContract'
import { createMockHostStores } from './mockHostStores'

runHostStoresContract('mock host stores', () => {
  const mock = createMockHostStores()
  return {
    stores: mock,
    seedKeyChangeAlert: (jid, alert) => mock.setKeyChangeAlerts({ ...mock.keyChangeAlerts.getAll(), [jid]: alert }),
    trustStateDetails: mock.trustStateDetails,
    peerKeysetNotifications: mock.peerKeysetNotifications,
  }
})
