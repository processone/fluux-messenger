import { SettingsRow, Toggle } from '@xmpp/fluux'
import { SettingsSurface } from './_surface'

const noop = () => {}

export const WithToggle = () => (
  <SettingsSurface>
    <SettingsRow
      label="Read receipts"
      description="Let contacts see when you have read their messages."
    >
      <Toggle checked onChange={noop} aria-label="Read receipts" />
    </SettingsRow>
  </SettingsSurface>
)

export const LabelOnly = () => (
  <SettingsSurface>
    <SettingsRow label="Show offline contacts" />
  </SettingsSurface>
)

export const Clickable = () => (
  <SettingsSurface>
    <SettingsRow
      label="Change password"
      description="You will be signed out on other devices."
      onClick={noop}
    />
  </SettingsSurface>
)

export const Danger = () => (
  <SettingsSurface>
    <SettingsRow
      label="Delete account"
      description="This permanently removes your account from the server."
      onClick={noop}
      danger
    />
  </SettingsSurface>
)

export const Disabled = () => (
  <SettingsSurface>
    <SettingsRow
      label="Export archive"
      description="Unavailable while the initial sync is running."
      onClick={noop}
      disabled
    />
  </SettingsSurface>
)
