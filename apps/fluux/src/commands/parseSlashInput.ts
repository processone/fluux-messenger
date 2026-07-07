import type { ParsedInput } from './types'

/**
 * Classify raw composer text without consulting the command registry.
 * The registry decides whether a `command` name is known; this only tokenizes.
 */
export function parseSlashInput(text: string): ParsedInput {
  if (!text.startsWith('/')) return { kind: 'message' }
  // Escape hatch: "//foo" sends "/foo" literally.
  if (text.startsWith('//')) return { kind: 'literal', text: text.slice(1) }
  // "/me <action>" is sent verbatim (XEP-0245); requires the trailing space.
  if (text.startsWith('/me ')) return { kind: 'passthrough', text }
  // "/say <text>" sends <text> literally (lets a message start with a slash).
  if (text === '/say') return { kind: 'literal', text: '' }
  if (text.startsWith('/say ')) return { kind: 'literal', text: text.slice(5) }
  // General "/name args".
  const rest = text.slice(1)
  const spaceIdx = rest.search(/\s/)
  const name = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1)
  return { kind: 'command', name, args }
}
