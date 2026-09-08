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
    use js_sys::{Function, Object, Promise, Reflect};
    use optn_transport::{WireAction, WireState};
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;

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

    /// Invoke the Tauri global without a handwritten JavaScript bridge.
    ///
    /// `withGlobalTauri` is a shell setting; Rust owns argument construction,
    /// result handling, and every application command above this boundary.
    fn tauri_invoke(command: &str, args: &JsValue) -> Result<Promise, TransportError> {
        let global = js_sys::global();
        let tauri = Reflect::get(&global, &JsValue::from_str("__TAURI__")).map_err(js_error)?;
        let core = Reflect::get(&tauri, &JsValue::from_str("core")).map_err(js_error)?;
        let invoke = Reflect::get(&core, &JsValue::from_str("invoke")).map_err(js_error)?;
        let invoke = invoke
            .dyn_into::<Function>()
            .map_err(|_| TransportError::Other("Tauri invoke bridge is unavailable".into()))?;
        invoke
            .call2(&core, &JsValue::from_str(command), args)
            .map_err(js_error)?
            .dyn_into::<Promise>()
            .map_err(|_| TransportError::Other("Tauri invoke did not return a promise".into()))
    }

    async fn invoke(command: &str, args: JsValue) -> Result<JsValue, TransportError> {
        JsFuture::from(tauri_invoke(command, &args)?)
            .await
            .map_err(js_error)
    }

    impl AppTransport for TauriWebTransport {
        fn refresh_wallet<'a>(&'a self) -> TransportFuture<'a, ()> {
            Box::pin(async {
                invoke("optn_wallet_refresh", Object::new().into()).await?;
                Ok(())
            })
        }

        fn wallet_security<'a>(
            &'a self,
            request: optn_transport::WalletSecurityRequest,
        ) -> TransportFuture<'a, optn_transport::WalletSecurityStatus> {
            Box::pin(async move {
                let value = serde_wasm_bindgen::to_value(&request)
                    .map_err(|_| TransportError::InvalidData("Invalid wallet request.".into()))?;
                let result =
                    invoke("optn_wallet_security", command_args("request", &value)?).await?;
                serde_wasm_bindgen::from_value(result)
                    .map_err(|_| TransportError::InvalidData("Invalid wallet response.".into()))
            })
        }
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

        fn write_clipboard<'a>(&'a self, text: String) -> TransportFuture<'a, ()> {
            Box::pin(async move {
                let args = command_args("text", &JsValue::from_str(&text))?;
                invoke("clipboard_write_text", args).await?;
                Ok(())
            })
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
