# Open-draft tools (fork 0.8.4)

The MCP server exposes `listComposeWindows`, `getComposeWindow`, `updateComposeWindow`, and `saveComposeWindow`. The host adapter uses Thunderbird's native compose API through the extension's API manager. Each accessible native window receives an opaque session ID. Reads return a revision tied to the current compose details, attachment metadata, source URI and saved-draft URI.

Updates require the observed revision and serialize per window. The adapter checks current identity/account access, rejects busy windows, and holds Thunderbird's editor lock while checking the revision and applying a partial field update. Only subject, address arrays and the body in its existing format are writable. Unspecified fields, attachments and native threading remain untouched. A body replacement includes the entire body; callers must retain signatures and quotes when appropriate.

Saving checks the revision, releases the editing lock immediately before calling native `saveMessage` with mode `draft`, and returns the native receipt. It never calls a send API. IDs and revisions are not durable across extension reloads; closed or inaccessible windows cannot be edited. This is optimistic concurrency against user edits, not a transaction shared with other extensions that might also change the composer.

## Validation, 2026-09-17

- `npm test`: 593 tests, 576 passed, 17 skipped, zero failures. Existing integration tests skip where a running Thunderbird instance or their prerequisites prevent isolation.
- `npm run lint`: zero errors; 12 existing warnings.
- New workflow tests: target selection, preservation, stale body/attachment rejection, recheck after lock, revoked account access, closed windows, input/format validation, refreshed revisions, serialization, draft-save receipt and failure, native busy detection and lock release.
- Isolated native Thunderbird 140.15.0esr and 153.0 profiles, containing only dummy example.invalid identities: loaded the packaged extension; created two compose windows; listed/read both; updated one subject while preserving its body and the other window; rejected an old revision; replaced the HTML body while retaining its quote; saved through the draft-only tool and received a native Drafts-folder message receipt. No messages were sent.
- This test does not establish Exchange/Owl server-side save behavior. Real-profile activation still requires an extension reload/restart and live catalog verification.

## Closing drafts

`closeComposeWindow` requires `composeId`, the latest `expectedRevision`, and
`mode: "save"` or `mode: "discard"`. It uses the same account checks, per-window
serialization and native editor lock as updates. Stale revisions, busy windows,
and inaccessible accounts are rejected.

Save mode saves a draft, checks that its content has not changed during the
save, then closes. Save failure or intervening edits leave the window open.
Discard mode preflights the saved message and accessible Trash destination,
rechecks the revision, closes without saving, and moves that exact saved message
to Trash. Unsaved windows have no mailbox message to remove. The native close
operation waits for unload and bypasses Thunderbird's destructive draft-removal
prompt path. Neither mode sends or queues mail.

Discard receipts include `closed` and `savedDraft.status`: `notSaved`,
`alreadyAbsent`, `movedToTrash`, or `failed`. A move failure can occur after a
successful close, including an uncertain server timeout. Inspect that status
and refresh folders before further cleanup. There is no permanent-delete
fallback. Saved-message keys and identity are checked again before the move.
Mailbox, IMAP, and Owl saved-draft URI forms are supported; unsupported forms
fail before closing. As with edits, this is optimistic concurrency, not a
transaction shared with other extensions or the mail server.

Validation on 2026-09-23 includes workflow and identifier-resolution tests and
isolated native Thunderbird 140.16.0esr and 153.0 profiles with dummy identities. Save-and-close,
unsaved discard, and saved discard to Trash were exercised without sending mail.
The full suite passed: 615 passed, 17 skipped, no failures. Lint reported no
errors and 12 existing warnings. Exact message IDs confirmed Trash moves; a
stale close preserved the newer draft in native Thunderbird 153.0.
Exchange/Owl server-side behavior still requires live deployment verification.

## Reopening saved drafts

`openSavedDraft({messageId, folderPath})` accepts the stored Message-ID and
folder URI used by the message search/read tools. The folder must be an
accessible Drafts folder. It uses Thunderbird's native `Draft` loader, with
`MailUtils.getIdentityForHeader` as the initial identity hint, rather than
reconstructing a new message or using `EditAsNew`. Thunderbird restores its
saved MIME, identity, attachment, format and threading metadata.

The result is a full compose snapshot with `composeId`, `revision` and `reused`.
A matching open composer is focused and returned with its current unsaved
edits intact. Matching checks the exact folder, native message key and Message-ID,
not just the subject or message key. Concurrent opens of the same stored
message are coalesced. Loading waits up to approximately 15 seconds for the
native editor; on timeout it reports uncertainty and will not start another
native open for that URI during the extension session. Inspect open windows
before retrying. A folder refresh may be needed after saving to obtain the
current stored Message-ID.

Saving a reopened draft can renew Thunderbird's internal WebExtension message
ID; save-and-close compares its stable original source URI instead. Native
save completion also gets one UI turn to finish clearing the modified flag
before the lock is reacquired. Content changes or a remaining modified flag
still leave the window open.

Validation on 2026-09-28: a fresh, isolated Thunderbird 140.16.0esr profile with
only `example.invalid` identities completed save-and-close, native reopening,
HTML/body/identity/attachment preservation, reuse retaining unsaved subject
edits, rejection of a stale close revision, and a second save-and-close.
No real mailbox or user compose window was touched. Exchange/Owl and a newer
Thunderbird version were not retested for reopening. Activation requires
installing this XPI and reloading the extension, then refreshing the MCP tool
catalog; the running user's extension was not changed.

Final automated validation: `npm test` passed 625 tests, skipped 17 integration
checks, and failed none. `npm run lint` reported zero errors and 12 existing
warnings. `git diff --check` passed.
