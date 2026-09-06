//! Tauri command adapter for the shell-neutral application transport protocol.
//!
//! This module owns no application state and contains no wallet logic. It only
//! maps versioned wire values to the authoritative `optn-runtime` managed by
//! the host. Another shell can expose the same `optn-transport` contract using
//! a different adapter.

use crate::appearance::AppearanceStore;
use crate::network_config::NetworkSettingsStore;
use optn_transport::{WireAction, WireState};

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

async fn dispatch_action(
    runtime: &optn_runtime::AppRuntime,
    appearance: &AppearanceStore,
    network_settings: &NetworkSettingsStore,
    action: optn_app::AppAction,
) -> Result<(), String> {
    let persists_network = matches!(
        &action,
        optn_app::AppAction::SetServer { .. } | optn_app::AppAction::UseNetworkDefaultServers
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

async fn dispatch_network_settings(
    runtime: &optn_runtime::AppRuntime,
    network_settings: &NetworkSettingsStore,
    action: optn_app::AppAction,
) -> Result<(), String> {
    let before = runtime.state();
    let mut candidate = before.clone();
    if matches!(
        candidate.reduce(action.clone()),
        Some(optn_app::AppEvent::ServersChanged)
    ) {
        network_settings
            .save_for_network(&candidate, before.network)
            .map_err(|error| {
                format!("Network setting was not applied because it could not be saved: {error}")
            })?;
    }
    runtime
        .dispatch(action)
        .await
        .map_err(|_| "application runtime is closed".to_string())
}

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
        dispatch_action(
            &runtime,
            &store,
            &network_settings,
            AppAction::ToggleTheme,
        )
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
            restored.servers.for_network(Network::Mainnet).electrum.as_deref(),
            Some("main.example:50002")
        );
    }
}
