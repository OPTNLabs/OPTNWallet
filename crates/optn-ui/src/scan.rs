#![cfg(target_arch = "wasm32")]

//! QR scanning, as a control any field can borrow.
//!
//! The renderer never touches a camera API. It asks the transport, which the
//! shell supplies — so a Dioxus or egui build inherits scanning without this
//! file changing. Whether to offer the control at all comes from
//! `optn_app::transport_support`, so a surface with no camera shows no button
//! rather than a button that fails.

use crate::UiTransport;
use leptos::prelude::*;
use optn_app::{transport_support, AppState};

/// Does this surface have a camera to scan with?
pub fn can_scan(state: RwSignal<AppState>) -> bool {
    transport_support(state.get().surface).camera
}

/// A "Scan QR" button that hands the decoded payload to `on_payload`.
///
/// Rendered only where a camera exists. `busy` is local so two scan buttons
/// on one screen do not disable each other.
#[component]
pub fn ScanButton(
    transport: UiTransport,
    state: RwSignal<AppState>,
    /// Distinguishes the control in tests, e.g. `xpub` or `cosigner-1`.
    #[prop(into)]
    label: String,
    /// Called with the scanned text.
    on_payload: Callback<String>,
    /// Set when the scan fails, so the caller can show it beside its field.
    error: RwSignal<Option<String>>,
) -> impl IntoView {
    let busy = RwSignal::new(false);
    let testid = format!("scan-{label}");

    view! {
        <Show when=move || can_scan(state)>
            <button
                class="secondary scan-button"
                type="button"
                data-testid=testid.clone()
                disabled=move || busy.get()
                on:click=move |_| {
                    if busy.get_untracked() {
                        return;
                    }
                    busy.set(true);
                    error.set(None);
                    let scanner = transport.get_value();
                    leptos::task::spawn_local(async move {
                        match scanner.scan_qr().await {
                            Ok(payload) => {
                                let trimmed = payload.trim().to_owned();
                                if trimmed.is_empty() {
                                    error.set(Some("That QR code was empty.".into()));
                                } else {
                                    on_payload.run(trimmed);
                                }
                            }
                            // Say which of "no camera here" and "the scan
                            // failed" happened; they need different fixes.
                            Err(optn_transport::TransportError::Unsupported) => {
                                error.set(Some(
                                    "This build cannot open a camera, so scanning is unavailable."
                                        .into(),
                                ));
                            }
                            Err(_) => {
                                error.set(Some("Could not read a QR code.".into()));
                            }
                        }
                        busy.set(false);
                    });
                }
            >
                {move || if busy.get() { "Scanning…" } else { "Scan QR" }}
            </button>
        </Show>
    }
}
