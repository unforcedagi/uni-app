#!/usr/bin/env python3
"""Run a copy of the mail bridge's server.py (T-45 tests): `run_mail_bridge.py <server.py>`.

The test gives it its own HOME (config, allowlist, a dead upstream), so it
never reads the live config or reaches Stalwart. If `coincurve` isn't
installed, a pure-Python BIP-340 verifier (the BIP's reference algorithm)
stands in for `coincurve.PublicKeyXOnly`; set UNI_BRIDGE_PYTHON to a Python
that has coincurve to use the real one.
"""
import hashlib
import runpy
import sys
import types

try:
    import coincurve  # noqa: F401
    print("bridge crypto: coincurve", file=sys.stderr, flush=True)
except ImportError:
    P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
    N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
         0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

    def add(a, b):
        if a is None:
            return b
        if b is None:
            return a
        if a[0] == b[0] and a[1] != b[1]:
            return None
        if a == b:
            lam = 3 * a[0] * a[0] * pow(2 * a[1], P - 2, P) % P
        else:
            lam = (b[1] - a[1]) * pow(b[0] - a[0], P - 2, P) % P
        x = (lam * lam - a[0] - b[0]) % P
        return (x, (lam * (a[0] - x) - a[1]) % P)

    def mul(pt, k):
        r = None
        for i in range(256):
            if (k >> i) & 1:
                r = add(r, pt)
            pt = add(pt, pt)
        return r

    def lift_x(x):
        if x >= P:
            return None
        y2 = (pow(x, 3, P) + 7) % P
        y = pow(y2, (P + 1) // 4, P)
        if pow(y, 2, P) != y2:
            return None
        return (x, y if y % 2 == 0 else P - y)

    def tagged(tag, msg):
        t = hashlib.sha256(tag.encode()).digest()
        return hashlib.sha256(t + t + msg).digest()

    class PublicKeyXOnly:
        def __init__(self, pk: bytes):
            self.pk, self.point = pk, lift_x(int.from_bytes(pk, "big")) if len(pk) == 32 else None
            if self.point is None:
                raise ValueError("bad public key")

        def verify(self, sig: bytes, msg: bytes) -> bool:
            if len(sig) != 64:
                return False
            r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
            if r >= P or s >= N:
                return False
            e = int.from_bytes(tagged("BIP0340/challenge", sig[:32] + self.pk + msg), "big") % N
            R = add(mul(G, s), mul(self.point, N - e))
            return R is not None and R[1] % 2 == 0 and R[0] == r

    sys.modules["coincurve"] = types.SimpleNamespace(PublicKeyXOnly=PublicKeyXOnly)
    print("bridge crypto: BIP-340 reference (no coincurve)", file=sys.stderr, flush=True)

runpy.run_path(sys.argv[1], run_name="__main__")
