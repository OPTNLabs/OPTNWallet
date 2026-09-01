#[cfg(target_arch = "wasm32")]
use leptos::prelude::*;

#[cfg(target_arch = "wasm32")]
#[component]
fn App() -> impl IntoView {
    let dark = RwSignal::new(true);
    let help_open = RwSignal::new(false);
    let core_prefix = optn_core::network::Network::Mainnet.prefix();

    view! {
        <main class:dark=move || dark.get() class="app-shell">
            <header class="topbar">
                <div class="brand" aria-label="OPTN Wallet">"OPTN"</div>

                <button
                    class="chip"
                    type="button"
                    on:click=move |_| dark.update(|value| *value = !*value)
                    aria-label="Toggle theme"
                >
                    {move || if dark.get() { "☀ Light" } else { "☾ Dark" }}
                </button>

                <button
                    class="chip"
                    type="button"
                    on:click=move |_| help_open.set(true)
                >
                    "Help"
                </button>
            </header>

            <section class="landing">
                <div class="hero" aria-hidden="true">
                    <div class="hero-mark">"OPTN"</div>
                    <div class="hero-ring hero-ring-one"></div>
                    <div class="hero-ring hero-ring-two"></div>
                </div>

                <section class="wallet-card">
                    <p class="eyebrow">"Bitcoin Cash, owned by you"</p>
                    <h1>"A Rust-first OPTN Wallet"</h1>
                    <p class="description">
                        "The new frontend runs in Rust/WASM and links the same "
                        <code>"optn-core"</code>
                        " used by native targets."
                    </p>

                    <div class="core-proof">
                        <span>"Shared-core network prefix"</span>
                        <strong>{core_prefix}</strong>
                    </div>

                    <nav class="actions" aria-label="Wallet onboarding">
                        <a class="primary" href="#/createwallet">"Create wallet"</a>
                        <a class="secondary" href="#/importwallet">"Import wallet"</a>
                    </nav>
                </section>
            </section>

            <Show when=move || help_open.get()>
                <div
                    class="modal-backdrop"
                    role="presentation"
                    on:click=move |_| help_open.set(false)
                >
                    <section
                        class="modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="help-title"
                        on:click=move |event| event.stop_propagation()
                    >
                        <h2 id="help-title">"Getting started"</h2>
                        <p>
                            "Create a new wallet or import an existing one. "
                            "This Leptos screen is the first Rust-authored UI slice."
                        </p>
                        <button
                            class="primary"
                            type="button"
                            on:click=move |_| help_open.set(false)
                        >
                            "Close"
                        </button>
                    </section>
                </div>
            </Show>
        </main>
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    console_error_panic_hook::set_once();
    leptos::mount::mount_to_body(|| view! { <App /> });
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    println!("optn-ui is a Leptos CSR frontend; build it for wasm32-unknown-unknown.");
}
