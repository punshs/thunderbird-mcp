/** Resolve only the exact native saved-draft key; never guess from message content. */
export function resolveSavedDraft(uri, openFolder) {
  const match = /^(.*)(?:#|\?number=)(\d+)$/.exec(uri);
  if (!match) throw new Error('Unsupported saved draft URI; window left open');
  const key = Number(match[2]);
  if (!Number.isSafeInteger(key)) throw new Error('Invalid saved draft key');
  const folderURI = match[1].replace(/^(imap|mailbox|news)-message:/, '$1:');
  const opened = openFolder(folderURI);
  if (opened.error) throw new Error(opened.error);
  return opened.db.containsKey(key) ? opened.db.getMsgHdrForKey(key) : null;
}

/** Preflight saved-draft discard while its compose window is still open. */
export async function prepareDraftDiscard(state, host) {
  const draftId = state.draftId;
  if (!draftId) return { move: async () => ({ status: 'notSaved' }) };
  const header = host.resolveDraft(draftId);
  if (!header) return { move: async () => ({ status: 'alreadyAbsent', draftId }) };
  function check(hdr) {
    if (!host.isDraftFolder(hdr.folder) || !host.isFolderAllowed(hdr.folder)) {
      throw new Error('Saved message is not in an accessible Drafts folder');
    }
  }
  check(header);
  const trash = host.findTrashFolder(header.folder);
  if (!trash || !host.isFolderAllowed(trash) || trash.URI === header.folder.URI) {
    throw new Error('Accessible Trash folder not found; compose window left open');
  }
  const messageId = header.messageId, folderPath = header.folder.URI, key = header.messageKey;
  return { move: async () => {
    const current = host.resolveDraft(draftId);
    if (!current) return { status: 'alreadyAbsent', draftId };
    check(current);
    if (current.messageId !== messageId || current.messageKey !== key || current.folder.URI !== folderPath ||
        !host.isFolderAllowed(trash)) {
      throw new Error('Saved draft or folder access changed; no message was removed');
    }
    await host.moveToTrash(current, trash);
    return { status: 'movedToTrash', draftId, messageId, folderPath, trashFolderPath: trash.URI };
  } };
}
