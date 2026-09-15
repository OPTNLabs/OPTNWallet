//! Where the wallet gets chain data, and what each place can answer.
//!
//! Two protocols, and they are not alternatives to choose between once. A
//! Fulcrum server answers over Electrum; a full node with `NODE_BLOOM` answers
//! over Bitcoin's own p2p protocol with a BIP37 filter. A user may enter
//! either, the bootstrap list may hold a mix, and the wallet speaks whatever
//! the thing it reached happens to speak.
//!
//! That is the whole design: **the list is mixed and failover walks it.** Enter
//! `myfulcrum.example:50002` and it is queried over Electrum. Enter your own
//! node on `:8333` and it is queried with a bloom filter. Enter both and
//! whichever answers first is used.
//!
//! One rule makes that safe rather than merely flexible. **Failover must not
//! fall through to a source that cannot answer the question being asked.** The
//! two protocols do not have the same reach: a node with a bloom filter can
//! hand over blocks and take a broadcast, but it holds no address index, so
//! there is nothing there to answer a reusable-payment scan with. Falling from
//! a Fulcrum server to a node for *that* question would not be degraded
//! service, it would be a wrong answer -- an empty result that reads exactly
//! like "you have no payments".
//!
//! A second thing worth saying out loud, because a user choosing between them
//! deserves to know: a BIP37 filter is matched by the node serving it, so the
//! node learns roughly which addresses are being asked about. The filter's
//! false-positive rate blurs that but does not remove it. Fulcrum is worse in
//! the same direction -- it is told every address outright -- which is why the
//! endpoint parser refuses plaintext to a remote Fulcrum. Neither is private
//! against the server; they are differently indiscreet.

use std::fmt;

use crate::endpoint::{is_loopback_host, FULCRUM_HINT_PORT, NODE_HINT_PORT};
use crate::error::{CliError, Result};

/// Which protocol a source speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Protocol {
    /// Fulcrum, or anything else speaking the Electrum protocol.
    Fulcrum,
    /// A full node's p2p listener, queried with a BIP37 bloom filter.
    Bip37Node,
}

impl Protocol {
    pub const ALL: &'static [Self] = &[Self::Fulcrum, Self::Bip37Node];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Fulcrum => "Fulcrum",
            Self::Bip37Node => "BIP37 node",
        }
    }

    /// The port the wallet's hint text names for this protocol.
    pub const fn hint_port(self) -> u16 {
        match self {
            Self::Fulcrum => FULCRUM_HINT_PORT,
            Self::Bip37Node => NODE_HINT_PORT,
        }
    }

    /// Whether this protocol can answer a question at all.
    ///
    /// Not about whether a particular server is up — about whether the
    /// protocol has the shape to answer. A node serving bloom filters holds no
    /// address index, so some questions have no answer there however healthy it
    /// is.
    pub const fn can_answer(self, query: ChainQuery) -> bool {
        match (self, query) {
            // Fulcrum indexes addresses, so it answers everything.
            (Self::Fulcrum, _) => true,
            // A node takes a transaction and reports the tip regardless.
            (Self::Bip37Node, ChainQuery::Broadcast | ChainQuery::HeaderTip) => true,
            // With a filter loaded it returns matching transactions, from which
            // history and the unspent set are rebuilt locally.
            (
                Self::Bip37Node,
                ChainQuery::AddressHistory | ChainQuery::Utxos | ChainQuery::TransactionByTxid,
            ) => true,
            // Reusable payment addresses need an index over every input's
            // pubkey, which a node does not keep and a bloom filter cannot
            // stand in for.
            (Self::Bip37Node, ChainQuery::ReusableScan) => false,
        }
    }

    /// Whether the serving side learns the addresses being asked about.
    ///
    /// True for both, and the honest answer to "which is private". They differ
    /// in degree, not in kind.
    pub const fn discloses_addresses(self) -> bool {
        true
    }
}

/// Something the wallet needs from the chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ChainQuery {
    /// Everything that has touched an address.
    AddressHistory,
    /// The current unspent set for an address.
    Utxos,
    /// One transaction, by id.
    TransactionByTxid,
    /// The chain tip.
    HeaderTip,
    /// Send a signed transaction.
    Broadcast,
    /// Find reusable-payment-address payments. Fulcrum only.
    ReusableScan,
}

impl ChainQuery {
    pub const ALL: &'static [Self] = &[
        Self::AddressHistory,
        Self::Utxos,
        Self::TransactionByTxid,
        Self::HeaderTip,
        Self::Broadcast,
        Self::ReusableScan,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::AddressHistory => "address history",
            Self::Utxos => "the unspent set",
            Self::TransactionByTxid => "a transaction",
            Self::HeaderTip => "the chain tip",
            Self::Broadcast => "a broadcast",
            Self::ReusableScan => "a Cash Code scan",
        }
    }
}

/// One place the wallet can get chain data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainSource {
    pub protocol: Protocol,
    host: String,
    port: u16,
    /// Fulcrum only. A node's p2p protocol has no TLS to speak of here.
    encrypted: bool,
}

impl ChainSource {
    /// A source the caller has already decided the protocol for.
    pub fn new(protocol: Protocol, host: &str, port: u16, encrypted: bool) -> Result<Self> {
        let host = host.trim();
        if host.is_empty() {
            return Err(CliError::Usage("a server needs a host".into()));
        }
        if port == 0 {
            return Err(CliError::Usage("port 0 is not a port".into()));
        }
        // The same rule the Electrum parser enforces, restated where a mixed
        // list is built: plaintext Electrum to a remote host hands over every
        // address the wallet owns.
        if protocol == Protocol::Fulcrum && !encrypted && !is_loopback_host(host) {
            return Err(CliError::Usage(format!(
                "'{host}' is remote, so it must be reached over TLS: Electrum is told every \
                 address in the wallet, and in plaintext so is anyone on the path"
            )));
        }
        Ok(Self {
            protocol,
            host: host.to_string(),
            port,
            encrypted,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub const fn port(&self) -> u16 {
        self.port
    }

    pub const fn encrypted(&self) -> bool {
        self.encrypted
    }

    pub const fn can_answer(&self, query: ChainQuery) -> bool {
        self.protocol.can_answer(query)
    }
}

impl fmt::Display for ChainSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{} ({})", self.host, self.port, self.protocol.label())
    }
}

/// Work out which protocol an entry is for.
///
/// The port is the signal, because that is what the wallet's own hint text
/// tells people to type: "Fulcrum host:50002, or a node host:8333". A caller
/// that already knows should say so rather than rely on this.
pub fn infer_protocol(port: u16) -> Option<Protocol> {
    match port {
        // Fulcrum's advertised port, plus the ws/wss pair the React client used.
        50001..=50004 => Some(Protocol::Fulcrum),
        // Mainnet, testnet, regtest, chipnet p2p listeners.
        8333 | 18333 | 18444 | 48333 => Some(Protocol::Bip37Node),
        _ => None,
    }
}

/// Parse `host:port`, deciding the protocol from the port when it can.
///
/// Returns the entry *and* whether the protocol was inferred, because a screen
/// that guessed should say so and offer the choice rather than silently commit
/// the user to a protocol.
pub fn parse_source(entry: &str) -> Result<(ChainSource, bool)> {
    let entry = entry.trim();
    let (host, port_text) = entry.rsplit_once(':').ok_or_else(|| {
        CliError::Usage(format!(
            "'{entry}' needs a port: Fulcrum on :{}, or a node on :{}",
            FULCRUM_HINT_PORT, NODE_HINT_PORT
        ))
    })?;
    let port: u16 = port_text
        .trim()
        .parse()
        .map_err(|_| CliError::Usage(format!("'{port_text}' is not a port number")))?;

    let protocol = infer_protocol(port).ok_or_else(|| {
        CliError::Usage(format!(
            "nothing is known about port {port}. Fulcrum usually listens on \
             {FULCRUM_HINT_PORT} and a node on {NODE_HINT_PORT}; choose which this is."
        ))
    })?;
    // A Fulcrum entry typed without a scheme is assumed encrypted, which is the
    // safe direction to be wrong in.
    let encrypted = protocol == Protocol::Fulcrum;
    Ok((ChainSource::new(protocol, host, port, encrypted)?, true))
}

/// The wallet's bootstrap list, which may hold both protocols at once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceList {
    sources: Vec<ChainSource>,
    /// Indices that have failed this session, in the order they failed.
    failed: Vec<usize>,
}

impl SourceList {
    pub const fn new() -> Self {
        Self {
            sources: Vec::new(),
            failed: Vec::new(),
        }
    }

    /// Add a source. Duplicates are ignored rather than refused: a bootstrap
    /// list and a user's own entry naming the same server is ordinary.
    pub fn add(&mut self, source: ChainSource) {
        if !self.sources.contains(&source) {
            self.sources.push(source);
        }
    }

    pub fn len(&self) -> usize {
        self.sources.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &ChainSource> {
        self.sources.iter()
    }

    /// How many of each protocol the list holds.
    pub fn count(&self, protocol: Protocol) -> usize {
        self.sources
            .iter()
            .filter(|source| source.protocol == protocol)
            .count()
    }

    /// Mark a source as having failed, so failover moves past it.
    pub fn mark_failed(&mut self, source: &ChainSource) {
        if let Some(index) = self.sources.iter().position(|known| known == source) {
            if !self.failed.contains(&index) {
                self.failed.push(index);
            }
        }
    }

    /// Forget every failure, for a caller starting again.
    pub fn clear_failures(&mut self) {
        self.failed.clear();
    }

    /// The next source to try for this question.
    ///
    /// Skips what has already failed, and skips anything whose protocol cannot
    /// answer — which is the point. Falling from Fulcrum to a node for a
    /// reusable scan would return nothing and look exactly like a wallet with
    /// no payments.
    pub fn next_for(&self, query: ChainQuery) -> Option<&ChainSource> {
        self.sources
            .iter()
            .enumerate()
            .find(|(index, source)| !self.failed.contains(index) && source.can_answer(query))
            .map(|(_, source)| source)
    }

    /// Why there is nothing left to try, for a caller that got `None`.
    ///
    /// Distinguishes "they are all down" from "none of them could ever have
    /// answered this", because those need different things from the user.
    pub fn why_exhausted(&self, query: ChainQuery) -> String {
        let capable = self
            .sources
            .iter()
            .filter(|source| source.can_answer(query))
            .count();
        if self.sources.is_empty() {
            return "no servers are configured".to_string();
        }
        if capable == 0 {
            return format!(
                "none of the {} configured servers can answer {}: it needs {}, and this list \
                 holds only {}",
                self.sources.len(),
                query.label(),
                Protocol::Fulcrum.label(),
                Protocol::Bip37Node.label()
            );
        }
        format!(
            "all {capable} servers that could answer {} have failed this session",
            query.label()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fulcrum(host: &str) -> ChainSource {
        ChainSource::new(Protocol::Fulcrum, host, 50002, true).expect("a Fulcrum source")
    }

    fn node(host: &str) -> ChainSource {
        ChainSource::new(Protocol::Bip37Node, host, 8333, false).expect("a node source")
    }

    #[test]
    fn one_list_holds_both_protocols_at_once() {
        // The design in a sentence: not a choice made once, but a mixed list
        // the wallet walks, speaking whatever it reaches.
        let mut list = SourceList::new();
        list.add(fulcrum("fulcrum.example"));
        list.add(node("mynode.example"));
        list.add(fulcrum("another.example"));

        assert_eq!(list.len(), 3);
        assert_eq!(list.count(Protocol::Fulcrum), 2);
        assert_eq!(list.count(Protocol::Bip37Node), 1);

        // Adding the same server twice is ordinary -- a bootstrap entry and a
        // user's own -- and changes nothing.
        list.add(fulcrum("fulcrum.example"));
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn failover_walks_the_list_across_protocols() {
        let mut list = SourceList::new();
        list.add(fulcrum("first.example"));
        list.add(node("mynode.example"));

        let first = list.next_for(ChainQuery::Utxos).expect("something").clone();
        assert_eq!(first.host(), "first.example");

        // When it fails, the node takes over -- a different protocol answering
        // the same question.
        list.mark_failed(&first);
        let second = list.next_for(ChainQuery::Utxos).expect("failover");
        assert_eq!(second.host(), "mynode.example");
        assert_eq!(second.protocol, Protocol::Bip37Node);

        // And starting again forgets the failures.
        list.clear_failures();
        assert_eq!(
            list.next_for(ChainQuery::Utxos).expect("back").host(),
            "first.example"
        );
    }

    #[test]
    fn failover_never_lands_on_a_source_that_cannot_answer() {
        // The rule that makes a mixed list safe rather than merely flexible. A
        // node holds no index over input pubkeys, so a Cash Code scan there
        // returns nothing -- which reads exactly like a wallet with no
        // payments, and is the worst possible way for this to fail.
        let mut list = SourceList::new();
        list.add(fulcrum("fulcrum.example"));
        list.add(node("mynode.example"));

        let scan = list
            .next_for(ChainQuery::ReusableScan)
            .expect("Fulcrum can");
        assert_eq!(scan.protocol, Protocol::Fulcrum);

        list.mark_failed(&fulcrum("fulcrum.example"));
        assert_eq!(
            list.next_for(ChainQuery::ReusableScan),
            None,
            "the node must not be offered as a fallback for a scan"
        );

        // But the node is still perfectly good for everything else.
        assert!(list.next_for(ChainQuery::Broadcast).is_some());
        assert!(list.next_for(ChainQuery::Utxos).is_some());
    }

    #[test]
    fn an_exhausted_list_says_which_kind_of_exhausted() {
        // "They are all down" and "none of these could ever answer this" need
        // different things from the user: wait, or add a Fulcrum server.
        let mut only_nodes = SourceList::new();
        only_nodes.add(node("mynode.example"));
        let reason = only_nodes.why_exhausted(ChainQuery::ReusableScan);
        assert!(reason.contains("can answer"), "{reason}");
        assert!(reason.contains("Fulcrum"), "{reason}");

        let mut all_down = SourceList::new();
        all_down.add(fulcrum("fulcrum.example"));
        all_down.mark_failed(&fulcrum("fulcrum.example"));
        let reason = all_down.why_exhausted(ChainQuery::Utxos);
        assert!(reason.contains("have failed"), "{reason}");

        assert!(SourceList::new()
            .why_exhausted(ChainQuery::Utxos)
            .contains("no servers"));
    }

    #[test]
    fn what_each_protocol_can_answer_is_stated_rather_than_assumed() {
        // Fulcrum indexes addresses, so it answers everything asked of it.
        for query in ChainQuery::ALL {
            assert!(Protocol::Fulcrum.can_answer(*query), "{query:?}");
        }

        // A node takes a broadcast and reports the tip whatever else is true,
        // and with a filter loaded returns matching transactions.
        for query in [
            ChainQuery::Broadcast,
            ChainQuery::HeaderTip,
            ChainQuery::AddressHistory,
            ChainQuery::Utxos,
            ChainQuery::TransactionByTxid,
        ] {
            assert!(Protocol::Bip37Node.can_answer(query), "{query:?}");
        }
        assert!(!Protocol::Bip37Node.can_answer(ChainQuery::ReusableScan));

        // Neither is private against the server. They are differently
        // indiscreet, and a screen offering the choice should not imply
        // otherwise.
        for protocol in Protocol::ALL {
            assert!(protocol.discloses_addresses(), "{protocol:?}");
        }
    }

    #[test]
    fn the_port_says_which_protocol_an_entry_is_for() {
        // What the wallet's own hint text tells people to type.
        let (source, inferred) = parse_source("fulcrum.example:50002").expect("parses");
        assert_eq!(source.protocol, Protocol::Fulcrum);
        assert!(source.encrypted(), "a bare Fulcrum entry is assumed TLS");
        assert!(inferred, "a screen that guessed should say so");

        let (source, _) = parse_source("mynode.example:8333").expect("parses");
        assert_eq!(source.protocol, Protocol::Bip37Node);

        // Testnet, regtest and chipnet listeners are nodes too.
        for port in [18333, 18444, 48333] {
            let (source, _) = parse_source(&format!("mynode.example:{port}")).expect("parses");
            assert_eq!(source.protocol, Protocol::Bip37Node, "port {port}");
        }

        // An unknown port is a question, not a guess.
        let error = parse_source("mynode.example:9999").expect_err("unknown port");
        assert!(
            error.to_string().contains("choose which this is"),
            "{error}"
        );
        assert!(parse_source("mynode.example").is_err(), "no port at all");
    }

    #[test]
    fn plaintext_fulcrum_to_a_remote_host_is_still_refused_here() {
        // The rule the endpoint parser already enforces, restated where a mixed
        // list is assembled -- because this is a second door into the same
        // mistake.
        let error = ChainSource::new(Protocol::Fulcrum, "fulcrum.example", 50003, false)
            .expect_err("remote plaintext");
        assert!(error.to_string().contains("every address"), "{error}");

        // Locally it is fine, and is how people run their own.
        assert!(ChainSource::new(Protocol::Fulcrum, "127.0.0.1", 50003, false).is_ok());
        // A node has no TLS here, so plaintext is simply what it is.
        assert!(ChainSource::new(Protocol::Bip37Node, "mynode.example", 8333, false).is_ok());
    }
}
