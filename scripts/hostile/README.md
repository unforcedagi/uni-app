Hostile harnesses carried over from the T-73 reviews (review 1 and 2), ported to `src/interface`.
They need a built Chromium via the repo's Playwright and run with Node directly:

    cd scripts/hostile
    PCSP="frame-src about:" node --experimental-strip-types escape2.mjs   # network/nav vectors, host CSP on
    PCSP="frame-src about:" node --experimental-strip-types escape3.mjs   # child frames, preload nav, workers, prefetch…
    node --experimental-strip-types escape4.mjs                           # child-frame vectors inside a sealed frame
    node --experimental-strip-types turn-leak.mjs                         # TURN username through a srcdoc child (real UDP)
    node --experimental-strip-types shapes.mjs                            # 12 HTML shapes: the CSP meta is always first
    node --experimental-strip-types loads.mjs                             # which actions fire a second iframe load
    node --experimental-strip-types flood.mjs                             # host cost of junk / huge messages

Expected on stock Chromium: no HTTP hit anywhere; `childSrcdocRtc` and `turn-leak` DO reach the UDP port
(Chromium has WebRTC in child frames). That is the documented limit: the self-test's child-frame WebRTC
check keeps the gate closed there (see docs/interfaces.md). The e2e suite runs the same attack with WebRTC
off and asserts zero datagrams.
