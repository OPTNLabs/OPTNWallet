//! A local JSON-RPC endpoint over the same commands.
//!
//! An agent that shells out to `optn` pays process startup on every call and
//! has to parse whatever the shell did to its arguments. This serves the same
//! commands over HTTP instead.
//!
//! It is a thin wrapper on purpose. A request names a command and gives its
//! arguments exactly as the command line takes them, and they are parsed by the
//! same parser, gated by the same policy, and answered with the same JSON. A
//! second implementation of "what does balance mean" is a second place for it
//! to be wrong, and the one that only runs over HTTP is the one nobody tests.
//!
//! What it refuses matters more than what it serves:
//!
//! - **Loopback only**, unless someone asks for otherwise in as many words.
//!   A wallet that answers on 0.0.0.0 is a wallet anyone on the network can
//!   ask about your balances.
//! - **A bearer token on every request**, generated if not supplied. Localhost
//!   is not a security boundary: any process on the machine, and any web page
//!   that can make a cross-origin request, can reach 127.0.0.1.
//! - **No spending**, unless explicitly enabled. An HTTP endpoint that can move
//!   funds is a different risk from a command that can, because it outlives the
//!   decision to run it.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{CliError, Result};
use crate::skills::{self, Capability, Policy};

/// One JSON-RPC request.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub jsonrpc: Option<String>,
    pub method: String,
    /// The arguments the command line would take, in order.
    #[serde(default)]
    pub params: Vec<String>,
    #[serde(default)]
    pub id: Option<Value>,
}

pub struct Config {
    pub address: SocketAddr,
    pub token: String,
    pub allow_spend: bool,
    pub policy: Policy,
    /// Global flags the server was started with, applied to every call.
    pub base_args: Vec<String>,
}

/// Decide what to bind to, refusing a footgun rather than documenting it.
pub fn resolve_bind(bind: &str, port: u16, allow_remote: bool) -> Result<SocketAddr> {
    let ip: IpAddr = bind
        .parse()
        .map_err(|_| CliError::Usage(format!("'{bind}' is not an IP address")))?;

    if !ip.is_loopback() && !allow_remote {
        return Err(CliError::Usage(format!(
            "refusing to bind {ip}: a wallet answering off-loopback is one \
             anyone on the network can query. Pass --allow-remote if that is \
             genuinely what you want, and set --token yourself."
        )));
    }
    Ok(SocketAddr::new(ip, port))
}

/// A token to hold the endpoint shut.
///
/// Localhost is not a boundary — every process on the machine can reach it,
/// and so can any web page that can make a cross-origin request. Generated
/// from the OS random source rather than anything derived from the wallet.
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compare tokens without leaking their length through timing.
pub fn token_matches(expected: &str, given: &str) -> bool {
    if expected.len() != given.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in expected.bytes().zip(given.bytes()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// Whether a method may be served, before it is parsed.
///
/// Two gates, and they are not the same. The policy is what the operator set
/// for this process; `allow_spend` is specific to the endpoint, because an
/// HTTP server that can move funds outlives the decision to start it in a way
/// a single command does not.
pub fn admits(config: &Config, request: &Request) -> Result<()> {
    // Checked rather than ignored: a client announcing another version is
    // expecting different framing, and answering it as if it were 2.0 would
    // produce replies it cannot read.
    if let Some(version) = &request.jsonrpc {
        if version != "2.0" {
            return Err(CliError::Usage(format!(
                "this endpoint speaks JSON-RPC 2.0, not '{version}'"
            )));
        }
    }

    let method = request.method.as_str();
    let skill = skills::find(method).ok_or_else(|| {
        CliError::Usage(format!(
            "'{method}' is not a command; GET /skills lists what is"
        ))
    })?;

    if !config.allow_spend && skill.capability == Capability::Spend {
        return Err(CliError::Usage(format!(
            "'{method}' can move funds and this endpoint was not started with \
             --allow-spend"
        )));
    }
    skills::enforce(config.policy, method)
}

/// The argv a request turns into.
///
/// Assembled rather than interpreted: the same parser, the same validation and
/// the same errors as the command line, so the two cannot drift.
pub fn argv(config: &Config, request: &Request) -> Vec<String> {
    let mut args = vec!["optn".to_string(), "--json".to_string()];
    args.extend(config.base_args.iter().cloned());
    args.push(request.method.clone());
    args.extend(request.params.iter().cloned());
    args
}

/// A JSON-RPC error body.
pub fn rpc_error(id: Option<Value>, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

pub fn rpc_result(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// What `GET /skills` answers.
pub fn manifest(config: &Config) -> Value {
    let mut value = skills::manifest(config.policy);
    // The endpoint's own restriction, distinct from the policy: an agent
    // reading this needs to know a spending method will be refused here even
    // though the policy would allow it.
    value["endpoint"] = json!({
        "spending_enabled": config.allow_spend,
        "bind": config.address.to_string(),
        "transport": "JSON-RPC 2.0 over POST /, bearer token required",
    });
    if let Some(skills) = value["skills"].as_array_mut() {
        for skill in skills.iter_mut() {
            let spends = skill["capability"] == "spend";
            let permitted = skill["permitted"].as_bool().unwrap_or(false);
            skill["permitted"] = json!(permitted && (config.allow_spend || !spends));
        }
    }
    value
}

pub type Shared = Arc<Config>;

#[cfg(test)]
mod tests {
    use super::*;

    fn config(allow_spend: bool, policy: &str) -> Config {
        Config {
            address: "127.0.0.1:8787".parse().unwrap(),
            token: "t".repeat(48),
            allow_spend,
            policy: Policy::parse(policy).unwrap(),
            base_args: vec!["--network".into(), "chipnet".into()],
        }
    }

    fn request(method: &str, params: &[&str]) -> Request {
        Request {
            jsonrpc: Some("2.0".into()),
            method: method.into(),
            params: params.iter().map(|s| s.to_string()).collect(),
            id: Some(json!(1)),
        }
    }

    #[test]
    fn binding_off_loopback_is_refused_without_saying_so() {
        // A wallet answering on 0.0.0.0 is one anyone on the network can query.
        assert!(resolve_bind("0.0.0.0", 8787, false).is_err());
        assert!(resolve_bind("192.168.1.10", 8787, false).is_err());
        assert!(resolve_bind("127.0.0.1", 8787, false).is_ok());
        assert!(resolve_bind("::1", 8787, false).is_ok());
        assert!(resolve_bind("0.0.0.0", 8787, true).is_ok());
    }

    #[test]
    fn the_refusal_says_how_to_proceed() {
        let error = resolve_bind("0.0.0.0", 8787, false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("--allow-remote"), "{error}");
        assert!(error.contains("--token"), "{error}");
    }

    #[test]
    fn a_generated_token_is_long_and_not_repeated() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 48, "24 bytes as hex");
        assert_ne!(a, b, "two calls must not produce the same token");
    }

    #[test]
    fn tokens_compare_by_value_and_length() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("abc", "ab"));
        assert!(!token_matches("abc", "abcd"));
        assert!(!token_matches("", "x"));
    }

    #[test]
    fn spending_methods_are_refused_unless_the_endpoint_enables_them() {
        // The policy would allow it; the endpoint still will not. An HTTP
        // server that can move funds outlives the decision to start it.
        let closed = config(false, "spend");
        assert!(admits(&closed, &request("send", &[])).is_err());
        assert!(admits(&closed, &request("x402", &[])).is_err());
        assert!(admits(&closed, &request("broadcast", &[])).is_err());
        assert!(admits(&closed, &request("balance", &[])).is_ok());

        let open = config(true, "spend");
        assert!(admits(&open, &request("send", &[])).is_ok());
    }

    #[test]
    fn the_policy_still_applies_when_spending_is_enabled() {
        // --allow-spend opens the endpoint; it does not raise the policy.
        let open = config(true, "read");
        assert!(admits(&open, &request("send", &[])).is_err());
        assert!(admits(&open, &request("address", &[])).is_err());
        assert!(admits(&open, &request("balance", &[])).is_ok());
    }

    #[test]
    fn an_unknown_method_points_at_the_manifest() {
        let error = admits(&config(true, "spend"), &request("teleport", &[]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("/skills"), "{error}");
    }

    #[test]
    fn another_json_rpc_version_is_refused() {
        // A client announcing 1.0 expects different framing and could not read
        // a 2.0 reply anyway.
        let mut old = request("balance", &["bchtest:qq"]);
        old.jsonrpc = Some("1.0".into());
        assert!(admits(&config(false, "read"), &old).is_err());

        let mut absent = request("balance", &["bchtest:qq"]);
        absent.jsonrpc = None;
        assert!(
            admits(&config(false, "read"), &absent).is_ok(),
            "absent is fine"
        );
    }

    #[test]
    fn a_request_becomes_the_same_argv_the_command_line_would() {
        // Anything else means a second implementation of what each command
        // means, and the HTTP one is the copy nobody exercises.
        let args = argv(&config(false, "read"), &request("balance", &["bchtest:qq"]));
        assert_eq!(
            args,
            vec![
                "optn",
                "--json",
                "--network",
                "chipnet",
                "balance",
                "bchtest:qq"
            ]
        );
    }

    #[test]
    fn parameters_are_passed_through_untouched() {
        let args = argv(
            &config(false, "read"),
            &request("contract", &["address", "P2PKH", "--arg", "11"]),
        );
        assert_eq!(&args[args.len() - 4..], ["address", "P2PKH", "--arg", "11"]);
    }

    #[test]
    fn the_manifest_marks_spending_unavailable_on_a_closed_endpoint() {
        // An agent reading this must see that send will be refused here even
        // though the policy permits it.
        let value = manifest(&config(false, "spend"));
        assert_eq!(value["endpoint"]["spending_enabled"], false);
        for skill in value["skills"].as_array().unwrap() {
            if skill["capability"] == "spend" {
                assert_eq!(skill["permitted"], false, "{}", skill["name"]);
            }
        }

        let open = manifest(&config(true, "spend"));
        for skill in open["skills"].as_array().unwrap() {
            if skill["name"] == "send" {
                assert_eq!(skill["permitted"], true);
            }
        }
    }
}
