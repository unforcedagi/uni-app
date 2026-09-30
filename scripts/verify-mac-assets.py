"""Verify both Mac archives' version and the updater's Minisign signature."""
import base64
import io
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import zipfile


def verify(root: Path, version: str, config: Path) -> None:
    expected = "Uni.app/Contents/Info.plist"
    with zipfile.ZipFile(root / "Uni-mac-arm64.zip") as archive:
        zip_plists = [n for n in archive.namelist() if n == expected]
        if len(zip_plists) != 1:
            raise ValueError("ZIP must contain exactly one Uni.app Info.plist")
        zip_plist = archive.read(expected)
    with tarfile.open(root / "Uni.app.tar.gz", "r:gz") as archive:
        plists = [m for m in archive if m.name.removeprefix("./") == expected and m.isfile()]
        if len(plists) != 1:
            raise ValueError("Updater tarball must contain exactly one Uni.app Info.plist")
        stream = archive.extractfile(plists[0])
        if stream is None:
            raise ValueError("Updater plist cannot be read")
        tar_plist = stream.read()
    for label, data in (("ZIP", zip_plist), ("updater tarball", tar_plist)):
        info = plistlib.load(io.BytesIO(data))
        if info.get("CFBundleShortVersionString") != version or info.get("CFBundleIdentifier") != "org.unforced.uni":
            raise ValueError(f"{label} version or bundle identifier does not match requested release")
    if zip_plist != tar_plist:
        raise ValueError("ZIP and updater tarball have different app Info.plist content")
    key = json.loads(config.read_text())["plugins"]["updater"]["pubkey"]
    public_key = base64.b64decode(key, validate=True)
    signature = base64.b64decode((root / "Uni.app.tar.gz.sig").read_text().strip(), validate=True)
    with tempfile.TemporaryDirectory() as temp:
        pub = Path(temp) / "pubkey"
        sig = Path(temp) / "signature"
        pub.write_bytes(public_key)
        sig.write_bytes(signature)
        subprocess.run(["minisign", "-Vm", str(root / "Uni.app.tar.gz"), "-p", str(pub), "-x", str(sig), "-q"], check=True)


if __name__ == "__main__":
    try:
        verify(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"Mac asset verification failed: {exc}") from exc
