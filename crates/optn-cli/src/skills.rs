//! What each command is allowed to do, and a gate that enforces it.
//!
//! An agent driving a wallet needs two things this CLI did not have. First, a
//! machine-readable description of what it can invoke — `--help` is prose, and
//! parsing prose to decide whether a command spends money is not a safety
//! mechanism. Second, a way for whoever runs the agent to say "you may read,
//! you may not spend", enforced by the binary rather than by the agent's own
//! restraint.
//!
//! Both come from one table. `optn skills` publishes it; the gate reads it.
//! They cannot disagree, which matters more than it sounds: a manifest that
//! says a command is read-only while the gate lets it spend is worse than
//! having neither.

use std::fmt;

use serde_json::{json, Value};

use crate::error::{CliError, Result};

/// What a command can do, ordered least to most dangerous.
///
/// The ordering is the whole mechanism: a policy admits every capability up to
/// its own level, so adding a level in the wrong place silently widens what an
/// agent may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Capability {
    /// Reads chain or local state. Cannot move funds or touch a secret.
    Read,
    /// Handles the recovery phrase or a key derived from it.
    Secret,
    /// Produces a signature. Nothing is broadcast.
    Sign,
    /// Moves funds, or authorises someone else to.
    Spend,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Read => "read",
            Capability::Secret => "secret",
            Capability::Sign => "sign",
            Capability::Spend => "spend",
        }
    }

    fn describe(self) -> &'static str {
        match self {
            Capability::Read => "reads chain or local state",
            Capability::Secret => "handles the recovery phrase or a derived key",
            Capability::Sign => "produces a signature; broadcasts nothing",
            Capability::Spend => "moves funds, or authorises a debit",
        }
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The most a command may do under the current policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy(Capability);

impl Policy {
    /// The default when nothing is set.
    ///
    /// Deliberately permissive: this binary already refuses to spend without
    /// `--yes`, and a default that broke every existing invocation would be
    /// turned off rather than used. The policy is the second lock, not the
    /// first.
    pub fn unrestricted() -> Self {
        Policy(Capability::Spend)
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "read" | "read-only" | "readonly" => Ok(Policy(Capability::Read)),
            "secret" => Ok(Policy(Capability::Secret)),
            "sign" => Ok(Policy(Capability::Sign)),
            "spend" | "full" | "all" => Ok(Policy(Capability::Spend)),
            other => Err(CliError::Usage(format!(
                "unknown policy '{other}' (expected read, secret, sign or spend)"
            ))),
        }
    }

    /// From `OPTN_POLICY`, or unrestricted.
    pub fn from_env() -> Result<Self> {
        match std::env::var("OPTN_POLICY") {
            Ok(v) if !v.trim().is_empty() => Policy::parse(&v),
            _ => Ok(Policy::unrestricted()),
        }
    }

    pub fn ceiling(self) -> Capability {
        self.0
    }

    pub fn admits(self, capability: Capability) -> bool {
        capability <= self.0
    }
}

/// One command, as an agent sees it.
pub struct Skill {
    /// The command as typed, subcommands space-separated.
    pub name: &'static str,
    pub capability: Capability,
    pub summary: &'static str,
    /// Needs a recovery phrase from the environment, keychain or stdin.
    pub needs_wallet: bool,
    /// Talks to an Electrum server or an HTTP endpoint.
    pub needs_network: bool,
    /// Refuses to act without `--yes`, on top of any policy.
    pub requires_confirmation: bool,
}

/// Every command this binary exposes.
///
/// Kept in one place and asserted against clap's own subcommand list, so a new
/// command cannot be added without deciding what it is allowed to do. The
/// failure mode being prevented is a command that an agent cannot see in the
/// manifest and that the gate therefore never classifies.
pub const SKILLS: &[Skill] = &[
    Skill {
        name: "ping",
        capability: Capability::Read,
        summary: "Check the Electrum server is reachable and report its version.",
        needs_wallet: false,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "balance",
        capability: Capability::Read,
        summary: "Confirmed and unconfirmed balance of an address.",
        needs_wallet: false,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "utxos",
        capability: Capability::Read,
        summary: "Unspent outputs held by an address.",
        needs_wallet: false,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "inspect",
        capability: Capability::Read,
        summary: "Show the scripthash and output script derived from an address. No network call.",
        needs_wallet: false,
        needs_network: false,
        requires_confirmation: false,
    },
    Skill {
        name: "tx",
        capability: Capability::Read,
        summary: "Fetch a transaction by id.",
        needs_wallet: false,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "decode",
        capability: Capability::Read,
        summary: "Decode a raw transaction, CashToken outputs included. No network call.",
        needs_wallet: false,
        needs_network: false,
        requires_confirmation: false,
    },
    Skill {
        // Derives addresses and reads bundled artifacts. No key material, no
        // network, nothing spent.
        name: "contract",
        capability: Capability::Read,
        summary: "List CashScript covenants, inspect one, or derive its address.",
        needs_wallet: false,
        needs_network: false,
        requires_confirmation: false,
    },
    Skill {
        name: "skills",
        capability: Capability::Read,
        summary: "This manifest: every command, what it may do, and the active policy.",
        needs_wallet: false,
        needs_network: false,
        requires_confirmation: false,
    },
    Skill {
        name: "broadcast",
        capability: Capability::Spend,
        summary: "Publish an already-signed transaction. Irreversible once accepted.",
        needs_wallet: false,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "new",
        capability: Capability::Secret,
        summary: "Generate a BIP39 recovery phrase. Prints a secret to stdout.",
        needs_wallet: false,
        needs_network: false,
        requires_confirmation: false,
    },
    Skill {
        name: "address",
        capability: Capability::Secret,
        summary: "Derive an address from the wallet's phrase.",
        needs_wallet: true,
        needs_network: false,
        requires_confirmation: false,
    },
    Skill {
        name: "discover",
        capability: Capability::Secret,
        summary: "Find which derivation paths the phrase has history on.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "rescan",
        capability: Capability::Secret,
        summary: "Rebuild the wallet view from the chain.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "history",
        capability: Capability::Secret,
        summary: "Transaction history across the wallet's own addresses.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        name: "tokens",
        capability: Capability::Secret,
        summary: "CashToken balances held by the wallet.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: false,
    },
    Skill {
        // Reads and writes the phrase itself. Not Spend — it moves nothing —
        // but a long way from Read.
        name: "keychain",
        capability: Capability::Secret,
        summary: "Store, check or remove the recovery phrase in the OS keychain.",
        needs_wallet: false,
        needs_network: false,
        requires_confirmation: false,
    },
    Skill {
        name: "send",
        capability: Capability::Spend,
        summary: "Send BCH. Builds, signs and broadcasts.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: true,
    },
    Skill {
        name: "token-send",
        capability: Capability::Spend,
        summary: "Send fungible CashTokens to a token-aware address.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: true,
    },
    Skill {
        name: "send-nft",
        capability: Capability::Spend,
        summary: "Send a CashToken NFT, identified by category and commitment.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: true,
    },
    Skill {
        // The whole command group is classified by its most dangerous member.
        // `x402 check` only reads, but a gate that admitted the group would
        // admit `x402 pay` with it.
        name: "x402",
        capability: Capability::Spend,
        summary: "Pay for an HTTP resource. `check` only reads; `pay` authorises a debit.",
        needs_wallet: true,
        needs_network: true,
        requires_confirmation: true,
    },
];

pub fn find(name: &str) -> Option<&'static Skill> {
    SKILLS.iter().find(|skill| skill.name == name)
}

/// Refuse a command the policy does not admit.
///
/// Checked before the command runs, so a refusal costs nothing and leaks
/// nothing. An unknown command is refused rather than allowed: a command
/// missing from the table is a gap in the manifest, and defaulting to "allow"
/// would make that gap invisible.
pub fn enforce(policy: Policy, command: &str) -> Result<()> {
    let skill = find(command).ok_or_else(|| {
        CliError::Internal(format!(
            "'{command}' is not in the skill manifest, so its capability is unknown"
        ))
    })?;

    if policy.admits(skill.capability) {
        return Ok(());
    }
    Err(CliError::Usage(format!(
        "policy '{}' does not permit '{command}' ({}). Raise OPTN_POLICY to '{}' to allow it.",
        policy.ceiling(),
        skill.capability.describe(),
        skill.capability
    )))
}

/// Every capability with what it means, for a harness building a UI.
fn capability_descriptions() -> Vec<Value> {
    [
        Capability::Read,
        Capability::Secret,
        Capability::Sign,
        Capability::Spend,
    ]
    .iter()
    .map(|c| json!({ "name": c.as_str(), "means": c.describe() }))
    .collect()
}

/// The manifest, as an agent harness reads it.
pub fn manifest(policy: Policy) -> Value {
    json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "policy": {
            "active": policy.ceiling().as_str(),
            "source": if std::env::var("OPTN_POLICY").is_ok() { "OPTN_POLICY" } else { "default" },
            "levels": [
                { "name": "read",   "admits": ["read"] },
                { "name": "secret", "admits": ["read", "secret"] },
                { "name": "sign",   "admits": ["read", "secret", "sign"] },
                { "name": "spend",  "admits": ["read", "secret", "sign", "spend"] },
            ],
        },
        "capabilities": capability_descriptions(),
        "skills": SKILLS.iter().map(|skill| json!({
            "name": skill.name,
            "capability": skill.capability.as_str(),
            "summary": skill.summary,
            "needs_wallet": skill.needs_wallet,
            "needs_network": skill.needs_network,
            "requires_confirmation": skill.requires_confirmation,
            "permitted": policy.admits(skill.capability),
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_are_ordered_least_to_most_dangerous() {
        // The gate is `capability <= ceiling`, so this ordering is the policy.
        // Reordering it silently widens what an agent may do.
        assert!(Capability::Read < Capability::Secret);
        assert!(Capability::Secret < Capability::Sign);
        assert!(Capability::Sign < Capability::Spend);
    }

    #[test]
    fn a_read_only_policy_refuses_every_spending_command() {
        let policy = Policy::parse("read-only").unwrap();
        for skill in SKILLS.iter().filter(|s| s.capability == Capability::Spend) {
            let err = enforce(policy, skill.name).unwrap_err();
            assert!(
                err.to_string().contains(skill.name),
                "refusal should name the command: {err}"
            );
        }
    }

    #[test]
    fn a_read_only_policy_still_permits_reading() {
        let policy = Policy::parse("read").unwrap();
        for skill in SKILLS.iter().filter(|s| s.capability == Capability::Read) {
            assert!(enforce(policy, skill.name).is_ok(), "{}", skill.name);
        }
    }

    #[test]
    fn a_read_only_policy_refuses_commands_that_touch_the_phrase() {
        // `address` moves no funds, but it derives keys from the recovery
        // phrase. An agent restricted to reading should not reach it.
        assert!(enforce(Policy::parse("read").unwrap(), "address").is_err());
        assert!(enforce(Policy::parse("secret").unwrap(), "address").is_ok());
    }

    #[test]
    fn the_default_policy_permits_everything() {
        // Spending is already gated behind --yes. A default that broke every
        // existing invocation would be switched off rather than used.
        let policy = Policy::unrestricted();
        for skill in SKILLS {
            assert!(enforce(policy, skill.name).is_ok(), "{}", skill.name);
        }
    }

    #[test]
    fn an_unknown_command_is_refused_rather_than_allowed() {
        // A command missing from the table is a hole in the manifest. Failing
        // closed is what makes that hole visible.
        assert!(enforce(Policy::unrestricted(), "teleport").is_err());
    }

    #[test]
    fn an_unknown_policy_name_is_a_usage_error() {
        assert!(Policy::parse("maybe").is_err());
        assert!(Policy::parse("").is_err());
    }

    #[test]
    fn every_skill_that_spends_also_demands_confirmation() {
        // Except broadcast, which takes an already-signed transaction: the
        // decision was made when it was signed, and requiring --yes there
        // would only be ceremony.
        for skill in SKILLS.iter().filter(|s| s.capability == Capability::Spend) {
            if skill.name == "broadcast" {
                continue;
            }
            assert!(
                skill.requires_confirmation,
                "{} spends but does not require --yes",
                skill.name
            );
        }
    }

    #[test]
    fn no_skill_is_listed_twice() {
        let mut names: Vec<&str> = SKILLS.iter().map(|s| s.name).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "a command is listed twice");
    }

    #[test]
    fn the_manifest_marks_what_the_policy_permits() {
        let value = manifest(Policy::parse("read").unwrap());
        let skills = value["skills"].as_array().unwrap();
        assert_eq!(skills.len(), SKILLS.len());
        for entry in skills {
            let permitted = entry["permitted"].as_bool().unwrap();
            let is_read = entry["capability"] == "read";
            assert_eq!(permitted, is_read, "{}", entry["name"]);
        }
        assert_eq!(value["policy"]["active"], "read");
    }
}
