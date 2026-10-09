//! A CashFusion round's chain evidence: are claimed inputs unspent, and does
//! the network have a transaction.
//!
//! The round asks the holder's selected Electrum servers, each over a
//! connection of the round's own: a loopback server directly, any other only
//! through Tor, with isolation credentials no wallet connection shares
//! (`optn_chain_native::connect_fusion_lookup`). So a server cannot tie the
//! round's questions about other players' coins to this wallet's own
//! subscriptions.
//!
//! The protocol work stays in the shared adapter; this module only orders the
//! servers. A definite answer from any server settles a question. A server
//! that cannot answer passes it to the next, and when none can, the question
//! is an error, which the round never turns into blame.

use std::sync::Arc;
use std::time::Duration;

use optn_chain_native::ElectrumBackend;
use optn_runtime::chain_service::{ChainBackend, ChainPayload, ChainRequest};

use optn_fusion::lookup::{
    InputLookups, LookupFuture, OutputAnswer, OutputAnswers, OutputQuestion,
};

/// An Electrum server a round may ask: the holder's selection, primary first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LookupEndpoint {
    pub host: String,
    pub port: u16,
    pub tls: bool,
}

/// Opening a round's connection: Tor circuit, TLS, `server.version`,
/// `server.features` and the genesis check.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

type Outputs = [OutputQuestion];

/// A server's values for the outputs asked, one each: `None` when the
/// script's unspent list does not hold it, `Err` when that answer was unusable.
type ServerValues = Vec<Result<Option<u64>, String>>;

/// One server a round may ask.
pub trait LookupServer: Send + Sync {
    fn label(&self) -> String;
    /// The value at which each script's unspent list holds each output, or
    /// `None` when it does not.
    fn unspent_values<'a>(
        &'a self,
        outputs: &'a Outputs,
    ) -> LookupFuture<'a, Result<ServerValues, String>>;
    /// The raw bytes the server returns for `txid` (internal byte order).
    fn transaction<'a>(&'a self, txid: [u8; 32]) -> LookupFuture<'a, Result<Vec<u8>, String>>;
}

/// An Electrum server, connected on first use and kept for the round.
struct ElectrumLookupServer {
    network: optn_core::network::Network,
    server: LookupEndpoint,
    socks_port: Option<u16>,
    backend: tokio::sync::Mutex<Option<Arc<ElectrumBackend>>>,
}

impl ElectrumLookupServer {
    async fn backend(&self) -> Result<Arc<ElectrumBackend>, String> {
        let mut slot = self.backend.lock().await;
        if let Some(backend) = slot.as_ref() {
            return Ok(backend.clone());
        }
        let connected = tokio::time::timeout(
            CONNECT_TIMEOUT,
            optn_chain_native::connect_fusion_lookup(
                self.network,
                &self.server.host,
                self.server.port,
                self.server.tls,
                self.socks_port,
            ),
        )
        .await
        .map_err(|_| "connecting timed out".to_string())??;
        let backend = Arc::new(connected);
        *slot = Some(backend.clone());
        Ok(backend)
    }
}

impl LookupServer for ElectrumLookupServer {
    fn label(&self) -> String {
        format!("{}:{}", self.server.host, self.server.port)
    }

    fn unspent_values<'a>(
        &'a self,
        outputs: &'a Outputs,
    ) -> LookupFuture<'a, Result<ServerValues, String>> {
        Box::pin(async move {
            let backend = self.backend().await?;
            let answers = backend
                .script_unspent_values(outputs)
                .await
                .map_err(|error| format!("{error:?}"))?;
            Ok(answers
                .into_iter()
                .map(|answer| answer.map_err(|error| format!("{error:?}")))
                .collect())
        })
    }

    fn transaction<'a>(&'a self, txid: [u8; 32]) -> LookupFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            let backend = self.backend().await?;
            let observation = backend
                .execute(&ChainRequest::TransactionLookup { txid })
                .await
                .map_err(|error| format!("{error:?}"))?;
            match observation.payload {
                ChainPayload::Transaction(transaction) => Ok(transaction.raw),
                _ => Err("answered a transaction lookup with something else".into()),
            }
        })
    }
}

/// The servers a round asks, in the holder's order.
pub struct ChainInputLookups {
    servers: Vec<Box<dyn LookupServer>>,
}

impl ChainInputLookups {
    /// The selected Electrum servers on `network`. `socks_port` is the round's
    /// verified Tor proxy; without one, only loopback servers can be asked.
    pub fn electrum(
        network: optn_core::network::Network,
        servers: Vec<LookupEndpoint>,
        socks_port: Option<u16>,
    ) -> Self {
        Self::over(
            servers
                .into_iter()
                .map(|server| {
                    Box::new(ElectrumLookupServer {
                        network,
                        server,
                        socks_port,
                        backend: tokio::sync::Mutex::new(None),
                    }) as Box<dyn LookupServer>
                })
                .collect(),
        )
    }

    pub fn over(servers: Vec<Box<dyn LookupServer>>) -> Self {
        Self { servers }
    }
}

impl InputLookups for ChainInputLookups {
    fn unspent_outputs<'a>(
        &'a self,
        outputs: &'a Outputs,
    ) -> LookupFuture<'a, Result<OutputAnswers, String>> {
        Box::pin(async move {
            // `None` until some server gives a definite answer or an error.
            let mut answers: Vec<Option<Result<OutputAnswer, String>>> = vec![None; outputs.len()];
            let mut last_error = String::from("no Electrum server is selected for input lookups");
            for server in &self.servers {
                let open: Vec<usize> = (0..outputs.len())
                    .filter(|index| !matches!(answers[*index], Some(Ok(_))))
                    .collect();
                if open.is_empty() {
                    break;
                }
                let asked: Vec<OutputQuestion> =
                    open.iter().map(|index| outputs[*index].clone()).collect();
                let label = server.label();
                match server.unspent_values(&asked).await {
                    Ok(replies) if replies.len() == asked.len() => {
                        for (index, reply) in open.into_iter().zip(replies) {
                            answers[index] = Some(
                                reply
                                    .map(|value| match value {
                                        Some(value_sats) => OutputAnswer::Unspent { value_sats },
                                        None => OutputAnswer::NotUnspent,
                                    })
                                    .map_err(|error| format!("{label}: {error}")),
                            );
                        }
                    }
                    Ok(_) => {
                        last_error = format!("{label}: answered a different number of outputs")
                    }
                    Err(error) => last_error = format!("{label}: {error}"),
                }
            }
            if answers.iter().all(Option::is_none) {
                return Err(last_error);
            }
            Ok(answers
                .into_iter()
                .map(|answer| answer.unwrap_or_else(|| Err(last_error.clone())))
                .collect())
        })
    }

    fn transaction_is_known<'a>(
        &'a self,
        txid: [u8; 32],
    ) -> LookupFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            let mut last_error = String::from("no Electrum server is selected for this check");
            for server in &self.servers {
                let label = server.label();
                match server.transaction(txid).await {
                    // Only the exact bytes settle it.
                    Ok(raw) if optn_core::header_hash::sha256d(&raw) == txid => return Ok(true),
                    Ok(_) => last_error = format!("{label}: returned a different transaction"),
                    // A server that lacks it may only be behind.
                    Err(error) => last_error = format!("{label}: {error}"),
                }
            }
            Err(last_error)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Answers scripted per call; `Err` is a server that could not answer.
    struct Scripted {
        name: &'static str,
        unspent: Mutex<Vec<Result<ServerValues, String>>>,
        raw: Result<Vec<u8>, String>,
        asked: Arc<Mutex<Vec<(&'static str, usize)>>>,
    }

    impl LookupServer for Scripted {
        fn label(&self) -> String {
            self.name.into()
        }
        fn unspent_values<'a>(
            &'a self,
            outputs: &'a Outputs,
        ) -> LookupFuture<'a, Result<ServerValues, String>> {
            self.asked.lock().unwrap().push((self.name, outputs.len()));
            let answer = self.unspent.lock().unwrap().remove(0);
            Box::pin(async move { answer })
        }
        fn transaction<'a>(&'a self, _txid: [u8; 32]) -> LookupFuture<'a, Result<Vec<u8>, String>> {
            let raw = self.raw.clone();
            Box::pin(async move { raw })
        }
    }

    fn scripted(
        name: &'static str,
        unspent: Vec<Result<ServerValues, String>>,
        raw: Result<Vec<u8>, String>,
        asked: &Arc<Mutex<Vec<(&'static str, usize)>>>,
    ) -> Box<dyn LookupServer> {
        Box::new(Scripted {
            name,
            unspent: Mutex::new(unspent),
            raw,
            asked: asked.clone(),
        })
    }

    fn outputs(count: u32) -> Vec<OutputQuestion> {
        (0..count).map(|vout| (vec![0x51], [1; 32], vout)).collect()
    }

    #[tokio::test]
    async fn a_definite_answer_settles_and_only_unanswered_questions_move_on() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let lookups = ChainInputLookups::over(vec![
            scripted(
                "down",
                vec![Err("connecting timed out".into())],
                Err("".into()),
                &asked,
            ),
            scripted(
                "partial",
                vec![Ok(vec![Ok(Some(5)), Err("bad list".into()), Ok(None)])],
                Err("".into()),
                &asked,
            ),
            scripted("last", vec![Ok(vec![Ok(Some(9))])], Err("".into()), &asked),
        ]);
        let answers = lookups.unspent_outputs(&outputs(3)).await.unwrap();
        assert_eq!(
            answers,
            vec![
                Ok(OutputAnswer::Unspent { value_sats: 5 }),
                Ok(OutputAnswer::Unspent { value_sats: 9 }),
                Ok(OutputAnswer::NotUnspent),
            ]
        );
        assert_eq!(
            *asked.lock().unwrap(),
            vec![("down", 3), ("partial", 3), ("last", 1)]
        );
    }

    #[tokio::test]
    async fn no_server_answering_is_an_error_never_an_absence() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let none = ChainInputLookups::over(vec![]);
        assert!(none.unspent_outputs(&outputs(1)).await.is_err());
        let down = ChainInputLookups::over(vec![scripted(
            "down",
            vec![Err("connecting timed out".into())],
            Err("not found".into()),
            &asked,
        )]);
        assert_eq!(
            down.unspent_outputs(&outputs(1)).await,
            Err("down: connecting timed out".into())
        );
        assert_eq!(
            down.transaction_is_known([2; 32]).await,
            Err("down: not found".into())
        );
        // A server whose own answer was malformed leaves that one unsettled.
        let malformed = ChainInputLookups::over(vec![scripted(
            "odd",
            vec![Ok(vec![Err("lists an output twice".into())])],
            Err("".into()),
            &asked,
        )]);
        assert_eq!(
            malformed.unspent_outputs(&outputs(1)).await.unwrap(),
            vec![Err("odd: lists an output twice".into())]
        );
    }

    #[tokio::test]
    async fn only_the_exact_bytes_make_a_transaction_known() {
        let raw = vec![2, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let txid = optn_core::header_hash::sha256d(&raw);
        let asked = Arc::new(Mutex::new(Vec::new()));
        let lookups = ChainInputLookups::over(vec![
            scripted("liar", vec![], Ok(vec![9, 9]), &asked),
            scripted("behind", vec![], Err("no such transaction".into()), &asked),
            scripted("good", vec![], Ok(raw), &asked),
        ]);
        assert_eq!(lookups.transaction_is_known(txid).await, Ok(true));
        let wrong = ChainInputLookups::over(vec![scripted("liar", vec![], Ok(vec![9]), &asked)]);
        assert_eq!(
            wrong.transaction_is_known(txid).await,
            Err("liar: returned a different transaction".into())
        );
    }

    /// The round's connection rule: remote servers need the verified proxy.
    #[test]
    fn a_remote_server_without_tor_is_refused_before_dialling() {
        let config = optn_chain_native::fusion_lookup_config(
            optn_core::network::Network::Chipnet,
            "chip.example",
            50002,
            true,
            None,
        );
        assert!(config.unwrap_err().contains("only through Tor"));
    }
}
