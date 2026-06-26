// verge-core 同构核心单元测试
// 直接 require lib/ 下的模块，不依赖 HTTP server

const { test } = require("node:test");
const assert = require("node:assert");
const yaml = require("js-yaml");
const vm = require("node:vm");

function vmRunHook(script, params) {
  const sandbox = { params, module: { exports: {} }, exports: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    `${script}\n;if (typeof main === 'function') { params = main(params) || params; }`,
    sandbox, { timeout: 3000 }
  );
  return sandbox.params;
}

const { tryDecodeSubscription, summarize } = require("../lib/subscription");
const { buildYaml, buildAIRuleLine, HttpError } = require("../lib/generate-yaml");
const { buildOverrideScript } = require("../lib/generate-script");

// 测试用直连住宅节点（vless + reality，带嵌套字段）
const DIRECT_NODE = {
  name: "【B41-BISP4】美国ATT住宅 12.12.127.126",
  type: "vless",
  server: "bisp4.resip.cc",
  port: 36041,
  uuid: "0430e547-7b1b-4410-a0d7-df4ef066c44b",
  tls: true,
  flow: "xtls-rprx-vision",
  servername: "steamcdn-a.akamaihd.net",
  "client-fingerprint": "chrome",
  "reality-opts": { "public-key": "OTjSIZonl1n", "short-id": "b76c181224d839ee" },
};

function baseYaml() {
  return yaml.dump({
    proxies: [{ name: "vps1", type: "ss", server: "1.2.3.4", port: 443 }],
    "proxy-groups": [],
    rules: [],
  });
}

// ------- subscription.js -------

test("tryDecodeSubscription: 明文 YAML 原样返回", () => {
  const src = "proxies:\n  - name: test\n";
  assert.equal(tryDecodeSubscription(src), src.trim());
});

test("tryDecodeSubscription: 空输入返回空字符串", () => {
  assert.equal(tryDecodeSubscription(""), "");
  assert.equal(tryDecodeSubscription(null), "");
});

test("summarize: 返回正确摘要结构", () => {
  const parsed = {
    proxies: [{ name: "n1", type: "ss", server: "1.1.1.1" }],
    "proxy-groups": [{ name: "g1", type: "select", proxies: ["n1"] }],
  };
  const r = summarize(parsed);
  assert.equal(r.proxyCount, 1);
  assert.equal(r.groupCount, 1);
  assert.equal(r.proxies[0].name, "n1");
  assert.equal(r.groups[0].count, 1);
});

test("summarize: 非对象输入返回空结构", () => {
  const r = summarize(null);
  assert.deepEqual(r, { proxies: [], groups: [] });
});

// ------- generate-yaml.js: buildAIRuleLine -------

test("buildAIRuleLine: 裸域名 → DOMAIN-SUFFIX", () => {
  assert.equal(buildAIRuleLine("anthropic.com", "AI出口"), "DOMAIN-SUFFIX,anthropic.com,AI出口");
});

test("buildAIRuleLine: 完整规则原样组合", () => {
  assert.equal(buildAIRuleLine("DOMAIN-SUFFIX,example.com", "target"), "DOMAIN-SUFFIX,example.com,target");
});

test("buildAIRuleLine: 带 modifier 的规则", () => {
  assert.equal(buildAIRuleLine("IP-CIDR,1.2.3.0/24,no-resolve", "target"), "IP-CIDR,1.2.3.0/24,target,no-resolve");
});

// ------- generate-yaml.js: buildYaml -------

test("buildYaml: 缺少 srcYaml 抛 HttpError(400)", () => {
  assert.throws(() => buildYaml({}), (e) => e instanceof HttpError && e.status === 400);
});

test("buildYaml: directResidentials 注入 proxies 且不挂 dialer-proxy", () => {
  const out = yaml.load(buildYaml({
    srcYaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
  }));
  const injected = out.proxies.find((p) => p.name === DIRECT_NODE.name);
  assert.ok(injected, "节点已注入");
  assert.equal(injected["dialer-proxy"], undefined, "不应有 dialer-proxy");
  assert.deepEqual(injected["reality-opts"], DIRECT_NODE["reality-opts"], "字段原样保留");
  const group = out["proxy-groups"].find((g) => g.name === "直连住宅");
  assert.ok(group, "建了直连住宅分组");
  assert.equal(group.type, "select");
});

test("buildYaml: AI 规则注入，RULE-SET 在 DOMAIN 之前", () => {
  const outYaml = buildYaml({
    srcYaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiRules: {
      target: "直连住宅",
      domains: ["DOMAIN-SUFFIX,anthropic.com"],
      providers: [{ name: "AI_No_Resolve", url: "https://example.com/ai.yaml", behavior: "classical", interval: 259200 }],
    },
  });
  const rsIdx = outYaml.indexOf("RULE-SET,AI_No_Resolve,直连住宅");
  const domIdx = outYaml.indexOf("DOMAIN-SUFFIX,anthropic.com,直连住宅");
  assert.ok(rsIdx >= 0, "应有 RULE-SET");
  assert.ok(domIdx >= 0, "应有 DOMAIN-SUFFIX");
  assert.ok(rsIdx < domIdx, "RULE-SET 应在 DOMAIN 之前");
});

test("buildYaml: aiExitGroup 包含直连住宅和住宅节点（直连在前）", () => {
  const out = yaml.load(buildYaml({
    srcYaml: baseYaml(),
    relay: { name: "高速中转", type: "select", proxies: ["vps1"] },
    residentials: [{ name: "住宅-1", type: "socks5", server: "h", port: 1, username: "u", password: "p" }],
    residentialGroup: "住宅节点",
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiExitGroup: "AI 总出口",
    aiRules: { target: "AI 总出口", domains: ["DOMAIN-SUFFIX,anthropic.com"], providers: [] },
  }));
  const g = out["proxy-groups"].find((x) => x.name === "AI 总出口");
  assert.ok(g, "总出口组存在");
  assert.equal(g.type, "select");
  assert.deepEqual(g.proxies, ["直连住宅", "住宅节点"], "直连组在前、中转组在后");
});

test("buildYaml: portMappings 生成 IN-PORT 规则", () => {
  const outYaml = buildYaml({
    srcYaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    portMappings: [{ port: 1080, type: "socks", target: DIRECT_NODE.name }],
  });
  assert.ok(outYaml.includes("IN-PORT,1080," + DIRECT_NODE.name));
});

// ------- generate-script.js -------

test("buildOverrideScript: 输出含 DIRECT_RESIDENTIALS 常量", () => {
  const script = buildOverrideScript({
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
  });
  assert.match(script, /const DIRECT_RESIDENTIALS = /);
  assert.match(script, /const DIRECT_RESIDENTIAL_GROUP = /);
  assert.ok(script.includes("reality-opts"), "节点完整字段被内联");
  assert.ok(script.includes("直连住宅"), "分组名被内联");
});

test("buildOverrideScript: 生成的 main() 运行时注入直连住宅、不挂 dialer-proxy", () => {
  const script = buildOverrideScript({
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
  });
  const main = new Function(script + "\n;return main;")();
  const out = main({ proxies: [], "proxy-groups": [], rules: [] });
  const injected = out.proxies.find((p) => p.name === DIRECT_NODE.name);
  assert.ok(injected, "节点已注入");
  assert.equal(injected["dialer-proxy"], undefined, "不应有 dialer-proxy");
  assert.deepEqual(injected["reality-opts"], DIRECT_NODE["reality-opts"]);
  const group = out["proxy-groups"].find((g) => g.name === "直连住宅");
  assert.ok(group, "建了直连住宅分组");
  assert.equal(group.type, "select");
  assert.deepEqual(group.proxies, [DIRECT_NODE.name]);
});

test("buildOverrideScript: aiExitGroup 运行时创建总出口组（直连+住宅）", () => {
  const script = buildOverrideScript({
    relay: { name: "高速中转", type: "select", proxies: ["x"] },
    residentials: [{ name: "住宅-1", type: "socks5", server: "h", port: 1, username: "u", password: "p" }],
    residentialGroup: "住宅节点",
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiExitGroup: "AI 总出口",
  });
  assert.match(script, /const AI_EXIT_GROUP = /);
  const main = new Function(script + "\n;return main;")();
  const out = main({ proxies: [], "proxy-groups": [], rules: [] });
  const g = out["proxy-groups"].find((x) => x.name === "AI 总出口");
  assert.ok(g, "总出口组运行时已建");
  assert.deepEqual(g.proxies, ["直连住宅", "住宅节点"]);
});

// ------- generate-yaml.js: buildYaml + runHook 注入 -------

test("buildYaml: 注入 runHook，extensionScript 修改 params", () => {
  const outYaml = buildYaml(
    { srcYaml: baseYaml(), extensionScript: "function main(p){ p.__hooked = true; return p; }" },
    { runHook: vmRunHook }
  );
  const out = yaml.load(outYaml);
  assert.strictEqual(out.__hooked, true, "runHook 被调用且修改了 params");
});

test("buildYaml: 缺少 runHook 且有 extensionScript 抛 HttpError(422)", () => {
  assert.throws(
    () => buildYaml(
      { srcYaml: baseYaml(), extensionScript: "function main(p){return p;}" },
      {}
    ),
    (e) => e instanceof HttpError && e.status === 422
  );
});
