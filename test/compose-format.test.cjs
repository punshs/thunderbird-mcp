"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = source.indexOf("function resolveComposeFormat(");
const end = source.indexOf("\n            /**", start);
const Ci = {
  nsIMsgCompType: { New: 0, Reply: 1, ForwardInline: 2, ForwardAsAttachment: 3 },
  nsIMsgCompFormat: { Default: 0, OppositeOfDefault: 1, HTML: 2, PlainText: 3 },
};
const resolve = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { Ci });
for (const composeHtml of [true, false]) {
  for (const isHtml of [undefined, false, true]) {
    for (const [name, type] of Object.entries(Ci.nsIMsgCompType)) {
      test(`${name}: input HTML=${isHtml}, identity HTML=${composeHtml} retains styled composition`, () => {
        const result = resolve({ composeHtml }, isHtml, type);
        assert.equal(result.useHtml, true);
        const forwards = name.startsWith("Forward");
        assert.equal(result.format, forwards
          ? (composeHtml ? Ci.nsIMsgCompFormat.Default : Ci.nsIMsgCompFormat.OppositeOfDefault)
          : Ci.nsIMsgCompFormat.HTML);
      });
    }
  }
}
