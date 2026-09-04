#![forbid(unsafe_code)]

//! Protocol core shared between the OPTN CLI and the wallet.
//!
//! RPA was implemented twice -- once in TypeScript for every GUI target, once
//! in Rust for the CLI -- with no shared code, so a change to one was not a
//! change to the other and the two could drift silently. This crate is the
//! single implementation both sides are meant to use: natively from the CLI,
//! and through wasm32 from the wallet.
//!
//! Everything here is pure Rust and free of I/O, so it builds for the host,
//! for the riscv64 and armv7 cross targets, and for wasm32 alike.

pub mod addon;
pub mod airgap;
pub mod cashaddr;
pub mod coins;
pub mod conformance;
pub mod discovery;
pub mod endpoint;
pub mod error;
pub mod flipstarter;
pub mod fundme;
pub mod fusion;
pub mod hd;
pub mod multisig;
pub mod network;
pub mod nostr;
pub mod nostr_identity;
pub mod psbt;
pub mod rpa;
pub mod scan;
pub mod sources;
pub mod spend;
pub mod tor;
pub mod wallet_pack;
pub mod watch_only;

/// The wallet's binding surface. wasm32 only, so no other target pays for it.
#[cfg(target_arch = "wasm32")]
pub mod wasm;

#[cfg(kani)]
mod kani_proofs;
