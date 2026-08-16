// 节点列表的关键字过滤。
//
// 渲染列表与「全选 / 清空」必须共用同一份可见集合 —— 曾经渲染在 renderNodeList
// 里就地过滤，而全选直接遍历全量，导致过滤状态下点全选会把被隐藏的节点也选中。
//
// 浏览器里挂到 window.VergeNodeFilter，Node 下走 CommonJS 供单测引用。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VergeNodeFilter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function filterNodes(nodes, keyword) {
    if (!Array.isArray(nodes)) return [];
    var kw = String(keyword == null ? "" : keyword).trim().toLowerCase();
    if (!kw) return nodes.slice();
    return nodes.filter(function (p) {
      if (!p || !p.name) return false;
      return (
        String(p.name).toLowerCase().indexOf(kw) >= 0 ||
        String(p.type || "").toLowerCase().indexOf(kw) >= 0
      );
    });
  }

  return { filterNodes: filterNodes };
});
