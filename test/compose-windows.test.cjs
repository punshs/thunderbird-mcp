const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const target = path.resolve(__dirname, '../extension/mcp_server/compose_windows.sys.mjs');

// Removing the revision check, scope check, or partial patch semantics must
// fail these tests. The fake host is the Thunderbird boundary, not the logic.
async function fixture() {
  assert.ok(fs.existsSync(target), 'compose window workflow must exist');
  const { createComposeWindowWorkflow } = await import(pathToFileURL(target));
  const windows = new Map([
    ['one', { accountId: 'allowed', details: { subject: 'First', to: ['a@example.org'], cc: [], bcc: [], body: '<p>Reply</p><blockquote>Original</blockquote>', isPlainText: false, identityId: 'id1' }, attachments: [{ id: 7, name: 'report.pdf', size: 20 }], originalMessageId: 'seed@example.org' }],
    ['two', { accountId: 'allowed', details: { subject: 'Second', to: [], plainTextBody: 'Text', isPlainText: true, identityId: 'id1' }, attachments: [] }],
    ['private', { accountId: 'denied', details: { subject: 'Private' }, attachments: [] }],
  ]);
  let sequence = 0, saved = 0, applied = 0;
  const host = {
    list: () => [...windows.keys()],
    allowed: id => windows.has(id) && windows.get(id).accountId === 'allowed',
    read: async id => structuredClone(windows.get(id)),
    withLock: async (id, action) => action(),
    apply: async (id, changes) => { applied++; Object.assign(windows.get(id).details, changes); },
    save: async () => { saved++; return { mode: 'draft', messages: [{ id: 42 }] }; },
    token: () => `revision-${++sequence}`,
  };
  return { workflow: createComposeWindowWorkflow(host), windows, host, counts: () => ({ saved, applied }) };
}

test('lists only authorized windows without exposing full bodies', async () => {
  const { workflow } = await fixture();
  const result = await workflow.list();
  assert.deepEqual(result.windows.map(w => w.composeId), ['one', 'two']);
  assert.equal(result.windows[0].subject, 'First');
  assert.equal(result.windows[0].body, undefined);
});

test('edits only selected fields in the selected window, preserving attachments and threading', async () => {
  const { workflow, windows, counts } = await fixture();
  const read = await workflow.get('one');
  await workflow.update('one', read.revision, { subject: 'Revised' });
  assert.equal(windows.get('one').details.subject, 'Revised');
  assert.equal(windows.get('one').details.body, '<p>Reply</p><blockquote>Original</blockquote>');
  assert.deepEqual(windows.get('one').details.to, ['a@example.org']);
  assert.equal(windows.get('one').attachments[0].name, 'report.pdf');
  assert.equal(windows.get('one').originalMessageId, 'seed@example.org');
  assert.equal(windows.get('two').details.subject, 'Second');
  assert.deepEqual(counts(), { saved: 0, applied: 1 });
});

test('refuses stale edits after user changes body or attachments', async () => {
  for (const change of [w => { w.details.body += 'Human edit'; }, w => { w.attachments.push({ id: 8, name: 'new.pdf' }); }]) {
    const { workflow, windows, counts } = await fixture();
    const read = await workflow.get('one');
    change(windows.get('one'));
    await assert.rejects(workflow.update('one', read.revision, { subject: 'Wrong' }), /changed/i);
    assert.equal(counts().applied, 0);
  }
});

test('rechecks changes after acquiring the window lock', async () => {
  const { workflow, host, windows, counts } = await fixture();
  const read = await workflow.get('one');
  host.withLock = async (id, action) => { windows.get(id).details.subject = 'Human edit'; return action(); };
  await assert.rejects(workflow.update('one', read.revision, { subject: 'Wrong' }), /changed/i);
  assert.equal(counts().applied, 0);
});

test('rejects revoked account access and closed windows', async () => {
  const { workflow, windows } = await fixture();
  const read = await workflow.get('one');
  windows.get('one').accountId = 'denied';
  await assert.rejects(workflow.update('one', read.revision, { subject: 'Wrong' }), /accessible/i);
  windows.delete('one');
  await assert.rejects(workflow.get('one'), /accessible/i);
});

test('requires an observed revision and rejects unsupported fields or wrong body format', async () => {
  const { workflow } = await fixture();
  const read = await workflow.get('one');
  for (const patch of [{ identityId: 'other' }, { isPlainText: true }, { attachments: [] }, { plainTextBody: 'lose HTML' }, { subject: null }, { to: 'not-an-array' }, {}]) {
    await assert.rejects(workflow.update('one', read.revision, patch));
  }
  await assert.rejects(workflow.update('one', 'unknown', { subject: 'Wrong' }), /changed|revision/i);
});

test('returns a fresh readable revision after editing', async () => {
  const { workflow } = await fixture();
  const before = await workflow.get('one');
  const after = await workflow.update('one', before.revision, { body: '<p>Revised</p>' });
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.details.body, '<p>Revised</p>');
  assert.equal((await workflow.get('one')).revision, after.revision);
});

test('saves only an unchanged observed draft and reports its saved message', async () => {
  const { workflow, windows, counts } = await fixture();
  const before = await workflow.get('two');
  const saved = await workflow.save('two', before.revision);
  assert.equal(saved.mode, 'draft');
  assert.equal(saved.messages[0].id, 42);
  assert.deepEqual(counts(), { saved: 1, applied: 0 });
  windows.get('two').details.plainTextBody = 'Human edit';
  await assert.rejects(workflow.save('two', before.revision), /changed/i);
  assert.equal(counts().saved, 1);
});

test('serializes mutations and rejects a simultaneous stale edit', async () => {
  const { workflow, counts } = await fixture();
  const before = await workflow.get('one');
  const results = await Promise.allSettled([
    workflow.update('one', before.revision, { subject: 'First update' }),
    workflow.update('one', before.revision, { subject: 'Second update' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(counts().applied, 1);
});

test('reports host save failures without claiming success', async () => {
  const { workflow, host } = await fixture();
  host.save = async () => { throw new Error('Disk full'); };
  const read = await workflow.get('one');
  await assert.rejects(workflow.save('one', read.revision), /Disk full/);
});

test('native adapter refuses busy windows, unlocks failed edits, and saves with draft mode only', async () => {
  const { createThunderbirdComposeHost } = await import(pathToFileURL(target));
  assert.equal(typeof createThunderbirdComposeHost, 'function');
  const locks = [];
  const win = { closed: false, gCurrentIdentity: { key: 'id1' }, gMsgCompose: { compFields: { draftId: '' }, originalMsgURI: '' }, gWindowLocked: false,
    ToggleWindowLock(value) { this.gWindowLocked = value; locks.push(value); } };
  const calls = [];
  const compose = {
    getComposeDetails: async () => ({ subject: 'Test', identityId: 'id1' }),
    listAttachments: async () => [],
    setComposeDetails: async (_id, fields) => { calls.push(fields); throw new Error('Editor failed'); },
    saveMessage: async (_id, options) => { assert.equal(win.gWindowLocked, false); return options; },
  };
  const host = createThunderbirdComposeHost({
    windows: () => [win], accounts: () => [{ key: 'allowed', identities: [{ key: 'id1' }] }],
    isAccountAllowed: key => key === 'allowed', compose, tabId: () => 1, token: () => 'opaque-id',
  });
  const [id] = host.list();
  win.gSendOperationInProgress = true;
  await assert.rejects(host.withLock(id, () => host.apply(id, { subject: 'Wrong' })), /busy/i);
  assert.equal(calls.length, 0);
  win.gSendOperationInProgress = false;
  await assert.rejects(host.withLock(id, () => host.apply(id, { subject: 'New' })), /Editor failed/);
  assert.equal(win.gWindowLocked, false);
  assert.deepEqual(locks, [true, false]);
  assert.deepEqual(await host.withLock(id, () => host.save(id)), { mode: 'draft' });
  win.gCurrentIdentity.key = 'private';
  assert.equal(host.allowed(id), false);
});
