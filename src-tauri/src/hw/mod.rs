//! Native hardware wallets — Electron Cash model.
//!
//! WebView has no WebHID/WebUSB. Same split as EC:
//!   JS (protobuf / hw-app-btc) → invoke → native (hidapi + Trezor Bridge HTTP).
//!
//! Trezor Safe 5: Bridge (trezord) on 127.0.0.1:21325 from Rust, not WebView fetch.
//! Ledger: HID APDU via hidapi.
//!
//! Modules are `pub` so `tauri::generate_handler![…]` sees command items.

pub mod ledger;
pub mod session;
pub mod trezor_bridge;
pub mod trezor_webusb;
