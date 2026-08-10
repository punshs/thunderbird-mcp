"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const BRIDGE = path.join(__dirname, "..", "mcp-bridge.cjs");

/**
 * Drive the bridge the way a real MCP client does: send initialize and leave
 * stdin open. Piping and closing stdin is not equivalent -- it lets a bridge
 * that only flushes at exit look healthy.
 */
function handshake(requestedVersion, { timeoutMs = 8000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no response within ${timeoutMs}ms (stdout=${JSON.stringify(stdout)})`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      const line = stdout.split("\n").find((l) => l.trim());
      if (!line) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // partial line, keep buffering
      }
      clearTimeout(timer);
      child.kill();
      resolve({ response: parsed, stderr });
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);

    const params = { capabilities: {}, clientInfo: { name: "test", version: "1" } };
    if (requestedVersion !== undefined) params.protocolVersion = requestedVersion;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params }) + "\n");
    // stdin deliberately left open
  });
}

describe("initialize protocol version negotiation", () => {
  it("echoes 2025-06-18 when the client asks for it", async () => {
    const { response } = await handshake("2025-06-18");
    assert.equal(response.result.protocolVersion, "2025-06-18");
    assert.equal(response.id, 0);
  });

  it("echoes 2025-03-26 when the client asks for it", async () => {
    const { response } = await handshake("2025-03-26");
    assert.equal(response.result.protocolVersion, "2025-03-26");
  });

  it("echoes 2024-11-05 when the client asks for it", async () => {
    const { response } = await handshake("2024-11-05");
    assert.equal(response.result.protocolVersion, "2024-11-05");
  });

  it("falls back for an unknown version rather than echoing it blindly", async () => {
    const { response } = await handshake("1999-01-01");
    assert.equal(response.result.protocolVersion, "2024-11-05");
  });

  it("falls back when the client omits protocolVersion entirely", async () => {
    const { response } = await handshake(undefined);
    assert.equal(response.result.protocolVersion, "2024-11-05");
  });

  it("responds promptly with stdin held open", async () => {
    const started = Date.now();
    await handshake("2025-06-18", { timeoutMs: 5000 });
    assert.ok(Date.now() - started < 3000, "handshake should not depend on stdin closing");
  });

  it("still advertises the tools capability", async () => {
    const { response } = await handshake("2025-06-18");
    assert.deepEqual(response.result.capabilities, { tools: {} });
    assert.equal(response.result.serverInfo.name, "thunderbird-mcp");
  });
});

describe("stdio tracing", () => {
  it("is silent unless THUNDERBIRD_MCP_DEBUG is set", async () => {
    const { stderr } = await handshake("2025-06-18");
    assert.ok(!stderr.includes("[thunderbird-mcp]"), `unexpected trace: ${stderr}`);
  });

  it("traces both directions when enabled", async () => {
    const { stderr } = await handshake("2025-06-18", { env: { THUNDERBIRD_MCP_DEBUG: "1" } });
    assert.ok(stderr.includes("<-- in"), `missing inbound trace: ${stderr}`);
    assert.ok(stderr.includes("--> out"), `missing outbound trace: ${stderr}`);
  });
});
