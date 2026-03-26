# Plugin & Theme Engine — Design Document

## Context

Fluux is an XMPP client built as a monorepo with a reusable React SDK and a Tauri desktop/web app. The SDK is designed to let developers build custom XMPP clients and bots. A plugin and theme engine is the natural next step to make Fluux extensible by end users and third-party developers.

This document captures architecture decisions and serves as a reference for implementation.

## Prerequisites

**Migrate to React 19.1 + React Compiler before starting plugin/theme work.**

- React 19 is stable since December 2024, compiler stable since React 19.1 (March 2025).
- The compiler auto-memoizes components, eliminating manual `useMemo`/`useCallback` and an entire class of render bugs.
- Plugin code written on React 19 is simpler from day one — no memoization guidance needed for plugin authors.
- React 19 brings `use()` and improved Suspense, which directly inform plugin lazy-loading patterns.
- The migration is small (a few days); the plugin engine is weeks. Do the foundation first.

## Guiding Principles

1. **Ship incrementally.** Start with themes (CSS-only, no API design), then named slots, then the full plugin API. Avoid designing the perfect plugin system before we have real use cases.
2. **SDK-first.** The plugin API lives in `@fluux/sdk`, not in the app. Plugins work the same whether the host is Fluux desktop, a web app, or a bot.
3. **Secure by default.** A messaging app handles private conversations. Plugins must be sandboxed with explicit permissions, unlike Obsidian's full-trust model.
4. **Public API must be sufficient.** If plugin authors need to reach into internals, the API is incomplete. Fix the API, don't document workarounds.

## Lessons from Obsidian

Obsidian's plugin ecosystem (~2,000 plugins) validates that a simple model with clear extension points can scale. We adopt what works and fix what doesn't.

### What we adopt

| Pattern                               | How it works in Obsidian                                                                                        | How we adapt it                                                                                                   |
|---------------------------------------|-----------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| **CSS variables as theme contract**   | 400+ variables (foundation, semantic, component layers). Themes override variables, never target class names.   | Same approach. Define our variable taxonomy, document it, themes only touch variables.                            |
| **Layered CSS**                       | Cascade: defaults < theme < snippets < plugin styles. Users drop `.css` files to tweak without forking a theme. | Same. Built-in defaults < active theme < user snippets. Clear specificity rules.                                  |
| **Declarative theme settings**        | Themes declare customizable variables via comments; Style Settings plugin generates UI.                         | Build into core. Themes declare knobs in manifest, Fluux generates settings UI (color pickers, sliders, toggles). |
| **Lifecycle hooks with auto-cleanup** | `onload()` / `onunload()`. Resources registered via `registerEvent()`, `addCommand()` etc. are auto-cleaned.    | Same pattern. `activate()` / `deactivate()`. All registrations auto-cleanup on unload.                            |
| **Named extension points**            | Ribbon, status bar, sidebar, commands, settings tabs, modals — explicit slots.                                  | Define Fluux-specific slots (see Extension Points below).                                                         |

### What we fix

| Obsidian problem                                                     | Our approach                                                                            |
|----------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| **No sandboxing** — plugins have full filesystem/network/DOM access  | Capability-based permissions declared in manifest; sandboxed execution                  |
| **No post-publication review** — updates ship unchecked              | Signed updates, or at minimum a permissions diff warning on update                      |
| **Undocumented internals as real API** — developers use `@ts-ignore` | Public API is the only API. Internals are truly private.                                |
| **No inter-plugin communication**                                    | Event bus from day one. Plugins can declare/consume named services.                     |
| **No lazy loading** — all plugins load at startup                    | Lazy activation: plugins declare which slots they use, load on first access             |
| **CSS specificity wars**                                             | Variables-only for themes. Plugins get scoped style injection with clear cascade rules. |

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Theme Layer (CSS only)                     │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ Defaults │→│  Theme   │→│  Snippets   │  │
│  └──────────┘ └──────────┘ └─────────────┘  │
│  (CSS variables cascade, lowest → highest)  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Plugin Layer                               │
│  ┌─────────┐  ┌───────────┐  ┌───────────┐  │
│  │Manifest │  │ Lifecycle │  │   Slots   │  │
│  │(perms)  │  │ activate  │  │ (named UI │  │
│  │         │  │ deactivate│  │  points)  │  │
│  └─────────┘  └───────────┘  └───────────┘  │
│        │            │              │        │
│        ▼            ▼              ▼        │
│  ┌─────────────────────────────────────┐    │
│  │  SDK API (read-only by default)     │    │
│  │  • Stores (subscribe, query)        │    │
│  │  • Client (send, with permission)   │    │
│  │  • Event bus (cross-plugin)         │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

## Phase 1: Theme Engine (CSS Variables)

**Goal:** Themes can completely reskin Fluux without touching code.

### CSS Variable Taxonomy

Three layers, from general to specific:

```css
/* Foundation — raw design tokens */
--color-base-00: #ffffff;
--color-base-100: #000000;
--font-family-default: 'Inter', sans-serif;
--radius-m: 8px;
--spacing-m: 12px;

/* Semantic — contextual meaning */
--background-primary: var(--color-base-00);
--background-secondary: ...;
--text-normal: var(--color-base-100);
--text-muted: ...;
--text-accent: ...;
--interactive-hover: ...;
--border-color: ...;

/* Component — specific UI elements */
--sidebar-background: var(--background-secondary);
--message-bubble-self: ...;
--message-bubble-other: ...;
--composer-background: ...;
--avatar-radius: var(--radius-m);
```

### Theme Manifest

```json
{
  "id": "nord-fluux",
  "name": "Nord",
  "author": "...",
  "version": "1.0.0",
  "minAppVersion": "0.15.0",
  "modes": ["dark", "light"],
  "settings": [
    {
      "id": "bubble-style",
      "type": "select",
      "label": "Message bubble style",
      "options": ["rounded", "flat", "minimal"],
      "default": "rounded"
    },
    {
      "id": "accent-color",
      "type": "color",
      "label": "Accent color",
      "default": "#88c0d0"
    }
  ]
}
```

The app reads `settings` and generates a preferences panel automatically. Setting values map to CSS variables via a naming convention (e.g., `accent-color` → `--theme-accent-color`).

### Theme File Structure

```
themes/nord-fluux/
├── manifest.json
├── theme.css          # Variable overrides
└── preview.png        # Screenshot for theme picker
```

### User Snippets

Individual `.css` files in a snippets directory, toggleable from Settings > Appearance. Applied after the active theme, allowing per-user tweaks without forking.

### Deliverables

- [ ] Audit current CSS and extract all hard-coded values into variables
- [ ] Define the variable taxonomy (foundation, semantic, component)
- [ ] Document all variables
- [ ] Build theme loader (reads manifest, applies CSS, generates settings UI)
- [ ] Build snippet loader (toggleable CSS files)
- [ ] Ship a second built-in theme to validate the system
- [ ] Theme picker in Settings > Appearance

## Phase 2: Plugin Extension Points (Named Slots)

**Goal:** Define where plugins can inject UI, before building the full plugin runtime.

### Extension Points

| Slot                  | Location                                   | What plugins can add                                   |
|-----------------------|--------------------------------------------|--------------------------------------------------------|
| `message-actions`     | Menu on each message bubble                | Custom actions (translate, summarize, bookmark, etc.)  |
| `compose-actions`     | Toolbar above/below the message composer   | Buttons, panels (emoji picker, AI assist, etc.)        |
| `sidebar-panel`       | Left sidebar, additional tabs              | Custom panels (contacts search, plugin-specific views) |
| `room-toolbar`        | Room/chat header area                      | Status indicators, quick actions                       |
| `settings-tab`        | Settings screen                            | Plugin configuration panels                            |
| `command-palette`     | Global command palette                     | Custom commands with keyboard shortcuts                |
| `status-bar`          | Bottom bar (if we add one)                 | Connection indicators, counters                        |
| `context-menu`        | Right-click menus (occupant, conversation) | Custom menu items                                      |
| `notification-filter` | Before notification is shown               | Suppress, modify, or route notifications               |
| `message-renderer`    | Message display pipeline                   | Custom rendering for specific content types            |

### Slot API (sketch)

```typescript
interface PluginSlot<T> {
  id: string
  register(item: T): () => void  // returns unregister function
  getAll(): T[]
  subscribe(callback: (items: T[]) => void): () => void
}

// Example: message actions slot
interface MessageAction {
  id: string
  label: string
  icon?: string
  condition?: (message: Message) => boolean  // show/hide per message
  execute: (message: Message) => void | Promise<void>
}

// Plugin registers an action
slots.messageActions.register({
  id: 'translate',
  label: 'Translate',
  icon: 'languages',
  execute: async (message) => { /* ... */ }
})
```

### Deliverables

- [ ] Define slot types and their TypeScript interfaces
- [ ] Implement slot registry in SDK
- [ ] Add slot rendering in app components (render registered items at each extension point)
- [ ] Build one internal feature as a "plugin" to validate the slot system (e.g., move message reactions into a slot)

## Phase 3: Plugin Runtime

**Goal:** Third-party code can extend Fluux safely.

### Plugin Manifest

```json
{
  "id": "fluux-translate",
  "name": "Message Translator",
  "version": "1.0.0",
  "minSdkVersion": "0.15.0",
  "author": "...",
  "description": "Translate messages using DeepL",
  "permissions": [
    "messages:read",
    "network:https://api.deepl.com/*"
  ],
  "slots": ["message-actions"],
  "activationEvents": ["onSlot:message-actions"]
}
```

### Permission Model

Plugins declare required permissions in the manifest. Users approve on install.

| Permission          | Grants                                       |
|---------------------|----------------------------------------------|
| `messages:read`     | Read messages from active conversation       |
| `messages:send`     | Send messages (bot plugins)                  |
| `roster:read`       | Read contact list                            |
| `roster:write`      | Add/remove contacts                          |
| `rooms:read`        | Read room list and metadata                  |
| `rooms:join`        | Join/leave rooms                             |
| `presence:read`     | Read presence information                    |
| `network:<pattern>` | HTTP requests to matching URLs               |
| `storage`           | Persistent key-value storage (plugin-scoped) |
| `notifications`     | Show system notifications                    |
| `clipboard`         | Read/write clipboard                         |

### Plugin Lifecycle

```typescript
interface FluuxPlugin {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

interface PluginContext {
  // Slot registration (auto-cleanup on deactivate)
  slots: SlotRegistry

  // SDK access (filtered by permissions)
  sdk: {
    messages: MessageAPI      // if messages:read/send granted
    roster: RosterAPI         // if roster:read/write granted
    rooms: RoomAPI            // if rooms:read/join granted
    presence: PresenceAPI     // if presence:read granted
  }

  // Plugin-scoped storage
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }

  // Event bus
  events: {
    on(event: string, handler: Function): () => void
    emit(event: string, data: unknown): void
  }

  // Settings (declared in manifest, values managed by app)
  settings: {
    get(key: string): unknown
    onChange(key: string, handler: (value: unknown) => void): () => void
  }
}
```

### Lazy Activation

Plugins declare `activationEvents` — they are loaded only when the trigger fires:

- `onSlot:message-actions` — first time the message actions menu opens
- `onCommand:translate` — user invokes the command
- `onStartup` — load immediately (use sparingly)
- `onMessage` — a message is received (for bot/filter plugins)

### Sandboxing Strategy

Sandboxing is enforced in layers, from strongest (Rust/OS level) to practical (JavaScript level). Each layer covers different threats.

#### Layer 1: Tauri enforces hard boundaries (Rust side)

The strongest layer — cannot be bypassed from JavaScript. Tauri already has a capability/permission system for IPC commands.

Plugin manifest permissions map directly to Tauri scopes:

| Manifest permission               | Tauri enforcement                                  |
|-----------------------------------|----------------------------------------------------|
| `network:https://api.deepl.com/*` | HTTP plugin scoped to matching URLs only           |
| `storage`                         | Filesystem scoped to `~/.fluux/plugins/<id>/data/` |
| `notifications`                   | Notification IPC command allowed                   |
| `clipboard`                       | Clipboard IPC command allowed                      |

A plugin declaring `network:https://api.deepl.com/*` literally cannot reach any other domain — Tauri's Rust layer rejects the request. Plugins don't call `fetch()` directly; they call `context.http.fetch()` which routes through a Tauri IPC command that checks the manifest scope.

#### Layer 2: Frozen PluginContext proxy (JavaScript side)

The `PluginContext` given to each plugin is not the real store — it's a **frozen Proxy** that checks permissions before forwarding calls.

```typescript
function createPluginAPI(pluginId: string, permissions: string[]): PluginContext {
  const sdk = {
    messages: permissions.includes('messages:read')
      ? {
          getActive: () => chatStore.getState().activeConversation?.messages ?? [],
          onMessage: (cb) => chatStore.subscribe(/* filtered */),
          ...(permissions.includes('messages:send') && {
            send: (to, body) => client.sendMessage(to, body)
          })
        }
      : undefined,

    roster: permissions.includes('roster:read')
      ? { getContacts: () => rosterStore.getState().contacts }
      : undefined,

    // Same pattern for rooms, presence
  }

  return Object.freeze(sdk)
}
```

This layer is **not bulletproof** — a determined attacker in the same JS process can access globals or walk prototypes. But it serves three purposes:
- Prevents honest plugins from accidentally overstepping
- Makes the permission contract explicit and auditable
- Powers the settings UI that shows users exactly what each plugin can access

#### Layer 3: Shadow DOM for style isolation

Plugin UI renders inside Shadow DOM at each slot, preventing plugin CSS from leaking into the app and app CSS from breaking plugin rendering.

```typescript
function SlotContainer({ slotId }: { slotId: string }) {
  const items = useSlot(slotId)

  return items.map(item => (
    <ShadowRoot key={item.pluginId}>
      <item.Component context={item.context} />
    </ShadowRoot>
  ))
}
```

Plugins that register data-only items (actions, commands, filters) don't need this — the host renders the menu item from the plugin's descriptor.

#### Layer 4 (future): Web Workers for untrusted plugins

If the ecosystem grows to include untrusted third-party plugins, we can add true process isolation:

```
┌─────────────────────┐    postMessage     ┌──────────────┐
│  Main thread        │ ◄────────────────► │  Worker      │
│                     │                    │              │
│  Slot proxy:        │  { type: 'action', │  Plugin code │
│  renders descriptors│    slot: '...',    │  (no DOM)    │
│  from worker        │    label: '...' }  │              │
│                     │                    │              │
│  API proxy:         │  { type: 'api',    │  Calls       │
│  forwards permitted │    method: '...',  │  context.sdk │
│  calls to stores    │    args: [...] }   │              │
└─────────────────────┘                    └──────────────┘
```

Workers can't access the DOM. For UI, plugins send declarative descriptions and the host renders them. This works well for simple slots (menu items, status indicators) but poorly for complex custom views.

#### Implementation plan

| Step        | Layer                             | Isolation strength | When         |
|-------------|-----------------------------------|--------------------|--------------|
| Phase 3     | Tauri IPC permission scoping      | Strong (Rust/OS)   | Day one      |
| Phase 3     | Frozen `PluginContext` proxy      | Medium (JS)        | Day one      |
| Phase 3     | Shadow DOM for plugin UI          | Style only         | Day one      |
| Later       | Worker-based execution            | Strong (process)   | If needed    |

**Key design decision:** The permission manifest is the stable contract. Whether enforcement is a JS proxy today or a Worker boundary tomorrow, plugin code doesn't change — it still calls `context.sdk.messages.getActive()`. We can tighten enforcement without breaking the plugin API.

### Deliverables

- [ ] Implement plugin loader (read manifest, check permissions, lazy activate)
- [ ] Implement PluginContext with permission-filtered SDK access
- [ ] Implement plugin-scoped storage
- [ ] Implement event bus for cross-plugin communication
- [ ] Build plugin settings UI (auto-generated from manifest)
- [ ] Build a reference plugin (e.g., message translator) to validate the full stack
- [ ] Document plugin authoring guide with examples

## Phase 4: Distribution (Later)

Not needed for initial release, but worth considering:

- Plugin/theme registry (a simple JSON file on GitHub, like Obsidian)
- In-app browser for discovering and installing plugins/themes
- Update mechanism with permissions diff warnings
- Plugin signing for verified authors

## Implementation Order

```
1. React 19.1 migration + compiler          (few days)
2. CSS variable audit + taxonomy             (Phase 1 start)
3. Theme loader + snippet system             (Phase 1)
4. Slot type definitions + registry          (Phase 2 start)
5. Slot rendering in app components          (Phase 2)
6. Validate with one internal "plugin"       (Phase 2)
7. Plugin manifest + loader + lifecycle      (Phase 3 start)
8. PluginContext + permission model          (Phase 3)
9. Reference plugin                          (Phase 3)
10. Distribution                             (Phase 4, later)
```

Each phase is independently shippable and useful. Themes (Phase 1) don't require any plugin infrastructure. Slots (Phase 2) work with internal code before plugins exist. The plugin runtime (Phase 3) builds on established slots and APIs.
