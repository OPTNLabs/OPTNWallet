//! Two Rust multisig implementations, compared directly.
//!
//! `optn_core::multisig` derives a wallet from cosigner account xPubs;
//! `optn_multisig_core` derives one concrete address from raw public keys.
//! They overlap on the innermost step — BIP-67 sorting, the redeem script,
//! HASH160, and the P2SH20 CashAddr — and that overlap is where a
//! disagreement would be silent and expensive: a wallet watching addresses
//! the money is not at, showing an empty balance rather than an error.
//!
//! This is the only crate that depends on both, which is what makes the
//! comparison possible here and nowhere else. It replaces a test that
//! transcribed the other crate's published vector into a constant: agreeing
//! with a copied number proves the copy was accurate, not that the two
//! implementations agree today.

use optn_core::multisig::{p2sh_address, redeem_script};
use optn_core::network::Network as CoreNetwork;
use optn_multisig_core::{inspect_p2sh20, Network as MultisigNetwork};

/// PR #65's `VECTOR_1`. Test-vector material; it controls nothing.
const KEY_A: &str = "02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8";
const KEY_B: &str = "02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f";

fn key_bytes(hex: &str) -> [u8; 33] {
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
        .collect();
    let mut out = [0u8; 33];
    out.copy_from_slice(&bytes);
    out
}

#[test]
fn both_implementations_produce_the_same_script_and_address() {
    for (a, b) in [(KEY_A, KEY_B), (KEY_B, KEY_A)] {
        let theirs = inspect_p2sh20(MultisigNetwork::Chipnet, 2, &[a, b])
            .expect("optn-multisig-core inspects the policy");

        let ours = redeem_script(2, &[key_bytes(a), key_bytes(b)]).expect("2-of-2");
        let ours_hex: String = ours.iter().map(|byte| format!("{byte:02x}")).collect();
        let theirs_hex: String = theirs
            .redeem_script
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();

        assert_eq!(
            ours_hex, theirs_hex,
            "redeem scripts diverge with keys entered {a}, {b}"
        );
        assert_eq!(
            p2sh_address(CoreNetwork::Chipnet, &ours, false),
            theirs.address,
            "addresses diverge with keys entered {a}, {b}"
        );
    }
}

#[test]
fn both_sort_to_bip67_order_rather_than_input_order() {
    // The property that makes the agreement above meaningful. Entering the
    // same cosigners in a different order must not produce a different
    // wallet, and both implementations have to get that right independently
    // or one of them silently makes a wallet the other cannot open.
    let forwards = inspect_p2sh20(MultisigNetwork::Chipnet, 2, &[KEY_A, KEY_B]).expect("policy");
    let backwards = inspect_p2sh20(MultisigNetwork::Chipnet, 2, &[KEY_B, KEY_A]).expect("policy");
    assert_eq!(forwards.address, backwards.address);

    let ours_forwards = redeem_script(2, &[key_bytes(KEY_A), key_bytes(KEY_B)]).expect("script");
    let ours_backwards = redeem_script(2, &[key_bytes(KEY_B), key_bytes(KEY_A)]).expect("script");
    assert_eq!(ours_forwards, ours_backwards);
    assert_eq!(ours_forwards, forwards.redeem_script);

    // 0x02fe sorts before 0x02ff, so B precedes A in the script whichever
    // way round they were given.
    let hex: String = ours_forwards
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert!(
        hex.find(KEY_B) < hex.find(KEY_A),
        "BIP-67 order, not input order"
    );
}

#[test]
fn the_two_disagree_only_about_how_many_cosigners_a_script_may_hold() {
    // Recorded rather than smoothed over, because it is a real difference and
    // the merge is the moment to notice it. optn-multisig-core caps at 15,
    // which is Electron Cash's limit; optn_core::multisig allows 16, which is
    // what OP_16 encodes. A 16-of-16 built here is valid on chain and cannot
    // be inspected by the other crate.
    assert_eq!(optn_core::multisig::MAX_COSIGNERS, 16);

    let sixteen: Vec<[u8; 33]> = (0..16u8)
        .map(|index| {
            let mut key = key_bytes(KEY_A);
            key[32] = key[32].wrapping_add(index);
            key
        })
        .collect();
    assert!(
        redeem_script(2, &sixteen).is_ok(),
        "optn-core encodes a 16-key script"
    );

    let hex: Vec<String> = sixteen
        .iter()
        .map(|key| key.iter().map(|byte| format!("{byte:02x}")).collect())
        .collect();
    let refs: Vec<&str> = hex.iter().map(String::as_str).collect();
    assert!(
        inspect_p2sh20(MultisigNetwork::Chipnet, 2, &refs).is_err(),
        "optn-multisig-core stops at 15, so this is the boundary to agree on"
    );
}
