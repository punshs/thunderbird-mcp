"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension/mcp_server/api.js"), "utf8");
function snippet(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  snippet("// BEGIN INLINE ATTACHMENT BASE64 HELPERS", "// END INLINE ATTACHMENT BASE64 HELPERS"),
  snippet("// BEGIN TOOL SCHEMA VALIDATOR", "// END TOOL SCHEMA VALIDATOR"),
  "this.validate = isValidBase64; this.validateSchema = validateAgainstSchema;",
].join("\n"), sandbox);

test("multi-megabyte inline attachments validate without exhausting the stack", () => {
  // The bridge turns local file paths into inline payloads before dispatch.
  // F2's original PNG is 3,487,484 bytes; the old repeated-group regex overflows.
  const payload = Buffer.alloc(3487484, 0x7b).toString("base64");
  const errors = [];
  assert.doesNotThrow(() => sandbox.validateSchema(payload,
    { type: "string", contentEncoding: "base64" }, "attachments[0].base64", errors));
  assert.deepEqual(errors, []);
  assert.equal(sandbox.validate(payload), true);
  assert.equal(sandbox.validate(`${payload.slice(0, -5)}!${payload.slice(-4)}`), false);
});

test("base64 validation remains strict about alphabet, groups, and padding", () => {
  for (const payload of ["AAAA", "AA==", "AAA=", "////", "++++", "aGk="]) {
    assert.equal(sandbox.validate(payload), true, payload);
  }
  for (const payload of [null, 123, "", "A", "AAA", "AAAA=", "A===", "AA=A", "=AAA", "AAAA\n", "AA-_", "AAAA===="]) {
    assert.equal(sandbox.validate(payload), false, String(payload));
  }
});
