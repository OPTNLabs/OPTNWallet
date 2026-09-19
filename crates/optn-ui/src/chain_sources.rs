//! Source management renders the native catalog; all edits are validated and persisted by Rust runtime helpers.
use crate::UiTransport;
use leptos::prelude::*;
use optn_app::AppState;
use optn_transport::chain_sources::{
    AddSourceRequest, ChainSourceEdit, ChainSourcesView, WireChainProtocol, WireConnectionPolicy,
    WireSourceScope,
};

#[component]
pub fn ChainSourcesSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let network = Memo::new(move |_| state.get().network.to_string());
    let catalog = RwSignal::new(None::<ChainSourcesView>);
    let error = RwSignal::new(None::<String>);
    let draft = RwSignal::new(None::<WireConnectionPolicy>);
    let revision = StoredValue::new(0u64);
    let action = Action::new_local(move |request: &(String, Option<ChainSourceEdit>)| {
        let (selected, edit) = request.clone();
        let issued = revision.get_value().wrapping_add(1);
        revision.set_value(issued);
        let transport = transport.get_value();
        async move {
            let result = async {
                if let Some(edit) = edit {
                    transport.edit_chain_sources(selected.clone(), edit).await?;
                }
                transport.chain_sources(selected.clone()).await
            }
            .await;
            if revision.try_get_value() == Some(issued)
                && network.try_get_untracked().as_ref() == Some(&selected)
            {
                match result {
                    Ok(value) if value.network == selected => {
                        draft.try_set(Some(value.selection.clone()));
                        catalog.try_set(Some(value));
                        error.try_set(None);
                    }
                    Ok(_) => {
                        error.try_set(Some("Source response belongs to another network.".into()));
                    }
                    Err(failure) => {
                        error.try_set(Some(format!("{failure:?}")));
                    }
                }
            }
        }
    });
    Effect::new(move |_| {
        let selected = network.get();
        catalog.set(None);
        draft.set(None);
        error.set(None);
        action.dispatch((selected, None));
    });
    let backup = RwSignal::new(String::new());
    let exporting = Action::new_local(move |selected: &String| {
        let selected = selected.clone();
        let transport = transport.get_value();
        async move {
            let result = transport
                .export_network_configuration(selected.clone())
                .await;
            if network.try_get_untracked().as_ref() == Some(&selected) {
                match result {
                    Ok(value) => {
                        backup.try_set(value);
                    }
                    Err(failure) => {
                        error.try_set(Some(format!("{failure:?}")));
                    }
                }
            }
        }
    });
    Effect::new(move |_| {
        network.get();
        backup.set(String::new());
    });
    let label = RwSignal::new(String::new());
    let host = RwSignal::new(String::new());
    let port = RwSignal::new("50002".to_owned());
    let kind = RwSignal::new("electrum-tls".to_owned());
    let group = RwSignal::new(String::new());
    view! {
        <section aria-label="Chain sources">
            <p class="source-title">"Chain sources"</p>
            <p class="muted">"Saved for the selected network. Disabled or banned sources cannot be used for failover."</p>
            <Show when=move || action.pending().get()><p role="status">"Updating sources..."</p></Show>
            {move || error.get().map(|message| view! { <p role="alert">{message}</p> })}
            <Show when=move || catalog.get().is_some()>
                <label class="field">
                    <span>"Connection policy"</span>
                    <select
                        disabled=move || action.pending().get()
                        prop:value=move || catalog.get().map(|value| value.policy).unwrap_or_default()
                        on:change=move |event| { action.dispatch((network.get_untracked(), Some(ChainSourceEdit::Policy(event_target_value(&event))))); }
                    >
                        <option value="auto">"Automatic"</option>
                        <option value="privacy">"Privacy"</option>
                        <option value="own_infrastructure">"Only my infrastructure"</option>
                        <option value="electrum_only">"Electrum"</option>
                        <option value="bip37_only">"BIP37 nodes"</option>
                        <option value="neutrino_only">"Compact-filter nodes"</option>
                        <option value="custom" disabled>"Custom selection"</option>
                    </select>
                </label>
                {move || catalog.get().and_then(|value| value.configuration_error).map(|message| view! { <p role="alert">{message}</p> })}
                <p class="muted">{move || catalog.get().map(|value| format!("{} usable wallet routes", value.wallet_routes)).unwrap_or_default()}</p>
                <details>
                    <summary>"Advanced selection and failover"</summary>
                    <p class="muted">"Choose a source pool, allowed protocols, and optional fallback. Save applies the complete selection together."</p>
                    <label class="field"><span>"Primary pool"</span>
                        <select disabled=move || action.pending().get() prop:value=move || draft.get().map(|value|scope_name(&value.primary_scope)).unwrap_or("all") on:change=move |event| {
                            let selected=event_target_value(&event);
                            draft.update(|draft| if let Some(value)=draft { value.primary_scope=scope_choice(&selected,&value.primary_scope); });
                        }><option value="all">"All enabled sources"</option><option value="public">"Public sources"</option><option value="own">"My infrastructure"</option><option value="selected">"Selected sources below"</option></select>
                    </label>
                    <label class="field"><span>"Fallback pool"</span>
                        <select disabled=move || action.pending().get() prop:value=move || draft.get().and_then(|value|value.fallback_scope).as_ref().map(scope_name).unwrap_or("none") on:change=move |event| {
                            let selected=event_target_value(&event);
                            draft.update(|draft| if let Some(value)=draft { value.fallback_scope=if selected=="none" {None} else {Some(scope_choice(&selected,value.fallback_scope.as_ref().unwrap_or(&WireSourceScope::AllEnabled)))}; });
                        }><option value="none">"No fallback"</option><option value="all">"All enabled sources"</option><option value="public">"Public sources"</option><option value="own">"My infrastructure"</option><option value="selected">"Selected sources below"</option></select>
                    </label>
                    <fieldset><legend>"Allowed protocols"</legend>
                        {[ (WireChainProtocol::FulcrumElectrum,"Electrum"), (WireChainProtocol::Bip37,"BIP37"), (WireChainProtocol::Neutrino,"Compact filters"), (WireChainProtocol::BchnRpc,"Node RPC"), (WireChainProtocol::BchnZmq,"Node notifications") ].into_iter().map(|(protocol,label)|view! {
                            <label class="field"><span>{label}</span><input type="checkbox" disabled=move || action.pending().get() prop:checked=move || draft.get().is_some_and(|value|value.protocols.contains(&protocol)) on:change=move |event| {
                                let checked=event_target_checked(&event);
                                draft.update(|draft| if let Some(value)=draft { value.protocols.retain(|p|*p!=protocol); if checked {value.protocols.push(protocol);} });
                            } /></label>
                        }).collect_view()}
                    </fieldset>
                    <For each=move || catalog.get().map(|value|value.sources).unwrap_or_default() key=|source|source.id.clone() children=move |source| {
                        let id=StoredValue::new(source.id);
                        view! {
                            <div class="panel">
                                <p>{source.label}</p>
                                <Show when=move || draft.get().is_some_and(|value|matches!(value.primary_scope,WireSourceScope::Selected(_)))>
                                    <label class="field"><span>"Primary"</span><input type="checkbox" disabled=move || action.pending().get() prop:checked=move || draft.get().is_some_and(|value|scope_has(&value.primary_scope,&id.get_value())) on:change=move |event| {
                                        let checked=event_target_checked(&event); draft.update(|draft|if let Some(value)=draft {toggle_source(&mut value.primary_scope,id.get_value(),checked);});
                                    } /></label>
                                </Show>
                                <Show when=move || draft.get().is_some_and(|value|matches!(value.fallback_scope,Some(WireSourceScope::Selected(_))))>
                                    <label class="field"><span>"Fallback"</span><input type="checkbox" disabled=move || action.pending().get() prop:checked=move || draft.get().and_then(|value|value.fallback_scope).is_some_and(|scope|scope_has(&scope,&id.get_value())) on:change=move |event| {
                                        let checked=event_target_checked(&event); draft.update(|draft|if let Some(value)=draft {if let Some(scope)=&mut value.fallback_scope {toggle_source(scope,id.get_value(),checked);}});
                                    } /></label>
                                </Show>
                                <button class="secondary" type="button" disabled=move || action.pending().get() on:click=move |_| {
                                    draft.update(|draft|if let Some(value)=draft {let id=id.get_value();value.preferred.retain(|existing|existing!=&id);value.preferred.insert(0,id);});
                                }>"Prefer first"</button>
                                <p class="muted">{move || draft.get().and_then(|value|value.preferred.iter().position(|source|source==&id.get_value())).map(|rank|format!("Preference {}",rank+1))}</p>
                            </div>
                        }
                    } />
                    <button class="primary" type="button" disabled=move || action.pending().get() on:click=move |_| {if let Some(selection)=draft.get_untracked() {action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Selection(selection))));}}>"Save selection"</button>
                </details>
                <div class="choice-list">
                    <For each=move || catalog.get().map(|value| value.sources).unwrap_or_default() key=|source| format!("{}:{}:{}",source.id,source.disposition,source.live_protocols.join(",")) children=move |source| {
                        let id = StoredValue::new(source.id.clone());
                        let initial = source.disposition.clone();
                        let has_rpc = source.endpoints.iter().any(|endpoint| endpoint.kind == "node-rpc");
                        view! {
                            <article class="panel">
                                <p class="source-title">{source.label}</p>
                                <p class="muted">{source.group.unwrap_or(source.origin)}</p>
                                <p class="muted">{if source.live_protocols.is_empty() { "Not connected".to_owned() } else { "Connected".to_owned() }}</p>
                                <label class="field"><span>"Availability"</span>
                                    <select disabled=move || action.pending().get() prop:value=initial on:change=move |event| {
                                        action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Disposition { source:id.get_value(), disposition:event_target_value(&event) })));
                                    }>
                                        <option value="enabled">"Enabled"</option><option value="disabled">"Disabled"</option><option value="banned">"Banned"</option>
                                    </select>
                                </label>
                                <details><summary>"Connection details"</summary>
                                    {source.endpoints.into_iter().map(|endpoint| view! { <p class="mono">{format!("{} {}{}",endpoint.kind,endpoint.host,endpoint.port.map(|p|format!(":{p}")).unwrap_or_default())}</p> }).collect_view()}
                                    {source.failures.into_iter().map(|failure| view! { <p>{failure.error}</p> }).collect_view()}
                                </details>
                                {has_rpc.then(|| view! { <RpcCredentials transport=transport network=network state=state source=id.get_value() /> })}
                                <Show when=move || source.can_remove>
                                    <button class="secondary" type="button" disabled=move || action.pending().get() on:click=move |_| { action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Remove(id.get_value())))); }>"Remove source"</button>
                                </Show>
                            </article>
                        }
                    } />
                </div>
            </Show>
            <button class="secondary" type="button" disabled=move || action.pending().get() on:click=move |_| { action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Retry))); }>"Retry connections"</button>
            <details><summary>"Back up or restore network settings"</summary>
                <p class="muted">"Includes this network's sources, bans and selection. Wallet keys and passwords are never included. Confirm external Tor proxies again on a new device."</p>
                <button class="secondary" type="button" disabled=move || exporting.pending().get() || action.pending().get() on:click=move |_| {exporting.dispatch(network.get_untracked());}>"Export settings"</button>
                <label class="field"><span>"Network settings backup"</span><textarea spellcheck="false" prop:value=move || backup.get() on:input=move |event| backup.set(event_target_value(&event)) /></label>
                <button class="secondary" type="button" disabled=move || backup.get().is_empty() on:click=move |_| {let text=backup.get_untracked();let transport=transport.get_value();leptos::task::spawn_local(async move {if let Err(failure)=transport.write_clipboard(text).await {error.try_set(Some(format!("{failure:?}")));}});}>"Copy backup"</button>
                <p class="muted">"Restore replaces the selected network's saved sources and selection. Export your current settings first if you want to keep them."</p>
                <button class="secondary" type="button" disabled=move || action.pending().get() || exporting.pending().get() || backup.get().is_empty() on:click=move |_| {action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Import(backup.get_untracked()))));}>"Restore this network's settings"</button>
            </details>
            <details><summary>"Add a source"</summary>
                <form class="watch-only-form" on:submit=move |event| {
                    event.prevent_default();
                    let port = match port.get_untracked().parse::<u16>() { Ok(value) if value > 0 => value, _ => {error.set(Some("Enter a port between 1 and 65535.".into())); return;} };
                    let group = group.get_untracked();
                    action.dispatch((network.get_untracked(), Some(ChainSourceEdit::Add(AddSourceRequest {
                        network:Some(network.get_untracked()), label:label.get_untracked(), host:host.get_untracked(), port:Some(port), kind:kind.get_untracked(), infrastructure_group:(!group.trim().is_empty()).then_some(group),
                    }))));
                }>
                    <label class="field"><span>"Name"</span><input required prop:value=move || label.get() on:input=move |event| label.set(event_target_value(&event)) /></label>
                    <label class="field"><span>"Connection"</span><select prop:value=move || kind.get() on:change=move |event| kind.set(event_target_value(&event))><option value="electrum-tls">"Electrum TLS"</option><option value="electrum-tcp">"Electrum TCP"</option><option value="p2p">"BCH node"</option><option value="node-rpc">"Node RPC"</option><option value="node-zmq">"Node notifications"</option></select></label>
                    <label class="field"><span>"Host"</span><input required spellcheck="false" prop:value=move || host.get() on:input=move |event| host.set(event_target_value(&event)) /></label>
                    <label class="field"><span>"Port"</span><input required type="number" min="1" max="65535" prop:value=move || port.get() on:input=move |event| port.set(event_target_value(&event)) /></label>
                    <label class="field"><span>"My infrastructure group (optional)"</span><input prop:value=move || group.get() on:input=move |event| group.set(event_target_value(&event)) /><small>"Only mark infrastructure you control. This permits a direct connection."</small></label>
                    <button class="primary" disabled=move || action.pending().get() type="submit">"Save source"</button>
                </form>
            </details>
        </section>
    }
}

fn scope_name(scope: &WireSourceScope) -> &'static str {
    match scope {
        WireSourceScope::AllEnabled => "all",
        WireSourceScope::PublicEnabled => "public",
        WireSourceScope::MyInfrastructure => "own",
        WireSourceScope::Selected(_) => "selected",
    }
}
fn scope_choice(value: &str, previous: &WireSourceScope) -> WireSourceScope {
    match value {
        "public" => WireSourceScope::PublicEnabled,
        "own" => WireSourceScope::MyInfrastructure,
        "selected" => match previous {
            WireSourceScope::Selected(ids) => WireSourceScope::Selected(ids.clone()),
            _ => WireSourceScope::Selected(Vec::new()),
        },
        _ => WireSourceScope::AllEnabled,
    }
}
fn scope_has(scope: &WireSourceScope, id: &str) -> bool {
    matches!(scope,WireSourceScope::Selected(ids) if ids.iter().any(|value|value==id))
}
fn toggle_source(scope: &mut WireSourceScope, id: String, checked: bool) {
    if let WireSourceScope::Selected(ids) = scope {
        ids.retain(|value| value != &id);
        if checked {
            ids.push(id);
        }
    }
}

#[component]
fn RpcCredentials(
    transport: UiTransport,
    network: Memo<String>,
    state: RwSignal<AppState>,
    source: String,
) -> impl IntoView {
    use optn_transport::chain_sources::RpcCredentialRequest;
    let source = StoredValue::new(source);
    let username = RwSignal::new(String::new());
    let password = RwSignal::new(String::new());
    let message = RwSignal::new(String::new());
    let request = Action::new_local(
        move |request: &std::sync::Mutex<Option<RpcCredentialRequest>>| {
            let request = request.lock().ok().and_then(|mut value| value.take());
            let selected = network.get_untracked();
            let transport = transport.get_value();
            async move {
                let Some(request) = request else {
                    return;
                };
                let result = transport.rpc_credentials(selected.clone(), request).await;
                if network.try_get_untracked().as_ref() == Some(&selected) {
                    message.try_set(match result {
                        Ok(status) if status.configured => {
                            "Credentials stored for this endpoint. Sync to refresh the wallet."
                                .into()
                        }
                        Ok(_) => "No credentials stored for this endpoint.".into(),
                        Err(_) => {
                            "Credential operation failed or is unavailable on this platform.".into()
                        }
                    });
                }
            }
        },
    );
    view! {
        <details><summary>"Node RPC authentication"</summary>
            <p class="muted">{move || (state.get().surface != optn_app::AppSurface::Desktop).then_some("Credential entry is currently available on desktop only.")}</p>
            <fieldset disabled=move || state.get().surface != optn_app::AppSurface::Desktop>
            <p class="muted">"Saved in this device's secure storage, excluded from settings backups. Linux credentials last for the login session."</p>
            <form on:submit=move |event| {
                event.prevent_default();
                let value = RpcCredentialRequest::Set { source:source.get_value(), username:optn_app::SecretText::new(username.get_untracked()), password:optn_app::SecretText::new(password.get_untracked()) };
                username.set(String::new()); password.set(String::new());
                request.dispatch(std::sync::Mutex::new(Some(value)));
            }>
                <label class="field"><span>"RPC username"</span><input required autocomplete="off" prop:value=move || username.get() on:input=move |event| username.set(event_target_value(&event)) /></label>
                <label class="field"><span>"RPC password"</span><input required type="password" autocomplete="new-password" prop:value=move || password.get() on:input=move |event| password.set(event_target_value(&event)) /></label>
                <button type="submit" class="primary" disabled=move || request.pending().get()>"Save credentials"</button>
            </form>
            <button type="button" class="secondary" disabled=move || request.pending().get() on:click=move |_| {request.dispatch(std::sync::Mutex::new(Some(RpcCredentialRequest::Status {source:source.get_value()})));}>"Check saved credentials"</button>
            <button type="button" class="secondary" disabled=move || request.pending().get() on:click=move |_| {request.dispatch(std::sync::Mutex::new(Some(RpcCredentialRequest::Remove {source:source.get_value()})));}>"Remove credentials"</button>
            <p role="status">{move || message.get()}</p>
            </fieldset>
        </details>
    }
}
