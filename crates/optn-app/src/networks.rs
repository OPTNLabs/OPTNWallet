//! Settings → Network: network choice plus issue #75 source-policy view models.
//!
//! The renderer receives typed rows/actions. It does not own source selection,
//! health, failover, or persistence; those remain in `optn-runtime`.

use crate::Network;

pub const NETWORK_DESCRIPTION: &str = "Switching networks clears the active network records, \
     derives the network path, and resynchronizes receive/change addresses. \
     Custom paths are preserved across network changes.";
pub const RELOAD_LABEL: &str = "Reload and resync current wallet";
pub const RELOADING_LABEL: &str = "Reloading wallet…";
pub const COMING_SOON_LABEL: &str = "Coming soon";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PlannedNetwork {
    Testnet3,
    Testnet4,
    Regtest,
}

impl PlannedNetwork {
    pub const ALL: &'static [Self] = &[Self::Testnet3, Self::Testnet4, Self::Regtest];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Testnet3 => "Testnet3",
            Self::Testnet4 => "Testnet4",
            Self::Regtest => "Regtest",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetworkOption {
    pub network: Network,
    pub label: &'static str,
    pub description: &'static str,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkSettingsViewModel {
    pub description: &'static str,
    pub available: Vec<NetworkOption>,
    pub coming_soon: &'static [PlannedNetwork],
    pub busy: bool,
    pub reload_label: &'static str,
}

const fn label_of(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "Mainnet",
        Network::Chipnet => "Chipnet",
    }
}

const fn description_of(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "Live BCH network — real funds",
        Network::Chipnet => "BCH testnet for upcoming CHIPs — test funds only",
    }
}

pub fn network_settings_view_model(active: Network, busy: bool) -> NetworkSettingsViewModel {
    NetworkSettingsViewModel {
        description: NETWORK_DESCRIPTION,
        available: [Network::Mainnet, Network::Chipnet]
            .into_iter()
            .map(|network| NetworkOption {
                network,
                label: label_of(network),
                description: description_of(network),
                active: network == active,
            })
            .collect(),
        coming_soon: PlannedNetwork::ALL,
        busy,
        reload_label: if busy { RELOADING_LABEL } else { RELOAD_LABEL },
    }
}

// ---------------------------------------------------------------------------
// Issue #75 advanced source selection. These are UI/application vocabulary;
// runtime types are intentionally not imported here to preserve dependency flow.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceOriginView {
    Bootstrap,
    UserAdded,
    MyInfrastructure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceDispositionView {
    Enabled,
    Disabled,
    Banned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityConfidenceView {
    Unknown,
    Advertised,
    Verified,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainProtocolView {
    FulcrumElectrum,
    Bip37,
    Neutrino,
    BchnRpc,
    BchnZmq,
}

impl ChainProtocolView {
    pub const fn label(self) -> &'static str {
        match self {
            Self::FulcrumElectrum => "Fulcrum / Electrum",
            Self::Bip37 => "BIP37",
            Self::Neutrino => "Neutrino",
            Self::BchnRpc => "BCHN RPC",
            Self::BchnZmq => "BCHN ZMQ",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityBadgeView {
    pub protocol: ChainProtocolView,
    pub confidence: CapabilityConfidenceView,
    /// Human-readable provenance such as `NODE_BLOOM`, `SFNodeCF`,
    /// `server.features`, or `active probe`.
    pub provenance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkSourceRow {
    pub id: String,
    pub label: String,
    pub endpoint_summary: String,
    pub origin: SourceOriginView,
    pub disposition: SourceDispositionView,
    pub capabilities: Vec<CapabilityBadgeView>,
    pub preferred_rank: Option<usize>,
    pub latency_ms: Option<u32>,
    pub height: Option<u32>,
    pub removable: bool,
}

impl NetworkSourceRow {
    /// Bootstrap sources are policy-controlled, not user-deletable. User-added
    /// and own-infrastructure records are removable because the user created them.
    pub const fn expected_removable(origin: SourceOriginView) -> bool {
        !matches!(origin, SourceOriginView::Bootstrap)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceScopeView {
    AllEnabled,
    PublicEnabled,
    MyInfrastructure,
    Selected(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionPolicyView {
    pub protocols: Vec<ChainProtocolView>,
    pub primary_scope: SourceScopeView,
    pub fallback_scope: Option<SourceScopeView>,
    pub preferred: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkSourcesViewModel {
    pub policy: ConnectionPolicyView,
    pub sources: Vec<NetworkSourceRow>,
    /// True while runtime is probing/refreshing capabilities. Existing rows stay
    /// visible instead of disappearing and looking like an empty configuration.
    pub refreshing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkSourceIntent {
    AddPublicSource,
    AddInfrastructure,
    SetDisposition {
        source_id: String,
        disposition: SourceDispositionView,
    },
    RemoveUserSource { source_id: String },
    SetPreferredOrder(Vec<String>),
    SetProtocols(Vec<ChainProtocolView>),
    SetPrimaryScope(SourceScopeView),
    SetFallbackScope(Option<SourceScopeView>),
    ResetBootstrapDispositions,
    ExportNetworkConfiguration,
    ImportNetworkConfiguration,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planned_networks_are_listed_but_cannot_be_selected() {
        let vm = network_settings_view_model(Network::Mainnet, false);
        assert_eq!(
            vm.coming_soon.iter().map(|n| n.label()).collect::<Vec<_>>(),
            vec!["Testnet3", "Testnet4", "Regtest"]
        );
        assert_eq!(vm.available.len(), 2);
        assert!(vm
            .available
            .iter()
            .all(|option| matches!(option.network, Network::Mainnet | Network::Chipnet)));
    }

    #[test]
    fn exactly_one_network_is_active_and_it_follows_the_wallet() {
        for active in [Network::Mainnet, Network::Chipnet] {
            let vm = network_settings_view_model(active, false);
            let live: Vec<_> = vm
                .available
                .iter()
                .filter(|option| option.active)
                .map(|option| option.network)
                .collect();
            assert_eq!(live, vec![active]);
        }
    }

    #[test]
    fn the_copy_matches_the_screen_it_was_ported_from() {
        let vm = network_settings_view_model(Network::Chipnet, false);
        assert!(vm.description.contains("clears the active network records"));
        assert!(vm.description.contains("Custom paths are preserved"));
        assert_eq!(vm.reload_label, "Reload and resync current wallet");
        assert_eq!(COMING_SOON_LABEL, "Coming soon");
        assert_eq!(vm.available[0].description, "Live BCH network — real funds");
        assert_eq!(
            vm.available[1].description,
            "BCH testnet for upcoming CHIPs — test funds only"
        );
    }

    #[test]
    fn the_resync_control_says_what_it_is_doing() {
        assert_eq!(
            network_settings_view_model(Network::Mainnet, true).reload_label,
            RELOADING_LABEL
        );
        assert!(network_settings_view_model(Network::Mainnet, true).busy);
    }

    #[test]
    fn source_lifecycle_matches_issue_75() {
        assert!(!NetworkSourceRow::expected_removable(SourceOriginView::Bootstrap));
        assert!(NetworkSourceRow::expected_removable(SourceOriginView::UserAdded));
        assert!(NetworkSourceRow::expected_removable(SourceOriginView::MyInfrastructure));
    }

    #[test]
    fn selected_one_and_selected_many_share_the_same_scope_type() {
        assert_eq!(
            SourceScopeView::Selected(vec!["a".into()]),
            SourceScopeView::Selected(vec!["a".into()])
        );
        assert_ne!(
            SourceScopeView::Selected(vec!["a".into()]),
            SourceScopeView::Selected(vec!["a".into(), "b".into()])
        );
    }
}
