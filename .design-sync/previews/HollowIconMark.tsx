import { HollowIconMark, AppIconMark } from '@xmpp/fluux'
import { Surface } from './_surface'

export const Default = () => (
  <Surface>
    <HollowIconMark />
  </Surface>
)

export const Sizes = () => (
  <Surface>
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
      <HollowIconMark size={32} />
      <HollowIconMark size={48} />
      <HollowIconMark size={72} />
      <HollowIconMark size={112} />
    </div>
  </Surface>
)

export const AgainstFilled = () => (
  <Surface>
    <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <AppIconMark size={80} />
        <span className="text-xs text-fluux-muted">AppIconMark</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <HollowIconMark size={80} />
        <span className="text-xs text-fluux-muted">HollowIconMark</span>
      </div>
    </div>
  </Surface>
)
