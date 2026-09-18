//! Block explorer presets and URL building, for issue #75 row 15.
//!
//! An explorer link is navigation, never chain truth: nothing here feeds
//! consensus, spend authorization or UTXO state. But it is still a network
//! request that names one of the holder's transactions or addresses to a third
//! party, which is exactly what "own infrastructure only" exists to prevent.
//! So the policy that governs chain sources governs this too, and it is
//! applied here rather than at each call site.
//!
//! This module used to be `src/utils/servers/explorers.ts`. The renderer copy
//! had the presets and none of the policy, so a holder on own-infrastructure
//! could open a transaction and hand its txid to a public website — the one
//! thing they had asked the wallet not to do. `chainSourcesBridge.ts` already
//! states the rule this broke: a second copy of a selection rule in the
//! renderer is how a policy ends up enforced on one surface and not another.
//!
//! The preset ids and URL templates are carried over unchanged, so a saved
//! `explorerId` keeps resolving to the explorer the holder picked.

use crate::network::Network;

/// A public explorer the wallet can offer.
///
/// `chipnet_*` is present only where the operator runs a test-network site.
/// Where it is absent the chipnet fallback is used instead, because sending a
/// chipnet txid to a mainnet explorer produces a confident "not found" that
/// reads like the transaction failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorerPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub tx: &'static str,
    pub address: &'static str,
    pub block: Option<&'static str>,
    pub chipnet_tx: Option<&'static str>,
    pub chipnet_address: Option<&'static str>,
}

/// Default is BCH Explorer (bchexplorer.cash), Melroy van den Berg's
/// open-source explorer.
pub const DEFAULT_PRESET_ID: &str = "bchexplorer";

pub const PRESETS: &[ExplorerPreset] = &[
    ExplorerPreset {
        id: "bchexplorer",
        label: "BCH Explorer (bchexplorer.cash)",
        tx: "https://bchexplorer.cash/tx/{txid}",
        address: "https://bchexplorer.cash/address/{address}",
        block: Some("https://bchexplorer.cash/block/{block}"),
        chipnet_tx: Some("https://bchexplorer.cash/chipnet/tx/{txid}"),
        chipnet_address: Some("https://bchexplorer.cash/chipnet/address/{address}"),
    },
    ExplorerPreset {
        id: "bch-ninja",
        label: "explorer.bch.ninja",
        tx: "https://explorer.bch.ninja/tx/{txid}",
        address: "https://explorer.bch.ninja/address/{address}",
        block: None,
        chipnet_tx: Some("https://chipnet.bch.ninja/tx/{txid}"),
        chipnet_address: Some("https://chipnet.bch.ninja/address/{address}"),
    },
    ExplorerPreset {
        id: "imaginary",
        label: "explorer.imaginary.cash",
        tx: "https://explorer.imaginary.cash/tx/{txid}",
        address: "https://explorer.imaginary.cash/address/{address}",
        block: None,
        chipnet_tx: None,
        chipnet_address: None,
    },
    ExplorerPreset {
        id: "blockchair",
        label: "Blockchair",
        tx: "https://blockchair.com/bitcoin-cash/transaction/{txid}",
        address: "https://blockchair.com/bitcoin-cash/address/{address}",
        block: None,
        chipnet_tx: None,
        chipnet_address: None,
    },
    ExplorerPreset {
        id: "3xpl",
        label: "3xpl",
        tx: "https://3xpl.com/bitcoin-cash/transaction/{txid}",
        address: "https://3xpl.com/bitcoin-cash/address/{address}",
        block: None,
        chipnet_tx: None,
        chipnet_address: None,
    },
    ExplorerPreset {
        id: "tokenexplorer",
        label: "TokenExplorer (CashTokens)",
        tx: "https://tokenexplorer.cash/?tx={txid}",
        address: "https://tokenexplorer.cash/?address={address}",
        block: None,
        chipnet_tx: None,
        chipnet_address: None,
    },
];

/// Chipnet has no BCH Explorer site, so test-network links fall back here
/// regardless of the chosen mainnet explorer unless it defines its own.
const CHIPNET_FALLBACK_TX: &str = "https://chipnet.bch.ninja/tx/{txid}";
const CHIPNET_FALLBACK_ADDRESS: &str = "https://chipnet.bch.ninja/address/{address}";

pub fn preset(id: &str) -> &'static ExplorerPreset {
    PRESETS
        .iter()
        .find(|entry| entry.id == id)
        .unwrap_or(&PRESETS[0])
}

/// Which explorer to use: one of the shipped presets, or templates the holder
/// supplied themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplorerChoice {
    Preset(String),
    Custom { tx: String, address: String },
}

/// What is being looked up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplorerObject<'a> {
    Transaction(&'a str),
    Address(&'a str),
    Block(&'a str),
}

/// Whether an explorer lookup may leave the holder's own infrastructure.
///
/// Derived from the connection policy rather than set separately: a holder who
/// restricted chain access to their own nodes did not separately consent to
/// telling blockchair.com which transactions they care about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplorerPolicy {
    /// Any shipped preset is fine.
    PublicAllowed,
    /// Only an explorer the holder supplied. Fail closed: with none configured
    /// there is no link, rather than a public one.
    UserOwnedOnly,
    /// No explorer links at all.
    Disabled,
}

impl ExplorerPolicy {
    /// The explorer policy implied by a chain connection policy.
    ///
    /// Named by the same strings the settings surface and the runtime already
    /// use (`chainSourcesBridge.ts`), so the two cannot drift: an unrecognised
    /// policy is treated as `UserOwnedOnly`, because a policy this build does
    /// not know about is not one it can claim permits public lookups.
    pub fn for_chain_policy(policy: &str) -> Self {
        match policy {
            "auto" | "electrum_only" | "bip37_only" | "neutrino_only" => Self::PublicAllowed,
            // `privacy` is client-side filtering precisely so addresses are not
            // handed to an indexed server; an explorer link would undo it.
            "privacy" | "own_infrastructure" => Self::UserOwnedOnly,
            "disabled" | "none" => Self::Disabled,
            _ => Self::UserOwnedOnly,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplorerError {
    /// The policy forbids a public explorer and none of the holder's own is
    /// configured.
    PublicExplorerRefused,
    Disabled,
    /// A template that does not carry the placeholder it is used for, or does
    /// not address a web page.
    InvalidTemplate,
    /// A txid, address or height that is not one.
    InvalidObject,
}

impl core::fmt::Display for ExplorerError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let message = match self {
            Self::PublicExplorerRefused => {
                "this wallet is set to use only your own infrastructure, and no explorer of \
                 yours is configured -- opening a public explorer would tell it which \
                 transactions are yours"
            }
            Self::Disabled => "explorer links are turned off",
            Self::InvalidTemplate => "that explorer address is not a usable https:// template",
            Self::InvalidObject => "that is not a transaction id, address or height",
        };
        f.write_str(message)
    }
}

impl std::error::Error for ExplorerError {}

/// A txid/address/height is pasted into a URL, so it is bounded to what those
/// actually contain. Cashaddr carries `:`, and nothing here needs `/`, `?`,
/// `#` or `%` -- each of which would let a crafted value point the link
/// somewhere else on the explorer's site.
fn object_is_well_formed(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_'))
}

fn fill(template: &str, key: &str, value: &str) -> Result<String, ExplorerError> {
    let placeholder = format!("{{{key}}}");
    if !template.contains(&placeholder) {
        return Err(ExplorerError::InvalidTemplate);
    }
    if !(template.starts_with("https://") || template.starts_with("http://")) {
        return Err(ExplorerError::InvalidTemplate);
    }
    Ok(template.replace(&placeholder, value))
}

/// Build the URL for one lookup, or refuse.
///
/// This is the only place a link is produced. Every surface calls it, so
/// "own infrastructure only" means the same thing on all of them.
pub fn explorer_url(
    choice: &ExplorerChoice,
    network: Network,
    object: ExplorerObject<'_>,
    policy: ExplorerPolicy,
) -> Result<String, ExplorerError> {
    if matches!(policy, ExplorerPolicy::Disabled) {
        return Err(ExplorerError::Disabled);
    }

    let (key, value) = match object {
        ExplorerObject::Transaction(value) => ("txid", value),
        ExplorerObject::Address(value) => ("address", value),
        ExplorerObject::Block(value) => ("block", value),
    };
    if !object_is_well_formed(value) {
        return Err(ExplorerError::InvalidObject);
    }

    match choice {
        // The holder typed this one in, which is the only way to name an
        // explorer of their own, so it is the only kind that survives
        // `UserOwnedOnly`.
        ExplorerChoice::Custom { tx, address } => {
            let template = match object {
                ExplorerObject::Transaction(_) => tx,
                ExplorerObject::Address(_) => address,
                // A custom explorer names a tx and an address template only.
                // Guessing a block URL from either would be a fabricated link.
                ExplorerObject::Block(_) => return Err(ExplorerError::InvalidTemplate),
            };
            fill(template, key, value)
        }
        ExplorerChoice::Preset(id) => {
            // Every preset is a public website by construction.
            if matches!(policy, ExplorerPolicy::UserOwnedOnly) {
                return Err(ExplorerError::PublicExplorerRefused);
            }
            let preset = preset(id);
            // testnet3 and testnet4 have no shipped explorer; chipnet's is the
            // closest thing and still wrong, so only chipnet is redirected.
            let template = match (object, network) {
                (ExplorerObject::Transaction(_), Network::Chipnet) => {
                    preset.chipnet_tx.unwrap_or(CHIPNET_FALLBACK_TX)
                }
                (ExplorerObject::Address(_), Network::Chipnet) => {
                    preset.chipnet_address.unwrap_or(CHIPNET_FALLBACK_ADDRESS)
                }
                (ExplorerObject::Transaction(_), _) => preset.tx,
                (ExplorerObject::Address(_), _) => preset.address,
                (ExplorerObject::Block(_), _) => {
                    preset.block.ok_or(ExplorerError::InvalidTemplate)?
                }
            };
            fill(template, key, value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom() -> ExplorerChoice {
        ExplorerChoice::Custom {
            tx: "https://explorer.home/tx/{txid}".into(),
            address: "https://explorer.home/address/{address}".into(),
        }
    }

    #[test]
    fn own_infrastructure_refuses_every_public_preset() {
        // The whole point of the row: no preset is exempt, including the
        // default one a holder never chose.
        for entry in PRESETS {
            let error = explorer_url(
                &ExplorerChoice::Preset(entry.id.into()),
                Network::Mainnet,
                ExplorerObject::Transaction("abc123"),
                ExplorerPolicy::UserOwnedOnly,
            )
            .unwrap_err();
            assert_eq!(
                error,
                ExplorerError::PublicExplorerRefused,
                "preset {} leaked under own-infrastructure-only",
                entry.id
            );
        }
    }

    #[test]
    fn own_infrastructure_still_opens_the_holders_own_explorer() {
        // Fail-closed must not mean "no explorer ever": the holder running one
        // is precisely who this policy is for.
        assert_eq!(
            explorer_url(
                &custom(),
                Network::Mainnet,
                ExplorerObject::Transaction("abc123"),
                ExplorerPolicy::UserOwnedOnly,
            )
            .unwrap(),
            "https://explorer.home/tx/abc123"
        );
    }

    #[test]
    fn privacy_policy_is_treated_the_same_as_own_infrastructure() {
        // Client-side filtering exists so addresses are never handed to an
        // indexed server. An explorer lookup hands over the same address.
        assert_eq!(
            ExplorerPolicy::for_chain_policy("privacy"),
            ExplorerPolicy::UserOwnedOnly
        );
        assert_eq!(
            ExplorerPolicy::for_chain_policy("own_infrastructure"),
            ExplorerPolicy::UserOwnedOnly
        );
    }

    #[test]
    fn an_unknown_chain_policy_fails_closed() {
        // A newer settings surface naming a policy this build does not know
        // must not be read as permission.
        assert_eq!(
            ExplorerPolicy::for_chain_policy("some_future_policy"),
            ExplorerPolicy::UserOwnedOnly
        );
        assert_eq!(
            ExplorerPolicy::for_chain_policy("auto"),
            ExplorerPolicy::PublicAllowed
        );
    }

    #[test]
    fn chipnet_never_resolves_to_a_mainnet_explorer() {
        // A chipnet txid on a mainnet explorer renders a confident "not found"
        // that reads like the transaction failed.
        for entry in PRESETS {
            let url = explorer_url(
                &ExplorerChoice::Preset(entry.id.into()),
                Network::Chipnet,
                ExplorerObject::Transaction("abc123"),
                ExplorerPolicy::PublicAllowed,
            )
            .unwrap();
            assert!(
                url.contains("chipnet"),
                "preset {} sent a chipnet txid to {url}",
                entry.id
            );
        }
    }

    #[test]
    fn a_crafted_object_cannot_redirect_the_link() {
        for hostile in [
            "../../evil",
            "abc/../..",
            "abc?next=https://evil",
            "abc#frag",
            "abc%2f",
            "",
        ] {
            assert_eq!(
                explorer_url(
                    &custom(),
                    Network::Mainnet,
                    ExplorerObject::Transaction(hostile),
                    ExplorerPolicy::UserOwnedOnly,
                ),
                Err(ExplorerError::InvalidObject),
                "{hostile:?} was accepted into a URL"
            );
        }
    }

    #[test]
    fn a_custom_template_without_its_placeholder_is_refused() {
        // Otherwise the link silently opens the explorer's front page, which
        // looks like the explorer simply does not have the transaction.
        let choice = ExplorerChoice::Custom {
            tx: "https://explorer.home/".into(),
            address: "https://explorer.home/address/{address}".into(),
        };
        assert_eq!(
            explorer_url(
                &choice,
                Network::Mainnet,
                ExplorerObject::Transaction("abc123"),
                ExplorerPolicy::UserOwnedOnly,
            ),
            Err(ExplorerError::InvalidTemplate)
        );
    }

    #[test]
    fn disabled_produces_no_link_at_all() {
        assert_eq!(
            explorer_url(
                &custom(),
                Network::Mainnet,
                ExplorerObject::Transaction("abc123"),
                ExplorerPolicy::Disabled,
            ),
            Err(ExplorerError::Disabled)
        );
    }

    #[test]
    fn preset_ids_are_unique_and_the_default_exists() {
        let mut ids: Vec<&str> = PRESETS.iter().map(|entry| entry.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "two presets share an id");
        assert!(PRESETS.iter().any(|entry| entry.id == DEFAULT_PRESET_ID));
    }

    #[test]
    fn the_shipped_templates_are_all_usable() {
        // A typo in a template is invisible until someone clicks it.
        for entry in PRESETS {
            for (template, key) in [(entry.tx, "txid"), (entry.address, "address")] {
                assert!(
                    fill(template, key, "x").is_ok(),
                    "{} has an unusable {key} template: {template}",
                    entry.id
                );
            }
            if let Some(block) = entry.block {
                assert!(fill(block, "block", "1").is_ok(), "{} block", entry.id);
            }
        }
    }
}
