//! Telling a desktop holder that a newer build exists.
//!
//! Deliberately a *check*, not an installer. Installing an update means
//! executing code fetched from the network, and the only thing that makes that
//! safe is a signature the application can verify against a key it shipped
//! with. This repository has no such key and no signed update manifest, so an
//! auto-installer here would be a way to run arbitrary code on every holder's
//! machine the moment anything upstream was compromised. Until an update
//! signing key exists, this reports what is available and opens the release
//! page; the holder installs deliberately.
//!
//! Which releases are *offered* is decided in `optn_core::release_channel`,
//! from the tag the release workflow published. Stable only by default; beta
//! and alpha are separate opt-ins, and both are off until asked for.
//!
//! The check is an outbound request to a third party, so it goes through the
//! same route decision every other remote connection does. A holder whose
//! policy forbids public connections is told the check is unavailable and why,
//! rather than having one quietly made in the clear on their behalf.

use optn_core::release_channel::{newest_offer, ReleaseChannel};
use optn_core::tor::{outbound_route, Route as TorRoute};
use serde::Serialize;
use std::time::Duration;

/// Where releases are published. A constant, not a setting: a configurable
/// update source is a configurable place to be told to install something.
const RELEASES_API: &str = "https://api.github.com/repos/OPTNLabs/OPTNWallet/releases";
const RELEASES_PAGE: &str = "https://github.com/OPTNLabs/OPTNWallet/releases";

/// This build, from the crate version the release workflow also tags with.
fn current_version() -> String {
    format!("v{}", env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
    /// Whether this build can verify an update's signature, and therefore
    /// whether it may install one.
    ///
    /// False when no public key is configured. The check still works and still
    /// links to the release page; what is withheld is the install button,
    /// because installing what cannot be verified is the whole danger.
    pub verified_install: bool,
    /// The running build, as a tag.
    pub current: String,
    /// `stable` | `beta` | `alpha`.
    pub channel: String,
    /// The newer release to offer, if there is one.
    pub available: Option<String>,
    /// Where to get it. Always present, so "you are up to date" still offers a
    /// way to look.
    pub releases_url: String,
    /// Why no check was made, when none was.
    pub unavailable: Option<String>,
}

impl UpdateCheck {
    fn unavailable(channel: ReleaseChannel, reason: String) -> Self {
        Self {
            verified_install: false,
            current: current_version(),
            channel: channel.as_str().to_owned(),
            available: None,
            releases_url: RELEASES_PAGE.to_owned(),
            unavailable: Some(reason),
        }
    }
}

/// Tags of every published release, newest first as GitHub returns them.
async fn published_tags(route: TorRoute) -> Result<Vec<String>, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        // The API requires one, and an honest one is better than a browser's.
        .user_agent(concat!("OPTNWallet/", env!("CARGO_PKG_VERSION")));
    if let TorRoute::Through { socks_port } = route {
        let proxy = reqwest::Proxy::all(format!("socks5h://127.0.0.1:{socks_port}"))
            .map_err(|error| format!("could not use the Tor proxy: {error}"))?;
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|error| error.to_string())?;

    let response = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("could not reach the release list: {error}"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("the release list answered HTTP {status}"));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("the release list was not readable: {error}"))?;
    let releases = body
        .as_array()
        .ok_or_else(|| "the release list was not a list".to_string())?;
    Ok(releases
        .iter()
        .filter_map(|release| {
            // A draft is not published to anyone; offering one would point at
            // a page most holders cannot open.
            if release.get("draft").and_then(serde_json::Value::as_bool) == Some(true) {
                return None;
            }
            release
                .get("tag_name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect())
}

/// Look for a newer build on the holder's chosen channel.
///
/// `beta` and `alpha` are the two opt-ins; both false is stable only.
#[tauri::command]
pub async fn optn_check_for_update(
    app: tauri::AppHandle,
    native: tauri::State<'_, std::sync::Arc<crate::chain_runtime::NativeChainRuntime>>,
    beta: bool,
    alpha: bool,
) -> Result<UpdateCheck, String> {
    let channel = ReleaseChannel::from_opt_ins(beta, alpha);

    // Tor whenever it is usable; without it, whether this may go direct is the
    // holder's connection policy, not a guess from the shape of their sources.
    let (public_allowed, tor) = native.tor_status_for_update_check().await;
    let route = outbound_route(public_allowed, tor);
    if route.is_refused() {
        return Ok(UpdateCheck::unavailable(
            channel,
            format!(
                "This wallet is set not to make public connections, and no Tor is \
                 available to make this one through. Start Tor in Settings, or open \
                 {RELEASES_PAGE} yourself."
            ),
        ));
    }

    let tags = match published_tags(route).await {
        Ok(tags) => tags,
        Err(reason) => return Ok(UpdateCheck::unavailable(channel, reason)),
    };

    let current = current_version();
    let available = newest_offer(&current, channel, tags.iter().map(String::as_str));
    Ok(UpdateCheck {
        verified_install: signature_checking_configured(&app),
        current,
        channel: channel.as_str().to_owned(),
        available,
        releases_url: RELEASES_PAGE.to_owned(),
        unavailable: None,
    })
}

/// Can this build verify an update before running it?
///
/// True only when a public key is configured, which is what
/// `tauri-plugin-updater` checks a downloaded artifact's detached signature
/// against. With no key the plugin errors, and that error is the correct
/// answer: there is no such thing as an unverified install here, only no
/// install.
pub(crate) fn has_update_key(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty() && key != "REPLACE_WITH_TAURI_SIGNING_PUBLIC_KEY")
}

fn signature_checking_configured(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_updater::UpdaterExt;
    has_update_key(app.config()) && app.updater_builder().build().is_ok()
}

/// Download and install the update, verifying its signature first.
///
/// Every byte is checked against the public key compiled into this build
/// before anything is run. A missing or wrong signature fails here, which is
/// the only reason this command is allowed to exist at all -- the check-only
/// path stays for builds that have no key.
/// Download and install, verifying the signature first.
#[tauri::command]
pub async fn optn_install_update(
    app: tauri::AppHandle,
    native: tauri::State<'_, std::sync::Arc<crate::chain_runtime::NativeChainRuntime>>,
) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    if !has_update_key(app.config()) {
        return Err(
            "This build has no update verification key; installation is unavailable.".into(),
        );
    }
    let (public_allowed, tor) = native.tor_status_for_update_check().await;
    let builder = app.updater_builder();
    let builder = match outbound_route(public_allowed, tor) {
        TorRoute::Direct => builder.no_proxy(),
        TorRoute::Through { socks_port } => builder.proxy(
            format!("socks5h://127.0.0.1:{socks_port}")
                .parse()
                .map_err(|_| "Invalid verified update proxy.".to_string())?,
        ),
        _ => {
            return Err(
                "Update installation is unavailable under the current network policy.".into(),
            )
        }
    };
    let updater = builder.build().map_err(|error| {
        format!(
            "This build cannot verify updates ({error}). Install from {RELEASES_PAGE} instead."
        )
    })?;

    let update = updater
        .check()
        .await
        .map_err(|error| format!("could not check for an update: {error}"))?
        .ok_or_else(|| "no update is available".to_string())?;

    let version = update.version.clone();
    // The plugin verifies the detached signature against the configured public
    // key as it downloads; a failure here is a refusal, never a warning.
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("the update did not verify and was not installed: {error}"))?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::tor::TorStatus;

    #[test]
    fn unsigned_previews_do_not_initialize_an_installer() {
        let mut config = tauri::Config::default();
        assert!(!has_update_key(&config));
        for value in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"pubkey":""}),
            serde_json::json!({"pubkey":"REPLACE_WITH_TAURI_SIGNING_PUBLIC_KEY"}),
        ] {
            config.plugins.0.insert("updater".into(), value);
            assert!(!has_update_key(&config));
        }
        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey":"configured-public-key"}),
        );
        assert!(has_update_key(&config)); // The plugin still verifies signatures before installing.
    }

    #[test]
    fn the_running_version_is_a_tag_the_parser_accepts() {
        // If these two ever disagree, every check silently reports "no update"
        // because the running version cannot be parsed to compare against.
        let current = current_version();
        assert!(
            optn_core::release_channel::ReleaseTag::parse(&current).is_some(),
            "current_version() produced {current}, which release_channel cannot parse"
        );
    }

    #[test]
    fn a_private_policy_reports_rather_than_connecting() {
        // Asserted on the shared rule rather than restated here.
        assert!(outbound_route(false, TorStatus::Absent).is_refused());
        assert!(outbound_route(false, TorStatus::Unverified { socks_port: 9050 }).is_refused());
        assert_eq!(
            outbound_route(false, TorStatus::Verified { socks_port: 9050 }),
            TorRoute::Through { socks_port: 9050 }
        );
        // And a holder who permits public connections is not blocked from
        // learning that a security fix exists.
        assert_eq!(outbound_route(true, TorStatus::Absent), TorRoute::Direct);
    }

    #[test]
    fn the_update_source_is_not_configurable() {
        // A settable update URL is a settable place to be told to install
        // something. Pinned here so a "make it configurable" change has to
        // delete an assertion that says why not.
        assert!(RELEASES_API.starts_with("https://api.github.com/repos/OPTNLabs/"));
        assert!(RELEASES_PAGE.starts_with("https://github.com/OPTNLabs/"));
    }
}
