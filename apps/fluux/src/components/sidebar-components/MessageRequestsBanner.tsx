import { useTranslation } from 'react-i18next'
import { useEvents, useBlocking, getBareJid } from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { useRouteSync } from '@/hooks'
import { StrangerMessageItem } from './StrangerMessageItem'

export function MessageRequestsBanner() {
  const { t } = useTranslation()
  const { strangerConversations, acceptStranger, ignoreStranger } = useEvents()
  const { blockJid } = useBlocking()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const { navigateToMessages } = useRouteSync()

  const jids = Object.keys(strangerConversations)
  if (jids.length === 0) return null

  const handleAccept = async (jid: string) => {
    await acceptStranger(jid)
    const bareJid = getBareJid(jid)
    void setActiveConversation(bareJid)
    navigateToMessages(bareJid)
  }
  const handleBlock = async (jid: string) => {
    await ignoreStranger(jid)
    await blockJid(jid)
  }

  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2">
        {t('conversations.messageRequestsHeading')} · {jids.length}
      </h3>
      <div className="space-y-0.5">
        {jids.map((jid) => (
          <StrangerMessageItem
            key={jid}
            jid={jid}
            messages={strangerConversations[jid]}
            onAccept={() => handleAccept(jid)}
            onIgnore={() => ignoreStranger(jid)}
            onBlock={() => handleBlock(jid)}
          />
        ))}
      </div>
    </div>
  )
}
