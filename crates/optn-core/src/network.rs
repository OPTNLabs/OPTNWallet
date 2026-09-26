//! Network selection.
//!
//! The networks differ in more than a server address: they use different
//! CashAddr prefixes, and an address from one is not merely unfunded on the
//! other, it is a different address entirely. Decoding a `bchtest:` address
//! against mainnet succeeds — the checksum covers the prefix, so a mismatched
//! prefix fails the checksum rather than returning a wrong result — but
//! querying mainnet for a testnet address returns an empty balance, which
//! reads exactly like an address with no history.
//!
//! So the network is explicit, and a prefix that disagrees with it is refused.
//!
//! Three testnets share the `bchtest:` prefix, which means the prefix cannot
//! name a network on its own. Anything that has to know *which* chain — a
//! genesis hash, a P2P magic, an ASERT anchor, a header checkpoint — takes a
//! `Network`, never a prefix and never a free-form string with a fallback.

use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Network {
    Mainnet,
    /// The long-running BCH testnet, carried over from Bitcoin's testnet3.
    Testnet3,
    /// The low-height testnet reset for BCH, and chipnet's parent chain.
    Testnet4,
    /// Testnet4 running the next upgrade's rules ahead of activation.
    ///
    /// Consensus-identical to testnet4 at the header level — same genesis,
    /// same ASERT anchor, same P2P magic — and separated only by the peers it
    /// talks to. That is why a stored header view carries its network label:
    /// nothing in the headers themselves tells these two apart.
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
    /// Every network, so a table that must cover all of them can be checked
    /// rather than trusted. Adding a variant without extending a table is a
    /// failing test here, not a silent fallback at runtime.
    pub const ALL: [Network; 5] = [
        Network::Mainnet,
        Network::Testnet3,
        Network::Testnet4,
        Network::Chipnet,
        Network::Regtest,
    ];

    /// The CashAddr prefix this network's addresses carry.
    ///
    /// Not unique: the three testnets share `bchtest`. Use it to encode and
    /// decode addresses, never to decide which chain to talk to.
    pub const fn prefix(&self) -> &'static str {
        match self {
            Network::Mainnet => "bitcoincash",
            Network::Testnet3 | Network::Testnet4 | Network::Chipnet => "bchtest",
            Network::Regtest => "bchreg",
        }
    }

    /// Default Electrum endpoint, used when --host is not given.
    pub const fn default_host(&self) -> &'static str {
        match self {
            Network::Mainnet => "bch.imaginary.cash",
            Network::Testnet3 => "testnet.imaginary.cash",
            // No imaginary.cash instance serves testnet4; this is the host
            // Electron Cash ships in `servers_testnet4.json`.
            Network::Testnet4 => "tbch4.loping.net",
            Network::Chipnet => "chipnet.imaginary.cash",
            // Loopback on purpose: a regtest build is one we started.
            Network::Regtest => "127.0.0.1",
        }
    }

    /// Default Electrum TLS port for `default_host`.
    ///
    /// Per network because the hosts disagree: the imaginary.cash instances
    /// answer on the conventional 50002 whatever the chain, while testnet4's
    /// server uses the port Electron Cash lists for it.
    pub const fn default_port(&self) -> u16 {
        match self {
            Network::Mainnet | Network::Testnet3 | Network::Chipnet | Network::Regtest => 50002,
            Network::Testnet4 => 62002,
        }
    }

    /// Default BIP44/SLIP-44 coin type used by this wallet.
    pub const fn default_coin_type(&self) -> u32 {
        match self {
            Network::Mainnet => 145,
            // Every test chain shares testnet's SLIP-44 coin type.
            Network::Testnet3 | Network::Testnet4 | Network::Chipnet | Network::Regtest => 1,
        }
    }

    /// Whether this chain carries value anyone would miss.
    pub const fn is_testnet(&self) -> bool {
        !matches!(self, Network::Mainnet)
    }

    /// The canonical spelling, and the only one ever written to storage or a
    /// wire message. Parsing accepts more; writing never does.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Network::Mainnet => "mainnet",
            Network::Testnet3 => "testnet3",
            Network::Testnet4 => "testnet4",
            Network::Chipnet => "chipnet",
            Network::Regtest => "regtest",
        }
    }
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl FromStr for Network {
    type Err = String;

    /// Explicit in both directions. An unrecognised or ambiguous name is an
    /// error, never a default: a wallet that quietly lands on the wrong chain
    /// shows empty balances that look exactly like an unused address, and on
    /// mainnet it would be spending real coins under testnet assumptions.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mainnet" | "main" | "bitcoincash" => Ok(Network::Mainnet),
            "testnet3" | "testnet" => Ok(Network::Testnet3),
            "testnet4" => Ok(Network::Testnet4),
            "chipnet" | "chip" => Ok(Network::Chipnet),
            "regtest" | "bchreg" => Ok(Network::Regtest),
            // Shared by three chains, so it names none of them.
            "bchtest" => Err("'bchtest' is the address prefix of testnet3, testnet4 and \
                              chipnet, not a network name — pass one of those instead"
                .to_string()),
            other => Err(format!(
                "unknown network '{other}' (expected 'mainnet', 'testnet3', 'testnet4', \
                 'chipnet' or 'regtest')"
            )),
        }
    }
}

#[cfg(test)]
mod network_identity {
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

        assert_eq!("regtest".parse::<Network>().unwrap(), Network::Regtest);
        assert_eq!("bchreg".parse::<Network>().unwrap(), Network::Regtest);
        assert!("bogus".parse::<Network>().is_err());
    }

    /// The production networks keep exactly the values they had.
    #[test]
    fn adding_networks_did_not_move_mainnet_or_chipnet() {
        assert_eq!(Network::Mainnet.prefix(), "bitcoincash");
        assert_eq!(Network::Chipnet.prefix(), "bchtest");
        assert_eq!(Network::Mainnet.default_coin_type(), 145);
        assert_eq!(Network::Chipnet.default_coin_type(), 1);
        assert_eq!(Network::Mainnet.to_string(), "mainnet");
        assert_eq!(Network::Chipnet.to_string(), "chipnet");
        assert_eq!(Network::Mainnet.default_host(), "bch.imaginary.cash");
        assert_eq!(Network::Chipnet.default_host(), "chipnet.imaginary.cash");
        assert_eq!(Network::Mainnet.default_port(), 50002);
        assert_eq!(Network::Chipnet.default_port(), 50002);
    }

    /// The testnets that used to be chipnet aliases now resolve to themselves.
    ///
    /// This is the point of the change: `--network testnet4` previously opened
    /// a chipnet wallet, so the two chains were unreachable as separate things
    /// no matter what the chain layer underneath already supported.
    #[test]
    fn the_testnets_no_longer_collapse_into_chipnet() {
        assert_eq!("testnet4".parse::<Network>().unwrap(), Network::Testnet4);
        assert_eq!("testnet3".parse::<Network>().unwrap(), Network::Testnet3);
        assert_eq!("testnet".parse::<Network>().unwrap(), Network::Testnet3);
        assert_eq!("chipnet".parse::<Network>().unwrap(), Network::Chipnet);
        assert_eq!("chip".parse::<Network>().unwrap(), Network::Chipnet);

        for network in [Network::Testnet3, Network::Testnet4] {
            assert_ne!(network, Network::Chipnet);
        }
    }

    /// A prefix three chains share cannot select one of them.
    #[test]
    fn the_shared_testnet_prefix_is_not_a_network_name() {
        let error = "bchtest".parse::<Network>().unwrap_err();
        assert!(error.contains("testnet3"), "{error}");
        assert!(error.contains("chipnet"), "{error}");

        let sharing: Vec<Network> = Network::ALL
            .into_iter()
            .filter(|network| network.prefix() == "bchtest")
            .collect();
        assert_eq!(
            sharing,
            vec![Network::Testnet3, Network::Testnet4, Network::Chipnet]
        );
    }

    /// Every name we write can be read back as the same network, so a stored
    /// or transported network label survives a round trip unchanged.
    #[test]
    fn every_canonical_name_round_trips() {
        for network in Network::ALL {
            assert_eq!(
                network.as_str().parse::<Network>().unwrap(),
                network,
                "{network} did not round trip"
            );
            assert_eq!(network.to_string(), network.as_str());
        }
    }

    /// Distinct canonical names, so no two networks can share a stored label.
    #[test]
    fn no_two_networks_share_a_name() {
        let mut names: Vec<&str> = Network::ALL.iter().map(|n| n.as_str()).collect();
        names.sort_unstable();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total, "two networks share a canonical name");
    }

    /// Only mainnet holds real value; everything else must be able to say so.
    #[test]
    fn only_mainnet_is_not_a_testnet() {
        assert!(!Network::Mainnet.is_testnet());
        for network in Network::ALL.into_iter().filter(|n| *n != Network::Mainnet) {
            assert!(network.is_testnet(), "{network} should be a testnet");
        }
    }
}
