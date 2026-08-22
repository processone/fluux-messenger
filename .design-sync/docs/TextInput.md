---
category: Forms
---

# TextInput

A drop-in replacement for `<input>`. Use it instead of a bare `<input>` everywhere in Fluux.

It accepts every native input attribute and forwards its ref, so it behaves exactly like the
element it replaces. The one addition is a filter that strips control characters from typed
input — a workaround for a Tauri bug that inserts them when arrow keys are pressed at text
boundaries on macOS (tauri-apps/tauri#10194). The cursor position is preserved across the
filter.

Note that `TextInput` ships **unstyled**: it renders a plain `<input>`. Apply the Fluux field
treatment through `className` (border, radius, focus ring) the way the surrounding form does.
`TextArea` is the same component for `<textarea>`.

## Example

```tsx
<TextInput
  type="text"
  value={nickname}
  onChange={(e) => setNickname(e.target.value)}
  placeholder="Nickname"
  className="w-full px-3 py-2 rounded-lg border-2 border-fluux-hover bg-fluux-bg text-fluux-text focus:border-fluux-brand focus:outline-none"
/>
```
