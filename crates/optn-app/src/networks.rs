//! Settings → Network: choosing one, resyncing, and what is coming.
//!
//! Ported from `NetworkSettings.tsx`, including its exact copy. Two things
//! about the shape are deliberate:
//!
//! **Planned networks are a different type from selectable ones.** Testnet3,
//! Testnet4 and Regtest are listed so the roadmap is visible, but they are
//! [`PlannedNetwork`], not [`Network`]. A renderer cannot pass one to
//! `SetNetwork` because it would not typecheck — the disabled state is a
//! consequence of the type rather than a flag someone has to remember to
//! honour. The React version relies on `aria-disabled` and a CSS class, which
//! is one forgotten conditional away from switching to a network the wallet
//! cannot talk to.
//!
//! **Switching is destructive and says so.** The description is carried
//! verbatim because it is a warning, not decoration: switching clears the
//! active network records, derives the network path, and resynchronises
//! addresses.

use crate::Network;

/// The warning shown above the list. Verbatim from `settingsNetwork.description`.
pub const NETWORK_DESCRIPTION: &str = "Switching networks clears the active network records, \
     derives the network path, and resynchronizes receive/change addresses. \
     Custom paths are preserved across network changes.";

/// `settingsNetwork.reload`.
pub const RELOAD_LABEL: &str = "Reload and resync current wallet";
/// `settingsNetwork.reloading`.
pub const RELOADING_LABEL: &str = "Reloading wallet…";
/// `settingsNetwork.comingSoon`.
pub const COMING_SOON_LABEL: &str = "Coming soon";

/// A network the wallet intends to support but cannot yet reach.
///
/// Deliberately not a [`Network`]. Adding one here makes it appear in the UI
/// as a disabled row; it becomes selectable only by moving it into `Network`,
/// which forces the Electrum endpoints and address parsing to be handled at
/// the same time.
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

/// A network that can actually be selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetworkOption {
    pub network: Network,
    pub label: &'static str,
    pub description: &'static str,
    pub active: bool,
}

/// Everything the Network settings screen needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkSettingsViewModel {
    pub description: &'static str,
    pub available: Vec<NetworkOption>,
    /// Present so the roadmap is visible, and unselectable by type.
    pub coming_soon: &'static [PlannedNetwork],
    /// A switch or a resync is in flight.
    pub busy: bool,
    /// Label for the resync control, which changes while it runs.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planned_networks_are_listed_but_cannot_be_selected() {
        let vm = network_settings_view_model(Network::Mainnet, false);
        assert_eq!(
            vm.coming_soon.iter().map(|n| n.label()).collect::<Vec<_>>(),
            vec!["Testnet3", "Testnet4", "Regtest"],
            "the roadmap stays visible rather than being hidden"
        );
        // The guarantee: a planned network is not a Network, so no renderer
        // can hand one to SetNetwork. The disabled state is the type, not a
        // flag someone has to remember.
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
        // A warning, not decoration: switching is destructive.
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
}
