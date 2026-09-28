/** Open-window draft operations. The host owns Thunderbird API access and UI locking. */
export function createComposeWindowWorkflow(host) {
  const snapshots = new Map();
  const pending = new Map();

  function accessible(id) {
    if (typeof id !== 'string' || !id || !host.allowed(id)) {
      snapshots.delete(id);
      throw new Error('Compose window is closed or not accessible');
    }
  }

  async function get(id) {
    accessible(id);
    const state = await host.read(id);
    accessible(id);
    const fingerprint = JSON.stringify(state);
    const prior = snapshots.get(id);
    const revision = prior?.fingerprint === fingerprint ? prior.revision : host.token();
    snapshots.set(id, { fingerprint, revision });
    return { composeId: id, revision, ...state };
  }

  async function list() {
    const ids = host.list();
    for (const id of snapshots.keys()) if (!ids.includes(id)) snapshots.delete(id);
    const windows = [], errors = [];
    for (const id of ids) {
      if (!host.allowed(id)) continue;
      try {
        const state = await get(id);
        const { subject, to, cc, bcc, identityId, isPlainText } = state.details;
        windows.push({ composeId: id, revision: state.revision, accountId: state.accountId,
          subject, to, cc, bcc, identityId, isPlainText, attachments: state.attachments,
          originalMessageURI: state.originalMessageURI, draftId: state.draftId });
      } catch (error) {
        errors.push({ composeId: id, error: String(error.message || error) });
      }
    }
    return { windows, errors };
  }

  async function mutate(id, expectedRevision, action) {
    accessible(id);
    const previous = pending.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => host.withLock(id, async () => {
      const current = await get(id);
      if (!expectedRevision || current.revision !== expectedRevision) {
        throw new Error('Draft changed or revision is unknown; read the compose window again before editing, saving or closing');
      }
      accessible(id);
      return action(current);
    }));
    pending.set(id, task);
    try { return await task; }
    finally { if (pending.get(id) === task) pending.delete(id); }
  }

  async function update(id, expectedRevision, changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
      throw new Error('Supply at least one compose field to update');
    }
    const allowed = ['subject', 'to', 'cc', 'bcc', 'body', 'plainTextBody'];
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.includes(key)) throw new Error(`Unsupported compose field: ${key}`);
      if (['to', 'cc', 'bcc'].includes(key)) {
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || /[\r\n]/.test(v))) {
          throw new Error(`${key} must be an array of single-line address strings`);
        }
      } else if (typeof value !== 'string' || (key === 'subject' && /[\r\n]/.test(value))) {
        throw new Error(`${key} must be a string (subject must be single-line)`);
      }
    }
    return mutate(id, expectedRevision, async current => {
      if ((current.details.isPlainText && 'body' in changes) ||
          (!current.details.isPlainText && 'plainTextBody' in changes)) {
        throw new Error('Body format must match the existing compose window; use body for HTML or plainTextBody for plain text');
      }
      await host.apply(id, { ...changes });
      return get(id);
    });
  }

  async function save(id, expectedRevision) {
    return mutate(id, expectedRevision, async () => {
      const result = await host.save(id);
      return { composeId: id, ...result };
    });
  }

  // Native saving changes bookkeeping, not the content the caller approved.
  function content(state) {
    const details = { ...state.details };
    delete details.isModified;
    // Saving a reopened draft replaces its stored header; Thunderbird may
    // allocate another WebExtension message ID for the same original URI.
    // Keep checking originalMessageURI below, which is the stable source.
    if (details.type === 'draft') delete details.relatedMessageId;
    return JSON.stringify({ accountId: state.accountId, details,
      attachments: state.attachments, originalMessageURI: state.originalMessageURI });
  }

  async function close(id, expectedRevision, mode) {
    if (!['save', 'discard'].includes(mode)) throw new Error('Close mode must be save or discard');
    return mutate(id, expectedRevision, async current => {
      if (mode === 'save') {
        const saved = await host.save(id);
        // save releases the native editing lock. Reacquire and compare before
        // closing so user/extension changes during an asynchronous save survive.
        return host.withLock(id, async () => {
          const after = await get(id);
          if (content(current) !== content(after) || after.details.isModified === true) {
            throw new Error(`Draft changed during save; saved copy retained and window left open (contentChanged=${content(current) !== content(after)}, modified=${after.details.isModified})`);
          }
          await host.close(id);
          snapshots.delete(id);
          return { composeId: id, closed: true, mode, saved };
        });
      }
      const prepared = await host.prepareDiscard(current);
      if ((await get(id)).revision !== expectedRevision) {
        throw new Error('Draft changed before closing; read the compose window again');
      }
      await host.close(id);
      snapshots.delete(id);
      // No open editor can autosave/recreate the draft after this point.
      try {
        return { composeId: id, closed: true, mode, savedDraft: await prepared.move() };
      } catch (error) {
        return { composeId: id, closed: true, mode, savedDraft: {
          status: 'failed', draftId: current.draftId || null, error: String(error.message || error),
        } };
      }
    });
  }

  return { list, get, update, save, close };
}

/** Thunderbird adapter, with native dependencies injected for focused tests. */
export function createThunderbirdComposeHost({ windows, accounts, isAccountAllowed, compose, tabId, token, prepareDiscard }) {
  const ids = new WeakMap();
  const live = new Map();
  const locked = new Set();

  function list() {
    const current = new Set();
    for (const win of windows()) {
      if (win.closed || !win.gMsgCompose) continue;
      if (!ids.has(win)) ids.set(win, token());
      const id = ids.get(win);
      current.add(id);
      live.set(id, win);
    }
    for (const id of live.keys()) if (!current.has(id)) live.delete(id);
    return [...current];
  }

  function accountFor(win) {
    if (!win || win.closed) return null;
    const key = win.gCurrentIdentity?.key;
    if (!key) return null;
    for (const account of accounts()) {
      if ([...account.identities].some(identity => identity.key === key)) return account;
    }
    return null;
  }

  function allowed(id) {
    const account = accountFor(live.get(id));
    return Boolean(account && isAccountAllowed(account.key));
  }

  function windowFor(id) {
    if (!allowed(id)) throw new Error('Compose window is closed or not accessible');
    return live.get(id);
  }

  async function read(id) {
    const win = windowFor(id);
    const tab = tabId(win);
    const details = await compose.getComposeDetails(tab);
    const attachments = await compose.listAttachments(tab);
    windowFor(id);
    return { accountId: accountFor(win).key, details, attachments,
      originalMessageURI: win.gMsgCompose.originalMsgURI || null,
      draftId: win.gMsgCompose.compFields.draftId || null };
  }

  async function withLock(id, action) {
    const win = windowFor(id);
    if (win.gWindowLocked || win.gSendOperationInProgress || win.gSaveOperationInProgress || locked.has(id)) {
      throw new Error('Compose window is busy; wait for the current operation to finish');
    }
    if (typeof win.ToggleWindowLock !== 'function') throw new Error('Compose window does not support editing lock');
    win.ToggleWindowLock(true);
    locked.add(id);
    try { return await action(); }
    finally {
      if (locked.delete(id) && !win.closed) win.ToggleWindowLock(false);
    }
  }

  async function apply(id, changes) {
    const win = windowFor(id);
    if (!locked.has(id)) throw new Error('Compose update requires the editing lock');
    return compose.setComposeDetails(tabId(win), changes);
  }

  async function save(id) {
    const win = windowFor(id);
    // Thunderbird's save command must see an unlocked composer. Release our
    // UI lock immediately before invoking the native draft-only operation;
    // its own save lifecycle owns the window from here. Never invoke send.
    if (!locked.delete(id)) throw new Error('Compose save requires the editing lock');
    win.ToggleWindowLock(false);
    const result = await compose.saveMessage(tabId(win), { mode: 'draft' });
    // The native receipt can resolve before ComposeProcessDone clears the
    // editor's modified flag. Let that UI turn finish before the workflow
    // reacquires its lock and compares content. Later edits still fail closed.
    await new Promise(resolve => win.setTimeout(resolve, 0));
    return result;
  }

  async function close(id) {
    const win = windowFor(id);
    if (!locked.has(id)) throw new Error('Compose close requires the editing lock');
    if (win.gSendOperationInProgress || win.gSaveOperationInProgress) {
      throw new Error('Compose window is busy; cannot close');
    }
    // Like Thunderbird's windows.remove API, call window.close directly.
    // Do NOT call ComposeCanClose/RemoveDraft: those prompt or hard-delete.
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        win.clearTimeout(timer);
        win.removeEventListener('unload', onUnload);
      };
      const onUnload = event => {
        if (event.target !== win.document) return;
        cleanup();
        resolve();
      };
      const timer = win.setTimeout(() => {
        cleanup();
        reject(new Error('Compose window did not close; saved draft was not removed'));
      }, 5000);
      win.addEventListener('unload', onUnload);
      try { win.close(); }
      catch (error) { cleanup(); reject(error); }
    });
    live.delete(id);
  }

  return { list, allowed, read, withLock, apply, save, close, prepareDiscard, token,
    idForWindow(win) { list(); return ids.get(win); } };
}
