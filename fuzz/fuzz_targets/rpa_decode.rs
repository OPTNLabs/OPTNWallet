#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(candidate) = std::str::from_utf8(data) {
        let _ = optn_core::rpa::decode(candidate);
    }
});
