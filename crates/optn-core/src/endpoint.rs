//! User-supplied server endpoints: Electrum/Fulcrum and BCH P2P peers.
//!
//! Ported from the React `ElectrumServer` entry parser, including the rule
//! that matters most: **an unencrypted WebSocket is only allowed to a
//! loopback host.** Electrum tells the server every address the wallet owns,
//! so plaintext to a remote host hands the wallet's whole history to anyone
//! on the path. Locally it is fine and is how people run their own Fulcrum.
//!
//! A bare host defaults to encrypted, never to plaintext — the safe direction
//! to be wrong in.
//!
//! Fulcrum and a BCH P2P peer are deliberately separate endpoint types. They speak
//! different protocols on different ports (the wallet's own hint string is
//! "Fulcrum host:50002, or a node host:8333"), and collapsing them into one
//! "server" string would make every error message useless.

use std::fmt;

use crate::error::{CliError, Result};

/// Default port for `wss://`, matching `WSS_PORT` in the React client.
pub const DEFAULT_WSS_PORT: u16 = 50004;
/// Default port for a plaintext WebSocket.
pub const DEFAULT_WS_PORT: u16 = 50003;
/// The port the wallet's own hint text tells users Fulcrum listens on.
pub const FULCRUM_HINT_PORT: u16 = 50002;
/// The port the hint text uses for a full node's p2p listener.
pub const NODE_HINT_PORT: u16 = 8333;

/// Longest hostname we accept, per DNS.
const MAX_HOST_LEN: usize = 253;

/// An Electrum/Fulcrum endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElectrumEndpoint {
    host: String,
    port: u16,
    encrypted: bool,
}

impl ElectrumEndpoint {
    pub fn host(&self) -> &str {
        &self.host
    }

    pub const fn port(&self) -> u16 {
        self.port
    }

    /// `true` for `wss://`. Plaintext is only reachable on loopback.
    pub const fn encrypted(&self) -> bool {
        self.encrypted
    }

    pub fn url(&self) -> String {
        let scheme = if self.encrypted { "wss" } else { "ws" };
        format!("{scheme}://{}:{}", self.host, self.port)
    }
}

impl fmt::Display for ElectrumEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.url())
    }
}

/// A full node's BCH P2P listener; runtime capability probes decide how it is used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerEndpoint {
    host: String,
    port: u16,
}

impl PeerEndpoint {
    pub fn host(&self) -> &str {
        &self.host
    }

    pub const fn port(&self) -> u16 {
        self.port
    }
}

impl fmt::Display for PeerEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

/// Whether a host is the local machine.
///
/// Only these reach the same machine, so only these may be spoken to in
/// plaintext. `localhost.evil.example` must not match, which is why this
/// compares whole labels rather than using `starts_with`.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host == "::1" || host == "0:0:0:0:0:0:0:1" {
        return true;
    }
    // Any 127.0.0.0/8 address is loopback, not just 127.0.0.1.
    let mut octets = host.split('.');
    let Some("127") = octets.next() else {
        return false;
    };
    let rest: Vec<&str> = octets.collect();
    rest.len() == 3
        && rest
            .iter()
            .all(|part| !part.is_empty() && part.parse::<u8>().is_ok())
}

fn validate_host(host: &str) -> Result<String> {
    let host = host.trim();
    if host.is_empty() {
        return Err(CliError::Usage("enter a server host".into()));
    }
    if host.len() > MAX_HOST_LEN {
        return Err(CliError::Usage("that host name is too long".into()));
    }
    // A stray path, credential or query means the user pasted something that
    // is not a host; guessing which part they meant would be worse than
    // asking.
    if host.contains(['/', '\\', '@', '?', '#', ' ']) {
        return Err(CliError::Usage(format!(
            "'{host}' is not a plain host name — enter just the host, such as fulcrum.example"
        )));
    }
    Ok(host.to_owned())
}

fn parse_port(raw: &str) -> Result<u16> {
    let trimmed = raw.trim();
    trimmed
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| CliError::Usage(format!("'{trimmed}' is not a port between 1 and 65535")))
}

/// Split a `host:port` pair, tolerating a bracketed IPv6 literal.
fn split_host_port(entry: &str) -> Option<(&str, &str)> {
    if let Some(rest) = entry.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = tail.strip_prefix(':')?;
        return Some((host, port));
    }
    // A bare IPv6 literal has many colons and no port; only a single colon is
    // a host/port split.
    let (host, port) = entry.rsplit_once(':')?;
    if host.contains(':') {
        return None;
    }
    Some((host, port))
}

/// Parse a user-typed Electrum entry: `wss://host:port`, `host:port`, or `host`.
///
/// `default_port` is used when the entry carries none.
pub fn parse_electrum_endpoint(entry: &str, default_port: u16) -> Result<ElectrumEndpoint> {
    let entry = entry.trim();
    if entry.is_empty() {
        return Err(CliError::Usage("enter a server address".into()));
    }

    // Scheme form.
    for (scheme, encrypted, scheme_port) in [
        ("wss://", true, DEFAULT_WSS_PORT),
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
        ("ws://", false, DEFAULT_WS_PORT),
    ] {
        let Some(rest) = entry.strip_prefix(scheme) else {
            continue;
        };
        let (host, port) = match split_host_port(rest) {
            Some((host, port)) => (validate_host(host)?, parse_port(port)?),
            None => (validate_host(rest)?, scheme_port),
        };
        if !encrypted && !is_loopback_host(&host) {
            return Err(CliError::Usage(
                // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
                "an unencrypted ws:// server is only allowed on this machine. \
                 Electrum sends it every address in your wallet, so use wss:// \
                 for a remote server."
                    .into(),
            ));
        }
        return Ok(ElectrumEndpoint {
            host,
            port,
            encrypted,
        });
    }

    // A scheme we do not speak is refused rather than silently treated as a
    // host name.
    if let Some((maybe_scheme, _)) = entry.split_once("://") {
        return Err(CliError::Usage(format!(
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
            "'{maybe_scheme}://' is not an Electrum transport — use wss:// or ws://"
        )));
    }

    match split_host_port(entry) {
        Some((host, port)) => Ok(ElectrumEndpoint {
            host: validate_host(host)?,
            port: parse_port(port)?,
            // Bare host:port defaults to encrypted, as the React parser does.
            encrypted: true,
        }),
        None => Ok(ElectrumEndpoint {
            host: validate_host(entry)?,
            port: default_port,
            encrypted: true,
        }),
    }
}

/// Parse a user-typed BCH P2P peer: `host:port`, or `host` with `default_port`.
pub fn parse_peer_endpoint(entry: &str, default_port: u16) -> Result<PeerEndpoint> {
    let entry = entry.trim();
    if entry.is_empty() {
        return Err(CliError::Usage("enter a node host".into()));
    }
    if entry.contains("://") {
        return Err(CliError::Usage(
            "a node is a host and port, not a URL — for example node.example:8333".into(),
        ));
    }
    match split_host_port(entry) {
        Some((host, port)) => Ok(PeerEndpoint {
            host: validate_host(host)?,
            port: parse_port(port)?,
        }),
        None => Ok(PeerEndpoint {
            host: validate_host(entry)?,
            port: default_port,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_is_refused_to_anywhere_but_this_machine() {
        // The invariant this module exists for. Electrum tells the server
        // every address the wallet owns.
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
        let remote = parse_electrum_endpoint("ws://fulcrum.example:50003", DEFAULT_WSS_PORT);
        match remote {
            Err(CliError::Usage(message)) => {
                assert!(message.contains("every address"), "unexpected: {message}");
            }
            other => panic!("remote plaintext must be refused, got {other:?}"),
        }

        // Locally it is exactly how someone runs their own Fulcrum.
        for local in [
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
            "ws://localhost:50003",
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
            "ws://127.0.0.1:50003",
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
            "ws://[::1]:50003",
        ] {
            let parsed = parse_electrum_endpoint(local, DEFAULT_WSS_PORT)
                .unwrap_or_else(|e| panic!("{local} must be allowed: {e}"));
            assert!(!parsed.encrypted(), "{local}");
        }
    }

    #[test]
    fn a_lookalike_host_is_not_loopback() {
        // `localhost.evil.example` resolves wherever its owner wants it to.
        for impostor in [
            "localhost.evil.example",
            "notlocalhost",
            "127.0.0.1.evil.example",
            "1270.0.1",
            "example.com",
        ] {
            assert!(!is_loopback_host(impostor), "{impostor} must not be local");
            assert!(
                // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
                parse_electrum_endpoint(&format!("ws://{impostor}:50003"), DEFAULT_WSS_PORT)
                    .is_err(),
                "{impostor} must not get plaintext"
            );
        }
        // The whole 127/8 block is the local machine.
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.1.2.3"));
        assert!(!is_loopback_host("128.0.0.1"));
    }

    #[test]
    fn an_entry_without_a_scheme_defaults_to_encrypted() {
        // Defaulting to plaintext would silently downgrade every wallet that
        // typed a bare host.
        let bare = parse_electrum_endpoint("fulcrum.example", DEFAULT_WSS_PORT).unwrap();
        assert_eq!(bare.host(), "fulcrum.example");
        assert_eq!(bare.port(), DEFAULT_WSS_PORT);
        assert!(bare.encrypted());
        assert_eq!(bare.url(), "wss://fulcrum.example:50004");

        let with_port = parse_electrum_endpoint("fulcrum.example:50002", DEFAULT_WSS_PORT).unwrap();
        assert_eq!(with_port.port(), FULCRUM_HINT_PORT);
        assert!(with_port.encrypted());
    }

    #[test]
    fn schemes_carry_their_own_default_ports() {
        let wss = parse_electrum_endpoint("wss://fulcrum.example", DEFAULT_WSS_PORT).unwrap();
        assert_eq!(wss.port(), DEFAULT_WSS_PORT);
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
        let ws = parse_electrum_endpoint("ws://localhost", DEFAULT_WSS_PORT).unwrap();
        assert_eq!(ws.port(), DEFAULT_WS_PORT);
    }

    #[test]
    fn nonsense_is_refused_rather_than_guessed_at() {
        for bad in [
            "",
            "   ",
            "fulcrum.example:0",
            "fulcrum.example:99999",
            "fulcrum.example:abc",
            "http://fulcrum.example",
            "https://fulcrum.example",
            "user@fulcrum.example:50002",
            "fulcrum.example/path",
            "two hosts.example",
        ] {
            assert!(
                parse_electrum_endpoint(bad, DEFAULT_WSS_PORT).is_err(),
                "{bad:?} must not parse"
            );
        }
    }

    #[test]
    fn a_node_is_a_host_and_port_not_a_url() {
        let peer = parse_peer_endpoint("node.example:8333", NODE_HINT_PORT).unwrap();
        assert_eq!(peer.host(), "node.example");
        assert_eq!(peer.port(), NODE_HINT_PORT);
        assert_eq!(peer.to_string(), "node.example:8333");

        let defaulted = parse_peer_endpoint("node.example", NODE_HINT_PORT).unwrap();
        assert_eq!(defaulted.port(), NODE_HINT_PORT);

        // Pasting an Electrum URL into the node field is a category error and
        // says so, rather than half-working.
        match parse_peer_endpoint("wss://node.example:8333", NODE_HINT_PORT) {
            Err(CliError::Usage(message)) => assert!(message.contains("not a URL"), "{message}"),
            other => panic!("expected a category error, got {other:?}"),
        }
        assert!(parse_peer_endpoint("", NODE_HINT_PORT).is_err());
    }

    #[test]
    fn ipv6_literals_survive_the_host_port_split() {
        let bracketed = parse_electrum_endpoint("[2001:db8::1]:50002", DEFAULT_WSS_PORT).unwrap();
        assert_eq!(bracketed.host(), "2001:db8::1");
        assert_eq!(bracketed.port(), FULCRUM_HINT_PORT);

        // Unbracketed, there is no port to find, so the whole thing is the
        // host and the default port applies rather than "db8::1" being eaten.
        let bare = parse_electrum_endpoint("2001:db8::1", DEFAULT_WSS_PORT).unwrap();
        assert_eq!(bare.host(), "2001:db8::1");
        assert_eq!(bare.port(), DEFAULT_WSS_PORT);
    }
}
