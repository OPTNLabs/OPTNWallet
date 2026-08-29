//! CashScript covenants.
//!
//! A covenant is a contract whose spending conditions are written in Script and
//! locked to by its hash. The wallet already ships compiled artifacts, so
//! nothing here compiles CashScript — the work is turning an artifact plus its
//! constructor arguments into the same redeem script, and therefore the same
//! address, that the desktop wallet derives.
//!
//! "The same" is the whole difficulty. An address that is merely plausible is
//! worse than none: funds sent to it are locked under a script nobody holds the
//! spending path for. So the construction here is pinned to vectors generated
//! with the `cashscript` library itself (tests/vectors/contracts.json), rather
//! than to a reading of how it probably works.
//!
//! Three details that are easy to get wrong and silent when wrong:
//!
//! - Constructor arguments are pushed in **reverse** order, last argument
//!   first, ahead of the compiled bytecode.
//! - Integers use Script's minimal little-endian signed encoding, not a
//!   fixed width.
//! - The address is P2SH32 — a double-SHA-256 of the redeem script, not
//!   hash160 — and CashAddr encodes the 32-byte length in its version byte.

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::error::{CliError, Result};
use crate::network::Network;

/// A compiled CashScript artifact, as `cashc` emits it.
#[derive(Debug, Clone, Deserialize)]
pub struct Artifact {
    #[serde(rename = "contractName")]
    pub contract_name: String,
    #[serde(rename = "constructorInputs", default)]
    pub constructor_inputs: Vec<Parameter>,
    #[serde(default)]
    pub abi: Vec<Function>,
    /// Space-separated ASM, which is what cashc writes.
    pub bytecode: String,
    #[serde(default)]
    pub compiler: Option<Compiler>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Parameter {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Function {
    pub name: String,
    #[serde(default)]
    pub inputs: Vec<Parameter>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Compiler {
    pub name: String,
    pub version: String,
}

/// The artifacts this wallet ships, compiled into the binary.
///
/// Embedded rather than read from disk: the CLI is a single file people copy
/// onto a machine, and a contract command that only worked next to a checkout
/// would be useless there.
pub const BUNDLED: &[(&str, &str)] = &[
    (
        "AuthGuard.json",
        include_str!("../../../src/apis/ContractManager/artifacts/AuthGuard.json"),
    ),
    (
        "CustodyVault.json",
        include_str!("../../../src/apis/ContractManager/artifacts/CustodyVault.json"),
    ),
    (
        "MSVault.json",
        include_str!("../../../src/apis/ContractManager/artifacts/MSVault.json"),
    ),
    (
        "announcement.json",
        include_str!("../../../src/apis/ContractManager/artifacts/announcement.json"),
    ),
    (
        "bip38.json",
        include_str!("../../../src/apis/ContractManager/artifacts/bip38.json"),
    ),
    (
        "escrow.json",
        include_str!("../../../src/apis/ContractManager/artifacts/escrow.json"),
    ),
    (
        "escrowMS2.json",
        include_str!("../../../src/apis/ContractManager/artifacts/escrowMS2.json"),
    ),
    (
        "p2pkh.json",
        include_str!("../../../src/apis/ContractManager/artifacts/p2pkh.json"),
    ),
    (
        "transfer_with_timeout.json",
        include_str!("../../../src/apis/ContractManager/artifacts/transfer_with_timeout.json"),
    ),
];

/// Load a bundled artifact by file name or contract name.
pub fn bundled(name: &str) -> Result<Artifact> {
    let wanted = name.trim_end_matches(".json");
    for (file, source) in BUNDLED {
        let artifact: Artifact = serde_json::from_str(source).map_err(|e| {
            CliError::Internal(format!("bundled artifact {file} is unreadable: {e}"))
        })?;
        if file.trim_end_matches(".json").eq_ignore_ascii_case(wanted)
            || artifact.contract_name.eq_ignore_ascii_case(wanted)
        {
            return Ok(artifact);
        }
    }
    let known: Vec<&str> = BUNDLED
        .iter()
        .map(|(f, _)| f.trim_end_matches(".json"))
        .collect();
    Err(CliError::Usage(format!(
        "no contract '{name}'; this build has: {}",
        known.join(", ")
    )))
}

/// Push `data` with the shortest encoding Script allows.
///
/// Not merely a size question: the redeem script is hashed to form the address,
/// so a non-minimal push produces a different address for the same contract.
pub fn push_data(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 5);
    match data.len() {
        0 => out.push(0x00),
        1 if data[0] == 0x81 => out.push(0x4f), // OP_1NEGATE
        1 if (1..=16).contains(&data[0]) => out.push(0x50 + data[0]),
        n if n < 0x4c => {
            out.push(n as u8);
            out.extend_from_slice(data);
        }
        n if n <= 0xff => {
            out.push(0x4c);
            out.push(n as u8);
            out.extend_from_slice(data);
        }
        n if n <= 0xffff => {
            out.push(0x4d);
            out.extend_from_slice(&(n as u16).to_le_bytes());
            out.extend_from_slice(data);
        }
        n => {
            out.push(0x4e);
            out.extend_from_slice(&(n as u32).to_le_bytes());
            out.extend_from_slice(data);
        }
    }
    out
}

/// Script's minimal little-endian signed integer.
///
/// Little-endian, and the sign lives in the top bit of the last byte, with an
/// extra byte added when that bit would otherwise be taken as the sign. Zero is
/// the empty string. Getting this wrong changes the redeem script and so the
/// address.
pub fn encode_number(value: i64) -> Vec<u8> {
    if value == 0 {
        return Vec::new();
    }
    let negative = value < 0;
    let mut magnitude = value.unsigned_abs();
    let mut out = Vec::new();
    while magnitude > 0 {
        out.push((magnitude & 0xff) as u8);
        magnitude >>= 8;
    }
    // The high bit of the final byte is the sign, so a value that already uses
    // it needs one more byte to avoid reading as negative.
    if out.last().is_some_and(|b| b & 0x80 != 0) {
        out.push(if negative { 0x80 } else { 0x00 });
    } else if negative {
        let last = out.len() - 1;
        out[last] |= 0x80;
    }
    out
}

/// A constructor argument, typed as the artifact declares it.
#[derive(Debug, Clone)]
pub enum Argument {
    Bytes(Vec<u8>),
    Number(i64),
    Bool(bool),
}

impl Argument {
    fn encoded(&self) -> Vec<u8> {
        match self {
            Argument::Bytes(bytes) => push_data(bytes),
            Argument::Number(n) => push_data(&encode_number(*n)),
            Argument::Bool(b) => push_data(&encode_number(i64::from(*b))),
        }
    }
}

/// Parse a command-line argument against the type the artifact declares.
///
/// Typed rather than guessed: `1000` is a number under `int` and twenty bytes
/// of hex under `bytes20`, and inferring from the text would silently produce a
/// different script for an argument that happens to look like the other.
pub fn parse_argument(parameter: &Parameter, raw: &str) -> Result<Argument> {
    let kind = parameter.kind.as_str();
    let name = &parameter.name;

    let expect_hex = |expected: Option<usize>| -> Result<Vec<u8>> {
        let text = raw.strip_prefix("0x").unwrap_or(raw);
        if text.len() % 2 != 0 || !text.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(CliError::Usage(format!(
                "{name} ({kind}) must be hex, got '{raw}'"
            )));
        }
        let bytes: Vec<u8> = (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect();
        if let Some(want) = expected {
            if bytes.len() != want {
                return Err(CliError::Usage(format!(
                    "{name} ({kind}) must be {want} bytes, got {}",
                    bytes.len()
                )));
            }
        }
        Ok(bytes)
    };

    match kind {
        "int" => raw
            .parse::<i64>()
            .map(Argument::Number)
            .map_err(|_| CliError::Usage(format!("{name} (int) must be a number, got '{raw}'"))),
        "bool" => match raw {
            "true" | "1" => Ok(Argument::Bool(true)),
            "false" | "0" => Ok(Argument::Bool(false)),
            _ => Err(CliError::Usage(format!(
                "{name} (bool) must be true or false, got '{raw}'"
            ))),
        },
        "pubkey" => Ok(Argument::Bytes(expect_hex(Some(33))?)),
        "sig" => Ok(Argument::Bytes(expect_hex(None)?)),
        "datasig" => Ok(Argument::Bytes(expect_hex(None)?)),
        "string" => Ok(Argument::Bytes(raw.as_bytes().to_vec())),
        "bytes" => Ok(Argument::Bytes(expect_hex(None)?)),
        other => {
            if let Some(size) = other.strip_prefix("bytes") {
                let want: usize = size.parse().map_err(|_| {
                    CliError::Usage(format!("{name} has an unrecognised type '{other}'"))
                })?;
                return Ok(Argument::Bytes(expect_hex(Some(want))?));
            }
            Err(CliError::Usage(format!(
                "{name} has an unsupported type '{other}'"
            )))
        }
    }
}

/// Assemble cashc's ASM into Script bytes.
///
/// The artifacts store `OP_DUP OP_HASH160 <hex> ...` rather than bytecode, so
/// this is the step that turns an artifact into something hashable.
pub fn assemble(asm: &str) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for token in asm.split_whitespace() {
        if let Some(name) = token.strip_prefix("OP_") {
            out.push(opcode(name).ok_or_else(|| {
                CliError::Protocol(format!("unknown opcode OP_{name} in the artifact"))
            })?);
            continue;
        }
        // Anything else is a hex literal to be pushed.
        if token.len() % 2 != 0 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(CliError::Protocol(format!(
                "'{token}' in the artifact is neither an opcode nor hex"
            )));
        }
        let bytes: Vec<u8> = (0..token.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&token[i..i + 2], 16).unwrap())
            .collect();
        out.extend_from_slice(&push_data(&bytes));
    }
    Ok(out)
}

/// The redeem script: constructor arguments, then the compiled contract.
///
/// Arguments go in **reverse** declaration order. That is not a stylistic
/// choice — it is what puts them on the stack in the order the compiled code
/// expects, and reversing it produces a valid-looking script that can never be
/// spent.
pub fn redeem_script(artifact: &Artifact, arguments: &[Argument]) -> Result<Vec<u8>> {
    if arguments.len() != artifact.constructor_inputs.len() {
        return Err(CliError::Usage(format!(
            "{} takes {} constructor argument(s), got {}",
            artifact.contract_name,
            artifact.constructor_inputs.len(),
            arguments.len()
        )));
    }
    let mut script = Vec::new();
    for argument in arguments.iter().rev() {
        script.extend_from_slice(&argument.encoded());
    }
    script.extend_from_slice(&assemble(&artifact.bytecode)?);
    Ok(script)
}

fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    let once = Sha256::digest(bytes);
    let twice = Sha256::digest(once);
    let mut out = [0u8; 32];
    out.copy_from_slice(&twice);
    out
}

/// The P2SH32 CashAddr for a redeem script.
///
/// P2SH32, not the older hash160 form: BCH added it because 160 bits is not a
/// comfortable margin for a script anyone can construct, and it is what the
/// desktop wallet uses. The version byte encodes both the type and the hash
/// length, which is why this cannot reuse the 20-byte address encoder.
pub fn p2sh32_address(script: &[u8], network: Network, token_aware: bool) -> String {
    let hash = double_sha256(script);
    // Type bits 3..7: 1 = P2SH, 3 = P2SH with tokens.
    //
    // Size bits 0..2 index 160, 192, 224, 256, 320, 384, 448, 512 bits, so
    // 256 is 3 — not 4. A wrong size bit yields a well-formed address with a
    // valid checksum that is not the contract's, which is the worst failure
    // available here: funds sent to it are unspendable and nothing looks off.
    let version = if token_aware {
        (3 << 3) | 3
    } else {
        (1 << 3) | 3
    };

    let mut payload = Vec::with_capacity(33);
    payload.push(version);
    payload.extend_from_slice(&hash);
    crate::cashaddr::encode_payload(network.prefix(), &payload)
}

/// The locking script an output pays to for a P2SH32 contract.
pub fn p2sh32_script_pubkey(script: &[u8]) -> Vec<u8> {
    let hash = double_sha256(script);
    let mut out = Vec::with_capacity(35);
    out.push(0xaa); // OP_HASH256
    out.extend_from_slice(&push_data(&hash));
    out.push(0x87); // OP_EQUAL
    out
}

/// cashc's opcode names, without the `OP_` prefix.
fn opcode(name: &str) -> Option<u8> {
    Some(match name {
        "0" | "FALSE" => 0x00,
        "PUSHDATA1" => 0x4c,
        "PUSHDATA2" => 0x4d,
        "PUSHDATA4" => 0x4e,
        "1NEGATE" => 0x4f,
        "RESERVED" => 0x50,
        "1" | "TRUE" => 0x51,
        "2" => 0x52,
        "3" => 0x53,
        "4" => 0x54,
        "5" => 0x55,
        "6" => 0x56,
        "7" => 0x57,
        "8" => 0x58,
        "9" => 0x59,
        "10" => 0x5a,
        "11" => 0x5b,
        "12" => 0x5c,
        "13" => 0x5d,
        "14" => 0x5e,
        "15" => 0x5f,
        "16" => 0x60,
        "NOP" => 0x61,
        "IF" => 0x63,
        "NOTIF" => 0x64,
        "ELSE" => 0x67,
        "ENDIF" => 0x68,
        "VERIFY" => 0x69,
        "RETURN" => 0x6a,
        "TOALTSTACK" => 0x6b,
        "FROMALTSTACK" => 0x6c,
        "2DROP" => 0x6d,
        "2DUP" => 0x6e,
        "3DUP" => 0x6f,
        "2OVER" => 0x70,
        "2ROT" => 0x71,
        "2SWAP" => 0x72,
        "IFDUP" => 0x73,
        "DEPTH" => 0x74,
        "DROP" => 0x75,
        "DUP" => 0x76,
        "NIP" => 0x77,
        "OVER" => 0x78,
        "PICK" => 0x79,
        "ROLL" => 0x7a,
        "ROT" => 0x7b,
        "SWAP" => 0x7c,
        "TUCK" => 0x7d,
        "CAT" => 0x7e,
        "SPLIT" => 0x7f,
        "NUM2BIN" => 0x80,
        "BIN2NUM" => 0x81,
        "SIZE" => 0x82,
        "INVERT" => 0x83,
        "AND" => 0x84,
        "OR" => 0x85,
        "XOR" => 0x86,
        "EQUAL" => 0x87,
        "EQUALVERIFY" => 0x88,
        "RESERVED1" => 0x89,
        "RESERVED2" => 0x8a,
        "1ADD" => 0x8b,
        "1SUB" => 0x8c,
        "2MUL" => 0x8d,
        "2DIV" => 0x8e,
        "NEGATE" => 0x8f,
        "ABS" => 0x90,
        "NOT" => 0x91,
        "0NOTEQUAL" => 0x92,
        "ADD" => 0x93,
        "SUB" => 0x94,
        "MUL" => 0x95,
        "DIV" => 0x96,
        "MOD" => 0x97,
        "LSHIFT" => 0x98,
        "RSHIFT" => 0x99,
        "BOOLAND" => 0x9a,
        "BOOLOR" => 0x9b,
        "NUMEQUAL" => 0x9c,
        "NUMEQUALVERIFY" => 0x9d,
        "NUMNOTEQUAL" => 0x9e,
        "LESSTHAN" => 0x9f,
        "GREATERTHAN" => 0xa0,
        "LESSTHANOREQUAL" => 0xa1,
        "GREATERTHANOREQUAL" => 0xa2,
        "MIN" => 0xa3,
        "MAX" => 0xa4,
        "WITHIN" => 0xa5,
        "RIPEMD160" => 0xa6,
        "SHA1" => 0xa7,
        "SHA256" => 0xa8,
        "HASH160" => 0xa9,
        "HASH256" => 0xaa,
        "CODESEPARATOR" => 0xab,
        "CHECKSIG" => 0xac,
        "CHECKSIGVERIFY" => 0xad,
        "CHECKMULTISIG" => 0xae,
        "CHECKMULTISIGVERIFY" => 0xaf,
        "NOP1" => 0xb0,
        "CHECKLOCKTIMEVERIFY" | "NOP2" => 0xb1,
        "CHECKSEQUENCEVERIFY" | "NOP3" => 0xb2,
        "NOP4" => 0xb3,
        "NOP5" => 0xb4,
        "NOP6" => 0xb5,
        "NOP7" => 0xb6,
        "NOP8" => 0xb7,
        "NOP9" => 0xb8,
        "NOP10" => 0xb9,
        "CHECKDATASIG" => 0xba,
        "CHECKDATASIGVERIFY" => 0xbb,
        "REVERSEBYTES" => 0xbc,
        // Native introspection (CHIP-2021-02), which is what most covenants
        // in this wallet are built on.
        "INPUTINDEX" => 0xc0,
        "ACTIVEBYTECODE" => 0xc1,
        "TXVERSION" => 0xc2,
        "TXINPUTCOUNT" => 0xc3,
        "TXOUTPUTCOUNT" => 0xc4,
        "TXLOCKTIME" => 0xc5,
        "UTXOVALUE" => 0xc6,
        "UTXOBYTECODE" => 0xc7,
        "OUTPOINTTXHASH" => 0xc8,
        "OUTPOINTINDEX" => 0xc9,
        "INPUTBYTECODE" => 0xca,
        "INPUTSEQUENCENUMBER" => 0xcb,
        "OUTPUTVALUE" => 0xcc,
        "OUTPUTBYTECODE" => 0xcd,
        "UTXOTOKENCATEGORY" => 0xce,
        "UTXOTOKENCOMMITMENT" => 0xcf,
        "UTXOTOKENAMOUNT" => 0xd0,
        "OUTPUTTOKENCATEGORY" => 0xd1,
        "OUTPUTTOKENCOMMITMENT" => 0xd2,
        "OUTPUTTOKENAMOUNT" => 0xd3,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_use_scripts_minimal_signed_encoding() {
        // Zero is empty, not a zero byte; the sign is the top bit of the last
        // byte; and a value already using that bit needs one more. Each of
        // these changes the redeem script, and so the address.
        assert_eq!(encode_number(0), Vec::<u8>::new());
        assert_eq!(encode_number(1), vec![0x01]);
        assert_eq!(encode_number(127), vec![0x7f]);
        assert_eq!(encode_number(128), vec![0x80, 0x00]);
        assert_eq!(encode_number(255), vec![0xff, 0x00]);
        assert_eq!(encode_number(256), vec![0x00, 0x01]);
        assert_eq!(encode_number(1000), vec![0xe8, 0x03]);
        assert_eq!(encode_number(-1), vec![0x81]);
        assert_eq!(encode_number(-127), vec![0xff]);
        assert_eq!(encode_number(-128), vec![0x80, 0x80]);
    }

    #[test]
    fn pushes_use_the_shortest_form() {
        // A non-minimal push hashes differently, so the contract would sit at
        // an address nobody else derives.
        assert_eq!(push_data(&[]), vec![0x00]);
        assert_eq!(push_data(&[0x05]), vec![0x55]); // OP_5
        assert_eq!(push_data(&[0x81]), vec![0x4f]); // OP_1NEGATE
        assert_eq!(push_data(&[0x20]), vec![0x01, 0x20]);
        assert_eq!(push_data(&[0xaa; 20])[0], 20);
        assert_eq!(push_data(&[0xaa; 75])[0], 75);
        assert_eq!(push_data(&[0xaa; 76])[0..2], [0x4c, 76]);
        assert_eq!(push_data(&[0xaa; 256])[0..3], [0x4d, 0x00, 0x01]);
    }

    #[test]
    fn assembles_opcodes_and_hex_literals() {
        assert_eq!(assemble("OP_DUP OP_HASH160").unwrap(), vec![0x76, 0xa9]);
        assert_eq!(
            assemble("OP_1 OP_2 OP_ADD").unwrap(),
            vec![0x51, 0x52, 0x93]
        );
        // A bare hex token is data to push, not an opcode.
        assert_eq!(assemble("6a").unwrap(), vec![0x01, 0x6a]);
        assert_eq!(assemble("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn an_unknown_opcode_is_refused_rather_than_skipped() {
        // Silently dropping a token would produce a script that hashes to an
        // address with no spending path.
        assert!(assemble("OP_TELEPORT").is_err());
        assert!(assemble("nothex").is_err());
    }

    #[test]
    fn introspection_opcodes_assemble() {
        // Most covenants here are built on CHIP-2021-02 introspection; without
        // these the artifacts do not assemble at all.
        assert_eq!(assemble("OP_UTXOVALUE").unwrap(), vec![0xc6]);
        assert_eq!(assemble("OP_OUTPUTBYTECODE").unwrap(), vec![0xcd]);
        assert_eq!(assemble("OP_ACTIVEBYTECODE").unwrap(), vec![0xc1]);
    }

    #[test]
    fn the_wrong_number_of_constructor_arguments_is_refused() {
        let artifact = Artifact {
            contract_name: "T".into(),
            constructor_inputs: vec![Parameter {
                name: "a".into(),
                kind: "int".into(),
            }],
            abi: vec![],
            bytecode: "OP_1".into(),
            compiler: None,
        };
        assert!(redeem_script(&artifact, &[]).is_err());
        assert!(redeem_script(&artifact, &[Argument::Number(1), Argument::Number(2)]).is_err());
        assert!(redeem_script(&artifact, &[Argument::Number(1)]).is_ok());
    }

    #[test]
    fn constructor_arguments_are_pushed_in_reverse() {
        // Reversing this produces a script that looks fine and can never be
        // spent, because the compiled code pops them in the other order.
        let artifact = Artifact {
            contract_name: "T".into(),
            constructor_inputs: vec![
                Parameter {
                    name: "first".into(),
                    kind: "int".into(),
                },
                Parameter {
                    name: "second".into(),
                    kind: "int".into(),
                },
            ],
            abi: vec![],
            bytecode: "OP_ADD".into(),
            compiler: None,
        };
        let script = redeem_script(&artifact, &[Argument::Number(1), Argument::Number(2)]).unwrap();
        // OP_2 then OP_1 then OP_ADD.
        assert_eq!(script, vec![0x52, 0x51, 0x93]);
    }

    #[test]
    fn arguments_are_parsed_against_the_declared_type() {
        // '1000' is a number under int and hex under bytes20; inferring from
        // the text would produce a different script for the same input.
        let int = Parameter {
            name: "n".into(),
            kind: "int".into(),
        };
        let pk = Parameter {
            name: "p".into(),
            kind: "pubkey".into(),
        };
        let b20 = Parameter {
            name: "b".into(),
            kind: "bytes20".into(),
        };

        assert!(matches!(
            parse_argument(&int, "1000").unwrap(),
            Argument::Number(1000)
        ));
        assert!(parse_argument(&int, "ff").is_err());
        assert!(parse_argument(&pk, &"11".repeat(33)).is_ok());
        assert!(
            parse_argument(&pk, &"11".repeat(20)).is_err(),
            "a pubkey is 33 bytes"
        );
        assert!(parse_argument(&b20, &"22".repeat(20)).is_ok());
        assert!(parse_argument(&b20, &"22".repeat(19)).is_err());
        assert!(parse_argument(&b20, "0x".to_string().as_str()).is_err());
    }

    #[test]
    fn the_p2sh32_version_byte_encodes_type_and_length() {
        // 256 bits is size index 3, not 4. A wrong size bit produces a
        // well-formed address with a valid checksum that is not the
        // contract's — funds sent there are unspendable, and nothing about
        // the address looks wrong.
        for (token_aware, expected) in [(false, 0x0b_u8), (true, 0x1b_u8)] {
            let address = p2sh32_address(&[0x51], Network::Mainnet, token_aware);
            let payload = crate::cashaddr::decode_payload(&address).unwrap();
            assert_eq!(payload[0], expected);
            assert_eq!(payload.len() - 1, 32, "a 32-byte hash");
            assert_eq!(payload[0] & 0x07, 3, "size bits say 256");
        }
    }

    #[test]
    fn the_locking_script_is_hash256_equal() {
        let script = p2sh32_script_pubkey(&[0x51]);
        assert_eq!(script[0], 0xaa, "OP_HASH256");
        assert_eq!(script[1], 32, "a 32-byte push");
        assert_eq!(script[34], 0x87, "OP_EQUAL");
        assert_eq!(script.len(), 35);
    }
}
