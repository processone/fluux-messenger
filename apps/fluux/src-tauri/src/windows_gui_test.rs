//! Bootstrap isolation for the unsigned Windows GUI smoke, before plugins or storage open.
#[cfg(not(all(target_os = "windows", debug_assertions, feature = "production-tls")))]
compile_error!("windows-gui-test requires a Windows debug build with production-tls");

fn validate_profile(identifier: &str, token: &str, roots: &[std::path::PathBuf]) {
    assert_eq!(identifier, "net.processone.fluux.dev.gui-test");
    assert!(!token.is_empty());
    assert_eq!(roots.len(), 2);
    for base in roots {
        let path = base.join(identifier);
        assert_eq!(
            std::fs::read_to_string(path.join(".gui-test-owner"))
                .expect("native data directory ownership marker"),
            token,
            "the harness must exclusively provision both native data directories"
        );
    }
}

pub fn initialize(identifier: &str) {
    let token = std::env::var("FLUUX_GUI_TEST_TOKEN")
        .expect("launch the disposable build through the Windows GUI harness");
    validate_profile(
        identifier,
        &token,
        &[
            dirs::data_dir().expect("Windows roaming application data folder"),
            dirs::data_local_dir().expect("Windows local application data folder"),
        ],
    );
    // The default builder is process-global: install it before any startup task or IPC can read secrets.
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Profile {
        path: PathBuf,
        roots: Vec<PathBuf>,
        identifier: String,
        token: String,
    }
    impl Profile {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("fluux-gui-gate-{}", uuid::Uuid::new_v4()));
            let roots = vec![path.join("Roaming"), path.join("Local")];
            let identifier = serde_json::from_str::<serde_json::Value>(include_str!(
                "../tauri.windows-gui.conf.json"
            ))
            .unwrap()["identifier"]
                .as_str()
                .unwrap()
                .to_owned();
            let token = uuid::Uuid::new_v4().to_string();
            let profile = Self {
                path,
                roots,
                identifier,
                token,
            };
            profile.provision(&profile.identifier);
            profile
        }
        fn provision(&self, identifier: &str) {
            for root in &self.roots {
                std::fs::create_dir_all(root.join(identifier)).unwrap();
                std::fs::write(root.join(identifier).join(".gui-test-owner"), &self.token).unwrap();
            }
        }
    }
    impl Drop for Profile {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.path).unwrap();
        }
    }

    #[test]
    fn launcher_owned_profile_is_accepted() {
        let profile = Profile::new();
        assert!(std::panic::catch_unwind(|| {
            validate_profile(&profile.identifier, &profile.token, &profile.roots)
        })
        .is_ok());
    }

    #[test]
    fn installed_and_dev_identities_are_rejected_even_with_valid_markers() {
        let profile = Profile::new();
        for config in [
            include_str!("../tauri.conf.json"),
            include_str!("../tauri.dev.conf.json"),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let identifier = config["identifier"].as_str().unwrap();
            profile.provision(identifier);
            assert!(std::panic::catch_unwind(|| validate_profile(
                identifier,
                &profile.token,
                &profile.roots
            ))
            .is_err());
        }
    }

    #[test]
    fn foreign_or_missing_native_marker_is_rejected() {
        let profile = Profile::new();
        let marker = profile.roots[1]
            .join(&profile.identifier)
            .join(".gui-test-owner");
        std::fs::write(&marker, uuid::Uuid::new_v4().to_string()).unwrap();
        assert!(std::panic::catch_unwind(|| validate_profile(
            &profile.identifier,
            &profile.token,
            &profile.roots
        ))
        .is_err());
        std::fs::remove_file(marker).unwrap();
        assert!(std::panic::catch_unwind(|| validate_profile(
            &profile.identifier,
            &profile.token,
            &profile.roots
        ))
        .is_err());
    }
}
