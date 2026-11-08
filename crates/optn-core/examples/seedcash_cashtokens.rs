//! Offline corpus exporter and signed-return verifier; never broadcasts.
#[path = "../tests/support/cash_tokens.rs"]
mod support;

use optn_core::{network::Network, psbt};
use serde_json::json;
use std::{fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command, directory] if command == "export" => {
            let root = Path::new(directory);
            fs::create_dir_all(root)?;
            let mut manifest = Vec::new();
            for case in support::cases() {
                let review = psbt::review_p2pkh(&case.psbt, Network::Chipnet);
                assert_eq!(review.is_ok(), case.valid, "{}: {review:?}", case.id);
                fs::write(root.join(format!("{}.psbt", case.id)), &case.psbt)?;
                fs::write(
                    root.join(format!("{}.hex", case.id)),
                    support::hex(&case.psbt),
                )?;
                manifest.push(json!({"id":case.id,"related_scenario_ids":case.scenario_ids,"expected_valid":case.valid,
                    "psbt_hex":support::hex(&case.psbt), "source_transactions":case.parents.iter().map(|p|support::hex(p)).collect::<Vec<_>>(),
                    "review":review.as_ref().ok(),"error":review.err().map(|e|e.to_string())}));
            }
            fs::write(
                root.join("manifest.json"),
                serde_json::to_string_pretty(&json!({
                    "network":"chipnet", "funded":false,"broadcast":false,"hardware_verified":false,
                    "signer_account":"m/44'/145'/0'", "public_bip39_fixture":"abandon x11 + about (empty passphrase)", "cases":manifest
                }))?,
            )?;
            println!("Exported {} unfunded PSBT templates", manifest.len());
        }
        [command, original, signed, output] if command == "finalize" => {
            let original = support::unhex(fs::read_to_string(original)?.trim());
            let signed = support::unhex(fs::read_to_string(signed)?.trim());
            let raw = psbt::finalize_cash_tokens_p2pkh(&original, &signed, Network::Chipnet)?;
            fs::write(output, support::hex(&raw))?;
            println!("Verified {} transaction bytes; not broadcast", raw.len());
        }
        _ => {
            return Err(
                "usage: seedcash_cashtokens export DIR | finalize ORIGINAL.hex SIGNED.hex RAW.hex"
                    .into(),
            )
        }
    }
    Ok(())
}
