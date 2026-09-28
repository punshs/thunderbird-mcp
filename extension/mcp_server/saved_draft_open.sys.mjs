/** Open a stored draft through Thunderbird's native Draft path, never EditAsNew. */
export function createSavedDraftOpener(host, { attempts = 150 } = {}) {
  const pending = new Map();
  // A timeout may mean the native open is still loading. Do not create a second
  // composer on retry while the first operation's outcome remains unknown.
  const opening = new Set();

  async function run(messageId, folderPath) {
    const header = host.resolve(messageId, folderPath);
    const uri = host.uri(header);
    let win = host.windows().find(w => !w.closed && host.matches(w, header));
    const reused = Boolean(win);
    if (!win && !opening.has(uri)) {
      opening.add(uri);
      try { host.open(header); }
      catch (error) { opening.delete(uri); throw error; }
    }
    for (let i = 0; i < attempts; i++) {
      // Re-resolve to enforce folder scope and detect moved/deleted drafts.
      const current = host.resolve(messageId, folderPath);
      if (host.uri(current) !== uri) throw new Error('Saved draft changed while opening; inspect open windows');
      win = host.windows().find(w => !w.closed && host.matches(w, current));
      if (win && host.ready(win)) {
        const state = await host.snapshot(win);
        opening.delete(uri);
        host.focus(win);
        return { ...state, reused };
      }
      await host.wait(100);
    }
    throw new Error('Draft opening timed out; it may still open. Inspect listComposeWindows before retrying.');
  }

  function open(messageId, folderPath) {
    if (typeof messageId !== 'string' || !messageId || typeof folderPath !== 'string' || !folderPath) {
      return Promise.reject(new Error('messageId and folderPath are required'));
    }
    const key = JSON.stringify([folderPath, messageId]);
    if (pending.has(key)) return pending.get(key);
    const task = run(messageId, folderPath).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return { open };
}

/** Match Thunderbird's UI identity hint; the MIME draft loader restores the
 * saved X-Identity-Key and all other draft metadata itself. */
export function openNativeSavedDraft(header, { getIdentity, compose, draftType, defaultFormat }) {
  const identity = getIdentity(header);
  if (!identity) throw new Error('No sender identity available for saved draft');
  compose.OpenComposeWindow(null, header, header.folder.getUriForMsg(header),
    draftType, defaultFormat, identity, null, null);
}
