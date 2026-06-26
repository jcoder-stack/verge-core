// 订阅解码与摘要工具

const { decodeBase64 } = require("./base64");

// Base64 订阅 → YAML 文本（Clash 订阅 99% 是明文 YAML；少数 v2ray 风格 base64 这里也尝试解码）
function tryDecodeSubscription(text) {
  if (!text) return "";
  const trimmed = text.trim();
  // 看起来像 YAML / JSON 直接返回
  if (/^(proxies:|proxy-groups:|port:|mixed-port:|mode:|rules:|#)/m.test(trimmed) || trimmed.startsWith("{")) {
    return trimmed;
  }
  // 看起来像 base64
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 64) {
    try {
      const decoded = decodeBase64(trimmed);
      if (/proxies:|vmess:|ss:|trojan:/i.test(decoded)) return decoded;
    } catch {}
  }
  return trimmed;
}

// 解析后的订阅对象 → 节点/分组摘要（供前端列表与目标候选使用）
function summarize(parsed) {
  if (!parsed || typeof parsed !== "object") return { proxies: [], groups: [] };
  const proxies = Array.isArray(parsed.proxies) ? parsed.proxies : [];
  const groups = Array.isArray(parsed["proxy-groups"]) ? parsed["proxy-groups"] : [];
  return {
    proxyCount: proxies.length,
    groupCount: groups.length,
    proxies: proxies.map((p) => ({ name: p.name, type: p.type, server: p.server })),
    proxiesFull: proxies,
    groups: groups.map((g) => ({ name: g.name, type: g.type, count: Array.isArray(g.proxies) ? g.proxies.length : 0 })),
  };
}

module.exports = { tryDecodeSubscription, summarize };
