import { useMemo, useState } from 'react'
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

/** The menu's selection and dismissal, and the text they were made on. */
interface MenuChoice {
  text: string
  selectedIndex: number
  dismissed: boolean
}

export function useCommandMenu(
  text: string,
  cursor: number,
  kind: CommandContextKind,
  self?: CommandSelf,
) {
  // Any edit resets the selection and the dismissal. The choice carries the text it
  // was made on, so a choice made on other text reads as the reset one, with no state
  // update. An effect that reset it set state after every keystroke at low priority;
  // when keys arrived back to back that update never ran, so React counted each later
  // keystroke as a nested update and threw "Maximum update depth exceeded" past 50.
  const [choice, setChoice] = useState<MenuChoice>({ text, selectedIndex: 0, dismissed: false })
  const current = choice.text === text ? choice : { text, selectedIndex: 0, dismissed: false }

  const { isActive, matches } = useMemo(
    () => matchCommandMenu(text, cursor, kind, self),
    [text, cursor, kind, self],
  )

  const active = isActive && !current.dismissed

  return {
    state: {
      isActive: active,
      matches,
      selectedIndex: Math.min(current.selectedIndex, Math.max(0, matches.length - 1)),
    },
    moveSelection: (dir: 'up' | 'down') =>
      setChoice((c) => {
        const i = c.text === text ? c.selectedIndex : 0
        const n = matches.length
        const next = n === 0 ? 0 : dir === 'down' ? (i + 1) % n : (i - 1 + n) % n
        return { text, selectedIndex: next, dismissed: c.text === text && c.dismissed }
      }),
    dismiss: () =>
      setChoice((c) => ({ text, selectedIndex: c.text === text ? c.selectedIndex : 0, dismissed: true })),
    reset: () => setChoice({ text, selectedIndex: 0, dismissed: false }),
  }
}
