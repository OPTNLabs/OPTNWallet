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
    /// A locally mined chain, for tests against a node we control.
    ///
    /// A real variant rather than chipnet wearing a different hat. It has its
    /// own address prefix, its own genesis and no difficulty retargeting, and
    /// keeping those explicit is what stops a regtest fixture from being
    /// mistaken for evidence about a network anyone else uses.
    Regtest,
}

impl Network {
    /// The CashAddr prefix this network's addresses carry.
    pub fn prefix(&self) -> &'static str {
        match self {
            Network::Mainnet => "bitcoincash",
            Network::Chipnet => "bchtest",
            Network::Regtest => "bchreg",
        }
    }

    /// Default Electrum endpoint, used when --host is not given.
    pub fn default_host(&self) -> &'static str {
        match self {
            Network::Mainnet => "bch.imaginary.cash",
            Network::Chipnet => "chipnet.imaginary.cash",
            // Loopback on purpose: a regtest build is one we started.
            Network::Regtest => "127.0.0.1",
        }
    }

    pub fn default_port(&self) -> u16 {
        50002
    }

    /// Default BIP44/SLIP-44 coin type used by this wallet.
    pub const fn default_coin_type(&self) -> u32 {
        match self {
            Network::Mainnet => 145,
            // Regtest shares testnet's SLIP-44 coin type.
            Network::Chipnet | Network::Regtest => 1,
        }
    }
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Network::Mainnet => write!(f, "mainnet"),
            Network::Chipnet => write!(f, "chipnet"),
            Network::Regtest => write!(f, "regtest"),
        }
    }
}

impl FromStr for Network {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mainnet" | "main" | "bitcoincash" => Ok(Network::Mainnet),
            "chipnet" | "chip" | "bchtest" | "testnet" | "testnet4" => Ok(Network::Chipnet),
            "regtest" | "bchreg" => Ok(Network::Regtest),
            other => Err(format!(
                "unknown network '{other}' (expected 'mainnet', 'chipnet' or 'regtest')"
            )),
        }
    }
}

#[cfg(test)]
mod regtest_isolation {
    use super::*;

    /// Regtest is its own network, not chipnet under another name.
    ///
    /// If any of these ever collapse into chipnet's values, a regtest fixture
    /// starts looking like evidence about a network other people use.
    #[test]
    fn regtest_is_distinct_from_the_networks_users_run_on() {
        assert_eq!(Network::Regtest.prefix(), "bchreg");
        assert_ne!(Network::Regtest.prefix(), Network::Chipnet.prefix());
        assert_ne!(Network::Regtest.prefix(), Network::Mainnet.prefix());
        assert_eq!(Network::Regtest.to_string(), "regtest");

        // Parsing is explicit in both directions, and chipnet's aliases do not
        // resolve to regtest.
        assert_eq!("regtest".parse::<Network>().unwrap(), Network::Regtest);
        assert_eq!("bchreg".parse::<Network>().unwrap(), Network::Regtest);
        for alias in ["chipnet", "chip", "bchtest", "testnet", "testnet4"] {
            assert_eq!(alias.parse::<Network>().unwrap(), Network::Chipnet);
        }
        assert!("bogus".parse::<Network>().is_err());
    }

    /// The production networks keep exactly the values they had.
    #[test]
    fn adding_regtest_did_not_move_mainnet_or_chipnet() {
        assert_eq!(Network::Mainnet.prefix(), "bitcoincash");
        assert_eq!(Network::Chipnet.prefix(), "bchtest");
        assert_eq!(Network::Mainnet.default_coin_type(), 145);
        assert_eq!(Network::Chipnet.default_coin_type(), 1);
        assert_eq!(Network::Mainnet.to_string(), "mainnet");
        assert_eq!(Network::Chipnet.to_string(), "chipnet");
    }
}
