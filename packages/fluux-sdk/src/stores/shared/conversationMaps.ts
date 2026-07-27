/**
 * The single writer for chatStore's three conversation maps.
 *
 * `conversations` is a compat view of `conversationEntities` + `conversationMeta`
 * — and only a view. {@link Conversation} extends both interfaces and adds
 * nothing, and their field sets are disjoint, so `{ ...entity, ...meta }` is a
 * TOTAL reconstruction: a compat entry can hold no information the other two
 * maps do not already carry.
 *
 * `deserializeState` relies on exactly that, rebuilding the map with that
 * expression on every reload rather than reading the persisted copy. Which
 * means any field written into `conversations` alone — updated in one map and
 * left stale in the other — survives in memory and then silently disappears on
 * the next launch. Twenty-two call sites used to mirror each metadata write by
 * hand, several of them naming a subset of the fields they had just changed;
 * that mirroring is what this module replaces.
 *
 * The guarantee is structural rather than remembered: the compat entry is never
 * patched, only DERIVED, with the same expression the rebuild uses. A new write
 * site cannot reintroduce drift without bypassing the draft entirely.
 *
 * Copy-on-write: `commit()` hands back only the maps a caller actually touched,
 * so a rename still returns the original `conversationMeta` reference and
 * metadata subscribers do not re-render.
 */

import type { Conversation, ConversationEntity, ConversationMetadata } from '../../core/types/chat'

/** The three maps this module owns, as they live on `ChatState`. */
export interface ConversationMaps {
  conversationEntities: Map<string, ConversationEntity>
  conversationMeta: Map<string, ConversationMetadata>
  conversations: Map<string, Conversation>
}

/**
 * Build one conversation's compat entry. The single definition of the merge —
 * `deserializeState`'s rebuild loop calls this too, so the live map and a
 * restored one cannot disagree about the shape.
 */
export function rebuildCompatEntry(
  entity: ConversationEntity,
  meta: ConversationMetadata
): Conversation {
  return { ...entity, ...meta }
}

export interface ConversationMapsDraft {
  /** Current entity, including this draft's own uncommitted writes. */
  getEntity(id: string): ConversationEntity | undefined
  /** Current metadata, including this draft's own uncommitted writes. */
  getMeta(id: string): ConversationMetadata | undefined
  /** Replace metadata wholesale. Fields absent from `meta` are dropped. */
  setMeta(id: string, meta: ConversationMetadata): void
  /**
   * Merge `patch` over existing metadata. Returns false (writing nothing) when
   * the conversation has no metadata — callers that must create it use
   * {@link setMeta} with their own default.
   */
  patchMeta(id: string, patch: Partial<ConversationMetadata>): boolean
  /** Replace the entity wholesale. */
  setEntity(id: string, entity: ConversationEntity): void
  /** Merge `patch` over an existing entity. Returns false when absent. */
  patchEntity(id: string, patch: Partial<ConversationEntity>): boolean
  /** Create or replace both halves of a conversation. */
  upsert(id: string, entity: ConversationEntity, meta: ConversationMetadata): void
  /** Drop a conversation from all three maps. */
  remove(id: string): void
  /** Whether any write landed; false means `commit()` returns an empty patch. */
  readonly dirty: boolean
  /**
   * The state patch to return from `set()`. Contains only the maps that
   * changed, so untouched maps keep their identity.
   */
  commit(): Partial<ConversationMaps>
}

/**
 * Open a draft over `source`. Nothing is mutated: each map is cloned on its
 * first write, and `commit()` returns the clones.
 */
export function draftConversationMaps(source: ConversationMaps): ConversationMapsDraft {
  let entities: Map<string, ConversationEntity> | undefined
  let meta: Map<string, ConversationMetadata> | undefined
  let compat: Map<string, Conversation> | undefined

  const entitiesNow = (): Map<string, ConversationEntity> => entities ?? source.conversationEntities
  const metaNow = (): Map<string, ConversationMetadata> => meta ?? source.conversationMeta

  const mutableEntities = (): Map<string, ConversationEntity> =>
    (entities ??= new Map(source.conversationEntities))
  const mutableMeta = (): Map<string, ConversationMetadata> =>
    (meta ??= new Map(source.conversationMeta))
  const mutableCompat = (): Map<string, Conversation> =>
    (compat ??= new Map(source.conversations))

  /**
   * Re-derive one conversation's compat entry from whatever the entity and
   * metadata maps now hold. A conversation missing either half has no compat
   * entry at all — the same rule `deserializeState`'s rebuild applies, which is
   * why an entry it would not reproduce can never exist here either.
   */
  const rederive = (id: string): void => {
    const entity = entitiesNow().get(id)
    const entryMeta = metaNow().get(id)
    const next = entity && entryMeta ? rebuildCompatEntry(entity, entryMeta) : undefined
    const map = mutableCompat()
    if (next) map.set(id, next)
    else map.delete(id)
  }

  return {
    getEntity: (id) => entitiesNow().get(id),
    getMeta: (id) => metaNow().get(id),

    setMeta(id, value) {
      mutableMeta().set(id, value)
      rederive(id)
    },

    patchMeta(id, patch) {
      const existing = metaNow().get(id)
      if (!existing) return false
      mutableMeta().set(id, { ...existing, ...patch })
      rederive(id)
      return true
    },

    setEntity(id, value) {
      mutableEntities().set(id, value)
      rederive(id)
    },

    patchEntity(id, patch) {
      const existing = entitiesNow().get(id)
      if (!existing) return false
      mutableEntities().set(id, { ...existing, ...patch })
      rederive(id)
      return true
    },

    upsert(id, entity, value) {
      mutableEntities().set(id, entity)
      mutableMeta().set(id, value)
      rederive(id)
    },

    remove(id) {
      // Guard so a miss stays a no-op: cloning here would hand every caller a
      // fresh map and re-render the sidebar for nothing.
      if (!entitiesNow().has(id) && !metaNow().has(id) && !source.conversations.has(id)) return
      mutableEntities().delete(id)
      mutableMeta().delete(id)
      mutableCompat().delete(id)
    },

    get dirty() {
      return entities !== undefined || meta !== undefined || compat !== undefined
    },

    commit() {
      const patch: Partial<ConversationMaps> = {}
      if (entities) patch.conversationEntities = entities
      if (meta) patch.conversationMeta = meta
      if (compat) patch.conversations = compat
      return patch
    },
  }
}
