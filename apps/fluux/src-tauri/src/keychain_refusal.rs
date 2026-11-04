//! What a secret store reports about the user's refusal of the old keychain
//! items that unlock an account's key (FLM-304).
//!
//! Only the macOS secret store keeps refusals. This module builds on every
//! platform so the OpenPGP key storage can answer "none held" where there is
//! no keychain to refuse.

/// What this launch's cached answers say about the user's refusal of the old
/// items that unlock an account's key. Asking never reads the keychain.
// Only the macOS store holds or waits on a refusal; elsewhere nothing is held.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalState {
    /// No refusal is held, so nothing is left to ask again.
    NotHeld,
    /// The user refused the items this launch, and nothing has read them since.
    Held,
    /// A keychain read is under way, perhaps an earlier retry still waiting on
    /// the user's answer. Its outcome decides, so neither answer holds yet.
    Pending,
}

/// What one explicit retry of a refused keychain read found.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusedRetry {
    /// This launch held no refusal for the account, so nothing was read.
    NothingRefused,
    /// The OS was asked again and the items were read.
    Read,
    /// The user refused again. That answer is kept like the first one.
    RefusedAgain,
}
