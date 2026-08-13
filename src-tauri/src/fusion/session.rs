// CashFusion round — Phase 1.4a: session hash + covert message building.
//
// The SESSION HASH is the round's anti-spy guarantee. It commits to everything
// the server should have told every player identically (tier, covert endpoint,
// times, the full commitment list, the full component list). Each player
// recomputes it and refuses to sign if the server's `session_hash` differs — so
// a server that whispers different components to different players just makes the
// fusion fail instead of deanonymizing anyone. Matched to Electron Cash util.py
// (listhash / calc_initial_hash / calc_round_hash) byte-for-byte.
//
// Also here: building the covert messages (CovertComponent) that get submitted
// over the covert Tor connections in 1.4b.

use prost::Message;
use sha2::{Digest, Sha256};

use super::pb;
use super::VERSION;

/// Length-delimited hash of a list of byte strings: sha256 of, for each item,
/// its 4-byte big-endian length followed by its bytes. The length prefix makes
/// the boundaries unambiguous (so ["ab","c"] and ["a","bc"] hash differently).
pub fn listhash<I, T>(items: I) -> [u8; 32]
where
    I: IntoIterator<Item = T>,
    T: AsRef<[u8]>,
{
    let mut h = Sha256::new();
    for x in items {
        let x = x.as_ref();
        h.update((x.len() as u32).to_be_bytes());
        h.update(x);
    }
    h.finalize().into()
}

/// The initial session hash, fixed at FusionBegin: binds the tier, covert
/// endpoint, and begin time. `begin_time` is FusionBegin.server_time.
pub fn calc_initial_hash(
    tier: u64,
    covert_domain: &[u8],
    covert_port: u32,
    covert_ssl: bool,
    begin_time: u64,
) -> [u8; 32] {
    let ssl: &[u8] = if covert_ssl { b"\x01" } else { b"\x00" };
    listhash([
        b"Cash Fusion Session".as_ref(),
        VERSION,
        &tier.to_be_bytes(),
        covert_domain,
        &covert_port.to_be_bytes(),
        ssl,
        &begin_time.to_be_bytes(),
    ])
}

/// The per-round session hash, chaining the previous hash with the round key,
/// round time, and the full commitment + component lists. `round_time` is
/// StartRound.server_time. Compare against the server's declared session_hash.
pub fn calc_round_hash(
    last_hash: &[u8; 32],
    round_pubkey: &[u8],
    round_time: u64,
    all_commitments: &[Vec<u8>],
    all_components: &[Vec<u8>],
) -> [u8; 32] {
    let commit_h = listhash(all_commitments);
    let comp_h = listhash(all_components);
    listhash([
        b"Cash Fusion Round".as_ref(),
        last_hash,
        round_pubkey,
        &round_time.to_be_bytes(),
        &commit_h,
        &comp_h,
    ])
}

/// Serialize a `CovertComponent` message (component + its unblinded blind
/// signature, tagged with the round key) for submission over a covert connection.
pub fn build_covert_component(
    round_pubkey: &[u8],
    signature: &[u8; 64],
    component: &[u8],
) -> Vec<u8> {
    let msg = pb::CovertMessage {
        msg: Some(pb::covert_message::Msg::Component(pb::CovertComponent {
            round_pubkey: Some(round_pubkey.to_vec()),
            signature: signature.to_vec(),
            component: component.to_vec(),
        })),
    };
    msg.encode_to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listhash_matches_its_definition() {
        // listhash([b"a"]) == sha256(0x00000001 || b"a") — verifies the exact
        // length-prefix framing against an independent SHA256.
        let mut h = Sha256::new();
        h.update(1u32.to_be_bytes());
        h.update(b"a");
        let expected: [u8; 32] = h.finalize().into();
        assert_eq!(listhash([b"a".as_ref()]), expected);
    }

    #[test]
    fn listhash_boundaries_are_unambiguous() {
        // The whole point of the length prefix: concatenation-ambiguous inputs
        // must hash differently.
        assert_ne!(
            listhash([b"ab".as_ref(), b"c".as_ref()]),
            listhash([b"a".as_ref(), b"bc".as_ref()])
        );
    }

    #[test]
    fn initial_hash_equals_the_listhash_of_its_fields() {
        let tier = 10_000u64;
        let domain = b"covert.example";
        let port = 8888u32;
        let begin = 1_700_000_000u64;

        let got = calc_initial_hash(tier, domain, port, true, begin);
        let expected = listhash([
            b"Cash Fusion Session".as_ref(),
            b"alpha13",
            &tier.to_be_bytes(),
            domain.as_ref(),
            &port.to_be_bytes(),
            b"\x01",
            &begin.to_be_bytes(),
        ]);
        assert_eq!(got, expected);
        // ssl flag actually changes the hash.
        assert_ne!(got, calc_initial_hash(tier, domain, port, false, begin));
    }

    #[test]
    fn round_hash_depends_on_every_input() {
        let last = [7u8; 32];
        let pk = vec![0x02u8; 33];
        let t = 1_700_000_123u64;
        let commits = vec![vec![1u8, 2, 3], vec![4u8, 5]];
        let comps = vec![vec![9u8], vec![8u8, 7]];

        let base = calc_round_hash(&last, &pk, t, &commits, &comps);
        // Changing any input changes the hash.
        assert_ne!(base, calc_round_hash(&[8u8; 32], &pk, t, &commits, &comps));
        assert_ne!(
            base,
            calc_round_hash(&last, &[0x03u8; 33], t, &commits, &comps)
        );
        assert_ne!(base, calc_round_hash(&last, &pk, t + 1, &commits, &comps));
        // Reordering components changes it (order is committed).
        let comps_rev = vec![vec![8u8, 7], vec![9u8]];
        assert_ne!(base, calc_round_hash(&last, &pk, t, &commits, &comps_rev));
    }

    #[test]
    fn covert_component_round_trips() {
        let rpk = vec![0x02u8; 33];
        let sig = [0x11u8; 64];
        let comp = vec![0xabu8, 0xcd, 0xef];
        let raw = build_covert_component(&rpk, &sig, &comp);
        let decoded = pb::CovertMessage::decode(raw.as_slice()).unwrap();
        match decoded.msg {
            Some(pb::covert_message::Msg::Component(c)) => {
                assert_eq!(c.round_pubkey.as_deref(), Some(rpk.as_slice()));
                assert_eq!(c.signature, sig.to_vec());
                assert_eq!(c.component, comp);
            }
            _ => panic!("expected a CovertComponent"),
        }
    }
}
