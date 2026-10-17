//! Pool discovery: what a peer announces, which announcements count as live,
//! which group forms, and who coordinates it (`nostr/fusion.ts`).
//!
//! Signing and verifying the Nostr event itself is the host's job; this module
//! owns the content, the tags and every rule applied to them.

use serde::{Deserialize, Serialize};

use super::wire::PoolNetwork;
use super::MAX_MONEY;

/// NIP-01 replaceable kind: relays keep the latest per throwaway key and
/// replay it to late subscribers, which Tor joiners need.
pub const POOL_ANNOUNCE_KIND: u16 = 12230;
pub const FUSION_POOL_PROTOCOL: u64 = 1;
/// Announcements carry a 30-second bucket the announcer signs.
pub const POOL_EPOCH_SECONDS: u64 = 30;
/// An announcement stays discoverable this long.
pub const POOL_PEER_TTL_SECONDS: u64 = 180;
/// A peer is live while heard from within this window.
pub const POOL_LIVE_ACTIVE_SECONDS: u64 = 24;
/// Live peers re-announce on this cadence.
pub const POOL_REANNOUNCE_SECONDS: u64 = 4;
/// How far back a subscription pulls stored announcements.
pub const POOL_SUBSCRIBE_LOOKBACK_SECONDS: u64 = 180;
pub const MAX_FUTURE_SKEW_SECONDS: u64 = 5;
pub const MAX_ANNOUNCEMENT_BYTES: usize = 2_048;
pub const MAX_TIERS: usize = 16;
/// Most inputs one peer may announce.
pub const MAX_ANNOUNCED_INPUTS: u64 = 20;
/// Worst-case components a group may hold.
pub const MAX_TOTAL_COMPONENTS: u64 = 120;
/// Most outputs one peer may contribute.
pub const MAX_OUTPUTS_PER_PEER: u64 = 6;

/// The 30-second bucket `now` falls in.
pub fn pool_epoch(now_unix: u64) -> u64 {
    now_unix / POOL_EPOCH_SECONDS
}

/// The network-scoped `t` tag every announcement and subscription uses.
pub fn pool_tag(network: PoolNetwork) -> String {
    format!("optn-fusion-v{FUSION_POOL_PROTOCOL}-{}", network.as_str())
}

/// The announcement's JSON content, field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementContent {
    pub protocol: u64,
    pub network: PoolNetwork,
    pub epoch: u64,
    pub tiers: Vec<u64>,
    pub num_inputs: u64,
    pub expires_at: u64,
}

/// What a peer announces, ready for the host to sign as a kind-12230 event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnouncementDraft {
    pub created_at: u64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
}

fn valid_tier(tier: u64) -> bool {
    (10_000..=MAX_MONEY).contains(&tier)
}

/// Valid tiers, deduplicated and ascending (`normalizeTiers`).
pub fn normalize_tiers(tiers: &[u64]) -> Vec<u64> {
    let mut tiers: Vec<u64> = tiers
        .iter()
        .copied()
        .filter(|&tier| valid_tier(tier))
        .collect();
    tiers.sort_unstable();
    tiers.dedup();
    tiers
}

/// Build an announcement (`buildPoolAnnouncement`). A withdrawal is already
/// expired so peers drop the key at once; the NIP-40 `expiration` tag lets
/// relays that honour it delete the event too.
pub fn build_announcement(
    network: PoolNetwork,
    tiers: &[u64],
    num_inputs: u64,
    now_unix: u64,
    withdraw: bool,
) -> Result<AnnouncementDraft, String> {
    let tiers = normalize_tiers(tiers);
    if tiers.is_empty() || tiers.len() > MAX_TIERS {
        return Err("P2P Fusion announcement needs 1-16 valid tiers.".into());
    }
    if !(1..=MAX_ANNOUNCED_INPUTS).contains(&num_inputs) {
        return Err("P2P Fusion announcement has an invalid input count.".into());
    }
    let expires_at = if withdraw {
        now_unix.saturating_sub(1)
    } else {
        now_unix + POOL_PEER_TTL_SECONDS
    };
    let content = AnnouncementContent {
        protocol: FUSION_POOL_PROTOCOL,
        network,
        epoch: pool_epoch(now_unix),
        tiers,
        num_inputs,
        expires_at,
    };
    Ok(AnnouncementDraft {
        created_at: now_unix,
        tags: vec![
            vec!["t".into(), pool_tag(network)],
            vec!["n".into(), network.as_str().into()],
            vec!["v".into(), FUSION_POOL_PROTOCOL.to_string()],
            vec!["expiration".into(), expires_at.to_string()],
        ],
        content: serde_json::to_string(&content).expect("announcement content serializes"),
    })
}

/// An announcement admitted to the candidate set (`PoolAnnouncement`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    pub pubkey: String,
    pub network: PoolNetwork,
    pub epoch: u64,
    pub tiers: Vec<u64>,
    pub num_inputs: u64,
    /// The event's `created_at`, by the announcer's clock.
    pub at: u64,
    pub expires_at: u64,
    /// When this host last received it from a relay. Tor drops re-announces,
    /// so hearing a key counts as much as its own timestamp.
    pub seen_at: Option<u64>,
}

/// The parts of a signature-verified event this module checks.
pub struct AnnouncementEvent<'a> {
    pub pubkey: &'a str,
    pub kind: u16,
    pub created_at: u64,
    pub tags: &'a [Vec<String>],
    pub content: &'a str,
}

fn has_tag(tags: &[Vec<String>], name: &str, value: &str) -> bool {
    tags.iter().any(|tag| {
        tag.first().map(String::as_str) == Some(name)
            && tag.get(1).map(String::as_str) == Some(value)
    })
}

/// Admit an announcement whose Nostr signature the host already verified
/// (`parsePoolAnnouncement`). The signed epoch is the decidable freshness
/// test: a relay replaying an abandoned key cannot advance it, while a live
/// peer always carries the current bucket.
pub fn parse_announcement(
    event: &AnnouncementEvent<'_>,
    network: PoolNetwork,
    now_unix: u64,
) -> Option<Announcement> {
    if event.kind != POOL_ANNOUNCE_KIND
        || event.content.encode_utf16().count() > MAX_ANNOUNCEMENT_BYTES
        || event.created_at > now_unix + MAX_FUTURE_SKEW_SECONDS
        || event.created_at + POOL_PEER_TTL_SECONDS + MAX_FUTURE_SKEW_SECONDS < now_unix
        || !has_tag(event.tags, "t", &pool_tag(network))
        || !has_tag(event.tags, "n", network.as_str())
        || !has_tag(event.tags, "v", &FUSION_POOL_PROTOCOL.to_string())
    {
        return None;
    }
    let content: serde_json::Value = serde_json::from_str(event.content).ok()?;
    let number = |field: &str| content.get(field).and_then(serde_json::Value::as_u64);
    let tiers = content
        .get("tiers")
        .and_then(serde_json::Value::as_array)
        .map(|tiers| {
            normalize_tiers(
                &tiers
                    .iter()
                    .filter_map(serde_json::Value::as_u64)
                    .collect::<Vec<_>>(),
            )
        })
        .unwrap_or_default();
    let current = pool_epoch(now_unix);
    let (Some(expires_at), Some(num_inputs), Some(epoch)) =
        (number("expiresAt"), number("numInputs"), number("epoch"))
    else {
        return None;
    };
    if number("protocol") != Some(FUSION_POOL_PROTOCOL)
        || content.get("network").and_then(serde_json::Value::as_str) != Some(network.as_str())
        || tiers.is_empty()
        || tiers.len() > MAX_TIERS
        || !(1..=MAX_ANNOUNCED_INPUTS).contains(&num_inputs)
        || expires_at < now_unix
        || epoch > current
        || epoch + 1 < current
    {
        return None;
    }
    Some(Announcement {
        pubkey: event.pubkey.to_owned(),
        network,
        epoch,
        tiers,
        num_inputs,
        at: event.created_at,
        expires_at,
        seen_at: None,
    })
}

/// Whether an announcement is a live gatherer for this attempt
/// (`isLivePoolAnnouncement`). `lock_strict` is the lock/propose view: only
/// keys re-published during this gather count, so ghosts never get proposed.
pub fn is_live(
    peer: &Announcement,
    now_unix: u64,
    gather_start_unix: u64,
    self_pubkey: &str,
    is_ghost: impl Fn(&str) -> bool,
    lock_strict: bool,
) -> bool {
    if peer.pubkey == self_pubkey {
        return true;
    }
    if is_ghost(&peer.pubkey) || peer.expires_at < now_unix {
        return false;
    }
    let last_heard = peer.seen_at.unwrap_or(peer.at);
    if last_heard + POOL_LIVE_ACTIVE_SECONDS < now_unix {
        return false;
    }
    let floor = gather_start_unix.saturating_sub(3);
    if lock_strict {
        return peer.at >= floor && last_heard >= floor;
    }
    if now_unix.saturating_sub(gather_start_unix) >= POOL_REANNOUNCE_SECONDS {
        return peer.at >= floor;
    }
    true
}

/// A peer as group selection sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupPeer {
    pub pubkey: String,
    pub tiers: Vec<u64>,
    pub num_inputs: u64,
}

/// The group that forms: the tier with the largest compatible set, the larger
/// tier on a tie (`selectFusionGroup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub tier: u64,
    pub participants: Vec<String>,
}

pub fn select_group(peers: &[GroupPeer], min: usize, max: usize) -> Option<Group> {
    let mut unique: Vec<GroupPeer> = Vec::new();
    for peer in peers {
        if peer.pubkey.is_empty() || unique.iter().any(|known| known.pubkey == peer.pubkey) {
            continue;
        }
        let tiers = normalize_tiers(&peer.tiers);
        if tiers.is_empty() || !(1..=MAX_ANNOUNCED_INPUTS).contains(&peer.num_inputs) {
            continue;
        }
        unique.push(GroupPeer {
            tiers,
            ..peer.clone()
        });
    }
    let mut tiers: Vec<u64> = unique
        .iter()
        .flat_map(|peer| peer.tiers.iter().copied())
        .collect();
    tiers.sort_unstable_by(|a, b| b.cmp(a));
    tiers.dedup();
    let mut best: Option<Group> = None;
    for tier in tiers {
        let mut compatible: Vec<&GroupPeer> = unique
            .iter()
            .filter(|peer| peer.tiers.contains(&tier))
            .collect();
        // `localeCompare` on lowercase hex keys orders as bytes do.
        compatible.sort_by(|a, b| a.pubkey.cmp(&b.pubkey));
        let mut participants = Vec::new();
        let mut worst_case = 0;
        for peer in compatible {
            if participants.len() >= max {
                break;
            }
            let with_peer = worst_case + peer.num_inputs + MAX_OUTPUTS_PER_PEER;
            if with_peer > MAX_TOTAL_COMPONENTS {
                continue;
            }
            participants.push(peer.pubkey.clone());
            worst_case = with_peer;
        }
        if participants.len() < min {
            continue;
        }
        let better = match &best {
            None => true,
            Some(best) => {
                participants.len() > best.participants.len()
                    || (participants.len() == best.participants.len() && tier > best.tier)
            }
        };
        if better {
            best = Some(Group { tier, participants });
        }
    }
    best
}

/// The coordinator of a candidate set (`electCoordinator`): the lowest ticket
/// over the sorted set and each candidate, so a key ground offline has no
/// standing advantage — its rank depends on who else joined.
pub fn elect_coordinator(pubkeys: &[String]) -> Option<String> {
    let mut candidates: Vec<&String> = Vec::new();
    for key in pubkeys {
        if !key.is_empty() && !candidates.contains(&key) {
            candidates.push(key);
        }
    }
    match candidates.len() {
        0 => return None,
        1 => return Some(candidates[0].clone()),
        _ => {}
    }
    let mut sorted: Vec<&str> = candidates.iter().map(|key| key.as_str()).collect();
    sorted.sort_unstable();
    let commitment = sorted.join("|");
    let mut winner = candidates[0];
    let mut best = election_ticket(&commitment, winner);
    for &candidate in &candidates[1..] {
        let ticket = election_ticket(&commitment, candidate);
        if ticket < best || (ticket == best && candidate < winner) {
            best = ticket;
            winner = candidate;
        }
    }
    Some(winner.clone())
}

/// The TypeScript's two-lane FNV-1a over `${commitment}#${candidate}`, as the
/// 16-hex-digit string it compares. JavaScript's `Math.imul` and `>>> 0` are
/// 32-bit wrapping multiplication; `charCodeAt` is the byte for these ASCII
/// keys.
pub fn election_ticket(commitment: &str, candidate: &str) -> String {
    let input = format!("{commitment}#{candidate}");
    let mut h1: u32 = 0x811c_9dc5;
    let mut h2: u32 = 0x0100_0193;
    for (i, unit) in input.encode_utf16().enumerate() {
        let c = u32::from(unit);
        h1 = (h1 ^ c).wrapping_mul(0x0100_0193);
        h2 = (h2 ^ c.wrapping_add(i as u32)).wrapping_mul(0x85eb_ca6b);
    }
    format!("{h1:08x}{h2:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> String {
        super::super::hex(&[byte; 32])
    }

    #[test]
    fn election_is_set_bound_and_order_independent() {
        let set = vec![key(1), key(2), key(3), key(4)];
        let mut shuffled = set.clone();
        shuffled.reverse();
        assert_eq!(elect_coordinator(&set), elect_coordinator(&shuffled));
        assert_eq!(elect_coordinator(&[key(5)]), Some(key(5)));
        assert_eq!(elect_coordinator(&[]), None);
        // The winner of one set need not win a superset: rank is relative.
        let winner = elect_coordinator(&set).unwrap();
        assert!(set.contains(&winner));
    }

    #[test]
    fn group_prefers_the_largest_set_then_the_larger_tier() {
        let peer = |byte, tiers: &[u64]| GroupPeer {
            pubkey: key(byte),
            tiers: tiers.to_vec(),
            num_inputs: 2,
        };
        let peers = vec![
            peer(1, &[100_000, 1_000_000]),
            peer(2, &[100_000, 1_000_000]),
            peer(3, &[100_000]),
            peer(4, &[100_000, 1_000_000]),
        ];
        let group = select_group(&peers, 3, 10).unwrap();
        assert_eq!(group.tier, 100_000);
        assert_eq!(group.participants.len(), 4);
        let tie = select_group(&peers[..2], 2, 10).unwrap();
        assert_eq!(tie.tier, 1_000_000, "equal sets prefer the larger tier");
        assert!(select_group(&peers, 5, 10).is_none());
    }

    #[test]
    fn the_component_budget_caps_a_group() {
        let peers: Vec<GroupPeer> = (1..=10)
            .map(|byte| GroupPeer {
                pubkey: key(byte),
                tiers: vec![100_000],
                num_inputs: 20,
            })
            .collect();
        // 20 inputs + 6 outputs each: four peers fit in 120 components.
        let group = select_group(&peers, 2, 10).unwrap();
        assert_eq!(group.participants.len(), 4);
    }

    #[test]
    fn an_announcement_round_trips_and_stale_buckets_are_refused() {
        let now = 1_800_000_015;
        let draft = build_announcement(PoolNetwork::Chipnet, &[100_000, 5, 100_000], 3, now, false)
            .unwrap();
        let event = AnnouncementEvent {
            pubkey: &key(7),
            kind: POOL_ANNOUNCE_KIND,
            created_at: draft.created_at,
            tags: &draft.tags,
            content: &draft.content,
        };
        let parsed = parse_announcement(&event, PoolNetwork::Chipnet, now).unwrap();
        assert_eq!(parsed.tiers, vec![100_000]);
        assert_eq!(parsed.num_inputs, 3);
        assert!(parse_announcement(&event, PoolNetwork::Mainnet, now).is_none());
        // Two buckets later the signed epoch is stale even though the event
        // is still inside its TTL.
        assert!(
            parse_announcement(&event, PoolNetwork::Chipnet, now + 2 * POOL_EPOCH_SECONDS)
                .is_none()
        );
        let withdrawn = build_announcement(PoolNetwork::Chipnet, &[100_000], 3, now, true).unwrap();
        let event = AnnouncementEvent {
            content: &withdrawn.content,
            tags: &withdrawn.tags,
            ..event
        };
        assert!(parse_announcement(&event, PoolNetwork::Chipnet, now).is_none());
    }

    #[test]
    fn the_strict_view_needs_a_republish_during_this_gather() {
        let start = 1_800_000_000;
        let ghost = Announcement {
            pubkey: key(2),
            network: PoolNetwork::Chipnet,
            epoch: 0,
            tiers: vec![100_000],
            num_inputs: 1,
            at: start - 20,
            expires_at: start + 100,
            seen_at: Some(start + 1),
        };
        let none = |_: &str| false;
        assert!(is_live(&ghost, start + 2, start, &key(1), none, false));
        assert!(!is_live(&ghost, start + 2, start, &key(1), none, true));
        let fresh = Announcement {
            at: start + 1,
            ..ghost.clone()
        };
        assert!(is_live(&fresh, start + 2, start, &key(1), none, true));
        assert!(!is_live(
            &fresh,
            start + 2,
            start,
            &key(1),
            |k| k == key(2),
            false
        ));
    }
}
