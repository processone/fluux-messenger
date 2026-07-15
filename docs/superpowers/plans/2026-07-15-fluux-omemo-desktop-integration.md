# OMEMO Desktop Integration (M2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠ Security-critical: this wires a real E2EE plugin and an at-rest secret store into the shipping desktop app.** Never let a code path send plaintext where encryption was expected; never persist OMEMO secrets unsealed. Add adversarial/edge tests per task (tampered sealed value must fail to decrypt; keychain-absent fallback; wrong-account isolation). After each task, dispatch a separate defect-hunting reviewer.

**Goal:** Ship encrypted OMEMO 1:1 in the Fluux desktop (Tauri) app: register `OmemoPlugin`, persist its store sealed at rest via a Tier-1 Rust keychain-backed `StorageBackend`, gate it opt-in with OMEMO auto-preferred + a protocol-switch notice, and surface OMEMO in the composer lock.

**Architecture:** The OMEMO crypto stays 100% TypeScript (`@fluux/omemo` + `@fluux/omemo-plugin`). A new **generic** Rust module seals arbitrary key/value bytes with a per-account key held in the OS keychain and exposes `get/put/delete/list` Tauri commands; a TS `StorageBackend` adapter calls them. The app registrar becomes multi-plugin, gated by a new `omemoEnabled` setting. Coexistence uses the SDK's existing securityLevel ranking (OMEMO 80 > OpenPGP 30) plus a one-time switch notice. The composer state hook is generalized off its OpenPGP hardcoding.

**Tech Stack:** Rust (`keyring` v3, `aes-gcm` 0.10, `serde`), Tauri commands, TypeScript, Zustand, React, vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-fluux-omemo-desktop-integration-design.md`

## Global Constraints

- **OMEMO crypto stays in TypeScript** (`@fluux/omemo`). Rust owns ONLY the seal/unseal at-rest boundary — no ratchet, no X3DH, no payload cipher in Rust.
- **The Rust KV store is generic/protocol-agnostic** (`get/put/delete/list` of opaque bytes), not OMEMO-shaped. It is also the documented Tier-2 seam.
- **Per-account isolation**: keys/values are namespaced by account JID; account A's data must be invisible to account B (mirrors `IndexedDBStorageBackend`'s per-JID DB).
- **Sealed at rest**: every stored value is AEAD-encrypted (AES-256-GCM) with a per-account master key held in the OS keychain (`keyring::Entry`). Keychain-absent (mostly Linux) → 0600 file-backed master key + a persistent UI warning; NEVER store OMEMO secrets in cleartext.
- **IPC marshaling**: byte values cross the Tauri boundary as **base64 strings**, not number arrays (avoids the known large-number-array IPC stall; E2EE values are small but base64 is uniform and safe).
- **`omemoEnabled` is opt-in, default OFF.** OMEMO registered only on Tauri (desktop). Web OMEMO is out of scope.
- **Coexistence:** the SDK's `selectStrategy` already auto-prefers OMEMO (securityLevel 80 > OpenPGP 30) — do NOT change selection. Add a one-time, dismissible `openpgp→omemo:2` switch notice.
- **Namespaces (exact):** OMEMO 2 = `urn:xmpp:omemo:2`; plugin id = `omemo:2`.
- **Commands (repo root):** SDK/app tests `npm run test:run -w @xmpp/fluux` / `-w @fluux/sdk`; single vitest file `npx vitest run <path>`. Rust: `cd apps/fluux/src-tauri && cargo test <name>`. Typecheck: `npm run typecheck`. The plugin typechecks against built dep dists — run `npm run build:sdk` (and `-w @fluux/omemo`/`-w @fluux/omemo-plugin` if their types changed) before app typecheck.
- **Commit signing is broken** — commit with `git commit --no-gpg-sign -m "…"`. Do NOT retry signing.
- **Manual E2E gate**: the crypto interop is already proven (M2a vs twomemo); the final gate here is a manual `tauri:dev` run proving encrypted 1:1 against a live server AND session survival across restart.

---

## File Structure

```
apps/fluux/src-tauri/src/
  e2ee_store.rs                 # NEW: generic keychain-sealed KV store (master key + AES-256-GCM)
  main.rs                       # MODIFY: `mod e2ee_store;` + 4 commands in generate_handler!

apps/fluux/src/
  e2ee/TauriKeychainStorageBackend.ts   # NEW: StorageBackend over the Rust commands (base64 IPC)
  e2ee/registerPlugins.ts               # MODIFY: multi-plugin registry; register OMEMO on Tauri
  stores/encryptionSettingsStore.ts     # MODIFY: add omemoEnabled + isOmemoEnabled
  stores/protocolSwitchStore.ts         # NEW: one-time openpgp->omemo:2 switch notice
  hooks/useConversationEncryptionState.ts # MODIFY: query selected plugin, OMEMO states
  components/settings-components/EncryptionSettings.tsx  # MODIFY: OMEMO opt-in toggle
  i18n/locales/*.json                   # MODIFY: chat.encryption.tooltip.protocol.omemo:2 + toggle copy

packages/fluux-sdk/src/core/e2ee/
  stanzaDecrypt.ts              # MODIFY: EME_NAMESPACE_PLUGIN_IDS['urn:xmpp:omemo:2'] = 'omemo:2'
```

---

### Task 1: Rust generic keychain-sealed KV store (`e2ee_store.rs`)

**Files:**
- Create: `apps/fluux/src-tauri/src/e2ee_store.rs`
- Modify: `apps/fluux/src-tauri/src/main.rs` (add `mod e2ee_store;` near line 204)

**Interfaces:**
- Produces a `Store` with `for_testing(base_dir)` + production ctor, and methods `get(account,key)->Option<Vec<u8>>`, `put(account,key,value)`, `delete(account,key)`, `list(account,prefix)->Vec<String>`. Master key per account from `keyring::Entry("fluux-e2ee-store", account)`; values sealed AES-256-GCM (random 12-byte nonce, stored `nonce||ct||tag`); per-account JSON file `<base_dir>/e2ee-store/<sanitized-jid>.json` mapping key→base64(sealed). Keychain-absent → 0600 file `<base_dir>/e2ee-store/<sanitized-jid>.mk` holding the raw master key + set a `fallback_used` flag surfaced to the caller.

- [ ] **Step 1: Write the failing Rust test** — append to `e2ee_store.rs` (create the file with a `#[cfg(test)] mod tests`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn seals_and_round_trips_including_high_bytes() {
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        let v: Vec<u8> = vec![0x00, 0x7f, 0x80, 0xfe, 0xff, 0x01];
        s.put("alice@x", "session/bob/5", &v).unwrap();
        assert_eq!(s.get("alice@x", "session/bob/5").unwrap(), Some(v));
        // on-disk bytes are NOT the plaintext (sealed)
        let raw = std::fs::read(s.file_path("alice@x")).unwrap();
        assert!(!raw.windows(6).any(|w| w == [0x00,0x7f,0x80,0xfe,0xff,0x01]));
    }

    #[test]
    fn missing_key_is_none_and_delete_is_noop() {
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        assert_eq!(s.get("a@x", "nope").unwrap(), None);
        s.delete("a@x", "nope").unwrap(); // no error
    }

    #[test]
    fn accounts_are_isolated() {
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        s.put("a@x", "k", &[1]).unwrap();
        assert_eq!(s.get("b@x", "k").unwrap(), None);
    }

    #[test]
    fn list_filters_by_prefix() {
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        s.put("a@x", "session/1", &[1]).unwrap();
        s.put("a@x", "trust/1", &[2]).unwrap();
        let mut got = s.list("a@x", "session/").unwrap();
        got.sort();
        assert_eq!(got, vec!["session/1".to_string()]);
    }

    #[test]
    fn fallback_master_key_when_keychain_unavailable() {
        let dir = tempdir().unwrap();
        let s = Store::for_testing_no_keychain(dir.path().to_path_buf());
        s.put("a@x", "k", &[9, 9]).unwrap();
        assert_eq!(s.get("a@x", "k").unwrap(), Some(vec![9, 9]));
        assert!(s.file_path("a@x").with_extension("mk").exists()); // 0600 fallback key file
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/fluux/src-tauri && cargo test e2ee_store 2>&1 | tail -20`
Expected: FAIL — `Store` not found. (Add `tempfile` to `[dev-dependencies]` in `Cargo.toml` if absent: `tempfile = "3"`.)

- [ ] **Step 3: Implement `e2ee_store.rs`**

```rust
//! Generic, protocol-agnostic at-rest KV store for E2EE plugin bytes.
//!
//! Each value is sealed with AES-256-GCM under a per-account master key held
//! in the OS keychain (`keyring`). Keychain-absent hosts fall back to a 0600
//! master-key file (with a caller-surfaced warning). The store is deliberately
//! generic — it is also the seam a future Rust crypto engine would use.
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

const KEYCHAIN_SERVICE: &str = "fluux-e2ee-store";

pub struct Store {
    base_dir: PathBuf,
    use_keychain: bool,
}

fn sanitize_jid(jid: &str) -> String {
    jid.chars().map(|c| if c.is_ascii_alphanumeric() || "@._-".contains(c) { c } else { '_' }).collect()
}

impl Store {
    pub fn new(base_dir: PathBuf) -> Self { Self { base_dir, use_keychain: true } }
    #[cfg(test)]
    pub fn for_testing(base_dir: PathBuf) -> Self { Self { base_dir, use_keychain: true } }
    #[cfg(test)]
    pub fn for_testing_no_keychain(base_dir: PathBuf) -> Self { Self { base_dir, use_keychain: false } }

    fn dir(&self) -> std::io::Result<PathBuf> {
        let d = self.base_dir.join("e2ee-store");
        std::fs::create_dir_all(&d)?;
        Ok(d)
    }
    pub fn file_path(&self, account: &str) -> PathBuf {
        // dir() is idempotent; unwrap acceptable — base_dir is app-owned.
        self.base_dir.join("e2ee-store").join(format!("{}.json", sanitize_jid(account)))
    }
    fn mk_path(&self, account: &str) -> PathBuf { self.file_path(account).with_extension("mk") }

    /// Load or create the per-account 32-byte master key.
    fn master_key(&self, account: &str) -> Result<[u8; 32], String> {
        // 1) keychain path
        if self.use_keychain {
            if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, account) {
                match entry.get_secret() {
                    Ok(bytes) if bytes.len() == 32 => {
                        let mut k = [0u8; 32]; k.copy_from_slice(&bytes); return Ok(k);
                    }
                    Ok(_) => {}
                    Err(keyring::Error::NoEntry) => {
                        let mut k = [0u8; 32]; OsRng.fill_bytes(&mut k);
                        entry.set_secret(&k).map_err(|e| format!("keychain set: {e}"))?;
                        return Ok(k);
                    }
                    Err(_) => { /* keychain present but erroring — fall through to file */ }
                }
            }
        }
        // 2) 0600 file fallback (keychain unavailable)
        self.dir().map_err(|e| e.to_string())?;
        let p = self.mk_path(account);
        if let Ok(bytes) = std::fs::read(&p) {
            if bytes.len() == 32 { let mut k = [0u8; 32]; k.copy_from_slice(&bytes); return Ok(k); }
        }
        let mut k = [0u8; 32]; OsRng.fill_bytes(&mut k);
        write_0600(&p, &k).map_err(|e| format!("write fallback mk: {e}"))?;
        Ok(k)
    }

    fn read_map(&self, account: &str) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read(self.file_path(account)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("parse store: {e}")),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("read store: {e}")),
        }
    }
    fn write_map(&self, account: &str, map: &BTreeMap<String, String>) -> Result<(), String> {
        self.dir().map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        write_0600(&self.file_path(account), &bytes).map_err(|e| e.to_string())
    }

    pub fn get(&self, account: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
        let map = self.read_map(account)?;
        match map.get(key) {
            None => Ok(None),
            Some(sealed_b64) => {
                let sealed = b64_decode(sealed_b64)?;
                Ok(Some(self.unseal(account, &sealed)?))
            }
        }
    }
    pub fn put(&self, account: &str, key: &str, value: &[u8]) -> Result<(), String> {
        let sealed = self.seal(account, value)?;
        let mut map = self.read_map(account)?;
        map.insert(key.to_string(), b64_encode(&sealed));
        self.write_map(account, &map)
    }
    pub fn delete(&self, account: &str, key: &str) -> Result<(), String> {
        let mut map = self.read_map(account)?;
        if map.remove(key).is_some() { self.write_map(account, &map)?; }
        Ok(())
    }
    pub fn list(&self, account: &str, prefix: &str) -> Result<Vec<String>, String> {
        Ok(self.read_map(account)?.keys().filter(|k| k.starts_with(prefix)).cloned().collect())
    }

    fn seal(&self, account: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let key = self.master_key(account)?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let mut nonce_bytes = [0u8; 12]; OsRng.fill_bytes(&mut nonce_bytes);
        let ct = cipher.encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
            .map_err(|e| format!("seal: {e}"))?;
        let mut out = Vec::with_capacity(12 + ct.len());
        out.extend_from_slice(&nonce_bytes); out.extend_from_slice(&ct);
        Ok(out)
    }
    fn unseal(&self, account: &str, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < 12 { return Err("sealed value too short".into()); }
        let key = self.master_key(account)?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        cipher.decrypt(Nonce::from_slice(&sealed[..12]), &sealed[12..])
            .map_err(|e| format!("unseal (tampered or wrong key): {e}"))
    }
}

fn write_0600(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    Ok(())
}

fn b64_encode(b: &[u8]) -> String { use base64::Engine; base64::engine::general_purpose::STANDARD.encode(b) }
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine; base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| e.to_string())
}
```

> Verify the `base64` and `rand` crates are in `Cargo.toml` (they are used elsewhere; `base64` may need adding — check `grep -E "base64|^rand " Cargo.toml`, add `base64 = "0.22"` / `rand = "0.8"` if missing). `keyring::Entry::get_secret`/`set_secret` are the v3 binary-secret API; if the installed v3 exposes only `get_password`/`set_password` (string), base64 the master key through those instead — verify against `cargo doc -p keyring` or the crate source and adjust.

- [ ] **Step 4: Add `mod e2ee_store;` to `main.rs`** (near the other `mod` lines ~204)

```rust
mod e2ee_store;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/fluux/src-tauri && cargo test e2ee_store 2>&1 | tail -15`
Expected: PASS (5 tests). Also `cargo build 2>&1 | tail -5` succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src-tauri/src/e2ee_store.rs apps/fluux/src-tauri/src/main.rs apps/fluux/src-tauri/Cargo.toml
git commit --no-gpg-sign -m "feat(tauri): generic keychain-sealed E2EE KV store"
```

---

### Task 2: Tauri commands for the store

**Files:**
- Modify: `apps/fluux/src-tauri/src/e2ee_store.rs` (add commands)
- Modify: `apps/fluux/src-tauri/src/main.rs` (register in `generate_handler!`)

**Interfaces:**
- Produces Tauri commands: `e2ee_store_get(app, account, key) -> Result<Option<String>, String>` (base64), `e2ee_store_put(app, account, key, value_b64)`, `e2ee_store_delete(app, account, key)`, `e2ee_store_list(app, account, prefix) -> Result<Vec<String>, String>`. Each resolves the app data dir for the `Store` base dir.

- [ ] **Step 1: Add the commands to `e2ee_store.rs`**

```rust
use tauri::Manager;

fn store_for(app: &tauri::AppHandle) -> Result<Store, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(Store::new(base))
}

#[tauri::command]
pub fn e2ee_store_get(app: tauri::AppHandle, account: String, key: String) -> Result<Option<String>, String> {
    Ok(store_for(&app)?.get(&account, &key)?.map(|b| b64_encode(&b)))
}
#[tauri::command]
pub fn e2ee_store_put(app: tauri::AppHandle, account: String, key: String, value_b64: String) -> Result<(), String> {
    store_for(&app)?.put(&account, &key, &b64_decode(&value_b64)?)
}
#[tauri::command]
pub fn e2ee_store_delete(app: tauri::AppHandle, account: String, key: String) -> Result<(), String> {
    store_for(&app)?.delete(&account, &key)
}
#[tauri::command]
pub fn e2ee_store_list(app: tauri::AppHandle, account: String, prefix: String) -> Result<Vec<String>, String> {
    store_for(&app)?.list(&account, &prefix)
}
```

- [ ] **Step 2: Register in `main.rs` `generate_handler!`** (add to the macro list near line 1494-1497)

```rust
            e2ee_store::e2ee_store_get,
            e2ee_store::e2ee_store_put,
            e2ee_store::e2ee_store_delete,
            e2ee_store::e2ee_store_list,
```

- [ ] **Step 3: Verify build**

Run: `cd apps/fluux/src-tauri && cargo build 2>&1 | tail -8`
Expected: builds (no unused-warning on the commands since they're in the handler). Re-run `cargo test e2ee_store` → still PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src-tauri/src/e2ee_store.rs apps/fluux/src-tauri/src/main.rs
git commit --no-gpg-sign -m "feat(tauri): expose e2ee_store get/put/delete/list commands"
```

---

### Task 3: `TauriKeychainStorageBackend` (TS)

**Files:**
- Create: `apps/fluux/src/e2ee/TauriKeychainStorageBackend.ts`
- Test: `apps/fluux/src/e2ee/TauriKeychainStorageBackend.test.ts`

**Interfaces:**
- Consumes: `StorageBackend` (from `@fluux/sdk`); the four Tauri commands.
- Produces: `class TauriKeychainStorageBackend implements StorageBackend` (ctor `(accountJid: string, invoke?: InvokeFn)` — `invoke` injectable for tests, defaults to dynamic `@tauri-apps/api/core`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { TauriKeychainStorageBackend } from './TauriKeychainStorageBackend'

function fakeInvoke() {
  const store = new Map<string, string>() // key -> base64
  return vi.fn(async (cmd: string, args: any) => {
    const k = `${args.account} ${args.key ?? ''}`
    if (cmd === 'e2ee_store_put') { store.set(k, args.value_b64); return }
    if (cmd === 'e2ee_store_get') { return store.get(k) ?? null }
    if (cmd === 'e2ee_store_delete') { store.delete(k); return }
    if (cmd === 'e2ee_store_list') {
      const p = `${args.account} ${args.prefix}`
      return [...store.keys()].filter((kk) => kk.startsWith(p)).map((kk) => kk.split(' ')[1])
    }
    throw new Error('unknown cmd ' + cmd)
  })
}

describe('TauriKeychainStorageBackend', () => {
  it('round-trips bytes (incl. high-bit) via base64 IPC', async () => {
    const invoke = fakeInvoke()
    const b = new TauriKeychainStorageBackend('alice@x', invoke as any)
    const v = new Uint8Array([0, 0x80, 0xff, 1])
    await b.put('session/bob/5', v)
    expect(await b.get('session/bob/5')).toEqual(v)
    expect(invoke).toHaveBeenCalledWith('e2ee_store_put', expect.objectContaining({ account: 'alice@x', key: 'session/bob/5' }))
  })
  it('get of a missing key returns null; delete is a no-op; list filters', async () => {
    const b = new TauriKeychainStorageBackend('a@x', fakeInvoke() as any)
    expect(await b.get('nope')).toBeNull()
    await b.delete('nope')
    await b.put('session/1', new Uint8Array([1]))
    await b.put('trust/1', new Uint8Array([2]))
    expect((await b.list('session/')).sort()).toEqual(['session/1'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**, then create `TauriKeychainStorageBackend.ts`

```ts
import type { StorageBackend } from '@fluux/sdk'

type InvokeFn = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>

function toB64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * StorageBackend that seals E2EE plugin bytes at rest via the Rust
 * keychain-backed store (Tauri commands). Values cross IPC as base64.
 */
export class TauriKeychainStorageBackend implements StorageBackend {
  private invokePromise: Promise<InvokeFn> | null = null
  constructor(private readonly accountJid: string, private readonly injectedInvoke?: InvokeFn) {}

  private async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    if (this.injectedInvoke) return this.injectedInvoke<T>(cmd, args)
    if (!this.invokePromise) this.invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke as InvokeFn)
    const invoke = await this.invokePromise
    return invoke<T>(cmd, args)
  }

  async get(key: string): Promise<Uint8Array | null> {
    const b64 = await this.invoke<string | null>('e2ee_store_get', { account: this.accountJid, key })
    return b64 == null ? null : fromB64(b64)
  }
  async put(key: string, value: Uint8Array): Promise<void> {
    await this.invoke<void>('e2ee_store_put', { account: this.accountJid, key, value_b64: toB64(value) })
  }
  async delete(key: string): Promise<void> {
    await this.invoke<void>('e2ee_store_delete', { account: this.accountJid, key })
  }
  async list(prefix: string): Promise<string[]> {
    return this.invoke<string[]>('e2ee_store_list', { account: this.accountJid, prefix })
  }
}
```

- [ ] **Step 3: Run PASS; commit**

```bash
git add apps/fluux/src/e2ee/TauriKeychainStorageBackend.ts apps/fluux/src/e2ee/TauriKeychainStorageBackend.test.ts
git commit --no-gpg-sign -m "feat(e2ee): TauriKeychainStorageBackend over the Rust sealed store"
```

---

### Task 4: `omemoEnabled` setting

**Files:**
- Modify: `apps/fluux/src/stores/encryptionSettingsStore.ts`
- Test: `apps/fluux/src/stores/encryptionSettingsStore.omemo.test.ts`

**Interfaces:**
- Produces on the store: `omemoEnabled: boolean`, `setOmemoEnabled(enabled: boolean): void`; module fn `isOmemoEnabled(): boolean`. Persisted under scoped key `fluux-e2ee-omemo-enabled`, default false. Mirrors the existing `openpgpEnabled` shape exactly.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useEncryptionSettingsStore, isOmemoEnabled } from './encryptionSettingsStore'

describe('omemoEnabled setting', () => {
  beforeEach(() => localStorage.clear())
  it('defaults to false and toggles + persists', () => {
    expect(isOmemoEnabled()).toBe(false)
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    expect(isOmemoEnabled()).toBe(true)
    expect(localStorage.getItem('fluux-e2ee-omemo-enabled')).toBe('1')
    useEncryptionSettingsStore.getState().rehydrate()
    expect(useEncryptionSettingsStore.getState().omemoEnabled).toBe(true)
  })
})
```

> Note: `buildScopedStorageKey` may prefix by account; the raw key assertion assumes no active account scope in the test (matches how the openpgp key behaves in unit tests). If the scoped key differs, assert `localStorage.getItem(buildScopedStorageKey('fluux-e2ee-omemo-enabled'))` instead.

- [ ] **Step 2: Run to verify it fails; then modify `encryptionSettingsStore.ts`**

Add to the interface, the store object, the loader, and a module accessor — mirroring `openpgpEnabled`:

```ts
// in EncryptionSettingsState:
  omemoEnabled: boolean
  setOmemoEnabled: (enabled: boolean) => void

// module constants:
const OMEMO_STORAGE_KEY_BASE = 'fluux-e2ee-omemo-enabled'
function loadOmemoEnabled(): boolean {
  try {
    const key = buildScopedStorageKey(OMEMO_STORAGE_KEY_BASE)
    return localStorage.getItem(key) === '1'
  } catch { return false }
}

// in the create<...>() object:
  omemoEnabled: loadOmemoEnabled(),
  setOmemoEnabled: (enabled) => {
    try { localStorage.setItem(buildScopedStorageKey(OMEMO_STORAGE_KEY_BASE), enabled ? '1' : '0') } catch { /* ignore */ }
    set({ omemoEnabled: enabled, registrationError: null })
  },

// extend rehydrate to also set omemoEnabled: loadOmemoEnabled()

// module fn:
export function isOmemoEnabled(): boolean {
  return useEncryptionSettingsStore.getState().omemoEnabled
}
```

- [ ] **Step 3: Run PASS; commit**

```bash
git add apps/fluux/src/stores/encryptionSettingsStore.ts apps/fluux/src/stores/encryptionSettingsStore.omemo.test.ts
git commit --no-gpg-sign -m "feat(settings): omemoEnabled opt-in flag (default off)"
```

---

### Task 5: Multi-plugin registration refactor

**Files:**
- Modify: `apps/fluux/src/e2ee/registerPlugins.ts`
- Test: `apps/fluux/src/e2ee/registerPlugins.omemo.test.ts`

**Interfaces:**
- Consumes: `isOpenpgpEnabled`/`isOmemoEnabled` (settings), `TauriKeychainStorageBackend`, `OmemoPlugin` (from `@fluux/omemo-plugin`), `isTauri`.
- Produces: `registerE2EEPlugins`/`unregisterE2EEPlugins` behavior — register EACH enabled plugin (OpenPGP unchanged; OMEMO on Tauri with the keychain backend), idempotent per-id, unregister per-id.

- [ ] **Step 1: Write the failing test** (mock the manager + client)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerE2EEPlugins } from './registerPlugins'
import { useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'

vi.mock('../utils/tauri', () => ({ isTauri: () => true }))

function fakeClient() {
  const plugins = new Map<string, any>()
  const manager = {
    getPlugin: (id: string) => plugins.get(id) ?? null,
    getAccountJid: () => 'me@x',
    register: vi.fn(async (p: any) => { plugins.set(p.descriptor.id, p) }),
    unregister: vi.fn(async (id: string) => { plugins.delete(id) }),
    setForcedPlaintext: vi.fn(),
  }
  return { e2ee: manager, setE2EEStorageBackend: vi.fn(), _plugins: plugins }
}

describe('registerE2EEPlugins with OMEMO', () => {
  beforeEach(() => { localStorage.clear() })
  it('registers OMEMO on Tauri when omemoEnabled, with a storage backend', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    expect(client._plugins.has('omemo:2')).toBe(true)
    expect(client.setE2EEStorageBackend).toHaveBeenCalled()
  })
  it('does NOT register OMEMO when omemoEnabled is false', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(false)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    expect(client._plugins.has('omemo:2')).toBe(false)
  })
  it('is idempotent — re-registering does not double-register OMEMO', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    await registerE2EEPlugins(client)
    expect(client.e2ee.register).toHaveBeenCalledTimes(1) // only OMEMO (openpgp off)
  })
})
```

- [ ] **Step 2: Run to verify it fails; then refactor `registerPlugins.ts`**

Replace the single-OpenPGP body with a per-plugin flow. Keep the OpenPGP branch's behavior identical; add an OMEMO branch. Full replacement of the `try {...}` body in `registerE2EEPlugins` and the guard in `unregisterE2EEPlugins`:

```ts
import { E2EEPluginError } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { isTauri } from '../utils/tauri'
import { isOpenpgpEnabled, isOmemoEnabled, useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'
import { useConversationPlaintextOverrideStore } from '../stores/conversationPlaintextOverrideStore'
import { classifyBoundaryError } from './OpenPGPPluginBase'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'

export async function registerE2EEPlugins(client: XMPPClient): Promise<void> {
  const manager = client.e2ee
  if (!manager) return
  const anyEnabled = isOpenpgpEnabled() || isOmemoEnabled()
  if (!anyEnabled) return

  try {
    // --- OpenPGP (unchanged behavior) ---
    if (isOpenpgpEnabled() && !manager.getPlugin('openpgp')) {
      if (isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core')
        await manager.register(new SequoiaPgpPlugin({ invoke }))
      } else {
        const { IndexedDBStorageBackend } = await import('./IndexedDBStorageBackend')
        const backend = new IndexedDBStorageBackend(manager.getAccountJid())
        await backend.open()
        client.setE2EEStorageBackend(backend)
        const { WebOpenPGPPlugin } = await import('./WebOpenPGPPlugin')
        await manager.register(new WebOpenPGPPlugin())
      }
    }

    // --- OMEMO (desktop-only; sealed keychain store) ---
    if (isOmemoEnabled() && isTauri() && !manager.getPlugin('omemo:2')) {
      const { TauriKeychainStorageBackend } = await import('./TauriKeychainStorageBackend')
      client.setE2EEStorageBackend(new TauriKeychainStorageBackend(manager.getAccountJid()))
      const { OmemoPlugin } = await import('@fluux/omemo-plugin')
      await manager.register(new OmemoPlugin())
    }

    useEncryptionSettingsStore.getState().notifyPluginRegistered()

    const { plaintextJids } = useConversationPlaintextOverrideStore.getState()
    for (const jid of Object.keys(plaintextJids)) {
      manager.setForcedPlaintext({ kind: 'direct', peer: jid }, true)
    }
  } catch (err) {
    console.error('[Fluux] E2EE plugin registration failed:', err)
    const { kind, code } = err instanceof E2EEPluginError ? err : classifyBoundaryError(err)
    useEncryptionSettingsStore.getState().notifyPluginRegistrationFailed({ kind, code })
  }
}

export async function unregisterE2EEPlugins(client: XMPPClient): Promise<void> {
  const manager = client.e2ee
  if (!manager) return
  for (const id of ['openpgp', 'omemo:2']) {
    if (!manager.getPlugin(id)) continue
    // only unregister a plugin the user has toggled OFF
    if (id === 'openpgp' && isOpenpgpEnabled()) continue
    if (id === 'omemo:2' && isOmemoEnabled()) continue
    try { await manager.unregister(id) } catch (err) {
      console.error(`[Fluux] E2EE unregister ${id} failed:`, err)
    }
  }
}
```

> IMPORTANT interop caveat: both OpenPGP (web) and OMEMO call `client.setE2EEStorageBackend`. If both are ever enabled on the SAME platform they'd fight over the single backend. In this slice OpenPGP-web uses IndexedDB and OMEMO is Tauri-only, so on desktop only OMEMO sets a backend (SequoiaPgpPlugin owns its own Rust store and ignores `ctx.storage`), and on web OMEMO isn't registered — no conflict. Add a code comment noting this; a shared multi-namespace backend is a follow-up if OpenPGP ever moves onto the generic store.

- [ ] **Step 3: Run PASS; app typecheck**

Run: `npm run build:sdk && npm run build -w @fluux/omemo && npm run build -w @fluux/omemo-plugin` (fresh dep dists), then `npx vitest run apps/fluux/src/e2ee/registerPlugins.omemo.test.ts` (PASS) and `npm run typecheck 2>&1 | grep -A2 omemo || echo "typecheck clean for omemo"`.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/e2ee/registerPlugins.ts apps/fluux/src/e2ee/registerPlugins.omemo.test.ts
git commit --no-gpg-sign -m "feat(e2ee): register OMEMO plugin on desktop (multi-plugin registrar)"
```

---

### Task 6: EME namespace→plugin map + `omemo:2` i18n

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts:489-491`
- Modify: `apps/fluux/src/i18n/locales/en.json` (+ all other `locales/*.json`)
- Test: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.omemo.test.ts`

**Interfaces:** Produces: `EME_NAMESPACE_PLUGIN_IDS` includes `'urn:xmpp:omemo:2': 'omemo:2'` so an inbound OMEMO stanza with a registered `omemo:2` plugin is treated as supported (claimed), not "unsupported".

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { classifyUnclaimedEncryption } from './stanzaDecrypt' // or the exported checker used by the map

// If the map isn't exported directly, test via the public entrypoint that consults it:
describe('EME OMEMO 2 recognition', () => {
  it('treats urn:xmpp:omemo:2 as supported when an omemo:2 plugin is registered', () => {
    const state = { getPlugin: (id: string) => (id === 'omemo:2' ? {} : null) } as any
    // The predicate at stanzaDecrypt.ts:538-540: pluginId ? !!state.getPlugin(pluginId) : false
    // Assert the map now yields 'omemo:2' for the OMEMO namespace so that predicate is true.
    // (Adapt to the actual exported surface; if only the map is internal, export a small
    //  `isEncryptionSupported(namespace, state)` helper and test that.)
    expect(true).toBe(true)
  })
})
```

> The map is module-private. Implement by exporting a tiny pure helper `emePluginIdFor(namespace: string): string | undefined` from `stanzaDecrypt.ts` (returns the map lookup) and test THAT directly (`emePluginIdFor('urn:xmpp:omemo:2') === 'omemo:2'`, `emePluginIdFor('urn:xmpp:openpgp:0') === 'openpgp'`). Replace the placeholder test with real assertions on `emePluginIdFor`.

- [ ] **Step 2: Run to verify it fails; then edit `stanzaDecrypt.ts`**

```ts
const EME_NAMESPACE_PLUGIN_IDS: Record<string, string> = {
  'urn:xmpp:openpgp:0': 'openpgp',
  'urn:xmpp:omemo:2': 'omemo:2',
}

/** Plugin id that handles an EME namespace, if any (for supported-vs-unsupported classification). */
export function emePluginIdFor(namespace: string): string | undefined {
  return EME_NAMESPACE_PLUGIN_IDS[namespace]
}
```

Update the internal call site (`stanzaDecrypt.ts:538`) to use `emePluginIdFor(namespace)` if it doesn't already reference the map directly.

- [ ] **Step 3: Add i18n** — in `apps/fluux/src/i18n/locales/en.json`, under `chat.encryption.tooltip.protocol`, add `"omemo:2": "OMEMO"`; add the OMEMO settings-toggle copy (e.g. `settings.encryption.omemo.title`/`.description`). Then mirror across ALL other `locales/*.json` (translate the toggle copy; the protocol label `"OMEMO"` stays "OMEMO" everywhere).

- [ ] **Step 4: Run PASS; commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.omemo.test.ts apps/fluux/src/i18n/locales
git commit --no-gpg-sign -m "feat(e2ee): recognize urn:xmpp:omemo:2 EME + omemo:2 i18n"
```

---

### Task 7: Protocol-switch notice store

**Files:**
- Create: `apps/fluux/src/stores/protocolSwitchStore.ts`
- Test: `apps/fluux/src/stores/protocolSwitchStore.test.ts`

**Interfaces:**
- Produces: `useProtocolSwitchStore` with `recordSelected(peer, protocolId): { switchedFromOpenpgp: boolean }` (returns whether this call is a first-time `openpgp → omemo:2` transition for that peer), `pendingNotice(peer): boolean`, `dismiss(peer): void`. Persisted per peer (scoped storage), so a dismissed notice stays dismissed and a switch isn't re-announced.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useProtocolSwitchStore } from './protocolSwitchStore'

describe('protocolSwitchStore', () => {
  beforeEach(() => { localStorage.clear(); useProtocolSwitchStore.getState().reset() })
  it('flags a one-time openpgp->omemo:2 switch and clears on dismiss', () => {
    const s = () => useProtocolSwitchStore.getState()
    expect(s().recordSelected('bob@x', 'openpgp').switchedFromOpenpgp).toBe(false) // first sight, no prior
    expect(s().recordSelected('bob@x', 'omemo:2').switchedFromOpenpgp).toBe(true)  // openpgp -> omemo:2
    expect(s().pendingNotice('bob@x')).toBe(true)
    // re-recording the same protocol does not re-raise
    expect(s().recordSelected('bob@x', 'omemo:2').switchedFromOpenpgp).toBe(false)
    s().dismiss('bob@x')
    expect(s().pendingNotice('bob@x')).toBe(false)
  })
  it('a peer that starts on omemo:2 never raises a switch notice', () => {
    const s = () => useProtocolSwitchStore.getState()
    expect(s().recordSelected('carol@x', 'omemo:2').switchedFromOpenpgp).toBe(false)
    expect(s().pendingNotice('carol@x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails; then create `protocolSwitchStore.ts`**

```ts
import { create } from 'zustand'
import { buildScopedStorageKey } from '@fluux/sdk'

const KEY = 'fluux-e2ee-protocol-switch'
type Persisted = { last: Record<string, string>; pending: Record<string, boolean> }

function load(): Persisted {
  try { return JSON.parse(localStorage.getItem(buildScopedStorageKey(KEY)) || '') || { last: {}, pending: {} } }
  catch { return { last: {}, pending: {} } }
}
function save(p: Persisted): void {
  try { localStorage.setItem(buildScopedStorageKey(KEY), JSON.stringify(p)) } catch { /* ignore */ }
}

interface State {
  last: Record<string, string>
  pending: Record<string, boolean>
  recordSelected: (peer: string, protocolId: string) => { switchedFromOpenpgp: boolean }
  pendingNotice: (peer: string) => boolean
  dismiss: (peer: string) => void
  reset: () => void
}

export const useProtocolSwitchStore = create<State>((set, get) => ({
  ...load(),
  recordSelected: (peer, protocolId) => {
    const prev = get().last[peer]
    const switched = prev === 'openpgp' && protocolId === 'omemo:2'
    const last = { ...get().last, [peer]: protocolId }
    const pending = switched ? { ...get().pending, [peer]: true } : get().pending
    const next = { last, pending }
    save(next); set(next)
    return { switchedFromOpenpgp: switched }
  },
  pendingNotice: (peer) => !!get().pending[peer],
  dismiss: (peer) => {
    const pending = { ...get().pending }; delete pending[peer]
    const next = { last: get().last, pending }
    save(next); set(next)
  },
  reset: () => { const next = { last: {}, pending: {} }; save(next); set(next) },
}))
```

- [ ] **Step 3: Run PASS; commit**

```bash
git add apps/fluux/src/stores/protocolSwitchStore.ts apps/fluux/src/stores/protocolSwitchStore.test.ts
git commit --no-gpg-sign -m "feat(e2ee): protocol-switch notice store (openpgp->omemo:2)"
```

---

### Task 8: Generalize `useConversationEncryptionState` for OMEMO

**Files:**
- Modify: `apps/fluux/src/hooks/useConversationEncryptionState.ts`
- Test: `apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.ts`

**Interfaces:**
- Consumes: `isOmemoEnabled`, the manager's `selectStrategy`/`getPlugin`, `useProtocolSwitchStore`.
- Produces: the hook returns an `encrypted` state (with the OMEMO peer's aggregate trust) when OMEMO is the selected strategy, and records the selection into `useProtocolSwitchStore`. OpenPGP behavior is unchanged when OpenPGP is selected.

- [ ] **Step 1: Write the failing test** (render the hook with a mocked manager where the selected plugin is OMEMO)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useConversationEncryptionState } from './useConversationEncryptionState'
import { useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'

// Mock the E2EE manager access the hook uses (adapt import to the hook's actual source).
// The OMEMO plugin: descriptor.id 'omemo:2', probePeer -> supported, getPeerTrust -> 'tofu'.
// selectStrategy(target) -> the omemo plugin.

describe('useConversationEncryptionState with OMEMO', () => {
  beforeEach(() => { localStorage.clear(); useEncryptionSettingsStore.getState().setOmemoEnabled(true) })
  it('reports encrypted (omemo:2) when OMEMO is the selected strategy', async () => {
    // ... wire a mock manager whose selectStrategy returns an omemo:2 plugin and getPeerTrust='tofu'
    const { result } = renderHook(() => useConversationEncryptionState('bob@x', 'chat'))
    await waitFor(() => expect(result.current.state).toBe('encrypted'))
    // and the security context reflects omemo:2 + tofu (assert the shape the hook exposes)
  })
})
```

> This hook is 302 lines and OpenPGP-shaped; the test wiring depends on how it accesses the manager. Read the hook first and mirror its existing test setup (there is likely a `useConversationEncryptionState.test.ts` — copy its manager-mock harness). The concrete change (Step 2) is the load-bearing part; keep the test focused on: OMEMO-selected → `encrypted`.

- [ ] **Step 2: Modify the hook** — the minimal generalization:

1. Gate on `isOpenpgpEnabled() || isOmemoEnabled()` (line ~181) instead of only `openpgpEnabled`.
2. Determine the **selected** plugin for the peer: `const selected = await manager?.selectStrategy({ kind: 'direct', peer: peerJid })` (it returns the plugin or null, using the capability cache). Branch on `selected?.descriptor.id`.
3. If `selected` is `omemo:2`: produce `state: 'encrypted'` with the security context sourced from `omemoPlugin.getPeerTrust(peerJid)` (map `tofu/verified/untrusted/unknown` to the existing trust display). No `keyLocked`/pinned-fingerprint logic for OMEMO.
4. If `selected` is `openpgp`: keep the existing OpenPGP code path verbatim.
5. If `selected` is null (peer supports neither / not enabled): keep the existing `unsupported`/`disabled` handling.
6. Call `useProtocolSwitchStore.getState().recordSelected(peerJid, selected?.descriptor.id ?? 'none')` when the selection resolves, so Task 7's notice can fire.

Keep OpenPGP-only states (`keyLocked`, `blocked`, `rejected`) reachable only on the OpenPGP branch. Add `isOmemoEnabled`/`selectStrategy`/`useProtocolSwitchStore` to the effect deps.

> Because this hook is large and central, implement the OMEMO branch as an early, isolated block that returns before touching the OpenPGP-specific stores, minimizing risk to the existing path. Do NOT refactor the OpenPGP path beyond the gate change.

- [ ] **Step 3: Run PASS + full app suite for regressions**

Run: `npx vitest run apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.ts` and the existing `useConversationEncryptionState.test.ts` (must still pass — OpenPGP path unchanged). Then `npm run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/hooks/useConversationEncryptionState.ts apps/fluux/src/hooks/useConversationEncryptionState.omemo.test.ts
git commit --no-gpg-sign -m "feat(e2ee): composer encryption state reflects the selected plugin (OMEMO)"
```

---

### Task 9: OMEMO opt-in toggle + switch-notice UI

**Files:**
- Modify: `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`
- Modify: a composer/header surface for the switch notice (e.g. `apps/fluux/src/components/MessageComposer.tsx` or `ChatHeader.tsx`)
- Test: a focused render test for the toggle wiring

**Interfaces:** Consumes `omemoEnabled`/`setOmemoEnabled`, `registerE2EEPlugins`/`unregisterE2EEPlugins`, `useProtocolSwitchStore`.

- [ ] **Step 1: Add the OMEMO toggle to `EncryptionSettings.tsx`** — mirror the existing OpenPGP toggle: a switch bound to `omemoEnabled`/`setOmemoEnabled`; on enable, call `registerE2EEPlugins(client)`, on disable `unregisterE2EEPlugins(client)` (same flow the OpenPGP toggle uses at `EncryptionSettings.tsx:302,334,364,388,781`). Gate the toggle visible only on Tauri (`isTauri()`) with a short "desktop only" note, since OMEMO is desktop-first. Use the `settings.encryption.omemo.*` i18n keys from Task 6.

- [ ] **Step 2: Add the switch-notice banner** — where the composer renders the encryption lock, if `useProtocolSwitchStore().pendingNotice(peerJid)`, render a small dismissible inline notice ("This conversation now uses OMEMO — verify the new device in the contact's security details"), calling `dismiss(peerJid)` on close. Reuse the existing notice/banner component style (model on `keyChangeAlertsStore` consumers).

- [ ] **Step 3: Write a focused test** — the toggle calls `setOmemoEnabled(true)` + `registerE2EEPlugins`; the banner shows when `pendingNotice` is true and hides after `dismiss`. Run it + `npm run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/settings-components/EncryptionSettings.tsx apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/i18n/locales
git commit --no-gpg-sign -m "feat(e2ee): OMEMO opt-in toggle + protocol-switch notice UI"
```

---

### Task 10: Manual E2E verification gate (the real proof)

**Files:** Create: `docs/superpowers/plans/m2b-manual-verification.md` (a checklist recording the run + result).

This gate is NOT automatable in CI here — it validates the assembled desktop app + at-rest persistence against a live server. The crypto interop itself is already proven (M2a vs twomemo).

- [ ] **Step 1: Build + launch**

Run: `npm run build:sdk && npm run build -w @fluux/omemo && npm run build -w @fluux/omemo-plugin`, then `npm run tauri:dev`. Log in to a real XMPP account on a server with PEP (e.g. an ejabberd test account).

- [ ] **Step 2: Enable + exchange**

In Settings → Encryption, enable OMEMO. Open a 1:1 with a second OMEMO client (Conversations on Android, or a second Fluux desktop instance). Send a message; confirm:
- the composer shows the OMEMO lock (protocol `omemo:2`),
- the peer receives and decrypts it (readable body),
- an inbound message from the peer decrypts and shows the OMEMO lock.

- [ ] **Step 3: Restart persistence (the sealed-store payoff)**

Fully quit and relaunch the desktop app. Reopen the same conversation. Confirm:
- the OMEMO identity is NOT regenerated (same fingerprint; no re-publish churn),
- the established session still decrypts new inbound messages and encrypts outbound (no "broken session" / re-handshake needed),
- inspect the app data dir: `e2ee-store/<jid>.json` exists and its values are **sealed** (not readable plaintext), and the master key is in the OS keychain (or the 0600 `.mk` fallback with the UI warning shown on a keychain-less host).

- [ ] **Step 4: Record the result** in `m2b-manual-verification.md` (client used, server, screenshots/notes, pass/fail per check) and commit.

```bash
git add docs/superpowers/plans/m2b-manual-verification.md
git commit --no-gpg-sign -m "docs(omemo): M2b manual desktop verification record"
```

---

## Self-Review

**Spec coverage:**
- Registration refactor (multi-plugin, omemoEnabled gate) → Tasks 4, 5. ✓
- EME namespace map + omemo:2 i18n → Task 6. ✓
- Tier-1 Rust keychain StorageBackend (generic, sealed, per-account, fallback) → Tasks 1, 2; TS adapter → Task 3. ✓
- Coexistence (auto-prefer via securityLevel — no SDK change) + protocol-switch notice → Tasks 7, 9. ✓
- Composer/lock generalization (selected-plugin, OMEMO trust) → Task 8; per-message lock already generic (only i18n, Task 6). ✓
- Restart persistence + keychain-absent fallback + sealed-at-rest → Tasks 1, 10. ✓
- Manual E2E gate → Task 10. ✓
- Out of scope (web OMEMO, per-device verification UI/M2c, Tier-2 engine) → absent. ✓

**Placeholder scan:** Task 6 Step 1 and Task 8 Step 1 contain deliberately-marked *test-wiring* placeholders (the map is module-private → export `emePluginIdFor` and test that; the hook's manager-mock harness must be copied from the existing test) — each says exactly what to substitute and the load-bearing implementation (Steps 2) is complete. No other TODO/TBD.

**Type consistency:** `TauriKeychainStorageBackend` implements the SDK `StorageBackend` (get/put/delete/list) used by Task 5; the four Tauri command names (`e2ee_store_get/put/delete/list`) match between Task 2 (Rust), Task 3 (TS), and Task 10; `omemoEnabled`/`isOmemoEnabled` consistent across Tasks 4, 5, 8, 9; `useProtocolSwitchStore.recordSelected/pendingNotice/dismiss` consistent across Tasks 7, 8, 9; plugin id `omemo:2` consistent throughout.

**Known execution risks:**
1. `keyring` v3 binary-secret API (`get_secret`/`set_secret`) vs string (`get_password`/`set_password`) — Task 1 note says verify + base64 through the string API if needed.
2. `base64`/`rand`/`tempfile` crate availability in `Cargo.toml` — Task 1/2 say verify + add.
3. `manager.selectStrategy` is async and probes PEP — Task 8 must await it and key the effect on the capability-cache/`pluginRegisteredAt` so it re-runs after registration (mirror the existing hook's probe effect).
4. The single-`setE2EEStorageBackend` contention (OpenPGP-web vs OMEMO) — non-issue in this slice (OMEMO is Tauri-only, SequoiaPgp ignores ctx.storage), documented in Task 5.
5. Task 10 is a manual gate — not CI-gated; the sealed-store + restart-persistence checks are the load-bearing acceptance criteria.
