---
category: Forms
---

# TextArea

A drop-in replacement for `<textarea>`, and the multi-line sibling of `TextInput`. Use it
instead of a bare `<textarea>` everywhere in Fluux.

It accepts every native textarea attribute and forwards its ref. Like `TextInput`, it strips
control characters that Tauri inserts on macOS when arrow keys are pressed at text boundaries
(tauri-apps/tauri#10194), preserving the cursor position.

It ships **unstyled** — a plain `<textarea>`. Apply the Fluux field treatment through
`className`, and set `rows` for the default height.

## Example

```tsx
<TextArea
  value={status}
  onChange={(e) => setStatus(e.target.value)}
  rows={3}
  placeholder="What's on your mind?"
  className="w-full px-3 py-2 rounded-lg border-2 border-fluux-hover bg-fluux-bg text-fluux-text focus:border-fluux-brand focus:outline-none resize-none"
/>
```
