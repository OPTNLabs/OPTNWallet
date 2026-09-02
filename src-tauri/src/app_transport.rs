//! Tauri command adapter for the shell-neutral application transport protocol.
//!
//! This module owns no application state and contains no wallet logic. It only
//! maps versioned wire values to the authoritative `optn-runtime` managed by
//! the host. Another shell can expose the same `optn-transport` contract using
//! a different adapter.

use optn_transport::{WireAction, WireState};

#[tauri::command]
pub async fn optn_app_dispatch(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    action: WireAction,
) -> Result<(), String> {
    let action = optn_app::AppAction::try_from(action).map_err(|error| format!("{error:?}"))?;
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
}
