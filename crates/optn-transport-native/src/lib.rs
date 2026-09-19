//! Persisted source-settings access shared by native interfaces.
//!
//! This module deliberately reads and edits only the durable source overlay.
//! It neither creates a chain stack nor asks a provider about its health.

use optn_app::Network;
use optn_chain_native::{network_config::NetworkConfigFile, NativeChainProbeFailure};
use optn_runtime::chain::{
    build_selection_plan, Capability, CapabilityConfidence, CapabilityDiscovery, ChainSource,
    ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily, SourceCatalog, SourceDisposition,
    SourceId, SourceOrigin, SourceScope,
};
use optn_runtime::chain_service::RegisteredCapabilityObservation;
use optn_runtime::network_config::{
    promote_legacy_policy, remove_user_source, resolve_shipped_chain_selection, set_policy_preset,
    set_source_disposition, ChainPolicyPreset, NetworkConfigEnvelope, NetworkConfigStore,
    UserNetworkOverlay, SHIPPED_CATALOG_VERSION,
};
use optn_transport::chain_sources::{
    AddSourceRequest, ChainSourceEdit, ChainSourceView, EndpointView, SourceCapabilityView,
    SourceFailureView, SourceProtocolStatus, SourceProtocolView, SourceRouteCapabilityView,
    WireConnectionPolicy,
};
use std::path::PathBuf;

/// A persisted-only source view. Empty route diagnostics mean no health or
/// active-provider claim was made by this config-only API.
#[derive(Debug, Clone)]
pub struct SourceSettingsSnapshot {
    pub network: String,
    pub sources: Vec<ChainSourceView>,
    pub selection: WireConnectionPolicy,
    pub preset: String,
}

/// One network-scoped durable source overlay.
#[derive(Clone)]
pub struct SourceSettings {
    network: Network,
    file: NetworkConfigFile,
}

impl SourceSettings {
    pub fn new(network: Network, path: PathBuf) -> Self {
        Self {
            network,
            file: NetworkConfigFile::new(path),
        }
    }

    /// Read the reviewed bootstrap catalog merged with persisted user intent.
    /// This is pure configuration projection and performs no network I/O.
    pub fn read(&self) -> Result<SourceSettingsSnapshot, String> {
        self.snapshot(self.file.load()?)
    }

    /// Validate and atomically apply one durable source edit. `Retry` and
    /// `Import` require host/runtime behavior and are intentionally outside
    /// this configuration-only pilot.
    pub fn edit(&self, edit: ChainSourceEdit) -> Result<SourceSettingsSnapshot, String> {
        let network = self.network;
        let envelope = self.file.update(move |existing| {
            let mut envelope = existing.unwrap_or_else(|| {
                NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, Default::default())
            });
            promote_legacy_policy(&mut envelope);
            apply_edit(network, &mut envelope.overlay, edit)?;
            Ok(envelope)
        })?;
        self.snapshot(Some(envelope))
    }

    fn snapshot(
        &self,
        envelope: Option<NetworkConfigEnvelope>,
    ) -> Result<SourceSettingsSnapshot, String> {
        let (catalog, policy) = resolve_shipped_chain_selection(self.network, envelope.as_ref())
            .map_err(|error| format!("invalid network configuration: {error:?}"))?;
        Ok(SourceSettingsSnapshot {
            network: self.network.to_string(),
            sources: source_views(&catalog, &policy, &[], &[], &[]),
            selection: optn_runtime::source_selection::view(&policy),
            preset: preset_label(&policy),
        })
    }
}

fn apply_edit(
    network: Network,
    overlay: &mut UserNetworkOverlay,
    edit: ChainSourceEdit,
) -> Result<(), String> {
    match edit {
        ChainSourceEdit::Policy(value) => {
            let preset: ChainPolicyPreset =
                serde_json::from_value(serde_json::Value::String(value))
                    .map_err(|_| "unknown connection policy".to_string())?;
            set_policy_preset(overlay, preset)
        }
        ChainSourceEdit::Selection(selection) => {
            let catalog = resolved_catalog(network, overlay)?;
            overlay.connection_policy =
                optn_runtime::source_selection::policy(&catalog, &selection)?;
            Ok(())
        }
        ChainSourceEdit::Disposition {
            source,
            disposition,
        } => {
            let id = SourceId::new(source);
            let catalog = resolved_catalog(network, overlay)?;
            if catalog.get(&id).is_none() {
                return Err("Source is unavailable.".into());
            }
            set_source_disposition(overlay, &id, parse_disposition(&disposition)?)
        }
        ChainSourceEdit::Add(request) => add_source(network, overlay, request),
        ChainSourceEdit::Remove(source) => {
            let id = SourceId::new(source);
            let catalog = resolved_catalog(network, overlay)?;
            let selected = catalog.get(&id).ok_or("Source is unavailable.")?;
            if !selected.can_remove() {
                return Err("Bootstrap sources cannot be removed.".into());
            }
            remove_user_source(overlay, &id)
        }
        ChainSourceEdit::Retry => Err("Retry requires an active chain runtime.".into()),
        ChainSourceEdit::Import(_) => Err("Import is unavailable in source settings.".into()),
    }
}

fn resolved_catalog(
    network: Network,
    overlay: &UserNetworkOverlay,
) -> Result<SourceCatalog, String> {
    let envelope = NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, overlay.clone());
    resolve_shipped_chain_selection(network, Some(&envelope))
        .map(|(catalog, _)| catalog)
        .map_err(|error| format!("Invalid source catalog: {error:?}"))
}

pub fn add_source(
    network: Network,
    overlay: &mut UserNetworkOverlay,
    request: AddSourceRequest,
) -> Result<(), String> {
    if let Some(requested_network) = request.network.as_deref() {
        let requested: Network = requested_network
            .parse()
            .map_err(|_| format!("unknown network '{requested_network}'"))?;
        if requested != network {
            return Err("source network does not match this settings file".into());
        }
    }
    if request.services.len() > 15 {
        return Err("A source supports at most sixteen services per edit".into());
    }
    let mut endpoints = vec![Endpoint {
        kind: parse_endpoint_kind(&request.kind)?,
        host: request.host.clone(),
        port: request.port,
    }];
    for service in request.services {
        endpoints.push(Endpoint {
            kind: parse_endpoint_kind(&service.kind)?,
            host: request.host.clone(),
            port: service.port,
        });
    }
    optn_runtime::network_config::add_user_source_services(
        overlay,
        &request.label,
        endpoints,
        request.infrastructure_group.as_deref(),
    )
    .map(|_| ())
}

fn preset_label(policy: &ConnectionPolicy) -> String {
    serde_json::to_value(ChainPolicyPreset::describe(policy))
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "custom".into())
}

fn endpoint_view(endpoint: &Endpoint) -> EndpointView {
    EndpointView {
        kind: endpoint_kind_label(endpoint.kind).to_owned(),
        host: endpoint.host.clone(),
        port: endpoint.port,
    }
}

pub const fn endpoint_kind_label(kind: EndpointKind) -> &'static str {
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

pub const fn protocol_label(protocol: ProtocolFamily) -> &'static str {
    match protocol {
        ProtocolFamily::Electrum => "electrum",
        ProtocolFamily::Bip37 => "bip37",
        ProtocolFamily::Neutrino => "neutrino",
        ProtocolFamily::BchnRpc => "node-rpc",
        ProtocolFamily::BchnZmq => "node-zmq",
    }
}

pub const fn scope_label(scope: &SourceScope) -> &'static str {
    match scope {
        SourceScope::AllEnabled => "all-enabled",
        SourceScope::PublicEnabled => "public-enabled",
        SourceScope::UserInfrastructure => "own-infrastructure",
        SourceScope::Explicit(_) => "explicit",
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

pub const fn disposition_label(disposition: SourceDisposition) -> &'static str {
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

const fn protocol_capability(protocol: ProtocolFamily) -> Capability {
    match protocol {
        ProtocolFamily::Electrum => Capability::ElectrumProtocol,
        ProtocolFamily::Bip37 => Capability::Bip37BloomFiltering,
        ProtocolFamily::Neutrino => Capability::CompactFilters,
        ProtocolFamily::BchnRpc => Capability::RpcQueries,
        ProtocolFamily::BchnZmq => Capability::ZmqEvents,
    }
}

fn protocol_status(
    source: &ChainSource,
    endpoint: &Endpoint,
    protocol: ProtocolFamily,
    registered: &[RegisteredCapabilityObservation],
) -> SourceProtocolStatus {
    if let Some(observation) = registered.iter().find(|observation| {
        observation.source == source.id
            && observation.protocol == protocol
            && observation.endpoint.as_ref() == Some(endpoint)
            && observation.capability == protocol_capability(protocol)
    }) {
        capability_status(observation.confidence)
    } else if source.capabilities.protocol_supported(protocol) {
        SourceProtocolStatus::Advertised
    } else {
        SourceProtocolStatus::Unknown
    }
}

const fn capability_status(confidence: CapabilityConfidence) -> SourceProtocolStatus {
    match confidence {
        CapabilityConfidence::Unknown => SourceProtocolStatus::Unknown,
        CapabilityConfidence::Advertised => SourceProtocolStatus::Advertised,
        CapabilityConfidence::Verified => SourceProtocolStatus::Verified,
        CapabilityConfidence::Rejected => SourceProtocolStatus::Rejected,
    }
}

fn capability_discovery_label(discovery: &CapabilityDiscovery) -> String {
    match discovery {
        CapabilityDiscovery::P2pServiceBit { bit, name } => format!("p2p-service-bit:{name}:{bit}"),
        CapabilityDiscovery::ElectrumServerVersion => "electrum-server-version".into(),
        CapabilityDiscovery::ElectrumServerFeatures => "electrum-server-features".into(),
        CapabilityDiscovery::ElectrumPeerDiscovery => "electrum-peer-discovery".into(),
        CapabilityDiscovery::ExplicitConfiguration => "explicit-configuration".into(),
        CapabilityDiscovery::BootstrapMetadata => "bootstrap-metadata".into(),
        CapabilityDiscovery::ActiveProbe => "active-probe".into(),
    }
}

/// Project catalog and registered backend evidence. Supplying empty live inputs
/// yields a persisted-only view; no route health is inferred from configuration.
pub fn source_views(
    catalog: &SourceCatalog,
    policy: &ConnectionPolicy,
    live: &[(SourceId, ProtocolFamily, Option<Endpoint>)],
    registered: &[RegisteredCapabilityObservation],
    failures: &[NativeChainProbeFailure],
) -> Vec<ChainSourceView> {
    let plan = build_selection_plan(catalog, policy);
    let mut sources: Vec<_> = catalog.iter().cloned().collect();
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
                    .filter(|(id, _, _)| id == &source.id)
                    .map(|(_, protocol, _)| protocol_label(*protocol).to_owned())
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
                    .map(|(capability, _)| capability.label().to_owned())
                    .collect(),
                capability_details: source
                    .capabilities
                    .iter()
                    .map(|(capability, claim)| SourceCapabilityView {
                        name: capability.label().to_owned(),
                        confidence: capability_status(claim.confidence),
                        discovery: capability_discovery_label(&claim.discovery),
                    })
                    .collect(),
                registered_capability_details: registered
                    .iter()
                    .filter(|observation| observation.source == source.id)
                    .map(|observation| SourceRouteCapabilityView {
                        endpoint: observation.endpoint.as_ref().map(endpoint_view),
                        protocol: protocol_label(observation.protocol).to_owned(),
                        name: observation.capability.label().to_owned(),
                        confidence: capability_status(observation.confidence),
                        discovery: capability_discovery_label(&observation.discovery),
                    })
                    .collect(),
                protocol_statuses: source
                    .endpoints
                    .iter()
                    .flat_map(|endpoint| {
                        let source_for_status = &source;
                        [
                            ProtocolFamily::Electrum,
                            ProtocolFamily::Bip37,
                            ProtocolFamily::Neutrino,
                            ProtocolFamily::BchnRpc,
                            ProtocolFamily::BchnZmq,
                        ]
                        .into_iter()
                        .filter(move |protocol| endpoint.kind.can_probe_protocol(*protocol))
                        .map(move |protocol| SourceProtocolView {
                            endpoint: endpoint_view(endpoint),
                            protocol: protocol_label(protocol).to_owned(),
                            status: protocol_status(
                                source_for_status,
                                endpoint,
                                protocol,
                                registered,
                            ),
                        })
                    })
                    .collect(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_transport::chain_sources::{WireChainProtocol, WireSourceScope};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn file(label: &str) -> (PathBuf, SourceSettings) {
        let path = std::env::temp_dir()
            .join(format!(
                "optn-source-settings-{label}-{}-{}",
                std::process::id(),
                TEST_ID.fetch_add(1, Ordering::Relaxed)
            ))
            .join("network-chipnet.json");
        let settings = SourceSettings::new(Network::Chipnet, path.clone());
        (path, settings)
    }

    fn add(host: &str) -> ChainSourceEdit {
        ChainSourceEdit::Add(AddSourceRequest {
            services: Vec::new(),
            network: Some("chipnet".into()),
            label: "Home node".into(),
            kind: "electrum-tls".into(),
            host: host.into(),
            port: Some(50002),
            infrastructure_group: Some("home".into()),
        })
    }

    #[test]
    fn endpoint_kind_labels_round_trip() {
        // The label is what the UI sends back when adding a source, so a label
        // the shared adapter cannot parse would make its own list unusable.
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
    fn service_bundle_persists_as_one_source_and_bad_append_is_atomic() {
        let (path, settings) = file("service-bundle");
        let ChainSourceEdit::Add(mut request) = add("node.home") else {
            unreachable!()
        };
        request.services = vec![
            optn_transport::chain_sources::SourceService {
                kind: "p2p".into(),
                port: Some(48333),
            },
            optn_transport::chain_sources::SourceService {
                kind: "node-rpc".into(),
                port: Some(48332),
            },
            optn_transport::chain_sources::SourceService {
                kind: "node-zmq".into(),
                port: Some(28332),
            },
        ];
        settings
            .edit(ChainSourceEdit::Add(request.clone()))
            .unwrap();
        let reopened = SourceSettings::new(Network::Chipnet, path.clone())
            .read()
            .unwrap();
        let own: Vec<_> = reopened
            .sources
            .iter()
            .filter(|source| source.origin == "own-infrastructure")
            .collect();
        assert_eq!(own.len(), 1);
        assert_eq!(own[0].endpoints.len(), 4);
        let before = std::fs::read(&path).unwrap();
        request.kind = "p2p".into();
        request.port = Some(48334);
        request.services[0].port = Some(0);
        assert!(settings.edit(ChainSourceEdit::Add(request)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn remove_keeps_an_explicit_pool_empty() {
        let (path, settings) = file("remove-explicit");
        let added = settings.edit(add("home.example")).unwrap();
        let id = added
            .sources
            .iter()
            .find(|source| source.can_remove)
            .unwrap()
            .id
            .clone();
        settings
            .edit(ChainSourceEdit::Selection(WireConnectionPolicy {
                protocols: vec![WireChainProtocol::FulcrumElectrum],
                primary_scope: WireSourceScope::Selected(vec![id.clone()]),
                fallback_scope: None,
                preferred: vec![id.clone()],
            }))
            .unwrap();
        let snapshot = settings.edit(ChainSourceEdit::Remove(id)).unwrap();
        assert_eq!(
            snapshot.selection.primary_scope,
            WireSourceScope::Selected(Vec::new())
        );
        assert!(snapshot.selection.preferred.is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn bootstrap_cannot_be_removed() {
        let (path, settings) = file("bootstrap-remove");
        let bootstrap = settings
            .read()
            .unwrap()
            .sources
            .into_iter()
            .find(|source| !source.can_remove)
            .unwrap()
            .id;
        assert!(settings
            .edit(ChainSourceEdit::Remove(bootstrap))
            .unwrap_err()
            .contains("Bootstrap sources cannot be removed"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn bootstrap_ban_survives_reopen() {
        let (path, settings) = file("ban-reopen");
        let bootstrap = settings
            .read()
            .unwrap()
            .sources
            .into_iter()
            .find(|source| !source.can_remove)
            .unwrap()
            .id;
        settings
            .edit(ChainSourceEdit::Disposition {
                source: bootstrap.clone(),
                disposition: "banned".into(),
            })
            .unwrap();
        let reopened = SourceSettings::new(Network::Chipnet, path.clone())
            .read()
            .unwrap();
        assert_eq!(
            reopened
                .sources
                .into_iter()
                .find(|source| source.id == bootstrap)
                .unwrap()
                .disposition,
            "banned"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn malformed_add_and_invalid_selection_do_not_write() {
        let (path, settings) = file("invalid");
        assert!(settings
            .edit(ChainSourceEdit::Add(AddSourceRequest {
                services: Vec::new(),
                network: None,
                label: "bad".into(),
                kind: "unknown".into(),
                host: "host".into(),
                port: Some(1),
                infrastructure_group: None
            }))
            .is_err());
        assert!(!path.exists());
        assert!(settings
            .edit(ChainSourceEdit::Selection(WireConnectionPolicy {
                protocols: vec![WireChainProtocol::FulcrumElectrum],
                primary_scope: WireSourceScope::Selected(vec!["missing".into()]),
                fallback_scope: None,
                preferred: Vec::new()
            }))
            .is_err());
        assert!(!path.exists());
    }
}
