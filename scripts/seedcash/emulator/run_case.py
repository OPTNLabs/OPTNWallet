"""Run one OPTN PSBT through the SeedCash emulator, from the wallet menu.

    python run_case.py <case> [--no-sign]

Shows OPTN's UR frames to the camera, opens Sign Transaction, captures every
review screen into screens/<case>/, signs, then records the animated signed
QR and decodes its UR parts into signed/<case>.json. Leaves SeedCash back at
the wallet menu.
"""

import json
import os
import re
import socket
import sys
import time
from pathlib import Path

# See harness.py: pyzbar's Windows zbar needs msvcr120.dll.
_VC120 = "C:/Program Files/Microsoft Office/root/vfs/System"
if os.name == "nt" and os.path.isdir(_VC120):
    os.add_dll_directory(_VC120)
import pyzbar.pyzbar as zbar  # noqa: E402
from PIL import Image  # noqa: E402

# The lab folder the harness was started with (screens/, cam/<case>/,
# emu.log); defaults to this script's folder.
LAB = Path(os.environ.get("SEEDCASH_LAB", Path(__file__).resolve().parent))
CASE = sys.argv[1]
SIGN = "--no-sign" not in sys.argv
OUT = LAB / "screens" / CASE
OUT.mkdir(parents=True, exist_ok=True)
(LAB / "signed").mkdir(exist_ok=True)


def send(line: str) -> str:
    with socket.create_connection(("127.0.0.1", 8765), timeout=30) as conn:
        conn.sendall((line + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
    return data.decode().strip()


def view() -> str:
    text = (LAB / "emu.log").read_text(encoding="utf-8", errors="replace")
    found = re.findall(r"Executing ([A-Za-z]+)\(", text)
    return found[-1] if found else ""


def shot(name: str) -> Path:
    return Path(send(f"shot {CASE}/{name}"))


def wait_out(*views, timeout=60):
    end = time.time() + timeout
    while time.time() < end and view() in views:
        time.sleep(0.5)
    return view()


log = []
assert view() == "WalletOptionsView", f"start from the wallet menu, not {view()}"
send(f"camera {LAB / 'cam' / CASE}")
for _ in range(5):
    send("press UP")
for _ in range(3):
    send("press DOWN")
send("press PRESS")
v = wait_out("WalletOptionsView", "ScanPSBTView", "LoadingPSBTView")
step = 0
while step < 40:
    time.sleep(1.0)
    v = view()
    path = shot(f"{step:02d}-{v}")
    log.append({"step": step, "view": v, "screen": path.name})
    if v in ("PSBTConfirmationView", "ErrorView", "UnhandledExceptionView") or not v.startswith(("PSBT", "BCHPSBT", "Token", "CashToken")):
        if v not in ("PSBTConfirmationView",):
            break
    if v == "PSBTConfirmationView":
        break
    send("press PRESS")
    step += 1

result = {"case": CASE, "screens": log, "final_view": view()}
if SIGN and view() == "PSBTConfirmationView":
    send("press PRESS")
    wait_out("PSBTConfirmationView", timeout=30)
    result["signed_view"] = view()
    parts = {}
    for i in range(120):
        image = shot(f"qr-{i:03d}")
        for code in zbar.decode(Image.open(image)):
            parts[code.data.decode()] = True
        time.sleep(0.25)
    for path in OUT.glob("qr-*.png"):
        path.unlink()
    shot("signed-qr-sample")
    result["signed_parts"] = list(parts)
    send("press PRESS")
    wait_out("PSBTSignedQRDisplayView", timeout=30)
elif view() not in ("WalletOptionsView",):
    # Not signable: go back to the wallet menu.
    for _ in range(8):
        if view() == "WalletOptionsView":
            break
        send("press PRESS" if view() == "ErrorView" else "press LEFT")
        time.sleep(1.0)

result["end_view"] = view()
(LAB / "signed" / f"{CASE}.json").write_text(json.dumps(result, indent=1))
print(json.dumps({k: (v if k != "signed_parts" else len(v)) for k, v in result.items() if k != "screens"}))
print(" -> ".join(s["view"] for s in log))
