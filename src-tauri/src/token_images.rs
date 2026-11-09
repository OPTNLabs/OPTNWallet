//! Token images for the desktop renderer, fetched under the wallet's
//! metadata transport.
//!
//! A verified registry names its images as URIs. Loading one in the webview
//! would contact that host directly, outside the transport the wallet applies
//! to everything else, and would tell it that this address holds the token. So
//! the renderer asks here instead. It names a category the open wallet has a
//! verified (or last-known) identity for, and one image URI from that
//! identity's authenticated presentation; the host fetches the bytes through
//! the same metadata transport as registry bytes. What comes back is a bounded
//! image of a recognised type, as a `data:` URL, or nothing.
//!
//! The renderer cannot use this as a general fetcher: a URI that is not in the
//! hash-verified registry for that category is refused before any I/O.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use optn_app::{IdentityStatus, TokenPresentation};
use optn_runtime::token_metadata::FetchLimits;

use crate::chain_runtime::NativeChainRuntime;

/// An icon, not an artwork archive.
const MAX_IMAGE_BYTES: usize = 512 * 1024;
const IMAGE_DEADLINE: Duration = Duration::from_secs(15);
/// Encoded images kept for reuse across screens. Bounded by bytes, not count.
const MAX_CACHED_BYTES: usize = 8 * 1024 * 1024;

/// Every image URI a verified presentation names: the category's own `icon`
/// and `image`, and the same for each NFT type.
pub(crate) fn image_uris(presentation: &TokenPresentation) -> impl Iterator<Item = &str> {
    const IMAGE_KEYS: [&str; 2] = ["icon", "image"];
    let types = presentation
        .nfts
        .iter()
        .flat_map(|nfts| nfts.parse.types.values())
        .flat_map(|nft| nft.uris.iter().flatten());
    presentation
        .uris
        .iter()
        .chain(types)
        .filter(|(key, _)| IMAGE_KEYS.contains(&key.as_str()))
        .map(|(_, uri)| uri.as_str())
}

/// The media type of `bytes`, judged from their content rather than from what
/// a server claimed. Anything unrecognised is not an image here.
pub(crate) fn image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // An SVG drawn by an <img> element runs no script and loads nothing, so it
    // is as inert as a raster here. Recognise it only as a document whose
    // first element is <svg>, after an optional BOM, XML declaration, comments
    // and doctype.
    let text = std::str::from_utf8(bytes).ok()?;
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("<?xml") {
            rest = after.split_once("?>")?.1.trim_start();
        } else if let Some(after) = rest.strip_prefix("<!--") {
            rest = after.split_once("-->")?.1.trim_start();
        } else if let Some(after) = rest.strip_prefix("<!DOCTYPE") {
            rest = after.split_once('>')?.1.trim_start();
        } else {
            break;
        }
    }
    rest.strip_prefix("<svg")
        .filter(|after| after.starts_with(|c: char| c.is_whitespace() || c == '>'))
        .map(|_| "image/svg+xml")
}

/// Standard base64 with padding, for a `data:` URL.
pub(crate) fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (index, byte)| {
            n | u32::from(*byte) << (16 - 8 * index)
        });
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(char::from(
                    ALPHABET[(n >> (18 - 6 * index) & 0x3f) as usize],
                ));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[derive(Default)]
struct ImageCache {
    entries: BTreeMap<(String, String, String), Arc<String>>,
    bytes: usize,
}

impl ImageCache {
    fn get(&self, key: &(String, String, String)) -> Option<Arc<String>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: (String, String, String), value: Arc<String>) {
        if value.len() > MAX_CACHED_BYTES {
            return;
        }
        while self.bytes + value.len() > MAX_CACHED_BYTES {
            let Some(oldest) = self.entries.keys().next().cloned() else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&oldest) {
                self.bytes -= evicted.len();
            }
        }
        self.bytes += value.len();
        if let Some(replaced) = self.entries.insert(key, value) {
            self.bytes -= replaced.len();
        }
    }
}

fn cache() -> &'static Mutex<ImageCache> {
    static CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// A token image as a `data:` URL, or `None` when there is nothing to show:
/// no verified identity for the category, no usable metadata transport, a
/// failed fetch, or bytes that are not a bounded image.
#[tauri::command]
pub async fn optn_token_image(
    runtime: tauri::State<'_, Arc<NativeChainRuntime>>,
    category: String,
    uri: String,
) -> Result<Option<String>, String> {
    let state = runtime.owner.state();
    let network = state.network.to_string();
    let Some(identity) = state.token_identities.get(&category) else {
        return Ok(None);
    };
    if !matches!(
        identity.status,
        IdentityStatus::Verified | IdentityStatus::Stale
    ) {
        return Ok(None);
    }
    let presentation = identity.authenticated_presentation();
    if !image_uris(&presentation).any(|candidate| candidate == uri) {
        return Err("not an image from this token's verified registry".into());
    }
    let key = (network, category, uri);
    if let Some(hit) = cache()
        .lock()
        .map_err(|_| "image cache poisoned")?
        .get(&key)
    {
        return Ok(Some((*hit).clone()));
    }
    // The installed stack's transport, or nothing: an image is never worth
    // a route the wallet's own policy would not take.
    let Some(service) = runtime.with_service(Arc::clone).await else {
        return Ok(None);
    };
    let Some(fetcher) = service.lock().await.registry_fetcher() else {
        return Ok(None);
    };
    let Ok(bytes) = fetcher
        .fetch(
            &key.2,
            FetchLimits {
                max_bytes: MAX_IMAGE_BYTES,
                deadline: IMAGE_DEADLINE,
                ..FetchLimits::default()
            },
        )
        .await
    else {
        return Ok(None);
    };
    if bytes.len() > MAX_IMAGE_BYTES {
        return Ok(None);
    }
    let Some(media_type) = image_media_type(&bytes) else {
        return Ok(None);
    };
    let url = Arc::new(format!("data:{media_type};base64,{}", base64(&bytes)));
    cache()
        .lock()
        .map_err(|_| "image cache poisoned")?
        .insert(key, Arc::clone(&url));
    Ok(Some((*url).clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_type_comes_from_content_not_from_claims() {
        assert_eq!(
            image_media_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            image_media_type(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(image_media_type(b"GIF89a...."), Some("image/gif"));
        assert_eq!(
            image_media_type(b"RIFF\0\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        for svg in [
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            "\u{feff}<?xml version=\"1.0\"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg>",
        ] {
            assert_eq!(image_media_type(svg.as_bytes()), Some("image/svg+xml"));
        }
        for not_image in [
            &b"<html><svg></svg></html>"[..],
            b"<svgish>",
            b"{\"name\":\"not an image\"}",
            b"",
            b"RIFF\0\0\0\0WAVE",
        ] {
            assert_eq!(image_media_type(not_image), None);
        }
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
    }

    #[test]
    fn only_image_uris_from_the_presentation_are_offered() {
        let presentation: TokenPresentation = serde_json::from_value(serde_json::json!({
            "description": "Tickets",
            "uris": {"icon": "ipfs://bafy/icon.png", "web": "https://example.test/"},
            "nfts": {"parse": {"types": {
                "01": {"name": "Seat", "uris": {"image": "https://example.test/seat.png", "web": "https://example.test/seat"}},
                "02": {"name": "Plain"}
            }}}
        }))
        .unwrap();
        let mut uris: Vec<_> = image_uris(&presentation).collect();
        uris.sort_unstable();
        assert_eq!(
            uris,
            ["https://example.test/seat.png", "ipfs://bafy/icon.png"]
        );
    }

    #[test]
    fn the_cache_is_bounded_by_bytes() {
        let mut cache = ImageCache::default();
        let big = Arc::new("x".repeat(MAX_CACHED_BYTES / 2 + 1));
        cache.insert(("n".into(), "a".into(), "1".into()), Arc::clone(&big));
        cache.insert(("n".into(), "b".into(), "1".into()), Arc::clone(&big));
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.bytes <= MAX_CACHED_BYTES);
        cache.insert(
            ("n".into(), "c".into(), "1".into()),
            Arc::new("y".repeat(MAX_CACHED_BYTES + 1)),
        );
        assert!(cache.bytes <= MAX_CACHED_BYTES);
    }
}
