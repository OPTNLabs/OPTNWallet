//! Opt-in: resolve real mainnet token identities through one public Fulcrum
//! server, the way a wallet refresh does, and print what a holder would see.
//!
//! ```sh
//! cargo test -p optn-chain-native --test bcmr_live -- --ignored --nocapture
//! ```
//!
//! `OPTN_LIVE_BCMR_ELECTRUM=host:port` picks another TLS server. The registry
//! bytes are fetched directly over HTTPS here; the wallet itself only ever
//! fetches them through its transport policy.
//!
//! The categories are from rnbrady's Electron Cash authchain benchmark (Moria
//! USD: two hops; Furu: four hops whose later links sit at one address).

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use optn_chain_electrum::{ElectrumBackend, ElectrumConfig, ElectrumTransport};
use optn_core::bcmr::RegistryPublication;
use optn_runtime::chain::{
    CapabilitySet, ChainSource, ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily,
    SourceCatalog, SourceDisposition, SourceId, SourceOrigin,
};
use optn_runtime::chain_service::ChainService;
use optn_runtime::token_metadata::{
    resolve_category_identities, FetchAttempt, FetchError, FetchLimits, RegistryFetcher,
};

const CATEGORIES: [(&str, &str); 2] = [
    (
        "Moria USD",
        "b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366",
    ),
    (
        "Furu",
        "d9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea",
    ),
];

/// Direct HTTPS, bounded the way the wallet's own fetcher is.
struct DirectHttps(reqwest::Client);

impl RegistryFetcher for DirectHttps {
    fn fetch<'a>(
        &'a self,
        uri: &'a str,
        limits: FetchLimits,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchAttempt> + Send + 'a>> {
        Box::pin(async move {
            // The gateways the wallet ships, in its order: any one may be
            // rate-limiting, and the bytes are checked against the chain anyway.
            let targets: Vec<String> = match uri.strip_prefix("ipfs://") {
                Some(path) => [
                    "ipfs.optnlabs.com",
                    "ipfs.io",
                    "ipfs.filebase.io",
                    "gateway.pinata.cloud",
                ]
                .iter()
                .map(|host| format!("https://{host}/ipfs/{path}"))
                .collect(),
                None => vec![RegistryPublication::resolve_uri(uri)],
            };
            let mut last = Err(FetchError::Transport {
                detail: "no target".into(),
            });
            for target in targets {
                last = self.get(&target, limits).await;
                if last.is_ok() {
                    break;
                }
            }
            last
        })
    }
}

impl DirectHttps {
    async fn get(&self, target: &str, limits: FetchLimits) -> FetchAttempt {
        let transport = |error: reqwest::Error| FetchError::Transport {
            detail: error.to_string(),
        };
        let response = tokio::time::timeout(limits.deadline, self.0.get(target).send())
            .await
            .map_err(|_| FetchError::Timeout)?
            .map_err(transport)?
            .error_for_status()
            .map_err(transport)?;
        let bytes = response.bytes().await.map_err(transport)?;
        if bytes.len() > limits.max_bytes {
            return Err(FetchError::TooLarge {
                limit: limits.max_bytes,
            });
        }
        Ok(bytes.to_vec())
    }
}

fn category_bytes(hex_id: &str) -> [u8; 32] {
    hex::decode(hex_id).unwrap().try_into().unwrap()
}

#[tokio::test]
#[ignore = "reaches a public Fulcrum server and registry hosts"]
async fn rnbrady_benchmark_categories_resolve_through_public_fulcrum() {
    let server = std::env::var("OPTN_LIVE_BCMR_ELECTRUM")
        .unwrap_or_else(|_| "bch.imaginary.cash:50002".into());
    let (host, port) = server.rsplit_once(':').expect("host:port");
    let source = SourceId::new("live-fulcrum");
    let endpoint = Endpoint {
        kind: EndpointKind::ElectrumTls,
        host: host.into(),
        port: Some(port.parse().expect("numeric port")),
    };
    let backend = ElectrumBackend::connect(ElectrumConfig::new(
        source.clone(),
        endpoint.clone(),
        ElectrumTransport::Tls,
        optn_chain_bip37::genesis_hash("mainnet"),
    ))
    .await
    .expect("the live Fulcrum server answers");
    let mut catalog = SourceCatalog::default();
    catalog
        .insert(ChainSource {
            id: source.clone(),
            label: "Live Fulcrum".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![endpoint],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        })
        .unwrap();
    let mut service = ChainService::new(
        catalog,
        ConnectionPolicy::exact(source, ProtocolFamily::Electrum),
    );
    service.register(Arc::new(backend));
    service.set_registry_fetcher(Arc::new(DirectHttps(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap(),
    )));

    for (label, id) in CATEGORIES {
        let category = category_bytes(id);
        let started = Instant::now();
        let identities =
            resolve_category_identities(&mut service, BTreeSet::from([category])).await;
        let identity = &identities[&category];
        println!(
            "{label}: {:?} {:?} name={:?} ticker={:?} decimals={} in {:.1}s",
            identity.status,
            identity.basis,
            identity.name,
            identity.ticker,
            identity.decimals,
            started.elapsed().as_secs_f64()
        );
        // Current, hash-verified, and labelled as resting on the server's word.
        assert_eq!(
            identity.caveat(),
            Some("as reported by server"),
            "{label}: {identity:?}"
        );
        assert_ne!(identity.name, id, "{label} resolved to a name");
    }
}
