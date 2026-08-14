export function insertReplyHtmlAtTop(editorDoc, fragmentHtml) {
  if (!editorDoc?.body || !fragmentHtml) throw new Error("Reply editor is not ready");
  const insertionRange = editorDoc.createRange();
  insertionRange.selectNodeContents(editorDoc.body);
  insertionRange.collapse(true);
  const domFragment = insertionRange.createContextualFragment(fragmentHtml);
  const insertedNode = domFragment.firstChild;
  const insertedLastNode = domFragment.lastChild;
  if (!insertedNode || !insertedLastNode) {
    throw new Error("Reply body produced no editable content");
  }
  editorDoc.body.insertBefore(domFragment, editorDoc.body.firstChild);

  const composeChildren = Array.from(editorDoc.body.children);
  const signature = composeChildren.find(node => node.matches?.(".moz-signature"));
  const quote = composeChildren.find(node => (
    node.matches?.(".moz-cite-prefix, blockquote[type='cite']")
  ));
  if (signature && quote && (signature.compareDocumentPosition(quote) & 2)) {
    editorDoc.body.insertBefore(signature, quote);
  }

  const selection = editorDoc.defaultView?.getSelection?.();
  if (selection) {
    const caretRange = editorDoc.createRange();
    caretRange.selectNodeContents(insertedNode);
    caretRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(caretRange);
  }
  return { insertedNode };
}

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

export function outlookThreadRoot(value) {
  const threadIndex = String(value || "").trim();
  if (!threadIndex) return null;
  try {
    const decoded = globalThis.atob(threadIndex);
    if (decoded.length < 22) return null;
    return Uint8Array.from(decoded.slice(0, 22), char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function createBoundedConversationScan(seedRecord, maxRecords) {
  const limit = Math.max(1, Math.trunc(Number(maxRecords) || 1));
  const records = [];
  const seenIds = new Set();
  let truncated = false;

  function add(record) {
    const id = normalizeMessageId(record?.id);
    if (!id || seenIds.has(id)) return false;
    if (records.length >= limit) {
      truncated = true;
      return false;
    }
    seenIds.add(id);
    records.push({ ...record, id });
    return true;
  }

  if (!add(seedRecord)) {
    throw new TypeError("A bounded conversation scan requires a seed record with a message ID");
  }

  return {
    records,
    add,
    has(messageId) {
      return seenIds.has(normalizeMessageId(messageId));
    },
    markTruncated() {
      truncated = true;
    },
    get truncated() {
      return truncated;
    },
  };
}

export function collectConversationFolderRecords({
  rootFolder,
  seedFolder,
  seedHeader,
  seedRecord,
  maxRecords,
  sentFlag,
  virtualFlag,
  getMessageId,
  isSeedHeader,
  makeRecord,
  onRecord = () => {},
}) {
  const scan = createBoundedConversationScan(seedRecord, maxRecords);
  const limit = Math.max(1, Math.trunc(Number(maxRecords) || 1));
  const diagnostics = [];
  const diagnosticKeys = new Set();
  let collectionIncomplete = false;

  function folderPath(folder) {
    try {
      return String(folder?.URI || "(unknown folder)");
    } catch {
      return "(unknown folder)";
    }
  }

  function report(folder, stage, error) {
    const diagnostic = {
      folderPath: folderPath(folder),
      stage,
      error: error?.message || String(error || "Unknown collection failure"),
    };
    const key = `${diagnostic.folderPath}\u0000${diagnostic.stage}\u0000${diagnostic.error}`;
    if (!diagnosticKeys.has(key)) {
      diagnosticKeys.add(key);
      diagnostics.push(diagnostic);
    }
    collectionIncomplete = true;
  }

  const discovered = [];
  const discoveredUris = new Set();
  const seenFolders = new Set();

  function discover(folder) {
    if (!folder || seenFolders.has(folder)) return;
    seenFolders.add(folder);

    const uri = folderPath(folder);
    if (discoveredUris.has(uri)) return;
    discoveredUris.add(uri);
    discovered.push(folder);

    let hasSubFolders;
    try {
      hasSubFolders = folder.hasSubFolders;
    } catch (error) {
      report(folder, "subtree traversal", error);
      return;
    }
    if (!hasSubFolders) return;

    try {
      for (const subfolder of folder.subFolders) discover(subfolder);
    } catch (error) {
      report(folder, "subtree traversal", error);
    }
  }

  discover(rootFolder);

  const orderedFolders = [];
  const orderedUris = new Set();
  function addOrdered(folder) {
    if (!folder) return;
    const uri = folderPath(folder);
    if (orderedUris.has(uri)) return;
    orderedUris.add(uri);
    orderedFolders.push(folder);
  }

  addOrdered(seedFolder);
  for (const folder of discovered) {
    try {
      if (folder.flags & sentFlag) addOrdered(folder);
    } catch (error) {
      report(folder, "folder metadata", error);
    }
  }
  for (const folder of discovered) addOrdered(folder);

  try {
    onRecord(scan.records[0], seedFolder, seedHeader);
  } catch (error) {
    report(seedFolder, "message processing", error);
  }

  let enumeratedHeaders = 1;
  for (const folder of orderedFolders) {
    if (scan.truncated) break;

    let selectable;
    try {
      selectable = !folder.isServer && !(folder.flags & virtualFlag) && !folder.noSelect;
    } catch (error) {
      report(folder, "folder metadata", error);
      continue;
    }
    if (!selectable) continue;

    let database;
    try {
      database = folder.msgDatabase;
    } catch (error) {
      report(folder, "message database", error);
      continue;
    }
    if (!database) {
      report(folder, "message database", "Message database unavailable");
      continue;
    }

    let messages;
    try {
      messages = database.enumerateMessages();
    } catch (error) {
      report(folder, "message enumeration", error);
      continue;
    }

    try {
      for (const header of messages) {
        if (isSeedHeader(header, folder)) continue;
        if (enumeratedHeaders >= limit) {
          scan.markTruncated();
          break;
        }
        enumeratedHeaders++;

        const id = normalizeMessageId(getMessageId(header));
        if (!id || scan.has(id)) continue;
        try {
          const record = makeRecord(header, folder);
          if (scan.add(record)) onRecord(scan.records.at(-1), folder, header);
        } catch (error) {
          report(folder, "message processing", error);
        }
      }
    } catch (error) {
      report(folder, "message enumeration", error);
    }
  }

  return {
    records: scan.records,
    diagnostics,
    warnings: diagnostics.map(diagnostic => (
      `Conversation collection incomplete for ${diagnostic.folderPath} during ` +
      `${diagnostic.stage}: ${diagnostic.error}`
    )),
    collectionCapReached: scan.truncated,
    collectionIncomplete,
    truncated: scan.truncated || collectionIncomplete,
  };
}

export function finalizeConversationScan(
  resolved,
  scanTruncated,
  warnings = [],
  collectionCap = 10000,
  collectionIncomplete = false
) {
  const mergedWarnings = [...warnings];
  if (scanTruncated) {
    const cap = Math.max(1, Math.trunc(Number(collectionCap) || 1));
    mergedWarnings.push(
      `Conversation scan stopped at the ${cap}-header collection cap; additional account messages may be omitted.`
    );
  }
  return {
    totalMessages: resolved.totalMessages,
    truncated: Boolean(resolved.truncated || scanTruncated || collectionIncomplete),
    warnings: [...new Set(mergedWarnings)],
  };
}

export function summarizeRefreshResults(results) {
  const counts = {
    attempted: results.length,
    refreshed: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0,
  };
  for (const result of results) {
    if (result.status === "refreshed") counts.refreshed++;
    else if (result.status === "failed") counts.failed++;
    else if (result.status === "timed_out") counts.timedOut++;
    else if (result.status === "skipped") counts.skipped++;
    else counts.failed++;
  }
  return {
    success: counts.failed === 0 && counts.timedOut === 0,
    counts,
  };
}

export function createFolderRefreshWorkflow({
  inboxFlag,
  sentFlag,
  virtualFlag,
  getAccessibleFolder,
  getAccessibleAccounts,
  isAccountAllowed,
  getAccount,
  getAccountIdForFolder,
  queryImapFolder,
  makeUrlListener = listener => listener,
  makeFolderListener = listener => listener,
  scheduleTimeout,
  isSuccessCode,
  now = Date.now,
  summarizeRefreshResults: summarizeResults,
}) {
  function selectRefreshFolders(accountId, folderPath, recursive) {
    const selected = [];
    const selectedUris = new Set();

    function addFolder(folder) {
      try {
        if (!folder || folder.isServer || (folder.flags & virtualFlag) || folder.noSelect) {
          return;
        }
        if (!folder.URI || selectedUris.has(folder.URI)) return;
        selectedUris.add(folder.URI);
        selected.push(folder);
      } catch {
        // Skip folders whose selection properties cannot be read.
      }
    }

    function walkDescendants(folder, visit) {
      try {
        if (!folder?.hasSubFolders) return;
        for (const subfolder of folder.subFolders) {
          visit(subfolder);
          walkDescendants(subfolder, visit);
        }
      } catch {
        // Skip descendants that cannot be enumerated.
      }
    }

    if (folderPath) {
      const resolved = getAccessibleFolder(folderPath);
      if (resolved.error) return resolved;
      addFolder(resolved.folder);
      if (recursive === true) {
        walkDescendants(resolved.folder, addFolder);
      }
      return selected;
    }

    let accounts;
    if (accountId) {
      if (!isAccountAllowed(accountId)) {
        return { error: `Account not accessible: ${accountId}` };
      }
      const account = getAccount(accountId);
      if (!account) return { error: `Account not found: ${accountId}` };
      accounts = [account];
    } else {
      accounts = getAccessibleAccounts();
    }

    for (const account of accounts) {
      const root = account.incomingServer?.rootFolder;
      if (!root) continue;
      const addSpecialFolder = folder => {
        try {
          if (folder.flags & (inboxFlag | sentFlag)) addFolder(folder);
        } catch {}
      };
      addSpecialFolder(root);
      walkDescendants(root, addSpecialFolder);
    }
    return selected;
  }

  function refreshOneFolder(folder, timeoutMs) {
    const startedAt = now();
    const serverType = folder.server?.type || "unknown";
    let accountId = "unknown";
    try {
      accountId = getAccountIdForFolder(folder) || "unknown";
    } catch {}
    const baseResult = {
      accountId,
      folderPath: folder.URI,
      serverType,
    };

    if (serverType === "none" || serverType === "pop3") {
      return Promise.resolve({
        ...baseResult,
        status: "skipped",
        elapsedMs: now() - startedAt,
      });
    }

    const numericTimeout = Number(timeoutMs);
    const boundedTimeout = Number.isFinite(numericTimeout)
      ? Math.max(1_000, Math.min(60_000, Math.trunc(numericTimeout)))
      : 15_000;

    return new Promise(resolve => {
      let settled = false;
      let cancelTimer = null;
      let folderListener = null;
      const targetFolderUri = folder.URI;

      function finish(status, error) {
        if (settled) return;
        settled = true;
        try { cancelTimer?.(); } catch {}
        if (folderListener) {
          try { folder.RemoveFolderListener(folderListener); } catch {}
        }
        resolve({
          ...baseResult,
          status,
          elapsedMs: now() - startedAt,
          ...(error ? { error } : {}),
        });
      }

      try {
        cancelTimer = scheduleTimeout(
          () => finish("timed_out", `Folder refresh timed out after ${boundedTimeout} ms`),
          boundedTimeout
        );

        const imapFolder = queryImapFolder(folder);
        if (imapFolder) {
          const urlListener = makeUrlListener({
            OnStartRunningUrl() {},
            OnStopRunningUrl(_url, statusCode) {
              if (isSuccessCode(statusCode)) {
                finish("refreshed");
              } else {
                finish("failed", `Update folder failed with status 0x${statusCode.toString(16)}`);
              }
            },
          });
          imapFolder.updateFolderWithListener(null, urlListener);
          return;
        }

        folderListener = makeFolderListener({
          onFolderAdded() {},
          onMessageAdded() {},
          onFolderRemoved() {},
          onMessageRemoved() {},
          onFolderPropertyChanged() {},
          onFolderIntPropertyChanged() {},
          onFolderBoolPropertyChanged() {},
          onFolderPropertyFlagChanged() {},
          onFolderEvent(eventFolder, event) {
            if (eventFolder.URI === targetFolderUri && event === "FolderLoaded") {
              finish("refreshed");
            }
          },
        });
        folder.AddFolderListener(folderListener);
        folder.updateFolder(null);
      } catch (error) {
        finish("failed", error?.message || String(error));
      }
    });
  }

  async function refreshFolders(accountId, folderPath, recursive, timeoutMs) {
    const selection = selectRefreshFolders(accountId, folderPath, recursive);
    if (selection.error) return selection;

    const results = [];
    const timedOutAccounts = new Set();
    for (const folder of selection) {
      let folderAccountId = "unknown";
      try {
        folderAccountId = getAccountIdForFolder(folder) || "unknown";
      } catch {}

      if (timedOutAccounts.has(folderAccountId)) {
        results.push({
          accountId: folderAccountId,
          folderPath: folder.URI,
          serverType: folder.server?.type || "unknown",
          status: "skipped",
          elapsedMs: 0,
          error: `Skipped because another folder refresh for account ${folderAccountId} ` +
            "timed out and may still be running",
        });
        continue;
      }

      const result = await refreshOneFolder(folder, timeoutMs);
      results.push(result);
      if (result.status === "timed_out") timedOutAccounts.add(result.accountId);
    }
    return {
      ...summarizeResults(results),
      folders: results,
    };
  }

  return { selectRefreshFolders, refreshOneFolder, refreshFolders };
}

function outlookThreadKey(record) {
  const topic = String(record.threadTopic || "").trim();
  const root = outlookThreadRoot(record.threadIndex);
  if (!topic || !root) return "";
  return `${topic}\u0000${Array.from(root).join(",")}`;
}

export function resolveConversationMembers(records, seedMessageId, maxMessages = 100) {
  const seedId = normalizeMessageId(seedMessageId);
  const normalized = [];
  const recordsById = new Map();
  for (const record of records) {
    const candidate = {
      ...record,
      id: normalizeMessageId(record.id),
      inReplyTo: normalizeMessageId(record.inReplyTo),
      references: parseMessageIdList(record.references),
    };
    if (!candidate.id || recordsById.has(candidate.id)) continue;
    recordsById.set(candidate.id, candidate);
    normalized.push(candidate);
  }

  const seed = recordsById.get(seedId);
  if (!seed) return { error: `Seed message not found: ${seedMessageId}` };

  function addToIndex(index, key, record) {
    if (!key) return;
    const values = index.get(key);
    if (values) values.push(record);
    else index.set(key, [record]);
  }

  const repliesByParent = new Map();
  const referencesByTarget = new Map();
  const outlookGroups = new Map();
  for (const record of normalized) {
    addToIndex(repliesByParent, record.inReplyTo, record);
    for (const reference of record.references) {
      addToIndex(referencesByTarget, reference, record);
    }
    addToIndex(outlookGroups, outlookThreadKey(record), record);
  }

  const matched = new Map();
  const exactQueue = [];
  const outlookQueue = [];
  const expandedOutlookGroups = new Set();

  function addMatch(record, matchReason) {
    if (!record?.id || matched.has(record.id)) return false;
    matched.set(record.id, { ...record, matchReason });
    exactQueue.push(record);
    outlookQueue.push(record);
    return true;
  }

  function exactReasonAgainstMatched(record) {
    if (record.inReplyTo && matched.has(record.inReplyTo)) return "in-reply-to";
    if (record.references.some(id => matched.has(id))) return "references";
    if ((repliesByParent.get(record.id) || []).some(child => matched.has(child.id))) {
      return "referenced-by-member";
    }
    if ((referencesByTarget.get(record.id) || []).some(child => matched.has(child.id))) {
      return "referenced-by-member";
    }
    return "";
  }

  addMatch(seed, "seed");
  let exactIndex = 0;
  let outlookIndex = 0;
  while (exactIndex < exactQueue.length || outlookIndex < outlookQueue.length) {
    while (exactIndex < exactQueue.length) {
      const member = exactQueue[exactIndex++];

      for (const reply of repliesByParent.get(member.id) || []) {
        if (!matched.has(reply.id)) addMatch(reply, "in-reply-to");
      }
      for (const reply of referencesByTarget.get(member.id) || []) {
        if (!matched.has(reply.id)) {
          addMatch(reply, exactReasonAgainstMatched(reply) || "references");
        }
      }

      for (const parentId of [member.inReplyTo, ...member.references]) {
        const parent = recordsById.get(parentId);
        if (parent && !matched.has(parent.id)) {
          addMatch(parent, exactReasonAgainstMatched(parent) || "referenced-by-member");
        }
      }
    }

    if (outlookIndex < outlookQueue.length) {
      const member = outlookQueue[outlookIndex++];
      const key = outlookThreadKey(member);
      if (!key || expandedOutlookGroups.has(key)) continue;
      expandedOutlookGroups.add(key);
      for (const related of outlookGroups.get(key) || []) {
        if (!matched.has(related.id)) {
          addMatch(related, exactReasonAgainstMatched(related) || "outlook-thread");
        }
      }
    }
  }

  function compareChronologically(left, right) {
    const leftDate = Number(left._dateTs);
    const rightDate = Number(right._dateTs);
    return (Number.isFinite(leftDate) ? leftDate : 0) -
      (Number.isFinite(rightDate) ? rightDate : 0);
  }

  const members = [...matched.values()].sort(compareChronologically);
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(maxMessages) || 100)));
  let returnedMembers = members;
  if (members.length > limit) {
    returnedMembers = members.slice(-limit);
    if (!returnedMembers.some(member => member.id === seedId)) {
      const newest = limit > 1
        ? members.filter(member => member.id !== seedId).slice(-(limit - 1))
        : [];
      returnedMembers = [matched.get(seedId), ...newest].sort(compareChronologically);
    }
  }
  return {
    members: returnedMembers,
    totalMessages: members.length,
    truncated: members.length > limit,
  };
}
