//! Generated binding entry points only; the implementation lives in `connect`.
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::connect;

#[wasm_bindgen(js_name = connectSigningSerialization)]
pub fn signing_serialization(
    context_json: &str,
    covered: &[u8],
    mode: u8,
) -> Result<Vec<u8>, String> {
    connect::signing_serialization(&connect::parse_context(context_json)?, covered, mode)
}

#[wasm_bindgen(js_name = connectSignInput)]
pub fn sign_input(
    context_json: &str,
    private_key: Vec<u8>,
    covered: &[u8],
    mode: u8,
) -> Result<Vec<u8>, String> {
    // Parse failure must erase the transferred WASM key buffer too.
    let mut key = Zeroizing::new(private_key);
    let context = connect::parse_context(context_json)?;
    connect::sign_input(&context, std::mem::take(&mut *key), covered, mode)
}

#[wasm_bindgen(js_name = connectPublicKey)]
pub fn public_key(private_key: Vec<u8>) -> Result<Vec<u8>, String> {
    connect::public_key(private_key)
}

#[wasm_bindgen(js_name = connectSignP2pkh)]
pub fn sign_p2pkh(context_json: &str, private_key: Vec<u8>, mode: u8) -> Result<Vec<u8>, String> {
    let mut key = Zeroizing::new(private_key);
    let context = connect::parse_context(context_json)?;
    connect::sign_p2pkh(&context, std::mem::take(&mut *key), mode)
}

#[wasm_bindgen(js_name = connectP2pkhLock)]
pub fn p2pkh_lock(public_key: &[u8]) -> Result<Vec<u8>, String> {
    connect::p2pkh_lock(public_key)
}
