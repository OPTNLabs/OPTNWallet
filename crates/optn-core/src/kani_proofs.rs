//! Bounded formal checks for parser primitives.
//!
//! These harnesses are compiled only by Kani. They assert safety properties
//! over all possible fixed-size inputs rather than sampled examples.

use crate::cashaddr::convert_bits;

#[kani::proof]
fn cashaddr_bytes_to_base32_never_panics() {
    let bytes: [u8; 8] = kani::any();
    let encoded = convert_bits(&bytes, 8, 5, true);
    assert!(encoded.is_some());
}

#[kani::proof]
fn cashaddr_valid_base32_input_never_panics() {
    let values: [u8; 8] = kani::any();
    for value in values {
        kani::assume(value < 32);
    }
    let _ = convert_bits(&values, 5, 8, false);
}
