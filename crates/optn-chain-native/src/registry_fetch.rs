//! Bounded retrieval of BCMR registry bytes, over the route the holder's
//! transport policy gives each origin.
//!
//! This module deliberately returns bytes as a `FetchAttempt`. The runtime owns
//! publication hash verification and must pair it with explicit selected-source
//! spentness evidence before it can publish an identity. Keeping transport and
//! identity separate preserves a hash mismatch as evidence rather than
//! disguising it as an HTTP failure.

use optn_core::bcmr::RegistryPublication;
use optn_runtime::token_metadata::{FetchAttempt, FetchError, FetchLimits, RegistryFetcher};
use rand_core::{OsRng, RngCore};
use reqwest::{redirect, Client, Proxy, Url};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use url::Host;

const TOR_PROXY_HOST: &str = "127.0.0.1";

/// A SOCKS port whose provenance was already verified by the native Tor
/// policy. This module cannot turn a listening port into a trusted proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedRegistryTor {
    pub socks_port: u16,
}

impl RegistryFetcher for VerifiedRegistryTor {
    fn fetch<'a>(
        &'a self,
        uri: &'a str,
        limits: FetchLimits,
    ) -> std::pin::Pin<Box<dyn Future<Output = FetchAttempt> + Send + 'a>> {
        Box::pin(fetch_publication_uri(uri, *self, limits))
    }
}

/// How one registry origin is reached.
///
/// The native stack decides this from the holder's transport policy and the
/// origin's ownership (#75 §4.1). This module only carries it out: a refusal
/// stays a refusal and never becomes a direct connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryRoute {
    /// Through a SOCKS port whose provenance the native Tor policy verified.
    Tor(VerifiedRegistryTor),
    /// Without a proxy. Only the holder's declared infrastructure may resolve
    /// to a private or local address; see [`PublicAddressesOnly`].
    Direct { own_infrastructure: bool },
    /// The transport requires Tor for this origin and no verified Tor is
    /// available, so nothing is fetched from it.
    TorUnavailable,
}

pub struct ConfiguredRegistryFetcher {
    gateways: Vec<(Url, RegistryRoute)>,
    indexers: Vec<(Url, RegistryRoute)>,
    /// How registries named by publications are reached, or `None` when the
    /// source policy does not permit public registry retrieval at all.
    publishers: Option<RegistryRoute>,
}

impl ConfiguredRegistryFetcher {
    pub fn new(
        gateways: Vec<(Url, RegistryRoute)>,
        indexers: Vec<(Url, RegistryRoute)>,
        publishers: Option<RegistryRoute>,
    ) -> Self {
        Self {
            gateways: gateways.into_iter().take(16).collect(),
            indexers: indexers.into_iter().take(16).collect(),
            publishers,
        }
    }

    /// Whether any origin this fetcher may use has a usable route.
    pub fn can_fetch(&self) -> bool {
        self.gateways
            .iter()
            .chain(&self.indexers)
            .map(|(_, route)| *route)
            .chain(self.publishers)
            .any(|route| route != RegistryRoute::TorUnavailable)
    }
}

impl RegistryFetcher for ConfiguredRegistryFetcher {
    fn registry_candidates(&self, category: [u8; 32]) -> Vec<String> {
        self.indexers
            .iter()
            // An indexer the transport cannot reach is not a candidate.
            .filter(|(_, route)| *route != RegistryRoute::TorUnavailable)
            .filter_map(|(origin, _)| {
                let mut target = registry_url(origin.as_str()).ok()?;
                if target.path() != "/" || target.query().is_some() {
                    return None;
                }
                target.set_path(&format!(
                    "/api/registries/{}/latest/",
                    hex::encode(category)
                ));
                Some(target.into())
            })
            .collect()
    }

    fn fetch<'a>(
        &'a self,
        uri: &'a str,
        limits: FetchLimits,
    ) -> std::pin::Pin<Box<dyn Future<Output = FetchAttempt> + Send + 'a>> {
        Box::pin(async move {
            if !uri.starts_with("ipfs://") {
                let target = registry_url(&RegistryPublication::resolve_uri(uri))?;
                if let Some((_, route)) = self
                    .indexers
                    .iter()
                    .find(|(base, _)| base.origin() == target.origin())
                {
                    // Stay on the configured service, including redirects. Its response
                    // is merely candidate bytes; the runtime authenticates the hash.
                    let client = registry_client(*route, limits)?;
                    return within_deadline(
                        limits.deadline,
                        fetch_url_scoped(&client, target, limits, true),
                    )
                    .await;
                }
                let Some(route) = self.publishers else {
                    return Err(refused(
                        "source policy does not permit public registry retrieval",
                    ));
                };
                return fetch_publication_via(uri, route, limits).await;
            }
            let path = ipfs_path(uri)?;
            if self.gateways.is_empty() {
                return Err(refused("no permitted IPFS gateway is configured"));
            }
            within_deadline(limits.deadline, async {
                let mut last = Err(refused("no usable IPFS gateway"));
                for (gateway, route) in &self.gateways {
                    let mut target = registry_url(gateway.as_str())?;
                    if target.path() != "/" || target.query().is_some() {
                        return Err(refused("gateway must be an HTTPS origin"));
                    }
                    target.set_path(&path);
                    // Each gateway on its own route, and over Tor its own circuit.
                    last = match registry_client(*route, limits) {
                        Ok(client) => fetch_url_scoped(&client, target, limits, true).await,
                        Err(error) => Err(error),
                    };
                    if last.is_ok() {
                        break;
                    }
                }
                last
            })
            .await
        })
    }
}

fn refused(detail: &str) -> FetchError {
    FetchError::PolicyRefused {
        detail: detail.into(),
    }
}

fn ipfs_path(uri: &str) -> Result<String, FetchError> {
    let value = uri
        .strip_prefix("ipfs://")
        .ok_or_else(|| refused("invalid IPFS URI"))?;
    if value.len() > 4096 || value.contains(['?', '#', '@', '%', '\\']) {
        return Err(refused("unsupported IPFS URI"));
    }
    let mut segments = value.split('/');
    let cid = segments.next().unwrap_or_default();
    // Preserve case: CIDv0 base58 is case sensitive. The publication hash,
    // rather than trusting the gateway or this syntactic CID check, authenticates bytes.
    if cid.len() < 10 || cid.len() > 128 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(refused("invalid IPFS content identifier"));
    }
    if segments.any(|part| {
        part == "."
            || part == ".."
            || part
                .bytes()
                .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    }) {
        return Err(refused("invalid IPFS path"));
    }
    Ok(format!("/ipfs/{value}"))
}

/// Resolve a publication URI and retrieve its bounded bytes over the supplied
/// verified Tor route.
///
/// Bare authorities are normalized by `RegistryPublication::resolve_uri`. The
/// client uses `socks5h`, so registry hostnames are resolved by Tor rather than
/// the host resolver. Redirects are followed manually and every hop is checked
/// as a fresh publication URI.
pub async fn fetch_publication_uri(
    published_uri: &str,
    tor: VerifiedRegistryTor,
    limits: FetchLimits,
) -> FetchAttempt {
    fetch_publication_via(published_uri, RegistryRoute::Tor(tor), limits).await
}

/// Resolve a publication URI and retrieve its bounded bytes over `route`.
async fn fetch_publication_via(
    published_uri: &str,
    route: RegistryRoute,
    limits: FetchLimits,
) -> FetchAttempt {
    let resolved = RegistryPublication::resolve_uri(published_uri);
    let start = registry_url(&resolved)?;
    let client = registry_client(route, limits)?;
    within_deadline(limits.deadline, fetch_url(&client, start, limits)).await
}

fn registry_url(value: &str) -> Result<Url, FetchError> {
    let url = Url::parse(value).map_err(|_| FetchError::PolicyRefused {
        detail: "registry URI is invalid".into(),
    })?;
    if url.scheme() != "https" {
        return Err(FetchError::PolicyRefused {
            detail: "registry URI must use HTTPS".into(),
        });
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(FetchError::PolicyRefused {
            detail: "registry URI contains unsupported credentials or fragment".into(),
        });
    }
    let host = match url.host() {
        Some(Host::Domain(host)) => host.trim_end_matches('.'),
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => {
            return Err(FetchError::PolicyRefused {
                detail: "registry URI must name a public hostname".into(),
            });
        }
        None => {
            return Err(FetchError::PolicyRefused {
                detail: "registry URI has no host".into(),
            });
        }
    };
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return Err(FetchError::PolicyRefused {
            detail: "registry URI must name a public hostname".into(),
        });
    }
    Ok(url)
}

fn registry_client(route: RegistryRoute, limits: FetchLimits) -> Result<Client, FetchError> {
    let builder = Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(limits.deadline)
        .connect_timeout(limits.deadline.min(Duration::from_secs(10)));
    let builder = match route {
        RegistryRoute::Tor(tor) => {
            if tor.socks_port == 0 {
                return Err(FetchError::PolicyRefused {
                    detail: "verified Tor route has no SOCKS port".into(),
                });
            }
            let token = isolation_token();
            let proxy = format!(
                "socks5h://{token}:{token}@{TOR_PROXY_HOST}:{}",
                tor.socks_port
            );
            builder.proxy(Proxy::all(&proxy).map_err(|_| FetchError::PolicyRefused {
                detail: "verified Tor route is invalid".into(),
            })?)
        }
        // No proxy from the environment either: the holder chose a direct
        // connection, and a variable set for some other program is not that.
        RegistryRoute::Direct {
            own_infrastructure: true,
        } => builder.no_proxy(),
        RegistryRoute::Direct {
            own_infrastructure: false,
        } => builder
            .no_proxy()
            .dns_resolver(Arc::new(PublicAddressesOnly)),
        RegistryRoute::TorUnavailable => {
            return Err(refused(
                "the network policy reaches this registry through Tor, and no verified Tor is available",
            ));
        }
    };
    builder.build().map_err(|_| FetchError::Transport {
        detail: "registry HTTP client could not start".into(),
    })
}

/// Name resolution for direct fetches from origins the holder did not declare
/// as theirs: only public addresses are kept.
///
/// A publication's URI is written by whoever controls the identity. Through
/// Tor it can only reach the public internet; fetched directly, it could name
/// a host that resolves into this machine's own network, and the wallet would
/// make requests there on the publisher's behalf. `registry_url` already
/// refuses IP literals and `localhost`, so every connection is named and comes
/// through here, redirects included. The desktop shell's direct fetches of
/// dApp- and peer-named URLs use it for the same reason.
pub struct PublicAddressesOnly;

impl reqwest::dns::Resolve for PublicAddressesOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let public: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|address| is_public_address(address.ip()))
                .collect();
            if public.is_empty() {
                return Err("registry host has no public address".into());
            }
            Ok(Box::new(public.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Whether an address is on the public internet, rather than loopback,
/// private, link-local, shared, documentation, multicast or reserved space.
/// IPv6 forms that carry an IPv4 address are judged by that address.
pub fn is_public_address(address: IpAddr) -> bool {
    let v6 = match address {
        IpAddr::V4(v4) => return is_public_v4(v4),
        IpAddr::V6(v6) => v6,
    };
    let s = v6.segments();
    let embedded = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    match s {
        // IPv4-compatible, `::` and `::1` among them.
        [0, 0, 0, 0, 0, 0, high, low] => is_public_v4(embedded(high, low)),
        // NAT64 well-known prefix: an IPv6-only network reaching IPv4.
        [0x0064, 0xff9b, 0, 0, 0, 0, high, low] => is_public_v4(embedded(high, low)),
        // 6to4.
        [0x2002, high, low, ..] => is_public_v4(embedded(high, low)),
        // Discard-only.
        [0x0100, 0, 0, 0, ..] => false,
        // Documentation.
        [0x2001, 0x0db8, ..] => false,
        [first, ..] => {
            !(v6.is_multicast()
                // Unique local, fc00::/7.
                || first & 0xfe00 == 0xfc00
                // Link-local, fe80::/10, and the deprecated site-local fec0::/10.
                || first & 0xffc0 == 0xfe80
                || first & 0xffc0 == 0xfec0)
        }
    }
}

fn is_public_v4(v4: Ipv4Addr) -> bool {
    let [a, b, c, _] = v4.octets();
    !(a == 0
        || v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        // Shared address space (carrier-grade NAT), 100.64.0.0/10.
        || (a == 100 && (64..128).contains(&b))
        // IETF protocol assignments, 192.0.0.0/24.
        || (a == 192 && b == 0 && c == 0)
        || v4.is_documentation()
        // Benchmarking, 198.18.0.0/15.
        || (a == 198 && (b == 18 || b == 19))
        || v4.is_multicast()
        // Reserved, 240.0.0.0/4, and the limited broadcast address.
        || a >= 240)
}

fn isolation_token() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

async fn within_deadline<T>(
    deadline: Duration,
    operation: impl Future<Output = Result<T, FetchError>>,
) -> Result<T, FetchError> {
    tokio::time::timeout(deadline, operation)
        .await
        .unwrap_or(Err(FetchError::Timeout))
}

async fn fetch_url(client: &Client, current: Url, limits: FetchLimits) -> FetchAttempt {
    fetch_url_scoped(client, current, limits, false).await
}

async fn fetch_url_scoped(
    client: &Client,
    mut current: Url,
    limits: FetchLimits,
    same_origin: bool,
) -> FetchAttempt {
    let origin = current.origin();
    for redirects in 0..=limits.max_redirects {
        let mut response = client
            .get(current.clone())
            .send()
            .await
            .map_err(fetch_error)?;
        if response.status().is_redirection() {
            if redirects == limits.max_redirects {
                return Err(FetchError::TooManyRedirects {
                    limit: limits.max_redirects,
                });
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| FetchError::Transport {
                    detail: "registry redirect has no valid location".into(),
                })?;
            let next = current
                .join(location)
                .map_err(|_| FetchError::PolicyRefused {
                    detail: "registry redirect location is invalid".into(),
                })?;
            current = registry_url(next.as_str())?;
            if same_origin && current.origin() != origin {
                return Err(refused("gateway redirect leaves the selected source"));
            }
            continue;
        }
        if !response.status().is_success() {
            return Err(FetchError::Transport {
                detail: "registry server returned an unsuccessful status".into(),
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > limits.max_bytes as u64)
        {
            return Err(FetchError::TooLarge {
                limit: limits.max_bytes,
            });
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(fetch_error)? {
            append_chunk(&mut body, &chunk, limits.max_bytes)?;
        }
        return Ok(body);
    }
    unreachable!("redirect loop is bounded by the for range")
}

fn append_chunk(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), FetchError> {
    if chunk.len() > limit.saturating_sub(body.len()) {
        return Err(FetchError::TooLarge { limit });
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn fetch_error(error: reqwest::Error) -> FetchError {
    if error.is_timeout() {
        FetchError::Timeout
    } else {
        FetchError::Transport {
            detail: "registry transport failed".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOR: RegistryRoute = RegistryRoute::Tor(VerifiedRegistryTor { socks_port: 9050 });

    #[test]
    fn indexer_candidates_preserve_category_and_only_use_configured_https_origins() {
        let category = [0xab; 32];
        let fetcher = ConfiguredRegistryFetcher::new(
            vec![],
            vec![
                (Url::parse("https://bcmr.example:8443/").unwrap(), TOR),
                (Url::parse("http://bad.example/").unwrap(), TOR),
                (Url::parse("https://bad.example/path").unwrap(), TOR),
                // Configured, but the transport gives it no route.
                (
                    Url::parse("https://unreachable.example/").unwrap(),
                    RegistryRoute::TorUnavailable,
                ),
            ],
            None,
        );
        assert_eq!(
            fetcher.registry_candidates(category),
            vec![format!(
                "https://bcmr.example:8443/api/registries/{}/latest/",
                hex::encode(category)
            )]
        );
    }

    #[tokio::test]
    async fn a_route_the_transport_cannot_satisfy_is_refused_not_downgraded() {
        let cid = "QmYwAPJzv5CZsnAzt8auVZRnGkD8ZKC6NAkbwfEfEbKxQv";
        let gateway = Url::parse("https://gateway.example/").unwrap();
        let fetcher = ConfiguredRegistryFetcher::new(
            vec![(gateway.clone(), RegistryRoute::TorUnavailable)],
            vec![(gateway, RegistryRoute::TorUnavailable)],
            Some(RegistryRoute::TorUnavailable),
        );
        assert!(!fetcher.can_fetch());
        for uri in [
            format!("ipfs://{cid}"),
            "https://publisher.example/registry.json".into(),
            "https://gateway.example/api/registries/ab/latest/".into(),
        ] {
            assert!(
                matches!(
                    fetcher.fetch(&uri, FetchLimits::default()).await,
                    Err(FetchError::PolicyRefused { .. })
                ),
                "{uri}"
            );
        }
        // One reachable origin is enough for the stack to install a fetcher.
        for route in [
            TOR,
            RegistryRoute::Direct {
                own_infrastructure: false,
            },
        ] {
            assert!(ConfiguredRegistryFetcher::new(vec![], vec![], Some(route)).can_fetch());
        }
        assert!(!ConfiguredRegistryFetcher::new(vec![], vec![], None).can_fetch());
    }

    #[test]
    fn direct_public_fetches_only_resolve_to_public_addresses() {
        for public in [
            "1.1.1.1",
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.1",
            "198.20.0.1",
            "2606:4700:4700::1111",
            "64:ff9b::808:808",
            "::ffff:8.8.8.8",
            "2002:808:808::1",
        ] {
            assert!(is_public_address(public.parse().unwrap()), "{public}");
        }
        for private in [
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            // Cloud instance metadata lives here.
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.254",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "198.19.255.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "::c0a8:101",
            "64:ff9b::a00:1",
            "2002:c0a8:101::1",
            "fe80::1",
            "fec0::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "2001:db8::1",
            "100::1",
        ] {
            assert!(!is_public_address(private.parse().unwrap()), "{private}");
        }
    }

    #[tokio::test]
    async fn a_name_resolving_only_to_this_machine_is_not_fetched_directly() {
        use reqwest::dns::Resolve;
        let name: reqwest::dns::Name = "localhost".parse().unwrap();
        assert!(PublicAddressesOnly.resolve(name).await.is_err());
        // The holder's own declared gateway may sit on their own network, so
        // its client keeps the system resolver.
        assert!(registry_client(
            RegistryRoute::Direct {
                own_infrastructure: true
            },
            FetchLimits::default()
        )
        .is_ok());
    }

    #[tokio::test]
    async fn configured_gateway_preserves_cid_and_refuses_unselected_routes() {
        let cid = "QmYwAPJzv5CZsnAzt8auVZRnGkD8ZKC6NAkbwfEfEbKxQv";
        assert_eq!(
            ipfs_path(&format!("ipfs://{cid}/registry.json")).unwrap(),
            format!("/ipfs/{cid}/registry.json")
        );
        for suffix in [
            "/../secret",
            "/%2e%2e/secret",
            "?url=https://evil.example",
            "#x",
            "/a b",
            "/a\\b",
        ] {
            assert!(ipfs_path(&format!("ipfs://{cid}{suffix}")).is_err());
        }
        let fetcher = ConfiguredRegistryFetcher::new(vec![], vec![], None);
        for uri in [
            format!("ipfs://{cid}"),
            "https://publisher.example/file".into(),
        ] {
            assert!(matches!(
                fetcher.fetch(&uri, FetchLimits::default()).await,
                Err(FetchError::PolicyRefused { .. })
            ));
        }
    }

    #[test]
    fn bare_authorities_use_https_well_known_uri() {
        let uri = RegistryPublication::resolve_uri("registry.example");
        assert_eq!(
            registry_url(&uri).unwrap().as_str(),
            "https://registry.example/.well-known/bitcoin-cash-metadata-registry.json"
        );
    }

    #[test]
    fn registry_uris_reject_cleartext_credentials_fragments_and_local_targets() {
        for uri in [
            "http://registry.example/metadata.json",
            "https://user:secret@registry.example/metadata.json",
            "https://registry.example/metadata.json#fragment",
            "https://localhost/metadata.json",
            "https://LOCALHOST./metadata.json",
            "https://registry.localhost/metadata.json",
            "https://registry.localhost./metadata.json",
            "https://127.0.0.1/metadata.json",
            "https://[::1]/metadata.json",
        ] {
            assert!(
                matches!(registry_url(uri), Err(FetchError::PolicyRefused { .. })),
                "{uri}"
            );
        }
    }

    #[test]
    fn registry_body_limit_is_enforced_before_allocation_growth() {
        let mut body = vec![1, 2];
        assert_eq!(
            append_chunk(&mut body, &[3, 4], 3),
            Err(FetchError::TooLarge { limit: 3 })
        );
        assert_eq!(body, vec![1, 2]);
    }

    #[test]
    fn zero_tor_socks_port_is_refused() {
        let limits = FetchLimits::default();
        assert!(matches!(
            registry_client(
                RegistryRoute::Tor(VerifiedRegistryTor { socks_port: 0 }),
                limits
            ),
            Err(FetchError::PolicyRefused { .. })
        ));
    }

    #[tokio::test]
    async fn deadline_covers_the_whole_redirect_and_body_operation() {
        let result = within_deadline(Duration::from_millis(30), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok::<_, FetchError>(())
        })
        .await;
        assert_eq!(result, Err(FetchError::Timeout));
    }

    #[test]
    fn tor_proxy_url_uses_remote_dns_and_per_fetch_isolation_credentials() {
        let first = isolation_token();
        let second = isolation_token();
        assert_ne!(first, second);
        let proxy = format!("socks5h://{first}:{first}@{TOR_PROXY_HOST}:9050");
        assert!(proxy.starts_with("socks5h://"));
        assert!(proxy.ends_with("@127.0.0.1:9050"));
    }
}
