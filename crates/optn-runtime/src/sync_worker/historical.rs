//! Recover a scan range against the wallet's existing MMR commitment.
//!
//! A proof authenticates the starting locator. The linked range must then end
//! at our already accepted tip, so a peer cannot substitute a different past.
//! Nothing is published until both ends and every link agree. Peers without
//! SHV retain the existing full, difficulty-verified replay path.

use super::*;
use crate::chain::HistoricalHeaderProof;
use crate::chain_service::ChainBackendError;

#[cfg(test)]
mod tests;

impl ProgressiveSyncWorker {
    pub(super) async fn restore_with_shv(
        &mut self,
        service: &mut ChainService,
        wallet_route: &CapabilityRoute,
        view: &VerifiedHeaderView,
        store: &SharedHeaders,
        start: u32,
    ) -> Result<bool, ProgressiveSyncError> {
        let Some(proof_route) = service
            .matching_route_for_operation(wallet_route, ChainOperation::HistoricalHeaderProof)
        else {
            return Ok(false);
        };
        self.proven_shv_route = None;
        let Some(header_route) =
            service.matching_route_for_operation(wallet_route, ChainOperation::HeaderSync)
        else {
            return Err(ProgressiveSyncError::MissingHeaderRoute {
                source: wallet_route.source.clone(),
                protocol: wallet_route.protocol,
            });
        };
        let (target, target_hash) = view
            .tip()
            .ok_or(ProgressiveSyncError::MissingTrustedHeaderVerifier)?;
        if start > target || target - start >= MAX_HISTORICAL_REPLAY_HEADERS {
            return Err(ProgressiveSyncError::HeaderSafetyLimit);
        }
        let snapshot = store.write(|retained| retained.clone());
        if snapshot.tip().is_some_and(|(height, hash)| {
            height > target || (height == target && hash != target_hash)
        }) {
            return Err(ProgressiveSyncError::HeaderRecovery(
                "accepted store and restored view disagree".into(),
            ));
        }
        let response = service
            .execute_on_route(
                &proof_route,
                &ChainRequest::HistoricalHeaderProof {
                    height: start,
                    checkpoint_height: target,
                },
            )
            .await;
        let observation = match response {
            Ok(observation) => observation,
            Err(ChainServiceError::Exhausted { attempts })
                if !service.revocation().is_revoked()
                    && !attempts.is_empty()
                    && attempts.iter().all(|attempt| {
                        matches!(
                            attempt.error,
                            ChainBackendError::Unsupported | ChainBackendError::Timeout
                        )
                    }) =>
            {
                return Ok(false)
            }
            Err(error) => return Err(ProgressiveSyncError::Chain(error)),
        };
        let ChainPayload::HistoricalHeaderProof {
            height,
            checkpoint_height,
            header,
            siblings,
            root,
        } = observation.value
        else {
            return Err(ProgressiveSyncError::UnexpectedPayload);
        };
        if height != start || checkpoint_height != target || siblings.len() > 64 {
            return Err(ProgressiveSyncError::InvalidHeaderRange);
        }
        let proof = HistoricalHeaderProof {
            height,
            header: BlockHeaderBytes(header),
            proof: siblings,
            target: root,
        };
        view.accept_historical_proof(view.network(), &proof)
            .map_err(ProgressiveSyncError::HeaderView)?;

        let mut staged = snapshot.clone();
        insert_recovered(&mut staged, start, proof.header)?;
        let mut next = start
            .checked_add(1)
            .ok_or(ProgressiveSyncError::HeaderSafetyLimit)?;
        let batch_size = self.config.header_batch_size.clamp(1, 2_000);
        let mut batches = 0u32;
        while next <= target {
            if batches >= self.config.max_header_batches {
                return Err(ProgressiveSyncError::HeaderSafetyLimit);
            }
            batches += 1;
            let count = batch_size.min(target - next + 1);
            let locator = staged.hash_at(next - 1).ok_or_else(|| {
                ProgressiveSyncError::HeaderRecovery("missing staged proof locator".into())
            })?;
            let observation = service
                .execute_on_route(
                    &header_route,
                    &ChainRequest::HeaderSyncFromLocator {
                        start_height: next,
                        count,
                        locator,
                    },
                )
                .await
                .map_err(ProgressiveSyncError::Chain)?;
            let ChainPayload::Headers {
                start_height,
                headers,
            } = observation.value
            else {
                return Err(ProgressiveSyncError::UnexpectedPayload);
            };
            if start_height != next || headers.is_empty() || headers.len() > count as usize {
                return Err(ProgressiveSyncError::InvalidHeaderRange);
            }
            for header in headers {
                insert_recovered(&mut staged, next, BlockHeaderBytes(header))?;
                next = next
                    .checked_add(1)
                    .ok_or(ProgressiveSyncError::HeaderSafetyLimit)?;
            }
        }
        if staged.hash_at(target) != Some(target_hash) {
            return Err(ProgressiveSyncError::HeaderRecovery(
                "proof-backed history does not end at the accepted tip".into(),
            ));
        }
        staged
            .range_inclusive(start, target)
            .map_err(ProgressiveSyncError::HeaderStore)?;
        let revocation = service.revocation();
        store.write(|retained| {
            if revocation.is_revoked() || *retained != snapshot {
                return Err(ProgressiveSyncError::HeaderRecovery(
                    "accepted headers or source changed during proof recovery".into(),
                ));
            }
            *retained = staged;
            Ok(())
        })?;
        self.proven_shv_route = Some(wallet_route.clone());
        Ok(true)
    }

    /// Called only after the actor has durably accepted the wallet checkpoint.
    /// Keep the recent reorg window. Ordinary peers and Neutrino retain older
    /// locator/filter hashes, but discard full headers; SHV-capable BIP37 may
    /// discard the old hashes too. No capability is inferred from BIP37 alone.
    pub(crate) fn prune_after_sync(&self, service: &ChainService, route: &CapabilityRoute) {
        let Some((height, hash)) = self.header_view.as_ref().and_then(VerifiedHeaderView::tip)
        else {
            return;
        };
        let Some(store) = &self.accepted else {
            return;
        };
        let floor = height.saturating_sub(self.config.retained_header_window.max(1) - 1);
        let recoverable_hashes = route.protocol == ProtocolFamily::Bip37
            && self.proven_shv_route.as_ref().is_some_and(|proven| {
                proven.source == route.source
                    && proven.protocol == route.protocol
                    && proven.endpoint == route.endpoint
            })
            && service
                .matching_route_for_operation(route, ChainOperation::HistoricalHeaderProof)
                .is_some();
        store.write(|retained| {
            if service.revocation().is_revoked() || retained.tip() != Some((height, hash)) {
                return;
            }
            if recoverable_hashes {
                retained.prune_below(floor);
            } else {
                retained.drop_headers_below(floor);
            }
        });
    }
}

pub(super) fn insert_recovered(
    store: &mut RetainedHeaders,
    height: u32,
    header: BlockHeaderBytes,
) -> Result<(), ProgressiveSyncError> {
    if store
        .hash_at(height)
        .is_some_and(|hash| hash != sha256d(&header.0))
    {
        return Err(ProgressiveSyncError::HeaderRecovery(
            "recovered header contradicts accepted history".into(),
        ));
    }
    store
        .insert_verified(height, header)
        .map_err(ProgressiveSyncError::HeaderStore)
}

fn time_window(store: &RetainedHeaders, height: u32) -> Option<Vec<BlockHeaderBytes>> {
    let start = height.saturating_sub(optn_core::header_time::MEDIAN_TIME_SPAN as u32 - 1);
    (start..=height)
        .map(|height| store.header_at(height).cloned())
        .collect()
}

/// Hash-only history is sufficient for a scan, but cannot authenticate a date.
pub(super) fn missing_time_windows(view: &VerifiedHeaderView, store: &RetainedHeaders) -> bool {
    view.times()
        .anchors()
        .iter()
        .any(|anchor| !anchor.is_authenticated() && time_window(store, anchor.height).is_none())
}

/// Re-derive provisional medians only from retained, authenticated raw headers.
/// Work on the caller's candidate view so a bad median publishes no partial trust.
pub(super) fn reauthenticate_time_windows(
    view: &mut VerifiedHeaderView,
    store: &RetainedHeaders,
) -> Result<(), ProgressiveSyncError> {
    let heights = view
        .times()
        .anchors()
        .iter()
        .filter(|anchor| !anchor.is_authenticated())
        .map(|anchor| anchor.height)
        .collect::<Vec<_>>();
    for height in heights {
        if let Some(window) = time_window(store, height) {
            view.reauthenticate_anchor_window(height, &window)
                .map_err(ProgressiveSyncError::HeaderView)?;
        }
    }
    Ok(())
}
