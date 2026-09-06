//! Bring your own node, Electrum server and block explorer.
//!
//! Three separate things, kept separate on purpose. The wallet's own hint
//! string is "Fulcrum host:50002, or a node host:8333": Fulcrum speaks
//! Electrum while a node exposes BCH P2P capabilities such as BIP37 or compact
//! filters; an explorer is a web URL. Capabilities are not permanently owned by
//! either route. One shared "server" string would make every error
//! message useless and would let a node host be tried as an Electrum server.
//!
//! Overrides are stored **per network**, in separate fields rather than a map
//! keyed by network. A chipnet Fulcrum answering mainnet queries returns
//! empty results that look exactly like an empty wallet, so the type is shaped
//! so that a chipnet host cannot be read while mainnet is selected — there is
//! no code path that would let it.
//!
//! Validation lives in `optn_core::endpoint`, which refuses a plaintext
//! WebSocket to anything but loopback.

use optn_core::endpoint::{
    parse_electrum_endpoint, parse_peer_endpoint, DEFAULT_WSS_PORT, NODE_HINT_PORT,
};
use optn_core::network::Network;

/// Which endpoint a setting refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ServerKind {
    /// Fulcrum, over Electrum.
    Electrum,
    /// A full node's BCH P2P listener. Runtime probes its capabilities.
    Peer,
    /// Web block explorer, for "view this transaction".
    Explorer,
}

impl ServerKind {
    pub const ALL: &'static [Self] = &[Self::Electrum, Self::Peer, Self::Explorer];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Electrum => "Electrum server",
            Self::Peer => "Node (P2P)",
            Self::Explorer => "Block explorer",
        }
    }

    pub const fn id(self) -> &'static str {
        match self {
            Self::Electrum => "electrum",
            Self::Peer => "peer",
            Self::Explorer => "explorer",
        }
    }

    /// Placeholder showing the shape and the port people expect.
    pub const fn hint(self) -> &'static str {
        match self {
            Self::Electrum => "fulcrum.example:50002",
            Self::Peer => "node.example:8333",
            Self::Explorer => "https://explorer.example",
        }
    }
}

/// One network's overrides. Absent means "use the network default".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkServers {
    pub electrum: Option<String>,
    pub peer: Option<String>,
    pub explorer: Option<String>,
}

impl NetworkServers {
    pub const fn new() -> Self {
        Self {
            electrum: None,
            peer: None,
            explorer: None,
        }
    }

    pub fn get(&self, kind: ServerKind) -> Option<&str> {
        match kind {
            ServerKind::Electrum => self.electrum.as_deref(),
            ServerKind::Peer => self.peer.as_deref(),
            ServerKind::Explorer => self.explorer.as_deref(),
        }
    }

    fn set(&mut self, kind: ServerKind, value: Option<String>) {
        match kind {
            ServerKind::Electrum => self.electrum = value,
            ServerKind::Peer => self.peer = value,
            ServerKind::Explorer => self.explorer = value,
        }
    }

    pub const fn is_empty(&self) -> bool {
        self.electrum.is_none() && self.peer.is_none() && self.explorer.is_none()
    }
}

/// Overrides for every network, held separately.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerOverrides {
    mainnet: NetworkServers,
    chipnet: NetworkServers,
}

impl ServerOverrides {
    pub const fn new() -> Self {
        Self {
            mainnet: NetworkServers::new(),
            chipnet: NetworkServers::new(),
        }
    }

    /// The overrides for one network. There is no accessor that returns
    /// another network's, which is the point.
    pub const fn for_network(&self, network: Network) -> &NetworkServers {
        match network {
            Network::Mainnet => &self.mainnet,
            Network::Chipnet => &self.chipnet,
        }
    }

    fn for_network_mut(&mut self, network: Network) -> &mut NetworkServers {
        match network {
            Network::Mainnet => &mut self.mainnet,
            Network::Chipnet => &mut self.chipnet,
        }
    }

    /// Validate and store one override.
    ///
    /// An empty entry clears it, which is how "use network default" is
    /// expressed for a single field.
    pub fn set(
        &mut self,
        network: Network,
        kind: ServerKind,
        entry: &str,
    ) -> Result<Option<String>, String> {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            self.for_network_mut(network).set(kind, None);
            return Ok(None);
        }
        let canonical = validate(kind, trimmed)?;
        self.for_network_mut(network)
            .set(kind, Some(canonical.clone()));
        Ok(Some(canonical))
    }

    /// Drop every override for one network — "Use network default".
    ///
    /// Scoped to one network so resetting chipnet cannot wipe a mainnet
    /// server the user configured deliberately.
    pub fn use_network_default(&mut self, network: Network) -> bool {
        let servers = self.for_network_mut(network);
        if servers.is_empty() {
            return false;
        }
        *servers = NetworkServers::new();
        true
    }

    /// The Electrum endpoint in force, override or default.
    pub fn effective_electrum(&self, network: Network) -> String {
        match self.for_network(network).electrum.as_deref() {
            Some(entry) => entry.to_owned(),
            None => format!("{}:{}", network.default_host(), network.default_port()),
        }
    }
}

/// Canonicalise one entry for its kind, or say why it cannot be used.
fn validate(kind: ServerKind, entry: &str) -> Result<String, String> {
    match kind {
        ServerKind::Electrum => parse_electrum_endpoint(entry, DEFAULT_WSS_PORT)
            .map(|endpoint| format!("{}:{}", endpoint.host(), endpoint.port()))
            .map_err(|error| error.to_string()),
        ServerKind::Peer => parse_peer_endpoint(entry, NODE_HINT_PORT)
            .map(|endpoint| endpoint.to_string())
            .map_err(|error| error.to_string()),
        ServerKind::Explorer => validate_explorer(entry),
    }
}

/// An explorer is a web URL, not a host and port.
fn validate_explorer(entry: &str) -> Result<String, String> {
    let trimmed = entry.trim().trim_end_matches('/');
    let rest = trimmed.strip_prefix("https://").ok_or_else(|| {
        if trimmed.starts_with("http://") {
            // A transaction id in a plaintext URL tells anyone on the path
            // which transactions this wallet cares about.
            "a block explorer must be https://, so the transactions you look up are not \
                 sent in the clear"
                .to_string()
        } else {
            "enter a block explorer URL beginning with https://".to_string()
        }
    })?;
    if rest.is_empty() || rest.starts_with('/') {
        return Err("that explorer URL has no host".into());
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chipnet_server_is_never_read_while_mainnet_is_selected() {
        // The invariant this type exists for. A chipnet Fulcrum answering
        // mainnet queries returns empty results that look exactly like an
        // empty wallet.
        let mut servers = ServerOverrides::new();
        servers
            .set(Network::Chipnet, ServerKind::Electrum, "chip.example:50002")
            .expect("valid");

        assert_eq!(
            servers.for_network(Network::Mainnet).electrum,
            None,
            "a chipnet override must not be visible from mainnet"
        );
        assert_eq!(
            servers.effective_electrum(Network::Mainnet),
            format!(
                "{}:{}",
                Network::Mainnet.default_host(),
                Network::Mainnet.default_port()
            )
        );
        assert_eq!(
            servers.effective_electrum(Network::Chipnet),
            "chip.example:50002"
        );
    }

    #[test]
    fn use_network_default_clears_only_that_network() {
        let mut servers = ServerOverrides::new();
        servers
            .set(Network::Mainnet, ServerKind::Electrum, "main.example:50002")
            .unwrap();
        servers
            .set(Network::Chipnet, ServerKind::Electrum, "chip.example:50002")
            .unwrap();

        assert!(servers.use_network_default(Network::Chipnet));
        assert!(servers.for_network(Network::Chipnet).is_empty());
        assert_eq!(
            servers.for_network(Network::Mainnet).electrum.as_deref(),
            Some("main.example:50002"),
            "resetting chipnet must not wipe a deliberate mainnet server"
        );
        // Nothing to clear reports no change rather than a spurious event.
        assert!(!servers.use_network_default(Network::Chipnet));
    }

    #[test]
    fn the_three_kinds_do_not_accept_each_others_entries() {
        let mut servers = ServerOverrides::new();

        // A node host pasted into the Electrum field is accepted as a host and
        // port -- both are host:port -- but a URL is not a node.
        assert!(servers
            .set(
                Network::Mainnet,
                ServerKind::Peer,
                "wss://node.example:8333"
            )
            .is_err());

        // An explorer must be a URL, not a bare host.
        assert!(servers
            .set(Network::Mainnet, ServerKind::Explorer, "explorer.example")
            .is_err());
        assert_eq!(
            servers
                .set(
                    Network::Mainnet,
                    ServerKind::Explorer,
                    "https://explorer.example/"
                )
                .unwrap(),
            Some("https://explorer.example".into()),
            "a trailing slash is not a different explorer"
        );
    }

    #[test]
    fn a_plaintext_explorer_is_refused_with_the_reason() {
        // A transaction id in a plaintext URL tells anyone on the path which
        // transactions this wallet cares about.
        let mut servers = ServerOverrides::new();
        let error = servers
            .set(
                Network::Mainnet,
                ServerKind::Explorer,
                "http://explorer.example",
            )
            .unwrap_err();
        assert!(error.contains("in the clear"), "{error}");
    }

    #[test]
    fn a_remote_plaintext_electrum_is_refused_through_this_layer_too() {
        // optn-core owns the rule; this asserts the setting cannot bypass it.
        let mut servers = ServerOverrides::new();
        let error = servers
            .set(
                Network::Mainnet,
                ServerKind::Electrum,
                // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
                "ws://fulcrum.example:50003",
            )
            .unwrap_err();
        assert!(error.contains("every address"), "{error}");

        // The same server on this machine is fine.
        assert!(servers
            .set(
                Network::Mainnet,
                ServerKind::Electrum,
                // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
                "ws://127.0.0.1:50003"
            )
            .is_ok());
    }

    #[test]
    fn an_empty_entry_clears_one_field_without_touching_the_others() {
        let mut servers = ServerOverrides::new();
        servers
            .set(Network::Mainnet, ServerKind::Electrum, "main.example:50002")
            .unwrap();
        servers
            .set(Network::Mainnet, ServerKind::Peer, "node.example:8333")
            .unwrap();

        assert_eq!(
            servers
                .set(Network::Mainnet, ServerKind::Electrum, "   ")
                .unwrap(),
            None
        );
        assert_eq!(servers.for_network(Network::Mainnet).electrum, None);
        assert_eq!(
            servers.for_network(Network::Mainnet).peer.as_deref(),
            Some("node.example:8333"),
            "clearing one field must not clear another"
        );
        assert!(!servers.for_network(Network::Mainnet).is_empty());
    }

    #[test]
    fn every_kind_is_labelled_and_hinted() {
        assert_eq!(ServerKind::ALL.len(), 3);
        for kind in ServerKind::ALL {
            assert!(!kind.label().is_empty());
            assert!(!kind.id().is_empty());
            assert!(!kind.hint().is_empty());
        }
        // The hints carry the ports the wallet's own copy promises.
        assert!(ServerKind::Electrum.hint().contains("50002"));
        assert!(ServerKind::Peer.hint().contains("8333"));
    }
}
