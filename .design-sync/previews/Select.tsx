import { Select } from '@xmpp/fluux'
import { Surface } from './_surface'

export const Default = () => (
  <Surface className="max-w-xs">
    <Select defaultValue="dark">
      <option value="system">Match system</option>
      <option value="dark">Dark</option>
      <option value="light">Light</option>
    </Select>
  </Surface>
)

export const WithLabel = () => (
  <Surface className="max-w-xs">
    <label htmlFor="theme-select" className="block text-sm text-fluux-text mb-2">
      Theme
    </label>
    <Select id="theme-select" defaultValue="nord">
      <option value="fluux">Aurora</option>
      <option value="nord">Nord</option>
      <option value="dracula">Dracula</option>
      <option value="tokyo-night">Tokyo Night</option>
    </Select>
  </Surface>
)

export const Disabled = () => (
  <Surface className="max-w-xs">
    <Select defaultValue="always" disabled>
      <option value="always">Always notify</option>
    </Select>
  </Surface>
)
