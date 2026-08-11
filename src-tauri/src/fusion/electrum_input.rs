use std::collections::HashMap;
use std::collections::HashSet;
use std::time::Duration;

use ripemd::Ripemd160;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::{connect_stream, pb, schnorr, Transport};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Per-input timeout inside a batch so a single slow query doesn't block the
/// entire round.  The outer caller already has its own overall timeout.
const BATCH_PER_INPUT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_LIST_UNSPENT_ENTRIES: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElectrumEndpoint {
    pub host: String,
    pub port: u16,
    pub use_ssl: bool,
}

/// A protocol-valid Electrum answer either confirms the peer's exact input or
/// disproves it. Network, timeout, and malformed-response failures remain
/// errors so a caller never assigns blame based on unavailable evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputLookup {
    Match,
    Mismatch(String),
}

#[derive(Serialize)]
struct ListUnspentRequest<'a> {
    id: u64,
    method: &'static str,
    params: [&'a str; 1],
}

#[derive(Debug)]
enum RpcMember<T> {
    Missing,
    Present(T),
}

impl<T> Default for RpcMember<T> {
    fn default() -> Self {
        Self::Missing
    }
}

impl<'de, T> Deserialize<'de> for RpcMember<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        T::deserialize(deserializer).map(Self::Present)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RpcError {
    code: i64,
    message: String,
    #[serde(default, rename = "data")]
    _data: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListUnspentItem {
    tx_hash: String,
    tx_pos: u32,
    height: i64,
    value: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListUnspentResponse {
    #[serde(default)]
    jsonrpc: RpcMember<String>,
    id: u64,
    #[serde(default)]
    result: RpcMember<Vec<ListUnspentItem>>,
    #[serde(default)]
    error: RpcMember<RpcError>,
}

/// Query the endpoint for the P2PKH UTXOs controlled by `input.pubkey` and
/// verify the component's exact display-order txid, vout, confirmation state,
/// and satoshi value.
pub async fn verify_input(
    endpoint: &ElectrumEndpoint,
    transport: Transport<'_>,
    input: &pb::InputComponent,
) -> Result<InputLookup, String> {
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let mut stream =
            connect_stream(&endpoint.host, endpoint.port, endpoint.use_ssl, transport).await?;
        exchange(&mut stream, 1, input).await.map(|(_, result)| result)
    })
    .await
    .map_err(|_| "Electrum peer-input lookup timed out".to_string())?
}

/// Verify multiple inputs over a **single** Electrum connection.
///
/// Opens one TCP (or Tor) connection and pipelines all `listunspent` queries,
/// matching responses by request id.  This avoids the 1–3 s Tor circuit
/// establishment cost that `verify_input` pays per input — the dominant source
/// of latency in `revalidate_own_inputs`.
///
/// Returns `(input_index, Result)` pairs so the caller can map results back to
/// the original input list.  A network-level failure on the shared connection
/// aborts the entire batch (the caller should fall back to per-input lookups).
pub async fn batch_verify_inputs(
    endpoint: &ElectrumEndpoint,
    transport: Transport<'_>,
    inputs: &[&pb::InputComponent],
) -> Result<Vec<(usize, Result<InputLookup, String>)>, String> {
    let mut stream =
        connect_stream(&endpoint.host, endpoint.port, endpoint.use_ssl, transport).await?;

    // Send all requests — each with a unique id so we can match responses.
    let mut scripthash_by_id: HashMap<u64, (usize, String)> = HashMap::with_capacity(inputs.len());
    for (idx, input) in inputs.iter().enumerate() {
        let request_id = (idx as u64) + 1;
        let scripthash = electrum_scripthash(&input.pubkey)?;
        let request = serde_json::to_vec(&ListUnspentRequest {
            id: request_id,
            method: "blockchain.scripthash.listunspent",
            params: [&scripthash],
        })
        .map_err(|e| format!("could not encode Electrum request: {e}"))?;

        // Pipeline: write request + newline without waiting for a response.
        let mut full_request = request;
        full_request.push(b'\n');
        stream
            .write_all(&full_request)
            .await
            .map_err(|e| format!("Electrum request write failed: {e}"))?;

        scripthash_by_id.insert(request_id, (idx, scripthash));
    }

    // Read exactly `inputs.len()` responses, matching each to its request id.
    let mut results: Vec<Option<Result<InputLookup, String>>> = vec![None; inputs.len()];
    let mut remaining = inputs.len();
    while remaining > 0 {
        let mut response = Vec::new();
        let mut total_read = 0usize;
        // Read byte-by-byte until newline, enforcing the size limit.
        let read_result: Result<(), String> = tokio::time::timeout(
            BATCH_PER_INPUT_TIMEOUT,
            async {
                let mut buf = [0u8; 1];
                loop {
                    let n = stream
                        .read(&mut buf)
                        .await
                        .map_err(|e| format!("Electrum response read failed: {e}"))?;
                    if n == 0 {
                        return Err("Electrum connection closed before newline".into());
                    }
                    total_read += n;
                    if total_read > MAX_RESPONSE_BYTES {
                        return Err(format!(
                            "Electrum response too large (maximum {MAX_RESPONSE_BYTES} bytes)"
                        ));
                    }
                    response.push(buf[0]);
                    if buf[0] == b'\n' {
                        break;
                    }
                }
                Ok(())
            },
        )
        .await
        .map_err(|_| "Electrum batch response timed out".to_string())?;
        read_result?;

        if response.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "Electrum response too large (maximum {MAX_RESPONSE_BYTES} bytes)"
            ));
        }
        if response.last() != Some(&b'\n') {
            return Err("Electrum response ended before newline".into());
        }

        let parsed: ListUnspentResponse = serde_json::from_slice(&response)
            .map_err(|e| format!("invalid Electrum JSON-RPC response: {e}"))?;

        if let Some((idx, _scripthash)) = scripthash_by_id.remove(&parsed.id) {
            let input = inputs[idx];
            let display_txid = display_txid(input)?;
            results[idx] = Some(parse_listunspent_response(&parsed, &display_txid, input));
            remaining -= 1;
        }
        // Unknown response id — skip (shouldn't happen with a well-behaved server).
    }

    Ok(results
        .into_iter()
        .enumerate()
        .filter_map(|(idx, r)| r.map(|result| (idx, result)))
        .collect())
}

/// Parse a `ListUnspentResponse` against a specific outpoint + value.
fn parse_listunspent_response(
    response: &ListUnspentResponse,
    display_txid: &str,
    input: &pb::InputComponent,
) -> Result<InputLookup, String> {
    match response.jsonrpc {
        RpcMember::Missing => {}
        RpcMember::Present(ref version) if version == "2.0" => {}
        RpcMember::Present(ref version) => {
            return Err(format!("unsupported Electrum JSON-RPC version: {version}"));
        }
    }

    let items = match (&response.result, &response.error) {
        (RpcMember::Present(items), RpcMember::Missing) => items,
        (RpcMember::Missing, RpcMember::Present(error)) => {
            return Err(format!(
                "Electrum RPC error {}: {}",
                error.code, error.message
            ));
        }
        (RpcMember::Present(_), RpcMember::Present(_)) => {
            return Err("ambiguous Electrum response contains result and error".into());
        }
        (RpcMember::Missing, RpcMember::Missing) => {
            return Err("Electrum response contains neither result nor error".into());
        }
    };

    if items.len() > MAX_LIST_UNSPENT_ENTRIES {
        return Err(format!(
            "Electrum listunspent result has too many entries (maximum {MAX_LIST_UNSPENT_ENTRIES})"
        ));
    }

    let mut seen = HashSet::with_capacity(items.len());
    for item in items {
        if !is_canonical_display_txid(&item.tx_hash) {
            return Err("Electrum listunspent returned a non-canonical tx_hash".into());
        }
        if !seen.insert((item.tx_hash.as_str(), item.tx_pos)) {
            return Err("Electrum listunspent returned a duplicate outpoint".into());
        }
    }

    let Some(item) = items
        .iter()
        .find(|item| item.tx_hash == display_txid && item.tx_pos == input.prev_index)
    else {
        return Ok(InputLookup::Mismatch(
            "claimed outpoint is not unspent for the peer pubkey".into(),
        ));
    };

    let _height_may_be_unconfirmed = item.height;
    if item.value != input.amount {
        return Ok(InputLookup::Mismatch(format!(
            "claimed value {} does not match Electrum value {}",
            input.amount, item.value
        )));
    }

    Ok(InputLookup::Match)
}

async fn exchange<S>(stream: &mut S, request_id: u64, input: &pb::InputComponent) -> Result<(u64, InputLookup), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let scripthash = electrum_scripthash(&input.pubkey)?;
    let mut request = serde_json::to_vec(&ListUnspentRequest {
        id: request_id,
        method: "blockchain.scripthash.listunspent",
        params: [&scripthash],
    })
    .map_err(|e| format!("could not encode Electrum request: {e}"))?;
    request.push(b'\n');

    stream
        .write_all(&request)
        .await
        .map_err(|e| format!("Electrum request write failed: {e}"))?;

    let mut response = Vec::new();
    let mut limited = BufReader::new(stream).take((MAX_RESPONSE_BYTES + 1) as u64);
    limited
        .read_until(b'\n', &mut response)
        .await
        .map_err(|e| format!("Electrum response read failed: {e}"))?;

    if response.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "Electrum response too large (maximum {MAX_RESPONSE_BYTES} bytes)"
        ));
    }
    if response.last() != Some(&b'\n') {
        return Err("Electrum response ended before newline".into());
    }

    let parsed: ListUnspentResponse = serde_json::from_slice(&response)
        .map_err(|e| format!("invalid Electrum JSON-RPC response: {e}"))?;
    if parsed.id != request_id {
        return Err(format!(
            "Electrum response id {} did not match request id {request_id}",
            parsed.id
        ));
    }

    let display_txid = display_txid(input)?;
    Ok((parsed.id, parse_listunspent_response(&parsed, &display_txid, input)?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionGetResponse {
    #[serde(default)]
    #[allow(dead_code)]
    jsonrpc: RpcMember<String>,
    id: u64,
    #[serde(default)]
    result: RpcMember<String>,
    #[serde(default)]
    error: RpcMember<RpcError>,
}

/// Does this Electrum server know the transaction?
///
/// `Ok(false)` means the server answered and does not have it. An unreachable or
/// malfunctioning server is an `Err`, never `Ok(false)`: telling someone their
/// fusion was not broadcast because a lookup failed is worse than saying
/// nothing, and from the outside the two look identical.
///
/// The round engine only ever assembles and validates the transaction — the
/// broadcast is somebody else's. Without this, a round that was assembled
/// perfectly and then rejected by the network (say, for paying under the
/// minimum relay fee) reports success to the user and leaves the evidence
/// only in the server's log.
pub async fn transaction_is_known(
    endpoint: &ElectrumEndpoint,
    transport: Transport<'_>,
    txid: &str,
) -> Result<bool, String> {
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not a transaction id".into());
    }
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let mut stream =
            connect_stream(&endpoint.host, endpoint.port, endpoint.use_ssl, transport).await?;
        let mut request = serde_json::to_vec(&ListUnspentRequest {
            id: 1,
            method: "blockchain.transaction.get",
            params: [txid],
        })
        .map_err(|e| format!("could not encode Electrum request: {e}"))?;
        request.push(b'\n');
        stream
            .write_all(&request)
            .await
            .map_err(|e| format!("Electrum request write failed: {e}"))?;

        let mut response = Vec::new();
        let mut limited = BufReader::new(&mut stream).take((MAX_RESPONSE_BYTES + 1) as u64);
        limited
            .read_until(b'\n', &mut response)
            .await
            .map_err(|e| format!("Electrum response read failed: {e}"))?;
        if response.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "Electrum response too large (maximum {MAX_RESPONSE_BYTES} bytes)"
            ));
        }
        if response.last() != Some(&b'\n') {
            return Err("Electrum response ended before newline".into());
        }

        let parsed: TransactionGetResponse = serde_json::from_slice(&response)
            .map_err(|e| format!("invalid Electrum JSON-RPC response: {e}"))?;
        if parsed.id != 1 {
            return Err("Electrum response id did not match the request".into());
        }
        match (parsed.result, parsed.error) {
            // "no such transaction" is an answer, not a failure.
            (_, RpcMember::Present(_)) => Ok(false),
            (RpcMember::Present(hex), _) if !hex.is_empty() => Ok(true),
            _ => Err("Electrum returned neither a transaction nor an error".into()),
        }
    })
    .await
    .map_err(|_| "Electrum broadcast confirmation timed out".to_string())?
}

fn electrum_scripthash(pubkey: &[u8]) -> Result<String, String> {
    if pubkey.len() != 33 || !matches!(pubkey.first(), Some(0x02 | 0x03)) {
        return Err("peer input pubkey must be compressed (33 bytes)".into());
    }
    schnorr::parse_point(pubkey)
        .map_err(|_| "peer input pubkey is not a valid compressed secp256k1 key".to_string())?;

    let pubkey_sha = Sha256::digest(pubkey);
    let pubkey_hash = Ripemd160::digest(pubkey_sha);
    let mut script = [0u8; 25];
    script[..3].copy_from_slice(&[0x76, 0xa9, 0x14]);
    script[3..23].copy_from_slice(&pubkey_hash);
    script[23..].copy_from_slice(&[0x88, 0xac]);

    let mut script_hash: [u8; 32] = Sha256::digest(script).into();
    script_hash.reverse();
    Ok(encode_hex(script_hash))
}

fn display_txid(input: &pb::InputComponent) -> Result<String, String> {
    if input.prev_txid.len() != 32 {
        return Err("peer input prev_txid must be exactly 32 bytes".into());
    }
    Ok(encode_hex(input.prev_txid.iter().rev().copied()))
}

fn is_canonical_display_txid(txid: &str) -> bool {
    txid.len() == 64
        && txid
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn encode_hex(bytes: impl IntoIterator<Item = u8>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let bytes = bytes.into_iter();
    let mut encoded = String::with_capacity(bytes.size_hint().0 * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;

    fn input() -> pb::InputComponent {
        pb::InputComponent {
            prev_txid: (0u8..32).collect(),
            prev_index: 7,
            pubkey: decode_hex(
                "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            ),
            amount: 12_345,
        }
    }

    fn decode_hex(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }

    #[test]
    fn derives_reference_p2pkh_electrum_scripthash() {
        let pubkey =
            decode_hex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");

        assert_eq!(
            electrum_scripthash(&pubkey).unwrap(),
            "8bd2c4f79944cd6a3cb1730cf92c513ae259eb271d81918457f3753eebe14a3f"
        );
    }

    #[test]
    fn rejects_non_compressed_pubkeys_before_lookup() {
        let mut invalid = vec![0x04; 65];
        invalid[0] = 0x04;

        assert!(electrum_scripthash(&invalid)
            .unwrap_err()
            .contains("compressed"));
    }

    #[test]
    fn parses_an_exact_confirmed_display_outpoint_and_value_as_match() {
        let response = br#"{"jsonrpc":"2.0","id":1,"result":[{"tx_hash":"1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100","tx_pos":7,"height":800000,"value":12345}]}"#;
        let parsed: ListUnspentResponse = serde_json::from_slice(response).unwrap();
        let display = display_txid(&input()).unwrap();

        assert_eq!(
            parse_listunspent_response(&parsed, &display, &input()).unwrap(),
            InputLookup::Match
        );
    }

    #[test]
    fn valid_absence_and_wrong_value_are_mismatches() {
        let cases = [
            (
                br#"{"id":1,"result":[]}"#.as_slice(),
                "not unspent",
            ),
            (
                br#"{"id":1,"result":[{"tx_hash":"1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100","tx_pos":7,"height":800000,"value":12344}]}"#.as_slice(),
                "value",
            ),
        ];

        for (response, expected_reason) in cases {
            let parsed: ListUnspentResponse = serde_json::from_slice(response).unwrap();
            let display = display_txid(&input()).unwrap();
            match parse_listunspent_response(&parsed, &display, &input()).unwrap() {
                InputLookup::Mismatch(reason) => assert!(
                    reason.contains(expected_reason),
                    "unexpected mismatch: {reason}"
                ),
                InputLookup::Match => panic!("expected mismatch"),
            }
        }
    }

    #[test]
    fn unconfirmed_outpoint_with_matching_value_is_accepted() {
        // OPTN accepts height=0 (0-conf). EC still rejects; we do not.
        let response = br#"{"jsonrpc":"2.0","id":1,"result":[{"tx_hash":"1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100","tx_pos":7,"height":0,"value":12345}]}"#;
        let parsed: ListUnspentResponse = serde_json::from_slice(response).unwrap();
        let display = display_txid(&input()).unwrap();
        assert_eq!(
            parse_listunspent_response(&parsed, &display, &input()).unwrap(),
            InputLookup::Match
        );
    }

    #[test]
    fn rejects_wrong_ids_ambiguous_envelopes_and_duplicate_fields() {
        let input = input();
        let display = display_txid(&input).unwrap();
        let cases = [
            // Wrong id — parse succeeds but parse_listunspent_response doesn't care about id
            // (batch function matches by id). These test the deserialization layer.
            br#"{"id":1,"result":[],"error":{"code":1,"message":"bad"}}"#.as_slice(),
            br#"{"id":1,"id":1,"result":[]}"#.as_slice(),
            br#"{"id":1,"result":[],"unexpected":true}"#.as_slice(),
            br#"{"jsonrpc":null,"id":1,"result":[]}"#.as_slice(),
        ];

        for response in cases {
            let parsed: Result<ListUnspentResponse, _> = serde_json::from_slice(response);
            assert!(
                parsed.is_err() || parse_listunspent_response(&parsed.unwrap(), &display, &input).is_err(),
                "accepted {}",
                String::from_utf8_lossy(response)
            );
        }
    }

    #[test]
    fn rpc_errors_and_malformed_json_are_errors_not_mismatches() {
        let rpc_error = br#"{"id":1,"error":{"code":-32601,"message":"method unavailable"}}"#;
        let parsed: ListUnspentResponse = serde_json::from_slice(rpc_error).unwrap();
        let display = display_txid(&input()).unwrap();
        let err = parse_listunspent_response(&parsed, &display, &input()).unwrap_err();
        assert!(err.contains("-32601"), "unexpected error: {err}");

        assert!(serde_json::from_slice::<ListUnspentResponse>(br#"{"id":1,"result":"not a list"}"#).is_err());
        assert!(serde_json::from_slice::<ListUnspentResponse>(br#"{"id":1,"result":["#).is_err());
    }

    #[test]
    fn rejects_malformed_or_unbounded_listunspent_results() {
        let malformed_txid =
            br#"{"id":1,"result":[{"tx_hash":"not-a-txid","tx_pos":7,"height":1,"value":12345}]}"#;
        let parsed: ListUnspentResponse = serde_json::from_slice(malformed_txid).unwrap();
        let display = display_txid(&input()).unwrap();
        assert!(
            parse_listunspent_response(&parsed, &display, &input()).is_err(),
            "accepted malformed txid"
        );

        let item = r#"{"tx_hash":"1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100","tx_pos":8,"height":1,"value":1}"#;
        let oversized = format!(r#"{{"id":1,"result":[{}]}}"#, vec![item; 1_025].join(","));
        let parsed: ListUnspentResponse = serde_json::from_slice(oversized.as_bytes()).unwrap();
        let display = display_txid(&input()).unwrap();
        assert!(parse_listunspent_response(&parsed, &display, &input())
            .unwrap_err()
            .contains("too many"));
    }

    #[tokio::test]
    async fn newline_rpc_exchange_sends_the_derived_scripthash_and_matches_reply() {
        let (mut client, server) = tokio::io::duplex(4096);
        let server_task = tokio::spawn(async move {
            let mut reader = BufReader::new(server);
            let mut request = Vec::new();
            reader.read_until(b'\n', &mut request).await.unwrap();
            assert_eq!(request.last(), Some(&b'\n'));

            let request: Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(request["id"], 1);
            assert_eq!(request["method"], "blockchain.scripthash.listunspent");
            assert_eq!(
                request["params"][0],
                "8bd2c4f79944cd6a3cb1730cf92c513ae259eb271d81918457f3753eebe14a3f"
            );

            reader
                .get_mut()
                .write_all(
                    br#"{"id":1,"result":[{"tx_hash":"1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100","tx_pos":7,"height":800000,"value":12345}]}
"#,
                )
                .await
                .unwrap();
        });

        let (_, result) = exchange(&mut client, 1, &input()).await.unwrap();
        server_task.await.unwrap();
        assert_eq!(result, InputLookup::Match);
    }

    #[tokio::test]
    async fn exchange_rejects_a_response_over_256_kib() {
        let (mut client, mut server) = tokio::io::duplex(300 * 1024);
        let server_task = tokio::spawn(async move {
            let mut response = vec![b' '; 256 * 1024 + 1];
            response.push(b'\n');
            server.write_all(&response).await.unwrap();
        });

        let err = exchange(&mut client, 1, &input()).await.unwrap_err();
        server_task.await.unwrap();
        assert!(err.contains("too large"), "unexpected error: {err}");
    }
}
