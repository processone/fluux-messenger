## Building with Fluux

Fluux is the design language of an XMPP chat client. This library is its **presentation layer**:
form controls, settings primitives, an empty state, a bottom sheet, and the brand marks. There
is no chat, roster, or conversation component here — build those layouts yourself out of these
parts plus the styling vocabulary below.

### No provider — but always paint a surface

Every component renders from props alone. There is no theme provider, no context, no setup call.

What you **must** supply is the surface. Fluux is dark-first: `:root` sets `color-scheme: dark`
and `--fluux-text-normal` is near-white (`#E9EDF7`). A component dropped onto an unstyled white
page renders invisible text. Put content inside an element carrying the background and text
tokens:

```jsx
<div className="bg-fluux-bg text-fluux-text font-sans">…</div>
```

**Mode and theme** are attributes on `<html>`:

- Dark is the default. Add `class="light"` for light mode.
- `data-theme="<id>"` selects a palette. Aurora (the default identity) is `fluux` and needs no
  attribute. The other thirteen: `indigo`, `nord`, `catppuccin-mocha`, `solarized`, `dracula`,
  `gruvbox`, `one-dark`, `tokyo-night`, `monokai`, `rose-pine`, `kanagawa`, `github`, `pure`.

### The styling idiom: Tailwind utilities over a token tree

Fluux styles with Tailwind utilities whose colors resolve to `--fluux-*` CSS variables, so one
class set works across all fourteen themes. Use these families for your own layout glue:

| Family | Verified utilities |
|---|---|
| Backgrounds | `bg-fluux-bg` `bg-fluux-bg-secondary` `bg-fluux-surface` `bg-fluux-sidebar` `bg-fluux-chat` `bg-fluux-hover` `bg-fluux-float` `bg-fluux-brand` `bg-fluux-red` |
| Text | `text-fluux-text` `text-fluux-muted` `text-fluux-link` `text-fluux-brand` `text-fluux-error` `text-fluux-encryption` `text-fluux-text-on-accent` |
| Border | `border-fluux-border` |
| Type | `font-sans` (Inter) `font-mono` (JetBrains Mono) `font-display` (Inter Tight) |
| Effects | `fluux-glass` (frosted panel) `fluux-popover` (elevated menu) `animate-sheet-up` |

**Important:** the shipped stylesheet is the app's compiled Tailwind output, so it contains only
the utilities the app actually uses. A plausible-looking class the app never wrote —
`bg-fluux-active`, `duration-fast`, `ease-standard` — is **not** in the CSS and will silently do
nothing. When you need something outside the table, reach for the variable directly, which is
always defined:

```jsx
<div style={{ background: 'var(--fluux-bg-active)', transitionDuration: 'var(--fluux-duration-fast)' }} />
```

Useful tokens beyond the utility set: `--fluux-bg-primary/secondary/tertiary`, `--fluux-bg-hover`,
`--fluux-bg-active`, `--fluux-text-normal/muted/link/error`, `--fluux-status-success/warning/error`,
`--fluux-surface-divider`, `--fluux-duration-fast/base/slow`, `--fluux-ease-standard/emphasized/spring`,
and `--fluux-grad` (the aurora gradient).

Red has two tokens on purpose: `--fluux-status-error` is the **fill** (danger button, dnd dot),
tuned so white text on it clears AA; `--fluux-text-error` is red **as text or icon**. Using the
fill token for text is sub-AA on dark surfaces.

### Where the truth lives

- `styles.css` and its imports — the full token tree, `.light` overrides, and every utility that
  exists. Read it before inventing a class name.
- `tokens/themes.css` — the thirteen alternate palettes.
- `components/<group>/<Name>/<Name>.prompt.md` — per-component usage, written by hand. Read the
  one for any component before composing it; several have real constraints (a `SettingsRow` with
  `onClick` must not contain an interactive child).

### Composition

The settings primitives nest in a fixed order — `SettingsSection` → `SettingsGroup` →
`SettingsRow` → control:

```jsx
<div className="bg-fluux-bg text-fluux-text font-sans p-6 max-w-md">
  <SettingsSection title="Privacy" description="Control what other people can see.">
    <SettingsGroup>
      <SettingsRow label="Read receipts" description="Let contacts see when you have read their messages.">
        <Toggle checked={receipts} onChange={setReceipts} aria-label="Read receipts" />
      </SettingsRow>
      <SettingsRow label="Delete account" onClick={confirmDelete} danger />
    </SettingsGroup>
  </SettingsSection>
</div>
```

`TextInput` and `TextArea` are deliberately unstyled — they are Tauri-safe replacements for the
native elements, and the caller applies the field treatment. Copy it from their prompt files.
