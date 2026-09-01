"""Let SeedCash's cryptographic modules import on a desktop/CI runner.

SeedCash targets Raspberry Pi hardware. The signing path only needs its own
BIP39/BIP32/PSBT/signing modules plus the BIP39 wordlist; importing the normal
GUI wordlist helper would transitively pull display/camera/GPIO drivers.

This shim therefore:
- resolves SeedCash from SEEDCASH_SRC (CI) or an explicit argument;
- stubs hardware-only Python modules;
- provides only seedcash.gui.components.load_txt, reading SeedCash's real
  resource files from the pinned checkout.

No key derivation, transaction parsing, sighash construction, or signing logic
is reimplemented here.
"""

from __future__ import annotations

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


def _resolve_seedcash_src(seedcash_src: str | None) -> Path:
    candidate = seedcash_src or os.environ.get("SEEDCASH_SRC")
    if not candidate:
        raise RuntimeError(
            "SeedCash source is not configured. Set SEEDCASH_SRC to the "
            "pinned SeedCash checkout's src directory."
        )
    path = Path(candidate).expanduser().resolve()
    package = path / "seedcash"
    if not package.is_dir():
        raise RuntimeError(f"SEEDCASH_SRC does not contain seedcash/: {path}")
    return path


def _install_wordlist_loader(seedcash_src: Path) -> None:
    module_name = "seedcash.gui.components"
    if module_name in sys.modules:
        return

    module = types.ModuleType(module_name)
    resources = seedcash_src / "seedcash" / "resources"

    def load_txt(file_name: str) -> list[str]:
        path = resources / file_name
        with path.open("r", encoding="utf-8") as handle:
            return [line.strip() for line in handle if line.strip()]

    module.load_txt = load_txt
    module.__file__ = str(seedcash_src / "seedcash" / "gui" / "components.py")
    module.__package__ = "seedcash.gui"
    sys.modules[module_name] = module


def install(seedcash_src: str | None = None) -> None:
    resolved = _resolve_seedcash_src(seedcash_src)

    for name in HARDWARE_MODULES:
        if name not in sys.modules:
            module = MagicMock()
            module.__name__ = name
            module.__spec__ = types.SimpleNamespace(name=name)
            sys.modules[name] = module

    source = str(resolved)
    if source not in sys.path:
        sys.path.insert(0, source)

    _install_wordlist_loader(resolved)
