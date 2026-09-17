# Open-draft tools (fork 0.8.0)

The MCP server exposes `listComposeWindows`, `getComposeWindow`, `updateComposeWindow`, and `saveComposeWindow`. The host adapter uses Thunderbird's native compose API through the extension's API manager. Each accessible native window receives an opaque session ID. Reads return a revision tied to the current compose details, attachment metadata, source URI and saved-draft URI.

Updates require the observed revision and serialize per window. The adapter checks current identity/account access, rejects busy windows, and holds Thunderbird's editor lock while checking the revision and applying a partial field update. Only subject, address arrays and the body in its existing format are writable. Unspecified fields, attachments and native threading remain untouched. A body replacement includes the entire body; callers must retain signatures and quotes when appropriate.

Saving checks the revision, releases the editing lock immediately before calling native `saveMessage` with mode `draft`, and returns the native receipt. It never calls a send API. IDs and revisions are not durable across extension reloads; closed or inaccessible windows cannot be edited. This is optimistic concurrency against user edits, not a transaction shared with other extensions that might also change the composer.

## Validation, 2026-09-17

- `npm test`: 593 tests, 576 passed, 17 skipped, zero failures. Existing integration tests skip where a running Thunderbird instance or their prerequisites prevent isolation.
- `npm run lint`: zero errors; 12 existing warnings.
- New workflow tests: target selection, preservation, stale body/attachment rejection, recheck after lock, revoked account access, closed windows, input/format validation, refreshed revisions, serialization, draft-save receipt and failure, native busy detection and lock release.
- Isolated native Thunderbird 140.15.0esr and 153.0 profiles, containing only dummy example.invalid identities: loaded the packaged extension; created two compose windows; listed/read both; updated one subject while preserving its body and the other window; rejected an old revision; replaced the HTML body while retaining its quote; saved through the draft-only tool and received a native Drafts-folder message receipt. No messages were sent.
- This test does not establish Exchange/Owl server-side save behavior. Real-profile activation still requires an extension reload/restart and live catalog verification.
