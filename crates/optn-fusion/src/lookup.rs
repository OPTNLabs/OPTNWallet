//! Chain evidence for a round: is a claimed input unspent, and does the
//! network have a transaction.
//!
//! The round never speaks a chain protocol itself. The host supplies an
//! [`InputLookups`] over the chain sources it selected, on connections of the
//! round's own, and this module turns what a source said into a verdict. That
//! keeps the one rule that matters here in one place: only a source's
//! definite answer can count against a peer. A lookup that could not be made
//! is an error, and an error never becomes blame.

use std::future::Future;
use std::pin::Pin;

use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

use crate::{pb, schnorr};

pub type LookupFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One output to ask about: the script that should hold it, its txid in
/// internal byte order, and its index.
pub type OutputQuestion = (Vec<u8>, [u8; 32], u32);

/// A source's answers, one per question; `Err` is a question it could not
/// answer.
pub type OutputAnswers = Vec<Result<OutputAnswer, String>>;

/// A chain source's answer about one output of one script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputAnswer {
    /// The script's unspent outputs hold it, with this value.
    Unspent { value_sats: u64 },
    /// The script's unspent outputs, as the source gave them in full, do not
    /// hold it.
    NotUnspent,
}

/// What a source's answer means for a peer's claimed input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputLookup {
    Match,
    Mismatch(String),
}

/// The chain sources a round may ask. Implementations try their sources in
/// order and return the first definite answer; `Err` means none could give
/// one.
pub trait InputLookups: Send + Sync {
    /// Whether `script_pubkey`'s unspent outputs hold `txid:vout` (txid in
    /// internal byte order), for each output asked, in order. The outer `Err`
    /// means no source could be asked at all.
    fn unspent_outputs<'a>(
        &'a self,
        outputs: &'a [OutputQuestion],
    ) -> LookupFuture<'a, Result<OutputAnswers, String>>;

    /// `Ok(true)` once a source returns the exact transaction (txid in
    /// internal byte order). No source having it is an `Err`: a source that
    /// lacks it may only be behind.
    fn transaction_is_known<'a>(&'a self, txid: [u8; 32])
        -> LookupFuture<'a, Result<bool, String>>;
}

/// The P2PKH script a CashFusion input's compressed `pubkey` controls.
pub fn p2pkh_script(pubkey: &[u8]) -> Result<Vec<u8>, String> {
    if pubkey.len() != 33 || !matches!(pubkey.first(), Some(0x02 | 0x03)) {
        return Err("peer input pubkey must be compressed (33 bytes)".into());
    }
    schnorr::parse_point(pubkey)
        .map_err(|_| "peer input pubkey is not a valid compressed secp256k1 key".to_string())?;
    let hash = Ripemd160::digest(Sha256::digest(pubkey));
    let mut script = Vec::with_capacity(25);
    script.extend_from_slice(&[0x76, 0xa9, 0x14]);
    script.extend_from_slice(&hash);
    script.extend_from_slice(&[0x88, 0xac]);
    Ok(script)
}

/// The question to ask about a claimed input: its pubkey's script and its
/// outpoint.
pub fn input_question(input: &pb::InputComponent) -> Result<OutputQuestion, String> {
    let txid: [u8; 32] = input
        .prev_txid
        .as_slice()
        .try_into()
        .map_err(|_| "peer input prev_txid must be exactly 32 bytes".to_string())?;
    Ok((p2pkh_script(&input.pubkey)?, txid, input.prev_index))
}

/// A claimed input against a source's answer. Its value must be exact; an
/// unconfirmed output counts as unspent, as it does for the server.
pub fn judge_input(input: &pb::InputComponent, answer: OutputAnswer) -> InputLookup {
    match answer {
        OutputAnswer::NotUnspent => {
            InputLookup::Mismatch("claimed outpoint is not unspent for the peer pubkey".into())
        }
        OutputAnswer::Unspent { value_sats } if value_sats != input.amount => {
            InputLookup::Mismatch(format!(
                "claimed value {} does not match the chain's value {value_sats}",
                input.amount
            ))
        }
        OutputAnswer::Unspent { .. } => InputLookup::Match,
    }
}

/// Check claimed inputs, in order. An input that cannot be asked about (a
/// malformed pubkey or txid) or that no source could answer is an `Err` in
/// its place, never a mismatch.
pub async fn verify_inputs(
    lookups: &dyn InputLookups,
    inputs: &[&pb::InputComponent],
) -> Result<Vec<Result<InputLookup, String>>, String> {
    let questions: Vec<Result<OutputQuestion, String>> =
        inputs.iter().map(|input| input_question(input)).collect();
    let askable: Vec<OutputQuestion> = questions
        .iter()
        .filter_map(|question| question.clone().ok())
        .collect();
    let mut answers = if askable.is_empty() {
        Vec::new()
    } else {
        lookups.unspent_outputs(&askable).await?
    }
    .into_iter();
    if answers.len() != askable.len() {
        return Err("a chain source answered a different number of inputs".into());
    }
    Ok(inputs
        .iter()
        .zip(questions)
        .map(|(input, question)| {
            question?;
            let answer = answers.next().expect("one answer per askable input")?;
            Ok(judge_input(input, answer))
        })
        .collect())
}

/// Check one claimed input.
pub async fn verify_input(
    lookups: &dyn InputLookups,
    input: &pb::InputComponent,
) -> Result<InputLookup, String> {
    verify_inputs(lookups, &[input])
        .await?
        .pop()
        .expect("one result per input")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Answers scripted in order; `None` is a source that could not answer.
    #[derive(Default)]
    pub(crate) struct ScriptedLookups {
        pub(crate) rounds: Mutex<Vec<Option<OutputAnswers>>>,
        pub(crate) asked: Mutex<Vec<Vec<OutputQuestion>>>,
        pub(crate) known: Mutex<Vec<Result<bool, String>>>,
    }

    impl ScriptedLookups {
        pub(crate) fn answering(rounds: Vec<Option<OutputAnswers>>) -> Self {
            Self {
                rounds: Mutex::new(rounds.into_iter().rev().collect()),
                ..Self::default()
            }
        }
    }

    impl InputLookups for ScriptedLookups {
        fn unspent_outputs<'a>(
            &'a self,
            outputs: &'a [OutputQuestion],
        ) -> LookupFuture<'a, Result<OutputAnswers, String>> {
            self.asked.lock().unwrap().push(outputs.to_vec());
            let round = self.rounds.lock().unwrap().pop().flatten();
            Box::pin(async move { round.ok_or_else(|| "no source could answer".to_string()) })
        }

        fn transaction_is_known<'a>(
            &'a self,
            _txid: [u8; 32],
        ) -> LookupFuture<'a, Result<bool, String>> {
            let answer = self
                .known
                .lock()
                .unwrap()
                .pop()
                .unwrap_or_else(|| Err("no source has it".into()));
            Box::pin(async move { answer })
        }
    }

    pub(crate) fn decode_hex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn input() -> pb::InputComponent {
        pb::InputComponent {
            prev_txid: (0u8..32).collect(),
            prev_index: 7,
            pubkey: decode_hex(
                "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            ),
            amount: 12_345,
        }
    }

    #[test]
    fn derives_the_reference_p2pkh_script() {
        // HASH160 of the secp256k1 generator's compressed key.
        assert_eq!(
            p2pkh_script(&input().pubkey).unwrap(),
            decode_hex("76a914751e76e8199196d454941c45d1b3a323f1433bd688ac")
        );
    }

    #[test]
    fn refuses_keys_and_txids_it_cannot_ask_about() {
        assert!(p2pkh_script(&[0x04; 65])
            .unwrap_err()
            .contains("compressed"));
        let mut off_curve = input().pubkey;
        off_curve[1..].fill(0xff);
        assert!(p2pkh_script(&off_curve).unwrap_err().contains("valid"));
        let mut short = input();
        short.prev_txid.pop();
        assert!(input_question(&short).unwrap_err().contains("32 bytes"));
    }

    #[test]
    fn only_an_exact_unspent_output_matches() {
        assert_eq!(
            judge_input(&input(), OutputAnswer::Unspent { value_sats: 12_345 }),
            InputLookup::Match
        );
        for (answer, reason) in [
            (OutputAnswer::NotUnspent, "not unspent"),
            (OutputAnswer::Unspent { value_sats: 12_344 }, "value"),
        ] {
            match judge_input(&input(), answer) {
                InputLookup::Mismatch(found) => assert!(found.contains(reason), "{found}"),
                InputLookup::Match => panic!("{answer:?} must not match"),
            }
        }
    }

    #[tokio::test]
    async fn asks_once_for_every_askable_input_and_keeps_their_order() {
        let mut bad = input();
        bad.pubkey = vec![0x04; 65];
        let other = pb::InputComponent {
            prev_index: 8,
            ..input()
        };
        let lookups = ScriptedLookups::answering(vec![Some(vec![
            Ok(OutputAnswer::Unspent { value_sats: 12_345 }),
            Err("that server timed out".into()),
        ])]);
        let results = verify_inputs(&lookups, &[&input(), &bad, &other])
            .await
            .unwrap();
        assert_eq!(results[0], Ok(InputLookup::Match));
        assert!(results[1].as_ref().unwrap_err().contains("compressed"));
        assert_eq!(results[2], Err("that server timed out".into()));
        let asked = lookups.asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 1);
        assert_eq!(
            asked[0]
                .iter()
                .map(|(_, txid, vout)| (txid[0], *vout))
                .collect::<Vec<_>>(),
            vec![(0, 7), (0, 8)]
        );
    }

    #[tokio::test]
    async fn no_source_and_a_short_answer_are_errors_not_mismatches() {
        let none = ScriptedLookups::answering(vec![None]);
        assert!(verify_input(&none, &input()).await.is_err());
        let short = ScriptedLookups::answering(vec![Some(vec![])]);
        assert!(verify_input(&short, &input())
            .await
            .unwrap_err()
            .contains("different number"));
    }
}
