import { readFileSync } from 'node:fs'
import { CHAT_SCOPE, archiveReference, canonicalReference, tierKey, resolveMessageReference } from '../../packages/fluux-sdk/src/utils/messageIdentity.ts'
const corpus = JSON.parse(readFileSync(0, 'utf8'))
if (corpus.version !== 1) throw new Error('Unknown identity corpus version')
function sequence(batches) {
  const facts = new Map(), pending = new Set(), notified = new Set(), handled = new Set(), retracted = new Set()
  const requests = new Map(), editTargets = new Map(), selections = []
  const resolve = target => {
    const result = resolveMessageReference([...facts.values()], target, 'archive-first')
    return result?.candidates.length === 1 ? result.candidates[0].message : undefined
  }
  return batches.map((events, index) => {
    const removeRequests = new Set()
    const cancel = uid => { for (const [id, request] of requests) if (id === uid || editTargets.get(id) === uid) removeRequests.add(request) }
    for (const event of events) if (event.kind === 'newMessage') facts.set(event.uid, { ...event, stanzaId: event.uid })
    for (const target of pending) {
      const message = resolve(target)
      if (message) { cancel(message.uid); retracted.add(message.uid); pending.delete(target) }
    }
    let candidates = events.filter(event => event.kind === 'newMessage' && !notified.has(event.uid) && !retracted.has(event.uid)).map(event => ({ ...event }))
    let metadata, unresolved = false
    for (const event of events) if (event.kind === 'metadata') {
      const target = resolve(event.target)
      if (!target) {
        if (event.mutation === 'retraction') pending.add(event.target)
        unresolved = true
        continue
      }
      if (!handled.has(event.uid) && !notified.has(event.uid) && !(event.mutation !== 'retraction' && retracted.has(target.uid))) metadata = event
      handled.add(event.uid)
      if (event.mutation === 'retraction') {
        cancel(target.uid); pending.delete(event.target); retracted.add(target.uid)
        candidates = candidates.filter(message => message.uid !== target.uid)
      } else if (!retracted.has(target.uid)) {
        for (const candidate of candidates) if (candidate.uid === target.uid) candidate.body = event.text
      }
    }
    if (metadata && metadata.mutation !== 'retraction' && retracted.has(resolve(metadata.target)?.uid)) metadata = undefined
    if (unresolved) { candidates = []; metadata = undefined }
    const claimed = candidates.length ? candidates.map(message => message.uid) : metadata ? [metadata.uid] : []
    const body = candidates.length === 1 ? candidates[0].body : candidates.length ? `Alice: ${candidates.length} new messages` : metadata ? metadata.mutation === 'retraction' ? 'Alice deleted a message' : `Alice (edit): ${metadata.text}` : null
    if (!candidates.length && metadata && metadata.mutation !== 'retraction') editTargets.set(metadata.uid, resolve(metadata.target).uid)
    for (const uid of claimed) { notified.add(uid); requests.set(uid, `request-${index}`) }
    if (claimed.length) selections.push(claimed)
    const handoffs = selections.map(ids => ids.every(uid => !retracted.has(uid) && !retracted.has(editTargets.get(uid))))
    return { body, claimed, removeRequests: [...removeRequests].sort(), handoffs }
  })
}
const output = corpus.cases.map(test => {
  if (test.batches) return { keys: [], resolved: null, steps: sequence(test.batches) }
  const messages = test.messages.map(message => ({ ...message, stanzaId: archiveReference({ id: '', stanzaId: message.mamUid ?? (message.stanzaBy === message.account ? message.stanzaId : undefined) }) }))
  const eligible = messages.filter(message => message.stanzaId)
  const resolved = resolveMessageReference(eligible, test.target, 'archive-first')
  return { keys: messages.map(message => message.stanzaId ? tierKey(CHAT_SCOPE, 'stanzaId', canonicalReference(message)) : ''), resolved: resolved?.candidates.length === 1 ? canonicalReference(resolved.candidates[0].message) : null }
})
process.stdout.write(JSON.stringify(output))
