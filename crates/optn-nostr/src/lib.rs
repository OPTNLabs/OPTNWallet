#![forbid(unsafe_code)]

//! Nostr relays for OPTN, over the holder's verified Tor proxy.
//!
//! One crate for every Rust surface that speaks Nostr -- P2P CashFusion
//! coordination and chat, on the desktop host, the CLI and the docker runner --
//! so a relay is reached the same way everywhere:
//!
//! - [`Relays`]: a set of relays reached through [`RelayRoute`], publishing
//!   with at-least-once acceptance and streaming subscribed events.
//! - [`nip17`]: NIP-17 private messages (a kind-14 rumor, sealed and
//!   gift-wrapped per NIP-59), the envelope the TypeScript peers' nostr-tools
//!   `wrapEvent` / `unwrapEvent` produce and read, so Rust and TypeScript peers
//!   exchange the same bytes.
//!
//! Built on rust-nostr (`nostr`, `nostr-sdk` 0.45).

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::Duration;

use futures::{Stream, StreamExt};
use nostr::prelude::{Event, Filter, RelayUrl, SubscriptionId};
use nostr_sdk::prelude::{Client, ClientNotification, Proxy};

pub mod nip17;

pub use nostr;

/// How relays are reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayRoute {
    /// Remote relays through this SOCKS5 proxy: the holder's Tor, which the
    /// caller has verified the way every other remote leg is verified. Relays
    /// on this machine are reached directly.
    Tor(SocketAddr),
    /// Relays on this machine only (tests, a relay the holder runs locally).
    /// A remote relay is refused rather than reached directly.
    LocalOnly,
}

impl RelayRoute {
    fn proxy(self) -> Option<Proxy> {
        match self {
            RelayRoute::Tor(socks) => Some(Proxy::custom(move |url: &RelayUrl| {
                (!url.is_local_addr()).then_some(socks)
            })),
            RelayRoute::LocalOnly => None,
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

/// Relays the event was published to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    /// Relays that accepted it.
    pub accepted: Vec<String>,
    /// Relays that refused it or did not answer, with why.
    pub failed: BTreeMap<String, String>,
}

/// A connected set of relays.
#[derive(Debug, Clone)]
pub struct Relays {
    client: Client,
    urls: Vec<RelayUrl>,
}

impl Relays {
    /// Reach `urls` through `route`, waiting up to `timeout` for at least one
    /// to connect. Remote relays need [`RelayRoute::Tor`].
    pub async fn connect(
        urls: &[impl AsRef<str>],
        route: RelayRoute,
        timeout: Duration,
    ) -> Result<Self, RelayError> {
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
            if route == RelayRoute::LocalOnly && !relay.is_local_addr() {
                return Err(RelayError::RemoteWithoutTor {
                    url: text.to_owned(),
                });
            }
            if !parsed.contains(&relay) {
                parsed.push(relay);
            }
        }
        let mut builder = Client::builder();
        if let Some(proxy) = route.proxy() {
            builder = builder.proxy(proxy);
        }
        let client = builder.build();
        for relay in &parsed {
            client
                .add_relay(relay.clone())
                .await
                .map_err(client_error)?;
        }
        let output = client.try_connect().timeout(timeout).await;
        if output.success.is_empty() {
            client.shutdown().await;
            return Err(RelayError::NotConnected {
                failed: output
                    .failed
                    .into_iter()
                    .map(|(url, reason)| (url.to_string(), reason))
                    .collect(),
            });
        }
        Ok(Self {
            client,
            urls: parsed,
        })
    }

    /// The relays this set was asked to reach.
    pub fn urls(&self) -> impl Iterator<Item = &str> {
        self.urls.iter().map(RelayUrl::as_str)
    }

    /// Publish `event`. Succeeds when at least one relay accepts it, which is
    /// what a peer needs to see it; the relays that did not are reported.
    pub async fn publish(&self, event: &Event) -> Result<Published, RelayError> {
        let output = self.client.send_event(event).await.map_err(client_error)?;
        let failed: BTreeMap<String, String> = output
            .failed
            .into_iter()
            .map(|(url, reason)| (url.to_string(), reason))
            .collect();
        if output.success.is_empty() {
            return Err(RelayError::NotAccepted { failed });
        }
        let mut accepted: Vec<String> = output.success.keys().map(ToString::to_string).collect();
        accepted.sort();
        Ok(Published { accepted, failed })
    }

    /// Ask the relays for events matching `filter`, stored and new. They
    /// arrive on [`Relays::events`] under the returned id.
    pub async fn subscribe(&self, filter: Filter) -> Result<SubscriptionId, RelayError> {
        let output = self.client.subscribe(filter).await.map_err(client_error)?;
        if output.success.is_empty() {
            return Err(RelayError::NotAccepted {
                failed: output
                    .failed
                    .into_iter()
                    .map(|(url, reason)| (url.to_string(), reason))
                    .collect(),
            });
        }
        Ok(output.value)
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

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::prelude::{EventBuilder, FinalizeEvent, Keys, Kind};
    use nostr_sdk::prelude::LocalRelay;

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
        // remote one through the proxy.
        let proxy = RelayRoute::Tor("127.0.0.1:9050".parse().unwrap())
            .proxy()
            .unwrap();
        let _ = proxy;
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
}
