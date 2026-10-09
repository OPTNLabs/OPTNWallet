// CashFusion protocol primitives, shared by every surface that speaks it.
//
// The desktop backend implemented these in Rust and the browser-side P2P round
// implemented them again in TypeScript. Both had to agree byte for byte, and
// nothing enforced that: a drift between them does not crash, it produces a
// signature or commitment the other side rejects part-way through a round.
//
// Nothing in here draws randomness. Nonces, blinding factors and selection
// draws are parameters, so every value is reproducible from a test vector.
pub mod coin_selection;
pub mod pedersen;
pub mod schnorr;

/// The two transports for one feature. Mutually exclusive: only the selected
/// one may start a round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FusionMode {
    /// Peer-to-peer, coordinated over Nostr. Requires Tor.
    P2p,
    /// A CashFusion server, coordinated by the server's pools.
    Server,
}

impl FusionMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::P2p => "P2P",
            Self::Server => "Server",
        }
    }
}
#[cfg(test)]
mod vectors;
