//! Cross-output (XO) skeleton.
//!
//! XO is a 2026 VM contract family. It is not a P2PKH spend wrapper and does
//! not assume BIP44. Invitation engines, Wizard Connect, and template
//! execution are out of scope here.

/// A lock XO can spend. The template identity is opaque; it is not a P2PKH
/// script and it is not a derivation path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossOutputLock {
    /// Template identity. Opaque to this skeleton.
    pub template_id: [u8; 32],
    /// Template parameters. Not a BIP44 path.
    pub params: Vec<u8>,
}

impl CrossOutputLock {
    pub fn new(template_id: [u8; 32], params: Vec<u8>) -> Self {
        Self {
            template_id,
            params,
        }
    }

    /// XO does not require a P2PKH lock. P2PKH remains a wallet capability
    /// underneath, not a field this type needs.
    pub const fn requires_p2pkh() -> bool {
        false
    }

    /// XO does not require a BIP44 derivation path.
    pub const fn requires_bip44() -> bool {
        false
    }
}

/// Constructing an XO lock from a P2PKH script is refused.
pub fn lock_from_p2pkh(_script: &[u8]) -> Result<CrossOutputLock, &'static str> {
    Err("cross-output is not a P2PKH wrapper")
}

/// Constructing an XO lock from a BIP44 path is refused.
pub fn lock_from_bip44(_path: &str) -> Result<CrossOutputLock, &'static str> {
    Err("cross-output does not assume BIP44")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_xo_lock_is_not_a_p2pkh_or_bip44_wrapper() {
        let lock = CrossOutputLock::new([7u8; 32], b"template-params".to_vec());
        assert!(!CrossOutputLock::requires_p2pkh());
        assert!(!CrossOutputLock::requires_bip44());
        assert_eq!(lock.template_id, [7u8; 32]);
        assert_eq!(lock.params, b"template-params");
        assert_eq!(
            lock_from_p2pkh(&[0x76, 0xa9, 0x14]),
            Err("cross-output is not a P2PKH wrapper")
        );
        assert_eq!(
            lock_from_bip44("m/44'/145'/0'"),
            Err("cross-output does not assume BIP44")
        );
    }
}
