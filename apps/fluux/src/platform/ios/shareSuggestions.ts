import { connectionStore, roomStore, rosterStore, chatStore } from '@fluux/sdk'
import { platform } from '@/platform'

/** Called only after an accepted send; donations carry no message content. */
export async function donateIOSConversation(account: string | null, jid: string, type: 'chat' | 'groupchat'): Promise<void> {
  if (!platform().usesNativePush || platform().os !== 'ios' || !account) return
  const current = () => {
    const roster = rosterStore.getState()
    return connectionStore.getState().jid?.split('/')[0] === account && roster.isLoaded && roster.accountJid === account &&
      (type === 'chat' ? roster.contacts.has(jid) && chatStore.getState().conversations.has(jid) : roomStore.getState().rooms.get(jid)?.joined === true)
  }
  if (!current()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    if (current()) await invoke('plugin:push|donate_conversation', { destination: { account, jid, type } })
  } catch { /* System suggestions are optional; an accepted send stays accepted. */ }
}

/** Deleting a local conversation also removes its system suggestions. */
export function startIOSShareSuggestions(): () => void {
  if (!platform().usesNativePush || platform().os !== 'ios') return () => {}
  let account = connectionStore.getState().jid?.split('/')[0] ?? null
  let conversations = chatStore.getState().conversations
  return chatStore.subscribe(() => {
    const nextAccount = connectionStore.getState().jid?.split('/')[0] ?? null
    const next = chatStore.getState().conversations
    if (account && nextAccount === account && next !== conversations) {
      for (const jid of conversations.keys()) {
        if (next.has(jid)) continue
        const destination = { account, jid, type: 'chat' }
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('plugin:push|remove_conversation_donations', { destination })).catch(() => {})
      }
    }
    account = nextAccount
    conversations = next
  })
}
