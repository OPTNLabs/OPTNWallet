//! x402-bch: HTTP 402 payments over Bitcoin Cash.
//!
//! Three actors — Client, Server, Facilitator. The Server offloads all chain
//! work to the Facilitator, and unlike the original x402 the Facilitator holds
//! no wallet: clients pay servers directly and the Facilitator only verifies.
//!
//! The property that makes this usable by an agent is that payment is
//! *batched*. A client funds the server once and then debits against that UTXO
//! on each subsequent request, so a few hundred API calls cost one on-chain
//! transaction rather than a few hundred.
//!
//! The flow:
//!
//! 1. request the resource with no payment header
//! 2. the server answers 402 with `PaymentRequired`, listing what it accepts
//! 3. the client funds `payTo`, or reuses a UTXO it already funded
//! 4. the client signs `JSON.stringify(authorization)` as a Bitcoin message
//! 5. the request is repeated with a `PAYMENT-SIGNATURE` header
//!
//! Spec: <https://github.com/x402-bch/x402-bch> (v2.2).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CliError, Result};

/// The `PaymentRequired` body a server returns with HTTP 402.
#[derive(Debug, Deserialize)]
pub struct PaymentRequired {
    #[serde(rename = "x402Version")]
    pub version: u32,
    #[serde(default)]
    pub resource: Option<Value>,
    pub accepts: Vec<PaymentRequirements>,
}

/// One payment option from a server's `accepts` list.
///
/// This is echoed back inside the payment payload, so absent fields are
/// skipped rather than serialised as null: a Facilitator that compares the
/// echo against its own requirements sees a document that differs from the one
/// it sent, and rejects a payment that is otherwise correct.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PaymentRequirements {
    /// `utxo` is the BCH debit scheme; anything else is another chain's.
    pub scheme: String,
    pub network: String,
    /// Satoshis, sent as a string because the top of the range does not
    /// survive a JSON number intact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    #[serde(
        rename = "maxAmountRequired",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_amount_required: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(rename = "payTo")]
    pub pay_to: String,
    #[serde(
        rename = "maxTimeoutSeconds",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_timeout_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

impl PaymentRequirements {
    /// Satoshis this option asks for.
    ///
    /// v2.1 named it `maxAmountRequired` and v2.2 `amount`; servers in the
    /// wild send either, so both are accepted rather than pinning one version.
    pub fn satoshis(&self) -> Result<u64> {
        let raw = self
            .amount
            .as_deref()
            .or(self.max_amount_required.as_deref())
            .ok_or_else(|| {
                CliError::Protocol("payment requirements carry no amount".to_string())
            })?;
        raw.parse().map_err(|_| {
            CliError::Protocol(format!("amount '{raw}' is not a whole number of satoshis"))
        })
    }
}

/// The debit authorisation. Field order matters: the Facilitator recomputes
/// `JSON.stringify(authorization)` and checks it against the signature, so the
/// bytes signed here have to match the bytes it rebuilds. serde emits struct
/// fields in declaration order, which is why these are declared in the order
/// the specification lists them.
#[derive(Debug, Clone, Serialize)]
pub struct Authorization {
    pub from: String,
    pub to: String,
    pub value: String,
    pub txid: String,
    pub vout: Option<u32>,
    pub amount: Option<String>,
}

impl Authorization {
    /// A debit against a specific funding output.
    pub fn against(
        from: String,
        to: String,
        value: u64,
        txid: String,
        vout: u32,
        funded: u64,
    ) -> Self {
        Authorization {
            from,
            to,
            value: value.to_string(),
            txid,
            vout: Some(vout),
            amount: Some(funded.to_string()),
        }
    }

    /// "Check my tab": let the Facilitator pick any funded output of ours.
    ///
    /// `txid` is the literal `*` and the other two are null, which is what the
    /// specification defines rather than an omission.
    pub fn tab(from: String, to: String, value: u64) -> Self {
        Authorization {
            from,
            to,
            value: value.to_string(),
            txid: "*".to_string(),
            vout: None,
            amount: None,
        }
    }

    /// Exactly the bytes the Facilitator will re-serialise and verify.
    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self)
            .map_err(|e| CliError::Internal(format!("could not serialise authorization: {e}")))
    }
}

#[derive(Debug, Serialize)]
pub struct PaymentPayload {
    #[serde(rename = "x402Version")]
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<Value>,
    pub accepted: PaymentRequirements,
    pub payload: Inner,
    pub extensions: Value,
}

#[derive(Debug, Serialize)]
pub struct Inner {
    pub signature: String,
    pub authorization: Authorization,
}

/// Pick the BCH option from what a server accepts.
///
/// A server may advertise several chains. Taking the first entry blindly would
/// try to pay an EVM requirement with a BCH signature, which fails at the
/// Facilitator with an error that says nothing about the real cause.
pub fn choose_bch(required: &PaymentRequired) -> Result<&PaymentRequirements> {
    required
        .accepts
        .iter()
        .find(|r| r.scheme.eq_ignore_ascii_case("utxo"))
        .ok_or_else(|| {
            let seen: Vec<&str> = required.accepts.iter().map(|r| r.scheme.as_str()).collect();
            CliError::Usage(format!(
                "the server accepts no BCH payment option (offered: {})",
                if seen.is_empty() {
                    "nothing".to_string()
                } else {
                    seen.join(", ")
                }
            ))
        })
}

/// One HTTP attempt at a paid resource.
pub struct Attempt {
    pub status: u16,
    pub body: String,
    /// What the server reports back about the payment, if anything.
    pub payment_response: Option<String>,
}

impl Attempt {
    pub fn is_payment_required(&self) -> bool {
        self.status == 402
    }

    /// The body as JSON when it is JSON, otherwise as a string.
    ///
    /// A paid API usually answers JSON, but the point of this command is to
    /// fetch whatever is behind the paywall, so a non-JSON body is returned
    /// rather than rejected.
    pub fn json_or_text(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| Value::String(self.body.clone()))
    }
}

/// What to ask for, independent of whether payment is attached.
///
/// Held apart from the sending so the identical request can be replayed with
/// the payment header — a request that differs between the two attempts may be
/// quoted one price and charged for another resource.
pub struct RequestSpec {
    pub url: String,
    pub method: String,
    pub body: Option<String>,
    pub headers: Vec<(String, String)>,
}

impl RequestSpec {
    pub fn get(url: &str) -> Self {
        RequestSpec {
            url: url.to_string(),
            method: "GET".to_string(),
            body: None,
            headers: Vec::new(),
        }
    }
}

/// Parse a `Name: value` command-line header.
pub fn parse_header(raw: &str) -> Result<(String, String)> {
    let (name, value) = raw
        .split_once(':')
        .ok_or_else(|| CliError::Usage(format!("header '{raw}' is not in Name: value form")))?;
    let name = name.trim();
    if name.is_empty() {
        return Err(CliError::Usage(format!("header '{raw}' has no name")));
    }
    // PAYMENT-SIGNATURE is built from the wallet's own key. Letting a caller
    // set it by hand would send an authorisation this wallet did not sign, and
    // the failure would surface at the Facilitator as an opaque rejection.
    if name.eq_ignore_ascii_case(PAYMENT_HEADER) {
        return Err(CliError::Usage(format!(
            "{PAYMENT_HEADER} is set by this command; it cannot be supplied as a header"
        )));
    }
    Ok((name.to_string(), value.trim().to_string()))
}

pub const PAYMENT_HEADER: &str = "PAYMENT-SIGNATURE";
const RESPONSE_HEADER: &str = "X-PAYMENT-RESPONSE";

/// The header value: the payload as a JSON string.
///
/// Not base64. The reference implementation sends the JSON directly, so
/// encoding it would give the Facilitator a string it cannot parse.
pub fn header_value(payload: &PaymentPayload) -> Result<String> {
    serde_json::to_string(payload)
        .map_err(|e| CliError::Internal(format!("could not serialise payment payload: {e}")))
}

pub struct Http {
    client: reqwest::Client,
}

impl Http {
    pub fn new(timeout_secs: u64) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            // A paid request must not be replayed against a different host: a
            // redirect after payment would hand the authorisation to whoever
            // the first server names.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("optn/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| CliError::Internal(format!("could not build the HTTP client: {e}")))?;
        Ok(Http { client })
    }

    pub async fn send(&self, spec: &RequestSpec, payment: Option<&str>) -> Result<Attempt> {
        let method = reqwest::Method::from_bytes(spec.method.as_bytes())
            .map_err(|_| CliError::Usage(format!("'{}' is not an HTTP method", spec.method)))?;
        let mut request = self.client.request(method, &spec.url);
        for (name, value) in &spec.headers {
            request = request.header(name, value);
        }
        if let Some(body) = &spec.body {
            request = request.body(body.clone());
        }
        if let Some(header) = payment {
            request = request.header(PAYMENT_HEADER, header);
        }

        let response = request
            .send()
            .await
            .map_err(|e| CliError::Network(format!("{}: {e}", spec.url)))?;
        let status = response.status().as_u16();
        let payment_response = response
            .headers()
            .get(RESPONSE_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let body = response
            .text()
            .await
            .map_err(|e| CliError::Protocol(format!("could not read the response body: {e}")))?;
        Ok(Attempt {
            status,
            body,
            payment_response,
        })
    }
}

impl PaymentRequired {
    pub fn parse(body: &str) -> Result<Self> {
        serde_json::from_str(body).map_err(|e| {
            CliError::Protocol(format!(
                "the 402 body is not a PaymentRequired document: {e}"
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = r#"{
      "x402Version": 2,
      "resource": { "url": "http://example/weather" },
      "accepts": [
        { "scheme": "evm", "network": "eip155:8453", "payTo": "0xabc" },
        { "scheme": "utxo", "network": "bip122:0000", "amount": "1000",
          "payTo": "bitcoincash:qqlrzp23w08434twmvr4fxw672whkjy0py26r63g3d",
          "maxTimeoutSeconds": 60 }
      ]
    }"#;

    #[test]
    fn the_bch_option_is_chosen_over_other_chains() {
        let required: PaymentRequired = serde_json::from_str(BODY).unwrap();
        let chosen = choose_bch(&required).unwrap();
        assert_eq!(chosen.scheme, "utxo");
        assert_eq!(chosen.satoshis().unwrap(), 1000);
    }

    #[test]
    fn a_server_with_no_bch_option_is_refused_by_name() {
        let body = r#"{"x402Version":2,"accepts":[{"scheme":"evm","network":"eip155:8453","payTo":"0xabc"}]}"#;
        let required: PaymentRequired = serde_json::from_str(body).unwrap();
        let err = choose_bch(&required).unwrap_err();
        assert!(
            err.to_string().contains("evm"),
            "should name what was offered: {err}"
        );
    }

    #[test]
    fn both_amount_spellings_are_accepted() {
        // v2.1 called it maxAmountRequired, v2.2 calls it amount.
        let old = r#"{"scheme":"utxo","network":"n","maxAmountRequired":"250","payTo":"x"}"#;
        let new = r#"{"scheme":"utxo","network":"n","amount":"250","payTo":"x"}"#;
        for body in [old, new] {
            let r: PaymentRequirements = serde_json::from_str(body).unwrap();
            assert_eq!(r.satoshis().unwrap(), 250);
        }
    }

    #[test]
    fn authorization_serialises_in_specification_order() {
        // The Facilitator rebuilds this string to check the signature, so a
        // reordered or renamed field breaks verification with no useful error.
        let a = Authorization::against(
            "bitcoincash:qfrom".into(),
            "bitcoincash:qto".into(),
            1000,
            "b74dcfc8".into(),
            0,
            2000,
        );
        let json = String::from_utf8(a.signing_bytes().unwrap()).unwrap();
        assert_eq!(
            json,
            r#"{"from":"bitcoincash:qfrom","to":"bitcoincash:qto","value":"1000","txid":"b74dcfc8","vout":0,"amount":"2000"}"#
        );
    }

    #[test]
    fn check_my_tab_uses_a_star_and_nulls() {
        let a = Authorization::tab("bitcoincash:qfrom".into(), "bitcoincash:qto".into(), 500);
        let json = String::from_utf8(a.signing_bytes().unwrap()).unwrap();
        assert!(json.contains(r#""txid":"*""#), "{json}");
        assert!(json.contains(r#""vout":null"#), "{json}");
        assert!(json.contains(r#""amount":null"#), "{json}");
    }

    #[test]
    fn the_accepted_echo_matches_what_the_server_sent() {
        // The payload echoes this object back. Serialising absent fields as
        // null changes the document, and a Facilitator comparing it to its own
        // requirements rejects the payment without saying why.
        let sent = r#"{"scheme":"utxo","network":"n","amount":"1000","payTo":"x"}"#;
        let parsed: PaymentRequirements = serde_json::from_str(sent).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), sent);
    }

    #[test]
    fn a_non_numeric_amount_is_a_protocol_error() {
        let r: PaymentRequirements =
            serde_json::from_str(r#"{"scheme":"utxo","network":"n","amount":"lots","payTo":"x"}"#)
                .unwrap();
        assert!(r.satoshis().is_err());
    }
}
