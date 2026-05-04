/**
 * XEP-0050 admin command nodes that operate on a specific user JID.
 * Shared by `useAdmin` (filters `userCommands`) and `useAdminPermissions`
 * (derives `hasUserCommands`).
 */
export const USER_COMMANDS = new Set([
  'http://jabber.org/protocol/admin#delete-user',
  'http://jabber.org/protocol/admin#disable-user',
  'http://jabber.org/protocol/admin#reenable-user',
  'http://jabber.org/protocol/admin#end-user-session',
  'http://jabber.org/protocol/admin#change-user-password',
  'http://jabber.org/protocol/admin#get-user-roster',
  'http://jabber.org/protocol/admin#get-user-lastlogin',
  'http://jabber.org/protocol/admin#user-stats',
])
