/**
 * Demo entry point — renders the full Fluux UI with realistic fake data.
 *
 * Access via /demo.html in the dev server or production build.
 * No XMPP server required.
 *
 * URL parameters:
 *   ?tutorial=false  — disable tutorial tooltips (for video recording)
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { XMPPProvider, DemoClient } from '@fluux/sdk'
import { adminStore, ignoreStore } from '@fluux/sdk/stores'
import { ThemeProvider } from './providers/ThemeProvider'
import { useThemeStore } from './stores/themeStore'
import { RenderLoopBoundary, RenderLoopWarningBanner } from './components/RenderLoopBoundary'
import { DemoTutorialProvider } from './demo/tutorial/DemoTutorialProvider'
import { buildDemoData, buildDemoAnimation } from './demo/demoData'
import { getDiscoverableRooms } from './demo/rooms'
import App from './App'
import i18n from './i18n'
import './index.css'

// Parse URL parameters
const params = new URLSearchParams(window.location.search)
const tutorialEnabled = params.get('tutorial') !== 'false'

// Clear all persisted state to prevent stale data from real/previous sessions.
// Demo uses its own transient state — we don't want leftover data from the
// real app or from a previous demo reload.
const DEMO_STORAGE_PREFIXES = ['fluux:', 'fluux-', 'xmpp-']
for (const key of Object.keys(localStorage)) {
  if (DEMO_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) {
    localStorage.removeItem(key)
  }
}
// Clear IndexedDB caches (async, best-effort)
indexedDB.deleteDatabase('fluux-message-cache')
indexedDB.deleteDatabase('fluux-avatar-cache')

// Create demo client and populate stores synchronously before first render
const demoData = buildDemoData()
const demoAnimation = buildDemoAnimation()

const demoClient = new DemoClient()
demoClient.populateDemo(demoData)
demoClient.setDiscoverableRooms(getDiscoverableRooms())

// Expose demo client and stores for automation (screenshot scripts, testing)
;(window as any).__demoClient = demoClient
;(window as any).__adminStore = adminStore
;(window as any).__themeStore = useThemeStore
;(window as any).__i18n = i18n

// Seed admin store so the Admin panel is accessible in demo
adminStore.getState().setIsAdmin(true)
adminStore.getState().setVhosts(['fluux.chat'])
adminStore.getState().setSelectedVhost('fluux.chat')
adminStore.getState().setCommands([
  // User management (XEP-0133)
  { node: 'http://jabber.org/protocol/admin#add-user', name: 'Add a User', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#delete-user', name: 'Delete User', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#disable-user', name: 'Disable User', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#reenable-user', name: 'Re-Enable User', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#end-user-session', name: 'End User Session', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#change-user-password', name: 'Change User Password', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#get-user-roster', name: 'Get User Roster', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#get-user-lastlogin', name: 'Get User Last Login', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#user-stats', name: 'Get User Statistics', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#get-registered-users-list', name: 'Get Registered Users', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#get-online-users-list', name: 'Get Online Users', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#get-active-users', name: 'Get Active Users', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#get-idle-users', name: 'Get Idle Users', category: 'user' },
  { node: 'http://jabber.org/protocol/admin#get-disabled-users-list', name: 'Get Disabled Users', category: 'user' },
  // API commands (ejabberd-specific)
  { node: 'api-commands/ban_account', name: 'Ban Account', category: 'user' },
  { node: 'api-commands/unban_account', name: 'Unban Account', category: 'user' },
  { node: 'api-commands/check_account', name: 'Check Account', category: 'user' },
  { node: 'api-commands/check_password', name: 'Check Password', category: 'user' },
  { node: 'api-commands/registered_users', name: 'Registered Users', category: 'user' },
  { node: 'api-commands/kick_user', name: 'Kick User', category: 'user' },
  { node: 'api-commands/kick_session', name: 'Kick Session', category: 'user' },
  { node: 'api-commands/user_info', name: 'User Info', category: 'user' },
  { node: 'api-commands/user_sessions_info', name: 'User Sessions Info', category: 'user' },
  // Statistics
  { node: 'http://jabber.org/protocol/admin#get-registered-users-num', name: 'Registered Users Count', category: 'stats' },
  { node: 'http://jabber.org/protocol/admin#get-online-users-num', name: 'Online Users Count', category: 'stats' },
  { node: 'http://jabber.org/protocol/admin#get-active-users-num', name: 'Active Users Count', category: 'stats' },
  { node: 'http://jabber.org/protocol/admin#get-idle-users-num', name: 'Idle Users Count', category: 'stats' },
  { node: 'http://jabber.org/protocol/admin#get-disabled-users-num', name: 'Disabled Users Count', category: 'stats' },
  { node: 'api-commands/stats', name: 'Server Stats', category: 'stats' },
  { node: 'api-commands/status', name: 'Server Status', category: 'stats' },
  { node: 'api-commands/server_info', name: 'Server Info', category: 'stats' },
  { node: 'api-commands/server_version', name: 'Server Version', category: 'stats' },
  // Announcements
  { node: 'http://jabber.org/protocol/admin#announce', name: 'Send Announcement to Online Users', category: 'announcement' },
  { node: 'http://jabber.org/protocol/admin#announce-all', name: 'Send Announcement to All Users', category: 'announcement' },
  { node: 'http://jabber.org/protocol/admin#set-motd', name: 'Set Message of the Day', category: 'announcement' },
  { node: 'http://jabber.org/protocol/admin#edit-motd', name: 'Update Message of the Day', category: 'announcement' },
  { node: 'http://jabber.org/protocol/admin#delete-motd', name: 'Delete Message of the Day', category: 'announcement' },
  { node: 'api-commands/send_message', name: 'Send Message', category: 'announcement' },
  { node: 'api-commands/send_direct_invitation', name: 'Send Direct Invitation', category: 'announcement' },
  // Room management
  { node: 'api-commands/create_room', name: 'Create Room', category: 'other' },
  { node: 'api-commands/destroy_room', name: 'Destroy Room', category: 'other' },
  { node: 'api-commands/change_room_option', name: 'Change Room Option', category: 'other' },
  { node: 'api-commands/get_room_options', name: 'Get Room Options', category: 'other' },
  { node: 'api-commands/get_room_affiliations', name: 'Get Room Affiliations', category: 'other' },
  { node: 'api-commands/set_room_affiliation', name: 'Set Room Affiliation', category: 'other' },
  { node: 'api-commands/get_room_occupants', name: 'Get Room Occupants', category: 'other' },
  { node: 'api-commands/get_room_occupants_number', name: 'Get Room Occupants Number', category: 'other' },
  { node: 'api-commands/muc_online_rooms', name: 'Online Rooms', category: 'other' },
  { node: 'api-commands/muc_online_rooms_count', name: 'Online Rooms Count', category: 'other' },
  { node: 'api-commands/rooms_empty_list', name: 'Empty Rooms List', category: 'other' },
  // Other
  { node: 'api-commands/change_password', name: 'Change Password', category: 'other' },
  { node: 'api-commands/get_vcard', name: 'Get vCard', category: 'other' },
  { node: 'api-commands/set_vcard', name: 'Set vCard', category: 'other' },
  { node: 'api-commands/oauth_issue_token', name: 'Issue OAuth Token', category: 'other' },
  { node: 'api-commands/oauth_list_tokens', name: 'List OAuth Tokens', category: 'other' },
  { node: 'api-commands/oauth_revoke_token', name: 'Revoke OAuth Token', category: 'other' },
  { node: 'http://jabber.org/protocol/admin#restart', name: 'Restart Service', category: 'other' },
  { node: 'http://jabber.org/protocol/admin#shutdown', name: 'Shutdown Service', category: 'other' },
  { node: 'ping', name: 'Ping', category: 'other' },
])
adminStore.getState().setUsers([
  'you@fluux.chat', 'emma@fluux.chat', 'james@fluux.chat',
  'sophia@fluux.chat', 'oliver@fluux.chat', 'mia@fluux.chat',
  'liam@fluux.chat', 'ava@fluux.chat', 'alex@fluux.chat',
])
adminStore.getState().setUserList({
  items: [
    { jid: 'emma@fluux.chat', username: 'emma', isOnline: true },
    { jid: 'james@fluux.chat', username: 'james', isOnline: true },
    { jid: 'sophia@fluux.chat', username: 'sophia', isOnline: true },
    { jid: 'oliver@fluux.chat', username: 'oliver', isOnline: true },
    { jid: 'mia@fluux.chat', username: 'mia', isOnline: false },
    { jid: 'liam@fluux.chat', username: 'liam', isOnline: true },
    { jid: 'ava@fluux.chat', username: 'ava', isOnline: true },
    { jid: 'alex@fluux.chat', username: 'alex', isOnline: false },
  ],
  isLoading: false,
  error: null,
  searchQuery: '',
  pagination: { count: 8 },
})
adminStore.getState().setRoomList({
  items: [
    { jid: 'team@conference.fluux.chat', name: 'Team Chat', occupants: 6 },
    { jid: 'design@conference.fluux.chat', name: 'Design Review', occupants: 4 },
  ],
  isLoading: false,
  error: null,
  searchQuery: '',
  pagination: { count: 2 },
})
adminStore.getState().setEntityCounts({ users: 8, onlineUsers: 6, rooms: 2 })
adminStore.getState().setStats({ onlineUsers: 6, registeredUsers: 8, lastFetched: new Date() })

// Seed an ignored user in Team Chat so the occupant panel shows the "Ignored Users" section
ignoreStore.getState().setIgnoredForRoom('team@conference.fluux.chat', [
  { identifier: 'alex@fluux.chat', displayName: 'Alex', jid: 'alex@fluux.chat' },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RenderLoopBoundary>
      <XMPPProvider client={demoClient}>
        <ThemeProvider>
          <DemoTutorialProvider enabled={tutorialEnabled} client={demoClient} animation={demoAnimation}>
            <HashRouter>
              <App />
            </HashRouter>
          </DemoTutorialProvider>
        </ThemeProvider>
      </XMPPProvider>
      {import.meta.env.DEV && <RenderLoopWarningBanner />}
    </RenderLoopBoundary>
  </React.StrictMode>,
)

// Animation is started inside DemoTutorialProvider's useEffect to avoid
// a timing race with React StrictMode's mount/destroy/remount cycle.
