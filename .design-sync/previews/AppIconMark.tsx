import { AppIconMark } from '@xmpp/fluux'
import { Surface } from './_surface'

export const Default = () => (
  <Surface>
    <AppIconMark />
  </Surface>
)

export const Sizes = () => (
  <Surface>
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
      <AppIconMark size={32} />
      <AppIconMark size={48} />
      <AppIconMark size={72} />
      <AppIconMark size={112} />
    </div>
  </Surface>
)

export const LoginLockup = () => (
  <Surface className="max-w-xs">
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <AppIconMark size={96} />
      <h1 className="font-display text-2xl text-fluux-text">Fluux</h1>
      <p className="text-sm text-fluux-muted">Sign in to your XMPP account</p>
    </div>
  </Surface>
)
