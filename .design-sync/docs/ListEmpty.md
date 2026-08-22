---
category: Feedback
---

# ListEmpty

The compact empty state for a list or panel that has nothing to show — the conversation list,
contacts, search results, admin lists. Restrained by design: a muted icon, a one-line title,
an optional sub-line, and an optional accent action.

This is the *in-list* empty state. The full-pane hero empty state (nothing selected yet) is a
different component and is not part of this design system.

Everything is centered and tinted `--fluux-text-muted`, so it reads as an absence rather than
as content. Keep the title to a short noun phrase, not a sentence.

## Props

- `title: string` — required. Short: "No contacts", "No results".
- `icon?: LucideIcon` — the component itself, not an element: `icon={Users}`.
- `description?: string` — one line of guidance, capped to a narrow measure.
- `action?: { label, icon?, onClick }` — renders an accent-tinted pill under the text. Use it
  only when there is one obvious next step.
- `className?: string`

## Example

```tsx
import { Users, UserPlus } from 'lucide-react'

<ListEmpty
  icon={Users}
  title="No contacts"
  description="Add someone by their XMPP address to start chatting."
  action={{ label: 'Add contact', icon: UserPlus, onClick: openAddContact }}
/>
```
