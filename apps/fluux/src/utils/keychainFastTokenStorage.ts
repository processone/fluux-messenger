import { getBareJid, setDefaultFastTokenStorage, type FastToken, type FastTokenStorageAdapter } from '@fluux/sdk'
import { platform } from '@/platform'
import { keychainSecrets, type SecretStore } from './keychainSecrets'

const LEGACY_PREFIX = 'fluux:fast-token:'
// Written synchronously on delete and cleared once the keychain item is gone:
// the keychain is asynchronous, and a logout must not leave a token that the
// next launch would load back.
const DELETED_PREFIX = 'fluux:fast-token-deleted:'

type LocalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface KeychainFastTokenStorage {
  /** The SDK adapter, answering from the tokens loaded into memory. */
  adapter: FastTokenStorageAdapter
  /**
   * Loads an account's token from the keychain, moving a token left in
   * localStorage by an earlier version there. Call it before the SDK reads
   * the token: the adapter is synchronous.
   */
  load(jid: string): Promise<void>
}

function parse(raw: string | null): FastToken | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as FastToken
  } catch {
    return null
  }
}

function report(action: string) {
  return (err: unknown) => console.warn(`[Fluux] Keychain: FAST token ${action} failed:`, err)
}

export function createKeychainFastTokenStorage(
  secrets: SecretStore,
  storage: LocalStorage = localStorage,
): KeychainFastTokenStorage {
  const tokens = new Map<string, FastToken>()

  const adapter: FastTokenStorageAdapter = {
    getToken: (jid) => tokens.get(jid) ?? null,
    setToken(jid, token) {
      tokens.set(jid, token)
      storage.removeItem(DELETED_PREFIX + jid)
      secrets.set('fast-token', jid, JSON.stringify(token)).catch(report('save'))
    },
    deleteToken(jid) {
      tokens.delete(jid)
      storage.removeItem(LEGACY_PREFIX + jid)
      storage.setItem(DELETED_PREFIX + jid, 'true')
      secrets.delete('fast-token', jid)
        .then(() => storage.removeItem(DELETED_PREFIX + jid))
        .catch(report('delete'))
    },
  }

  async function load(jid: string): Promise<void> {
    if (storage.getItem(DELETED_PREFIX + jid)) {
      tokens.delete(jid)
      storage.removeItem(LEGACY_PREFIX + jid)
      await secrets.delete('fast-token', jid)
      storage.removeItem(DELETED_PREFIX + jid)
      return
    }

    const legacy = parse(storage.getItem(LEGACY_PREFIX + jid))
    if (legacy) {
      tokens.set(jid, legacy)
      await secrets.set('fast-token', jid, JSON.stringify(legacy))
      storage.removeItem(LEGACY_PREFIX + jid)
      return
    }
    storage.removeItem(LEGACY_PREFIX + jid)

    const token = parse(await secrets.get('fast-token', jid))
    if (token) tokens.set(jid, token)
  }

  return {
    adapter,
    load: (jid) => load(jid).catch(report('load')),
  }
}

/**
 * Keeps FAST tokens in the keychain where the platform does, loading the
 * remembered account's token. Await it before the first render: the
 * auto-connect decision reads the token synchronously.
 */
export async function installKeychainFastTokens(storage: LocalStorage = localStorage): Promise<void> {
  if (!platform().keychainSessionSecrets) return
  const keychain = createKeychainFastTokenStorage(keychainSecrets, storage)
  setDefaultFastTokenStorage(keychain.adapter)
  const lastJid = storage.getItem('xmpp-last-jid')
  if (lastJid) await keychain.load(getBareJid(lastJid))
}
