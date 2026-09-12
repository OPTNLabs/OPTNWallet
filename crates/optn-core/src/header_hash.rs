//! Pure BCH/Bitcoin double-SHA256 hashing used by header verification.

use sha2::{Digest, Sha256};

pub type Hash32 = [u8; 32];

/// SHA256(SHA256(bytes)). The returned bytes are the digest bytes as produced
/// by SHA-256; display/endian reversal belongs at serialization/UI boundaries.
pub fn sha256d(bytes: &[u8]) -> Hash32 {
    let first = Sha256::digest(bytes);
    Sha256::digest(first).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256d_is_stable() {
        assert_eq!(
            sha256d(b""),
            [
                0x5d, 0xf6, 0xe0, 0xe2, 0x76, 0x13, 0x59, 0xd3, 0x0a, 0x82, 0x75, 0x05, 0x8e, 0x29,
                0x9f, 0xcc, 0x03, 0x81, 0x53, 0x45, 0x45, 0xf5, 0x5c, 0xf4, 0x3e, 0x41, 0x98, 0x3f,
                0x5d, 0x4c, 0x94, 0x56,
            ]
        );
    }
}
