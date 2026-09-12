#![no_main]

//! `sh(sortedmulti(...))` descriptors arrive as text another wallet wrote.
//!
//! Misreading one does not fail loudly: it produces a *valid* wallet at
//! addresses that are not the ones the money is at, and the symptom is an
//! empty balance. So the parser refuses anything it does not understand
//! exactly, and this checks the other half of that promise -- that refusing
//! is what it does, rather than panicking, on input nobody thought of.

use libfuzzer_sys::fuzz_target;
use optn_core::multisig::{parse_descriptor, MAX_COSIGNERS};

fuzz_target!(|data: &[u8]| {
    let Ok(candidate) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(parsed) = parse_descriptor(candidate) {
        // Anything that parses has to satisfy what the type promises, or the
        // refusals elsewhere are decoration.
        assert!(parsed.keys.len() >= 2, "a multisig needs two cosigners");
        assert!(parsed.keys.len() <= MAX_COSIGNERS);
        assert!(parsed.required > 0);
        assert!(usize::from(parsed.required) <= parsed.keys.len());
        assert!(!parsed.branches.is_empty());

        // Two cosigners sharing a key would be an "m of n" that fewer people
        // than it claims can satisfy.
        let mut keys: Vec<&str> = parsed
            .keys
            .iter()
            .map(|key| key.account_xpub.as_str())
            .collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), before, "a parsed descriptor repeated a key");
    }
});
