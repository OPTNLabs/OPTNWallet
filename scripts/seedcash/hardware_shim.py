"""Let SeedCash's crypto modules import on a desktop.

SeedCash targets a Raspberry Pi, so its BIP39 wordlist loader sits behind a GUI
module that transitively imports GPIO and SPI display drivers. Only those
hardware leaves are stubbed. Every line that touches key derivation, sighash
construction and signing is SeedCash's own code, unmodified — which is the
whole point: this harness is evidence about the real signer, not about a
reimplementation of it.
"""

import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

HARDWARE_MODULES = [
    "RPi",
    "RPi.GPIO",
    "spidev",
    "board",
    "digitalio",
    "picamera",
    "picamera.array",
    "picamera2",
    "gpiozero",
    "smbus",
    "smbus2",
]


def install(seedcash_src: str | None = None) -> None:
    source = seedcash_src or os.environ.get("SEEDCASH_SRC")
    if not source:
        raise RuntimeError(
            "Set SEEDCASH_SRC to the official SeedCash repository's src directory."
        )
    source_path = str(Path(source).resolve())
    if not Path(source_path, "seedcash").is_dir():
        raise RuntimeError(f"SEEDCASH_SRC does not contain seedcash/: {source_path}")
    for name in HARDWARE_MODULES:
        if name not in sys.modules:
            module = MagicMock()
            module.__name__ = name
            module.__spec__ = types.SimpleNamespace(name=name)
            sys.modules[name] = module
    if source_path not in sys.path:
        sys.path.insert(0, source_path)
