//! What coin control shows for a coin, and whether a BCH send may take it.
//!
//! A coin that carries CashTokens is not just some BCH. A send with no token
//! output for its category destroys those tokens, and a BCH send has none, so
//! a token coin listed as an ordinary coin is a burn one click away. Coin
//! control therefore names what each coin carries -- a fungible token such as
//! MUSD or FURU, an NFT -- and keeps such coins out of BCH sends.
//!
//! The identity (name, ticker, decimals) is an input: the wallet's own BCMR
//! resolution, carried here as resolved. Nothing in this module fetches or
//! guesses one, and only a verified or last-known identity may name a coin.
//! A ticker is not unique -- any issuer can publish "MUSD" for a category of
//! its own -- so every token label carries its category as well.

use serde::Serialize;

use crate::bcmr::{bounded_text, MAX_DECIMALS, MAX_NAME_BYTES, MAX_TICKER_BYTES};
use crate::coins::hex_encode;
use crate::error::{CliError, Result};
use crate::spend::SpendError;
use crate::token::{self, Capability, TokenData, MAX_FUNGIBLE_AMOUNT};
use crate::tx;

/// How far the wallet's BCMR resolution got for a category.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum IdentityStatus {
    /// Fetched from the current authhead and hash-verified.
    Verified,
    /// Verified once and no longer current.
    Stale,
    /// The authhead publishes no registry.
    Unpublished,
    /// Nothing could be established.
    #[default]
    Unresolved,
}

impl IdentityStatus {
    /// Read one of the runtime's status names. A name this build does not
    /// recognise reads as unresolved, never as current.
    pub fn from_name(name: &str) -> Self {
        match name {
            "verified" => Self::Verified,
            "stale" => Self::Stale,
            "unpublished" => Self::Unpublished,
            _ => Self::Unresolved,
        }
    }

    /// Only an authenticated identity may put a name on a coin.
    const fn names_coins(self) -> bool {
        matches!(self, Self::Verified | Self::Stale)
    }

    /// The same caveats the runtime shows beside an identity.
    const fn caveat(self) -> Option<&'static str> {
        match self {
            Self::Verified => None,
            Self::Stale => Some("last known"),
            Self::Unpublished => Some("no registry published"),
            Self::Unresolved => Some("unverified"),
        }
    }
}

/// A category's identity, as the wallet resolved it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub ticker: Option<String>,
    pub decimals: u8,
    pub status: IdentityStatus,
}

impl Identity {
    /// The bounds a verified registry must meet before it may name a category.
    fn is_well_formed(&self) -> bool {
        !self.name.is_empty()
            && bounded_text(&self.name, MAX_NAME_BYTES)
            && self
                .ticker
                .as_deref()
                .is_none_or(|ticker| !ticker.is_empty() && bounded_text(ticker, MAX_TICKER_BYTES))
            && self.decimals <= MAX_DECIMALS
    }

    /// This identity, when it may name a coin.
    fn naming(&self) -> Option<&Self> {
        (self.status.names_coins() && self.is_well_formed()).then_some(self)
    }
}

/// The parts of a coin's tokens that decide its label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoinTokens {
    /// Category id in display order.
    pub category: [u8; 32],
    /// Fungible amount; zero when the coin carries none.
    pub amount: u64,
    /// The NFT's capability, when the coin carries one.
    pub nft: Option<Capability>,
}

impl From<&TokenData> for CoinTokens {
    fn from(token: &TokenData) -> Self {
        Self {
            category: token.category,
            amount: token.amount,
            nft: token.nft.as_ref().map(|nft| nft.capability),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoinKind {
    Bch,
    Fungible,
    Nft,
    FungibleNft,
    /// Token data was reported for the coin but could not be read.
    UnreadableTokens,
}

/// One coin as coin control presents it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CoinLabel {
    pub kind: CoinKind,
    /// The ticker, else the name. `BCH` for a coin without tokens, and
    /// `CashToken` when no identity may name the category.
    pub title: String,
    /// The full name, when the title is the ticker.
    pub name: Option<String>,
    /// Category id in display order. Shown with any name: names are not unique.
    pub category: Option<String>,
    /// The first and last eight characters of the category id.
    pub category_short: Option<String>,
    /// Fungible amount, scaled by the identity's decimals; base units when no
    /// identity may name the category.
    pub amount: Option<String>,
    /// `Immutable`, `Mutable` or `Minting`, when the coin carries an NFT.
    pub nft_capability: Option<&'static str>,
    /// Why the identity is not current, when it is not.
    pub caveat: Option<&'static str>,
    /// Why a BCH send must leave this coin alone, when it must.
    pub bch_send_refusal: Option<String>,
}

impl CoinLabel {
    /// A coin without tokens.
    pub fn bch() -> Self {
        Self {
            kind: CoinKind::Bch,
            title: "BCH".to_owned(),
            name: None,
            category: None,
            category_short: None,
            amount: None,
            nft_capability: None,
            caveat: None,
            bch_send_refusal: None,
        }
    }

    /// A coin carrying `tokens`, named by `identity` when it may be.
    pub fn tokens(tokens: CoinTokens, identity: Option<&Identity>) -> Self {
        let naming = identity.and_then(Identity::naming);
        let caveat = match (naming, identity) {
            (Some(named), _) => named.status.caveat(),
            (None, Some(identity)) if !identity.status.names_coins() => identity.status.caveat(),
            // Absent, or authenticated but malformed: nothing usable either way.
            _ => IdentityStatus::Unresolved.caveat(),
        };
        let (title, name) = match naming {
            Some(Identity {
                name,
                ticker: Some(ticker),
                ..
            }) => (ticker.clone(), Some(name.clone())),
            Some(identity) => (identity.name.clone(), None),
            None => ("CashToken".to_owned(), None),
        };
        let decimals = naming.map_or(0, |identity| identity.decimals);
        let category = hex_encode(&tokens.category);
        Self {
            kind: match (tokens.amount > 0, tokens.nft.is_some()) {
                (true, true) => CoinKind::FungibleNft,
                (false, true) => CoinKind::Nft,
                (_, false) => CoinKind::Fungible,
            },
            title,
            name,
            category_short: Some(short_category(&category)),
            category: Some(category),
            amount: (tokens.amount > 0 || tokens.nft.is_none())
                .then(|| scaled_amount(tokens.amount, decimals)),
            nft_capability: tokens.nft.map(capability_label),
            caveat,
            bch_send_refusal: Some(SpendError::TokenCoin.to_string()),
        }
    }

    /// A coin reported to carry tokens that could not be read. It is still a
    /// token coin, so it stays out of BCH sends.
    fn unreadable_tokens() -> Self {
        Self {
            kind: CoinKind::UnreadableTokens,
            title: "CashToken".to_owned(),
            caveat: Some("unreadable token data"),
            bch_send_refusal: Some(SpendError::TokenCoin.to_string()),
            ..Self::bch()
        }
    }

    /// Whether a send of BCH alone may spend this coin.
    pub fn spendable_in_bch_send(&self) -> bool {
        self.bch_send_refusal.is_none()
    }
}

/// Label a coin from its tokens, if it has any.
pub fn label(tokens: Option<CoinTokens>, identity: Option<&Identity>) -> CoinLabel {
    tokens.map_or_else(CoinLabel::bch, |tokens| CoinLabel::tokens(tokens, identity))
}

/// Label output `vout` of the complete parent transaction `txid` names.
///
/// The check to make before a spend: a server's coin list can omit token data,
/// the transaction that created the coin cannot. Fails closed when the parent
/// is not the transaction `txid` (display order) names.
pub fn spent_output_label(parent: &[u8], txid: &str, vout: u32) -> Result<CoinLabel> {
    let mut parent_id = tx::double_sha256(parent);
    parent_id.reverse();
    if !hex_encode(&parent_id).eq_ignore_ascii_case(txid) {
        return Err(usage(format!(
            "the parent transaction supplied for {txid}:{vout} is a different transaction"
        )));
    }
    let decoded = tx::decode(parent)?;
    let output = usize::try_from(vout)
        .ok()
        .and_then(|index| decoded.outputs.get(index))
        .ok_or_else(|| usage(format!("transaction {txid} has no output {vout}")))?;
    Ok(label(output.token.as_ref().map(CoinTokens::from), None))
}

/// A coin as a server's coin list reported it, with the identity the wallet
/// resolved for its category: the flat shape that crosses the WASM boundary,
/// one value per field so that no JSON parser is needed on the way in.
///
/// No `category` means the coin carries no tokens. Amounts are decimal
/// strings: they reach 2^63 - 1, past a JavaScript number.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReportedCoin {
    pub category: Option<String>,
    pub amount: Option<String>,
    /// `none`, `mutable` or `minting`, when the coin carries an NFT.
    pub nft_capability: Option<String>,
    pub identity_name: Option<String>,
    pub identity_ticker: Option<String>,
    pub identity_decimals: Option<u32>,
    /// One of the runtime's status names.
    pub identity_status: Option<String>,
}

impl ReportedCoin {
    /// Token fields that do not hold up make the label `UnreadableTokens`:
    /// still a token coin, still kept out of BCH sends. An identity that does
    /// not hold up names nothing.
    pub fn label(&self) -> CoinLabel {
        let Some(category) = self.category.as_deref() else {
            return CoinLabel::bch();
        };
        match self.tokens(category) {
            Ok(tokens) => CoinLabel::tokens(tokens, self.identity().as_ref()),
            Err(_) => CoinLabel::unreadable_tokens(),
        }
    }

    fn tokens(&self, category: &str) -> Result<CoinTokens> {
        let category = token::parse_category(category)?;
        let amount = self.amount.as_deref().map_or(Ok(0), parse_amount)?;
        let nft = self
            .nft_capability
            .as_deref()
            .map(parse_capability)
            .transpose()?;
        if amount == 0 && nft.is_none() {
            return Err(usage(
                "a token coin must carry a fungible amount or an NFT".to_owned(),
            ));
        }
        Ok(CoinTokens {
            category,
            amount,
            nft,
        })
    }

    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            name: self.identity_name.clone()?,
            ticker: self.identity_ticker.clone(),
            decimals: u8::try_from(self.identity_decimals.unwrap_or(0)).ok()?,
            status: self
                .identity_status
                .as_deref()
                .map_or(IdentityStatus::Unresolved, IdentityStatus::from_name),
        })
    }
}

/// Digits only: `str::parse` would also take a sign.
fn parse_amount(text: &str) -> Result<u64> {
    let amount = if text.bytes().all(|byte| byte.is_ascii_digit()) {
        text.parse::<u64>().ok()
    } else {
        None
    };
    amount
        .filter(|amount| *amount <= MAX_FUNGIBLE_AMOUNT)
        .ok_or_else(|| usage(format!("'{text}' is not a fungible token amount")))
}

fn parse_capability(text: &str) -> Result<Capability> {
    match text {
        "none" => Ok(Capability::None),
        "mutable" => Ok(Capability::Mutable),
        "minting" => Ok(Capability::Minting),
        other => Err(usage(format!("'{other}' is not an NFT capability"))),
    }
}

const fn capability_label(capability: Capability) -> &'static str {
    match capability {
        Capability::None => "Immutable",
        Capability::Mutable => "Mutable",
        Capability::Minting => "Minting",
    }
}

/// `amount` base units with `decimals` places, trailing zeros trimmed. Exact:
/// no floating point between the chain and the screen.
fn scaled_amount(amount: u64, decimals: u8) -> String {
    let digits = amount.to_string();
    let places = usize::from(decimals);
    if places == 0 {
        return digits;
    }
    let padded = format!("{digits:0>width$}", width = places + 1);
    let (whole, fraction) = padded.split_at(padded.len() - places);
    match fraction.trim_end_matches('0') {
        "" => whole.to_owned(),
        fraction => format!("{whole}.{fraction}"),
    }
}

/// `category` is 64 ASCII hex characters, so both slices fall on boundaries.
fn short_category(category: &str) -> String {
    format!("{}…{}", &category[..8], &category[category.len() - 8..])
}

fn usage(message: String) -> CliError {
    CliError::Usage(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::Nft;

    /// SeedCash pins this category as MUSD with two decimals; PR #108's live
    /// BCMR run resolved Moria USD / MUSD / 2 decimals. The identity below is
    /// a fixture, not a claim about the registry.
    const MUSD: &str = "b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366";

    fn category(hex: &str) -> [u8; 32] {
        token::parse_category(hex).expect("fixture category is 64 hex characters")
    }

    fn identity(status: IdentityStatus) -> Identity {
        Identity {
            name: "Moria USD".to_owned(),
            ticker: Some("MUSD".to_owned()),
            decimals: 2,
            status,
        }
    }

    fn fungible(amount: u64) -> CoinTokens {
        CoinTokens {
            category: category(MUSD),
            amount,
            nft: None,
        }
    }

    fn reported_musd(amount: &str) -> ReportedCoin {
        ReportedCoin {
            category: Some(MUSD.to_owned()),
            amount: Some(amount.to_owned()),
            identity_name: Some("Moria USD".to_owned()),
            identity_ticker: Some("MUSD".to_owned()),
            identity_decimals: Some(2),
            identity_status: Some("verified".to_owned()),
            ..ReportedCoin::default()
        }
    }

    #[test]
    fn a_plain_coin_is_bch_and_spendable() {
        for label in [label(None, None), ReportedCoin::default().label()] {
            assert_eq!(label.kind, CoinKind::Bch);
            assert_eq!(label.title, "BCH");
            assert!(label.spendable_in_bch_send());
        }
    }

    #[test]
    fn a_verified_fungible_coin_is_named_scaled_and_kept_out_of_bch_sends() {
        let label = CoinLabel::tokens(fungible(12_345), Some(&identity(IdentityStatus::Verified)));
        assert_eq!(label, reported_musd("12345").label());
        assert_eq!(label.kind, CoinKind::Fungible);
        assert_eq!(label.title, "MUSD");
        assert_eq!(label.name.as_deref(), Some("Moria USD"));
        assert_eq!(label.amount.as_deref(), Some("123.45"));
        assert_eq!(label.category.as_deref(), Some(MUSD));
        assert_eq!(label.category_short.as_deref(), Some("b38a33f7…ed87f366"));
        assert_eq!(label.caveat, None);
        assert_eq!(
            label.bch_send_refusal.as_deref(),
            Some("token-bearing coins require a token-aware transfer")
        );
        assert!(!label.spendable_in_bch_send());
    }

    #[test]
    fn a_last_known_identity_names_the_coin_with_its_caveat() {
        let label = CoinLabel::tokens(fungible(100), Some(&identity(IdentityStatus::Stale)));
        assert_eq!(label.title, "MUSD");
        assert_eq!(label.amount.as_deref(), Some("1"));
        assert_eq!(label.caveat, Some("last known"));
    }

    #[test]
    fn an_unauthenticated_identity_never_names_the_coin() {
        for (status, caveat) in [
            (IdentityStatus::Unpublished, "no registry published"),
            (IdentityStatus::Unresolved, "unverified"),
        ] {
            let label = CoinLabel::tokens(fungible(12_345), Some(&identity(status)));
            assert_eq!(label.title, "CashToken");
            assert_eq!(label.name, None);
            // Without decimals from an authenticated identity, base units.
            assert_eq!(label.amount.as_deref(), Some("12345"));
            assert_eq!(label.caveat, Some(caveat));
            assert_eq!(label.category.as_deref(), Some(MUSD));
            assert!(!label.spendable_in_bch_send());
        }
        let label = CoinLabel::tokens(fungible(5), None);
        assert_eq!(label.title, "CashToken");
        assert_eq!(label.caveat, Some("unverified"));
    }

    #[test]
    fn an_unknown_identity_status_reads_as_unresolved() {
        assert_eq!(
            IdentityStatus::from_name("trusted"),
            IdentityStatus::Unresolved
        );
        assert_eq!(
            IdentityStatus::from_name("Verified"),
            IdentityStatus::Unresolved
        );
        let mut coin = reported_musd("1");
        coin.identity_status = Some("trusted".to_owned());
        assert_eq!(coin.label().title, "CashToken");
        coin.identity_status = None;
        assert_eq!(coin.label().title, "CashToken");
    }

    #[test]
    fn a_malformed_verified_identity_is_not_used() {
        let mut too_many_decimals = identity(IdentityStatus::Verified);
        too_many_decimals.decimals = 19;
        let mut control_ticker = identity(IdentityStatus::Verified);
        control_ticker.ticker = Some("MU\u{0007}SD".to_owned());
        let mut empty_name = identity(IdentityStatus::Verified);
        empty_name.name.clear();
        for bad in [too_many_decimals, control_ticker, empty_name] {
            let label = CoinLabel::tokens(fungible(12_345), Some(&bad));
            assert_eq!(label.title, "CashToken");
            assert_eq!(label.amount.as_deref(), Some("12345"));
            assert_eq!(label.caveat, Some("unverified"));
        }
        // Decimals past a byte drop the identity before it is judged.
        let mut coin = reported_musd("12345");
        coin.identity_decimals = Some(300);
        let label = coin.label();
        assert_eq!(label.title, "CashToken");
        assert_eq!(label.amount.as_deref(), Some("12345"));
        assert_eq!(label.caveat, Some("unverified"));
    }

    #[test]
    fn a_name_without_a_ticker_is_the_title() {
        let mut furu = identity(IdentityStatus::Verified);
        furu.name = "Furu Tokens".to_owned();
        furu.ticker = None;
        furu.decimals = 0;
        let label = CoinLabel::tokens(fungible(7), Some(&furu));
        assert_eq!(label.title, "Furu Tokens");
        assert_eq!(label.name, None);
        assert_eq!(label.amount.as_deref(), Some("7"));
    }

    #[test]
    fn the_same_ticker_on_two_categories_stays_distinguishable() {
        let impostor = CoinTokens {
            category: [0xab; 32],
            ..fungible(12_345)
        };
        let genuine =
            CoinLabel::tokens(fungible(12_345), Some(&identity(IdentityStatus::Verified)));
        let copy = CoinLabel::tokens(impostor, Some(&identity(IdentityStatus::Verified)));
        assert_eq!(genuine.title, copy.title);
        assert_ne!(genuine.category_short, copy.category_short);
    }

    #[test]
    fn nfts_carry_their_capability_and_no_amount_unless_fungible_too() {
        let minting = CoinTokens {
            nft: Some(Capability::Minting),
            ..fungible(0)
        };
        let label = CoinLabel::tokens(minting, Some(&identity(IdentityStatus::Verified)));
        assert_eq!(label.kind, CoinKind::Nft);
        assert_eq!(label.nft_capability, Some("Minting"));
        assert_eq!(label.amount, None);
        assert!(!label.spendable_in_bch_send());

        let both = CoinTokens {
            nft: Some(Capability::None),
            ..fungible(250)
        };
        let label = CoinLabel::tokens(both, Some(&identity(IdentityStatus::Verified)));
        assert_eq!(label.kind, CoinKind::FungibleNft);
        assert_eq!(label.nft_capability, Some("Immutable"));
        assert_eq!(label.amount.as_deref(), Some("2.5"));

        let reported = ReportedCoin {
            category: Some("cd".repeat(32)),
            nft_capability: Some("mutable".to_owned()),
            ..ReportedCoin::default()
        }
        .label();
        assert_eq!(reported.kind, CoinKind::Nft);
        assert_eq!(reported.title, "CashToken");
        assert_eq!(reported.nft_capability, Some("Mutable"));
        assert_eq!(reported.caveat, Some("unverified"));
    }

    #[test]
    fn amounts_scale_exactly() {
        assert_eq!(scaled_amount(0, 2), "0");
        assert_eq!(scaled_amount(5, 2), "0.05");
        assert_eq!(scaled_amount(1_200, 2), "12");
        assert_eq!(scaled_amount(1_201, 2), "12.01");
        assert_eq!(scaled_amount(42, 0), "42");
        assert_eq!(
            scaled_amount(MAX_FUNGIBLE_AMOUNT, 2),
            "92233720368547758.07"
        );
        assert_eq!(scaled_amount(1, MAX_DECIMALS), "0.000000000000000001");
        assert_eq!(
            scaled_amount(MAX_FUNGIBLE_AMOUNT, MAX_DECIMALS),
            "9.223372036854775807"
        );
    }

    #[test]
    fn unreadable_token_data_is_still_a_token_coin() {
        let unreadable = [
            ReportedCoin {
                category: Some("zz".to_owned()),
                ..reported_musd("1")
            },
            ReportedCoin {
                category: Some(String::new()),
                ..reported_musd("1")
            },
            reported_musd("1e21"),
            reported_musd("+5"),
            reported_musd(""),
            reported_musd("9223372036854775808"),
            reported_musd("0"),
            ReportedCoin {
                nft_capability: Some("burnable".to_owned()),
                ..reported_musd("1")
            },
        ];
        for coin in unreadable {
            let label = coin.label();
            assert_eq!(label.kind, CoinKind::UnreadableTokens, "{coin:?}");
            assert_eq!(label.title, "CashToken");
            assert_eq!(label.caveat, Some("unreadable token data"));
            assert!(!label.spendable_in_bch_send());
        }
    }

    #[test]
    fn labels_serialize_for_the_renderer() {
        let json = serde_json::to_value(reported_musd("12345").label()).expect("labels serialize");
        assert_eq!(json["kind"], "fungible");
        assert_eq!(json["title"], "MUSD");
        assert_eq!(json["amount"], "123.45");
        assert_eq!(json["nft_capability"], serde_json::Value::Null);
        let json = serde_json::to_value(CoinLabel::bch()).expect("labels serialize");
        assert_eq!(json["kind"], "bch");
        assert_eq!(json["bch_send_refusal"], serde_json::Value::Null);
        let json = serde_json::to_value(CoinLabel::unreadable_tokens()).expect("labels serialize");
        assert_eq!(json["kind"], "unreadable_tokens");
    }

    fn parent(outputs: Vec<tx::Output>) -> (Vec<u8>, String) {
        let spent = tx::Utxo {
            txid: [0x11; 32],
            vout: 0,
            value: 0,
            script_pubkey: Vec::new(),
        };
        let raw = tx::Transaction::new(vec![spent], outputs)
            .serialize_with_sequences(&[Vec::new()], &[u32::MAX])
            .expect("one input, one script and one sequence");
        let mut id = tx::double_sha256(&raw);
        id.reverse();
        (raw, hex_encode(&id))
    }

    fn p2pkh() -> Vec<u8> {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&[0x42; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        script
    }

    #[test]
    fn the_parent_transaction_decides_whether_a_coin_carries_tokens() {
        let tokens = TokenData {
            category: category(MUSD),
            amount: 1_000,
            nft: Some(Nft {
                capability: Capability::Minting,
                commitment: vec![0x01],
            }),
        };
        let prefix = tokens.encode_prefix().expect("a valid token prefix");
        let (raw, txid) = parent(vec![
            tx::Output::new(50_000, p2pkh()),
            tx::Output::with_tokens(1_000, p2pkh(), prefix),
        ]);

        let plain = spent_output_label(&raw, &txid, 0).expect("output 0 exists");
        assert!(plain.spendable_in_bch_send());

        let token =
            spent_output_label(&raw, &txid.to_ascii_uppercase(), 1).expect("output 1 exists");
        assert_eq!(token.kind, CoinKind::FungibleNft);
        assert_eq!(token.category.as_deref(), Some(MUSD));
        assert_eq!(token.amount.as_deref(), Some("1000"));
        assert!(!token.spendable_in_bch_send());
    }

    #[test]
    fn a_parent_that_is_not_the_named_transaction_is_refused() {
        let (raw, txid) = parent(vec![tx::Output::new(50_000, p2pkh())]);
        let other = "00".repeat(32);
        assert!(spent_output_label(&raw, &other, 0).is_err());
        assert!(spent_output_label(&raw, &txid, 1).is_err());
        let mut truncated = raw.clone();
        truncated.pop();
        let mut truncated_id = tx::double_sha256(&truncated);
        truncated_id.reverse();
        assert!(spent_output_label(&truncated, &hex_encode(&truncated_id), 0).is_err());
    }
}
