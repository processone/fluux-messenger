export function generatedIdentityCorpus() {
  let seed = 0x35_09_31
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const token = () => 'id-' + next() % 13
  const cases = Array.from({ length: 512 }, () => {
    const messages = Array.from({ length: 1 + next() % 5 }, (_, index) => {
      const account = 'me@example.com', id = token(), originId = token(), stanzaId = token() + '-live-' + index
      const stanzaBy = next() % 2 ? account : 'foreign@example.com'
      const mamUid = next() % 3 ? token() + '-mam-' + index : undefined
      return { account, id, originId, stanzaId, stanzaBy, mamUid }
    })
    const selected = messages[next() % messages.length]
    const target = next() % 3 ? (next() % 2 ? selected.id : selected.originId) : selected.mamUid ?? selected.stanzaId
    if (next() % 4 === 0) {
      const uid = 'u-' + next(), reused = token(), mutation = next() % 2 ? 'edit' : 'outerEdit'
      const original = { uid, id: reused, kind: 'newMessage', body: 'old' }
      const metadata = { uid: 'm-' + next(), id: 'metadata', kind: 'metadata', target: reused }
      const batches = next() % 3 === 0
        ? [[original], [{ ...metadata, mutation, text: "private updated" }], [{ ...metadata, uid: metadata.uid + "-retract", mutation: "retraction" }]]
        : next() % 2
        ? [[{ ...metadata, mutation, text: 'updated' }, original]]
        : [[original], [{ ...metadata, mutation: 'retraction' }], [{ ...original, uid: uid + '-next', body: 'fresh' }]]
      return { messages: [], target: '', batches }
    }
    return { messages, target }
  })
  return { version: 1, cases }
}
