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
});
