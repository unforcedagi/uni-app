#!/usr/bin/env python3
"""Reconnect paired Daylight wireless ADB when its connect port changes.

A pairing code is not needed after initial pairing; if wireless debugging is off
there is no remotely reachable port and the caller will publish only.
"""
import asyncio
from pathlib import Path
import re
import subprocess

HOST = "100.114.25.16"
CONF = Path.home() / ".config/uni/adb-devices"


def existing_port():
    for line in CONF.read_text().splitlines():
        match = re.match(r"^daylight\s+100\.114\.25\.16:(\d+)\s*$", line)
        if match:
            return int(match.group(1))
    return None


async def probe(port, semaphore):
    async with semaphore:
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(HOST, port), timeout=1.2)
            writer.close()
            await writer.wait_closed()
            return port
        except (OSError, asyncio.TimeoutError):
            return None


async def find_port():
    sem = asyncio.Semaphore(700)
    # Check the old port first. Wireless debugging advertises a new random port
    # after toggles, so discover it across the tailnet when needed.
    old = existing_port()
    if old and await probe(old, sem):
        return old
    pending = {asyncio.create_task(probe(p, sem)) for p in range(30000, 50000)}
    try:
        for completed in asyncio.as_completed(pending):
            port = await completed
            if port:
                return port
    finally:
        for task in pending:
            task.cancel()
    return None


def main():
    listing = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=10).stdout
    if re.search(r"^100\.114\.25\.16:\d+\s+device$", listing, re.M):
        print("Daylight already connected")
        return
    port = asyncio.run(find_port())
    if port is None:
        print("Daylight wireless ADB offline; leaving the APK for in-app download")
        return
    result = subprocess.run(["adb", "connect", f"{HOST}:{port}"], capture_output=True, text=True, timeout=15)
    if result.returncode == 0 and "connected" in result.stdout.lower():
        text = CONF.read_text()
        text = re.sub(r"^daylight\s+100\.114\.25\.16:\d+\s*$", f"daylight {HOST}:{port}", text, flags=re.M)
        CONF.write_text(text)
        print(f"Daylight ADB connected on port {port}")
    else:
        print("Daylight ADB port found but connection failed")


if __name__ == "__main__":
    main()
