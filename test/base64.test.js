const { test } = require("node:test");
const assert = require("node:assert");
const { decodeBase64 } = require("../lib/base64");

test("decodeBase64 解码 ASCII", () => {
  assert.strictEqual(decodeBase64("aGVsbG8="), "hello");
});

test("decodeBase64 解码 UTF-8 中文", () => {
  // "代理" 的 base64
  assert.strictEqual(decodeBase64("5Luj55CG"), "代理");
});

test("decodeBase64 容忍空白", () => {
  assert.strictEqual(decodeBase64("aGVs\nbG8="), "hello");
});
