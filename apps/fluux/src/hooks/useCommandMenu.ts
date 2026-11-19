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

/** The menu's selection and dismissal, and the text they belong to. */
interface MenuChoice {
  text: string
  selectedIndex: number
  /** Counts Up/Down moves made by the key handler; lets the menu tell a handled move from a reset. */
  navSerial?: number
  dismissed: boolean
}

export function useCommandMenu(
  text: string,
  cursor: number,
  kind: CommandContextKind,
  self?: CommandSelf,
) {
  // Every edit resets the selection and the dismissal, including an edit back to
  // earlier text. The reset is made while rendering the edit, React's way to adjust
  // state when a prop changes: React re-runs this component at once and schedules
  // nothing. An effect that reset them set state after every keystroke at low
  // priority; when keys arrived back to back that update never ran, so React counted
  // each later keystroke as a nested update and threw "Maximum update depth exceeded"
  // past 50.
  const [choice, setChoice] = useState<MenuChoice>({ text, selectedIndex: 0, dismissed: false })
  if (choice.text !== text) setChoice({ text, selectedIndex: 0, dismissed: false })

  const { isActive, matches } = useMemo(
    () => matchCommandMenu(text, cursor, kind, self),
    [text, cursor, kind, self],
  )

  const active = isActive && !choice.dismissed

  return {
    state: {
      isActive: active,
      matches,
      selectedIndex: Math.min(choice.selectedIndex, Math.max(0, matches.length - 1)),
      navSerial: choice.navSerial ?? 0,
    },
    moveSelection: (dir: 'up' | 'down') =>
      setChoice((c) => {
        const n = matches.length
        if (n === 0) return { ...c, selectedIndex: 0 }
        return {
          ...c,
          navSerial: (c.navSerial ?? 0) + 1,
          selectedIndex: dir === 'down' ? (c.selectedIndex + 1) % n : (c.selectedIndex - 1 + n) % n,
        }
      }),
    dismiss: () => setChoice((c) => ({ ...c, dismissed: true })),
    reset: () => setChoice((c) => ({ ...c, selectedIndex: 0, dismissed: false })),
  }
}
