//! Ledger APDU over USB HID — same channel framing as Ledger Live / btchip-python.
//!
//! Packet layout (64 bytes):
//!   [0..1] channel (BE, default 0x0101)
//!   [2]    tag 0x05 (APDU)
//!   [3..4] sequence (BE)
//!   first packet only: [5..6] APDU length (BE), then payload
//!   continuation: payload only after sequence

use super::session::{self, HwFamily};
use hidapi::HidDevice;
use std::time::{Duration, Instant};

const TAG_APDU: u8 = 0x05;
const CHANNEL: u16 = 0x0101;
const PACKET_SIZE: usize = 64;

fn write_packet(device: &HidDevice, packet: &[u8; PACKET_SIZE]) -> Result<(), String> {
    // Windows HID often requires a leading report ID byte (0).
    let mut report = [0u8; PACKET_SIZE + 1];
    report[0] = 0x00;
    report[1..].copy_from_slice(packet);
    match device.write(&report) {
        Ok(_) => Ok(()),
        Err(_) => {
            // Some stacks accept the bare 64-byte packet.
            device
                .write(packet)
                .map_err(|e| format!("Ledger HID write failed: {e}"))?;
            Ok(())
        }
    }
}

fn read_packet(device: &HidDevice, timeout: Duration) -> Result<[u8; PACKET_SIZE], String> {
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; PACKET_SIZE + 1];
    loop {
        match device.read_timeout(&mut buf, 200) {
            Ok(0) => {
                if Instant::now() >= deadline {
                    return Err("Ledger HID read timed out — unlock the device and open the Bitcoin Cash app".into());
                }
            }
            Ok(n) => {
                let mut out = [0u8; PACKET_SIZE];
                // Strip optional report ID if present.
                if n == PACKET_SIZE + 1 {
                    out.copy_from_slice(&buf[1..PACKET_SIZE + 1]);
                } else if n >= PACKET_SIZE {
                    out.copy_from_slice(&buf[..PACKET_SIZE]);
                } else if n > 0 {
                    out[..n].copy_from_slice(&buf[..n]);
                } else if Instant::now() >= deadline {
                    return Err("Ledger HID read returned empty".into());
                } else {
                    continue;
                }
                return Ok(out);
            }
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err(format!("Ledger HID read failed: {e}"));
                }
            }
        }
    }
}

fn exchange_apdu(device: &HidDevice, apdu: &[u8]) -> Result<Vec<u8>, String> {
    if apdu.is_empty() {
        return Err("empty APDU".into());
    }
    if apdu.len() > 0xffff {
        return Err("APDU too large".into());
    }

    // ── send ──────────────────────────────────────────────────────────
    let mut seq: u16 = 0;
    let mut offset = 0usize;
    while offset < apdu.len() || seq == 0 {
        let mut packet = [0u8; PACKET_SIZE];
        packet[0] = (CHANNEL >> 8) as u8;
        packet[1] = (CHANNEL & 0xff) as u8;
        packet[2] = TAG_APDU;
        packet[3] = (seq >> 8) as u8;
        packet[4] = (seq & 0xff) as u8;

        let mut i = 5usize;
        if seq == 0 {
            packet[i] = (apdu.len() >> 8) as u8;
            packet[i + 1] = (apdu.len() & 0xff) as u8;
            i += 2;
        }
        while i < PACKET_SIZE && offset < apdu.len() {
            packet[i] = apdu[offset];
            i += 1;
            offset += 1;
        }
        write_packet(device, &packet)?;
        seq = seq.wrapping_add(1);
        if offset >= apdu.len() {
            break;
        }
    }

    // ── receive ───────────────────────────────────────────────────────
    let mut response = Vec::new();
    let mut expected_seq: u16 = 0;
    let mut total: Option<usize> = None;
    let read_timeout = Duration::from_secs(120); // user may be confirming on device

    loop {
        let packet = read_packet(device, read_timeout)?;
        if packet[0] != (CHANNEL >> 8) as u8 || packet[1] != (CHANNEL & 0xff) as u8 {
            // Ignore unrelated HID noise (some devices multiplex).
            continue;
        }
        if packet[2] != TAG_APDU {
            continue;
        }
        let seq = u16::from_be_bytes([packet[3], packet[4]]);
        if seq != expected_seq {
            return Err(format!(
                "Ledger HID sequence mismatch: got {seq}, expected {expected_seq}"
            ));
        }
        expected_seq = expected_seq.wrapping_add(1);

        let mut i = 5usize;
        if seq == 0 {
            if packet.len() < 7 {
                return Err("Ledger response header truncated".into());
            }
            total = Some(u16::from_be_bytes([packet[5], packet[6]]) as usize);
            i = 7;
        }
        let Some(need) = total else {
            return Err("Ledger response missing length".into());
        };
        while i < PACKET_SIZE && response.len() < need {
            response.push(packet[i]);
            i += 1;
        }
        if response.len() >= need {
            response.truncate(need);
            break;
        }
    }

    if response.len() < 2 {
        return Err("Ledger response too short (no status word)".into());
    }
    Ok(response)
}

/// Open the first Ledger HID interface (or a specific path).
///
/// Prefers usage_page 0xffa0 (APDU channel — same as Electron Cash / Ledger Live).
/// Closes any existing Ledger sessions first so Windows exclusive HID is free
/// (stale handles produce WriteFile 0x48F "The device is not connected").
#[tauri::command]
pub fn hw_ledger_open(path: Option<String>) -> Result<u64, String> {
    // Drop prior Ledger sessions — one exclusive HID handle per process.
    session::hw_close_family(HwFamily::Ledger)?;

    if let Some(p) = path {
        return session::hw_open(p, Some("ledger".into()));
    }
    let devices = session::hw_enumerate()?;
    let mut ledgers: Vec<_> = devices
        .into_iter()
        .filter(|d| d.family == HwFamily::Ledger)
        .collect();
    if ledgers.is_empty() {
        return Err(
            "No Ledger found over USB HID. Plug in the device, unlock it, and open the Bitcoin Cash app.".into(),
        );
    }
    // Prefer APDU usage page, then interface 0 (EC filter).
    ledgers.sort_by_key(|d| {
        let usage_score = if d.usage_page == 0xffa0 { 0 } else { 1 };
        let iface_score = if d.interface_number == 0 { 0 } else { 1 };
        (usage_score, iface_score)
    });
    let ledger = &ledgers[0];
    session::hw_open(ledger.path.clone(), Some("ledger".into()))
}

/// Exchange one APDU; returns response hex including SW1SW2.
#[tauri::command]
pub fn hw_ledger_exchange(session_id: u64, apdu_hex: String) -> Result<String, String> {
    let apdu = hex::decode(apdu_hex.trim()).map_err(|e| format!("invalid APDU hex: {e}"))?;
    session::with_session_mut(session_id, |device, family| {
        if family != HwFamily::Ledger {
            return Err("session is not a Ledger device".into());
        }
        let resp = exchange_apdu(device, &apdu)?;
        Ok(hex::encode(resp))
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn channel_constants() {
        assert_eq!(super::CHANNEL, 0x0101);
        assert_eq!(super::TAG_APDU, 0x05);
    }
}
