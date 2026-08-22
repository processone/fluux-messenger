import { TextArea } from '@xmpp/fluux'
import { Surface } from './_surface'

// TextArea renders a bare <textarea>; the Fluux field treatment is applied by
// the caller, exactly as the app's own forms do.
const field =
  'w-full px-4 py-3 rounded-lg border-2 border-fluux-hover bg-fluux-bg text-fluux-text ' +
  'placeholder:text-fluux-muted focus:border-fluux-brand focus:outline-none transition-colors resize-none'

export const Default = () => (
  <Surface className="max-w-sm">
    <TextArea
      rows={3}
      defaultValue="Working from the Bordeaux office this week."
      className={field}
    />
  </Surface>
)

export const Placeholder = () => (
  <Surface className="max-w-sm">
    <TextArea rows={3} placeholder="What's on your mind?" className={field} />
  </Surface>
)

export const WithLabel = () => (
  <Surface className="max-w-sm">
    <label htmlFor="room-subject" className="block text-sm text-fluux-text mb-2">
      Room subject
    </label>
    <TextArea
      id="room-subject"
      rows={4}
      defaultValue={'Release coordination for 0.18.\nAgenda in the pinned message.'}
      className={field}
    />
  </Surface>
)

export const Disabled = () => (
  <Surface className="max-w-sm">
    <TextArea
      rows={3}
      defaultValue="Only moderators can change the subject."
      disabled
      className={`${field} opacity-50`}
    />
  </Surface>
)
