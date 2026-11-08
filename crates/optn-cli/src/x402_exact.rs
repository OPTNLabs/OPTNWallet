//! Native CLI adapter for the shared wallet payment lifecycle and BCH SDK.
use crate::{
    error::{CliError, Result},
    Cli, Network,
};
use clap::Args;
use optn_core::payment::{PaymentIntent, PaymentRecord};
use optn_runtime::external_payment::PaymentOperation;
use optn_x402::{x402_chain_bch::BchChainReference, Offer, PaymentSources, PreparedWallet};
use serde_json::{json, Value};
use std::path::PathBuf;

// Keep protocol workflows out of the legacy dispatcher's large async frame.
// This also retains the same CLI capability gate for every entry point.
pub fn dispatch<'a>(
    cli: &'a Cli,
    action: &'a crate::X402Command,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + 'a>> {
    Box::pin(async move {
        crate::authorize_command(cli)?;
        match action {
            crate::X402Command::Check(request) => Box::pin(check(cli, request)).await,
            crate::X402Command::Pay(args) => Box::pin(pay(cli, args)).await,
            crate::X402Command::Status { payment_id } => Box::pin(status(cli, payment_id)).await,
            _ => unreachable!("legacy x402 has its own adapter"),
        }
    })
}

#[derive(Args)]
pub struct Request {
    pub url: String,
    #[arg(long = "header", short = 'H')]
    pub headers: Vec<String>,
    #[arg(long, short = 'X', default_value = "GET")]
    pub method: String,
    #[arg(long)]
    pub data: Option<String>,
}

#[derive(Args)]
pub struct Pay {
    #[command(flatten)]
    pub request: Request,
    /// Stable id for this purchase. Reuse it after an uncertain response.
    #[arg(long)]
    pub payment_id: String,
    /// Maximum merchant amount in satoshis; network fees have their own cap.
    #[arg(long)]
    pub max_sats: u64,
    #[arg(long, default_value_t = 10_000)]
    pub max_fee_sats: u64,
    #[arg(long, default_value_t = 1)]
    pub fee_rate: u64,
    #[arg(long, default_value_t = 20)]
    pub gap: u32,
    /// Import a finalized raw transaction as hex, validated against this wallet.
    #[arg(long)]
    pub transaction: Option<PathBuf>,
    /// Inspect the quote only. Never signs, reserves inputs or emits a payment header.
    #[arg(long)]
    pub dry_run: bool,
    /// Approve this bounded payment, including external settlement of signed bytes.
    #[arg(long)]
    pub yes: bool,
}

struct Attempt {
    status: u16,
    body: String,
    required: Option<String>,
    response: Option<String>,
}
struct Http {
    client: reqwest::Client,
    url: reqwest::Url,
    method: reqwest::Method,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

fn chain(network: Network) -> Result<BchChainReference> {
    match network { Network::Mainnet => Ok(BchChainReference::Mainnet), Network::Chipnet => Ok(BchChainReference::Chipnet),
        _ => Err(CliError::Usage("x402 BCH exact supports mainnet and Chipnet; bchtest is not a testnet3/testnet4 selector".into())) }
}

impl Http {
    async fn new(cli: &Cli, request: &Request) -> Result<Self> {
        let url = reqwest::Url::parse(&request.url)
            .map_err(|_| CliError::Usage("Invalid HTTP URL".into()))?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(CliError::Usage(
                "Resource URLs cannot contain credentials or fragments".into(),
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| CliError::Usage("Resource URL has no host".into()))?;
        let local = optn_core::endpoint::is_loopback_host(host);
        if url.scheme() != "https" && !(url.scheme() == "http" && local) {
            return Err(CliError::Usage(
                "x402 requires HTTPS, except on loopback".into(),
            ));
        }
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(crate::timeout_seconds(cli)))
            .user_agent(concat!("optn/", env!("CARGO_PKG_VERSION")));
        // A deliberate loopback resource has no remote DNS or privacy hop.
        if !local {
            let selection = crate::network_settings::shared_chain_selection(
                cli.network,
                cli.network_config_dir.as_deref(),
            )
            .map_err(CliError::Usage)?
            .ok_or_else(|| CliError::Usage("No shared network policy".into()))?;
            use optn_runtime::chain::SourceScope;
            let public = |scope: &SourceScope| {
                matches!(scope, SourceScope::AllEnabled | SourceScope::PublicEnabled)
            };
            let allowed = public(&selection.policy.primary_scope)
                || selection.policy.fallback_scope.as_ref().is_some_and(public);
            let ports = crate::network_settings::trusted_socks_ports(
                cli.network,
                cli.network_config_dir.as_deref(),
            );
            let tor = optn_chain_native::tor_status_from_trust(optn_chain_native::TorProxyTrust {
                managed: &[],
                trusted: &ports,
            })
            .await;
            match optn_core::tor::outbound_route(allowed, tor) {
                optn_core::tor::Route::Direct => {}
                optn_core::tor::Route::Through { socks_port } => {
                    builder = builder.proxy(
                        reqwest::Proxy::all(format!("socks5h://127.0.0.1:{socks_port}"))
                            .map_err(|e| CliError::Network(e.to_string()))?,
                    );
                }
                _ => {
                    return Err(CliError::Usage(
                        "Shared network policy requires verified Tor for this resource".into(),
                    ))
                }
            }
        }
        let headers = request
            .headers
            .iter()
            .map(|raw| {
                let (name, value) = crate::x402::parse_header(raw)?;
                if [
                    "payment-required",
                    "payment-response",
                    "x-payment",
                    "x-payment-response",
                    "host",
                    "content-length",
                    "transfer-encoding",
                ]
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved))
                {
                    return Err(CliError::Usage(
                        "Protocol and routing headers are managed by x402".into(),
                    ));
                }
                Ok((name, value))
            })
            .collect::<Result<Vec<_>>>()?;
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| CliError::Usage("Invalid HTTP method".into()))?;
        Ok(Self {
            client: builder
                .build()
                .map_err(|e| CliError::Network(e.to_string()))?,
            url,
            method,
            headers,
            body: request.data.clone(),
        })
    }

    async fn send(&self, payment: Option<&str>) -> Result<Attempt> {
        let mut request = self.client.request(self.method.clone(), self.url.clone());
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        if let Some(body) = &self.body {
            request = request.body(body.clone());
        }
        if let Some(header) = payment {
            request = request.header(optn_x402::PAYMENT_SIGNATURE, header);
        }
        let mut response = request
            .send()
            .await
            .map_err(|e| CliError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        let header = |name| -> Result<Option<String>> {
            response
                .headers()
                .get(name)
                .map(|v| {
                    v.to_str()
                        .map(str::to_owned)
                        .map_err(|_| CliError::Protocol("Invalid x402 response header".into()))
                })
                .transpose()
        };
        let required = header(optn_x402::PAYMENT_REQUIRED)?;
        let receipt = header(optn_x402::PAYMENT_RESPONSE)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| CliError::Network(e.to_string()))?
        {
            if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
                return Err(CliError::Protocol("HTTP body exceeds 1 MiB".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Attempt {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
            required,
            response: receipt,
        })
    }
}

fn body(attempt: &Attempt) -> Value {
    serde_json::from_str(&attempt.body).unwrap_or_else(|_| json!(attempt.body))
}
fn quote(offer: &Offer, status: u16) -> Value {
    json!({"ok":true,"status":status,"payment_required":true,"x402_version":2,
    "scheme":"exact","chain":offer.accepted["network"],"pay_to":offer.request.recipient.address,
    "sats":offer.request.value.parse::<u64>().ok(),"request":offer.request,"accepted":offer.accepted})
}

pub async fn check(cli: &Cli, request: &Request) -> Result<Value> {
    let network = chain(cli.network)?;
    let attempt = Http::new(cli, request).await?.send(None).await?;
    if attempt.status != 402 {
        return Ok(
            json!({"ok":(200..300).contains(&attempt.status),"payment_required":false,"status":attempt.status,"body":body(&attempt)}),
        );
    }
    let offer = Offer::parse(attempt.required.as_deref(), &attempt.body, network)
        .map_err(CliError::Protocol)?;
    Ok(quote(&offer, attempt.status))
}

async fn header(
    offer: &Offer,
    record: &PaymentRecord,
    network: BchChainReference,
) -> Result<String> {
    offer
        .payment_header(
            PreparedWallet::new(
                offer.request.clone(),
                optn_core::payment::decode_hex(&record.raw_hex).map_err(CliError::Protocol)?,
            )
            .map_err(CliError::Protocol)?,
            PaymentSources::new(network, &record.parents).map_err(CliError::Protocol)?,
        )
        .await
        .map_err(CliError::Protocol)
}

pub async fn pay(cli: &Cli, args: &Pay) -> Result<Value> {
    if crate::SERVING.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(CliError::Usage(
            "Exact payments require the local wallet CLI".into(),
        ));
    }
    if !args.yes && !args.dry_run {
        return Err(CliError::Usage(
            "Exact payment requires --yes and --max-sats; use --dry-run to inspect the quote"
                .into(),
        ));
    }
    if cli.wallet.is_none() && !args.dry_run {
        return Err(CliError::Usage(
            "Select a saved OPTN wallet with --wallet".into(),
        ));
    }
    if cli.host.is_some() || cli.port.is_some() || cli.no_tls {
        return Err(CliError::Usage("Exact payments use the shared network selection; configure it with network select instead of --host/--port/--no-tls".into()));
    }
    let network = chain(cli.network)?;
    let http = Http::new(cli, &args.request).await?;
    let attempt = http.send(None).await?;
    if attempt.status != 402 {
        return Ok(
            json!({"ok":(200..300).contains(&attempt.status),"paid":false,"status":attempt.status,"body":body(&attempt)}),
        );
    }
    let offer = Offer::parse_native(attempt.required.as_deref(), &attempt.body, network)
        .map_err(CliError::Protocol)?;
    if offer.request.token.is_some() {
        return Err(CliError::Usage("The SDK supports CashTokens, but this wallet payment planner currently supports native BCH only".into()));
    }
    let amount: u64 = offer
        .request
        .value
        .parse()
        .map_err(|_| CliError::Protocol("Invalid merchant amount".into()))?;
    if amount > args.max_sats {
        return Err(CliError::Usage("Quote exceeds --max-sats".into()));
    }
    let intent = PaymentIntent { id: args.payment_id.clone(), binding: optn_core::tx::double_sha256(
        &serde_json::to_vec(&json!({"url":http.url.as_str(),"method":http.method.as_str(),"body":args.request.data,
            "headers":args.request.headers,"offer":offer.binding})).map_err(|e| CliError::Internal(e.to_string()))?),
        destination: offer.request.recipient.address.clone(), amount_sats: amount, fee_per_byte: args.fee_rate, max_fee_sats: args.max_fee_sats };
    intent.validate().map_err(CliError::Usage)?;
    if args.dry_run {
        let mut result = quote(&offer, attempt.status);
        result["dry_run"] = json!(true);
        return Ok(result);
    }
    let runtime = crate::wallet_security::open_managed_runtime(cli).await?;
    let saved = runtime
        .state()
        .payment_outbox
        .into_iter()
        .find(|r| r.intent.id == intent.id);
    if saved.as_ref().is_some_and(|record| record.intent != intent) {
        return Err(CliError::Usage(
            "Payment id is bound to a different request; refusing to replace it".into(),
        ));
    }
    let signed_hex = args
        .transaction
        .as_ref()
        .map(|path| {
            use std::io::Read;
            let mut text = String::new();
            std::fs::File::open(path)
                .map_err(|e| CliError::Usage(e.to_string()))?
                .take(200_002)
                .read_to_string(&mut text)
                .map_err(|e| CliError::Usage(e.to_string()))?;
            if text.len() > 200_001 {
                return Err(CliError::Usage("Signed transaction is too large".into()));
            }
            let text = text.trim().to_owned();
            if text.len() > 200_000 {
                return Err(CliError::Usage("Signed transaction is too large".into()));
            }
            Ok(text)
        })
        .transpose()?;
    {
        let synced = crate::sync_shared_wallet(
            cli,
            args.gap,
            optn_core::discovery::ADDRESS_CAP.max(args.gap),
            None,
            None,
            None,
        )
        .await?;
        // Import validation happens before reservation: invalid signatures cannot
        // leave a durable hold behind. The runtime still validates ownership/change.
        if let Some(raw) = signed_hex.as_ref().filter(|_| saved.is_none()) {
            let raw_bytes = optn_core::payment::decode_hex(raw).map_err(CliError::Usage)?;
            let inputs = optn_core::tx::decode(&raw_bytes)?.inputs;
            let parents = synced
                .snapshot
                .value
                .transactions
                .iter()
                .filter(|tx| inputs.iter().any(|(id, _, _)| id == &tx.txid))
                .map(|tx| tx.raw.clone())
                .collect::<Vec<_>>();
            offer
                .payment_header(
                    PreparedWallet::new(
                        offer.request.clone(),
                        optn_core::payment::decode_hex(raw).map_err(CliError::Usage)?,
                    )
                    .map_err(CliError::Protocol)?,
                    PaymentSources::new(network, &parents).map_err(CliError::Protocol)?,
                )
                .await
                .map_err(CliError::Protocol)?;
        }
    }
    let operation = || PaymentOperation::Prepare {
        intent: intent.clone(),
        signed_hex: signed_hex.clone(),
    };
    let record = match runtime.external_payment(operation()).await {
        Ok(record) => record,
        Err(optn_transport::TransportError::AuthenticationRequired) => {
            crate::wallet_security::authenticate_managed(cli, runtime).await?;
            runtime
                .external_payment(operation())
                .await
                .map_err(|e| CliError::Usage(format!("{e:?}")))?
        }
        Err(error) => return Err(CliError::Usage(format!("{error:?}"))),
    };
    let payment = header(&offer, &record, network).await?;
    runtime
        .external_payment(PaymentOperation::Release {
            id: intent.id.clone(),
        })
        .await
        .map_err(|e| CliError::Usage(format!("{e:?}")))?;
    // No new signing or provider broadcast occurs after this point. Even an
    // interrupted HTTP request has durable bytes and reservations for retry.
    let guard = runtime.wallet_operation_guard();
    let attempt = tokio::select! {
        biased;
        _ = guard.cancelled() => Err(CliError::Usage("Wallet session or source state changed".into())),
        result = http.send(Some(&payment)) => result,
    };
    let response = match attempt {
        Ok(response) => response,
        Err(error) => {
            return Ok(
                json!({"ok":false,"payment_id":intent.id,"txid":record.txid,"settlement":"uncertain",
            "message":format!("{error}. Retry with the same payment id; do not create a replacement payment.")}),
            )
        }
    };
    let recorded = runtime
        .external_payment(PaymentOperation::Response {
            id: intent.id.clone(),
            status: response.status,
        })
        .await
        .is_ok();
    let receipt = response
        .response
        .as_deref()
        .map(|value| optn_x402::settlement_receipt(value, &record.txid, network));
    let paid = (200..300).contains(&response.status)
        && receipt.as_ref().is_some_and(|receipt| receipt.is_ok());
    Ok(json!({"ok":paid,"status":response.status,"paid":paid,
        "payment_id":intent.id,"txid":record.txid,"pay_to":intent.destination,"sats":amount,"fee_sats":record.fee_sats,
        "settlement":if paid { "reported_by_server" } else { "uncertain" },"response_recorded":recorded,
        "payment_response":receipt.as_ref().and_then(|r| r.as_ref().ok()),"receipt_error":receipt.as_ref().and_then(|r| r.as_ref().err()),"body":body(&response)}))
}

pub async fn status(cli: &Cli, payment_id: &str) -> Result<Value> {
    let runtime = crate::wallet_security::open_managed_runtime(cli).await?;
    let state = runtime.state();
    let record = state
        .payment_outbox
        .iter()
        .find(|r| r.intent.id == payment_id)
        .ok_or_else(|| CliError::Usage("Unknown payment id".into()))?;
    Ok(
        json!({"ok":true,"payment_id":payment_id,"txid":record.txid,"pay_to":record.intent.destination,
        "sats":record.intent.amount_sats,"fee_sats":record.fee_sats,"http_status":record.response_status,
        "settlement":if record.released { "uncertain_until_reconciled" } else { "prepared" },
        "reserved_inputs":record.inputs,"chain_fresh":state.wallet_sync.utxos_fresh}),
    )
}
