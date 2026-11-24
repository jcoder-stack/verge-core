// WebRTC 防泄漏：STUN 会向对端暴露 UDP 公网出口。国内 STUN 命中订阅的直连规则时
// 暴露的就是真实 IP，与 DNS 是否泄漏无关，故把常用 STUN 端口的 UDP 统一收进 AI 出口。
// 只覆盖常用端口；非常用端口的 STUN 仍按订阅规则分流。

const STUN_MATCH = "AND,((NETWORK,UDP),(DST-PORT,3478-3481/5349-5350/19302-19309))";

// 总出口组仅在有住宅成员时才真实存在
function effectiveAIExit({ aiExitGroup, residentials, directResidentials }) {
  const has = (list) => Array.isArray(list) && list.some((r) => r && r.name);
  const name = typeof aiExitGroup === "string" ? aiExitGroup.trim() : "";
  return name && (has(residentials) || has(directResidentials)) ? name : "";
}

// 返回需前置的规则；无可用出口时为空数组。
// REJECT 兜底：目标不支持 UDP（如 http 住宅）时 mihomo 会跳过该规则继续往下匹配，
// 不拦就会回落到订阅的直连规则，防护形同虚设。
function buildStunRules(opts) {
  const { stunGuard, aiRules } = opts || {};
  if (!stunGuard) return [];
  const target = effectiveAIExit(opts) || String((aiRules && aiRules.target) || "").trim();
  return target ? [`${STUN_MATCH},${target}`, `${STUN_MATCH},REJECT`] : [];
}

module.exports = { buildStunRules, effectiveAIExit };
