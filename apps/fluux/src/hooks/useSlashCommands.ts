
/**
 * Actions that slash commands can trigger.
 * Each view provides its own implementation of these actions.
 */
export interface SlashCommandActions {
  sendEasterEgg: (animation: string) => Promise<void>
  // Future commands can add more actions here
}

/**
 * Hook that provides centralized slash command handling.
 * Command matching logic is shared, but actions are provided by each view.
 *
 * @example
 * // In ChatView
 * const { handleCommand } = useSlashCommands({
 *   sendEasterEgg: (anim) => sendEasterEgg(conversationId, 'chat', anim)
 * })
 *
 * // In handleSubmit
 * if (await handleCommand(text)) {
 *   setText('')
 *   return
 * }
 */
export function useSlashCommands(actions: SlashCommandActions) {
  /**
   * Check if text is a slash command and execute it.
   * @returns true if a command was handled, false otherwise
   */
  const handleCommand = async (text: string): Promise<boolean> => {
    const command = text.trim().toLowerCase()

    // Easter egg commands
    if (command === '/christmas') {
      await actions.sendEasterEgg('christmas')
      return true
    }

    // Future commands can be added here:
    // if (command === '/newyear') { ... }
    // if (command === '/confetti') { ... }

    return false
  }

  return { handleCommand }
}
