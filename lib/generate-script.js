// 构建 Clash Verge JS 覆写脚本（Script 类型）
// 产物是一个自包含 function main(params) { ... return params; }
// 将所有变换以数据字面量嵌入，运行时对导入订阅做同构变换（与 YAML 输出结果一致）

const { buildDnsSection } = require("./dns");
const { assertNoDialerLoop } = require("./http-error");

function buildOverrideScript(opts) {
  const { relay, residentials, residentialGroup, directResidentials, directResidentialGroup, aiExitGroup, portMappings, aiRules, dnsAntiLeak, dnsLan, dnsTun, dnsPolicyCollapse, extensionScript } = opts || {};
  const residentialGroupJSON = JSON.stringify(
    (typeof residentialGroup === "string" && residentialGroup.trim()) || "住宅节点"
  );

  const relayJSON = JSON.stringify(
    relay && relay.name
      ? {
          name: relay.name,
          type: relay.type === "url-test" ? "url-test" : "select",
          proxies: Array.isArray(relay.proxies) ? relay.proxies : [],
        }
      : null
  );
  const residentialsJSON = JSON.stringify(Array.isArray(residentials) ? residentials : []);
  const directResidentialsJSON = JSON.stringify(Array.isArray(directResidentials) ? directResidentials : []);
  const directResidentialGroupJSON = JSON.stringify(
    (typeof directResidentialGroup === "string" && directResidentialGroup.trim()) || "直连住宅"
  );
  const aiExitGroupJSON = JSON.stringify(
    (typeof aiExitGroup === "string" && aiExitGroup.trim()) || ""
  );
  const portMappingsJSON = JSON.stringify(Array.isArray(portMappings) ? portMappings : []);
  const aiRulesJSON = JSON.stringify(
    aiRules && aiRules.target && Array.isArray(aiRules.domains) ? aiRules : null
  );
  assertNoDialerLoop(relay, residentials);

  // DNS 段在生成时算好，脚本里只留数据，逻辑不在两处各写一遍
  const dnsSectionJSON = JSON.stringify(
    dnsAntiLeak ? buildDnsSection({ dnsLan, dnsTun, aiRules, aiExitGroup, dnsPolicyCollapse }) : null,
    null,
    2
  );
  const userExt = typeof extensionScript === "string" ? extensionScript.trim() : "";

  return `// Clash Verge 覆写脚本（由 verge-plugin 生成）
// 导入方式：Clash Verge → 配置 → 覆写 → 新建 JavaScript 覆写 → 粘贴本文件内容
// 生成时间：${new Date().toISOString()}

const RELAY = ${relayJSON};
const RESIDENTIALS = ${residentialsJSON};
const RESIDENTIAL_GROUP = ${residentialGroupJSON};
const DIRECT_RESIDENTIALS = ${directResidentialsJSON};
const DIRECT_RESIDENTIAL_GROUP = ${directResidentialGroupJSON};
const AI_EXIT_GROUP = ${aiExitGroupJSON};
const PORT_MAPPINGS = ${portMappingsJSON};
const AI_RULES = ${aiRulesJSON};
const DNS_SECTION = ${dnsSectionJSON};

function main(params) {
  if (!params || typeof params !== "object") return params;
  if (!Array.isArray(params.proxies)) params.proxies = [];
  if (!Array.isArray(params["proxy-groups"])) params["proxy-groups"] = [];
  if (!Array.isArray(params.rules)) params.rules = [];
  if (!params.dns || typeof params.dns !== "object") params.dns = {};

  // 1) 高速中转分组（住宅节点 dialer-proxy 的第一跳池）
  if (RELAY && RELAY.name && Array.isArray(RELAY.proxies) && RELAY.proxies.length > 0) {
    const proxyNameSet = new Set(params.proxies.map((p) => p.name));
    const groupNameSet = new Set(params["proxy-groups"].map((g) => g.name));
    const validProxies = RELAY.proxies.filter((n) => proxyNameSet.has(n) || groupNameSet.has(n));
    if (validProxies.length > 0) {
      const relayGroup = { name: RELAY.name, type: RELAY.type, proxies: validProxies };
      if (RELAY.type === "url-test") {
        relayGroup.url = "http://www.gstatic.com/generate_204";
        relayGroup.interval = 300;
      }
      const idx = params["proxy-groups"].findIndex((g) => g.name === RELAY.name);
      if (idx >= 0) params["proxy-groups"][idx] = relayGroup;
      else params["proxy-groups"].push(relayGroup);
    }
  }

  // 2) 住宅/落地节点（自动挂 dialer-proxy → 中转组）
  if (RESIDENTIALS.length > 0 && RELAY && RELAY.name) {
    RESIDENTIALS.forEach((n) => {
      if (!n || !n.name) return;
      const node = Object.assign({}, n, { "dialer-proxy": RELAY.name });
      if (!params.proxies.find((p) => p.name === node.name)) {
        params.proxies.unshift(node);
      }
    });
  }

  // 2b) 将住宅节点加入 select 分组（分组名由用户定义）
  if (RESIDENTIALS.length > 0) {
    const resNames = RESIDENTIALS.filter((r) => r && r.name).map((r) => r.name);
    if (resNames.length > 0) {
      const resGroupName = RESIDENTIAL_GROUP;
      const existingIdx = params["proxy-groups"].findIndex((g) => g.name === resGroupName);
      const resGroup = { name: resGroupName, type: "select", proxies: resNames };
      if (existingIdx >= 0) params["proxy-groups"][existingIdx] = resGroup;
      else params["proxy-groups"].push(resGroup);
    }
  }

  // 2c) 直连住宅节点（完整代理形态，不挂 dialer-proxy）+ 建 select 分组
  if (DIRECT_RESIDENTIALS.length > 0) {
    const dNames = [];
    DIRECT_RESIDENTIALS.forEach((n) => {
      if (!n || !n.name) return;
      dNames.push(n.name);
      if (!params.proxies.find((p) => p.name === n.name)) {
        params.proxies.unshift(Object.assign({}, n));
      }
    });
    if (dNames.length > 0) {
      const dIdx = params["proxy-groups"].findIndex((g) => g.name === DIRECT_RESIDENTIAL_GROUP);
      const dGroup = { name: DIRECT_RESIDENTIAL_GROUP, type: "select", proxies: dNames };
      if (dIdx >= 0) params["proxy-groups"][dIdx] = dGroup;
      else params["proxy-groups"].push(dGroup);
    }
  }

  // 2e) AI 总出口开关组（成员=[直连住宅, 住宅节点] 实际存在者，直连在前）
  if (AI_EXIT_GROUP) {
    const members = [];
    if (DIRECT_RESIDENTIALS.length > 0) members.push(DIRECT_RESIDENTIAL_GROUP);
    if (RESIDENTIALS.length > 0) members.push(RESIDENTIAL_GROUP);
    if (members.length > 0) {
      const eIdx = params["proxy-groups"].findIndex((g) => g.name === AI_EXIT_GROUP);
      const eGroup = { name: AI_EXIT_GROUP, type: "select", proxies: members };
      if (eIdx >= 0) params["proxy-groups"][eIdx] = eGroup;
      else params["proxy-groups"].push(eGroup);
    }
  }

  // 3a) AI 出口规则（前置 DOMAIN-SUFFIX + RULE-SET）
  if (AI_RULES && AI_RULES.target) {
    const aiTarget = String(AI_RULES.target).trim();
    const aiPrefix = [];
    // 顺序：先 RULE-SET（规则集 URL，通常覆盖多家 AI），再 DOMAIN（如 Claude 指定域名）。
    if (Array.isArray(AI_RULES.providers) && AI_RULES.providers.length > 0) {
      if (!params["rule-providers"] || typeof params["rule-providers"] !== "object") {
        params["rule-providers"] = {};
      }
      AI_RULES.providers.forEach((p) => {
        if (!p || !p.name || !p.url) return;
        const pname = String(p.name).trim();
        params["rule-providers"][pname] = {
          type: "http",
          behavior: p.behavior || "classical",
          url: p.url,
          interval: Number(p.interval) || 259200,
          path: "./ruleset/" + pname + ".yaml",
        };
        aiPrefix.push("RULE-SET," + pname + "," + aiTarget);
      });
    }
    if (Array.isArray(AI_RULES.domains)) {
      AI_RULES.domains
        .map((d) => String(d || "").trim())
        .filter((d) => d && !d.startsWith("#"))
        .forEach((d) => {
          // 裸域名 → DOMAIN-SUFFIX,x,target；完整规则（可带 no-resolve 等修饰符）→ TYPE,MATCHER,target[,modifier...]
          if (d.indexOf(",") < 0) { aiPrefix.push("DOMAIN-SUFFIX," + d + "," + aiTarget); return; }
          const parts = d.split(",").map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 0; });
          if (parts.length < 2) { aiPrefix.push("DOMAIN-SUFFIX," + d + "," + aiTarget); return; }
          const type = parts[0].toUpperCase();
          const matcher = parts[1];
          const mods = parts.slice(2);
          const tail = mods.length > 0 ? "," + mods.join(",") : "";
          aiPrefix.push(type + "," + matcher + "," + aiTarget + tail);
        });
    }
    if (aiPrefix.length > 0) params.rules = aiPrefix.concat(params.rules);
  }

  // DNS 防泄漏（fake-ip + 全加密 DoH + respect-rules）
  // 配置在生成时由 lib/dns.js 算好并内联为 DNS_SECTION，此处只做赋值与 tun 合并，
  // 避免与 generate-yaml.js 形成孪生实现。
  if (DNS_SECTION) {
    params.dns = DNS_SECTION.dns;
    params.ipv6 = DNS_SECTION.ipv6;
    params.sniffer = DNS_SECTION.sniffer;

    if (!params["rule-providers"] || typeof params["rule-providers"] !== "object") params["rule-providers"] = {};
    Object.keys(DNS_SECTION.ruleProviders).forEach(function (name) {
      if (!params["rule-providers"][name]) params["rule-providers"][name] = DNS_SECTION.ruleProviders[name];
    });

    if (DNS_SECTION.tun) {
      const existingTun = params.tun && typeof params.tun === "object" ? params.tun : {};
      params.tun = Object.assign({}, existingTun, DNS_SECTION.tun, {
        stack: existingTun.stack || DNS_SECTION.tun.stack
      });
    }
  }

  // 4) 特定端口代理入口（listeners + IN-PORT 前置规则）
  if (PORT_MAPPINGS.length > 0) {
    if (!Array.isArray(params.listeners)) params.listeners = [];
    const prefixRules = [];
    const usedNames = new Set(params.listeners.map((l) => l && l.name).filter(Boolean));
    PORT_MAPPINGS.forEach((m, i) => {
      if (!m) return;
      const port = Number(m.port);
      const type = ["socks", "http", "mixed"].indexOf(m.type) >= 0 ? m.type : "socks";
      const target = String(m.target || "").trim();
      if (!Number.isFinite(port) || port <= 0 || port > 65535 || !target) return;
      let name = m.name ? String(m.name).trim() : "listener-" + port;
      while (usedNames.has(name)) name = name + "-" + i;
      usedNames.add(name);
      const dup = params.listeners.find((l) => l && l.port === port && l.type === type);
      if (!dup) {
        params.listeners.push({ name: name, type: type, port: port, address: m.address || "127.0.0.1" });
      }
      prefixRules.push("IN-PORT," + port + "," + target);
    });
    if (prefixRules.length > 0) params.rules = prefixRules.concat(params.rules);
  }

  // 5) 用户扩展脚本（IIFE 隔离作用域，不污染外层 main）
${
  userExt
    ? "  // ---- user extension begin ----\n  params = (function(params) {\n" +
      indent(userExt, "    ") +
      "\n    if (typeof main === 'function') return main(params) || params;\n    return params;\n  })(params);\n  // ---- user extension end ----"
    : "  // (无用户扩展脚本)"
}

  return params;
}
`;
}

function indent(text, pad) {
  return String(text)
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

module.exports = { buildOverrideScript };
