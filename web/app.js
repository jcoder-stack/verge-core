// Verge 覆写生成器前端逻辑
const state = {
  yaml: "",
  summary: null,
  selected: new Set(),
  outYaml: "",
  portRows: [], // [{port, type, target}]
  directResProxies: {}, // name -> 完整节点对象（来自住宅订阅）
  directResSelected: new Set(), // 勾选的直连住宅节点名
};

const $ = (id) => document.getElementById(id);

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => { b.classList.remove("active"); });
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.style.display = p.dataset.panel === tab ? "" : "none";
    });
  });
});

$("btnFetch").addEventListener("click", async () => {
  const url = $("subUrl").value.trim();
  if (!url) { setStatus("inputStatus", "请输入订阅地址", "err"); return; }
  setStatus("inputStatus", "拉取中…");
  try {
    const data = await window.VergeTransport.apiFetch(url);
    onParsed(data);
  } catch (e) {
    setStatus("inputStatus", "拉取失败: " + e.message, "err");
  }
});

$("subFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const text = await file.text();
  await parseText(text);
});

$("btnParse").addEventListener("click", async () => {
  const text = $("subPaste").value;
  if (!text.trim()) { setStatus("inputStatus", "请粘贴 YAML", "err"); return; }
  await parseText(text);
});

async function parseText(text) {
  setStatus("inputStatus", "解析中…");
  try {
    const data = await window.VergeTransport.apiParse(text);
    onParsed(data);
  } catch (e) {
    setStatus("inputStatus", "解析失败: " + e.message, "err");
  }
}

function onParsed(data) {
  state.yaml = data.yaml;
  state.summary = data.summary;
  state.selected.clear();
  const s = data.summary;
  setStatus("inputStatus", "解析成功：" + s.proxyCount + " 节点 / " + s.groupCount + " 分组", "ok");
  $("nodeInfo").textContent = "已加载：" + s.proxyCount + " 节点";
  renderNodeList();
  refreshTargetOptions();
  $("btnGen").disabled = false;
  const btnExportClashMi = $("btnExportClashMi");
  if (btnExportClashMi) btnExportClashMi.disabled = false;
}

// ---------------- Port mappings (动态行) ----------------
function renderPortMappings() {
  const box = $("portMappings");
  if (!box) return;
  if (state.portRows.length === 0) {
    box.innerHTML = '<div class="hint">暂无映射。点击下方按钮添加。</div>';
    return;
  }
  box.innerHTML = state.portRows
    .map(
      (r, i) =>
        '<div class="row port-row" data-idx="' + i + '" style="margin-bottom:6px">' +
          '<input type="number" class="pm-port" placeholder="端口" value="' + escapeAttr(r.port) + '" min="1" max="65535" style="flex:1" title="端口" />' +
          '<select class="pm-type" title="类型" style="flex:1">' +
            '<option value="socks"' + (r.type === "socks" ? " selected" : "") + '>socks</option>' +
            '<option value="http"' + (r.type === "http" ? " selected" : "") + '>http</option>' +
            '<option value="mixed"' + (r.type === "mixed" ? " selected" : "") + '>mixed</option>' +
          '</select>' +
          '<input type="text" class="pm-target" placeholder="目标节点/分组名" value="' + escapeAttr(r.target) + '" list="targetOptions" style="flex:2" title="目标" />' +
          '<button class="secondary pm-del" title="删除" style="flex:0 0 auto">×</button>' +
        '</div>'
    )
    .join("");
  box.querySelectorAll(".port-row").forEach((row) => {
    const idx = Number(row.dataset.idx);
    row.querySelector(".pm-port").addEventListener("input", (e) => { state.portRows[idx].port = e.target.value; });
    row.querySelector(".pm-type").addEventListener("change", (e) => { state.portRows[idx].type = e.target.value; });
    row.querySelector(".pm-target").addEventListener("input", (e) => { state.portRows[idx].target = e.target.value; });
    row.querySelector(".pm-del").addEventListener("click", () => {
      state.portRows.splice(idx, 1);
      renderPortMappings();
    });
  });
}

function refreshTargetOptions() {
  const dl = $("targetOptions");
  if (!dl) return;
  const entries = []; // {name, tag}
  const seen = new Set();
  const add = (name, tag) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    entries.push({ name, tag });
  };

  // 中转分组名
  const relayName = $("relayName").value.trim();
  if (relayName) add(relayName, "[中转组]");
  // 订阅里的节点与分组
  if (state.summary) {
    state.summary.proxies.forEach((p) => add(p.name, "[订阅]"));
    state.summary.groups.forEach((g) => add(g.name, "[分组]"));
  }
  // 住宅行输入即将生成的节点名（走中转）
  const prefix = ($("residentialPrefix").value.trim() || '住宅');
  const lines = $("residentialLines").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const singleLine = lines.length === 1;
  lines.forEach((line, i) => {
    if (line.includes("|")) {
      const n = line.slice(0, line.indexOf("|")).trim();
      if (n) { add(n, "[中转住宅]"); return; }
    }
    add(singleLine ? prefix : `${prefix}-${i + 1}`, "[中转住宅]");
  });
  if (hasResidentials()) add(residentialGroupName(), "[住宅组]");

  // 直连住宅：勾选的节点 + 分组名
  Array.from(state.directResSelected).forEach((name) => add(name, "[直连]"));
  if (state.directResSelected.size > 0) {
    add(($("directResidentialGroup").value.trim() || "直连住宅"), "[直连组]");
  }

  // AI 总出口开关组（启用且至少有一个直连或中转住宅成员时才会真正生成）
  const aiExitEnabled = $("aiExitGroupEnabled") && $("aiExitGroupEnabled").checked;
  if (aiExitEnabled && (state.directResSelected.size > 0 || hasResidentials())) {
    add(($("aiExitGroupName").value.trim() || "AI 总出口"), "[AI总出口]");
  }

  // 常用内置
  add("DIRECT", "[内置]");
  add("REJECT", "[内置]");

  dl.innerHTML = entries
    .map((e) => '<option value="' + escapeAttr(e.name) + '" label="' + escapeAttr(e.tag + " " + e.name) + '"></option>')
    .join("");
}

function escapeAttr(s) {
  return String(s == null ? "" : s).replace(/["&<>]/g, (c) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---------------- Node list ----------------
function renderNodeList() {
  const listEl = $("nodeList");
  if (!state.summary || !state.summary.proxies.length) {
    listEl.innerHTML = '<div class="empty">无节点</div>';
    return;
  }
  const kw = $("nodeFilter").value.trim().toLowerCase();
  const items = state.summary.proxies.filter(
    (p) => !kw || p.name.toLowerCase().includes(kw) || (p.type || "").toLowerCase().includes(kw)
  );
  listEl.innerHTML = items
    .map((p) => {
      const checked = state.selected.has(p.name) ? "checked" : "";
      const nm = escapeHtml(p.name);
      return (
        '<label class="node-item">' +
        '<input type="checkbox" data-name="' + encodeURIComponent(p.name) + '" ' + checked + ' />' +
        '<span class="nm" title="' + nm + '">' + nm + '</span>' +
        '<span class="type">' + escapeHtml(p.type || "?") + '</span>' +
        '</label>'
      );
    })
    .join("");
  listEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const name = decodeURIComponent(cb.dataset.name);
      if (cb.checked) state.selected.add(name);
      else state.selected.delete(name);
      updateSelCount();
    });
  });
  updateSelCount();
}

function updateSelCount() {
  $("selCount").textContent = state.selected.size + state.directResSelected.size;
}

$("nodeFilter").addEventListener("input", renderNodeList);
$("selAll").addEventListener("click", () => {
  if (!state.summary) return;
  state.summary.proxies.forEach((p) => state.selected.add(p.name));
  renderNodeList();
});
$("selNone").addEventListener("click", () => {
  state.selected.clear();
  renderNodeList();
});
$("selPremium").addEventListener("click", () => {
  if (!state.summary) return;
  state.selected.clear();
  state.summary.proxies.forEach((p) => {
    if (/\[专线\]/.test(p.name)) state.selected.add(p.name);
  });
  renderNodeList();
});

// ---------------- Generate ----------------
// 收集前端表单 → /api/generate 请求 body。校验失败返回 {error}。
function collectGeneratePayload() {
  if (!state.yaml) return { error: "请先加载订阅" };
  const relayName = $("relayName").value.trim() || "高速中转";
  const relayType = $("relayType").value;
  const selected = Array.from(state.selected);

  let residentials = [];

  // 1) 行格式输入
  const lines = $("residentialLines").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  if (lines.length > 0) {
    const fmt = $("residentialFormat").value;
    const type = $("residentialType").value;
    const prefix = $("residentialPrefix").value.trim() || "住宅";
    const usedNames = new Set();
    for (let i = 0; i < lines.length; i++) {
      let raw = lines[i];
      // 支持显式命名：name|host:port:user:pass
      let explicitName = "";
      if (raw.includes("|")) {
        const barIdx = raw.indexOf("|");
        explicitName = raw.slice(0, barIdx).trim();
        raw = raw.slice(barIdx + 1).trim();
      }
      const parts = raw.split(":");
      if (parts.length < 4) {
        return { error: `第 ${i + 1} 行格式错误（需要 4 段，用 : 分隔）: ${lines[i]}` };
      }
      // 超过 4 段时，用户名/密码中可能含 :，我们把尾部多余段落并入 password
      let host, port, user, pass;
      if (fmt === "host_port_user_pass") {
        host = parts[0];
        port = parts[1];
        user = parts[2];
        pass = parts.slice(3).join(":");
      } else {
        user = parts[0];
        pass = parts.slice(1, parts.length - 2).join(":") || parts[1];
        host = parts[parts.length - 2];
        port = parts[parts.length - 1];
      }
      const portNum = Number(port);
      if (!host || !Number.isFinite(portNum) || portNum <= 0) {
        return { error: `第 ${i + 1} 行 host/port 无效: ${lines[i]}` };
      }
      // 生成唯一节点名：优先显式命名；单行时=前缀；多行时=前缀-序号
      const singleLine = lines.length === 1;
      let name = explicitName || (singleLine ? prefix : `${prefix}-${i + 1}`);
      let k = i + 1;
      while (usedNames.has(name)) {
        k++;
        name = explicitName ? `${explicitName}-${k}` : `${prefix}-${k}`;
      }
      usedNames.add(name);
      residentials.push({
        name,
        type,
        server: host,
        port: portNum,
        username: user,
        password: pass,
        udp: true,
      });
    }
  }

  // 2) JSON 数组（追加，覆盖同名）
  const rJson = $("residentialsJson").value.trim();
  if (rJson) {
    try {
      const extra = JSON.parse(rJson);
      if (!Array.isArray(extra)) throw new Error("必须是 JSON 数组");
      const names = new Set(residentials.map((r) => r.name));
      extra.forEach((r) => {
        if (r && r.name && !names.has(r.name)) {
          residentials.push(r);
          names.add(r.name);
        }
      });
    } catch (e) {
      return { error: "住宅节点 JSON 解析失败: " + e.message };
    }
  }

  // 3) AI 出口规则
  const aiTarget = $("aiTarget").value.trim();
  const aiDomains = $("aiDomains").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const aiProviders = $("aiProviders").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map((line) => {
      // 支持 纯 URL / name|url|behavior|interval
      const parts = line.split("|").map((x) => x.trim());
      let name, url, behavior, interval;
      if (parts.length === 1) {
        url = parts[0];
        // 从 URL 推导 name: 文件名去扩展名
        const m = url.match(/\/([^/?#]+?)(?:\.[a-zA-Z0-9]+)?(?:[?#]|$)/);
        name = m ? m[1] : "rule_" + Math.random().toString(36).slice(2, 8);
      } else {
        [name, url, behavior, interval] = parts;
      }
      return {
        name: (name || "").replace(/[^A-Za-z0-9_\-]/g, "_"),
        url,
        behavior: behavior || "classical",
        interval: Number(interval) || 259200,
      };
    })
    .filter((p) => p.name && /^https?:\/\//.test(p.url));
  // AI 总出口开关组（启用时）。你为 AI 建了这个组，AI 规则就默认走它，
  // 不必再单独填「出口目标」——出口目标优先用手填的，没填则回退到这个组。
  const aiExitGroup = ($("aiExitGroupEnabled") && $("aiExitGroupEnabled").checked)
    ? ($("aiExitGroupName").value.trim() || "AI 总出口")
    : "";
  const aiTargetFinal = aiTarget || aiExitGroup;
  const aiRules =
    aiTargetFinal && (aiDomains.length > 0 || aiProviders.length > 0)
      ? { target: aiTargetFinal, domains: aiDomains, providers: aiProviders }
      : null;

  // 4) 特定端口代理入口
  const portMappings = state.portRows
    .map((r) => ({ port: Number(r.port), type: r.type || "socks", target: (r.target || "").trim() }))
    .filter((r) => Number.isFinite(r.port) && r.port > 0 && r.target);

  // 5) 直连住宅（完整节点对象，原样提交）
  const directResidentials = Array.from(state.directResSelected)
    .map((name) => state.directResProxies[name])
    .filter(Boolean);
  const directResidentialGroup = $("directResidentialGroup").value.trim() || "直连住宅";

  // 6) AI 总出口开关组成员校验（aiExitGroup 已在上面 AI 规则处定义）
  // 启用了总出口组但没有任何成员（直连未勾选 + 无中转住宅）→ 明确报错，避免“勾了却没生成”的静默丢弃
  if (aiExitGroup && directResidentials.length === 0 && residentials.length === 0) {
    return { error: "已勾选「生成 AI 总出口开关组」，但没有任何成员：请在「2.5 直连住宅订阅」勾选直连节点，或在上方添加中转住宅，再生成。" };
  }

  // 中转可选：只有存在 socks5/http 住宅（需 dialer-proxy）时才强制要求中转
  if (residentials.length > 0 && selected.length === 0) {
    return { error: "存在 socks5/http 住宅节点，需至少勾选一个中转节点作为 dialer-proxy 第一跳" };
  }
  // 至少要有一个出口来源
  if (selected.length === 0 && residentials.length === 0 && directResidentials.length === 0) {
    return { error: "请至少勾选一个中转节点，或在「直连住宅」中勾选节点" };
  }

  const extensionScript = (window.VergeTransport && window.VergeTransport.supportsHook === false) ? "" : $("extScript").value;

  return {
    body: {
      yaml: state.yaml,
      relay: { name: relayName, type: relayType, proxies: selected },
      residentials,
      residentialGroup: residentialGroupName(),
      directResidentials,
      directResidentialGroup,
      aiExitGroup,
      aiRules,
      dnsAntiLeak: $("dnsAntiLeak").checked,
      dnsLan: $("dnsLan") ? $("dnsLan").checked : false,
      dnsTun: $("dnsTun") ? $("dnsTun").checked : false,
      portMappings,
      extensionScript,
    },
  };
}

$("btnGen").addEventListener("click", async () => {
  const collected = collectGeneratePayload();
  if (collected.error) { setStatus("genStatus", collected.error, "err"); return; }
  const format = $("outputFormat").value === "script" ? "script" : "yaml";
  const body = { ...collected.body, format };

  setStatus("genStatus", "生成中…");
  try {
    const data = await window.VergeTransport.apiGenerate(body);
    const out = format === "script" ? data.script : data.yaml;
    state.outYaml = out;
    state.outFormat = format;
    $("outYaml").textContent = out;
    setStatus("genStatus", `生成成功 [${format}] (${out.length} 字节)`, "ok");
    $("btnDownload").disabled = false;
    $("btnCopy").disabled = false;
  } catch (e) {
    setStatus("genStatus", "生成失败: " + e.message, "err");
  }
});

// 一键导出 ClashMi 兼容 YAML：生成后立即下载，文件名 clashmi-config-{ts}.yml
$("btnExportClashMi").addEventListener("click", async () => {
  const collected = collectGeneratePayload();
  if (collected.error) { setStatus("genStatus", collected.error, "err"); return; }
  const body = { ...collected.body, format: "clashmi" };

  setStatus("genStatus", "生成 ClashMi YAML 中…");
  try {
    const data = await window.VergeTransport.apiGenerate(body);
    const out = data.yaml || "";
    state.outYaml = out;
    state.outFormat = "clashmi";
    $("outYaml").textContent = out;
    $("btnDownload").disabled = false;
    $("btnCopy").disabled = false;

    // 立即触发下载
    const blob = new Blob([out], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clashmi-config-${Date.now()}.yml`;
    a.click();
    URL.revokeObjectURL(url);

    setStatus("genStatus", `已导出 ClashMi YAML (${out.length} 字节)`, "ok");
  } catch (e) {
    setStatus("genStatus", "导出失败: " + e.message, "err");
  }
});

$("btnDownload").addEventListener("click", () => {
  if (!state.outYaml) return;
  const isScript = state.outFormat === "script";
  const blob = new Blob([state.outYaml], {
    type: isScript ? "application/javascript" : "text/yaml",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "verge-override-" + Date.now() + (isScript ? ".js" : ".yml");
  a.click();
  URL.revokeObjectURL(url);
});

$("btnCopy").addEventListener("click", async () => {
  if (!state.outYaml) return;
  try {
    await navigator.clipboard.writeText(state.outYaml);
    setStatus("genStatus", "已复制到剪贴板", "ok");
  } catch (e) {
    setStatus("genStatus", "复制失败: " + e.message, "err");
  }
});

// ---------------- Utils ----------------
function setStatus(id, msg, kind) {
  const el = $(id);
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- Port mappings 初始化 ----------------
// 住宅节点 select 分组名：由用户输入定义（与发送给 server 的 residentialGroup 一致）。
// 多个住宅节点时，出口目标应指向这个“分组”，才能在分组内切换具体节点；
// 若指向某个具体节点名，则会被写死到该节点，切换分组无效。
function residentialGroupName() {
  const el = $("residentialGroup");
  return (el && el.value.trim()) || "住宅节点";
}

// 是否存在任何住宅节点输入（行格式 或 JSON 数组）
function hasResidentials() {
  const lines = $("residentialLines").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  if (lines.length > 0) return true;
  const raw = $("residentialsJson").value.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length > 0;
    } catch {}
  }
  return false;
}

$("btnAddPort").addEventListener("click", () => {
  // 目标默认留空：避免误填中转住宅组让人以为“只能选美国住宅”。
  // 从下拉里按标签自选：[直连]/[直连组] 走直连，[中转住宅]/[住宅组] 走中转。
  state.portRows.push({ port: 1080, type: "socks", target: "" });
  renderPortMappings();
});

// 住宅相关输入变化时，只刷新出口目标候选；不再自动把“中转住宅组”写进 AI/端口目标
// （避免误导成“只能选中转住宅”——出口一律由用户从带标签的下拉里自选：
//  [直连]/[直连组] 走直连，[中转住宅]/[住宅组] 走中转）。
function autofillTargets() {
  refreshTargetOptions();
}
["relayName", "residentialPrefix", "residentialGroup", "residentialLines", "residentialsJson"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("input", autofillTargets);
});

renderPortMappings();
refreshTargetOptions();

// ---------------- 直连住宅订阅（2.5 区块） ----------------
// 独立子标签切换（用 data-dtab/data-dpanel，避免与主订阅 .tabs 冲突）
document.querySelectorAll("#directResSection .dtabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#directResSection .dtabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.dtab;
    document.querySelectorAll("#directResSection .dtab-panel").forEach((p) => {
      p.style.display = p.dataset.dpanel === tab ? "" : "none";
    });
  });
});

$("btnDresFetch").addEventListener("click", async () => {
  const url = $("dresUrl").value.trim();
  if (!url) { setStatus("dresStatus", "请输入住宅订阅地址", "err"); return; }
  setStatus("dresStatus", "拉取中…");
  try {
    const data = await window.VergeTransport.apiFetch(url);
    onDirectResParsed(data);
  } catch (e) {
    setStatus("dresStatus", "拉取失败: " + e.message, "err");
  }
});

$("btnDresParse").addEventListener("click", async () => {
  const text = $("dresPaste").value;
  if (!text.trim()) { setStatus("dresStatus", "请粘贴住宅 YAML", "err"); return; }
  setStatus("dresStatus", "解析中…");
  try {
    const data = await window.VergeTransport.apiParse(text);
    onDirectResParsed(data);
  } catch (e) {
    setStatus("dresStatus", "解析失败: " + e.message, "err");
  }
});

function onDirectResParsed(data) {
  const full = (data.summary && Array.isArray(data.summary.proxiesFull)) ? data.summary.proxiesFull : [];
  state.directResProxies = {};
  state.directResSelected.clear();
  full.forEach((p) => { if (p && p.name) state.directResProxies[p.name] = p; });
  renderDirectResList();
  refreshTargetOptions();
  updateDresStatus();
}

// 直连住宅勾选提示：未勾选时明确告知“勾选后才会注入并可作为出口目标”，避免漏勾导致下拉里选不到。
function updateDresStatus() {
  const total = Object.keys(state.directResProxies).length;
  const sel = state.directResSelected.size;
  if (total === 0) { setStatus("dresStatus", "未解析到住宅节点", "err"); return; }
  if (sel === 0) {
    setStatus("dresStatus", "解析成功 " + total + " 个节点 —— 请勾选要使用的节点（勾选后才会注入，并出现在 AI/端口的出口目标候选里）", "err");
  } else {
    setStatus("dresStatus", "已勾选 " + sel + "/" + total + " 个，将作为直连出口注入", "ok");
  }
}

function renderDirectResList() {
  const listEl = $("dresList");
  const all = Object.values(state.directResProxies);
  if (!all.length) {
    listEl.innerHTML = '<div class="empty">无节点</div>';
    return;
  }
  const kw = $("dresFilter").value.trim().toLowerCase();
  const items = all.filter(
    (p) => !kw || p.name.toLowerCase().includes(kw) || (p.type || "").toLowerCase().includes(kw)
  );
  listEl.innerHTML = items
    .map((p) => {
      const checked = state.directResSelected.has(p.name) ? "checked" : "";
      const nm = escapeHtml(p.name);
      return (
        '<label class="node-item">' +
        '<input type="checkbox" data-name="' + encodeURIComponent(p.name) + '" ' + checked + ' />' +
        '<span class="nm" title="' + nm + '">' + nm + '</span>' +
        '<span class="type">' + escapeHtml(p.type || "?") + '</span>' +
        '</label>'
      );
    })
    .join("");
  listEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const name = decodeURIComponent(cb.dataset.name);
      if (cb.checked) state.directResSelected.add(name);
      else state.directResSelected.delete(name);
      refreshTargetOptions();
      updateSelCount();
      updateDresStatus();
    });
  });
  updateSelCount();
}

$("dresFilter").addEventListener("input", renderDirectResList);
$("dresSelAll").addEventListener("click", () => {
  Object.keys(state.directResProxies).forEach((name) => state.directResSelected.add(name));
  renderDirectResList();
  refreshTargetOptions();
  updateSelCount();
  updateDresStatus();
});
$("dresSelNone").addEventListener("click", () => {
  state.directResSelected.clear();
  renderDirectResList();
  refreshTargetOptions();
  updateSelCount();
  updateDresStatus();
});
$("directResidentialGroup").addEventListener("input", refreshTargetOptions);
$("aiExitGroupEnabled").addEventListener("change", refreshTargetOptions);
$("aiExitGroupName").addEventListener("input", refreshTargetOptions);

// 扩展环境不支持 hook：隐藏面板并保证不发送 extensionScript
if (window.VergeTransport && window.VergeTransport.supportsHook === false) {
  const hp = document.getElementById("hookPanel");
  if (hp) hp.style.display = "none";
}

