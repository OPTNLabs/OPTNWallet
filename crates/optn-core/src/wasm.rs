//! The wallet's entry point into this crate.
//!
//! Only compiled for wasm32, so native, riscv64 and armv7 builds never see
//! wasm-bindgen at all.
//!
//! The surface mirrors `src/services/RpaService.ts` deliberately, name for
//! name, so the TypeScript side becomes a thin call-through rather than a
//! translation. Anything that needs a shape richer than a string is returned as
//! JSON: it keeps this boundary free of serde-wasm-bindgen, and the wallet is
//! going to hand these values to JS anyway.
//!
//! Byte arrays cross as `Vec<u8>` (JS `Uint8Array`). Lengths are checked here
//! rather than trusted, because a wrong-length key from JS would otherwise
//! reach the curve code as a silently wrong value.

use wasm_bindgen::prelude::*;

use crate::network::Network;
use crate::rpa;

fn network_from(name: &str) -> Result<Network, JsValue> {
    match name {
        "mainnet" => Ok(Network::Mainnet),
        "chipnet" => Ok(Network::Chipnet),
        other => Err(JsValue::from_str(&format!(
            "unknown network '{other}' (expected 'mainnet' or 'chipnet')"
        ))),
    }
}

fn array33(bytes: &[u8], what: &str) -> Result<[u8; 33], JsValue> {
    <[u8; 33]>::try_from(bytes)
        .map_err(|_| JsValue::from_str(&format!("{what} must be 33 bytes, got {}", bytes.len())))
}

fn array32(bytes: &[u8], what: &str) -> Result<[u8; 32], JsValue> {
    <[u8; 32]>::try_from(bytes)
        .map_err(|_| JsValue::from_str(&format!("{what} must be 32 bytes, got {}", bytes.len())))
}

fn err(e: crate::error::CliError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// `m/44'/<coin>'/<account>'/3/0` and `/3/1`, as a JSON object.
#[wasm_bindgen(js_name = rpaKeyPaths)]
pub fn rpa_key_paths(coin_type: u32, account: u32) -> String {
    format!(
        r#"{{"scan":"{}","spend":"{}"}}"#,
        rpa::scan_path(coin_type, account),
        rpa::spend_path(coin_type, account)
    )
}

/// Encode a scan/spend pair as a `cashcode:` string.
///
/// `legacy` stamps the old `paycode:` prefix instead. Nothing in the wallet
/// passes it: it exists so tests and migration tooling can build the form that
/// must keep being accepted on input.
#[wasm_bindgen(js_name = encodeCashcode)]
pub fn encode_cashcode(
    scan_pubkey: &[u8],
    spend_pubkey: &[u8],
    network: &str,
    prefix_bits: u8,
    legacy: Option<bool>,
) -> Result<String, JsValue> {
    let family = if legacy.unwrap_or(false) {
        rpa::PrefixFamily::LegacyPaycode
    } else {
        rpa::PrefixFamily::Cashcode
    };
    Ok(rpa::encode_with_family(
        &array33(scan_pubkey, "scan pubkey")?,
        &array33(spend_pubkey, "spend pubkey")?,
        network_from(network)?,
        prefix_bits,
        family,
    ))
}

/// Decode a cashcode or legacy paycode. Returns JSON, or throws with the
/// reason the code was rejected.
#[wasm_bindgen(js_name = decodeCashcode)]
pub fn decode_cashcode(code: &str) -> Result<String, JsValue> {
    let c = rpa::decode(code).map_err(err)?;
    let hex = |b: &[u8]| -> String { b.iter().map(|x| format!("{x:02x}")).collect() };
    Ok(format!(
        r#"{{"version":{},"prefixBits":{},"scanPubkey":"{}","spendPubkey":"{}","expiry":{},"prefix":"{}","legacy":{}}}"#,
        c.version,
        c.prefix_bits,
        hex(&c.scan_pubkey),
        hex(&c.spend_pubkey),
        c.expiry,
        c.prefix,
        c.legacy
    ))
}

/// True if the string carries any RPA prefix, cashcode or legacy paycode.
#[wasm_bindgen(js_name = looksLikeRpa)]
pub fn looks_like_rpa(candidate: &str) -> bool {
    rpa::looks_like_rpa(candidate)
}

/// Why this code must not be paid on-chain, or `undefined` if it may be.
#[wasm_bindgen(js_name = sendBlockReason)]
pub fn send_block_reason(code: &str) -> Result<Option<String>, JsValue> {
    let c = rpa::decode(code).map_err(err)?;
    Ok(rpa::send_block_reason(&c))
}

/// ECDH plus the outpoint, per the reference implementation. `txid` is the
/// display (big-endian) form, as block explorers show it.
#[wasm_bindgen(js_name = sharedSecret)]
pub fn shared_secret(
    privkey: &[u8],
    counterpart_pubkey: &[u8],
    txid: &str,
    vout: u32,
) -> Result<Vec<u8>, JsValue> {
    rpa::shared_secret(
        &array32(privkey, "private key")?,
        &array33(counterpart_pubkey, "counterpart pubkey")?,
        txid,
        vout,
    )
    .map(|s| s.to_vec())
    .map_err(err)
}

/// The one-time P2PKH a sender pays: CKD_pub of the spend key, hashed
/// compressed.
#[wasm_bindgen(js_name = paymentAddress)]
pub fn payment_address(
    spend_pubkey: &[u8],
    secret: &[u8],
    network: &str,
    index: u32,
) -> Result<String, JsValue> {
    rpa::payment_address(
        &array33(spend_pubkey, "spend pubkey")?,
        &array32(secret, "shared secret")?,
        network_from(network)?,
        index,
    )
    .map(|a| a.encode())
    .map_err(err)
}

/// The private key that spends a payment at `index`.
#[wasm_bindgen(js_name = spendingKey)]
pub fn spending_key(spend_privkey: &[u8], secret: &[u8], index: u32) -> Result<Vec<u8>, JsValue> {
    rpa::spending_key(
        &array32(spend_privkey, "spend private key")?,
        &array32(secret, "shared secret")?,
        index,
    )
    .map(|k| k.to_vec())
    .map_err(err)
}

/// The hex a sender grinds the input hash to match.
#[wasm_bindgen(js_name = grindString)]
pub fn grind_string(scan_pubkey: &[u8], prefix_bits: u8) -> Result<String, JsValue> {
    rpa::grind_string(&array33(scan_pubkey, "scan pubkey")?, prefix_bits).map_err(err)
}

/// Payments to this wallet inside one raw transaction, as a JSON array.
///
/// Takes `scanPrivkey` and `spendPubkey` only -- the spend private key is not
/// needed to find a payment, and requiring it here would destroy the split the
/// spec asks for (REQ-5) between detecting and spending.
#[wasm_bindgen(js_name = scanTransaction)]
pub fn scan_transaction(
    raw_tx: &[u8],
    scan_privkey: &[u8],
    spend_pubkey: &[u8],
    network: &str,
) -> Result<String, JsValue> {
    let matches = rpa::scan_transaction(
        raw_tx,
        &array32(scan_privkey, "scan private key")?,
        &array33(spend_pubkey, "spend pubkey")?,
        network_from(network)?,
    )
    .map_err(err)?;

    let items: Vec<String> = matches
        .iter()
        .map(|m| {
            format!(
                r#"{{"outputIndex":{},"address":"{}","valueSats":{},"prevoutHash":"{}","prevoutIndex":{}}}"#,
                m.output_index, m.address, m.value, m.prevout_txid, m.prevout_index
            )
        })
        .collect();
    Ok(format!("[{}]", items.join(",")))
}
