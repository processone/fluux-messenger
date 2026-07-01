// Sidebar subcomponents
export { IconRailButton } from './IconRailButton'
export { IconRailNavLink } from './IconRailNavLink'
export { PresenceSelector, StatusDisplay, StatusOrPresence } from './PresenceSelector'
export { ConversationList, ArchiveList, ConversationItem } from './ConversationList'
export { ContactList } from './ContactList'
export { RoomsList } from './RoomsList'
export { SearchView } from './SearchView'
export { UserMenu } from './UserMenu'
export { MessagesHeaderActions } from './MessagesHeaderActions'
export { ContactsHeaderActions } from './ContactsHeaderActions'
export { RoomsHeaderActions } from './RoomsHeaderActions'

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
  SIDEBAR_HEADER_ICON_BTN,
  VIEW_PATHS,
} from './types'
