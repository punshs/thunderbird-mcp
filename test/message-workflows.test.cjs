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

describe("reply editor layout", () => {
  it("inserts the Aptos body before the existing signature and quote and moves the caret", async () => {
    const { insertReplyHtmlAtTop } = await import(moduleUrl);
    const { editorDoc, body, selection, originalChildren } = createReplyEditor([
      "signature",
      "quote",
    ]);

    const { insertedNode } = insertReplyHtmlAtTop(editorDoc, "<div>reply</div>");

    assert.deepStrictEqual(body.children.map(node => node.name), ["aptos", "signature", "quote"]);
    assert.equal(insertedNode.name, "aptos");
    assert.equal(selection.ranges[0].startAfterNode.name, "aptos");
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
    assert.equal(selection.ranges[0].startAfterNode.name, "aptos");
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
