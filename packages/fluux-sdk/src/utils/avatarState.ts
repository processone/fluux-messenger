import { getBareJid } from '../core/jid'

let cacheEpoch = 0
const pendingWrites = new Set<Promise<unknown>>()

/** A capability for one entity generation, captured before asynchronous work. */
export interface AvatarVersion {
  readonly token: symbol
  readonly jid: string
  readonly previousHash: string | null | undefined
  readonly hash: string | null | undefined
  readonly generation: number
  positive(): boolean
  absence(): AvatarVersion
  current(): boolean
  apply(action: () => void): boolean
  write<T>(action: () => Promise<T>): Promise<T | undefined>
}

interface State {
  hash: string | null | undefined
  previousHash?: string | null
  epoch: number
  token: symbol
  generation: number
  positiveRevision: number
  identity?: string
  writes: Promise<unknown>
}

/** Current versions and ordered entity writes; network requests never hold a queue. */
const states = new Map<string, State>()
let generation = 0

/**
 * Account/session capabilities over the shared entity version registry.
 * Changed hashes and explicit removals establish new generations; successful
 * lookups retain the generation so same-version consumers can all publish.
 * Absence is eligible only until positive evidence arrives after its capture;
 * a fresh recovery capture can therefore record backoff after an earlier success.
 */
export class AvatarStateOwner {
  private scope = 0

  constructor(private readonly account: () => string | null = () => null) {}

  cancel(): void { this.scope++ }

  capture(jid: string, hash?: string | null): AvatarVersion {
    let state = states.get(jid)
    if (!state || state.epoch !== cacheEpoch) {
      state = { hash, positiveRevision: 0, epoch: cacheEpoch, token: Symbol(), generation: ++generation, writes: state?.writes ?? Promise.resolve() }
      states.set(jid, state)
    } else if (hash !== undefined && (hash === null || hash !== state.hash)) {
      state.previousHash = state.hash
      state.hash = hash
      state.epoch = cacheEpoch
      state.token = Symbol()
      state.generation = ++generation
    }
    return this.version(jid, state)
  }

  identify(jid: string, identity: string): void {
    this.capture(jid)
    const state = states.get(jid)!
    if (state.identity !== undefined && state.identity !== identity) this.invalidate(jid)
    state.identity = identity
  }

  invalidate(jid: string): AvatarVersion {
    this.capture(jid)
    const state = states.get(jid)!
    state.generation = ++generation
    state.token = Symbol()
    return this.version(jid, state)
  }

  /** Storage snapshots can seed a version, but cannot supersede live evidence. */
  snapshot(jids?: readonly string[]): (jid: string, hash?: string) => AvatarVersion {
    const entries = jids ? jids.flatMap(jid => {
      const state = states.get(jid)
      return state ? [[jid, state] as const] : []
    }) : [...states]
    const generations = new Map(entries.filter(([, state]) => state.epoch === cacheEpoch).map(([jid, state]) => [jid, state.generation]))
    const account = this.account()
    const epoch = cacheEpoch
    const scope = this.scope
    return (jid, hash) => {
      const stored = states.get(jid)
      const state = stored?.epoch === cacheEpoch ? stored : undefined
      const unchanged = state?.generation === generations.get(jid) && account === this.account() && epoch === cacheEpoch && scope === this.scope
      const version = unchanged ? this.capture(jid, state?.hash === undefined ? hash : undefined) : this.capture(jid)
      if (unchanged) generations.set(jid, version.generation)
      const accepted = unchanged && (hash === undefined || version.hash === undefined || version.hash === hash)
      if (!accepted) return { ...version, current: () => false, positive: () => false, absence() { return this }, apply: () => false, write: async () => undefined }
      return version
    }
  }

  private version(jid: string, state: State): AvatarVersion {
    const { hash, previousHash, generation, epoch, token, positiveRevision } = state
    const account = this.account()
    const scope = this.scope
    const current = () => states.get(jid) === state && state.generation === generation && account === this.account() && epoch === cacheEpoch && scope === this.scope
    const version: AvatarVersion = {
      jid, hash, previousHash, generation, token, current,
      positive: () => {
        if (!current()) return false
        state.positiveRevision++
        // Legacy negative writers carry only a token, not a positive revision.
        state.token = Symbol()
        return true
      },
      absence: () => {
        const eligible = () => current() && state.positiveRevision === positiveRevision
        return {
          ...version, current: eligible,
          apply: action => eligible() && version.apply(action),
          write: action => version.write(async () => eligible() ? action() : undefined),
        }
      },
      apply(action) {
        if (!current()) return false
        action()
        return true
      },
      write(action) {
        const result = state.writes.then(() => current() ? action() : undefined)
        state.writes = result.catch(() => {})
        pendingWrites.add(state.writes)
        const pending = state.writes
        void pending.then(() => pendingWrites.delete(pending))
        return result
      },
    }
    return version
  }
}

// Cache-only consumers do not have a protocol client or account dependency.
export const avatarCacheState = new AvatarStateOwner()

const sourceOwners = new WeakMap<object, AvatarStateOwner>()

export function registerAvatarStateOwner(source: object, owner: AvatarStateOwner): void {
  sourceOwners.set(source, owner)
}

export function getAvatarStateOwner(source: object): AvatarStateOwner | undefined {
  return sourceOwners.get(source)
}

/** Cache reset cancels all client generations and drains admitted storage writes. */
export async function invalidateAllAvatarVersions(): Promise<void> {
  cacheEpoch++
  await Promise.all([...pendingWrites])
}

export function occupantAvatarKey(roomJid: string, nick: string, realJid?: string, occupantId?: string): string {
  if (realJid) return getBareJid(realJid)
  return occupantId ? `muc-occupant:${encodeURIComponent(getBareJid(roomJid))}:${encodeURIComponent(occupantId)}` : `${roomJid}/${nick}`
}

/** A disclosed JID lookup must also belong to the room identity that requested it. */
export function withAvatarIdentity(version: AvatarVersion, identity: AvatarVersion): AvatarVersion {
  if (version.jid === identity.jid) return version
  const current = () => version.current() && identity.current()
  return {
    ...version, current,
    positive: () => current() && version.positive(),
    absence: () => withAvatarIdentity(version.absence(), identity),
    apply: action => current() && version.apply(action),
    write: async action => current() ? version.write(async () => identity.current() ? action() : undefined) : undefined,
  }
}

/** One lookup can address a real JID while a room/nick owns its query eligibility. */
export function captureOccupantAvatar(
  owner: AvatarStateOwner, roomJid: string, nick: string, hash?: string, realJid?: string, occupantId?: string,
): AvatarVersion {
  const identity = occupantAvatarKey(roomJid, nick, undefined, occupantId)
  const nickJid = `${roomJid}/${nick}`
  const bareRealJid = realJid ? getBareJid(realJid) : ''
  if (identity !== nickJid) owner.identify(identity, bareRealJid)
  owner.identify(nickJid, `${identity}|${bareRealJid}`)
  return withAvatarIdentity(withAvatarIdentity(
    owner.capture(occupantAvatarKey(roomJid, nick, realJid, occupantId), hash), owner.capture(identity, hash),
  ), owner.capture(nickJid, hash))
}

export function snapshotOccupantAvatar(
  snapshot: ReturnType<AvatarStateOwner['snapshot']>, roomJid: string, nick: string, hash: string, realJid?: string, occupantId?: string,
): AvatarVersion {
  const version = withAvatarIdentity(snapshot(occupantAvatarKey(roomJid, nick, realJid, occupantId), hash),
    snapshot(occupantAvatarKey(roomJid, nick, undefined, occupantId), hash))
  return nick ? withAvatarIdentity(version, snapshot(`${roomJid}/${nick}`, hash)) : version
}
