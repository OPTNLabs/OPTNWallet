//! Deterministic, unfunded templates. Public BIP39 vector, never wallet data.
use optn_core::{
    hd::Wallet,
    psbt::{self, KeyOrigin, PsbtInputSpec, PsbtOutputSpec},
    token::{Capability, Nft, TokenData},
    tx,
};

pub struct Case {
    pub id: String,
    pub scenario_ids: Vec<u32>,
    pub psbt: Vec<u8>,
    pub valid: bool,
    pub parents: Vec<Vec<u8>>,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2));
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn origin(index: u32, change: bool) -> KeyOrigin {
    // BIP39's published all-zero-entropy test mnemonic, shared by the existing
    // SeedCash harness. It has no funds and must never be used for real funds.
    let wallet = Wallet::from_mnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "").unwrap();
    let key = wallet
        .signing_key(&format!("m/44'/145'/0'/{}/{index}", u8::from(change)))
        .unwrap();
    KeyOrigin {
        pubkey: key
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes()
            .try_into()
            .unwrap(),
        fingerprint: [0x73, 0xc5, 0xda, 0x0a],
        path: vec![0x8000002c, 0x80000091, 0x80000000, u32::from(change), index],
    }
}

fn script(origin: &KeyOrigin) -> Vec<u8> {
    [
        vec![0x76, 0xa9, 0x14],
        optn_core::hd::hash160(&origin.pubkey).to_vec(),
        vec![0x88, 0xac],
    ]
    .concat()
}

fn input(index: u32, vout: u32, token: Option<TokenData>) -> PsbtInputSpec {
    let origin = origin(index, false);
    let mut input = PsbtInputSpec {
        txid_display: token.as_ref().map_or([0xa5; 32], |t| t.category),
        vout: 0,
        sequence: Some(0xffff_fffe - index),
        satoshis: 1_000_000,
        locking_bytecode: script(&origin),
        previous_transaction: None,
        redeem_script: None,
        partial_signatures: vec![],
        derivations: vec![origin],
    };
    let mut outputs = vec![
        PsbtOutputSpec {
            satoshis: 1000,
            locking_bytecode: vec![0x51],
            ..Default::default()
        };
        vout as usize
    ];
    outputs.push(PsbtOutputSpec {
        satoshis: input.satoshis,
        locking_bytecode: input.locking_bytecode.clone(),
        token_prefix: token.as_ref().map(|t| t.encode_prefix().unwrap()),
        ..Default::default()
    });
    let parent = psbt::parse(&psbt::encode_unsigned(&[input.clone()], &outputs, &[]).unwrap())
        .unwrap()
        .unsigned_tx;
    input.txid_display = tx::double_sha256(&parent);
    input.txid_display.reverse();
    input.vout = vout;
    input.previous_transaction = Some(parent);
    input
}

fn token(
    category: u8,
    amount: u64,
    capability: Option<Capability>,
    commitment: &[u8],
) -> TokenData {
    TokenData {
        category: [category; 32],
        amount,
        nft: capability.map(|capability| Nft {
            capability,
            commitment: commitment.to_vec(),
        }),
    }
}

fn case(
    id: &str,
    scenario_ids: &[u32],
    inputs: Vec<PsbtInputSpec>,
    tokens: Vec<TokenData>,
    valid: bool,
) -> Case {
    let recipient = origin(50, false);
    let change = origin(99, true);
    let mut outputs: Vec<_> = tokens
        .into_iter()
        .map(|t| PsbtOutputSpec {
            satoshis: 1000,
            locking_bytecode: script(&recipient),
            token_prefix: Some(t.encode_prefix().unwrap()),
            ..Default::default()
        })
        .collect();
    // Nonadjacent token outputs, mixed with ordinary BCH and OP_RETURN.
    outputs.insert(
        outputs.len() / 2,
        PsbtOutputSpec {
            locking_bytecode: vec![0x6a, 2, 0xab, 0xcd],
            ..Default::default()
        },
    );
    outputs.push(PsbtOutputSpec {
        satoshis: inputs.iter().map(|i| i.satoshis).sum::<u64>()
            - outputs.iter().map(|o| o.satoshis).sum::<u64>()
            - 1000,
        locking_bytecode: script(&change),
        derivations: vec![change],
        ..Default::default()
    });
    Case {
        id: id.into(),
        scenario_ids: scenario_ids.to_vec(),
        psbt: psbt::encode_unsigned(&inputs, &outputs, &[]).unwrap(),
        valid,
        parents: inputs
            .iter()
            .map(|i| i.previous_transaction.clone().unwrap())
            .collect(),
    }
}

pub fn cases() -> Vec<Case> {
    use Capability::{Minting, Mutable, None as Immutable};
    let mut cases = vec![case(
        "bch-control",
        &[1],
        vec![input(0, 1, None)],
        vec![],
        true,
    )];
    for cap in [None, Some(Immutable), Some(Mutable), Some(Minting)] {
        for amount in [0, 253, i64::MAX as u64] {
            if cap.is_none() && amount == 0 {
                continue;
            }
            let source = input(0, 0, None);
            let mut genesis = token(0, amount, cap, &[0xcc; 40]);
            genesis.category = source.txid_display;
            let scenario = match (cap, amount > 0) {
                (None, _) => 11,
                (Some(Immutable), false) => 14,
                (Some(Mutable), false) => 15,
                (Some(Minting), false) => 16,
                (Some(Immutable), true) => 17,
                (Some(Mutable), true) => 18,
                (Some(Minting), true) => 19,
            };
            cases.push(case(
                &format!("genesis-{cap:?}-{amount}"),
                &[scenario],
                vec![source],
                vec![genesis],
                true,
            ));
        }
        for amount in [0, 1, 252, 253, 65536, i64::MAX as u64] {
            if cap.is_none() && amount == 0 {
                continue;
            }
            let t = token(0x11, amount, cap, &[]);
            cases.push(case(
                &format!("transfer-{cap:?}-{amount}"),
                match (cap, amount > 0) {
                    (None, _) => &[21, 29],
                    (Some(Immutable), _) => &[31],
                    (Some(_), true) => &[41],
                    _ => &[],
                },
                vec![input(0, 1, Some(t.clone()))],
                vec![t],
                true,
            ));
        }
    }
    let mutable = token(0x22, 100, Some(Mutable), &[1]);
    cases.push(case(
        "mutable-change-and-downgrade",
        &[33],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![token(0x22, 100, Some(Immutable), &[2])],
        true,
    ));
    cases.push(case(
        "mutable-change-preserve-authority",
        &[32],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![token(0x22, 100, Some(Mutable), &[2])],
        true,
    ));
    let minting = token(0x33, 100, Some(Minting), &[3]);
    for count in [1, 2, 10, 100] {
        let mut tokens = vec![minting.clone()];
        tokens.extend((0..count).map(|i| token(0x33, 0, Some(Immutable), &[i as u8])));
        cases.push(case(
            &format!("mint-{count}-nfts"),
            if count == 1 { &[34] } else { &[35] },
            vec![input(0, 1, Some(minting.clone()))],
            tokens,
            true,
        ));
    }
    cases.push(case(
        "split-minting-authority",
        &[37],
        vec![input(0, 1, Some(minting.clone()))],
        vec![
            token(0x33, 40, Some(Minting), &[4]),
            token(0x33, 60, Some(Minting), &[5]),
        ],
        true,
    ));
    cases.push(case(
        "mint-mutable",
        &[36],
        vec![input(0, 1, Some(minting.clone()))],
        vec![minting.clone(), token(0x33, 0, Some(Mutable), &[4])],
        true,
    ));
    cases.push(case(
        "mint-and-destroy-authority",
        &[34, 48],
        vec![input(0, 1, Some(minting.clone()))],
        vec![token(0x33, 100, Some(Immutable), &[7])],
        true,
    ));
    for amount in [0, 50] {
        let outputs = if amount == 0 {
            vec![]
        } else {
            vec![token(0x44, amount, None, &[])]
        };
        cases.push(case(
            &format!("burn-ft-{amount}-remaining"),
            if amount == 0 { &[45] } else { &[43] },
            vec![input(0, 1, Some(token(0x44, 100, None, &[])))],
            outputs,
            true,
        ));
    }
    cases.push(case(
        "burn-nft-preserve-ft",
        &[50],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![token(0x22, 100, None, &[])],
        true,
    ));
    cases.push(case(
        "burn-ft-preserve-nft",
        &[51],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![token(0x22, 0, Some(Mutable), &[1])],
        true,
    ));
    cases.push(case(
        "burn-both",
        &[45, 47],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![],
        true,
    ));
    let sources = vec![input(0, 0, None), input(1, 0, None), input(2, 0, None)];
    let genesis: Vec<_> = sources[..2]
        .iter()
        .map(|s| TokenData {
            category: s.txid_display,
            amount: 100,
            nft: None,
        })
        .collect();
    cases.push(case(
        "dual-genesis-neutral-vout-zero",
        &[12, 20, 54, 55],
        sources.clone(),
        genesis.clone(),
        true,
    ));
    let mut mixed_sources = sources;
    mixed_sources.extend([
        input(3, 1, Some(minting.clone())),
        input(4, 1, Some(mutable.clone())),
        input(5, 1, Some(token(0x44, 100, None, &[]))),
        input(6, 1, Some(token(0x55, 0, Some(Immutable), &[8]))),
    ]);
    let mut mixed = genesis;
    mixed.extend([
        minting.clone(),
        token(0x33, 0, Some(Immutable), &[9]),
        token(0x22, 60, Some(Immutable), &[2]),
        token(0x44, 50, None, &[]),
    ]);
    cases.push(case(
        "mega-mix-genesis-mint-mutate-ft-nft-burn",
        &[100],
        mixed_sources,
        mixed,
        true,
    ));
    cases.push(case(
        "consolidate-100-inputs",
        &[23, 97],
        (0..100)
            .map(|i| input(i, 1, Some(token(0x11, 10, None, &[]))))
            .collect(),
        vec![token(0x11, 1000, None, &[])],
        true,
    ));
    cases.push(case(
        "distribute-100-ft-outputs",
        &[24, 98],
        vec![input(0, 1, Some(token(0x11, 100, None, &[])))],
        vec![token(0x11, 1, None, &[]); 100],
        true,
    ));
    cases.push(case(
        "five-ft-categories",
        &[27],
        (1..=5)
            .map(|i| input(i, 1, Some(token(i as u8, 100, None, &[]))))
            .collect(),
        (1..=5).map(|i| token(i, 100, None, &[])).collect(),
        true,
    ));
    cases.push(case(
        "existing-token-vout-zero",
        &[53],
        vec![input(0, 0, Some(mutable.clone()))],
        vec![mutable.clone()],
        true,
    ));
    // These are syntactically well-formed PSBTs but invalid token transitions.
    cases.push(case(
        "reject-ft-mint-from-minting-nft",
        &[38, 39],
        vec![input(0, 1, Some(minting.clone()))],
        vec![token(0x33, 101, Some(Minting), &[3])],
        false,
    ));
    cases.push(case(
        "reject-ft-inflation",
        &[],
        vec![input(0, 1, Some(token(0x44, 100, None, &[])))],
        vec![token(0x44, 101, None, &[])],
        false,
    ));
    cases.push(case(
        "reject-wrong-category",
        &[],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![token(0x99, 100, Some(Mutable), &[1])],
        false,
    ));
    cases.push(case(
        "reject-authority-upgrade",
        &[],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![token(0x22, 100, Some(Minting), &[1])],
        false,
    ));
    cases.push(case(
        "reject-mutable-duplication",
        &[],
        vec![input(0, 1, Some(mutable.clone()))],
        vec![mutable.clone(), token(0x22, 0, Some(Mutable), &[2])],
        false,
    ));
    let immutable = token(0x55, 0, Some(Immutable), &[8]);
    cases.push(case(
        "reject-immutable-mutation",
        &[],
        vec![input(0, 1, Some(immutable.clone()))],
        vec![token(0x55, 0, Some(Immutable), &[9])],
        false,
    ));
    cases.push(case(
        "reject-immutable-duplication",
        &[],
        vec![input(0, 1, Some(immutable.clone()))],
        vec![immutable.clone(), immutable],
        false,
    ));
    let mut not_genesis = token(0, 100, None, &[]);
    let source = input(0, 1, None);
    not_genesis.category = source.txid_display;
    cases.push(case(
        "reject-genesis-without-vout-zero",
        &[],
        vec![source],
        vec![not_genesis],
        false,
    ));
    let source = input(0, 0, None);
    let too_much = TokenData {
        category: source.txid_display,
        amount: i64::MAX as u64,
        nft: None,
    };
    cases.push(case(
        "reject-genesis-sum-overflow",
        &[],
        vec![source],
        vec![too_much.clone(), too_much],
        false,
    ));
    cases
}
