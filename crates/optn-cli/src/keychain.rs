//! Recovery phrases in the operating system's keychain.
//!
//! Without this the phrase has to reach the process some other way, and the
//! two obvious ways are both bad: an argument lands in shell history and in
//! `ps` output where any other user on the machine can read it, and an
//! environment variable is inherited by every child process and is readable
//! from `/proc/<pid>/environ`. Stdin is safe but cannot be automated without
//! putting the phrase in a file.
//!
//! The keychain is the platform's answer to that, and it is a different one on
//! each: the Credential Manager on Windows, the Keychain on macOS, and the
//! kernel keyring on Linux. The kernel keyring rather than Secret Service —
//! Secret Service means dbus, dbus means C, and C means the cross-builds to
//! riscv64 and armv7 stop working.
//!
//! One consequence of the kernel keyring is worth knowing: it is held in kernel
//! memory for the session, not on disk, so on Linux a stored phrase does not
//! survive a reboot. That is a reasonable default for a secret, but it is
//! surprising if you expect a file, so `status` reports it.

use keyring::Entry;

use crate::error::{CliError, Result};
use crate::network::Network;

const SERVICE: &str = "optn-wallet";

/// Where a phrase is stored.
///
/// Keyed by network as well as profile: mainnet and chipnet phrases are
/// different secrets, and storing one over the other because they share a name
/// would silently replace a wallet holding real funds.
pub fn entry(network: Network, profile: &str) -> Result<Entry> {
    if profile.is_empty() {
        return Err(CliError::Usage("profile name cannot be empty".to_string()));
    }
    if !profile
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        // The name becomes an account identifier in a system store. Keeping it
        // to a known character set avoids arguing with three platforms about
        // what they accept.
        return Err(CliError::Usage(format!(
            "profile '{profile}' must be letters, digits, '-' or '_'"
        )));
    }
    let account = format!("{network}:{profile}");
    Entry::new(SERVICE, &account)
        .map_err(|e| CliError::Internal(format!("could not open the keychain: {e}")))
}

/// Store a phrase, replacing whatever was there.
pub fn store(network: Network, profile: &str, phrase: &str) -> Result<()> {
    let phrase = phrase.trim();
    if phrase.is_empty() {
        return Err(CliError::Usage(
            "refusing to store an empty phrase".to_string(),
        ));
    }
    entry(network, profile)?
        .set_password(phrase)
        .map_err(|e| CliError::Internal(format!("could not write to the keychain: {e}")))
}

/// Read a stored phrase, if there is one.
///
/// A missing entry is `None` rather than an error: callers fall back to other
/// sources, and "no entry" is not a failure.
pub fn load(network: Network, profile: &str) -> Result<Option<String>> {
    match entry(network, profile)?.get_password() {
        Ok(phrase) => Ok(Some(phrase)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CliError::Internal(format!(
            "could not read from the keychain: {e}"
        ))),
    }
}

/// Delete a stored phrase. Returns whether one was there.
pub fn remove(network: Network, profile: &str) -> Result<bool> {
    match entry(network, profile)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(CliError::Internal(format!(
            "could not delete from the keychain: {e}"
        ))),
    }
}

/// What the keychain is on this platform, and whether it survives a reboot.
pub fn backend() -> (&'static str, bool) {
    if cfg!(target_os = "windows") {
        ("Windows Credential Manager", true)
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        ("macOS Keychain", true)
    } else if cfg!(target_os = "linux") {
        // Kernel keyring: session-scoped, in kernel memory, gone on reboot.
        ("Linux kernel keyring", false)
    } else {
        ("unknown", false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_name_is_restricted_to_a_portable_character_set() {
        // The name becomes an account identifier in a platform store; three
        // operating systems disagree about what else is acceptable.
        assert!(entry(Network::Mainnet, "default").is_ok());
        assert!(entry(Network::Mainnet, "cold-storage_2").is_ok());
        assert!(entry(Network::Mainnet, "").is_err());
        assert!(entry(Network::Mainnet, "has space").is_err());
        assert!(entry(Network::Mainnet, "sla/sh").is_err());
    }

    #[test]
    fn an_empty_phrase_is_refused_before_it_reaches_the_store() {
        // Storing empty would overwrite a real phrase with nothing, and the
        // loss would only show up the next time the wallet was needed.
        assert!(store(Network::Chipnet, "default", "   ").is_err());
    }

    #[test]
    fn the_backend_is_named_and_its_persistence_stated() {
        let (name, persists) = backend();
        assert!(!name.is_empty());
        // On Linux the kernel keyring does not survive a reboot. Callers are
        // told rather than left to discover it.
        if cfg!(target_os = "linux") {
            assert!(!persists);
        }
    }
}
