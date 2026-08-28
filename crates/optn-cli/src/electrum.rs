//! Minimal Electrum JSON-RPC client over TCP+TLS.
//!
//! Electrum framing is one JSON object per line, so responses are read to the
//! newline rather than to EOF — a server that keeps the connection open for
//! subscriptions would otherwise hang a read-to-end forever.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use crate::error::{CliError, Result};

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
}

pub struct Client {
    host: String,
    port: u16,
    tls: bool,
    timeout_secs: u64,
}

impl Client {
    pub fn new(host: String, port: u16, tls: bool, timeout_secs: u64) -> Self {
        Self {
            host,
            port,
            tls,
            timeout_secs,
        }
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
        let stream = tokio::net::TcpStream::connect(&addr)
            .await
            .map_err(|e| CliError::Network(format!("could not connect to {addr}: {e}")))?;

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
        let config = ClientConfig::builder()
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
}
