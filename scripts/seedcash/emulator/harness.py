"""Run the SeedCash emulator with a scriptable camera, buttons and screen.

    python emu_harness.py <seedcash src dir> <lab dir> [port]

SeedCash runs unmodified apart from the emulator overlay. Three things are
added from outside, for automation only:

- Camera: cv2.VideoCapture is replaced by a virtual camera that shows the
  PNG frames last loaded with `camera <dir>`, in a loop, as a phone held up
  to the device would. SeedCash's own frame handling and QR decoding run on
  them.
- Screen: every image SeedCash sends to the display is kept; `shot <name>`
  writes the current one to <lab>/screens/<name>.png.
- Buttons: `press <UP|DOWN|LEFT|RIGHT|PRESS|KEY1|KEY2|KEY3>` raises and then
  lowers that GPIO pin, as a finger on the joystick would.

Commands arrive one per line on a localhost TCP port (default 8765).
"""

import os
import socket
import sys
import threading
import time
from pathlib import Path

SRC = Path(sys.argv[1]).resolve()
LAB = Path(sys.argv[2]).resolve()
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8765
os.chdir(SRC)
sys.path.insert(0, str(SRC))
(LAB / "screens").mkdir(parents=True, exist_ok=True)

# pyzbar's Windows libzbar needs the Visual C++ 2013 runtime (msvcr120.dll),
# which a Windows machine may have only inside Microsoft Office. Let this
# process load it from there; nothing is installed. Elsewhere, install
# libzbar0 (or the Visual C++ 2013 runtime) instead.
_VC120 = "C:/Program Files/Microsoft Office/root/vfs/System"
if os.name == "nt" and os.path.isdir(_VC120):
    os.add_dll_directory(_VC120)

import pyzbar.pyzbar as _pyzbar  # noqa: E402

_zbar_decode = _pyzbar.decode


def _decode_without_binary_mode(image, symbols=None, binary=False, **kwargs):
    """SeedCash asks zbar for binary mode (the emulator's pyzbar fork), which
    the Windows wheel's zbar 0.10 lacks. Every QR in this lab is numeric
    (Standard SeedQR) or alphanumeric (UR), where text and binary decoding
    yield the same bytes. A Compact SeedQR would need the real binary mode."""
    return _zbar_decode(image, symbols=symbols, **kwargs)


_pyzbar.decode = _decode_without_binary_mode

import cv2  # noqa: E402
import numpy as np  # noqa: E402

BLANK = np.full((480, 480, 3), 200, dtype=np.uint8)


class VirtualCamera:
    """Stands in for cv2.VideoCapture(0)."""

    frames: list = []

    def __init__(self, *_args, **_kwargs):
        self.index = 0

    def isOpened(self):
        return True

    def set(self, *_args):
        return True

    def read(self):
        time.sleep(0.12)
        frames = VirtualCamera.frames
        if not frames:
            return True, BLANK.copy()
        frame = frames[self.index % len(frames)]
        self.index += 1
        return True, frame.copy()

    def release(self):
        pass


cv2.VideoCapture = VirtualCamera

from seedcash.emulator import desktopDisplay as dd  # noqa: E402
from seedcash.emulator.virtualGPIO import GPIO  # noqa: E402
from seedcash.hardware.buttons import HardwareButtons  # noqa: E402

LATEST = {"image": None, "count": 0}
_show = dd.desktopDisplay.ShowImage


def show_and_keep(self, image, x, y):
    LATEST["image"] = image.copy()
    LATEST["count"] += 1
    return _show(self, image, x, y)


dd.desktopDisplay.ShowImage = show_and_keep

PINS = {
    "UP": HardwareButtons.KEY_UP_PIN,
    "DOWN": HardwareButtons.KEY_DOWN_PIN,
    "LEFT": HardwareButtons.KEY_LEFT_PIN,
    "RIGHT": HardwareButtons.KEY_RIGHT_PIN,
    "PRESS": HardwareButtons.KEY_PRESS_PIN,
    "KEY1": HardwareButtons.KEY1_PIN,
    "KEY2": HardwareButtons.KEY2_PIN,
    "KEY3": HardwareButtons.KEY3_PIN,
}


def load_frames(directory: str):
    if directory == "none":
        VirtualCamera.frames = []
        return 0
    paths = sorted(Path(directory).glob("*.png"))
    VirtualCamera.frames = [cv2.imread(str(p)) for p in paths]
    return len(VirtualCamera.frames)


def handle(line: str) -> str:
    parts = line.strip().split(maxsplit=1)
    if not parts:
        return "empty"
    cmd, arg = parts[0], (parts[1] if len(parts) > 1 else "")
    if cmd == "press":
        pin = PINS[arg.upper()]
        GPIO.set_input(pin, GPIO.HIGH)
        time.sleep(0.15)
        GPIO.set_input(pin, GPIO.LOW)
        time.sleep(0.35)
        return f"pressed {arg}"
    if cmd == "camera":
        return f"camera frames={load_frames(arg)}"
    if cmd == "shot":
        image = LATEST["image"]
        if image is None:
            return "no screen yet"
        path = LAB / "screens" / f"{arg}.png"
        image.save(path)
        return str(path)
    if cmd == "count":
        return str(LATEST["count"])
    return f"unknown {cmd}"


def serve():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", PORT))
    server.listen()
    while True:
        conn, _ = server.accept()
        with conn:
            data = b""
            while not data.endswith(b"\n"):
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            try:
                reply = handle(data.decode())
            except Exception as error:  # report, never kill the device
                reply = f"error {type(error).__name__}: {error}"
            conn.sendall((reply + "\n").encode())


threading.Thread(target=serve, daemon=True).start()

import main as seedcash_main  # noqa: E402

seedcash_main.main([])
