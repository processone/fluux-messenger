/**
 * The rotation policy of the verified-retraction ledger, decided against a fake
 * sink so every rule is exercised here and none depends on IndexedDB timing.
 *
 * The rules under test: a retraction rotates whole, never one alias at a time;
 * nothing rotates by age; past the cap, records a cache tombstone already
 * carries go first, oldest first, and only when that is not enough do uncarried
 * records rotate, oldest first, with one diagnostic saying so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RETRACTION_LEDGER_CAP,
  RETRACTION_LEDGER_LOW_WATER,
  _clearRetractedIdentitiesForTesting,
  _retractionLedgerForTesting,
  _settleRetractionLedgerForTesting,
  attachRetractionLedgerSink,
  chatRetractionAliases,
  clearRetractionLedger,
  ensureRetractionLedger,
  noteRetractedIdentity,
  retractedAtForIdentity,
  roomRetractionAliases,
  type RetractionLedgerSink,
  type RetractionScope,
  type VerifiedRetraction,
} from './retractedIdentities'
import { archiveIdentityConflict, CHAT_SCOPE, tierKey, type IdentityFields, type RoomIdentityFields } from './messageIdentity'
import {
  resetDiagnosticsForTesting,
  subscribeDiagnostics,
  type DiagnosticEvent,
} from '../diagnostics/channel'

const SCOPE = 'romeo@montague.example'
const OTHER_SCOPE = 'mercutio@verona.example'
const CHAT = 'juliet@capulet.example'
const ROOM = 'balcony@conference.montague.example'
const BASE = 1_700_000_000_000
const CAP = RETRACTION_LEDGER_CAP
const LOW = RETRACTION_LEDGER_LOW_WATER

const chatScope: RetractionScope = { kind: 'chat', entityId: CHAT, accountScope: SCOPE }
const roomScope: RetractionScope = { kind: 'room', entityId: ROOM, accountScope: SCOPE }

function createFakeSink() {
  const stored = new Map<string, Map<string, VerifiedRetraction>>()
  const scopeStore = (scope: string | null) => {
    const key = scope ?? ''
    let store = stored.get(key)
    if (!store) {
      store = new Map()
      stored.set(key, store)
    }
    return store
  }
  let carried: (record: VerifiedRetraction) => boolean = () => false
  let persistFailures = 0
  const classified: VerifiedRetraction[][] = []
  const persisted: Array<{ puts: string[]; deletes: string[] }> = []
  let loads = 0
  const sink: RetractionLedgerSink = {
    async load(scope) {
      loads++
      return [...scopeStore(scope).values()].map((record) => ({ ...record, aliases: [...record.aliases] }))
    },
    async persist(scope, puts, deletes) {
      if (persistFailures > 0) {
        persistFailures--
        throw new Error('injected persist failure')
      }
      persisted.push({ puts: puts.map((record) => record.key), deletes: [...deletes] })
      const store = scopeStore(scope)
      for (const record of puts) store.set(record.key, { ...record, aliases: [...record.aliases] })
      for (const key of deletes) store.delete(key)
    },
    async classifyCarried(_scope, records) {
      classified.push([...records])
      return new Set(records.filter(carried).map((record) => record.key))
    },
    async clear(scope) {
      stored.delete(scope ?? '')
    },
  }
  return {
    sink,
    stored: scopeStore,
    persisted,
    classified,
    get loads() { return loads },
    setCarried(predicate: (record: VerifiedRetraction) => boolean) { carried = predicate },
    failPersist(times = 1) { persistFailures = times },
  }
}

function target(i: number, overrides: Partial<IdentityFields> = {}): IdentityFields {
  return { from: CHAT, id: `id-${i}`, stanzaId: `stanza-${i}`, originId: `origin-${i}`, ...overrides }
}

function note(
  i: number,
  options: { at?: number; retractedAt?: number; overrides?: Partial<IdentityFields> } = {}
): IdentityFields {
  const at = options.at ?? BASE + i
  vi.setSystemTime(at)
  const m = target(i, options.overrides)
  noteRetractedIdentity(chatScope, chatRetractionAliases(m), m, options.retractedAt ?? at)
  return m
}

function knownBy(alias: string, scope: RetractionScope = chatScope): boolean {
  return retractedAtForIdentity(scope, [alias], () => true) !== undefined
}

function known(m: IdentityFields, scope: RetractionScope = chatScope): boolean {
  return retractedAtForIdentity(scope, chatRetractionAliases(m), () => true) !== undefined
}

function indexOf(record: VerifiedRetraction): number {
  return Number(record.stanzaId?.split('-')[1] ?? record.aliases[0].split('id-')[1])
}

const settle = () => _settleRetractionLedgerForTesting()

describe('verified retraction ledger rotation', () => {
  let fake: ReturnType<typeof createFakeSink>
  let events: DiagnosticEvent[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(BASE)
    _clearRetractedIdentitiesForTesting()
    resetDiagnosticsForTesting()
    fake = createFakeSink()
    attachRetractionLedgerSink(fake.sink)
    events = []
    subscribeDiagnostics((event) => { events.push(event) }, { kinds: ['retraction-ledger-evicted'] })
  })

  afterEach(() => {
    attachRetractionLedgerSink(null)
    resetDiagnosticsForTesting()
    vi.useRealTimers()
  })

  it('rotates a retraction whole, never one alias at a time', async () => {
    for (let i = 0; i <= CAP; i++) note(i)
    await settle()

    expect(_retractionLedgerForTesting(SCOPE).records).toHaveLength(CAP)
    for (const alias of chatRetractionAliases(target(0))) expect(knownBy(alias)).toBe(false)
    for (let i = 1; i <= CAP; i++) {
      for (const alias of chatRetractionAliases(target(i))) expect(knownBy(alias)).toBe(true)
    }
  })

  it('never rotates by age', async () => {
    const tenYears = 10 * 365 * 24 * 3600 * 1000
    const ancient = note(0, { at: BASE - tenYears, retractedAt: BASE - tenYears })
    for (let i = 1; i < CAP; i++) note(i)
    await settle()

    expect(known(ancient)).toBe(true)
    expect(_retractionLedgerForTesting(SCOPE).records).toHaveLength(CAP)
    expect(fake.classified).toHaveLength(0)
  })

  it('offers only records with an archive-tier alias for classification', async () => {
    for (let i = 0; i < 10; i++) note(i, { overrides: { stanzaId: undefined, originId: undefined } })
    for (let i = 10; i <= CAP; i++) note(i)
    await settle()

    const offered = fake.classified.flat()
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.every((record) => record.stanzaId !== undefined || record.originId !== undefined)).toBe(true)
  })

  it('drops carried records first, oldest first, down to the low-water mark', async () => {
    fake.setCarried(() => true)
    for (let i = 0; i <= CAP; i++) note(i)
    await settle()

    const survivors = _retractionLedgerForTesting(SCOPE).records
    expect(survivors).toHaveLength(LOW)
    const evicted = CAP + 1 - LOW
    for (let i = 0; i <= CAP; i++) expect(known(target(i))).toBe(i >= evicted)
    expect(events).toEqual([])
  })

  it('leaves uncarried records alone while carried ones compact', async () => {
    fake.setCarried((record) => indexOf(record) % 2 === 0)
    for (let i = 0; i <= CAP; i++) note(i)
    await settle()

    const evictedCarried = CAP + 1 - LOW
    // The carried set is every even index; the oldest `evictedCarried` of them go.
    const lastEvictedEven = (evictedCarried - 1) * 2
    for (let i = 0; i <= CAP; i++) {
      const expected = i % 2 === 1 || i > lastEvictedEven
      expect(known(target(i))).toBe(expected)
    }
    expect(events).toEqual([])
  })

  it('does not compact again just above the low-water mark', async () => {
    fake.setCarried(() => true)
    for (let i = 0; i <= CAP; i++) note(i)
    await settle()
    const classifications = fake.classified.length

    note(CAP + 1)
    await settle()

    expect(_retractionLedgerForTesting(SCOPE).records).toHaveLength(LOW + 1)
    expect(fake.classified).toHaveLength(classifications)
  })

  it('rotates the oldest uncarried records out past the cap and says so once', async () => {
    for (let i = 0; i < CAP + 10; i++) note(i)
    await settle()

    expect(_retractionLedgerForTesting(SCOPE).records).toHaveLength(CAP)
    for (let i = 0; i < CAP + 10; i++) expect(known(target(i))).toBe(i >= 10)
    expect(events).toEqual([{
      kind: 'retraction-ledger-evicted',
      accountScope: SCOPE,
      compacted: 0,
      evicted: 10,
      remaining: CAP,
    }])
    const deletes = fake.persisted.flatMap((batch) => batch.deletes)
    expect(deletes).toHaveLength(10)
  })

  it('merges a re-delivered retraction instead of duplicating it', async () => {
    const m = target(1)
    noteRetractedIdentity(chatScope, chatRetractionAliases(m), m, 200)
    noteRetractedIdentity(chatScope, chatRetractionAliases(m), m, 100)
    await settle()

    expect(_retractionLedgerForTesting(SCOPE).records).toHaveLength(1)
    expect(retractedAtForIdentity(chatScope, chatRetractionAliases(m), () => true)).toBe(100)
    const writes = fake.persisted.flatMap((batch) => batch.puts).length

    noteRetractedIdentity(chatScope, chatRetractionAliases(m), m, 150)
    await settle()
    expect(fake.persisted.flatMap((batch) => batch.puts)).toHaveLength(writes)

    noteRetractedIdentity(chatScope, chatRetractionAliases(m), m, 150, { isModerated: true, moderatedBy: 'mod' })
    await settle()
    const [record] = _retractionLedgerForTesting(SCOPE).records
    expect(record.retractedAt).toBe(100)
    expect(record.moderation).toEqual({ isModerated: true, moderatedBy: 'mod' })
    expect(fake.stored(SCOPE).get(record.key)?.moderation).toEqual({ isModerated: true, moderatedBy: 'mod' })
  })

  it('joins the alias sets of one target noted through different tiers', async () => {
    const byStanza = target(1, { originId: undefined })
    const byOrigin = target(1, { stanzaId: undefined })
    noteRetractedIdentity(chatScope, chatRetractionAliases(byStanza), byStanza, BASE)
    noteRetractedIdentity(chatScope, chatRetractionAliases(byOrigin), byOrigin, BASE)
    await settle()

    const { records } = _retractionLedgerForTesting(SCOPE)
    expect(records).toHaveLength(1)
    expect(records[0].stanzaId).toBe('stanza-1')
    expect(records[0].originId).toBe('origin-1')
    expect(new Set(records[0].aliases)).toEqual(new Set([
      ...chatRetractionAliases(byStanza),
      ...chatRetractionAliases(byOrigin),
    ]))
    expect(knownBy(tierKey(CHAT_SCOPE, 'originId', 'origin-1'))).toBe(true)
    expect(fake.stored(SCOPE).get(records[0].key)?.aliases).toEqual(records[0].aliases)
  })

  it('keeps a different occupant or a conflicting archive identity as its own record', async () => {
    const alice: RoomIdentityFields = { roomJid: ROOM, from: `${ROOM}/alice`, id: 'shared', occupantId: 'occ-alice' }
    const newcomer: RoomIdentityFields = { roomJid: ROOM, from: `${ROOM}/alice`, id: 'shared', occupantId: 'occ-bob' }
    noteRetractedIdentity(roomScope, roomRetractionAliases(alice), alice, BASE)
    noteRetractedIdentity(roomScope, roomRetractionAliases(newcomer), newcomer, BASE + 1)

    const first = target(2, { stanzaId: 'archive-a', originId: undefined })
    const second = target(2, { stanzaId: 'archive-b', originId: undefined })
    noteRetractedIdentity(chatScope, chatRetractionAliases(first), first, BASE)
    noteRetractedIdentity(chatScope, chatRetractionAliases(second), second, BASE + 1)
    await settle()

    const { records } = _retractionLedgerForTesting(SCOPE)
    expect(records.filter((record) => record.kind === 'room')).toHaveLength(2)
    expect(records.filter((record) => record.kind === 'chat')).toHaveLength(2)
    const onlyAlice = (record: { actorOccupantId?: string }) => record.actorOccupantId === 'occ-alice'
    expect(retractedAtForIdentity(roomScope, roomRetractionAliases(alice), onlyAlice)).toBe(BASE)
  })

  it.each(['stanzaId', 'originId'] as const)('preserves conflicting %s records through weaker live and stored notes', async (tier) => {
    for (const scope of [chatScope, roomScope]) {
      const aliasesFor = (m: IdentityFields) => scope.kind === 'chat'
        ? chatRetractionAliases(m) : roomRetractionAliases({ ...m, roomJid: ROOM })
      const weak: IdentityFields = { from: CHAT, id: 'reused' }
      const first: IdentityFields = { ...weak, [tier]: 'archive-a' }
      const second: IdentityFields = { ...weak, [tier]: 'archive-b' }
      noteRetractedIdentity(scope, aliasesFor(first), first, BASE)
      noteRetractedIdentity(scope, aliasesFor(second), second, BASE + 1)
      noteRetractedIdentity(scope, aliasesFor(weak), weak, BASE - 1)
      await settle()

      const records = _retractionLedgerForTesting(SCOPE).records.filter(record => record.kind === scope.kind)
      expect(records).toHaveLength(2)
      expect(records.map(record => record[tier]).sort()).toEqual(['archive-a', 'archive-b'])
      expect(retractedAtForIdentity(scope, aliasesFor(second), record =>
        record.actorJid === second.from && !archiveIdentityConflict(second, record))).toBe(BASE - 1)

      const storedWeak = { ...records[0], key: `${scope.kind}-weak`, aliases: aliasesFor(weak),
        stanzaId: undefined, originId: undefined, retractedAt: BASE - 2 }
      fake.stored(SCOPE).set(storedWeak.key, storedWeak)
      _clearRetractedIdentitiesForTesting()
      await ensureRetractionLedger(SCOPE)
      await settle()
      const hydrated = _retractionLedgerForTesting(SCOPE).records.filter(record => record.kind === scope.kind)
      expect(hydrated).toHaveLength(2)
      expect(hydrated.map(record => record[tier]).sort()).toEqual(['archive-a', 'archive-b'])
      expect(retractedAtForIdentity(scope, aliasesFor(second), record =>
        record.actorJid === second.from && !archiveIdentityConflict(second, record))).toBe(BASE - 2)
    }
  })

  it('hydrates stored aliases and metadata before draining an early note', async () => {
    const original = note(1, { retractedAt: BASE - 100 })
    noteRetractedIdentity(chatScope, chatRetractionAliases(original), original, BASE - 100,
      { isModerated: true, moderatedBy: 'moderator' })
    await settle()
    const [stored] = [...fake.stored(SCOPE).values()]
    _clearRetractedIdentitiesForTesting()

    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const load = fake.sink.load
    fake.sink.load = async scope => { await blocked; return load(scope) }
    const early = { ...original, originId: undefined }
    noteRetractedIdentity(chatScope, chatRetractionAliases(early), early, BASE)
    await Promise.resolve()
    const ready = ensureRetractionLedger(SCOPE)
    await Promise.resolve()
    expect(fake.stored(SCOPE).get(stored.key)).toEqual(stored)
    release()
    await ready
    await settle()

    const hydrated = fake.stored(SCOPE).get(stored.key)!
    expect({ ...hydrated, aliases: [...hydrated.aliases].sort() }).toEqual({
      ...stored, aliases: [...stored.aliases].sort(),
    })
    expect(knownBy(tierKey(CHAT_SCOPE, 'originId', original.originId!))).toBe(true)
  })

  it('keeps a failed batch and re-persists it with the next one', async () => {
    fake.failPersist(1)
    const first = note(1)
    await settle()
    expect(fake.stored(SCOPE).size).toBe(0)
    expect(known(first)).toBe(true)

    const second = note(2)
    await settle()
    expect(known(first)).toBe(true)
    expect(known(second)).toBe(true)
    expect(fake.stored(SCOPE).size).toBe(2)
  })

  it('hydrates stored records once and merges them with notes made meanwhile', async () => {
    const stored = note(1, { retractedAt: 200 })
    const alsoStored = note(2)
    await settle()
    _clearRetractedIdentitiesForTesting()
    expect(known(stored)).toBe(false)

    const ready = ensureRetractionLedger(SCOPE)
    const again = ensureRetractionLedger(SCOPE)
    noteRetractedIdentity(chatScope, chatRetractionAliases(stored), stored, 100)
    const meanwhile = note(3)
    await ready
    await again
    await settle()

    const { records, hydrated } = _retractionLedgerForTesting(SCOPE)
    expect(hydrated).toBe(true)
    expect(records).toHaveLength(3)
    expect(retractedAtForIdentity(chatScope, chatRetractionAliases(stored), () => true)).toBe(100)
    expect(known(alsoStored)).toBe(true)
    expect(known(meanwhile)).toBe(true)
    expect(fake.loads).toBe(2)
    expect(fake.stored(SCOPE).get(records.find((record) => record.stanzaId === 'stanza-1')!.key)?.retractedAt).toBe(100)
  })

  it('keeps each account scope apart', async () => {
    const m = note(1)
    await settle()

    expect(known(m, { ...chatScope, accountScope: OTHER_SCOPE })).toBe(false)
    expect(_retractionLedgerForTesting(OTHER_SCOPE).records).toEqual([])
    expect(fake.stored(OTHER_SCOPE).size).toBe(0)
    expect(fake.stored(SCOPE).size).toBe(1)
  })

  it('clears memory and storage for one scope on request', async () => {
    const mine = note(1)
    const theirs = target(2)
    noteRetractedIdentity({ ...chatScope, accountScope: OTHER_SCOPE }, chatRetractionAliases(theirs), theirs, BASE)
    await settle()

    await clearRetractionLedger(SCOPE)

    expect(known(mine)).toBe(false)
    expect(fake.stored(SCOPE).size).toBe(0)
    expect(known(theirs, { ...chatScope, accountScope: OTHER_SCOPE })).toBe(true)
    expect(fake.stored(OTHER_SCOPE).size).toBe(1)
  })
})
