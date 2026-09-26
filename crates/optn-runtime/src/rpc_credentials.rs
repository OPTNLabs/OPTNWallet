//! Machine-local, endpoint-bound credentials for BCHN RPC routes.
//!
//! The source catalog is portable configuration. RPC credentials are not: they
//! stay in the operating-system secure store and are loaded only when the
//! current catalog still names the exact local endpoint for which they were
//! entered.

pub struct LoadedRpcCredential {
    pub source: SourceId,
    pub endpoint: Endpoint,
    pub username: optn_core::wallet_file::SecretText,
    pub password: optn_core::wallet_file::SecretText,
}
use crate::chain::{
    build_selection_plan, ConnectionPolicy, Endpoint, EndpointKind, SourceCatalog, SourceId,
};
use optn_core::{endpoint::is_loopback_host, header_hash::sha256d, network::Network};
use optn_platform::{PlatformError, SecureStorage};
use std::collections::BTreeSet;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Dedicated keyring service for chain-provider credentials. It intentionally
/// differs from wallet-unlock storage, so neither capability can read the
/// other's entries.
pub const RPC_CREDENTIAL_SERVICE: &str = "com.optilabs.wallet.chain-rpc.v1";

const MAX_CREDENTIAL_BYTES: usize = 4096;
const RECORD_VERSION: u64 = 1;

/// A generic, non-secret result category suitable for UI and CLI errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcCredentialError {
    InvalidTarget,
    InvalidCredentials,
    StorageUnavailable,
    StoragePermissionDenied,
    StorageFailed,
    InvalidStoredCredential,
}

#[derive(serde::Serialize)]
struct StoredCredentialRef<'a> {
    version: u64,
    username: &'a str,
    password: &'a str,
}

#[derive(serde::Deserialize, Zeroize, ZeroizeOnDrop)]
struct StoredCredential {
    #[zeroize(skip)]
    version: u64,
    username: String,
    password: String,
}

/// Resolve source input against the current authoritative catalog. A source
/// with several local RPC endpoints needs a typed endpoint chooser before it
/// can receive credentials; guessing could bind a password to another node.
pub fn credential_endpoint(
    catalog: &SourceCatalog,
    source: &SourceId,
) -> Result<Endpoint, RpcCredentialError> {
    let source = catalog
        .get(source)
        .ok_or(RpcCredentialError::InvalidTarget)?;
    let mut endpoints = source.endpoints.iter().filter(|endpoint| {
        endpoint.kind == EndpointKind::BchnRpc
            && endpoint.port.is_some_and(|port| port != 0)
            && is_loopback_host(&endpoint.host)
    });
    let endpoint = endpoints.next().ok_or(RpcCredentialError::InvalidTarget)?;
    if endpoints.next().is_some() {
        return Err(RpcCredentialError::InvalidTarget);
    }
    Ok(endpoint.clone())
}

/// Store Basic-auth material for exactly one configured local BCHN RPC
/// endpoint. Remote native RPC is deliberately unavailable today, and a
/// credential record must not create a second route around that policy.
pub async fn set<S: SecureStorage + ?Sized>(
    storage: &S,
    network: Network,
    catalog: &SourceCatalog,
    source: &str,
    username: &str,
    password: &str,
) -> Result<(), RpcCredentialError> {
    let source = SourceId::new(source);
    let endpoint = credential_endpoint(catalog, &source)?;
    let key = credential_key(network, &source, &endpoint)?;
    if username.contains(':')
        || username.chars().any(char::is_control)
        || username.is_empty()
        || password.is_empty()
        || username.len() > MAX_CREDENTIAL_BYTES
        || password.len() > MAX_CREDENTIAL_BYTES
    {
        return Err(RpcCredentialError::InvalidCredentials);
    }
    let record = StoredCredentialRef {
        version: RECORD_VERSION,
        username,
        password,
    };
    let encoded = Zeroizing::new(
        serde_json::to_vec(&record).map_err(|_| RpcCredentialError::InvalidCredentials)?,
    );
    storage.set(&key, &encoded).await.map_err(storage_error)
}

/// Remove only the credential tied to this endpoint. Recreating a source at a
/// different host or port can therefore never recover old authority.
pub async fn remove<S: SecureStorage + ?Sized>(
    storage: &S,
    network: Network,
    catalog: &SourceCatalog,
    source: &str,
) -> Result<(), RpcCredentialError> {
    let source = catalog
        .get(&SourceId::new(source))
        .ok_or(RpcCredentialError::InvalidTarget)?;
    for endpoint in source.endpoints.iter().filter(|endpoint| {
        endpoint.kind == EndpointKind::BchnRpc && is_loopback_host(&endpoint.host)
    }) {
        let key = credential_key(network, &source.id, endpoint)?;
        storage.delete(&key).await.map_err(storage_error)?;
    }
    Ok(())
}

/// Return presence only; callers must never use this to retrieve the username
/// or password for display, export, or renderer state.
pub async fn status<S: SecureStorage + ?Sized>(
    storage: &S,
    network: Network,
    catalog: &SourceCatalog,
    source: &str,
) -> Result<bool, RpcCredentialError> {
    let source = SourceId::new(source);
    let endpoint = credential_endpoint(catalog, &source)?;
    let key = credential_key(network, &source, &endpoint)?;
    let value = storage.get(&key).await.map_err(storage_error)?;
    Ok(value.map(Zeroizing::new).is_some())
}

/// Load machine-local credentials for enabled loopback RPC endpoints. This
/// does not select or dial a route; stack construction still enforces the
/// active policy and records an unavailable stack when this function fails.
pub async fn load<S: SecureStorage + ?Sized>(
    storage: &S,
    network: Network,
    catalog: &SourceCatalog,
) -> Result<Vec<LoadedRpcCredential>, RpcCredentialError> {
    let mut secrets = Vec::new();
    load_into(storage, network, catalog, &mut secrets).await?;
    Ok(secrets)
}

/// Load only credentials for the shared policy's enabled primary/fallback RPC
/// sources. Hosts should use this path for stack construction so an inactive
/// catalog row cannot turn an unavailable keyring into a stack failure.
pub async fn load_selected<S: SecureStorage + ?Sized>(
    storage: &S,
    network: Network,
    catalog: &SourceCatalog,
    policy: &ConnectionPolicy,
) -> Result<Vec<LoadedRpcCredential>, RpcCredentialError> {
    if !policy
        .protocols
        .contains(crate::chain::ProtocolFamily::BchnRpc)
    {
        return Ok(Vec::new());
    }
    let plan = build_selection_plan(catalog, policy);
    let selected = plan
        .primary
        .into_iter()
        .chain(plan.fallback)
        .collect::<BTreeSet<_>>();
    let mut secrets = Vec::new();
    for source in catalog
        .iter()
        .filter(|source| selected.contains(&source.id))
    {
        for endpoint in source.endpoints.iter().filter(|endpoint| {
            endpoint.kind == EndpointKind::BchnRpc && is_loopback_host(&endpoint.host)
        }) {
            let key = credential_key(network, &source.id, endpoint)?;
            let Some(bytes) = storage.get(&key).await.map_err(storage_error)? else {
                continue;
            };
            let bytes = Zeroizing::new(bytes);
            let mut credential = decode_record(&bytes)?;
            let username = std::mem::take(&mut credential.username);
            let password = std::mem::take(&mut credential.password);
            secrets.push(LoadedRpcCredential {
                source: source.id.clone(),
                endpoint: endpoint.clone(),
                username: optn_core::wallet_file::SecretText::new(username),
                password: optn_core::wallet_file::SecretText::new(password),
            });
        }
    }
    Ok(secrets)
}

/// Add persisted RPC authentication without clearing host-probed or test-only
/// non-auth settings already held in `secrets`.
pub async fn load_into<S: SecureStorage + ?Sized>(
    storage: &S,
    network: Network,
    catalog: &SourceCatalog,
    secrets: &mut Vec<LoadedRpcCredential>,
) -> Result<(), RpcCredentialError> {
    for source in catalog.iter().filter(|source| source.is_enabled()) {
        for endpoint in source.endpoints.iter().filter(|endpoint| {
            endpoint.kind == EndpointKind::BchnRpc && is_loopback_host(&endpoint.host)
        }) {
            let key = credential_key(network, &source.id, endpoint)?;
            let Some(bytes) = storage.get(&key).await.map_err(storage_error)? else {
                continue;
            };
            let bytes = Zeroizing::new(bytes);
            let mut credential = decode_record(&bytes)?;
            let username = std::mem::take(&mut credential.username);
            let password = std::mem::take(&mut credential.password);
            secrets.push(LoadedRpcCredential {
                source: source.id.clone(),
                endpoint: endpoint.clone(),
                username: optn_core::wallet_file::SecretText::new(username),
                password: optn_core::wallet_file::SecretText::new(password),
            });
        }
    }
    Ok(())
}

fn credential_key(
    network: Network,
    source: &SourceId,
    endpoint: &Endpoint,
) -> Result<String, RpcCredentialError> {
    if endpoint.kind != EndpointKind::BchnRpc
        || endpoint.port.is_none_or(|port| port == 0)
        || !is_loopback_host(&endpoint.host)
    {
        return Err(RpcCredentialError::InvalidTarget);
    }
    let host = endpoint
        .host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() {
        return Err(RpcCredentialError::InvalidTarget);
    }
    let binding = format!(
        "v1\u{0}{}\u{0}{}\u{0}bchn-rpc\u{0}{host}\u{0}{}",
        network,
        source.as_str(),
        endpoint.port.expect("validated nonzero port"),
    );
    Ok(format!(
        "rpc-{}",
        sha256d(binding.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn decode_record(bytes: &[u8]) -> Result<StoredCredential, RpcCredentialError> {
    if bytes.len() > MAX_CREDENTIAL_BYTES.saturating_mul(12).saturating_add(128) {
        return Err(RpcCredentialError::InvalidStoredCredential);
    }
    let credential: StoredCredential =
        serde_json::from_slice(bytes).map_err(|_| RpcCredentialError::InvalidStoredCredential)?;
    if credential.version != RECORD_VERSION
        || credential.username.contains(':')
        || credential.username.chars().any(char::is_control)
        || credential.username.is_empty()
        || credential.password.is_empty()
        || credential.username.len() > MAX_CREDENTIAL_BYTES
        || credential.password.len() > MAX_CREDENTIAL_BYTES
    {
        return Err(RpcCredentialError::InvalidStoredCredential);
    }
    Ok(credential)
}

fn storage_error(error: PlatformError) -> RpcCredentialError {
    match error {
        PlatformError::Unavailable => RpcCredentialError::StorageUnavailable,
        PlatformError::PermissionDenied => RpcCredentialError::StoragePermissionDenied,
        PlatformError::Cancelled => RpcCredentialError::StorageUnavailable,
        PlatformError::InvalidData(_) | PlatformError::Io(_) | PlatformError::Other(_) => {
            RpcCredentialError::StorageFailed
        }
    }
}
