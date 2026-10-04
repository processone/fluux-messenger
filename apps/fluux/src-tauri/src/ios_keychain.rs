//! Generic password items in the iOS keychain.
//!
//! Items are readable after the first unlock following a restart, so the app
//! can reconnect while it runs in the background with the device locked, and
//! never leave this device through a backup or iCloud Keychain.

use crate::credentials::SecretStore;
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::base::Error;
use security_framework::passwords::{
    delete_generic_password_options, generic_password, set_generic_password_options,
    PasswordOptions,
};
use security_framework_sys::base::errSecItemNotFound;

const SERVICE: &str = "net.processone.fluux";

pub struct IosKeychain;

fn describe(e: Error) -> String {
    format!("Keychain error {}: {e}", e.code())
}

impl SecretStore for IosKeychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match generic_password(PasswordOptions::new_generic_password(SERVICE, account)) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|e| format!("Keychain item is not UTF-8: {e}")),
            Err(e) if e.code() == errSecItemNotFound => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    /// Replaces any existing item, so every item carries this accessibility.
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.delete(account)?;
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
            0,
        )
        .map_err(describe)?;
        let mut options = PasswordOptions::new_generic_password(SERVICE, account);
        options.set_access_control(access);
        set_generic_password_options(secret.as_bytes(), options).map_err(describe)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match delete_generic_password_options(PasswordOptions::new_generic_password(SERVICE, account)) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == errSecItemNotFound => Ok(()),
            Err(e) => Err(describe(e)),
        }
    }
}
