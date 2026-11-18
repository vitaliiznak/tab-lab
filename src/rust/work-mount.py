#!/usr/bin/python3
"""Guest launcher for the live editor's 9p mount."""
import ctypes
import os
import re
import socket
import sys

# Other mounts continue through the image's standard kw9p client.
if len(sys.argv) != 3 or sys.argv[2] != "/work":
    os.execv("/usr/bin/kw9p", ["kw9p", *sys.argv[1:]])
name = sys.argv[1]
if not re.fullmatch("[A-Za-z0-9_-]+", name):
    raise ValueError("Invalid 9p export name")
os.makedirs("/work", exist_ok=True)
# The normal mount's one-second 9p attribute cache can make Cargo run an
# older program immediately after a host edit. Disable it for /work only.
with socket.socket(getattr(socket, "AF_VSOCK", 40), socket.SOCK_STREAM) as stream:
    stream.connect((2, 564))
    fd = stream.fileno()
    options = (f"trans=fd,rfdno={fd},wfdno={fd},version=9p2000.L,aname={name},"
               "cache=none,metatimeout=0,noxattr,access=client,msize=131072")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.mount(f"kw9p:{name}".encode(), b"/work", b"9p", 0, options.encode()) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
