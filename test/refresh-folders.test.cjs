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

const FLAGS = { inbox: 1, sent: 2, virtual: 4 };

function makeFolder({
  uri,
  accountId = "account-a",
  serverType = "owl",
  flags = 0,
  isServer = false,
  noSelect = false,
  children = [],
  updateFolder,
} = {}) {
  const state = {
    listener: null,
    addCount: 0,
    removeCount: 0,
    updateCount: 0,
  };
  const folder = {
    URI: uri,
    accountId,
    server: { type: serverType },
    flags,
    isServer,
    noSelect,
    hasSubFolders: children.length > 0,
    subFolders: children,
    AddFolderListener(listener) {
      state.listener = listener;
      state.addCount++;
    },
    RemoveFolderListener(listener) {
      assert.equal(listener, state.listener);
      state.removeCount++;
    },
    updateFolder(msgWindow) {
      state.updateCount++;
      if (updateFolder) return updateFolder.call(folder, msgWindow, state);
    },
    _state: state,
  };
  return folder;
}

function makeAccount(key, children) {
  return {
    key,
    incomingServer: {
      rootFolder: makeFolder({
        uri: `root://${key}`,
        accountId: key,
        serverType: "imap",
        isServer: true,
        children,
      }),
    },
  };
}

function makeHarness(createFolderRefreshWorkflow, summarizeRefreshResults, options = {}) {
  const timers = [];
  const accessibleAccounts = options.accessibleAccounts || [];
  const accountsById = options.accountsById || new Map(accessibleAccounts.map(account => [account.key, account]));
  const allowedAccountIds = options.allowedAccountIds || new Set(accessibleAccounts.map(account => account.key));
  const foldersByUri = options.foldersByUri || new Map();
  let clock = 1_000;

  const workflow = createFolderRefreshWorkflow({
    inboxFlag: FLAGS.inbox,
    sentFlag: FLAGS.sent,
    virtualFlag: FLAGS.virtual,
    getAccessibleFolder(folderPath) {
      const folder = foldersByUri.get(folderPath);
      return folder ? { folder } : { error: `Folder not found: ${folderPath}` };
    },
    getAccessibleAccounts() {
      return accessibleAccounts;
    },
    isAccountAllowed(accountId) {
      return allowedAccountIds.has(accountId);
    },
    getAccount(accountId) {
      return accountsById.get(accountId) || null;
    },
    getAccountIdForFolder(folder) {
      return folder.accountId;
    },
    queryImapFolder(folder) {
      return folder.imapInterface || null;
    },
    makeUrlListener(listener) {
      return listener;
    },
    makeFolderListener(listener) {
      return listener;
    },
    scheduleTimeout(callback, timeoutMs) {
      const timer = { callback, timeoutMs, cancelCount: 0 };
      timers.push(timer);
      return () => timer.cancelCount++;
    },
    isSuccessCode(statusCode) {
      return statusCode === 0;
    },
    now() {
      return clock;
    },
    summarizeRefreshResults,
  });

  return {
    workflow,
    timers,
    advance(ms) {
      clock += ms;
    },
  };
}

async function loadRefreshExports() {
  const module = await import(moduleUrl);
  return {
    createFolderRefreshWorkflow: module.createFolderRefreshWorkflow,
    summarizeRefreshResults: module.summarizeRefreshResults,
  };
}

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
      const { summarizeRefreshResults } = await loadRefreshExports();
      assert.deepStrictEqual(summarizeRefreshResults(results), expected);
    });
  }
});

describe("executable folder refresh adapters", () => {
  it("settles IMAP success from OnStopRunningUrl with bounded metadata", async () => {
    const exports = await loadRefreshExports();
    const folder = makeFolder({ uri: "imap://a/Inbox", serverType: "imap" });
    let urlListener;
    folder.imapInterface = {
      updateFolderWithListener(msgWindow, listener) {
        assert.equal(msgWindow, null);
        urlListener = listener;
      },
    };
    const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults);

    const pending = harness.workflow.refreshOneFolder(folder, 500);
    assert.equal(harness.timers[0].timeoutMs, 1_000);
    harness.advance(12);
    urlListener.OnStopRunningUrl(null, 0);

    assert.deepStrictEqual(await pending, {
      accountId: "account-a",
      folderPath: "imap://a/Inbox",
      serverType: "imap",
      status: "refreshed",
      elapsedMs: 12,
    });
    assert.equal(harness.timers[0].cancelCount, 1);
    assert.equal(folder._state.addCount, 0);
  });

  it("settles IMAP failure from a failing status code", async () => {
    const exports = await loadRefreshExports();
    const folder = makeFolder({ uri: "imap://a/Sent", serverType: "imap" });
    let urlListener;
    folder.imapInterface = {
      updateFolderWithListener(_msgWindow, listener) {
        urlListener = listener;
      },
    };
    const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults);

    const pending = harness.workflow.refreshOneFolder(folder, 70_000);
    assert.equal(harness.timers[0].timeoutMs, 60_000);
    urlListener.OnStopRunningUrl(null, 0x80004005);

    assert.deepStrictEqual(await pending, {
      accountId: "account-a",
      folderPath: "imap://a/Sent",
      serverType: "imap",
      status: "failed",
      elapsedMs: 0,
      error: "Update folder failed with status 0x80004005",
    });
  });

  it("ignores nonmatching Owl events and settles on the matching FolderLoaded", async () => {
    const exports = await loadRefreshExports();
    const folder = makeFolder({
      uri: "owl://a/Inbox",
      updateFolder(_msgWindow, state) {
        assert.ok(state.listener, "listener must be attached before updateFolder");
      },
    });
    const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults);
    let settled = false;
    const pending = harness.workflow.refreshOneFolder(folder, 5_000).then(result => {
      settled = true;
      return result;
    });

    folder._state.listener.onFolderEvent({ URI: "owl://a/Other" }, "FolderLoaded");
    folder._state.listener.onFolderEvent(folder, "OtherEvent");
    await Promise.resolve();
    assert.equal(settled, false);

    harness.advance(7);
    folder._state.listener.onFolderEvent({ URI: folder.URI }, "FolderLoaded");
    assert.equal((await pending).status, "refreshed");
    assert.equal(folder._state.removeCount, 1);
    assert.equal(harness.timers[0].cancelCount, 1);
  });

  it("returns failed and cleans up when updateFolder throws synchronously", async () => {
    const exports = await loadRefreshExports();
    const folder = makeFolder({
      uri: "owl://a/Broken",
      updateFolder() {
        throw new Error("synchronous update failure");
      },
    });
    const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults);

    const result = await harness.workflow.refreshOneFolder(folder, 5_000);

    assert.equal(result.status, "failed");
    assert.equal(result.error, "synchronous update failure");
    assert.equal(folder._state.removeCount, 1);
    assert.equal(harness.timers[0].cancelCount, 1);
  });

  for (const winner of ["timeout", "listener"]) {
    it(`settles a ${winner}-first race once and cleans up once`, async () => {
      const exports = await loadRefreshExports();
      const folder = makeFolder({ uri: `owl://a/${winner}` });
      const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults);
      const pending = harness.workflow.refreshOneFolder(folder, 5_000);
      const timer = harness.timers[0];
      const listener = folder._state.listener;

      if (winner === "timeout") {
        timer.callback();
        listener.onFolderEvent(folder, "FolderLoaded");
      } else {
        listener.onFolderEvent(folder, "FolderLoaded");
        timer.callback();
      }

      const result = await pending;
      assert.equal(result.status, winner === "timeout" ? "timed_out" : "refreshed");
      assert.equal(folder._state.removeCount, 1);
      assert.equal(timer.cancelCount, 1);
    });
  }

  for (const serverType of ["none", "pop3"]) {
    it(`skips local ${serverType} folders without starting an update`, async () => {
      const exports = await loadRefreshExports();
      const folder = makeFolder({ uri: `${serverType}://a/Inbox`, serverType });
      const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults);

      assert.deepStrictEqual(await harness.workflow.refreshOneFolder(folder, 5_000), {
        accountId: "account-a",
        folderPath: `${serverType}://a/Inbox`,
        serverType,
        status: "skipped",
        elapsedMs: 0,
      });
      assert.equal(harness.timers.length, 0);
      assert.equal(folder._state.updateCount, 0);
      assert.equal(folder._state.addCount, 0);
    });
  }
});

describe("folder selection and orchestration", () => {
  it("selects only Inbox and Sent folders from accessible accounts by default", async () => {
    const exports = await loadRefreshExports();
    const inbox = makeFolder({ uri: "imap://a/Inbox", flags: FLAGS.inbox });
    const sent = makeFolder({ uri: "imap://a/Sent", flags: FLAGS.sent });
    const ordinary = makeFolder({ uri: "imap://a/Projects" });
    const virtualInbox = makeFolder({ uri: "imap://a/Search", flags: FLAGS.inbox | FLAGS.virtual });
    const noSelectSent = makeFolder({ uri: "imap://a/NoSelect", flags: FLAGS.sent, noSelect: true });
    const accessible = makeAccount("account-a", [inbox, sent, ordinary, virtualInbox, noSelectSent]);
    const inaccessibleInbox = makeFolder({ uri: "imap://b/Inbox", accountId: "account-b", flags: FLAGS.inbox });
    const inaccessible = makeAccount("account-b", [inaccessibleInbox]);
    const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults, {
      accessibleAccounts: [accessible],
      accountsById: new Map([[accessible.key, accessible], [inaccessible.key, inaccessible]]),
      allowedAccountIds: new Set([accessible.key]),
    });

    assert.deepStrictEqual(
      harness.workflow.selectRefreshFolders().map(folder => folder.URI),
      ["imap://a/Inbox", "imap://a/Sent"]
    );
    assert.deepStrictEqual(
      harness.workflow.selectRefreshFolders("account-a").map(folder => folder.URI),
      ["imap://a/Inbox", "imap://a/Sent"]
    );
    assert.deepStrictEqual(
      harness.workflow.selectRefreshFolders("account-b"),
      { error: "Account not accessible: account-b" }
    );
  });

  it("validates an explicit folder and includes selectable descendants only when recursive", async () => {
    const exports = await loadRefreshExports();
    const child = makeFolder({ uri: "owl://a/Parent/Child" });
    const virtual = makeFolder({ uri: "owl://a/Parent/Search", flags: FLAGS.virtual });
    const parent = makeFolder({ uri: "owl://a/Parent", children: [child, virtual] });
    const foldersByUri = new Map([[parent.URI, parent]]);
    const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults, { foldersByUri });

    assert.deepStrictEqual(
      harness.workflow.selectRefreshFolders(undefined, parent.URI, false).map(folder => folder.URI),
      [parent.URI]
    );
    assert.deepStrictEqual(
      harness.workflow.selectRefreshFolders(undefined, parent.URI, true).map(folder => folder.URI),
      [parent.URI, child.URI]
    );
    assert.deepStrictEqual(
      harness.workflow.selectRefreshFolders(undefined, "owl://a/Missing", false),
      { error: "Folder not found: owl://a/Missing" }
    );
  });

  it("refreshes selected folders sequentially and returns each folder's metadata", async () => {
    const exports = await loadRefreshExports();
    const starts = [];
    const listeners = new Map();
    const inbox = makeFolder({ uri: "imap://a/Inbox", flags: FLAGS.inbox, serverType: "imap" });
    const sent = makeFolder({ uri: "imap://a/Sent", flags: FLAGS.sent, serverType: "imap" });
    for (const folder of [inbox, sent]) {
      folder.imapInterface = {
        updateFolderWithListener(_msgWindow, listener) {
          starts.push(folder.URI);
          listeners.set(folder.URI, listener);
        },
      };
    }
    const account = makeAccount("account-a", [inbox, sent]);
    const harness = makeHarness(exports.createFolderRefreshWorkflow, exports.summarizeRefreshResults, {
      accessibleAccounts: [account],
    });

    const pending = harness.workflow.refreshFolders();
    assert.deepStrictEqual(starts, [inbox.URI]);

    listeners.get(inbox.URI).OnStopRunningUrl(null, 0);
    await Promise.resolve();
    assert.deepStrictEqual(starts, [inbox.URI, sent.URI]);

    listeners.get(sent.URI).OnStopRunningUrl(null, 0);
    const result = await pending;
    assert.deepStrictEqual(result.counts, {
      attempted: 2,
      refreshed: 2,
      failed: 0,
      timedOut: 0,
      skipped: 0,
    });
    assert.deepStrictEqual(result.folders.map(({ accountId, folderPath, serverType, status }) => ({
      accountId,
      folderPath,
      serverType,
      status,
    })), [
      { accountId: "account-a", folderPath: inbox.URI, serverType: "imap", status: "refreshed" },
      { accountId: "account-a", folderPath: sent.URI, serverType: "imap", status: "refreshed" },
    ]);
  });
});
