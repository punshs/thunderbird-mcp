const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

// Regressions these tests catch: rebuilding drafts as new messages, confusing
// same-key messages across folders, opening duplicate composers, or ignoring
// revoked access and native load failures.
async function fixture() {
  assert.ok(require('node:fs').existsSync(path.resolve(__dirname, '../extension/mcp_server/saved_draft_open.sys.mjs')), 'saved draft opener must exist');
  const { createSavedDraftOpener } = await import(pathToFileURL(path.resolve(__dirname,
    '../extension/mcp_server/saved_draft_open.sys.mjs')));
  const draft = { messageId: 'saved@example.org', messageKey: 42, folder: { URI: 'mailbox://local/Drafts' } };
  const windows = [];
  let opens = 0, allowed = true;
  const host = {
    resolve: () => { if (!allowed) throw new Error('Access denied'); return draft; },
    uri: h => `${h.folder.URI}#${h.messageKey}`,
    windows: () => windows,
    matches: (win, h) => win.draftId === host.uri(h),
    ready: w => w.ready && !w.closed,
    open: h => { opens++; windows.push({ draftId: host.uri(h), ready: true, closed: false,
      details: { identityId: 'id2', body: '<p>Draft</p>', isPlainText: false },
      attachments: ['file.pdf'], originalMessageURI: 'reply-source' }); },
    snapshot: async win => ({ composeId: 'id', revision: 'rev', ...structuredClone(win) }),
    focus: w => { w.focused = true; },
    wait: async () => {},
  };
  return { opener: createSavedDraftOpener(host, { attempts: 3 }), host, windows, draft,
    opens: () => opens, deny: () => { allowed = false; } };
}

test('opens stored draft natively and returns intact editable state', async () => {
  const f = await fixture();
  const result = await f.opener.open('saved@example.org', 'mailbox://local/Drafts');
  assert.equal(result.reused, false);
  assert.equal(result.composeId, 'id');
  assert.equal(result.details.identityId, 'id2');
  assert.equal(result.details.body, '<p>Draft</p>');
  assert.deepEqual(result.attachments, ['file.pdf']);
  assert.equal(result.originalMessageURI, 'reply-source');
});

test('reuses matching live draft and preserves unsaved edits', async () => {
  const f = await fixture();
  await f.opener.open('saved@example.org', 'mailbox://local/Drafts');
  f.windows[0].details.body = 'Human changes';
  const result = await f.opener.open('saved@example.org', 'mailbox://local/Drafts');
  assert.equal(result.reused, true);
  assert.equal(result.details.body, 'Human changes');
  assert.equal(f.opens(), 1);
});

test('coalesces simultaneous opens of same stored draft', async () => {
  const f = await fixture();
  await Promise.all([f.opener.open('id', 'folder'), f.opener.open('id', 'folder')]);
  assert.equal(f.opens(), 1);
});

test('does not reuse another folder with the same message key or a closed window', async () => {
  const f = await fixture();
  f.windows.push({ draftId: 'mailbox://other/Drafts#42', ready: true },
    { draftId: f.host.uri(f.draft), ready: true, closed: true });
  assert.equal((await f.opener.open('id', 'folder')).reused, false);
  assert.equal(f.opens(), 1);
});

test('denied or absent source never opens a composer', async () => {
  const f = await fixture();
  f.deny();
  await assert.rejects(f.opener.open('id', 'folder'), /Access denied/);
  assert.equal(f.opens(), 0);
});

test('native load timeout reports uncertainty without reopening on a retry', async () => {
  const f = await fixture();
  f.host.open = h => { f.windows.push({ draftId: f.host.uri(h), ready: false }); };
  await assert.rejects(f.opener.open('id', 'folder'), /timed out/i);
  await assert.rejects(f.opener.open('id', 'folder'), /timed out/i);
  assert.equal(f.windows.length, 1);
});

test('access revoked while loading is rechecked before returning draft contents', async () => {
  const f = await fixture();
  f.host.open = h => { f.windows.push({ draftId: f.host.uri(h), ready: true }); f.deny(); };
  await assert.rejects(f.opener.open('id', 'folder'), /Access denied/);
});

test('native loader selects the header identity instead of relying on a default account', async () => {
  const { openNativeSavedDraft } = await import(pathToFileURL(path.resolve(__dirname,
    '../extension/mcp_server/saved_draft_open.sys.mjs')));
  assert.equal(typeof openNativeSavedDraft, 'function');
  const identity = { key: 'nonDefault' };
  const header = { folder: { getUriForMsg: () => 'mailbox-message://test/Drafts#42' } };
  let args;
  openNativeSavedDraft(header, {
    getIdentity: h => { assert.equal(h, header); return identity; },
    compose: { OpenComposeWindow: (...values) => { args = values; } },
    draftType: 9, defaultFormat: 0,
  });
  assert.equal(args[1], header);
  assert.equal(args[2], 'mailbox-message://test/Drafts#42');
  assert.equal(args[3], 9);
  assert.equal(args[5], identity);
});
