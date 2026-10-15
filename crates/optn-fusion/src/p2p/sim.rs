//! Whole rounds between in-memory peers on a simulated clock.
//!
//! Every message goes through JSON and the strict parser, as it would through
//! a gift wrap, and every component arrives from a fresh throwaway key, so
//! these runs exercise the wire format and the anonymity rules, not just the
//! state machines.

use std::collections::{HashMap, HashSet, VecDeque};

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::ProjectivePoint;

use super::allocation::{plan_output_values, DEFAULT_MIN_OUTPUT};
use super::assemble::{sign_own_inputs, verify_final, Contribution};
use super::blame::{BlameCode, BlameReport};
use super::credentials::{canonical_scalar, random_scalar};
use super::io::{Action, Clock};
use super::rendezvous::{Negotiated, Rendezvous};
use super::session::{Round, RoundParams, RoundResult};
use super::wire::{parse_round_message, Body, InputRef, OutputRef, PoolNetwork, RoundMessage};
use super::{hex, random_bytes, P2P_FEERATE};

const TIER: u64 = 100_000;

fn x_only(secret: &[u8; 32]) -> String {
    let point = (ProjectivePoint::GENERATOR * canonical_scalar(secret).expect("valid key"))
        .to_affine()
        .to_encoded_point(true);
    hex(&point.as_bytes()[1..33])
}

fn compressed(secret: &[u8; 32]) -> String {
    hex(&optn_core::fusion::schnorr::pubkey_compressed(
        canonical_scalar(secret).expect("valid key"),
    ))
}

fn fresh_secret() -> [u8; 32] {
    random_scalar().to_bytes().into()
}

/// What a misbehaving peer does to its own outgoing messages.
type Tamper = Box<dyn FnMut(&mut RoundMessage) -> bool>;

struct Peer {
    secret: [u8; 32],
    pubkey: String,
    online: bool,
    wallet: HashMap<String, [u8; 32]>,
    inputs: Vec<InputRef>,
    contribution: Option<Contribution>,
    rendezvous: Option<Rendezvous>,
    round: Option<Round>,
    negotiated: Option<Negotiated>,
    /// Returns `false` to drop the message.
    tamper: Option<Tamper>,
    blames: Vec<BlameReport>,
}

impl Peer {
    fn new(inputs: usize) -> Self {
        let secret = fresh_secret();
        let mut wallet = HashMap::new();
        let inputs = (0..inputs)
            .map(|i| {
                let key = fresh_secret();
                let pubkey = compressed(&key);
                wallet.insert(pubkey.clone(), key);
                InputRef {
                    prev_txid: hex(&random_bytes::<32>()),
                    prev_index: i as u32,
                    value: 150_000 + u64::from(random_bytes::<2>()[0]) * 1_000,
                    pubkey,
                }
            })
            .collect();
        Self {
            pubkey: x_only(&secret),
            secret,
            online: true,
            wallet,
            inputs,
            contribution: None,
            rendezvous: None,
            round: None,
            negotiated: None,
            tamper: None,
            blames: Vec::new(),
        }
    }
}

struct Net {
    peers: Vec<Peer>,
    clock: Clock,
    inbox: VecDeque<(usize, String, String)>,
    broadcasts: Vec<String>,
}

impl Net {
    fn new(sizes: &[usize]) -> Self {
        Self {
            peers: sizes.iter().map(|&inputs| Peer::new(inputs)).collect(),
            clock: Clock {
                ms: 1_000_000,
                unix: 1_800_000_000,
            },
            inbox: VecDeque::new(),
            broadcasts: Vec::new(),
        }
    }

    fn index_of(&self, pubkey: &str) -> Option<usize> {
        self.peers.iter().position(|peer| peer.pubkey == pubkey)
    }

    fn route(&mut self, sender: usize, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Send { to, mut message } => {
                    if let Some(tamper) = self.peers[sender].tamper.as_mut() {
                        if !tamper(&mut message) {
                            continue;
                        }
                    }
                    let json = message.to_json();
                    assert!(
                        parse_round_message(&json, self.clock.unix).is_some(),
                        "the strict parser refuses what a peer sent: {json}"
                    );
                    let from = if message.body.is_anonymous() {
                        x_only(&fresh_secret())
                    } else {
                        self.peers[sender].pubkey.clone()
                    };
                    if let Some(to) = self.index_of(&to) {
                        self.inbox.push_back((to, from, json));
                    }
                }
                Action::Broadcast { tx_hex, txid } => {
                    self.broadcasts.push(tx_hex);
                    let clock = self.clock;
                    let round = self.peers[sender]
                        .round
                        .as_mut()
                        .expect("broadcast comes from a round");
                    round.on_broadcast(Ok(txid), clock);
                    let more = round.take_actions();
                    self.route(sender, more);
                }
                Action::Blame(report) => self.peers[sender].blames.push(report),
                Action::Rebroadcast { .. } | Action::Status(_) | Action::Phase(_) => {}
            }
        }
    }

    fn deliver(&mut self) {
        while let Some((to, from, json)) = self.inbox.pop_front() {
            if !self.peers[to].online {
                continue;
            }
            let clock = self.clock;
            let message = parse_round_message(&json, clock.unix).expect("checked on send");
            let peer = &mut self.peers[to];
            let actions = if let Some(round) = peer.round.as_mut() {
                round.on_message(&from, &message, clock);
                round.take_actions()
            } else if let Some(rendezvous) = peer.rendezvous.as_mut() {
                rendezvous.on_message(&from, &message, clock);
                rendezvous.take_actions()
            } else {
                Vec::new()
            };
            self.route(to, actions);
        }
    }

    fn next_deadline(&self) -> Option<u64> {
        self.peers
            .iter()
            .filter(|peer| peer.online)
            .filter_map(|peer| match (&peer.round, &peer.rendezvous) {
                (Some(round), _) => round.next_deadline(),
                (None, Some(rendezvous)) => rendezvous.next_deadline(),
                _ => None,
            })
            .min()
    }

    /// Advance to the next deadline and fire it everywhere.
    fn step(&mut self) -> bool {
        self.deliver();
        let Some(due) = self.next_deadline() else {
            return false;
        };
        let advance = due.saturating_sub(self.clock.ms);
        self.clock.ms += advance;
        self.clock.unix = 1_800_000_000 + (self.clock.ms - 1_000_000) / 1_000;
        for index in 0..self.peers.len() {
            if !self.peers[index].online {
                continue;
            }
            let clock = self.clock;
            let peer = &mut self.peers[index];
            let actions = match (&mut peer.round, &mut peer.rendezvous) {
                (Some(round), _) => {
                    round.tick(clock);
                    round.take_actions()
                }
                (None, Some(rendezvous)) => {
                    rendezvous.tick(clock);
                    rendezvous.take_actions()
                }
                _ => Vec::new(),
            };
            self.route(index, actions);
        }
        self.deliver();
        true
    }

    /// Everyone online agrees on a round.
    fn negotiate(&mut self) {
        let candidates: Vec<String> = self.peers.iter().map(|peer| peer.pubkey.clone()).collect();
        for index in 0..self.peers.len() {
            let clock = self.clock;
            let mut rendezvous = Rendezvous::start(
                &self.peers[index].pubkey,
                &candidates,
                PoolNetwork::Chipnet,
                TIER,
                7,
                60_000,
                clock,
            );
            let actions = rendezvous.take_actions();
            self.peers[index].rendezvous = Some(rendezvous);
            self.route(index, actions);
        }
        for _ in 0..10_000 {
            let open = self.peers.iter().any(|peer| {
                peer.online
                    && peer
                        .rendezvous
                        .as_ref()
                        .is_some_and(|r| r.outcome().is_none())
            });
            if !open || !self.step() {
                break;
            }
        }
        for peer in &mut self.peers {
            if let Some(Ok(negotiated)) = peer.rendezvous.as_ref().and_then(Rendezvous::outcome) {
                peer.negotiated = Some(negotiated.clone());
            }
        }
    }

    /// Run the round among everyone who agreed.
    fn fuse(&mut self) {
        for index in 0..self.peers.len() {
            let Some(negotiated) = self.peers[index].negotiated.clone() else {
                continue;
            };
            let peer = &mut self.peers[index];
            let plan = plan_output_values(
                &peer
                    .inputs
                    .iter()
                    .map(|input| (input.value, input.pubkey.len()))
                    .collect::<Vec<_>>(),
                negotiated.participants.len(),
                P2P_FEERATE,
                DEFAULT_MIN_OUTPUT,
                Some(TIER),
                super::random_unit,
            )
            .expect("inputs fund outputs");
            let outputs = plan
                .values
                .iter()
                .map(|&value| OutputRef {
                    script: format!("76a914{}88ac", hex(&random_bytes::<20>())),
                    value,
                })
                .collect();
            let contribution = Contribution {
                inputs: peer.inputs.clone(),
                outputs,
            };
            peer.contribution = Some(contribution.clone());
            let wallet = peer.wallet.clone();
            let round = Round::start(
                RoundParams {
                    my_pubkey: peer.pubkey.clone(),
                    round_secret: peer.secret,
                    participants: negotiated.participants.clone(),
                    session: negotiated.session.clone(),
                    network: negotiated.network,
                    tier: negotiated.tier,
                    feerate: P2P_FEERATE,
                    contribution,
                    signer: Box::new(move |tx| sign_own_inputs(tx, &wallet)),
                    timeout_ms: super::timing::round_timeout_ms(negotiated.participants.len() - 1),
                    jitter_ms: (30, 250),
                },
                self.clock,
            )
            .expect("round starts");
            peer.round = Some(round);
            let actions = self.peers[index]
                .round
                .as_mut()
                .expect("just set")
                .take_actions();
            self.route(index, actions);
        }
        for _ in 0..100_000 {
            let open = self.peers.iter().any(|peer| {
                peer.online
                    && peer
                        .round
                        .as_ref()
                        .is_some_and(|round| round.outcome().is_none())
            });
            if !open || !self.step() {
                break;
            }
        }
    }

    fn outcomes(&self) -> Vec<Option<Result<RoundResult, String>>> {
        self.peers
            .iter()
            .map(|peer| {
                peer.round
                    .as_ref()
                    .and_then(|round| round.outcome().cloned())
            })
            .collect()
    }
}

fn assert_fused(net: &Net) {
    let outcomes = net.outcomes();
    let results: Vec<&RoundResult> = outcomes
        .iter()
        .map(|outcome| match outcome {
            Some(Ok(result)) => result,
            other => panic!("a peer did not fuse: {other:?}"),
        })
        .collect();
    let txid = &results[0].txid;
    assert!(
        results.iter().all(|result| result.txid == *txid),
        "every peer fused the same transaction"
    );
    assert_eq!(net.broadcasts.len(), 1, "the coordinator broadcasts once");
    // Every peer's inputs and outputs are in the transaction everyone fused.
    let raw = super::unhex(&results[0].tx_hex).unwrap();
    for peer in &net.peers {
        let contribution = peer.contribution.as_ref().unwrap();
        for output in &contribution.outputs {
            let script = super::unhex(&output.script).unwrap();
            assert!(raw
                .windows(script.len())
                .any(|window| window == script.as_slice()));
        }
    }
    let all_inputs: Vec<InputRef> = net
        .peers
        .iter()
        .flat_map(|peer| peer.inputs.clone())
        .collect();
    let all_outputs: Vec<OutputRef> = net
        .peers
        .iter()
        .flat_map(|peer| peer.contribution.as_ref().unwrap().outputs.clone())
        .collect();
    let template = super::assemble::assemble([(&all_inputs[..], &all_outputs[..])]).unwrap();
    assert_eq!(
        verify_final(&template, &results[0].tx_hex, txid).unwrap(),
        *txid
    );
}

#[test]
fn six_peers_agree_and_fuse_one_transaction() {
    let mut net = Net::new(&[1, 2, 1, 3, 1, 2]);
    net.negotiate();
    let sessions: HashSet<String> = net
        .peers
        .iter()
        .map(|peer| {
            peer.negotiated
                .as_ref()
                .expect("every peer agreed")
                .session
                .clone()
        })
        .collect();
    assert_eq!(sessions.len(), 1, "one round, not two");
    net.fuse();
    assert_fused(&net);
}

#[test]
fn four_peers_are_enough() {
    let mut net = Net::new(&[1, 1, 2, 1]);
    net.negotiate();
    net.fuse();
    assert_fused(&net);
}

#[test]
fn two_silent_peers_shrink_six_to_the_acked_four() {
    let mut net = Net::new(&[1, 1, 1, 1, 1, 1]);
    // Pick two that are not the elected coordinator, so the round must shrink
    // rather than fail over.
    let all: Vec<String> = net.peers.iter().map(|peer| peer.pubkey.clone()).collect();
    let coordinator = super::pool::elect_coordinator(&all).unwrap();
    let silent: Vec<usize> = (0..6)
        .filter(|&i| net.peers[i].pubkey != coordinator)
        .take(2)
        .collect();
    for &index in &silent {
        net.peers[index].online = false;
    }
    net.negotiate();
    let agreed: Vec<&Negotiated> = net
        .peers
        .iter()
        .filter_map(|peer| peer.negotiated.as_ref())
        .collect();
    assert_eq!(agreed.len(), 4);
    assert!(agreed
        .iter()
        .all(|negotiated| negotiated.participants.len() == 4));
    net.peers.retain(|peer| peer.online);
    net.fuse();
    assert_fused(&net);
}

#[test]
fn a_peer_whose_inputs_never_arrive_fails_the_round_without_a_broadcast() {
    let mut net = Net::new(&[1, 1, 1, 1]);
    net.negotiate();
    let coordinator = net.peers[0]
        .negotiated
        .as_ref()
        .unwrap()
        .coordinator
        .clone();
    let quiet = net
        .peers
        .iter()
        .position(|peer| peer.pubkey != coordinator)
        .unwrap();
    net.peers[quiet].tamper = Some(Box::new(|message| {
        !matches!(message.body, Body::Inputs { .. })
    }));
    net.fuse();
    assert!(net.broadcasts.is_empty());
    assert!(net
        .outcomes()
        .iter()
        .all(|outcome| matches!(outcome, Some(Err(_)))));
}

#[test]
fn a_coordinator_that_drops_an_output_gets_no_signature_from_its_owner() {
    let mut net = Net::new(&[1, 1, 1, 1]);
    net.negotiate();
    let coordinator = net.peers[0]
        .negotiated
        .as_ref()
        .unwrap()
        .coordinator
        .clone();
    let index = net.index_of(&coordinator).unwrap();
    net.peers[index].tamper = Some(Box::new(|message| {
        if let Body::Assembled { outputs, .. } = &mut message.body {
            outputs.pop();
        }
        true
    }));
    net.fuse();
    assert!(
        net.broadcasts.is_empty(),
        "no complete signature set, no transaction"
    );
    let refused = net
        .outcomes()
        .iter()
        .flatten()
        .filter(|outcome| {
            outcome
                .as_ref()
                .is_err_and(|error| error.contains("refusing to sign"))
        })
        .count();
    assert!(
        refused >= 1,
        "the owner of the dropped output refused: {:?}",
        net.outcomes()
    );
}

#[test]
fn an_unbalanced_pedersen_claim_is_blamed_and_every_peer_verifies_it() {
    let mut net = Net::new(&[1, 1, 1, 1]);
    net.negotiate();
    let coordinator = net.peers[0]
        .negotiated
        .as_ref()
        .unwrap()
        .coordinator
        .clone();
    let cheat = net
        .peers
        .iter()
        .position(|peer| peer.pubkey != coordinator)
        .unwrap();
    let cheat_key = net.peers[cheat].pubkey.clone();
    net.peers[cheat].tamper = Some(Box::new(|message| {
        if let Body::CredentialRequest { excess_fee, .. } = &mut message.body {
            *excess_fee += 1;
        }
        true
    }));
    net.fuse();
    assert!(net.broadcasts.is_empty());
    for (index, peer) in net.peers.iter().enumerate() {
        if index == cheat {
            continue;
        }
        assert!(
            peer.blames
                .iter()
                .any(|report| report.code == BlameCode::PedersenUnbalanced
                    && report.accused == cheat_key),
            "peer {index} saw a verified blame naming the cheat's round key"
        );
    }
}
