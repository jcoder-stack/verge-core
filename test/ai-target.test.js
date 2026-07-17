// 出口目标回退链单元测试：手填 → 总出口组 → 直连住宅 → 住宅节点 → null

const { test } = require("node:test");
const assert = require("node:assert");

const { resolveAITarget } = require("../lib/ai-target");

// 两种住宅都齐备的基线输入；各用例按需覆盖字段
function base(over) {
  return {
    aiTarget: "",
    aiExitGroupEnabled: false,
    aiExitGroupName: "",
    residentialGroup: "住宅节点",
    directResidentialGroup: "直连住宅",
    hasResidentials: false,
    hasDirectResidentials: false,
    ...over,
  };
}

test("手填出口目标优先于总出口组", () => {
  const t = resolveAITarget(base({
    aiTarget: "【B41】美国ATT住宅",
    aiExitGroupEnabled: true,
    aiExitGroupName: "AI 总出口",
    hasDirectResidentials: true,
  }));
  assert.strictEqual(t, "【B41】美国ATT住宅");
});

test("手填目标两端空白被裁剪", () => {
  assert.strictEqual(resolveAITarget(base({ aiTarget: "  住宅节点  " })), "住宅节点");
});

test("启用总出口组且两种住宅都有 → 总出口组", () => {
  const t = resolveAITarget(base({
    aiExitGroupEnabled: true,
    aiExitGroupName: "AI 总出口",
    hasResidentials: true,
    hasDirectResidentials: true,
  }));
  assert.strictEqual(t, "AI 总出口");
});

test("启用总出口组但组名为空 → 回退默认组名", () => {
  const t = resolveAITarget(base({
    aiExitGroupEnabled: true,
    aiExitGroupName: "",
    hasDirectResidentials: true,
  }));
  assert.strictEqual(t, "AI 总出口");
});

test("启用总出口组但无任何成员 → 跳过该组，无其他来源时为 null", () => {
  const t = resolveAITarget(base({
    aiExitGroupEnabled: true,
    aiExitGroupName: "AI 总出口",
  }));
  assert.strictEqual(t, null);
});

test("未启用总出口组，仅有直连住宅 → 直连住宅组", () => {
  const t = resolveAITarget(base({ hasDirectResidentials: true }));
  assert.strictEqual(t, "直连住宅");
});

test("未启用总出口组，仅有中转住宅 → 住宅节点组", () => {
  const t = resolveAITarget(base({ hasResidentials: true }));
  assert.strictEqual(t, "住宅节点");
});

test("未启用总出口组，两种住宅都有 → 直连优先", () => {
  const t = resolveAITarget(base({ hasResidentials: true, hasDirectResidentials: true }));
  assert.strictEqual(t, "直连住宅");
});

test("回退到住宅分组时使用用户自定义组名", () => {
  const t = resolveAITarget(base({
    residentialGroup: "我的住宅",
    directResidentialGroup: "我的直连",
    hasDirectResidentials: true,
  }));
  assert.strictEqual(t, "我的直连");
});

test("组名为空字符串时回退到各自默认名", () => {
  const t = resolveAITarget(base({
    residentialGroup: "",
    directResidentialGroup: "",
    hasResidentials: true,
  }));
  assert.strictEqual(t, "住宅节点");
});

test("无任何出口来源 → null", () => {
  assert.strictEqual(resolveAITarget(base()), null);
});

test("入参为 undefined → null，不抛异常", () => {
  assert.strictEqual(resolveAITarget(undefined), null);
});

test("resolveAITarget 从 core/index.js 导出", () => {
  const core = require("../index.js");
  assert.strictEqual(typeof core.resolveAITarget, "function");
});
