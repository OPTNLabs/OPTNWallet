//! Whether a fusion connection may be made, and over what.
//!
//! CashFusion's privacy rests on the coordinator and the other participants not
//! learning which coins are whose. A connection made in the clear tells the
//! other end an IP address, and that is enough to undo the round for the peer
//! who made it — so remote fusion traffic goes through Tor or it does not go.
//!
//! The rule the desktop implementation settled on, and this is the whole of it:
//!
//! - **A loopback destination is direct.** A fusion server on `127.0.0.1` is
//!   the developer's own, there is no network hop to observe, and routing it
//!   through Tor would only break it.
//! - **Anything else needs Tor, and Tor that answered.** A SOCKS port being
//!   open is not evidence it is Tor; something else may be listening, or a
//!   proxy that quietly forwards in the clear. The port must have been probed
//!   and have answered as Tor.
//! - **No Tor, no connection.** Not a warning, not a fallback to direct: the
//!   attempt is refused. A privacy control with a fallback is a privacy
//!   control that does nothing the first time it matters.
//!
//! This applies to every remote leg of a round, not only the obvious one. The
//! server, the pool announcement, the peer-input lookup, the Electrum queries
//! made to check another participant's inputs, and any covert endpoint the
//! server hands out are all reachable addresses that would otherwise carry the
//! participant's IP.
//!
//! There is no I/O here. Probing a port is the runtime's job; this decides what
//! its answer means.

use crate::endpoint::is_loopback_host;

/// Where a system Tor daemon listens by default.
pub const TOR_DAEMON_SOCKS_PORT: u16 = 9050;
/// Where Tor Browser's bundled Tor listens by default.
pub const TOR_BROWSER_SOCKS_PORT: u16 = 9150;

/// The ports auto-detection tries, in order.
pub const AUTODETECT_SOCKS_PORTS: &[u16] = &[TOR_DAEMON_SOCKS_PORT, TOR_BROWSER_SOCKS_PORT];

/// What the runtime found when it went looking for Tor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TorStatus {
    /// A SOCKS proxy answered, and answered *as Tor*.
    Verified { socks_port: u16 },
    /// Something is listening on the port, but it has not been shown to be
    /// Tor.
    ///
    /// Deliberately not usable. An open port is not evidence: another service
    /// may hold it, or a proxy that forwards in the clear, and connecting
    /// through it would leak exactly what Tor was there to hide while looking
    /// like it had not.
    Unverified { socks_port: u16 },
    /// Nothing found.
    Absent,
}

impl TorStatus {
    /// The port to connect through, if there is one that may be used.
    pub const fn usable_port(self) -> Option<u16> {
        match self {
            Self::Verified { socks_port } => Some(socks_port),
            Self::Unverified { .. } | Self::Absent => None,
        }
    }
}

/// Which leg of a round a connection is for.
///
/// Every one of these is remote-capable and would carry the participant's
/// address, which is why the list is enumerated rather than left to a caller to
/// remember.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum FusionLeg {
    /// The fusion server itself.
    Server,
    /// Announcing to, or reading, the pool.
    Pool,
    /// Looking up another participant's inputs.
    PeerInputLookup,
    /// Electrum queries made during a round.
    ElectrumLookup,
    /// A covert endpoint the server handed out.
    CovertEndpoint,
}

impl FusionLeg {
    pub const ALL: &'static [Self] = &[
        Self::Server,
        Self::Pool,
        Self::PeerInputLookup,
        Self::ElectrumLookup,
        Self::CovertEndpoint,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Server => "the fusion server",
            Self::Pool => "the pool announcement",
            Self::PeerInputLookup => "a peer's input lookup",
            Self::ElectrumLookup => "an Electrum lookup",
            Self::CovertEndpoint => "a covert endpoint",
        }
    }
}

/// Why a connection was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No Tor was found at all.
    NoTor,
    /// A proxy is there, but nothing has shown it to be Tor.
    TorNotVerified { socks_port: u16 },
}

impl Refusal {
    pub fn message(self, leg: FusionLeg) -> String {
        match self {
            Self::NoTor => format!(
                "{} needs Tor, and none was found. Start the built-in Tor, or Tor Browser \
                 ({TOR_BROWSER_SOCKS_PORT}) or a system Tor daemon ({TOR_DAEMON_SOCKS_PORT}), \
                 then check it. Remote CashFusion is blocked without it.",
                leg.label()
            ),
            Self::TorNotVerified { socks_port } => format!(
                "{} needs Tor. Something is listening on port {socks_port}, but it has not \
                 answered as Tor, and connecting through an unverified proxy would leak the \
                 address Tor is there to hide.",
                leg.label()
            ),
        }
    }
}

/// What to do about one connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Connect straight there. Only ever a loopback destination.
    Direct,
    /// Connect through the SOCKS proxy on this port.
    Through { socks_port: u16 },
    /// Do not connect.
    Refused(Refusal),
}

impl Route {
    pub const fn is_refused(self) -> bool {
        matches!(self, Self::Refused(_))
    }

    /// The refusal to show, if there is one.
    pub fn refusal(self, leg: FusionLeg) -> Option<String> {
        match self {
            Self::Refused(refusal) => Some(refusal.message(leg)),
            Self::Direct | Self::Through { .. } => None,
        }
    }
}

/// Decide how a fusion connection is made, or that it is not.
///
/// Fails closed: every path that is not loopback and not verified Tor ends in a
/// refusal. There is deliberately no argument that relaxes this — a flag to
/// "allow direct just this once" is the flag that turns up set in a release.
pub fn route(host: &str, tor: TorStatus) -> Route {
    if is_loopback_host(host) {
        return Route::Direct;
    }
    match tor {
        TorStatus::Verified { socks_port } => Route::Through { socks_port },
        TorStatus::Unverified { socks_port } => {
            Route::Refused(Refusal::TorNotVerified { socks_port })
        }
        TorStatus::Absent => Route::Refused(Refusal::NoTor),
    }
}

/// Whether a whole round may start.
///
/// A round touches every leg, so it is only safe to begin if each of its
/// destinations can be reached. Checking up front means a participant is not
/// dropped halfway through for a reason that was knowable before it committed
/// its coins.
pub fn round_can_start(destinations: &[(FusionLeg, &str)], tor: TorStatus) -> Result<(), String> {
    for (leg, host) in destinations {
        if let Some(refusal) = route(host, tor).refusal(*leg) {
            return Err(refusal);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_server_is_direct_and_needs_no_tor_at_all() {
        // A fusion server on loopback is the developer's own. There is no
        // network hop to observe, and routing it through Tor would only break
        // it.
        for host in ["127.0.0.1", "localhost", "::1", "127.13.9.2"] {
            assert_eq!(route(host, TorStatus::Absent), Route::Direct, "{host}");
            assert_eq!(
                route(host, TorStatus::Verified { socks_port: 9050 }),
                Route::Direct,
                "{host} stays direct even when Tor is available"
            );
        }
    }

    #[test]
    fn a_remote_leg_without_tor_is_refused_rather_than_made_in_the_clear() {
        // The rule the whole module exists for. A privacy control with a
        // fallback is a privacy control that does nothing the first time it
        // matters.
        let refused = route("fusion.example.org", TorStatus::Absent);
        assert_eq!(refused, Route::Refused(Refusal::NoTor));
        assert!(refused.is_refused());

        let message = refused.refusal(FusionLeg::Server).expect("a reason");
        assert!(message.contains("9050"), "{message}");
        assert!(message.contains("9150"), "{message}");
        assert!(message.contains("blocked without it"), "{message}");
    }

    #[test]
    fn an_open_port_is_not_evidence_that_it_is_tor() {
        // The distinction that makes this fail closed rather than merely look
        // like it. Something else may hold the port, or a proxy that forwards
        // in the clear -- and connecting through it would leak exactly what Tor
        // was there to hide, while looking like it had not.
        let unverified = TorStatus::Unverified { socks_port: 9050 };
        assert_eq!(unverified.usable_port(), None);

        let refused = route("fusion.example.org", unverified);
        assert_eq!(
            refused,
            Route::Refused(Refusal::TorNotVerified { socks_port: 9050 })
        );
        let message = refused.refusal(FusionLeg::Pool).expect("a reason");
        assert!(message.contains("has not answered as Tor"), "{message}");

        // Verified, and the same port is used.
        let verified = TorStatus::Verified { socks_port: 9050 };
        assert_eq!(verified.usable_port(), Some(9050));
        assert_eq!(
            route("fusion.example.org", verified),
            Route::Through { socks_port: 9050 }
        );
    }

    #[test]
    fn every_remote_leg_of_a_round_is_covered_not_just_the_server() {
        // The server is the obvious one. The pool, a peer's input lookup, the
        // Electrum queries made to check those inputs and any covert endpoint
        // the server hands out are all reachable addresses that would carry the
        // participant's own.
        assert_eq!(FusionLeg::ALL.len(), 5);
        for leg in FusionLeg::ALL {
            let refused = route("somewhere.example.org", TorStatus::Absent);
            let message = refused.refusal(*leg).expect("every leg refuses");
            assert!(message.contains(leg.label()), "{message}");
        }
    }

    #[test]
    fn a_round_is_stopped_before_it_starts_rather_than_halfway_through() {
        // A participant dropped mid-round for a reason knowable up front has
        // already committed its coins to a fusion that cannot finish.
        let destinations = [
            (FusionLeg::Server, "127.0.0.1"),
            (FusionLeg::Pool, "relay.example.org"),
            (FusionLeg::ElectrumLookup, "electrum.example.org"),
        ];

        let blocked = round_can_start(&destinations, TorStatus::Absent).expect_err("no Tor");
        assert!(blocked.contains("the pool announcement"), "{blocked}");

        round_can_start(&destinations, TorStatus::Verified { socks_port: 9150 })
            .expect("with Tor, every leg is reachable");

        // An entirely local round needs no Tor.
        let local = [
            (FusionLeg::Server, "127.0.0.1"),
            (FusionLeg::ElectrumLookup, "localhost"),
        ];
        round_can_start(&local, TorStatus::Absent).expect("nothing leaves the machine");
    }

    #[test]
    fn autodetect_looks_where_tor_actually_listens() {
        assert_eq!(
            AUTODETECT_SOCKS_PORTS,
            &[TOR_DAEMON_SOCKS_PORT, TOR_BROWSER_SOCKS_PORT]
        );
        assert_eq!(TOR_DAEMON_SOCKS_PORT, 9050);
        assert_eq!(TOR_BROWSER_SOCKS_PORT, 9150);
    }

    #[test]
    fn a_host_that_merely_looks_local_is_still_remote() {
        // The same trap the Electrum endpoint parser guards: a name ending in
        // "localhost" is not loopback, and treating it as one would send a
        // fusion connection out in the clear.
        for host in [
            "localhost.evil.example",
            "notlocalhost",
            "127.0.0.1.evil.example",
        ] {
            assert_eq!(
                route(host, TorStatus::Absent),
                Route::Refused(Refusal::NoTor),
                "{host} is not loopback"
            );
        }
    }
}
