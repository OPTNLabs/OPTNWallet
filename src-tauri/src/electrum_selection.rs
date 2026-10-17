//! Which Electrum servers the renderer may dial (#75 §20, §21).
//!
//! The holder's source selection decides which servers the wallet uses. The
//! native stack builds its routes from it. The renderer's Electrum client
//! dials through `electrum_tcp_connect` and used to bring its own list, so a
//! server the holder disabled, banned or excluded by policy (Privacy, own
//! infrastructure only, BIP37 or Neutrino only) was still dialled. This is the
//! one rule both the renderer's list and that command's gate use.
//!
//! How a server is reached is a separate rule (`egress`): this decides which,
//! that decides whether through Tor.

use optn_app::AppState;
use optn_core::network::Network;
use optn_runtime::chain::{
    build_selection_plan, ConnectionPolicy, EndpointKind, ProtocolFamily, SourceCatalog,
    TransportPolicy,
};
use serde::Serialize;

use crate::network_config::NetworkSettingsStore;

/// Start of the refusal `electrum_tcp_connect` returns for a server the
/// selection does not include, so the renderer can tell policy from failure.
pub(crate) const NOT_SELECTED: &str = "electrum-not-selected";

/// Emitted with the network's name after its settings change, so renderers
/// fetch the pool again.
pub(crate) const POOL_CHANGED: &str = "optn://electrum-pool-changed";

/// Services that speak the Electrum protocol for an app, not as a chain
/// source: Cauldron's Rostrum indexer. Like the app indexers reached over
/// HTTP, the source selection does not cover them; the Tor switch does.
const APP_ELECTRUM_SERVICES: &[(&str, u16)] = &[("rostrum.cauldron.quest", 50002)];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedElectrum {
    pub host: String,
    pub port: u16,
    pub tls: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElectrumPool {
    /// Whether the selection uses Electrum servers at all.
    pub allowed: bool,
    /// Why there is nothing to dial, for the holder, when `servers` is empty.
    pub reason: Option<String>,
    /// In the selection's order: primary sources, then fallback.
    pub servers: Vec<SelectedElectrum>,
}

impl ElectrumPool {
    /// Whether the renderer may dial `host:port` for this selection.
    pub fn admits(&self, host: &str, port: u16, tls: bool) -> bool {
        let host = host.trim().trim_end_matches('.');
        self.servers.iter().any(|server| {
            server.port == port && server.tls == tls && server.host.eq_ignore_ascii_case(host)
        })
    }
}

/// The selection's Electrum servers, from a resolved catalog and policy.
///
/// Electrum must be in the policy's protocols: a source is selected if any of
/// its endpoints fits, so under Privacy a source with a P2P and an Electrum
/// endpoint is selected for its P2P one. Onion servers are left out with Tor
/// off, where nothing can reach them.
pub fn pool_from(
    catalog: &SourceCatalog,
    policy: &ConnectionPolicy,
    transport: TransportPolicy,
) -> ElectrumPool {
    if !policy.protocols.contains(ProtocolFamily::Electrum) {
        return ElectrumPool {
            allowed: false,
            reason: Some(
                "This wallet's source selection does not use Electrum servers. Change it under \
                 Settings → Servers."
                    .into(),
            ),
            servers: Vec::new(),
        };
    }
    let plan = build_selection_plan(catalog, policy);
    let mut servers: Vec<SelectedElectrum> = Vec::new();
    for source in plan
        .primary
        .iter()
        .chain(plan.fallback.iter())
        .filter_map(|id| catalog.get(id))
    {
        for endpoint in &source.endpoints {
            let tls = match endpoint.kind {
                EndpointKind::ElectrumTls => true,
                EndpointKind::ElectrumTcp => false,
                _ => continue,
            };
            let Some(port) = endpoint.port else {
                continue;
            };
            let host = endpoint.host.trim_end_matches('.').to_owned();
            if transport == TransportPolicy::Direct && host.to_ascii_lowercase().ends_with(".onion")
            {
                continue;
            }
            let server = SelectedElectrum { host, port, tls };
            if !servers.contains(&server) {
                servers.push(server);
            }
        }
    }
    let reason = servers
        .is_empty()
        .then(|| "No Electrum server is selected for this network.".to_owned());
    ElectrumPool {
        allowed: true,
        reason,
        servers,
    }
}

/// The catalog and policy the wallet's sources are listed and chosen from.
///
/// A saved selection is used as saved. With none, this is the app state's
/// selection, or the shipped catalog under Auto while the app state has no
/// sources yet. The runtime itself withholds the shipped catalog until a
/// wallet is open, so an idle install connects to nobody; listing is not
/// connecting, and a renderer that connects before then (onboarding) does so
/// to the servers that ship with the app, as it always has.
pub fn listed_selection(
    settings: &NetworkSettingsStore,
    state: &AppState,
    network: Network,
) -> Result<(SourceCatalog, ConnectionPolicy), String> {
    if let Some(selection) = settings.chain_selection(network)? {
        return Ok(selection);
    }
    let (catalog, policy) = if state.network == network {
        crate::chain_runtime::catalog_and_policy_from_app_state(state)
    } else {
        (SourceCatalog::default(), ConnectionPolicy::auto())
    };
    if catalog.iter().next().is_none() {
        Ok((
            optn_runtime::bootstrap::shipped_source_catalog(network),
            policy,
        ))
    } else {
        Ok((catalog, policy))
    }
}

/// The Electrum servers `network`'s selection allows, discovered servers
/// included as the native stack ranks them: last.
pub async fn electrum_pool(
    runtime: &optn_runtime::AppRuntime,
    settings: &NetworkSettingsStore,
    network: Network,
) -> Result<ElectrumPool, String> {
    let state = runtime.state();
    let settings = settings.clone();
    tokio::task::spawn_blocking(move || {
        let (catalog, policy) = listed_selection(&settings, &state, network)?;
        let catalog = settings.with_discovered(network, catalog);
        let transport = settings.transport(network)?;
        Ok(pool_from(&catalog, &policy, transport))
    })
    .await
    .map_err(|_| "network settings reader stopped".to_string())?
}

/// The network a renderer request answers to: its window's, or the shared
/// runtime's when the window has not said. A name nobody knows is refused,
/// never read as the runtime's.
pub fn requested_network(runtime: Network, requested: Option<&str>) -> Result<Network, String> {
    match requested {
        None => Ok(runtime),
        Some(name) => name
            .parse::<Network>()
            .map_err(|_| format!("unknown network {name:?}")),
    }
}

/// Refuse a server the selection does not include, before anything dials it.
///
/// Loopback is the holder's own machine and Cauldron's indexer an app
/// service; neither is a chain source the selection chooses between.
pub async fn check_dial(
    runtime: &optn_runtime::AppRuntime,
    settings: &NetworkSettingsStore,
    network: Network,
    host: &str,
    port: u16,
    tls: bool,
) -> Result<(), String> {
    if optn_core::endpoint::is_loopback_host(host) || is_app_service(host, port, tls) {
        return Ok(());
    }
    let pool = electrum_pool(runtime, settings, network).await?;
    if pool.admits(host, port, tls) {
        return Ok(());
    }
    let why = pool.reason.filter(|_| !pool.allowed).unwrap_or_else(|| {
        format!("{host}:{port} is not one of the servers selected for {network}.")
    });
    Err(format!("{NOT_SELECTED}: {why}"))
}

/// How many Electrum servers a Fusion round may check peer inputs with.
pub(crate) const FUSION_LOOKUP_LIMIT: usize = 8;

/// The Electrum servers a CashFusion round checks peer inputs with.
///
/// The renderer offers servers in the order its health tracking prefers.
/// Those the selection includes keep that order (loopback too, as for any
/// dial); the rest of the selection follows in its own order, up to `limit`.
/// Anything else offered is dropped, so a round asks only servers the holder
/// chose about the coins in it. Empty means no round can verify inputs.
pub fn fusion_lookup_endpoints(
    pool: &ElectrumPool,
    offered: impl IntoIterator<Item = SelectedElectrum>,
    limit: usize,
) -> Vec<SelectedElectrum> {
    let mut chosen: Vec<SelectedElectrum> = Vec::new();
    let admitted = offered.into_iter().filter(|server| {
        optn_core::endpoint::is_loopback_host(&server.host)
            || pool.admits(&server.host, server.port, server.tls)
    });
    for server in admitted.chain(pool.servers.iter().cloned()) {
        if chosen.len() >= limit {
            break;
        }
        let duplicate = chosen.iter().any(|existing| {
            existing.port == server.port
                && existing.tls == server.tls
                && existing.host.eq_ignore_ascii_case(&server.host)
        });
        if !duplicate {
            chosen.push(server);
        }
    }
    chosen
}

fn is_app_service(host: &str, port: u16, tls: bool) -> bool {
    let host = host.trim().trim_end_matches('.');
    tls && APP_ELECTRUM_SERVICES
        .iter()
        .any(|(service, service_port)| *service_port == port && service.eq_ignore_ascii_case(host))
}

/// The Electrum servers the selection allows for `network` (the window's, or
/// the runtime's), in the order to try them.
#[tauri::command]
pub async fn optn_chain_electrum_pool(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
) -> Result<ElectrumPool, String> {
    let network = requested_network(runtime.state().network, network.as_deref())?;
    electrum_pool(&runtime, &network_settings, network).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::chain::{Endpoint, SourceDisposition};
    use optn_runtime::network_config::{
        add_user_source_services, set_policy_preset, ChainPolicyPreset,
    };

    fn shipped(network: Network) -> SourceCatalog {
        optn_runtime::bootstrap::shipped_source_catalog(network)
    }

    fn policy(preset: ChainPolicyPreset) -> ConnectionPolicy {
        preset.policy().expect("a named preset")
    }

    fn temporary_store(name: &str) -> (NetworkSettingsStore, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "optn-electrum-selection-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        (NetworkSettingsStore::new(directory.clone()), directory)
    }

    #[test]
    fn auto_allows_the_shipped_tls_servers_in_order() {
        let pool = pool_from(
            &shipped(Network::Mainnet),
            &ConnectionPolicy::auto(),
            TransportPolicy::Tor,
        );
        assert!(pool.allowed);
        assert!(pool.reason.is_none());
        assert!(pool.servers.len() > 5, "{pool:?}");
        assert!(pool.servers.iter().all(|server| server.tls));
        assert!(pool.admits("bch.imaginary.cash", 50002, true));
        assert!(pool.admits("BCH.Imaginary.Cash.", 50002, true));
        assert!(
            !pool.admits("bch.imaginary.cash", 50002, false),
            "TLS is part of it"
        );
        assert!(!pool.admits("bch.imaginary.cash", 50001, true));
        assert!(!pool.admits("electrum.example.org", 50002, true));
    }

    #[test]
    fn policies_without_electrum_allow_no_server_and_say_why() {
        for preset in [
            ChainPolicyPreset::Privacy,
            ChainPolicyPreset::Bip37Only,
            ChainPolicyPreset::NeutrinoOnly,
        ] {
            let pool = pool_from(
                &shipped(Network::Mainnet),
                &policy(preset),
                TransportPolicy::Tor,
            );
            assert!(!pool.allowed, "{preset:?}");
            assert!(pool.servers.is_empty(), "{preset:?}");
            assert!(pool
                .reason
                .as_deref()
                .is_some_and(|why| why.contains("Electrum")));
        }
    }

    #[test]
    fn own_infrastructure_only_allows_only_declared_servers() {
        let (store, directory) = temporary_store("own");
        store
            .update_overlay(Network::Mainnet, |overlay| {
                add_user_source_services(
                    overlay,
                    "Home",
                    vec![Endpoint {
                        kind: EndpointKind::ElectrumTls,
                        host: "node.home.example".into(),
                        port: Some(50002),
                    }],
                    Some("home"),
                )?;
                set_policy_preset(overlay, ChainPolicyPreset::OwnInfrastructure)
            })
            .unwrap();
        let (catalog, policy) =
            listed_selection(&store, &AppState::default(), Network::Mainnet).unwrap();
        let pool = pool_from(&catalog, &policy, TransportPolicy::Tor);
        assert!(pool.allowed);
        assert!(pool.admits("node.home.example", 50002, true));
        assert!(!pool.admits("bch.imaginary.cash", 50002, true));
        assert_eq!(pool.servers.len(), 1, "{pool:?}");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_disabled_or_banned_server_is_not_allowed() {
        let mut catalog = shipped(Network::Mainnet);
        let id = catalog
            .iter()
            .find(|source| {
                source
                    .endpoints
                    .iter()
                    .any(|endpoint| endpoint.host == "bch.imaginary.cash")
            })
            .map(|source| source.id.clone())
            .expect("shipped");
        for disposition in [SourceDisposition::Disabled, SourceDisposition::Banned] {
            let mut edited = catalog.clone();
            edited.set_disposition(&id, disposition).unwrap();
            let pool = pool_from(&edited, &ConnectionPolicy::auto(), TransportPolicy::Tor);
            assert!(
                !pool.admits("bch.imaginary.cash", 50002, true),
                "{disposition:?}"
            );
        }
        catalog
            .set_disposition(&id, SourceDisposition::Enabled)
            .unwrap();
        assert!(
            pool_from(&catalog, &ConnectionPolicy::auto(), TransportPolicy::Tor).admits(
                "bch.imaginary.cash",
                50002,
                true
            )
        );
    }

    #[test]
    fn onion_servers_are_left_out_with_tor_off() {
        let catalog = shipped(Network::Mainnet);
        let with_tor = pool_from(&catalog, &ConnectionPolicy::auto(), TransportPolicy::Tor);
        assert!(with_tor
            .servers
            .iter()
            .any(|server| server.host.ends_with(".onion")));
        let direct = pool_from(&catalog, &ConnectionPolicy::auto(), TransportPolicy::Direct);
        assert!(direct
            .servers
            .iter()
            .all(|server| !server.host.ends_with(".onion")));
        assert!(!direct.servers.is_empty());
    }

    #[test]
    fn with_nothing_saved_the_shipped_servers_are_listed() {
        let (store, directory) = temporary_store("idle");
        let state = AppState::default();
        let (catalog, policy) =
            listed_selection(&store, &state, Network::Chipnet).expect("no file is not an error");
        assert_eq!(policy, ConnectionPolicy::auto());
        assert!(pool_from(&catalog, &policy, TransportPolicy::Tor).admits(
            "chipnet.imaginary.cash",
            50002,
            true
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_saved_policy_decides_once_it_exists() {
        let (store, directory) = temporary_store("saved");
        store
            .update_overlay(Network::Chipnet, |overlay| {
                set_policy_preset(overlay, ChainPolicyPreset::Privacy)
            })
            .unwrap();
        let (catalog, policy) =
            listed_selection(&store, &AppState::default(), Network::Chipnet).unwrap();
        assert!(!pool_from(&catalog, &policy, TransportPolicy::Tor).allowed);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn loopback_and_the_cauldron_indexer_are_not_chain_sources() {
        assert!(is_app_service("rostrum.cauldron.quest", 50002, true));
        assert!(is_app_service("Rostrum.Cauldron.Quest.", 50002, true));
        assert!(!is_app_service("rostrum.cauldron.quest", 50002, false));
        assert!(!is_app_service("rostrum.cauldron.quest", 50001, true));
        assert!(!is_app_service("cauldron.quest", 50002, true));
    }

    #[test]
    fn fusion_checks_inputs_only_with_selected_servers() {
        let server = |host: &str| SelectedElectrum {
            host: host.into(),
            port: 50002,
            tls: true,
        };
        let pool = pool_from(
            &shipped(Network::Mainnet),
            &ConnectionPolicy::auto(),
            TransportPolicy::Tor,
        );
        let chosen = fusion_lookup_endpoints(
            &pool,
            [
                server("electrum.example.org"),
                server("bch.loping.net"),
                server("127.0.0.1"),
                server("BCH.LOPING.NET"),
            ],
            4,
        );
        assert_eq!(chosen.len(), 4);
        assert_eq!(
            chosen[0].host, "bch.loping.net",
            "the renderer's order first"
        );
        assert_eq!(chosen[1].host, "127.0.0.1");
        assert!(chosen
            .iter()
            .all(|server| server.host != "electrum.example.org"));
        assert!(chosen[2..].iter().all(|server| pool.admits(
            &server.host,
            server.port,
            server.tls
        )));

        let none = pool_from(
            &shipped(Network::Mainnet),
            &policy(ChainPolicyPreset::Privacy),
            TransportPolicy::Tor,
        );
        assert!(fusion_lookup_endpoints(&none, [server("bch.loping.net")], 4).is_empty());
    }

    #[test]
    fn a_window_names_its_network_or_is_refused() {
        assert_eq!(
            requested_network(Network::Mainnet, None),
            Ok(Network::Mainnet)
        );
        assert_eq!(
            requested_network(Network::Mainnet, Some("chipnet")),
            Ok(Network::Chipnet)
        );
        assert!(requested_network(Network::Mainnet, Some("bogus")).is_err());
    }
}
