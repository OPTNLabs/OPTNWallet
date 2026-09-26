use optn_chain_native::NativeChainSecrets;
use optn_core::network::Network;
use optn_platform::{PlatformError, SecureStorage};
use optn_runtime::chain::{ConnectionPolicy, Endpoint, EndpointKind, SourceCatalog, SourceId};
use optn_runtime::rpc_credentials::*;
use rand::{distributions::Alphanumeric, rngs::OsRng, Rng};

use optn_runtime::chain::{
    CapabilitySet, ChainSource, ProtocolFamily, SourceDisposition, SourceOrigin,
};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Default)]
struct MemoryStorage(Arc<Mutex<BTreeMap<String, Vec<u8>>>>);

struct FailingStorage;

impl SecureStorage for MemoryStorage {
    fn get<'a>(&'a self, key: &'a str) -> optn_platform::PlatformFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move { Ok(self.0.lock().unwrap().get(key).cloned()) })
    }

    fn set<'a>(&'a self, key: &'a str, value: &'a [u8]) -> optn_platform::PlatformFuture<'a, ()> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_owned(), value.to_vec());
            Ok(())
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> optn_platform::PlatformFuture<'a, ()> {
        Box::pin(async move {
            self.0.lock().unwrap().remove(key);
            Ok(())
        })
    }
}

impl SecureStorage for FailingStorage {
    fn get<'a>(&'a self, _: &'a str) -> optn_platform::PlatformFuture<'a, Option<Vec<u8>>> {
        Box::pin(async { Err(PlatformError::Other("unexpected access".into())) })
    }

    fn set<'a>(&'a self, _: &'a str, _: &'a [u8]) -> optn_platform::PlatformFuture<'a, ()> {
        Box::pin(async { Err(PlatformError::Other("unexpected access".into())) })
    }

    fn delete<'a>(&'a self, _: &'a str) -> optn_platform::PlatformFuture<'a, ()> {
        Box::pin(async { Err(PlatformError::Other("unexpected access".into())) })
    }
}

// These tests check binding and storage, not fixed cryptographic vectors.
fn test_password() -> String {
    OsRng
        .sample_iter(Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn endpoint(port: u16) -> Endpoint {
    Endpoint {
        kind: EndpointKind::BchnRpc,
        host: "127.0.0.1".into(),
        port: Some(port),
    }
}

fn catalog(endpoint: Endpoint) -> (SourceCatalog, SourceId) {
    let id = SourceId::new("host:local-node");
    let source = ChainSource {
        id: id.clone(),
        label: "Local node".into(),
        origin: SourceOrigin::UserInfrastructure {
            group: "home".into(),
        },
        endpoints: vec![endpoint],
        capabilities: CapabilitySet::default(),
        disposition: SourceDisposition::Enabled,
        priority: 0,
    };
    let mut catalog = SourceCatalog::default();
    catalog.insert(source).unwrap();
    (catalog, id)
}

#[tokio::test]
async fn stored_auth_survives_reopen_for_the_same_endpoint() {
    let storage = MemoryStorage::default();
    let endpoint = endpoint(8332);
    let (catalog, source) = catalog(endpoint.clone());
    set(
        &storage,
        Network::Chipnet,
        &catalog,
        source.as_str(),
        "operator",
        &test_password(),
    )
    .await
    .unwrap();

    assert!(
        status(&storage, Network::Chipnet, &catalog, source.as_str())
            .await
            .unwrap()
    );
    let secrets = load(&storage, Network::Chipnet, &catalog).await.unwrap();
    assert_eq!(secrets.len(), 1);
    assert_eq!(secrets[0].source, source);
    assert_eq!(secrets[0].endpoint, endpoint);
}

#[tokio::test]
async fn changed_endpoint_never_loads_old_authentication() {
    let storage = MemoryStorage::default();
    let original = endpoint(8332);
    let (original_catalog, source) = catalog(original.clone());
    set(
        &storage,
        Network::Chipnet,
        &original_catalog,
        source.as_str(),
        "operator",
        &test_password(),
    )
    .await
    .unwrap();
    let changed = endpoint(18332);
    let (changed_catalog, _) = catalog(changed.clone());
    let secrets = load(&storage, Network::Chipnet, &changed_catalog)
        .await
        .unwrap();
    assert!(secrets.is_empty());
}

#[tokio::test]
async fn bip37_only_policy_never_reads_rpc_credentials() {
    let rpc = endpoint(8332);
    let (mut catalog, source) = catalog(rpc);
    catalog.get_mut(&source).unwrap().endpoints.push(Endpoint {
        kind: EndpointKind::BchP2p,
        host: "127.0.0.1".into(),
        port: Some(8333),
    });
    let policy = ConnectionPolicy::exact(source, ProtocolFamily::Bip37);
    assert!(
        load_selected(&FailingStorage, Network::Chipnet, &catalog, &policy)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn remote_targets_are_rejected_and_never_loaded() {
    let storage = MemoryStorage::default();
    let remote = Endpoint {
        kind: EndpointKind::BchnRpc,
        host: "node.example".into(),
        port: Some(8332),
    };
    let (catalog, source) = catalog(remote);
    assert_eq!(
        set(
            &storage,
            Network::Chipnet,
            &catalog,
            source.as_str(),
            "operator",
            &test_password(),
        )
        .await,
        Err(RpcCredentialError::InvalidTarget)
    );
    assert!(load(&storage, Network::Chipnet, &catalog).await.is_ok());
}

#[tokio::test]
async fn removing_a_credential_does_not_leave_a_reusable_record() {
    let storage = MemoryStorage::default();
    let endpoint = endpoint(8332);
    let (catalog, source) = catalog(endpoint);
    set(
        &storage,
        Network::Chipnet,
        &catalog,
        source.as_str(),
        "operator",
        &test_password(),
    )
    .await
    .unwrap();
    remove(&storage, Network::Chipnet, &catalog, source.as_str())
        .await
        .unwrap();
    assert!(
        !status(&storage, Network::Chipnet, &catalog, source.as_str())
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn loaded_credentials_reach_the_selected_native_rpc_provider() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(false).unwrap();
    let port = listener.local_addr().unwrap().port();
    let password = test_password();
    let expected = reqwest::Client::new()
        .get("http://127.0.0.1/")
        .basic_auth("operator", Some(&password))
        .build()
        .unwrap()
        .headers()[reqwest::header::AUTHORIZATION]
        .as_bytes()
        .to_vec();
    let (authenticated, receiver) = mpsc::channel();
    thread::spawn(move || {
        for result in [
            r#"{"result":{"chain":"chipnet","blocks":100,"bestblockhash":"0909090909090909090909090909090909090909090909090909090909090909"},"error":null,"id":"optn"}"#,
            r#"{"result":{"txindex":{"synced":true,"best_block_height":100}},"error":null,"id":"optn"}"#,
        ] {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let count = socket.read(&mut chunk).unwrap();
                assert_ne!(count, 0, "RPC client closed before headers");
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            authenticated
                .send(request.split(|byte| *byte == b'\n').any(|line| {
                    let line = line.strip_suffix(b"\r").unwrap_or(line);
                    let Some(colon) = line.iter().position(|byte| *byte == b':') else {
                        return false;
                    };
                    line[..colon].eq_ignore_ascii_case(b"authorization")
                        && line[colon + 1..].trim_ascii_start() == expected.as_slice()
                }))
                .unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{result}",
                result.len()
            );
            socket.write_all(response.as_bytes()).unwrap();
        }
    });

    let storage = MemoryStorage::default();
    let endpoint = endpoint(port);
    let (catalog, source) = catalog(endpoint);
    set(
        &storage,
        Network::Chipnet,
        &catalog,
        source.as_str(),
        "operator",
        &password,
    )
    .await
    .unwrap();
    let policy = ConnectionPolicy::exact(source.clone(), ProtocolFamily::BchnRpc);
    let secrets = NativeChainSecrets::from_credentials(
        load_selected(&storage, Network::Chipnet, &catalog, &policy)
            .await
            .unwrap(),
    );
    let stack = optn_chain_native::build_native_chain_stack_via(
        catalog,
        policy,
        "chipnet",
        &secrets,
        optn_chain_native::TorProxyTrust {
            managed: &[],
            trusted: &[],
        },
    )
    .await;
    assert!(stack.failures.is_empty(), "{:#?}", stack.failures);
    assert!(receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap());
    assert!(receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap());
}

#[tokio::test]
async fn portable_configuration_has_no_secure_store_contents() {
    let storage = MemoryStorage::default();
    let endpoint = endpoint(8332);
    let (catalog, source) = catalog(endpoint);
    let password = test_password();
    set(
        &storage,
        Network::Chipnet,
        &catalog,
        source.as_str(),
        "operator",
        &password,
    )
    .await
    .unwrap();
    let portable = optn_chain_native::network_config::NetworkConfigFile::new(
        std::env::temp_dir().join(format!("optn-rpc-credential-export-{}", std::process::id())),
    );
    let export = portable.export_portable(Network::Chipnet).unwrap();
    assert!(!export.contains(&password));
    assert!(!export.contains("rpc-"));
}

#[tokio::test]
async fn invalid_auth_is_refused_and_escaped_passwords_round_trip() {
    let storage = MemoryStorage::default();
    let (catalog, source) = catalog(endpoint(8332));
    for username in ["a:b", "line\nfeed", ""] {
        assert_eq!(
            set(
                &storage,
                Network::Chipnet,
                &catalog,
                source.as_str(),
                username,
                &test_password()
            )
            .await,
            Err(RpcCredentialError::InvalidCredentials)
        );
    }
    let password = format!("{}{}", test_password(), "\u{0001}".repeat(4096 - 32));
    set(
        &storage,
        Network::Chipnet,
        &catalog,
        source.as_str(),
        "operator",
        &password,
    )
    .await
    .unwrap();
    let loaded = load(&storage, Network::Chipnet, &catalog).await.unwrap();
    assert_eq!(loaded[0].password.expose(), password);
    assert!(load(&storage, Network::Mainnet, &catalog)
        .await
        .unwrap()
        .is_empty());
    assert!(load(&FailingStorage, Network::Chipnet, &catalog)
        .await
        .is_err());
    for bytes in storage.0.lock().unwrap().values_mut() {
        *bytes = b"malformed".to_vec();
    }
    assert!(matches!(
        load(&storage, Network::Chipnet, &catalog).await,
        Err(RpcCredentialError::InvalidStoredCredential)
    ));
}
