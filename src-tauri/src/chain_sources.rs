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
    ConnectionPolicy, ProtocolFamily, SourceCatalog, SourceDisposition, SourceId,
};
use optn_runtime::chain_service::ChainOperation;
use optn_runtime::network_config::{
    remove_user_source, set_policy_preset, set_source_disposition, ChainPolicyPreset,
};
use optn_transport_native::{protocol_label, scope_label, source_views};
use std::sync::Arc;

pub use optn_transport::chain_sources::*;

fn parse_disposition(value: &str) -> Result<SourceDisposition, String> {
    Ok(match value {
        "enabled" => SourceDisposition::Enabled,
        "disabled" => SourceDisposition::Disabled,
        "banned" => SourceDisposition::Banned,
        other => return Err(format!("unknown disposition '{other}'")),
    })
}

fn parse_network(value: &str) -> Result<Network, String> {
    value
        .parse()
        .map_err(|_| format!("unknown network '{value}'"))
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
            let state = runtime.state();
            let (catalog, policy) = if state.network == network {
                crate::chain_runtime::catalog_and_policy_from_app_state(&state)
            } else {
                (SourceCatalog::default(), ConnectionPolicy::auto())
            };
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

    let observed_network = runtime.state().network;
    let (live, registered) = native
        .with_service(|service| {
            let service = service.try_lock().ok()?;
            Some((
                service
                    .routes_for_operation(ChainOperation::WalletRefresh)
                    .into_iter()
                    .map(|route| (route.source, route.protocol, route.endpoint))
                    .collect::<Vec<_>>(),
                service.registered_capability_observations(),
            ))
        })
        .await
        .flatten()
        .unwrap_or_default();

    // Diagnostics belong to the active stack, not a different network whose
    // saved catalog a renderer is inspecting. Refuse a racing switch.
    if runtime.state().network != observed_network {
        return Err("Network changed while reading chain sources; retry.".into());
    }
    let (live, registered, failures) = if network == observed_network {
        (live, registered, native.failures().await)
    } else {
        (Vec::new(), Vec::new(), Vec::new())
    };
    let view = ChainSourcesView {
        unavailable_services: optn_runtime::source_selection::unavailable_services(),
        network: network.to_string(),
        selection: optn_runtime::source_selection::view(&policy),
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
        sources: source_views(&catalog, &policy, &live, &registered, &failures),
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
    };
    if runtime.state().network != observed_network {
        return Err("Network changed while reading chain sources; retry.".into());
    }
    Ok(view)
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

fn network_or_current(
    runtime: &optn_runtime::AppRuntime,
    network: Option<String>,
) -> Result<Network, String> {
    match network {
        Some(value) => parse_network(&value),
        None => Ok(runtime.state().network),
    }
}

/// Revoke old routes before editing the durable overlay. The existing watcher
/// and explicit rebuild command then construct routes from the saved policy.
async fn edit_overlay(
    native: &NativeChainRuntime,
    network_settings: &NetworkSettingsStore,
    network: Network,
    edit: impl FnOnce(&mut optn_runtime::network_config::UserNetworkOverlay) -> Result<(), String>
        + Send
        + 'static,
) -> Result<(), String> {
    let settings = network_settings.clone();
    native
        .persist_network_edit(move || settings.update_overlay(network, edit))
        .await
}

#[tauri::command]
pub async fn optn_chain_set_policy(
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    policy: String,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    let preset: ChainPolicyPreset = serde_json::from_value(serde_json::Value::String(policy))
        .map_err(|_| "unknown connection policy".to_string())?;
    edit_overlay(&native, &network_settings, network, move |overlay| {
        set_policy_preset(overlay, preset)
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_set_selection(
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    selection: optn_transport::chain_sources::WireConnectionPolicy,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    edit_overlay(&native, &network_settings, network, move |overlay| {
        let envelope = optn_runtime::network_config::NetworkConfigEnvelope::current(
            optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
            overlay.clone(),
        );
        let (catalog, _) =
            optn_runtime::network_config::resolve_shipped_chain_selection(network, Some(&envelope))
                .map_err(|error| format!("Invalid source catalog: {error:?}"))?;
        overlay.connection_policy = optn_runtime::source_selection::policy(&catalog, &selection)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_export_configuration(
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: String,
) -> Result<String, String> {
    let network = parse_network(&network)?;
    let settings = (*network_settings).clone();
    tokio::task::spawn_blocking(move || settings.export_portable(network))
        .await
        .map_err(|_| "Network settings reader stopped".to_owned())?
}

#[tauri::command]
pub async fn optn_chain_import_configuration(
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: String,
    configuration: String,
) -> Result<(), String> {
    let network = parse_network(&network)?;
    let settings = (*network_settings).clone();
    native
        .persist_network_edit(move || settings.import_portable(network, &configuration))
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
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
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
    edit_overlay(&native, &network_settings, network, move |overlay| {
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
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    source: String,
    disposition: String,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    let disposition = parse_disposition(&disposition)?;
    let id = SourceId::new(source);
    edit_overlay(&native, &network_settings, network, move |overlay| {
        set_source_disposition(overlay, &id, disposition)
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_add_source(
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    request: AddSourceRequest,
) -> Result<(), String> {
    let network = network_or_current(&runtime, request.network.clone())?;
    edit_overlay(&native, &network_settings, network, move |overlay| {
        optn_transport_native::add_source(network, overlay, request)
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_remove_source(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    network: Option<String>,
    source: String,
) -> Result<(), String> {
    let network = network_or_current(&runtime, network)?;
    let selection = network_settings
        .chain_selection(network)?
        .ok_or("Source catalog is unavailable.")?;
    let selected = selection
        .0
        .get(&SourceId::new(&source))
        .ok_or("Source is unavailable.")?;
    if !selected.can_remove() {
        return Err("Bootstrap sources cannot be removed.".into());
    }
    runtime
        .invalidate_wallet_sync("Source removed; sync the wallet again.".into())
        .await
        .map_err(|error| error.to_string())?;
    // Mobile cannot save RPC credentials. Its source editor must not depend on
    // the unavailable desktop keyring just to remove a P2P/Electrum source.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    native
        .rpc_credentials(
            network,
            RpcCredentialRequest::Remove {
                source: source.clone(),
            },
            false,
        )
        .await?;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = &native;
    let id = SourceId::new(source);
    edit_overlay(&native, &network_settings, network, move |overlay| {
        remove_user_source(overlay, &id)
    })
    .await
}

#[tauri::command]
pub async fn optn_chain_rpc_credentials(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    network: String,
    request: RpcCredentialRequest,
) -> Result<RpcCredentialStatus, String> {
    let selected = parse_network(&network)?;
    if runtime.state().network != selected {
        return Err("Wallet network changed.".into());
    }
    native.rpc_credentials(selected, request, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::{
        chain::{ChainSource, Endpoint, EndpointKind, SourceOrigin},
        chain_service::RegisteredCapabilityObservation,
    };
    use optn_transport_native::disposition_label;

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
        let views = source_views(&catalog, &ConnectionPolicy::auto(), &[], &[], &[]);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].role.as_deref(), Some("primary"));
        assert!(views[0].live_protocols.is_empty());
        assert!(views[0].can_remove);
    }

    #[test]
    fn endpoint_protocol_statuses_keep_catalog_claims_and_runtime_evidence_distinct() {
        use optn_runtime::chain::{Capability, CapabilityConfidence, CapabilityDiscovery};

        let mut catalog = SourceCatalog::default();
        let id = SourceId::new("host:node.example");
        let peer = Endpoint {
            kind: EndpointKind::BchP2p,
            host: "node.example".into(),
            port: Some(8333),
        };
        let electrum = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "node.example".into(),
            port: Some(50002),
        };
        let rpc = Endpoint {
            kind: EndpointKind::BchnRpc,
            host: "node.example".into(),
            port: Some(8332),
        };
        let mut capabilities = optn_runtime::chain::CapabilitySet::default();
        capabilities.record(
            Capability::Bip37BloomFiltering,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::BootstrapMetadata,
        );
        capabilities.record(
            Capability::ElectrumProtocol,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        capabilities.record(
            Capability::RpcQueries,
            CapabilityConfidence::Rejected,
            CapabilityDiscovery::ActiveProbe,
        );
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "Node".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![peer.clone(), electrum.clone(), rpc.clone()],
                capabilities,
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let failures = [optn_chain_native::NativeChainProbeFailure {
            source: id.clone(),
            protocol: ProtocolFamily::BchnRpc,
            endpoint: rpc.clone(),
            error: "authentication refused".into(),
        }];
        let views = source_views(
            &catalog,
            &ConnectionPolicy::auto(),
            &[(id, ProtocolFamily::Electrum, Some(electrum))],
            &[RegisteredCapabilityObservation {
                source: SourceId::new("host:node.example"),
                protocol: ProtocolFamily::Electrum,
                endpoint: Some(Endpoint {
                    kind: EndpointKind::ElectrumTls,
                    host: "node.example".into(),
                    port: Some(50002),
                }),
                capability: Capability::ElectrumProtocol,
                confidence: CapabilityConfidence::Verified,
                discovery: CapabilityDiscovery::ActiveProbe,
            }],
            &failures,
        );
        let statuses: std::collections::BTreeMap<_, _> = views[0]
            .protocol_statuses
            .iter()
            .map(|status| {
                (
                    (status.endpoint.kind.as_str(), status.protocol.as_str()),
                    status.status,
                )
            })
            .collect();
        assert_eq!(
            statuses[&("p2p", "bip37")],
            SourceProtocolStatus::Advertised
        );
        assert_eq!(
            statuses[&("p2p", "neutrino")],
            SourceProtocolStatus::Unknown
        );
        assert_eq!(
            statuses[&("electrum-tls", "electrum")],
            SourceProtocolStatus::Verified
        );
        assert_eq!(
            statuses[&("node-rpc", "node-rpc")],
            SourceProtocolStatus::Unknown,
            "a native transport failure remains diagnostic rather than a capability verdict"
        );
        assert_eq!(
            views[0]
                .capability_details
                .iter()
                .find(|capability| capability.name == "Fulcrum/Electrum")
                .unwrap()
                .confidence,
            SourceProtocolStatus::Verified
        );
        assert_eq!(
            views[0]
                .capability_details
                .iter()
                .find(|capability| capability.name == "Fulcrum/Electrum")
                .unwrap()
                .discovery,
            "active-probe"
        );
        assert_eq!(
            views[0]
                .protocol_statuses
                .iter()
                .find(|status| status.protocol == "electrum")
                .unwrap()
                .status,
            SourceProtocolStatus::Verified,
            "only the registered endpoint claim promotes this route"
        );
        assert_eq!(
            views[0].registered_capability_details[0].confidence,
            SourceProtocolStatus::Verified
        );
        assert_eq!(
            views[0]
                .capability_details
                .iter()
                .find(|capability| capability.name == "BIP37")
                .unwrap()
                .confidence,
            SourceProtocolStatus::Advertised
        );
        assert_eq!(
            views[0]
                .capability_details
                .iter()
                .find(|capability| capability.name == "RPC")
                .unwrap()
                .confidence,
            SourceProtocolStatus::Rejected
        );
    }
}
