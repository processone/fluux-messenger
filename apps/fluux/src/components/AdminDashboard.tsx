import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users,
  Loader2,
  Server,
  Hash,
  ShieldOff,
} from 'lucide-react'
import { useAdmin, type AdminCategory } from '@fluux/sdk'

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
    serverStats,
    isDiscovering,
    fetchServerStats,
    discoverMucService,
    isAdmin,
  } = useAdmin()

  // Fetch server overview stats on mount (also feeds the category count badges)
  useEffect(() => {
    if (commands.length > 0) {
      void fetchServerStats()
      void discoverMucService()
    }
  }, [commands.length, fetchServerStats, discoverMucService])

  // Show access denied message if user is not an admin
  if (!isAdmin) {
    return (
      <div className="px-3 py-4 text-fluux-muted text-sm text-center">
        <ShieldOff className="size-12 mx-auto mb-3 opacity-50" />
        <p className="font-medium text-fluux-text mb-1">{t('admin.noAccess.title')}</p>
        <p>{t('admin.noAccess.description')}</p>
      </div>
    )
  }

  if (isDiscovering) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="flex items-center gap-2 text-fluux-muted">
          <Loader2 className="size-5 animate-spin" />
          <span>{t('admin.discovering')}</span>
        </div>
      </div>
    )
  }

  if (commands.length === 0) {
    return (
      <div className="px-3 py-4 text-fluux-muted text-sm text-center">
        <Server className="size-12 mx-auto mb-3 opacity-50" />
        <p>{t('admin.noCommands')}</p>
      </div>
    )
  }

  return (
    <div className="px-2 py-2 space-y-1">
      {/* Users Category */}
      <CategoryButton
        icon={Users}
        label={t('admin.categories.users')}
        count={serverStats?.registeredUsers}
        isActive={activeCategory === 'users'}
        onClick={() => onCategoryChange(activeCategory === 'users' ? null : 'users')}
      />

      {/* Rooms Category */}
      <CategoryButton
        icon={Hash}
        label={t('admin.categories.rooms')}
        count={serverStats?.onlineRooms}
        isActive={activeCategory === 'rooms'}
        onClick={() => onCategoryChange(activeCategory === 'rooms' ? null : 'rooms')}
      />
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
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count?: number
  isActive: boolean
  onClick: () => void
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
      <Icon className={`size-4 flex-shrink-0 ${isActive ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
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
    </button>
  )
}
