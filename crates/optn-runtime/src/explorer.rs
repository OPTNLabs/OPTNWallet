//! Explorer routing for issue #75.
//!
//! Explorer selection is human-facing navigation only. It never participates
//! in wallet consensus, spend authorization, UTXO truth, or provider voting.

use crate::chain::{ExplorerEndpoint, ExplorerPolicy};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplorerRouteError {
    Disabled,
    NoEligibleExplorer,
    InvalidBaseUrl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplorerObject<'a> {
    Transaction(&'a str),
    Block(&'a str),
    Address(&'a str),
}

/// Pure selector so every shell/renderer observes the same privacy boundary.
pub fn select_explorer<'a>(
    policy: ExplorerPolicy,
    endpoints: &'a [ExplorerEndpoint],
) -> Result<&'a ExplorerEndpoint, ExplorerRouteError> {
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

    // PreferUserOwned is fail-closed: absence of a user-owned explorer cannot
    // silently leak a transaction/address lookup to a public website.
    Err(ExplorerRouteError::NoEligibleExplorer)
}

pub fn route_url(
    endpoint: &ExplorerEndpoint,
    object: ExplorerObject<'_>,
) -> Result<String, ExplorerRouteError> {
    let base = endpoint.base_url.trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(ExplorerRouteError::InvalidBaseUrl);
    }
    let (kind, value) = match object {
        ExplorerObject::Transaction(value) => ("tx", value),
        ExplorerObject::Block(value) => ("block", value),
        ExplorerObject::Address(value) => ("address", value),
    };
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_'))
    {
        return Err(ExplorerRouteError::InvalidBaseUrl);
    }
    Ok(format!("{base}/{kind}/{value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn own_infrastructure_policy_never_falls_back_public() {
        assert_eq!(
            select_explorer(ExplorerPolicy::PreferUserOwned, &[public()]),
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
}
