---
category: Forms
---

# Select

A styled wrapper around a native `<select>`. It renders the real element — so keyboard
behaviour, form participation and the platform picker on mobile all come for free — and adds
the Fluux border/focus treatment plus a `ChevronDown` affordance.

Every prop other than `children` and `className` is forwarded to the underlying `<select>`,
so `value`, `defaultValue`, `onChange`, `disabled`, `name` and `required` all work as usual.
Pass plain `<option>` elements as children.

`className` is appended to the select's own classes, not replacing them; use it for width or
spacing overrides.

## Example

```tsx
<Select value={theme} onChange={(e) => setTheme(e.target.value)}>
  <option value="system">Match system</option>
  <option value="dark">Dark</option>
  <option value="light">Light</option>
</Select>
```
