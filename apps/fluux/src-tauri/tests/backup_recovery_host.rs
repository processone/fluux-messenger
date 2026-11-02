//! FLM-343: opt-in, unsigned native app journey. This executable includes the
//! production OpenPGP commands with test-only storage constructors. There is no
//! OS credential store, signing or installed application access.
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
            if a != "secrets-fresh-v1" && self.read_items().contains_key(a) {
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
    }

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
        let fresh = fixture.raw.fresh_accounts().map_err(|e| e.to_string())?;
        if fresh != ["openpgp_passphrase:you@fluux.chat"] {
            return Err("wrong fresh account route".into());
        }
        let old = fixture.raw.read_items();
        if old
            .get("openpgp_passphrase:bob@example.com")
            .map(String::as_str)
            != Some("b3RoZXI=")
            || old.get("last_user").map(String::as_str) != Some("fixture-only")
            || old
                .get("openpgp_passphrase:you@fluux.chat")
                .map(String::as_str)
                != Some("b2xk")
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
                .any(|line| line.starts_with("read ") && line != "read secrets-fresh-v1")
        {
            return Err("restart read an old item".into());
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
        };
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "net.processone.fluux.recovery-test".into();
        context.config_mut().build.dev_url = Some("http://127.0.0.1:5197".parse().unwrap());
        context.config_mut().app.windows.clear();
        tauri::Builder::default().manage(state).manage(fixture)
            .invoke_handler(tauri::generate_handler![get_credentials, recovery_checkpoint, recovery_ciphertext, recovery_failure,
                openpgp::openpgp_ensure_key, openpgp::openpgp_has_persisted_key,
                openpgp::openpgp_backup_import_all, openpgp::openpgp_backup_import_selected,
                openpgp::openpgp_validate_cert, openpgp::openpgp_encrypt, openpgp::openpgp_decrypt])
            .setup(move |app| {
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External("http://127.0.0.1:5197/demo.html?tutorial=false&e2ee=recovery".parse().unwrap()))
                    .initialization_script(format!("window.__FLUUX_RECOVERY_RESTART__ = {}; window.__FLUUX_RECOVERY_META__ = {}; window.__FLUUX_RECOVERY_SOURCE__ = {};", restart, metadata(), serde_json::to_string(&std::env::var("FLUUX_RECOVERY_SOURCE").unwrap_or_else(|_| "server".into())).unwrap()))
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
