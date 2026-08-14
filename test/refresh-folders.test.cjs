"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const apiSource = fs.readFileSync(path.join(
  __dirname,
  "..",
  "extension",
  "mcp_server",
  "api.js"
), "utf8");
const moduleUrl = pathToFileURL(path.join(
  __dirname,
  "..",
  "extension",
  "mcp_server",
  "message_workflows.sys.mjs"
)).href;

describe("folder refresh result aggregation", () => {
  for (const { name, results, expected } of [
    {
      name: "reports partial failure and timeout counts",
      results: [
        { status: "refreshed" },
        { status: "failed" },
        { status: "timed_out" },
      ],
      expected: {
        success: false,
        counts: { attempted: 3, refreshed: 1, failed: 1, timedOut: 1, skipped: 0 },
      },
    },
    {
      name: "treats skipped local folders as a successful bounded refresh",
      results: [
        { status: "refreshed" },
        { status: "skipped" },
      ],
      expected: {
        success: true,
        counts: { attempted: 2, refreshed: 1, failed: 0, timedOut: 0, skipped: 1 },
      },
    },
  ]) {
    it(name, async () => {
      const { summarizeRefreshResults } = await import(moduleUrl);
      assert.deepStrictEqual(summarizeRefreshResults(results), expected);
    });
  }
});

describe("Thunderbird folder refresh adapters", () => {
  it("uses the awaited IMAP URL-listener contract", () => {
    assert.match(apiSource, /QueryInterface\(Ci\.nsIMsgImapMailFolder\)/);
    assert.match(apiSource, /updateFolderWithListener\(null, urlListener\)/);
  });

  it("uses FolderLoaded completion for non-IMAP remote folders", () => {
    assert.match(apiSource, /onFolderEvent\(folder, event\)/);
    assert.match(apiSource, /event === "FolderLoaded"/);
  });

  it("dispatches refreshFolders through the async adapter", () => {
    assert.match(apiSource, /case "refreshFolders":\s*return await refreshFolders\(/);
  });
});
