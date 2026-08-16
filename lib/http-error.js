// 带 HTTP 状态码的错误类型：核心层抛出，由路由层直接映射为对应响应。
// 独立成模块，使 generate-yaml.js 与 generate-script.js 都能抛出同一种错误，
// 而不必让 script 路径反向依赖 yaml 模块。

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 死循环防御：住宅节点会挂 dialer-proxy → 中转组，若中转组候选里又含该住宅
// 节点本身，拨号就会自环。两条生成路径共用此校验，保证拒绝行为完全一致。
function assertNoDialerLoop(relay, residentials) {
  if (!relay || !Array.isArray(relay.proxies) || !Array.isArray(residentials)) return;
  const residentialNames = new Set(residentials.filter((r) => r && r.name).map((r) => r.name));
  const conflict = relay.proxies.filter((n) => residentialNames.has(n));
  if (conflict.length > 0) {
    throw new HttpError(
      400,
      `中转组候选包含住宅节点名 [${conflict.join(", ")}]，会导致 dialer-proxy 死循环，请移除`
    );
  }
}

module.exports = { HttpError, assertNoDialerLoop };
