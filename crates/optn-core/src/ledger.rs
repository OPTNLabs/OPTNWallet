//! Ledger Bitcoin Cash APDUs, as pure functions over bytes.
//!
//! Ledger deprecated the LedgerJS family in September 2026 and points everyone
//! at the Device Management Kit, which ships a signer kit per chain — and none
//! for Bitcoin Cash. The Bitcoin one cannot stand in: its descriptor templates
//! are `pkh`, `sh(wpkh(..))`, `wpkh` and `tr`, the wallet-policy protocol the
//! Bitcoin Cash device app does not speak. `hw-app-btc` itself routed
//! `currency: 'bch'` to its *legacy* implementation for exactly that reason.
//!
//! So the app-binder is ours to write. This is the Rust half of it, shared so
//! that the CLI, the desktop shell and any renderer encode the same bytes
//! rather than each carrying a copy: a second encoder is a second thing that
//! can disagree with the device about what an address is.
//!
//! The TypeScript original is `src/services/hardware/ledgerBchApdu.ts`, whose
//! wire format came from Ledger's own `getWalletPublicKey.js` and `bip32.js`.
//! Its vectors are ported alongside, because agreeing with our own encoder
//! proves nothing about what the device accepts.
//!
//! Nothing here touches a transport. Framing and HID live in the shell.

use crate::error::{CliError, Result};

/// Bitcoin application class byte.
pub const CLA_BTC: u8 = 0xe0;
/// GET WALLET PUBLIC KEY.
pub const INS_GET_WALLET_PUBLIC_KEY: u8 = 0x40;

/// The app rejects longer paths, and saying so here beats a 0x6a80 from the
/// device that the user has to interpret.
pub const MAX_BIP32_LEVELS: usize = 10;

/// Length of the BIP32 chain code the device returns.
const CHAIN_CODE_LEN: usize = 32;

/// Address encodings the app can return.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AddressFormat {
    Legacy,
    P2sh,
    Bech32,
    /// The only one this wallet asks for.
    ///
    /// A Ledger handed a BCH path and asked for the app's default will happily
    /// return a legacy address. Nothing errors, and it is an address on the
    /// same chain — it is simply one no modern Bitcoin Cash wallet displays,
    /// so funds sent to it are not seen as a mistake until much later.
    #[default]
    Cashaddr,
}

impl AddressFormat {
    /// The P2 value the app expects for this encoding.
    pub const fn code(self) -> u8 {
        match self {
            Self::Legacy => 0,
            Self::P2sh => 1,
            Self::Bech32 => 2,
            Self::Cashaddr => 3,
        }
    }
}

/// One command, ready for a transport to frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Apdu {
    pub cla: u8,
    pub ins: u8,
    pub p1: u8,
    pub p2: u8,
    pub data: Vec<u8>,
}

impl Apdu {
    /// The command as a transport sends it: header then data.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + self.data.len());
        out.extend_from_slice(&[self.cla, self.ins, self.p1, self.p2]);
        out.push(self.data.len() as u8);
        out.extend_from_slice(&self.data);
        out
    }
}

/// What the device answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletPublicKey {
    /// Uncompressed public key, hex.
    pub public_key: String,
    /// The address the device rendered, in the format that was asked for.
    pub address: String,
    /// BIP32 chain code, hex.
    pub chain_code: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Encode a BIP32 path the way the Bitcoin app expects: a count byte, then one
/// big-endian `u32` per level, hardened levels having the high bit set.
///
/// A leading `m/` is accepted. An empty path is a single zero byte, which is
/// what asks the device for the master key.
pub fn encode_bip32_path(path: &str) -> Result<Vec<u8>> {
    let trimmed = path
        .trim()
        .strip_prefix("m/")
        .unwrap_or_else(|| path.trim())
        .trim_end_matches('/');
    let levels: Vec<&str> = if trimmed.is_empty() {
        Vec::new()
    } else {
        trimmed.split('/').collect()
    };
    if levels.len() > MAX_BIP32_LEVELS {
        return Err(CliError::Usage(format!(
            "a BIP32 path has at most {MAX_BIP32_LEVELS} levels, got {}",
            levels.len()
        )));
    }

    let mut out = Vec::with_capacity(1 + levels.len() * 4);
    out.push(levels.len() as u8);
    for level in &levels {
        let hardened = level.ends_with('\'') || level.ends_with('h');
        let digits = if hardened {
            &level[..level.len() - 1]
        } else {
            level
        };
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CliError::Usage(format!(
                "'{level}' is not a BIP32 path level"
            )));
        }
        // Parsed as u64 so a value above u32 is rejected as out of range
        // rather than overflowing into a different level.
        let value: u64 = digits
            .parse()
            .map_err(|_| CliError::Usage(format!("path level {level} is out of range")))?;
        if value > 0x7fff_ffff {
            return Err(CliError::Usage(format!(
                "path level {level} is out of range"
            )));
        }
        let encoded = if hardened {
            value as u32 + 0x8000_0000
        } else {
            value as u32
        };
        out.extend_from_slice(&encoded.to_be_bytes());
    }
    Ok(out)
}

/// Build the GET WALLET PUBLIC KEY command.
///
/// `verify` asks the device to show the address on its own screen, which is
/// the only way a holder can tell that the address on the computer is the one
/// the device derived. It is a distinct request, not a UI flourish.
pub fn build_get_wallet_public_key(
    path: &str,
    verify: bool,
    format: AddressFormat,
) -> Result<Apdu> {
    Ok(Apdu {
        cla: CLA_BTC,
        ins: INS_GET_WALLET_PUBLIC_KEY,
        p1: u8::from(verify),
        p2: format.code(),
        data: encode_bip32_path(path)?,
    })
}

/// Read the response: a length-prefixed public key, a length-prefixed ASCII
/// address, then 32 bytes of chain code.
///
/// Every length is checked against what is actually there. A truncated reply
/// read optimistically would yield a short address that still looks like one,
/// and an address is the last thing worth guessing at.
pub fn parse_wallet_public_key(response: &[u8]) -> Result<WalletPublicKey> {
    let mut offset = 0usize;
    let need = |offset: usize, count: usize, what: &str| -> Result<()> {
        if offset + count > response.len() {
            return Err(CliError::Protocol(format!(
                "the device's reply ended in the middle of its {what} ({} bytes)",
                response.len()
            )));
        }
        Ok(())
    };

    need(offset, 1, "public key length")?;
    let public_key_length = usize::from(response[offset]);
    offset += 1;
    need(offset, public_key_length, "public key")?;
    let public_key = hex(&response[offset..offset + public_key_length]);
    offset += public_key_length;

    need(offset, 1, "address length")?;
    let address_length = usize::from(response[offset]);
    offset += 1;
    need(offset, address_length, "address")?;
    let address_bytes = &response[offset..offset + address_length];
    // The app renders the address as ASCII. Anything else is not an address
    // this wallet should hand onward as though it read one.
    if !address_bytes.is_ascii() {
        return Err(CliError::Protocol(
            "the device's address is not ASCII".into(),
        ));
    }
    let address = String::from_utf8_lossy(address_bytes).into_owned();
    offset += address_length;

    need(offset, CHAIN_CODE_LEN, "chain code")?;
    let chain_code = hex(&response[offset..offset + CHAIN_CODE_LEN]);

    if public_key_length == 0 || address_length == 0 {
        return Err(CliError::Protocol(
            "the device returned an empty public key or address".into(),
        ));
    }
    Ok(WalletPublicKey {
        public_key,
        address,
        chain_code,
    })
}

/// Turn a status word into something a holder can act on.
///
/// `None` is success. The rest are the ones that actually happen, and each has
/// a different thing for the user to do — which is the whole reason not to show
/// the raw code.
pub fn describe_status_word(status: u16) -> Option<String> {
    let message = match status {
        0x9000 => return None,
        0x6985 => "You declined that on the device.",
        0x5515 | 0x6b0c => "The Ledger is locked. Enter its PIN and try again.",
        0x6a80 | 0x6a86 => {
            "The device rejected the request. Open the Bitcoin Cash app on it, not Bitcoin."
        }
        0x6d00 | 0x6e00 => {
            "The app open on the device does not understand that request. \
             Open the Bitcoin Cash app."
        }
        0x6f00 => "The device reported an internal error. Unplug it and try again.",
        other => {
            return Some(format!(
                "The device refused the request (status 0x{other:04x})."
            ))
        }
    };
    Some(message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bytes a Ledger sees. Ported from the TypeScript vectors, which were
    /// themselves checked against Ledger's `getWalletPublicKey.js` and
    /// `bip32.js` rather than against our encoder.
    #[test]
    fn a_path_is_a_count_byte_and_big_endian_hardened_levels() {
        // m/44'/145'/0' -- BCH's coin type. Hardened sets the high bit, so 44'
        // is 0x8000002c and 145' is 0x80000091.
        assert_eq!(
            hex(&encode_bip32_path("44'/145'/0'").unwrap()),
            "038000002c8000009180000000"
        );
        // A leading m/ means the same thing.
        assert_eq!(
            encode_bip32_path("m/44'/145'/0'").unwrap(),
            encode_bip32_path("44'/145'/0'").unwrap()
        );
        // 'h' is the other spelling of hardened.
        assert_eq!(
            encode_bip32_path("44h/145h/0h").unwrap(),
            encode_bip32_path("44'/145'/0'").unwrap()
        );
        // Unhardened levels keep the high bit clear.
        assert_eq!(
            hex(&encode_bip32_path("44'/145'/0'/0/7").unwrap()),
            "058000002c80000091800000000000000000000007"
        );
        // An empty path is a single zero: the master key.
        assert_eq!(hex(&encode_bip32_path("").unwrap()), "00");
    }

    #[test]
    fn a_path_it_cannot_encode_is_refused_rather_than_sent_as_nonsense() {
        for bad in ["44'/xyz/0'", "44'//0'", "44'/'/0'"] {
            let error = encode_bip32_path(bad).unwrap_err().to_string();
            assert!(error.contains("not a BIP32 path level"), "{bad}: {error}");
        }
        // Above 0x7fffffff there is no room left for the hardened bit.
        let error = encode_bip32_path("44'/4294967295'/0'")
            .unwrap_err()
            .to_string();
        assert!(error.contains("out of range"), "{error}");
        let error = encode_bip32_path("0/1/2/3/4/5/6/7/8/9/10")
            .unwrap_err()
            .to_string();
        assert!(error.contains("at most 10 levels"), "{error}");
    }

    /// Asking for cashaddr is the whole point of writing this ourselves.
    #[test]
    fn the_request_asks_for_cashaddr_not_the_app_default() {
        assert_eq!(AddressFormat::Cashaddr.code(), 3);
        assert_eq!(AddressFormat::default(), AddressFormat::Cashaddr);

        let apdu = build_get_wallet_public_key("44'/145'/0'", false, AddressFormat::default())
            .expect("encodes");
        assert_eq!(apdu.cla, CLA_BTC);
        assert_eq!(apdu.cla, 0xe0);
        assert_eq!(apdu.ins, INS_GET_WALLET_PUBLIC_KEY);
        assert_eq!(apdu.ins, 0x40);
        assert_eq!(apdu.p1, 0, "no on-device display by default");
        assert_eq!(apdu.p2, 3, "cashaddr");
        assert_eq!(hex(&apdu.data), "038000002c8000009180000000");

        // And the framed command a transport would send: cla e0, ins 40,
        // p1 00, p2 03 (cashaddr), Lc 0d, then the path.
        assert_eq!(
            hex(&apdu.to_bytes()),
            "e04000030d038000002c8000009180000000"
        );
    }

    #[test]
    fn p1_is_set_when_the_address_must_be_shown_on_the_device() {
        let shown = build_get_wallet_public_key("44'/145'/0'", true, AddressFormat::Cashaddr)
            .expect("encodes");
        assert_eq!(shown.p1, 1);
        let quiet = build_get_wallet_public_key("44'/145'/0'", false, AddressFormat::Cashaddr)
            .expect("encodes");
        assert_eq!(quiet.p1, 0);
    }

    fn device_reply(public_key: &[u8], address: &str, chain_code: &[u8]) -> Vec<u8> {
        let mut reply = Vec::new();
        reply.push(public_key.len() as u8);
        reply.extend_from_slice(public_key);
        reply.push(address.len() as u8);
        reply.extend_from_slice(address.as_bytes());
        reply.extend_from_slice(chain_code);
        reply
    }

    #[test]
    fn a_reply_the_device_would_send_reads_back() {
        let mut public_key = [0xab; 65];
        public_key[0] = 0x04;
        let address = "bchtest:qq0000000000000000000000000000000000000000";
        let chain_code = [0xcd; CHAIN_CODE_LEN];

        let parsed =
            parse_wallet_public_key(&device_reply(&public_key, address, &chain_code)).unwrap();
        assert_eq!(parsed.public_key, hex(&public_key));
        assert_eq!(parsed.address, address);
        assert_eq!(parsed.chain_code, hex(&chain_code));
    }

    #[test]
    fn a_truncated_reply_is_refused_rather_than_read_as_a_short_address() {
        let public_key = [0x02; 65];
        let full = device_reply(&public_key, "bchtest:qq00", &[0; CHAIN_CODE_LEN]);
        for cut in [0, 1, 10, 66, 70, full.len() - 1] {
            assert!(
                parse_wallet_public_key(&full[..cut]).is_err(),
                "a reply cut to {cut} bytes must not parse"
            );
        }
        assert!(parse_wallet_public_key(&full).is_ok());
    }

    #[test]
    fn an_empty_key_or_address_is_refused() {
        let reply = device_reply(&[], "bchtest:qq00", &[0; CHAIN_CODE_LEN]);
        assert!(parse_wallet_public_key(&reply).is_err());
        let reply = device_reply(&[0x02; 33], "", &[0; CHAIN_CODE_LEN]);
        assert!(parse_wallet_public_key(&reply).is_err());
    }

    /// The address is what the holder acts on, so a non-ASCII one is refused
    /// rather than lossily rendered into something that still looks like an
    /// address.
    #[test]
    fn a_non_ascii_address_is_refused() {
        let mut reply = device_reply(&[0x02; 33], "bchtest:qq00", &[0; CHAIN_CODE_LEN]);
        reply[35] = 0xff;
        assert!(parse_wallet_public_key(&reply).is_err());
    }

    #[test]
    fn a_status_word_becomes_something_the_user_can_act_on() {
        assert_eq!(describe_status_word(0x9000), None);
        let declined = describe_status_word(0x6985).unwrap();
        assert!(declined.to_lowercase().contains("declined"), "{declined}");
        for locked in [0x5515, 0x6b0c] {
            let message = describe_status_word(locked).unwrap();
            assert!(message.to_lowercase().contains("locked"), "{message}");
        }
        // The one that actually catches people: the Bitcoin app is open, not
        // Bitcoin Cash, and the message has to say which.
        let wrong_app = describe_status_word(0x6a80).unwrap();
        assert!(wrong_app.contains("Bitcoin Cash app"), "{wrong_app}");
        assert!(wrong_app.contains("not Bitcoin."), "{wrong_app}");
        assert!(describe_status_word(0x6d00)
            .unwrap()
            .contains("Bitcoin Cash app"));
        // An unknown code still names itself rather than vanishing.
        assert!(describe_status_word(0x1234).unwrap().contains("0x1234"));
    }
}
