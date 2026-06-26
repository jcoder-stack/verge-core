const { test } = require("node:test");
const assert = require("node:assert");
const { tryDecodeSubscription } = require("../lib/subscription");

test("明文 YAML 原样返回", () => {
  const y = "proxies:\n  - name: a\n";
  assert.strictEqual(tryDecodeSubscription(y), y.trim());
});

test("base64 订阅被解码", () => {
  const raw = "proxies:\n  - name: vmess-1\n  - name: vmess-2\n  - name: vmess-3\n  - name: vmess-4\n";
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  assert.match(tryDecodeSubscription(b64), /proxies:/);
});
