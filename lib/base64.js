// 同构 base64 → UTF-8 文本解码。Node 用 Buffer；浏览器用 atob + TextDecoder。
// 注意：不要 require('buffer')，否则 esbuild 会把 Buffer shim 打进扩展包。
function decodeBase64(str) {
  const s = String(str || "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "base64").toString("utf8");
  }
  const binary = atob(s.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

module.exports = { decodeBase64 };
