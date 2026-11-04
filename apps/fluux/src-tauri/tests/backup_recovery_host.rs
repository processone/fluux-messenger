//! FLM-343: opt-in, unsigned native app journey. This executable includes the
//! production OpenPGP commands with test-only storage constructors. There is no
//! OS credential store, signing or installed application access.
//! FLM-304 adds the `retry` journey: the user's explicit retry of a refused
//! keychain read from the Settings Advanced panel.
#![allow(dead_code)]
#[cfg(not(test))]
compile_error!("the recovery host requires test-only storage constructors");
#[path = "../src/credentials.rs"]
mod credentials;
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
        sync::{Arc, Mutex},
    };
    const JID: &str = "you@fluux.chat";
    fn metadata() -> serde_json::Value {
        serde_json::from_str(include_str!("../../src/e2ee/fixtures/sequoia_meta.json")).unwrap()
    }

    #[derive(Clone)]
    struct Files {
        root: PathBuf,
        lock: Arc<Mutex<()>>,
    }
    impl Files {
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
            // Items written before the app ran are refused; the app's own
            // bundle item is not.
            if a != "secrets-fresh-v1"
                && a != "secrets-v1"
                && !self.granted()
                && self.read_items().contains_key(a)
            {
                return Err(StoreError::denied());
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
    /// FLM-304: marks a step of the retry journey in the operations log. Until
    /// the granted press, nothing may rewrite the locked key file; the first
    /// successful unlock may re-save it once to clear an expiry (same key).
    #[tauri::command]
    fn recovery_note(fixture: tauri::State<'_, Fixture>, label: String) -> Result<(), String> {
        let key = fs::read(fixture.root.join("keys/openpgp/you@fluux.chat.tsk.asc"))
            .map_err(|e| e.to_string())?;
        if key != fs::read(fixture.root.join("initial-key.asc")).map_err(|e| e.to_string())? {
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
        let retry = fixture.source == "retry";
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
        if fixture.restart
            && operations
                .split("phase restart\n")
                .last()
                .unwrap()
                .lines()
                .any(|line| {
                    line.strip_prefix("read ")
                        .is_some_and(|item| item != "secrets-fresh-v1" && (!retry || item != "secrets-v1"))
                })
        {
            return Err("restart read an old item".into());
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
        // FLM-304: one refused read at startup, then one OS request per click;
        // showing and opening the panel, or a normal unlock, reads nothing.
        // recovery_note proved the key file unchanged up to each press.
        if retry && !fixture.restart {
            let refused = vec!["last_user".to_string()];
            let expected = vec![
                ("startup".to_string(), refused.clone()),
                ("click-1".to_string(), refused),
                ("click-2".to_string(), OLD_ITEMS.map(String::from).to_vec()),
            ];
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
        assert!(["server", "file", "retry"].contains(&source.as_str()));
        let raw = Files {
            root: root.clone(),
            lock: Arc::new(Mutex::new(())),
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
            if source == "retry" {
                // FLM-304: the old keychain item holds this key's real
                // passphrase, so only a granted read of it unlocks the key.
                let pass = root.join("keys").join("openpgp").join(format!("{JID}.pass"));
                let mut items = raw.read_items();
                items.insert(
                    format!("openpgp_passphrase:{JID}"),
                    fs::read_to_string(&pass).unwrap().trim().into(),
                );
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
        let storage = openpgp_storage::KeyStorage::for_testing_with_store(
            root.join("keys"),
            Arc::new(Secrets::new(raw.clone())),
        );
        let state = Arc::new(openpgp::OpenpgpState::for_testing_with_storage(storage));
        raw.audit("phase", if restart { "restart" } else { "restore" });
        let fixture = Fixture {
            root: root.clone(),
            state: state.clone(),
            raw,
            restart,
            source: source.clone(),
        };
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "net.processone.fluux.recovery-test".into();
        context.config_mut().build.dev_url = Some("http://127.0.0.1:5197".parse().unwrap());
        context.config_mut().app.windows.clear();
        tauri::Builder::default().manage(state).manage(fixture)
            .invoke_handler(tauri::generate_handler![get_credentials, recovery_checkpoint, recovery_ciphertext, recovery_failure,
                recovery_note, recovery_grant_keychain,
                openpgp::openpgp_ensure_key, openpgp::openpgp_prewarm, openpgp::openpgp_has_persisted_key,
                openpgp::openpgp_keychain_retry_available, openpgp::openpgp_retry_keychain_access,
                openpgp::openpgp_backup_import_all, openpgp::openpgp_backup_import_selected,
                openpgp::openpgp_validate_cert, openpgp::openpgp_encrypt, openpgp::openpgp_decrypt])
            .setup(move |app| {
                // The retry is offered only when the server has no backup.
                let url = format!("http://127.0.0.1:5197/demo.html?tutorial=false&e2ee=recovery{}", if source == "retry" { "&recoveryBackup=absent" } else { "" });
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
