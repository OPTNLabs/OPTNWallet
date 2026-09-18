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
const UPDATE_HOST: &str = "api.github.com";

/// This build, from the crate version the release workflow also tags with.
fn current_version() -> String {
    format!("v{}", env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
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
        current,
        channel: channel.as_str().to_owned(),
        available,
        releases_url: RELEASES_PAGE.to_owned(),
        unavailable: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::tor::TorStatus;

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
