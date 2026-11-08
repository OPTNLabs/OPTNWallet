use super::*;
use crate::cashaddr::AddressKind;
use crate::coins::FreezeReason;
use crate::token::Nft;

const A: [u8; 32] = [0xa1; 32];
const B: [u8; 32] = [0xb2; 32];
const C: [u8; 32] = [0xc3; 32];

/// One sat per byte, so fees read as sizes.
const RATE: FeeRate = FeeRate::from_satoshis_per_kb(1_000);

fn address(fill: u8, kind: AddressKind) -> String {
    Address::from_hash(Network::Chipnet.prefix(), kind, [fill; 20]).encode()
}

fn recipient() -> String {
    address(0xee, AddressKind::P2pkhToken)
}

fn change() -> String {
    address(0xcc, AddressKind::P2pkh)
}

fn outpoint(seed: u8) -> Outpoint {
    Outpoint::new([seed; 32], u32::from(seed))
}

fn coin(seed: u8, sats: u64, token: Option<TokenData>) -> Coin {
    Coin::from_observation(
        outpoint(seed),
        sats,
        address(seed, AddressKind::P2pkh),
        token,
    )
    .unwrap()
}

fn ft(category: [u8; 32], amount: u64) -> Option<TokenData> {
    Some(TokenData::fungible(category, amount))
}

fn nft(
    category: [u8; 32],
    amount: u64,
    capability: Capability,
    commitment: &[u8],
) -> Option<TokenData> {
    Some(TokenData {
        category,
        amount,
        nft: Some(Nft {
            capability,
            commitment: commitment.to_vec(),
        }),
    })
}

fn wallet(coins: impl IntoIterator<Item = Coin>) -> CoinSet {
    let mut set = CoinSet::new();
    for coin in coins {
        set.insert(coin).unwrap();
    }
    set
}

fn request(payment: Payment) -> TokenSpendRequest {
    TokenSpendRequest {
        destination: recipient(),
        payment,
        coins: CoinChoice::Automatic,
        change: change(),
    }
}

fn chosen(seeds: &[u8], payment: Payment) -> TokenSpendRequest {
    TokenSpendRequest {
        coins: CoinChoice::Exactly(seeds.iter().map(|seed| outpoint(*seed)).collect()),
        ..request(payment)
    }
}

fn plan(coins: &CoinSet, request: &TokenSpendRequest) -> Result<TokenSpendPlan, SpendError> {
    prepare_token_spend(coins, Network::Chipnet, request, RATE)
}

fn input_seeds(plan: &TokenSpendPlan) -> Vec<u8> {
    plan.inputs
        .iter()
        .map(|input| input.outpoint.txid()[0])
        .collect()
}

fn roles(plan: &TokenSpendPlan) -> Vec<OutputRole> {
    plan.outputs.iter().map(|output| output.role).collect()
}

fn token_change_address() -> String {
    Address {
        kind: AddressKind::P2pkhToken,
        ..Address::decode(&change()).unwrap()
    }
    .encode()
}

/// BCH in equals BCH out plus the fee, and the fee pays at least the rate.
fn assert_balanced(plan: &TokenSpendPlan) {
    let spent: u64 = plan.inputs.iter().map(|input| input.sats).sum();
    let paid: u64 = plan.outputs.iter().map(|output| output.sats).sum();
    assert_eq!(spent, paid + plan.fee_sats);
    let size =
        tx::estimate_size_for(plan.inputs.len(), &plan.transaction_outputs().unwrap()).unwrap();
    assert_eq!(plan.size_bytes, size);
    assert!(plan.fee_sats >= plan.fee_rate.fee_for_bytes(size as u64));
}

#[test]
fn a_fungible_send_takes_its_category_and_returns_the_rest_as_token_change() {
    let coins = wallet([
        coin(1, 1_000, ft(A, 300)),
        coin(2, 1_000, ft(A, 200)),
        coin(3, 1_000, ft(B, 999)),
        coin(4, 50_000, None),
        coin(5, 20_000, None),
    ]);
    let plan = plan(
        &coins,
        &request(Payment::Fungible {
            category: A,
            amount: 400,
        }),
    )
    .unwrap();

    // Largest A coins first, then the largest BCH-only coin; B is never touched.
    assert_eq!(input_seeds(&plan), [1, 2, 4]);
    assert_eq!(
        roles(&plan),
        [
            OutputRole::Recipient,
            OutputRole::TokenChange,
            OutputRole::Change
        ]
    );
    let [paid, token_change, bch_change] = plan.outputs.as_slice() else {
        unreachable!()
    };
    assert_eq!(paid.address, recipient());
    assert_eq!(paid.token, ft(A, 400));
    assert_eq!(paid.sats, TOKEN_OUTPUT_SATS);
    assert_eq!(token_change.address, token_change_address());
    assert_eq!(token_change.token, ft(A, 100));
    assert_eq!(token_change.sats, TOKEN_OUTPUT_SATS);
    assert_eq!(bch_change.address, change());
    assert_eq!(bch_change.token, None);
    // 3 inputs x 148, a 71-byte token output (three-byte amount), a 69-byte
    // one, a 34-byte change output, and 10 bytes of framing.
    assert_eq!(plan.size_bytes, 628);
    assert_eq!(plan.fee_sats, 628);
    assert_eq!(bch_change.sats, 52_000 - 2_000 - 628);
    assert_balanced(&plan);
}

#[test]
fn an_nft_on_a_coin_whose_fungible_tokens_are_needed_stays_with_the_wallet() {
    let coins = wallet([
        coin(1, 1_000, ft(A, 100)),
        coin(2, 1_000, nft(A, 500, Capability::Mutable, &[1])),
        coin(3, 30_000, None),
    ]);
    // The fungible-only coin is not enough, so the mixed coin is spent too;
    // its NFT goes back to the wallet exactly as it was.
    let large = plan(
        &coins,
        &request(Payment::Fungible {
            category: A,
            amount: 450,
        }),
    )
    .unwrap();
    assert_eq!(input_seeds(&large), [1, 2, 3]);
    let tokens: Vec<_> = large
        .outputs
        .iter()
        .map(|output| output.token.clone())
        .collect();
    assert_eq!(
        tokens,
        [
            ft(A, 450),
            ft(A, 150),
            nft(A, 0, Capability::Mutable, &[1]),
            None
        ]
    );
    assert_eq!(large.outputs[2].role, OutputRole::TokenChange);
    assert_eq!(large.outputs[2].address, token_change_address());
    assert_balanced(&large);

    // When the fungible-only coin is enough, the NFT's coin is not touched.
    let small = plan(
        &coins,
        &request(Payment::Fungible {
            category: A,
            amount: 50,
        }),
    )
    .unwrap();
    assert_eq!(input_seeds(&small), [1, 3]);
    assert!(small.outputs.iter().all(|output| output
        .token
        .as_ref()
        .is_none_or(|token| token.nft.is_none())));
}

#[test]
fn categories_never_mix_and_chosen_coins_of_others_come_back_as_change() {
    let coins = wallet([
        coin(1, 1_000, ft(A, 300)),
        coin(2, 1_000, ft(B, 40)),
        coin(3, 1_000, nft(B, 0, Capability::None, &[7, 7])),
        coin(4, 1_000, nft(C, 5, Capability::Minting, &[])),
        coin(5, 9_000, None),
    ]);
    let automatic = plan(
        &coins,
        &request(Payment::Fungible {
            category: A,
            amount: 300,
        }),
    )
    .unwrap();
    assert_eq!(input_seeds(&automatic), [1, 5]);

    // Coin control: everything the holder picked is accounted for.
    let picked = plan(
        &coins,
        &chosen(
            &[1, 2, 3, 4, 5],
            Payment::Fungible {
                category: A,
                amount: 120,
            },
        ),
    )
    .unwrap();
    assert_eq!(input_seeds(&picked), [1, 2, 3, 4, 5]);
    let tokens: Vec<_> = picked
        .outputs
        .iter()
        .map(|output| (output.role, output.token.clone()))
        .collect();
    assert_eq!(
        tokens,
        [
            (OutputRole::Recipient, ft(A, 120)),
            // The paid category's change first, then the others by category.
            (OutputRole::TokenChange, ft(A, 180)),
            (OutputRole::TokenChange, ft(B, 40)),
            (OutputRole::TokenChange, ft(C, 5)),
            // Each NFT on an output of its own, in input order.
            (
                OutputRole::TokenChange,
                nft(B, 0, Capability::None, &[7, 7])
            ),
            (OutputRole::TokenChange, nft(C, 0, Capability::Minting, &[])),
            (OutputRole::Change, None),
        ]
    );
    assert_balanced(&picked);
}

#[test]
fn too_few_tokens_are_refused_with_what_is_available() {
    let mut coins = wallet([
        coin(1, 1_000, ft(A, 300)),
        coin(2, 1_000, ft(A, 200)),
        coin(3, 1_000, nft(A, 100, Capability::None, &[])),
        coin(4, 1_000, ft(A, 5_000)),
        coin(9, 90_000, None),
    ]);
    // A frozen coin's tokens are not available to any send.
    coins.freeze(outpoint(4), FreezeReason::User).unwrap();
    let category = hex_encode(&A);
    assert_eq!(
        plan(
            &coins,
            &request(Payment::Fungible {
                category: A,
                amount: 601,
            })
        ),
        Err(SpendError::InsufficientTokens {
            category: category.clone(),
            needed: 601,
            available: 600,
        })
    );
    assert_eq!(
        plan(
            &coins,
            &chosen(
                &[1, 9],
                Payment::Fungible {
                    category: A,
                    amount: 400,
                }
            )
        ),
        Err(SpendError::InsufficientTokens {
            category,
            needed: 400,
            available: 300,
        })
    );
    assert_eq!(
        plan(&coins, &request(Payment::AllFungible { category: C })),
        Err(SpendError::NoFungibleTokens {
            category: hex_encode(&C)
        })
    );
    assert_eq!(
        plan(&coins, &chosen(&[9], Payment::AllFungible { category: A })),
        Err(SpendError::NoFungibleTokens {
            category: hex_encode(&A)
        })
    );
    assert_eq!(
        plan(
            &coins,
            &request(Payment::Fungible {
                category: A,
                amount: 0,
            })
        ),
        Err(SpendError::ZeroAmount)
    );
}

#[test]
fn too_little_bch_for_the_token_outputs_and_fee_is_refused() {
    // Token coins carrying 1000 sats each cannot pay for a recipient output,
    // a change output and a fee by themselves.
    let tokens_only = wallet([coin(1, 1_000, ft(A, 300)), coin(2, 1_000, ft(B, 5))]);
    let payment = Payment::Fungible {
        category: A,
        amount: 100,
    };
    match plan(&tokens_only, &request(payment.clone())) {
        Err(SpendError::InsufficientSpendable { needed, available }) => {
            assert_eq!(available, 1_000, "other categories never pay");
            assert!(needed > 2_000);
        }
        other => panic!("expected InsufficientSpendable, got {other:?}"),
    }
    match plan(&tokens_only, &chosen(&[1], payment.clone())) {
        Err(SpendError::ChosenCoinsTooSmall { needed, available }) => {
            assert_eq!(available, 1_000);
            assert!(needed > 2_000);
        }
        other => panic!("expected ChosenCoinsTooSmall, got {other:?}"),
    }
    // A BCH-only coin that covers it fixes both.
    let funded = wallet([
        coin(1, 1_000, ft(A, 300)),
        coin(2, 1_000, ft(B, 5)),
        coin(3, 3_000, None),
    ]);
    assert_balanced(&plan(&funded, &request(payment.clone())).unwrap());
    assert_balanced(&plan(&funded, &chosen(&[1, 3], payment)).unwrap());
}

#[test]
fn an_nft_send_moves_that_exact_nft_and_keeps_its_fungible_tokens() {
    for capability in [Capability::None, Capability::Mutable, Capability::Minting] {
        let coins = wallet([
            coin(1, 800, nft(A, 77, capability, &[0xde, 0xad])),
            coin(2, 1_000, nft(A, 0, capability, &[0xbe, 0xef])),
            coin(3, 10_000, None),
        ]);
        let plan = plan(
            &coins,
            &request(Payment::Nft {
                outpoint: outpoint(1),
            }),
        )
        .unwrap();
        assert_eq!(input_seeds(&plan), [1, 3], "{capability:?}");
        let tokens: Vec<_> = plan
            .outputs
            .iter()
            .map(|output| output.token.clone())
            .collect();
        assert_eq!(
            tokens,
            [nft(A, 0, capability, &[0xde, 0xad]), ft(A, 77), None],
            "the NFT keeps its capability and commitment; its fungible tokens stay"
        );
        assert_eq!(plan.outputs[0].address, recipient());
        assert_balanced(&plan);
    }
    let coins = wallet([
        coin(1, 1_000, ft(A, 5)),
        coin(2, 1_000, nft(A, 0, Capability::None, &[2])),
        coin(3, 10_000, None),
    ]);
    let nft_of = |seed| Payment::Nft {
        outpoint: outpoint(seed),
    };
    assert_eq!(plan(&coins, &request(nft_of(1))), Err(SpendError::NotAnNft));
    assert_eq!(
        plan(&coins, &request(nft_of(8))),
        Err(SpendError::UnknownCoin)
    );
    assert_eq!(
        plan(&coins, &chosen(&[1, 3], nft_of(2))),
        Err(SpendError::NftCoinNotChosen)
    );
    let mut frozen = coins.clone();
    frozen.freeze(outpoint(2), FreezeReason::User).unwrap();
    assert_eq!(
        plan(&frozen, &request(nft_of(2))),
        Err(SpendError::FrozenCoin)
    );
}

#[test]
fn send_all_leaves_none_of_the_category_behind() {
    // 800 sats each, so the token coins cannot pay their own way and a BCH
    // coin has to be added.
    let coins = wallet([
        coin(1, 800, ft(A, 300)),
        coin(2, 800, ft(A, 200)),
        coin(3, 800, nft(A, 50, Capability::Minting, &[9])),
        coin(4, 1_000, nft(A, 0, Capability::None, &[8])),
        coin(5, 1_000, ft(B, 10)),
        coin(6, 40_000, None),
    ]);
    let plan = plan(&coins, &request(Payment::AllFungible { category: A })).unwrap();
    assert_eq!(input_seeds(&plan), [1, 2, 3, 6]);
    let tokens: Vec<_> = plan
        .outputs
        .iter()
        .map(|output| output.token.clone())
        .collect();
    assert_eq!(
        tokens,
        [
            ft(A, 550),
            // The minting NFT that rode on a spent coin stays with the wallet.
            nft(A, 0, Capability::Minting, &[9]),
            None
        ]
    );
    // Nothing fungible of the category is left: not in a change output, and
    // not on any coin the send did not spend.
    let spent: BTreeSet<_> = plan.inputs.iter().map(|input| input.outpoint).collect();
    assert!(plan.outputs[1..]
        .iter()
        .all(|output| output.token.as_ref().is_none_or(|token| token.amount == 0)));
    assert!(coins
        .iter()
        .filter(|coin| !spent.contains(&coin.outpoint()))
        .all(|coin| coin
            .token()
            .is_none_or(|token| token.category != A || token.amount == 0)));
    assert_balanced(&plan);
}

#[test]
fn coin_control_spends_exactly_the_chosen_coins() {
    let coins = wallet([
        coin(1, 1_000, ft(A, 300)),
        coin(2, 1_000, ft(A, 200)),
        coin(5, 40_000, None),
        coin(6, 90_000, None),
    ]);
    let send = |seeds: &[u8], sats| {
        plan(
            &coins,
            &TokenSpendRequest {
                destination: address(0xee, AddressKind::P2pkh),
                ..chosen(seeds, Payment::Bch { sats })
            },
        )
    };
    // A BCH send that spends a token coin returns its tokens.
    let picked = send(&[1, 5], 5_000).unwrap();
    assert_eq!(input_seeds(&picked), [1, 5]);
    assert_eq!(
        roles(&picked),
        [
            OutputRole::Recipient,
            OutputRole::TokenChange,
            OutputRole::Change
        ]
    );
    assert_eq!(picked.outputs[0].token, None);
    assert_eq!(picked.outputs[0].sats, 5_000);
    assert_eq!(picked.outputs[1].token, ft(A, 300));
    assert_balanced(&picked);

    // Never topped up from coins that were not chosen.
    assert!(matches!(
        send(&[1, 5], 45_000),
        Err(SpendError::ChosenCoinsTooSmall {
            available: 41_000,
            ..
        })
    ));
    assert_eq!(send(&[], 5_000), Err(SpendError::NoCoinsChosen));
    assert_eq!(send(&[1, 7], 5_000), Err(SpendError::UnknownCoin));
    let mut frozen = coins.clone();
    frozen
        .freeze(outpoint(5), FreezeReason::FusionInFlight)
        .unwrap();
    assert_eq!(
        prepare_token_spend(
            &frozen,
            Network::Chipnet,
            &TokenSpendRequest {
                destination: address(0xee, AddressKind::P2pkh),
                ..chosen(&[1, 5], Payment::Bch { sats: 5_000 })
            },
            RATE
        ),
        Err(SpendError::FrozenCoin)
    );
    // Automatic selection for the same BCH send takes no token coin at all.
    let automatic = plan(
        &coins,
        &TokenSpendRequest {
            destination: address(0xee, AddressKind::P2pkh),
            ..request(Payment::Bch { sats: 45_000 })
        },
    )
    .unwrap();
    assert_eq!(input_seeds(&automatic), [6]);
    assert!(automatic
        .outputs
        .iter()
        .all(|output| output.token.is_none()));
}

#[test]
fn tokens_are_never_sent_to_an_address_that_does_not_accept_them() {
    let coins = wallet([coin(1, 1_000, ft(A, 300)), coin(2, 9_000, None)]);
    let plain = address(0xee, AddressKind::P2pkh);
    for payment in [
        Payment::Fungible {
            category: A,
            amount: 1,
        },
        Payment::AllFungible { category: A },
    ] {
        assert_eq!(
            plan(
                &coins,
                &TokenSpendRequest {
                    destination: format!("  {plain} "),
                    ..request(payment)
                }
            ),
            Err(SpendError::NotTokenAware {
                address: plain.clone()
            })
        );
    }
    // A plain address is fine when no tokens go to it, and token change still
    // goes to the token-aware form of a plain change address.
    let bch = plan(
        &coins,
        &TokenSpendRequest {
            destination: plain.clone(),
            ..chosen(&[1, 2], Payment::Bch { sats: 2_000 })
        },
    )
    .unwrap();
    assert_eq!(bch.outputs[1].address, token_change_address());
    // A token-aware change address is accepted too; BCH change uses its plain form.
    let reversed = plan(
        &coins,
        &TokenSpendRequest {
            change: token_change_address(),
            ..request(Payment::Fungible {
                category: A,
                amount: 100,
            })
        },
    )
    .unwrap();
    assert_eq!(reversed.outputs[1].address, token_change_address());
    assert_eq!(reversed.outputs[2].address, change());

    let mainnet = Address::from_hash("bitcoincash", AddressKind::P2pkhToken, [0xee; 20]).encode();
    for (destination, error) in [
        ("".to_owned(), SpendError::EmptyDestination),
        (
            "bchtest:nonsense".to_owned(),
            SpendError::InvalidDestination("bchtest:nonsense".to_owned()),
        ),
        (
            mainnet.clone(),
            SpendError::NetworkMismatch {
                address: mainnet.clone(),
                expected: Network::Chipnet,
            },
        ),
    ] {
        assert_eq!(
            plan(
                &coins,
                &TokenSpendRequest {
                    destination,
                    ..request(Payment::AllFungible { category: A })
                }
            ),
            Err(error)
        );
    }
}

#[test]
fn dust_is_neither_paid_nor_made_into_change() {
    let coins = wallet([coin(1, 10_000, None)]);
    let to = |sats| TokenSpendRequest {
        destination: address(0xee, AddressKind::P2pkh),
        ..request(Payment::Bch { sats })
    };
    assert_eq!(
        plan(&coins, &to(545)),
        Err(SpendError::BelowDust {
            sats: 545,
            minimum: 546
        })
    );
    // One input, one output: 192 bytes. Leave 300 sats after that fee, which
    // a change output (34 more bytes of fee) could not carry.
    let tight = plan(&coins, &to(10_000 - 192 - 300)).unwrap();
    assert_eq!(roles(&tight), [OutputRole::Recipient]);
    assert_eq!(tight.fee_sats, 492);
    assert_balanced(&tight);
}

#[test]
fn the_fee_rate_is_never_below_the_relay_minimum() {
    let coins = wallet([coin(1, 1_000, ft(A, 3)), coin(2, 9_000, None)]);
    let slow = prepare_token_spend(
        &coins,
        Network::Chipnet,
        &request(Payment::AllFungible { category: A }),
        FeeRate::from_satoshis_per_kb(0),
    )
    .unwrap();
    assert_eq!(slow.fee_rate, RELAY_MINIMUM_FEE_RATE);
    assert_balanced(&slow);
    let fast = prepare_token_spend(
        &coins,
        Network::Chipnet,
        &request(Payment::AllFungible { category: A }),
        FeeRate::from_satoshis_per_kb(5_000),
    )
    .unwrap();
    assert_eq!(
        fast.fee_sats,
        fast.fee_rate.fee_for_bytes(fast.size_bytes as u64)
    );
    assert!(fast.fee_sats > slow.fee_sats);
}

#[test]
fn plans_serialize_for_the_renderer() {
    let coins = wallet([
        coin(1, 1_000, nft(A, 12, Capability::Minting, &[0x0f])),
        coin(2, 9_000, None),
    ]);
    let plan = plan(
        &coins,
        &request(Payment::Nft {
            outpoint: outpoint(1),
        }),
    )
    .unwrap();
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(json["inputs"][0]["outpoint"], outpoint(1).to_string());
    assert_eq!(json["inputs"][0]["token"]["amount"], "12");
    assert_eq!(json["inputs"][1]["token"], serde_json::Value::Null);
    assert_eq!(json["outputs"][0]["role"], "recipient");
    assert_eq!(json["outputs"][0]["token"]["category"], hex_encode(&A));
    assert_eq!(json["outputs"][0]["token"]["amount"], "0");
    assert_eq!(json["outputs"][0]["token"]["nft"]["capability"], "minting");
    assert_eq!(json["outputs"][0]["token"]["nft"]["commitment"], "0f");
    assert_eq!(json["outputs"][1]["role"], "token_change");
    assert_eq!(json["outputs"][2]["role"], "change");
    assert!(json["outputs"][0].get("script_pubkey").is_none());
    assert_eq!(json["fee_rate_sats_per_kb"], 1_000);
    assert_eq!(json["fee_sats"], plan.fee_sats);
}

/// A small deterministic generator, so the property below needs no
/// dependency and reruns identically.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn index(&mut self, len: usize) -> usize {
        usize::try_from(self.below(len as u64)).unwrap()
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

fn random_token(rng: &mut Rng) -> Option<TokenData> {
    if !rng.chance(60) {
        return None;
    }
    let category = [A, B, C][rng.index(3)];
    let amount = if rng.chance(70) {
        1 + rng.below(1 << 40)
    } else {
        0
    };
    let nft = (amount == 0 || rng.chance(30)).then(|| Nft {
        capability: [Capability::None, Capability::Mutable, Capability::Minting][rng.index(3)],
        commitment: (0..rng.below(4)).map(|_| rng.below(4) as u8).collect(),
    });
    Some(TokenData {
        category,
        amount,
        nft,
    })
}

/// Fungible totals by category, and every NFT as category, capability and
/// commitment.
type Inventory = (BTreeMap<[u8; 32], u128>, Vec<(String, String, Vec<u8>)>);

/// What the tokens add up to, counted independently of the code under test.
fn inventory<'a>(tokens: impl Iterator<Item = &'a TokenData>) -> Inventory {
    let mut fungible = BTreeMap::new();
    let mut nfts = Vec::new();
    for token in tokens {
        if token.amount > 0 {
            *fungible.entry(token.category).or_default() += u128::from(token.amount);
        }
        if let Some(nft) = &token.nft {
            nfts.push((
                hex_encode(&token.category),
                nft.capability.as_str().to_owned(),
                nft.commitment.clone(),
            ));
        }
    }
    nfts.sort();
    (fungible, nfts)
}

#[test]
fn no_plan_ever_burns_mints_or_alters_a_token() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let change_script = Address::decode(&change()).unwrap().script_pubkey();
    let mut planned = [0usize; 4];
    for _ in 0..10_000 {
        let mut coins = CoinSet::new();
        let count = 1 + rng.below(9) as u8;
        for seed in 1..=count {
            let sats = [0, 546, 800, 1_000, 5_000, 60_000][rng.index(6)];
            let token = random_token(&mut rng);
            if sats == 0 && token.is_none() {
                continue;
            }
            coins
                .insert(
                    Coin::from_observation(
                        outpoint(seed),
                        sats,
                        address(seed, AddressKind::P2pkh),
                        token,
                    )
                    .unwrap(),
                )
                .unwrap();
            if rng.chance(10) {
                coins.freeze(outpoint(seed), FreezeReason::User).unwrap();
            }
        }
        let outpoints: Vec<Outpoint> = coins.iter().map(Coin::outpoint).collect();
        if outpoints.is_empty() {
            continue;
        }
        let category = [A, B, C][rng.index(3)];
        let payment = match rng.below(4) {
            0 => Payment::Bch {
                sats: 546 + rng.below(70_000),
            },
            1 => Payment::Fungible {
                category,
                amount: 1 + rng.below(1 << 40),
            },
            2 => Payment::AllFungible { category },
            _ => Payment::Nft {
                outpoint: outpoints[rng.index(outpoints.len())],
            },
        };
        let choice = if rng.chance(50) {
            CoinChoice::Automatic
        } else {
            CoinChoice::Exactly(
                outpoints
                    .iter()
                    .copied()
                    .filter(|_| rng.chance(60))
                    .collect(),
            )
        };
        let request = TokenSpendRequest {
            destination: if rng.chance(85) {
                recipient()
            } else {
                address(0xee, AddressKind::P2pkh)
            },
            payment: payment.clone(),
            coins: choice.clone(),
            change: change(),
        };
        let rate = FeeRate::from_satoshis_per_kb([1_000, 1_100, 3_000][rng.index(3)]);
        let Ok(plan) = prepare_token_spend(&coins, Network::Chipnet, &request, rate) else {
            continue;
        };
        planned[match payment {
            Payment::Bch { .. } => 0,
            Payment::Fungible { .. } => 1,
            Payment::AllFungible { .. } => 2,
            Payment::Nft { .. } => 3,
        }] += 1;

        // Every input is a distinct, unfrozen coin of this wallet, as recorded.
        let spent: BTreeSet<Outpoint> = plan.inputs.iter().map(|input| input.outpoint).collect();
        assert_eq!(spent.len(), plan.inputs.len());
        for input in &plan.inputs {
            let coin = coins.get(input.outpoint).expect("a wallet coin");
            assert!(coin.freeze().is_none());
            assert_eq!(coin.token(), input.token.as_ref());
            assert_eq!(coin.value_sats(), input.sats);
        }
        match &choice {
            CoinChoice::Exactly(picked) => assert_eq!(&spent, picked),
            CoinChoice::Automatic => {
                for input in plan.inputs.iter().filter_map(|input| input.token.as_ref()) {
                    match &payment {
                        Payment::Bch { .. } => panic!("a BCH send took a token coin"),
                        Payment::Fungible { category, .. } | Payment::AllFungible { category } => {
                            assert_eq!(&input.category, category);
                            assert!(input.amount > 0);
                        }
                        Payment::Nft { .. } => {}
                    }
                }
            }
        }

        // The no-burn rule, recounted here: what goes in comes out.
        assert_eq!(
            inventory(plan.inputs.iter().filter_map(|input| input.token.as_ref())),
            inventory(
                plan.outputs
                    .iter()
                    .filter_map(|output| output.token.as_ref())
            ),
            "{payment:?} {choice:?}"
        );
        assert_balanced(&plan);

        let first = &plan.outputs[0];
        assert_eq!(first.role, OutputRole::Recipient);
        match &payment {
            Payment::Bch { sats } => {
                assert_eq!(first.token, None);
                assert_eq!(first.sats, *sats);
            }
            Payment::Fungible { category, amount } => {
                assert_eq!(first.token, ft(*category, *amount));
            }
            Payment::AllFungible { category } => {
                let total: u64 = plan
                    .inputs
                    .iter()
                    .filter_map(|input| input.token.as_ref())
                    .filter(|token| token.category == *category)
                    .map(|token| token.amount)
                    .sum();
                assert_eq!(first.token, ft(*category, total));
            }
            Payment::Nft { outpoint } => {
                let held = coins.get(*outpoint).and_then(Coin::token).unwrap();
                assert_eq!(
                    first.token,
                    Some(TokenData {
                        amount: 0,
                        ..held.clone()
                    })
                );
            }
        }
        for output in &plan.outputs {
            let address = Address::decode(&output.address).unwrap();
            assert_eq!(address.script_pubkey(), output.script_pubkey);
            assert!(output.sats >= output.to_output().unwrap().dust_threshold());
            if output.token.is_some() {
                assert!(address.kind.accepts_tokens(), "{output:?}");
            }
            if output.role != OutputRole::Recipient {
                assert_eq!(output.script_pubkey, change_script);
            }
        }
    }
    // Every kind of payment was planned often enough for this to mean something.
    assert!(planned.iter().all(|count| *count >= 200), "{planned:?}");
}
