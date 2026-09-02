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
use zeroize::Zeroize;

use crate::network::Network;
use crate::{rpa, watch_only};

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

/// Derive scan/spend private and compressed public keys in the shared core.
///
/// The packed result is `scan_priv(32) || scan_pub(33) || spend_priv(32) ||
/// spend_pub(33)`. A fixed byte layout avoids serializing private keys into
/// JavaScript strings, which are immutable and cannot be wiped by the caller.
#[wasm_bindgen(js_name = deriveRpaKeys)]
pub fn derive_rpa_keys(
    mnemonic: &str,
    passphrase: &str,
    scan_path: &str,
    spend_path: &str,
) -> Result<js_sys::Uint8Array, JsValue> {
    let keys =
        rpa::derive_keys_from_paths(mnemonic, passphrase, scan_path, spend_path).map_err(err)?;
    let mut packed = [0u8; 130];
    packed[0..32].copy_from_slice(&keys.scan_privkey);
    packed[32..65].copy_from_slice(&keys.scan_pubkey);
    packed[65..97].copy_from_slice(&keys.spend_privkey);
    packed[97..130].copy_from_slice(&keys.spend_pubkey);

    // Copy into caller-owned JS memory, then erase the Rust/WASM transfer
    // buffer. The adapter erases this returned array after taking its slices.
    let output = js_sys::Uint8Array::new_with_length(packed.len() as u32);
    output.copy_from(&packed);
    packed.zeroize();
    Ok(output)
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

/// Validate a watch-only account xPub and derive its first receive/change
/// addresses in the shared Rust core. The JSON shape mirrors the existing
/// TypeScript view model so mobile/web become thin adapters.
#[wasm_bindgen(js_name = watchOnlyAccountPreview)]
pub fn watch_only_account_preview(network: &str, account_xpub: &str) -> Result<String, JsValue> {
    let preview = watch_only::account_preview(network_from(network)?, account_xpub).map_err(err)?;
    Ok(format!(
        r#"{{"accountPath":"{}","receive":{{"path":"{}","address":"{}","tokenAddress":"{}"}},"change":{{"path":"{}","address":"{}","tokenAddress":"{}"}}}}"#,
        preview.account_path,
        preview.receive.path,
        preview.receive.address,
        preview.receive.token_address,
        preview.change.path,
        preview.change.address,
        preview.change.token_address,
    ))
}

/// Canonicalize the optional 4-byte PSBT master fingerprint.
#[wasm_bindgen(js_name = normalizeWatchOnlyMasterFingerprint)]
pub fn normalize_watch_only_master_fingerprint(raw: &str) -> Result<Option<String>, JsValue> {
    watch_only::normalize_master_fingerprint(raw).map_err(err)
}

// ---------------------------------------------------------------------------
// CashFusion primitives.
//
// The browser-side P2P round calls these exports through a thin TypeScript
// adapter. The protocol math therefore has one Rust implementation shared with
// the desktop backend and pinned by test-vectors/fusion.json.
//
// Randomness stays on the JS side. The core takes nonces and blinding factors
// as parameters, so callers pass values from crypto.getRandomValues rather than
// this crate pulling in a getrandom shim for wasm32.
// ---------------------------------------------------------------------------

fn scalar_from(bytes: &[u8], what: &str) -> Result<k256::Scalar, JsValue> {
    use k256::elliptic_curve::PrimeField;
    let array = array32(bytes, what)?;
    let scalar =
        Option::<k256::Scalar>::from(k256::Scalar::from_repr(array.into())).ok_or_else(|| {
            JsValue::from_str(&format!("{what} is not a canonical scalar (must be < n)"))
        })?;
    if bool::from(scalar.is_zero()) {
        return Err(JsValue::from_str(&format!("{what} must be non-zero")));
    }
    Ok(scalar)
}

/// Whether bytes are one non-zero canonical secp256k1 scalar.
#[wasm_bindgen(js_name = fusionScalarIsCanonical)]
pub fn fusion_scalar_is_canonical(bytes: &[u8]) -> bool {
    scalar_from(bytes, "scalar").is_ok()
}

/// Add packed 32-byte non-zero canonical scalars modulo the group order.
#[wasm_bindgen(js_name = fusionScalarSum)]
pub fn fusion_scalar_sum(packed: &[u8]) -> Result<Vec<u8>, JsValue> {
    if packed.is_empty() || packed.len() % 32 != 0 {
        return Err(JsValue::from_str(
            "packed scalars must contain one or more 32-byte values",
        ));
    }
    let mut total = k256::Scalar::ZERO;
    for chunk in packed.chunks_exact(32) {
        total += scalar_from(chunk, "scalar")?;
    }
    Ok(total.to_bytes().to_vec())
}

/// Verify a 64-byte BCH Schnorr signature. False on any malformed input.
#[wasm_bindgen(js_name = fusionVerifySchnorr)]
pub fn fusion_verify_schnorr(
    pubkey: &[u8],
    signature: &[u8],
    message: &[u8],
) -> Result<bool, JsValue> {
    let sig = <[u8; 64]>::try_from(signature).map_err(|_| {
        JsValue::from_str(&format!(
            "signature must be 64 bytes, got {}",
            signature.len()
        ))
    })?;
    let msg = array32(message, "message")?;
    Ok(crate::fusion::schnorr::verify(pubkey, &sig, &msg))
}

/// The 65-byte uncompressed Pedersen commitment `amount*H + nonce*G`.
#[wasm_bindgen(js_name = fusionPedersenCommit)]
pub fn fusion_pedersen_commit(amount: u64, nonce: &[u8]) -> Result<Vec<u8>, JsValue> {
    let nonce = scalar_from(nonce, "pedersen nonce")?;
    Ok(crate::fusion::pedersen::commit_bytes(amount, &nonce).to_vec())
}

/// The commitment for a signed amount: an input commits `+value-fee`, an output
/// `-value-fee`, a blank `0`.
#[wasm_bindgen(js_name = fusionPedersenCommitSigned)]
pub fn fusion_pedersen_commit_signed(amount: i64, nonce: &[u8]) -> Result<Vec<u8>, JsValue> {
    let nonce = scalar_from(nonce, "pedersen nonce")?;
    Ok(
        crate::fusion::pedersen::encode_uncompressed(
            &crate::fusion::pedersen::commit_point_signed(amount, &nonce),
        )
        .to_vec(),
    )
}

/// The compressed nothing-up-my-sleeve generator H, for callers that check it.
#[wasm_bindgen(js_name = fusionPedersenH)]
pub fn fusion_pedersen_h() -> Vec<u8> {
    use k256::elliptic_curve::group::GroupEncoding;
    crate::fusion::pedersen::h_point()
        .to_affine()
        .to_bytes()
        .to_vec()
}

/// Check packed 65-byte uncompressed commitments against one signed amount and
/// the sum of their nonces. Malformed points fail closed.
#[wasm_bindgen(js_name = fusionPedersenBalanceHolds)]
pub fn fusion_pedersen_balance_holds(
    packed_commitments: &[u8],
    excess_fee: i64,
    total_nonce: &[u8],
) -> Result<bool, JsValue> {
    use k256::ProjectivePoint;

    if packed_commitments.is_empty() || packed_commitments.len() % 65 != 0 {
        return Ok(false);
    }
    let mut sum = ProjectivePoint::IDENTITY;
    for encoded in packed_commitments.chunks_exact(65) {
        let point = match crate::fusion::schnorr::parse_point(encoded) {
            Ok(point) => point,
            Err(_) => return Ok(false),
        };
        sum += point;
    }
    let nonce = scalar_from(total_nonce, "pedersen total nonce")?;
    Ok(sum == crate::fusion::pedersen::commit_point_signed(excess_fee, &nonce))
}

/// Compressed public key for an issuer's non-zero canonical round secret.
#[wasm_bindgen(js_name = fusionBlindIssuerPublicKey)]
pub fn fusion_blind_issuer_public_key(secret: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(crate::fusion::schnorr::pubkey_compressed(scalar_from(secret, "issuer secret")?).to_vec())
}

/// Compressed one-shot nonce point published for a credential slot.
#[wasm_bindgen(js_name = fusionBlindIssuerNoncePoint)]
pub fn fusion_blind_issuer_nonce_point(nonce: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(crate::fusion::schnorr::pubkey_compressed(scalar_from(nonce, "issuer nonce")?).to_vec())
}

/// Sign one blinded challenge with caller-owned issuer secret and nonce.
#[wasm_bindgen(js_name = fusionBlindIssuerSign)]
pub fn fusion_blind_issuer_sign(
    secret: &[u8],
    nonce: &[u8],
    challenge: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let mut issuer = crate::fusion::schnorr::BlindIssuer::from_parts(
        scalar_from(secret, "issuer secret")?,
        vec![scalar_from(nonce, "issuer nonce")?],
    )
    .map_err(|e| JsValue::from_str(&e))?;
    issuer
        .sign(0, &array32(challenge, "blinded challenge")?)
        .map(|response| response.to_vec())
        .map_err(|e| JsValue::from_str(&e))
}

/// The 32-byte blinded challenge to send to the issuer. `a` and `b` must be
/// fresh uniform scalars from the caller's CSPRNG and must never be reused.
///
/// There is no handle to keep: `fusionFinalizeBlindSignature` takes the same
/// five inputs again and rebuilds the request, so nothing on the JS side owns
/// Rust memory it would have to free.
#[wasm_bindgen(js_name = fusionBlindRequest)]
pub fn fusion_blind_request(
    round_pubkey: &[u8],
    r_point: &[u8],
    message: &[u8],
    a: &[u8],
    b: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let msg = array32(message, "message")?;
    let request = crate::fusion::schnorr::BlindSignatureRequest::new_with_blinding(
        round_pubkey,
        r_point,
        msg,
        scalar_from(a, "blinding factor a")?,
        scalar_from(b, "blinding factor b")?,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    Ok(request.request().to_vec())
}

/// Complete a blinded signature. Takes the same inputs the request was built
/// from plus the issuer's 32-byte response, and returns the 64-byte signature.
/// Always verifies before returning, so a cheating issuer is an error here
/// rather than a rejected signature later in the round.
#[wasm_bindgen(js_name = fusionFinalizeBlindSignature)]
pub fn fusion_finalize_blind_signature(
    round_pubkey: &[u8],
    r_point: &[u8],
    message: &[u8],
    a: &[u8],
    b: &[u8],
    issuer_response: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let msg = array32(message, "message")?;
    let request = crate::fusion::schnorr::BlindSignatureRequest::new_with_blinding(
        round_pubkey,
        r_point,
        msg,
        scalar_from(a, "blinding factor a")?,
        scalar_from(b, "blinding factor b")?,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    let response = array32(issuer_response, "issuer response")?;
    request
        .finalize(&response, true)
        .map(|sig| sig.to_vec())
        .map_err(|e| JsValue::from_str(&e))
}
