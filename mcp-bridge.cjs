#!/usr/bin/env node
/**
 * MCP Bridge for Thunderbird
 *
 * Converts stdio MCP protocol to HTTP requests for the Thunderbird MCP extension.
 * The extension exposes an HTTP endpoint on localhost:8765.
 */

const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const THUNDERBIRD_HOSTS = ['127.0.0.1'];
const REQUEST_TIMEOUT = 30000;
const CONNECTION_RETRY_DELAY_MS = 1000;
const CONNECTION_MAX_RETRIES = 5;
const CONNECTION_CACHE_TTL_MS = 5000; // 5 seconds

const DEFAULT_PROC_ROOT = '/proc';
const DEFAULT_DARWIN_FOLDERS_ROOT = '/var/folders';
const THUNDERBIRD_MCP_SUBDIR = 'thunderbird-mcp';
const CONNECTION_FILE_BASENAME = 'connection.json';

// snap-confine gives each snap a private /tmp inside its mount namespace. The
// snap sees TMPDIR=/tmp, but that is NOT the host's /tmp -- from outside the
// namespace the same directory is reachable at
// /tmp/snap-private-tmp/snap.<instance>/tmp. Reading TMPDIR out of
// /proc/<pid>/environ therefore yields a path that resolves to the wrong
// directory for anything running on the host, which is exactly where the
// bridge runs.
const SNAP_PRIVATE_TMP_ROOT = '/tmp/snap-private-tmp';
const DEFAULT_SNAP_INSTANCE = 'thunderbird';

const BRIDGE_VERSION = '0.6.3';

/**
 * MCP revisions this bridge can speak, newest first.
 *
 * The bridge only exposes tools and answers lifecycle methods, and that
 * surface is identical across these revisions, so any of them is safe to
 * agree to.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

/**
 * Pick the protocol version to report from initialize.
 *
 * The spec requires the server to echo the client's requested version when it
 * supports it, and only substitute its own when it does not. This previously
 * returned a hardcoded 2024-11-05 no matter what was asked for; a client that
 * requires the version it proposed sees that as a failed handshake and waits
 * until it times out, while the server looks perfectly healthy from outside.
 */
function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return FALLBACK_PROTOCOL_VERSION;
}

/**
 * Trace the stdio conversation for debugging a stalled handshake.
 *
 * THUNDERBIRD_MCP_DEBUG_FILE appends to a file; THUNDERBIRD_MCP_DEBUG writes
 * to stderr. The file form exists because not every client surfaces a
 * server's stderr -- when a handshake stalls and the client's own log only
 * records what it sent, an absent stderr trace is ambiguous: it cannot
 * distinguish "the bridge never ran" from "the bridge ran and nobody
 * captured it". A file on disk is unambiguous.
 */
function traceStdio(direction, payload) {
  const configured = process.env.THUNDERBIRD_MCP_DEBUG_FILE;
  if (!configured && !process.env.THUNDERBIRD_MCP_DEBUG) {
    return;
  }

  let line;
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    line = `${new Date().toISOString()} [thunderbird-mcp] ${direction} ${text.slice(0, 800)}\n`;
  } catch {
    return; // Tracing must never break the bridge.
  }

  if (process.env.THUNDERBIRD_MCP_DEBUG) {
    try {
      process.stderr.write(line);
    } catch { /* ignore */ }
  }

  if (!configured) {
    return;
  }

  // A client that does not expand ${HOME} and friends hands the literal
  // string through, and appending to it fails on a directory that cannot
  // exist. Silently swallowing that is how a trace file goes missing and
  // looks like "the bridge never ran" -- so fall back to a path that is
  // always writable, and say so on stderr.
  const targets = [configured];
  if (/\$\{|^~|^(?!\/)/.test(configured)) {
    targets.push(path.join(os.tmpdir(), 'thunderbird-mcp-trace.log'));
  }

  for (const target of targets) {
    try {
      fs.appendFileSync(target, line);
      return;
    } catch (err) {
      try {
        process.stderr.write(
          `[thunderbird-mcp] could not write trace to ${target}: ${err.message}\n`
        );
      } catch { /* ignore */ }
    }
  }
}

let cachedConnectionInfo = null;
let connectionCacheExpiry = 0;
let lastDiscoveryAttempts = [];

function normalizeFsError(err) {
  if (!err) {
    return 'unknown error';
  }
  if (err.code === 'ENOENT') {
    return 'file not found';
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return 'permission denied';
  }
  return err.message || String(err);
}

function getCurrentUid(processImpl = process) {
  return typeof processImpl.getuid === 'function' ? processImpl.getuid() : null;
}

function createDiscoveryContext(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const pathImpl = options.pathImpl || path;
  const osImpl = options.osImpl || os;
  const processImpl = options.processImpl || process;
  const env = options.env || processImpl.env || {};
  const uid = Object.prototype.hasOwnProperty.call(options, 'uid')
    ? options.uid
    : getCurrentUid(processImpl);

  return {
    fsImpl,
    pathImpl,
    osImpl,
    processImpl,
    env,
    uid,
    platform: options.platform || processImpl.platform,
    homeDir: Object.prototype.hasOwnProperty.call(options, 'homeDir')
      ? options.homeDir
      : osImpl.homedir(),
    procRoot: options.procRoot || DEFAULT_PROC_ROOT,
    darwinFoldersRoot: options.darwinFoldersRoot || DEFAULT_DARWIN_FOLDERS_ROOT,
    runtimeDir: Object.prototype.hasOwnProperty.call(options, 'runtimeDir')
      ? options.runtimeDir
      : getRuntimeDir({ env, pathImpl, uid }),
  };
}

function getRuntimeDir({ env, pathImpl, uid }) {
  if (env.XDG_RUNTIME_DIR) {
    return env.XDG_RUNTIME_DIR;
  }
  if (uid !== null && uid !== undefined) {
    return pathImpl.join('/run/user', String(uid));
  }
  return null;
}

function getDefaultConnectionFile(context) {
  return context.pathImpl.join(
    context.osImpl.tmpdir(),
    THUNDERBIRD_MCP_SUBDIR,
    CONNECTION_FILE_BASENAME
  );
}

function makeAttempt(label, filePath, reason) {
  return { label, path: filePath, reason };
}

function makeCandidate(label, filePath, mtimeMs = Number.NEGATIVE_INFINITY) {
  return { label, path: filePath, mtimeMs };
}

function addUniqueCandidate(candidates, seenPaths, candidate) {
  if (!candidate.path || seenPaths.has(candidate.path)) {
    return;
  }
  seenPaths.add(candidate.path);
  candidates.push(candidate);
}

function sortCandidatesByMtime(candidates) {
  // When a sandbox scan yields multiple connection files, try the newest file
  // first so selection is deterministic without silently ignoring other paths.
  return candidates.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return a.path.localeCompare(b.path);
  });
}

function buildScanGroup(label, pattern, candidates, noMatchReason) {
  const notes = [];
  if (candidates.length === 0) {
    notes.push(makeAttempt(label, pattern, noMatchReason));
    return { notes, candidates };
  }
  if (candidates.length > 1) {
    notes.push(makeAttempt(label, pattern, `multiple matches found, trying newest first (${candidates.length} files)`));
  }
  return { notes, candidates: sortCandidatesByMtime(candidates) };
}

function findMacOsConnectionCandidates(context) {
  const { fsImpl, pathImpl, darwinFoldersRoot, uid } = context;
  const pattern = pathImpl.join(
    darwinFoldersRoot,
    '*',
    '*',
    'T',
    THUNDERBIRD_MCP_SUBDIR,
    CONNECTION_FILE_BASENAME
  );

  let firstLevel;
  try {
    firstLevel = fsImpl.readdirSync(darwinFoldersRoot, { withFileTypes: true });
  } catch (err) {
    return {
      notes: [makeAttempt('macOS temp scan', pattern, normalizeFsError(err))],
      candidates: [],
    };
  }

  const candidates = [];
  const seenPaths = new Set();

  for (const firstDir of firstLevel) {
    if (!firstDir.isDirectory()) {
      continue;
    }

    let secondLevel;
    const firstPath = pathImpl.join(darwinFoldersRoot, firstDir.name);
    try {
      secondLevel = fsImpl.readdirSync(firstPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const secondDir of secondLevel) {
      if (!secondDir.isDirectory()) {
        continue;
      }

      const candidatePath = pathImpl.join(
        firstPath,
        secondDir.name,
        'T',
        THUNDERBIRD_MCP_SUBDIR,
        CONNECTION_FILE_BASENAME
      );

      try {
        const stat = fsImpl.statSync(candidatePath);
        if (!stat.isFile()) {
          continue;
        }
        if (uid !== null && uid !== undefined && stat.uid !== uid) {
          continue;
        }
        addUniqueCandidate(candidates, seenPaths, makeCandidate('macOS temp scan', candidatePath, stat.mtimeMs));
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
          continue;
        }
      }
    }
  }

  const ownerText = uid !== null && uid !== undefined
    ? `no matching files owned by uid ${uid}`
    : 'no matching files';

  return buildScanGroup('macOS temp scan', pattern, candidates, ownerText);
}

function findSnapConnectionCandidates(context) {
  const { fsImpl, pathImpl, homeDir, procRoot } = context;
  const snapDir = homeDir ? pathImpl.join(homeDir, 'snap', 'thunderbird') : null;
  const pattern = pathImpl.join(procRoot, '<pid>', 'environ');

  if (!snapDir) {
    return {
      notes: [makeAttempt('Snap detection', pattern, 'home directory unavailable')],
      candidates: [],
    };
  }

  // Detect a snap install from any of several signals, not just ~/snap. The
  // Thunderbird snap points TMPDIR at ~/Downloads/thunderbird.tmp so the
  // desktop portal can reach temp files, and that directory is by itself
  // proof of a snap -- but the old ~/snap-only probe returned early before
  // the Downloads fallback below was ever considered, so a layout the
  // function already knew how to handle was reported as
  // 'snap install not detected'.
  const downloadsTmp = pathImpl.join(homeDir, 'Downloads', 'thunderbird.tmp');
  const privateTmpDir = pathImpl.join(SNAP_PRIVATE_TMP_ROOT, `snap.${DEFAULT_SNAP_INSTANCE}`);
  const exists = (p) => {
    try {
      fsImpl.accessSync(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (!exists(snapDir) && !exists(downloadsTmp) && !exists(privateTmpDir)) {
    return {
      notes: [makeAttempt('Snap detection', pattern, 'snap install not detected')],
      candidates: [],
    };
  }

  const candidates = [];
  const seenPaths = new Set();

  try {
    const procDirs = fsImpl.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
    for (const pid of procDirs) {
      try {
        const cmdline = fsImpl.readFileSync(pathImpl.join(procRoot, pid, 'cmdline'), 'utf8');
        // Match argv[0] basename precisely -- not any occurrence of 'thunderbird'
        // in argv. A text editor opened on 'thunderbird.txt' would have the
        // substring in argv[1], and we do NOT want to read its TMPDIR.
        const argv0 = cmdline.split('\0')[0] || '';
        const argv0Basename = pathImpl.basename(argv0);
        if (!/^(thunderbird|betterbird)(-.+)?$/.test(argv0Basename)) {
          continue;
        }

        const environ = fsImpl.readFileSync(pathImpl.join(procRoot, pid, 'environ'), 'utf8');
        const tmpEntry = environ.split('\0').find((entry) => entry.startsWith('TMPDIR='));
        if (!tmpEntry) {
          continue;
        }

        const tmpDir = tmpEntry.slice('TMPDIR='.length);
        const candidatePath = pathImpl.join(tmpDir, THUNDERBIRD_MCP_SUBDIR, CONNECTION_FILE_BASENAME);
        let mtimeMs = Number.NEGATIVE_INFINITY;
        try {
          mtimeMs = fsImpl.statSync(candidatePath).mtimeMs;
        } catch {
          // Missing file is handled later when the candidate is read.
        }
        addUniqueCandidate(
          candidates,
          seenPaths,
          makeCandidate(`Snap TMPDIR from /proc/${pid}/environ`, candidatePath, mtimeMs)
        );

        // The TMPDIR above is namespace-relative. Translate it to the host
        // path so the bridge can actually read the file. SNAP_INSTANCE_NAME
        // distinguishes parallel installs (thunderbird_beta and friends);
        // fall back to the plain name when it is absent.
        const instanceEntry = environ
          .split('\0')
          .find((entry) => entry.startsWith('SNAP_INSTANCE_NAME=') || entry.startsWith('SNAP_NAME='));
        const instance = instanceEntry
          ? instanceEntry.slice(instanceEntry.indexOf('=') + 1)
          : DEFAULT_SNAP_INSTANCE;
        if (instance) {
          const hostPath = pathImpl.join(
            SNAP_PRIVATE_TMP_ROOT,
            `snap.${instance}`,
            tmpDir,
            THUNDERBIRD_MCP_SUBDIR,
            CONNECTION_FILE_BASENAME
          );
          let hostMtime = Number.NEGATIVE_INFINITY;
          try {
            hostMtime = fsImpl.statSync(hostPath).mtimeMs;
          } catch {
            // Missing file is handled later when the candidate is read.
          }
          addUniqueCandidate(
            candidates,
            seenPaths,
            makeCandidate(`Snap private tmp for snap.${instance}`, hostPath, hostMtime)
          );
        }
      } catch {
        // Processes can disappear or deny access while we scan /proc.
      }
    }
  } catch (err) {
    return {
      notes: [makeAttempt('Snap detection', pattern, normalizeFsError(err))],
      candidates: [],
    };
  }

  // Static form of the private-tmp path, for when /proc gave us nothing --
  // Thunderbird not running yet, or environ unreadable. snap-confine's layout
  // is fixed, so this is a safe guess even without the process.
  const privateTmpFallback = pathImpl.join(
    SNAP_PRIVATE_TMP_ROOT,
    `snap.${DEFAULT_SNAP_INSTANCE}`,
    'tmp',
    THUNDERBIRD_MCP_SUBDIR,
    CONNECTION_FILE_BASENAME
  );
  let privateTmpMtime = Number.NEGATIVE_INFINITY;
  try {
    privateTmpMtime = fsImpl.statSync(privateTmpFallback).mtimeMs;
  } catch {
    // Missing file is handled later when the candidate is read.
  }
  addUniqueCandidate(
    candidates,
    seenPaths,
    makeCandidate('Snap private tmp fallback', privateTmpFallback, privateTmpMtime)
  );

  // Match the official snap tmpdir helper as a best-effort fallback when /proc
  // cannot tell us the runtime TMPDIR.
  const fallbackPath = pathImpl.join(
    homeDir,
    'Downloads',
    'thunderbird.tmp',
    THUNDERBIRD_MCP_SUBDIR,
    CONNECTION_FILE_BASENAME
  );
  let fallbackMtime = Number.NEGATIVE_INFINITY;
  try {
    fallbackMtime = fsImpl.statSync(fallbackPath).mtimeMs;
  } catch {
    // Missing file is handled later when the candidate is read.
  }
  addUniqueCandidate(
    candidates,
    seenPaths,
    makeCandidate('Snap Downloads fallback', fallbackPath, fallbackMtime)
  );

  return buildScanGroup('Snap detection', pattern, candidates, 'no thunderbird TMPDIR candidates found');
}

function findFlatpakConnectionCandidates(context) {
  const { fsImpl, pathImpl, runtimeDir } = context;
  const patternBase = runtimeDir || '$XDG_RUNTIME_DIR';
  const pattern = pathImpl.join(
    patternBase,
    'app',
    '*',
    THUNDERBIRD_MCP_SUBDIR,
    CONNECTION_FILE_BASENAME
  );

  if (!runtimeDir) {
    return {
      notes: [makeAttempt('Flatpak scan', pattern, 'runtime dir unavailable')],
      candidates: [],
    };
  }

  const appRoot = pathImpl.join(runtimeDir, 'app');
  let appEntries;
  try {
    appEntries = fsImpl.readdirSync(appRoot, { withFileTypes: true });
  } catch (err) {
    return {
      notes: [makeAttempt('Flatpak scan', pattern, normalizeFsError(err))],
      candidates: [],
    };
  }

  const candidates = [];
  const seenPaths = new Set();

  for (const appEntry of appEntries) {
    if (!appEntry.isDirectory()) {
      continue;
    }

    const candidatePath = pathImpl.join(
      appRoot,
      appEntry.name,
      THUNDERBIRD_MCP_SUBDIR,
      CONNECTION_FILE_BASENAME
    );

    try {
      const stat = fsImpl.statSync(candidatePath);
      if (!stat.isFile()) {
        continue;
      }
      addUniqueCandidate(candidates, seenPaths, makeCandidate('Flatpak runtime scan', candidatePath, stat.mtimeMs));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        continue;
      }
    }
  }

  return buildScanGroup('Flatpak scan', pattern, candidates, 'no matching files');
}

function buildCandidateGroups(options = {}) {
  const context = createDiscoveryContext(options);
  const groups = [];

  if (context.env.THUNDERBIRD_MCP_CONNECTION_FILE) {
    groups.push({
      notes: [],
      candidates: [
        makeCandidate(
          'THUNDERBIRD_MCP_CONNECTION_FILE',
          context.env.THUNDERBIRD_MCP_CONNECTION_FILE
        )
      ],
      stopOnFailure: true,
      context,
    });
    return groups;
  }

  groups.push({
    notes: [],
    candidates: [makeCandidate('native tmp', getDefaultConnectionFile(context))],
    stopOnFailure: false,
    context,
  });

  if (context.platform === 'darwin') {
    groups.push({ ...findMacOsConnectionCandidates(context), stopOnFailure: false, context });
  }

  if (context.platform === 'linux') {
    groups.push({ ...findSnapConnectionCandidates(context), stopOnFailure: false, context });
    groups.push({ ...findFlatpakConnectionCandidates(context), stopOnFailure: false, context });
  }

  return groups;
}

function tryReadConnectionCandidate(candidate, context) {
  try {
    const raw = context.fsImpl.readFileSync(candidate.path, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        attempt: makeAttempt(candidate.label, candidate.path, `malformed JSON (${err.message})`)
      };
    }

    if (!data.port || !data.token) {
      return {
        ok: false,
        attempt: makeAttempt(candidate.label, candidate.path, 'missing port or token')
      };
    }

    return {
      ok: true,
      data,
      attempt: makeAttempt(candidate.label, candidate.path, 'ok')
    };
  } catch (err) {
    return {
      ok: false,
      attempt: makeAttempt(candidate.label, candidate.path, normalizeFsError(err))
    };
  }
}

function discoverConnectionInfo(options = {}) {
  const groups = buildCandidateGroups(options);
  const attempts = [];

  for (const group of groups) {
    attempts.push(...group.notes);

    for (const candidate of group.candidates) {
      const result = tryReadConnectionCandidate(candidate, group.context);
      attempts.push(result.attempt);
      if (result.ok) {
        return { data: result.data, attempts, selectedPath: candidate.path };
      }
      if (group.stopOnFailure) {
        return { data: null, attempts, selectedPath: null };
      }
    }
  }

  return { data: null, attempts, selectedPath: null };
}

/**
 * Read connection info (port + auth token) written by the Thunderbird extension.
 * Returns { port, token } or null if no valid candidate exists.
 * Caches the result for a short TTL to avoid hitting the filesystem on every request.
 * Cache is cleared on connection errors (see clearConnectionCache).
 */
function readConnectionInfo(options = {}) {
  if (cachedConnectionInfo && Date.now() < connectionCacheExpiry) {
    return cachedConnectionInfo;
  }

  const result = discoverConnectionInfo(options);
  lastDiscoveryAttempts = result.attempts;

  if (!result.data) {
    return null;
  }

  cachedConnectionInfo = result.data;
  connectionCacheExpiry = Date.now() + CONNECTION_CACHE_TTL_MS;
  return result.data;
}

function clearConnectionCache() {
  cachedConnectionInfo = null;
  connectionCacheExpiry = 0;
}

function formatDiscoveryAttempts(attempts = lastDiscoveryAttempts) {
  if (!attempts.length) {
    return 'no candidates generated';
  }

  return attempts
    .map((attempt) => `${attempt.label} (${attempt.path}): ${attempt.reason}`)
    .join('; ');
}

function buildConnectionDiscoveryErrorMessage() {
  return (
    'Connection discovery failed. ' +
    'Tried: ' + formatDiscoveryAttempts() + '. ' +
    'Is Thunderbird running with the MCP extension? ' +
    'The extension must be started first to create the connection file.'
  );
}

function sanitizeJson(data) {
  // Remove control chars except \n, \r, \t
  let sanitized = data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Escape raw newlines/carriage returns/tabs that aren't already escaped.
  // Match an even number of backslashes (including zero) before the control
  // char so we don't double-escape already-escaped sequences like \n, but
  // do escape after literal backslash pairs like \\\n (escaped-backslash + raw newline).
  sanitized = sanitized.replace(/((?:^|[^\\])(?:\\\\)*)\r/gm, '$1\\r');
  sanitized = sanitized.replace(/((?:^|[^\\])(?:\\\\)*)\n/gm, '$1\\n');
  sanitized = sanitized.replace(/((?:^|[^\\])(?:\\\\)*)\t/gm, '$1\\t');
  return sanitized;
}

async function handleMessage(line) {
  const message = JSON.parse(line);
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const isNotification =
    !hasId ||
    (typeof message.method === 'string' && message.method.startsWith('notifications/'));

  if (isNotification) {
    return null;
  }

  // Handle MCP lifecycle methods locally so the bridge can complete
  // handshake even when Thunderbird isn't running yet.
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: 'thunderbird-mcp', version: BRIDGE_VERSION }
        }
      };
    case 'ping':
      return { jsonrpc: '2.0', id: message.id, result: {} };
    case 'resources/list':
      return { jsonrpc: '2.0', id: message.id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id: message.id, result: { prompts: [] } };
  }

  return forwardToThunderbird(message);
}

function tryRequest(hostname, postData, port, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const req = http.request({
      hostname,
      port,
      path: '/',
      method: 'POST',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 403) {
          clearConnectionCache();
          reject(new Error('Authentication failed (403). Token may be stale — retrying with fresh connection info.'));
          return;
        }
        const data = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(data));
        } catch {
          try {
            resolve(JSON.parse(sanitizeJson(data)));
          } catch (e) {
            reject(new Error(`Invalid JSON from Thunderbird: ${e.message}`));
          }
        }
      });
    });

    req.on('error', reject);

    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Request to Thunderbird timed out'));
    });

    req.write(postData);
    req.end();
  });
}

async function forwardToThunderbird(message, _retried) {
  const postData = JSON.stringify(message);

  // Read connection info (port + auth token) from the file written by the extension.
  // Fail-closed: if the connection file is missing, retry a few times
  // (Thunderbird may still be starting), then fail with an error.
  // Never forward requests without authentication.
  let connInfo = readConnectionInfo();
  if (!connInfo) {
    for (let attempt = 0; attempt < CONNECTION_MAX_RETRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, CONNECTION_RETRY_DELAY_MS));
      connInfo = readConnectionInfo();
      if (connInfo) {
        break;
      }
    }
    if (!connInfo) {
      throw new Error(buildConnectionDiscoveryErrorMessage());
    }
  }

  if (!connInfo.port || !connInfo.token) {
    throw new Error('Invalid connection file: missing port or token');
  }
  if (typeof connInfo.port !== 'number' || connInfo.port < 1 || connInfo.port > 65535 || !Number.isInteger(connInfo.port)) {
    throw new Error('Invalid connection file: port must be an integer between 1 and 65535');
  }

  const { port, token } = connInfo;

  // Try each host in order - handles platforms where 'localhost' resolves to
  // IPv6 (::1) but the extension only listens on IPv4 (127.0.0.1).
  const tryNext = (hosts) => {
    const [hostname, ...rest] = hosts;
    return tryRequest(hostname, postData, port, token).catch((err) => {
      if (rest.length > 0 && (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL')) {
        return tryNext(rest);
      }
      // On 403 or connection refused, clear cache and retry once with fresh
      // connection info (Thunderbird may have restarted on a new port/token).
      if (!_retried) {
        if (err.message && err.message.includes('403')) {
          clearConnectionCache();
          return forwardToThunderbird(message, true);
        }
        if (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
          clearConnectionCache();
          return forwardToThunderbird(message, true);
        }
      }
      // Already retried or non-recoverable error
      if (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
        throw new Error(`Connection failed: ${err.message}. Is Thunderbird running with the MCP extension?`);
      }
      throw err;
    });
  };

  return tryNext(THUNDERBIRD_HOSTS);
}

function startBridge() {
  // Recorded before anything else so the trace distinguishes "never started"
  // from "started and then went quiet", and identifies which runtime and
  // which copy of this file the client actually launched.
  traceStdio('boot   ', {
    version: BRIDGE_VERSION,
    node: process.version,
    execPath: process.execPath,
    script: __filename,
    pid: process.pid,
    connectionFileEnv: process.env.THUNDERBIRD_MCP_CONNECTION_FILE || null,
  });

  // Ensure stdout doesn't buffer - critical for MCP protocol
  if (process.stdout._handle?.setBlocking) {
    process.stdout._handle.setBlocking(true);
  }

  process.on('uncaughtException', (err) => {
    traceStdio('FATAL  ', { message: err.message, stack: err.stack });
    process.exit(1);
  });

  let pendingRequests = 0;
  let stdinClosed = false;

  function checkExit() {
    if (stdinClosed && pendingRequests === 0) {
      process.exit(0);
    }
  }

  function writeOutput(data) {
    return new Promise((resolve) => {
      if (process.stdout.write(data)) {
        resolve();
      } else {
        process.stdout.once('drain', resolve);
      }
    });
  }

  // Process stdin as JSON-RPC messages
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    let messageId = null;
    try {
      messageId = JSON.parse(line).id ?? null;
    } catch {
      // Leave as null when request cannot be parsed
    }

    traceStdio('<-- in ', line);

    pendingRequests++;
    handleMessage(line)
      .then(async (response) => {
        if (response !== null) {
          traceStdio('--> out', response);
          await writeOutput(JSON.stringify(response) + '\n');
        } else {
          traceStdio('--- notification, no reply', line);
        }
      })
      .catch(async (err) => {
        const failure = {
          jsonrpc: '2.0',
          id: messageId,
          error: { code: -32700, message: `Bridge error: ${err.message}` }
        };
        traceStdio('--> err', failure);
        await writeOutput(JSON.stringify(failure) + '\n');
      })
      .finally(() => {
        pendingRequests--;
        checkExit();
      });
  });

  rl.on('close', () => {
    stdinClosed = true;
    checkExit();
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

if (require.main === module) {
  startBridge();
}

module.exports = {
  buildCandidateGroups,
  buildConnectionDiscoveryErrorMessage,
  clearConnectionCache,
  createDiscoveryContext,
  discoverConnectionInfo,
  findFlatpakConnectionCandidates,
  findMacOsConnectionCandidates,
  findSnapConnectionCandidates,
  formatDiscoveryAttempts,
  readConnectionInfo,
  startBridge,
};
