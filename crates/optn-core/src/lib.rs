#![forbid(unsafe_code)]

//! Wallet primitives shared by native callers and the WASM wallet surface.
//! No UI, transport SDK, platform state or network access belongs here.

pub mod connect;
pub mod fusion;

#[cfg(target_arch = "wasm32")]
mod wasm;
