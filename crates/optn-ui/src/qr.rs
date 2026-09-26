//! Local QR encoding for addresses shown by the Rust renderer.
//!
//! The address never leaves the process: the page renders an SVG path from
//! modules produced in Rust rather than asking a web service or a JS library.

use qrcodegen::{QrCode, QrCodeEcc};
use std::fmt::Write;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QrSvg {
    pub(crate) size: i32,
    pub(crate) path: String,
}

pub(crate) fn encode_address_qr(address: &str) -> Result<QrSvg, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("No receive address is available.".into());
    }

    let code = QrCode::encode_text(address, QrCodeEcc::Medium)
        .map_err(|_| "The receive address is too long to encode as a QR code.".to_string())?;
    let size = code.size();
    let mut path = String::new();
    for y in 0..size {
        for x in 0..size {
            if code.get_module(x, y) {
                // A single compound path keeps a long address cheap to paint.
                write!(path, "M{x} {y}h1v1h-1z").expect("writing to String cannot fail");
            }
        }
    }
    Ok(QrSvg { size, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cashaddr_becomes_a_nonempty_square_svg_path() {
        let qr = encode_address_qr("bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a")
            .expect("valid address QR");
        assert!(qr.size >= 21);
        assert!(qr.path.contains('M'));
    }
}
