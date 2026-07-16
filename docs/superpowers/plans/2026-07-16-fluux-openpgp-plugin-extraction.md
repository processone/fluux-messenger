# `@fluux/openpgp-plugin` Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the app-inline OpenPGP E2EE plugin (`OpenPGPPluginBase`, `SequoiaPgpPlugin`, `WebOpenPGPPlugin` + helpers) into a standalone `@fluux/openpgp-plugin` package, mirroring `@fluux/omemo-plugin`, with zero user-visible behavior change.

**Architecture:** Behavior-preserving structural refactor. The base's eight `@/stores/*` couplings are broken via an injected `OpenPGPHostStores` adapter (package-defined interface, app-implemented at registration wiring to the real Zustand stores). Tauri file dialogs become an injected `OpenPGPFileIO`. Store data stays app-side; every UI subscription and localStorage key is untouched. The existing OpenPGP + OMEMO test suites are the correctness gate.

**Tech Stack:** TypeScript, tsup (dual cjs/esm), vitest (happy-dom), Zustand (app stores, untouched), openpgp.js (web, dynamic import), Tauri IPC (desktop, injected).

## Global Constraints

- Behavior-preserving: ZERO user-visible change. No trait methods added (`listPeerIdentities?`/`setIdentityTrust?` are the NEXT slice), no store DATA moved behind the plugin, no crypto/backup/recovery behavior change. The existing OpenPGP + OMEMO test suites stay GREEN as the correctness gate.
- Package `@fluux/openpgp-plugin` mirrors `packages/omemo-plugin/` scaffold (tsup, vitest, dual cjs/esm dist, `"files":["dist"]`, `exports` map). Runtime deps: `@fluux/sdk: "*"` + `openpgp` (the exact version the app currently resolves: `^6.3.0`). NO `@tauri-apps/*` in the package (Tauri file I/O is injected). Likely NO `@xmpp` shim (base imports only `@fluux/sdk`/`@fluux/sdk/core`) — but if extraction surfaces an `@xmpp/client` type need, add the same `src/xmpp.d.ts` shim `packages/omemo-plugin/src/xmpp.d.ts` uses.
- The 6 shared plugin/UI stores STAY app-side; the base reaches them ONLY through an injected `OpenPGPHostStores` adapter (package-defined interface, app-implemented at registration). Tauri file dialogs become an injected `OpenPGPFileIO`.
- Every commit `git commit --no-gpg-sign` (sandbox ssh-agent broken). Never push.
- Test/build commands: package `cd packages/openpgp-plugin && npx vitest run`; build `npm run build -w @fluux/openpgp-plugin`; app `cd apps/fluux && npx vitest run <file>`; root `npm run typecheck`. After a package source change consumed by the app, `npm run build -w @fluux/openpgp-plugin` before app typecheck (dist is what the app typechecks against; gitignored).
- **Intermediate red state is expected.** Tasks 2–8 relocate files with `git mv`; the app's `@/e2ee/...` imports of those files are NOT rewired until Tasks 9–10. Between the first move (Task 2) and Task 10, root `npm run typecheck` and the app suite are intentionally RED. Each move task's gate is the **package** build/test only. The authoritative full-app gates are Task 10 (app suite) and Task 11 (full typecheck + all suites).

---

## File Structure

New package `packages/openpgp-plugin/`:
- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js` — scaffold mirroring `packages/omemo-plugin/`.
- `src/index.ts` — public surface (grows per task).
- `src/hostStores.ts` — `OpenPGPHostStores`, `OpenPGPFileIO` interfaces + shared contract types.
- `src/OpenPGPPluginBase.ts`, `src/SequoiaPgpPlugin.ts`, `src/WebOpenPGPPlugin.ts` — moved plugins.
- `src/` leaf helpers moved from `apps/fluux/src/e2ee/`: `fingerprintCompare.ts`, `openpgpUserId.ts`, `keyExportNaming.ts`, `armorDetect.ts`, `backupMarker.ts`, `backupKeyMaterial.ts`, `passphraseFormatHeader.ts`, `passphraseGenerator.ts` (+ `passphraseWordlists/`), `secretKeyProbe.ts`, `verificationSync.ts`, `trustStateIntegrity.ts`, `recoveryErrors.ts`, `keyUnavailable.ts`, `webPassphraseStore.ts`, `webPassphraseCache.ts`, and their colocated tests + `fixtures/`.
- `src/testing/mockHostStores.ts` — in-memory `OpenPGPHostStores` for package tests.

App files that STAY and get rewired to `@fluux/openpgp-plugin` (Tasks 9–10): `e2ee/registerPlugins.ts`, `e2ee/silentRestore.ts`, `stores/verifiedPeerKeysStore.ts`, `components/conversation/messageTrust.ts`, `hooks/useConversationEncryptionState.ts`, `hooks/useWebKeyLocked.ts`, `App.tsx`, `demo.tsx`, `main.tsx`, `demo/DemoOpenPGPPlugin.ts`, `components/KeyPickerDialog.tsx`, `components/UnlockEncryptionDialog.tsx` (+ `.test.tsx` mock path), `components/settings-components/EncryptionSettings.tsx`, `components/BackupPassphraseDialog.tsx`, `components/SaveToPasswordManagerButton.tsx`, `components/RestorePassphraseDialog.tsx`, `utils/performLogout.ts`, `utils/clearLocalData.ts`.

App files that STAY unchanged: the 6 stores (except `verifiedPeerKeysStore.ts`'s one import line), `trustVisual.ts`, `encryptionSendError.ts`, `IndexedDBStorageBackend.ts`, `TauriKeychainStorageBackend.ts`.

---

## Task 1: Scaffold the `@fluux/openpgp-plugin` package

**Files:**
- Create: `packages/openpgp-plugin/package.json`
- Create: `packages/openpgp-plugin/tsconfig.json`
- Create: `packages/openpgp-plugin/tsconfig.build.json`
- Create: `packages/openpgp-plugin/tsup.config.ts`
- Create: `packages/openpgp-plugin/vitest.config.ts`
- Create: `packages/openpgp-plugin/eslint.config.js`
- Create: `packages/openpgp-plugin/src/index.ts`
- Modify: `apps/fluux/package.json` (add dependency)

**Interfaces:**
- Consumes: nothing.
- Produces: an installable, buildable empty workspace package `@fluux/openpgp-plugin` and an app dependency edge on it.

- [ ] **Step 1: Create `packages/openpgp-plugin/package.json`**

The root `package.json` `workspaces` is `["packages/*", "apps/*"]`, so this directory is auto-discovered. `openpgp` is `^6.3.0` (matches `apps/fluux/package.json`). Vitest needs `happy-dom` + `fake-indexeddb` (used by `webPassphraseCache.test.ts`, moved in Task 2).

```json
{
  "name": "@fluux/openpgp-plugin",
  "version": "0.0.0",
  "description": "OpenPGP (XEP-0373) E2EEPlugin adapter for the Fluux SDK.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "lint:fix": "eslint src --fix",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@fluux/sdk": "*",
    "openpgp": "^6.3.0"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.0",
    "eslint": "^10.0.0",
    "fake-indexeddb": "^6.2.5",
    "happy-dom": "^20.0.11",
    "tsup": "^8.0.0",
    "typescript": "^5.3.3",
    "typescript-eslint": "^8.53.0",
    "vitest": "^4.1.0"
  }
}
```

Note: these devDep versions mirror `packages/fluux-sdk/package.json` (the sibling package that also runs DOM + `fake-indexeddb` tests under `happy-dom ^20.0.11` / `vitest ^4.1.0`), NOT `packages/omemo-plugin` (which is node-env and uses older `vitest ^2.1.8`). Using vitest 4 matches the app's test authorship, so the moved app-origin suites run unchanged. The runtime `dependencies` (`@fluux/sdk`, `openpgp`) still follow the omemo-plugin/app pattern.

- [ ] **Step 2: Create `packages/openpgp-plugin/tsconfig.json`**

Identical to `packages/omemo-plugin/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["vitest/globals", "node"],
    "strict": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/openpgp-plugin/tsconfig.build.json`**

Mirror omemo-plugin (exclude tests + fixtures + manual tests from the build):

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/**/*.manual.test.ts", "src/fixtures/**"]
}
```

- [ ] **Step 4: Create `packages/openpgp-plugin/tsup.config.ts`**

Identical to `packages/omemo-plugin/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
})
```

- [ ] **Step 5: Create `packages/openpgp-plugin/vitest.config.ts`**

Unlike omemo-plugin (node env), this package's tests need DOM globals (`localStorage`, `document`, `IndexedDB`), so use `happy-dom` (matching `apps/fluux`). Exclude `*.manual.test.ts` (mirrors the app's exclusion of `generateWebVectors.manual.test.ts`).

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.manual.test.ts'],
  },
})
```

- [ ] **Step 6: Create `packages/openpgp-plugin/eslint.config.js`**

Identical to `packages/omemo-plugin/eslint.config.js` (drop the `src/interop/**` ignore — this package has no interop dir):

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  { ignores: ['dist/**'] },
)
```

- [ ] **Step 7: Create an empty `packages/openpgp-plugin/src/index.ts`**

```ts
// Public surface of `@fluux/openpgp-plugin`. Populated per task.
export {}
```

- [ ] **Step 8: Add the app dependency edge**

In `apps/fluux/package.json`, add `"@fluux/openpgp-plugin": "*"` to `dependencies`, alphabetically next to the existing `"@fluux/omemo-plugin": "*"` / `"@fluux/sdk": "*"` lines (currently lines 26–27). Edit the `dependencies` block so it reads:

```json
    "@fluux/omemo-plugin": "*",
    "@fluux/openpgp-plugin": "*",
    "@fluux/sdk": "*",
```

- [ ] **Step 9: Install to link the workspace symlink**

Run: `npm install`
Expected: completes without error; `ls -la node_modules/@fluux/openpgp-plugin` shows a symlink into `packages/openpgp-plugin`.

- [ ] **Step 10: Verify the empty package builds**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: tsup emits `packages/openpgp-plugin/dist/index.js`, `index.cjs`, `index.d.ts` with no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/openpgp-plugin apps/fluux/package.json package-lock.json
git commit --no-gpg-sign -m "feat(e2ee): scaffold @fluux/openpgp-plugin package"
```

---

## Task 2: Move the store-free leaf helpers + their tests

**Files (git mv each `.ts` and its `.test.ts` where present):**
- Move: `apps/fluux/src/e2ee/fingerprintCompare.ts` (+ `.test.ts`) → `packages/openpgp-plugin/src/`
- Move: `apps/fluux/src/e2ee/openpgpUserId.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/keyExportNaming.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/armorDetect.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/passphraseFormatHeader.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/passphraseGenerator.ts` (+ `.test.ts`) AND the directory `apps/fluux/src/e2ee/passphraseWordlists/`
- Move: `apps/fluux/src/e2ee/backupKeyMaterial.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/backupMarker.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/recoveryErrors.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/keyUnavailable.ts` (+ `.test.ts`)
- Move: `apps/fluux/src/e2ee/webPassphraseStore.ts` (NO colocated test)
- Move: `apps/fluux/src/e2ee/webPassphraseCache.ts` (+ `.test.ts`)
- Modify: `packages/openpgp-plugin/src/index.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces (package public exports added this task):
  - `fingerprintsEqual(a: string, b: string): boolean`
  - `toXep0373Fingerprint(fingerprint: string): string`
  - `pubkeyMetadataFingerprintAttrs(fingerprint: string): Record<string, string>`
  - `parseArmorPassphraseFormat(...)` (from `passphraseFormatHeader`)
  - `generateBackupPassphrase(...)`, `generateBackupCode(...)`, `USE_V6_KEYS` (from `passphraseGenerator`)
  - `KeyPickerRequiredError`, `NoRecoveryAvailableError` (from `recoveryErrors`)
  - `isKeyLocked(): boolean`, `subscribeKeyLockState(listener: () => void): () => void`, `setSessionPassphrase(pp: string): void` (from `webPassphraseStore`)
  - `sweepExpiredPassphrases(): Promise<void>`, `clearCachedPassphrase(jid: string): Promise<void>`, `clearAllCachedPassphrases(): Promise<void>`, `cachePassphrase(...)`, `loadCachedPassphrase(jid: string): Promise<string | null>`, `getRememberPassphrasePreference(): boolean`, `setRememberPassphrasePreference(value: boolean): void` (from `webPassphraseCache`)

All 12 modules are store-free: verified imports are only `@fluux/sdk` / `@fluux/sdk/core` / sibling helpers (`fingerprintCompare` ← nothing app-side; `webPassphraseStore` ← nothing; `secretKeyProbe` is NOT in this task). `passphraseGenerator` dynamic-imports `./passphraseWordlists/bip39-*`, so the wordlists directory must move too. `webPassphraseCache.test.ts` imports `fake-indexeddb/auto` (already a package devDep from Task 1).

- [ ] **Step 1: git mv every module + colocated test into the package**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/whisper-border-smooth-c602be
for m in fingerprintCompare openpgpUserId keyExportNaming armorDetect passphraseFormatHeader passphraseGenerator backupKeyMaterial backupMarker recoveryErrors keyUnavailable webPassphraseCache; do
  git mv apps/fluux/src/e2ee/$m.ts packages/openpgp-plugin/src/$m.ts
  git mv apps/fluux/src/e2ee/$m.test.ts packages/openpgp-plugin/src/$m.test.ts
done
git mv apps/fluux/src/e2ee/webPassphraseStore.ts packages/openpgp-plugin/src/webPassphraseStore.ts
git mv apps/fluux/src/e2ee/passphraseWordlists packages/openpgp-plugin/src/passphraseWordlists
```

- [ ] **Step 2: Confirm no `@/` or app-relative imports remain in the moved modules**

All 12 modules import only `@fluux/sdk`, `@fluux/sdk/core`, or `./`-siblings that were also moved. Verify:

Run: `cd packages/openpgp-plugin && grep -rn "@/" src/ ; grep -rn "from '\.\./" src/`
Expected: no output (empty). If any line prints, that import points at a not-yet-moved app module — STOP and reconcile (it means the recon missed a coupling).

- [ ] **Step 3: Populate `packages/openpgp-plugin/src/index.ts`**

```ts
// Public surface of `@fluux/openpgp-plugin`. Populated per task.

// Fingerprint utilities (single source of truth, imported by the app UI).
export { fingerprintsEqual, toXep0373Fingerprint, pubkeyMetadataFingerprintAttrs } from './fingerprintCompare'

// Backup passphrase format + generation.
export { parseArmorPassphraseFormat } from './passphraseFormatHeader'
export { generateBackupPassphrase, generateBackupCode, USE_V6_KEYS } from './passphraseGenerator'

// Web recovery signals.
export { KeyPickerRequiredError, NoRecoveryAvailableError } from './recoveryErrors'

// Web session-passphrase lock state + cache.
export { isKeyLocked, subscribeKeyLockState, setSessionPassphrase } from './webPassphraseStore'
export {
  sweepExpiredPassphrases,
  clearCachedPassphrase,
  clearAllCachedPassphrases,
  cachePassphrase,
  loadCachedPassphrase,
  getRememberPassphrasePreference,
  setRememberPassphrasePreference,
} from './webPassphraseCache'
```

- [ ] **Step 4: Run the package test suite**

Run: `cd packages/openpgp-plugin && npx vitest run`
Expected: PASS. The moved suites run green under happy-dom (`fingerprintCompare.test.ts`, `openpgpUserId.test.ts`, `keyExportNaming.test.ts`, `armorDetect.test.ts`, `passphraseFormatHeader.test.ts`, `passphraseGenerator.test.ts`, `backupKeyMaterial.test.ts`, `backupMarker.test.ts`, `recoveryErrors.test.ts`, `keyUnavailable.test.ts`, `webPassphraseCache.test.ts`). No test count decrease vs the originals.

- [ ] **Step 5: Build the package (verify the new exports type-check into dist)**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: dist rebuilt, no type errors. (Root/app typecheck is expected RED now — see Global Constraints; do NOT run it as this task's gate.)

- [ ] **Step 6: Commit**

```bash
git add packages/openpgp-plugin apps/fluux/src/e2ee
git commit --no-gpg-sign -m "refactor(e2ee): move store-free OpenPGP leaf helpers into @fluux/openpgp-plugin"
```

---

## Task 3: Define `OpenPGPHostStores` + `OpenPGPFileIO` + mock host

**Files:**
- Create: `packages/openpgp-plugin/src/hostStores.ts`
- Create: `packages/openpgp-plugin/src/testing/mockHostStores.ts`
- Create: `packages/openpgp-plugin/src/hostStores.test.ts`
- Modify: `packages/openpgp-plugin/src/index.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces (the load-bearing seam):
  - Contract types `CertRejectionCode`, `CertRejection`, `KeyChangeAlert`, `OwnKeyConflict`, `TrustStateStatus`.
  - `interface OpenPGPHostStores { verifiedPeers; certRejections; keyChangeAlerts; ownKeyConflict; pinnedPrimaryFingerprints; trustStateStatus }` (full member list below).
  - `interface OpenPGPFileIO { saveFile(defaultName, armored): Promise<boolean>; pickFile(): Promise<string | null> }`.
  - `createMockHostStores(): MockHostStores` test util (internal, from `testing/`).

### The crux — enumerated call-site → interface member coverage

Every call the base (`OpenPGPPluginBase.ts`) and its moved helper `trustStateIntegrity.ts` make into the 6 stores, mapped to the interface member that replaces it (call-site rewrites happen in Tasks 4–5; this task defines the contract):

**`verifiedPeers`** (from `verifiedPeerKeysStore`):
| Current call | Base line(s) | Interface member |
|---|---|---|
| `isPeerVerified(jid, fp)` | 1990, 2121 | `isVerified(jid: string, fingerprint: string): boolean` |
| `setPeerVerified(jid, fp)` | 1267, 1705 | `setVerified(jid: string, fingerprint: string): void` |
| `clearPeerVerified(jid)` | 1268, 1687 | `clearVerified(jid: string): void` |
| `useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid` | 1264 | `getAll(): Record<string, string>` |
| `useVerifiedPeerKeysStore.subscribe((s,p)=>… s.verifiedFingerprintByJid …)` | 591, 610 | `subscribe(listener: (verifiedMap: Record<string, string>) => void): () => void` |
| `usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid` / `useVerifiedPeerKeysStore.getState()...` / `useKeyChangeAlertsStore.getState()...` | `trustStateIntegrity.ts` 44–46, 61–63 | `verifiedPeers.getAll()` / `pinnedPrimaryFingerprints.getAll()` / `keyChangeAlerts.getAll()` |

**`certRejections`** (from `certRejectionStore`):
| Current call | Base line(s) | Interface member |
|---|---|---|
| `recordCertRejections(jid, rejections)` | 1543 | `record(jid: string, rejections: CertRejection[]): void` |
| `clearCertRejections(jid)` | 1525, 1533, 1545 | `clear(jid: string): void` |

**`keyChangeAlerts`** (from `keyChangeAlertsStore`):
| Current call | Base line(s) | Interface member |
|---|---|---|
| `recordKeyChangeAlert(jid, prev, curr)` | 1659, 1672 | `record(jid: string, previousFingerprint: string, currentFingerprint: string): void` |
| `clearKeyChangeAlert(jid)` | 1699 | `clear(jid: string): void` |
| `getKeyChangeAlert(jid)` | 1682, 1697, 1743 | `get(jid: string): KeyChangeAlert | null` |
| `useKeyChangeAlertsStore.getState().alertsByJid` | `trustStateIntegrity.ts` 46, 63 | `getAll(): Record<string, KeyChangeAlert>` |
| `useKeyChangeAlertsStore.subscribe((s,p)=>… s.alertsByJid …)` | 617 | `subscribe(listener: () => void): () => void` |

**`ownKeyConflict`** (from `ownKeyConflictStore`):
| Current call | Base line(s) | Interface member |
|---|---|---|
| `recordOwnKeyConflict({…})` | 1369, 1398 | `record(conflict: OwnKeyConflict): void` |
| `clearOwnKeyConflict()` | 906, 1220, 1237, 1240, 1339, 1344, 1350, 1387, 1392, 1407 | `clear(): void` |
| `getOwnKeyConflict()` | 756, 758, 1727, 1731 | `get(): OwnKeyConflict | null` |

**`pinnedPrimaryFingerprints`** (from `pinnedPrimaryFingerprintsStore`):
| Current call | Base line(s) | Interface member |
|---|---|---|
| `getPinnedPrimaryFp(jid)` | 1656 | `get(jid: string): string | null` |
| `setPinnedPrimaryFp(jid, fp)` | 1662, 1688, 1693 | `set(jid: string, fingerprint: string): void` |
| `usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid` | `trustStateIntegrity.ts` 44, 61 | `getAll(): Record<string, string>` |
| `usePinnedPrimaryFingerprintsStore.subscribe((s,p)=>… s.pinnedFingerprintByJid …)` | 603 | `subscribe(listener: () => void): () => void` |

**`trustStateStatus`** (from `trustStateStatusStore`):
| Current call | Base line(s) | Interface member |
|---|---|---|
| `setTrustStateStatus(status, details?)` | 648, 671 (+ `trustStateIntegrity.ts` 180) | `set(status: TrustStateStatus, details?: string[]): void` |
| `getTrustStateStatus()` | `trustStateIntegrity.ts` 169 | `get(): TrustStateStatus` |

Completeness gate: after Tasks 4–5 swap these calls to `this.hostStores.<group>.<member>(...)`, `tsc` on the package is clean (the base has zero remaining `@/` import).

Note on contract types: the app stores (`certRejectionStore.CertRejection`, `keyChangeAlertsStore.KeyChangeAlert`, `ownKeyConflictStore.OwnKeyConflict`, `trustStateStatusStore.TrustStateStatus`) are STRUCTURALLY IDENTICAL to the package copies defined here, so the app adapter (Task 9) can delegate directly (`record: recordCertRejections`, etc.) via TypeScript structural assignability — the app store files are NOT modified.

- [ ] **Step 1: Create `packages/openpgp-plugin/src/hostStores.ts`**

```ts
/**
 * Host-store seam for the OpenPGP plugin.
 *
 * `OpenPGPPluginBase` reads and writes six pieces of app-owned trust state
 * (verified peers, cert rejections, key-change alerts, own-key conflict,
 * pinned primary fingerprints, trust-state integrity status). Rather than
 * importing the app's Zustand stores directly (which would pin the package
 * to `apps/fluux/src`), the base reaches them through an injected
 * `OpenPGPHostStores` adapter. The app implements it at plugin registration,
 * delegating to the real stores; the store DATA stays app-side, so every UI
 * subscription and localStorage key is untouched.
 */

// ---- Contract types (structurally identical to the app store definitions) ----

export type CertRejectionCode =
  | 'validation_failed'
  | 'fingerprint_mismatch'
  | 'uid_mismatch'

export interface CertRejection {
  fingerprint: string
  code: CertRejectionCode
  detail: string
  observedAt: string
}

export interface KeyChangeAlert {
  previousFingerprint: string
  currentFingerprint: string
  observedAt: string
}

export interface OwnKeyConflict {
  kind: 'primary-mismatch' | 'subkey-mismatch'
  localFingerprint: string
  publishedFingerprint: string
  publishedDate: string
}

export type TrustStateStatus =
  | 'uninitialized'
  | 'sealed'
  | 'pending-seal'
  | 'awaiting-key'
  | 'compromised'

// ---- The adapter interface ----

export interface OpenPGPHostStores {
  verifiedPeers: {
    /** True when the user has confirmed `fingerprint` for `jid` out-of-band. */
    isVerified(jid: string, fingerprint: string): boolean
    setVerified(jid: string, fingerprint: string): void
    clearVerified(jid: string): void
    /** The whole bare-JID → verified-fingerprint map (read for sync/seal). */
    getAll(): Record<string, string>
    /** Fires (with the new map) whenever the verified map changes. */
    subscribe(listener: (verifiedMap: Record<string, string>) => void): () => void
  }
  certRejections: {
    record(jid: string, rejections: CertRejection[]): void
    clear(jid: string): void
  }
  keyChangeAlerts: {
    record(jid: string, previousFingerprint: string, currentFingerprint: string): void
    clear(jid: string): void
    get(jid: string): KeyChangeAlert | null
    getAll(): Record<string, KeyChangeAlert>
    /** Fires whenever the alerts map changes (used to reseal trust state). */
    subscribe(listener: () => void): () => void
  }
  ownKeyConflict: {
    record(conflict: OwnKeyConflict): void
    clear(): void
    get(): OwnKeyConflict | null
  }
  pinnedPrimaryFingerprints: {
    get(jid: string): string | null
    set(jid: string, fingerprint: string): void
    getAll(): Record<string, string>
    /** Fires whenever the pin map changes (used to reseal trust state). */
    subscribe(listener: () => void): () => void
  }
  trustStateStatus: {
    set(status: TrustStateStatus, details?: string[]): void
    get(): TrustStateStatus
  }
}

// ---- Injected Tauri file I/O (desktop only) ----

export interface OpenPGPFileIO {
  /**
   * Present a save dialog defaulting to `defaultName`, and if the user picks a
   * path, write `armored` to it. Resolves `true` when written, `false` when the
   * user cancelled. (Matches the current `SequoiaPgpPlugin.exportKeyToFile` tail.)
   */
  saveFile(defaultName: string, armored: string): Promise<boolean>
  /**
   * Present an open dialog and return the CONTENTS of the chosen file, or
   * `null` if the user cancelled. (Matches the current
   * `SequoiaPgpPlugin.pickKeyFile`, which returns file text, not a path.)
   */
  pickFile(): Promise<string | null>
}
```

- [ ] **Step 2: Create `packages/openpgp-plugin/src/testing/mockHostStores.ts`**

An in-memory implementation whose observable semantics (skip-if-equal on set, subscribe fan-out) mirror the real Zustand stores, so the moved plugin/base tests behave identically. `_reset()` clears all state and listeners for `beforeEach`.

```ts
// In-memory `OpenPGPHostStores` for package tests. Mirrors the app stores'
// idempotency (skip-if-equal on set) and subscribe fan-out so plugin tests
// observe the same scheduling behaviour they did against the real stores.
// Test utility only — never re-exported from the package index.
import type {
  OpenPGPHostStores,
  CertRejection,
  KeyChangeAlert,
  OwnKeyConflict,
  TrustStateStatus,
} from '../hostStores'

export interface MockHostStores extends OpenPGPHostStores {
  /** Reset all in-memory state + listeners (call in `beforeEach`). */
  _reset(): void
}

function fpEqual(a: string, b: string): boolean {
  return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()
}

export function createMockHostStores(): MockHostStores {
  let verified: Record<string, string> = {}
  let pinned: Record<string, string> = {}
  let alerts: Record<string, KeyChangeAlert> = {}
  let rejections: Record<string, CertRejection[]> = {}
  let conflict: OwnKeyConflict | null = null
  let status: TrustStateStatus = 'uninitialized'

  const verifiedListeners = new Set<(m: Record<string, string>) => void>()
  const pinnedListeners = new Set<() => void>()
  const alertListeners = new Set<() => void>()

  return {
    verifiedPeers: {
      isVerified: (jid, fp) => {
        const s = verified[jid]
        return s !== undefined && fpEqual(s, fp)
      },
      setVerified: (jid, fp) => {
        if (verified[jid] === fp) return
        verified = { ...verified, [jid]: fp }
        verifiedListeners.forEach((l) => l(verified))
      },
      clearVerified: (jid) => {
        if (!(jid in verified)) return
        verified = { ...verified }
        delete verified[jid]
        verifiedListeners.forEach((l) => l(verified))
      },
      getAll: () => verified,
      subscribe: (l) => {
        verifiedListeners.add(l)
        return () => verifiedListeners.delete(l)
      },
    },
    certRejections: {
      record: (jid, r) => {
        rejections = { ...rejections, [jid]: r }
      },
      clear: (jid) => {
        if (!(jid in rejections)) return
        rejections = { ...rejections }
        delete rejections[jid]
      },
    },
    keyChangeAlerts: {
      record: (jid, prev, curr) => {
        const existing = alerts[jid]
        if (existing && existing.previousFingerprint === prev && existing.currentFingerprint === curr) return
        alerts = {
          ...alerts,
          [jid]: { previousFingerprint: prev, currentFingerprint: curr, observedAt: new Date().toISOString() },
        }
        alertListeners.forEach((l) => l())
      },
      clear: (jid) => {
        if (!(jid in alerts)) return
        alerts = { ...alerts }
        delete alerts[jid]
        alertListeners.forEach((l) => l())
      },
      get: (jid) => alerts[jid] ?? null,
      getAll: () => alerts,
      subscribe: (l) => {
        alertListeners.add(l)
        return () => alertListeners.delete(l)
      },
    },
    ownKeyConflict: {
      record: (c) => {
        conflict = c
      },
      clear: () => {
        conflict = null
      },
      get: () => conflict,
    },
    pinnedPrimaryFingerprints: {
      get: (jid) => pinned[jid] ?? null,
      set: (jid, fp) => {
        if (pinned[jid] === fp) return
        pinned = { ...pinned, [jid]: fp }
        pinnedListeners.forEach((l) => l())
      },
      getAll: () => pinned,
      subscribe: (l) => {
        pinnedListeners.add(l)
        return () => pinnedListeners.delete(l)
      },
    },
    trustStateStatus: {
      set: (s) => {
        status = s
      },
      get: () => status,
    },
    _reset: () => {
      verified = {}
      pinned = {}
      alerts = {}
      rejections = {}
      conflict = null
      status = 'uninitialized'
      verifiedListeners.clear()
      pinnedListeners.clear()
      alertListeners.clear()
    },
  }
}
```

- [ ] **Step 3: Write the failing interface-conformance test `packages/openpgp-plugin/src/hostStores.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { OpenPGPHostStores } from './hostStores'
import { createMockHostStores, type MockHostStores } from './testing/mockHostStores'

describe('OpenPGPHostStores mock conformance', () => {
  let host: MockHostStores

  beforeEach(() => {
    host = createMockHostStores()
    host._reset()
  })

  it('satisfies the OpenPGPHostStores interface', () => {
    // Compile-time assignability: if the mock drifts from the interface this
    // line fails to type-check (the package typecheck is the real gate).
    const asInterface: OpenPGPHostStores = host
    expect(asInterface).toBeDefined()
  })

  it('verifiedPeers round-trips and fires subscribers with the new map', () => {
    const seen: Array<Record<string, string>> = []
    host.verifiedPeers.subscribe((m) => seen.push(m))
    host.verifiedPeers.setVerified('a@x', 'FP1')
    expect(host.verifiedPeers.isVerified('a@x', 'fp1')).toBe(true) // normalized compare
    expect(host.verifiedPeers.getAll()).toEqual({ 'a@x': 'FP1' })
    host.verifiedPeers.setVerified('a@x', 'FP1') // idempotent → no extra fire
    expect(seen).toHaveLength(1)
    host.verifiedPeers.clearVerified('a@x')
    expect(host.verifiedPeers.getAll()).toEqual({})
    expect(seen).toHaveLength(2)
  })

  it('pinned + keyChangeAlerts + ownKeyConflict + trustStateStatus behave', () => {
    host.pinnedPrimaryFingerprints.set('b@x', 'PIN')
    expect(host.pinnedPrimaryFingerprints.get('b@x')).toBe('PIN')
    host.keyChangeAlerts.record('b@x', 'OLD', 'NEW')
    expect(host.keyChangeAlerts.get('b@x')).toMatchObject({ previousFingerprint: 'OLD', currentFingerprint: 'NEW' })
    host.ownKeyConflict.record({ kind: 'primary-mismatch', localFingerprint: 'L', publishedFingerprint: 'P', publishedDate: 'd' })
    expect(host.ownKeyConflict.get()?.kind).toBe('primary-mismatch')
    host.trustStateStatus.set('sealed')
    expect(host.trustStateStatus.get()).toBe('sealed')
  })
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/openpgp-plugin && npx vitest run src/hostStores.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export the interfaces + contract types from `index.ts`**

Append to `packages/openpgp-plugin/src/index.ts`:

```ts

// Host-store seam (interfaces + contract types; app implements the adapter).
export type {
  OpenPGPHostStores,
  OpenPGPFileIO,
  CertRejection,
  CertRejectionCode,
  KeyChangeAlert,
  OwnKeyConflict,
  TrustStateStatus,
} from './hostStores'
```

- [ ] **Step 6: Build the package**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: dist rebuilt, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/openpgp-plugin
git commit --no-gpg-sign -m "feat(e2ee): OpenPGPHostStores + OpenPGPFileIO seam + mock host"
```

---

## Task 4: Move `secretKeyProbe`, `verificationSync`, `trustStateIntegrity`

**Files:**
- Move: `apps/fluux/src/e2ee/secretKeyProbe.ts` (+ `.test.ts`) → `packages/openpgp-plugin/src/`
- Move: `apps/fluux/src/e2ee/verificationSync.ts` (+ `.test.ts`) → `packages/openpgp-plugin/src/`
- Move: `apps/fluux/src/e2ee/trustStateIntegrity.ts` (+ `.test.ts`) → `packages/openpgp-plugin/src/`
- Modify: `packages/openpgp-plugin/src/trustStateIntegrity.ts` (refactor to take `hostStores`)
- Modify: `packages/openpgp-plugin/src/trustStateIntegrity.test.ts` (inject mock host)
- Modify: `packages/openpgp-plugin/src/index.ts`

**Interfaces:**
- Consumes: `OpenPGPHostStores`, `TrustStateStatus` (Task 3); `createMockHostStores` (Task 3, tests).
- Produces:
  - `secretKeyProbe`: `probeRemoteIdentityState(...)`, `probeRemotePublishedFingerprints(...)`, `SecretKeyBackupProbeError`, `probeRemoteSecretKeyBackup(...)`, `RemoteIdentityState` (unchanged — no store coupling).
  - `verificationSync`: `VERIFICATIONS_NODE`, `fetchVerificationsFromServer`, `loadAppliedVerificationsVersion`, `planVerificationUpdate`, `publishVerificationsToServer`, `saveAppliedVerificationsVersion`, `EncryptFn`, `DecryptFn` (unchanged — no store coupling).
  - `trustStateIntegrity` (refactored signatures — every store read/write now flows through a passed `hostStores`):
    - `buildCanonicalSnapshot(hostStores: OpenPGPHostStores): TrustStateSnapshot`
    - `sealTrustState(encryptFn: EncryptFn, ownPublicArmored: string, hostStores: OpenPGPHostStores): Promise<void>`
    - `verifyTrustStateSeal(decryptFn: DecryptFn, ownPublicArmored: string, ownFingerprint: string, hostStores: OpenPGPHostStores, isKeyUnavailable?: (err: unknown) => boolean): Promise<{ status: TrustStateStatus; details?: string[] }>`
    - `isTofuBlockedByCompromise(peer: string, hostStores: OpenPGPHostStores): boolean`
    - `clearCompromisedAndReseal(encryptFn: EncryptFn, ownPublicArmored: string, hostStores: OpenPGPHostStores): Promise<void>`

`secretKeyProbe.ts` imports only `@fluux/sdk/core` (+ locally defined). `verificationSync.ts` imports only `@fluux/sdk` + `./fingerprintCompare` (moved Task 2). Both move without edits. Only `trustStateIntegrity.ts` reads 4 stores and needs the refactor.

- [ ] **Step 1: git mv the three modules + tests**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/whisper-border-smooth-c602be
for m in secretKeyProbe verificationSync trustStateIntegrity; do
  git mv apps/fluux/src/e2ee/$m.ts packages/openpgp-plugin/src/$m.ts
  git mv apps/fluux/src/e2ee/$m.test.ts packages/openpgp-plugin/src/$m.test.ts
done
```

- [ ] **Step 2: Refactor `trustStateIntegrity.ts` — replace the 4 store imports with `hostStores` params**

Replace the import block (current lines 16–23) — delete the `@/stores/*` imports and add the package types:

Old:
```ts
import { buildScopedStorageKey } from '@fluux/sdk'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { setTrustStateStatus, getTrustStateStatus } from '@/stores/trustStateStatusStore'
import type { TrustStateStatus } from '@/stores/trustStateStatusStore'
import { loadAppliedVerificationsVersion } from './verificationSync'
import type { EncryptFn, DecryptFn } from './verificationSync'
```

New:
```ts
import { buildScopedStorageKey } from '@fluux/sdk'
import type { OpenPGPHostStores, TrustStateStatus } from './hostStores'
import { loadAppliedVerificationsVersion } from './verificationSync'
import type { EncryptFn, DecryptFn } from './verificationSync'
```

- [ ] **Step 3: Thread `hostStores` through `buildCanonicalSnapshot` + `storesAreEmpty`**

Replace `buildCanonicalSnapshot` (current lines 43–49):

```ts
export function buildCanonicalSnapshot(hostStores: OpenPGPHostStores): TrustStateSnapshot {
  const pins = { ...hostStores.pinnedPrimaryFingerprints.getAll() }
  const verified = { ...hostStores.verifiedPeers.getAll() }
  const alerts = { ...hostStores.keyChangeAlerts.getAll() }
  const syncVersion = loadAppliedVerificationsVersion()
  return { v: 1, sealedAt: new Date().toISOString(), pins, verified, alerts, syncVersion }
}
```

Replace `storesAreEmpty` (current lines 60–69):

```ts
function storesAreEmpty(hostStores: OpenPGPHostStores): boolean {
  const pins = hostStores.pinnedPrimaryFingerprints.getAll()
  const verified = hostStores.verifiedPeers.getAll()
  const alerts = hostStores.keyChangeAlerts.getAll()
  return (
    Object.keys(pins).length === 0 &&
    Object.keys(verified).length === 0 &&
    Object.keys(alerts).length === 0
  )
}
```

- [ ] **Step 4: Thread `hostStores` through the exported functions**

Replace `sealTrustState` (current lines 95–108):

```ts
export async function sealTrustState(
  encryptFn: EncryptFn,
  ownPublicArmored: string,
  hostStores: OpenPGPHostStores,
): Promise<void> {
  const snapshot = buildCanonicalSnapshot(hostStores)
  const json = JSON.stringify(snapshot)
  const armored = await encryptFn(json, ownPublicArmored)
  try {
    localStorage.setItem(getSealKey(), armored)
    markInitialized()
  } catch {
    // best-effort — quota exceeded etc.
  }
}
```

Replace the `verifyTrustStateSeal` signature + its `storesAreEmpty()` / `buildCanonicalSnapshot()` calls. Change the signature (current lines 114–119) to insert `hostStores` before `isKeyUnavailable`:

```ts
export async function verifyTrustStateSeal(
  decryptFn: DecryptFn,
  ownPublicArmored: string,
  ownFingerprint: string,
  hostStores: OpenPGPHostStores,
  isKeyUnavailable: (err: unknown) => boolean = () => false,
): Promise<{ status: TrustStateStatus; details?: string[] }> {
```

Then inside that function body update the three internal calls: `storesAreEmpty()` → `storesAreEmpty(hostStores)` (three occurrences, current lines 123, 136, 145) and `const current = buildCanonicalSnapshot()` → `const current = buildCanonicalSnapshot(hostStores)` (current line 159).

Replace `isTofuBlockedByCompromise` (current lines 168–172):

```ts
export function isTofuBlockedByCompromise(peer: string, hostStores: OpenPGPHostStores): boolean {
  if (hostStores.trustStateStatus.get() !== 'compromised') return false
  if (!lastKnownPayload) return true
  return peer in lastKnownPayload.pins
}
```

Replace `clearCompromisedAndReseal` (current lines 174–181):

```ts
export async function clearCompromisedAndReseal(
  encryptFn: EncryptFn,
  ownPublicArmored: string,
  hostStores: OpenPGPHostStores,
): Promise<void> {
  await sealTrustState(encryptFn, ownPublicArmored, hostStores)
  lastKnownPayload = null
  hostStores.trustStateStatus.set('sealed')
}
```

- [ ] **Step 5: Confirm no `@/` imports remain in the three moved modules**

Run: `cd packages/openpgp-plugin && grep -rn "@/\|from '\.\./" src/secretKeyProbe.ts src/verificationSync.ts src/trustStateIntegrity.ts`
Expected: no output.

- [ ] **Step 6: Rewrite `trustStateIntegrity.test.ts` to inject a mock host instead of the real stores**

The test currently drives state via `useXStore.setState(...)` (imports at lines 4–6, usages at 17, 22–24). Replace those store imports + `beforeEach` setup with a `createMockHostStores()` instance, and pass `host` into every refactored function call. Apply this transformation across the file:

1. Replace the store imports:

Old:
```ts
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
```

New:
```ts
import { createMockHostStores, type MockHostStores } from './testing/mockHostStores'
```

2. Introduce a shared `host` in the describe scope and reset it per test. Where the test previously seeded pins via `usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: pins })`, seed the mock instead: `for (const [jid, fp] of Object.entries(pins)) host.pinnedPrimaryFingerprints.set(jid, fp)`. Where it cleared all three stores in `beforeEach` (lines 22–24), replace with `host = createMockHostStores(); host._reset()`.
3. Add `host` as the trailing (or documented-position) argument to every `sealTrustState`, `verifyTrustStateSeal`, `buildCanonicalSnapshot`, `isTofuBlockedByCompromise`, `clearCompromisedAndReseal` call, matching the new signatures in Step 4. For `verifyTrustStateSeal`, `host` goes BEFORE the optional `isKeyUnavailable` arg.
4. Any assertion that read store state via `useXStore.getState()` becomes `host.<group>.getAll()` / `host.<group>.get()`.

Read the full `packages/openpgp-plugin/src/trustStateIntegrity.test.ts` before editing and apply the above rules to each of its cases; the observable expectations do not change.

- [ ] **Step 7: Run the moved suites**

Run: `cd packages/openpgp-plugin && npx vitest run src/secretKeyProbe.test.ts src/verificationSync.test.ts src/trustStateIntegrity.test.ts`
Expected: PASS. Same test counts as the originals.

- [ ] **Step 8: Export the probe surface from `index.ts`**

Append to `packages/openpgp-plugin/src/index.ts`:

```ts

// PEP secret-key / identity probes.
export {
  probeRemoteIdentityState,
  probeRemotePublishedFingerprints,
  SecretKeyBackupProbeError,
} from './secretKeyProbe'
export type { RemoteIdentityState } from './secretKeyProbe'
```

(`verificationSync` and `trustStateIntegrity` stay INTERNAL — no app consumer imports them; confirmed by grep in recon.)

- [ ] **Step 9: Build the package**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: no type errors.

- [ ] **Step 10: Commit**

```bash
git add packages/openpgp-plugin apps/fluux/src/e2ee
git commit --no-gpg-sign -m "refactor(e2ee): move probe/sync/trust-integrity; route trust integrity through hostStores"
```

---

## Task 5: Move `OpenPGPPluginBase.ts` and route it through `hostStores`

**Files:**
- Move: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` → `packages/openpgp-plugin/src/OpenPGPPluginBase.ts`
- Move: `apps/fluux/src/e2ee/peerKeyCache.test.ts` → `packages/openpgp-plugin/src/peerKeyCache.test.ts`
- Modify: `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` (constructor + call-site rewrites)
- Modify: `packages/openpgp-plugin/src/index.ts`

**Interfaces:**
- Consumes: `OpenPGPHostStores`, `CertRejection` (Task 3); refactored `trustStateIntegrity` functions (Task 4); all leaf helpers (Task 2).
- Produces:
  - `abstract class OpenPGPPluginBase implements E2EEPlugin` with `constructor(opts: { hostStores: OpenPGPHostStores })` and `protected readonly hostStores: OpenPGPHostStores`.
  - `OPENPGP_DESCRIPTOR`, `classifyBoundaryError(err): { kind: E2EEErrorKind; code: string }`.
  - shared types `KeyBundle`, `RestoreResult`, `DecryptOutput`, `CertValidation`.

`peerKeyCache.test.ts` tests the base's localStorage peer-key cache purely via `localStorage` (no imports from the base), so it moves cleanly and runs under happy-dom.

- [ ] **Step 1: git mv the base + peerKeyCache test**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/whisper-border-smooth-c602be
git mv apps/fluux/src/e2ee/OpenPGPPluginBase.ts packages/openpgp-plugin/src/OpenPGPPluginBase.ts
git mv apps/fluux/src/e2ee/peerKeyCache.test.ts packages/openpgp-plugin/src/peerKeyCache.test.ts
```

- [ ] **Step 2: Replace the 8 `@/stores/*` import lines with a single `hostStores` type import**

In `packages/openpgp-plugin/src/OpenPGPPluginBase.ts`, delete these import blocks (current lines 79–84, 99–117, 124–126) and the store symbols they bring in. Specifically:

Delete (lines 79–84):
```ts
import {
  clearPeerVerified,
  isPeerVerified,
  setPeerVerified,
  useVerifiedPeerKeysStore,
} from '@/stores/verifiedPeerKeysStore'
```

Delete (lines 99–117):
```ts
import {
  clearKeyChangeAlert,
  getKeyChangeAlert,
  recordKeyChangeAlert,
} from '@/stores/keyChangeAlertsStore'
import {
  clearOwnKeyConflict,
  getOwnKeyConflict,
  recordOwnKeyConflict,
} from '@/stores/ownKeyConflictStore'
import {
  getPinnedPrimaryFp,
  setPinnedPrimaryFp,
} from '@/stores/pinnedPrimaryFingerprintsStore'
import {
  clearCertRejections,
  recordCertRejections,
  type CertRejection,
} from '@/stores/certRejectionStore'
```

Delete (lines 124–126):
```ts
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { setTrustStateStatus } from '@/stores/trustStateStatusStore'
```

Then add, next to the other local imports (e.g. immediately after the `import { ... } from './trustStateIntegrity'` block at lines 118–123):

```ts
import type { OpenPGPHostStores, CertRejection } from './hostStores'
```

Note: `CertRejection` moves from the app store import to the package `./hostStores` import — the base uses it as a value/type in `fetchAdvertisedKey` (`const rejections: CertRejection[] = []`, etc.). Keep the identifier `CertRejection` so those bodies are unchanged.

- [ ] **Step 3: Add the constructor + `hostStores` field**

In the class body, immediately after the `_keyRecoveryNeeded` field / `isKeyRecoveryNeeded()` method (current lines 401–409) and before the `// Abstract crypto methods` banner (current line 411), insert:

```ts

  /**
   * App-injected adapter over the six trust stores (verified peers, cert
   * rejections, key-change alerts, own-key conflict, pinned fingerprints,
   * trust-state status). The store DATA lives app-side; the base reaches it
   * only through this seam. Supplied by subclasses via `super({ hostStores })`.
   */
  protected readonly hostStores: OpenPGPHostStores

  constructor(opts: { hostStores: OpenPGPHostStores }) {
    this.hostStores = opts.hostStores
  }
```

- [ ] **Step 4: Rewrite the store subscriptions in `activateSubscriptions()` + the two seal subscriptions**

Replace the verification-publish subscription (current lines 591–600):

```ts
    this._verificationStoreUnsub = this.hostStores.verifiedPeers.subscribe((verifiedMap) => {
      if (this._syncingFromRemoteCount === 0) {
        this.scheduleVerificationsPublish(verifiedMap)
      }
    })
```

Replace the `this._trustStoreUnsubs = [...]` block (current lines 602–624):

```ts
    this._trustStoreUnsubs = [
      this.hostStores.pinnedPrimaryFingerprints.subscribe(() => {
        this.scheduleTrustStateSeal()
      }),
      this.hostStores.verifiedPeers.subscribe(() => {
        this.scheduleTrustStateSeal()
      }),
      this.hostStores.keyChangeAlerts.subscribe(() => {
        this.scheduleTrustStateSeal()
      }),
    ]
```

- [ ] **Step 5: Rewrite the `setTrustStateStatus` + `trustStateIntegrity` call sites**

- Line 648 `setTrustStateStatus('sealed')` → `this.hostStores.trustStateStatus.set('sealed')`
- Line 671 `setTrustStateStatus(status, details)` → `this.hostStores.trustStateStatus.set(status, details)`
- The `sealTrustState(...)` call (current lines 644–647): add `this.hostStores` as the third arg:
  ```ts
      await sealTrustState(
        (plaintext, recipientKey) => this.encryptToRecipient(jid, recipientKey, plaintext),
        ownPublicArmored,
        this.hostStores,
      )
  ```
- The `verifyTrustStateSeal(...)` call (current lines 659–664): insert `this.hostStores` before `isSecretKeyUnavailableError`:
  ```ts
      const { status, details } = await verifyTrustStateSeal(
        (ciphertext, senderPub) => this.decryptWithOwnKey(jid, ciphertext, senderPub),
        ownPublicArmored,
        ownFingerprint,
        this.hostStores,
        isSecretKeyUnavailableError,
      )
  ```
- The `clearCompromisedAndReseal(...)` call in `resealTrustState` (current lines 691–694): add `this.hostStores`:
  ```ts
      await clearCompromisedAndReseal(
        (plaintext, recipientKey) => this.encryptToRecipient(jid, recipientKey, plaintext),
        ownPublicArmored,
        this.hostStores,
      )
  ```

- [ ] **Step 6: Rewrite the remaining per-store call sites**

Apply these exact substitutions (each is a unique call; line numbers are the pre-edit anchors):

- `getVerifiedPeerFingerprint`/`isPeerVerified` etc:
  - 1990 `isPeerVerified(peer, cached.fingerprint)` → `this.hostStores.verifiedPeers.isVerified(peer, cached.fingerprint)`
  - 2121 `isPeerVerified(peer, cached.fingerprint)` → `this.hostStores.verifiedPeers.isVerified(peer, cached.fingerprint)`
  - 1267 `setPeerVerified(jid, fingerprint)` → `this.hostStores.verifiedPeers.setVerified(jid, fingerprint)`
  - 1705 `setPeerVerified(peer, targetFp)` → `this.hostStores.verifiedPeers.setVerified(peer, targetFp)`
  - 1268 `clearPeerVerified(jid)` → `this.hostStores.verifiedPeers.clearVerified(jid)`
  - 1687 `clearPeerVerified(peer)` → `this.hostStores.verifiedPeers.clearVerified(peer)`
  - 1264 `useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid` → `this.hostStores.verifiedPeers.getAll()`
- pinned:
  - 1656 `getPinnedPrimaryFp(peer)` → `this.hostStores.pinnedPrimaryFingerprints.get(peer)`
  - 1662 `setPinnedPrimaryFp(peer, bundle.fingerprint)` → `this.hostStores.pinnedPrimaryFingerprints.set(peer, bundle.fingerprint)`
  - 1688 `setPinnedPrimaryFp(peer, targetFp)` → `this.hostStores.pinnedPrimaryFingerprints.set(peer, targetFp)`
  - 1693 `setPinnedPrimaryFp(peer, previousFp)` → `this.hostStores.pinnedPrimaryFingerprints.set(peer, previousFp)`
- keyChangeAlerts:
  - 1659 `recordKeyChangeAlert(peer, 'unknown-cleared', bundle.fingerprint)` → `this.hostStores.keyChangeAlerts.record(peer, 'unknown-cleared', bundle.fingerprint)`
  - 1672 `recordKeyChangeAlert(peer, pinnedFp, bundle.fingerprint)` → `this.hostStores.keyChangeAlerts.record(peer, pinnedFp, bundle.fingerprint)`
  - 1699 `clearKeyChangeAlert(peer)` → `this.hostStores.keyChangeAlerts.clear(peer)`
  - 1682 `getKeyChangeAlert(peer)` → `this.hostStores.keyChangeAlerts.get(peer)`
  - 1697 `getKeyChangeAlert(peer)` → `this.hostStores.keyChangeAlerts.get(peer)`
  - 1743 `getKeyChangeAlert(peer)` → `this.hostStores.keyChangeAlerts.get(peer)`
- certRejections:
  - 1543 `recordCertRejections(peer, rejections)` → `this.hostStores.certRejections.record(peer, rejections)`
  - 1525, 1533, 1545 `clearCertRejections(peer)` → `this.hostStores.certRejections.clear(peer)`
- ownKeyConflict:
  - 1369, 1398 `recordOwnKeyConflict({ … })` → `this.hostStores.ownKeyConflict.record({ … })` (keep the object literal unchanged)
  - 756, 758, 1727, 1731 `getOwnKeyConflict()` → `this.hostStores.ownKeyConflict.get()`
  - 906, 1220, 1237, 1240, 1339, 1344, 1350, 1387, 1392, 1407 `clearOwnKeyConflict()` → `this.hostStores.ownKeyConflict.clear()`
- `isTofuBlockedByCompromise`:
  - 1658 `isTofuBlockedByCompromise(peer)` → `isTofuBlockedByCompromise(peer, this.hostStores)`

After editing, verify none of the old free-function identifiers survive:

Run: `cd packages/openpgp-plugin && grep -nE "\b(isPeerVerified|setPeerVerified|clearPeerVerified|useVerifiedPeerKeysStore|getPinnedPrimaryFp|setPinnedPrimaryFp|usePinnedPrimaryFingerprintsStore|recordKeyChangeAlert|clearKeyChangeAlert|getKeyChangeAlert|useKeyChangeAlertsStore|recordCertRejections|clearCertRejections|recordOwnKeyConflict|clearOwnKeyConflict|getOwnKeyConflict|setTrustStateStatus)\(" src/OpenPGPPluginBase.ts`
Expected: no output. Also confirm zero app imports remain:
Run: `grep -n "@/" src/OpenPGPPluginBase.ts`
Expected: no output.

- [ ] **Step 7: Package typecheck (the completeness gate)**

Run: `cd packages/openpgp-plugin && npx tsc --noEmit`
Expected: no errors. A clean typecheck proves `OpenPGPHostStores` covers every store call the base makes. If `tsc` reports a missing member, add it to the interface in `hostStores.ts` and the mock in `mockHostStores.ts`, then re-run.

- [ ] **Step 8: Run `peerKeyCache.test.ts` (base's cache behavior, store-free)**

Run: `cd packages/openpgp-plugin && npx vitest run src/peerKeyCache.test.ts`
Expected: PASS.

- [ ] **Step 9: Export the base surface from `index.ts`**

Append to `packages/openpgp-plugin/src/index.ts`:

```ts

// Shared XEP-0373 descriptor + error classifier + base value/output types.
export { OPENPGP_DESCRIPTOR, classifyBoundaryError } from './OpenPGPPluginBase'
export type { KeyBundle, RestoreResult, DecryptOutput, CertValidation } from './OpenPGPPluginBase'
```

- [ ] **Step 10: Build the package**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: no type errors.

- [ ] **Step 11: Commit**

```bash
git add packages/openpgp-plugin apps/fluux/src/e2ee
git commit --no-gpg-sign -m "refactor(e2ee): move OpenPGPPluginBase into package; route stores through hostStores"
```

---

## Task 6: Move `SequoiaPgpPlugin.ts` (inject `hostStores` + `fileIO`)

**Files:**
- Move: `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts` → `packages/openpgp-plugin/src/SequoiaPgpPlugin.ts`
- Move: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts` → `packages/openpgp-plugin/src/SequoiaPgpPlugin.test.ts`
- Modify: `packages/openpgp-plugin/src/SequoiaPgpPlugin.ts`
- Modify: `packages/openpgp-plugin/src/SequoiaPgpPlugin.test.ts`
- Modify: `packages/openpgp-plugin/src/index.ts`

**Interfaces:**
- Consumes: `OpenPGPPluginBase` (Task 5), `OpenPGPHostStores`, `OpenPGPFileIO` (Task 3), `keyExportFilename` (Task 2).
- Produces:
  - `class SequoiaPgpPlugin extends OpenPGPPluginBase`
  - `type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>`
  - `interface SequoiaPgpPluginOptions { invoke: InvokeFn; hostStores: OpenPGPHostStores; fileIO: OpenPGPFileIO }`
  - static `SequoiaPgpPlugin.classifyBoundaryError(err)`

- [ ] **Step 1: git mv the plugin + test**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/whisper-border-smooth-c602be
git mv apps/fluux/src/e2ee/SequoiaPgpPlugin.ts packages/openpgp-plugin/src/SequoiaPgpPlugin.ts
git mv apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts packages/openpgp-plugin/src/SequoiaPgpPlugin.test.ts
```

- [ ] **Step 2: Extend the options + constructor; add the hostStores/fileIO imports**

In `packages/openpgp-plugin/src/SequoiaPgpPlugin.ts`, add to the `./OpenPGPPluginBase` import (or a new import) the seam types. After the existing import block (current lines 17–26), add:

```ts
import type { OpenPGPHostStores, OpenPGPFileIO } from './hostStores'
```

Replace `SequoiaPgpPluginOptions` (current lines 34–37) and the constructor (current lines 39–45):

```ts
export interface SequoiaPgpPluginOptions {
  /** Tauri command dispatcher. Tests pass a mock; app code passes the real one. */
  invoke: InvokeFn
  /** App-injected adapter over the six trust stores. */
  hostStores: OpenPGPHostStores
  /** App-injected Tauri file dialogs (keeps @tauri-apps/* out of the package). */
  fileIO: OpenPGPFileIO
}

export class SequoiaPgpPlugin extends OpenPGPPluginBase {
  private readonly invoke: InvokeFn
  private readonly fileIO: OpenPGPFileIO

  constructor(options: SequoiaPgpPluginOptions) {
    super({ hostStores: options.hostStores })
    this.invoke = options.invoke
    this.fileIO = options.fileIO
  }
```

- [ ] **Step 3: Replace the two Tauri dynamic-import method bodies with `fileIO` calls**

Replace `exportKeyToFile` (current lines 185–209):

```ts
  async exportKeyToFile(passphrase: string): Promise<boolean> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        'SequoiaPgpPlugin: no identity to export — call ensureIdentity first',
      )
    }
    let armoredMessage: string
    try {
      armoredMessage = await this.buildExportArmor(passphrase)
    } catch (err) {
      throw this.toPluginError('exportKeyToFile', err)
    }
    return this.fileIO.saveFile(keyExportFilename(ctx.account.jid), armoredMessage)
  }
```

Replace `pickKeyFile` (current lines 211–222):

```ts
  async pickKeyFile(): Promise<string | null> {
    return this.fileIO.pickFile()
  }
```

- [ ] **Step 4: Confirm no `@tauri-apps` or `@/` imports remain**

Run: `cd packages/openpgp-plugin && grep -n "@tauri-apps\|@/" src/SequoiaPgpPlugin.ts`
Expected: no output.

- [ ] **Step 5: Migrate `SequoiaPgpPlugin.test.ts` to construct with a mock host + mock fileIO**

This is a large but MECHANICAL migration (33 `new SequoiaPgpPlugin({ … })` sites; store-touching blocks at the imports and a few cases). Apply these rules across the whole file; read it fully first, then transform:

1. **Imports.** Replace the app-store import(s) at the top (line 11 `import { getOwnKeyConflict } from '@/stores/ownKeyConflictStore'`, and the dynamic `await import('@/stores/…')` at lines 589–593 and 2740–2741) with the package mock. Add:
   ```ts
   import { createMockHostStores, type MockHostStores } from './testing/mockHostStores'
   ```
   Introduce a module/describe-scoped `let hostStores: MockHostStores` created (`hostStores = createMockHostStores()`) and `hostStores._reset()` in the outer `beforeEach`.
2. **Construction sites.** Every `new SequoiaPgpPlugin({ invoke: X })` becomes `new SequoiaPgpPlugin({ invoke: X, hostStores, fileIO: mockFileIO })`, where `X` is the site's existing invoke expression (`fake.invoke`, `wrappedInvoke`, `fakeInvoke`, etc. — leave it verbatim). Define once, near the top:
   ```ts
   const mockFileIO = { saveFile: async () => true, pickFile: async () => null }
   ```
   For any test that asserts export/import file behavior, give that test its own `fileIO` stub returning the expected value (search the file for `exportKeyToFile`/`pickKeyFile` assertions and localize a stub there).
3. **Store reads/writes in assertions.** Replace `getOwnKeyConflict()` → `hostStores.ownKeyConflict.get()`. For the blocks that `await import('@/stores/verifiedPeerKeysStore' | 'keyChangeAlertsStore' | 'pinnedPrimaryFingerprintsStore' | 'ownKeyConflictStore' | 'trustStateStatusStore')` and then call their helpers (`setPeerVerified`, `getTrustStateStatus`, `usePinnedPrimaryFingerprintsStore.getState()`, etc.), replace each with the corresponding `hostStores.<group>` accessor:
   - `setPeerVerified(jid, fp)` → `hostStores.verifiedPeers.setVerified(jid, fp)`
   - `usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid` → `hostStores.pinnedPrimaryFingerprints.getAll()`
   - `getTrustStateStatus()` → `hostStores.trustStateStatus.get()`
   - `getKeyChangeAlert(jid)` → `hostStores.keyChangeAlerts.get(jid)`
   - …and the analogous members per the Task-3 mapping.
   All `plugin` and `hostStores` used together must share the SAME `hostStores` instance passed into that plugin's constructor.

Because two-party tests construct multiple plugins (`alicePlugin`, `bobPlugin`), give each party its OWN `hostStores` when the test asserts per-party trust state (create `const aliceHost = createMockHostStores()` / `const bobHost = createMockHostStores()` and pass each into the matching constructor). For crypto/PEP-only tests that never read the stores, the shared `hostStores` is fine.

- [ ] **Step 6: Run the Sequoia suite**

Run: `cd packages/openpgp-plugin && npx vitest run src/SequoiaPgpPlugin.test.ts`
Expected: PASS with the SAME number of tests as before the move. Investigate any failure as a migration error (wrong `hostStores` instance wired to a plugin), NOT a product change.

- [ ] **Step 7: Export the Sequoia surface from `index.ts`**

Append to `packages/openpgp-plugin/src/index.ts`:

```ts

// Desktop plugin (Rust Sequoia via Tauri IPC).
export { SequoiaPgpPlugin } from './SequoiaPgpPlugin'
export type { InvokeFn, SequoiaPgpPluginOptions } from './SequoiaPgpPlugin'
```

- [ ] **Step 8: Build the package**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: no type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/openpgp-plugin apps/fluux/src/e2ee
git commit --no-gpg-sign -m "refactor(e2ee): move SequoiaPgpPlugin into package; inject hostStores + fileIO"
```

---

## Task 7: Move `WebOpenPGPPlugin.ts` (inject `hostStores`) + web crypto/vector tests

**Files:**
- Move: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` → `packages/openpgp-plugin/src/WebOpenPGPPlugin.ts`
- Move: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` → `packages/openpgp-plugin/src/WebOpenPGPPlugin.test.ts`
- Move: `apps/fluux/src/e2ee/backupInterop.test.ts` → `packages/openpgp-plugin/src/backupInterop.test.ts`
- Move: `apps/fluux/src/e2ee/consumeSequoiaVectors.test.ts` → `packages/openpgp-plugin/src/consumeSequoiaVectors.test.ts`
- Move: `apps/fluux/src/e2ee/consumeMigrationVectors.test.ts` → `packages/openpgp-plugin/src/consumeMigrationVectors.test.ts`
- Move: `apps/fluux/src/e2ee/generateWebVectors.manual.test.ts` → `packages/openpgp-plugin/src/generateWebVectors.manual.test.ts`
- Move: `apps/fluux/src/e2ee/fixtures/` → `packages/openpgp-plugin/src/fixtures/`
- Modify: `packages/openpgp-plugin/src/WebOpenPGPPlugin.ts`
- Modify the four vector/interop tests' plugin construction (add `hostStores`)
- Modify: `packages/openpgp-plugin/src/index.ts`

**Interfaces:**
- Consumes: `OpenPGPPluginBase` (Task 5), `OpenPGPHostStores` (Task 3), leaf helpers (Task 2), `openpgp` (dynamic import).
- Produces:
  - `class WebOpenPGPPlugin extends OpenPGPPluginBase` with `async unlock(passphrase): Promise<{ recovered: boolean }>`.
  - `interface WebOpenPGPPluginOptions { hostStores: OpenPGPHostStores }`.

The web plugin's file I/O is browser-native (`triggerBrowserDownload`, DOM `<input type=file>`) — NOT Tauri — so it keeps its own `exportKeyToFile`/`pickKeyFile` and needs NO `fileIO`. The vector/interop tests import `./WebOpenPGPPlugin`, `./webPassphraseStore`, `./backupKeyMaterial`, and `./fixtures/*` as siblings — all now in the package, so their relative imports resolve after the move.

- [ ] **Step 1: git mv the web plugin, its tests, the vector/interop tests, and fixtures**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/whisper-border-smooth-c602be
git mv apps/fluux/src/e2ee/WebOpenPGPPlugin.ts packages/openpgp-plugin/src/WebOpenPGPPlugin.ts
git mv apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts packages/openpgp-plugin/src/WebOpenPGPPlugin.test.ts
git mv apps/fluux/src/e2ee/backupInterop.test.ts packages/openpgp-plugin/src/backupInterop.test.ts
git mv apps/fluux/src/e2ee/consumeSequoiaVectors.test.ts packages/openpgp-plugin/src/consumeSequoiaVectors.test.ts
git mv apps/fluux/src/e2ee/consumeMigrationVectors.test.ts packages/openpgp-plugin/src/consumeMigrationVectors.test.ts
git mv apps/fluux/src/e2ee/generateWebVectors.manual.test.ts packages/openpgp-plugin/src/generateWebVectors.manual.test.ts
git mv apps/fluux/src/e2ee/fixtures packages/openpgp-plugin/src/fixtures
```

- [ ] **Step 2: Add the options interface + constructor to the web plugin**

In `packages/openpgp-plugin/src/WebOpenPGPPlugin.ts`, add near the top imports (after the `./OpenPGPPluginBase` import block at current lines 27–33):

```ts
import type { OpenPGPHostStores } from './hostStores'
```

Add the options interface just before `export class WebOpenPGPPlugin` (current line 123):

```ts
export interface WebOpenPGPPluginOptions {
  /** App-injected adapter over the six trust stores. */
  hostStores: OpenPGPHostStores
}
```

Add a constructor as the FIRST member inside the class body (immediately after `export class WebOpenPGPPlugin extends OpenPGPPluginBase {` at line 123, before its existing fields). Inline field initializers run after `super()` returns, so this is safe:

```ts
  constructor(options: WebOpenPGPPluginOptions) {
    super({ hostStores: options.hostStores })
  }
```

- [ ] **Step 3: Confirm no `@tauri-apps` or `@/` imports remain**

Run: `cd packages/openpgp-plugin && grep -n "@tauri-apps\|@/" src/WebOpenPGPPlugin.ts`
Expected: no output.

- [ ] **Step 4: Update the web plugin construction in its own test + the four vector/interop tests**

`WebOpenPGPPlugin.test.ts` constructs plugins and (like the Sequoia test) may read the stores. Apply the SAME migration rules as Task 6 Step 5, but with the web constructor shape `new WebOpenPGPPlugin({ hostStores })` (no `invoke`/`fileIO`). Add the mock import + a describe-scoped `hostStores`/`_reset()`.

The four vector/interop tests define `class Testable*Plugin extends WebOpenPGPPlugin` and construct `new Testable*Plugin()` with NO args (`backupInterop.test.ts` lines 84/102/128/181/208/227/252; `consumeSequoiaVectors.test.ts`; `consumeMigrationVectors.test.ts` line 105; `generateWebVectors.manual.test.ts` line 33). Since the base now requires `{ hostStores }`, give each `Testable*Plugin` a zero-arg-friendly construction. Simplest: in each file, add near the top:

```ts
import { createMockHostStores } from './testing/mockHostStores'
```

and change each `new Testable*Plugin()` to `new Testable*Plugin({ hostStores: createMockHostStores() })` (the `Testable*Plugin extends WebOpenPGPPlugin` inherits the `WebOpenPGPPluginOptions` constructor, so no subclass ctor edit is needed). These vector tests do not read the trust stores, so a fresh throwaway mock per construction is fine.

- [ ] **Step 5: Run the web + vector/interop suites (manual test excluded by config)**

Run: `cd packages/openpgp-plugin && npx vitest run src/WebOpenPGPPlugin.test.ts src/backupInterop.test.ts src/consumeSequoiaVectors.test.ts src/consumeMigrationVectors.test.ts`
Expected: PASS with the same test counts as before. (`generateWebVectors.manual.test.ts` is excluded by `vitest.config.ts` `*.manual.test.ts` and only runs on demand — verify it still type-checks in the build step.)

- [ ] **Step 6: Export the web surface from `index.ts`**

Append to `packages/openpgp-plugin/src/index.ts`:

```ts

// Web plugin (openpgp.js + IndexedDB).
export { WebOpenPGPPlugin } from './WebOpenPGPPlugin'
export type { WebOpenPGPPluginOptions } from './WebOpenPGPPlugin'
```

- [ ] **Step 7: Build the package**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: no type errors (the build's `tsconfig.build.json` type-checks `generateWebVectors.manual.test.ts` is EXCLUDED — confirm it is in the build exclude list from Task 1 Step 3).

- [ ] **Step 8: Commit**

```bash
git add packages/openpgp-plugin apps/fluux/src/e2ee
git commit --no-gpg-sign -m "refactor(e2ee): move WebOpenPGPPlugin + web vector tests into package; inject hostStores"
```

---

## Task 8: Finalize + verify the package public surface

**Files:**
- Modify: `packages/openpgp-plugin/src/index.ts` (review/consolidate)
- Create: `packages/openpgp-plugin/src/index.test.ts`

**Interfaces:**
- Consumes: everything exported in Tasks 2–7.
- Produces: a verified, complete public surface. No new runtime code.

- [ ] **Step 1: Review `index.ts` against the required surface**

Read `packages/openpgp-plugin/src/index.ts` and confirm it exports EXACTLY (values + types):
- Classes: `SequoiaPgpPlugin`, `WebOpenPGPPlugin`.
- `OPENPGP_DESCRIPTOR`, `classifyBoundaryError`.
- Probes: `probeRemoteIdentityState`, `probeRemotePublishedFingerprints`, `SecretKeyBackupProbeError`, type `RemoteIdentityState`.
- Fingerprint utils: `fingerprintsEqual`, `toXep0373Fingerprint`, `pubkeyMetadataFingerprintAttrs`.
- Passphrase: `parseArmorPassphraseFormat`, `generateBackupPassphrase`, `generateBackupCode`, `USE_V6_KEYS`.
- Web recovery errors: `KeyPickerRequiredError`, `NoRecoveryAvailableError`.
- Web lock/cache: `isKeyLocked`, `subscribeKeyLockState`, `setSessionPassphrase`, `sweepExpiredPassphrases`, `clearCachedPassphrase`, `clearAllCachedPassphrases`, `cachePassphrase`, `loadCachedPassphrase`, `getRememberPassphrasePreference`, `setRememberPassphrasePreference`.
- Types: `KeyBundle`, `RestoreResult`, `DecryptOutput`, `CertValidation`, `InvokeFn`, `SequoiaPgpPluginOptions`, `WebOpenPGPPluginOptions`, `OpenPGPHostStores`, `OpenPGPFileIO`, `CertRejection`, `CertRejectionCode`, `KeyChangeAlert`, `OwnKeyConflict`, `TrustStateStatus`.

Everything else (`keyExportNaming`, `openpgpUserId`, `armorDetect`, `backupKeyMaterial`, `backupMarker`, `keyUnavailable`, `verificationSync`, `trustStateIntegrity`, `webPassphraseStore`'s `getSessionPassphrase`/`clearSessionPassphrase`) stays internal.

- [ ] **Step 2: Add a smoke test that the public surface is importable `packages/openpgp-plugin/src/index.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import * as pkg from './index'

describe('@fluux/openpgp-plugin public surface', () => {
  it('exports the plugin classes and helpers', () => {
    expect(typeof pkg.SequoiaPgpPlugin).toBe('function')
    expect(typeof pkg.WebOpenPGPPlugin).toBe('function')
    expect(typeof pkg.classifyBoundaryError).toBe('function')
    expect(pkg.OPENPGP_DESCRIPTOR.id).toBe('openpgp')
    expect(typeof pkg.fingerprintsEqual).toBe('function')
    expect(typeof pkg.toXep0373Fingerprint).toBe('function')
    expect(typeof pkg.pubkeyMetadataFingerprintAttrs).toBe('function')
    expect(typeof pkg.probeRemoteIdentityState).toBe('function')
    expect(typeof pkg.probeRemotePublishedFingerprints).toBe('function')
    expect(typeof pkg.SecretKeyBackupProbeError).toBe('function')
    expect(typeof pkg.parseArmorPassphraseFormat).toBe('function')
    expect(typeof pkg.generateBackupPassphrase).toBe('function')
    expect(typeof pkg.generateBackupCode).toBe('function')
    expect(typeof pkg.USE_V6_KEYS).toBe('boolean')
    expect(typeof pkg.KeyPickerRequiredError).toBe('function')
    expect(typeof pkg.NoRecoveryAvailableError).toBe('function')
    expect(typeof pkg.isKeyLocked).toBe('function')
    expect(typeof pkg.subscribeKeyLockState).toBe('function')
    expect(typeof pkg.setSessionPassphrase).toBe('function')
    expect(typeof pkg.sweepExpiredPassphrases).toBe('function')
    expect(typeof pkg.clearCachedPassphrase).toBe('function')
    expect(typeof pkg.clearAllCachedPassphrases).toBe('function')
    expect(typeof pkg.cachePassphrase).toBe('function')
    expect(typeof pkg.loadCachedPassphrase).toBe('function')
    expect(typeof pkg.getRememberPassphrasePreference).toBe('function')
    expect(typeof pkg.setRememberPassphrasePreference).toBe('function')
  })
})
```

- [ ] **Step 3: Run the full package suite**

Run: `cd packages/openpgp-plugin && npx vitest run`
Expected: PASS across all moved suites + `hostStores.test.ts` + `index.test.ts`.

- [ ] **Step 4: Build the package**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: clean `dist/index.js`, `index.cjs`, `index.d.ts`. Spot-check `dist/index.d.ts` includes `OpenPGPHostStores`, `OpenPGPFileIO`, `SequoiaPgpPluginOptions`, `WebOpenPGPPluginOptions`.

- [ ] **Step 5: Commit**

```bash
git add packages/openpgp-plugin
git commit --no-gpg-sign -m "test(e2ee): pin @fluux/openpgp-plugin public surface"
```

---

## Task 9: Rewire `registerPlugins.ts` (build the host adapter + fileIO)

**Files:**
- Modify: `apps/fluux/src/e2ee/registerPlugins.ts`
- Test: `apps/fluux/src/e2ee/registerPlugins.test.ts` (mock path update)

**Interfaces:**
- Consumes: `SequoiaPgpPlugin`, `WebOpenPGPPlugin`, `classifyBoundaryError`, `OpenPGPHostStores`, `OpenPGPFileIO` from `@fluux/openpgp-plugin`; the app stores' imperative helpers.
- Produces: the real `openpgpHostStores` adapter + `openpgpFileIO`, passed into the plugin constructors. No behavior change (same stores, same localStorage keys, same construction branch).

- [ ] **Step 1: Rewrite the imports + build the adapter in `registerPlugins.ts`**

Replace the import block (current lines 13–19):

```ts
import { E2EEPluginError } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { isTauri } from '../utils/tauri'
import { isOpenpgpEnabled, isOmemoEnabled, useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'
import { useConversationPlaintextOverrideStore } from '../stores/conversationPlaintextOverrideStore'
import { classifyBoundaryError, SequoiaPgpPlugin } from '@fluux/openpgp-plugin'
import type { OpenPGPHostStores, OpenPGPFileIO } from '@fluux/openpgp-plugin'
import {
  isPeerVerified,
  setPeerVerified,
  clearPeerVerified,
  useVerifiedPeerKeysStore,
} from '../stores/verifiedPeerKeysStore'
import { recordCertRejections, clearCertRejections } from '../stores/certRejectionStore'
import {
  recordKeyChangeAlert,
  clearKeyChangeAlert,
  getKeyChangeAlert,
  useKeyChangeAlertsStore,
} from '../stores/keyChangeAlertsStore'
import { recordOwnKeyConflict, clearOwnKeyConflict, getOwnKeyConflict } from '../stores/ownKeyConflictStore'
import {
  getPinnedPrimaryFp,
  setPinnedPrimaryFp,
  usePinnedPrimaryFingerprintsStore,
} from '../stores/pinnedPrimaryFingerprintsStore'
import { setTrustStateStatus, getTrustStateStatus } from '../stores/trustStateStatusStore'
```

Then add, at module scope (after the imports, before `registerE2EEPlugins`), the adapter + fileIO. The adapter delegates to the SAME imperative helpers the base used to call directly, so behavior is byte-identical:

```ts
/**
 * Adapter over the six app trust stores, injected into the OpenPGP plugins.
 * Delegates to the stores' imperative helpers; the store data + localStorage
 * keys are untouched, so this is behavior-preserving. The subscribe methods
 * guard on the exact store slice the base watched.
 */
const openpgpHostStores: OpenPGPHostStores = {
  verifiedPeers: {
    isVerified: isPeerVerified,
    setVerified: setPeerVerified,
    clearVerified: clearPeerVerified,
    getAll: () => useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid,
    subscribe: (listener) =>
      useVerifiedPeerKeysStore.subscribe((state, prev) => {
        if (state.verifiedFingerprintByJid !== prev.verifiedFingerprintByJid) {
          listener(state.verifiedFingerprintByJid)
        }
      }),
  },
  certRejections: {
    record: recordCertRejections,
    clear: clearCertRejections,
  },
  keyChangeAlerts: {
    record: recordKeyChangeAlert,
    clear: clearKeyChangeAlert,
    get: getKeyChangeAlert,
    getAll: () => useKeyChangeAlertsStore.getState().alertsByJid,
    subscribe: (listener) =>
      useKeyChangeAlertsStore.subscribe((state, prev) => {
        if (state.alertsByJid !== prev.alertsByJid) listener()
      }),
  },
  ownKeyConflict: {
    record: recordOwnKeyConflict,
    clear: clearOwnKeyConflict,
    get: getOwnKeyConflict,
  },
  pinnedPrimaryFingerprints: {
    get: getPinnedPrimaryFp,
    set: setPinnedPrimaryFp,
    getAll: () => usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid,
    subscribe: (listener) =>
      usePinnedPrimaryFingerprintsStore.subscribe((state, prev) => {
        if (state.pinnedFingerprintByJid !== prev.pinnedFingerprintByJid) listener()
      }),
  },
  trustStateStatus: {
    set: setTrustStateStatus,
    get: getTrustStateStatus,
  },
}

/**
 * Tauri-backed file dialogs for the desktop plugin. The bodies are the exact
 * dynamic-import sequences that used to live in `SequoiaPgpPlugin`.
 */
const openpgpFileIO: OpenPGPFileIO = {
  async saveFile(defaultName, armored) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'OpenPGP Armor', extensions: ['asc', 'pgp', 'gpg'] }],
    })
    if (!filePath) return false
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(filePath, armored)
    return true
  },
  async pickFile() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({
      multiple: false,
      filters: [{ name: 'OpenPGP Armor', extensions: ['asc', 'pgp', 'gpg'] }],
    })
    if (!result) return null
    const filePath = typeof result === 'string' ? result : result[0]
    if (!filePath) return null
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    return readTextFile(filePath)
  },
}
```

- [ ] **Step 2: Pass the adapter + fileIO into the constructors**

Replace the desktop construction (current line 34):

```ts
        await manager.register(new SequoiaPgpPlugin({ invoke, hostStores: openpgpHostStores, fileIO: openpgpFileIO }))
```

Replace the web construction (current lines 42–43):

```ts
        const { WebOpenPGPPlugin } = await import('@fluux/openpgp-plugin')
        await manager.register(new WebOpenPGPPlugin({ hostStores: openpgpHostStores }))
```

(The `SequoiaPgpPlugin` and `classifyBoundaryError` are now statically imported from `@fluux/openpgp-plugin` at the top; the `import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'` line is gone. `WebOpenPGPPlugin` stays a dynamic import to keep openpgp.js out of the desktop bundle path.)

- [ ] **Step 3: Update the registerPlugins test mock path**

`apps/fluux/src/e2ee/registerPlugins.test.ts` currently `vi.mock('./SequoiaPgpPlugin', …)` (lines 17–18). Change it to mock the package export instead:

```ts
vi.mock('@fluux/openpgp-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/openpgp-plugin')>()
  return {
    ...actual,
    SequoiaPgpPlugin: vi.fn(function SequoiaPgpPluginMock() {
      // ...preserve the existing mock body (register-spy shape) from the original file...
    }),
  }
})
```

Read the existing mock body (lines 14–30 of the test) and preserve its exact stub behavior; only the mocked module specifier changes from `'./SequoiaPgpPlugin'` to `'@fluux/openpgp-plugin'`, spreading `actual` so the other exports (`WebOpenPGPPlugin`, `classifyBoundaryError`, `OpenPGPHostStores`) remain real. If the test also constructs/asserts on `WebOpenPGPPlugin`, mock it in the same factory.

- [ ] **Step 4: Build the package, then run the registerPlugins tests**

Run: `npm run build -w @fluux/openpgp-plugin && cd apps/fluux && npx vitest run src/e2ee/registerPlugins.test.ts src/e2ee/registerPlugins.omemo.test.ts`
Expected: PASS. (Build first so the app resolves the package's dist.)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/registerPlugins.ts apps/fluux/src/e2ee/registerPlugins.test.ts
git commit --no-gpg-sign -m "refactor(e2ee): construct OpenPGP plugins with hostStores adapter + injected fileIO"
```

---

## Task 10: Rewire the remaining app consumers to `@fluux/openpgp-plugin`

**Files (modify import specifiers only — no logic change):**
- `apps/fluux/src/stores/verifiedPeerKeysStore.ts` — `fingerprintsEqual`
- `apps/fluux/src/components/conversation/messageTrust.ts` — `fingerprintsEqual`
- `apps/fluux/src/hooks/useConversationEncryptionState.ts` — `fingerprintsEqual`
- `apps/fluux/src/e2ee/silentRestore.ts` — `loadCachedPassphrase`, `clearCachedPassphrase`
- `apps/fluux/src/App.tsx` — `probeRemoteIdentityState`, `parseArmorPassphraseFormat`, `isKeyLocked`
- `apps/fluux/src/demo.tsx` — `setSessionPassphrase`
- `apps/fluux/src/main.tsx` — `sweepExpiredPassphrases`
- `apps/fluux/src/demo/DemoOpenPGPPlugin.ts` — type `KeyBundle`
- `apps/fluux/src/components/KeyPickerDialog.tsx` — type `KeyBundle`
- `apps/fluux/src/components/UnlockEncryptionDialog.tsx` — `KeyPickerRequiredError`, `NoRecoveryAvailableError`, type `KeyBundle`, `cachePassphrase`, `clearCachedPassphrase`, `getRememberPassphrasePreference`, `setRememberPassphrasePreference`
- `apps/fluux/src/components/UnlockEncryptionDialog.test.tsx` — `vi.mock('@/e2ee/webPassphraseCache')` path
- `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` — type `KeyBundle`, `parseArmorPassphraseFormat`, `probeRemoteIdentityState`, `SecretKeyBackupProbeError`, `isKeyLocked`
- `apps/fluux/src/components/BackupPassphraseDialog.tsx` — `generateBackupPassphrase`, `generateBackupCode`, `USE_V6_KEYS`
- `apps/fluux/src/components/SaveToPasswordManagerButton.tsx` — `USE_V6_KEYS`
- `apps/fluux/src/components/RestorePassphraseDialog.tsx` — `USE_V6_KEYS`
- `apps/fluux/src/hooks/useWebKeyLocked.ts` — `isKeyLocked`, `subscribeKeyLockState`
- `apps/fluux/src/utils/performLogout.ts` — `clearCachedPassphrase`
- `apps/fluux/src/utils/clearLocalData.ts` — `clearCachedPassphrase`, `clearAllCachedPassphrases`

**Interfaces:**
- Consumes: the finalized `@fluux/openpgp-plugin` surface (Task 8).
- Produces: an app that imports all moved symbols from `@fluux/openpgp-plugin` (no `@/e2ee/<moved>` imports remain).

- [ ] **Step 1: Rewrite each import specifier**

For every file above, change the module specifier of the listed imports from `@/e2ee/<module>` (or `./e2ee/<module>` / `../e2ee/<module>`) to `@fluux/openpgp-plugin`, keeping the SAME imported names. Examples (apply the analogous edit in each file):

`stores/verifiedPeerKeysStore.ts` line 3:
```ts
import { fingerprintsEqual } from '@fluux/openpgp-plugin'
```

`components/UnlockEncryptionDialog.tsx` lines 7–16 collapse to package imports:
```ts
import { KeyPickerRequiredError, NoRecoveryAvailableError } from '@fluux/openpgp-plugin'
import type { KeyBundle } from '@fluux/openpgp-plugin'
// ...
import {
  cachePassphrase,
  clearCachedPassphrase,
  getRememberPassphrasePreference,
  setRememberPassphrasePreference,
} from '@fluux/openpgp-plugin'
```

`components/settings-components/EncryptionSettings.tsx`:
```ts
import type { KeyBundle } from '@fluux/openpgp-plugin'
import { parseArmorPassphraseFormat } from '@fluux/openpgp-plugin'
import { probeRemoteIdentityState, SecretKeyBackupProbeError } from '@fluux/openpgp-plugin'
import { isKeyLocked } from '@fluux/openpgp-plugin'
```

`App.tsx`:
```ts
import { probeRemoteIdentityState } from '@fluux/openpgp-plugin'
import { parseArmorPassphraseFormat } from '@fluux/openpgp-plugin'
import { isKeyLocked } from '@fluux/openpgp-plugin'
```

`e2ee/silentRestore.ts` line 13:
```ts
import { loadCachedPassphrase, clearCachedPassphrase } from '@fluux/openpgp-plugin'
```

Apply the same pattern to `messageTrust.ts`, `useConversationEncryptionState.ts`, `demo.tsx`, `main.tsx`, `DemoOpenPGPPlugin.ts` (type `KeyBundle`), `KeyPickerDialog.tsx` (type `KeyBundle`), `BackupPassphraseDialog.tsx`, `SaveToPasswordManagerButton.tsx`, `RestorePassphraseDialog.tsx`, `useWebKeyLocked.ts`, `performLogout.ts`, `clearLocalData.ts`. Consolidate multiple single-name imports from the package into one statement per file where practical.

For `components/UnlockEncryptionDialog.test.tsx` line 7, change the mock target:
```ts
vi.mock('@fluux/openpgp-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/openpgp-plugin')>()
  return { ...actual, /* the existing webPassphraseCache stubs: cachePassphrase, clearCachedPassphrase, getRememberPassphrasePreference, setRememberPassphrasePreference */ }
})
```
Read the existing mock factory (the object it returns for `@/e2ee/webPassphraseCache`) and reproduce those exact stub members, spreading `actual` so the dialog's other package imports (`KeyPickerRequiredError`, `KeyBundle`) resolve to the real exports.

- [ ] **Step 2: Grep for any surviving old-path imports of moved modules**

Run:
```bash
cd apps/fluux/src && grep -rn "e2ee/\(OpenPGPPluginBase\|SequoiaPgpPlugin\|WebOpenPGPPlugin\|fingerprintCompare\|openpgpUserId\|keyExportNaming\|armorDetect\|backupMarker\|backupKeyMaterial\|passphraseFormatHeader\|passphraseGenerator\|secretKeyProbe\|verificationSync\|trustStateIntegrity\|recoveryErrors\|keyUnavailable\|webPassphraseStore\|webPassphraseCache\)'" .
```
Expected: no output. Any hit is an un-rewired consumer — fix it.

- [ ] **Step 3: Build the package, then run the affected app suites**

Run:
```bash
npm run build -w @fluux/openpgp-plugin
cd apps/fluux && npx vitest run \
  src/components/settings-components/EncryptionSettings.test.tsx \
  src/components/UnlockEncryptionDialog.test.tsx \
  src/e2ee/silentRestore.test.ts \
  src/e2ee/openpgpTrustRendering.regression.test.tsx
```
Expected: PASS. (These are the suites most coupled to the rewired imports; the full app suite runs in Task 11.) If a suite file name differs, discover it with `ls src/components/settings-components/ | grep -i encryption` and run the actual file.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src
git commit --no-gpg-sign -m "refactor(e2ee): import moved OpenPGP helpers from @fluux/openpgp-plugin"
```

---

## Task 11: Behavior-parity gate — full typecheck + all suites

**Files:**
- No source changes (verification + cleanup only).

**Interfaces:**
- Consumes: Tasks 1–10.
- Produces: proof that the extraction is behavior-preserving.

- [ ] **Step 1: Confirm the moved files are gone from the app tree**

Run:
```bash
cd apps/fluux/src/e2ee && ls -1 | grep -E "^(OpenPGPPluginBase|SequoiaPgpPlugin|WebOpenPGPPlugin|fingerprintCompare|openpgpUserId|keyExportNaming|armorDetect|backupMarker|backupKeyMaterial|passphraseFormatHeader|passphraseGenerator|secretKeyProbe|verificationSync|trustStateIntegrity|recoveryErrors|keyUnavailable|webPassphraseStore|webPassphraseCache)\.ts" || echo "NONE REMAIN"
```
Expected: `NONE REMAIN` (they were relocated via `git mv` in Tasks 2–7; nothing left to delete). Also confirm `apps/fluux/src/e2ee/fixtures/` and `apps/fluux/src/e2ee/passphraseWordlists/` no longer exist.

Files that SHOULD remain in `apps/fluux/src/e2ee/`: `registerPlugins.ts`, `silentRestore.ts`, `trustVisual.ts`, `encryptionSendError.ts`, `IndexedDBStorageBackend.ts`, `TauriKeychainStorageBackend.ts`, and their tests, plus `openpgpTrustRendering.regression.test.tsx`.

- [ ] **Step 2: Grep the whole app for any remaining old-path imports**

Run:
```bash
cd apps/fluux/src && grep -rn "@/e2ee/\(OpenPGPPluginBase\|SequoiaPgpPlugin\|WebOpenPGPPlugin\|fingerprintCompare\|openpgpUserId\|keyExportNaming\|armorDetect\|backupMarker\|backupKeyMaterial\|passphraseFormatHeader\|passphraseGenerator\|secretKeyProbe\|verificationSync\|trustStateIntegrity\|recoveryErrors\|keyUnavailable\|webPassphraseStore\|webPassphraseCache\)\|\./e2ee/\(secretKeyProbe\|passphraseFormatHeader\|webPassphraseStore\|webPassphraseCache\)" .
```
Expected: no output.

- [ ] **Step 3: Build the package (dist is what the app typechecks against)**

Run: `npm run build -w @fluux/openpgp-plugin`
Expected: clean build.

- [ ] **Step 4: Full workspace typecheck**

Run: `npm run typecheck`
Expected: PASS across all workspaces (`@fluux/sdk`, `@fluux/omemo-plugin`, `@fluux/openpgp-plugin`, `@xmpp/fluux`). A clean typecheck across the app confirms every `hostStores`/`fileIO`/import edge is complete.

- [ ] **Step 5: Full package suite**

Run: `cd packages/openpgp-plugin && npx vitest run`
Expected: PASS (all moved plugin/helper suites + `hostStores.test.ts` + `index.test.ts`).

- [ ] **Step 6: Full app suite (OpenPGP characterization net + OMEMO + everything)**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS. Specifically green: `openpgpTrustRendering.regression.test.tsx` (the Task-1 characterization net), `EncryptionSettings`, `UnlockEncryptionDialog`, `silentRestore`, `registerPlugins`, `registerPlugins.omemo`, and the OMEMO suites — all WITHOUT assertion changes.

- [ ] **Step 7: Full OMEMO package suite (untouched, must stay green)**

Run: `cd packages/omemo-plugin && npx vitest run`
Expected: PASS (this task changed nothing here; it is the negative control).

- [ ] **Step 8: Commit the verification (if any incidental fixes were needed)**

```bash
git add -A
git commit --no-gpg-sign -m "test(e2ee): verify @fluux/openpgp-plugin extraction is behavior-preserving"
```

If Step 8 has nothing to commit (all green with no edits), skip it — the extraction is already committed across Tasks 1–10.

- [ ] **Step 9 (optional human gate): desktop + web smoke**

Not automatable here. On a machine with Tauri: `npm run tauri:dev`, confirm OpenPGP encrypt/decrypt to a peer + key backup/restore still work; on web (`npm run dev`): confirm session unlock still prompts + decrypts. These are covered by the moved test suites; the smoke is the final human confirmation.

---

## Self-review notes (applied)

- **Spec coverage:** Component 1 (scaffold) → Task 1. Component 2 (moves vs stays) → Tasks 2, 4–7 (moves), Tasks 9–10 (stays rewired). Component 3 (`OpenPGPHostStores`) → Task 3 (enumerated call-site table) + Tasks 4–5 (call-site rewrites) + Task 9 (app adapter). Component 4 (Tauri file I/O injection) → `OpenPGPFileIO` in Task 3 + Task 6 (Sequoia uses it) + Task 9 (app supplies it). Component 5 (import rewiring + registration) → Tasks 9–10. Error-handling/edge-cases (byte-identical `classifyBoundaryError`, single-source fingerprint utils, `hostStores` typecheck completeness, no new persisted data) → Task 5 (classify moves untouched), Task 2 (fingerprint exports), Task 5 Step 7 (typecheck gate), Global Constraints (no data movement). Testing & verification → per-task package suites + Task 11 full gate.
- **Type consistency:** `OpenPGPHostStores`, `OpenPGPFileIO`, `SequoiaPgpPluginOptions { invoke, hostStores, fileIO }`, `WebOpenPGPPluginOptions { hostStores }`, `constructor(opts: { hostStores })`, and the refactored `trustStateIntegrity` signatures (with `hostStores` inserted before the optional `isKeyUnavailable`) are used identically in Tasks 3–9. Member names (`verifiedPeers.isVerified/setVerified/clearVerified/getAll/subscribe`, `keyChangeAlerts.record/clear/get/getAll/subscribe`, `pinnedPrimaryFingerprints.get/set/getAll/subscribe`, `ownKeyConflict.record/clear/get`, `certRejections.record/clear`, `trustStateStatus.set/get`) match between the interface (Task 3), the base rewrites (Task 5), and the app adapter (Task 9).
- **No placeholders:** every code step shows the actual code; every command lists its expected output. The two 100+ KB plugin test files (`SequoiaPgpPlugin.test.ts`, `WebOpenPGPPlugin.test.ts`) are migrated by explicit, complete transformation RULES (import swap + construction-arg rule + store-accessor mapping table) rather than reproduced verbatim — reproducing ~450 KB of unchanged test code inline is impractical; the `npx vitest run` count-parity check is the gate.
