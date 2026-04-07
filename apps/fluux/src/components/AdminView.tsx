import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench, Users, Hash, User, Plus, ArrowLeft } from 'lucide-react'
import { useAdmin, useXMPP, type AdminCategory, type AdminUser, type AdminRoom } from '@fluux/sdk'
import { useWindowDrag, useModalInput } from '@/hooks'
import { Tooltip } from './Tooltip'
import { ModalShell } from './ModalShell'
import { AdminCommandForm, AdminCommandResult } from './AdminCommandForm'
import { TextInput } from './ui/TextInput'
import { EntityListView } from './EntityListView'
import { UserListItem } from './UserListItem'
import { RoomListItem } from './RoomListItem'
import { AdminUserView } from './AdminUserView'
import { AdminRoomView } from './AdminRoomView'

interface AdminViewProps {
  activeCategory: AdminCategory | null
  onBack?: () => void
}

export function AdminView({ activeCategory, onBack }: AdminViewProps) {
  const { t } = useTranslation()
  const { titleBarClass } = useWindowDrag()
  const { client } = useXMPP()
  const {
    currentSession,
    isExecuting,
    submitForm,
    previousStep,
    cancelCommand,
    clearSession,
    clearTargetJid,
    targetJid,
    canGoBack,
    canGoNext,
    // Entity list state and methods
    userList,
    roomList,
    entityCounts,
    hasMoreUsers,
    hasMoreRooms,
    fetchUsers,
    loadMoreUsers,
    resetUserList,
    fetchRooms,
    loadMoreRooms,
    resetRoomList,
    executeCommandForUser,
    addUser,
    // Vhost support
    vhosts,
    selectedVhost,
    setSelectedVhost,
    fetchVhosts,
    // Pending user navigation (from roster context menu)
    pendingSelectedUserJid,
    clearPendingSelectedUserJid,
    // Room options
    getRoomOptions,
    hasCommand,
  } = useAdmin()

  // Local state
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [roomSearchQuery, setRoomSearchQuery] = useState('')
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)
  const [selectedRoom, setSelectedRoom] = useState<AdminRoom | null>(null)
  const [showAddUserModal, setShowAddUserModal] = useState(false)

  // Fetch vhosts when users category becomes active
  useEffect(() => {
    if (activeCategory === 'users' && vhosts.length === 0) {
      fetchVhosts().catch(console.error)
    }
  }, [activeCategory, vhosts.length, fetchVhosts])

  // Fetch users when users category becomes active (always refresh on enter)
  useEffect(() => {
    if (activeCategory === 'users' && !userList.isLoading) {
      fetchUsers().catch(console.error)
    }
  }, [activeCategory]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle pending user selection (from roster context menu "Manage" action)
  useEffect(() => {
    if (pendingSelectedUserJid && activeCategory === 'users' && userList.hasFetched) {
      // Find the user in the list
      const user = userList.items.find(u => u.jid === pendingSelectedUserJid)
      if (user) {
        setSelectedUser(user)
      } else {
        // User not in current list - create a minimal AdminUser object
        // This handles cases where the user exists but wasn't in the first page
        const username = pendingSelectedUserJid.split('@')[0]
        setSelectedUser({
          jid: pendingSelectedUserJid,
          username,
          isOnline: false, // Unknown
        })
      }
      // Clear the pending JID
      clearPendingSelectedUserJid()
    }
  }, [pendingSelectedUserJid, activeCategory, userList.hasFetched, userList.items, clearPendingSelectedUserJid])

  // Handle vhost change - reset user list and refetch
  const handleVhostChange = (vhost: string) => {
    setSelectedVhost(vhost)
    resetUserList()
    setUserSearchQuery('')
    setSelectedUser(null)
  }

  // Fetch rooms when rooms category becomes active (always refresh on enter)
  useEffect(() => {
    if (activeCategory === 'rooms' && !roomList.isLoading) {
      fetchRooms().catch(console.error)
    }
  }, [activeCategory]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset lists and selected user when category changes
  useEffect(() => {
    if (activeCategory !== 'users') {
      resetUserList()
      setUserSearchQuery('')
      setSelectedUser(null)
    }
    if (activeCategory !== 'rooms') {
      resetRoomList()
      setRoomSearchQuery('')
      setSelectedRoom(null)
    }
  }, [activeCategory, resetUserList, resetRoomList])

  // Clear selected user when a command session starts
  useEffect(() => {
    if (currentSession) {
      setSelectedUser(null)
    }
  }, [currentSession])

  const handleSubmitForm = async (formData: Record<string, string | string[]>) => {
    try {
      await submitForm(formData)
    } catch (error) {
      console.error('Failed to submit form:', error)
    }
  }

  const handleCancel = async () => {
    try {
      await cancelCommand()
    } catch (error) {
      console.error('Failed to cancel command:', error)
    }
  }

  const handleCloseSession = () => {
    clearSession()
    // Refresh user list after user-mutating commands (delete, password change, etc.)
    if (activeCategory === 'users') {
      resetUserList()
      void fetchUsers()
    }
  }

  const handlePrev = async () => {
    try {
      await previousStep()
    } catch (error) {
      console.error('Failed to go to previous step:', error)
    }
  }

  // User selection handler
  const handleSelectUser = (user: AdminUser) => {
    setSelectedUser(user)
  }

  // User action handlers
  const handleDeleteUser = (jid: string) => {
    void executeCommandForUser('http://jabber.org/protocol/admin#delete-user', jid)
  }

  // TODO: Fall back to 'api-commands/change_password' if standard command unavailable
  // Priority: XEP-0133 admin#change-user-password > ejabberd api-commands/change_password
  const handleChangePassword = (jid: string) => {
    void executeCommandForUser('http://jabber.org/protocol/admin#change-user-password', jid)
  }

  const handleEndSessions = (jid: string) => {
    void executeCommandForUser('http://jabber.org/protocol/admin#end-user-session', jid)
  }

  const handleAddUser = () => {
    setShowAddUserModal(true)
  }

  const handleAddUserSubmit = async (username: string, password: string) => {
    await addUser(username, password)
    setShowAddUserModal(false)
    // Refresh user list
    resetUserList()
    void fetchUsers()
  }

  const handleDestroyRoom = async (jid: string) => {
    try {
      await client.muc.destroyRoom(jid)
      setSelectedRoom(null)
      resetRoomList()
      void fetchRooms()
    } catch (err) {
      console.error('Failed to destroy room:', err)
    }
  }


  // Filter users by search query (client-side for now)
  const filteredUsers = userSearchQuery
    ? userList.items.filter(user =>
        user.jid.toLowerCase().includes(userSearchQuery.toLowerCase()) ||
        (user.username && user.username.toLowerCase().includes(userSearchQuery.toLowerCase()))
      )
    : userList.items

  // Filter rooms by search query (client-side for now)
  const filteredRooms = roomSearchQuery
    ? roomList.items.filter(room =>
        room.jid.toLowerCase().includes(roomSearchQuery.toLowerCase()) ||
        (room.name && room.name.toLowerCase().includes(roomSearchQuery.toLowerCase()))
      )
    : roomList.items

  // Get title based on active category or command
  const getTitle = () => {
    if (currentSession) {
      return currentSession.node
        ? currentSession.node.replace('http://jabber.org/protocol/admin#', '').replace(/-/g, ' ')
        : t('admin.title')
    }
    if (selectedUser) {
      return t('admin.userView.title')
    }
    switch (activeCategory) {
      case 'users':
        return t('admin.categories.users')
      case 'rooms':
        return t('admin.categories.rooms')
      default:
        return t('admin.title')
    }
  }

  // Get icon based on active category
  const getIcon = () => {
    if (selectedUser) {
      return <User className="w-5 h-5 text-fluux-brand" />
    }
    switch (activeCategory) {
      case 'users':
        return <Users className="w-5 h-5 text-fluux-brand" />
      case 'rooms':
        return <Hash className="w-5 h-5 text-fluux-brand" />
      default:
        return <Wrench className="w-5 h-5 text-fluux-brand" />
    }
  }

  // Render content based on state
  const renderContent = () => {
    // If there's an active command session, show the form/result
    if (currentSession?.status === 'executing' && currentSession.form) {
      return (
        <AdminCommandForm
          form={currentSession.form}
          onSubmit={handleSubmitForm}
          onCancel={handleCancel}
          onPrev={handlePrev}
          isSubmitting={isExecuting}
          note={currentSession.note}
          canGoBack={canGoBack}
          canGoNext={canGoNext}
          targetJid={targetJid}
          onClearTargetJid={clearTargetJid}
        />
      )
    }

    if (currentSession?.status === 'completed' && currentSession.form) {
      return (
        <AdminCommandResult
          form={currentSession.form}
          note={currentSession.note}
          onClose={handleCloseSession}
        />
      )
    }

    // Show user detail view if a user is selected
    if (selectedUser && activeCategory === 'users') {
      return (
        <AdminUserView
          user={selectedUser}
          onBack={() => setSelectedUser(null)}
          onDeleteUser={handleDeleteUser}
          onEndSessions={handleEndSessions}
          onChangePassword={handleChangePassword}
          isExecuting={isExecuting}
        />
      )
    }

    // Show entity lists based on active category
    if (activeCategory === 'users') {
      return (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Vhost selector - only show when multiple vhosts available */}
          {vhosts.length > 1 && (
            <div className="mb-3">
              <label htmlFor="admin-vhost-select" className="block text-sm text-fluux-muted mb-1">
                {t('admin.userList.virtualHost')}
              </label>
              <select
                id="admin-vhost-select"
                name="vhost"
                value={selectedVhost || ''}
                onChange={(e) => handleVhostChange(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-hover rounded-lg
                           text-fluux-text focus:outline-none focus:border-fluux-brand"
              >
                {vhosts.map((vhost) => (
                  <option key={vhost} value={vhost}>
                    {vhost}
                  </option>
                ))}
              </select>
            </div>
          )}
          <EntityListView
            title={t('admin.userList.title')}
            items={filteredUsers}
            isLoading={userList.isLoading}
            hasMore={hasMoreUsers && !userSearchQuery}
            searchValue={userSearchQuery}
            totalCount={entityCounts.users}
            onSearchChange={setUserSearchQuery}
            onLoadMore={loadMoreUsers}
            emptyMessage={t('admin.userList.noUsers')}
            keyExtractor={(user) => user.jid}
            renderItem={(user) => (
              <UserListItem
                user={user}
                onSelect={handleSelectUser}
              />
            )}
            headerAction={
              <Tooltip content={t('admin.userList.addUser')} position="left">
                <button
                  onClick={handleAddUser}
                  className="p-1.5 text-fluux-muted hover:text-fluux-brand hover:bg-fluux-hover
                             rounded-lg transition-colors"
                  aria-label={t('admin.userList.addUser')}
                >
                  <Plus className="w-5 h-5" />
                </button>
              </Tooltip>
            }
          />
        </div>
      )
    }

    if (activeCategory === 'rooms') {
      // Show room detail view if a room is selected
      if (selectedRoom) {
        return (
          <AdminRoomView
            room={selectedRoom}
            onBack={() => setSelectedRoom(null)}
            onDestroyRoom={handleDestroyRoom}
            isExecuting={isExecuting}
            getRoomOptions={getRoomOptions}
            hasGetRoomOptionsCommand={hasCommand('get_room_options')}
          />
        )
      }

      return (
        <EntityListView
          title={t('admin.roomList.title')}
          items={filteredRooms}
          isLoading={roomList.isLoading}
          hasMore={hasMoreRooms && !roomSearchQuery}
          searchValue={roomSearchQuery}
          totalCount={entityCounts.rooms}
          onSearchChange={setRoomSearchQuery}
          onLoadMore={loadMoreRooms}
          emptyMessage={t('admin.roomList.noRooms')}
          keyExtractor={(room) => room.jid}
          renderItem={(room) => (
            <RoomListItem
              room={room}
              onSelect={setSelectedRoom}
            />
          )}
        />
      )
    }

    // Default placeholder
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted">
        <Wrench className="w-12 h-12 mb-2 opacity-50" />
        <p>{t('admin.selectCommand')}</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-fluux-sidebar">
      {/* Header */}
      <div className={`flex items-center px-4 py-3 ${titleBarClass} border-b border-fluux-bg`}>
        {/* Back button - mobile only */}
        {onBack && (
          <button
            onClick={onBack}
            className="p-1 -ms-1 me-2 rounded hover:bg-fluux-hover md:hidden"
            aria-label={t('common.back')}
          >
            <ArrowLeft className="w-5 h-5 text-fluux-muted rtl-mirror" />
          </button>
        )}
        {getIcon()}
        <h2 className="ms-2 font-semibold text-fluux-text capitalize">{getTitle()}</h2>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-4">
        {renderContent()}
      </div>

      {/* Add User Modal */}
      {showAddUserModal && selectedVhost && (
        <AddUserModal
          vhost={selectedVhost}
          onSubmit={handleAddUserSubmit}
          onClose={() => setShowAddUserModal(false)}
        />
      )}
    </div>
  )
}

interface AddUserModalProps {
  vhost: string
  onSubmit: (username: string, password: string) => Promise<void>
  onClose: () => void
}

function AddUserModal({ vhost, onSubmit, onClose }: AddUserModalProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useModalInput<HTMLInputElement>()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedUsername = username.trim()
    const trimmedPassword = password.trim()

    if (!trimmedUsername) {
      setError(t('admin.addUser.usernameRequired'))
      return
    }

    if (!trimmedPassword) {
      setError(t('admin.addUser.passwordRequired'))
      return
    }

    if (trimmedPassword !== confirmPassword) {
      setError(t('admin.addUser.passwordsDoNotMatch'))
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit(trimmedUsername, trimmedPassword)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.addUser.failedToAdd'))
      setIsSubmitting(false)
    }
  }

  return (
    <ModalShell title={t('admin.addUser.title')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div>
          <label htmlFor="add-user-username" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('admin.addUser.username')}
          </label>
          <div className="flex items-center gap-2">
            <TextInput
              ref={inputRef}
              id="add-user-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('admin.addUser.usernamePlaceholder')}
              disabled={isSubmitting}
              className="flex-1 px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-transparent focus:border-fluux-brand
                         placeholder:text-fluux-muted disabled:opacity-50"
            />
            <span className="text-fluux-muted">@{vhost}</span>
          </div>
        </div>

        <div>
          <label htmlFor="add-user-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('admin.addUser.password')}
          </label>
          <input
            id="add-user-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('admin.addUser.passwordPlaceholder')}
            disabled={isSubmitting}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="add-user-confirm-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('admin.addUser.confirmPassword')}
          </label>
          <input
            id="add-user-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t('admin.addUser.confirmPasswordPlaceholder')}
            disabled={isSubmitting}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        {error && (
          <p className="text-sm text-fluux-red">{error}</p>
        )}

        {/* Buttons */}
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="flex-1 px-4 py-2 text-fluux-text bg-fluux-hover rounded
                       hover:bg-fluux-muted/30 disabled:opacity-50 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 px-4 py-2 text-fluux-text-on-accent bg-fluux-brand rounded
                       hover:bg-fluux-brand/90 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? t('admin.addUser.adding') : t('common.create')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
