// web/node-filter.js 单元测试
// 节点列表的关键字过滤：渲染与「全选/清空」必须用同一份可见集合，
// 否则过滤状态下点全选会选中被隐藏的节点。

const { test } = require("node:test");
const assert = require("node:assert");

const { filterNodes } = require("../web/node-filter");

const NODES = [
  { name: "🇺🇸 美国 01", type: "ss" },
  { name: "🇺🇸 美国 10 家宽", type: "ss" },
  { name: "🇭🇰 香港 01 [专线]", type: "vmess" },
  { name: "🇯🇵 日本 02", type: "trojan" },
];

test("filterNodes: 空关键字返回全部", () => {
  assert.equal(filterNodes(NODES, "").length, 4);
  assert.equal(filterNodes(NODES, "   ").length, 4);
  assert.equal(filterNodes(NODES, null).length, 4);
});

test("filterNodes: 按名称匹配", () => {
  const r = filterNodes(NODES, "美国");
  assert.deepEqual(r.map((n) => n.name), ["🇺🇸 美国 01", "🇺🇸 美国 10 家宽"]);
});

test("filterNodes: 按类型匹配", () => {
  assert.deepEqual(filterNodes(NODES, "trojan").map((n) => n.name), ["🇯🇵 日本 02"]);
});

test("filterNodes: 大小写不敏感", () => {
  assert.equal(filterNodes(NODES, "VMESS").length, 1);
  assert.equal(filterNodes(NODES, "TrOjAn").length, 1);
});

test("filterNodes: 关键字首尾空格被忽略", () => {
  assert.equal(filterNodes(NODES, "  家宽  ").length, 1);
});

test("filterNodes: 无匹配返回空数组", () => {
  assert.deepEqual(filterNodes(NODES, "不存在的关键字"), []);
});

test("filterNodes: 缺少 type 字段的节点不报错", () => {
  const r = filterNodes([{ name: "无类型节点" }], "无类型");
  assert.equal(r.length, 1);
});

test("filterNodes: 非数组输入返回空数组", () => {
  assert.deepEqual(filterNodes(null, "x"), []);
  assert.deepEqual(filterNodes(undefined, ""), []);
});

test("filterNodes: 不修改传入的数组", () => {
  const src = NODES.slice();
  filterNodes(src, "美国");
  assert.equal(src.length, 4, "原数组应保持不变");
});
