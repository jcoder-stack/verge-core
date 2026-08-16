// lib/dns.js 单元测试：DNS 防泄漏段的唯一来源
// buildDnsSection 只产出纯数据，不接触 params

const { test } = require("node:test");
const assert = require("node:assert");

const { buildDnsSection, DEFAULT_DNS_POLICY_COLLAPSE } = require("../lib/dns");

// ------- 基础形状 -------

test("buildDnsSection: 返回 dns/sniffer/tun/ruleProviders/ipv6 五段", () => {
  const s = buildDnsSection({});
  assert.equal(typeof s.dns, "object");
  assert.equal(typeof s.sniffer, "object");
  assert.equal(typeof s.ruleProviders, "object");
  assert.equal(s.ipv6, false);
  assert.ok("tun" in s);
});

// ------- 分流：国内走国内、国外基础设施走国外 -------

test("buildDnsSection: bootstrap 用纯 IP 国外 DNS", () => {
  const { dns } = buildDnsSection({});
  assert.deepEqual(dns["default-nameserver"], ["1.1.1.1", "8.8.8.8"]);
});

test("buildDnsSection: proxy-server-nameserver 用 IP 形式国外 DoH", () => {
  const { dns } = buildDnsSection({});
  assert.deepEqual(dns["proxy-server-nameserver"], [
    "https://1.1.1.1/dns-query",
    "https://8.8.8.8/dns-query",
  ]);
});

test("buildDnsSection: direct-nameserver 保持国内 DoH", () => {
  const { dns } = buildDnsSection({});
  assert.deepEqual(dns["direct-nameserver"], [
    "https://dns.alidns.com/dns-query",
    "https://doh.pub/dns-query",
  ]);
});

test("buildDnsSection: 兜底 nameserver 以 1.1.1.1 为首", () => {
  const { dns } = buildDnsSection({});
  assert.deepEqual(dns.nameserver, [
    "https://1.1.1.1/dns-query#RULES",
    "https://8.8.8.8/dns-query#RULES",
  ]);
});

// ------- 开关 -------

test("buildDnsSection: dnsLan 决定 listen 监听地址", () => {
  assert.equal(buildDnsSection({}).dns.listen, "127.0.0.1:1053");
  assert.equal(buildDnsSection({ dnsLan: true }).dns.listen, "0.0.0.0:1053");
});

test("buildDnsSection: dnsTun 关闭时 tun 为 null", () => {
  assert.equal(buildDnsSection({}).tun, null);
});

test("buildDnsSection: dnsTun 开启时给出 tun 目标字段", () => {
  const { tun } = buildDnsSection({ dnsTun: true });
  assert.equal(tun.enable, true);
  assert.equal(tun.stack, "mixed");
  assert.deepEqual(tun["dns-hijack"], ["any:53", "tcp://any:53"]);
  assert.equal(tun["auto-route"], true);
  assert.equal(tun["auto-detect-interface"], true);
});

// ------- fake-ip-filter -------

test("buildDnsSection: fake-ip-filter 以 rule-set 开头并含静态白名单", () => {
  const { dns } = buildDnsSection({});
  const f = dns["fake-ip-filter"];
  assert.equal(f[0], "rule-set:fakeipfilter_domain");
  for (const item of ["localhost", "+.lan", "+.local", "+.home.arpa", "+.in-addr.arpa", "+.pool.ntp.org", "time.apple.com"]) {
    assert.ok(f.includes(item), `fake-ip-filter 应含 ${item}`);
  }
});

test("buildDnsSection: 附带 fakeipfilter_domain 规则集定义", () => {
  const { ruleProviders } = buildDnsSection({});
  const p = ruleProviders["fakeipfilter_domain"];
  assert.equal(p.behavior, "domain");
  assert.equal(p.format, "mrs");
});

// ------- nameserver-policy 派生 -------

test("buildDnsSection: 无 AI 规则且关闭收敛表时 policy 只有 geosite:cn", () => {
  const { dns } = buildDnsSection({ dnsPolicyCollapse: [] });
  assert.deepEqual(Object.keys(dns["nameserver-policy"]), ["geosite:cn"]);
  assert.deepEqual(dns["nameserver-policy"]["geosite:cn"], [
    "https://dns.alidns.com/dns-query",
    "https://doh.pub/dns-query",
  ]);
});

test("buildDnsSection: AI 域名派生为 +.域名 并带 AI 出口标签", () => {
  const { dns } = buildDnsSection({
    aiExitGroup: "AI 总出口",
    aiRules: { domains: ["DOMAIN-SUFFIX,claude.ai", "chatgpt.com"] },
  });
  const policy = dns["nameserver-policy"];
  assert.deepEqual(policy["+.claude.ai"], ["https://1.1.1.1/dns-query#AI 总出口"]);
  assert.deepEqual(policy["+.chatgpt.com"], ["https://1.1.1.1/dns-query#AI 总出口"]);
});

test("buildDnsSection: 无 aiExitGroup 时退回不带标签的直连形式", () => {
  const { dns } = buildDnsSection({ aiRules: { domains: ["claude.ai"] } });
  assert.deepEqual(dns["nameserver-policy"]["+.claude.ai"], ["https://1.1.1.1/dns-query"]);
});

test("buildDnsSection: 跳过无法映射成 DNS policy 的规则类型", () => {
  const { dns } = buildDnsSection({
    dnsPolicyCollapse: [],
    aiRules: {
      domains: [
        "GEOSITE,openai",
        "IP-CIDR,160.79.104.0/21,no-resolve",
        "IP-CIDR6,2607:6bc0::/32,no-resolve",
        "IP-ASN,399358,no-resolve",
        "DOMAIN-KEYWORD,datadog",
      ],
    },
  });
  assert.deepEqual(Object.keys(dns["nameserver-policy"]), ["geosite:cn"]);
});

test("buildDnsSection: geosite:cn 排在 policy 末尾", () => {
  const { dns } = buildDnsSection({ aiRules: { domains: ["claude.ai"] } });
  const keys = Object.keys(dns["nameserver-policy"]);
  assert.equal(keys[keys.length - 1], "geosite:cn");
});

test("buildDnsSection: 重复域名只出现一次", () => {
  const { dns } = buildDnsSection({
    aiRules: { domains: ["claude.ai", "DOMAIN-SUFFIX,claude.ai", "DOMAIN,claude.ai"] },
  });
  const keys = Object.keys(dns["nameserver-policy"]).filter((k) => k === "+.claude.ai");
  assert.equal(keys.length, 1);
});

// ------- 收敛表 -------

test("buildDnsSection: 细碎主机名按收敛表合并到父域", () => {
  const { dns } = buildDnsSection({
    aiRules: {
      domains: [
        "DOMAIN,openaiapi-site.azureedge.net",
        "DOMAIN,production-openaicom-storage.azureedge.net",
        "DOMAIN,openaicomproductionae4b.blob.core.windows.net",
      ],
    },
  });
  const policy = dns["nameserver-policy"];
  assert.ok(policy["+.azureedge.net"], "应收敛出 +.azureedge.net");
  assert.ok(policy["+.blob.core.windows.net"], "应收敛出 +.blob.core.windows.net");
  assert.equal(policy["+.openaiapi-site.azureedge.net"], undefined, "细碎主机名不应保留");
});

test("buildDnsSection: 收敛表条目无条件输出", () => {
  const { dns } = buildDnsSection({ aiRules: { domains: [] } });
  const policy = dns["nameserver-policy"];
  for (const suffix of DEFAULT_DNS_POLICY_COLLAPSE) {
    assert.ok(policy["+." + suffix], `收敛表条目 ${suffix} 应出现在 policy 中`);
  }
});

test("buildDnsSection: dnsPolicyCollapse 整表覆盖默认收敛表", () => {
  const { dns } = buildDnsSection({
    dnsPolicyCollapse: ["azureedge.net"],
    aiRules: { domains: ["DOMAIN,openaiapi-site.azureedge.net", "DOMAIN,x.sentry.io"] },
  });
  const policy = dns["nameserver-policy"];
  assert.ok(policy["+.azureedge.net"], "自定义收敛后缀生效");
  assert.equal(policy["+.sift.com"], undefined, "默认收敛表已被整表覆盖");
  assert.ok(policy["+.x.sentry.io"], "未被收敛的域名保留完整主机名");
});

test("buildDnsSection: dnsPolicyCollapse 传空数组可关掉所有收敛", () => {
  const { dns } = buildDnsSection({
    dnsPolicyCollapse: [],
    aiRules: { domains: ["DOMAIN,openaiapi-site.azureedge.net"] },
  });
  const policy = dns["nameserver-policy"];
  assert.ok(policy["+.openaiapi-site.azureedge.net"], "关掉收敛后保留完整主机名");
  assert.equal(policy["+.azureedge.net"], undefined);
});

test("buildDnsSection: 域名与收敛后缀同名时不重复输出", () => {
  const { dns } = buildDnsSection({
    dnsPolicyCollapse: ["sentry.io"],
    aiRules: { domains: ["DOMAIN-SUFFIX,sentry.io"] },
  });
  const keys = Object.keys(dns["nameserver-policy"]).filter((k) => k === "+.sentry.io");
  assert.equal(keys.length, 1);
});

test("buildDnsSection: 同级独立顶级域不会被误收敛", () => {
  // browser-intake-datadoghq.com 不是 datadoghq.com 的子域，必须保留完整域名
  const { dns } = buildDnsSection({
    dnsPolicyCollapse: ["datadoghq.com"],
    aiRules: { domains: ["DOMAIN,browser-intake-datadoghq.com"] },
  });
  assert.ok(dns["nameserver-policy"]["+.browser-intake-datadoghq.com"]);
});
