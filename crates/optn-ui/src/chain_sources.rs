//! Source management renders the native catalog; all edits are validated and persisted by Rust runtime helpers.
use crate::UiTransport;
use leptos::prelude::*;
use optn_app::AppState;
use optn_transport::chain_sources::{
    AddSourceRequest, ChainSourceEdit, ChainSourcesView, WireChainProtocol, WireConnectionPolicy,
    WireSourceScope,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum NetworkPage {
    Overview,
    Public,
    Own,
    Custom,
    Details,
    Routing,
    Privacy,
    Explorer,
    Add,
    Services,
    Backup,
}

#[component]
pub fn ChainSourcesSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let page = RwSignal::new(NetworkPage::Overview);
    let source_id = RwSignal::new(String::new());
    let directory = RwSignal::new(NetworkPage::Public);
    let search = RwSignal::new(String::new());
    let service_filter = RwSignal::new(String::new());
    let network = Memo::new(move |_| state.get().network.to_string());
    let catalog = RwSignal::new(None::<ChainSourcesView>);
    let error = RwSignal::new(None::<String>);
    let notice = RwSignal::new(None::<String>);
    let draft = RwSignal::new(None::<WireConnectionPolicy>);
    let revision = StoredValue::new(0u64);
    let action = Action::new_local(move |request: &(String, Option<ChainSourceEdit>)| {
        let (selected, edit) = request.clone();
        let added = matches!(&edit, Some(ChainSourceEdit::Add(_)));
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
                        if added {
                            notice.try_set(Some("Service saved. Add another service on this host or return to your sources.".into()));
                        }
                        if page.get_untracked() == NetworkPage::Details
                            && !value
                                .sources
                                .iter()
                                .any(|s| s.id == source_id.get_untracked())
                        {
                            page.set(directory.get_untracked());
                        }
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
        page.set(NetworkPage::Overview);
        source_id.set(String::new());
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
            <Show when=move || page.get()!=NetworkPage::Overview>
                <button class="secondary" type="button" on:click=move |_| page.set(if page.get_untracked()==NetworkPage::Details { directory.get_untracked() } else if page.get_untracked()==NetworkPage::Services { NetworkPage::Add } else { NetworkPage::Overview })>"Back"</button>
            </Show>
            <h2>{move || match page.get() { NetworkPage::Overview=>"Network", NetworkPage::Public=>"Public Sources", NetworkPage::Own=>"My Infrastructure", NetworkPage::Custom=>"My Custom Sources", NetworkPage::Details=>"Source details", NetworkPage::Routing=>"Routing", NetworkPage::Privacy=>"Privacy & Transport", NetworkPage::Explorer=>"Explorer", NetworkPage::Add=>"Add a source", NetworkPage::Services=>"Configure services", NetworkPage::Backup=>"Network backup" }}</h2>
            <Show when=move || page.get()==NetworkPage::Overview>
                <p class="muted">"Sources provide chain access. Routing chooses eligible services for each operation within your boundaries."</p>
                <p>{move || catalog.get().map(|v|format!("{} usable wallet routes · Routing: {}",v.wallet_routes,routing_name(&v.policy))).unwrap_or_else(||"Loading saved configuration...".into())}</p>
                <nav aria-label="Network settings" class="choice-list">
                    {[(NetworkPage::Own,"My Infrastructure","own-infrastructure"),(NetworkPage::Public,"Public Sources","bootstrap"),(NetworkPage::Custom,"My Custom Sources","user")].into_iter().map(|(destination,title,origin)|view! {
                        <button class="panel settings-row" type="button" on:click=move |_| {directory.set(destination);page.set(destination);}>
                            <span class="source-title">{title}</span>
                            <span class="muted">{move || catalog.get().map(|v|format!("{} known sources",v.sources.iter().filter(|s|s.origin==origin).count())).unwrap_or_default()}</span>
                        </button>
                    }).collect_view()}
                    {[(NetworkPage::Routing,"Routing"),(NetworkPage::Privacy,"Privacy & Transport"),(NetworkPage::Explorer,"Explorer"),(NetworkPage::Backup,"Back up or restore network settings")].into_iter().map(|(destination,title)|view! {<button class="panel settings-row" type="button" on:click=move |_| page.set(destination)>{title}</button>}).collect_view()}
                </nav>
            </Show>
            <Show when=move || page.get()==NetworkPage::Privacy>
                <p>"Public sources require Tor under the current host policy. Explicitly owned infrastructure may use direct connections. A generic SOCKS proxy is not proof of Tor."</p>
                <crate::settings::TorSection transport=transport />
            </Show>
            <Show when=move || page.get()==NetworkPage::Explorer>
                <p class="muted">"Explorer links are separate from wallet synchronization and source selection. Leave the address empty to use the network default; existing privacy restrictions still apply."</p>
                <crate::settings::ServerField transport=transport state=state kind=optn_app::ServerKind::Explorer />
            </Show>
            <Show when=move || action.pending().get()><p role="status">"Updating sources..."</p></Show>
            {move || notice.get().map(|message| view! { <p role="status">{message}</p> })}
            {move || error.get().map(|message| view! { <p role="alert">{message}</p> })}
            <Show when=move || catalog.get().is_some()>
                <Show when=move || page.get()==NetworkPage::Routing>
                <label class="field">
                    <span>"Routing preset"</span>
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
                <section aria-label="Routing boundaries">
                    <h3>"Selection and failover"</h3>
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
                    <fieldset><legend>"Allowed chain access"</legend>
                        {[ (WireChainProtocol::FulcrumElectrum,"Electrum"), (WireChainProtocol::Bip37,"BIP37"), (WireChainProtocol::Neutrino,"Compact filters"), (WireChainProtocol::BchnRpc,"Node RPC") ].into_iter().map(|(protocol,label)|view! {
                            <label class="field"><span>{label}</span><input type="checkbox" disabled=move || action.pending().get() prop:checked=move || draft.get().is_some_and(|value|value.protocols.contains(&protocol)) on:change=move |event| {
                                let checked=event_target_checked(&event);
                                draft.update(|draft| if let Some(value)=draft { value.protocols.retain(|p|*p!=protocol); if checked {value.protocols.push(protocol);} });
                            } /></label>
                        }).collect_view()}
                    </fieldset>
                    <fieldset><legend>"Event sources"</legend>
                        <label class="field"><span>"Node notifications (ZMQ)"</span><input type="checkbox" disabled=move || action.pending().get() prop:checked=move || draft.get().is_some_and(|v|v.protocols.contains(&WireChainProtocol::BchnZmq)) on:change=move |event| {let checked=event_target_checked(&event);draft.update(|d|if let Some(v)=d {v.protocols.retain(|p|*p!=WireChainProtocol::BchnZmq);if checked {v.protocols.push(WireChainProtocol::BchnZmq);}});} /></label>
                        <p class="muted">"Notifications may trigger reconciliation. They are not a synchronization mode or verification proof."</p>
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
                </section>
                </Show>
                <Show when=move || matches!(page.get(),NetworkPage::Public|NetworkPage::Own|NetworkPage::Custom)>
                    <p class="muted">"Browsing reads the catalog without contacting these sources. Known, configured and currently usable are different states."</p>
                    <label class="field"><span>"Search sources"</span><input type="search" prop:value=move || search.get() on:input=move |e|search.set(event_target_value(&e)) /></label>
                    <label class="field"><span>"Service filter"</span><select prop:value=move || service_filter.get() on:change=move |e|service_filter.set(event_target_value(&e))><option value="">"All services"</option><option value="electrum">"Electrum / Fulcrum"</option><option value="p2p">"BCH P2P"</option><option value="bip37">"BIP37"</option><option value="neutrino">"Compact filters"</option><option value="node-rpc">"Node RPC"</option><option value="node-zmq">"Notifications"</option></select></label>
                    <Show when=move || page.get()!=NetworkPage::Public><button class="primary" type="button" on:click=move |_| {group.set(if page.get_untracked()==NetworkPage::Own {"My infrastructure".into()} else {String::new()});page.set(NetworkPage::Add);}>"Add source"</button></Show>
                </Show>
                <Show when=move || matches!(page.get(),NetworkPage::Public|NetworkPage::Own|NetworkPage::Custom|NetworkPage::Details)>
                <div class="choice-list">
                    <For each=move || {let destination=page.get();let query=search.get().to_lowercase();let filter=service_filter.get();catalog.get().map(|value| value.sources.into_iter().filter(|source| {
                        if destination==NetworkPage::Details {return source.id==source_id.get();}
                        let origin=match destination {NetworkPage::Public=>"bootstrap",NetworkPage::Own=>"own-infrastructure",_=>"user"};
                        source.origin==origin && (source.label.to_lowercase().contains(&query)||source.endpoints.iter().any(|e|e.host.to_lowercase().contains(&query))) && (filter.is_empty()||source.endpoints.iter().any(|e|e.kind.contains(&filter))||source.protocol_statuses.iter().any(|p|p.protocol==filter && matches!(p.status,optn_transport::chain_sources::SourceProtocolStatus::Advertised|optn_transport::chain_sources::SourceProtocolStatus::Verified)))
                    }).collect::<Vec<_>>()).unwrap_or_default()} key=|source| format!("{source:?}") children=move |source| {
                        let id = StoredValue::new(source.id.clone());
                        let initial = source.disposition.clone();
                        let has_rpc = source.endpoints.iter().any(|endpoint| endpoint.kind == "node-rpc");
                        view! {
                            <article class="panel">
                                <p class="source-title">{source.label}</p>
                                <p class="muted">{source.endpoints.first().map(|e|e.host.clone()).unwrap_or_default()}</p>
                                <p class="muted">{source.group.clone().unwrap_or_else(||match source.origin.as_str(){"bootstrap"=>"Maintained public catalog", "own-infrastructure"=>"My infrastructure", _=>"User-added source"}.into())}</p>
                                <div class="source-badges">
                                    {source.registered_capability_details.iter().take(4).cloned().map(|claim|view! {
                                        <details><summary class="chip">{claim.name}</summary><p>{format!("{:?} · {} · {}",claim.confidence,claim.protocol,claim.discovery)}</p><p class="muted">"Recorded provider evidence. Routing and privacy restrictions still apply."</p></details>
                                    }).collect_view()}
                                    {source.endpoints.iter().map(|e|e.kind.as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().map(|kind|view! {<span class="chip">{service_name(kind).to_owned()}</span>}).collect_view()}
                                    {source.capability_details.iter().filter(|_|source.registered_capability_details.is_empty()).take(4).cloned().map(|claim|view! {
                                        <details><summary class="chip">{claim.name}</summary><p>{format!("{:?} · {}",claim.confidence,claim.discovery)}</p><p class="muted">"Source-level catalog evidence; not proof of a current endpoint connection."</p></details>
                                    }).collect_view()}
                                </div>
                                <p class="muted">{if source.live_protocols.is_empty() { "No usable wallet route in the current selection" } else { "Wallet route available" }}</p>
                                <p>{source.disposition.clone()}</p>
                                <Show when=move || page.get()!=NetworkPage::Details>
                                    <button class="secondary" type="button" on:click=move |_| {source_id.set(id.get_value());page.set(NetworkPage::Details);}>"View source details"</button>
                                </Show>
                                <Show when=move || page.get()==NetworkPage::Details>
                                <p class="muted">"Configured services do not imply verified capabilities. Route availability is subject to your current routing and privacy choices."</p>
                                <label class="field"><span>"Availability"</span>
                                    <select disabled=move || action.pending().get() prop:value=initial.clone() on:change=move |event| {
                                        action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Disposition { source:id.get_value(), disposition:event_target_value(&event) })));
                                    }>
                                        <option value="enabled">"Enabled"</option><option value="disabled">"Disabled"</option><option value="banned">"Banned"</option>
                                    </select>
                                </label>
                                <h3>"Capabilities and evidence"</h3>
                                {if source.capability_details.is_empty() { "No source-level capability evidence recorded.".to_owned() } else {format!("{} recorded capability claims",source.capability_details.len())}}
                                {source.capability_details.clone().into_iter().map(|claim|view! {<p>{format!("{} · {:?} · {}",claim.name,claim.confidence,claim.discovery)}</p>}).collect_view()}
                                <h3>"Current provider evidence"</h3>
                                <p class="muted">"These are recorded backend claims, not permission to use a route. Your selection, transport policy and route health still apply."</p>
                                {source.registered_capability_details.clone().into_iter().map(|claim|view! {<p>{format!("{} · {:?} · {} · {}",claim.name,claim.confidence,claim.protocol,claim.discovery)}</p>}).collect_view()}
                                <h3>"Configured routes"</h3>
                                {source.protocol_statuses.clone().into_iter().map(|route|view! {<p>{format!("{} · {:?} · {}{}",route.protocol,route.status,route.endpoint.host,route.endpoint.port.map(|p|format!(":{p}")).unwrap_or_default())}</p>}).collect_view()}
                                <button class="secondary" type="button" disabled=move || action.pending().get() on:click=move |_| {if let Some(mut policy)=draft.get_untracked(){policy.preferred.retain(|s|*s!=id.get_value());policy.preferred.insert(0,id.get_value());action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Selection(policy))));}}>"Prefer first within permitted routes"</button>
                                <Show when=move || !source.can_remove><p class="muted">"Maintained catalog entry: you may disable or ban it. Only a maintained catalog update can remove it; your overrides remain separate."</p></Show>
                                <details><summary>"Connection details"</summary>
                                    {source.endpoints.clone().into_iter().map(|endpoint| view! { <p class="mono">{format!("{} {}{}",endpoint.kind,endpoint.host,endpoint.port.map(|p|format!(":{p}")).unwrap_or_default())}</p> }).collect_view()}
                                    {source.failures.clone().into_iter().map(|failure| view! { <p>{failure.error}</p> }).collect_view()}
                                </details>
                                {has_rpc.then(|| view! { <RpcCredentials transport=transport network=network state=state source=id.get_value() /> })}
                                <Show when=move || source.can_remove>
                                    <button class="secondary" type="button" disabled=move || action.pending().get() on:click=move |_| { action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Remove(id.get_value())))); }>"Remove source"</button>
                                </Show>
                                </Show>
                            </article>
                        }
                    } />
                </div>
                </Show>
            </Show>
            <Show when=move || page.get()==NetworkPage::Routing>
            <button class="secondary" type="button" disabled=move || action.pending().get() on:click=move |_| { action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Retry))); }>"Retry permitted connections"</button>
            <p class="muted">"This retries the existing selection only. It does not test every directory entry or expand your boundaries."</p>
            <details><summary>"Legacy connection overrides"</summary><p class="muted">"Compatibility settings for existing installations. These also change the effective source selection."</p>
                <crate::settings::ServerField transport=transport state=state kind=optn_app::ServerKind::Electrum />
                <crate::settings::ServerField transport=transport state=state kind=optn_app::ServerKind::Peer />
            </details>
            </Show>
            <Show when=move || page.get()==NetworkPage::Backup>
                <p class="muted">"Includes this network's sources, bans and selection. Wallet keys and passwords are never included. Confirm external Tor proxies again on a new device."</p>
                <button class="secondary" type="button" disabled=move || exporting.pending().get() || action.pending().get() on:click=move |_| {exporting.dispatch(network.get_untracked());}>"Export settings"</button>
                <label class="field"><span>"Network settings backup"</span><textarea spellcheck="false" prop:value=move || backup.get() on:input=move |event| backup.set(event_target_value(&event)) /></label>
                <button class="secondary" type="button" disabled=move || backup.get().is_empty() on:click=move |_| {let text=backup.get_untracked();let transport=transport.get_value();leptos::task::spawn_local(async move {if let Err(failure)=transport.write_clipboard(text).await {error.try_set(Some(format!("{failure:?}")));}});}>"Copy backup"</button>
                <p class="muted">"Restore replaces the selected network's saved sources and selection. Export your current settings first if you want to keep them."</p>
                <button class="secondary" type="button" disabled=move || action.pending().get() || exporting.pending().get() || backup.get().is_empty() on:click=move |_| {action.dispatch((network.get_untracked(),Some(ChainSourceEdit::Import(backup.get_untracked()))));}>"Restore this network's settings"</button>
            </Show>
            <Show when=move || page.get()==NetworkPage::Add>
                <form on:submit=move |e| {e.prevent_default();page.set(NetworkPage::Services);}>
                    <label class="field"><span>"Name"</span><input required prop:value=move || label.get() on:input=move |e|label.set(event_target_value(&e)) /></label>
                    <label class="field"><span>"Host"</span><input required spellcheck="false" prop:value=move || host.get() on:input=move |e|host.set(event_target_value(&e)) /></label>
                    <p class="muted">{move || if group.get().is_empty() {"Custom source: existing public-source privacy rules apply."} else {"My infrastructure: only add services you control. This permits direct connections to this source."}}</p>
                    <button class="primary" type="submit">"Continue"</button>
                </form>
            </Show>
            <Show when=move || page.get()==NetworkPage::Services>
                <p>{move ||format!("{} · {}",label.get(),host.get())}</p>
                <h3>"Saved services"</h3>
                {move || {let host=host.get().trim().trim_end_matches('.').to_ascii_lowercase();catalog.get().map(|v|v.sources.into_iter().flat_map(|s|s.endpoints).filter(|e|e.host==host).map(|e|view!{<p>{format!("{} · configured · port {}",service_name(&e.kind),e.port.map(|p|p.to_string()).unwrap_or_default())}</p>}).collect_view()).unwrap_or_default()}}

                <p class="muted">"Add a service manually. No services have been detected or assumed. Add additional services on this host to the same source; configure RPC credentials in Source details."</p>
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
            </Show>
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

fn service_name(kind: &str) -> &str {
    match kind {
        "electrum-tls" | "electrum-tcp" => "Electrum / Fulcrum",
        "p2p" => "BCH P2P",
        "node-rpc" => "RPC",
        "node-zmq" => "Notifications",
        _ => kind,
    }
}

fn routing_name(preset: &str) -> &str {
    match preset {
        "auto" => "Automatic",
        "privacy" => "Privacy",
        "own_infrastructure" => "My infrastructure only",
        "electrum_only" => "Electrum only",
        "bip37_only" => "BIP37 only",
        "neutrino_only" => "Compact filters only",
        "custom" => "Custom",
        _ => "Unknown preset",
    }
}
