const { test } = require('node:test');
const assert = require('node:assert/strict');
async function setup() {
  const { prepareDraftDiscard } = await import('../extension/mcp_server/draft_discard.sys.mjs');
  const header = { messageId: 'draft@example.invalid', messageKey: 7, folder: { URI: 'mailbox://local/Drafts', draft: true, account: 'allowed' } };
  let current = header;
  const moves = [];
  const deps = {
    resolveDraft: () => current,
    isDraftFolder: f => f.draft,
    isFolderAllowed: f => f.account === 'allowed',
    findTrashFolder: () => ({ URI: 'mailbox://local/Trash', account: 'allowed' }),
    moveToTrash: async (h, trash) => { moves.push([h.messageId, trash.URI]); },
  };
  return { prepare: state => prepareDraftDiscard(state, deps), deps, header, moves, replace: h => { current = h; } };
}
test('discard without a saved copy does no mailbox work', async () => {
  const f = await setup();
  f.deps.resolveDraft = () => assert.fail('No URI to resolve');
  assert.equal((await (await f.prepare({ draftId: null })).move()).status, 'notSaved');
});
test('missing saved draft can close without deleting another message', async () => {
  const f = await setup(); f.replace(null);
  assert.equal((await (await f.prepare({ draftId: 'saved' })).move()).status, 'alreadyAbsent');
  assert.deepEqual(f.moves, []);
});
test('discard requires Drafts, allowed folders and a Trash target before close', async () => {
  for (const change of [f => { f.header.folder.draft = false; }, f => { f.header.folder.account = 'private'; }, f => { f.deps.findTrashFolder = () => null; }, f => { f.deps.findTrashFolder = () => ({ account: 'private' }); }]) {
    const f = await setup(); change(f);
    await assert.rejects(f.prepare({ draftId: 'saved' }));
    assert.deepEqual(f.moves, []);
  }
});
test('saved draft moves only to Trash and reports identifiers', async () => {
  const f = await setup();
  const receipt = await (await f.prepare({ draftId: 'saved' })).move();
  assert.equal(receipt.status, 'movedToTrash');
  assert.equal(receipt.messageId, 'draft@example.invalid');
  assert.deepEqual(f.moves, [['draft@example.invalid', 'mailbox://local/Trash']]);
});
test('reused message keys and revoked access cannot delete different mail after closing', async () => {
  for (const revoke of [false, true]) {
    const f = await setup(); const op = await f.prepare({ draftId: 'saved' });
    if (revoke) f.header.folder.account = 'private';
    else f.replace({ ...f.header, messageId: 'other@example.invalid' });
    await assert.rejects(op.move());
    assert.deepEqual(f.moves, []);
  }
});
test('move failure is not a success receipt', async () => {
  const f = await setup();
  f.deps.moveToTrash = async () => { throw new Error('Server rejected move'); };
  await assert.rejects((await f.prepare({ draftId: 'saved' })).move(), /Server rejected/);
});
test('native draft resolver handles exact mailbox, IMAP and Owl keys', async () => {
  const { resolveSavedDraft } = await import('../extension/mcp_server/draft_discard.sys.mjs');
  for (const [uri, folder, key] of [
    ['mailbox-message://nobody@Local%20Folders/Drafts#4', 'mailbox://nobody@Local%20Folders/Drafts', 4],
    ['imap-message://user@host/Drafts#83', 'imap://user@host/Drafts', 83],
    ['owl://user@host/Drafts?number=18', 'owl://user@host/Drafts', 18],
  ]) {
    const header = { messageKey: key };
    const open = actual => {
      assert.equal(actual, folder);
      return { db: { containsKey: k => k === key, getMsgHdrForKey: k => { assert.equal(k, key); return header; } } };
    };
    assert.equal(resolveSavedDraft(uri, open), header);
    assert.equal(resolveSavedDraft(uri, () => ({ db: { containsKey: () => false } })), null);
  }
});
test('native draft resolver rejects malformed keys and folder access errors', async () => {
  const { resolveSavedDraft } = await import('../extension/mcp_server/draft_discard.sys.mjs');
  for (const uri of ['mailbox-message://local/Drafts', 'owl://host/Drafts?number=', 'imap-message://host/Drafts#-1', 'mailbox-message://local/Drafts#9007199254740992']) {
    assert.throws(() => resolveSavedDraft(uri, () => assert.fail('must validate before opening folder')));
  }
  assert.throws(() => resolveSavedDraft('owl://host/Drafts?number=4', () => ({ error: 'Account access denied' })), /access denied/);
});
