//! Identity checks for the disposable startup lab.
//!
//! The lab binary refuses to run under the installed or Dev identities and
//! insists on an explicitly provisioned scratch HOME, so it can never touch a
//! real profile. The lab's fault switches live where the faults happen: the
//! in-memory secret store reads FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS and the
//! AppKit adapter reads FLUUX_STARTUP_LAB_STALL.
pub fn assert_identity(identifier: &str) {
    assert_eq!(
        identifier, "net.processone.fluux.startup-lab",
        "startup-recovery-lab refuses installed and Dev identities"
    );
    assert!(
        std::env::var_os("FLUUX_STARTUP_LAB_HOME").is_some(),
        "disposable lab must explicitly identify its scratch HOME"
    );
    assert_eq!(
        std::env::var_os("HOME"),
        std::env::var_os("FLUUX_STARTUP_LAB_HOME"),
        "lab HOME must be the explicitly provisioned disposable directory"
    );
}
