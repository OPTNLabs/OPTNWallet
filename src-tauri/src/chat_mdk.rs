// Marmot chat through MDK (crates/optn-chat), beside the renderer's ts-mls
// engine, which keeps every group it made. Built only with the `mdk-chat`
// feature: MDK's encrypted store is SQLCipher, whose crypto off Apple
// platforms is OpenSSL built from source (a full Perl on Windows). Without the
// feature these commands answer that the engine is not in this build, and the
// chat stays on ts-mls.
//
// One chat identity at a time, owned by the page that opened it: its events go
// to that page alone, and it closes when the page reloads or its window goes,
// like the renderer's relay sockets.

use serde_json::Value;

/// Whether this build carries the MDK engine.
#[tauri::command]
pub fn chat_mdk_available() -> bool {
    cfg!(feature = "mdk-chat")
}

#[cfg(not(feature = "mdk-chat"))]
fn not_built() -> String {
    "this build of the wallet has no MDK chat engine (built without the mdk-chat feature)".into()
}

/// Open the MDK store of the chat identity whose Nostr secret key is
/// `identity` (hex), reach `relays` under the holder's egress, publish a key
/// package if the last one is a week old, and start reading. Its events
/// arrive at the calling page as `chat-mdk://event`.
#[tauri::command]
pub async fn chat_mdk_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    identity: String,
    relays: Vec<String>,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, crate::network_config::NetworkSettingsStore>,
) -> Result<Value, String> {
    #[cfg(feature = "mdk-chat")]
    {
        let networks = crate::egress::networks_for(runtime.state().network, None);
        enabled::open(
            app,
            webview.label().to_owned(),
            identity,
            relays,
            network_settings.inner().clone(),
            networks,
        )
        .await
    }
    #[cfg(not(feature = "mdk-chat"))]
    {
        let _ = (app, webview, identity, relays, runtime, network_settings);
        Err(not_built())
    }
}

/// Close the open chat identity, if the calling page owns it.
#[tauri::command]
pub async fn chat_mdk_close(webview: tauri::Webview) -> Result<(), String> {
    close_owned_by(webview.label()).await;
    Ok(())
}

/// Close the chat identity a page owns: on reload and when its window goes.
pub async fn close_owned_by(owner: &str) {
    #[cfg(feature = "mdk-chat")]
    enabled::close_owned_by(owner).await;
    #[cfg(not(feature = "mdk-chat"))]
    let _ = owner;
}

/// One call on the open identity: `op` and its arguments.
///
/// - `groups` -> every group
/// - `messages { group, limit }` -> a group's newest messages, oldest first
/// - `createGroup { name, members, relays }` -> the new group
/// - `addMembers { group, members }`, `removeMembers { group, members }`,
///   `rename { group, name }` -> the changed group
/// - `leave { group }`, `forget { group }` -> nothing
/// - `send { group, kind, content, tags }` -> the message as sent
/// - `catchUp` -> how many events were read (they also arrive as events)
/// - `publishKeyPackage` -> the relays that took a fresh key package
#[tauri::command]
pub async fn chat_mdk_call(
    webview: tauri::Webview,
    op: String,
    args: Option<Value>,
) -> Result<Value, String> {
    #[cfg(feature = "mdk-chat")]
    {
        enabled::call(webview.label(), &op, args.unwrap_or(Value::Null)).await
    }
    #[cfg(not(feature = "mdk-chat"))]
    {
        let _ = (webview, op, args);
        Err(not_built())
    }
}

#[cfg(feature = "mdk-chat")]
mod enabled {
    use std::sync::Arc;
    use std::time::Duration;

    use futures_util::StreamExt;
    use optn_chat::{ChatConfig, ChatEngine, MdkSqliteStorage};
    use optn_core::network::Network;
    use optn_nostr::nostr::prelude::Keys;
    use optn_nostr::{Dialed, RelayDialer, RelayEndpoint, RelayIo, RelayRoute, Relays};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use tauri::{AppHandle, Emitter, EventTarget, Manager};
    use tokio::sync::Mutex;

    use crate::network_config::NetworkSettingsStore;

    /// How long one relay operation waits: long enough for a Tor circuit.
    const RELAY_TIMEOUT: Duration = Duration::from_secs(30);

    struct Session {
        engine: ChatEngine<MdkSqliteStorage>,
        owner: String,
        forwarder: tokio::task::AbortHandle,
    }

    static SESSION: Mutex<Option<Session>> = Mutex::const_new(None);

    /// Relays reached the way every other relay socket is: the holder's Tor
    /// switch, their own hosts, public addresses only for anyone else's, and
    /// plain `ws` only on this machine.
    struct EgressDialer {
        settings: NetworkSettingsStore,
        networks: Vec<Network>,
    }

    impl RelayDialer for EgressDialer {
        fn dial(&self, endpoint: RelayEndpoint) -> Dialed {
            let settings = self.settings.clone();
            let networks = self.networks.clone();
            Box::pin(async move {
                if !endpoint.tls && !optn_core::endpoint::is_loopback_host(&endpoint.host) {
                    return Err(format!(
                        "{} is a plain ws relay; only wss relays are reached off this machine",
                        endpoint.host
                    ));
                }
                let decision = crate::egress::decide(&endpoint.host, &settings, &networks).await?;
                let stream = crate::egress::open_stream(
                    &endpoint.host,
                    endpoint.port,
                    endpoint.tls,
                    decision.route,
                    !decision.own,
                )
                .await?;
                Ok(Box::new(stream) as Box<dyn RelayIo>)
            })
        }
    }

    pub(super) async fn open(
        app: AppHandle,
        owner: String,
        identity: String,
        relays: Vec<String>,
        settings: NetworkSettingsStore,
        networks: Vec<Network>,
    ) -> Result<Value, String> {
        let keys = Keys::parse(identity.trim())
            .map_err(|_| "the chat identity is not a Nostr secret key".to_string())?;
        drop(identity);
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("chat-mdk");

        let mut session = SESSION.lock().await;
        if let Some(previous) = session.take() {
            previous.forwarder.abort();
            previous.engine.shutdown().await;
        }

        let route = RelayRoute::Dialer(Arc::new(EgressDialer { settings, networks }));
        let connected = Relays::connect(&relays, route, RELAY_TIMEOUT)
            .await
            .map_err(|error| error.to_string())?;
        let engine = ChatEngine::open(
            &dir,
            keys,
            connected,
            ChatConfig {
                relays,
                timeout: RELAY_TIMEOUT,
            },
        )
        .await
        .map_err(|error| error.to_string())?;

        let events = engine.events();
        let target = EventTarget::webview(owner.clone());
        let emitter = app.clone();
        let forwarder = tokio::spawn(async move {
            let mut events = std::pin::pin!(events);
            while let Some(event) = events.next().await {
                if emitter
                    .emit_to(target.clone(), "chat-mdk://event", &event)
                    .is_err()
                {
                    break;
                }
            }
        })
        .abort_handle();

        engine.listen().await.map_err(|error| error.to_string())?;
        // A relay that refuses the key package now is tried again next open;
        // reading needs none.
        let _ = engine.ensure_key_package().await;
        let groups = engine.groups().await.map_err(|error| error.to_string())?;
        let public_key = engine.public_key();
        *session = Some(Session {
            engine: engine.clone(),
            owner,
            forwarder,
        });
        drop(session);

        // Catching up can take a while over Tor; what it reads arrives as
        // events.
        tokio::spawn(async move {
            let _ = engine.catch_up().await;
        });
        Ok(json!({ "publicKey": public_key, "groups": groups }))
    }

    pub(super) async fn close_owned_by(owner: &str) {
        let mut session = SESSION.lock().await;
        if session.as_ref().is_some_and(|open| open.owner == owner) {
            if let Some(closing) = session.take() {
                closing.forwarder.abort();
                closing.engine.shutdown().await;
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group: Option<String>,
        limit: Option<usize>,
        name: Option<String>,
        members: Option<Vec<String>>,
        relays: Option<Vec<String>>,
        kind: Option<u16>,
        content: Option<String>,
        tags: Option<Vec<Vec<String>>>,
    }

    fn need<T>(value: Option<T>, name: &str) -> Result<T, String> {
        value.ok_or_else(|| format!("missing argument {name}"))
    }

    fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
        serde_json::to_value(value).map_err(|error| error.to_string())
    }

    pub(super) async fn call(owner: &str, op: &str, args: Value) -> Result<Value, String> {
        let engine = {
            let session = SESSION.lock().await;
            match session.as_ref() {
                Some(open) if open.owner == owner => open.engine.clone(),
                _ => return Err("no chat identity is open in this window".into()),
            }
        };
        let args: Args = if args.is_null() {
            Args {
                group: None,
                limit: None,
                name: None,
                members: None,
                relays: None,
                kind: None,
                content: None,
                tags: None,
            }
        } else {
            serde_json::from_value(args).map_err(|error| error.to_string())?
        };
        let failed = |error: optn_chat::ChatError| error.to_string();
        match op {
            "groups" => to_value(engine.groups().await.map_err(failed)?),
            "messages" => to_value(
                engine
                    .messages(&need(args.group, "group")?, args.limit.unwrap_or(200))
                    .await
                    .map_err(failed)?,
            ),
            "createGroup" => to_value(
                engine
                    .create_group(
                        &need(args.name, "name")?,
                        &args.members.unwrap_or_default(),
                        &args.relays.unwrap_or_default(),
                    )
                    .await
                    .map_err(failed)?,
            ),
            "addMembers" => to_value(
                engine
                    .add_members(&need(args.group, "group")?, &need(args.members, "members")?)
                    .await
                    .map_err(failed)?,
            ),
            "removeMembers" => to_value(
                engine
                    .remove_members(&need(args.group, "group")?, &need(args.members, "members")?)
                    .await
                    .map_err(failed)?,
            ),
            "rename" => to_value(
                engine
                    .rename(&need(args.group, "group")?, &need(args.name, "name")?)
                    .await
                    .map_err(failed)?,
            ),
            "leave" => {
                engine
                    .leave(&need(args.group, "group")?)
                    .await
                    .map_err(failed)?;
                Ok(Value::Null)
            }
            "forget" => {
                engine
                    .forget(&need(args.group, "group")?)
                    .await
                    .map_err(failed)?;
                Ok(Value::Null)
            }
            "send" => to_value(
                engine
                    .send(
                        &need(args.group, "group")?,
                        need(args.kind, "kind")?,
                        &need(args.content, "content")?,
                        &args.tags.unwrap_or_default(),
                    )
                    .await
                    .map_err(failed)?,
            ),
            "catchUp" => to_value(engine.catch_up().await.map_err(failed)?.len()),
            "publishKeyPackage" => {
                to_value(engine.publish_key_package().await.map_err(failed)?.accepted)
            }
            other => Err(format!("unknown chat operation {other}")),
        }
    }
}
