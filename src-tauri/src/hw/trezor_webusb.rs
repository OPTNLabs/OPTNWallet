//! Trezor WebUSB via libusb — Electron Cash / trezorlib `WebUsbTransport`.
//!
//! Source: trezor-firmware python `trezorlib.transport.webusb`
//!   INTERFACE=0, ENDPOINT=1, 64-byte interrupt chunks
//!   Vendor-class USB (LIBUSB_CLASS_VENDOR_SPEC)
//!
//! Safe 5 / Model T / Safe 3 firmware appear as VID 0x1209 PID 0x53c1.
//! Modern Trezor Suite talks this way via node-usb; Bridge (:21325) is optional.

use once_cell::sync::Lazy;
use rusb::{Context, DeviceHandle, UsbContext};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

const TREZOR_VIDS_PIDS: &[(u16, u16)] = &[
    (0x1209, 0x53c1), // Core firmware (Model T, Safe 3/5, …)
    (0x1209, 0x53c0), // Core bootloader
    (0x1209, 0x53c2), // some newer cores
];

const INTERFACE: u8 = 0;
const ENDPOINT_OUT: u8 = 1;
const ENDPOINT_IN: u8 = 0x81;
const CHUNK: usize = 64;
const IO_TIMEOUT: Duration = Duration::from_millis(300);

static SESSIONS: Lazy<Mutex<HashMap<u64, WebUsbSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: Lazy<Mutex<u64>> = Lazy::new(|| Mutex::new(1));

struct WebUsbSession {
    handle: DeviceHandle<Context>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebUsbDeviceInfo {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product: Option<String>,
    pub manufacturer: Option<String>,
    pub bus: u8,
    pub address: u8,
}

fn is_known_id(vid: u16, pid: u16) -> bool {
    TREZOR_VIDS_PIDS.contains(&(vid, pid))
}

fn is_vendor_class(dev: &rusb::Device<Context>) -> bool {
    let Ok(cfg) = dev.active_config_descriptor() else {
        return false;
    };
    for iface in cfg.interfaces() {
        for desc in iface.descriptors() {
            if desc.interface_number() == INTERFACE
                && desc.class_code() == rusb::constants::LIBUSB_CLASS_VENDOR_SPEC
            {
                return true;
            }
        }
    }
    // Some Windows descriptors expose class on alt setting 0 of interface 0.
    true
}

fn device_path(dev: &rusb::Device<Context>) -> String {
    // Match trezorlib style: webusb:bus:port0:port1…
    format!("webusb:{:03}:{}", dev.bus_number(), dev.address())
}

/// Enumerate Trezor Core devices over libusb (EC WebUsbTransport.enumerate).
#[tauri::command]
pub fn trezor_webusb_enumerate() -> Result<Vec<WebUsbDeviceInfo>, String> {
    let ctx = Context::new().map_err(|e| format!("libusb init failed: {e}"))?;
    let mut out = Vec::new();
    for dev in ctx
        .devices()
        .map_err(|e| format!("libusb list: {e}"))?
        .iter()
    {
        let desc = match dev.device_descriptor() {
            Ok(d) => d,
            Err(_) => continue,
        };
        let vid = desc.vendor_id();
        let pid = desc.product_id();
        if !is_known_id(vid, pid) {
            continue;
        }
        if !is_vendor_class(&dev) {
            continue;
        }
        // trezorlib: skip non-functional Windows double-listing
        let product = dev
            .open()
            .ok()
            .and_then(|h| h.read_product_string_ascii(&desc).ok());
        let manufacturer = dev
            .open()
            .ok()
            .and_then(|h| h.read_manufacturer_string_ascii(&desc).ok());
        out.push(WebUsbDeviceInfo {
            path: device_path(&dev),
            vendor_id: vid,
            product_id: pid,
            product,
            manufacturer,
            bus: dev.bus_number(),
            address: dev.address(),
        });
    }
    Ok(out)
}

/// Open first matching device, or a specific webusb: path.
#[tauri::command]
pub fn trezor_webusb_open(path: Option<String>) -> Result<u64, String> {
    let ctx = Context::new().map_err(|e| format!("libusb init failed: {e}"))?;
    let want = path
        .as_deref()
        .map(|p| p.trim().trim_start_matches("bridge:").to_string())
        .filter(|p| !p.is_empty());

    let mut chosen: Option<(rusb::Device<Context>, String)> = None;
    for dev in ctx
        .devices()
        .map_err(|e| format!("libusb list: {e}"))?
        .iter()
    {
        let desc = match dev.device_descriptor() {
            Ok(d) => d,
            Err(_) => continue,
        };
        if !is_known_id(desc.vendor_id(), desc.product_id()) {
            continue;
        }
        let p = device_path(&dev);
        if let Some(ref w) = want {
            if p != *w && !w.starts_with(&p) && !p.starts_with(w.as_str()) {
                continue;
            }
        }
        chosen = Some((dev, p));
        break;
    }

    let (dev, path_str) = chosen.ok_or_else(|| {
        "No Trezor WebUSB device found. Unlock Safe 5 (PIN), use a data USB cable, close Suite if it holds the device exclusively.".to_string()
    })?;

    let handle = dev
        .open()
        .map_err(|e| format!("Cannot open Trezor USB device: {e}. On Windows, WinUSB/libusb drivers may be needed (Zadig) if Suite is not installed."))?;

    // Detach kernel driver if any (Linux); ignore on Windows.
    let _ = handle.set_auto_detach_kernel_driver(true);
    handle
        .claim_interface(INTERFACE)
        .map_err(|e| {
            format!(
                "Cannot claim Trezor interface: {e}. Device busy — close Trezor Suite / other wallets and unlock the Safe."
            )
        })?;

    let _ = path_str; // path used for selection only
    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "webusb session lock poisoned".to_string())?;
    let mut next = NEXT_ID
        .lock()
        .map_err(|_| "webusb id lock poisoned".to_string())?;
    let id = *next;
    *next += 1;
    sessions.insert(id, WebUsbSession { handle });
    Ok(id)
}

#[tauri::command]
pub fn trezor_webusb_close(session_id: u64) -> Result<(), String> {
    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "webusb session lock poisoned".to_string())?;
    if let Some(s) = sessions.remove(&session_id) {
        let _ = s.handle.release_interface(INTERFACE);
    }
    Ok(())
}

/// Write one 64-byte protocol chunk (trezorlib write_chunk).
#[tauri::command]
pub fn trezor_webusb_write(session_id: u64, data_hex: String) -> Result<(), String> {
    let data = hex::decode(data_hex.trim()).map_err(|e| format!("invalid hex: {e}"))?;
    let mut packet = data;
    if packet.len() < CHUNK {
        packet.resize(CHUNK, 0);
    }
    if packet.len() > CHUNK {
        packet.truncate(CHUNK);
    }

    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "webusb session lock poisoned".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "invalid or closed Trezor WebUSB session".to_string())?;

    // Retry on timeout with partial 0 (trezorlib loop).
    for _ in 0..40 {
        match session
            .handle
            .write_interrupt(ENDPOINT_OUT, &packet, IO_TIMEOUT)
        {
            Ok(n) if n == CHUNK => return Ok(()),
            Ok(n) if n == 0 => continue,
            Ok(n) => {
                return Err(format!("USB partial write: {n} of {CHUNK}"));
            }
            Err(rusb::Error::Timeout) => continue,
            Err(e) => return Err(format!("USB write failed: {e}")),
        }
    }
    Err("USB write timed out".into())
}

/// Read one 64-byte protocol chunk (trezorlib read_chunk).
#[tauri::command]
pub fn trezor_webusb_read(session_id: u64, timeout_ms: Option<u64>) -> Result<String, String> {
    let total = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let start = std::time::Instant::now();

    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "webusb session lock poisoned".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "invalid or closed Trezor WebUSB session".to_string())?;

    let mut buf = [0u8; CHUNK];
    loop {
        if start.elapsed() > total {
            return Err("Timeout reading WebUSB packet — confirm on the device".into());
        }
        match session
            .handle
            .read_interrupt(ENDPOINT_IN, &mut buf, IO_TIMEOUT)
        {
            Ok(n) if n == CHUNK => return Ok(hex::encode(buf)),
            Ok(n) if n > 0 => {
                // pad short reads
                return Ok(hex::encode(&buf[..n.max(CHUNK).min(CHUNK)]));
            }
            Ok(_) => continue,
            Err(rusb::Error::Timeout) => continue,
            Err(e) => return Err(format!("USB read failed: {e}")),
        }
    }
}
