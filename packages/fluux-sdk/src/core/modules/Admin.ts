import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getDomain, getLocalPart } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { parseDataForm, getFormFieldValue, getFormFieldValues } from '../../utils/dataForm'
import { parseRSMResponse, buildRSMElement } from '../../utils/rsm'
import { HIDDEN_ADMIN_COMMANDS } from '../config'
import {
  NS_DISCO_ITEMS,
  NS_DISCO_INFO,
  NS_COMMANDS,
  NS_ADMIN,
  NS_DATA_FORMS,
  NS_MUC_OWNER,
  NS_RSM,
} from '../namespaces'
import type {
  AdminCommand,
  AdminCommandCategory,
  DataForm,
  AdminSession,
  RSMRequest,
  RSMResponse,
  AdminUser,
  AdminRoom,
  EntityCounts,
} from '../types'

/**
 * Server administration module via XEP-0050 Ad-Hoc Commands and XEP-0133 Service Administration.
 *
 * Provides server management capabilities for admin users including:
 * - Command discovery and execution
 * - User management (list, delete, disable users)
 * - Room management (list rooms, get configuration)
 * - Server statistics
 * - Virtual host management
 *
 * @remarks
 * Admin commands are only available to users with administrative privileges
 * on the XMPP server. The module discovers available commands via disco#items
 * and filters for XEP-0133 admin commands.
 *
 * @example
 * ```typescript
 * // Access via XMPPClient
 * client.admin.discoverAdminCommands()
 * client.admin.executeAdminCommand('http://jabber.org/protocol/admin#delete-user')
 * client.admin.fetchUserList()
 * ```
 *
 * @category Modules
 */
export class Admin extends BaseModule {
  handle(_stanza: Element): boolean | void {
    // Admin commands are request-response via IQ, handled via sendIQ promises
    return false
  }

  // ============================================================================
  // Command Discovery
  // ============================================================================

  /**
   * Discover admin commands (XEP-0133 Service Administration).
   * Queries disco#items for the commands node and filters for admin commands.
   */
  async discoverAdminCommands(): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return

    const domain = getDomain(currentJid)
    if (!domain) return

    this.deps.emitSDK('admin:discovering', { isDiscovering: true })

    try {
      const iq = xml(
        'iq',
        { type: 'get', to: domain, id: `admin_${generateUUID()}` },
        xml('query', { xmlns: NS_DISCO_ITEMS, node: NS_COMMANDS })
      )

      const result = await this.deps.sendIQ(iq)
      const query = result.getChild('query', NS_DISCO_ITEMS)
      const items = query?.getChildren('item') || []

      // Filter and categorize admin commands
      const adminCommands: AdminCommand[] = items
        .filter((item: Element) => {
          const node = item.attrs.node as string | undefined
          if (!node?.startsWith(`${NS_ADMIN}#`) && !node?.startsWith('api-commands/')) {
            return false
          }
          const commandName = this.extractCommandName(node)
          return !HIDDEN_ADMIN_COMMANDS.includes(commandName as typeof HIDDEN_ADMIN_COMMANDS[number])
        })
        .map((item: Element) => {
          const node = item.attrs.node as string
          const commandName = this.extractCommandName(node)
          const name = item.attrs.name as string || commandName
          const category = this.categorizeCommand(commandName)
          return { node, name, category }
        })

      const isAdmin = adminCommands.length > 0
      this.deps.emitSDK('admin:is-admin', { isAdmin })
      this.deps.emitSDK('admin:commands', { commands: adminCommands })

      if (isAdmin) {
        this.deps.emitSDK('console:event', {
          message: `Admin access: ${adminCommands.length} commands available`,
          category: 'connection',
        })
      }
    } catch (_err) {
      // No admin commands available - user is not an admin
      this.deps.emitSDK('admin:is-admin', { isAdmin: false })
      this.deps.emitSDK('admin:commands', { commands: [] })
    } finally {
      this.deps.emitSDK('admin:discovering', { isDiscovering: false })
    }
  }

  private extractCommandName(node: string): string {
    if (node.startsWith('api-commands/')) {
      return node.replace('api-commands/', '')
    }
    return node.split('#').pop() || node
  }

  private categorizeCommand(commandName: string): AdminCommandCategory {
    // User management commands
    if (['add-user', 'delete-user', 'disable-user', 'reenable-user',
         'end-user-session', 'change-user-password', 'get-user-roster',
         'get-user-lastlogin', 'user-stats', 'get-user-statistics',
         'ban_account', 'unban_account', 'registered_users', 'register', 'unregister',
         'get-registered-users-list', 'get-online-users-list',
         'connected_users', 'connected_users_number', 'connected_users_info',
         'user_resources', 'user_sessions_info', 'kick_user', 'check_account',
         'check_password', 'check_password_hash', 'set_nickname'].includes(commandName)) {
      return 'user'
    }
    // Statistics and server info commands
    if (['get-online-users-num', 'get-registered-users-num', 'num-active-users',
         'server-stats', 'stats', 'status', 'status_list', 'status_num',
         'get-server-stats', 'online-users', 'registered-users-num',
         'uptime', 'incoming_s2s_number', 'outgoing_s2s_number',
         'list_cluster', 'connected_users_vhost'].includes(commandName)) {
      return 'stats'
    }
    // Announcement/messaging commands
    if (['announce', 'set-motd', 'edit-motd', 'delete-motd',
         'set-welcome', 'delete-welcome', 'send_message',
         'send_stanza', 'send_stanza_c2s', 'send_direct_invitation',
         'send_broadcast_message'].includes(commandName)) {
      return 'announcement'
    }
    return 'other'
  }

  // ============================================================================
  // Command Execution
  // ============================================================================

  /**
   * Execute an admin command (XEP-0050 Ad-Hoc Commands).
   * @param node - Command node to execute
   * @param action - Command action (execute, next, prev, complete, cancel)
   * @param sessionId - Session ID for multi-step commands
   * @param formData - Form data to submit
   */
  async executeAdminCommand(
    node: string,
    action: 'execute' | 'next' | 'prev' | 'complete' | 'cancel' = 'execute',
    sessionId?: string,
    formData?: Record<string, string | string[]>
  ): Promise<AdminSession> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) throw new Error('Not connected')

    const domain = getDomain(currentJid)
    if (!domain) throw new Error('Invalid JID')

    this.deps.emitSDK('admin:executing', { isExecuting: true })

    try {
      // Build command element
      const commandAttrs: Record<string, string> = {
        xmlns: NS_COMMANDS,
        node,
        action,
      }
      if (sessionId) {
        commandAttrs.sessionid = sessionId
      }

      const commandChildren: Element[] = []

      // Add form data if provided
      if (formData && Object.keys(formData).length > 0) {
        const fields = Object.entries(formData).map(([varName, value]) => {
          const values = Array.isArray(value) ? value : [value]
          return xml('field', { var: varName },
            ...values.map(v => xml('value', {}, v))
          )
        })
        commandChildren.push(
          xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' }, ...fields)
        )
      }

      const iq = xml(
        'iq',
        { type: 'set', to: domain, id: `cmd_${generateUUID()}` },
        xml('command', commandAttrs, ...commandChildren)
      )

      const result = await this.deps.sendIQ(iq)
      const command = result.getChild('command', NS_COMMANDS)

      if (!command) {
        throw new Error('Invalid command response')
      }

      // Parse response
      const session: AdminSession = {
        sessionId: command.attrs.sessionid || sessionId || '',
        node,
        status: command.attrs.status as AdminSession['status'] || 'executing',
        actions: [],
      }

      // Parse available actions
      const actionsEl = command.getChild('actions')
      if (actionsEl) {
        session.actions = actionsEl.children
          .filter((child: unknown): child is Element =>
            typeof child !== 'string' && (child as Element).name !== undefined
          )
          .map((child: Element) => child.name)
      }

      // Parse note
      const noteEl = command.getChild('note')
      if (noteEl) {
        const noteType = noteEl.attrs.type as 'info' | 'warn' | 'error' | undefined
        session.note = {
          type: noteType || 'info',
          text: noteEl.text() || '',
        }
      }

      // Parse form
      const formEl = command.getChild('x', NS_DATA_FORMS)
      if (formEl) {
        session.form = parseDataForm(formEl)
      }

      this.deps.emitSDK('admin:session', { session })
      return session
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Command failed'
      const errorSession: AdminSession = {
        sessionId: sessionId || '',
        node,
        status: 'canceled',
        note: { type: 'error', text: errorMessage },
      }
      this.deps.emitSDK('admin:session', { session: errorSession })
      throw err
    } finally {
      this.deps.emitSDK('admin:executing', { isExecuting: false })
    }
  }

  /**
   * Cancel the current admin command session.
   */
  async cancelAdminCommand(): Promise<void> {
    const session = this.deps.stores?.admin.getCurrentSession?.()
    if (!session || session.status !== 'executing') {
      this.deps.emitSDK('admin:session', { session: null })
      return
    }

    try {
      await this.executeAdminCommand(session.node, 'cancel', session.sessionId)
    } catch {
      // Ignore cancel errors
    }
    this.deps.emitSDK('admin:session', { session: null })
  }

  // ============================================================================
  // Entity Counts
  // ============================================================================

  /**
   * Fetch entity counts for admin dashboard badges.
   * Executes get-registered-users-num, get-online-users-num, and muc_online_rooms_count commands.
   */
  async fetchEntityCounts(): Promise<EntityCounts> {
    const counts: EntityCounts = {}

    // Try to fetch registered users count
    try {
      const regResult = await this.executeSimpleCommand('get-registered-users-num')
      if (regResult) {
        const numField = getFormFieldValue(regResult, 'registeredusersnum')
        if (numField) {
          counts.users = parseInt(numField, 10)
        }
      }
    } catch {
      // Command may not be available
    }

    // Try to fetch online users count
    try {
      const onlineResult = await this.executeSimpleCommand('get-online-users-num')
      if (onlineResult) {
        const numField = getFormFieldValue(onlineResult, 'onlineusersnum')
        if (numField) {
          counts.onlineUsers = parseInt(numField, 10)
        }
      }
    } catch {
      // Command may not be available
    }

    // Try to fetch online MUC rooms count using ejabberd API command
    // Note: This is sent to the server domain (not MUC service) with api-commands/ prefix
    try {
      const roomsResult = await this.executeApiCommand('muc_online_rooms_count')
      if (roomsResult) {
        // The field name varies - try common variations
        const numField = getFormFieldValue(roomsResult, 'onlineroomsnum') ||
                        getFormFieldValue(roomsResult, 'rooms') ||
                        getFormFieldValue(roomsResult, 'count')
        if (numField) {
          counts.rooms = parseInt(numField, 10)
        }
      }
    } catch {
      // Command may not be available
    }

    this.deps.emitSDK('admin:entity-counts', { counts })
    return counts
  }

  /**
   * Execute a simple admin command and return the result form.
   * For commands that complete in one step without user input.
   */
  private async executeSimpleCommand(commandName: string): Promise<DataForm | null> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return null

    const node = `${NS_ADMIN}#${commandName}`
    const domain = getDomain(currentJid)

    try {
      const iq = xml(
        'iq',
        { type: 'set', to: domain, id: `cmd_${generateUUID()}` },
        xml('command', { xmlns: NS_COMMANDS, node, action: 'execute' })
      )

      const result = await this.deps.sendIQ(iq)
      const command = result.getChild('command', NS_COMMANDS)

      if (!command) return null

      const formEl = command.getChild('x', NS_DATA_FORMS)
      if (!formEl) return null

      return parseDataForm(formEl)
    } catch {
      return null
    }
  }

  /**
   * Execute an ejabberd API command (api-commands/ prefix).
   * These are sent to the server domain, not a specific service.
   * Handles multi-step commands that require form submission.
   * @param commandName - The command name (e.g., muc_online_rooms_count)
   */
  private async executeApiCommand(commandName: string): Promise<DataForm | null> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return null

    const domain = getDomain(currentJid)
    const node = `api-commands/${commandName}`

    try {
      // Step 1: Execute command
      const iq = xml(
        'iq',
        { type: 'set', to: domain, id: `api_cmd_${generateUUID()}` },
        xml('command', { xmlns: NS_COMMANDS, node, action: 'execute' })
      )

      const result = await this.deps.sendIQ(iq)
      const command = result.getChild('command', NS_COMMANDS)

      if (!command) return null

      const status = command.attrs.status
      const formEl = command.getChild('x', NS_DATA_FORMS)

      // If completed, return the form directly
      if (status === 'completed') {
        return formEl ? parseDataForm(formEl) : null
      }

      // If executing (multi-step), submit the form to complete
      if (status === 'executing' && formEl) {
        const sessionId = command.attrs.sessionid
        const form = parseDataForm(formEl)

        // Build submit form with default values from the form
        // Filter out fixed fields and fields without var (they shouldn't be submitted)
        const submitFields = form.fields
          .filter(field => field.var && field.type !== 'fixed')
          .map(field => {
            const values = Array.isArray(field.value) ? field.value : (field.value ? [field.value] : [])
            return xml('field', { var: field.var },
              ...values.map((v: string) => xml('value', {}, v))
            )
          })

        const submitForm = xml(
          'x',
          { xmlns: NS_DATA_FORMS, type: 'submit' },
          ...submitFields
        )

        // Step 2: Complete the command with the form
        const completeIq = xml(
          'iq',
          { type: 'set', to: domain, id: `api_cmd_${generateUUID()}` },
          xml('command', { xmlns: NS_COMMANDS, node, sessionid: sessionId, action: 'complete' },
            submitForm
          )
        )

        const completeResult = await this.deps.sendIQ(completeIq)
        const completeCommand = completeResult.getChild('command', NS_COMMANDS)
        const resultFormEl = completeCommand?.getChild('x', NS_DATA_FORMS)

        return resultFormEl ? parseDataForm(resultFormEl) : null
      }

      return formEl ? parseDataForm(formEl) : null
    } catch {
      return null
    }
  }

  // ============================================================================
  // Virtual Hosts
  // ============================================================================

  /**
   * Fetch list of available virtual hosts for admin operations.
   * Queries disco#items on the server to find domains with admin commands.
   */
  async fetchVhosts(): Promise<string[]> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) throw new Error('Not connected')

    const currentDomain = getDomain(currentJid)
    if (!currentDomain) return []

    // Start with current domain
    const vhosts: string[] = [currentDomain]

    try {
      // Query disco#items on server domain to find other vhosts
      const itemsIq = xml(
        'iq',
        { type: 'get', to: currentDomain, id: `vhosts_${generateUUID()}` },
        xml('query', { xmlns: NS_DISCO_ITEMS })
      )

      const result = await this.deps.sendIQ(itemsIq)
      const query = result.getChild('query', NS_DISCO_ITEMS)
      const items = query?.getChildren('item') || []

      // Look for items that are domains (no node attribute, jid looks like a domain)
      for (const item of items) {
        const jid = item.attrs.jid as string | undefined
        const node = item.attrs.node as string | undefined

        // Skip items with nodes (these are services, not vhosts)
        if (node || !jid) continue

        // Check if this JID looks like a domain (no @ symbol, not a subdomain service)
        if (!jid.includes('@') && !jid.startsWith('conference.') &&
            !jid.startsWith('pubsub.') && !jid.startsWith('upload.') &&
            !jid.startsWith('multicast.') && !jid.startsWith('proxy.') &&
            !jid.startsWith('muc.') && !vhosts.includes(jid)) {
          // Try to check if this domain has admin commands
          try {
            const adminIq = xml(
              'iq',
              { type: 'get', to: jid, id: `admin_check_${generateUUID()}` },
              xml('query', { xmlns: NS_DISCO_ITEMS, node: NS_COMMANDS })
            )
            const adminResult = await this.deps.sendIQ(adminIq)
            const adminQuery = adminResult.getChild('query', NS_DISCO_ITEMS)
            const adminItems = adminQuery?.getChildren('item') || []

            // Check if there are admin commands on this domain
            const hasAdminCommands = adminItems.some((i: Element) => {
              const itemNode = i.attrs.node as string | undefined
              return itemNode?.startsWith(`${NS_ADMIN}#`) || itemNode?.startsWith('api-commands/')
            })

            if (hasAdminCommands) {
              vhosts.push(jid)
            }
          } catch {
            // Can't query this domain, skip it
          }
        }
      }
    } catch {
      // disco#items not available, return just current domain
    }

    // Emit vhosts event
    this.deps.emitSDK('admin:vhosts', { vhosts })

    // Auto-select current domain if no vhost selected
    if (!this.deps.stores?.admin.selectedVhost && vhosts.length > 0) {
      this.deps.emitSDK('admin:selected-vhost', { vhost: vhosts[0] })
    }

    return vhosts
  }

  // ============================================================================
  // User Management
  // ============================================================================

  /**
   * Fetch paginated list of registered users via XEP-0133.
   * @param vhost - Virtual host to query (defaults to current domain)
   * @param rsm - RSM pagination parameters
   */
  async fetchUserList(vhost?: string, rsm?: RSMRequest): Promise<{
    users: AdminUser[]
    pagination: RSMResponse
  }> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) throw new Error('Not connected')

    const node = `${NS_ADMIN}#get-registered-users-list`
    const domain = vhost || getDomain(currentJid)

    // Step 1: Execute the command
    const executeIq = xml(
      'iq',
      { type: 'set', to: domain, id: `users_${generateUUID()}` },
      xml('command', { xmlns: NS_COMMANDS, node, action: 'execute' })
    )

    const executeResult = await this.deps.sendIQ(executeIq)
    let command = executeResult.getChild('command', NS_COMMANDS)

    if (!command) {
      throw new Error('Invalid response: no command element')
    }

    // Step 2: If status is 'executing', we need to complete the command
    if (command.attrs.status === 'executing') {
      const sessionId = command.attrs.sessionid

      // Build complete command with RSM and empty form submission
      const completeChildren: Element[] = [
        xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' })
      ]
      if (rsm) {
        completeChildren.push(buildRSMElement(rsm))
      }

      const completeIq = xml(
        'iq',
        { type: 'set', to: domain, id: `users_${generateUUID()}` },
        xml('command', {
          xmlns: NS_COMMANDS,
          node,
          action: 'complete',
          sessionid: sessionId,
        }, ...completeChildren)
      )

      const completeResult = await this.deps.sendIQ(completeIq)
      command = completeResult.getChild('command', NS_COMMANDS)

      if (!command) {
        throw new Error('Invalid response: no command element after complete')
      }
    }

    // Parse RSM response
    const setEl = command.getChild('set', NS_RSM)
    const pagination = parseRSMResponse(setEl)

    // Parse data form to get user list
    const formEl = command.getChild('x', NS_DATA_FORMS)
    const users: AdminUser[] = []

    if (formEl) {
      const form = parseDataForm(formEl)
      // Look for JIDs field - different servers use different field names
      // ejabberd uses 'registereduserjids', others may use 'accountjids' or 'userjids'
      let jids = getFormFieldValues(form, 'registereduserjids')
      if (jids.length === 0) {
        jids = getFormFieldValues(form, 'accountjids')
      }
      if (jids.length === 0) {
        jids = getFormFieldValues(form, 'userjids')
      }
      for (const jid of jids) {
        if (jid) {
          users.push({
            jid,
            username: getLocalPart(jid),
          })
        }
      }
    }

    return { users, pagination }
  }

  // ============================================================================
  // Room Management
  // ============================================================================

  /**
   * Discover MUC service JID from server disco#items.
   */
  async discoverMucService(): Promise<string | null> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return null

    const domain = getDomain(currentJid)

    try {
      // Query disco#items on server domain
      const itemsIq = xml(
        'iq',
        { type: 'get', to: domain, id: `disco_items_${generateUUID()}` },
        xml('query', { xmlns: NS_DISCO_ITEMS })
      )

      const itemsResult = await this.deps.sendIQ(itemsIq)
      const query = itemsResult.getChild('query', NS_DISCO_ITEMS)
      const items = query?.getChildren('item') || []

      // Check each item for MUC service
      for (const item of items) {
        const jid = item.attrs.jid
        if (!jid) continue

        try {
          // Query disco#info on each service
          const infoIq = xml(
            'iq',
            { type: 'get', to: jid, id: `disco_info_${generateUUID()}` },
            xml('query', { xmlns: NS_DISCO_INFO })
          )

          const infoResult = await this.deps.sendIQ(infoIq)
          const infoQuery = infoResult.getChild('query', NS_DISCO_INFO)
          const identities = infoQuery?.getChildren('identity') || []

          // Look for MUC identity (category="conference")
          for (const identity of identities) {
            if (identity.attrs.category === 'conference') {
              this.deps.emitSDK('admin:muc-service', { mucServiceJid: jid })
              return jid
            }
          }
        } catch {
          // Skip services we can't query
        }
      }
    } catch (_error) {
      // Silently ignore MUC service discovery errors
    }

    return null
  }

  /**
   * Fetch paginated list of public rooms from MUC service.
   * @param mucServiceJid - Optional MUC service JID. If not provided, uses auto-discovered service.
   * @param rsm - RSM pagination parameters
   */
  async fetchRoomList(mucServiceJid?: string, rsm?: RSMRequest): Promise<{
    rooms: AdminRoom[]
    pagination: RSMResponse
  }> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) throw new Error('Not connected')

    // Use provided MUC service JID, or get auto-discovered one
    let mucJid: string | null | undefined = mucServiceJid
    if (!mucJid) {
      mucJid = this.deps.stores?.admin.getMucServiceJid?.()
      if (!mucJid) {
        mucJid = await this.discoverMucService()
      }
    }

    if (!mucJid) {
      throw new Error('MUC service not available')
    }

    // Build disco#items query with RSM
    const queryChildren: Element[] = []
    if (rsm) {
      queryChildren.push(buildRSMElement(rsm))
    }

    const iq = xml(
      'iq',
      { type: 'get', to: mucJid, id: `rooms_${generateUUID()}` },
      xml('query', { xmlns: NS_DISCO_ITEMS }, ...queryChildren)
    )

    const result = await this.deps.sendIQ(iq)
    const query = result.getChild('query', NS_DISCO_ITEMS)

    if (!query) {
      throw new Error('Invalid response: no query element')
    }

    // Parse RSM response
    const setEl = query.getChild('set', NS_RSM)
    const pagination = parseRSMResponse(setEl)

    // Parse room items
    const rooms: AdminRoom[] = []
    const items = query.getChildren('item') || []

    for (const item of items) {
      const jid = item.attrs.jid
      const name = item.attrs.name || getLocalPart(jid)
      if (jid) {
        rooms.push({ jid, name })
      }
    }

    return { rooms, pagination }
  }

  /**
   * Fetch room configuration/options (XEP-0045 room configuration).
   * @param roomJid - The room JID to get options for
   */
  async fetchRoomOptions(roomJid: string): Promise<DataForm> {
    const iq = xml('iq', { type: 'get', to: roomJid, id: `room_config_${generateUUID()}` },
      xml('query', { xmlns: NS_MUC_OWNER })
    )

    const result = await this.deps.sendIQ(iq)
    const query = result.getChild('query', NS_MUC_OWNER)
    const formEl = query?.getChild('x', NS_DATA_FORMS)

    if (!formEl) {
      throw new Error('Room did not return a configuration form')
    }

    return parseDataForm(formEl)
  }
}
