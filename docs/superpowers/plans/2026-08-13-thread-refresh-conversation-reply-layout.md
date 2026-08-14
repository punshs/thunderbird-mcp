# Thunderbird MCP Refresh, Conversation, and Reply Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit Owl/IMAP folder synchronization, exact cross-folder conversation lookup, and deterministic top-first Aptos reply composition without changing `getThread`.

**Architecture:** Put protocol-independent conversation matching and editor insertion in a small ES module that both Thunderbird and Node tests can load. Keep Thunderbird/XPCOM adapters in `api.js`: they select accessible folders, collect headers, await protocol-specific refresh completion, and expose the two MCP tools. Preserve native reply composition and insert only the new Aptos block at the editor root.

**Tech Stack:** Thunderbird WebExtension Experiment API, privileged JavaScript/XPCOM, ES modules (`.sys.mjs`), Node.js 18+ built-in test runner, custom XPI builder.

## Global Constraints

- Preserve the existing folder-local `getThread` contract and behavior.
- `getConversation` must never join messages on subject equality alone.
- Exact linkage order is `Message-ID`, `In-Reply-To`, `References`, then compatible Outlook `Thread-Index` plus `Thread-Topic`.
- Default refresh scope is each allowed account's Inbox and Sent folders; recursive traversal is opt-in only for a supplied `folderPath`.
- A folder refresh must return `refreshed`, `skipped`, `timed_out`, or `failed` and must expose partial failures.
- Reply order is new Aptos 12pt body, Thunderbird-managed signature, then Thunderbird-managed quote.
- Preserve all existing compose nodes and place the caret after the inserted Aptos block. When Thunderbird initially places the signature below the quote, move that existing signature node before the quote so the required order wins; never delete or reconstruct either node.
- Never send a test message. Do not install the XPI or restart Thunderbird without separate user approval.
- Keep `skipReview` safety behavior unchanged.
- Reference Thunderbird's official IMAP listener pattern in [MailUtils.sys.mjs](https://searchfox.org/comm-central/source/mail/modules/MailUtils.sys.mjs) and the base folder/event contracts in [nsIMsgFolder.idl](https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgFolder.idl) and [nsIFolderListener.idl](https://searchfox.org/comm-central/source/mailnews/base/public/nsIFolderListener.idl).

## File Map

- Create `extension/mcp_server/message_workflows.sys.mjs`: pure message-ID parsing, fixed-point conversation resolution, Outlook thread-root comparison, and top-of-editor insertion.
- Create `test/message-workflows.test.cjs`: Node tests for the pure module and lightweight editor-DOM fakes.
- Create `test/refresh-folders.test.cjs`: tests for refresh result aggregation and structural checks for the IMAP and Owl completion adapters.
- Modify `extension/mcp_server/api.js`: load helpers; define MCP schemas; implement folder selection, refresh adapters, conversation record collection, tool dispatch, and deterministic reply insertion.
- Modify `test/tool-access.test.cjs`: register `getConversation` and `refreshFolders` in access-control fixtures.
- Modify `test/validation.test.cjs`: validate both new tool schemas.
- Modify `README.md`: document the tools, folder-local versus cross-folder semantics, explicit refresh workflow, and correct tool count.
- Modify `dist/thunderbird-mcp.xpi`: rebuild the distributable only after all tests pass.

---

### Task 1: Pure Conversation Resolver

**Files:**
- Create: `extension/mcp_server/message_workflows.sys.mjs`
- Create: `test/message-workflows.test.cjs`

**Interfaces:**
- Consumes: plain records shaped as `{ id, inReplyTo, references, threadTopic, threadIndex }`.
- Produces: `normalizeMessageId(value)`, `parseMessageIdList(value)`, `outlookThreadRoot(value)`, and `resolveConversationMembers(records, seedMessageId, maxMessages)`.

- [ ] **Step 1: Write failing normalization and exact-linkage tests**

Create a dynamic module loader and fixtures in `test/message-workflows.test.cjs`:

```js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(
  __dirname,
  "..",
  "extension",
  "mcp_server",
  "message_workflows.sys.mjs"
)).href;

describe("conversation matching", () => {
  it("normalizes only whitespace and one angle-bracket pair", async () => {
    const { normalizeMessageId } = await import(moduleUrl);
    assert.equal(normalizeMessageId("  <AbC@example.test>  "), "AbC@example.test");
    assert.equal(normalizeMessageId("AbC@example.test"), "AbC@example.test");
    assert.equal(normalizeMessageId("<AbC@example.test"), "<AbC@example.test");
  });

  it("joins Inbox and Sent through References and In-Reply-To", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const records = [
      { id: "ken@example.test", references: [] },
      { id: "reply@example.test", inReplyTo: "<ken@example.test>", references: ["ken@example.test"] },
    ];
    const result = resolveConversationMembers(records, "ken@example.test", 100);
    assert.deepStrictEqual(result.members.map(m => m.id), ["ken@example.test", "reply@example.test"]);
    assert.equal(result.members[1].matchReason, "in-reply-to");
  });

  it("expands a reply-to-reply chain to a fixed point", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const records = [
      { id: "root@test" },
      { id: "child@test", inReplyTo: "root@test" },
      { id: "grandchild@test", inReplyTo: "child@test" },
    ];
    assert.deepStrictEqual(
      resolveConversationMembers(records, "root@test", 100).members.map(m => m.id),
      ["root@test", "child@test", "grandchild@test"]
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `node --test test/message-workflows.test.cjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `message_workflows.sys.mjs`.

- [ ] **Step 3: Implement message-ID parsing and fixed-point exact matching**

Create `message_workflows.sys.mjs` with these exported signatures and matching loop:

```js
export function normalizeMessageId(value) {
  const text = String(value || "").trim();
  return text.startsWith("<") && text.endsWith(">")
    ? text.slice(1, -1)
    : text;
}

export function parseMessageIdList(value) {
  if (Array.isArray(value)) return value.map(normalizeMessageId).filter(Boolean);
  const text = String(value || "");
  const bracketed = [...text.matchAll(/<([^<>]+)>/g)].map(match => normalizeMessageId(match[1]));
  return bracketed.length ? bracketed : text.split(/\s+/).map(normalizeMessageId).filter(Boolean);
}

export function resolveConversationMembers(records, seedMessageId, maxMessages = 100) {
  const seedId = normalizeMessageId(seedMessageId);
  const normalized = records.map(record => ({
    ...record,
    id: normalizeMessageId(record.id),
    inReplyTo: normalizeMessageId(record.inReplyTo),
    references: parseMessageIdList(record.references),
  }));
  const seed = normalized.find(record => record.id === seedId);
  if (!seed) return { error: `Seed message not found: ${seedMessageId}` };

  const matched = new Map([[seed.id, { ...seed, matchReason: "seed" }]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of normalized) {
      if (!record.id || matched.has(record.id)) continue;
      let reason = "";
      if (record.inReplyTo && matched.has(record.inReplyTo)) reason = "in-reply-to";
      else if (record.references.some(id => matched.has(id))) reason = "references";
      else if ([...matched.values()].some(member => member.inReplyTo === record.id || member.references.includes(record.id))) reason = "referenced-by-member";
      if (!reason) continue;
      matched.set(record.id, { ...record, matchReason: reason });
      changed = true;
    }
  }

  const members = [...matched.values()];
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(maxMessages) || 100)));
  return { members: members.slice(-limit), totalMessages: members.length, truncated: members.length > limit };
}
```

- [ ] **Step 4: Add Outlook fallback and false-positive tests**

Add tests proving that equal subjects alone do not match, different `Thread-Topic` values do not match, and equal decoded 22-byte Outlook roots plus equal trimmed topics do match. Build test thread indices with `Buffer.concat([root22Bytes, child5Bytes]).toString("base64")`.

Expected assertions:

```js
assert.deepStrictEqual(subjectOnly.members.map(m => m.id), ["seed@test"]);
assert.deepStrictEqual(wrongTopic.members.map(m => m.id), ["seed@test"]);
assert.deepStrictEqual(outlookMatch.members.map(m => m.id), ["seed@test", "sent@test"]);
assert.equal(outlookMatch.members[1].matchReason, "outlook-thread");
```

- [ ] **Step 5: Implement Outlook root decoding without Node-only APIs**

Use `globalThis.atob`, which exists in Thunderbird and Node 18+, decode the first 22 bytes, and compare byte arrays. Only apply the fallback when both records have nonempty, equal trimmed `threadTopic` strings and valid roots.

- [ ] **Step 6: Run the resolver tests**

Run: `node --test test/message-workflows.test.cjs`

Expected: PASS for normalization, multi-hop linkage, subject isolation, topic isolation, and Outlook ancestry.

- [ ] **Step 7: Commit the pure resolver**

```bash
git add extension/mcp_server/message_workflows.sys.mjs test/message-workflows.test.cjs
git commit -m "feat: resolve conversations across mail folders"
```

---

### Task 2: `getConversation` MCP Tool

**Files:**
- Modify: `extension/mcp_server/api.js` near the `getThread` schema, account/folder helpers, `getThread`, and `callTool` dispatch.
- Modify: `test/tool-access.test.cjs` in `ALL_TOOLS`.
- Modify: `test/validation.test.cjs` in `sampleTools` and schema tests.

**Interfaces:**
- Consumes: `resolveConversationMembers(records, seedMessageId, maxMessages)` from Task 1 and existing `getAccessibleFolder`, `getAccessibleAccounts`, `findMessage`, `folderDisplayName`, and account restrictions.
- Produces: async `getConversation(messageId, folderPath, maxMessages)` and MCP tool `getConversation`.

- [ ] **Step 1: Add failing schema, access-control, and dispatch structural tests**

Add to `ALL_TOOLS`:

```js
{ name: "getConversation", group: "messages", crud: "read" },
```

Add a `sampleTools` schema requiring `messageId` and `folderPath`, with optional numeric `maxMessages`. Assert that the validator accepts all three valid fields and rejects missing `messageId` or a string `maxMessages`.

Add a source assertion to `test/message-workflows.test.cjs`:

```js
assert.match(apiSource, /case "getConversation":\s*return await getConversation\(/);
```

- [ ] **Step 2: Run the focused tests and verify structural failure**

Run: `node --test test/tool-access.test.cjs test/validation.test.cjs test/message-workflows.test.cjs`

Expected: FAIL because production `api.js` does not yet define `getConversation`.

- [ ] **Step 3: Register the helper module and MCP schema**

After the resource substitution in `getAPI`, import:

```js
const {
  normalizeMessageId,
  parseMessageIdList,
  resolveConversationMembers,
} = ChromeUtils.importESModule(
  "resource://thunderbird-mcp/mcp_server/message_workflows.sys.mjs"
);
```

Add a read-only messages tool whose schema is:

```js
{
  name: "getConversation",
  group: "messages", crud: "read",
  title: "Get Cross-Folder Conversation",
  description: "List exact header-linked messages across folders in the seed account, including Sent Items replies. Unlike getThread, this follows Message-ID references across folders and never joins by subject alone.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", description: "Seed message ID" },
      folderPath: { type: "string", description: "Folder URI containing the seed" },
      maxMessages: { type: "number", description: "Maximum messages returned (default 100, max 200)" },
    },
    required: ["messageId", "folderPath"],
  },
}
```

- [ ] **Step 4: Implement account-scoped record collection**

Add `collectConversationRecords(seedHdr, seedFolder)` that:

1. Resolves the seed account with `MailServices.accounts.findAccountForServer(seedFolder.server)`.
2. Rejects a missing or inaccessible account.
3. Walks all non-server, non-virtual, selectable folders below that account root.
4. Enumerates at most `SEARCH_COLLECTION_CAP` headers.
5. Collects `messageId`, `numReferences/getStringReference`, `in-reply-to`, `thread-topic`, `thread-index`, subject, author, recipients, date, flags, folder display name, and folder URI.
6. Reads only the raw header block for same-topic candidates when Outlook headers are absent from the database and the message has an offline/local stream.
7. Adds a warning with the folder URI when raw headers are unavailable rather than guessing.

Use this output shape for every record:

```js
{
  id, inReplyTo, references, threadTopic, threadIndex,
  subject, author, recipients, ccList, date,
  folder, folderPath, read, flagged, tags, direction, _dateTs
}
```

Direction is `outgoing` when the normalized author address matches an identity on the seed account, otherwise `incoming`.

- [ ] **Step 5: Implement `getConversation` and dispatch**

Call the resolver, sort proven members by `_dateTs`, remove the internal timestamp, and return:

```js
{
  seedMessageId: normalizeMessageId(messageId),
  accountId: account.key,
  totalMessages,
  truncated,
  warnings,
  messages
}
```

Add:

```js
case "getConversation":
  return await getConversation(args.messageId, args.folderPath, args.maxMessages);
```

- [ ] **Step 6: Run focused tests**

Run: `node --test test/tool-access.test.cjs test/validation.test.cjs test/message-workflows.test.cjs`

Expected: PASS, including the unchanged production/test tool inventory check.

- [ ] **Step 7: Commit the MCP conversation integration**

```bash
git add extension/mcp_server/api.js test/tool-access.test.cjs test/validation.test.cjs test/message-workflows.test.cjs
git commit -m "feat: expose cross-folder email conversations"
```

---

### Task 3: Explicit `refreshFolders` with Owl and IMAP Completion

**Files:**
- Create: `test/refresh-folders.test.cjs`
- Modify: `extension/mcp_server/api.js` near folder helpers, tool schemas, and dispatch.
- Modify: `test/tool-access.test.cjs`
- Modify: `test/validation.test.cjs`

**Interfaces:**
- Consumes: accessible account/folder helpers and Thunderbird `nsIMsgImapMailFolder`, `nsIUrlListener`, and `nsIFolderListener` APIs.
- Produces: `selectRefreshFolders(accountId, folderPath, recursive)`, `refreshOneFolder(folder, timeoutMs)`, async `refreshFolders(accountId, folderPath, recursive, timeoutMs)`, and MCP tool `refreshFolders`.

- [ ] **Step 1: Write failing tool inventory, schema, and result aggregation tests**

Add to `ALL_TOOLS`:

```js
{ name: "refreshFolders", group: "folders", crud: "update" },
```

Add validator cases for optional `accountId`, `folderPath`, `recursive`, and `timeoutMs`. Add `test/refresh-folders.test.cjs` source assertions for:

```js
assert.match(apiSource, /QueryInterface\(Ci\.nsIMsgImapMailFolder\)/);
assert.match(apiSource, /updateFolderWithListener\(null, urlListener\)/);
assert.match(apiSource, /onFolderEvent\(folder, event\)/);
assert.match(apiSource, /event === "FolderLoaded"/);
assert.match(apiSource, /case "refreshFolders":\s*return await refreshFolders\(/);
```

Add a table-driven pure aggregation test by exporting `summarizeRefreshResults(results)` from `message_workflows.sys.mjs`. Given one refreshed, one failed, and one timed-out result, require counts `{ attempted: 3, refreshed: 1, failed: 1, timedOut: 1, skipped: 0 }` and `success: false`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/refresh-folders.test.cjs test/tool-access.test.cjs test/validation.test.cjs`

Expected: FAIL because the schema, adapters, and aggregator do not exist.

- [ ] **Step 3: Implement folder selection and schema**

Define flags from `Ci.nsMsgFolderFlags.Inbox`, `SentMail`, and `Virtual`. Selection rules:

- `folderPath`: validate access, select it, and include descendants only when `recursive === true`.
- `accountId`: validate access, select folders with Inbox or Sent flags under that account.
- neither: select Inbox and Sent folders from every accessible account.
- Skip server roots, virtual folders, and `noSelect` folders.
- Deduplicate by folder URI.

Clamp `timeoutMs` to 1,000 through 60,000 milliseconds, defaulting to 15,000.

- [ ] **Step 4: Implement IMAP completion using Mozilla's listener contract**

For folders that can `QueryInterface(Ci.nsIMsgImapMailFolder)`, register:

```js
const urlListener = {
  QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
  OnStartRunningUrl() {},
  OnStopRunningUrl(_url, statusCode) {
    if (Components.isSuccessCode(statusCode)) finish("refreshed");
    else finish("failed", `Update folder failed with status 0x${statusCode.toString(16)}`);
  },
};
imapFolder.updateFolderWithListener(null, urlListener);
```

Use a one-shot `nsITimer` to call `finish("timed_out")`. Guard `finish` so listener and timeout races settle once.

- [ ] **Step 5: Implement Owl completion through `FolderLoaded`**

For non-IMAP selectable remote folders, attach an `nsIFolderListener` to the folder before calling `folder.updateFolder(null)`. Implement all listener methods as no-ops except:

```js
onFolderEvent(eventFolder, event) {
  if (eventFolder.URI === folder.URI && event === "FolderLoaded") {
    finish("refreshed");
  }
}
```

Always remove the folder listener and cancel the timer in `finish`. A synchronous `updateFolder` exception yields `failed`. Local folders with server type `none` or `pop3` yield `skipped` because their local database does not need an MCP-triggered remote folder refresh.

- [ ] **Step 6: Implement aggregate response and dispatch**

Refresh selected folders sequentially to avoid concurrent account synchronization reentrancy. Return:

```js
{
  success: counts.failed === 0 && counts.timedOut === 0,
  counts,
  folders: results
}
```

Each result includes `accountId`, `folderPath`, `serverType`, `status`, `elapsedMs`, and optional `error`. Add the async dispatch case.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/refresh-folders.test.cjs test/tool-access.test.cjs test/validation.test.cjs test/message-workflows.test.cjs`

Expected: PASS for schema, tool metadata, both completion strategies, timeout cleanup, and partial-failure aggregation.

- [ ] **Step 8: Commit explicit refresh support**

```bash
git add extension/mcp_server/api.js extension/mcp_server/message_workflows.sys.mjs test/refresh-folders.test.cjs test/tool-access.test.cjs test/validation.test.cjs test/message-workflows.test.cjs
git commit -m "feat: refresh Thunderbird folders with completion status"
```

---

### Task 4: Deterministic Aptos Reply Placement

**Files:**
- Modify: `extension/mcp_server/message_workflows.sys.mjs`
- Modify: `extension/mcp_server/api.js` at `insertReplyBodyIntoComposeWindow`.
- Modify: `test/message-workflows.test.cjs`

**Interfaces:**
- Consumes: an editor `Document` and the existing `wrapOutlookBody(formatBodyFragmentHtml(...))` fragment.
- Produces: `insertReplyHtmlAtTop(editorDoc, fragmentHtml)` returning `{ insertedNode }` or throwing before mutation.

- [ ] **Step 1: Write failing fake-DOM layout and caret tests**

Add lightweight fakes implementing `body.firstChild`, `body.insertBefore`, `createRange`, `createContextualFragment`, and `defaultView.getSelection`. Start with existing children named `signature` and `quote`, and set a fake current selection after `quote`.

Assert:

```js
assert.deepStrictEqual(body.children.map(node => node.name), ["aptos", "signature", "quote"]);
assert.equal(selection.range.startAfterNode.name, "aptos");
assert.equal(selection.ranges.length, 1);
```

Add cases for quote-only, empty editor body, absent initial selection, and an initial quote-before-signature order. Assert that no original child is removed and that quote-before-signature is normalized to message, signature, quote.

- [ ] **Step 2: Run the layout tests and verify missing export failure**

Run: `node --test test/message-workflows.test.cjs`

Expected: FAIL because `insertReplyHtmlAtTop` is not exported.

- [ ] **Step 3: Implement top insertion and caret placement**

Implement:

```js
export function insertReplyHtmlAtTop(editorDoc, fragmentHtml) {
  if (!editorDoc?.body || !fragmentHtml) throw new Error("Reply editor is not ready");
  const insertionRange = editorDoc.createRange();
  insertionRange.selectNodeContents(editorDoc.body);
  insertionRange.collapse(true);
  const domFragment = insertionRange.createContextualFragment(fragmentHtml);
  const insertedNode = domFragment.firstChild;
  const insertedLastNode = domFragment.lastChild;
  if (!insertedNode || !insertedLastNode) throw new Error("Reply body produced no editable content");
  editorDoc.body.insertBefore(domFragment, editorDoc.body.firstChild);

  const signature = editorDoc.body.querySelector(".moz-signature");
  const quote = editorDoc.body.querySelector(".moz-cite-prefix, blockquote[type='cite']");
  if (signature && quote && (signature.compareDocumentPosition(quote) & 2)) {
    editorDoc.body.insertBefore(signature, quote);
  }

  const selection = editorDoc.defaultView?.getSelection?.();
  if (selection) {
    const caretRange = editorDoc.createRange();
    caretRange.setStartAfter(insertedLastNode);
    caretRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caretRange);
  }
  return { insertedNode };
}
```

- [ ] **Step 4: Replace selection-dependent compose insertion**

Add `insertReplyHtmlAtTop` to the existing helper-module destructuring import in `api.js`. In `insertReplyBodyIntoComposeWindow`, remove both `execCommand("insertHTML")` and `editor.insertHTML(fragment)` paths. Require `browser.contentDocument`, call `insertReplyHtmlAtTop(editorDoc, fragment)`, then retain the existing `bodyModified` and `gContentChanged` assignments.

This inserts before Thunderbird's signature and quote nodes regardless of its reply-above/reply-below caret preference. If Thunderbird put the signature after the quote, reposition that existing node before the quote without deleting or reconstructing either node. The direct-send HTML already concatenates `wrapOutlookBody(...)` before `quoteBlock`; keep it unchanged and add a source assertion that locks this order.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/message-workflows.test.cjs`

Expected: PASS for message, signature, quote ordering; quote-only and empty layouts; caret placement; content preservation; and direct-send order.

- [ ] **Step 6: Commit reply placement**

```bash
git add extension/mcp_server/message_workflows.sys.mjs extension/mcp_server/api.js test/message-workflows.test.cjs
git commit -m "fix: place Aptos replies above signatures and quotes"
```

---

### Task 5: Documentation, Regression Suite, and XPI Build

**Files:**
- Modify: `README.md`
- Modify: `dist/thunderbird-mcp.xpi`

**Interfaces:**
- Consumes: completed tools and passing focused tests from Tasks 1 through 4.
- Produces: documented 39-tool extension and a tested installable XPI artifact.

- [ ] **Step 1: Document the explicit triage workflow**

Update the badge and prose from stale counts to 39 tools. Add `getConversation` and `refreshFolders` to the Mail table. State this recommended sequence:

```text
refreshFolders (Inbox + Sent) -> getConversation -> getMessage as needed
```

Keep `getThread` documented as folder-local. Document refresh statuses and that automatic refresh is intentionally not performed before every read.

- [ ] **Step 2: Run all Node tests**

Run: `node --test test/*.test.cjs`

Expected: all tests PASS with zero failures, cancellations, or skipped tests caused by this change.

- [ ] **Step 3: Check syntax and whitespace**

Run:

```bash
node --check extension/mcp_server/api.js
node --check extension/mcp_server/message_workflows.sys.mjs
git diff --check
```

Expected: each command exits 0 with no diagnostics.

- [ ] **Step 4: Build the XPI**

Run: `node scripts/build-xpi.cjs`

Expected: output matching `Built: .../dist/thunderbird-mcp.xpi (... KB)`.

- [ ] **Step 5: Verify packaged contents**

Run:

```bash
unzip -t dist/thunderbird-mcp.xpi
unzip -l dist/thunderbird-mcp.xpi | grep 'mcp_server/message_workflows.sys.mjs'
```

Expected: `No errors detected` and one packaged helper-module entry.

- [ ] **Step 6: Re-run the full suite after the build**

Run: `node --test test/*.test.cjs`

Expected: all tests still PASS. Check `git status --short`; only intended README, source, tests, plan, and XPI changes may appear.

- [ ] **Step 7: Commit docs and build artifact**

```bash
git add README.md dist/thunderbird-mcp.xpi docs/superpowers/plans/2026-08-13-thread-refresh-conversation-reply-layout.md
git commit -m "docs: describe refreshed cross-folder email workflow"
```

- [ ] **Step 8: Stop at the live-install gate**

Report the worktree path, branch, commit list, complete test output summary, and XPI path. Ask for explicit approval before installing the XPI or restarting Thunderbird. After approval, live acceptance consists of:

1. Install the rebuilt XPI and restart Thunderbird.
2. Call `refreshFolders` for Inbox and Sent Items.
3. Call `getConversation` on the Ken and Sequoyah seeds and verify the same-day Sent replies appear.
4. Open, but do not send, a harmless reply compose window and visually verify Aptos body, signature, quote ordering.
5. Close the compose window without sending.
