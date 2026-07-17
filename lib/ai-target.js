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

module.exports = { resolveAITarget };
