#![forbid(unsafe_code)]

//! Nostr relays for OPTN, over the holder's verified Tor proxy or the host's
//! own egress.
//!
//! One crate for every Rust surface that speaks Nostr -- P2P CashFusion
//! coordination and chat, on the desktop host, the CLI and the docker runner --
//! so a relay is reached the same way everywhere:
//!
//! - [`Relays`]: a set of relays reached through [`RelayRoute`], publishing
//!   with at-least-once acceptance and streaming subscribed events, to the
//!   whole set or to the relays one group or one peer reads.
//! - [`nip17`]: NIP-17 private messages (a kind-14 rumor, sealed and
//!   gift-wrapped per NIP-59), the envelope the TypeScript peers' nostr-tools
//!   `wrapEvent` / `unwrapEvent` produce and read, so Rust and TypeScript peers
//!   exchange the same bytes.
//! - [`nip59`]: gift wraps for any rumor, such as a Marmot welcome.
//! - [`dialer`]: relays reached through a dialer the host supplies.
//!
//! Built on rust-nostr (`nostr`, `nostr-sdk` 0.45).

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::{Stream, StreamExt};
use nostr::prelude::{Event, Filter, RelayUrl, SubscriptionId};
use nostr_sdk::prelude::{Client, ClientNotification, Proxy};

pub mod dialer;
pub mod nip17;
pub mod nip59;

pub use dialer::{Dialed, RelayDialer, RelayEndpoint, RelayIo};
pub use nostr;

/// How relays are reached.
#[derive(Clone)]
pub enum RelayRoute {
    /// Remote relays through this SOCKS5 proxy: the holder's Tor, which the
    /// caller has verified the way every other remote leg is verified. Relays
    /// on this machine are reached directly.
    Tor(SocketAddr),
    /// Relays on this machine only (tests, a relay the holder runs locally).
    /// A remote relay is refused rather than reached directly.
    LocalOnly,
    /// Every relay through the host's dialer (see [`dialer`]), which applies
    /// the holder's egress rules, Tor switch included, and may refuse.
    Dialer(Arc<dyn RelayDialer>),
}

impl std::fmt::Debug for RelayRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayRoute::Tor(socks) => f.debug_tuple("Tor").field(socks).finish(),
            RelayRoute::LocalOnly => f.write_str("LocalOnly"),
            RelayRoute::Dialer(_) => f.write_str("Dialer"),
        }
    }
}

impl RelayRoute {
    fn admits(&self, relay: &RelayUrl) -> bool {
        !matches!(self, RelayRoute::LocalOnly) || relay.is_local_addr()
    }

    fn client(&self) -> Client {
        let builder = Client::builder();
        match self {
            RelayRoute::Tor(socks) => {
                let socks = *socks;
                builder
                    .proxy(Proxy::custom(move |url: &RelayUrl| {
                        (!url.is_local_addr()).then_some(socks)
                    }))
                    .build()
            }
            RelayRoute::LocalOnly => builder.build(),
            RelayRoute::Dialer(dialer) => builder
                .websocket_transport(dialer::DialerTransport(dialer.clone()))
                .build(),
        }
    }
}

/// Why a relay operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayError {
    /// No relay was given.
    NoRelays,
    /// A relay URL that is not `ws://` or `wss://`, or does not parse.
    InvalidRelay { url: String, reason: String },
    /// A remote relay under [`RelayRoute::LocalOnly`]: it would have been
    /// reached without Tor.
    RemoteWithoutTor { url: String },
    /// No relay accepted the connection within the timeout.
    NotConnected { failed: BTreeMap<String, String> },
    /// No relay accepted the event.
    NotAccepted { failed: BTreeMap<String, String> },
    /// The relay client refused the operation.
    Client(String),
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let failures = |failed: &BTreeMap<String, String>| {
            failed
                .iter()
                .map(|(url, reason)| format!("{url}: {reason}"))
                .collect::<Vec<_>>()
                .join("; ")
        };
        match self {
            RelayError::NoRelays => write!(f, "no Nostr relay is configured"),
            RelayError::InvalidRelay { url, reason } => {
                write!(f, "{url} is not a Nostr relay address: {reason}")
            }
            RelayError::RemoteWithoutTor { url } => write!(
                f,
                "{url} is a remote relay, and remote relays are reached only through Tor"
            ),
            RelayError::NotConnected { failed } => {
                write!(f, "no Nostr relay could be reached ({})", failures(failed))
            }
            RelayError::NotAccepted { failed } => {
                write!(
                    f,
                    "no Nostr relay accepted the event ({})",
                    failures(failed)
                )
            }
            RelayError::Client(reason) => write!(f, "Nostr relay client: {reason}"),
        }
    }
}

impl std::error::Error for RelayError {}

fn client_error(error: impl std::fmt::Display) -> RelayError {
    RelayError::Client(error.to_string())
}

fn failures<V: std::fmt::Display>(
    failed: impl IntoIterator<Item = (RelayUrl, V)>,
) -> BTreeMap<String, String> {
    failed
        .into_iter()
        .map(|(url, reason)| (url.to_string(), reason.to_string()))
        .collect()
}

/// Relays the event was published to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    /// Relays that accepted it.
    pub accepted: Vec<String>,
    /// Relays that refused it or did not answer, with why.
    pub failed: BTreeMap<String, String>,
}

/// A connected set of relays. More can be reached later with
/// [`Relays::add`]; the targeted calls reach theirs on demand.
#[derive(Debug, Clone)]
pub struct Relays {
    client: Client,
    route: RelayRoute,
}

impl Relays {
    /// Reach `urls` through `route`, waiting up to `timeout` for at least one
    /// to connect. Remote relays need [`RelayRoute::Tor`] or a dialer.
    pub async fn connect(
        urls: &[impl AsRef<str>],
        route: RelayRoute,
        timeout: Duration,
    ) -> Result<Self, RelayError> {
        let parsed = parse(urls, &route)?;
        let relays = Self {
            client: route.client(),
            route,
        };
        if let Err(error) = relays.reach(&parsed, timeout).await {
            relays.client.shutdown().await;
            return Err(error);
        }
        Ok(relays)
    }

    /// Reach `urls` as well, waiting up to `timeout` for them. Succeeds with
    /// the ones connected when at least one is.
    pub async fn add(
        &self,
        urls: &[impl AsRef<str>],
        timeout: Duration,
    ) -> Result<Vec<String>, RelayError> {
        let parsed = parse(urls, &self.route)?;
        let connected = self.reach(&parsed, timeout).await?;
        Ok(connected.iter().map(ToString::to_string).collect())
    }

    async fn reach(
        &self,
        relays: &[RelayUrl],
        timeout: Duration,
    ) -> Result<Vec<RelayUrl>, RelayError> {
        for relay in relays {
            self.client
                .add_relay(relay.clone())
                .await
                .map_err(client_error)?;
        }
        // A relay already connected answers at once.
        let attempts = relays.iter().map(|relay| async move {
            let outcome = self.client.try_connect_relay(relay, timeout).await;
            (relay.clone(), outcome)
        });
        let mut connected = Vec::new();
        let mut failed = BTreeMap::new();
        for (relay, outcome) in futures::future::join_all(attempts).await {
            match outcome {
                Ok(()) => connected.push(relay),
                Err(error) => {
                    failed.insert(relay.to_string(), error.to_string());
                }
            }
        }
        if connected.is_empty() {
            return Err(RelayError::NotConnected { failed });
        }
        Ok(connected)
    }

    /// The relays this set has been asked to reach.
    pub async fn urls(&self) -> Vec<String> {
        let mut urls: Vec<String> = self
            .client
            .relays()
            .await
            .into_keys()
            .map(|url| url.to_string())
            .collect();
        urls.sort();
        urls
    }

    /// Publish `event` to every relay in the set. Succeeds when at least one
    /// relay accepts it, which is what a peer needs to see it; the relays
    /// that did not are reported.
    pub async fn publish(&self, event: &Event) -> Result<Published, RelayError> {
        let output = self.client.send_event(event).await.map_err(client_error)?;
        published(output.success.into_keys(), failures(output.failed))
    }

    /// Publish `event` to `urls`, reaching them first if need be: the relays
    /// a group reads, or the ones a peer receives on.
    pub async fn publish_to(
        &self,
        urls: &[impl AsRef<str>],
        event: &Event,
        timeout: Duration,
    ) -> Result<Published, RelayError> {
        let reached = self.reach_some(urls, timeout).await?;
        let mut failed = reached.failed;
        let output = self
            .client
            .send_event(event)
            .to(reached.connected)
            .await
            .map_err(client_error)?;
        failed.extend(failures(output.failed));
        published(output.success.into_keys(), failed)
    }

    /// Events matching `filter` stored on `urls`, waiting up to `timeout`.
    /// Relays that cannot be reached are skipped while one can.
    pub async fn fetch(
        &self,
        urls: &[impl AsRef<str>],
        filter: Filter,
        timeout: Duration,
    ) -> Result<Vec<Event>, RelayError> {
        let reached = self.reach_some(urls, timeout).await?;
        let targets: Vec<(RelayUrl, Vec<Filter>)> = reached
            .connected
            .into_iter()
            .map(|relay| (relay, vec![filter.clone()]))
            .collect();
        let events = self
            .client
            .fetch_events(targets)
            .timeout(timeout)
            .await
            .map_err(client_error)?;
        Ok(events.into_iter().collect())
    }

    /// Ask the relays for events matching `filter`, stored and new. They
    /// arrive on [`Relays::events`] under the returned id.
    pub async fn subscribe(&self, filter: Filter) -> Result<SubscriptionId, RelayError> {
        let output = self.client.subscribe(filter).await.map_err(client_error)?;
        if output.success.is_empty() {
            return Err(RelayError::NotAccepted {
                failed: failures(output.failed),
            });
        }
        Ok(output.value)
    }

    /// [`Relays::subscribe`] on `urls`, reaching them first if need be.
    pub async fn subscribe_to(
        &self,
        urls: &[impl AsRef<str>],
        filter: Filter,
        timeout: Duration,
    ) -> Result<SubscriptionId, RelayError> {
        let reached = self.reach_some(urls, timeout).await?;
        let targets: Vec<(RelayUrl, Vec<Filter>)> = reached
            .connected
            .into_iter()
            .map(|relay| (relay, vec![filter.clone()]))
            .collect();
        let output = self.client.subscribe(targets).await.map_err(client_error)?;
        if output.success.is_empty() {
            return Err(RelayError::NotAccepted {
                failed: failures(output.failed),
            });
        }
        Ok(output.value)
    }

    async fn reach_some(
        &self,
        urls: &[impl AsRef<str>],
        timeout: Duration,
    ) -> Result<Reached, RelayError> {
        let parsed = parse(urls, &self.route)?;
        let connected = self.reach(&parsed, timeout).await?;
        let failed = parsed
            .iter()
            .filter(|relay| !connected.contains(relay))
            .map(|relay| (relay.to_string(), "not reached".to_owned()))
            .collect();
        Ok(Reached { connected, failed })
    }

    /// Stop a subscription. Relays that cannot be told keep it until they
    /// drop the connection, which [`Relays::shutdown`] does.
    pub async fn unsubscribe(&self, id: &SubscriptionId) -> Result<(), RelayError> {
        self.client
            .unsubscribe(id)
            .await
            .map(|_| ())
            .map_err(client_error)
    }

    /// Every subscribed event, once, as relays deliver it. Events this set
    /// published itself are not repeated back.
    pub fn events(&self) -> impl Stream<Item = (SubscriptionId, Event)> + Send + 'static {
        self.client
            .notifications()
            .filter_map(|notification| async move {
                match notification {
                    ClientNotification::Event {
                        subscription_id,
                        event,
                        ..
                    } => Some((subscription_id, *event)),
                    _ => None,
                }
            })
    }

    /// Close every connection.
    pub async fn shutdown(&self) {
        self.client.shutdown().await;
    }
}

struct Reached {
    connected: Vec<RelayUrl>,
    failed: BTreeMap<String, String>,
}

fn published(
    accepted: impl Iterator<Item = RelayUrl>,
    failed: BTreeMap<String, String>,
) -> Result<Published, RelayError> {
    let mut accepted: Vec<String> = accepted.map(|url| url.to_string()).collect();
    if accepted.is_empty() {
        return Err(RelayError::NotAccepted { failed });
    }
    accepted.sort();
    Ok(Published { accepted, failed })
}

fn parse(urls: &[impl AsRef<str>], route: &RelayRoute) -> Result<Vec<RelayUrl>, RelayError> {
    if urls.is_empty() {
        return Err(RelayError::NoRelays);
    }
    let mut parsed = Vec::with_capacity(urls.len());
    for url in urls {
        let text = url.as_ref();
        let relay = RelayUrl::parse(text).map_err(|error| RelayError::InvalidRelay {
            url: text.to_owned(),
            reason: error.to_string(),
        })?;
        if !route.admits(&relay) {
            return Err(RelayError::RemoteWithoutTor {
                url: text.to_owned(),
            });
        }
        if !parsed.contains(&relay) {
            parsed.push(relay);
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::prelude::{EventBuilder, FinalizeEvent, Keys, Kind};
    use nostr_sdk::prelude::LocalRelay;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn local_relay() -> (LocalRelay, String) {
        let relay = LocalRelay::new();
        relay.run().await.unwrap();
        let url = relay.url().await.to_string();
        (relay, url)
    }

    #[tokio::test]
    async fn remote_relays_need_tor() {
        assert_eq!(
            Relays::connect(
                &["wss://relay.example.org"],
                RelayRoute::LocalOnly,
                Duration::from_secs(1)
            )
            .await
            .err(),
            Some(RelayError::RemoteWithoutTor {
                url: "wss://relay.example.org".into()
            })
        );
        assert_eq!(
            Relays::connect(
                &[] as &[&str],
                RelayRoute::LocalOnly,
                Duration::from_secs(1)
            )
            .await
            .err(),
            Some(RelayError::NoRelays)
        );
        assert!(matches!(
            Relays::connect(
                &["https://relay.example.org"],
                RelayRoute::LocalOnly,
                Duration::from_secs(1)
            )
            .await,
            Err(RelayError::InvalidRelay { .. })
        ));
        // Under Tor, a relay on this machine is still reached directly and a
        // remote one through the proxy; under a dialer, every relay is the
        // dialer's to judge.
        let tor = RelayRoute::Tor("127.0.0.1:9050".parse().unwrap());
        let remote = RelayUrl::parse("wss://relay.example.org").unwrap();
        assert!(tor.admits(&remote));
        assert!(!RelayRoute::LocalOnly.admits(&remote));
    }

    #[tokio::test]
    async fn a_published_event_reaches_a_subscriber() {
        let (relay, url) = local_relay().await;
        let writer = Relays::connect(&[&url], RelayRoute::LocalOnly, Duration::from_secs(5))
            .await
            .unwrap();
        let reader = Relays::connect(&[&url], RelayRoute::LocalOnly, Duration::from_secs(5))
            .await
            .unwrap();
        let keys = Keys::generate();
        let id = reader
            .subscribe(Filter::new().kind(Kind::TextNote).author(keys.public_key()))
            .await
            .unwrap();
        let mut events = Box::pin(reader.events());

        let event = EventBuilder::new(Kind::TextNote, "fusion pool ping")
            .finalize(&keys)
            .unwrap();
        let published = writer.publish(&event).await.unwrap();
        assert_eq!(published.accepted.len(), 1);

        let (got_id, got) = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .expect("the subscriber sees the event")
            .unwrap();
        assert_eq!(got_id, id);
        assert_eq!(got.id, event.id);
        writer.shutdown().await;
        reader.shutdown().await;
        relay.shutdown();
    }

    #[tokio::test]
    async fn an_unreachable_relay_is_reported_not_hidden() {
        // Nothing listens on this port.
        let error = Relays::connect(
            &["ws://127.0.0.1:9"],
            RelayRoute::LocalOnly,
            Duration::from_millis(500),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RelayError::NotConnected { .. }), "{error}");
    }

    /// A group's relays are not the set the client started with: publishing
    /// and fetching reach them on demand, and a relay that cannot be reached
    /// is reported beside the one that took the event.
    #[tokio::test]
    async fn a_relay_outside_the_set_is_reached_on_demand() {
        let (home, home_url) = local_relay().await;
        let (group, group_url) = local_relay().await;
        let relays = Relays::connect(&[&home_url], RelayRoute::LocalOnly, Duration::from_secs(5))
            .await
            .unwrap();
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(445), "group event")
            .finalize(&keys)
            .unwrap();

        let published = relays
            .publish_to(
                &[group_url.as_str(), "ws://127.0.0.1:9"],
                &event,
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(published.accepted, vec![group_url.clone()]);
        assert!(published.failed.contains_key("ws://127.0.0.1:9"));

        let fetched = relays
            .fetch(
                &[&group_url],
                Filter::new()
                    .kind(Kind::Custom(445))
                    .author(keys.public_key()),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(
            fetched.iter().map(|event| event.id).collect::<Vec<_>>(),
            vec![event.id]
        );
        // The home relay never saw it.
        let home_only = relays
            .fetch(
                &[&home_url],
                Filter::new().kind(Kind::Custom(445)),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(home_only.is_empty());
        assert_eq!(relays.urls().await.len(), 3);
        relays.shutdown().await;
        home.shutdown();
        group.shutdown();
    }

    /// The host's dialer opens every stream, and its refusal is that relay's
    /// failure, never a fallback to a direct connection.
    #[tokio::test]
    async fn a_dialer_opens_every_relay_and_its_refusal_stands() {
        #[derive(Default)]
        struct Counting {
            dialed: AtomicUsize,
        }
        impl RelayDialer for Counting {
            fn dial(&self, endpoint: RelayEndpoint) -> Dialed {
                self.dialed.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if endpoint.port == 9 {
                        return Err("the holder's egress refuses this relay".to_owned());
                    }
                    let stream =
                        tokio::net::TcpStream::connect((endpoint.host.as_str(), endpoint.port))
                            .await
                            .map_err(|error| error.to_string())?;
                    Ok(Box::new(stream) as Box<dyn RelayIo>)
                })
            }
        }

        let (relay, url) = local_relay().await;
        let dialer = Arc::new(Counting::default());
        let relays = Relays::connect(
            &[&url],
            RelayRoute::Dialer(dialer.clone()),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(dialer.dialed.load(Ordering::SeqCst), 1);

        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "through the host")
            .finalize(&keys)
            .unwrap();
        assert_eq!(relays.publish(&event).await.unwrap().accepted, vec![url]);

        let refused = relays
            .add(&["ws://127.0.0.1:9"], Duration::from_secs(2))
            .await
            .unwrap_err();
        match refused {
            RelayError::NotConnected { failed } => {
                let reason = &failed["ws://127.0.0.1:9"];
                assert!(reason.contains("refuses"), "{reason}");
            }
            other => panic!("unexpected {other}"),
        }
        relays.shutdown().await;
        relay.shutdown();
    }
}
