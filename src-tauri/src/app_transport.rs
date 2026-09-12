//! Tauri command adapter for the shell-neutral application transport protocol.
//!
//! This module owns no application state and contains no wallet logic. It only
//! maps versioned wire values to the authoritative `optn-runtime` managed by
//! the host. Another shell can expose the same `optn-transport` contract using
//! a different adapter.

use crate::appearance::AppearanceStore;
use crate::chain_runtime::NativeChainRuntime;
use crate::network_config::NetworkSettingsStore;
use optn_transport::{WireAction, WireState};
use std::sync::Arc;

#[tauri::command]
pub async fn optn_wallet_refresh(
    runtime: tauri::State<'_, Arc<NativeChainRuntime>>,
) -> Result<(), String> {
    runtime.refresh_wallet().await
}

/// Rescan the open wallet from a chosen block height, inclusive.
///
/// The height is the holder's instruction. It does not touch keys, and it does
/// not touch the accepted chain the rest of the application reads.
#[tauri::command]
pub async fn optn_wallet_rescan(
    runtime: tauri::State<'_, Arc<NativeChainRuntime>>,
    height: u32,
) -> Result<(), String> {
    runtime.rescan_wallet_from(height).await
}

/// Forward authentication requests to the shared Rust runtime.
///
/// Passes through runtime validation and service messages; other error kinds
/// use a generic unavailable message. This adapter does not verify secrets.
#[tauri::command]
pub async fn optn_wallet_security(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    request: optn_transport::WalletSecurityRequest,
) -> Result<optn_transport::WalletSecurityStatus, String> {
    runtime
        .wallet_security(request)
        .await
        .map_err(|error| match error {
            optn_transport::TransportError::Other(message)
            | optn_transport::TransportError::InvalidData(message) => message,
            _ => "Wallet authentication is unavailable.".into(),
        })
}

/// Forward public PSBT preparation/finalization; the runtime owns validation.
#[tauri::command]
pub async fn optn_airgap(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    request: optn_transport::AirgapRequest,
) -> Result<optn_transport::AirgapResponse, String> {
    runtime.airgap(request).await.map_err(|error| match error {
        optn_transport::TransportError::Other(message)
        | optn_transport::TransportError::InvalidData(message) => message,
        optn_transport::TransportError::AuthenticationRequired => "Open the wallet first.".into(),
        _ => "Air-gap signing is unavailable on this interface.".into(),
    })
}

/// Appearance save failures are returned after the runtime has applied the
/// selection. Callers should refresh their snapshot and display the error;
/// retrying the same selection retries persistence even if reduction is a no-op.
#[tauri::command]
pub async fn optn_app_dispatch(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    appearance: tauri::State<'_, AppearanceStore>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    action: WireAction,
) -> Result<(), String> {
    let action = optn_app::AppAction::try_from(action).map_err(|error| format!("{error:?}"))?;
    dispatch_action(&runtime, &appearance, &network_settings, action).await
}

/// Serialize network edits with network switches, and appearance edits with saves.
/// Network edits persist before publication; appearance edits persist afterward
/// and report save failures even when the runtime selection has already changed.
async fn dispatch_action(
    runtime: &optn_runtime::AppRuntime,
    appearance: &AppearanceStore,
    network_settings: &NetworkSettingsStore,
    action: optn_app::AppAction,
) -> Result<(), String> {
    let persists_network = matches!(
        &action,
        optn_app::AppAction::SetServer { .. }
            | optn_app::AppAction::UseNetworkDefaultServers
            | optn_app::AppAction::ReplaceNetworkServers { .. }
    );
    if persists_network || matches!(&action, optn_app::AppAction::SetNetwork(_)) {
        let _guard = network_settings.write_lock.lock().await;
        if persists_network {
            return dispatch_network_settings(runtime, network_settings, action).await;
        }
        return runtime
            .dispatch(action)
            .await
            .map_err(|_| "application runtime is closed".to_string());
    }

    let persist = matches!(
        &action,
        optn_app::AppAction::SetTheme(_)
            | optn_app::AppAction::SetSkin(_)
            | optn_app::AppAction::ToggleTheme
    );
    let _guard = if persist {
        Some(appearance.write_lock.lock().await)
    } else {
        None
    };
    runtime
        .dispatch(action)
        .await
        .map_err(|_| "application runtime is closed".to_string())?;
    if persist {
        let state = runtime.state();
        appearance.save(state.theme, state.skin).map_err(|error| {
            format!("Appearance changed for this session, but could not be saved: {error}")
        })?;
    }
    Ok(())
}

/// Validate and persist the targeted network before publishing its action.
///
/// The caller must hold the network store's write lock across this operation.
/// Validation or save errors leave the runtime unchanged. A closed runtime can
/// still reject publication after a successful save.
async fn dispatch_network_settings(
    runtime: &optn_runtime::AppRuntime,
    network_settings: &NetworkSettingsStore,
    action: optn_app::AppAction,
) -> Result<(), String> {
    let before = runtime.state();
    let mut candidate = before.clone();
    let saved_network = match &action {
        optn_app::AppAction::ReplaceNetworkServers { network, .. } => *network,
        _ => before.network,
    };
    let event = candidate.reduce(action.clone());
    if matches!(event, Some(optn_app::AppEvent::NoticeChanged)) {
        return Err(candidate
            .notice
            .unwrap_or_else(|| "Network setting was not applied".into()));
    }
    if matches!(event, Some(optn_app::AppEvent::ServersChanged)) {
        network_settings
            .save_for_network(&candidate, saved_network)
            .map_err(|error| {
                format!("Network setting was not applied because it could not be saved: {error}")
            })?;
    }
    runtime
        .dispatch(action)
        .await
        .map_err(|_| "application runtime is closed".to_string())
}

/// Return the current versioned wire snapshot without starting a refresh or sync.
#[tauri::command]
pub fn optn_app_snapshot(runtime: tauri::State<'_, optn_runtime::AppRuntime>) -> WireState {
    WireState::from(&runtime.state())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_wire_type_is_shell_neutral() {
        let wire = WireState::from(&optn_app::AppState::default());
        assert_eq!(wire.version, optn_transport::WIRE_PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn appearance_dispatch_acknowledges_durable_changes_and_reports_failed_saves() {
        use crate::appearance::tests::TestDirectory;
        use crate::network_config::NetworkSettingsStore;
        use optn_app::{AppAction, AppState, ThemeMode, UiSkin};
        let directory = TestDirectory::new();
        let store = directory.store();
        let network_settings = NetworkSettingsStore::new(directory.0.clone());
        let runtime = optn_runtime::AppRuntime::spawn(AppState::default());
        dispatch_action(
            &runtime,
            &store,
            &network_settings,
            AppAction::SetSkin(UiSkin::Cyberpunk),
        )
        .await
        .unwrap();
        dispatch_action(
            &runtime,
            &store,
            &network_settings,
            AppAction::SetTheme(ThemeMode::Light),
        )
        .await
        .unwrap();
        dispatch_action(&runtime, &store, &network_settings, AppAction::ToggleTheme)
            .await
            .unwrap();
        let mut restored = AppState::default();
        directory.store().restore(&mut restored).unwrap();
        assert_eq!(restored.theme, ThemeMode::Gray);
        assert_eq!(restored.skin, UiSkin::Cyberpunk);

        // A blocked destination must not acknowledge durable success.
        let path = directory.0.join("appearance.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let error = dispatch_action(
            &runtime,
            &store,
            &network_settings,
            AppAction::SetTheme(ThemeMode::Dark),
        )
        .await
        .unwrap_err();
        assert!(error.contains("changed for this session, but could not be saved"));
        assert_eq!(runtime.state().theme, ThemeMode::Dark);
        // Retrying the same (now no-op) action still retries persistence.
        std::fs::remove_dir(&path).unwrap();
        dispatch_action(
            &runtime,
            &store,
            &network_settings,
            AppAction::SetTheme(ThemeMode::Dark),
        )
        .await
        .unwrap();
        directory.store().restore(&mut restored).unwrap();
        assert_eq!(restored.theme, ThemeMode::Dark);
    }

    #[tokio::test]
    async fn network_settings_are_saved_before_the_runtime_publishes_them() {
        use crate::appearance::tests::TestDirectory;
        use crate::network_config::NetworkSettingsStore;
        use optn_app::{AppAction, AppState, ServerKind};
        use optn_core::network::Network;

        let directory = TestDirectory::new();
        let appearance = directory.store();
        let network_settings = NetworkSettingsStore::new(directory.0.clone());
        let runtime = optn_runtime::AppRuntime::spawn(AppState::default());
        let blocked_path = directory.0.join("network-mainnet.json");
        std::fs::create_dir(&blocked_path).unwrap();

        let error = dispatch_action(
            &runtime,
            &appearance,
            &network_settings,
            AppAction::SetServer {
                kind: ServerKind::Electrum,
                entry: "main.example:50002".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("not applied"));
        assert!(runtime
            .state()
            .servers
            .for_network(Network::Mainnet)
            .electrum
            .is_none());

        std::fs::remove_dir(&blocked_path).unwrap();
        dispatch_action(
            &runtime,
            &appearance,
            &network_settings,
            AppAction::SetServer {
                kind: ServerKind::Electrum,
                entry: "main.example:50002".into(),
            },
        )
        .await
        .unwrap();
        let mut restored = AppState::default();
        network_settings.restore(&mut restored).unwrap();
        assert_eq!(
            restored
                .servers
                .for_network(Network::Mainnet)
                .electrum
                .as_deref(),
            Some("main.example:50002")
        );
    }

    #[tokio::test]
    async fn chipnet_server_dispatch_restricts_selection_until_explicit_default_reset() {
        use crate::appearance::tests::TestDirectory;
        use optn_app::{AppAction, AppState, ServerKind};
        use optn_core::network::Network;
        use optn_runtime::chain::{build_selection_plan, ConnectionPolicy, SourceId};

        let directory = TestDirectory::new();
        let appearance = directory.store();
        let network_settings = NetworkSettingsStore::new(directory.0.clone());
        let mut state = AppState {
            network: Network::Chipnet,
            ..AppState::default()
        };
        state.apply(AppAction::OpenCreatedWallet {
            name: "Public source-selection fixture".into(),
            receive_address: "bchtest:qqaz6s295ncfs53m86qj0uw6sl8u2kuw0ymst35fx4".into(),
            account_path: "m/44'/1'/0'".into(),
        });
        let runtime = optn_runtime::AppRuntime::spawn(state);
        dispatch_action(
            &runtime,
            &appearance,
            &network_settings,
            AppAction::SetServer {
                kind: ServerKind::Electrum,
                entry: "127.0.0.1:1".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            runtime
                .state()
                .servers
                .for_network(Network::Chipnet)
                .electrum
                .as_deref(),
            Some("127.0.0.1:1")
        );
        let (catalog, policy) = network_settings
            .chain_selection(Network::Chipnet)
            .unwrap()
            .unwrap();
        let selection = build_selection_plan(&catalog, &policy);
        assert_eq!(selection.primary, [SourceId::new("host:127.0.0.1")]);
        assert!(selection.fallback.is_empty());

        // The acknowledgement must survive a new adapter reading the actual file.
        let restarted = NetworkSettingsStore::new(directory.0.clone());
        let mut restored = AppState::default();
        restarted.restore(&mut restored).unwrap();
        assert_eq!(restored.servers, runtime.state().servers);
        let (catalog, policy) = restarted
            .chain_selection(Network::Chipnet)
            .unwrap()
            .unwrap();
        assert_eq!(build_selection_plan(&catalog, &policy), selection);

        dispatch_action(
            &runtime,
            &appearance,
            &network_settings,
            AppAction::UseNetworkDefaultServers,
        )
        .await
        .unwrap();
        assert!(runtime.state().wallet.is_some());
        assert!(runtime
            .state()
            .servers
            .for_network(Network::Chipnet)
            .is_empty());
        let (catalog, policy) = restarted
            .chain_selection(Network::Chipnet)
            .unwrap()
            .unwrap();
        let defaults = optn_runtime::bootstrap::shipped_source_catalog(Network::Chipnet);
        assert_eq!(policy, ConnectionPolicy::auto());
        assert_eq!(
            build_selection_plan(&catalog, &policy),
            build_selection_plan(&defaults, &ConnectionPolicy::auto())
        );
        restarted.restore(&mut restored).unwrap();
        assert!(restored.servers.for_network(Network::Chipnet).is_empty());
    }

    #[tokio::test]
    async fn replacing_an_inactive_network_saves_that_network_without_switching() {
        use crate::appearance::tests::TestDirectory;
        use crate::network_config::NetworkSettingsStore;
        use optn_app::{AppAction, AppState, NetworkServers};
        use optn_core::network::Network;

        let directory = TestDirectory::new();
        let appearance = directory.store();
        let network_settings = NetworkSettingsStore::new(directory.0.clone());
        let runtime = optn_runtime::AppRuntime::spawn(AppState::default());
        dispatch_action(
            &runtime,
            &appearance,
            &network_settings,
            AppAction::ReplaceNetworkServers {
                network: Network::Chipnet,
                servers: NetworkServers {
                    peer: Some("chip.example:8333".into()),
                    ..NetworkServers::new()
                },
            },
        )
        .await
        .unwrap();

        assert_eq!(runtime.state().network, Network::Mainnet);
        let mut restored = AppState::default();
        network_settings.restore(&mut restored).unwrap();
        assert_eq!(
            restored
                .servers
                .for_network(Network::Chipnet)
                .peer
                .as_deref(),
            Some("chip.example:8333")
        );
        assert!(restored.servers.for_network(Network::Mainnet).is_empty());
    }
}
