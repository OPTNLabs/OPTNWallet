"""Let SeedCash's crypto modules import on a desktop.

SeedCash targets a Raspberry Pi, so its BIP39 wordlist loader sits behind a GUI
module that transitively imports GPIO and SPI display drivers. Only those
hardware leaves are stubbed. Every line that touches key derivation, sighash
construction and signing is SeedCash's own code, unmodified — which is the
whole point: this harness is evidence about the real signer, not about a
reimplementation of it.
"""

import sys
import types
from unittest.mock import MagicMock

SEEDCASH_SRC = r"D:\OPTN wallet work\seedcash\src"

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


def install(seedcash_src: str = SEEDCASH_SRC) -> None:
    for name in HARDWARE_MODULES:
        if name not in sys.modules:
            module = MagicMock()
            module.__name__ = name
            module.__spec__ = types.SimpleNamespace(name=name)
            sys.modules[name] = module
    if seedcash_src not in sys.path:
        sys.path.insert(0, seedcash_src)
