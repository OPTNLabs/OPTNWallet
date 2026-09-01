"""Sign a PSBT with the real SeedCash signer, for round-trip evidence.

This is the offline half of the Issue #8 air-gapped flow, driven directly
instead of through the device UI. OPTN builds the PSBT, this signs it with
SeedCash's own `sign_psbt_with_xpriv`, and OPTN then verifies and finalizes
what comes back. If the two sides disagree about signature algorithm, sighash
type or derivation metadata, this is where it shows up.

Usage:
    python sign_psbt.py keys
    python sign_psbt.py sign <unsigned-psbt-hex-file> <signed-psbt-hex-file>

The mnemonic is the published BIP39 all-`abandon` test vector. It holds no
funds we care about and nothing here is ever broadcast.
"""

import json
import sys

import hardware_shim

hardware_shim.install()


def _signer_imports():
    """Import the signing API exposed by the pinned SeedCash revision."""
    from seedcash.models.bip39 import Bip39  # noqa: E402
    from seedcash.models.psbt_parser import PSBTParser, parse_psbt  # noqa: E402
    from seedcash.models.wallet import Wallet  # noqa: E402
    return Bip39, PSBTParser, parse_psbt, Wallet


Bip39, PSBTParser, parse_psbt, Wallet = (
    (None, None, None, None)
    if len(sys.argv) >= 2 and sys.argv[1] == "decode-ur"
    else _signer_imports()
)

TEST_MNEMONIC = " ".join(["abandon"] * 11 + ["about"])
ACCOUNT_PATH = "m/44'/145'/0'"


def wallet_from(mnemonic: str) -> Wallet:
    master_key, master_code = Bip39.bip39_protocol(mnemonic, "")
    return Wallet(master_key, master_code)


def build_wallet() -> Wallet:
    return wallet_from(TEST_MNEMONIC)


def emit_keys() -> None:
    wallet = build_wallet()
    print(
        json.dumps(
            {
                "xpub": wallet._xpub,
                "fingerprint": wallet._fingerprint,
                "accountPath": ACCOUNT_PATH,
            }
        )
    )


def _partial_signature_count(psbt_bytes: bytes | bytearray) -> int:
    return sum(
        1
        for input_map in parse_psbt(bytes(psbt_bytes))["inputs"]
        for key, _ in input_map
        if key and key[0] == 0x02
    )


def sign(unsigned_path: str, signed_path: str) -> None:
    wallet = build_wallet()
    with open(unsigned_path, "r", encoding="utf-8") as handle:
        psbt_bytes = bytearray.fromhex(handle.read().strip())

    before = _partial_signature_count(psbt_bytes)
    parser = PSBTParser(psbt_bytes)
    signed = wallet.sign_psbt(parser)
    after = _partial_signature_count(signed)
    if after <= before:
        raise SystemExit(
            "SeedCash returned the PSBT without adding a partial signature. "
            "Check BIP32 derivation metadata and signer ownership."
        )

    with open(signed_path, "w", encoding="utf-8") as handle:
        handle.write(bytes(signed).hex())


def cosigner_mnemonic(index: int) -> str:
    """A distinct, deterministic throwaway seed per cosigner.

    Deterministic so a failing multisig round trip can be re-run and debugged
    with the same keys, rather than a fresh set each time.
    """
    words = ["abandon"] * 11
    tail = ["about", "abstract", "absurd", "abuse", "access"]
    return " ".join(words + [tail[index % len(tail)]])


def emit_cosigner_keys(count: int) -> None:
    out = []
    for index in range(count):
        wallet = wallet_from(cosigner_mnemonic(index))
        out.append({"xpub": wallet._xpub, "fingerprint": wallet._fingerprint})
    print(json.dumps(out))


def sign_as(index: int, unsigned_path: str, signed_path: str) -> None:
    """Sign every owned input as one deterministic multisig cosigner."""
    wallet = wallet_from(cosigner_mnemonic(index))
    with open(unsigned_path, "r", encoding="utf-8") as handle:
        psbt = bytearray.fromhex(handle.read().strip())

    before = _partial_signature_count(psbt)
    signed = wallet.sign_psbt(PSBTParser(psbt))
    after = _partial_signature_count(signed)
    if after <= before:
        raise SystemExit(
            f"SeedCash cosigner {index} returned no new partial signature."
        )

    with open(signed_path, "w", encoding="utf-8") as handle:
        handle.write(bytes(signed).hex())
    print(json.dumps({"fingerprint": wallet._fingerprint}))


def decode_ur(frames_path: str, out_path: str) -> None:
    """Reconstruct a PSBT from OPTN's UR frames using SeedCash's own decoder.

    The animated QR is the only channel between the two apps, so "our encoder
    and our decoder agree" proves nothing about whether the device can read
    what we display. This runs the frames through SeedCash's `URDecoder` — the
    same one `decode_qr.py` feeds from the camera.
    """
    from seedcash.helpers.ur2.ur_decoder import URDecoder

    decoder = URDecoder()
    with open(frames_path, "r", encoding="utf-8") as handle:
        frames = [line.strip() for line in handle if line.strip()]

    for frame in frames:
        decoder.receive_part(frame)
        if decoder.is_complete():
            break

    if not decoder.is_complete():
        raise SystemExit(
            f"SeedCash's decoder never completed after {len(frames)} frames."
        )

    message = decoder.result_message()
    raw = bytes(message.cbor)

    # Same path as SeedCash `decode_qr.py:get_data_psbt`: the UR CBOR field is
    # handed to parse_psbt. OPTN now emits the raw PSBT there (SeedCash's own
    # encode shape). A leftover Keystone wrap would start with a CBOR bstr
    # major type, not `psbt\xff`, and this helper must not hide that regression.
    if not raw.startswith(b"psbt\xff"):
        raise SystemExit(
            "SeedCash recovered UR CBOR that is not a PSBT "
            f"(prefix {raw[:8].hex()}). Encoder drifted back to a CBOR wrap."
        )

    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(raw.hex())
    print(
        json.dumps(
            {
                "frames": len(frames),
                "type": message.type,
                "cborPrefix": raw[:8].hex(),
            }
        )
    )


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "keys":
        emit_keys()
    elif len(sys.argv) == 3 and sys.argv[1] == "cosigner-keys":
        emit_cosigner_keys(int(sys.argv[2]))
    elif len(sys.argv) == 5 and sys.argv[1] == "sign-as":
        sign_as(int(sys.argv[2]), sys.argv[3], sys.argv[4])
    elif len(sys.argv) == 4 and sys.argv[1] == "decode-ur":
        decode_ur(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "sign":
        sign(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
