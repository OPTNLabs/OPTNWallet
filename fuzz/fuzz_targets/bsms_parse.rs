#![no_main]

//! BSMS 1.0 setup records, as Paytaca and other wallets exchange them.
//!
//! A whole file rather than one line, so there is more framing to get wrong:
//! a version, a descriptor, path restrictions, and the first address the
//! policy produces. That last line is the format's own integrity check, and
//! the property worth fuzzing is that a record which parses is still one whose
//! policy can be checked -- never a usable wallet nobody verified.

use libfuzzer_sys::fuzz_target;
use optn_core::multisig::parse_bsms_record;

fuzz_target!(|data: &[u8]| {
    let Ok(candidate) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(record) = parse_bsms_record(candidate) {
        assert_eq!(record.version, "1.0", "only 1.0 is read");
        assert!(!record.path_restrictions.is_empty());
        assert!(
            !record.first_address.trim().is_empty(),
            "a record with no first address cannot be checked against its policy"
        );
        assert!(record.descriptor.keys.len() >= 2);

        // Deriving must not panic either. Whether it agrees is the caller's
        // business; that it answers at all is this target's.
        let _ = record.verify_first_address(optn_core::network::Network::Chipnet);
    }
});
