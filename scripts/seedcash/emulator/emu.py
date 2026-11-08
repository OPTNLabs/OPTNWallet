"""Send commands to the emulator harness.  python emu.py <cmd> [<cmd> ...]

Each argument is one command line, e.g. `press DOWN` or `shot home`.
"""

import socket
import sys

PORT = 8765


def send(line: str) -> str:
    with socket.create_connection(("127.0.0.1", PORT), timeout=30) as conn:
        conn.sendall((line + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
    return data.decode().strip()


for command in sys.argv[1:]:
    print(f"{command} -> {send(command)}")
