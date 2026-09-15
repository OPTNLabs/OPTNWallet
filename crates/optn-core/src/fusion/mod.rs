// CashFusion protocol primitives, shared by every surface that speaks it.
//
// The desktop backend implemented these in Rust and the browser-side P2P round
// implemented them again in TypeScript. Both had to agree byte for byte, and
// nothing enforced that: a drift between them does not crash, it produces a
// signature or commitment the other side rejects part-way through a round.
//
// Nothing in here draws randomness. Nonces and blinding factors are parameters,
// so this compiles to wasm32 without a getrandom shim and every value is
// reproducible from a test vector.
pub mod pedersen;
pub mod schnorr;
#[cfg(test)]
mod vectors;
