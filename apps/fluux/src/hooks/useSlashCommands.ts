import { useCallback } from 'react'
import { parseSlashInput } from '../commands/parseSlashInput'
import { runCommand, classifyInput as classify } from '../commands/registry'
import type { CommandContext, InputClass } from '../commands/types'
import { useToastStore } from '../stores/toastStore'

/**
 * Registry-driven slash-command dispatcher.
 *
 * `resolveInput` returns the text that should actually be sent, or the sentinel
 * `'consumed'` when the input was a command (feedback is delivered via toast).
 * `classifyInput` drives the composer's send-button indicator.
 */
export function useSlashCommands(context: CommandContext) {
  const addToast = useToastStore((s) => s.addToast)

  const resolveInput = useCallback(
    async (text: string): Promise<string | 'consumed'> => {
      const parsed = parseSlashInput(text)
      if (parsed.kind === 'message') return text
      if (parsed.kind === 'passthrough') return parsed.text
      if (parsed.kind === 'literal') return parsed.text
      const result = await runCommand(parsed, context)
      if (result.ok) {
        if (result.toast) addToast('success', result.toast)
      } else {
        addToast('error', result.error)
      }
      return 'consumed'
    },
    [context, addToast],
  )

  const classifyInput = useCallback(
    (text: string): InputClass => classify(text, context.kind),
    [context.kind],
  )

  return { resolveInput, classifyInput }
}
