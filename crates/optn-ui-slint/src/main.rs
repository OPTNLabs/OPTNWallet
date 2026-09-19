use optn_app::Network;
use optn_transport::chain_sources::{
    AddSourceRequest, ChainSourceEdit, WireChainProtocol as Protocol, WireConnectionPolicy,
    WireSourceScope as Scope,
};
use optn_transport_native::{SourceSettings, SourceSettingsSnapshot};
use optn_ui_slint::{NetworkWindow, SourceRow};
use slint::{ComponentHandle, ModelRc, VecModel};
use std::{cell::RefCell, path::PathBuf, rc::Rc};

mod smoke;

struct Host {
    settings: SourceSettings,
    snapshot: SourceSettingsSnapshot,
    selected: String,
    primary: Vec<String>,
    fallback: Vec<String>,
}

fn selected(scope: &Scope) -> Vec<String> {
    match scope {
        Scope::Selected(ids) => ids.clone(),
        _ => Vec::new(),
    }
}
fn scope_index(scope: &Scope) -> i32 {
    match scope {
        Scope::AllEnabled => 0,
        Scope::PublicEnabled => 1,
        Scope::MyInfrastructure => 2,
        Scope::Selected(_) => 3,
    }
}
fn scope(index: i32, ids: &[String]) -> Scope {
    match index {
        0 => Scope::AllEnabled,
        1 => Scope::PublicEnabled,
        2 => Scope::MyInfrastructure,
        _ => Scope::Selected(ids.to_vec()),
    }
}
impl Host {
    fn render(&mut self, ui: &NetworkWindow) {
        let policy = &self.snapshot.selection;
        self.primary = selected(&policy.primary_scope);
        self.fallback = policy
            .fallback_scope
            .as_ref()
            .map(selected)
            .unwrap_or_default();
        ui.set_network(self.snapshot.network.to_uppercase().into());
        let (title, preset_index) = match self.snapshot.preset.as_str() {
            "auto" => ("Automatic", 0),
            "own_infrastructure" => ("Only my infrastructure", 1),
            _ => ("Custom", 2),
        };
        ui.set_routing(title.into());
        ui.set_preset_index(preset_index);
        let scope_title = |scope: &Scope| match scope {
            Scope::AllEnabled => "All enabled".to_owned(),
            Scope::PublicEnabled => "Public enabled".to_owned(),
            Scope::MyInfrastructure => "My infrastructure".to_owned(),
            Scope::Selected(ids) => format!("{} selected", ids.len()),
        };
        ui.set_selection_summary(
            format!(
                "Primary · {}\nFallback · {}",
                scope_title(&policy.primary_scope),
                policy
                    .fallback_scope
                    .as_ref()
                    .map(scope_title)
                    .unwrap_or_else(|| "None".into())
            )
            .into(),
        );
        let preferred = policy
            .preferred
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let label = self
                    .snapshot
                    .sources
                    .iter()
                    .find(|s| &s.id == id)
                    .map(|s| s.label.as_str())
                    .unwrap_or(id);
                format!("{}. {label}", index + 1)
            })
            .collect::<Vec<_>>()
            .join("\n");
        ui.set_preference_summary(if preferred.is_empty() {
            "No preference".into()
        } else {
            preferred.into()
        });
        ui.set_primary_scope(scope_index(&policy.primary_scope));
        ui.set_fallback_scope(
            policy
                .fallback_scope
                .as_ref()
                .map(|s| scope_index(s) + 1)
                .unwrap_or(0),
        );
        ui.set_electrum(policy.protocols.contains(&Protocol::FulcrumElectrum));
        ui.set_bip37(policy.protocols.contains(&Protocol::Bip37));
        ui.set_filters(policy.protocols.contains(&Protocol::Neutrino));
        ui.set_rpc(policy.protocols.contains(&Protocol::BchnRpc));
        ui.set_notifications(policy.protocols.contains(&Protocol::BchnZmq));
        self.rows(ui);
        self.details(ui);
    }
    fn rows(&self, ui: &NetworkWindow) {
        ui.set_sources(ModelRc::new(VecModel::from(
            self.snapshot
                .sources
                .iter()
                .map(|s| SourceRow {
                    id: s.id.clone().into(),
                    label: s.label.clone().into(),
                    summary: format!(
                        "{} · {} catalog capabilities · not contacted",
                        s.disposition,
                        s.capability_details.len()
                    )
                    .into(),
                    origin: match s.origin.as_str() {
                        "bootstrap" => 1,
                        "own-infrastructure" => 2,
                        _ => 3,
                    },
                    primary: self.primary.contains(&s.id),
                    fallback: self.fallback.contains(&s.id),
                })
                .collect::<Vec<_>>(),
        )));
    }
    fn details(&self, ui: &NetworkWindow) {
        if let Some(s) = self.snapshot.sources.iter().find(|s| s.id == self.selected) {
            ui.set_detail_title(s.label.clone().into());
            ui.set_removable(s.can_remove);
            ui.set_preferred(self.snapshot.selection.preferred.contains(&s.id));
            let mut text = format!(
                "{} · {}\nNo current connection claim.\n\nServices\n",
                s.origin, s.disposition
            );
            for e in &s.endpoints {
                text.push_str(&format!(
                    "{} · {}{}\n",
                    e.kind,
                    e.host,
                    e.port.map(|p| format!(":{p}")).unwrap_or_default()
                ));
            }
            text.push_str("\nCatalog capabilities (not live evidence)\n");
            for c in &s.capability_details {
                text.push_str(&format!(
                    "{} · {:?}\n{}\n",
                    c.name, c.confidence, c.discovery
                ));
            }
            ui.set_detail_text(text.into());
        } else {
            ui.set_removable(false);
        }
    }
    fn edit(&mut self, ui: &NetworkWindow, edit: ChainSourceEdit) {
        match self.settings.edit(edit) {
            Ok(snapshot) => {
                self.snapshot = snapshot;
                self.render(ui);
                ui.set_status(
                    "Saved to the selected network configuration. No connections made.".into(),
                );
            }
            Err(error) => ui.set_status(format!("Not saved: {error}").into()),
        }
    }
    fn policy(&self, ui: &NetworkWindow) -> WireConnectionPolicy {
        let protocols = [
            (ui.get_electrum(), Protocol::FulcrumElectrum),
            (ui.get_bip37(), Protocol::Bip37),
            (ui.get_filters(), Protocol::Neutrino),
            (ui.get_rpc(), Protocol::BchnRpc),
            (ui.get_notifications(), Protocol::BchnZmq),
        ]
        .into_iter()
        .filter_map(|(enabled, protocol)| enabled.then_some(protocol))
        .collect();
        WireConnectionPolicy {
            protocols,
            primary_scope: scope(ui.get_primary_scope(), &self.primary),
            fallback_scope: (ui.get_fallback_scope() != 0)
                .then(|| scope(ui.get_fallback_scope() - 1, &self.fallback)),
            preferred: self.snapshot.selection.preferred.clone(),
        }
    }
}

fn connect(ui: &NetworkWindow, settings: SourceSettings) -> Result<Rc<RefCell<Host>>, String> {
    let snapshot = settings.read()?;
    let host = Rc::new(RefCell::new(Host {
        settings,
        snapshot,
        selected: String::new(),
        primary: Vec::new(),
        fallback: Vec::new(),
    }));
    host.borrow_mut().render(ui);
    ui.set_status("Native pilot · catalog settings only · no wallet session".into());
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_navigate(move |page| {
        let Some(ui) = weak.upgrade() else { return };
        if page == 7
            && (ui.get_source_name().trim().is_empty() || ui.get_source_host().trim().is_empty())
        {
            ui.set_status("Enter a name and host before continuing.".into());
            return;
        }
        state.borrow_mut().render(&ui);
        ui.set_status("Catalog settings only · no sources contacted".into());
        ui.set_page(page);
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_open_source(move |id| {
        if let Some(ui) = weak.upgrade() {
            let mut h = state.borrow_mut();
            h.selected = id.to_string();
            h.details(&ui);
            ui.set_page(4);
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_disposition(move |disposition| {
        if let Some(ui) = weak.upgrade() {
            let mut h = state.borrow_mut();
            let source = h.selected.clone();
            h.edit(
                &ui,
                ChainSourceEdit::Disposition {
                    source,
                    disposition: disposition.to_string(),
                },
            );
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_remove_source(move || {
        if let Some(ui) = weak.upgrade() {
            let mut h = state.borrow_mut();
            let id = h.selected.clone();
            h.edit(&ui, ChainSourceEdit::Remove(id.clone()));
            if !h.snapshot.sources.iter().any(|s| s.id == id) {
                ui.set_page(0);
            }
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_pin_source(move || {
        if let Some(ui) = weak.upgrade() {
            let mut h = state.borrow_mut();
            let mut p = h.snapshot.selection.clone();
            p.primary_scope = Scope::Selected(vec![h.selected.clone()]);
            p.fallback_scope = None;
            h.edit(&ui, ChainSourceEdit::Selection(p));
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_prefer_source(move || {
        if let Some(ui) = weak.upgrade() {
            let mut h = state.borrow_mut();
            let mut p = h.snapshot.selection.clone();
            if p.preferred.contains(&h.selected) {
                p.preferred.retain(|id| id != &h.selected);
            } else {
                p.preferred.insert(0, h.selected.clone());
            }
            h.edit(&ui, ChainSourceEdit::Selection(p));
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_preset(move |preset| {
        if let Some(ui) = weak.upgrade() {
            state
                .borrow_mut()
                .edit(&ui, ChainSourceEdit::Policy(preset.to_string()));
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_select_source(move |id, fallback, enabled| {
        if let Some(ui) = weak.upgrade() {
            let mut h = state.borrow_mut();
            let ids = if fallback {
                &mut h.fallback
            } else {
                &mut h.primary
            };
            ids.retain(|v| v != id.as_str());
            if enabled {
                ids.push(id.to_string());
            }
            h.rows(&ui);
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_save_routing(move || {
        if let Some(ui) = weak.upgrade() {
            let mut h = state.borrow_mut();
            let policy = h.policy(&ui);
            h.edit(&ui, ChainSourceEdit::Selection(policy));
        }
    });
    let weak = ui.as_weak();
    let state = host.clone();
    ui.on_add_source(move || {
        if let Some(ui) = weak.upgrade() {
            let Ok(port) = ui.get_source_port().parse::<u16>() else {
                ui.set_status("Enter a valid port from 1 to 65535.".into());
                return;
            };
            if port == 0 {
                ui.set_status("Port zero is not a service port.".into());
                return;
            }
            let kinds = ["electrum-tls", "p2p", "node-rpc", "node-zmq"];
            let Some(kind) = kinds.get(ui.get_service() as usize) else {
                return;
            };
            let mut h = state.borrow_mut();
            let network = h.snapshot.network.clone();
            h.edit(
                &ui,
                ChainSourceEdit::Add(AddSourceRequest {
                    services: Vec::new(),
                    network: Some(network),
                    label: ui.get_source_name().to_string(),
                    host: ui.get_source_host().to_string(),
                    kind: (*kind).into(),
                    port: Some(port),
                    infrastructure_group: ui.get_own().then(|| "My infrastructure".into()),
                }),
            );
        }
    });
    Ok(host)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if !matches!(args.len(), 4 | 6)
        || args[0] != "--network"
        || args[2] != "--config"
        || (args.len() == 6 && args[4] != "--smoke-dir")
    {
        return Err("Usage: optn-slint-pilot --network chipnet --config <network-chipnet.json>\nUse a disposable path to evaluate the pilot. No default wallet storage is opened.".into());
    }
    let network: Network = args[1].parse().map_err(|_| "Unknown network")?;
    let path = PathBuf::from(&args[3]);
    if args.len() == 6 && (network != Network::Chipnet || path.exists()) {
        return Err("Smoke check requires Chipnet and a NEW disposable config path.".into());
    }
    let settings = SourceSettings::new(network, path);
    let ui = NetworkWindow::new()?;
    let host = connect(&ui, settings)?;
    if args.len() == 6 {
        smoke::run(&ui, host, PathBuf::from(&args[5]))?;
    } else {
        ui.run()?;
    }
    Ok(())
}
