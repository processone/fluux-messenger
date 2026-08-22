import { ListEmpty } from '@xmpp/fluux'
import { MessageSquare, Search, Users, UserPlus } from 'lucide-react'
import { Surface } from './_surface'

const noop = () => {}

export const Default = () => (
  <Surface className="max-w-sm">
    <ListEmpty icon={MessageSquare} title="No conversations yet" />
  </Surface>
)

export const WithDescription = () => (
  <Surface className="max-w-sm">
    <ListEmpty
      icon={Users}
      title="No contacts"
      description="Add someone by their XMPP address to start chatting."
    />
  </Surface>
)

export const WithAction = () => (
  <Surface className="max-w-sm">
    <ListEmpty
      icon={Users}
      title="No contacts"
      description="Add someone by their XMPP address to start chatting."
      action={{ label: 'Add contact', icon: UserPlus, onClick: noop }}
    />
  </Surface>
)

export const NoResults = () => (
  <Surface className="max-w-sm">
    <ListEmpty icon={Search} title="No results" description="Try a different search term." />
  </Surface>
)
