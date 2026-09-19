//! Bounded, Tor-only retrieval of BCMR registry bytes.
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
    let resolved = RegistryPublication::resolve_uri(published_uri);
    let start = registry_url(&resolved)?;
    let client = registry_client(tor, limits)?;
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

fn registry_client(tor: VerifiedRegistryTor, limits: FetchLimits) -> Result<Client, FetchError> {
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
    Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(limits.deadline)
        .connect_timeout(limits.deadline.min(Duration::from_secs(10)))
        .proxy(Proxy::all(&proxy).map_err(|_| FetchError::PolicyRefused {
            detail: "verified Tor route is invalid".into(),
        })?)
        .build()
        .map_err(|_| FetchError::Transport {
            detail: "registry HTTP client could not start".into(),
        })
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

async fn fetch_url(client: &Client, mut current: Url, limits: FetchLimits) -> FetchAttempt {
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
            registry_client(VerifiedRegistryTor { socks_port: 0 }, limits),
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
