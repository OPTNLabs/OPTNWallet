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

from seedcash.models.bip39 import Bip39  # noqa: E402
from seedcash.models.psbt_parser import (  # noqa: E402
    PSBTParser,
    parse_psbt,
    sign_psbt_with_xpriv,
)
from seedcash.models.wallet import Wallet  # noqa: E402

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


def sign(unsigned_path: str, signed_path: str) -> None:
    wallet = build_wallet()
    with open(unsigned_path, "r", encoding="utf-8") as handle:
        psbt_bytes = bytearray.fromhex(handle.read().strip())

    # Parse first, exactly as the device does before showing the review screen.
    # `_wallet_pubkeys_in_map` is the function that decides whether SeedCash
    # claims an input as its own — if it returns nothing, the device shows the
    # transaction as somebody else's and refuses to sign, which is the failure
    # this check is here to surface loudly.
    parser = PSBTParser(psbt_bytes, wallet_fingerprint=wallet._fingerprint)
    fingerprint_bytes = bytes.fromhex(wallet._fingerprint)
    claimed = [
        index
        for index, input_map in enumerate(parse_psbt(psbt_bytes)["inputs"])
        if PSBTParser._wallet_pubkeys_in_map(input_map, fingerprint_bytes)
    ]
    if not claimed:
        raise SystemExit(
            "SeedCash did not recognise any input as its own. The PSBT is "
            "missing or misencoding PSBT_IN_BIP32_DERIVATION (0x06) for "
            f"fingerprint {wallet._fingerprint}."
        )

    signed = sign_psbt_with_xpriv(psbt_bytes, wallet._xpriv, account_path=ACCOUNT_PATH)
    # sign_psbt_with_xpriv signs one input; the device loops every input.
    for index in range(1, parser.num_inputs):
        signed = sign_psbt_with_xpriv(
            signed, wallet._xpriv, input_index=index, account_path=ACCOUNT_PATH
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
    """Sign every input as one cosigner of a multisig wallet.

    SeedCash reads the redeem script from PSBT_IN_REDEEM_SCRIPT (0x04) and uses
    it as the scriptCode, which is what makes P2SH multisig work at all here.
    It takes the derivation path from the 0x06 records — every cosigner shares
    the same path, so it derives its own key at that path from its own xpriv.
    """
    wallet = wallet_from(cosigner_mnemonic(index))
    with open(unsigned_path, "r", encoding="utf-8") as handle:
        psbt = bytearray.fromhex(handle.read().strip())

    signed = psbt
    for input_index in range(parse_psbt(psbt)["input_count"]):
        signed = sign_psbt_with_xpriv(
            signed, wallet._xpriv, input_index=input_index, account_path=ACCOUNT_PATH
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

    # `ur:crypto-psbt` wraps the PSBT in a CBOR byte string (BCR-2020-006), so
    # `.cbor` is the wrapper, not the payload. SeedCash's `get_data_psbt()`
    # returns `.cbor` straight to its parser and therefore chokes on its own
    # decode — see the note in seedcashUrRoundtrip.test.ts. Unwrap it here so
    # the test can assert what the bytes on the wire actually are.
    from seedcash.helpers.ur2.cbor_lite import CBORDecoder

    payload, _ = CBORDecoder(raw).decodeBytes()

    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(bytes(payload).hex())
    print(
        json.dumps(
            {
                "frames": len(frames),
                "type": message.type,
                "cborPrefix": raw[: len(raw) - len(payload)].hex(),
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
