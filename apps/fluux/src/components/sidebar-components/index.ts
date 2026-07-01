// Sidebar subcomponents
export { IconRailButton } from './IconRailButton'
export { IconRailNavLink } from './IconRailNavLink'
export { PresenceSelector, StatusDisplay, StatusOrPresence } from './PresenceSelector'
export { ConversationList, ArchiveList, ConversationItem } from './ConversationList'
export { ContactList } from './ContactList'
export { RoomsList } from './RoomsList'
export { ActivityLogView } from './ActivityLogView'
export { SearchView } from './SearchView'
export { UserMenu } from './UserMenu'

// Types and utilities
export {
  type SidebarView,
  SidebarZoneContext,
  useSidebarZone,
  ContactDevicesTooltip,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_KEY,
  VIEW_PATHS,
} from './types'
