# Native Network Sources pilot

An opt-in Slint window, not a shipping wallet replacement. The visual reference
remains OPTN v1.7.4; this pilot does not establish pixel or screen parity.
It adds no CSS, JavaScript, WebView or Tauri dependency. Existing React/Leptos,
CLI, extension and mobile builds remain available.

```powershell
cargo run --locked --manifest-path crates/optn-ui-slint/Cargo.toml -- `
  --network chipnet --config D:/scratch/optn-pilot/network-chipnet.json
```

Use a disposable configuration while evaluating. A path is mandatory: the pilot
does not open the default wallet storage. An explicitly supplied file is edited
using the existing network envelope and atomic locked store. Do not point this
standalone pilot at a running wallet's configuration: it does not notify that
other process to rebuild its active routes.

The native host translates controls into `ChainSourceEdit` requests. The shared
`optn-transport-native` adapter invokes the existing runtime validators and
`NetworkConfigFile`; there is no second routing engine or persistence format.
Tauri reuses its source/evidence projection. The renderer library contains only
the generated Slint view; native composition stays in the binary.

Connected controls: public/custom/infrastructure directories, source details,
enable/disable/ban, removal of user sources, pinning, prefer-first/removal,
Automatic and infrastructure presets, custom primary/fallback pools, chain
access restrictions, separate ZMQ event selection, and manual service setup.
Capabilities remain catalog claims with confidence/provenance. Browsing and
saving never probe endpoints or claim a live connection.

## Reproduce the native-window check

Use a **new** configuration path and a graphical Windows session:

```powershell
cargo run --locked --manifest-path crates/optn-ui-slint/Cargo.toml -- `
  --network chipnet --config D:/scratch/optn-pilot-check/network-chipnet.json `
  --smoke-dir D:/scratch/optn-pilot-check
```

This exercises actual view callbacks through persistence and rereads, including
ban, add, pin, preference, selected pools, remove and Automatic. It captures
native software-rendered BMPs at desktop/narrow sizes and after maximize and
minimize/restore. `PASS.txt` records the bounded check. It refuses a preexisting
configuration or a non-Chipnet smoke run. It does not send network traffic.

The extra desktop panel is presentation only; resizing never changes feature
permissions or routing. Standard widgets provide keyboard focus and accessible
controls. Full assistive-technology testing remains separate.

Wallet sessions, live sync, privacy/proxy editing, Explorer, RPC credentials,
service detection, signing/Flipstarter, Android/iOS/macOS packages and full
v1.7.4 visual parity are outside this pilot. Its success cannot close #71/#75/#83.
