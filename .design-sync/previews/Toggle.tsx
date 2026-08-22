import { Toggle } from '@xmpp/fluux'
import { Surface } from './_surface'

const noop = () => {}

export const On = () => (
  <Surface>
    <Toggle checked onChange={noop} aria-label="Enable read receipts" />
  </Surface>
)

export const Off = () => (
  <Surface>
    <Toggle checked={false} onChange={noop} aria-label="Enable read receipts" />
  </Surface>
)

export const Disabled = () => (
  <Surface>
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <Toggle checked onChange={noop} disabled aria-label="Locked on" />
      <Toggle checked={false} onChange={noop} disabled aria-label="Locked off" />
    </div>
  </Surface>
)

export const Loading = () => (
  <Surface>
    <Toggle checked onChange={noop} loading aria-label="Publishing key" />
  </Surface>
)
