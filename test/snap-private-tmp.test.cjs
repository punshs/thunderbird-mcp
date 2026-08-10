"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createDiscoveryContext, findSnapConnectionCandidates } = require("../mcp-bridge.cjs");

/**
 * Minimal fs stand-in. `files` maps absolute path -> mtimeMs; `dirs` is the set
 * of directories that exist. Anything else raises ENOENT the way node's fs does.
 */
function makeFs({ files = {}, dirs = [], procEntries = [] } = {}) {
  const dirSet = new Set(dirs);
  return {
    constants: { F_OK: 0 },
    accessSync(p) {
      if (!dirSet.has(p) && !(p in files)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
    },
    statSync(p) {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return { isFile: () => true, mtimeMs: files[p], uid: 1000 };
    },
    readdirSync() {
      return procEntries.map(e => e.pid);
    },
    readFileSync(p) {
      const m = /\/proc\/(\d+)\/(cmdline|environ)$/.exec(p);
      if (m) {
        const entry = procEntries.find(e => e.pid === m[1]);
        if (entry) return entry[m[2]];
      }
      const err = new Error(`ENOENT: ${p}`);
      err.code = "ENOENT";
      throw err;
    },
  };
}

const HOME = "/home/tester";
const SNAP_DIR = path.join(HOME, "snap", "thunderbird");
// What the bridge, running on the host, must end up reading.
const HOST_PATH = "/tmp/snap-private-tmp/snap.thunderbird/tmp/thunderbird-mcp/connection.json";
// What TMPDIR literally says, which resolves to the wrong directory on the host.
const NAMESPACE_PATH = "/tmp/thunderbird-mcp/connection.json";

function snapProc({ instanceVar = "SNAP_INSTANCE_NAME=thunderbird", tmpdir = "/tmp" } = {}) {
  return [{
    pid: "4242",
    cmdline: "/snap/thunderbird/current/usr/lib/thunderbird/thunderbird\0",
    environ: `TMPDIR=${tmpdir}\0${instanceVar}\0HOME=${HOME}\0`,
  }];
}

function run(fsImpl) {
  const context = createDiscoveryContext({
    fsImpl,
    pathImpl: path,
    homeDir: HOME,
    procRoot: "/proc",
    platform: "linux",
    uid: 1000,
    env: {},
    osImpl: { homedir: () => HOME },
    processImpl: { platform: "linux", env: {}, getuid: () => 1000 },
  });
  return findSnapConnectionCandidates(context);
}

describe("Snap private /tmp translation", () => {
  it("finds the connection file at the host-visible private tmp path", () => {
    const fsImpl = makeFs({
      dirs: [SNAP_DIR],
      files: { [HOST_PATH]: 5000 },
      procEntries: snapProc(),
    });
    const paths = run(fsImpl).candidates.map(c => c.path);
    assert.ok(
      paths.includes(HOST_PATH),
      `expected host private-tmp path among candidates, got:\n${paths.join("\n")}`
    );
  });

  it("still offers the raw TMPDIR path, for non-namespaced setups", () => {
    const fsImpl = makeFs({
      dirs: [SNAP_DIR],
      files: { [NAMESPACE_PATH]: 5000 },
      procEntries: snapProc(),
    });
    const paths = run(fsImpl).candidates.map(c => c.path);
    assert.ok(paths.includes(NAMESPACE_PATH), "raw TMPDIR candidate must not be dropped");
  });

  it("honours SNAP_INSTANCE_NAME for parallel installs", () => {
    const fsImpl = makeFs({
      dirs: [SNAP_DIR],
      files: {},
      procEntries: snapProc({ instanceVar: "SNAP_INSTANCE_NAME=thunderbird_beta" }),
    });
    const paths = run(fsImpl).candidates.map(c => c.path);
    assert.ok(
      paths.some(p => p.includes("snap.thunderbird_beta/")),
      `expected parallel-install path, got:\n${paths.join("\n")}`
    );
  });

  it("falls back to SNAP_NAME when SNAP_INSTANCE_NAME is absent", () => {
    const fsImpl = makeFs({
      dirs: [SNAP_DIR],
      files: {},
      procEntries: snapProc({ instanceVar: "SNAP_NAME=thunderbird" }),
    });
    const paths = run(fsImpl).candidates.map(c => c.path);
    assert.ok(paths.includes(HOST_PATH), "SNAP_NAME should still yield the private tmp path");
  });

  it("offers the static private-tmp path when Thunderbird is not running", () => {
    const fsImpl = makeFs({
      dirs: [SNAP_DIR],
      files: { [HOST_PATH]: 5000 },
      procEntries: [],
    });
    const paths = run(fsImpl).candidates.map(c => c.path);
    assert.ok(
      paths.includes(HOST_PATH),
      `expected static fallback with no processes, got:\n${paths.join("\n")}`
    );
  });

  it("ignores unrelated processes whose argv0 merely mentions thunderbird", () => {
    const fsImpl = makeFs({
      dirs: [SNAP_DIR],
      files: {},
      procEntries: [{
        pid: "99",
        cmdline: "/usr/bin/vim\0thunderbird.txt\0",
        environ: "TMPDIR=/evil\0SNAP_INSTANCE_NAME=evil\0",
      }],
    });
    const paths = run(fsImpl).candidates.map(c => c.path);
    assert.ok(!paths.some(p => p.includes("evil")), "must not trust a bystander process's TMPDIR");
  });

  it("reports snap not detected when there is no snap install", () => {
    const fsImpl = makeFs({ dirs: [], files: {}, procEntries: snapProc() });
    const result = run(fsImpl);
    assert.equal(result.candidates.length, 0);
    assert.ok(JSON.stringify(result.notes).includes("snap install not detected"));
  });
});
