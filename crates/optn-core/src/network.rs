//! Network selection.
//!
//! Chipnet and mainnet differ in more than a server address: they use
//! different CashAddr prefixes, and an address from one is not merely
//! unfunded on the other, it is a different address entirely. Decoding a
//! `bchtest:` address against mainnet succeeds — the checksum covers the
//! prefix, so a mismatched prefix fails the checksum rather than returning a
//! wrong result — but querying mainnet for a chipnet address returns an empty
//! balance, which reads exactly like an address with no history.
//!
//! So the network is explicit, and a prefix that disagrees with it is refused.

use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Chipnet,
}

impl Network {
    /// The CashAddr prefix this network's addresses carry.
    pub fn prefix(&self) -> &'static str {
        match self {
            Network::Mainnet => "bitcoincash",
            Network::Chipnet => "bchtest",
        }
    }

    /// Default Electrum endpoint, used when --host is not given.
    pub fn default_host(&self) -> &'static str {
        match self {
            Network::Mainnet => "bch.imaginary.cash",
            Network::Chipnet => "chipnet.imaginary.cash",
        }
    }

    pub fn default_port(&self) -> u16 {
        50002
    }
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Network::Mainnet => write!(f, "mainnet"),
            Network::Chipnet => write!(f, "chipnet"),
        }
    }
}

impl FromStr for Network {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mainnet" | "main" | "bitcoincash" => Ok(Network::Mainnet),
            "chipnet" | "chip" | "bchtest" | "testnet" => Ok(Network::Chipnet),
            other => Err(format!(
                "unknown network '{other}' (expected 'mainnet' or 'chipnet')"
            )),
        }
    }
}
