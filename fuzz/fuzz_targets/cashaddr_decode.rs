#![no_main]

use libfuzzer_sys::fuzz_target;
use optn_core::cashaddr::Address;

fuzz_target!(|data: &[u8]| {
    if let Ok(candidate) = std::str::from_utf8(data) {
        let _ = Address::decode(candidate);
    }
});
