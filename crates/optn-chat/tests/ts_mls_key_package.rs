//! A key package the ts-mls engine published, read by MDK's own parser, so an
//! MDK user can invite a ts-mls user (`docs/chat-mdk.md`). Opt-in, since the
//! event comes from the renderer's test, freshly built (a key package
//! expires, so none is committed):
//!
//! ```sh
//! OPTN_MIP00_OUT=/tmp/mip00.json \
//!   npx vitest run src/platform/desktop/nostr/__tests__/mlsMip00.test.ts
//! OPTN_MIP00_EVENT=/tmp/mip00.json \
//!   cargo test -p optn-chat --test ts_mls_key_package -- --ignored
//! ```

use mdk_core::prelude::MDK;
use mdk_memory_storage::MdkMemoryStorage;
use mdk_nostr::JsonUtil;

#[test]
#[ignore = "reads an event the ts-mls test wrote; set OPTN_MIP00_EVENT"]
fn mdk_reads_a_ts_mls_key_package() {
    let Some(path) = std::env::var_os("OPTN_MIP00_EVENT") else {
        return;
    };
    let json = std::fs::read_to_string(path).expect("the exported event");
    let event = mdk_nostr::Event::from_json(json).expect("a Nostr event");
    event.verify().expect("signed by its author");
    let mdk = MDK::new(MdkMemoryStorage::default());
    mdk.parse_key_package(&event)
        .expect("MDK reads the ts-mls key package");
}
