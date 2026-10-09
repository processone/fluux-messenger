import { RequestTimeoutError } from '../core/errors'

export const AVATAR_LOOKUP_TIMEOUT_MS = 10_000
const SHORT_RETRY_MS = 5 * 60_000
const FIRST_BACKOFF_MS = 60 * 60_000
const MAX_BACKOFF_MS = 24 * FIRST_BACKOFF_MS

interface Entry { jid: string; attempts: number; retryAfter: number; hash?: string }
interface State { jid: string; hash?: string; entry?: Entry; retryAfter: number; writes: Promise<void> }
const states = new Map<string, Promise<State>>()
let database: Promise<IDBDatabase> | undefined

// Silence has its own cache so legacy definitive no-avatar entries keep their meaning.
async function store(operation: 'read' | 'write' | 'clear', jid = '', entry?: Entry): Promise<Entry | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('fluux-unanswered-lookups', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('jids', { keyPath: 'jid' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const db = await database
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('jids', operation === 'read' ? 'readonly' : 'readwrite')
    const objectStore = transaction.objectStore('jids')
    const request = operation === 'clear' ? objectStore.clear()
      : operation === 'read' ? objectStore.get(jid) : entry ? objectStore.put(entry) : objectStore.delete(jid)
    transaction.oncomplete = () => resolve(operation === 'read' ? request.result : undefined)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function stateFor(jid: string): Promise<State> {
  let state = states.get(jid)
  if (!state) {
    state = store('read', jid).catch(() => undefined).then(entry => ({
      jid, hash: entry?.hash, entry, retryAfter: 0, writes: Promise.resolve(),
    }))
    states.set(jid, state)
  }
  return state
}

function persist(state: State): Promise<void> {
  const entry = state.entry && { ...state.entry }
  // Cache mutations must reach IndexedDB in order, even while storage is opening.
  state.writes = state.writes.then(() => store('write', state.jid, entry)).then(() => {}).catch(() => {})
  return state.writes
}

async function clear(state: State): Promise<void> {
  const hadEntry = state.entry !== undefined
  state.entry = undefined
  state.retryAfter = 0
  if (hadEntry) await persist(state)
}

async function announce(state: State, hash?: string): Promise<void> {
  if (hash === undefined || hash === state.hash) return
  state.hash = hash
  await clear(state)
}

export interface UnansweredLookup {
  allowed(): boolean
  read<T>(query: () => Promise<T>, target?: string): Promise<T>
  answered(): Promise<void>
}

/**
 * The first timeout persists its count with only a five-minute volatile retry.
 * The second persists one hour, then 2/4/8/16/24 hours. Expiry retains the count.
 * PEP and its vCard fallback count as one attempt to resolve an avatar.
 */
export async function beginUnansweredLookup(jid: string, hash?: string): Promise<UnansweredLookup> {
  const state = await stateFor(jid)
  await announce(state, hash)
  let timedOut = false
  return {
    allowed: () => Date.now() >= Math.max(state.retryAfter, state.entry?.retryAfter ?? 0),
    answered: () => clear(state),
    async read(query, target = jid) {
      try {
        return await query()
      } catch (error) {
        if (error instanceof RequestTimeoutError) {
          state.retryAfter = Date.now() + SHORT_RETRY_MS
          console.debug(`Avatar lookup timed out for ${target}`)
          if (!timedOut) {
            timedOut = true
            const attempts = (state.entry?.attempts ?? 0) + 1
            state.entry = {
              jid, attempts, hash: state.hash,
              retryAfter: attempts < 2 ? 0 : Date.now() + Math.min(FIRST_BACKOFF_MS * 2 ** (attempts - 2), MAX_BACKOFF_MS),
            }
            await persist(state)
          }
        }
        throw error
      }
    },
  }
}

/** A changed announcement or a successful cached answer allows another lookup. */
export async function clearUnansweredLookup(jid: string, hash?: string): Promise<void> {
  const state = await stateFor(jid)
  if (hash === undefined) await clear(state)
  else await announce(state, hash)
}

export async function clearAllUnansweredLookups(): Promise<void> {
  const loaded = await Promise.all(states.values())
  await Promise.all(loaded.map(state => state.writes))
  states.clear()
  await store('clear').catch(() => {})
}
