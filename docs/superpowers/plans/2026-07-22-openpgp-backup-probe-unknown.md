# OpenPGP Backup Probe "unknown" State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a failed OpenPGP backup probe from masquerading as "no backup exists", so no consumer can overwrite, orphan, or fail to restore a backup it never actually ruled out.

**Architecture:** `fetchSecretKeyBackup` adopts the classification `secretKeyProbe.ts` already established — `item-not-found` means absent, everything else throws. A new `probeSecretKeyBackup()` returns `'present' | 'absent' | 'unknown'` and never throws. The settings panel's `boolean | null` state becomes one exhaustive four-state union so the compiler enumerates every consumer. Every consumer treats `unknown` as "a backup might exist", because in all five cases the dangerous action is the one that assumes absence.

**Tech Stack:** React 19 + TypeScript, Zustand, Vitest + @testing-library/react, i18next (33 locales).

**Spec:** [docs/superpowers/specs/2026-07-22-openpgp-backup-probe-unknown-design.md](../specs/2026-07-22-openpgp-backup-probe-unknown-design.md)

## Global Constraints

- **Scope: `apps/fluux` only.** No SDK change, no Rust change, no new cryptography.
- **The `item-not-found` classifier lives inside `OpenPGPPluginBase.ts`** — NOT a new shared module. On `features/omemo` this file is at `packages/openpgp-plugin/src/OpenPGPPluginBase.ts`; a new file under `apps/fluux/src/e2ee/` lands in a directory that branch deleted and would need manual relocation on merge.
- **Do not modify `secretKeyProbe.ts`.** It already has the right semantics and serves the separate plugin-less toggle-on path. It is the reference, not the target.
- **Do not change backup encryption bytes.** `consumeSequoiaVectors.test.ts` and `consumeMigrationVectors.test.ts` must pass without regenerating golden vectors.
- **All 33 locales** get every new key: `ar be bg ca cs da de el en es et fi fr ga he hr hu is it lt lv mt nb nl pl pt ro ru sk sl sv uk zh-CN`
- **Locale files:** 4-space indent, trailing newline. Edit by parse → mutate → `JSON.stringify(data, null, 4) + "\n"`. Never hand-edit the JSON text, never reorder keys.
- **No em-dash connectors in user-facing copy.** Use a comma, colon, or full stop.
- **No hardcoded Tailwind palette colors** in `EncryptionSettings.tsx` — an existing test greps the source for `/(?:red|green|yellow)-\d{2,3}/` and asserts zero matches. Use `fluux-` tokens.
- **Test integrity:** every negative assertion (`not.toHaveBeenCalled`, `queryBy*` → null) must be paired with a positive control test in the same fixture that drives the same wire to completion. A deliberate-break check is necessary but has already been shown insufficient on its own (#1064).
- **Before every commit:** tests pass with no new stderr, `npm run typecheck` passes, `npm run lint` passes.
- **Never include a Claude footer in commit messages.**

## Preflight

Branch `mr/openpgp-probe-unknown-state` is already created from `origin/main` (`c2daca9d`). Dependencies were installed for a previous branch in this worktree; re-verify they still resolve.

- [ ] **Confirm the baseline is green**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && npm run build:sdk && npm test
```

Expected: SDK and app suites both pass. If `build:sdk` fails, run `npm install` first (in the worktree — a symlink to the main checkout resolves `@fluux/sdk` to the wrong branch).

**Note on shell state:** the Bash working directory persists between calls, so every command below uses an absolute path. Do not assume you are where the previous step left you.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` | Plugin backup API | Classify probe errors; add `probeSecretKeyBackup`; restore raises transient |
| `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts` | Plugin behaviour lock | Add a `describe` block (base behaviour, inherited by both subclasses) |
| `apps/fluux/src/i18n/locales/*.json` (33) | User-facing copy | Add 5 keys under `settings.encryption` |
| `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` | Settings consumers | State union, probe effect, status line, retry, 4 call sites |
| `apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx` | Behaviour lock | Add a `describe` block |
| `apps/fluux/src/components/UnlockEncryptionDialog.tsx` | Unlock mode selection | `unknown` → `restore` |
| `apps/fluux/src/demo/DemoOpenPGPPlugin.ts` | Demo stub | `hasSecretKeyBackup` → `probeSecretKeyBackup` |

No new files.

---

## Task 1: Plugin classifies probe failures

Ships independently: `hasSecretKeyBackup` is kept as a compatibility wrapper preserving today's exact semantics, so no consumer changes yet and the app compiles unchanged.

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts`
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces, used by Tasks 3 and 4:
  - `export type BackupProbeResult = 'present' | 'absent' | 'unknown'`
  - `async probeSecretKeyBackup(): Promise<BackupProbeResult>` — never throws
  - `async fetchSecretKeyBackup(): Promise<string | null>` — now THROWS on anything but a server-confirmed absence
  - `hasSecretKeyBackup(): Promise<boolean>` — retained this task, deleted in Task 4

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts`, immediately after the existing `describe('XEP-0373 §5 secret-key backup', …)` block (~line 2470).

Harness facts you need, already verified — do not re-derive them:
- `makeContext('me@example.com')` returns `{ ctx, published, … }`; `plugin` is the suite-scoped `let plugin: SequoiaPgpPlugin` (declared ~line 583) and is initialised with `await plugin.init(ctx)`.
- `ctx.xmpp.queryPEP` is a plain property, so reassigning it after `init` overrides the probe.
- The harness's `publishPEP` writes the item into the same map `queryPEP` reads, so a `backupSecretKey` call is visible to a subsequent probe. That is what makes the `present` control test meaningful.

```tsx
  // A failed probe used to be indistinguishable from an empty node:
  // fetchSecretKeyBackup swallowed every error and returned null. Callers
  // then read "no backup exists" when the truthful answer was "could not
  // find out", which let the settings panel overwrite a real backup and
  // told restoring users their backup did not exist. Only `item-not-found`
  // means absent; everything else is an open question.
  describe('secret-key backup probe classification', () => {
    it('reports absent when the server returns item-not-found', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('item-not-found')
      }

      expect(await plugin.probeSecretKeyBackup()).toBe('absent')
    })

    it('reports absent when the node resolves with no secretkey item', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => []

      expect(await plugin.probeSecretKeyBackup()).toBe('absent')
    })

    it('reports unknown when the query times out', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('remote-server-timeout')
      }

      expect(await plugin.probeSecretKeyBackup()).toBe('unknown')
    })

    it('reports unknown when the transport is down', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('not connected')
      }

      expect(await plugin.probeSecretKeyBackup()).toBe('unknown')
    })

    it('reports unknown when a secretkey item is present but undecodable', async () => {
      // Something IS on the server. Reporting absence would let a caller
      // overwrite it, which is the whole failure this change prevents.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => [
        {
          id: 'current',
          payload: {
            name: 'secretkey',
            attrs: { xmlns: 'urn:xmpp:openpgp:0' },
            children: ['!!!not-base64!!!'],
          },
        },
      ]

      expect(await plugin.probeSecretKeyBackup()).toBe('unknown')
    })

    it('reports present when a decodable backup exists', async () => {
      // Control test: the harness's publishPEP writes into the same map
      // queryPEP reads, so this proves the fixture can reach a positive
      // result and the negative expectations above are not vacuous.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('probe-classification-pp')

      expect(await plugin.probeSecretKeyBackup()).toBe('present')
    })

    it('surfaces a transient error from restoreSecretKey when the probe fails', async () => {
      // Previously this raised permanent/no-backup — "no secret-key backup
      // found on server" — at the exact moment a user decides whether to
      // replace their identity.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('remote-server-timeout')
      }

      await expect(plugin.restoreSecretKey('pp')).rejects.toMatchObject({
        kind: 'transient',
      })
    })

    it('still raises no-backup when the server confirms there is none', async () => {
      // Control test for the pair above: the no-backup path must survive.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('item-not-found')
      }

      await expect(plugin.restoreSecretKey('pp')).rejects.toMatchObject({
        kind: 'permanent',
        code: 'no-backup',
      })
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "secret-key backup probe classification"
```

Expected: FAIL. Six tests fail with `plugin.probeSecretKeyBackup is not a function`. `surfaces a transient error from restoreSecretKey` fails because it currently rejects with `permanent`/`no-backup`.

`still raises no-backup when the server confirms there is none` should already PASS — that path exists today. If it fails, the fixture is wrong, not the implementation; fix the fixture before continuing.

- [ ] **Step 3: Add the item-not-found classifier**

At module scope in `OpenPGPPluginBase.ts`, next to the other module-level helpers (near `parseSecretKeyBackupItem`, ~line 2348), add:

```ts
/**
 * `item-not-found` is the only IQ error condition that means "this node was
 * never created", i.e. the user has genuinely never published a backup.
 * ejabberd and Prosody both return it for an absent node. Every other
 * failure (timeout, transport down, permission, internal error) leaves the
 * question open and must NOT collapse to "no backup".
 *
 * The IQ caller surfaces XMPP conditions inside the Error message; the
 * codebase convention is to substring-match the condition name. Mirrors
 * `secretKeyProbe.ts`, which established these semantics for the
 * plugin-less toggle-on path.
 */
function isItemNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('item-not-found')
}
```

- [ ] **Step 4: Make fetchSecretKeyBackup classify instead of swallow**

Replace the whole of `fetchSecretKeyBackup` (~line 1046) with:

```ts
  /**
   * Query our own XEP-0373 §5 secret-key node.
   *
   * Returns the armored backup when one exists. Returns `null` ONLY when the
   * server has confirmed there is none: an `item-not-found` IQ error, or a
   * node that resolved but carried no `<secretkey>` item.
   *
   * Every other failure THROWS — timeout, transport down, permission, or an
   * item we found but could not decode. Collapsing those to "no backup" is
   * what let callers overwrite a real backup and told restoring users their
   * backup did not exist. Callers that want a non-throwing answer should use
   * {@link probeSecretKeyBackup}.
   */
  async fetchSecretKeyBackup(): Promise<string | null> {
    const ctx = this.requireCtx()
    let items: Awaited<ReturnType<typeof ctx.xmpp.queryPEP>>
    try {
      items = await ctx.xmpp.queryPEP(ctx.account.jid, SECRET_KEY_NODE, 1)
    } catch (err) {
      if (isItemNotFoundError(err)) return null
      throw this.toPluginError('fetchSecretKeyBackup', err)
    }
    for (const item of items) {
      let armored: string | null
      try {
        armored = parseSecretKeyBackupItem(item.payload)
      } catch (err) {
        // We DID find a `<secretkey>` item — there is something on the
        // server, we just cannot decode it. Reporting absence here would
        // let a caller overwrite that something with a fresh key.
        throw this.toPluginError('fetchSecretKeyBackup', err)
      }
      if (armored) return armored
    }
    return null
  }
```

- [ ] **Step 5: Add the non-throwing probe**

Immediately after `fetchSecretKeyBackup`, replace the existing `hasSecretKeyBackup` with:

```ts
  /**
   * Non-throwing three-state answer to "is there a backup on the server?".
   *
   * `unknown` is not a failure to be retried silently — it is information the
   * UI must act on. Every consumer treats it as "a backup might exist",
   * because in each case the dangerous action is the one that assumes
   * absence: overwriting the node, rotating without re-publishing, hiding
   * the delete-the-backup option, or offering to generate a fresh key.
   */
  async probeSecretKeyBackup(): Promise<BackupProbeResult> {
    try {
      return (await this.fetchSecretKeyBackup()) === null ? 'absent' : 'present'
    } catch (err) {
      this.requireCtx().logger.debug(
        `${this.pluginName()}: secret-key backup probe inconclusive: ${formatError(err)}`,
      )
      return 'unknown'
    }
  }

  /**
   * @deprecated Collapses `unknown` to `false`. Retained only until the last
   * consumer migrates to {@link probeSecretKeyBackup}; removed in Task 4.
   */
  async hasSecretKeyBackup(): Promise<boolean> {
    return (await this.probeSecretKeyBackup()) === 'present'
  }
```

Add the exported type near the file's other exported types, above the class:

```ts
/**
 * Three-state result of probing the server for a secret-key backup.
 * `unknown` means the probe could not reach a definitive answer — see
 * {@link OpenPGPPluginBase.probeSecretKeyBackup}.
 */
export type BackupProbeResult = 'present' | 'absent' | 'unknown'
```

- [ ] **Step 6: Make restoreSecretKey surface the transient failure**

In `restoreSecretKey` (~line 1066), `fetchSecretKeyBackup` can now throw. A thrown `E2EEPluginError` must propagate untouched so the caller sees `transient`; only a genuine `null` becomes `no-backup`. The existing code already has the right shape — verify it reads:

```ts
    const armoredMessage = await this.fetchSecretKeyBackup()
    if (!armoredMessage) {
      throw new E2EEPluginError(
        'permanent',
        'no-backup',
        `${this.pluginName()}: no secret-key backup found on server`,
      )
    }
```

No edit is needed here: an exception from `fetchSecretKeyBackup` now propagates past this block on its own. Do not wrap it in a try/catch — doing so would re-collapse the distinction this task creates.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts src/e2ee/WebOpenPGPPlugin.test.ts
```

Expected: all pass. Both subclasses inherit the base behaviour, so the web suite must stay green without edits. If a pre-existing test now fails, it was asserting the swallow — read it, and if it encoded the old "treated as no backup" contract, update it and note the change in your report.

- [ ] **Step 8: Deliberate-break check**

Break: in `fetchSecretKeyBackup`, change `if (isItemNotFoundError(err)) return null` to `return null` (restoring the swallow).

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "secret-key backup probe classification"
```

Expected: FAIL — both `unknown` timeout/transport tests and the `restoreSecretKey` transient test. Revert and re-run: PASS.

- [ ] **Step 9: Verify and commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && npm test && npm run typecheck && npm run lint
```

Expected: all green.

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts
git commit -m "fix(e2ee): classify secret-key backup probe failures instead of swallowing them

fetchSecretKeyBackup caught every error and returned null, so a timeout, a
dead transport and a genuinely empty PEP node were indistinguishable.
item-not-found now means absent; everything else throws, matching the
semantics secretKeyProbe.ts already established for the plugin-less path.

probeSecretKeyBackup returns present/absent/unknown without throwing.
restoreSecretKey now surfaces a transient error on a transport failure
instead of claiming no backup exists on the server."
```

---

## Task 2: Add the unknown-state copy to all 33 locales

Ships independently: unused keys are inert, and it means Task 3 never renders a raw key string.

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` and the other 32 locale files

**Interfaces:**
- Consumes: nothing
- Produces: five keys under `settings.encryption`, referenced by Task 3:
  `backupStatusUnknown`, `backupStatusRetry`, `backupReplaceUnknownTitle`, `backupReplaceUnknownMessage`, `backupReplaceUnknownAction`

- [ ] **Step 1: Add the English copy**

Insert into `apps/fluux/src/i18n/locales/en.json` under `settings.encryption`. Put the two status keys immediately after `backupStatusMismatch`, and the three replace keys immediately after `backupReplaceOwnAction`. Use the parse/mutate/stringify rule from Global Constraints.

```json
"backupStatusUnknown": "Couldn't check whether a backup exists on this server.",
"backupStatusRetry": "Check again",
"backupReplaceUnknownTitle": "Replace the backup on this server?",
"backupReplaceUnknownMessage": "We couldn't check whether a backup already exists on this server. Publishing will replace it if there is one, and the passphrase saved for that backup will stop working. Your key itself is unchanged.",
"backupReplaceUnknownAction": "Publish anyway"
```

- [ ] **Step 2: Translate into the other 32 locales**

Match the register and terminology already used by each locale's neighbouring `backupStatusMismatch`, `backupConflictMessage`, and `backupReplaceOwnMessage`. Read them in the file before translating. Terminology for "passphrase" varies by locale and sometimes within a locale: pick whichever term dominates that file's backup copy and stay internally consistent across your five new strings.

No em-dash connectors in any language.

- [ ] **Step 3: Verify every locale has all five keys**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && node -e "
const fs=require('fs');const d='src/i18n/locales';
const need=['backupStatusUnknown','backupStatusRetry','backupReplaceUnknownTitle','backupReplaceUnknownMessage','backupReplaceUnknownAction'];
let bad=0;
for(const f of fs.readdirSync(d).filter(f=>f.endsWith('.json'))){
  const e=JSON.parse(fs.readFileSync(d+'/'+f,'utf8')).settings.encryption;
  const miss=need.filter(k=>typeof e[k]!=='string'||!e[k].trim());
  if(miss.length){console.log(f,'MISSING',miss.join(','));bad++}
  const em=need.filter(k=>typeof e[k]==='string'&&e[k].includes(String.fromCharCode(8212)));
  if(em.length){console.log(f,'EM-DASH',em.join(','));bad++}
}
console.log(bad?'FAIL':'OK all 33 locales');
"
```

Expected: `OK all 33 locales`

- [ ] **Step 4: Verify formatting survived**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && git diff --stat apps/fluux/src/i18n/locales/
```

Expected: exactly 33 files changed, roughly +5 lines each. A file showing hundreds of changed lines means the indent or key order was destroyed — revert that file and redo it with the parse/mutate/stringify rule.

- [ ] **Step 5: Commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af
git add apps/fluux/src/i18n/locales/
git commit -m "i18n(encryption): add copy for an inconclusive backup probe"
```

---

## Task 3: Settings panel consumes the three-state probe

**Files:**
- Modify: `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`
- Test: `apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx`

**Interfaces:**
- Consumes: `probeSecretKeyBackup(): Promise<'present' | 'absent' | 'unknown'>` from Task 1; the five i18n keys from Task 2
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the failing tests**

Append this `describe` block inside the top-level `describe('EncryptionSettings PEP support', …)`, after the `re-publishing an in-sync backup` block and before `Aurora color tokenization`.

```tsx
  // A failed server probe used to be coerced to "no backup exists", which
  // skipped the replace confirmation entirely: a transient network failure
  // could overwrite a real server backup with no warning. `unknown` now
  // fails toward "a backup might exist" at every consumer.
  describe('inconclusive backup probe', () => {
    const FP = 'AAAABBBBCCCCDDDDEEEEFFFF0000111122223333'
    const mockBackupSecretKey = vi.fn<(pp: string) => Promise<void>>()
    const mockProbe = vi.fn<() => Promise<'present' | 'absent' | 'unknown'>>()

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      mockStatus = 'online'
      mockCheckPepSupport.mockResolvedValue(true)
      mockBackupSecretKey.mockResolvedValue(undefined)
      mockProbe.mockResolvedValue('unknown')
      mockPlugin = {
        getOwnFingerprint: () => FP,
        getBackedUpFingerprint: () => FP,
        probeSecretKeyBackup: mockProbe,
        backupSecretKey: mockBackupSecretKey,
      }
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        pluginRegisteredAt: 1,
        registrationError: null,
      })
    })

    it('shows the inconclusive status line instead of claiming no backup', async () => {
      render(<EncryptionSettings />)

      expect(
        await screen.findByText('settings.encryption.backupStatusUnknown'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupStatusNone'),
      ).not.toBeInTheDocument()
    })

    it('shows the definitive status line when the probe succeeds', async () => {
      // Control test: proves this fixture can render the other status lines,
      // so the negative assertion above is not vacuous.
      mockProbe.mockResolvedValue('present')

      render(<EncryptionSettings />)

      expect(
        await screen.findByText('settings.encryption.backupStatusInSync'),
      ).toBeInTheDocument()
    })

    it('offers a retry that re-runs the probe', async () => {
      render(<EncryptionSettings />)

      const retry = await screen.findByRole('button', {
        name: 'settings.encryption.backupStatusRetry',
      })
      expect(mockProbe).toHaveBeenCalledTimes(1)

      mockProbe.mockResolvedValue('present')
      fireEvent.click(retry)

      await screen.findByText('settings.encryption.backupStatusInSync')
      expect(mockProbe).toHaveBeenCalledTimes(2)
    })

    it('confirms with the unknown variant before publishing', async () => {
      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.backupAction' }),
      )

      expect(
        await screen.findByText('settings.encryption.backupReplaceUnknownTitle'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupReplaceOwnTitle'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupConflictTitle'),
      ).not.toBeInTheDocument()
    })

    it('publishes once the unknown confirmation is accepted', async () => {
      // Control test for the pair above: proves the publish wire is live in
      // this fixture, so "did not publish" assertions have teeth.
      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.backupAction' }),
      )
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'settings.encryption.backupReplaceUnknownAction',
        }),
      )
      const publish = await screen.findByRole('button', {
        name: 'settings.encryption.backupPublish',
      })
      fireEvent.click(document.querySelector('input[type="checkbox"]')!)
      await waitFor(() => expect(publish).not.toBeDisabled())
      fireEvent.click(publish)

      await waitFor(() => expect(mockBackupSecretKey).toHaveBeenCalledTimes(1))
    })

    it('offers the delete-the-server-backup option under an inconclusive probe', async () => {
      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.deleteKey' }),
      )

      expect(
        await screen.findByText('settings.encryption.deleteKeyAlsoBackup'),
      ).toBeInTheDocument()
    })
  })
```

Then add the rotate coverage. Rotate is Tauri-gated (`pluginStatus === 'ready' && isTauri()`), so this one test needs the platform mock. Add at the top of the file, beside the other `vi.mock` calls:

```tsx
let mockIsTauri = false
vi.mock('@/utils/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/tauri')>()
  return { ...actual, isTauri: () => mockIsTauri }
})
```

Set `mockIsTauri = false` in the outermost `beforeEach` so every existing test keeps its current behaviour, then add inside the `inconclusive backup probe` block:

```tsx
    it('re-publishes the backup on rotate under an inconclusive probe', async () => {
      // Over-publishing a backup that did not exist is harmless. Leaving a
      // real one encrypted to the retired key is not, so `unknown` takes the
      // same path as in-sync: through the passphrase dialog.
      mockIsTauri = true

      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.rotateAction' }),
      )
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'settings.encryption.rotateConfirmAction',
        }),
      )

      // The passphrase dialog is the re-publish path; its absence would mean
      // we rotated and left the server copy stale.
      expect(
        await screen.findByRole('button', { name: 'settings.encryption.backupPublish' }),
      ).toBeInTheDocument()
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/settings-components/EncryptionSettings.test.tsx -t "inconclusive backup probe"
```

Expected: 6 of 7 FAIL. The component still calls `hasSecretKeyBackup`, which the fixture no longer provides, so it falls into the `!plugin?.hasSecretKeyBackup` branch and sets `false` — producing the "none" status line and no retry button.

`shows the definitive status line when the probe succeeds` will also fail for the same reason. That is expected at this stage; it becomes a genuine control test once Step 3 lands.

- [ ] **Step 3: Replace the boolean state with an exhaustive union**

At module scope, above the component, add:

```tsx
/**
 * Server-probe state for the secret-key backup node.
 *
 * `unknown` is deliberately distinct from `absent`: a failed probe used to
 * be coerced to "no backup", which skipped the replace confirmation and let
 * a transient network failure overwrite a real backup. Consumers treat
 * `unknown` as "a backup might exist".
 */
type BackupProbeState = 'checking' | 'present' | 'absent' | 'unknown'
```

Replace the state declaration (~line 136) and its comment:

```tsx
  // `checking` until the first probe settles. See BackupProbeState.
  const [backupProbe, setBackupProbe] = useState<BackupProbeState>('checking')
```

Update `isBackupInSync` (~line 88) to take the union:

```tsx
function isBackupInSync(
  backupProbe: BackupProbeState,
  backedUpFingerprint: string | null,
  fingerprint: string | null,
): boolean {
  return backupProbe === 'present' && !!fingerprint && backedUpFingerprint === fingerprint
}
```

TypeScript now flags every remaining site: `=== true` / `=== false` / `=== null` on a string union are type errors. Work through them with `npm run typecheck` — that list is the authoritative set of consumers.

- [ ] **Step 4: Rewrite the probe effect**

Replace the body of the probe effect (~line 596-626):

```tsx
    void (async () => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            probeSecretKeyBackup?: () => Promise<'present' | 'absent' | 'unknown'>
            getBackedUpFingerprint?: () => string | null
          }
        | null
        | undefined
      // Read the local marker synchronously — it's cheap and lets the
      // in-sync status land in the same render as the server probe
      // instead of flickering through a "backup needed" frame.
      if (!cancelled) {
        setBackedUpFingerprint(plugin?.getBackedUpFingerprint?.() ?? null)
      }
      if (!plugin?.probeSecretKeyBackup) {
        // No plugin method at all is a different thing from a failed probe:
        // there is nothing to publish to, so `absent` is truthful here.
        if (!cancelled) setBackupProbe('absent')
        return
      }
      const result = await plugin.probeSecretKeyBackup()
      if (!cancelled) setBackupProbe(result)
    })()
```

The `try`/`catch` is gone on purpose: `probeSecretKeyBackup` never throws, and re-adding a catch that sets `absent` would restore the exact bug this change removes.

Also reset to `checking`, not `null`, in the effect's early-return branch where `pluginStatus !== 'ready'`.

- [ ] **Step 5: Route the confirm variant**

Extend the variant map (added in #1064) with the third entry:

```tsx
  unknown: {
    title: 'settings.encryption.backupReplaceUnknownTitle',
    message: 'settings.encryption.backupReplaceUnknownMessage',
    action: 'settings.encryption.backupReplaceUnknownAction',
  },
```

Replace `handleBackupRequest` (~line 659):

```tsx
  const handleBackupRequest = useCallback(() => {
    if (backupProbe === 'absent') {
      // Server confirmed there is nothing to lose.
      setShowBackupDialog(true)
      return
    }
    if (backupProbe === 'unknown') {
      // We could not rule out a backup. Say so rather than asserting whose
      // it is — `foreign` would claim it wasn't made on this device, which
      // we do not know.
      setBackupConfirmVariant('unknown')
      return
    }
    const isOwnBackup = isBackupInSync(backupProbe, backedUpFingerprint, fingerprint)
    setBackupConfirmVariant(isOwnBackup ? 'own' : 'foreign')
  }, [backupProbe, backedUpFingerprint, fingerprint])
```

`checking` falls through to the last branch, which yields `foreign`. That is unreachable in practice — the button row only renders once the probe has settled — and erring toward a confirmation is the safe direction regardless.

- [ ] **Step 6: Route rotate**

In `handleRotateConfirm` (~line 766), change the condition so an inconclusive probe re-publishes rather than skipping:

```tsx
    // `unknown` re-publishes: over-publishing a backup that didn't exist is
    // harmless, leaving a real one stale is not.
    if (backupProbe === 'unknown' || isBackupInSync(backupProbe, backedUpFingerprint, fingerprint)) {
      setShowRotatePassphraseDialog(true)
    } else {
```

- [ ] **Step 7: Route the delete dialog and the restore button**

Delete dialog (~line 1257) — offer the checkbox whenever a backup is not ruled out:

```tsx
          backupExists={backupProbe === 'present' || backupProbe === 'unknown'}
```

Restore button (~line 1143) — same reasoning; restoring under `unknown` degrades to an error the dialog already handles:

```tsx
                      {(backupProbe === 'present' || backupProbe === 'unknown') && (
```

Rotate confirm message (~line 1297) — leave as `isBackupInSync(...)`; the union change is enough.

- [ ] **Step 8: Add the status line and retry**

In the status-line IIFE (~line 1108), replace `const checking = remoteBackupExists === null` with `const checking = backupProbe === 'checking'`, update `inSync` to pass `backupProbe`, and change the two definitive lines to compare `backupProbe === 'absent'` and `backupProbe === 'present'`. Then add the fourth line after the mismatch line:

```tsx
                    {!checking && !inSync && backupProbe === 'unknown' && (
                      <span className="text-fluux-yellow">
                        {t('settings.encryption.backupStatusUnknown')}
                      </span>
                    )}
```

Add the retry button as the first child of the existing button row, rendered only under `unknown`:

```tsx
                      {backupProbe === 'unknown' && (
                        <button
                          onClick={() => setBackupProbeNonce((n) => n + 1)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                        >
                          <RefreshCw className="size-3.5" />
                          {t('settings.encryption.backupStatusRetry')}
                        </button>
                      )}
```

`RefreshCw` is already imported for the rotate button. Without this retry, `unknown` is a dead end the user cannot clear without restarting the app.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/settings-components/EncryptionSettings.test.tsx
```

Expected: all pass — the 17 pre-existing plus the 7 new. Pre-existing tests that stub `hasSecretKeyBackup` must be updated to stub `probeSecretKeyBackup` returning `'present'` / `'absent'`; that is a fixture migration, not a behaviour change.

- [ ] **Step 10: Deliberate-break check**

Break 1 — in the probe effect, replace `setBackupProbe(result)` with `setBackupProbe(result === 'present' ? 'present' : 'absent')` (re-collapsing unknown). Run the block: `shows the inconclusive status line`, `offers a retry`, `confirms with the unknown variant`, and `publishes once the unknown confirmation is accepted` must FAIL. Revert, re-run, PASS.

Break 2 — in `handleBackupRequest`, delete the `backupProbe === 'unknown'` branch. `confirms with the unknown variant` and `publishes once the unknown confirmation is accepted` must FAIL. Revert, re-run, PASS.

Break 3 — in the delete dialog, change `backupExists` back to `backupProbe === 'present'`. `offers the delete-the-server-backup option` must FAIL. Revert, re-run, PASS.

Break 4 — in `handleRotateConfirm`, drop the `backupProbe === 'unknown' ||` clause. `re-publishes the backup on rotate under an inconclusive probe` must FAIL. Revert, re-run, PASS.

If any test stays green under its break, it is hollow. Fix it and redo the check.

- [ ] **Step 11: Verify and commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && npm test && npm run typecheck && npm run lint
```

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af
git add apps/fluux/src/components/settings-components/EncryptionSettings.tsx apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx
git commit -m "fix(e2ee): stop treating a failed backup probe as no backup in settings

The probe state was boolean|null and a failed probe was coerced to false,
so a transient network failure skipped the replace confirmation and could
overwrite a real server backup. It is now one exhaustive union, and an
inconclusive probe shows its own status line with a retry, confirms before
publishing, re-publishes on rotate, and keeps offering to delete the
server copy."
```

---

## Task 4: Unlock dialog, and retire the boolean API

The last consumer. Once it migrates, `hasSecretKeyBackup` has no callers.

**Files:**
- Modify: `apps/fluux/src/components/UnlockEncryptionDialog.tsx`
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (delete `hasSecretKeyBackup`)
- Modify: `apps/fluux/src/demo/DemoOpenPGPPlugin.ts`
- Test: `apps/fluux/src/components/UnlockEncryptionDialog.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `probeSecretKeyBackup()` from Task 1
- Produces: nothing

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/UnlockEncryptionDialog.test.tsx`.

Verified facts — do not re-derive:
- The component takes `client` as a **prop**: `UnlockEncryptionDialog({ client, onClose })`. It does **not** read `useXMPPContext`, so no `@fluux/sdk` mock is needed; pass a stub client whose `e2ee.getPlugin('openpgp')` returns your fake.
- Restore mode renders `settings.encryption.unlockDialogRestoreTitle`; setup mode renders `settings.encryption.unlockDialogSetupTitle`.

Mock `react-i18next` so `t` returns the key **and** `i18n` exposes `{ language: 'en' }`. Omitting `i18n` makes any dialog reading `i18n.language` throw on render, which silently defuses every assertion downstream of it — that is exactly the hollow test found in #1064.

```tsx
  // A failed probe used to select `setup` — inviting a user whose local key
  // is gone to generate a NEW key while a backup may sit on the server. A
  // wrong `restore` guess only degrades to NoRecoveryAvailableError, which
  // this dialog already handles; a wrong `setup` guess risks forking the
  // identity. The asymmetry is why `unknown` must mean restore.
  describe('inconclusive backup probe', () => {
    function clientWith(probe: 'present' | 'absent' | 'unknown') {
      return {
        e2ee: {
          getPlugin: (name: string) =>
            name === 'openpgp'
              ? { hasNoLocalKey: async () => true, probeSecretKeyBackup: async () => probe }
              : null,
        },
      } as unknown as Parameters<typeof UnlockEncryptionDialog>[0]['client']
    }

    it('offers restore, not setup, when the probe is inconclusive', async () => {
      render(<UnlockEncryptionDialog client={clientWith('unknown')} onClose={() => {}} />)

      expect(
        await screen.findByText('settings.encryption.unlockDialogRestoreTitle'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.unlockDialogSetupTitle'),
      ).not.toBeInTheDocument()
    })

    it('offers setup when the server confirms there is no backup', async () => {
      // Control test: proves the fixture can reach setup mode, so the
      // assertions above discriminate between two live outcomes rather than
      // asserting a constant.
      render(<UnlockEncryptionDialog client={clientWith('absent')} onClose={() => {}} />)

      expect(
        await screen.findByText('settings.encryption.unlockDialogSetupTitle'),
      ).toBeInTheDocument()
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/UnlockEncryptionDialog.test.tsx
```

Expected: `offers restore, not setup` FAILS — the component calls `hasSecretKeyBackup`, which the fixture no longer provides, so `hasBackup` is `false` and it renders setup.

- [ ] **Step 3: Migrate the dialog**

In `UnlockEncryptionDialog.tsx`, change the plugin cast (~line 58) and the mode selection (~line 73):

```tsx
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | {
          hasNoLocalKey?: () => Promise<boolean>
          probeSecretKeyBackup?: () => Promise<'present' | 'absent' | 'unknown'>
        }
      | null
      | undefined
```

```tsx
        // Only a server-confirmed `absent` justifies offering to create a new
        // key. `unknown` means we could not rule out a backup, and guessing
        // wrong toward setup risks forking the identity; guessing wrong toward
        // restore only produces an error this dialog already handles.
        const probe = plugin.probeSecretKeyBackup
          ? await plugin.probeSecretKeyBackup()
          : 'absent'
        if (!cancelled) setMode(probe === 'absent' ? 'setup' : 'restore')
```

- [ ] **Step 4: Delete the deprecated method and migrate the demo**

In `OpenPGPPluginBase.ts`, delete `hasSecretKeyBackup` and its `@deprecated` doc comment.

In `apps/fluux/src/demo/DemoOpenPGPPlugin.ts` (~line 170), replace:

```ts
  async probeSecretKeyBackup(): Promise<'present' | 'absent' | 'unknown'> {
    await delay(200)
    // Demo mode has no failing transport, so the probe is always definitive.
    return this.state.hasBackup ? 'present' : 'absent'
  }
```

Run `npm run typecheck` — it must report zero remaining references to `hasSecretKeyBackup`. Confirm with:

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && grep -rn "hasSecretKeyBackup" apps/fluux/src packages/fluux-sdk/src
```

Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/UnlockEncryptionDialog.test.tsx
```

Expected: both pass.

- [ ] **Step 6: Deliberate-break check**

Break: change the mode selection to `setMode(probe === 'present' ? 'restore' : 'setup')` (collapsing unknown back to setup).

Expected: `offers restore, not setup, when the probe is inconclusive` FAILS, and `offers setup when the server confirms there is no backup` still PASSES — proving the test discriminates the two outcomes rather than asserting a constant. Revert and re-run: both PASS.

- [ ] **Step 7: Verify and commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && npm test && npm run typecheck && npm run lint
```

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af
git add apps/fluux/src/components/UnlockEncryptionDialog.tsx apps/fluux/src/components/UnlockEncryptionDialog.test.tsx apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/demo/DemoOpenPGPPlugin.ts
git commit -m "fix(e2ee): offer restore, not setup, when the backup probe is inconclusive

A user whose local key is gone was invited to create a new key whenever the
server probe failed, even though a backup might exist. Only a
server-confirmed absence now selects setup mode.

With the last consumer migrated, hasSecretKeyBackup is removed: it
collapsed unknown to false, which is the ambiguity this series removes."
```

---

## Manual verification

Needs a server that can be made unreachable mid-session (block the connection, or point the account at a dead host after it has connected).

- [ ] With a real backup on the server, break connectivity, open Settings → Encryption. Status line reads "couldn't check", not "not backed up".
- [ ] Click Back up. The unknown confirmation appears rather than publishing straight away.
- [ ] Restore connectivity, click Check again. The line resolves to in-sync.
- [ ] On web with no local key and the server unreachable, the unlock dialog offers **restore**, not setup.
- [ ] Sanity: with a healthy server and no backup, the flow is unchanged — "not backed up", and Back up publishes with no confirmation.
