//! The dense, bounded half of the runtime's block-header authority.
//!
//! [`crate::header_view::VerifiedHeaderView`] already owns the accumulator and
//! the sparse anchor index. Those answer "what does the chain commit to" and
//! "which height was around this time", but they cannot answer the question a
//! wallet scan actually asks:
//!
//! > give me the hash of every block from height A to height B.
//!
//! A Bloom scan needs one `getdata` per block in the range, and a compact-filter
//! batch needs the same range plus its preceding context. Both providers grew
//! their own `BTreeMap<u32, [u8; 32]>` to serve that, which made each of them a
//! second accepted-chain store. This is that storage, owned once.
//!
//! # What it is not
//!
//! Not the full chain. Retention is bounded and pruning is expected: this holds
//! a window, and a request outside it is reported as a gap rather than guessed
//! at. Recovering an older range is a separate, authenticated operation.
//!
//! Storage is linear in retained entries. Each entry has a hash and an inline
//! optional header slot, plus map overhead; dropping a header does not shrink
//! that slot. Only the accumulator peaks are O(log n).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

use optn_core::header_hash::sha256d;

use crate::chain::{BlockHeaderBytes, Hash32};

/// Which accepted chain a projection was built against.
///
/// Bumped whenever a reorg invalidates retained history. A provider-local cache
/// stamped with an older generation is stale by construction, which is what
/// lets a disposable projection stay disposable instead of quietly serving
/// hashes from a chain that no longer exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct ChainGeneration(u64);

impl ChainGeneration {
    pub const fn value(self) -> u64 {
        self.0
    }

    const fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderStoreError {
    /// A height was requested that is not retained. Carries the gap so the
    /// caller can decide between recovery and reporting reduced coverage --
    /// never a silent empty result.
    NotRetained {
        requested: u32,
        retained: Option<(u32, u32)>,
    },
    /// The range is inverted.
    EmptyRange { start: u32, end: u32 },
    /// The stored range has a hole in it, so it cannot answer contiguously.
    Discontiguous { missing: u32 },
    /// A header did not link to the block already retained beneath it.
    Linkage { height: u32 },
    /// Recovery must not replace an already accepted hash with another chain.
    ConflictingHash { height: u32 },
    /// Recovery batches contain authenticated raw headers, not hash assertions.
    MissingHeader { height: u32 },
    /// The runtime withdrew permission after validation, before publication.
    PublicationCancelled,
}

/// One retained block. The header is optional: a pruned tail can keep the hash
/// (which a locator and a `getdata` both need) after dropping the 80 bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Retained {
    hash: Hash32,
    header: Option<BlockHeaderBytes>,
}

/// Dense, bounded, authoritative height/hash storage for one accepted chain.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RetainedHeaders {
    by_height: BTreeMap<u32, Retained>,
    by_hash: HashMap<Hash32, u32>,
    generation: ChainGeneration,
}

impl RetainedHeaders {
    pub fn new() -> Self {
        Self::default()
    }

    pub const fn generation(&self) -> ChainGeneration {
        self.generation
    }

    pub fn len(&self) -> usize {
        self.by_height.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_height.is_empty()
    }

    /// Lowest and highest retained heights.
    pub fn retained_span(&self) -> Option<(u32, u32)> {
        let first = *self.by_height.keys().next()?;
        let last = *self.by_height.keys().next_back()?;
        Some((first, last))
    }

    pub fn tip(&self) -> Option<(u32, Hash32)> {
        let (height, entry) = self.by_height.iter().next_back()?;
        Some((*height, entry.hash))
    }

    pub fn hash_at(&self, height: u32) -> Option<Hash32> {
        Some(self.by_height.get(&height)?.hash)
    }

    /// Reverse lookup. `getheaders` answers with a *hash*, and a locator entry
    /// comes back as one, so the store has to be able to say what height that
    /// was without a scan.
    pub fn height_of(&self, hash: &Hash32) -> Option<u32> {
        self.by_hash.get(hash).copied()
    }

    pub fn header_at(&self, height: u32) -> Option<&BlockHeaderBytes> {
        self.by_height.get(&height)?.header.as_ref()
    }

    /// Check contiguous coverage without allocating a copy of the hash range.
    pub(crate) fn covers_range(&self, start: u32, end: u32) -> bool {
        start <= end
            && self
                .by_height
                .range(start..=end)
                .map(|(h, _)| *h)
                .eq(start..=end)
    }

    /// Atomically merge an independently authenticated batch. Validate every
    /// conflict and boundary before writing anything; an error leaves the
    /// accepted store untouched. Work is proportional to incoming headers,
    /// not to the entire previously retained chain.
    pub(crate) fn merge_verified(
        &mut self,
        incoming: Self,
        may_publish: impl FnOnce() -> bool,
    ) -> Result<(), HeaderStoreError> {
        let mut previous_height: Option<u32> = None;
        for (&height, entry) in &incoming.by_height {
            if let Some(previous) = previous_height {
                if previous.checked_add(1) != Some(height) {
                    return Err(HeaderStoreError::Discontiguous {
                        missing: previous.saturating_add(1),
                    });
                }
            }
            previous_height = Some(height);
            let header = entry
                .header
                .as_ref()
                .ok_or(HeaderStoreError::MissingHeader { height })?;
            if self.hash_at(height).is_some_and(|hash| hash != entry.hash) {
                return Err(HeaderStoreError::ConflictingHash { height });
            }
            if let Some(previous) = height
                .checked_sub(1)
                .and_then(|h| incoming.hash_at(h).or_else(|| self.hash_at(h)))
            {
                if header.0[4..36] != previous {
                    return Err(HeaderStoreError::Linkage { height });
                }
            }
            if let Some(next_height) = height.checked_add(1) {
                if self
                    .header_at(next_height)
                    .is_some_and(|next| next.0[4..36] != entry.hash)
                {
                    return Err(HeaderStoreError::Linkage {
                        height: next_height,
                    });
                }
            }
        }
        if !may_publish() {
            return Err(HeaderStoreError::PublicationCancelled);
        }
        // No fallible validation remains. Keep existing generation, hashes and
        // headers outside this batch, including retained history after its tip.
        for (height, entry) in incoming.by_height {
            self.by_hash.insert(entry.hash, height);
            self.by_height.insert(height, entry);
        }
        Ok(())
    }

    /// Append a verified header, checking it links to what is already there.
    ///
    /// Linkage is checked against the retained predecessor when there is one.
    /// This is a storage-integrity check, not a substitute for the verifier:
    /// proof-of-work and difficulty are settled before anything reaches here.
    pub fn insert_verified(
        &mut self,
        height: u32,
        header: BlockHeaderBytes,
    ) -> Result<(), HeaderStoreError> {
        if let Some(previous) = height.checked_sub(1).and_then(|h| self.by_height.get(&h)) {
            let mut prev_hash = [0u8; 32];
            prev_hash.copy_from_slice(&header.0[4..36]);
            if prev_hash != previous.hash {
                return Err(HeaderStoreError::Linkage { height });
            }
        }
        let hash = sha256d(&header.0);
        if let Some(displaced) = self.by_height.insert(
            height,
            Retained {
                hash,
                header: Some(header),
            },
        ) {
            self.by_hash.remove(&displaced.hash);
        }
        self.by_hash.insert(hash, height);
        Ok(())
    }

    /// Record a height whose hash is known but whose header is not retained.
    ///
    /// The same shape a pruned tail has. Used to seed a network's genesis,
    /// which is chain identity rather than something a peer supplied.
    pub fn insert_hash_only(&mut self, height: u32, hash: Hash32) {
        if let Some(displaced) = self
            .by_height
            .insert(height, Retained { hash, header: None })
        {
            self.by_hash.remove(&displaced.hash);
        }
        self.by_hash.insert(hash, height);
    }

    /// Every `(height, hash)` from `start` to `end` inclusive.
    ///
    /// Contiguous or nothing. A Bloom scan issues one request per entry, so a
    /// silently short range would look like a block with no wallet activity
    /// rather than a block that was never examined.
    pub fn range_inclusive(
        &self,
        start: u32,
        end: u32,
    ) -> Result<Vec<(u32, Hash32)>, HeaderStoreError> {
        if start > end {
            return Err(HeaderStoreError::EmptyRange { start, end });
        }
        let retained = self.retained_span();
        if !self.by_height.contains_key(&start) {
            return Err(HeaderStoreError::NotRetained {
                requested: start,
                retained,
            });
        }
        if !self.by_height.contains_key(&end) {
            return Err(HeaderStoreError::NotRetained {
                requested: end,
                retained,
            });
        }
        let mut out = Vec::with_capacity((end - start + 1) as usize);
        for height in start..=end {
            let Some(entry) = self.by_height.get(&height) else {
                return Err(HeaderStoreError::Discontiguous { missing: height });
            };
            out.push((height, entry.hash));
        }
        Ok(out)
    }

    /// The `count` blocks immediately before `height`, oldest first.
    ///
    /// A compact-filter batch is validated against the filter header that
    /// precedes it, and a median-time window is the eleven blocks before a
    /// height. Both are this operation.
    pub fn preceding(
        &self,
        height: u32,
        count: usize,
    ) -> Result<Vec<(u32, Hash32)>, HeaderStoreError> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let start = height.saturating_sub(count as u32);
        let end = height.checked_sub(1).ok_or(HeaderStoreError::EmptyRange {
            start: height,
            end: height,
        })?;
        self.range_inclusive(start, end)
    }

    /// Drop everything below `height`, keeping the store a bounded window.
    ///
    /// Does not touch the generation: pruning narrows what can be answered, it
    /// does not invalidate what a projection already read.
    pub fn prune_below(&mut self, height: u32) {
        let dropped: Vec<u32> = self.by_height.range(..height).map(|(h, _)| *h).collect();
        for h in dropped {
            if let Some(entry) = self.by_height.remove(&h) {
                self.by_hash.remove(&entry.hash);
            }
        }
    }

    /// Drop the 80-byte headers below `height` while keeping their hashes.
    ///
    /// The cheap prune: a scan and a locator both need hashes, and only proof
    /// verification needs the header itself.
    pub fn drop_headers_below(&mut self, height: u32) {
        for (_, entry) in self.by_height.range_mut(..height) {
            entry.header = None;
        }
    }

    /// Invalidate everything at or above `height` after a reorg, and bump the
    /// generation so stale projections are detectable.
    pub fn rewind_to(&mut self, height: u32) {
        let dropped: Vec<u32> = self.by_height.range(height..).map(|(h, _)| *h).collect();
        for h in dropped {
            if let Some(entry) = self.by_height.remove(&h) {
                self.by_hash.remove(&entry.hash);
            }
        }
        self.generation = self.generation.next();
    }
}

/// Read access to the runtime's accepted block headers.
///
/// The contract providers see. Deliberately read-only: a provider fetches
/// headers and returns them as observations, and the runtime verifies them and
/// writes them here. Handing a provider a writer would put it back in the
/// business of deciding what the accepted chain is.
///
/// Neither provider implements this, and neither depends on the other to get
/// it: both are handed the same `Arc<dyn BlockHeaderSource>` by the runtime.
pub trait BlockHeaderSource: Send + Sync + std::fmt::Debug {
    /// Which accepted chain these answers belong to. A caller that caches
    /// anything derived from them compares this to detect a reorg.
    fn generation(&self) -> ChainGeneration;
    fn tip(&self) -> Option<(u32, Hash32)>;
    fn hash_at(&self, height: u32) -> Option<Hash32>;
    fn height_of(&self, hash: &Hash32) -> Option<u32>;
    fn retained_span(&self) -> Option<(u32, u32)>;
    /// Contiguous or an error. Never a short result.
    fn range_inclusive(&self, start: u32, end: u32)
        -> Result<Vec<(u32, Hash32)>, HeaderStoreError>;
    /// The `count` blocks before `height`, oldest first.
    fn preceding(&self, height: u32, count: usize) -> Result<Vec<(u32, Hash32)>, HeaderStoreError>;
}

/// The runtime's own store behind a shared lock, handed to providers as a
/// [`BlockHeaderSource`].
#[derive(Debug, Default)]
pub struct SharedHeaders(RwLock<SharedHeaderState>);

#[derive(Debug, Default)]
struct SharedHeaderState {
    headers: RetainedHeaders,
    revision: Arc<()>,
}

/// An identity token, not a chain generation. Every write invalidates it,
/// including pruning or replacement with an older clone. Holding the token
/// prevents address reuse (ABA); there is no wrapping integer counter.
#[derive(Debug, Clone)]
pub(crate) struct HeaderStoreRevision(Arc<()>);

impl SharedHeaders {
    pub fn new(headers: RetainedHeaders) -> Self {
        Self(RwLock::new(SharedHeaderState {
            headers,
            revision: Arc::new(()),
        }))
    }

    /// Write access, for the runtime only. Providers get the trait.
    pub fn write<R>(&self, edit: impl FnOnce(&mut RetainedHeaders) -> R) -> R {
        let mut state = self.0.write().expect("header store lock poisoned");
        state.revision = Arc::new(());
        edit(&mut state.headers)
    }

    pub(crate) fn read<R>(&self, view: impl FnOnce(&RetainedHeaders) -> R) -> R {
        view(&self.0.read().expect("header store lock poisoned").headers)
    }

    /// Capture a revision together with only the data the caller needs.
    pub(crate) fn snapshot<R>(
        &self,
        view: impl FnOnce(&RetainedHeaders) -> R,
    ) -> (HeaderStoreRevision, R) {
        let state = self.0.read().expect("header store lock poisoned");
        (
            HeaderStoreRevision(state.revision.clone()),
            view(&state.headers),
        )
    }

    /// Acquire the writer only if no intervening write occurred. The callback
    /// must validate its batch before mutation; stale revisions never run it.
    pub(crate) fn write_if_current<R>(
        &self,
        expected: &HeaderStoreRevision,
        edit: impl FnOnce(&mut RetainedHeaders) -> R,
    ) -> Option<R> {
        let mut state = self.0.write().expect("header store lock poisoned");
        if !Arc::ptr_eq(&state.revision, &expected.0) {
            return None;
        }
        state.revision = Arc::new(());
        Some(edit(&mut state.headers))
    }
}

impl BlockHeaderSource for SharedHeaders {
    fn generation(&self) -> ChainGeneration {
        self.read(RetainedHeaders::generation)
    }
    fn tip(&self) -> Option<(u32, Hash32)> {
        self.read(RetainedHeaders::tip)
    }
    fn hash_at(&self, height: u32) -> Option<Hash32> {
        self.read(|store| store.hash_at(height))
    }
    fn height_of(&self, hash: &Hash32) -> Option<u32> {
        self.read(|store| store.height_of(hash))
    }
    fn retained_span(&self) -> Option<(u32, u32)> {
        self.read(RetainedHeaders::retained_span)
    }
    fn range_inclusive(
        &self,
        start: u32,
        end: u32,
    ) -> Result<Vec<(u32, Hash32)>, HeaderStoreError> {
        self.read(|store| store.range_inclusive(start, end))
    }
    fn preceding(&self, height: u32, count: usize) -> Result<Vec<(u32, Hash32)>, HeaderStoreError> {
        self.read(|store| store.preceding(height, count))
    }
}

/// A provider-local read of the store, stamped with the generation it saw.
///
/// This is what keeps a disposable cache disposable: the provider holds one of
/// these, and [`is_stale`](Self::is_stale) tells it when the accepted chain has
/// moved out from under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderProjection {
    pub generation: ChainGeneration,
    pub blocks: Vec<(u32, Hash32)>,
}

impl HeaderProjection {
    pub fn is_stale(&self, store: &RetainedHeaders) -> bool {
        self.generation != store.generation()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::header_pow::verify_declared_pow;

    /// Linked headers with ground nonces, so declared proof-of-work passes.
    fn chain(count: usize) -> Vec<BlockHeaderBytes> {
        let mut out = Vec::new();
        let mut prev = [0u8; 32];
        for index in 0..count {
            let mut nonce = 0u32;
            let block = loop {
                let mut raw = [0u8; 80];
                raw[0..4].copy_from_slice(&1u32.to_le_bytes());
                raw[4..36].copy_from_slice(&prev);
                raw[68..72].copy_from_slice(&((index as u32 + 1) * 600).to_le_bytes());
                raw[72..76].copy_from_slice(&0x207f_ffffu32.to_le_bytes());
                raw[76..80].copy_from_slice(&nonce.to_le_bytes());
                if verify_declared_pow(&raw).is_ok() {
                    break BlockHeaderBytes(raw);
                }
                nonce += 1;
            };
            prev = sha256d(&block.0);
            out.push(block);
        }
        out
    }

    fn store_of(count: usize) -> (RetainedHeaders, Vec<BlockHeaderBytes>) {
        let headers = chain(count);
        let mut store = RetainedHeaders::new();
        for (height, header) in headers.iter().enumerate() {
            store
                .insert_verified(height as u32, header.clone())
                .expect("linked fixture");
        }
        (store, headers)
    }

    #[test]
    fn recovery_batch_validates_every_entry_before_mutating() {
        let (mut accepted, headers) = store_of(10);
        accepted.drop_headers_below(5);
        let before = accepted.clone();
        let mut incoming = RetainedHeaders::new();
        for (height, header) in headers.iter().take(5).enumerate() {
            let mut header = header.clone();
            if height == 4 {
                header.0[36] ^= 1;
            }
            incoming.insert_verified(height as u32, header).unwrap();
        }
        assert_eq!(
            accepted.merge_verified(incoming, || true),
            Err(HeaderStoreError::ConflictingHash { height: 4 })
        );
        assert_eq!(
            accepted, before,
            "late conflict must not restore even an earlier header"
        );

        let mut incoming = RetainedHeaders::new();
        for (height, header) in headers.iter().take(5).enumerate() {
            incoming
                .insert_verified(height as u32, header.clone())
                .unwrap();
        }
        assert_eq!(
            accepted.merge_verified(incoming.clone(), || false),
            Err(HeaderStoreError::PublicationCancelled)
        );
        assert_eq!(accepted, before);
        accepted.merge_verified(incoming, || true).unwrap();
        assert_eq!(accepted.len(), 10);
        assert_eq!(accepted.generation(), before.generation());
        for (height, header) in headers.iter().enumerate() {
            assert_eq!(accepted.header_at(height as u32), Some(header));
        }
    }

    #[test]
    fn recovery_batch_checks_both_boundaries_and_requires_raw_contiguous_headers() {
        let (original, headers) = store_of(10);
        let mut accepted = original.clone();
        accepted.prune_below(5);
        let before = accepted.clone();
        let mut incoming = RetainedHeaders::new();
        let mut wrong = headers[4].clone();
        wrong.0[36] ^= 1;
        incoming.insert_verified(4, wrong).unwrap();
        assert_eq!(
            accepted.merge_verified(incoming, || true),
            Err(HeaderStoreError::Linkage { height: 5 })
        );
        assert_eq!(accepted, before);

        let mut accepted = original.clone();
        accepted.rewind_to(5);
        let before = accepted.clone();
        let mut incoming = RetainedHeaders::new();
        let mut wrong = headers[5].clone();
        wrong.0[4] ^= 1;
        incoming.insert_verified(5, wrong).unwrap();
        assert_eq!(
            accepted.merge_verified(incoming, || true),
            Err(HeaderStoreError::Linkage { height: 5 })
        );
        assert_eq!(accepted, before);

        let mut incoming = RetainedHeaders::new();
        incoming.insert_verified(5, headers[5].clone()).unwrap();
        incoming.insert_verified(7, headers[7].clone()).unwrap();
        assert_eq!(
            accepted.merge_verified(incoming, || true),
            Err(HeaderStoreError::Discontiguous { missing: 6 })
        );
        assert_eq!(accepted, before);
        let mut incoming = RetainedHeaders::new();
        incoming.insert_hash_only(5, sha256d(&headers[5].0));
        assert_eq!(
            accepted.merge_verified(incoming, || true),
            Err(HeaderStoreError::MissingHeader { height: 5 })
        );
        assert_eq!(accepted, before);
    }

    #[test]
    fn revisions_cover_pruning_rewinds_replacement_and_empty_publication() {
        let (original, _) = store_of(10);
        let store = SharedHeaders::new(original.clone());
        let edits: [fn(&mut RetainedHeaders); 5] = [
            |s| s.drop_headers_below(5),
            |s| s.prune_below(3),
            |s| s.rewind_to(9),
            |s| s.insert_hash_only(0, [42; 32]),
            |s| *s = RetainedHeaders::new(),
        ];
        for edit in edits {
            let (revision, _) = store.snapshot(|s| s.tip());
            store.write(edit);
            assert!(store
                .write_if_current(&revision, |_| panic!("stale writer ran"))
                .is_none());
        }
        // Restoring identical contents cannot revive a prior token (ABA).
        store.write(|s| *s = original.clone());
        let (revision, _) = store.snapshot(|s| s.tip());
        store.write(|s| *s = RetainedHeaders::new());
        store.write(|s| *s = original.clone());
        assert!(store
            .write_if_current(&revision, |_| panic!("ABA writer ran"))
            .is_none());

        let (revision, _) = store.snapshot(|s| s.tip());
        store.read(|s| assert_eq!(s.len(), 10));
        assert_eq!(
            store.write_if_current(&revision, |s| s
                .merge_verified(RetainedHeaders::new(), || true)),
            Some(Ok(()))
        );
        assert!(store
            .write_if_current(&revision, |_| panic!("token reused"))
            .is_none());
        assert_eq!(store.read(Clone::clone), original);
    }

    #[test]
    fn coverage_checks_detect_gaps_without_materializing_the_range() {
        let (mut store, _) = store_of(10);
        assert!(store.covers_range(0, 9));
        assert!(!store.covers_range(9, 0));
        assert!(!store.covers_range(0, 10));
        store.by_height.remove(&4);
        assert!(!store.covers_range(0, 9));
        assert!(store.covers_range(5, 9));
    }

    #[test]
    fn it_answers_the_four_lookups_a_scan_needs() {
        let (store, headers) = store_of(20);
        assert_eq!(store.len(), 20);
        assert_eq!(store.retained_span(), Some((0, 19)));

        let hash7 = sha256d(&headers[7].0);
        assert_eq!(store.hash_at(7), Some(hash7));
        assert_eq!(store.height_of(&hash7), Some(7));
        assert_eq!(store.header_at(7), Some(&headers[7]));
        assert_eq!(store.tip(), Some((19, sha256d(&headers[19].0))));

        // Unknown hash and unretained height both answer None, not a guess.
        assert_eq!(store.height_of(&[9u8; 32]), None);
        assert_eq!(store.hash_at(99), None);
    }

    #[test]
    fn a_range_is_contiguous_or_it_is_an_error() {
        let (store, headers) = store_of(20);
        let range = store.range_inclusive(5, 9).expect("retained range");
        assert_eq!(range.len(), 5);
        for (offset, (height, hash)) in range.iter().enumerate() {
            assert_eq!(*height, 5 + offset as u32);
            assert_eq!(*hash, sha256d(&headers[*height as usize].0));
        }

        // Outside the window is a reported gap, never a short result.
        assert_eq!(
            store.range_inclusive(5, 25),
            Err(HeaderStoreError::NotRetained {
                requested: 25,
                retained: Some((0, 19))
            })
        );
        assert!(matches!(
            store.range_inclusive(9, 5),
            Err(HeaderStoreError::EmptyRange { .. })
        ));
    }

    #[test]
    fn a_hole_is_reported_rather_than_skipped() {
        let (mut store, _) = store_of(20);
        // Punch a hole without touching the ends of the range.
        store.by_height.remove(&7);
        assert_eq!(
            store.range_inclusive(5, 9),
            Err(HeaderStoreError::Discontiguous { missing: 7 }),
            "a silently short range would look like blocks with no activity"
        );
    }

    #[test]
    fn preceding_context_is_the_window_before_a_height() {
        let (store, _) = store_of(20);
        let window = store.preceding(11, 11).expect("full window");
        assert_eq!(window.len(), 11);
        assert_eq!(window.first().unwrap().0, 0);
        assert_eq!(window.last().unwrap().0, 10);

        // Near the start of the chain the window is shorter, not an error.
        let short = store.preceding(3, 11).expect("short window");
        assert_eq!(short.first().unwrap().0, 0);
        assert_eq!(short.last().unwrap().0, 2);

        assert!(store.preceding(5, 0).unwrap().is_empty());
        assert!(store.preceding(0, 11).is_err(), "nothing precedes genesis");
    }

    #[test]
    fn insert_rejects_a_header_that_does_not_link() {
        let (mut store, headers) = store_of(10);
        // headers[0] does not follow height 9.
        assert_eq!(
            store.insert_verified(10, headers[0].clone()),
            Err(HeaderStoreError::Linkage { height: 10 })
        );
        assert_eq!(store.len(), 10, "a rejected header is not stored");
    }

    #[test]
    fn pruning_narrows_the_window_and_keeps_the_generation() {
        let (mut store, _) = store_of(20);
        let generation = store.generation();

        store.prune_below(10);
        assert_eq!(store.retained_span(), Some((10, 19)));
        assert_eq!(store.hash_at(5), None);
        assert!(matches!(
            store.range_inclusive(5, 12),
            Err(HeaderStoreError::NotRetained { requested: 5, .. })
        ));
        assert_eq!(
            store.generation(),
            generation,
            "pruning does not invalidate what a projection already read"
        );
    }

    #[test]
    fn dropping_headers_keeps_the_hashes_a_scan_needs() {
        let (mut store, headers) = store_of(20);
        store.drop_headers_below(10);

        assert_eq!(store.header_at(5), None, "the 80 bytes are gone");
        assert_eq!(
            store.hash_at(5),
            Some(sha256d(&headers[5].0)),
            "but the hash a getdata needs is still here"
        );
        assert!(store.range_inclusive(0, 19).is_ok());
        assert_eq!(store.header_at(15), Some(&headers[15]));
    }

    #[test]
    fn a_reorg_bumps_the_generation_and_strands_stale_projections() {
        let (mut store, _) = store_of(20);
        let projection = HeaderProjection {
            generation: store.generation(),
            blocks: store.range_inclusive(10, 19).unwrap(),
        };
        assert!(!projection.is_stale(&store));

        store.rewind_to(15);
        assert_eq!(store.retained_span(), Some((0, 14)));
        assert!(
            projection.is_stale(&store),
            "a cache built before the reorg must not keep serving those hashes"
        );

        // The reverse index went with it.
        assert_eq!(store.hash_at(15), None);
        assert!(store.by_hash.values().all(|height| *height < 15));
    }

    #[test]
    fn re_inserting_a_height_replaces_its_reverse_entry() {
        let (mut store, _) = store_of(5);
        let displaced = store.hash_at(4).expect("a tip");
        store.rewind_to(4);

        // A genuinely different block at the same height: same parent, later
        // timestamp. Regenerating the fixture chain would reproduce the very
        // block we just removed, which would prove nothing.
        let parent = store.hash_at(3).expect("parent retained");
        let mut nonce = 0u32;
        let replacement = loop {
            let mut raw = [0u8; 80];
            raw[0..4].copy_from_slice(&1u32.to_le_bytes());
            raw[4..36].copy_from_slice(&parent);
            raw[68..72].copy_from_slice(&9_999u32.to_le_bytes());
            raw[72..76].copy_from_slice(&0x207f_ffffu32.to_le_bytes());
            raw[76..80].copy_from_slice(&nonce.to_le_bytes());
            if verify_declared_pow(&raw).is_ok() {
                break BlockHeaderBytes(raw);
            }
            nonce += 1;
        };
        assert_ne!(sha256d(&replacement.0), displaced, "must be a real fork");
        store
            .insert_verified(4, replacement.clone())
            .expect("links");

        let new_hash = sha256d(&replacement.0);
        assert_eq!(store.hash_at(4), Some(new_hash));
        assert_eq!(store.height_of(&new_hash), Some(4));
        assert_eq!(
            store.height_of(&displaced),
            None,
            "the old block must not still resolve to a height"
        );
    }
}
