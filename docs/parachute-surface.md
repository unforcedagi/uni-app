# Parachute surface — Release A

Uni can browse, search, create and edit Parachute notes. Every vault operation is
a Tauri command backed by `uni_core::parachute::VaultClient`. Rust signs each hub
`/mcp` JSON-RPC request with the device's Nostr key (NIP-98); no vault tokens,
secrets or hub fetches enter the WebView.

- **Vaults:** the sidebar discovers readable vaults with an unscoped
  `query-notes` request. Vault tabs persist with the other tabs. Refresh retries
  discovery; empty successful discovery falls back to the configured vault. Path lists
  are cached per vault across tab switches and invalidated by Refresh, create or save.
- **Tree:** `vault_paths` requests pages of 500 paths without content or metadata,
  stopping on a short page or at 20,000 rows. The UI warns at the cap. Filtering
  is a local, case-insensitive substring match; folders sort first. A note whose
  path also has children appears as the folder's index entry. Expanded folders
  persist per vault in `uni.vaultExpanded.v1:<vault>`. Path-less notes appear under
  `(unfiled)` using their IDs. Malformed rows are skipped; duplicate paths retain
  every note, labelled with extension and ID. Filtering is deferred, expands
  folders only from two characters, and renders at most 2,000 rows.
- **Search:** Meaning remains the default. Keyword skips semantic search.
  A vault dropdown and optional path-prefix filter apply to notes, including keyword
  fallback; message search stays local. Folder search fills the vault and a
  slash-terminated prefix to avoid matching sibling folder names. Transport/auth
  failures surface immediately; semantic tool failures retain keyword fallback.
- **Editing:** md, txt, csv, json, yaml, yml and mdx use a full-pane text editor.
  Cmd/Ctrl-S saves; Escape leaves a clean editor. Cancel asks before discarding
  changes. Drafts retain their original content and `updatedAt` revision under
  `uni.noteDraft.v1:<vault>:<id>`; reopening restores unsaved work and notices a
  changed server revision. A session copy survives tab switches when storage is
  unavailable. Storage writes debounce for 300 ms; blur, save, unmount and beforeunload flush
  immediately. Drafts clear on successful save or explicit discard; a late save
  preserves a newer draft and reports its actual remaining dirty state.
- **Conflicts:** normal saves send `if_updated_at`. Rust maps conflict errors to
  `conflict:` only for JSON-RPC `error.data.error_type == "conflict"`, or in-band
  tool errors starting with `conflict: note` after an optional numeric MCP error
  prefix. HTTP and transport errors never become conflicts. The editor keeps the draft and offers **Copy mine & reload theirs**
  (only reloads after copying succeeds) or **Overwrite**, with an explicit second
  confirmation. Notes without a revision timestamp also offer confirmed Overwrite. Overwrite sends `force: true` and omits `if_updated_at`.
- **Tabs:** dirty notes show a dot. Closing, replacing, or evicting a dirty tab
  asks for confirmation and retains its draft. The existing recorder stays in
  place and keeps its recording origin across tab switches. Resolved path-to-ID
  aliases persist; dirty checks inspect every stacked note and the persisted tab.
  Recording tabs survive eviction, and the Stop pill remains accessible over dialogs.
- **Creation:** New note here/New note opens a path prompt, then creates with
  `if_exists: "error"` and opens an editor tab. Both client and server reject
  blank paths, paths over 512 UTF-8 bytes, leading slashes, empty segments,
  `.`/`..` segments, segment-edge whitespace, backslashes and ASCII control
  characters. Creation reports its path even if opening the tab is cancelled.
  Forgetting identity clears note drafts, aliases and saved folder expansions.
- **Backlinks:** Linked from uses inbound rows from `vault_note`'s hydrated
  `links`. Source paths fall back to IDs when summaries are absent. Source links
  navigate in the current note tab's Back stack. Outbound rows are excluded.

## Verification

Run `pnpm typecheck`, `pnpm test`, `pnpm build:vite`,
`cargo test -q -p uni-core`, and `cargo check -q -p uni-app-tauri`.
Pure tests cover tabs, trees, drafts/conflicts, validation and backlink extraction.
Rust tests cover request arguments, discovery, signed pagination and scoped
semantic-to-keyword fallback through a local scripted MCP server.

The live probe is opt-in and requires `UNI_NSEC` already set in the environment:

```sh
cargo run -p uni-core --example surface_probe -- https://your-hub scope-test
```

It lists paths, creates `Probe/<unix>-surface`, saves an edit using its revision,
attempts a stale save and requires a `conflict:` error, then fetches backlinks.
It leaves the probe note for inspection. It writes only to the explicit command
line vault, accepts only `scope-test` or names starting with `scope-test`, and
never prints the key. Unit tests cannot establish live hub permissions or device WebView behavior;
use a disposable vault and actual desktop/mobile devices for those checks.
