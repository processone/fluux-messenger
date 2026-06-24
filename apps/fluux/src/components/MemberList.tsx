import { useChatActive, useRoster, type PresenceStatus } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { Avatar } from './Avatar'
import { UserInfoPopover } from './conversation/UserInfoPopover'

export function MemberList() {
  // Counted before the hooks + early-return below: MemberList is always mounted in
  // ChatLayout and holds a full useRoster() subscription, so it re-renders on every
  // roster/presence change even in 1:1 chats where it renders null. The tally must
  // include those invisible renders (the waste Phase 0 measures).
  detectRenderLoop('MemberList')

  // useChatActive subscribes only to the active conversation, not the full conversation
  // list / typingStates / drafts that useChat() pulls in. MemberList is always mounted
  // in ChatLayout, so over-subscription here re-renders the right sidebar on every
  // chat store update during sync.
  const { activeConversation } = useChatActive()
  const { sortedContacts } = useRoster()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'

  // Only show for group chats
  if (!activeConversation || activeConversation.type !== 'groupchat') return null

  // TODO: For MUC, this should show room participants, not the roster
  // For now, show roster contacts as a placeholder
  const online = sortedContacts.filter(c => (forceOffline ? 'offline' : c.presence) !== 'offline')
  const offline = sortedContacts.filter(c => (forceOffline ? 'offline' : c.presence) === 'offline')

  return (
    <aside className="w-60 bg-fluux-sidebar border-l border-fluux-bg overflow-y-auto hidden lg:block">
      <div className="p-4">
        {online.length > 0 && (
          <MemberGroup
            title={`Online — ${online.length}`}
            members={online.map(c => ({
              jid: c.jid,
              name: c.name,
              presence: forceOffline ? 'offline' : c.presence,
              status: c.statusMessage,
              avatar: c.avatar,
            }))}
          />
        )}

        {offline.length > 0 && (
          <MemberGroup
            title={`Offline — ${offline.length}`}
            members={offline.map(c => ({
              jid: c.jid,
              name: c.name,
              presence: forceOffline ? 'offline' : c.presence,
              status: c.statusMessage,
              avatar: c.avatar,
            }))}
          />
        )}
      </div>
    </aside>
  )
}

interface Member {
  jid: string
  name: string
  presence: PresenceStatus
  status?: string
  avatar?: string
}

function MemberGroup({ title, members }: { title: string; members: Member[] }) {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase mb-2">
        {title}
      </h3>
      <div className="space-y-1">
        {members.map((member) => (
          <MemberItem key={member.jid} member={member} />
        ))}
      </div>
    </div>
  )
}

function MemberItem({ member }: { member: Member }) {
  return (
    <div className="flex items-center gap-3 px-2 py-1 rounded hover:bg-fluux-hover cursor-pointer">
      {/* Avatar */}
      <Avatar
        identifier={member.jid}
        name={member.name}
        avatarUrl={member.avatar}
        size="sm"
        presence={member.presence}
        presenceBorderColor="border-fluux-sidebar"
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <UserInfoPopover jid={member.jid}>
          <p className="text-sm font-medium text-fluux-text truncate">
            {member.name}
          </p>
        </UserInfoPopover>
        {member.status && (
          <p className="text-xs text-fluux-muted truncate">
            {member.status}
          </p>
        )}
      </div>
    </div>
  )
}
