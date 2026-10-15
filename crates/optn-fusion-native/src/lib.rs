#![forbid(unsafe_code)]

//! The native CashFusion host: what a native surface (the CLI, the docker
//! runner, the desktop) needs around the protocol engine to fuse a wallet's
//! coins. A surface supplies only its settings and its wallet runtime, so a
//! round is driven the same way everywhere.
//!
//! - [`lookups`]: the round's chain evidence, through the holder's selected
//!   Electrum servers on connections of the round's own.
//! - [`depth_file`]: the wallet's fusion depth record on disk.
//! - [`server_round`]: one server round, from the server's settings to a
//!   transaction the network holds.
//! - [`p2p_round`]: one P2P round over Nostr and Tor, with the desktop's peers.

pub mod depth_file;
pub mod lookups;
pub mod p2p_round;
pub mod server_round;
