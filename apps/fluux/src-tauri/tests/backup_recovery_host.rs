//! FLM-343: opt-in, unsigned native app journey. This executable includes the
//! production OpenPGP commands with test-only storage constructors. There is no
//! OS credential store, signing or installed application access.
//! FLM-304 adds the `retry` journey: the user's explicit retry of a refused
//! keychain read from the Settings Advanced panel, and `retry-desync`: the same
//! retry inside the startup identity choice, for a key whose combined item holds
//! a stale passphrase and whose refused old item holds the real one.
#![allow(dead_code)]
#[cfg(not(test))]
compile_error!("the recovery host requires test-only storage constructors");
#[path = "../src/credentials.rs"]
mod credentials;
#[path = "../src/keychain_refusal.rs"]
mod keychain_refusal;
#[path = "../src/macos_secrets.rs"]
mod macos_secrets;
// Its iOS-only test imports are unused in this macOS-only GUI harness.
#[allow(unused_imports)]
#[path = "../src/openpgp.rs"]
mod openpgp;
#[path = "../src/openpgp_backup.rs"]
mod openpgp_backup;
#[path = "../src/openpgp_storage.rs"]
mod openpgp_storage;

#[cfg(target_os = "macos")]
mod host {
    use super::*;
    use credentials::SecretStore;
    use macos_secrets::{Backend, Secrets, StoreError};
    use std::{
        collections::BTreeMap,
        fs,
        path::PathBuf,
        sync::{Arc, Condvar, Mutex},
    };
    const JID: &str = "you@fluux.chat";
    fn metadata() -> serde_json::Value {
        serde_json::from_str(include_str!("../../src/e2ee/fixtures/sequoia_meta.json")).unwrap()
    }

    #[derive(Clone)]
    struct Files {
        root: PathBuf,
        lock: Arc<Mutex<()>>,
        /// FLM-408 R4: while set, a read waits like a macOS prompt the user
        /// has not answered yet.
        prompt: Arc<(Mutex<bool>, Condvar)>,
        source: String,
    }
    impl Files {
        fn set_prompt_open(&self, open: bool) {
            let (lock, answered) = &*self.prompt;
            *lock.lock().unwrap() = open;
            answered.notify_all();
        }
        /// FLM-304: set by the journey between its two retries; stands in for
        /// the user allowing the macOS prompt. Without it every old item is refused.
        fn granted(&self) -> bool {
            self.root.join("keychain-granted").is_file()
        }
        fn read_items(&self) -> BTreeMap<String, String> {
            serde_json::from_slice(&fs::read(self.root.join("fixture-items.json")).unwrap())
                .unwrap()
        }
        fn audit(&self, operation: &str, account: &str) {
            use std::io::Write;
            writeln!(
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.root.join("operations.log"))
                    .unwrap(),
                "{operation} {account}"
            )
            .unwrap();
        }
    }
    impl SecretStore for Files {
        fn get(&self, a: &str) -> Result<Option<String>, String> {
            Ok(self.read_items().get(a).cloned())
        }
        fn set(&self, a: &str, value: &str) -> Result<(), String> {
            let _lock = self.lock.lock().unwrap();
            self.audit("set", a);
            let mut items = self.read_items();
            items.insert(a.into(), value.into());
            fs::write(
                self.root.join("fixture-items.json"),
                serde_json::to_vec(&items).unwrap(),
            )
            .map_err(|e| e.to_string())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.audit("delete", account);
            Err("fixture refuses deletion".into())
        }
    }
    impl Backend for Files {
        fn read(&self, a: &str) -> Result<Option<String>, StoreError> {
            self.audit("read", a);
            // Items written before the app ran ask the user, who refuses
            // unless the journey granted access; the app's own bundle item
            // asks nothing.
            if a != "secrets-fresh-v1" && a != "secrets-v1" && self.read_items().contains_key(a) {
                if self.source.starts_with("migration-") {
                    let failed = if self.source == "migration-login" {
                        JID
                    } else {
                        "mcp-token"
                    };
                    if a != failed || self.granted() {
                        return self.get(a).map_err(Into::into);
                    }
                    return Err(if self.source == "migration-transient" {
                        "injected transient legacy read failure".into()
                    } else {
                        StoreError::denied()
                    });
                }
                let (lock, answered) = &*self.prompt;
                drop(answered.wait_while(lock.lock().unwrap(), |open| *open).unwrap());
                if !self.granted() {
                    return Err(StoreError::denied());
                }
            }
            self.get(a).map_err(Into::into)
        }
        fn accounts(&self) -> Result<Vec<String>, StoreError> {
            Ok(self.read_items().keys().cloned().collect())
        }
        fn fresh_accounts(&self) -> Result<Vec<String>, StoreError> {
            match fs::read(self.root.join("fresh-accounts.json")) {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string().into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
                Err(e) => Err(e.to_string().into()),
            }
        }
        fn mark_fresh_account(&self, a: &str) -> Result<(), StoreError> {
            self.audit("mark", a);
            let mut accounts = self.fresh_accounts()?;
            if !accounts.contains(&a.to_string()) {
                accounts.push(a.into())
            }
            fs::write(
                self.root.join("fresh-accounts.json"),
                serde_json::to_vec(&accounts).unwrap(),
            )
            .map_err(|e| e.to_string().into())
        }
    }
    struct Fixture {
        root: PathBuf,
        state: Arc<openpgp::OpenpgpState>,
        raw: Files,
        restart: bool,
        source: String,
        secrets: Arc<Secrets<Files>>,
    }
    const OLD_ITEMS: [&str; 3] = [
        "last_user",
        "openpgp_passphrase:bob@example.com",
        "openpgp_passphrase:you@fluux.chat",
    ];

    #[tauri::command]
    fn recovery_ciphertext(fixture: tauri::State<'_, Fixture>) -> String {
        fs::read_to_string(fixture.root.join("original-ciphertext.asc")).unwrap()
    }
    #[tauri::command]
    fn recovery_failure(app: tauri::AppHandle, reason: String) {
        eprintln!("Native recovery journey failed: {reason}");
        app.exit(1);
    }
    #[tauri::command]
    fn get_credentials() -> Option<credentials::StoredCredentials> {
        None
    }
    /// FLM-304: marks a step of the retry journey in the operations log. While
    /// the key is locked, nothing may rewrite its file; the first successful
    /// unlock may re-save it once to clear an expiry (same key).
    #[tauri::command]
    fn recovery_note(fixture: tauri::State<'_, Fixture>, label: String) -> Result<(), String> {
        let unlocked = fixture.state.keychain_retry_available(JID)
            == Ok(openpgp::KeychainRetryAvailability::Unlocked);
        let key = fs::read(fixture.root.join("keys/openpgp/you@fluux.chat.tsk.asc"))
            .map_err(|e| e.to_string())?;
        if !unlocked
            && key != fs::read(fixture.root.join("initial-key.asc")).map_err(|e| e.to_string())?
        {
            return Err(format!("the key file changed before {label}"));
        }
        fixture.raw.audit("note", &label);
        Ok(())
    }
    /// FLM-304: the user allows the next macOS prompt.
    #[tauri::command]
    fn recovery_grant_keychain(fixture: tauri::State<'_, Fixture>) -> Result<(), String> {
        fixture.raw.audit("grant", "keychain");
        fs::write(fixture.root.join("keychain-granted"), b"granted").map_err(|e| e.to_string())
    }

    /// FLM-408 R4: the next macOS prompt stays open until the user answers.
    #[tauri::command]
    fn recovery_hold_keychain(fixture: tauri::State<'_, Fixture>) {
        fixture.raw.audit("hold", "keychain");
        fixture.raw.set_prompt_open(true);
    }
    /// FLM-408 R4: the user answers the open prompt; without a grant, a refusal.
    #[tauri::command]
    fn recovery_answer_keychain(fixture: tauri::State<'_, Fixture>) {
        fixture.raw.audit("answer", "keychain");
        fixture.raw.set_prompt_open(false);
    }

    /// Old items read in each part of the retry journey, split at its notes.
    fn old_reads_by_step(operations: &str) -> Vec<(String, Vec<String>)> {
        let mut steps = vec![("startup".to_string(), Vec::new())];
        for line in operations.split("phase restart\n").next().unwrap().lines() {
            if let Some(label) = line.strip_prefix("note ") {
                steps.push((label.into(), Vec::new()));
            } else if let Some(item) = line.strip_prefix("read ") {
                if OLD_ITEMS.contains(&item) {
                    steps.last_mut().unwrap().1.push(item.into());
                }
            }
        }
        steps
    }

    #[tauri::command]
    async fn recovery_checkpoint(
        app: tauri::AppHandle,
        fixture: tauri::State<'_, Fixture>,
        fingerprint: String,
    ) -> Result<String, String> {
        if fingerprint != metadata()["aliceFingerprint"].as_str().unwrap() {
            return Err("wrong restored fingerprint".into());
        }
        let bundle = fixture
            .state
            .ensure_key(JID.into(), format!("xmpp:{JID}"))
            .await?;
        if bundle.fingerprint != metadata()["aliceFingerprint"].as_str().unwrap() {
            return Err("native identity does not match UI".into());
        }
        let ciphertext = fs::read_to_string(fixture.root.join("original-ciphertext.asc"))
            .map_err(|e| e.to_string())?;
        let decrypted = fixture
            .state
            .decrypt(JID, &ciphertext, &[])
            .map_err(|e| e.to_string())?;
        if !decrypted
            .plaintext
            .contains(metadata()["plaintext"].as_str().unwrap())
        {
            return Err("decrypt mismatch".into());
        }
        if fixture.source.starts_with("migration-") {
            let count = fs::read_to_string(fixture.root.join("operations.log"))
                .unwrap()
                .lines()
                .filter(|line| line.starts_with("read "))
                .count();
            for _ in 0..3 {
                let login = credentials::load(&*fixture.secrets);
                if !fixture.restart && fixture.source == "migration-login" {
                    assert!(login.is_err());
                } else {
                    assert_eq!(login.unwrap().unwrap().jid, JID);
                }
                let token = fixture.secrets.get("mcp-token");
                if !fixture.restart && fixture.source != "migration-login" {
                    assert!(token.is_err());
                } else {
                    assert_eq!(token.unwrap().as_deref(), Some("fixture-token"));
                }
                assert_eq!(
                    fixture
                        .state
                        .ensure_key(JID.into(), format!("xmpp:{JID}"))
                        .await?
                        .fingerprint,
                    fingerprint
                );
            }
            let after = fs::read_to_string(fixture.root.join("operations.log")).unwrap();
            assert_eq!(
                after
                    .lines()
                    .filter(|line| line.starts_with("read "))
                    .count(),
                count
            );
            let current = fixture.raw.read_items();
            let initial: BTreeMap<String, String> =
                serde_json::from_slice(&fs::read(fixture.root.join("initial-items.json")).unwrap())
                    .unwrap();
            for (name, value) in initial {
                assert_eq!(current.get(&name), Some(&value));
            }
            assert_eq!(current.contains_key("secrets-v1"), fixture.restart);
            fs::write(
                fixture.root.join("keychain-granted"),
                b"next launch can read every item",
            )
            .unwrap();
            let phase = if fixture.restart {
                "restart"
            } else {
                "restore"
            };
            fs::write(fixture.root.join(format!("{phase}-passed")), b"passed").unwrap();
            println!("{} {phase}: actual App unlocked the existing key and decrypted the waiting message; native credential/token consumers isolate the failed secret, repeated calls read nothing; originals unchanged", fixture.source);
            app.exit(0);
            return Ok(phase.into());
        }
        let retry = fixture.source.starts_with("retry");
        let fresh = fixture.raw.fresh_accounts().map_err(|e| e.to_string())?;
        // The retry unlocks the existing key; it never restores into fresh items.
        let expected_fresh: &[&str] = if retry {
            &[]
        } else {
            &["openpgp_passphrase:you@fluux.chat"]
        };
        if fresh != expected_fresh {
            return Err("wrong fresh account route".into());
        }
        let old = fixture.raw.read_items();
        let initial: BTreeMap<String, String> = serde_json::from_slice(
            &fs::read(fixture.root.join("initial-items.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if OLD_ITEMS
            .iter()
            .any(|item| old.get(*item) != initial.get(*item))
            || old.get("last_user").map(String::as_str) != Some("fixture-only")
        {
            return Err("another account or credential changed".into());
        }
        let phase = if fixture.restart {
            "restart"
        } else {
            "restore"
        };
        let operations = fs::read_to_string(fixture.root.join("operations.log")).unwrap();
        if operations.lines().any(|line| line.starts_with("delete ")) {
            return Err("recovery attempted a deletion".into());
        }
        if fixture.restart {
            let restarted_old: Vec<_> = operations
                .split("phase restart\n")
                .last()
                .unwrap()
                .lines()
                .filter_map(|line| line.strip_prefix("read "))
                .filter(|item| OLD_ITEMS.contains(item))
                .collect();
            // FLM-86: the first launch retained a partial legacy snapshot.
            // Restart can now migrate all originals; restored/desynced layouts
            // already have a durable bundle and still read no originals.
            let expected: &[&str] = if fixture.source == "retry" {
                &OLD_ITEMS
            } else {
                &[]
            };
            if restarted_old != expected {
                return Err(format!("wrong restart legacy reads: {restarted_old:?}"));
            }
        }
        // FLM-304: once a restore routes the account to fresh storage, nothing
        // reads an old item again, including the driver's direct retry request.
        if !retry {
            let restore = operations.split("phase restart\n").next().unwrap();
            let Some((_, after_route)) = restore.split_once("\nmark ") else {
                return Err("the restore never routed the account to fresh storage".into());
            };
            if after_route.lines().any(|line| {
                line.strip_prefix("read ")
                    .is_some_and(|item| OLD_ITEMS.contains(&item))
            }) {
                return Err("an old item was read after the restore".into());
            }
        }
        // FLM-304: one refused read at startup, then one OS request per click.
        // Before each click, a prewarm, the normal unlock, the App's
        // registration of a new plugin, a reconnect and the panel shown again
        // (FLM-408 R3) each read nothing. recovery_note proved the key file
        // unchanged up to each step. FLM-86: first migration snapshots every
        // old item once; subsequent retries read only this key's item. FLM-408 R4:
        // after the first refusal, a press that outlives its time limit on an
        // open prompt reads once, and nothing reads while it waits or after
        // the user refuses that prompt. FLM-408 R5: from Settings, the user
        // allows the last press's prompt only after it timed out; its reads
        // unlock the key, and the press that then uses it reads nothing.
        if retry && !fixture.restart {
            let late_grant = fixture.source == "retry";
            let refused = vec![format!("openpgp_passphrase:{JID}")];
            let granted = refused.clone();
            let startup = if late_grant {
                OLD_ITEMS.map(String::from).to_vec()
            } else {
                refused.clone()
            };
            let mut expected = vec![("startup".to_string(), startup)];
            for press in [1, 2] {
                expected.extend(
                    ["prewarm", "unlock", "reregister", "reconnect", "panel"]
                        .map(|step| (format!("{step}-{press}"), Vec::new())),
                );
                if press == 1 {
                    expected.push(("click-1".into(), refused.clone()));
                    expected.push(("timeout-1".into(), refused.clone()));
                    expected.push(("answered-1".into(), Vec::new()));
                } else if late_grant {
                    expected.push(("timeout-2".into(), granted.clone()));
                    expected.push(("ready-2".into(), Vec::new()));
                    expected.push(("click-2".into(), Vec::new()));
                } else {
                    expected.push(("click-2".into(), granted.clone()));
                }
            }
            let steps = old_reads_by_step(&operations);
            if steps != expected {
                return Err(format!("old items read outside an explicit retry: {steps:?}"));
            }
        }
        fs::write(fixture.root.join(format!("{phase}-passed")), b"passed")
            .map_err(|e| e.to_string())?;
        println!("{phase}: UI fingerprint matches durable native identity; real crypto decrypt succeeded; old items, other accounts and credentials preserved; no deletion attempted");
        app.exit(0);
        Ok(phase.into())
    }

    pub fn run() {
        if !std::env::args().any(|a| a == "--run-recovery-host") {
            println!("Native recovery journey is opt-in; use its isolated launcher");
            return;
        }
        let home = PathBuf::from(std::env::var_os("HOME").expect("scratch HOME"));
        assert!(
            home.join(".fluux-recovery-fixture").is_file(),
            "scratch HOME marker required"
        );
        assert_eq!(
            std::env::var_os("CFFIXED_USER_HOME"),
            Some(home.clone().into_os_string())
        );
        let root = home.join("recovery");
        fs::create_dir_all(&root).unwrap();
        let restart = root.join("restore-passed").exists();
        let source = std::env::var("FLUUX_RECOVERY_SOURCE").unwrap_or_else(|_| "server".into());
        assert!([
            "server",
            "file",
            "retry",
            "retry-desync",
            "migration-login",
            "migration-mcp",
            "migration-transient"
        ]
        .contains(&source.as_str()));
        let raw = Files {
            root: root.clone(),
            lock: Arc::new(Mutex::new(())),
            prompt: Arc::new((Mutex::new(false), Condvar::new())),
            source: source.clone(),
        };
        if !root.join("fixture-items.json").exists() {
            fs::write(root.join("fixture-items.json"), br#"{"openpgp_passphrase:you@fluux.chat":"b2xk","openpgp_passphrase:bob@example.com":"b3RoZXI=","last_user":"fixture-only"}"#).unwrap();
            let initial = Arc::new(openpgp::OpenpgpState::for_testing(root.join("keys")));
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(initial.import_backup(
                JID.into(),
                include_str!("../../src/e2ee/fixtures/sequoia_alice_backup.asc").into(),
                metadata()["backupPassphrase"].as_str().unwrap().into(),
                false,
            ))
            .unwrap();
            let original = rt
                .block_on(initial.ensure_key(JID.into(), format!("xmpp:{JID}")))
                .unwrap();
            let envelope = format!("<signcrypt xmlns='urn:xmpp:openpgp:0'><to jid='ava@fluux.chat'/><time stamp='2026-01-01T00:00:00Z'/><rpad>fixture</rpad><payload xmlns='jabber:client'><body>{}</body></payload></signcrypt>", metadata()["plaintext"].as_str().unwrap());
            let ciphertext = initial
                .encrypt(JID, &[original.public_armored], &envelope)
                .unwrap();
            fs::write(root.join("original-ciphertext.asc"), ciphertext).unwrap();
            if source.starts_with("retry") || source.starts_with("migration-") {
                // FLM-304: the old keychain item holds this key's real
                // passphrase, so only a granted read of it unlocks the key.
                let pass = root.join("keys").join("openpgp").join(format!("{JID}.pass"));
                let mut items = raw.read_items();
                items.insert(
                    format!("openpgp_passphrase:{JID}"),
                    fs::read_to_string(&pass).unwrap().trim().into(),
                );
                if source.starts_with("migration-") {
                    items.insert("last_user".into(), JID.into());
                    items.insert(
                        JID.into(),
                        serde_json::to_string(&credentials::StoredCredentials {
                            jid: JID.into(),
                            password: "fixture-password".into(),
                            server: None,
                        })
                        .unwrap(),
                    );
                    items.insert("mcp-token".into(), "fixture-token".into());
                }
                if source == "retry-desync" {
                    // The combined item exists, so nothing migrates, and its
                    // stale passphrase leaves the key desynced.
                    items.insert(
                        "secrets-v1".into(),
                        serde_json::json!({"version": 1, "items": {format!("openpgp_passphrase:{JID}"): "b2xk"}}).to_string(),
                    );
                }
                fs::write(root.join("fixture-items.json"), serde_json::to_vec(&items).unwrap()).unwrap();
                fs::remove_file(pass).unwrap();
            }
            fs::copy(root.join("fixture-items.json"), root.join("initial-items.json")).unwrap();
            fs::copy(
                root.join("keys/openpgp/you@fluux.chat.tsk.asc"),
                root.join("initial-key.asc"),
            )
            .unwrap();
        }
        let secrets = Arc::new(Secrets::new(raw.clone()));
        let storage =
            openpgp_storage::KeyStorage::for_testing_with_store(root.join("keys"), secrets.clone());
        let state = Arc::new(openpgp::OpenpgpState::for_testing_with_storage(storage));
        raw.audit("phase", if restart { "restart" } else { "restore" });
        let fixture = Fixture {
            root: root.clone(),
            state: state.clone(),
            raw,
            restart,
            source: source.clone(),
            secrets,
        };
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "net.processone.fluux.recovery-test".into();
        context.config_mut().build.dev_url = Some("http://127.0.0.1:5197".parse().unwrap());
        context.config_mut().app.windows.clear();
        tauri::Builder::default().manage(state).manage(fixture)
            .invoke_handler(tauri::generate_handler![get_credentials, recovery_checkpoint, recovery_ciphertext, recovery_failure,
                recovery_note, recovery_grant_keychain, recovery_hold_keychain, recovery_answer_keychain,
                openpgp::openpgp_ensure_key, openpgp::openpgp_prewarm, openpgp::openpgp_has_persisted_key,
                openpgp::openpgp_keychain_retry_available, openpgp::openpgp_retry_keychain_access,
                openpgp::openpgp_backup_import_all, openpgp::openpgp_backup_import_selected,
                openpgp::openpgp_validate_cert, openpgp::openpgp_encrypt, openpgp::openpgp_decrypt])
            .setup(move |app| {
                // The retry is offered only when the server has no backup.
                let url = format!("http://127.0.0.1:5197/demo.html?tutorial=false&e2ee=recovery{}", if source.starts_with("retry") { "&recoveryBackup=absent" } else { "" });
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url.parse().unwrap()))
                    .initialization_script(format!("window.__FLUUX_RECOVERY_RESTART__ = {}; window.__FLUUX_RECOVERY_META__ = {}; window.__FLUUX_RECOVERY_SOURCE__ = {};", restart, metadata(), serde_json::to_string(&source).unwrap()))
                    .initialization_script(format!("window.__FLUUX_RECOVERY_EXPECTED_BUILD__ = {};", serde_json::to_string(&std::env::var("FLUUX_RECOVERY_BUILD").expect("run the recovery launcher to identify its app build")).unwrap()))
                     .initialization_script(include_str!("backup_recovery_driver.js"))
                    .title("Fluux isolated recovery fixture").inner_size(1280.0, 800.0)
                    .data_store_identifier(*b"fluux-recovery01")
                    .build()?;
                Ok(())
            }).run(context).expect("isolated native recovery host");
    }
}
fn main() {
    #[cfg(target_os = "macos")]
    host::run();
}
