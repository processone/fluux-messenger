import { SettingsSection, SettingsGroup, SettingsRow, Toggle, Select } from '@xmpp/fluux'
import { SettingsSurface } from './_surface'

const noop = () => {}

export const Default = () => (
  <SettingsSurface>
    <SettingsSection title="Privacy">
      <SettingsGroup>
        <SettingsRow label="Read receipts">
          <Toggle checked onChange={noop} aria-label="Read receipts" />
        </SettingsRow>
        <SettingsRow label="Typing indicators">
          <Toggle checked={false} onChange={noop} aria-label="Typing indicators" />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  </SettingsSurface>
)

export const WithDescription = () => (
  <SettingsSurface>
    <SettingsSection
      title="Notifications"
      description="Fluux only notifies you while the window is not focused."
    >
      <SettingsGroup>
        <SettingsRow label="Desktop notifications">
          <Toggle checked onChange={noop} aria-label="Desktop notifications" />
        </SettingsRow>
        <SettingsRow label="Sound" htmlFor="sound-select">
          <Select id="sound-select" defaultValue="chime" className="w-36">
            <option value="none">None</option>
            <option value="chime">Chime</option>
            <option value="ping">Ping</option>
          </Select>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  </SettingsSurface>
)

export const Stacked = () => (
  <SettingsSurface>
    <SettingsSection title="Appearance">
      <SettingsGroup>
        <SettingsRow label="Compact density">
          <Toggle checked={false} onChange={noop} aria-label="Compact density" />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
    <SettingsSection title="Advanced" description="Changes apply after a restart." className="mt-6">
      <SettingsGroup>
        <SettingsRow label="Hardware acceleration">
          <Toggle checked onChange={noop} aria-label="Hardware acceleration" />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  </SettingsSurface>
)
