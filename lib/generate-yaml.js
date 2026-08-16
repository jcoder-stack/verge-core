// 构建完整 YAML 覆写（合并源订阅）。outputFormat 为 "clashmi" 时输出 mihomo 兼容版本。
// 失败时抛出 HttpError(status, message)，由路由层映射为对应的 HTTP 响应。

const yaml = require("js-yaml");
const { buildDnsSection } = require("./dns");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 规则行解析：裸域名 → DOMAIN-SUFFIX,x,target；完整规则（可带 no-resolve 等修饰符）→ TYPE,MATCHER,target[,modifier...]
function buildAIRuleLine(line, target) {
  const s = String(line || "").trim();
  if (!s) return "";
  if (!s.includes(",")) return `DOMAIN-SUFFIX,${s},${target}`;
  const parts = s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  if (parts.length < 2) return `DOMAIN-SUFFIX,${s},${target}`;
  const type = parts[0].toUpperCase();
  const matcher = parts[1];
  const modifiers = parts.slice(2); // 如 no-resolve；目标名要插在它们之前
  const tail = modifiers.length > 0 ? "," + modifiers.join(",") : "";
  return `${type},${matcher},${target}${tail}`;
}

function buildYaml(opts, deps = {}) {
  const {
    srcYaml,
    relay,
    residentials,
    residentialGroup,
    directResidentials,
    directResidentialGroup,
    aiExitGroup,
    aiRules,
    dnsAntiLeak,
    dnsLan,
    dnsTun,
    dnsPolicyCollapse,
    portMappings,
    extensionScript,
    outputFormat,
  } = opts || {};

  if (!srcYaml || typeof srcYaml !== "string") {
    throw new HttpError(400, "missing yaml（YAML 输出需要先加载订阅）");
  }

  let params;
  try {
    params = yaml.load(srcYaml);
  } catch (e) {
    throw new HttpError(422, `parse source yaml failed: ${e.message}`);
  }
  if (!params || typeof params !== "object") {
    throw new HttpError(422, "yaml root is not an object");
  }

  if (!Array.isArray(params.proxies)) params.proxies = [];
  if (!Array.isArray(params["proxy-groups"])) params["proxy-groups"] = [];
  if (!Array.isArray(params.rules)) params.rules = [];

  // 总出口组成员：实际会存在的出口分组（直连优先），仅在有成员时才创建/注册
  const aiExitMembers = [];
  if (Array.isArray(directResidentials) && directResidentials.some((r) => r && r.name)) aiExitMembers.push(directResidentialGroup);
  if (Array.isArray(residentials) && residentials.some((r) => r && r.name)) aiExitMembers.push(residentialGroup);

  // 死循环防御：中转组候选不能包含即将新增的住宅节点（否则 dialer-proxy 自环）
  if (relay && Array.isArray(relay.proxies) && Array.isArray(residentials)) {
    const residentialNames = new Set(residentials.filter((r) => r && r.name).map((r) => r.name));
    const conflict = relay.proxies.filter((n) => residentialNames.has(n));
    if (conflict.length > 0) {
      throw new HttpError(400, `中转组候选包含住宅节点名 [${conflict.join(", ")}]，会导致 dialer-proxy 死循环，请移除`);
    }
  }

  // 1) 注入高速中转分组
  if (relay && relay.name && Array.isArray(relay.proxies) && relay.proxies.length > 0) {
    const proxyNameSet = new Set(params.proxies.map((p) => p.name));
    const groupNameSet = new Set(params["proxy-groups"].map((g) => g.name));
    const validProxies = relay.proxies.filter((n) => proxyNameSet.has(n) || groupNameSet.has(n));
    if (validProxies.length === 0) {
      throw new HttpError(400, "relay.proxies 中没有匹配订阅中的节点/分组");
    }

    const relayGroup = {
      name: relay.name,
      type: relay.type === "url-test" ? "url-test" : "select",
      proxies: validProxies,
    };
    if (relayGroup.type === "url-test") {
      relayGroup.url = "http://www.gstatic.com/generate_204";
      relayGroup.interval = 300;
    }

    const idx = params["proxy-groups"].findIndex((g) => g.name === relay.name);
    if (idx >= 0) params["proxy-groups"][idx] = relayGroup;
    else params["proxy-groups"].push(relayGroup);
  }

  // 2) 注入住宅/落地节点，并挂 dialer-proxy → relay.name
  if (Array.isArray(residentials) && residentials.length > 0 && relay && relay.name) {
    residentials.forEach((n) => {
      if (!n || !n.name) return;
      const node = { ...n, "dialer-proxy": relay.name };
      if (!params.proxies.find((p) => p.name === node.name)) {
        params.proxies.unshift(node);
      }
    });
  }

  // 2b) 将住宅节点加入一个 select 分组，方便在 GUI 中查看/切换（分组名由用户定义）
  if (Array.isArray(residentials) && residentials.length > 0) {
    const resNames = residentials.filter((r) => r && r.name).map((r) => r.name);
    if (resNames.length > 0) {
      const resGroupName = residentialGroup;
      const existingIdx = params["proxy-groups"].findIndex((g) => g.name === resGroupName);
      const resGroup = { name: resGroupName, type: "select", proxies: resNames };
      if (existingIdx >= 0) params["proxy-groups"][existingIdx] = resGroup;
      else params["proxy-groups"].push(resGroup);
    }
  }

  // 2c) 注入直连住宅节点（完整代理形态，不挂 dialer-proxy）+ 建 select 分组
  if (Array.isArray(directResidentials) && directResidentials.length > 0) {
    const dNames = [];
    directResidentials.forEach((n) => {
      if (!n || !n.name) return;
      dNames.push(n.name);
      if (!params.proxies.find((p) => p.name === n.name)) {
        params.proxies.unshift({ ...n });
      }
    });
    if (dNames.length > 0) {
      const dIdx = params["proxy-groups"].findIndex((g) => g.name === directResidentialGroup);
      const dGroup = { name: directResidentialGroup, type: "select", proxies: dNames };
      if (dIdx >= 0) params["proxy-groups"][dIdx] = dGroup;
      else params["proxy-groups"].push(dGroup);
    }
  }

  // 2e) AI 总出口开关组：select 组，成员=[直连住宅, 住宅节点]（实际存在者，直连在前）
  //     AI 规则指向它即可在客户端一个开关里实时切「直连 / 中转」。
  if (aiExitGroup && aiExitMembers.length > 0) {
    const eIdx = params["proxy-groups"].findIndex((g) => g.name === aiExitGroup);
    const eGroup = { name: aiExitGroup, type: "select", proxies: aiExitMembers.slice() };
    if (eIdx >= 0) params["proxy-groups"][eIdx] = eGroup;
    else params["proxy-groups"].push(eGroup);
  }

  // 3a) AI 出口规则：前置 DOMAIN-SUFFIX + RULE-SET
  if (aiRules && typeof aiRules === "object" && aiRules.target) {
    const target = String(aiRules.target).trim();
    const prefix = [];

    // 顺序：先 RULE-SET（规则集 URL，通常覆盖多家 AI），再 DOMAIN（如 Claude 指定域名）。
    // rule-providers（生成 rule-providers 节点 + RULE-SET 规则）
    if (Array.isArray(aiRules.providers) && aiRules.providers.length > 0) {
      if (!params["rule-providers"] || typeof params["rule-providers"] !== "object") {
        params["rule-providers"] = {};
      }
      aiRules.providers.forEach((p) => {
        if (!p || !p.name || !p.url) return;
        const name = String(p.name).trim();
        params["rule-providers"][name] = {
          type: "http",
          behavior: p.behavior || "classical",
          url: p.url,
          interval: Number(p.interval) || 259200,
          path: `./ruleset/${name}.yaml`,
        };
        prefix.push(`RULE-SET,${name},${target}`);
      });
    }

    // 规则行：支持裸域名（→ DOMAIN-SUFFIX）/ 完整 Clash 规则前缀（DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR / IP-CIDR6 / IP-ASN / GEOIP / ...）
    if (Array.isArray(aiRules.domains)) {
      aiRules.domains
        .map((d) => String(d || "").trim())
        .filter((d) => d && !d.startsWith("#"))
        .forEach((d) => { prefix.push(buildAIRuleLine(d, target)); });
    }

    if (prefix.length > 0) params.rules = [...prefix, ...params.rules];
  }

  // DNS 防泄漏（fake-ip + 全加密 DoH + respect-rules）：配置全部来自 lib/dns.js
  if (dnsAntiLeak) {
    const section = buildDnsSection({ dnsLan, dnsTun, aiRules, aiExitGroup, dnsPolicyCollapse });
    params.dns = section.dns;
    params.ipv6 = section.ipv6;
    params.sniffer = section.sniffer;

    if (!params["rule-providers"] || typeof params["rule-providers"] !== "object") params["rule-providers"] = {};
    Object.entries(section.ruleProviders).forEach(([name, provider]) => {
      if (!params["rule-providers"][name]) params["rule-providers"][name] = provider;
    });

    if (section.tun) {
      const existingTun = params.tun && typeof params.tun === "object" ? params.tun : {};
      params.tun = { ...existingTun, ...section.tun, stack: existingTun.stack || section.tun.stack };
    }
  }

  // 4) 特定端口代理入口：注入 listeners + 前置 IN-PORT 规则
  if (Array.isArray(portMappings) && portMappings.length > 0) {
    if (!Array.isArray(params.listeners)) params.listeners = [];
    const prefixRules = [];
    const usedNames = new Set(params.listeners.map((l) => l && l.name).filter(Boolean));
    portMappings.forEach((m, i) => {
      if (!m) return;
      const port = Number(m.port);
      const type = ["socks", "http", "mixed"].includes(m.type) ? m.type : "socks";
      const target = String(m.target || "").trim();
      if (!Number.isFinite(port) || port <= 0 || port > 65535 || !target) return;

      let name = m.name ? String(m.name).trim() : `listener-${port}`;
      while (usedNames.has(name)) name = `${name}-${i}`;
      usedNames.add(name);

      // 避免与已有同端口同类型 listener 重复
      const dup = params.listeners.find((l) => l && l.port === port && l.type === type);
      if (!dup) {
        params.listeners.push({
          name,
          type,
          port,
          address: m.address || "127.0.0.1",
        });
      }
      prefixRules.push(`IN-PORT,${port},${target}`);
    });
    if (prefixRules.length > 0) {
      params.rules = [...prefixRules, ...params.rules];
    }
  }

  // 4) 扩展脚本：通过注入的 runHook 执行 main(params) 覆写（核心不再直接依赖 vm）
  if (typeof extensionScript === "string" && extensionScript.trim().length > 0) {
    const runHook = deps && deps.runHook;
    if (typeof runHook !== "function") {
      throw new HttpError(422, "extension script not supported in this environment");
    }
    try {
      params = runHook(extensionScript, params) || params;
    } catch (e) {
      throw new HttpError(422, `extension script failed: ${e.message}`);
    }
  }

  if (outputFormat === "clashmi") {
    // 剥离 Clash Verge 私有字段（mihomo 会忽略，但留着会让 ClashMi 配置看起来不干净）
    [
      "verge-mihomo-core",
      "verge-mihomo-alpha-core",
      "clash-verge",
      "verge-merge",
    ].forEach((k) => { if (k in params) delete params[k]; });
  }

  let outYaml;
  try {
    outYaml = yaml.dump(params, { lineWidth: -1, noRefs: true });
  } catch (e) {
    throw new HttpError(500, `dump yaml failed: ${e.message}`);
  }

  if (outputFormat === "clashmi") {
    const header =
      `# Generated by verge-plugin for ClashMi (mihomo client)\n` +
      `# 直接导入 ClashMi → 配置 → 导入：可作为完整 Profile 使用\n` +
      `# Generated at: ${new Date().toISOString()}\n\n`;
    outYaml = header + outYaml;
  }

  return outYaml;
}

module.exports = { buildYaml, buildAIRuleLine, HttpError };
