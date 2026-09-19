//! Multi-source chain selection for the shipping wallet UI.
//!
//! The runtime has carried #75's model for a while — several sources, each with
//! endpoints, capabilities and a disposition, chosen by a connection policy —
//! while the settings screen could still only hold one Electrum server and one
//! peer. That gap is why an advanced policy had to be *rejected* by the legacy
//! bridge rather than shown: a surface that cannot display own-infrastructure,
//! protocol filters or bans must not be allowed to overwrite them.
//!
//! These commands expose the real model instead. Policy stays in
//! `optn-runtime`: this module reads it, edits the durable overlay through the
//! shared helpers, and reports what the live stack made of it. It decides
//! nothing itself.

use crate::chain_runtime::NativeChainRuntime;
use crate::network_config::NetworkSettingsStore;
use optn_core::network::Network;
use optn_runtime::chain::{
    build_selection_plan, ChainSource, ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily,
    SourceCatalog, SourceDisposition, SourceId, SourceOrigin, SourceScope,
};
use optn_runtime::chain_service::ChainOperation;
use optn_runtime::network_config::{
    add_user_source, remove_user_source, set_policy_preset, set_source_disposition,
    ChainPolicyPreset,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct EndpointView {
    /// `electrum-tls`, `p2p`, … — the same labels the source ids are built from.
    pub kind: String,
    pub host: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceFailureView {
    pub protocol: String,
    pub endpoint: EndpointView,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChainSourceView {
    pub id: String,
    pub label: String,
    /// `bootstrap` | `user` | `own-infrastructure`.
    pub origin: String,
    pub group: Option<String>,
    /// `enabled` | `disabled` | `banned`.
    pub disposition: String,
    pub priority: u16,
    /// Bootstrap entries are disabled, never deleted: the base catalog has to
    /// stay recoverable for a later refresh to be deterministic.
    pub can_remove: bool,
    pub endpoints: Vec<EndpointView>,
    pub capabilities: Vec<String>,
    /// In the current selection plan: `primary`, `fallback`, or absent.
    pub role: Option<String>,
    /// Protocols this source has a live provider for right now. An empty list
    /// next to a `primary` role is the honest way to show a route that was
    /// selected but could not be opened.
    pub live_protocols: Vec<String>,
    pub failures: Vec<SourceFailureView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifiedTipView {
    pub height: u32,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChainSourcesView {
    pub network: String,
    /// `auto` | `privacy` | `own_infrastructure` | `electrum_only` |
    /// `bip37_only` | `neutrino_only` | `custom`.
    pub policy: String,
    pub protocols: Vec<String>,
    /// `all-enabled` | `own-infrastructure` | `explicit`.
    pub scope: String,
    pub sources: Vec<ChainSourceView>,
    /// A persisted policy that could not be resolved. No provider is registered
    /// in that state, which is why it is surfaced rather than swallowed.
    pub configuration_error: Option<String>,
    /// How many routes can answer a wallet refresh right now. Zero with sources
    /// present means the policy or the transport refused them, not that the
    /// wallet has no servers configured.
    pub wallet_routes: usize,
    /// Tip of the accepted chain this host has verified (SHV/MMR), if any.
    pub verified_tip: Option<VerifiedTipView>,
    /// What this host found when it went looking for a proxy.
    pub tor: TorProxyView,
}

/// The proxy situation, for a screen that has to explain a refusal.
///
/// "No Tor found" and "a proxy is there but I cannot tell whether it is yours"
/// call for different actions from the holder -- start Tor, or confirm the Tor
/// they already run -- and a screen that cannot tell them apart can only offer
/// the wrong one half the time.
#[derive(Debug, Clone, Serialize)]
pub struct TorProxyView {
    /// `verified` | `unverified` | `absent` | `not_needed`.
    pub status: String,
    /// The port a proxy answered on, whether or not it is trusted.
    pub socks_port: Option<u16>,
    /// Ports the holder has already confirmed.
    pub trusted_ports: Vec<u16>,
}

fn endpoint_view(endpoint: &Endpoint) -> EndpointView {
    EndpointView {
        kind: endpoint_kind_label(endpoint.kind).to_owned(),
        host: endpoint.host.clone(),
        port: endpoint.port,
    }
}

const fn endpoint_kind_label(kind: EndpointKind) -> &'static str {
    match kind {
        EndpointKind::BchP2p => "p2p",
        EndpointKind::ElectrumTls => "electrum-tls",
        EndpointKind::ElectrumTcp => "electrum-tcp",
        EndpointKind::BchnRpc => "node-rpc",
        EndpointKind::BchnZmq => "node-zmq",
        EndpointKind::ExplorerHttp => "explorer-http",
        EndpointKind::ExplorerHttps => "explorer-https",
    }
}

fn parse_endpoint_kind(value: &str) -> Result<EndpointKind, String> {
    Ok(match value {
        "p2p" => EndpointKind::BchP2p,
        "electrum-tls" => EndpointKind::ElectrumTls,
        "electrum-tcp" => EndpointKind::ElectrumTcp,
        "node-rpc" => EndpointKind::BchnRpc,
        "node-zmq" => EndpointKind::BchnZmq,
        "explorer-https" => EndpointKind::ExplorerHttps,
        "explorer-http" => EndpointKind::ExplorerHttp,
        other => return Err(format!("unknown endpoint kind '{other}'")),
    })
}

const fn protocol_label(protocol: ProtocolFamily) -> &'static str {
    match protocol {
        ProtocolFamily::Electrum => "electrum",
        ProtocolFamily::Bip37 => "bip37",
        ProtocolFamily::Neutrino => "neutrino",
        ProtocolFamily::BchnRpc => "node-rpc",
        ProtocolFamily::BchnZmq => "node-zmq",
    }
}

fn origin_view(origin: &SourceOrigin) -> (String, Option<String>) {
    match origin {
        SourceOrigin::Bootstrap { .. } => ("bootstrap".into(), None),
        SourceOrigin::UserAdded => ("user".into(), None),
        SourceOrigin::UserInfrastructure { group } => {
            ("own-infrastructure".into(), Some(group.clone()))
        }
    }
}

const fn disposition_label(disposition: SourceDisposition) -> &'static str {
    match disposition {
        SourceDisposition::Enabled => "enabled",
        SourceDisposition::Disabled => "disabled",
        SourceDisposition::Banned => "banned",
    }
}

fn parse_disposition(value: &str) -> Result<SourceDisposition, String> {
    Ok(match value {
        "enabled" => SourceDisposition::Enabled,
        "disabled" => SourceDisposition::Disabled,
        "banned" => SourceDisposition::Banned,
        other => return Err(format!("unknown disposition '{other}'")),
    })
}

const fn scope_label(scope: &SourceScope) -> &'static str {
    match scope {
        SourceScope::AllEnabled => "all-enabled",
        SourceScope::PublicEnabled => "public-enabled",
        SourceScope::UserInfrastructure => "own-infrastructure",
        SourceScope::Explicit(_) => "explicit",
    }
}

fn parse_network(value: &str) -> Result<Network, String> {
    value
        .parse()
        .map_err(|_| format!("unknown network '{value}'"))
}

fn source_views(
    catalog: &SourceCatalog,
    policy: &ConnectionPolicy,
    live: &[(SourceId, ProtocolFamily)],
    failures: &[optn_chain_native::NativeChainProbeFailure],
) -> Vec<ChainSourceView> {
    let plan = build_selection_plan(catalog, policy);
    let mut sources: Vec<_> = catalog.iter().cloned().collect();
    // Selection order first, then priority: the list reads the way the runtime
    // will actually try them.
    sources.sort_by_key(|source: &ChainSource| {
        let rank = if plan.primary.contains(&source.id) {
            0
        } else if plan.fallback.contains(&source.id) {
            1
        } else {
            2
        };
        (rank, source.priority, source.label.clone())
    });

    sources
        .into_iter()
        .map(|source| {
            let (origin, group) = origin_view(&source.origin);
            ChainSourceView {
                role: if plan.primary.contains(&source.id) {
                    Some("primary".into())
                } else if plan.fallback.contains(&source.id) {
                    Some("fallback".into())
                } else {
                    None
                },
                live_protocols: live
                    .iter()
                    .filter(|(id, _)| id == &source.id)
                    .map(|(_, protocol)| protocol_label(*protocol).to_owned())
                    .collect(),
                failures: failures
                    .iter()
                    .filter(|failure| failure.source == source.id)
                    .map(|failure| SourceFailureView {
                        protocol: protocol_label(failure.protocol).to_owned(),
                        endpoint: endpoint_view(&failure.endpoint),
                        error: failure.error.clone(),
                    })
                    .collect(),
                id: source.id.as_str().to_owned(),
                label: source.label.clone(),
                origin,
                group,
                disposition: disposition_label(source.disposition).to_owned(),
                priority: source.priority,
                can_remove: source.can_remove(),
                endpoints: source.endpoints.iter().map(endpoint_view).collect(),
                capabilities: source
                    .capabilities
                    .iter()
                    .map(|capability| format!("{capability:?}"))
                    .collect(),
            }
        })
        .collect()
}

/// Every source for a network, with the policy and what the live stack made of it.
#[tauri::command]
pub async fn optn_chain_sources(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
) -> Result<ChainSourcesView, String> {
    let network = match network {
        Some(value) => parse_network(&value)?,
        None => runtime.state().network,
    };
    let settings = (*network_settings).clone();
    let persisted = tokio::task::spawn_blocking(move || settings.chain_selection(network))
        .await
        .map_err(|_| "network settings reader stopped".to_string())??;
    let (catalog, policy) = match persisted {
        Some(selection) => selection,
        None => {
            // The runtime's own fallback withholds the shipped catalog until a
            // wallet is open, because an idle install must not dial anyone.
            // Listing is not dialling: with nothing to show, this screen would
            // claim the wallet has no servers at all, which is false and leaves
            // no way to disable one before opening a wallet. `wallet_routes`
            // still reports what is actually connected.
            let (catalog, policy) =
                crate::chain_runtime::catalog_and_policy_from_app_state(&runtime.state());
            if catalog.iter().next().is_none() {
                (
                    optn_runtime::bootstrap::shipped_source_catalog(network),
                    policy,
                )
            } else {
                (catalog, policy)
            }
        }
    };

    let settings = (*network_settings).clone();
    let trusted_ports = tokio::task::spawn_blocking(move || settings.trusted_socks_ports(network))
        .await
        .unwrap_or_default();

    let live = native
        .with_service(|service| {
            let service = service.try_lock().ok()?;
            Some(
                service
                    .routes_for_operation(ChainOperation::WalletRefresh)
                    .into_iter()
                    .map(|route| (route.source, route.protocol))
                    .collect::<Vec<_>>(),
            )
        })
        .await
        .flatten()
        .unwrap_or_default();

    Ok(ChainSourcesView {
        network: network.to_string(),
        policy: serde_json::to_value(ChainPolicyPreset::describe(&policy))
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "custom".into()),
        protocols: [
            ProtocolFamily::Electrum,
            ProtocolFamily::Bip37,
            ProtocolFamily::Neutrino,
            ProtocolFamily::BchnRpc,
            ProtocolFamily::BchnZmq,
        ]
        .into_iter()
        .filter(|protocol| policy.protocols.contains(*protocol))
        .map(|protocol| protocol_label(protocol).to_owned())
        .collect(),
        scope: scope_label(&policy.primary_scope).to_owned(),
        sources: source_views(&catalog, &policy, &live, &native.failures().await),
        configuration_error: native.configuration_error().await,
        wallet_routes: live.len(),
        // Height 0 is the shipped genesis anchor, not a header this host
        // verified from a peer. Reporting it as "verified header 0" reads as
        // progress that has not happened.
        verified_tip: native
            .verified_tip(network)
            .await
            .filter(|(height, _)| *height > 0)
            .map(|(height, hash)| {
                let mut display = hash;
                // Block hashes are read big-endian; the store keeps wire order.
                display.reverse();
                VerifiedTipView {
                    height,
                    hash: hex::encode(display),
                }
            }),
        tor: tor_view(&catalog, &policy, &trusted_ports).await,
    })
}

/// Ask the same question the stack builder asks, with the same trust.
///
/// Reported rather than recomputed differently: a screen that told the holder
/// "Tor verified" while the routes were refusing for want of it would be worse
/// than saying nothing.
async fn tor_view(
    catalog: &optn_runtime::chain::SourceCatalog,
    policy: &ConnectionPolicy,
    trusted: &[u16],
) -> TorProxyView {
    let managed = crate::fusion::tor_manager::owned_socks_port();
    let status = optn_chain_native::tor_status_for(
        catalog,
        policy,
        optn_chain_native::TorProxyTrust {
            managed: managed.as_slice(),
            trusted,
        },
    )
    .await;
    let needed = optn_chain_native::requires_tor_proxy(catalog, policy);
    let (label, socks_port) = match status {
        optn_core::tor::TorStatus::Verified { socks_port } => ("verified", Some(socks_port)),
        optn_core::tor::TorStatus::Unverified { socks_port } => ("unverified", Some(socks_port)),
        optn_core::tor::TorStatus::Absent if needed => ("absent", None),
        optn_core::tor::TorStatus::Absent => ("not_needed", None),
    };
    TorProxyView {
        status: label.to_owned(),
        socks_port,
        trusted_ports: trusted.to_vec(),
    }
}

/// Rebuild routes now, without waiting for a settings change.
///
/// Routes are rebuilt when the selection changes, and a proxy appearing is not
/// a selection change: starting Tor left every public source refused until
/// something unrelated was edited. Retrying is the holder's instruction, so it
/// is a command rather than a background poll.
#[tauri::command]
pub async fn optn_chain_rebuild(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
) -> Result<(), String> {
    native.rebuild_from_app_state(&runtime.state()).await;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct AddSourceRequest {
    pub network: Option<String>,
    pub label: String,
    pub kind: String,
    pub host: String,
    pub port: Option<u16>,
    /// Naming a group declares this as the holder's own infrastructure, which
    /// is what `own_infrastructure` policy selects and what may be dialled
    /// directly rather than through Tor.
    pub infrastructure_group: Option<String>,
}

fn network_or_current(
    runtime: &optn_runtime::AppRuntime,
    network: Option<String>,
) -> Result<Network, String> {
    match network {
        Some(value) => parse_network(&value),
        None => Ok(runtime.state().network),
    }
}

/// Edit the durable overlay. The runtime's selection watcher rebuilds routes
/// from the file, so a write here retires the old routes rather than leaving a
/// connection open that the new policy would not have allowed.
async fn edit_overlay(
    network_settings: &NetworkSettingsStore,
    network: Network,
    edit: impl FnOnce(&mut optn_runtime::network_config::UserNetworkOverlay) -> Result<(), String>
        + Send
        + 'static,
) -> Result<(), String> {
    let settings = network_settings.clone();
    tokio::task::spawn_blocking(move || settings.update_overlay(network, edit))
        .await
        .map_err(|_| "network settings writer stopped".to_string())?
}

#[tauri::command]
pub async fn optn_chain_set_policy(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    policy: String,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    let preset: ChainPolicyPreset = serde_json::from_value(serde_json::Value::String(policy))
        .map_err(|_| "unknown connection policy".to_string())?;
    edit_overlay(&network_settings, network, move |overlay| {
        set_policy_preset(overlay, preset)
    })
    .await
}

/// The proxy situation, in the shape every renderer reads.
///
/// Separate from `optn_chain_sources` because the Leptos renderer wants this
/// and not a catalog of every source: a screen that had to fetch the whole
/// chain view to learn whether Tor is up would either be slow or would grow a
/// second, lazier answer of its own.
///
/// The policy question is asked here, not in the renderer. A renderer that
/// decided for itself whether a proxy is usable would be the second copy of
/// the rule this whole area exists to avoid.
#[tauri::command]
pub async fn optn_tor_readiness(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
) -> Result<optn_transport::WireTorStatus, String> {
    let network = network_or_current(&runtime, network)?;
    let settings = (*network_settings).clone();
    let trusted = tokio::task::spawn_blocking(move || settings.trusted_socks_ports(network))
        .await
        .unwrap_or_default();
    let settings = (*network_settings).clone();
    let persisted = tokio::task::spawn_blocking(move || settings.chain_selection(network))
        .await
        .map_err(|_| "network settings reader stopped".to_string())??;
    let (catalog, policy) = match persisted {
        Some(selection) => selection,
        None => crate::chain_runtime::catalog_and_policy_from_app_state(&runtime.state()),
    };

    let view = tor_view(&catalog, &policy, &trusted).await;
    let _ = &native;
    let state = match view.status.as_str() {
        "verified" => optn_transport::WireTorState::Verified,
        "unverified" => optn_transport::WireTorState::Unverified,
        "absent" => optn_transport::WireTorState::Absent,
        _ => optn_transport::WireTorState::NotNeeded,
    };
    Ok(optn_transport::WireTorStatus {
        state,
        socks_port: view.socks_port,
        // How far this shell's own Tor has bootstrapped, so a renderer can
        // show progress rather than a dead button.
        bootstrap_percent: crate::fusion::tor_manager::status().bootstrap_percent,
    })
}

/// Confirm, or withdraw confirmation, that a loopback SOCKS port is the
/// holder's own Tor.
///
/// This exists because probing cannot answer the question. Every no-auth
/// SOCKS5 proxy completes the same greeting, and nothing in the protocol
/// separates Tor from a corporate proxy, an SSH dynamic forward, or something
/// forwarding in the clear. A Tor this application started needs no
/// confirmation -- it owns the process. Anything else is one deliberate act by
/// the person who knows what is running on their own machine.
///
/// Loopback only. A SOCKS proxy elsewhere on the network sees both the traffic
/// and the address it came from, which is what Tor was being asked to hide, so
/// there is no port number that makes trusting a remote one correct.
#[tauri::command]
pub async fn optn_chain_trust_socks_proxy(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    port: u16,
    trusted: bool,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    if port == 0 {
        return Err("0 is not a port".into());
    }
    edit_overlay(&network_settings, network, move |overlay| {
        overlay.trusted_socks_ports.retain(|entry| *entry != port);
        if trusted {
            overlay.trusted_socks_ports.push(port);
            overlay.trusted_socks_ports.sort_unstable();
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_set_source_disposition(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    source: String,
    disposition: String,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    let disposition = parse_disposition(&disposition)?;
    let id = SourceId::new(source);
    edit_overlay(&network_settings, network, move |overlay| {
        set_source_disposition(overlay, &id, disposition)
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_add_source(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    request: AddSourceRequest,
) -> Result<(), String> {
    let network = network_or_current(&runtime, request.network.clone())?;
    let kind = parse_endpoint_kind(&request.kind)?;
    let endpoint = Endpoint {
        kind,
        host: request.host.clone(),
        port: request.port,
    };
    let label = request.label.clone();
    let group = request.infrastructure_group.clone();
    edit_overlay(&network_settings, network, move |overlay| {
        add_user_source(overlay, &label, endpoint, group.as_deref()).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_remove_source(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    source: String,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    let id = SourceId::new(source);
    edit_overlay(&network_settings, network, move |overlay| {
        remove_user_source(overlay, &id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_kind_labels_round_trip() {
        // The label is what the UI sends back when adding a source, so a label
        // this module cannot parse would make its own list unusable.
        for kind in [
            EndpointKind::BchP2p,
            EndpointKind::ElectrumTls,
            EndpointKind::ElectrumTcp,
            EndpointKind::BchnRpc,
            EndpointKind::BchnZmq,
            EndpointKind::ExplorerHttp,
            EndpointKind::ExplorerHttps,
        ] {
            assert_eq!(parse_endpoint_kind(endpoint_kind_label(kind)), Ok(kind));
        }
        assert!(parse_endpoint_kind("smoke-signals").is_err());
    }

    #[test]
    fn dispositions_round_trip_and_reject_anything_else() {
        for disposition in [
            SourceDisposition::Enabled,
            SourceDisposition::Disabled,
            SourceDisposition::Banned,
        ] {
            assert_eq!(
                parse_disposition(disposition_label(disposition)),
                Ok(disposition)
            );
        }
        assert!(parse_disposition("mostly").is_err());
    }

    #[test]
    fn a_selected_source_that_has_no_live_route_is_shown_as_selected_and_empty() {
        // The failure this is written against: "primary" with an empty protocol
        // list is how a screen can say a chosen server was refused, instead of
        // showing a healthy-looking row for a route nothing can use.
        let mut catalog = SourceCatalog::default();
        let id = SourceId::new("host:node.example");
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "Node".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![Endpoint {
                    kind: EndpointKind::ElectrumTls,
                    host: "node.example".into(),
                    port: Some(50002),
                }],
                capabilities: Default::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let views = source_views(&catalog, &ConnectionPolicy::auto(), &[], &[]);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].role.as_deref(), Some("primary"));
        assert!(views[0].live_protocols.is_empty());
        assert!(views[0].can_remove);
    }
}
