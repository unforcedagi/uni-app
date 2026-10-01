# Parachute surface — Release A

Uni can browse, search, create and edit Parachute notes. Every vault operation is
a Tauri command backed by `uni_core::parachute::VaultClient`. Rust signs each hub
`/mcp` JSON-RPC request with the device's Nostr key (NIP-98); no vault tokens,
secrets or hub fetches enter the WebView.

- **Vaults:** the sidebar discovers readable vaults with an unscoped
  `query-notes` request. Vault tabs persist with the other tabs. Refresh retries
  discovery; each browser has a separate path refresh.
- **Tree:** `vault_paths` requests pages of 500 paths without content or metadata,
  stopping on a short page or at 20,000 rows. The UI warns at the cap. Filtering
  is a local, case-insensitive substring match; folders sort first. A note whose
  path also has children appears as the folder's index entry. Expanded folders
  persist per vault in `uni.vaultExpanded.v1:<vault>`.
- **Search:** Meaning remains the default. Keyword skips semantic search.
  Optional vault and path-prefix filters apply to notes, including keyword
  fallback; message search stays local. Folder search fills the vault and a
  slash-terminated prefix to avoid matching sibling folder names. Transport/auth
  failures surface immediately; semantic tool failures retain keyword fallback.
- **Editing:** md, txt, csv, json, yaml, yml and mdx use a full-pane text editor.
  Cmd/Ctrl-S saves; Escape leaves a clean editor. Cancel asks before discarding
  changes. Drafts retain their original content and `updatedAt` revision under
  `uni.noteDraft.v1:<vault>:<id>`; reopening restores unsaved work and notices a
  changed server revision. A session copy survives tab switches when storage is
  unavailable. Drafts clear on successful save or explicit discard.
- **Conflicts:** normal saves send `if_updated_at`. Rust maps conflict errors to
  `conflict:`. The editor keeps the draft and offers **Copy mine & reload theirs**
  (only reloads after copying succeeds) or **Overwrite**, with an explicit second
  confirmation. Overwrite sends `force: true` and omits `if_updated_at`.
- **Tabs:** dirty notes show a dot. Closing, replacing, or evicting a dirty tab
  asks for confirmation and retains its draft. The existing recorder stays in
  place and keeps its recording origin across tab switches.
- **Creation:** New note here/New note opens a path prompt, then creates with
  `if_exists: "error"` and opens an editor tab. Both client and server reject
  blank paths, paths over 512 UTF-8 bytes, leading slashes, empty segments,
  `..` segments and NUL characters.
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
line vault, refuses `uni` and `unforced` (case-insensitive), and never prints the
key. Unit tests cannot establish live hub permissions or device WebView behavior;
use a disposable vault and actual desktop/mobile devices for those checks.
