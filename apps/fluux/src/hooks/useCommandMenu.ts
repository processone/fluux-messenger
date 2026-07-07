import { useEffect, useMemo, useState } from 'react'
import { visibleCommands } from '../commands/registry'
import type { CommandContextKind, CommandSelf, SlashCommand } from '../commands/types'

const PARTIAL = /^\/(\w*)$/

/** Pure: is the composer showing a bare partial command, and which commands match? */
export function matchCommandMenu(
  text: string,
  cursor: number,
  kind: CommandContextKind,
  self?: CommandSelf,
): { isActive: boolean; matches: SlashCommand[] } {
  // Only active when the whole input up to the caret is "/" + word, caret at end.
  if (cursor !== text.length) return { isActive: false, matches: [] }
  const m = text.match(PARTIAL)
  if (!m) return { isActive: false, matches: [] }
  const partial = m[1].toLowerCase()
  const matches = visibleCommands(kind, self).filter(
    (c) => c.name.startsWith(partial) || c.aliases?.some((a) => a.startsWith(partial)),
  )
  return { isActive: matches.length > 0, matches }
}

export function useCommandMenu(
  text: string,
  cursor: number,
  kind: CommandContextKind,
  self?: CommandSelf,
) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const { isActive, matches } = useMemo(
    () => matchCommandMenu(text, cursor, kind, self),
    [text, cursor, kind, self],
  )

  // Reset the dismissal + selection whenever the token changes.
  useEffect(() => {
    setSelectedIndex(0)
    setDismissed(false)
  }, [text])

  const active = isActive && !dismissed

  return {
    state: { isActive: active, matches, selectedIndex: Math.min(selectedIndex, Math.max(0, matches.length - 1)) },
    moveSelection: (dir: 'up' | 'down') =>
      setSelectedIndex((i) => {
        const n = matches.length
        if (n === 0) return 0
        return dir === 'down' ? (i + 1) % n : (i - 1 + n) % n
      }),
    dismiss: () => setDismissed(true),
    reset: () => {
      setSelectedIndex(0)
      setDismissed(false)
    },
  }
}
