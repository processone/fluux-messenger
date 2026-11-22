/** Name/local-part rank: exact, prefix, substring, then no identity match. */
export function suggestionMatchRank(query: string, name: string, jid?: string): number {
  const search = query.trim().normalize('NFC').toLowerCase()
  if (!search) return 2
  // Match the name or address local part, never the server name.
  const fields = [name, ...(jid ? [jid.split('@')[0]] : [])]
    .map(value => value.normalize('NFC').toLowerCase())
  if (fields.some(value => value === search)) return 0
  if (fields.some(value => value.startsWith(search))) return 1
  if (fields.some(value => value.includes(search))) return 2
  return 3
}
