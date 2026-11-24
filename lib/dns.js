// DNS 防泄漏段的唯一来源：YAML 与 Script 两条生成路径共用
//
// 分流意图：
//   国内域名 → 阿里 / 腾讯 DoH（direct-nameserver + geosite:cn policy）
//   AI 域名   → Cloudflare 1.1.1.1，且该 DNS 连接经 AI 总出口发出（#组名），
//              使解析结果与真实出口同区域
//   基础设施（bootstrap / 代理节点域名） → 国外 DNS，避开国内污染
//
// buildDnsSection 只产出纯数据，不接触 params，便于 script 路径在构建期序列化内联。

const AI_DNS = "https://1.1.1.1/dns-query";
// 纯 IP 形式，且阿里 / 腾讯各两个入口：mihomo 并发查询、取最先成功者，任一可达即可。
// 不用 dns.alidns.com / doh.pub 域名：它们要先经 bootstrap 解析，结果可能落到当前网络
// 不可达的那个 IP（实测某网络仅 223.5.5.5 可达，doh.pub 与 223.6.6.6 全不通），
// 两条一起失败即 direct 出站报 dns resolve failed: context deadline exceeded。
const CN_DNS = [
  "https://223.5.5.5/dns-query",
  "https://223.6.6.6/dns-query",
  "https://1.12.12.12/dns-query",
  "https://120.53.53.53/dns-query",
];

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

// 节点域名解析（proxy-server-nameserver）继承订阅自带的 DNS。
// 部分机场对节点域名做分区解析：只有自家 DoH 返回可用入口，公共 DNS 给的 IP 能建 TCP
// 却握不上手（实测 MESL：cl-188 经阿里解析后全部节点超时）。这一层只查节点地址、不涉及
// 浏览记录，交还机场不影响防泄漏；nameserver / policy / direct 三层仍由本模块决定。
//
// 过滤：
//   #出站 后缀 → 剥掉。节点解析必须直连，指向代理组即自环
//   system / dhcp → 丢弃。TUN 劫持下会被内核自己接走
//   境外公共 DNS → 丢弃。它们给不出分区结果，反倒带回国内直连 TLS 被 RST 的风险
// 过滤后为空则回退 fallback。
//
// 必须自包含（不引用模块内常量）：script 路径经 toString() 内联到生成脚本运行时调用，
// 因为订阅内容要到 main(params) 里才拿得到。
function inheritProxyServerNameserver(srcDns, fallback) {
  const FOREIGN_PUBLIC = /^(?:[a-z0-9]+:\/\/)?(?:1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9|149\.112\.112\.112|dns\.google|cloudflare-dns\.com|[a-z0-9.-]*\.cloudflare-dns\.com|dns\.quad9\.net|doh\.opendns\.com|dns\.adguard(?:-dns)?\.com)(?:[:/]|$)/i;
  const pick = (list) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    list.forEach((item) => {
      if (typeof item !== "string") return;
      const s = item.split("#")[0].trim();
      if (!s) return;
      if (/^system(?::\/\/)?$/i.test(s) || /^dhcp:\/\//i.test(s)) return;
      if (FOREIGN_PUBLIC.test(s)) return;
      if (out.indexOf(s) < 0) out.push(s);
    });
    return out;
  };
  const dns = srcDns && typeof srcDns === "object" ? srcDns : {};
  let list = pick(dns["proxy-server-nameserver"]);
  if (list.length === 0) list = pick(dns.nameserver);
  return list.length > 0 ? list : fallback.slice();
}

function buildDnsSection(opts) {
  const { dnsLan, dnsTun, dnsViaExit, aiRules, aiExitGroup, dnsPolicyCollapse } = opts || {};

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
      // bootstrap 只解析 DNS 服务器自身的域名（如订阅继承来的机场 DoH），必须是纯 IP。
      // 国内 IP 打头：国内直连 1.1.1.1 / 8.8.8.8 常不稳定。
      "default-nameserver": ["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"],
      // 解析机场节点域名，直连发出。此处可达性优先于抗污染：国内直连
      // 1.1.1.1:443 的 TLS 常被 RST，而 DoH 是全有或全无 —— 一断就解析不出
      // 任何节点，TUN 全局模式下等于彻底断网。机场域名不敏感，无需抗污染。
      "proxy-server-nameserver": CN_DNS.slice(),
      "direct-nameserver": CN_DNS.slice(),
      // 兜底必须走国外：DNS 泄漏检测站的域名不匹配任何 policy，走的就是这一条，
      // 换成国内 DNS 会让检测直接显示国内递归服务器 —— 那正是本配置要防的。
      // 与上面两项不同，这条挂掉不致命：fake-ip 下境外域名拿假 IP，真实解析在
      // 代理端完成，所以这里可以为防泄漏承担可达性风险。
      // #RULES 按规则选出口，解析位置随普通节点变；dnsViaExit 固定经 AI 总出口，
      // 代价是解析变慢，且普通网站的解析也依赖住宅节点，故默认不开。
      nameserver: [`${AI_DNS}#${dnsViaExit || "RULES"}`, `https://8.8.8.8/dns-query#${dnsViaExit || "RULES"}`],
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

module.exports = { buildDnsSection, inheritProxyServerNameserver, DEFAULT_DNS_POLICY_COLLAPSE };
