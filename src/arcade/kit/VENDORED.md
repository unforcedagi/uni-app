Vendored from taste-arcade a8bab66 (MIT, see LICENSE). Do not edit here: run scripts/sync-arcade.sh.
Local fix on top of that, not yet in the library: games/Ripple.tsx lets the mic go when you leave while it opens. Apply it there before the next sync, or the sync undoes it (scripts/browser/arcade.spec.ts goes red if so).
