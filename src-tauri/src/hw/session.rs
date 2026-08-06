//! Session registry over hidapi — open/read/write/close for any known HID wallet.

use hidapi::{HidApi, HidDevice};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Ledger Semiconductor + legacy btchip.
const LEDGER_VIDS: &[u16] = &[0x2c97, 0x2581];
/// Trezor One (HID). Model T / Safe use WebUSB (0x1209) — not HID; see docs.
const TREZOR_HID_VID: u16 = 0x534c;
const TREZOR_HID_PID: u16 = 0x0001;
/// OneKey (and some Trezor WebUSB ids share 0x1209; we only claim HID interfaces).
const ONEKEY_VIDS: &[u16] = &[0x1209, 0x2c97];

static HID_API: Lazy<Mutex<Option<HidApi>>> = Lazy::new(|| Mutex::new(None));
static SESSIONS: Lazy<Mutex<HashMap<u64, Session>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: Lazy<Mutex<u64>> = Lazy::new(|| Mutex::new(1));

struct Session {
    device: HidDevice,
    family: HwFamily,
    #[allow(dead_code)] // kept for diagnostics / future re-open by path
    path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HwFamily {
    Ledger,
    Trezor,
    Onekey,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct HwDeviceInfo {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product: Option<String>,
    pub manufacturer: Option<String>,
    pub family: HwFamily,
    pub interface_number: i32,
    pub usage_page: u16,
}

fn with_api<T>(f: impl FnOnce(&HidApi) -> Result<T, String>) -> Result<T, String> {
    let mut guard = HID_API
        .lock()
        .map_err(|_| "hardware HID lock poisoned".to_string())?;
    if guard.is_none() {
        let api = HidApi::new().map_err(|e| format!("hidapi init failed: {e}"))?;
        *guard = Some(api);
    }
    // Refresh device list each enumerate/open so plug/unplug is seen.
    let api = guard.as_mut().unwrap();
    api.refresh_devices()
        .map_err(|e| format!("hidapi refresh failed: {e}"))?;
    f(api)
}

fn classify(vid: u16, pid: u16, usage_page: u16, interface_number: i32) -> Option<HwFamily> {
    if LEDGER_VIDS.contains(&vid) {
        // Ledger multi-interface devices: only the APDU interface (usage 0xffa0
        // or interface 0) is usable — same filter as Electron Cash.
        if vid == 0x2c97 && interface_number > 0 && usage_page != 0xffa0 {
            return None;
        }
        return Some(HwFamily::Ledger);
    }
    if vid == TREZOR_HID_VID && pid == TREZOR_HID_PID {
        return Some(HwFamily::Trezor);
    }
    // OneKey often ships as 0x1209 with product strings; avoid claiming Trezor
    // WebUSB bootloader PIDs that are not HID usable here.
    if ONEKEY_VIDS.contains(&vid) {
        // Trezor T firmware WebUSB product 0x53c1 is not a classic HID APDU path.
        if vid == 0x1209 && (pid == 0x53c0 || pid == 0x53c1) {
            return None;
        }
        if vid == 0x2c97 {
            // Already handled as Ledger above when usage matches; leftover 2c97
            // with non-ledger usage is ignored.
            return None;
        }
        return Some(HwFamily::Onekey);
    }
    None
}

#[tauri::command]
pub fn hw_enumerate() -> Result<Vec<HwDeviceInfo>, String> {
    with_api(|api| {
        let mut out = Vec::new();
        for dev in api.device_list() {
            let vid = dev.vendor_id();
            let pid = dev.product_id();
            let usage = dev.usage_page();
            let iface = dev.interface_number();
            let Some(family) = classify(vid, pid, usage, iface) else {
                continue;
            };
            let path = dev.path().to_string_lossy().into_owned();
            out.push(HwDeviceInfo {
                path,
                vendor_id: vid,
                product_id: pid,
                product: dev.product_string().map(|s| s.to_string()),
                manufacturer: dev.manufacturer_string().map(|s| s.to_string()),
                family,
                interface_number: iface,
                usage_page: usage,
            });
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn hw_open(path: String, family: Option<String>) -> Result<u64, String> {
    let want_family = family.as_deref().map(parse_family).transpose()?;
    with_api(|api| {
        let mut opened: Option<(HidDevice, HwFamily, String)> = None;
        for dev in api.device_list() {
            let p = dev.path().to_string_lossy().into_owned();
            if p != path {
                continue;
            }
            let vid = dev.vendor_id();
            let pid = dev.product_id();
            let usage = dev.usage_page();
            let iface = dev.interface_number();
            let Some(fam) = classify(vid, pid, usage, iface) else {
                return Err("device path is not a supported hardware wallet interface".into());
            };
            if let Some(want) = want_family {
                if want != fam {
                    return Err(format!(
                        "device family mismatch: path is {fam:?}, requested {want:?}"
                    ));
                }
            }
            let device = dev
                .open_device(api)
                .map_err(|e| format!("failed to open HID device: {e}"))?;
            let _ = device.set_blocking_mode(true);
            opened = Some((device, fam, p));
            break;
        }
        let (device, fam, p) = opened.ok_or_else(|| {
            "device path not found — plug in the device and open its coin app".to_string()
        })?;
        let mut sessions = SESSIONS
            .lock()
            .map_err(|_| "hardware session lock poisoned".to_string())?;
        let mut next = NEXT_ID
            .lock()
            .map_err(|_| "hardware id lock poisoned".to_string())?;
        let id = *next;
        *next += 1;
        sessions.insert(
            id,
            Session {
                device,
                family: fam,
                path: p,
            },
        );
        Ok(id)
    })
}

#[tauri::command]
pub fn hw_close(session_id: u64) -> Result<(), String> {
    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "hardware session lock poisoned".to_string())?;
    sessions.remove(&session_id);
    Ok(())
}

/// Close every open session of a given family (e.g. before re-opening Ledger).
pub fn hw_close_family(family: HwFamily) -> Result<(), String> {
    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "hardware session lock poisoned".to_string())?;
    sessions.retain(|_, s| s.family != family);
    Ok(())
}

#[tauri::command]
pub fn hw_write(session_id: u64, data_hex: String) -> Result<(), String> {
    let data = hex::decode(data_hex.trim()).map_err(|e| format!("invalid hex: {e}"))?;
    if data.is_empty() {
        return Err("empty HID write".into());
    }
    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "hardware session lock poisoned".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "invalid or closed hardware session".to_string())?;

    // Pad / report-id handling for 64-byte HID wallets (Trezor One, OneKey HID).
    let mut packet = data;
    if packet.len() < 64 {
        packet.resize(64, 0);
    }
    let mut with_id = Vec::with_capacity(packet.len() + 1);
    with_id.push(0x00);
    with_id.extend_from_slice(&packet[..64.min(packet.len())]);
    if with_id.len() < 65 {
        with_id.resize(65, 0);
    }
    match session.device.write(&with_id) {
        Ok(_) => Ok(()),
        Err(_) => {
            session
                .device
                .write(&packet[..64.min(packet.len())])
                .map_err(|e| format!("HID write failed: {e}"))?;
            Ok(())
        }
    }
}

#[tauri::command]
pub fn hw_read(session_id: u64, timeout_ms: u64) -> Result<String, String> {
    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "hardware session lock poisoned".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "invalid or closed hardware session".to_string())?;
    let mut buf = [0u8; 64];
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(50));
    loop {
        match session.device.read_timeout(&mut buf, 100) {
            Ok(0) => {
                if Instant::now() >= deadline {
                    return Err("HID read timed out".into());
                }
            }
            Ok(n) => {
                return Ok(hex::encode(&buf[..n]));
            }
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err(format!("HID read failed: {e}"));
                }
            }
        }
    }
}

pub fn with_session_mut<T>(
    session_id: u64,
    f: impl FnOnce(&mut HidDevice, HwFamily) -> Result<T, String>,
) -> Result<T, String> {
    let mut sessions = SESSIONS
        .lock()
        .map_err(|_| "hardware session lock poisoned".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "invalid or closed hardware session".to_string())?;
    f(&mut session.device, session.family)
}

pub fn session_family(session_id: u64) -> Result<HwFamily, String> {
    let sessions = SESSIONS
        .lock()
        .map_err(|_| "hardware session lock poisoned".to_string())?;
    sessions
        .get(&session_id)
        .map(|s| s.family)
        .ok_or_else(|| "invalid or closed hardware session".to_string())
}

fn parse_family(s: &str) -> Result<HwFamily, String> {
    match s.to_ascii_lowercase().as_str() {
        "ledger" => Ok(HwFamily::Ledger),
        "trezor" => Ok(HwFamily::Trezor),
        "onekey" => Ok(HwFamily::Onekey),
        other => Err(format!("unknown hardware family '{other}'")),
    }
}
