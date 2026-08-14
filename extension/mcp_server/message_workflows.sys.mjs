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
