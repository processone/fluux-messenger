# Admin User View — Settings-Kit Redesign

**Status:** design approved (2026-07-02) · **Target:** 0.17 · **Origin:** admin-friendliness backlog
(see `docs/superpowers/specs/2026-06-20-admin-server-overview-design.md`, "Next steps" §3 Deep user
management)

## Goal

`AdminUserView` (the per-user detail screen reached from Admin → Users → a user) is currently a bare
"Actions" box: a header (back button, JID) over a single bordered `<div>` of stacked plain buttons
(Change password, End sessions, Ban account, Delete user). It carries no visual relationship to the
rest of the app. Restyle it using the shared Settings primitive kit (`SettingsSection` /
`SettingsGroup` / `SettingsRow` in `components/ui/`) introduced by the Aurora settings/admin
consistency pass (#731), whose commit message explicitly reserved it for this redesign.

## Scope

**In:**
- Replace the stacked-button "Actions" box with `SettingsSection` + `SettingsGroup` +
  `SettingsRow` per action, mirroring `AccountSection.tsx`'s "Change password" row idiom exactly.
- Replace the static "Manage user account" subtitle with an inline online/offline status indicator
  driven by the existing `AdminUser.isOnline` field.
- Add a `danger?: boolean` prop to the shared `SettingsRow` primitive (red label + icon), the one
  gap versus what this screen needs.
- Update the existing `AdminUserView.test.tsx` render tests for the new structure.

**Out (explicitly deferred):**
- Any new "Account info" card/section. `AdminUser` only carries `jid` / `username` / `isOnline`;
  username duplicates the JID already shown in the header, so a second section would hold one
  sparse row for no real gain. Revisit once richer per-user data (last-login, roster, etc.) is
  wired up — a separate, later task.
- Any change to *what* the four actions do (their handlers, confirm-dialog copy, and the
  `executeCommandForUser` / `client.admin` calls behind them are untouched).
- A kebab/overflow menu (considered and rejected — see "Approach").
- A Contact-style avatar/hero (considered and rejected — see "Approach").

## Approach (chosen)

Two established visual languages already exist in the app for a "detail screen with actions":
Contact's hero + card-grid (avatar, kebab actions menu, `InfoRow` cards), and Settings' grouped-row
kit (`SettingsSection`/`SettingsGroup`/`SettingsRow`, flat list of full-row-clickable actions).

**Chosen: the Settings-kit.** It's the one the admin/settings consistency pass already reserved for
this redesign, it reads as an admin console (not a social profile — admin users aren't contacts),
and it keeps the whole app's admin + settings areas visually consistent. All four actions stay
directly visible (no menu to open first) — appropriate here since none of them are secondary to the
others (unlike Contact's block/remove, which are true overflow actions next to the primary "message
this person" CTA).

Rejected: Contact hero + card grid — mismatched tone (social-profile framing for an admin console)
and would need a new avatar-with-no-photo affordance and a kebab menu that hides actions an admin
is likely to want to see at a glance.

## Component structure

```
AdminUserView
├── Header (unchanged layout)
│   ├── back button
│   ├── h2: user.jid
│   └── status line: dot + "Online"/"Offline", or the existing
│       "Manage user account" caption when user.isOnline is undefined
└── <SettingsSection title={t('admin.userView.actions')}>
      <SettingsGroup>
        <SettingsRow label="Change password" onClick={...}><Key/></SettingsRow>
        <SettingsRow label="End sessions"    onClick={...}><Power/></SettingsRow>
        {canBanAccount &&
        <SettingsRow label="Ban account" danger onClick={...}><ShieldOff/></SettingsRow>}
        <SettingsRow label="Delete user" danger onClick={...}><Trash2/></SettingsRow>
      </SettingsGroup>
    </SettingsSection>
```

- `SettingsRow`'s `onClick` opens the same three `ConfirmDialog`s as today (Delete: danger, End
  Sessions: warning, Ban: danger) or, for Change password, calls `onChangePassword` directly (no
  confirm — unchanged from current behavior).
- Row order matches the current button order (Change password, End sessions, Ban account, Delete
  user) so the riskiest actions stay at the bottom, consistent with today's screen.

## `SettingsRow` change

Add an optional `danger?: boolean` prop, mirroring `OverflowMenuItem.danger`:

```ts
interface SettingsRowProps {
  // ...existing fields
  danger?: boolean
}
```

When `true`, the row's `<label>` renders with `text-fluux-error` instead of `text-fluux-text`. The
icon passed as `children` also needs the red treatment — since `children` is caller-supplied
markup, the caller (this screen) applies `text-fluux-error` to the icon directly rather than
`SettingsRow` trying to reach into its children; `SettingsRow` only owns the label color.

This is additive and backward compatible: every existing `SettingsRow` call site omits the prop and
is unaffected.

## Status indicator

```tsx
{user.isOnline === undefined
  ? <p className="text-sm text-fluux-muted">{t('admin.userView.manageUser')}</p>
  : (
    <div className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${user.isOnline ? 'bg-fluux-green' : 'bg-fluux-muted'}`} />
      <span className="text-sm text-fluux-text">
        {t(user.isOnline ? 'admin.users.online' : 'admin.users.offline')}
      </span>
    </div>
  )}
```

Reuses the existing `admin.users.online` / `admin.users.offline` i18n keys (already present, used
by `UserListItem`) — no new i18n keys needed for this part.

## Testing

- Update `AdminUserView.test.tsx`: replace the plain-button queries with `SettingsRow`-rendered
  button queries (labels/roles are unaffected — `SettingsRow` renders a `<button>` when `onClick` is
  passed, same as today's plain buttons, so most existing `screen.getByText(...)` /
  `fireEvent.click(...)` assertions carry over unchanged). Add a case for the status line: online →
  dot + "Online", offline → dot + "Offline", undefined → existing caption text.
- Add a `SettingsRow.test.tsx` case (existing file) for the new `danger` prop: renders with
  `text-fluux-error` on the label when `danger` is true, `text-fluux-text` when omitted.
- No SDK, store, or i18n-key changes — existing full-suite/typecheck/lint gates apply unchanged.

## Architecture seam & isolation

- Purely a presentation change inside `AdminUserView.tsx` plus one additive prop on the shared
  `SettingsRow` primitive. No prop signature changes to `AdminUserView` itself (still takes
  `user`, `onBack`, `onDeleteUser`, `onEndSessions`, `onChangePassword`, `onBanAccount`,
  `canBanAccount`, `isExecuting` — unchanged from the current interface).
- `AdminView.tsx` (the parent) needs no changes — it already passes exactly these props.

## Next steps (not in this task)

- Once per-user data is richer (last-login, roster size, session/resource list), revisit whether an
  "Account info" `SettingsSection` earns its place above the "Actions" section.
