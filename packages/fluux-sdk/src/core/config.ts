/**
 * SDK Configuration Constants
 *
 * Well-known servers and other configuration values.
 */

/**
 * Well-known public MUC (Multi-User Chat) servers.
 * These are displayed in the room browser as alternative servers to discover public rooms.
 */
export const WELL_KNOWN_MUC_SERVERS = [
  'conference.process-one.net',
  'conference.jabber.org',
  'muc.xmpp.org',
  'conference.igniterealtime.org',
  'conference.prosody.im',
  'channels.snikket.org',
] as const

export type WellKnownMucServer = typeof WELL_KNOWN_MUC_SERVERS[number]

/**
 * Admin commands to hide from the command list in the sidebar.
 *
 * These commands are excluded because they are redundant with dedicated UI
 * functionality available elsewhere in the application, or are not useful
 * from a GUI (more relevant as backend API):
 *
 * - change-user-password / change_password:
 *   Redundant with the "Change Password" button in AdminUserView.
 *   Users can change passwords directly from the user profile screen.
 *   See AdminView.tsx handleChangePassword() for implementation.
 *   TODO: Fall back to api-commands/change_password if XEP-0133 unavailable.
 *
 * - check_account:
 *   Returns true/false if account exists. Not useful from GUI, more relevant
 *   as API for admin backends.
 *
 * - create_rooms_file / destroy_rooms_file:
 *   Batch operations to create/destroy rooms from a file. Not suitable for GUI,
 *   more appropriate for batch processing scripts.
 *
 * - muc_online_rooms:
 *   Redundant with disco#items on MUC service which already shows rooms
 *   accessible to the current user (including all rooms for admins).
 *
 * Command names correspond to both:
 * - XEP-0133 nodes (e.g., "change-user-password" from admin#change-user-password)
 * - ejabberd API nodes (e.g., "check_account" from api-commands/check_account)
 */
export const HIDDEN_ADMIN_COMMANDS = [
  'change-user-password',  // XEP-0133 - available via AdminUserView
  'change_password',       // ejabberd API - available via AdminUserView
  'check_account',         // ejabberd API - not useful from GUI
  'create_rooms_file',     // ejabberd API - batch operation, not for GUI
  'destroy_rooms_file',    // ejabberd API - batch operation, not for GUI
  'muc_online_rooms',      // ejabberd API - redundant with disco#items
  'muc_online_rooms_count', // ejabberd API - used internally for entity counts
] as const

export type HiddenAdminCommand = typeof HIDDEN_ADMIN_COMMANDS[number]
