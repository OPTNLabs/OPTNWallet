//! Minimal Electrum JSON-RPC client over TCP+TLS.
//!
//! Electrum framing is one JSON object per line, so responses are read to the
//! newline rather than to EOF — a server that keeps the connection open for
//! subscriptions would otherwise hang a read-to-end forever.

use std::{fmt::Write, sync::Arc, time::Duration};

use optn_core::tor::{route as tor_route, Route as TorRoute, TorStatus, AUTODETECT_SOCKS_PORTS};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use crate::error::{CliError, Result};

const DEFAULT_TOR_HOST: &str = "127.0.0.1";
const TOR_PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);
const REMOTE_ELECTRUM_TOR_REQUIRED: &str =
    "remote Electrum requires a verified Tor SOCKS proxy; refusing a direct connection";

#[derive(Debug, Deserialize)]
pub struct Balance {
    pub confirmed: i64,
    pub unconfirmed: i64,
}

#[derive(Debug, Deserialize)]
pub struct Utxo {
    pub tx_hash: String,
    pub tx_pos: u32,
    pub height: i64,
    pub value: u64,
    /// Present only on servers that index CashTokens. A server without token
    /// support omits it entirely, which is why this is an Option rather than a
    /// default — an absent field and a token-free output must not look alike.
    #[serde(default)]
    pub token_data: Option<TokenUtxo>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TokenUtxo {
    pub category: String,
    /// Servers send the amount as a decimal string, since it does not fit a
    /// JSON number safely at the top of the range.
    #[serde(default)]
    pub amount: Option<String>,
    #[serde(default)]
    pub nft: Option<TokenNft>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TokenNft {
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub commitment: Option<String>,
}

pub struct Client {
    host: String,
    port: u16,
    tls: bool,
    timeout_secs: u64,
}

impl Client {
    pub fn new(host: String, port: u16, tls: bool, timeout_secs: u64) -> Result<Self> {
        if !tls && !optn_core::endpoint::is_loopback_host(&host) {
            return Err(CliError::Usage(
                "plaintext Electrum is only allowed for a loopback server".into(),
            ));
        }
        Ok(Self {
            host,
            port,
            tls,
            timeout_secs,
        })
    }

    pub fn endpoint(&self) -> String {
        format!(
            "{}:{}{}",
            self.host,
            self.port,
            if self.tls { " (tls)" } else { " (plain)" }
        )
    }

    /// Send one request and return its `result`.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({ "id": 1, "method": method, "params": params });
        let mut line =
            serde_json::to_string(&body).map_err(|e| CliError::Internal(e.to_string()))?;
        line.push('\n');

        let deadline = std::time::Duration::from_secs(self.timeout_secs);
        let raw = tokio::time::timeout(deadline, self.exchange(line))
            .await
            .map_err(|_| {
                CliError::Network(format!(
                    "timed out after {}s talking to {}",
                    self.timeout_secs,
                    self.endpoint()
                ))
            })??;

        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| CliError::Protocol(format!("server sent invalid JSON: {e}")))?;
        if let Some(err) = parsed.get("error") {
            if !err.is_null() {
                let message = err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(&err.to_string())
                    .to_string();
                return Err(CliError::Server(message));
            }
        }
        parsed
            .get("result")
            .cloned()
            .ok_or_else(|| CliError::Protocol("response had no result field".into()))
    }

    async fn exchange(&self, line: String) -> Result<String> {
        let addr = format!("{}:{}", self.host, self.port);
        let stream = self.connect(&addr).await?;

        if !self.tls {
            let mut reader = BufReader::new(stream);
            reader
                .get_mut()
                .write_all(line.as_bytes())
                .await
                .map_err(|e| CliError::Network(e.to_string()))?;
            let mut out = String::new();
            reader
                .read_line(&mut out)
                .await
                .map_err(|e| CliError::Network(e.to_string()))?;
            return Ok(out);
        }

        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = ClientConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|error| CliError::Internal(format!("TLS configuration: {error}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let server_name = ServerName::try_from(self.host.clone()).map_err(|_| {
            CliError::Usage(format!("'{}' is not a valid TLS server name", self.host))
        })?;
        let tls_stream = TlsConnector::from(Arc::new(config))
            .connect(server_name, stream)
            .await
            .map_err(|e| CliError::Network(format!("TLS handshake with {addr} failed: {e}")))?;

        let mut reader = BufReader::new(tls_stream);
        reader
            .get_mut()
            .write_all(line.as_bytes())
            .await
            .map_err(|e| CliError::Network(e.to_string()))?;
        let mut out = String::new();
        reader
            .read_line(&mut out)
            .await
            .map_err(|e| CliError::Network(e.to_string()))?;
        Ok(out)
    }

    async fn connect(&self, addr: &str) -> Result<TcpStream> {
        let local_route = tor_route(&self.host, TorStatus::Absent);
        let route = if local_route.is_refused() {
            route_for_host(&self.host, default_tor_status().await)?
        } else {
            local_route
        };
        match route {
            TorRoute::Direct => TcpStream::connect(addr)
                .await
                .map_err(|e| CliError::Network(format!("could not connect to {addr}: {e}"))),
            TorRoute::Through { socks_port } => {
                let token = fresh_tor_isolation_token();
                let proxy = format!("{DEFAULT_TOR_HOST}:{socks_port}");
                let target = format!("{}:{}", self.host, self.port);
                tokio::time::timeout(
                    Duration::from_secs(self.timeout_secs),
                    tokio_socks::tcp::Socks5Stream::connect_with_password(
                        proxy.as_str(),
                        target.as_str(),
                        &token,
                        &token,
                    ),
                )
                .await
                .map_err(|_| {
                    CliError::Network(format!(
                        "timed out after {}s connecting to Tor SOCKS proxy {proxy}",
                        self.timeout_secs
                    ))
                })?
                .map(|stream| stream.into_inner())
                .map_err(|e| {
                    CliError::Network(format!(
                        "could not connect to {target} through Tor SOCKS proxy {proxy}: {e}"
                    ))
                })
            }
            TorRoute::Refused(_) => Err(CliError::Network(REMOTE_ELECTRUM_TOR_REQUIRED.into())),
        }
    }

    pub async fn server_version(&self) -> Result<Value> {
        self.call("server.version", json!(["optn-cli", "1.4"]))
            .await
    }

    pub async fn balance(&self, scripthash: &str) -> Result<Balance> {
        let v = self
            .call("blockchain.scripthash.get_balance", json!([scripthash]))
            .await?;
        serde_json::from_value(v).map_err(|e| CliError::Protocol(e.to_string()))
    }

    pub async fn utxos(&self, scripthash: &str) -> Result<Vec<Utxo>> {
        let v = self
            .call("blockchain.scripthash.listunspent", json!([scripthash]))
            .await?;
        serde_json::from_value(v).map_err(|e| CliError::Protocol(e.to_string()))
    }

    pub async fn transaction(&self, txid: &str, verbose: bool) -> Result<Value> {
        self.call("blockchain.transaction.get", json!([txid, verbose]))
            .await
    }

    pub async fn broadcast(&self, raw_hex: &str) -> Result<String> {
        let v = self
            .call("blockchain.transaction.broadcast", json!([raw_hex]))
            .await?;
        v.as_str()
            .map(str::to_string)
            .ok_or_else(|| CliError::Protocol("broadcast did not return a txid".into()))
    }

    pub async fn tip(&self) -> Result<(u32, String)> {
        let v = self.call("blockchain.headers.subscribe", json!([])).await?;
        let height = v
            .get("height")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::Protocol("headers.subscribe lacks height".into()))?;
        let height = u32::try_from(height)
            .map_err(|_| CliError::Protocol("tip height exceeds u32".into()))?;
        let header = v
            .get("hex")
            .or_else(|| v.get("header"))
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::Protocol("headers.subscribe lacks header hex".into()))?
            .to_owned();
        Ok((height, header))
    }

    pub async fn block_headers(&self, start_height: u32, count: u32) -> Result<Vec<[u8; 80]>> {
        let v = self
            .call("blockchain.block.headers", json!([start_height, count, 0]))
            .await?;
        parse_concatenated_headers(&v)
    }
}

fn parse_concatenated_headers(value: &Value) -> Result<Vec<[u8; 80]>> {
    let object = value
        .as_object()
        .ok_or_else(|| CliError::Protocol("block.headers result is not an object".into()))?;
    if let Some(headers) = object.get("headers").and_then(Value::as_array) {
        return headers
            .iter()
            .map(|header| {
                header
                    .as_str()
                    .ok_or_else(|| CliError::Protocol("headers array contains a non-string".into()))
                    .and_then(parse_header_hex)
            })
            .collect();
    }
    let concatenated = object.get("hex").and_then(Value::as_str).ok_or_else(|| {
        CliError::Protocol("block.headers result has neither headers[] nor hex".into())
    })?;
    if concatenated.len() % 160 != 0 {
        return Err(CliError::Protocol(
            "concatenated header hex is not a multiple of 80 bytes".into(),
        ));
    }
    (0..concatenated.len() / 160)
        .map(|i| parse_header_hex(&concatenated[i * 160..(i + 1) * 160]))
        .collect()
}

fn parse_header_hex(value: &str) -> Result<[u8; 80]> {
    if value.len() != 160 || !value.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Protocol(format!(
            "header hex must be 160 hex digits, got {}",
            value.len()
        )));
    }
    let mut header = [0u8; 80];
    for i in 0..80 {
        header[i] = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
            .map_err(|e| CliError::Protocol(format!("invalid header hex: {e}")))?;
    }
    Ok(header)
}

fn route_for_host(host: &str, tor_status: TorStatus) -> Result<TorRoute> {
    let route = tor_route(host, tor_status);
    if route.is_refused() {
        Err(CliError::Network(REMOTE_ELECTRUM_TOR_REQUIRED.into()))
    } else {
        Ok(route)
    }
}

async fn default_tor_status() -> TorStatus {
    // ponytail: default Tor ports only; add a typed persisted proxy route when
    // the shared network overlay owns custom proxy configuration.
    for &socks_port in AUTODETECT_SOCKS_PORTS {
        if is_tor_socks_proxy(DEFAULT_TOR_HOST, socks_port).await {
            return TorStatus::Verified { socks_port };
        }
    }
    TorStatus::Absent
}

/// The Rust core owns the fail-closed route decision. This Tauri-free shell
/// performs only the local SOCKS capability probe needed to supply that input.
async fn is_tor_socks_proxy(host: &str, port: u16) -> bool {
    let probe = async {
        let mut stream = TcpStream::connect((host, port)).await.ok()?;
        stream.write_all(&[0x05, 0x01, 0x00]).await.ok()?;
        let mut response = [0u8; 2];
        stream.read_exact(&mut response).await.ok()?;
        Some(response == [0x05, 0x00])
    };

    matches!(
        tokio::time::timeout(TOR_PROBE_TIMEOUT, probe).await,
        Ok(Some(true))
    )
}

fn fresh_tor_isolation_token() -> String {
    let mut bytes = [0u8; 32];
    let mut rng = OsRng;
    rng.fill_bytes(&mut bytes);
    let mut token = String::from("optn-cli-");
    for byte in bytes {
        write!(&mut token, "{byte:02x}").expect("writing into String cannot fail");
    }
    token
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn remote_electrum_has_no_direct_fallback() {
        assert!(route_for_host("electrum.example", TorStatus::Absent).is_err());
        assert_eq!(
            route_for_host("electrum.example", TorStatus::Verified { socks_port: 9050 }).unwrap(),
            TorRoute::Through { socks_port: 9050 }
        );
        assert_eq!(
            route_for_host("127.0.0.1", TorStatus::Absent).unwrap(),
            TorRoute::Direct
        );
    }

    #[test]
    fn plaintext_electrum_is_limited_to_loopback() {
        assert!(Client::new("127.0.0.1".into(), 50001, false, 1).is_ok());
        assert!(Client::new("electrum.example".into(), 50001, false, 1).is_err());
    }

    #[tokio::test]
    async fn a_plain_listener_is_not_mistaken_for_tor() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut request = [0u8; 3];
                let _ = stream.read_exact(&mut request).await;
                let _ = stream.write_all(b"HTTP/1.1 200 OK\\r\\n\\r\\n").await;
            }
        });

        assert!(!is_tor_socks_proxy("127.0.0.1", port).await);
    }
}
