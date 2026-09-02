#![forbid(unsafe_code)]

//! Tauri/WebView implementation of the shell-agnostic `AppTransport` port.
//!
//! This crate is intentionally outside the neutral dependency firewall. It is
//! a replaceable shell adapter: web/extension use `LocalTransport`, native Rust
//! renderers can use `DirectTransport`, and Tauri-hosted WASM can use this type.

use optn_app::{AppAction, AppEvent, AppState};
use optn_transport::{AppTransport, TransportError, TransportFuture};

#[derive(Clone, Copy, Default)]
pub struct TauriWebTransport;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use js_sys::{Object, Reflect};
    use optn_transport::{WireAction, WireState};
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::JsFuture;

    #[wasm_bindgen(inline_js = r#"
        export function optnTauriInvoke(command, args) {
            const tauri = globalThis.__TAURI__;
            if (!tauri?.core?.invoke) {
                return Promise.reject(new Error('Tauri invoke bridge is unavailable'));
            }
            return tauri.core.invoke(command, args);
        }
    "#)]
    extern "C" {
        #[wasm_bindgen(js_name = optnTauriInvoke)]
        fn tauri_invoke(command: &str, args: &JsValue) -> js_sys::Promise;
    }

    fn js_error(value: JsValue) -> TransportError {
        TransportError::Other(
            value
                .as_string()
                .unwrap_or_else(|| format!("Tauri IPC rejected: {value:?}")),
        )
    }

    fn command_args(key: &str, value: &JsValue) -> Result<JsValue, TransportError> {
        let args = Object::new();
        Reflect::set(&args, &JsValue::from_str(key), value).map_err(js_error)?;
        Ok(args.into())
    }

    async fn invoke(command: &str, args: JsValue) -> Result<JsValue, TransportError> {
        JsFuture::from(tauri_invoke(command, &args))
            .await
            .map_err(js_error)
    }

    impl AppTransport for TauriWebTransport {
        fn dispatch<'a>(&'a self, action: AppAction) -> TransportFuture<'a, ()> {
            Box::pin(async move {
                let action = serde_wasm_bindgen::to_value(&WireAction::from(action))
                    .map_err(|error| TransportError::InvalidData(error.to_string()))?;
                let args = command_args("action", &action)?;
                invoke("optn_app_dispatch", args).await?;
                Ok(())
            })
        }

        fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
            Box::pin(async move {
                let value = invoke("optn_app_snapshot", Object::new().into()).await?;
                let wire: WireState = serde_wasm_bindgen::from_value(value)
                    .map_err(|error| TransportError::InvalidData(error.to_string()))?;
                AppState::try_from(wire)
            })
        }

        fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>> {
            Box::pin(async { Err(TransportError::Unsupported) })
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl AppTransport for TauriWebTransport {
    fn dispatch<'a>(&'a self, _action: AppAction) -> TransportFuture<'a, ()> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }

    fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }

    fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_transport<T: AppTransport>() {}

    #[test]
    fn tauri_adapter_satisfies_transport_contract_without_leaking_into_core() {
        assert_transport::<TauriWebTransport>();
    }
}
