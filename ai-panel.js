// ===== AI 顾问面板(手机版、电脑版共用) =====
// 页面调用: CalmAI.init({ getToken, ensureAuth(cb), onPlanChanged() }); 有入口按钮时 CalmAI.open()
// 手机上是底部弹层, 电脑上是右侧抽屉; 样式自带(不依赖 tailwind 预编译), 跟随页面深色模式。
(function () {
  "use strict";
  const LS_ANON = "calmAiAnon", SS_CHAT = "calmAiChat";
  let hooks = { getToken: () => "", ensureAuth: (cb) => cb(), onPlanChanged: () => {} };
  let cfg = null, root = null, msgs = [], busy = null, applied = {};

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const $ = (sel) => root.querySelector(sel);
  const anon = () => {   // 用户勾过就按用户的; 没勾过按服务端默认(默认只发比例)
    let v = null; try { v = localStorage.getItem(LS_ANON); } catch (e) {}
    return v === null ? !(cfg && cfg.anonymizeDefault === false) : v !== "0";
  };
  const saveChat = () => { try { sessionStorage.setItem(SS_CHAT, JSON.stringify(msgs.slice(-30))); } catch (e) {} };
  try { msgs = JSON.parse(sessionStorage.getItem(SS_CHAT) || "[]") || []; } catch (e) { msgs = []; }

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", "X-Auth-Token": hooks.getToken() || "", ...(opts.headers || {}) } });
    if (res.status === 401) throw Object.assign(new Error("登录已过期，请刷新页面重新登录"), { status: 401 });
    return res;
  }

  // ---- 极简 Markdown: 标题、列表、粗体、行内代码、段落; 先转义再替换, 不插入任何外部 HTML ----
  function md(text) {
    const lines = esc(String(text || "").replace(/```calm-proposals[\s\S]*?(```|$)/g, "").trim()).split("\n");
    let html = "", list = null;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    lines.forEach((l) => {
      let m;
      if ((m = /^\s*#{1,4}\s+(.*)$/.exec(l))) { close(); html += `<div class="cai-h">${inline(m[1])}</div>`; }
      else if ((m = /^\s*[-*•]\s+(.*)$/.exec(l))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = /^\s*\d+[.)、]\s+(.*)$/.exec(l))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
      else if (!l.trim()) { close(); }
      else { close(); html += `<p>${inline(l)}</p>`; }
    });
    close();
    return html;
  }

  function css() {
    if (document.getElementById("cai-style")) return;
    const st = document.createElement("style");
    st.id = "cai-style";
    st.textContent = `
.cai-mask{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.35);display:flex;justify-content:flex-end;align-items:flex-end}
.cai{--bg:#fff;--fg:#1f2937;--mut:#9ca3af;--line:#eef0f3;--soft:#f3f4f6;--acc:#14b8a6;--acc2:#0f766e;--warn:#d97706;
  background:var(--bg);color:var(--fg);display:flex;flex-direction:column;font-size:14px;line-height:1.6;box-shadow:0 10px 40px rgba(0,0,0,.18)}
.cai.dark{--bg:#161b22;--fg:#e5e7eb;--mut:#7d8590;--line:#262c36;--soft:#21262d;--acc:#2dd4bf;--acc2:#5eead4;--warn:#f59e0b}
@media (max-width:767px){.cai{width:100%;height:92vh;border-radius:22px 22px 0 0;font-size:15px}}
@media (min-width:768px){.cai-mask{align-items:stretch}.cai{width:480px;max-width:94vw;height:100%}}
.cai-hd{display:flex;align-items:center;gap:8px;padding:16px 18px 10px;border-bottom:1px solid var(--line)}
.cai-hd b{font-size:17px}.cai-hd .cai-model{color:var(--mut);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cai-x{border:0;background:var(--soft);color:var(--fg);border-radius:10px;padding:5px 10px;font-size:13px;cursor:pointer}
.cai-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line);font-size:13px}
.cai-btn{border:0;border-radius:12px;padding:7px 12px;font-weight:600;cursor:pointer;background:var(--soft);color:var(--fg);font-size:13px}
.cai-btn.pri{background:var(--acc);color:#fff}.cai-btn:disabled{opacity:.45;cursor:default}
.cai-chk{display:flex;align-items:center;gap:5px;color:var(--mut);margin-left:auto;cursor:pointer}
.cai-body{flex:1;overflow-y:auto;padding:14px 18px}
.cai-empty{color:var(--mut);font-size:13px;padding:24px 4px}
.cai-m{margin:0 0 14px}.cai-u{background:var(--soft);border-radius:14px;padding:8px 12px;margin-left:15%;white-space:pre-wrap}
.cai-a p{margin:0 0 6px}.cai-a ul,.cai-a ol{margin:0 0 6px;padding-left:20px}.cai-a ul{list-style:disc}.cai-a ol{list-style:decimal}.cai-a li{margin:2px 0}.cai-a .cai-h{font-weight:700;margin:10px 0 4px}
.cai-a code{background:var(--soft);border-radius:5px;padding:0 4px;font-size:.92em}
.cai-err{color:var(--warn);font-size:13px}
.cai-props{border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin:6px 0 4px;background:var(--bg)}
.cai-props .t{font-size:12px;color:var(--mut);margin-bottom:6px}
.cai-p{display:flex;gap:8px;padding:6px 0;border-top:1px dashed var(--line)}.cai-p:first-of-type{border-top:0}
.cai-p .s{font-weight:600}.cai-p .w{color:var(--mut);font-size:12px}
.cai-props input[type=text]{width:100%;box-sizing:border-box;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:10px;padding:7px 10px;margin:8px 0;font-size:13px}
.cai-done{color:var(--acc2);font-size:13px;margin-top:6px}
.cai-pend{margin:10px 18px 0;padding:8px 12px;border-radius:12px;background:var(--soft);font-size:12px}
.cai-pend .row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:3px 0}
.cai-pre{white-space:pre-wrap;font-size:12px;background:var(--soft);border-radius:12px;padding:10px 12px;margin:0 0 14px;max-height:45vh;overflow:auto}
.cai-ft{border-top:1px solid var(--line);padding:10px 14px calc(10px + env(safe-area-inset-bottom))}
.cai-in{display:flex;gap:8px;align-items:flex-end}
.cai-in textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:14px;padding:9px 12px;font-size:15px;line-height:1.4;max-height:120px;outline:none}
.cai-note{color:var(--mut);font-size:11px;text-align:center;margin-top:6px}
.cai-dots::after{content:"…";animation:caiDot 1s steps(3,end) infinite}@keyframes caiDot{0%{content:"."}50%{content:".."}100%{content:"..."}}`;
    document.head.appendChild(st);
  }

  function build() {
    css();
    const mask = document.createElement("div");
    mask.className = "cai-mask";
    mask.innerHTML = `<div class="cai" role="dialog" aria-label="AI 顾问">
      <div class="cai-hd"><b>AI 顾问</b><span class="cai-model"></span><button class="cai-x" data-act="clear">清空</button><button class="cai-x" data-act="close">关闭</button></div>
      <div class="cai-tools">
        <button class="cai-btn pri" data-act="checkup">一键体检</button>
        <button class="cai-btn" data-act="preview">看看会发什么</button>
        <label class="cai-chk"><input type="checkbox" data-act="anon"> 只发比例</label>
      </div>
      <div class="cai-pendbox"></div>
      <div class="cai-body"></div>
      <div class="cai-ft">
        <div class="cai-in"><textarea rows="1" placeholder="问问你的持仓和规则…"></textarea><button class="cai-btn pri" data-act="send">发送</button></div>
        <div class="cai-note">AI 的分析仅供参考，不构成投资建议；规则修改都要你确认。</div>
      </div></div>`;
    mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
    mask.addEventListener("click", onClick);
    mask.addEventListener("change", (e) => { if (e.target.dataset.act === "anon") { try { localStorage.setItem(LS_ANON, e.target.checked ? "1" : "0"); } catch (x) {} } });
    const ta = mask.querySelector("textarea");
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(120, ta.scrollHeight) + "px"; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.innerWidth >= 768) { e.preventDefault(); send(); } });
    return mask;
  }

  function onClick(e) {
    const act = e.target.closest("[data-act]") && e.target.closest("[data-act]").dataset.act;
    if (!act) return;
    if (act === "close") close();
    else if (act === "clear") { if (busy) busy.abort(); msgs = []; applied = {}; saveChat(); render(); }
    else if (act === "checkup") send(cfg && cfg.checkupPrompt);
    else if (act === "send") busy ? busy.abort() : send();
    else if (act === "preview") preview();
    else if (act === "apply") apply(+e.target.dataset.i);
    else if (act === "cancel") cancelPending(e.target.dataset.id);
  }

  function render() {
    const dark = document.body.classList.contains("dark") || document.documentElement.classList.contains("dark");
    $(".cai").classList.toggle("dark", dark);
    $(".cai-model").textContent = cfg && cfg.model ? cfg.model : "";
    $("[data-act=anon]").checked = anon();
    const body = $(".cai-body");
    if (!msgs.length) {
      body.innerHTML = `<div class="cai-empty">AI 会读取你现在的持仓占比和规则（看板已经把数字算好），帮你检查结构、集中度和规则有没有遗漏。<br><br>它不会预测涨跌，也不会替你下单；想改规则时会给出建议，你确认后才生效。<br><br>默认「只发比例」：不发金额、股数和成本价。点「看看会发什么」可以先确认内容。</div>`;
    } else {
      body.innerHTML = msgs.map((m, i) => {
        if (m.role === "user") return `<div class="cai-m cai-u">${esc(m.shown || m.content)}</div>`;
        if (m.role === "preview") return `<div class="cai-pre">${esc(m.content)}</div>`;
        let h = `<div class="cai-m cai-a">${md(m.content) || (m.streaming ? '<span class="cai-dots">思考中</span>' : "")}`;
        if (m.error) h += `<div class="cai-err">${esc(m.error)}</div>`;
        if (m.proposals && m.proposals.length) h += proposalsHtml(m, i);
        return h + "</div>";
      }).join("");
    }
    $("[data-act=send]").textContent = busy ? "停止" : "发送";
    $("[data-act=checkup]").disabled = !!busy;
    body.scrollTop = body.scrollHeight;
  }

  function proposalsHtml(m, i) {
    const done = applied[i];
    const cd = cfg && cfg.cooldownHours > 0;
    return `<div class="cai-props"><div class="t">AI 的修改建议 · 勾选后确认才会改规则${cd ? `（冷静期 ${cfg.cooldownHours} 小时后生效）` : ""}</div>
      ${m.proposals.map((p, j) => `<label class="cai-p"><input type="checkbox" data-i="${i}" data-j="${j}" ${done ? "disabled" : "checked"}><span><div class="s">${esc(p.summary)}</div>${p.why ? `<div class="w">${esc(p.why)}</div>` : ""}</span></label>`).join("")}
      ${done ? `<div class="cai-done">${esc(done)}</div>` : `<input type="text" data-reason="${i}" maxlength="200" placeholder="你的理由（可选，会记进修改记录）">
      <button class="cai-btn pri" data-act="apply" data-i="${i}">${cd ? "确认，加入待生效" : "确认修改"}</button>`}</div>`;
  }

  async function send(preset) {
    if (busy) return;
    const ta = $("textarea");
    const text = String(preset || ta.value || "").trim();
    if (!text) return;
    if (!preset) { ta.value = ""; ta.style.height = "auto"; }
    msgs.push({ role: "user", content: text, shown: preset ? "一键体检" : text });
    const a = { role: "assistant", content: "", streaming: true };
    msgs.push(a);
    render();
    busy = new AbortController();
    render();
    try {
      const history = msgs.filter((m) => (m.role === "user" || m.role === "assistant") && m !== a && m.content).map((m) => ({ role: m.role, content: m.content }));
      const res = await api("/api/ai/chat", { method: "POST", body: JSON.stringify({ messages: history, anonymize: anon() }), signal: busy.signal });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `请求失败（${res.status}）`); }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", last = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const ev = (/^event: (.*)$/m.exec(block) || [])[1], data = (/^data: (.*)$/m.exec(block) || [])[1];
          if (!ev || !data) continue;
          const d = JSON.parse(data);
          if (ev === "delta") a.content += d.t;
          else if (ev === "done") a.proposals = d.proposals || [];
          else if (ev === "error") a.error = d.msg;
        }
        if (Date.now() - last > 80) { last = Date.now(); render(); }
      }
    } catch (e) {
      if (e.name !== "AbortError") a.error = e.message;
      else a.error = a.content ? "（已停止）" : "已停止";
    }
    a.streaming = false;
    busy = null;
    saveChat();
    render();
  }

  async function preview() {
    try {
      const res = await api("/api/ai/context", { method: "POST", body: JSON.stringify({ anonymize: anon() }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "获取失败");
      msgs.push({ role: "preview", content: "下面是这次会和你的问题一起发给 AI 的数据：\n\n" + j.text });
    } catch (e) { msgs.push({ role: "assistant", content: "", error: e.message }); }
    render();
  }

  async function apply(i) {
    const m = msgs[i];
    if (!m || !m.proposals) return;
    const picked = [...root.querySelectorAll(`input[type=checkbox][data-i="${i}"]`)].filter((x) => x.checked).map((x) => m.proposals[+x.dataset.j]);
    if (!picked.length) return;
    const reason = (root.querySelector(`input[data-reason="${i}"]`) || {}).value || "";
    try {
      const res = await api("/api/ai/apply", { method: "POST", body: JSON.stringify({ proposals: picked, reason }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "修改失败");
      const okN = j.results.filter((r) => r.ok).length;
      applied[i] = j.pending ? `已加入待生效，${new Date(j.dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 自动生效，之前可以撤销。` : `已修改 ${okN} 条，记进了规则修改记录。`;
      if (!j.pending) hooks.onPlanChanged();
      loadPending();
    } catch (e) { applied[i] = null; alert(e.message); }
    render();
  }

  async function loadPending() {
    const box = $(".cai-pendbox");
    if (!cfg || !(cfg.cooldownHours > 0)) { box.innerHTML = ""; return; }
    try {
      const j = await (await api("/api/ai/pending")).json();
      const items = (j && j.items) || [];
      box.innerHTML = items.length ? `<div class="cai-pend"><b>待生效的修改</b>${items.map((it) => `<div class="row"><span>${esc(it.proposals.map((p) => p.summary).join("；"))} · ${new Date(it.dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 生效</span><button class="cai-x" data-act="cancel" data-id="${esc(it.id)}">撤销</button></div>`).join("")}</div>` : "";
    } catch (e) { box.innerHTML = ""; }
  }
  async function cancelPending(id) {
    try { await api(`/api/ai/pending?id=${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) {}
    loadPending();
  }

  function close() { if (root) root.style.display = "none"; document.body.style.overflow = ""; }
  function open() {
    hooks.ensureAuth(async () => {
      if (!root) { root = build(); document.body.appendChild(root); }
      root.style.display = "";
      document.body.style.overflow = "hidden";
      if (!cfg || !cfg.enabled) {
        try { cfg = await (await api("/api/ai/config")).json(); } catch (e) { cfg = { enabled: false, error: e.message }; }
      }
      if (!cfg.enabled) { $(".cai-body").innerHTML = `<div class="cai-empty">${esc(cfg.error || "服务器还没有配置 AI。在 .env 里设置 AI_PROVIDER / AI_API_KEY（见 README「AI 顾问」）后重启。")}</div>`; return; }
      render();
      loadPending();
    });
  }
  // 页面加载时问一次服务端是否启用了 AI, 用来决定显示不显示入口按钮
  async function available() {
    try { const r = await api("/api/ai/config"); if (!r.ok) return false; cfg = await r.json(); return !!cfg.enabled; } catch (e) { return false; }
  }
  window.CalmAI = { init(h) { hooks = { ...hooks, ...h }; }, open, close, available };
})();
