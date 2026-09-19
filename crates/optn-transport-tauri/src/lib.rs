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

        fn rescan_from_height<'a>(&'a self, height: u32) -> TransportFuture<'a, ()> {
            Box::pin(async move {
                let args = command_args("height", &JsValue::from_f64(height.into()))?;
                invoke("optn_wallet_rescan", args).await?;
                Ok(())
            })
        }

        fn export_network_configuration<'a>(
            &'a self,
            network: String,
        ) -> TransportFuture<'a, String> {
            Box::pin(async move {
                let args = command_args("network", &JsValue::from_str(&network))?;
                invoke("optn_chain_export_configuration", args)
                    .await?
                    .as_string()
                    .ok_or_else(|| {
                        TransportError::InvalidData(
                            "Invalid network configuration response.".into(),
                        )
                    })
            })
        }

        fn chain_sources<'a>(
            &'a self,
            network: String,
        ) -> TransportFuture<'a, optn_transport::chain_sources::ChainSourcesView> {
            Box::pin(async move {
                let args = command_args("network", &JsValue::from_str(&network))?;
                let value = invoke("optn_chain_sources", args).await?;
                serde_wasm_bindgen::from_value(value)
                    .map_err(|error| TransportError::InvalidData(error.to_string()))
            })
        }

        fn edit_chain_sources<'a>(
            &'a self,
            network: String,
            edit: optn_transport::chain_sources::ChainSourceEdit,
        ) -> TransportFuture<'a, ()> {
            Box::pin(async move {
                use optn_transport::chain_sources::ChainSourceEdit;
                let args = command_args("network", &JsValue::from_str(&network))?;
                let set = |key: &str, value: &str| {
                    Reflect::set(&args, &JsValue::from_str(key), &JsValue::from_str(value))
                        .map(|_| ())
                        .map_err(js_error)
                };
                let command = match edit {
                    ChainSourceEdit::Selection(selection) => {
                        let value = serde_wasm_bindgen::to_value(&selection)
                            .map_err(|error| TransportError::InvalidData(error.to_string()))?;
                        Reflect::set(&args, &JsValue::from_str("selection"), &value)
                            .map_err(js_error)?;
                        "optn_chain_set_selection"
                    }
                    ChainSourceEdit::Policy(policy) => {
                        set("policy", &policy)?;
                        "optn_chain_set_policy"
                    }
                    ChainSourceEdit::Disposition {
                        source,
                        disposition,
                    } => {
                        set("source", &source)?;
                        set("disposition", &disposition)?;
                        "optn_chain_set_source_disposition"
                    }
                    ChainSourceEdit::Remove(source) => {
                        set("source", &source)?;
                        "optn_chain_remove_source"
                    }
                    ChainSourceEdit::Add(mut request) => {
                        request.network = Some(network);
                        let value = serde_wasm_bindgen::to_value(&request)
                            .map_err(|error| TransportError::InvalidData(error.to_string()))?;
                        Reflect::set(&args, &JsValue::from_str("request"), &value)
                            .map_err(js_error)?;
                        "optn_chain_add_source"
                    }
                    ChainSourceEdit::Retry => "optn_chain_rebuild",
                    ChainSourceEdit::Import(configuration) => {
                        set("configuration", &configuration)?;
                        "optn_chain_import_configuration"
                    }
                };
                invoke(command, args).await?;
                if command != "optn_chain_rebuild" {
                    invoke("optn_chain_rebuild", Object::new().into()).await?;
                }
                Ok(())
            })
        }

        fn airgap<'a>(
            &'a self,
            request: optn_transport::AirgapRequest,
        ) -> TransportFuture<'a, optn_transport::AirgapResponse> {
            Box::pin(async move {
                let value = serde_wasm_bindgen::to_value(&request)
                    .map_err(|_| TransportError::InvalidData("Invalid air-gap request.".into()))?;
                let result = invoke("optn_airgap", command_args("request", &value)?).await?;
                serde_wasm_bindgen::from_value(result)
                    .map_err(|_| TransportError::InvalidData("Invalid air-gap response.".into()))
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

        fn tor_status<'a>(&'a self) -> TransportFuture<'a, optn_transport::WireTorStatus> {
            Box::pin(async move {
                let value = invoke("optn_tor_readiness", Object::new().into()).await?;
                serde_wasm_bindgen::from_value(value).map_err(|error| {
                    TransportError::InvalidData(format!("unreadable Tor status: {error}"))
                })
            })
        }

        fn start_tor<'a>(&'a self) -> TransportFuture<'a, optn_transport::WireTorStatus> {
            Box::pin(async move {
                // Bootstrapping can take a minute on a filtered network, and
                // the command waits for it. Reading the status back afterwards
                // rather than trusting the start call means the answer is what
                // the chain layer will actually see, not what starting a
                // process implied.
                invoke("tor_start", Object::new().into()).await?;
                let value = invoke("optn_tor_readiness", Object::new().into()).await?;
                serde_wasm_bindgen::from_value(value).map_err(|error| {
                    TransportError::InvalidData(format!("unreadable Tor status: {error}"))
                })
            })
        }

        fn trust_socks_port<'a>(&'a self, port: u16, trusted: bool) -> TransportFuture<'a, ()> {
            Box::pin(async move {
                let args = Object::new();
                Reflect::set(
                    &args,
                    &JsValue::from_str("port"),
                    &JsValue::from_f64(port.into()),
                )
                .map_err(js_error)?;
                Reflect::set(
                    &args,
                    &JsValue::from_str("trusted"),
                    &JsValue::from_bool(trusted),
                )
                .map_err(js_error)?;
                invoke("optn_chain_trust_socks_proxy", args.into()).await?;
                // Routes were built while the proxy was untrusted, and nothing
                // rebuilds them on a settings write alone.
                invoke("optn_chain_rebuild", Object::new().into()).await?;
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
