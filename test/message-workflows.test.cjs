"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(
  __dirname,
  "..",
  "extension",
  "mcp_server",
  "message_workflows.sys.mjs"
)).href;
const apiSource = fs.readFileSync(path.join(
  __dirname,
  "..",
  "extension",
  "mcp_server",
  "api.js"
), "utf8");

function createReplyEditor(initialNames, {
  withSelection = true,
  quoteChildren = [],
} = {}) {
  const children = [];
  const nodesByName = new Map();
  const body = {
    children,
    get firstChild() {
      return this.children[0] || null;
    },
    insertBefore(node, referenceNode) {
      const nodes = node.isFragment ? [...node.children] : [node];
      for (const inserted of nodes) {
        const oldParent = inserted.parentNode;
        const oldIndex = oldParent?.children.indexOf(inserted) ?? -1;
        if (oldIndex !== -1) oldParent.children.splice(oldIndex, 1);
      }
      const referenceIndex = referenceNode == null
        ? this.children.length
        : this.children.indexOf(referenceNode);
      assert.notEqual(referenceIndex, -1, "reference node belongs to the editor body");
      this.children.splice(referenceIndex, 0, ...nodes);
      for (const inserted of nodes) inserted.parentNode = this;
      return node;
    },
    querySelector(selector) {
      function findDescendant(nodes) {
        for (const node of nodes) {
          if (node.matches(selector)) return node;
          const nestedMatch = findDescendant(node.children);
          if (nestedMatch) return nestedMatch;
        }
        return null;
      }
      return findDescendant(this.children);
    },
  };

  function createNode(name) {
    const node = {
      name,
      children: [],
      parentNode: null,
      matches(selector) {
        if (selector === ".moz-signature") return this.name.endsWith("signature");
        if (selector === ".moz-cite-prefix, blockquote[type='cite']") {
          return this.name === "quote";
        }
        return false;
      },
      compareDocumentPosition(other) {
        function documentOrder(nodes, result = []) {
          for (const child of nodes) {
            result.push(child);
            documentOrder(child.children, result);
          }
          return result;
        }
        const ordered = documentOrder(body.children);
        return ordered.indexOf(other) < ordered.indexOf(this) ? 2 : 4;
      },
    };
    nodesByName.set(name, node);
    return node;
  }

  for (const name of initialNames) {
    const node = createNode(name);
    node.parentNode = body;
    children.push(node);
  }
  const quote = nodesByName.get("quote");
  for (const name of quoteChildren) {
    const node = createNode(name);
    node.parentNode = quote;
    quote.children.push(node);
  }

  const selection = withSelection ? {
    ranges: [{ startAfterNode: children.at(-1) || null }],
    removeAllRanges() {
      this.ranges.length = 0;
    },
    addRange(range) {
      this.ranges.push(range);
    },
  } : null;

  const editorDoc = {
    body,
    createRange() {
      return {
        selectNodeContents(node) {
          this.selectedNode = node;
        },
        collapse(toStart) {
          this.collapsedToStart = toStart;
        },
        createContextualFragment(fragmentHtml) {
          assert.equal(fragmentHtml, "<div>reply</div>");
          const aptos = createNode("aptos");
          return {
            isFragment: true,
            children: [aptos],
            firstChild: aptos,
            lastChild: aptos,
          };
        },
        setStartAfter(node) {
          this.startAfterNode = node;
        },
      };
    },
    defaultView: {
      getSelection() {
        return selection;
      },
    },
  };

  return {
    editorDoc,
    body,
    selection,
    originalChildren: [...children],
    nodesByName,
  };
}

function createCollectionHeader(messageId, messageKey, date = 0) {
  return { messageId, messageKey, date };
}

function createCollectionFolder({
  uri,
  flags = 0,
  isServer = false,
  noSelect = false,
  headers = [],
  database = undefined,
  enumerationError = null,
  children = [],
  traversalError = null,
  enumerationLog = null,
}) {
  const folder = {
    URI: uri,
    flags,
    isServer,
    noSelect,
    hasSubFolders: children.length > 0 || Boolean(traversalError),
  };
  Object.defineProperty(folder, "subFolders", {
    get() {
      if (traversalError) throw traversalError;
      return children;
    },
  });
  Object.defineProperty(folder, "msgDatabase", {
    get() {
      if (database !== undefined) return database;
      return {
        enumerateMessages() {
          enumerationLog?.push(uri);
          if (enumerationError) throw enumerationError;
          return headers;
        },
      };
    },
  });
  return folder;
}

async function collectTestConversation({ rootFolder, seedFolder, seedHeader, maxRecords = 100 }) {
  const { collectConversationFolderRecords } = await import(moduleUrl);
  return collectConversationFolderRecords({
    rootFolder,
    seedFolder,
    seedHeader,
    seedRecord: {
      id: seedHeader.messageId,
      folderPath: seedFolder.URI,
      _dateTs: seedHeader.date,
    },
    maxRecords,
    sentFlag: 2,
    virtualFlag: 4,
    getMessageId: header => header.messageId,
    isSeedHeader: (header, folder) => (
      header.messageKey === seedHeader.messageKey && folder.URI === seedFolder.URI
    ),
    makeRecord: (header, folder) => ({
      id: header.messageId,
      folderPath: folder.URI,
      _dateTs: header.date,
    }),
  });
}

describe("conversation matching", () => {
  const outlookThreadIndex = (rootByte, childByte) => Buffer.concat([
    Buffer.alloc(22, rootByte),
    Buffer.alloc(5, childByte),
  ]).toString("base64");

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

  it("resolves a reverse-ordered long reply chain without repeated full scans", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const chainLength = 800;
    const records = [{ id: "message-0@test", _dateTs: 0 }];
    for (let index = chainLength; index >= 1; index--) {
      records.push({
        id: `message-${index}@test`,
        inReplyTo: `message-${index - 1}@test`,
        _dateTs: index,
      });
    }

    const startedAt = performance.now();
    const result = resolveConversationMembers(records, "message-0@test", 200);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(result.totalMessages, chainLength + 1);
    assert.ok(elapsedMs < 1_000, `indexed closure took ${elapsedMs.toFixed(1)} ms`);
  });

  it("does not join messages with only an equal subject", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const subjectOnly = resolveConversationMembers([
      { id: "seed@test", subject: "Same subject" },
      { id: "other@test", subject: "Same subject" },
    ], "seed@test", 100);
    assert.deepStrictEqual(subjectOnly.members.map(m => m.id), ["seed@test"]);
  });

  it("does not join Outlook thread roots with different topics", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const wrongTopic = resolveConversationMembers([
      { id: "seed@test", threadTopic: "Project update", threadIndex: outlookThreadIndex(1, 2) },
      { id: "sent@test", threadTopic: "Different topic", threadIndex: outlookThreadIndex(1, 3) },
    ], "seed@test", 100);
    assert.deepStrictEqual(wrongTopic.members.map(m => m.id), ["seed@test"]);
  });

  it("joins matching Outlook roots with equal trimmed topics", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const outlookMatch = resolveConversationMembers([
      { id: "seed@test", threadTopic: " Project update ", threadIndex: outlookThreadIndex(7, 2) },
      { id: "sent@test", threadTopic: "Project update", threadIndex: outlookThreadIndex(7, 3) },
    ], "seed@test", 100);
    assert.deepStrictEqual(outlookMatch.members.map(m => m.id), ["seed@test", "sent@test"]);
    assert.equal(outlookMatch.members[1].matchReason, "outlook-thread");
  });

  it("prefers exact In-Reply-To evidence over compatible Outlook headers", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const result = resolveConversationMembers([
      {
        id: "seed@test",
        threadTopic: "Project update",
        threadIndex: outlookThreadIndex(9, 1),
      },
      {
        id: "sent@test",
        inReplyTo: "seed@test",
        threadTopic: "Project update",
        threadIndex: outlookThreadIndex(9, 2),
      },
    ], "seed@test", 100);

    assert.equal(result.members[1].matchReason, "in-reply-to");
  });

  it("limits a long conversation after chronology while retaining the seed and newest reply", async () => {
    const { resolveConversationMembers } = await import(moduleUrl);
    const result = resolveConversationMembers([
      { id: "seed@test", _dateTs: 100 },
      { id: "sent-newest@test", inReplyTo: "reply-4@test", _dateTs: 600, direction: "outgoing" },
      { id: "reply-4@test", inReplyTo: "reply-3@test", _dateTs: 500 },
      { id: "reply-1@test", inReplyTo: "seed@test", _dateTs: 200 },
      { id: "reply-3@test", inReplyTo: "reply-2@test", _dateTs: 400 },
      { id: "reply-2@test", inReplyTo: "reply-1@test", _dateTs: 300 },
    ], "seed@test", 3);

    assert.equal(result.totalMessages, 6);
    assert.equal(result.truncated, true);
    assert.deepStrictEqual(
      result.members.map(member => member.id),
      ["seed@test", "reply-4@test", "sent-newest@test"]
    );
    assert.equal(result.members.at(-1).direction, "outgoing");
  });

  it("retains the seed when the bounded scan fills before traversal records", async () => {
    const { createBoundedConversationScan } = await import(moduleUrl);
    const scan = createBoundedConversationScan(
      { id: "seed@test", folderPath: "imap://account/Archive" },
      1
    );

    assert.equal(scan.add({ id: "<seed@test>", folderPath: "imap://account/Archive" }), false);
    assert.equal(scan.truncated, false);
    assert.equal(scan.add({ id: "other@test", folderPath: "imap://account/Inbox" }), false);
    assert.deepStrictEqual(scan.records.map(record => record.id), ["seed@test"]);
    assert.equal(scan.truncated, true);
  });

  it("marks capped account scans truncated and adds a bounded-scan warning", async () => {
    const { finalizeConversationScan } = await import(moduleUrl);
    const summary = finalizeConversationScan(
      { totalMessages: 1, truncated: false },
      true,
      ["Raw headers unavailable for imap://account/Inbox"],
      10_000
    );

    assert.deepStrictEqual(summary, {
      totalMessages: 1,
      truncated: true,
      warnings: [
        "Raw headers unavailable for imap://account/Inbox",
        "Conversation scan stopped at the 10000-header collection cap; additional account messages may be omitted.",
      ],
    });
  });

  it("dispatches getConversation through the async adapter", () => {
    assert.match(apiSource, /case "getConversation":\s*return await getConversation\(/);
  });
});

describe("conversation folder collection", () => {
  it("collects the seed folder and Sent before Archive consumes the global cap", async () => {
    const enumerationLog = [];
    const seedHeader = createCollectionHeader("seed@test", 1, 100);
    const seedFolder = createCollectionFolder({
      uri: "imap://account/Inbox",
      headers: [seedHeader],
      enumerationLog,
    });
    const archive = createCollectionFolder({
      uri: "imap://account/Archive",
      headers: [
        createCollectionHeader("archive-1@test", 11, 200),
        createCollectionHeader("archive-2@test", 12, 300),
        createCollectionHeader("archive-3@test", 13, 400),
      ],
      enumerationLog,
    });
    const sent = createCollectionFolder({
      uri: "imap://account/Sent",
      flags: 2,
      headers: [createCollectionHeader("sent-reply@test", 21, 500)],
      enumerationLog,
    });
    const duplicateSentUri = createCollectionFolder({
      uri: sent.URI,
      flags: 2,
      headers: [createCollectionHeader("duplicate-sent@test", 22, 600)],
      enumerationLog,
    });
    const rootFolder = createCollectionFolder({
      uri: "imap://account",
      isServer: true,
      children: [archive, sent, duplicateSentUri, seedFolder],
    });

    const result = await collectTestConversation({
      rootFolder,
      seedFolder,
      seedHeader,
      maxRecords: 3,
    });

    assert.deepStrictEqual(enumerationLog, [seedFolder.URI, sent.URI, archive.URI]);
    assert.deepStrictEqual(
      result.records.map(record => record.id),
      ["seed@test", "sent-reply@test", "archive-1@test"]
    );
    assert.equal(result.records.some(record => record.id === "duplicate-sent@test"), false);
    assert.equal(result.collectionCapReached, true);
    assert.equal(result.truncated, true);
  });

  it("reports a null message database for its folder and marks collection incomplete", async () => {
    const { finalizeConversationScan } = await import(moduleUrl);
    const seedHeader = createCollectionHeader("seed@test", 1);
    const seedFolder = createCollectionFolder({ uri: "imap://account/Inbox", headers: [seedHeader] });
    const broken = createCollectionFolder({ uri: "imap://account/NullDb", database: null });
    const rootFolder = createCollectionFolder({
      uri: "imap://account",
      isServer: true,
      children: [seedFolder, broken],
    });

    const result = await collectTestConversation({ rootFolder, seedFolder, seedHeader });

    assert.deepStrictEqual(result.diagnostics, [{
      folderPath: broken.URI,
      stage: "message database",
      error: "Message database unavailable",
    }]);
    assert.equal(result.collectionIncomplete, true);
    assert.equal(result.truncated, true);
    assert.equal(finalizeConversationScan(
      { totalMessages: 1, truncated: false },
      result.collectionCapReached,
      result.warnings,
      100,
      result.collectionIncomplete
    ).truncated, true);
  });

  it("reports message enumeration exceptions for their folder and marks collection incomplete", async () => {
    const seedHeader = createCollectionHeader("seed@test", 1);
    const seedFolder = createCollectionFolder({ uri: "imap://account/Inbox", headers: [seedHeader] });
    const broken = createCollectionFolder({
      uri: "imap://account/ThrowingDb",
      enumerationError: new Error("enumeration failed"),
    });
    const rootFolder = createCollectionFolder({
      uri: "imap://account",
      isServer: true,
      children: [seedFolder, broken],
    });

    const result = await collectTestConversation({ rootFolder, seedFolder, seedHeader });

    assert.deepStrictEqual(result.diagnostics, [{
      folderPath: broken.URI,
      stage: "message enumeration",
      error: "enumeration failed",
    }]);
    assert.equal(result.collectionIncomplete, true);
    assert.equal(result.truncated, true);
  });

  it("reports descendant traversal exceptions for their folder and marks collection incomplete", async () => {
    const seedHeader = createCollectionHeader("seed@test", 1);
    const seedFolder = createCollectionFolder({ uri: "imap://account/Inbox", headers: [seedHeader] });
    const broken = createCollectionFolder({
      uri: "imap://account/BrokenParent",
      traversalError: new Error("descendant traversal failed"),
    });
    const rootFolder = createCollectionFolder({
      uri: "imap://account",
      isServer: true,
      children: [seedFolder, broken],
    });

    const result = await collectTestConversation({ rootFolder, seedFolder, seedHeader });

    assert.deepStrictEqual(result.diagnostics, [{
      folderPath: broken.URI,
      stage: "subtree traversal",
      error: "descendant traversal failed",
    }]);
    assert.equal(result.collectionIncomplete, true);
    assert.equal(result.truncated, true);
  });
});

describe("reply editor layout", () => {
  it("inserts the Aptos body before the existing signature and quote and keeps the caret inside it", async () => {
    const { insertReplyHtmlAtTop } = await import(moduleUrl);
    const { editorDoc, body, selection, originalChildren } = createReplyEditor([
      "signature",
      "quote",
    ]);

    const { insertedNode } = insertReplyHtmlAtTop(editorDoc, "<div>reply</div>");

    assert.deepStrictEqual(body.children.map(node => node.name), ["aptos", "signature", "quote"]);
    assert.equal(insertedNode.name, "aptos");
    assert.equal(selection.ranges[0].selectedNode, insertedNode);
    assert.equal(selection.ranges[0].collapsedToStart, false);
    assert.equal(selection.ranges[0].startAfterNode, undefined);
    assert.equal(selection.ranges.length, 1);
    assert.equal(body.children[1], originalChildren[0]);
    assert.equal(body.children[2], originalChildren[1]);
  });

  it("inserts before a quote when there is no signature", async () => {
    const { insertReplyHtmlAtTop } = await import(moduleUrl);
    const { editorDoc, body, originalChildren } = createReplyEditor(["quote"]);

    insertReplyHtmlAtTop(editorDoc, "<div>reply</div>");

    assert.deepStrictEqual(body.children.map(node => node.name), ["aptos", "quote"]);
    assert.equal(body.children[1], originalChildren[0]);
  });

  it("inserts into an empty editor body", async () => {
    const { insertReplyHtmlAtTop } = await import(moduleUrl);
    const { editorDoc, body, selection } = createReplyEditor([]);

    insertReplyHtmlAtTop(editorDoc, "<div>reply</div>");

    assert.deepStrictEqual(body.children.map(node => node.name), ["aptos"]);
    assert.equal(selection.ranges[0].selectedNode.name, "aptos");
    assert.equal(selection.ranges[0].collapsedToStart, false);
  });

  it("inserts when the editor has no selection", async () => {
    const { insertReplyHtmlAtTop } = await import(moduleUrl);
    const { editorDoc, body } = createReplyEditor(["signature", "quote"], {
      withSelection: false,
    });

    insertReplyHtmlAtTop(editorDoc, "<div>reply</div>");

    assert.deepStrictEqual(body.children.map(node => node.name), ["aptos", "signature", "quote"]);
  });

  it("moves an existing signature before a quote without replacing either node", async () => {
    const { insertReplyHtmlAtTop } = await import(moduleUrl);
    const { editorDoc, body, originalChildren } = createReplyEditor(["quote", "signature"]);

    insertReplyHtmlAtTop(editorDoc, "<div>reply</div>");

    assert.deepStrictEqual(body.children.map(node => node.name), ["aptos", "signature", "quote"]);
    assert.equal(body.children[1], originalChildren[1]);
    assert.equal(body.children[2], originalChildren[0]);
    assert.equal(body.children.length, originalChildren.length + 1);
  });

  it("moves only the current compose signature and preserves a nested historical signature", async () => {
    const { insertReplyHtmlAtTop } = await import(moduleUrl);
    const { editorDoc, body, nodesByName } = createReplyEditor(["quote", "signature"], {
      quoteChildren: ["historical-before", "historical-signature", "historical-after"],
    });
    const quote = nodesByName.get("quote");
    const currentSignature = nodesByName.get("signature");
    const historicalBefore = nodesByName.get("historical-before");
    const historicalSignature = nodesByName.get("historical-signature");
    const historicalAfter = nodesByName.get("historical-after");

    insertReplyHtmlAtTop(editorDoc, "<div>reply</div>");

    assert.deepStrictEqual(body.children.map(node => node.name), ["aptos", "signature", "quote"]);
    assert.equal(body.children[1], currentSignature);
    assert.equal(body.children[2], quote);
    assert.deepStrictEqual(
      quote.children,
      [historicalBefore, historicalSignature, historicalAfter]
    );
    assert.equal(historicalSignature.parentNode, quote);
  });

  it("keeps the direct-send reply body before its quote block", () => {
    assert.match(
      apiSource,
      /composeFields\.body = `<html><head><meta charset="UTF-8"><\/head><body>\$\{wrapOutlookBody\(formatBodyHtml\(body, isHtml\)\)\}\$\{quoteBlock\}<\/body><\/html>`;/
    );
  });
});
