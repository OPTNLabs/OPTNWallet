//! Sends that may spend CashToken coins.
//!
//! A token coin is not some BCH with a label on it. A transaction that spends
//! one and has no output carrying its tokens destroys them, and nothing on
//! chain refuses that. So every send that touches a token coin is planned
//! here, the same way for every wallet kind -- the CLI signs the plan with a
//! seed, the SeedCash screen turns it into a PSBT -- and every plan is checked
//! before it is returned: its outputs carry exactly the tokens its inputs do.
//! A send moves tokens; it never burns, mints or alters one.
//!
//! Three rules decide where tokens go:
//!
//! * The recipient gets what the [`Payment`] names, and nothing else.
//! * Every other token a spent coin carries returns to the wallet's change
//!   address, in its token-aware form: fungible change as one output per
//!   category, and each NFT on an output of its own, exactly as it was. An NFT
//!   riding on a coin whose fungible tokens are sent stays with the wallet;
//!   sending it is a separate, explicit payment.
//! * BCH for the token outputs and the fee comes first from the spent coins'
//!   own BCH, then from coins that carry no tokens. A coin carrying another
//!   category is never taken to pay for anything.
//!
//! Coin control ([`CoinChoice::Exactly`]) spends exactly the coins the holder
//! picked, or says why it cannot. It never adds one: people use coin control
//! to keep histories apart, and a quietly added coin defeats that.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Serialize, Serializer};

use super::SpendError;
use crate::cashaddr::Address;
use crate::coins::{hex_encode, Coin, CoinSet, Outpoint};
use crate::fee::{FeeRate, RELAY_MINIMUM_FEE_RATE};
use crate::network::Network;
use crate::token::{Capability, TokenData, MAX_FUNGIBLE_AMOUNT};
use crate::tx::{self, Committed, Funding, Output, Utxo};

/// BCH each token output carries.
///
/// The figure this wallet and its CLI already used, and above the dust
/// threshold of every token output to a P2PKH or P2SH address -- at most 798
/// sats, for a P2PKH output holding a 40-byte commitment and a maximal amount.
/// An output whose threshold were higher would carry that instead.
pub const TOKEN_OUTPUT_SATS: u64 = 1_000;

/// What the recipient receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payment {
    /// Satoshis and no tokens. Tokens on coins the holder chose go back to
    /// the wallet.
    Bch { sats: u64 },
    /// `amount` fungible units of one category.
    Fungible { category: [u8; 32], amount: u64 },
    /// Every fungible unit of one category the send spends: with automatic
    /// selection, every one the wallet can spend. NFTs on those coins stay
    /// with the wallet.
    AllFungible { category: [u8; 32] },
    /// The NFT on this coin, as it is: the same category, capability and
    /// commitment. Fungible tokens on the same coin stay with the wallet.
    Nft { outpoint: Outpoint },
}

impl Payment {
    /// Whether the recipient's output carries tokens.
    pub const fn moves_tokens(&self) -> bool {
        !matches!(self, Payment::Bch { .. })
    }
}

/// Which coins a send may spend.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum CoinChoice {
    /// The wallet picks: the token coins the payment needs, then BCH-only
    /// coins for the rest.
    #[default]
    Automatic,
    /// Coin control: exactly these coins, or a refusal saying why not.
    Exactly(BTreeSet<Outpoint>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenSpendRequest {
    pub destination: String,
    pub payment: Payment,
    pub coins: CoinChoice,
    /// The wallet's own change address, in either form. Tokens return to its
    /// token-aware form and BCH to its plain one: the same key either way.
    pub change: String,
}

/// Why an output exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputRole {
    Recipient,
    /// Tokens the send spends but does not send, returning to the wallet.
    TokenChange,
    /// BCH returning to the wallet.
    Change,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedInput {
    #[serde(serialize_with = "serialize_outpoint")]
    pub outpoint: Outpoint,
    pub sats: u64,
    /// The coin's address, as the wallet recorded it.
    pub address: String,
    #[serde(serialize_with = "serialize_token")]
    pub token: Option<TokenData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedOutput {
    pub role: OutputRole,
    /// The token-aware form when the output carries tokens.
    pub address: String,
    #[serde(skip)]
    pub script_pubkey: Vec<u8>,
    pub sats: u64,
    #[serde(serialize_with = "serialize_token")]
    pub token: Option<TokenData>,
}

impl PlannedOutput {
    /// The transaction output: value, locking script, token prefix.
    pub fn to_output(&self) -> Result<Output, SpendError> {
        Ok(Output {
            value: self.sats,
            script_pubkey: self.script_pubkey.clone(),
            token_prefix: self
                .token
                .as_ref()
                .map(TokenData::encode_prefix)
                .transpose()
                .map_err(|error| SpendError::InvalidToken(error.to_string()))?,
        })
    }
}

/// A send, decided: what it spends, what it pays, and the fee.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TokenSpendPlan {
    /// In transaction order: the coins the payment needs, or the holder's
    /// picks, then any BCH coins added to pay.
    pub inputs: Vec<PlannedInput>,
    /// In transaction order: the recipient, token change, then BCH change.
    pub outputs: Vec<PlannedOutput>,
    pub fee_sats: u64,
    #[serde(rename = "fee_rate_sats_per_kb", serialize_with = "serialize_fee_rate")]
    pub fee_rate: FeeRate,
    /// The worst-case signed size the fee was computed for.
    pub size_bytes: usize,
}

impl TokenSpendPlan {
    /// The outputs as transaction outputs, in order.
    pub fn transaction_outputs(&self) -> Result<Vec<Output>, SpendError> {
        self.outputs.iter().map(PlannedOutput::to_output).collect()
    }

    /// The token data each input's coin carries, in input order: what a
    /// signer commits to alongside each input's value.
    pub fn spent_tokens(&self) -> Vec<Option<TokenData>> {
        self.inputs
            .iter()
            .map(|input| input.token.clone())
            .collect()
    }
}

/// Plan a send that may spend token coins.
///
/// `coins` is the wallet's coin set with the tokens each coin carries; frozen
/// coins are never spent. `fee_rate` is the resolved application rate, raised
/// to the relay minimum if it is below it. The plan is checked before it is
/// returned: its outputs carry exactly the tokens its inputs do, every token
/// output pays a token-aware address, and BCH in equals BCH out plus the fee.
pub fn prepare_token_spend(
    coins: &CoinSet,
    network: Network,
    request: &TokenSpendRequest,
    fee_rate: FeeRate,
) -> Result<TokenSpendPlan, SpendError> {
    let destination = address_on(network, &request.destination)?;
    let change = address_on(network, &request.change)?;
    if request.payment.moves_tokens() && !destination.kind.accepts_tokens() {
        return Err(SpendError::NotTokenAware {
            address: request.destination.trim().to_owned(),
        });
    }
    let fee_rate = fee_rate.max(RELAY_MINIMUM_FEE_RATE);

    let spent = match &request.coins {
        CoinChoice::Automatic => coins_for(coins, &request.payment)?,
        CoinChoice::Exactly(chosen) => chosen_coins(coins, chosen)?,
    };
    let mut outputs = vec![recipient_output(&destination, &request.payment, &spent)?];
    outputs.extend(token_change(&change, &request.payment, &spent)?);

    // Only automatic selection adds coins, and only coins without tokens.
    let mut pool: Vec<&Coin> = match request.coins {
        CoinChoice::Automatic => coins.spendable().collect(),
        CoinChoice::Exactly(_) => Vec::new(),
    };
    pool.sort_by_key(|coin| coin.outpoint());
    let pool_utxos: Vec<Utxo> = pool.iter().copied().map(selection_utxo).collect();
    let spent_value = sum(spent.iter().map(|coin| coin.value_sats()))?;
    let committed = outputs
        .iter()
        .map(PlannedOutput::to_output)
        .collect::<Result<Vec<_>, _>>()?;
    let bch_change = Address {
        kind: change.kind.without_tokens(),
        ..change.clone()
    };
    let funding = tx::select_funding(
        &pool_utxos,
        Committed {
            inputs: spent.len(),
            value: spent_value,
            outputs: &committed,
        },
        &Output::new(0, bch_change.script_pubkey()),
        fee_rate,
    )
    .map_err(|_| SpendError::AmountOverflow)?;
    let (added, change_sats) = match funding {
        Funding::Paid { chosen, change, .. } => (chosen, change),
        Funding::Short { needed, available } => {
            return Err(match request.coins {
                CoinChoice::Automatic => SpendError::InsufficientSpendable { needed, available },
                CoinChoice::Exactly(_) => SpendError::ChosenCoinsTooSmall { needed, available },
            })
        }
    };
    if change_sats > 0 {
        outputs.push(PlannedOutput {
            role: OutputRole::Change,
            address: bch_change.encode(),
            script_pubkey: bch_change.script_pubkey(),
            sats: change_sats,
            token: None,
        });
    }

    let pool_by_outpoint: BTreeMap<([u8; 32], u32), &Coin> = pool_utxos
        .iter()
        .zip(&pool)
        .map(|(utxo, coin)| ((utxo.txid, utxo.vout), *coin))
        .collect();
    let added = added
        .iter()
        .map(|utxo| pool_by_outpoint.get(&(utxo.txid, utxo.vout)).copied())
        .collect::<Option<Vec<_>>>()
        // Selection only returns coins it was given.
        .ok_or(SpendError::UnknownCoin)?;
    let inputs: Vec<PlannedInput> = spent.into_iter().chain(added).map(planned_input).collect();
    let paid = sum(outputs.iter().map(|output| output.sats))?;
    let fee_sats = sum(inputs.iter().map(|input| input.sats))?
        .checked_sub(paid)
        .ok_or(SpendError::AmountOverflow)?;
    let size_bytes = tx::estimate_size_for(
        inputs.len(),
        &outputs
            .iter()
            .map(PlannedOutput::to_output)
            .collect::<Result<Vec<_>, _>>()?,
    )
    .map_err(|_| SpendError::AmountOverflow)?;
    assert_conserved(&inputs, &outputs)?;
    Ok(TokenSpendPlan {
        inputs,
        outputs,
        fee_sats,
        fee_rate,
        size_bytes,
    })
}

fn address_on(network: Network, text: &str) -> Result<Address, SpendError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(SpendError::EmptyDestination);
    }
    let address =
        Address::decode(trimmed).map_err(|_| SpendError::InvalidDestination(trimmed.to_owned()))?;
    if address.prefix != network.prefix() {
        return Err(SpendError::NetworkMismatch {
            address: trimmed.to_owned(),
            expected: network,
        });
    }
    Ok(address)
}

/// The coins automatic selection spends for a payment, before BCH funding.
fn coins_for<'a>(coins: &'a CoinSet, payment: &Payment) -> Result<Vec<&'a Coin>, SpendError> {
    match payment {
        Payment::Bch { .. } => Ok(Vec::new()),
        Payment::Fungible { category, amount } => {
            if *amount == 0 {
                return Err(SpendError::ZeroAmount);
            }
            // Coins without an NFT first, so an NFT moves only when the
            // fungible tokens cannot be found anywhere else -- and then it
            // returns to the wallet as change.
            let mut chosen = Vec::new();
            let mut gathered = 0u64;
            for coin in fungible_coins(coins, category) {
                if gathered >= *amount {
                    break;
                }
                gathered = gathered
                    .checked_add(fungible_amount(coin))
                    .ok_or(SpendError::AmountOverflow)?;
                chosen.push(coin);
            }
            if gathered < *amount {
                return Err(SpendError::InsufficientTokens {
                    category: hex_encode(category),
                    needed: *amount,
                    available: gathered,
                });
            }
            Ok(chosen)
        }
        Payment::AllFungible { category } => {
            let all: Vec<_> = fungible_coins(coins, category).collect();
            if all.is_empty() {
                return Err(SpendError::NoFungibleTokens {
                    category: hex_encode(category),
                });
            }
            Ok(all)
        }
        Payment::Nft { outpoint } => {
            let coin = coins.get(*outpoint).ok_or(SpendError::UnknownCoin)?;
            assert_transferable(coin)?;
            Ok(vec![coin])
        }
    }
}

/// Unfrozen coins carrying fungible tokens of `category`: those without an
/// NFT first, each group largest amount first, then by outpoint.
fn fungible_coins<'a>(coins: &'a CoinSet, category: &[u8; 32]) -> impl Iterator<Item = &'a Coin> {
    let mut matching: Vec<&Coin> = coins
        .iter()
        .filter(|coin| coin.freeze().is_none())
        .filter(|coin| {
            coin.token()
                .is_some_and(|token| token.category == *category && token.amount > 0)
        })
        .collect();
    matching.sort_by_key(|coin| {
        (
            coin.token().is_some_and(|token| token.nft.is_some()),
            std::cmp::Reverse(fungible_amount(coin)),
            coin.outpoint(),
        )
    });
    matching.into_iter()
}

fn fungible_amount(coin: &Coin) -> u64 {
    coin.token().map_or(0, |token| token.amount)
}

fn chosen_coins<'a>(
    coins: &'a CoinSet,
    chosen: &BTreeSet<Outpoint>,
) -> Result<Vec<&'a Coin>, SpendError> {
    if chosen.is_empty() {
        return Err(SpendError::NoCoinsChosen);
    }
    chosen
        .iter()
        .map(|outpoint| {
            let coin = coins.get(*outpoint).ok_or(SpendError::UnknownCoin)?;
            assert_transferable(coin)?;
            Ok(coin)
        })
        .collect()
}

/// A token-aware send may spend a token coin, but never a frozen one.
fn assert_transferable(coin: &Coin) -> Result<(), SpendError> {
    if coin.freeze().is_some() {
        Err(SpendError::FrozenCoin)
    } else {
        Ok(())
    }
}

fn recipient_output(
    destination: &Address,
    payment: &Payment,
    spent: &[&Coin],
) -> Result<PlannedOutput, SpendError> {
    match payment {
        Payment::Bch { sats } => {
            if *sats == 0 {
                return Err(SpendError::ZeroAmount);
            }
            let output = PlannedOutput {
                role: OutputRole::Recipient,
                address: destination.encode(),
                script_pubkey: destination.script_pubkey(),
                sats: *sats,
                token: None,
            };
            let minimum = output.to_output()?.dust_threshold();
            if *sats < minimum {
                return Err(SpendError::BelowDust {
                    sats: *sats,
                    minimum,
                });
            }
            Ok(output)
        }
        Payment::Fungible { category, amount } => {
            if *amount == 0 {
                return Err(SpendError::ZeroAmount);
            }
            token_output(
                OutputRole::Recipient,
                destination,
                TokenData::fungible(*category, *amount),
            )
        }
        Payment::AllFungible { category } => {
            let amount = fungible_held(spent)?.get(category).copied().unwrap_or(0);
            if amount == 0 {
                return Err(SpendError::NoFungibleTokens {
                    category: hex_encode(category),
                });
            }
            token_output(
                OutputRole::Recipient,
                destination,
                TokenData::fungible(*category, amount),
            )
        }
        Payment::Nft { outpoint } => {
            let coin = spent
                .iter()
                .find(|coin| coin.outpoint() == *outpoint)
                .ok_or(SpendError::NftCoinNotChosen)?;
            let token = coin.token().ok_or(SpendError::NotAnNft)?;
            let nft = token.nft.clone().ok_or(SpendError::NotAnNft)?;
            token_output(
                OutputRole::Recipient,
                destination,
                TokenData {
                    category: token.category,
                    amount: 0,
                    nft: Some(nft),
                },
            )
        }
    }
}

/// Everything the spent coins carry that the recipient does not receive.
///
/// The paid category's fungible change comes first, so its outputs sit
/// together right after the recipient's; then other categories' fungible
/// change by category; then each NFT, in input order, on an output of its own.
fn token_change(
    change: &Address,
    payment: &Payment,
    spent: &[&Coin],
) -> Result<Vec<PlannedOutput>, SpendError> {
    let held = fungible_held(spent)?;
    let paid = match payment {
        Payment::Fungible { category, amount } => Some((*category, *amount)),
        Payment::AllFungible { category } => {
            Some((*category, held.get(category).copied().unwrap_or(0)))
        }
        Payment::Bch { .. } | Payment::Nft { .. } => None,
    };
    let paid_category = paid.map(|(category, _)| category);
    let mut outputs = Vec::new();
    for category in paid_category
        .into_iter()
        .chain(held.keys().copied().filter(|c| Some(*c) != paid_category))
    {
        let available = held.get(&category).copied().unwrap_or(0);
        let sent = paid
            .filter(|(paid, _)| *paid == category)
            .map_or(0, |(_, amount)| amount);
        let left = available
            .checked_sub(sent)
            .ok_or_else(|| SpendError::InsufficientTokens {
                category: hex_encode(&category),
                needed: sent,
                available,
            })?;
        if left > 0 {
            outputs.push(token_output(
                OutputRole::TokenChange,
                change,
                TokenData::fungible(category, left),
            )?);
        }
    }
    let sent_nft = match payment {
        Payment::Nft { outpoint } => Some(*outpoint),
        _ => None,
    };
    for coin in spent
        .iter()
        .filter(|coin| Some(coin.outpoint()) != sent_nft)
    {
        if let Some(token) = coin.token().filter(|token| token.nft.is_some()) {
            outputs.push(token_output(
                OutputRole::TokenChange,
                change,
                TokenData {
                    amount: 0,
                    ..token.clone()
                },
            )?);
        }
    }
    Ok(outputs)
}

/// Fungible amounts the coins carry, by category.
fn fungible_held(coins: &[&Coin]) -> Result<BTreeMap<[u8; 32], u64>, SpendError> {
    let mut held = BTreeMap::new();
    for token in coins.iter().filter_map(|coin| coin.token()) {
        if token.amount == 0 {
            continue;
        }
        let total: &mut u64 = held.entry(token.category).or_default();
        *total = total
            .checked_add(token.amount)
            .filter(|total| *total <= MAX_FUNGIBLE_AMOUNT)
            .ok_or(SpendError::AmountOverflow)?;
    }
    Ok(held)
}

/// An output carrying `token`, to the token-aware form of `address`, with
/// [`TOKEN_OUTPUT_SATS`] or its dust threshold if that is higher.
fn token_output(
    role: OutputRole,
    address: &Address,
    token: TokenData,
) -> Result<PlannedOutput, SpendError> {
    let address = Address {
        kind: address.kind.token_aware(),
        ..address.clone()
    };
    let mut output = PlannedOutput {
        role,
        address: address.encode(),
        script_pubkey: address.script_pubkey(),
        sats: 0,
        token: Some(token),
    };
    output.sats = TOKEN_OUTPUT_SATS.max(output.to_output()?.dust_threshold());
    Ok(output)
}

/// The view of a coin selection needs: its outpoint, in wire order like
/// every other `Utxo`, and its value. Selection reads nothing else.
fn selection_utxo(coin: &Coin) -> Utxo {
    let mut txid = coin.outpoint().txid();
    txid.reverse();
    Utxo {
        txid,
        vout: coin.outpoint().vout(),
        value: coin.value_sats(),
        script_pubkey: Vec::new(),
    }
}

fn planned_input(coin: &Coin) -> PlannedInput {
    PlannedInput {
        outpoint: coin.outpoint(),
        sats: coin.value_sats(),
        address: coin.address().to_owned(),
        token: coin.token().cloned(),
    }
}

fn sum(values: impl IntoIterator<Item = u64>) -> Result<u64, SpendError> {
    values
        .into_iter()
        .try_fold(0u64, u64::checked_add)
        .ok_or(SpendError::AmountOverflow)
}

/// Fungible totals by category and NFTs by identity: what a send must carry
/// from its inputs to its outputs unchanged.
type Ledger = (
    BTreeMap<[u8; 32], u64>,
    BTreeMap<([u8; 32], u8, Vec<u8>), usize>,
);

fn ledger<'a>(tokens: impl Iterator<Item = &'a TokenData>) -> Result<Ledger, SpendError> {
    let mut fungible: BTreeMap<[u8; 32], u64> = BTreeMap::new();
    let mut nfts: BTreeMap<([u8; 32], u8, Vec<u8>), usize> = BTreeMap::new();
    for token in tokens {
        if token.amount > 0 {
            let total = fungible.entry(token.category).or_default();
            *total = total
                .checked_add(token.amount)
                .ok_or(SpendError::AmountOverflow)?;
        }
        if let Some(nft) = &token.nft {
            let capability = match nft.capability {
                Capability::None => 0,
                Capability::Mutable => 1,
                Capability::Minting => 2,
            };
            *nfts
                .entry((token.category, capability, nft.commitment.clone()))
                .or_default() += 1;
        }
    }
    Ok((fungible, nfts))
}

/// The no-burn rule, checked on the finished plan rather than trusted from
/// the steps that built it.
fn assert_conserved(inputs: &[PlannedInput], outputs: &[PlannedOutput]) -> Result<(), SpendError> {
    let spent = ledger(inputs.iter().filter_map(|input| input.token.as_ref()))?;
    let paid = ledger(outputs.iter().filter_map(|output| output.token.as_ref()))?;
    let token_outputs_accept_tokens =
        outputs
            .iter()
            .filter(|output| output.token.is_some())
            .all(|output| {
                Address::decode(&output.address).is_ok_and(|address| address.kind.accepts_tokens())
            });
    if spent != paid || !token_outputs_accept_tokens {
        return Err(SpendError::TokensNotConserved);
    }
    Ok(())
}

fn serialize_outpoint<S: Serializer>(
    outpoint: &Outpoint,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_str(outpoint)
}

fn serialize_fee_rate<S: Serializer>(rate: &FeeRate, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_u64(rate.satoshis_per_kb())
}

/// Category in display order, the amount as decimal text (it reaches 2^63 - 1,
/// past a JavaScript number), and the NFT's capability by name and its
/// commitment as hex.
fn serialize_token<S: Serializer>(
    token: &Option<TokenData>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    #[derive(Serialize)]
    struct NftView {
        capability: &'static str,
        commitment: String,
    }
    #[derive(Serialize)]
    struct TokenView {
        category: String,
        amount: String,
        nft: Option<NftView>,
    }
    token
        .as_ref()
        .map(|token| TokenView {
            category: hex_encode(&token.category),
            amount: token.amount.to_string(),
            nft: token.nft.as_ref().map(|nft| NftView {
                capability: nft.capability.as_str(),
                commitment: hex_encode(&nft.commitment),
            }),
        })
        .serialize(serializer)
}

#[cfg(test)]
mod tests;
