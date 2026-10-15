//! P2P CashFusion over Nostr, protocol v4, in Rust.
//!
//! The same protocol the desktop's TypeScript peers speak
//! (`src/platform/desktop/nostr/`, `docs/p2p-cashfusion-protocol.md`), so a
//! Rust peer and a TypeScript peer fuse in one round. Everything here is pure:
//! messages in, messages and actions out, no sockets and no clocks. The host
//! (`optn-fusion-native`) carries the messages over Nostr and Tor and feeds the
//! time in.
//!
//! - [`wire`]: the round messages and their strict parser.
//! - [`pool`]: pool announcements, the live filter, group selection and the
//!   set-bound coordinator election.
//! - [`onion`]: the output onion every output travels through.
//! - [`assemble`]: the canonical CoinJoin, the signing gate and the final
//!   transaction check.
//! - [`credentials`]: credential slots, blind requests and the coordinator's
//!   one-shot issuer.
//! - [`blame`]: provable protocol faults, created and verified.
//! - [`allocation`]: how a peer splits its inputs into outputs.
//! - [`rendezvous`]: proposal, ACK, shrink and start.
//! - [`session`]: the round itself, as coordinator or participant.
//!
//! Each TypeScript rule this ports is cited at its definition, and
//! `test-vectors/p2p-fusion.json`, generated from the TypeScript, pins the
//! bytes both sides must agree on.

pub mod allocation;
pub mod assemble;
pub mod blame;
pub mod credentials;
pub mod io;
pub mod onion;
pub mod pool;
pub mod rendezvous;
pub mod session;
pub mod wire;

#[cfg(test)]
mod sim;
#[cfg(test)]
mod vectors;

/// Protocol knobs (`fusionKnobs.ts` `FUSION_KNOB_DEFAULTS`). Protocol
/// constants, not wallet settings: every peer must use the same ones.
pub mod knobs {
    /// Gather locks at this many peers.
    pub const MIN_PLAYERS: usize = 6;
    /// ACK-shrink and coordinator failover floor.
    pub const MIN_SAFE_PLAYERS: usize = 4;
    /// Cap per round.
    pub const MAX_PLAYERS: usize = 10;
    /// Tiers a peer may announce, in sats.
    pub const TIERS_SATS: [u64; 5] = [10_000, 100_000, 1_000_000, 10_000_000, 100_000_000];

    pub const GATHER_MAX_MS: u64 = 120_000;
    pub const GATHER_ALONE_MS: u64 = 35_000;
    pub const GATHER_ALONE_AUTO_MS: u64 = 120_000;
    pub const GATHER_MIN_MS: u64 = 10_000;
    pub const GATHER_FAST_WARMUP_MS: u64 = 5_000;
    pub const SMALL_SET_HOLD_MS: u64 = 20_000;
    pub const PEER_SET_STABLE_MS: u64 = 4_000;
    pub const PEER_SET_STABLE_FAST_MS: u64 = 2_500;
    pub const PEAK_GRACE_MS: u64 = 15_000;
    pub const RENDEZVOUS_MS: u64 = 60_000;
    pub const PROPOSAL_TIMEOUT_MS: u64 = 20_000;
    pub const RENDEZVOUS_RESEND_MS: u64 = 1_200;
    pub const MISSING_OUTPUTS_ONION_MS: u64 = 36_000;
    pub const CREDENTIAL_WAIT_MS: u64 = 35_000;
}

/// Round timing (`fusionTiming.ts`).
pub mod timing {
    use super::knobs;

    /// Server CashFusion's `T_START_CLOSE_BLAME`, the floor of a round body.
    pub const ROUND_TIMEOUT_MS: u64 = 80_000;
    pub const CREDENTIAL_PARAMS_RESEND_MS: u64 = 1_500;
    pub const CREDENTIAL_PARAMS_RESEND_MAX: u32 = 12;
    pub const ONION_DECLARE_RESEND_MS: u64 = 1_500;
    pub const ONION_DECLARE_RESEND_MAX: u32 = 12;
    pub const ONION_OUTPUT_RESEND_MS: u64 = 2_000;
    pub const ONION_OUTPUT_RESEND_MAX: u32 = 8;
    pub const ASSEMBLED_RESEND_MS: u64 = 1_500;
    pub const SIG_RESEND_MS: u64 = 1_500;
    /// A participant outlasts the coordinator by this much, so the
    /// coordinator's abort or blame still arrives.
    pub const PEER_TIMEOUT_MARGIN_MS: u64 = 3_000;
    /// Per-component send jitter in production (`P2P_COMPONENT_JITTER_MS`).
    pub const COMPONENT_JITTER_MS: (u64, u64) = (30, 250);
    /// Participants rebroadcast the final transaction after this jitter.
    pub const PEER_BROADCAST_JITTER_MS: (u64, u64) = (2_000, 8_000);

    /// How long the coordinator waits, once every peer is ready, for the
    /// last peeler's reveal (`p2pMissingOutputsWaitMs`).
    pub fn missing_outputs_wait_ms(peelers: usize) -> u64 {
        knobs::MISSING_OUTPUTS_ONION_MS * peelers.max(1) as u64
    }

    /// The whole active round (`p2pRoundTimeoutMs`).
    pub fn round_timeout_ms(peelers: usize) -> u64 {
        ROUND_TIMEOUT_MS.max(knobs::CREDENTIAL_WAIT_MS + missing_outputs_wait_ms(peelers))
    }
}

/// Fee rate every P2P round uses, sats per 1,000 bytes (`P2P_FEERATE`).
pub const P2P_FEERATE: u64 = 1_000;

/// 21 million BCH in satoshis (`MAX_MONEY` in the TypeScript).
pub const MAX_MONEY: u64 = 21_000_000 * 100_000_000;

/// Lowercase hex.
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Hex of any case to bytes, refusing odd lengths and non-hex characters.
pub(crate) fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digits = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(digits, 16).ok()
        })
        .collect()
}

/// Exactly `N` bytes of hex.
pub(crate) fn unhex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    unhex(text)?.try_into().ok()
}

/// `true` when `text` is exactly `len` hex digits, any case.
pub(crate) fn is_hex_len(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A compressed secp256k1 point as hex: `02` or `03` and 64 hex digits.
pub(crate) fn is_compressed_pubkey_hex(text: &str) -> bool {
    text.len() == 66 && (text.starts_with("02") || text.starts_with("03")) && is_hex_len(text, 66)
}

/// An uncompressed secp256k1 point as hex: `04` and 128 hex digits.
pub(crate) fn is_uncompressed_point_hex(text: &str) -> bool {
    text.len() == 130 && text.starts_with("04") && is_hex_len(text, 130)
}

/// `n * feerate / 1000`, rounded up — the TypeScript `Math.ceil(n*f/1000)`.
pub(crate) fn fee_for_bytes(bytes: u64, feerate: u64) -> u64 {
    (bytes * feerate).div_ceil(1_000)
}

/// Fresh bytes from the operating system's CSPRNG.
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// Uniform in `0..bound` from the CSPRNG, rejection-sampled so no index is
/// favoured (`secureRandomInt`).
pub(crate) fn random_below(bound: usize) -> usize {
    if bound <= 1 {
        return 0;
    }
    let bound = bound as u64;
    let limit = u64::MAX - (u64::MAX % bound);
    loop {
        let value = u64::from_le_bytes(random_bytes::<8>());
        if value < limit {
            return (value % bound) as usize;
        }
    }
}

/// Uniform in `[0, 1)` with 53 random bits (`secureRandomUnit`).
pub(crate) fn random_unit() -> f64 {
    (u64::from_le_bytes(random_bytes::<8>()) >> 11) as f64 / (1u64 << 53) as f64
}

/// Fisher–Yates over the CSPRNG. This shuffle is the mix-net's privacy: a
/// permutation an observer could reproduce would let it walk the peel order
/// back to each sender (`secureShuffle`).
pub(crate) fn secure_shuffle<T>(items: &mut [T]) {
    for i in (1..items.len()).rev() {
        items.swap(i, random_below(i + 1));
    }
}

/// A random delay in `[min, max]` milliseconds.
pub(crate) fn jitter_ms((min, max): (u64, u64)) -> u64 {
    min + ((max.saturating_sub(min)) as f64 * random_unit()) as u64
}
