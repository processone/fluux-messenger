import { TextInput } from '@xmpp/fluux'
import { Surface } from './_surface'

// TextInput renders a bare <input>; the Fluux field treatment is applied by the
// caller, exactly as the app's own forms do.
const field =
  'w-full px-4 py-3 rounded-lg border-2 border-fluux-hover bg-fluux-bg text-fluux-text ' +
  'placeholder:text-fluux-muted focus:border-fluux-brand focus:outline-none transition-colors'

export const Default = () => (
  <Surface className="max-w-sm">
    <TextInput type="text" defaultValue="mickael@fluux.io" className={field} />
  </Surface>
)

export const Placeholder = () => (
  <Surface className="max-w-sm">
    <TextInput type="text" placeholder="you@example.com" className={field} />
  </Surface>
)

export const WithLabel = () => (
  <Surface className="max-w-sm">
    <label htmlFor="nickname" className="block text-sm text-fluux-text mb-2">
      Nickname
    </label>
    <TextInput id="nickname" type="text" defaultValue="mremond" className={field} />
    <p className="text-xs text-fluux-muted mt-2">Shown to other people in group chats.</p>
  </Surface>
)

export const Password = () => (
  <Surface className="max-w-sm">
    <TextInput type="password" defaultValue="correct-horse-battery" className={field} />
  </Surface>
)

export const Disabled = () => (
  <Surface className="max-w-sm">
    <TextInput type="text" defaultValue="mickael@fluux.io" disabled className={`${field} opacity-50`} />
  </Surface>
)
