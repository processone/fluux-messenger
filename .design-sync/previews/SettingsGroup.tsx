import { SettingsGroup, SettingsRow, Toggle } from '@xmpp/fluux'
import { SettingsSurface } from './_surface'

const noop = () => {}

export const WithToggles = () => (
  <SettingsSurface>
    <SettingsGroup>
      <SettingsRow label="Desktop notifications">
        <Toggle checked onChange={noop} aria-label="Desktop notifications" />
      </SettingsRow>
      <SettingsRow label="Sound">
        <Toggle checked={false} onChange={noop} aria-label="Sound" />
      </SettingsRow>
      <SettingsRow label="Notify on mention only" description="Group chats only.">
        <Toggle checked onChange={noop} aria-label="Notify on mention only" />
      </SettingsRow>
    </SettingsGroup>
  </SettingsSurface>
)

export const ActionRows = () => (
  <SettingsSurface>
    <SettingsGroup>
      <SettingsRow label="Change password" onClick={noop} />
      <SettingsRow label="Export message archive" onClick={noop} />
      <SettingsRow label="Delete account" onClick={noop} danger />
    </SettingsGroup>
  </SettingsSurface>
)

export const SingleRow = () => (
  <SettingsSurface>
    <SettingsGroup>
      <SettingsRow label="Send read receipts" description="Applies to one-to-one chats.">
        <Toggle checked onChange={noop} aria-label="Send read receipts" />
      </SettingsRow>
    </SettingsGroup>
  </SettingsSurface>
)
