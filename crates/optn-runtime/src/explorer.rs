//! Explorer routing for issue #75, row 15.
//!
//! Explorer selection is human-facing navigation only. It never participates
//! in wallet consensus, spend authorization, UTXO truth, or provider voting.
//!
//! What it *is* is a network request naming one of the holder's transactions
//! to a third party, so the connection policy governs it. This module joins
//! the two: it turns a persisted [`UserNetworkOverlay`] — the holder's chain
//! policy and their own explorer, if they run one — into the inputs
//! `optn_core::explorer` decides from.
//!
//! The URL building and the policy rule live in `optn-core` rather than here,
//! because the renderers reach that crate through WASM and this one only from
//! the desktop shell and the CLI. Two copies of the rule is how a policy ends
//! up enforced on one surface and not another; this module used to be the
//! second copy, and it was the one nothing called.

use crate::chain::EndpointKind;
use crate::chain::{ConnectionPolicy, ExplorerEndpoint};
use crate::network_config::{ChainPolicyPreset, UserNetworkOverlay};
use optn_core::explorer::{explorer_url, ExplorerChoice, ExplorerError, ExplorerPolicy};
use optn_core::network::Network;

pub use optn_core::explorer::{ExplorerObject, ExplorerPolicy as CoreExplorerPolicy};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplorerRouteError {
    Disabled,
    NoEligibleExplorer,
    InvalidBaseUrl,
}

impl From<ExplorerError> for ExplorerRouteError {
    fn from(error: ExplorerError) -> Self {
        match error {
            ExplorerError::Disabled => Self::Disabled,
            ExplorerError::PublicExplorerRefused => Self::NoEligibleExplorer,
            ExplorerError::InvalidTemplate | ExplorerError::InvalidObject => Self::InvalidBaseUrl,
        }
    }
}

/// The explorer policy a chain connection policy implies.
///
/// Derived, never stored separately: a holder who restricted chain access to
/// their own nodes did not separately consent to telling a public explorer
/// which transactions they care about, and a second setting they would have to
/// find and match is a setting that will disagree with the first one.
pub fn explorer_policy_for(policy: &ConnectionPolicy) -> ExplorerPolicy {
    let name = serde_json::to_value(ChainPolicyPreset::describe(policy))
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    ExplorerPolicy::for_chain_policy(&name)
}

/// The holder's own explorer, as the core's choice type.
///
/// `None` when they have not configured one, which under a private policy
/// means there is no link to offer — the fail-closed outcome, not an error.
pub fn explorer_choice(overlay: &UserNetworkOverlay) -> Option<ExplorerChoice> {
    let endpoint = overlay.explorer.as_ref()?;
    let scheme = match endpoint.kind {
        EndpointKind::ExplorerHttps => "https",
        EndpointKind::ExplorerHttp => "http",
        // Not an explorer at all; a node endpoint saved in the explorer slot
        // would otherwise produce a link to a JSON-RPC port.
        _ => return None,
    };
    let authority = match endpoint.port {
        Some(port) => format!("{}:{port}", endpoint.host),
        None => endpoint.host.clone(),
    };
    let base = format!("{scheme}://{authority}");
    Some(ExplorerChoice::Custom {
        tx: format!("{base}/tx/{{txid}}"),
        address: format!("{base}/address/{{address}}"),
    })
}

/// The link for one lookup under this holder's saved configuration, or the
/// reason there is none.
///
/// This is the whole row in one call: policy in, link or refusal out, with no
/// surface able to reach past it.
pub fn route_for_overlay(
    overlay: &UserNetworkOverlay,
    network: Network,
    object: ExplorerObject<'_>,
) -> Result<String, ExplorerRouteError> {
    let policy = explorer_policy_for(&overlay.connection_policy);
    if matches!(policy, ExplorerPolicy::Disabled) {
        return Err(ExplorerRouteError::Disabled);
    }
    let choice = match explorer_choice(overlay) {
        Some(choice) => choice,
        None if matches!(policy, ExplorerPolicy::UserOwnedOnly) => {
            // No explorer of theirs, and no permission to use anyone else's.
            return Err(ExplorerRouteError::NoEligibleExplorer);
        }
        None => ExplorerChoice::Preset(optn_core::explorer::DEFAULT_PRESET_ID.to_string()),
    };
    explorer_url(&choice, network, object, policy).map_err(ExplorerRouteError::from)
}

/// Pure selector over an explicit endpoint list, for callers that hold one
/// rather than an overlay.
pub fn select_explorer(
    policy: ExplorerPolicy,
    endpoints: &[ExplorerEndpoint],
) -> Result<&ExplorerEndpoint, ExplorerRouteError> {
    if matches!(policy, ExplorerPolicy::Disabled) {
        return Err(ExplorerRouteError::Disabled);
    }

    if let Some(owned) = endpoints.iter().find(|endpoint| endpoint.user_owned) {
        return Ok(owned);
    }

    if matches!(policy, ExplorerPolicy::PublicAllowed) {
        return endpoints
            .first()
            .ok_or(ExplorerRouteError::NoEligibleExplorer);
    }

    // UserOwnedOnly is fail-closed: absence of a user-owned explorer cannot
    // silently leak a transaction/address lookup to a public website.
    Err(ExplorerRouteError::NoEligibleExplorer)
}

pub fn route_url(
    endpoint: &ExplorerEndpoint,
    object: ExplorerObject<'_>,
) -> Result<String, ExplorerRouteError> {
    let base = endpoint.base_url.trim_end_matches('/');
    let choice = ExplorerChoice::Custom {
        tx: format!("{base}/tx/{{txid}}"),
        address: format!("{base}/address/{{address}}"),
    };
    // The endpoint is the holder's by construction here: the caller already
    // applied the policy through `select_explorer`.
    explorer_url(
        &choice,
        Network::Mainnet,
        object,
        ExplorerPolicy::UserOwnedOnly,
    )
    .map_err(ExplorerRouteError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::Endpoint;

    fn public() -> ExplorerEndpoint {
        ExplorerEndpoint {
            label: "public".into(),
            base_url: "https://public.example".into(),
            user_owned: false,
        }
    }

    fn owned() -> ExplorerEndpoint {
        ExplorerEndpoint {
            label: "home".into(),
            base_url: "https://explorer.home".into(),
            user_owned: true,
        }
    }

    fn overlay(policy: ConnectionPolicy, explorer: Option<Endpoint>) -> UserNetworkOverlay {
        UserNetworkOverlay {
            connection_policy: policy,
            explorer,
            ..Default::default()
        }
    }

    fn own_explorer() -> Endpoint {
        Endpoint {
            kind: EndpointKind::ExplorerHttps,
            host: "explorer.lan".into(),
            port: None,
        }
    }

    #[test]
    fn own_infrastructure_policy_never_falls_back_public() {
        assert_eq!(
            select_explorer(ExplorerPolicy::UserOwnedOnly, &[public()]),
            Err(ExplorerRouteError::NoEligibleExplorer)
        );
    }

    #[test]
    fn user_owned_wins_even_when_public_is_allowed() {
        let endpoints = [public(), owned()];
        assert_eq!(
            select_explorer(ExplorerPolicy::PublicAllowed, &endpoints)
                .unwrap()
                .label,
            "home"
        );
    }

    #[test]
    fn navigation_path_is_separate_and_bounded() {
        let url = route_url(&owned(), ExplorerObject::Transaction("abc123")).unwrap();
        assert_eq!(url, "https://explorer.home/tx/abc123");
    }

    // ---- the row, end to end: a saved configuration in, a link or a refusal
    // out, with nothing in between able to widen it -------------------------

    #[test]
    fn a_saved_own_infrastructure_policy_refuses_a_public_explorer() {
        // The configuration a holder actually persists, not a policy value
        // handed to the selector by a test.
        let saved = overlay(ConnectionPolicy::own_infrastructure(), None);
        assert_eq!(
            route_for_overlay(
                &saved,
                Network::Mainnet,
                ExplorerObject::Transaction("abc123")
            ),
            Err(ExplorerRouteError::NoEligibleExplorer)
        );
    }

    #[test]
    fn the_same_policy_opens_the_holders_own_explorer() {
        let saved = overlay(ConnectionPolicy::own_infrastructure(), Some(own_explorer()));
        assert_eq!(
            route_for_overlay(
                &saved,
                Network::Mainnet,
                ExplorerObject::Transaction("abc123")
            )
            .unwrap(),
            "https://explorer.lan/tx/abc123"
        );
    }

    #[test]
    fn auto_opens_a_public_explorer() {
        // The other direction: fail-closed must not mean nobody gets a link.
        let saved = overlay(ConnectionPolicy::auto(), None);
        let url = route_for_overlay(
            &saved,
            Network::Mainnet,
            ExplorerObject::Transaction("abc123"),
        )
        .unwrap();
        assert!(url.starts_with("https://bchexplorer.cash/tx/"), "{url}");
    }

    #[test]
    fn a_policy_no_preset_can_name_is_treated_as_private() {
        // `describe` returns Custom for a policy this build cannot name, and
        // rounding an unnameable policy up to "public is fine" is exactly the
        // leak #75 forbids.
        let unnameable = ConnectionPolicy {
            protocols: crate::chain::ProtocolSet::wallet_sync(),
            primary_scope: crate::chain::SourceScope::UserInfrastructure,
            fallback_scope: Some(crate::chain::SourceScope::AllEnabled),
            preferred: Vec::new(),
        };
        assert_eq!(
            ChainPolicyPreset::describe(&unnameable),
            ChainPolicyPreset::Custom
        );
        assert_eq!(
            explorer_policy_for(&unnameable),
            ExplorerPolicy::UserOwnedOnly
        );
    }

    #[test]
    fn a_node_endpoint_saved_as_an_explorer_is_not_linked_to() {
        // Otherwise a stored RPC endpoint becomes a link to a JSON-RPC port.
        let saved = overlay(
            ConnectionPolicy::own_infrastructure(),
            Some(Endpoint {
                kind: EndpointKind::BchnRpc,
                host: "node.lan".into(),
                port: Some(8332),
            }),
        );
        assert_eq!(
            route_for_overlay(
                &saved,
                Network::Mainnet,
                ExplorerObject::Transaction("abc123")
            ),
            Err(ExplorerRouteError::NoEligibleExplorer)
        );
    }
}
