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

export function finalizeConversationScan(resolved, scanTruncated, warnings = [], collectionCap = 10000) {
  const mergedWarnings = [...warnings];
  if (scanTruncated) {
    const cap = Math.max(1, Math.trunc(Number(collectionCap) || 1));
    mergedWarnings.push(
      `Conversation scan stopped at the ${cap}-header collection cap; additional account messages may be omitted.`
    );
  }
  return {
    totalMessages: resolved.totalMessages,
    truncated: Boolean(resolved.truncated || scanTruncated),
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
    for (const folder of selection) {
      results.push(await refreshOneFolder(folder, timeoutMs));
    }
    return {
      ...summarizeResults(results),
      folders: results,
    };
  }

  return { selectRefreshFolders, refreshOneFolder, refreshFolders };
}

function haveSameOutlookThread(record, member) {
  const topic = String(record.threadTopic || "").trim();
  if (!topic || topic !== String(member.threadTopic || "").trim()) return false;
  const recordRoot = outlookThreadRoot(record.threadIndex);
  const memberRoot = outlookThreadRoot(member.threadIndex);
  if (!recordRoot || !memberRoot) return false;
  return recordRoot.every((byte, index) => byte === memberRoot[index]);
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
      else if ([...matched.values()].some(member => haveSameOutlookThread(record, member))) reason = "outlook-thread";
      if (!reason) continue;
      matched.set(record.id, { ...record, matchReason: reason });
      changed = true;
    }
  }

  const members = [...matched.values()];
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(maxMessages) || 100)));
  return { members: members.slice(-limit), totalMessages: members.length, truncated: members.length > limit };
}
