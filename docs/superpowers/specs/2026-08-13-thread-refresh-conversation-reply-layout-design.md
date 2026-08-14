# Thunderbird MCP Refresh, Conversation, and Reply Layout Design

## Purpose

Make mailbox triage reliable when replies live in Sent Items, provide an explicit way to refresh Thunderbird-backed data, and ensure review-window replies place the new Aptos-formatted message above the signature and quoted original.

The change must preserve the existing folder-local `getThread` contract and Thunderbird's native reply behavior.

## Current Problems

1. `getThread` uses Thunderbird's folder-local message database. It cannot show a reply stored in Sent Items when the seed message is in Inbox.
2. Folder refresh is attempted only for servers whose type is exactly `imap`. The user's Exchange account is exposed through Owl, so MCP reads can remain stale until Thunderbird is refreshed manually.
3. Refresh calls are fire-and-forget. Reads can race the synchronization they initiated.
4. Review-window replies insert HTML at the current editor selection. Depending on Thunderbird's caret position, the new Aptos block can appear below the signature or quoted original.

## Compatibility Strategy

Keep `getThread` unchanged and add two focused tools:

- `refreshFolders` synchronizes selected folders and waits for a bounded completion result.
- `getConversation` resolves a logical conversation across folders, especially Inbox and Sent Items.

Existing clients retain their current behavior. Email-management clients can refresh explicitly and then use `getConversation` when they need to determine whether a message has already received a reply.

## `refreshFolders`

### Interface

The tool accepts an optional account identifier, folder path, recursive flag, and timeout. With a folder path it refreshes that folder. With an account and no folder path it refreshes the folders carrying Thunderbird's Inbox or Sent flags. Recursive traversal is opt-in and applies only when a folder path is provided, so callers do not accidentally trigger an expensive whole-account refresh.

The result contains one entry per attempted folder:

- account identifier
- folder path
- server type
- status: `refreshed`, `skipped`, `timed_out`, or `failed`
- elapsed time
- error text when applicable

It also contains aggregate counts and a top-level success value. Partial failure is represented explicitly rather than discarding successful folder results.

### Synchronization

Refresh eligibility will be capability-based, not restricted to the literal `imap` server type. The implementation will call Thunderbird's folder update API for selectable remote folders, including Owl-backed Exchange folders.

Each update will be wrapped in a completion listener and a timeout. The MCP call will not report a folder as refreshed until Thunderbird signals completion. Unsupported or local-only folders will be returned as skipped. A timeout will not cancel or corrupt Thunderbird's underlying synchronization; it only bounds the MCP request.

Read tools will not automatically refresh every folder. This avoids hidden network latency and preserves fast local-database reads.

## `getConversation`

### Interface and Scope

The tool accepts a seed message identifier and its folder path. It searches the seed account by default and returns matching messages with their folder paths in chronological order. The response identifies the seed, match evidence, and whether each message is incoming or outgoing when that can be determined from account identities.

### Matching Rules

Conversation membership uses exact evidence in this order:

1. Canonical `Message-ID` equality.
2. An `In-Reply-To` value pointing to a known member.
3. A `References` list containing a known member.
4. Outlook `Thread-Index` ancestry together with compatible `Thread-Topic`.

Matching is expanded to a fixed point so a reply to a reply is included even when it does not directly reference the seed. Header identifiers are normalized only by trimming whitespace and one surrounding pair of angle brackets. Their contents retain their original case and are not fuzzily rewritten.

Subject equality alone will never establish membership. This prevents unrelated messages with the same common subject from being merged. Outlook fallback matching is accepted only within the same account and when its thread headers are structurally compatible.

Folders that cannot expose the required raw headers are reported in diagnostic metadata. The tool returns the exact matches it can prove rather than guessing.

### Performance

The implementation will first use available message-database properties to narrow candidates. MIME or raw-header parsing will be limited to the seed and plausible candidates. Results will be bounded by a configurable limit, with truncation reported explicitly.

## Reply Composition Layout

The review path will continue to open Thunderbird's native reply or reply-all compose window. This preserves recipient calculation, identity selection, threading headers, signatures, quoted content, and disposition behavior.

When `NotifyComposeBodyReady` fires, the extension will inspect the editor DOM and identify Thunderbird's signature and quote boundary. It will insert the new body at the beginning of the editable message region rather than at the current selection.

The required order is:

1. New message, wrapped in Aptos 12pt styling.
2. Thunderbird-managed identity signature, when present.
3. Thunderbird-managed quoted original.

After insertion, the caret will be placed at the end of the new message block so the user can continue typing naturally.

If expected signature or quote markers are missing, the extension will prepend the new block to the editor body and preserve every existing node. It will not delete, reconstruct, or move Thunderbird-generated content.

The direct-send path will retain its hand-built quote block and ensure the same top-first body ordering. It cannot add a Thunderbird-managed signature, so that existing limitation remains documented.

## Error Handling

- Missing seed messages and invalid folders return the existing structured error style.
- A refresh failure is isolated to its folder and includes the underlying Thunderbird status when available.
- A conversation search with incomplete header access returns proven matches plus warnings.
- An editor mutation failure leaves the compose window open and returns an error without sending anything.
- No new path sends mail automatically. Existing `skipReview` safety behavior remains unchanged.

## Testing

Automated tests will cover:

- An Inbox seed linked to a Sent reply through `In-Reply-To` and `References`.
- A multi-hop reply chain across Inbox and Sent Items.
- Messages with equal subjects but no reference or compatible Outlook thread headers remaining separate.
- Outlook `Thread-Index` and `Thread-Topic` fallback behavior.
- Existing folder-local `getThread` behavior remaining unchanged.
- Owl/Exchange refresh completion, unsupported-folder skipping, partial failure, and timeout.
- Reply editor DOMs with a signature and quote, a quote only, and neither marker.
- Thunderbird configurations that initially place the caret above or below quoted content.
- Exact reply order: Aptos body, signature, quoted original.
- Caret placement after the inserted Aptos body.
- Direct-send body preceding its quote block.
- Existing unit tests and packaged-extension build.

Live acceptance testing will refresh the user's Inbox and Sent Items, verify that the Ken and Sequoyah conversations include the same-day Sent replies, and open a harmless review-window reply to inspect the layout. Installing the rebuilt extension or restarting Thunderbird requires separate user approval before that external-state change.

## Non-Goals

- Replacing or changing the contract of `getThread`.
- Automatically refreshing before every read operation.
- Combining messages based only on normalized subject text.
- Sending a test email.
- Refactoring unrelated portions of the extension's large API module.
