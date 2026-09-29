#!/usr/bin/env python3
"""Reconnect paired Android devices over wireless ADB (tailnet).

Devices are listed in ~/.config/uni/adb-devices as `name host:port` lines.
Wireless debugging picks a new random connect port after toggles, so when the
saved port is dead we scan the tailnet host and try `adb connect` on each open
port (the pairing port is also open but refuses a connect). Pairing codes are
never needed after the first pairing. Prints `name serial` per connected device.
"""
import asyncio
from pathlib import Path
import re
import subprocess

CONF = Path.home() / ".config/uni/adb-devices"
LINE = re.compile(r"^(\S+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s*$")


def devices():
    if not CONF.exists():
        return []
    return [(m[1], m[2], int(m[3])) for m in map(LINE.match, CONF.read_text().splitlines()) if m]


def adb(*args, timeout=15):
    return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout).stdout


def online(host):
    m = re.search(rf"^({re.escape(host)}:\d+)\s+device$", adb("devices", timeout=10), re.M)
    return m[1] if m else None


async def open_ports(host, first):
    sem = asyncio.Semaphore(700)

    async def probe(port):
        async with sem:
            try:
                _, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=1.2)
                w.close()
                return port
            except (OSError, asyncio.TimeoutError):
                return None

    if first and await probe(first):
        return [first]
    found = await asyncio.gather(*(probe(p) for p in range(30000, 50000)))
    return [p for p in found if p]


def save(name, host, port):
    text = CONF.read_text()
    text = re.sub(rf"^{re.escape(name)}\s+\S+\s*$", f"{name} {host}:{port}", text, flags=re.M)
    CONF.write_text(text)


def connect(name, host, saved):
    serial = online(host)
    if serial:
        return serial
    for port in asyncio.run(open_ports(host, saved)):
        adb("connect", f"{host}:{port}")
        serial = online(host)
        if serial:
            save(name, host, port)
            return serial
        adb("disconnect", f"{host}:{port}")
    return None


def main():
    for name, host, port in devices():
        serial = connect(name, host, port)
        print(f"{name} {serial}" if serial else f"{name} offline")


if __name__ == "__main__":
    main()
