use super::*;
use crate::chain::{
    Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainSource,
    ConnectionPolicy, Endpoint, EndpointKind, Evidence, Hash32, ProviderHealth, SourceCatalog,
    SourceDisposition, SourceOrigin,
};
use crate::chain_service::{BackendObservation, ChainBackend, ChainFuture, ChainRevocation};
use crate::wallet_birthday::{ScanFloor, WalletBirthday, WalletRestoreState};
use optn_core::header_pow::{verify_declared_pow, HeaderPowError};
use std::sync::Mutex;

// Seven leaves exercise duplicate padding, including an interior starting leaf.
const TIP: u32 = 6;
const FLOOR: u32 = 4;
const WINDOW: u32 = 3;
const PROTOCOLS: [ProtocolFamily; 2] = [ProtocolFamily::Bip37, ProtocolFamily::Neutrino];

struct Fixture {
    view: VerifiedHeaderView,
    headers: Vec<BlockHeaderBytes>,
}

fn mine(mut header: [u8; 80]) -> BlockHeaderBytes {
    for nonce in 0u32..100_000 {
        header[76..80].copy_from_slice(&nonce.to_le_bytes());
        if verify_declared_pow(&header).is_ok() {
            return BlockHeaderBytes(header);
        }
    }
    panic!("bounded regtest fixture mining failed");
}

impl Fixture {
    fn new() -> Self {
        Self::with_tip(TIP)
    }

    fn with_tip(end: u32) -> Self {
        // Same shipped-genesis fixture pattern as sync_worker::tests. That
        // sibling's mining helper is private, so no visibility change is needed.
        let verifier = shipped_header_verifier(Network::Regtest).unwrap();
        let genesis = verifier.tip_checkpoint_proof().unwrap().0.clone();
        let genesis_time = verifier.last_time().unwrap();
        let bits = optn_core::asert::AsertParams::for_network(Network::Regtest).max_bits;
        let mut headers = vec![genesis];
        for height in 1..=end {
            let mut header = [0u8; 80];
            header[0..4].copy_from_slice(&1u32.to_le_bytes());
            header[4..36].copy_from_slice(&sha256d(&headers.last().unwrap().0));
            header[36..68].copy_from_slice(&[height as u8; 32]);
            header[68..72].copy_from_slice(&(genesis_time + height * 600).to_le_bytes());
            header[72..76].copy_from_slice(&bits.to_le_bytes());
            headers.push(mine(header));
        }
        let mut view = VerifiedHeaderView::with_anchor_interval(Network::Regtest, verifier, 16);
        view.extend(&headers[1..]).unwrap();
        Self { view, headers }
    }

    fn tip(&self) -> u32 {
        self.headers.len() as u32 - 1
    }

    fn hash(&self, height: u32) -> Hash32 {
        sha256d(&self.headers[height as usize].0)
    }

    fn store(&self, heights: impl IntoIterator<Item = u32>) -> Arc<SharedHeaders> {
        let store = Arc::new(SharedHeaders::default());
        store.write(|retained| {
            for height in heights {
                retained
                    .insert_verified(height, self.headers[height as usize].clone())
                    .unwrap();
            }
        });
        store
    }

    fn worker(&self, store: &Arc<SharedHeaders>) -> ProgressiveSyncWorker {
        let trusted = self.view.checkpoint();
        let restored =
            VerifiedHeaderView::restore(&self.view.encode().unwrap(), Network::Regtest, &trusted)
                .unwrap();
        assert_eq!(restored.tip(), Some((self.tip(), self.hash(self.tip()))));
        assert_eq!(restored.checkpoint(), trusted);
        ProgressiveSyncWorker::new(ProgressiveSyncConfig {
            header_batch_size: 1,
            max_header_batches: self.tip().saturating_add(1).max(16),
            retained_header_window: WINDOW,
            ..Default::default()
        })
        .with_header_view(restored)
        .unwrap()
        .with_accepted_headers(store.clone())
    }

    fn service(
        &self,
        protocol: ProtocolFamily,
        shv: bool,
        store: Arc<SharedHeaders>,
    ) -> (ChainService, Arc<Peer>) {
        let mut service = ChainService::new(SourceCatalog::default(), ConnectionPolicy::auto());
        let peer = register_peer(&mut service, Peer::new(self, protocol, shv, store));
        (service, peer)
    }
}

// Independently construct the Bitcoin duplicate-padded tree used by the core
// MMR vectors. In particular, this is NOT the tip's append-only proof reused at
// an interior height. Every reply's root is checked against the accepted MMR.
fn merkle_proof(headers: &[BlockHeaderBytes], height: u32) -> (Hash32, Vec<Hash32>) {
    let mut level = headers
        .iter()
        .map(|header| sha256d(&header.0))
        .collect::<Vec<_>>();
    let mut index = height as usize;
    let mut siblings = Vec::new();
    assert!(index < level.len());
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(*level.last().unwrap());
        }
        siblings.push(level[index ^ 1]);
        level = level
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                let mut bytes = [0u8; 64];
                bytes[..32].copy_from_slice(&pair[0]);
                bytes[32..].copy_from_slice(&pair[1]);
                sha256d(&bytes)
            })
            .collect();
        index /= 2;
    }
    (level[0], siblings)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    None,
    Unsupported,
    Timeout,
    WrongRoot,
    WrongHeight,
    WrongCheckpoint,
    WrongSibling,
    WrongProofHeader,
    WrongProofAndOtherTip,
    EmptyTail,
    WrongTailHeight,
    UnlinkedTail,
    OtherTip,
    InvalidWork,
}

#[derive(Clone, Copy, Debug)]
enum InterruptAt {
    Proof,
    LastTail,
    Ordinary(u32),
}

struct Interrupt {
    at: InterruptAt,
    // None means change only the raw-header retention, not hashes/generation.
    revoke: Option<ChainRevocation>,
}

#[derive(Clone, Debug)]
struct Read {
    request: ChainRequest,
    retained: RetainedHeaders,
}

struct Peer {
    id: SourceId,
    endpoint: Endpoint,
    protocol: ProtocolFamily,
    caps: CapabilitySet,
    headers: Vec<BlockHeaderBytes>,
    checkpoint_height: u32,
    root: Hash32,
    store: Arc<SharedHeaders>,
    reads: Mutex<Vec<Read>>,
    fault: Mutex<Fault>,
    interrupt: Mutex<Option<Interrupt>>,
}

impl Peer {
    fn new(
        fixture: &Fixture,
        protocol: ProtocolFamily,
        shv: bool,
        store: Arc<SharedHeaders>,
    ) -> Self {
        let mut caps = CapabilitySet::default();
        for capability in [Capability::UtxoQuery, Capability::HeaderStream] {
            caps.record(
                capability,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
        }
        if shv {
            caps.record(
                Capability::HeaderMerkleProof,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::P2pServiceBit {
                    bit: 1 << 9,
                    name: "NODE_SHV".into(),
                },
            );
        }
        Self {
            id: SourceId::new("selected-peer"),
            endpoint: Endpoint {
                kind: EndpointKind::BchP2p,
                host: "selected-peer.invalid".into(),
                port: Some(18444),
            },
            protocol,
            caps,
            headers: fixture.headers.clone(),
            checkpoint_height: fixture.tip(),
            root: fixture.view.checkpoint().commitment,
            store,
            reads: Mutex::new(Vec::new()),
            fault: Mutex::new(Fault::None),
            interrupt: Mutex::new(None),
        }
    }

    fn reads(&self) -> Vec<Read> {
        self.reads.lock().unwrap().clone()
    }

    fn requests(&self) -> Vec<ChainRequest> {
        self.reads().into_iter().map(|read| read.request).collect()
    }

    fn fail_with(&self, fault: Fault) {
        *self.fault.lock().unwrap() = fault;
    }
}

fn register_peer(service: &mut ChainService, peer: Peer) -> Arc<Peer> {
    if let Some(source) = service.catalog_mut().get_mut(&peer.id) {
        if !source.endpoints.contains(&peer.endpoint) {
            source.endpoints.push(peer.endpoint.clone());
        }
    } else {
        service
            .catalog_mut()
            .insert(ChainSource {
                id: peer.id.clone(),
                label: peer.id.as_str().into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![peer.endpoint.clone()],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
    }
    let peer = Arc::new(peer);
    service.register(peer.clone());
    peer
}

impl ChainBackend for Peer {
    fn source_id(&self) -> &SourceId {
        &self.id
    }
    fn protocol(&self) -> ProtocolFamily {
        self.protocol
    }
    fn endpoint(&self) -> Option<&Endpoint> {
        Some(&self.endpoint)
    }
    fn capabilities(&self) -> &CapabilitySet {
        &self.caps
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth::Healthy
    }
    fn supports(&self, operation: ChainOperation) -> bool {
        matches!(
            operation,
            ChainOperation::WalletRefresh
                | ChainOperation::HeaderSync
                | ChainOperation::HistoricalHeaderProof
        )
    }

    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        Box::pin(async move {
            self.reads.lock().unwrap().push(Read {
                request: request.clone(),
                retained: snapshot(&self.store),
            });
            let mut interrupt = self.interrupt.lock().unwrap();
            if interrupt.as_ref().is_some_and(|hook| match hook.at {
                InterruptAt::Proof => matches!(request, ChainRequest::HistoricalHeaderProof { .. }),
                InterruptAt::LastTail => matches!(
                    request,
                    ChainRequest::HeaderSyncFromLocator { start_height, .. }
                        if *start_height == self.checkpoint_height
                ),
                InterruptAt::Ordinary(height) => matches!(request,
                    ChainRequest::HeaderSync { start_height, .. } if *start_height == height),
            }) {
                let hook = interrupt.take().unwrap();
                if let Some(revocation) = hook.revoke {
                    revocation.revoke();
                } else {
                    self.store
                        .write(|retained| retained.drop_headers_below(self.checkpoint_height + 1));
                }
            }
            drop(interrupt);
            let fault = *self.fault.lock().unwrap();
            let tip = (
                self.headers.len() as u32 - 1,
                sha256d(&self.headers.last().unwrap().0),
            );
            let payload = match request {
                ChainRequest::HistoricalHeaderProof {
                    height,
                    checkpoint_height,
                } => {
                    assert_eq!(
                        *checkpoint_height, self.checkpoint_height,
                        "proof must use our trusted tip"
                    );
                    match fault {
                        Fault::Unsupported => return Err(ChainBackendError::Unsupported),
                        Fault::Timeout => return Err(ChainBackendError::Timeout),
                        _ => {}
                    }
                    let (mut root, mut siblings) =
                        merkle_proof(&self.headers[..=*checkpoint_height as usize], *height);
                    assert_eq!(
                        root, self.root,
                        "independent tree must reproduce the accepted MMR"
                    );
                    let mut header = self.headers[*height as usize].0;
                    if fault == Fault::WrongRoot {
                        root[0] ^= 1;
                    }
                    if matches!(fault, Fault::WrongSibling | Fault::WrongProofAndOtherTip) {
                        siblings[0][0] ^= 1;
                    }
                    if fault == Fault::WrongProofHeader {
                        header = self.headers[(*height as usize + 1) % self.headers.len()].0;
                    }
                    ChainPayload::HistoricalHeaderProof {
                        height: height + u32::from(fault == Fault::WrongHeight),
                        checkpoint_height: checkpoint_height
                            - u32::from(fault == Fault::WrongCheckpoint),
                        header,
                        siblings,
                        root,
                    }
                }
                ChainRequest::HeaderSyncFromLocator {
                    start_height,
                    count,
                    locator,
                } => {
                    assert!((1..=self.checkpoint_height).contains(start_height));
                    assert_eq!(*locator, sha256d(&self.headers[*start_height as usize - 1].0),
                        "each batch must use the previous staged header, even while the shared store has a gap");
                    let mut headers = self
                        .headers
                        .iter()
                        .skip(*start_height as usize)
                        .take(*count as usize)
                        .map(|header| header.0)
                        .collect::<Vec<_>>();
                    let last = *start_height == self.checkpoint_height;
                    if last {
                        match fault {
                            Fault::EmptyTail => headers.clear(),
                            Fault::UnlinkedTail => headers[0][4] ^= 1,
                            Fault::OtherTip | Fault::WrongProofAndOtherTip => {
                                headers[0][36] ^= 1;
                                headers[0] = mine(headers[0]).0;
                            }
                            Fault::InvalidWork => {
                                // Regtest has no retargeting. Reject genuinely
                                // insufficient work, without claiming this
                                // fixture proves post-ASERT network behavior.
                                let nonce = (0u32..100_000)
                                    .find(|nonce| {
                                        headers[0][76..80].copy_from_slice(&nonce.to_le_bytes());
                                        matches!(
                                            verify_declared_pow(&headers[0]),
                                            Err(HeaderPowError::InsufficientWork)
                                        )
                                    })
                                    .expect("bounded invalid-work fixture");
                                headers[0][76..80].copy_from_slice(&nonce.to_le_bytes());
                            }
                            _ => {}
                        }
                    }
                    ChainPayload::Headers {
                        start_height: start_height
                            + u32::from(last && fault == Fault::WrongTailHeight),
                        headers,
                    }
                }
                ChainRequest::HeaderSync {
                    start_height,
                    count,
                } => {
                    assert!(
                        *start_height > self.checkpoint_height && *start_height <= tip.0 + 1,
                        "ordinary sync must continue the accepted checkpoint"
                    );
                    ChainPayload::Headers {
                        start_height: *start_height,
                        headers: self
                            .headers
                            .iter()
                            .skip(*start_height as usize)
                            .take(*count as usize)
                            .map(|header| header.0)
                            .collect(),
                    }
                }
                ChainRequest::WalletRefresh {
                    interests: supplied,
                    from_height,
                } => {
                    assert_eq!(
                        *supplied,
                        interests(),
                        "wallet request keeps its exact script scope"
                    );
                    let first = if self.protocol == ProtocolFamily::Neutrino {
                        0
                    } else {
                        from_height
                            .expect("bounded complete scan")
                            .saturating_sub(1)
                    };
                    self.store
                        .range_inclusive(first, tip.0)
                        .expect("wallet scan needs all authenticated hashes");
                    assert_eq!(self.store.tip(), Some(tip));
                    ChainPayload::WalletRefresh {
                        transactions: vec![],
                        tip: Some(ChainTip {
                            height: tip.0,
                            hash: tip.1,
                        }),
                    }
                }
                other => panic!("unexpected request: {other:?}"),
            };
            Ok(BackendObservation {
                payload,
                evidence: Evidence::ServerAssertion,
                chain_tip: Some(tip),
            })
        })
    }
}

fn interests() -> Vec<WalletInterest> {
    vec![
        WalletInterest::script(vec![0x51]),
        WalletInterest::script(vec![0x52]),
    ]
}

fn scope(floor: u32) -> RefreshScope {
    RefreshScope::Complete { floor: Some(floor) }
}

fn snapshot(store: &SharedHeaders) -> RetainedHeaders {
    store.read(|retained| retained.clone())
}

async fn accepted_refresh(
    fixture: &Fixture,
    worker: &mut ProgressiveSyncWorker,
    service: &mut ChainService,
    floor: u32,
) -> CapabilityRoute {
    let mut requested = interests();
    requested.reverse();
    requested.push(requested[0].clone());
    let outcome = worker
        .refresh_with_scope(service, requested, scope(floor))
        .await
        .unwrap();
    assert_eq!(outcome.decision, ReconciliationDecision::Accepted);
    let accepted = worker.reconciliation().authoritative.as_ref().unwrap();
    assert_eq!(accepted.value.interests, interests());
    assert_eq!(
        accepted.value.tip,
        Some(ChainTip {
            height: fixture.tip(),
            hash: fixture.hash(fixture.tip())
        })
    );
    assert_eq!(accepted.chain_tip, fixture.view.tip());
    assert_eq!(accepted.source, outcome.route.source);
    assert_eq!(
        accepted.evidence,
        Evidence::ServerAssertion,
        "a header proof does not upgrade wallet evidence"
    );
    assert!(worker.reconciliation().sync.history_fresh);
    assert!(worker.reconciliation().sync.utxos_fresh);
    outcome.route
}

async fn refused_refresh(
    worker: &mut ProgressiveSyncWorker,
    service: &mut ChainService,
    peer: &Peer,
    floor: u32,
    expected_store: &RetainedHeaders,
) {
    let accepted = worker.reconciliation().authoritative.clone();
    let view = worker.header_view().unwrap().encode().unwrap();
    assert!(worker
        .refresh_with_scope(service, interests(), scope(floor))
        .await
        .is_err());
    assert_eq!(
        snapshot(&peer.store),
        *expected_store,
        "rejected recovery published staged headers"
    );
    assert_eq!(worker.header_view().unwrap().encode().unwrap(), view);
    assert_eq!(
        worker.reconciliation().authoritative,
        accepted,
        "failure replaced the accepted wallet"
    );
    assert!(
        worker.proven_shv_route.is_none(),
        "a failed recovery must revoke earlier pruning authority"
    );
    assert!(!worker.reconciliation().sync.history_fresh);
    assert!(worker.reconciliation().sync.degraded_reason.is_some());
    assert!(!peer
        .requests()
        .iter()
        .any(|request| matches!(request, ChainRequest::WalletRefresh { .. })));
}

fn expected_requests(fixture: &Fixture, start: u32, proof: bool, floor: u32) -> Vec<ChainRequest> {
    let mut expected = Vec::new();
    if proof {
        expected.push(ChainRequest::HistoricalHeaderProof {
            height: start,
            checkpoint_height: fixture.tip(),
        });
    }
    for height in start + 1..=fixture.tip() {
        expected.push(ChainRequest::HeaderSyncFromLocator {
            start_height: height,
            count: 1,
            locator: fixture.hash(height - 1),
        });
    }
    expected.push(ChainRequest::HeaderSync {
        start_height: fixture.tip() + 1,
        count: 1,
    });
    expected.push(ChainRequest::WalletRefresh {
        interests: interests(),
        from_height: Some(floor),
    });
    expected
}

fn assert_staged_reads(peer: &Peer, before: &RetainedHeaders) {
    for read in peer.reads().iter().filter(|read| {
        matches!(
            read.request,
            ChainRequest::HistoricalHeaderProof { .. } | ChainRequest::HeaderSyncFromLocator { .. }
        )
    }) {
        assert_eq!(
            read.retained, *before,
            "provider observed partially published recovery"
        );
    }
}

#[tokio::test]
async fn proof_then_ordinary_refresh_prune_and_recover_an_older_floor() {
    assert_eq!(
        ProgressiveSyncConfig::default().retained_header_window,
        2_016
    );
    let fixture = Fixture::new();
    let store = fixture.store([0]);
    let before = snapshot(&store);
    let (mut service, peer) = fixture.service(ProtocolFamily::Bip37, true, store.clone());
    let mut worker = fixture.worker(&store);

    let route = accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
    assert_eq!(
        peer.requests(),
        expected_requests(&fixture, FLOOR - 1, true, FLOOR)
    );
    assert_staged_reads(&peer, &before);
    assert_eq!(store.range_inclusive(FLOOR - 1, TIP).unwrap().len(), 4);
    assert!(
        store.hash_at(1).is_none(),
        "SHV need not replay the unrelated prefix"
    );
    assert_eq!(worker.proven_shv_route, Some(route.clone()));

    peer.reads.lock().unwrap().clear();
    accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
    assert_eq!(
        peer.requests(),
        expected_requests(&fixture, TIP, false, FLOOR)
    );
    worker.prune_after_sync(&service, &route);
    assert_eq!(store.retained_span(), Some((TIP - WINDOW + 1, TIP)));
    assert!(store.hash_at(FLOOR - 1).is_none());
    assert!(snapshot(&store).header_at(TIP).is_some());

    peer.reads.lock().unwrap().clear();
    let pruned = snapshot(&store);
    accepted_refresh(&fixture, &mut worker, &mut service, 2).await;
    assert_eq!(peer.requests(), expected_requests(&fixture, 1, true, 2));
    assert_staged_reads(&peer, &pruned);
    assert_eq!(store.range_inclusive(1, TIP).unwrap().len(), TIP as usize);
}

#[tokio::test]
async fn serialized_view_with_only_its_tip_recovers_the_actual_wallet_scan_range() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        let store = fixture.store([TIP]);
        let before = snapshot(&store);
        let (mut service, peer) = fixture.service(protocol, true, store.clone());
        let mut worker = fixture.worker(&store);
        assert!(worker.reconciliation().authoritative.is_none());
        assert!(
            worker.proven_shv_route.is_none(),
            "a restored MMR is not proof of this peer's service"
        );
        accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
        let start = if protocol == ProtocolFamily::Bip37 {
            FLOOR - 1
        } else {
            0
        };
        assert_eq!(
            peer.requests(),
            expected_requests(&fixture, start, true, FLOOR)
        );
        assert_staged_reads(&peer, &before);
        assert_eq!(
            store.range_inclusive(start, TIP).unwrap().len(),
            (TIP - start + 1) as usize
        );
    }
}

#[tokio::test]
async fn pruning_requires_a_proven_still_allowed_exact_route_and_neutrino_keeps_hashes() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        let store = fixture.store(0..=TIP);
        let (mut service, peer) = fixture.service(protocol, true, store.clone());
        let mut worker = fixture.worker(&store);
        let route = accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
        assert_eq!(
            peer.requests(),
            expected_requests(&fixture, TIP, false, FLOOR)
        );
        worker.prune_after_sync(&service, &route);
        assert!(worker.proven_shv_route.is_none());
        assert_eq!(
            store.range_inclusive(0, TIP).unwrap().len(),
            (TIP + 1) as usize
        );
        assert!(snapshot(&store).header_at(1).is_none());

        // Reconstruct into a fresh provider store, proving service on this route.
        let store = fixture.store([TIP]);
        let (mut service, _) = fixture.service(protocol, true, store.clone());
        let mut worker = fixture.worker(&store);
        let route = accepted_refresh(&fixture, &mut worker, &mut service, 1).await;
        assert!(worker.proven_shv_route.is_some());

        let mut other = Peer::new(&fixture, protocol, true, store.clone());
        other.endpoint.port = Some(18445);
        let other = register_peer(&mut service, other);
        let other_route = service
            .routes_for_operation(ChainOperation::WalletRefresh)
            .into_iter()
            .find(|candidate| candidate.endpoint.as_ref() == Some(&other.endpoint))
            .unwrap();
        worker.prune_after_sync(&service, &other_route);
        assert_eq!(
            store.hash_at(0),
            Some(fixture.hash(0)),
            "proof for a different endpoint grants nothing"
        );

        service
            .catalog_mut()
            .set_disposition(&route.source, SourceDisposition::Banned)
            .unwrap();
        worker.prune_after_sync(&service, &route);
        assert_eq!(
            store.hash_at(0),
            Some(fixture.hash(0)),
            "a stale proven route cannot prune hashes"
        );
        service
            .catalog_mut()
            .set_disposition(&route.source, SourceDisposition::Enabled)
            .unwrap();
        worker.prune_after_sync(&service, &route);
        assert_eq!(
            store.hash_at(0),
            if protocol == ProtocolFamily::Neutrino {
                Some(fixture.hash(0))
            } else {
                None
            }
        );
        assert!(snapshot(&store).header_at(1).is_none());
        assert!(snapshot(&store).header_at(TIP).is_some());
        assert!(other.requests().is_empty());
    }
}

#[tokio::test]
async fn malformed_proof_request_bindings_never_publish_or_accept_a_wallet() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        for fault in [Fault::WrongHeight, Fault::WrongCheckpoint] {
            let store = fixture.store([0]);
            let before = snapshot(&store);
            let (mut service, peer) = fixture.service(protocol, true, store.clone());
            peer.fail_with(fault);
            let mut worker = fixture.worker(&store);
            refused_refresh(&mut worker, &mut service, &peer, FLOOR, &before).await;
            let start = if protocol == ProtocolFamily::Bip37 {
                FLOOR - 1
            } else {
                0
            };
            assert_eq!(
                peer.requests(),
                vec![ChainRequest::HistoricalHeaderProof {
                    height: start,
                    checkpoint_height: TIP
                }],
                "{protocol:?}: {fault:?}"
            );
            assert!(worker.reconciliation().authoritative.is_none());
        }
    }
}

#[tokio::test]
async fn late_tail_failures_preserve_both_fresh_and_previously_accepted_wallets() {
    let fixture = Fixture::new();
    for baseline in [false, true] {
        for fault in [
            Fault::EmptyTail,
            Fault::WrongTailHeight,
            Fault::UnlinkedTail,
            Fault::OtherTip,
        ] {
            let store = fixture.store([0]);
            let (mut service, peer) = fixture.service(ProtocolFamily::Bip37, true, store.clone());
            let mut worker = fixture.worker(&store);
            if baseline {
                let route = accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
                worker.prune_after_sync(&service, &route);
                peer.reads.lock().unwrap().clear();
            }
            let before = snapshot(&store);
            peer.fail_with(fault);
            let floor = if baseline { 2 } else { FLOOR };
            refused_refresh(&mut worker, &mut service, &peer, floor, &before).await;
            assert_eq!(worker.reconciliation().authoritative.is_some(), baseline);
            let expected = expected_requests(&fixture, floor - 1, true, floor);
            assert_eq!(
                peer.requests(),
                expected[..expected.len() - 2],
                "{fault:?}, baseline={baseline}"
            );
            assert_staged_reads(&peer, &before);
        }
    }
}

#[tokio::test]
async fn peers_without_shv_replay_from_genesis_and_keep_compatibility_hashes() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        let store = fixture.store([TIP]);
        let before = snapshot(&store);
        let (mut service, peer) = fixture.service(protocol, false, store.clone());
        let mut worker = fixture.worker(&store);
        let route = accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
        assert_eq!(
            peer.requests(),
            expected_requests(&fixture, 0, false, FLOOR)
        );
        assert_staged_reads(&peer, &before);
        assert!(worker.proven_shv_route.is_none());
        assert_eq!(
            worker.header_view().unwrap().checkpoint(),
            fixture.view.checkpoint()
        );
        worker.prune_after_sync(&service, &route);
        assert_eq!(
            store.range_inclusive(0, TIP).unwrap().len(),
            (TIP + 1) as usize
        );
        assert!(snapshot(&store).header_at(1).is_none());
        assert!(snapshot(&store).header_at(TIP).is_some());
    }
}

#[tokio::test]
async fn unavailable_or_invalid_proof_replays_independently_on_the_same_route() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        for fault in [
            Fault::Unsupported,
            Fault::Timeout,
            Fault::WrongRoot,
            Fault::WrongSibling,
            Fault::WrongProofHeader,
        ] {
            let store = fixture.store([0]);
            let before = snapshot(&store);
            let (mut service, peer) = fixture.service(protocol, true, store.clone());
            peer.fail_with(fault);
            let mut worker = fixture.worker(&store);
            let route = accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
            let start = if protocol == ProtocolFamily::Bip37 {
                FLOOR - 1
            } else {
                0
            };
            let mut expected = vec![ChainRequest::HistoricalHeaderProof {
                height: start,
                checkpoint_height: TIP,
            }];
            expected.extend(expected_requests(&fixture, 0, false, FLOOR));
            assert_eq!(peer.requests(), expected, "{protocol:?}: {fault:?}");
            assert_staged_reads(&peer, &before);
            assert!(service
                .matching_route_for_operation(&route, ChainOperation::HeaderSync)
                .is_some());
            assert!(
                worker.proven_shv_route.is_none(),
                "optional failure cannot grant pruning authority"
            );
            worker.prune_after_sync(&service, &route);
            assert_eq!(store.hash_at(0), Some(fixture.hash(0)));
            assert!(store.range_inclusive(0, TIP).is_ok());
            assert!(snapshot(&store).header_at(1).is_none());
        }
    }
}

#[tokio::test]
async fn invalid_proof_fallback_still_rejects_wrong_commitment_revocation_and_store_change() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        let store = fixture.store([TIP]);
        let before = snapshot(&store);
        let (mut service, peer) = fixture.service(protocol, true, store.clone());
        peer.fail_with(Fault::WrongProofAndOtherTip);
        let mut worker = fixture.worker(&store);
        refused_refresh(&mut worker, &mut service, &peer, FLOOR, &before).await;
        assert!(peer.requests().iter().any(|r| matches!(
            r,
            ChainRequest::HeaderSyncFromLocator {
                start_height: 1,
                ..
            }
        )));
        assert!(worker
            .reconciliation()
            .sync
            .degraded_reason
            .as_ref()
            .unwrap()
            .contains("CommitmentMismatch"));

        for revoke in [false, true] {
            let store = fixture.store([TIP]);
            let mut expected = snapshot(&store);
            let (mut service, peer) = fixture.service(protocol, true, store.clone());
            peer.fail_with(Fault::WrongSibling);
            *peer.interrupt.lock().unwrap() = Some(Interrupt {
                at: InterruptAt::Proof,
                revoke: revoke.then(|| service.revocation()),
            });
            if !revoke {
                expected.drop_headers_below(TIP + 1);
            }
            let mut worker = fixture.worker(&store);
            refused_refresh(&mut worker, &mut service, &peer, FLOOR, &expected).await;
            if revoke {
                assert_eq!(peer.requests().len(), 1, "revocation must not start replay");
            }
        }
    }
}

#[tokio::test]
async fn selected_source_bans_and_endpoint_scoping_never_borrow_another_peers_proof() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        for (shv, banned) in [(false, false), (true, false), (true, true)] {
            let store = fixture.store([0]);
            let before = snapshot(&store);
            let (mut service, peer) = fixture.service(protocol, shv, store.clone());
            let mut worker = fixture.worker(&store);
            service.set_policy(ConnectionPolicy::exact(peer.id.clone(), protocol));
            let mut outside = Peer::new(&fixture, protocol, true, store.clone());
            outside.id = SourceId::new("unselected-peer");
            outside.endpoint.host = "unselected-peer.invalid".into();
            let outside = register_peer(&mut service, outside);
            if banned {
                service
                    .catalog_mut()
                    .set_disposition(&peer.id, SourceDisposition::Banned)
                    .unwrap();
                refused_refresh(&mut worker, &mut service, &peer, FLOOR, &before).await;
                assert!(peer.requests().is_empty());
            } else if shv {
                peer.fail_with(Fault::WrongRoot);
                let route = accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
                assert_eq!(route.endpoint.as_ref(), Some(&peer.endpoint));
                assert!(worker.proven_shv_route.is_none());
                assert_eq!(
                    peer.requests().len(),
                    expected_requests(&fixture, 0, false, FLOOR).len() + 1
                );
            } else {
                // Even an allowed SHV endpoint belonging to this same source
                // cannot provide a proof for the chosen non-SHV wallet route.
                let mut sibling = Peer::new(&fixture, protocol, true, store.clone());
                sibling.endpoint.port = Some(18445);
                let sibling = register_peer(&mut service, sibling);
                let route = accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
                assert_eq!(route.endpoint.as_ref(), Some(&peer.endpoint));
                assert_eq!(
                    peer.requests(),
                    expected_requests(&fixture, 0, false, FLOOR)
                );
                assert!(sibling.requests().is_empty());
                assert!(worker.proven_shv_route.is_none());
            }
            assert!(
                outside.requests().is_empty(),
                "selection must not broaden on missing proof or failure"
            );
        }
    }
}

#[tokio::test]
async fn revocation_and_same_generation_store_mutation_refuse_proof_and_replay_atomically() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        for (shv, at) in [
            (true, InterruptAt::Proof),
            (true, InterruptAt::LastTail),
            (false, InterruptAt::LastTail),
        ] {
            for revoke in [false, true] {
                let store = fixture.store([TIP]);
                let before = snapshot(&store);
                let (mut service, peer) = fixture.service(protocol, shv, store.clone());
                let mut worker = fixture.worker(&store);
                let mut expected = before.clone();
                if !revoke {
                    expected.drop_headers_below(TIP + 1);
                    assert_ne!(expected, before, "the injected mutation must be observable");
                    assert_eq!(expected.generation(), before.generation());
                    assert_eq!(expected.retained_span(), before.retained_span());
                    assert_eq!(expected.hash_at(TIP), before.hash_at(TIP));
                }
                *peer.interrupt.lock().unwrap() = Some(Interrupt {
                    at,
                    revoke: revoke.then(|| service.revocation()),
                });
                refused_refresh(&mut worker, &mut service, &peer, FLOOR, &expected).await;
                assert!(
                    peer.interrupt.lock().unwrap().is_none(),
                    "{protocol:?}: hook {at:?} was never reached"
                );
                assert_eq!(service.revocation().is_revoked(), revoke);
                assert!(worker.reconciliation().authoritative.is_none());
                assert!(
                    !peer
                        .requests()
                        .iter()
                        .any(|request| matches!(request, ChainRequest::HeaderSync { .. })),
                    "ordinary wallet preparation must not run after rejected recovery"
                );
                if matches!(at, InterruptAt::LastTail) {
                    assert_staged_reads(&peer, &before);
                    assert!(matches!(
                        peer.requests().last(),
                        Some(ChainRequest::HeaderSyncFromLocator {
                            start_height: TIP,
                            ..
                        })
                    ));
                }
            }
        }
    }
}

#[tokio::test]
async fn ordinary_replay_checks_declared_work_and_the_full_mmr_before_publication() {
    let fixture = Fixture::new();
    for protocol in PROTOCOLS {
        for fault in [Fault::InvalidWork, Fault::OtherTip] {
            let store = fixture.store([0]);
            let before = snapshot(&store);
            let (mut service, peer) = fixture.service(protocol, false, store.clone());
            peer.fail_with(fault);
            let mut worker = fixture.worker(&store);
            refused_refresh(&mut worker, &mut service, &peer, FLOOR, &before).await;
            let expected = expected_requests(&fixture, 0, false, FLOOR);
            assert_eq!(
                peer.requests(),
                expected[..expected.len() - 2],
                "{protocol:?}: {fault:?}"
            );
            assert_staged_reads(&peer, &before);
            let reason = worker
                .reconciliation()
                .sync
                .degraded_reason
                .as_deref()
                .unwrap();
            assert!(
                reason.contains(if fault == Fault::OtherTip {
                    "CommitmentMismatch"
                } else {
                    "InsufficientWork"
                }),
                "{reason}"
            );
        }
    }
}

#[tokio::test]
async fn ordinary_refresh_refuses_same_generation_mutation_and_revocation_between_batches() {
    let fixture = Fixture::new();
    let advanced = Fixture::with_tip(TIP + 2);
    for protocol in PROTOCOLS {
        for revoke in [false, true] {
            let store = fixture.store(0..=TIP);
            let (mut service, _) = fixture.service(protocol, false, store.clone());
            let mut worker = fixture.worker(&store);
            accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
            let before = snapshot(&store);
            let mut expected = before.clone();
            if !revoke {
                expected.drop_headers_below(TIP + 1);
                assert_ne!(expected, before);
                assert_eq!(expected.generation(), before.generation());
                assert_eq!(expected.retained_span(), before.retained_span());
                assert_eq!(
                    expected.range_inclusive(0, TIP),
                    before.range_inclusive(0, TIP)
                );
            }

            // The same endpoint now has two more valid headers. Intervene
            // after the first batch has been verified but before publication.
            let mut live_peer = Peer::new(&fixture, protocol, false, store.clone());
            live_peer
                .headers
                .extend_from_slice(&advanced.headers[TIP as usize + 1..]);
            let mut service = ChainService::new(SourceCatalog::default(), ConnectionPolicy::auto());
            let peer = register_peer(&mut service, live_peer);
            *peer.interrupt.lock().unwrap() = Some(Interrupt {
                at: InterruptAt::Ordinary(TIP + 2),
                revoke: revoke.then(|| service.revocation()),
            });
            refused_refresh(&mut worker, &mut service, &peer, FLOOR, &expected).await;
            assert!(peer.interrupt.lock().unwrap().is_none());
            assert_eq!(service.revocation().is_revoked(), revoke);
            assert_eq!(worker.header_view().unwrap().tip(), fixture.view.tip());
            assert!(
                store.hash_at(TIP + 1).is_none(),
                "even the first valid batch must stay private"
            );
            let last_request = if revoke { TIP + 2 } else { TIP + 3 };
            assert_eq!(
                peer.requests(),
                (TIP + 1..=last_request)
                    .map(|start_height| ChainRequest::HeaderSync {
                        start_height,
                        count: 1
                    })
                    .collect::<Vec<_>>()
            );
            for read in peer.reads().iter().take(2) {
                assert_eq!(read.retained, before);
            }
        }
    }
}

#[tokio::test]
async fn ordinary_publication_rechecks_revocation_and_stages_every_insert() {
    let fixture = Fixture::new();
    let advanced = Fixture::with_tip(TIP + 2);
    for protocol in PROTOCOLS {
        for conflict in [false, true] {
            let store = fixture.store(0..=TIP);
            let (mut service, _) = fixture.service(protocol, false, store.clone());
            let mut worker = fixture.worker(&store);
            accepted_refresh(&fixture, &mut worker, &mut service, FLOOR).await;
            let accepted = worker.reconciliation().authoritative.clone();
            let original_view = worker.header_view().unwrap().encode().unwrap();
            let mut candidate_view = worker.header_view().unwrap().clone();
            candidate_view
                .extend(&advanced.headers[TIP as usize + 1..])
                .unwrap();
            let staged = (TIP + 1..=TIP + 2)
                .map(|height| (height, advanced.headers[height as usize].clone()))
                .collect::<Vec<_>>();

            if conflict {
                // The first insertion is valid; the second contradicts an
                // already accepted hash. No prefix may escape on that error.
                let mut fork = advanced.headers[TIP as usize + 2].0;
                fork[36] ^= 1;
                let fork = mine(fork);
                assert_ne!(sha256d(&fork.0), advanced.hash(TIP + 2));
                store.write(|retained| retained.insert_hash_only(TIP + 2, sha256d(&fork.0)));
            }
            let (revision, before) = store.snapshot(Clone::clone);
            if !conflict {
                // Exercise cancellation after acquisition/verification, beyond
                // ChainService's post-response check, without timing or sleeps.
                service.revocation().revoke();
            }
            assert!(worker
                .publish_headers(candidate_view, staged, Some(&revision), &service, None)
                .is_err());
            assert_eq!(snapshot(&store), before);
            assert!(store.hash_at(TIP + 1).is_none());
            assert_eq!(
                worker.header_view().unwrap().encode().unwrap(),
                original_view
            );
            assert_eq!(worker.reconciliation().authoritative, accepted);
        }
    }
}

fn date_restore(fixture: &Fixture) -> WalletRestoreState {
    let oldest = fixture.view.times().oldest().unwrap();
    assert_eq!(oldest.height, 16);
    let restore = WalletRestoreState::new(WalletBirthday::ImportedAtTime {
        requested_time: oldest.median_time_past + 600,
    });
    assert_eq!(
        restore.scan_floor(&fixture.view, 0, None),
        ScanFloor::Complete { from_height: 16 }
    );
    restore
}

fn assert_date_ready(
    fixture: &Fixture,
    worker: &ProgressiveSyncWorker,
    restore: &WalletRestoreState,
) {
    let view = worker.header_view().unwrap();
    assert_eq!(
        view.tip(),
        fixture.view.tip(),
        "date recovery must not invent a newer tip"
    );
    assert_eq!(view.checkpoint(), fixture.view.checkpoint());
    assert_eq!(view.anchor_authentication(), (2, 2));
    assert_eq!(
        restore.scan_floor(view, 0, None),
        ScanFloor::Complete { from_height: 16 }
    );
}

#[tokio::test]
async fn unchanged_tip_reauthenticates_restored_dates_from_retained_raw_windows() {
    let fixture = Fixture::with_tip(32);
    let restore = date_restore(&fixture);
    for protocol in PROTOCOLS {
        let store = fixture.store(0..=fixture.tip());
        let before = snapshot(&store);
        let (mut service, peer) = fixture.service(protocol, true, store.clone());
        let mut worker = fixture.worker(&store);
        assert_eq!(
            worker.header_view().unwrap().anchor_authentication(),
            (0, 2)
        );
        assert!(matches!(
            restore.scan_floor(worker.header_view().unwrap(), 0, None),
            ScanFloor::Undecidable(_)
        ));
        let route = service
            .routes_for_operation(ChainOperation::WalletRefresh)
            .remove(0);

        // This is the header-only preflight used before the actor retries its
        // unresolved date birthday. No wallet snapshot may precede resolution.
        worker
            .prime_headers_on_same_route(&mut service, &route)
            .await
            .unwrap();
        assert_date_ready(&fixture, &worker, &restore);
        assert!(worker.reconciliation().authoritative.is_none());
        assert_eq!(snapshot(&store), before);
        assert_eq!(
            peer.requests(),
            vec![ChainRequest::HeaderSync {
                start_height: 33,
                count: 1
            }]
        );
        peer.reads.lock().unwrap().clear();
        accepted_refresh(&fixture, &mut worker, &mut service, 16).await;
        assert_eq!(
            peer.requests(),
            expected_requests(&fixture, fixture.tip(), false, 16)
        );
        assert_date_ready(&fixture, &worker, &restore);
    }
}

#[tokio::test]
async fn date_preflight_recovers_missing_raw_windows_even_with_a_complete_hash_range() {
    let fixture = Fixture::with_tip(32);
    let restore = date_restore(&fixture);
    for protocol in PROTOCOLS {
        for shv in [false, true] {
            for hashes_only in [false, true] {
                let store = if hashes_only {
                    let store = fixture.store(0..=fixture.tip());
                    store.write(|retained| retained.drop_headers_below(fixture.tip() + 1));
                    assert!(store.range_inclusive(0, fixture.tip()).is_ok());
                    store
                } else {
                    fixture.store([fixture.tip()])
                };
                let before = snapshot(&store);
                let (mut service, peer) = fixture.service(protocol, shv, store.clone());
                let mut worker = fixture.worker(&store);
                assert!(matches!(
                    restore.scan_floor(worker.header_view().unwrap(), 0, None),
                    ScanFloor::Undecidable(_)
                ));
                let route = service
                    .routes_for_operation(ChainOperation::WalletRefresh)
                    .remove(0);
                worker
                    .prime_headers_on_same_route(&mut service, &route)
                    .await
                    .unwrap();

                assert_staged_reads(&peer, &before);
                let mut expected = expected_requests(&fixture, 0, shv, 16);
                expected.pop(); // Preflight resolves a floor; it does not scan the wallet yet.
                assert_eq!(
                    peer.requests(),
                    expected,
                    "{protocol:?}: SHV={shv}, hashes_only={hashes_only}"
                );
                assert_eq!(worker.proven_shv_route.is_some(), shv);
                assert_date_ready(&fixture, &worker, &restore);
                assert!(worker.reconciliation().authoritative.is_none());
                let recovered = snapshot(&store);
                for anchor in [16, 32] {
                    for height in anchor - 10..=anchor {
                        assert_eq!(
                            recovered.header_at(height),
                            Some(&fixture.headers[height as usize])
                        );
                    }
                }
                peer.reads.lock().unwrap().clear();
                accepted_refresh(&fixture, &mut worker, &mut service, 16).await;
                assert_eq!(
                    peer.requests(),
                    expected_requests(&fixture, fixture.tip(), false, 16)
                );
                assert_date_ready(&fixture, &worker, &restore);
            }
        }
    }
}

#[tokio::test]
async fn corrupt_later_median_cannot_publish_partial_date_authentication() {
    let fixture = Fixture::with_tip(32);
    let restore = date_restore(&fixture);
    let mut record: serde_json::Value =
        serde_json::from_str(&fixture.view.encode().unwrap()).unwrap();
    assert_eq!(record["anchors"].as_array().unwrap().len(), 2);
    // Keep ordering valid so restoration accepts the hint. The first anchor's
    // genuine window will authenticate before the second window detects this.
    let median = record["anchors"][1]["median_time_past"].as_u64().unwrap();
    record["anchors"][1]["median_time_past"] = serde_json::json!(median + 1);
    for protocol in PROTOCOLS {
        for shv in [false, true] {
            for missing_raw in [false, true] {
                let restored = VerifiedHeaderView::restore(
                    &record.to_string(),
                    Network::Regtest,
                    &fixture.view.checkpoint(),
                )
                .unwrap();
                assert_eq!(restored.anchor_authentication(), (0, 2));
                let store = fixture.store(0..=fixture.tip());
                let authenticated_headers = snapshot(&store);
                let (mut service, peer) = fixture.service(protocol, shv, store.clone());
                let mut worker = fixture.worker(&store);
                let route = accepted_refresh(&fixture, &mut worker, &mut service, 16).await;
                let accepted = worker.reconciliation().authoritative.clone();
                worker = worker.with_header_view(restored).unwrap();
                peer.reads.lock().unwrap().clear();
                if missing_raw {
                    store.write(|retained| retained.drop_headers_below(fixture.tip() + 1));
                }
                let before = snapshot(&store);
                let original_view = worker.header_view().unwrap().encode().unwrap();
                let error = worker
                    .prime_headers_on_same_route(&mut service, &route)
                    .await
                    .unwrap_err();
                assert!(format!("{error:?}").contains("MedianTimeMismatch"));
                assert_staged_reads(&peer, &before);
                let expected_requests = if missing_raw {
                    let mut requests = expected_requests(&fixture, 0, shv, 16);
                    requests.truncate(requests.len() - 2);
                    requests
                } else {
                    Vec::new()
                };
                assert_eq!(peer.requests(), expected_requests);
                // A successful proof/replay may hydrate the authenticated
                // cache before candidate time reauthentication rejects a hint.
                assert_eq!(snapshot(&store), authenticated_headers);
                assert_eq!(
                    worker.header_view().unwrap().encode().unwrap(),
                    original_view
                );
                assert_eq!(
                    worker.header_view().unwrap().anchor_authentication(),
                    (0, 2)
                );
                assert_eq!(worker.reconciliation().authoritative, accepted);
                assert!(matches!(
                    restore.scan_floor(worker.header_view().unwrap(), 0, None),
                    ScanFloor::Undecidable(_)
                ));

                assert!(worker
                    .refresh_with_scope(&mut service, interests(), scope(16))
                    .await
                    .is_err());
                assert_eq!(worker.reconciliation().authoritative, accepted);
                assert_eq!(
                    worker.header_view().unwrap().encode().unwrap(),
                    original_view
                );
                assert_eq!(
                    worker.header_view().unwrap().anchor_authentication(),
                    (0, 2)
                );
                assert_eq!(snapshot(&store), authenticated_headers);
                assert_eq!(
                    peer.requests(),
                    expected_requests,
                    "invalid dates must prevent the wallet request"
                );
                assert!(worker
                    .reconciliation()
                    .sync
                    .degraded_reason
                    .as_deref()
                    .unwrap()
                    .contains("MedianTimeMismatch"));
            }
        }
    }
}
