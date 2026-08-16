// DNS 防泄漏段的唯一来源：YAML 与 Script 两条生成路径共用
//
// 分流意图：
//   国内域名 → 阿里 / doh.pub（direct-nameserver + geosite:cn policy）
//   AI 域名   → Cloudflare 1.1.1.1，且该 DNS 连接经 AI 总出口发出（#组名），
//              使解析结果与真实出口同区域
//   基础设施（bootstrap / 代理节点域名） → 国外 DNS，避开国内污染
//
// buildDnsSection 只产出纯数据，不接触 params，便于 script 路径在构建期序列化内联。

const AI_DNS = "https://1.1.1.1/dns-query";
const CN_DNS = ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"];

// 收敛表：把 AI 规则里细碎的主机名合并成父域，同时补充无法从规则派生的后缀
// （如 sift / statsigapi 只以 DOMAIN-KEYWORD 出现，派生不出 policy key）
const DEFAULT_DNS_POLICY_COLLAPSE = [
  "azureedge.net",
  "azurefd.net",
  "blob.core.windows.net",
  "webpubsub.azure.com",
  "arkoselabs.com",
  "livekit.cloud",
  "sentry.io",
  "datadoghq.com",
  "auth0.com",
  "b-cdn.net",
  "cdn.cloudflare.net",
  "statsigapi.net",
  "sift.com",
  "intercom.io",
  "intercomcdn.com",
  "usefathom.com",
];

// 显式设置 fake-ip-filter 会「覆盖」内核默认列表（默认仅 msftnsci 系 3 条），
// 而其中的规则集依赖 raw.githubusercontent.com。拉取失败时列表就是空的 ——
// blacklist 模式下等于所有域名都拿 fake-ip，内网按域名访问（路由器/NAS）会坏。
// 故内联以下兜底：规则集只是锦上添花，最坏情况下这些仍保证可用。
const FAKE_IP_FILTER = [
  "rule-set:fakeipfilter_domain",
  "localhost",
  "+.lan",
  "+.local",
  "+.localdomain",
  "+.home.arpa",
  "+.internal",
  "+.msftncsi.com",
  "+.msftconnecttest.com", // 补回被覆盖掉的内核默认（Windows 连通性检测）
  "+.in-addr.arpa",
  "+.ip6.arpa", // 反向解析
  "+.pool.ntp.org",
  "time.windows.com",
  "time.apple.com", // 校时
];

// 只有 DOMAIN / DOMAIN-SUFFIX / 裸域名能映射成 nameserver-policy 的 key；
// GEOSITE / IP-CIDR / IP-ASN / DOMAIN-KEYWORD 无对应形式，跳过。
function extractPolicyDomain(line) {
  const s = String(line || "").trim();
  if (!s || s.startsWith("#")) return "";
  if (!s.includes(",")) return s;
  const parts = s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  if (parts.length < 2) return "";
  const type = parts[0].toUpperCase();
  if (type !== "DOMAIN" && type !== "DOMAIN-SUFFIX") return "";
  return parts[1];
}

// 命中收敛后缀（等于自身或其子域）则替换为该后缀，否则原样返回
function collapseDomain(domain, suffixes) {
  for (const suffix of suffixes) {
    if (domain === suffix || domain.endsWith("." + suffix)) return suffix;
  }
  return domain;
}

function buildNameserverPolicy(aiRules, aiExitGroup, collapse) {
  const suffixes = Array.isArray(collapse) ? collapse : DEFAULT_DNS_POLICY_COLLAPSE;
  const exit = String(aiExitGroup || "").trim();
  const aiServer = exit ? `${AI_DNS}#${exit}` : AI_DNS;

  const keys = [];
  const seen = new Set();
  const add = (domain) => {
    const key = "+." + domain;
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  // 收敛表条目无条件输出，再吸收落进其中的派生域名
  suffixes.forEach(add);

  const domains = aiRules && Array.isArray(aiRules.domains) ? aiRules.domains : [];
  domains.forEach((line) => {
    const domain = extractPolicyDomain(line);
    if (domain) add(collapseDomain(domain, suffixes));
  });

  const policy = {};
  keys.forEach((k) => { policy[k] = [aiServer]; });
  policy["geosite:cn"] = CN_DNS.slice();
  return policy;
}

function buildDnsSection(opts) {
  const { dnsLan, dnsTun, aiRules, aiExitGroup, dnsPolicyCollapse } = opts || {};

  return {
    dns: {
      enable: true,
      "cache-algorithm": "arc",
      listen: dnsLan ? "0.0.0.0:1053" : "127.0.0.1:1053",
      ipv6: false,
      "respect-rules": true,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "28.0.0.1/8",
      "fake-ip-filter-mode": "blacklist",
      // bootstrap 只解析下面这些 DNS 服务器自身的域名，必须是无需再解析的纯 IP。
      // 国内 IP 打头：要解析的 dns.alidns.com / doh.pub 都是国内域名。
      "default-nameserver": ["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"],
      // 解析机场节点域名，直连发出。此处可达性优先于抗污染：国内直连
      // 1.1.1.1:443 的 TLS 常被 RST，而 DoH 是全有或全无 —— 一断就解析不出
      // 任何节点，TUN 全局模式下等于彻底断网。机场域名不敏感，无需抗污染。
      "proxy-server-nameserver": CN_DNS.slice(),
      "direct-nameserver": CN_DNS.slice(),
      // 兜底同样走国内：它带 #RULES 时目标地址不在 AI 规则里，会落到订阅的
      // MATCH 兜底，一旦兜底是 DIRECT 就又变成直连国外 DNS。且 fake-ip 下
      // 境外域名拿的是假 IP、真实解析在代理端完成，本机兜底用国内足够。
      nameserver: CN_DNS.slice(),
      "nameserver-policy": buildNameserverPolicy(aiRules, aiExitGroup, dnsPolicyCollapse),
      "fake-ip-filter": FAKE_IP_FILTER.slice(),
    },
    sniffer: {
      enable: true,
      sniff: {
        HTTP: { ports: [80, "8080-8880"], "override-destination": true },
        TLS: { ports: [443, 8443] },
        QUIC: { ports: [443, 8443] },
      },
      "skip-domain": ["Mijia Cloud", "+.push.apple.com"],
    },
    // stack 由调用方与现有 tun 配置合并后决定
    tun: dnsTun
      ? {
          enable: true,
          stack: "mixed",
          "dns-hijack": ["any:53", "tcp://any:53"],
          "auto-route": true,
          "auto-detect-interface": true,
        }
      : null,
    ruleProviders: {
      fakeipfilter_domain: {
        type: "http",
        behavior: "domain",
        format: "mrs",
        url: "https://raw.githubusercontent.com/wwqgtxx/clash-rules/release/fakeip-filter.mrs",
        interval: 86400,
      },
    },
    // dns.ipv6 只让 DNS 不返回 AAAA；顶层 ipv6（默认 true）才控制内核能否用 IPv6 拨号。
    // 两者是独立开关，只设前者的话 IPv6 字面地址仍可绕过，故一并关闭。
    ipv6: false,
  };
}

module.exports = { buildDnsSection, DEFAULT_DNS_POLICY_COLLAPSE };
