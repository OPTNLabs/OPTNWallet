//! `getshv` / `shv`: Simplified Header Verification over BCH P2P.
//!
//! This is the wire half of CHIP-2026-02. It lets a pruned client ask a peer
//! for a historical header together with an inclusion proof, so header storage
//! can be discarded without giving up the ability to check what was in it.
//!
//! Until this existed, the only provider that could answer OPTN's
//! `HistoricalHeaderProof` was Electrum, which meant the privacy-preserving
//! policies were exactly the ones with no proof route at all.
//!
//! Encoding follows `src/shv/shv.h` in bitcoincashautist's BCHN branch
//! (`gitlab.com/0353F40E/bitcoin-cash-node`, branch `mmr-squashed`, commit
//! `e6d380373`), and the accepted/rejected cases follow its
//! `test/functional/bchn-p2p-shv.py`.
//!
//! This module only encodes, decodes and range-checks. It deliberately does not
//! verify a proof: the target a peer sends is that peer's claim, and only the
//! runtime's own accumulator can turn it into evidence.

use super::{read_varint, take, write_varint};

/// Service bit advertising that a peer will answer `getshv`.
pub const NODE_SHV: u64 = 1 << 9;

/// Bit 0: proof terminates at the bagged root rather than at a peak.
pub const TYPE_PROOF_TO_ROOT: u8 = 1 << 0;
/// Bit 1: the block is selected by hash rather than by height.
pub const TYPE_BY_HASH: u8 = 1 << 1;
/// Bits 2-7 are reserved and must be zero.
pub const TYPE_RESERVED_MASK: u8 = 0xFC;

/// A peer rejects a `getshv` carrying more than this, and scores the sender.
pub const MAX_SHV_REQUESTS: usize = 100;

/// Bound on a decoded response set, so a hostile peer cannot make us allocate
/// without limit. A well-behaved peer answers at most one per request.
const MAX_SHV_RESPONSES: usize = MAX_SHV_REQUESTS;

/// Bound on one proof. The accumulator is O(log n), so a real branch is well
/// under this even for a chain far longer than BCH will ever be.
const MAX_PROOF_LEN: usize = 64;

/// Which commitment a proof terminates at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofTarget {
    /// The peak containing the leaf. Cheaper, and enough when the client
    /// already holds the peaks.
    Peak,
    /// The bagged root over all peaks.
    Root,
}

/// How the requested block is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockSelector {
    Height(u64),
    Hash([u8; 32]),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShvRequest {
    pub target: ProofTarget,
    pub selector: BlockSelector,
    /// The accumulator height the proof must terminate against.
    pub commitment_height: u64,
}

impl ShvRequest {
    pub const fn type_byte(&self) -> u8 {
        let mut byte = 0u8;
        if matches!(self.target, ProofTarget::Root) {
            byte |= TYPE_PROOF_TO_ROOT;
        }
        if matches!(self.selector, BlockSelector::Hash(_)) {
            byte |= TYPE_BY_HASH;
        }
        byte
    }

    /// The reference node silently drops a request whose block sits above the
    /// commitment it is meant to be proven against. Catch it before sending, so
    /// a missing response means a peer problem rather than our own bad request.
    pub const fn is_self_consistent(&self) -> bool {
        match self.selector {
            BlockSelector::Height(height) => height <= self.commitment_height,
            BlockSelector::Hash(_) => true,
        }
    }

    fn encode_into(&self, buf: &mut Vec<u8>) {
        buf.push(self.type_byte());
        write_varint(buf, self.commitment_height);
        match self.selector {
            // Height rides in the low 8 bytes of the 32-byte field; the rest
            // must be zero or the peer treats the request as malformed.
            BlockSelector::Height(height) => {
                let mut field = [0u8; 32];
                field[..8].copy_from_slice(&height.to_le_bytes());
                buf.extend_from_slice(&field);
            }
            BlockSelector::Hash(hash) => buf.extend_from_slice(&hash),
        }
    }
}

/// One proof as a peer sent it. Nothing here is verified yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShvResponse {
    pub target: ProofTarget,
    pub by_hash: bool,
    pub commitment_height: u64,
    pub block_height: u64,
    pub header: [u8; 80],
    pub proof: Vec<[u8; 32]>,
    /// The peak or root the peer claims this proof reaches. A claim, not
    /// evidence: the runtime must match it against its own accumulator.
    pub claimed_target: [u8; 32],
}

/// Serialize a `getshv` payload.
///
/// Returns an error rather than truncating when asked to send more than a peer
/// will accept, because the reference node scores the sender for an oversized
/// message and then ignores every request in it.
pub fn encode_getshv(requests: &[ShvRequest]) -> Result<Vec<u8>, String> {
    if requests.is_empty() {
        return Err("getshv with no requests".into());
    }
    if requests.len() > MAX_SHV_REQUESTS {
        return Err(format!(
            "getshv carries {} requests, peers accept at most {MAX_SHV_REQUESTS}",
            requests.len()
        ));
    }
    if let Some(bad) = requests
        .iter()
        .find(|request| !request.is_self_consistent())
    {
        return Err(format!(
            "request block height is above its commitment height {}",
            bad.commitment_height
        ));
    }
    let mut buf = Vec::with_capacity(1 + requests.len() * 41);
    write_varint(&mut buf, requests.len() as u64);
    for request in requests {
        request.encode_into(&mut buf);
    }
    Ok(buf)
}

/// Parse an `shv` payload.
///
/// A peer answers only the requests it accepted, so the result may be shorter
/// than the batch that produced it and is not positionally aligned with it.
/// Callers must match on `(block_height, commitment_height, target)`.
pub fn decode_shv(payload: &[u8]) -> Result<Vec<ShvResponse>, String> {
    let mut pos = 0usize;
    let count = read_varint(payload, &mut pos)?;
    if count as usize > MAX_SHV_RESPONSES {
        return Err(format!("shv message carries {count} responses"));
    }
    let mut responses = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let type_byte = take(payload, &mut pos, 1)?[0];
        if type_byte & TYPE_RESERVED_MASK != 0 {
            return Err("shv response sets reserved type bits".into());
        }
        let commitment_height = read_varint(payload, &mut pos)?;
        let block_height = read_varint(payload, &mut pos)?;
        if block_height > commitment_height {
            return Err("shv response proves a block above its commitment".into());
        }
        let header: [u8; 80] = take(payload, &mut pos, 80)?
            .try_into()
            .expect("checked 80-byte slice");
        let proof_len = read_varint(payload, &mut pos)?;
        if proof_len as usize > MAX_PROOF_LEN {
            return Err(format!("shv proof has {proof_len} siblings"));
        }
        let mut proof = Vec::with_capacity(proof_len as usize);
        for _ in 0..proof_len {
            proof.push(
                take(payload, &mut pos, 32)?
                    .try_into()
                    .expect("checked 32-byte slice"),
            );
        }
        let claimed_target: [u8; 32] = take(payload, &mut pos, 32)?
            .try_into()
            .expect("checked 32-byte slice");

        responses.push(ShvResponse {
            target: if type_byte & TYPE_PROOF_TO_ROOT != 0 {
                ProofTarget::Root
            } else {
                ProofTarget::Peak
            },
            by_hash: type_byte & TYPE_BY_HASH != 0,
            commitment_height,
            block_height,
            header,
            proof,
            claimed_target,
        });
    }
    if pos != payload.len() {
        return Err("shv message has trailing bytes".into());
    }
    Ok(responses)
}

impl ShvResponse {
    /// Does this answer the request that was sent?
    ///
    /// A peer may reorder, drop, or duplicate; matching on the fields the
    /// request pinned is what keeps a response for one block from being read
    /// as the answer for another.
    pub fn answers(&self, request: &ShvRequest) -> bool {
        if self.target != request.target || self.commitment_height != request.commitment_height {
            return false;
        }
        match request.selector {
            BlockSelector::Height(height) => !self.by_hash && self.block_height == height,
            // By-hash responses carry the resolved height, so the hash is
            // checked by the caller against the returned header.
            BlockSelector::Hash(_) => self.by_hash,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn height_request(height: u64, commitment_height: u64, target: ProofTarget) -> ShvRequest {
        ShvRequest {
            target,
            selector: BlockSelector::Height(height),
            commitment_height,
        }
    }

    #[test]
    fn the_type_byte_matches_the_reference_bitfield() {
        assert_eq!(
            height_request(1, 2, ProofTarget::Peak).type_byte(),
            0,
            "peak by height is the all-zero type"
        );
        assert_eq!(
            height_request(1, 2, ProofTarget::Root).type_byte(),
            TYPE_PROOF_TO_ROOT
        );
        assert_eq!(
            ShvRequest {
                target: ProofTarget::Peak,
                selector: BlockSelector::Hash([7; 32]),
                commitment_height: 9,
            }
            .type_byte(),
            TYPE_BY_HASH
        );
        assert_eq!(
            ShvRequest {
                target: ProofTarget::Root,
                selector: BlockSelector::Hash([7; 32]),
                commitment_height: 9,
            }
            .type_byte(),
            TYPE_PROOF_TO_ROOT | TYPE_BY_HASH
        );
        // Nothing we can build sets a reserved bit.
        for request in [
            height_request(1, 2, ProofTarget::Peak),
            height_request(1, 2, ProofTarget::Root),
        ] {
            assert_eq!(request.type_byte() & TYPE_RESERVED_MASK, 0);
        }
    }

    /// The reference encodes a height in the low 8 bytes of a 32-byte field and
    /// drops the request if any upper byte is set.
    #[test]
    fn a_height_request_leaves_the_upper_bytes_zero() {
        let encoded = encode_getshv(&[height_request(
            0x0102_0304_0506_0708,
            0x0102_0304_0506_0708,
            ProofTarget::Root,
        )])
        .expect("encodes");
        // varint(1) | type | varint(commitment) | 32-byte field
        assert_eq!(encoded[0], 1);
        assert_eq!(encoded[1], TYPE_PROOF_TO_ROOT);
        let field = &encoded[encoded.len() - 32..];
        assert_eq!(&field[..8], &0x0102_0304_0506_0708u64.to_le_bytes());
        assert!(
            field[8..].iter().all(|byte| *byte == 0),
            "upper bytes must stay zero or the peer drops the request"
        );
    }

    #[test]
    fn a_hash_request_sends_the_hash_verbatim() {
        let hash = [9u8; 32];
        let encoded = encode_getshv(&[ShvRequest {
            target: ProofTarget::Peak,
            selector: BlockSelector::Hash(hash),
            commitment_height: 5,
        }])
        .expect("encodes");
        assert_eq!(&encoded[encoded.len() - 32..], &hash);
    }

    #[test]
    fn we_refuse_to_send_what_the_reference_would_drop_or_punish() {
        // Block above its own commitment: the node skips it silently.
        assert!(encode_getshv(&[height_request(11, 10, ProofTarget::Root)]).is_err());
        // Oversized: the node scores the sender and ignores the whole message.
        let batch = vec![height_request(1, 10, ProofTarget::Root); MAX_SHV_REQUESTS + 1];
        assert!(encode_getshv(&batch).is_err());
        // Exactly at the limit is fine.
        let batch = vec![height_request(1, 10, ProofTarget::Root); MAX_SHV_REQUESTS];
        assert!(encode_getshv(&batch).is_ok());
        // An empty batch is a pointless round trip.
        assert!(encode_getshv(&[]).is_err());
    }

    fn encode_response(response: &ShvResponse) -> Vec<u8> {
        let mut buf = Vec::new();
        write_varint(&mut buf, 1);
        let mut type_byte = 0u8;
        if matches!(response.target, ProofTarget::Root) {
            type_byte |= TYPE_PROOF_TO_ROOT;
        }
        if response.by_hash {
            type_byte |= TYPE_BY_HASH;
        }
        buf.push(type_byte);
        write_varint(&mut buf, response.commitment_height);
        write_varint(&mut buf, response.block_height);
        buf.extend_from_slice(&response.header);
        write_varint(&mut buf, response.proof.len() as u64);
        for sibling in &response.proof {
            buf.extend_from_slice(sibling);
        }
        buf.extend_from_slice(&response.claimed_target);
        buf
    }

    fn sample_response() -> ShvResponse {
        ShvResponse {
            target: ProofTarget::Root,
            by_hash: false,
            commitment_height: 10,
            block_height: 6,
            header: [3; 80],
            proof: vec![[1; 32], [2; 32]],
            claimed_target: [4; 32],
        }
    }

    #[test]
    fn a_response_round_trips() {
        let response = sample_response();
        let decoded = decode_shv(&encode_response(&response)).expect("decodes");
        assert_eq!(decoded, vec![response]);
    }

    #[test]
    fn an_empty_response_set_is_valid() {
        // The reference answers an all-invalid batch, and a node with no MMR
        // index, with an empty `shv` rather than silence.
        assert_eq!(decode_shv(&[0x00]).expect("decodes"), Vec::new());
    }

    #[test]
    fn a_genesis_proof_to_root_carries_no_siblings() {
        let mut response = sample_response();
        response.block_height = 0;
        response.commitment_height = 0;
        response.proof.clear();
        let decoded = decode_shv(&encode_response(&response)).expect("decodes");
        assert_eq!(decoded[0].proof.len(), 0);
        assert_eq!(decoded[0].block_height, 0);
    }

    #[test]
    fn malformed_responses_are_rejected_rather_than_half_parsed() {
        let good = encode_response(&sample_response());

        // Truncation anywhere.
        for cut in 1..good.len() {
            assert!(
                decode_shv(&good[..cut]).is_err(),
                "truncating to {cut} bytes must fail"
            );
        }
        // Trailing bytes.
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(decode_shv(&trailing).is_err());

        // Reserved type bits.
        let mut reserved = good.clone();
        reserved[1] |= 0x80;
        assert!(decode_shv(&reserved).is_err());

        // A block proven above its own commitment.
        let mut inverted = sample_response();
        inverted.block_height = inverted.commitment_height + 1;
        assert!(decode_shv(&encode_response(&inverted)).is_err());

        // An absurd proof length must not allocate.
        let mut huge = Vec::new();
        write_varint(&mut huge, 1);
        huge.push(TYPE_PROOF_TO_ROOT);
        write_varint(&mut huge, 10);
        write_varint(&mut huge, 6);
        huge.extend_from_slice(&[3u8; 80]);
        write_varint(&mut huge, u64::from(u32::MAX));
        assert!(decode_shv(&huge).is_err());

        // More responses than requests could have produced.
        let mut many = Vec::new();
        write_varint(&mut many, (MAX_SHV_RESPONSES + 1) as u64);
        assert!(decode_shv(&many).is_err());
    }

    #[test]
    fn responses_are_matched_to_requests_not_to_positions() {
        let request = height_request(6, 10, ProofTarget::Root);
        let response = sample_response();
        assert!(response.answers(&request));

        // Same block, different commitment: not an answer.
        let mut other_commitment = response.clone();
        other_commitment.commitment_height = 11;
        assert!(!other_commitment.answers(&request));

        // Same commitment, different block: not an answer.
        let mut other_block = response.clone();
        other_block.block_height = 7;
        assert!(!other_block.answers(&request));

        // Peak proof does not answer a root request.
        let mut peak = response.clone();
        peak.target = ProofTarget::Peak;
        assert!(!peak.answers(&request));

        // A by-hash response does not answer a by-height request.
        let mut by_hash = response.clone();
        by_hash.by_hash = true;
        assert!(!by_hash.answers(&request));

        let hash_request = ShvRequest {
            target: ProofTarget::Root,
            selector: BlockSelector::Hash([5; 32]),
            commitment_height: 10,
        };
        assert!(by_hash.answers(&hash_request));
        assert!(!response.answers(&hash_request));
    }
}
