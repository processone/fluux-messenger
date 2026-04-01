# Writing Themes for Fluux

Fluux uses a 3-tier CSS variable system inspired by Obsidian. Themes override these variables to reskin the entire app — no class names or DOM structure knowledge required.

## Quick Start

Create a JSON file with your color palette:

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "author": "Your Name",
  "version": "1.0.0",
  "description": "A short description of your theme",
  "variables": {
    "dark": {
      "--fluux-base-00": "#0d1117",
      "--fluux-base-05": "#161b22",
      "--fluux-base-10": "#1c2128",
      "--fluux-base-20": "#2d333b",
      "--fluux-base-30": "#373e47",
      "--fluux-base-40": "#444c56",
      "--fluux-base-50": "#545d68",
      "--fluux-base-60": "#636e7b",
      "--fluux-base-70": "#768390",
      "--fluux-base-80": "#8b949e",
      "--fluux-base-90": "#c9d1d9",
      "--fluux-base-100": "#f0f6fc",
      "--fluux-accent-h": "212",
      "--fluux-accent-s": "100%",
      "--fluux-accent-l": "67%",
      "--fluux-color-red": "#f85149",
      "--fluux-color-green": "#3fb950",
      "--fluux-color-yellow": "#d29922",
      "--fluux-color-blue": "#58a6ff",
      "--fluux-color-purple": "#bc8cff",
      "--fluux-color-gray": "#636e7b"
    },
    "light": {
      "--fluux-base-00": "#ffffff",
      "--fluux-base-05": "#f6f8fa",
      "--fluux-base-10": "#eaeef2",
      "--fluux-base-20": "#d0d7de",
      "--fluux-base-30": "#ffffff",
      "--fluux-base-40": "#d0d7de",
      "--fluux-base-50": "#afb8c1",
      "--fluux-base-60": "#8c959f",
      "--fluux-base-70": "#6e7781",
      "--fluux-base-80": "#57606a",
      "--fluux-base-90": "#24292f",
      "--fluux-base-100": "#1c2128",
      "--fluux-accent-h": "212",
      "--fluux-accent-s": "100%",
      "--fluux-accent-l": "47%",
      "--fluux-color-red": "#cf222e",
      "--fluux-color-green": "#1a7f37",
      "--fluux-color-yellow": "#9a6700",
      "--fluux-color-blue": "#0969da",
      "--fluux-color-purple": "#8250df",
      "--fluux-color-gray": "#6e7781"
    }
  },
  "swatches": {
    "dark": ["#1c2128", "#2d333b", "#58a6ff", "#3fb950"],
    "light": ["#eaeef2", "#ffffff", "#0969da", "#1a7f37"]
  }
}
```

Import it from **Settings > Appearance > Import theme**.

## How It Works

Fluux's CSS variables are organized in three tiers that cascade into each other:

```
Tier 1: Foundation     →   Tier 2: Semantic       →   Tier 3: Component
--fluux-base-20            --fluux-bg-tertiary         --fluux-sidebar-bg
(raw color)                (purpose)                   (specific widget)
```

When you change a foundation variable, everything that depends on it updates automatically. Most themes only need to override **Tier 1 (foundation)** variables — about 20 values — to completely reskin the app.

## Tier 1: Foundation Variables

These are the raw design tokens. Override these for a complete palette change.

### Neutral Ramp

The base ramp provides all surface and text colors. In dark mode, `00` is the darkest and `100` is the lightest. In light mode, the relationship inverts — `00` becomes the lightest background and `90`/`100` become dark text.

| Variable           | Dark mode role                   | Light mode role            |
|--------------------|----------------------------------|----------------------------|
| `--fluux-base-00`  | Deepest background               | Lightest background        |
| `--fluux-base-05`  | Secondary background (icon rail) | Near-white surface         |
| `--fluux-base-10`  | Main app surface                 | Main app surface           |
| `--fluux-base-20`  | Sidebar / elevated surface       | Sidebar / elevated surface |
| `--fluux-base-30`  | Chat content area                | Chat content area          |
| `--fluux-base-40`  | Hover state                      | Hover state                |
| `--fluux-base-50`  | Active / selected state          | Active / selected state    |
| `--fluux-base-60`  | Faint UI elements                | Faint UI elements          |
| `--fluux-base-70`  | Tertiary text                    | Tertiary text              |
| `--fluux-base-80`  | Secondary text (muted)           | Secondary text (muted)     |
| `--fluux-base-90`  | Primary text                     | Primary text               |
| `--fluux-base-100` | Brightest (rarely used)          | Darkest (rarely used)      |

**Tip for light themes:** Don't use pure `#ffffff` for `base-00` or `base-30` unless you want a stark white look. Tinted whites (e.g. Solarized's `#fdf6e3` cream or Nord's `#eceff4` blue-white) give the theme its character.

### Accent Color

The accent is defined as HSL components so Fluux can derive hover states, selection highlights, and focus rings automatically:

```json
"--fluux-accent-h": "235",
"--fluux-accent-s": "86%",
"--fluux-accent-l": "65%"
```

From these, the app computes:
- `--fluux-bg-accent` — primary accent background (buttons, active icons)
- `--fluux-bg-accent-hover` — darkened accent for hover
- `--fluux-text-on-accent` — auto-computed text color (`#000000` or `#ffffff`) for readable contrast on the accent background
- `--fluux-selection-bg` — translucent accent for text selection
- `--fluux-search-highlight-bg` — translucent accent for search match highlighting
- `--fluux-search-highlight-text` — text color inside search highlights
- `--fluux-focus-ring` — translucent accent for focus outlines

The `--fluux-text-on-accent` color is calculated automatically using WCAG relative luminance. Light accents (e.g. Yellow or Pink in dark mode) get black text; dark accents (e.g. Blue in light mode) get white text. This ensures buttons, active icon rail tabs, and other accent-colored elements remain readable with any accent color and mode combination. Theme authors do not need to set this variable — it adapts automatically.

**Tip:** Lower the lightness by ~8-10% for light mode so the accent remains readable on light backgrounds.

### Typography

Themes can optionally override the UI and monospace font families. Font overrides reference system-installed or user-provided fonts — themes never bundle font files. Always include a fallback stack ending with the default:

| Variable            | Default               | Purpose                                |
|---------------------|-----------------------|----------------------------------------|
| `--fluux-font-ui`   | `'Inter', sans-serif` | UI typeface for all text               |
| `--fluux-font-mono` | `monospace`           | Code blocks, console, fixed-width text |

```json
"--fluux-font-ui": "\"SF Pro Display\", \"Segoe UI\", system-ui, sans-serif",
"--fluux-font-mono": "\"JetBrains Mono\", \"Fira Code\", monospace"
```

If the specified fonts aren't installed on the user's system, the browser falls through the fallback stack gracefully. The built-in GitHub theme demonstrates this pattern with a system font stack.

### Palette Colors

Named colors for status indicators and semantic meaning:

| Variable               | Used for                            |
|------------------------|-------------------------------------|
| `--fluux-color-red`    | Errors, unread badges, DND presence |
| `--fluux-color-green`  | Success, online presence            |
| `--fluux-color-yellow` | Warnings, away presence             |
| `--fluux-color-blue`   | Links, info toasts                  |
| `--fluux-color-purple` | Accent fallback                     |
| `--fluux-color-gray`   | Neutral / offline presence          |

Each color also needs an `-rgb` variant for transparency effects:

```json
"--fluux-color-red": "#bf616a",
"--fluux-color-red-rgb": "191, 97, 106"
```

## Tier 2: Semantic Variables (Optional Overrides)

These map foundation tokens to purposes. They cascade from Tier 1, so you rarely need to override them — but you can for fine-tuning.

| Variable                        | Default               | Purpose                         |
|---------------------------------|-----------------------|---------------------------------|
| `--fluux-bg-primary`            | `base-10`             | Main app background             |
| `--fluux-bg-secondary`          | `base-05`             | Darker secondary background     |
| `--fluux-bg-tertiary`           | `base-20`             | Sidebar, elevated surfaces      |
| `--fluux-bg-hover`              | `base-40`             | Hover state for all elements    |
| `--fluux-bg-active`             | `base-50`             | Active / selected state         |
| `--fluux-text-normal`           | `base-90`             | Primary text                    |
| `--fluux-text-muted`            | `base-80`             | Secondary text                  |
| `--fluux-text-faint`            | `base-70`             | Timestamps, disabled text       |
| `--fluux-text-on-accent`        | Auto (`#000`/`#fff`)  | Text on accent backgrounds      |
| `--fluux-text-link`             | `color-blue`          | Hyperlinks                      |
| `--fluux-status-success`        | `color-green`         | Success indicators              |
| `--fluux-status-warning`        | `color-yellow`        | Warning indicators              |
| `--fluux-status-error`          | `color-red`           | Error indicators, unread badges |
| `--fluux-status-info`           | `color-blue`          | Informational indicators        |
| `--fluux-border-color`          | `rgba(0,0,0,0.1)`     | Subtle dividers                 |
| `--fluux-scrollbar-thumb`       | `base-05`             | Scrollbar thumb color           |
| `--fluux-scrollbar-thumb-sidebar` | `base-30`           | Sidebar scrollbar thumb color   |
| `--fluux-scrollbar-thumb-sidebar-hover` | `base-50`     | Sidebar scrollbar thumb hover   |
| `--fluux-selection-bg`          | Accent at 25% opacity | Text selection highlight        |
| `--fluux-search-highlight-bg`   | Accent at 35% opacity | Search match background         |
| `--fluux-search-highlight-text` | `text-normal`         | Search match text color         |

**When to override semantic variables:** When the automatic cascade from your base ramp doesn't produce the right result. Common cases:
- `--fluux-bg-secondary` — if your ramp spacing makes `base-05` too similar to `base-10`
- `--fluux-border-color` — light themes often need `rgba(0,0,0,0.12-0.15)` instead of `0.1`
- `--fluux-scrollbar-thumb` — if your ramp makes the default too subtle or too prominent
- `--fluux-scrollbar-thumb-sidebar` / `--fluux-scrollbar-thumb-sidebar-hover` — the sidebar has a darker background than the main content area, so the default `base-30`/`base-50` may not provide enough contrast. Light themes almost always need explicit overrides here since `base-30` is often near-white

## Tier 3: Component Variables (Rarely Needed)

Per-widget overrides for surgical changes. These default to semantic values.

| Variable                     | Default              | Widget                        |
|------------------------------|----------------------|-------------------------------|
| `--fluux-sidebar-bg`         | `bg-tertiary`        | Sidebar background            |
| `--fluux-rail-bg`            | `bg-primary`         | Icon rail background          |
| `--fluux-rail-icon-active`   | `bg-accent`          | Active icon rail color        |
| `--fluux-chat-bg`            | `base-30`            | Chat area background          |
| `--fluux-chat-header-border` | `divider-color`      | Chat header divider           |
| `--fluux-message-hover`      | `bg-hover`           | Message hover highlight       |
| `--fluux-message-timestamp`  | `text-faint`         | Timestamp text                |
| `--fluux-input-bg`           | `interactive-normal` | Composer input background     |
| `--fluux-modal-bg`           | `sidebar-bg`         | Modal background              |
| `--fluux-modal-backdrop`     | `rgba(0,0,0,0.5)`    | Modal overlay                 |
| `--fluux-toast-bg`           | `sidebar-bg`         | Toast notification background |
| `--fluux-tooltip-bg`         | `bg-primary`         | Tooltip background            |
| `--fluux-badge-bg`           | `status-error`       | Unread count badge            |
| `--fluux-presence-online`    | `status-success`     | Online indicator              |
| `--fluux-presence-away`      | `status-warning`     | Away indicator                |
| `--fluux-presence-dnd`       | `status-error`       | Do not disturb indicator      |
| `--fluux-presence-offline`   | `base-60`            | Offline indicator             |
| `--fluux-button-primary-bg`  | `interactive-accent` | Primary button                |
| `--fluux-button-danger-bg`   | `status-error`       | Danger button                 |

**When to override component variables:** When you want one specific widget to look different from the rest. For example, giving the sidebar a distinct tint while keeping other surfaces neutral.

## Theme File Format

```json
{
  "id": "kebab-case-id",
  "name": "Display Name",
  "author": "Author Name",
  "version": "1.0.0",
  "description": "Short description shown in the theme picker",
  "variables": {
    "dark": { ... },
    "light": { ... }
  },
  "swatches": {
    "dark": ["#color1", "#color2", "#color3", "#color4"],
    "light": ["#color1", "#color2", "#color3", "#color4"]
  },
  "accentPresets": [
    { "name": "Coral", "dark": { "h": 5, "s": 80, "l": 65 }, "light": { "h": 0, "s": 75, "l": 50 } },
    { "name": "Sage",  "dark": { "h": 140, "s": 35, "l": 60 }, "light": { "h": 138, "s": 40, "l": 38 } }
  ]
}
```

### Fields

| Field             | Required | Description                                              |
|-------------------|----------|----------------------------------------------------------|
| `id`              | Yes      | Unique identifier, kebab-case (e.g. `my-dark-theme`)     |
| `name`            | Yes      | Display name in the theme picker                         |
| `author`          | Yes      | Author name                                              |
| `version`         | Yes      | Semver version string                                    |
| `description`     | Yes      | Short description                                        |
| `variables.dark`  | No       | CSS variable overrides for dark mode                     |
| `variables.light` | No       | CSS variable overrides for light mode                    |
| `swatches.dark`   | No       | 3-5 hex colors for the preview strip in the theme picker |
| `swatches.light`  | No       | Same for light mode                                      |
| `accentPresets`   | No       | Curated accent colors for the accent picker (see below)  |

### Swatches

Swatches are a small row of colored rectangles displayed on each theme card in the Settings UI. They give users a quick visual preview of the theme's palette without activating it:

```
┌────────────┐
│ ██ ██ ██ █ │  ← swatch strip
│   Nord     │
└────────────┘
```

Pick 3-5 representative colors from your palette — typically two surface colors and two or three accent/status colors. The field is optional and purely cosmetic; it has no effect on the actual theme rendering.

A theme can provide `dark` only, `light` only, or both. Users independently choose the mode (dark/light/system) — the theme provides the palette for each mode.

### Accent Presets

Themes can optionally provide a curated list of accent color presets that pair well with the theme's palette. Each preset defines HSL values for both dark and light modes:

```json
"accentPresets": [
  { "name": "Coral",    "dark": { "h": 5,   "s": 80, "l": 65 }, "light": { "h": 0,   "s": 75, "l": 50 } },
  { "name": "Marigold", "dark": { "h": 42,  "s": 85, "l": 62 }, "light": { "h": 38,  "s": 80, "l": 45 } },
  { "name": "Sage",     "dark": { "h": 140, "s": 35, "l": 60 }, "light": { "h": 138, "s": 40, "l": 38 } }
]
```

When a theme provides accent presets, they replace the default accent picker options in Settings. Users can pick any of these presets, or reset to the theme's default accent (defined by the `--fluux-accent-*` variables). When a theme doesn't provide presets, a built-in default list (Blue, Purple, Pink, etc.) is shown instead.

**Tip:** Lower the lightness by ~10-15% for light mode values to maintain readability on light surfaces. See the built-in Catppuccin theme for an example with 14 curated presets.

## CSS Snippets

Snippets are standalone `.css` files for arbitrary style overrides that go beyond variable changes. They can target specific selectors, add custom fonts, hide elements, or adjust layout.

Snippets are applied **after** the active theme, so they take priority in the CSS cascade.

### Example: Compact Mode

```css
/* compact-mode.css */
/* Reduce spacing for a denser conversation list */
.conversation-item {
  padding-top: 0.25rem;
  padding-bottom: 0.25rem;
}
```

### Example: Custom Font

```css
/* custom-font.css */
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono&display=swap');

:root {
  --fluux-font-ui: 'JetBrains Mono', monospace;
}
```

Import snippets from **Settings > Appearance > Import snippet**. Each snippet can be toggled on/off independently.

## Tips for Theme Authors

1. **Start with the base ramp.** Get the 12 neutral values right first — they define 90% of the visual feel. Then adjust accent and palette colors.

2. **Test both modes.** Even if you only care about dark mode, set sensible light values — users may switch. If you only want to support one mode, omit the other from `variables`.

3. **Don't skip the RGB variants.** If you change a palette color, also update its `-rgb` variant. These are used for translucent overlays (e.g. `rgba(var(--fluux-color-red-rgb), 0.2)`).

4. **Use the accent HSL wisely.** The accent color drives buttons, focus rings, selection, and active states. Pick a hue that has enough contrast against both your darkest and lightest surfaces.

5. **Avoid overriding Tier 2/3 unless needed.** The cascade handles most cases. If you find yourself overriding many semantic or component variables, your base ramp spacing may need adjustment instead.

6. **Check the built-in themes for reference.** The Nord, Catppuccin, and Solarized themes in `apps/fluux/src/themes/builtins/` are good examples of foundation-only theming with selective semantic overrides.

## Storage

### Desktop (Tauri)

Themes and snippets live in the app config directory:

```
~/.fluux/
  themes/
    my-theme.json
  snippets/
    compact-mode.css
```

### Web

Themes and snippets are stored in `localStorage` and can be imported through the Settings UI.
