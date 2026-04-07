import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  Users,
  BarChart3,
  Megaphone,
  Loader2,
  Wrench,
  Hash,
  Settings,
  ShieldOff,
} from 'lucide-react'
import { useAdmin, type AdminCategory, type AdminCommand } from '@fluux/sdk'

interface AdminDashboardProps {
  activeCategory: AdminCategory | null
  onCategoryChange: (category: AdminCategory | null) => void
}

/**
 * AdminDashboard - Category navigation sidebar for admin panel.
 * Shows categories with count badges and triggers main content changes.
 */
export function AdminDashboard({ activeCategory, onCategoryChange }: AdminDashboardProps) {
  const { t } = useTranslation()
  const {
    commands,
    commandsByCategory,
    entityCounts,
    isDiscovering,
    isExecuting,
    executeCommand,
    fetchEntityCounts,
    discoverMucService,
    isAdmin,
  } = useAdmin()

  // Fetch entity counts on mount
  useEffect(() => {
    if (commands.length > 0) {
      fetchEntityCounts().catch(console.error)
      discoverMucService().catch(console.error)
    }
  }, [commands.length, fetchEntityCounts, discoverMucService])

  // Check if we have announcement commands
  const hasAnnouncements = commandsByCategory.announcement.length > 0

  // Handle command execution (for stats and announcement commands)
  const handleExecuteCommand = async (node: string) => {
    try {
      await executeCommand(node)
    } catch (error) {
      console.error('Failed to execute command:', error)
    }
  }

  // Check if we have stats commands
  const hasStats = commandsByCategory.stats.length > 0

  // Check if we have other/uncategorized commands
  const hasOther = commandsByCategory.other.length > 0

  // Show access denied message if user is not an admin
  if (!isAdmin) {
    return (
      <div className="px-3 py-4 text-fluux-muted text-sm text-center">
        <ShieldOff className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p className="font-medium text-fluux-text mb-1">{t('admin.noAccess.title')}</p>
        <p>{t('admin.noAccess.description')}</p>
      </div>
    )
  }

  if (isDiscovering) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="flex items-center gap-2 text-fluux-muted">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>{t('admin.discovering')}</span>
        </div>
      </div>
    )
  }

  if (commands.length === 0) {
    return (
      <div className="px-3 py-4 text-fluux-muted text-sm text-center">
        <Wrench className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>{t('admin.noCommands')}</p>
      </div>
    )
  }

  return (
    <div className="px-2 py-2 space-y-1">
      {/* Statistics Category */}
      {hasStats && (
        <>
          <CategoryButton
            icon={BarChart3}
            label={t('admin.categories.statistics')}
            isActive={activeCategory === 'stats'}
            onClick={() => onCategoryChange(activeCategory === 'stats' ? null : 'stats')}
          />

          {/* Stats commands (shown when stats is active) */}
          {activeCategory === 'stats' && (
            <div className="ms-6 space-y-0.5 mb-2">
              {commandsByCategory.stats.map(cmd => (
                <CommandButton
                  key={cmd.node}
                  command={cmd}
                  onClick={() => handleExecuteCommand(cmd.node)}
                  disabled={isExecuting}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Users Category */}
      <CategoryButton
        icon={Users}
        label={t('admin.categories.users')}
        count={entityCounts.users}
        isActive={activeCategory === 'users'}
        onClick={() => onCategoryChange(activeCategory === 'users' ? null : 'users')}
        hasExpandableContent={false}
      />

      {/* Rooms Category */}
      <CategoryButton
        icon={Hash}
        label={t('admin.categories.rooms')}
        count={entityCounts.rooms}
        isActive={activeCategory === 'rooms'}
        onClick={() => onCategoryChange(activeCategory === 'rooms' ? null : 'rooms')}
        hasExpandableContent={false}
      />

      {/* Announcements Category */}
      {hasAnnouncements && (
        <>
          <CategoryButton
            icon={Megaphone}
            label={t('admin.categories.announcements')}
            isActive={activeCategory === 'announcements'}
            onClick={() => onCategoryChange(activeCategory === 'announcements' ? null : 'announcements')}
          />

          {/* Announcement commands (shown when announcements is active) */}
          {activeCategory === 'announcements' && (
            <div className="ms-6 space-y-0.5 mb-2">
              {commandsByCategory.announcement.map(cmd => (
                <CommandButton
                  key={cmd.node}
                  command={cmd}
                  onClick={() => handleExecuteCommand(cmd.node)}
                  disabled={isExecuting}
                  highlight
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Other/Uncategorized Commands */}
      {hasOther && (
        <>
          <CategoryButton
            icon={Settings}
            label={t('admin.categories.other')}
            isActive={activeCategory === 'other'}
            onClick={() => onCategoryChange(activeCategory === 'other' ? null : 'other')}
          />

          {/* Other commands (shown when other is active) */}
          {activeCategory === 'other' && (
            <div className="ms-6 space-y-0.5 mb-2">
              {commandsByCategory.other.map(cmd => (
                <CommandButton
                  key={cmd.node}
                  command={cmd}
                  onClick={() => handleExecuteCommand(cmd.node)}
                  disabled={isExecuting}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Category button component
function CategoryButton({
  icon: Icon,
  label,
  count,
  isActive,
  onClick,
  hasExpandableContent = true,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count?: number
  isActive: boolean
  onClick: () => void
  hasExpandableContent?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-3 py-2 flex items-center gap-2 rounded-lg transition-colors
                 ${isActive
                   ? 'bg-fluux-brand/10 text-fluux-brand'
                   : 'hover:bg-fluux-hover text-fluux-text'
                 }`}
    >
      <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
      <span className="text-sm font-medium flex-1 text-start">{label}</span>
      {count !== undefined && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full min-w-[1.5rem] text-center
                        ${isActive
                          ? 'bg-fluux-brand/20 text-fluux-brand'
                          : 'bg-fluux-bg text-fluux-muted'
                        }`}>
          {count.toLocaleString()}
        </span>
      )}
      {hasExpandableContent && (
        <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform
                                 ${isActive ? 'rotate-90 text-fluux-brand' : 'text-fluux-muted'}`} />
      )}
    </button>
  )
}

// Command button component
function CommandButton({
  command,
  onClick,
  disabled,
  highlight = false,
}: {
  command: AdminCommand
  onClick: () => void
  disabled: boolean
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full px-2 py-1.5 rounded flex items-center justify-between text-start
                 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed group
                 ${highlight
                   ? 'text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent'
                   : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
                 }`}
    >
      <span className="truncate text-sm">{command.name}</span>
      <ChevronRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  )
}
