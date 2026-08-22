/**
 * Design-system surface — the presentation primitives that carry the Fluux
 * visual language without depending on XMPP state.
 *
 * Everything re-exported here renders from props alone: no store subscription,
 * no SDK provider, no router. That is the entry contract, and it is what lets
 * the barrel be bundled standalone for `claude.ai/design` (see
 * `.design-sync/config.json`). A component that needs a conversation, a roster
 * entry, or an i18n key belongs in the feature tree, not here.
 *
 * The app itself imports these from their own modules; nothing imports this
 * barrel at runtime.
 */

export { BottomSheet } from '@/components/ui/BottomSheet'
export { ListEmpty } from '@/components/ui/ListEmpty'
export { Select } from '@/components/ui/Select'
export { SettingsGroup } from '@/components/ui/SettingsGroup'
export { SettingsRow } from '@/components/ui/SettingsRow'
export { SettingsSection } from '@/components/ui/SettingsSection'
export { TextInput, TextArea } from '@/components/ui/TextInput'
export { Toggle } from '@/components/ui/Toggle'

export { AppIconMark } from '@/components/brand/AppIconMark'
export { HollowIconMark } from '@/components/brand/HollowIconMark'
