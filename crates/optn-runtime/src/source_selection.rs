//! Shared source-selection edits for every GUI and CLI adapter.
use crate::chain::{
    ConnectionPolicy, ProtocolFamily, ProtocolSet, SourceCatalog, SourceId, SourceScope,
};
use optn_transport::chain_sources::{
    WireChainProtocol as ChainProtocolView, WireConnectionPolicy as ConnectionPolicyView,
    WireSourceScope as SourceScopeView,
};
use std::collections::BTreeSet;

const PROTOCOLS: [(ChainProtocolView, ProtocolFamily); 5] = [
    (ChainProtocolView::FulcrumElectrum, ProtocolFamily::Electrum),
    (ChainProtocolView::Bip37, ProtocolFamily::Bip37),
    (ChainProtocolView::Neutrino, ProtocolFamily::Neutrino),
    (ChainProtocolView::BchnRpc, ProtocolFamily::BchnRpc),
    (ChainProtocolView::BchnZmq, ProtocolFamily::BchnZmq),
];

pub fn view(policy: &ConnectionPolicy) -> ConnectionPolicyView {
    fn scope(value: &SourceScope) -> SourceScopeView {
        match value {
            SourceScope::AllEnabled => SourceScopeView::AllEnabled,
            SourceScope::PublicEnabled => SourceScopeView::PublicEnabled,
            SourceScope::UserInfrastructure => SourceScopeView::MyInfrastructure,
            SourceScope::Explicit(ids) => {
                SourceScopeView::Selected(ids.iter().map(|id| id.as_str().to_owned()).collect())
            }
        }
    }
    ConnectionPolicyView {
        protocols: PROTOCOLS
            .iter()
            .filter(|(_, protocol)| policy.protocols.contains(*protocol))
            .map(|(view, _)| *view)
            .collect(),
        primary_scope: scope(&policy.primary_scope),
        fallback_scope: policy.fallback_scope.as_ref().map(scope),
        preferred: policy
            .preferred
            .iter()
            .map(|id| id.as_str().to_owned())
            .collect(),
    }
}

/// Validate the complete selection before the caller publishes or persists it.
/// Disabled/banned sources remain excluded by the common selection planner.
pub fn policy(
    catalog: &SourceCatalog,
    value: &ConnectionPolicyView,
) -> Result<ConnectionPolicy, String> {
    fn ids(catalog: &SourceCatalog, values: &[String]) -> Result<Vec<SourceId>, String> {
        let mut seen = BTreeSet::new();
        values
            .iter()
            .map(|value| {
                let id = SourceId::new(value.clone());
                if catalog.get(&id).is_none() {
                    return Err(format!("Unknown source: {value}"));
                }
                if !seen.insert(id.clone()) {
                    return Err("A source cannot occur twice in a selection.".into());
                }
                Ok(id)
            })
            .collect()
    }
    fn scope(catalog: &SourceCatalog, value: &SourceScopeView) -> Result<SourceScope, String> {
        Ok(match value {
            SourceScopeView::AllEnabled => SourceScope::AllEnabled,
            SourceScopeView::PublicEnabled => SourceScope::PublicEnabled,
            SourceScopeView::MyInfrastructure => SourceScope::UserInfrastructure,
            SourceScopeView::Selected(values) => {
                if values.is_empty() {
                    return Err("Choose at least one source for a selected-source pool.".into());
                }
                SourceScope::Explicit(ids(catalog, values)?.into_iter().collect())
            }
        })
    }
    if value.protocols.is_empty() {
        return Err("Choose at least one protocol.".into());
    }
    let mut protocols = ProtocolSet::default();
    for protocol in &value.protocols {
        let resolved = PROTOCOLS
            .iter()
            .find(|(view, _)| view == protocol)
            .expect("exhaustive protocol map")
            .1;
        if protocols.contains(resolved) {
            return Err("A protocol cannot occur twice.".into());
        }
        protocols.insert(resolved);
    }
    Ok(ConnectionPolicy {
        protocols,
        primary_scope: scope(catalog, &value.primary_scope)?,
        fallback_scope: value
            .fallback_scope
            .as_ref()
            .map(|value| scope(catalog, value))
            .transpose()?,
        preferred: ids(catalog, &value.preferred)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{build_selection_plan, SourceDisposition};
    #[test]
    fn edited_selection_preserves_order_scopes_protocols_and_bans() {
        let mut catalog =
            crate::bootstrap::shipped_source_catalog(optn_core::network::Network::Chipnet);
        let mut extra = catalog.iter().next().unwrap().clone();
        extra.id = SourceId::new("test-second-source");
        catalog.insert(extra).unwrap();
        let ids: Vec<_> = catalog.iter().map(|s| s.id.clone()).collect();
        assert!(ids.len() > 1);
        let mut selection = view(&ConnectionPolicy::auto());
        selection.primary_scope = SourceScopeView::Selected(vec![ids[1].as_str().into()]);
        selection.fallback_scope = Some(SourceScopeView::AllEnabled);
        selection.preferred = ids.iter().rev().map(|id| id.as_str().into()).collect();
        let edited = policy(&catalog, &selection).unwrap();
        assert_eq!(view(&edited), selection);
        catalog
            .set_disposition(&ids[1], SourceDisposition::Banned)
            .unwrap();
        let plan = build_selection_plan(&catalog, &edited);
        assert!(!plan.primary.contains(&ids[1]));
        assert!(!plan.fallback.contains(&ids[1]));
        selection.preferred.push("missing".into());
        assert!(policy(&catalog, &selection).is_err());
        selection.preferred.clear();
        selection.protocols.clear();
        assert!(policy(&catalog, &selection).is_err());
    }
}
