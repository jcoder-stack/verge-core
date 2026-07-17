// AI 出口目标回退链：按优先级返回第一个可用目标，全无则返回 null。
// 纯函数，无 DOM/IO 依赖，供 app.js（经 window.VergeTransport）与单测共用。

// 总出口组仅在有成员时才会被 generate-yaml.js 真正创建，故无成员时必须跳过，
// 否则会产出指向不存在分组的悬空目标，被 transport-ext.js 的完整性校验拦下。
function resolveAITarget(input) {
  const {
    aiTarget,
    aiExitGroupEnabled,
    aiExitGroupName,
    residentialGroup,
    directResidentialGroup,
    hasResidentials,
    hasDirectResidentials,
  } = input || {};

  const trimmed = String(aiTarget || "").trim();
  if (trimmed) return trimmed;

  if (aiExitGroupEnabled && (hasDirectResidentials || hasResidentials)) {
    return String(aiExitGroupName || "").trim() || "AI 总出口";
  }

  // 直连优先于中转，与 generate-yaml.js 中 aiExitMembers 的成员顺序一致
  if (hasDirectResidentials) {
    return String(directResidentialGroup || "").trim() || "直连住宅";
  }
  if (hasResidentials) {
    return String(residentialGroup || "").trim() || "住宅节点";
  }

  return null;
}

// 生成入口用的解析层：把请求体里的 aiRules 解析成 target 已填好的形态。
// 无可用目标时返回 { aiRules: null, skipped: true } —— 不抛错：无目标不是错误，
// 只是这批规则本次不适用。skipped 与 aiRules:null 分开表达，是为了让调用方能区分
// 「用户没填规则」（无需提示）与「填了但无处可去」（必须提示，否则退回静默丢弃的老 bug）。
function resolveAIRules(opts) {
  const {
    aiRules,
    aiExitGroup,
    residentialGroup,
    directResidentialGroup,
    residentials,
    directResidentials,
  } = opts || {};

  const hasRules =
    !!aiRules &&
    typeof aiRules === "object" &&
    ((Array.isArray(aiRules.domains) && aiRules.domains.length > 0) ||
      (Array.isArray(aiRules.providers) && aiRules.providers.length > 0));
  if (!hasRules) return { aiRules: null, skipped: false };

  // 成员判定与 generate-yaml.js 的 aiExitMembers 保持一致：无 name 的条目不算数
  const target = resolveAITarget({
    aiTarget: aiRules.target,
    aiExitGroupEnabled: !!aiExitGroup,
    aiExitGroupName: aiExitGroup,
    residentialGroup,
    directResidentialGroup,
    hasResidentials: Array.isArray(residentials) && residentials.some((r) => r && r.name),
    hasDirectResidentials:
      Array.isArray(directResidentials) && directResidentials.some((r) => r && r.name),
  });

  if (!target) return { aiRules: null, skipped: true };
  return { aiRules: { ...aiRules, target }, skipped: false };
}

module.exports = { resolveAITarget, resolveAIRules };
