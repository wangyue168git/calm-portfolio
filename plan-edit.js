"use strict";
// 改 plan.json 的公共逻辑(页面改规则、AI 建议都走这里): 校验 → 修改 → 有变化就记一条 changelog。纯函数, 不做 IO。

const SYMBOL_RE = /^[A-Z0-9.\-]{1,15}$/;

// 单只标的规则: 只允许 open / seal / band(溢价、境外这类特殊规则只能手改文件); null = 删除
function validateRule(r) {
  if (r === null || r === undefined) return { rule: null };
  const type = String(r.type || "");
  if (!["open", "seal", "band"].includes(type)) return { error: "规则类型只能是 open / seal / band" };
  const rule = { type };
  if (type === "band") {
    const lo = Number(r.openBelowPct), hi = Number(r.sealAtPct);
    if (!(lo >= 0 && lo <= 100 && hi > 0 && hi <= 100 && lo <= hi)) return { error: "占比需在 0–100 之间, 且「可加」不高于「封仓」" };
    rule.openBelowPct = lo; rule.sealAtPct = hi;
    if (r.targetShares !== undefined && r.targetShares !== null && r.targetShares !== "") {
      const t = Number(r.targetShares);
      if (!(t > 0)) return { error: "目标股数需大于 0" };
      rule.targetShares = t;
    }
  }
  if (r.why) rule.why = String(r.why).slice(0, 200);
  return { rule };
}

function describeRule(x) {
  if (!x) return "未设（按默认）";
  if (x.type === "open") return "一直可加";
  if (x.type === "seal") return "一直封仓";
  if (x.type === "band") return `${x.openBelowPct}% 以下可加、${x.sealAtPct}% 封仓${x.targetShares ? `、目标 ${x.targetShares} 股` : ""}`;
  if (x.type === "premium") return "看场内溢价";
  if (x.type === "offshore") return "境外账户到目标额后封仓";
  return x.type;
}

function pushChangelog(plan, change, reason, source) {
  plan.changelog = Array.isArray(plan.changelog) ? plan.changelog : [];
  const now = new Date();
  plan.changelog.push({
    version: `${source === "ai" ? "AI" : "页面"}-${now.toISOString().slice(0, 10)}`, date: now.toISOString(),
    changes: [change], reason: String(reason || "").trim().slice(0, 200), ...(source === "ai" ? { source: "ai" } : {}), objections: [],
  });
}

// 改单只标的规则; 返回 { changed, before, after } 或 { error }。plan 会被就地修改
function applySymbolRule(plan, symbol, rawRule, { reason = "", source = "page" } = {}) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!SYMBOL_RE.test(sym)) return { error: "标的代码不合法" };
  const v = validateRule(rawRule);
  if (v.error) return { error: v.error };
  plan.channels = plan.channels || {};
  plan.channels.symbols = plan.channels.symbols || {};
  const prev = plan.channels.symbols[sym] || null;
  if (prev && !["open", "seal", "band"].includes(prev.type)) return { error: `${sym} 用的是「${prev.type}」规则, 只能在 plan.json 里改` };
  if (v.rule) plan.channels.symbols[sym] = v.rule; else delete plan.channels.symbols[sym];
  const before = describeRule(prev), after = describeRule(v.rule);
  if (before !== after) pushChangelog(plan, `${sym}：${before} → ${after}`, reason, source);
  return { changed: before !== after, symbol: sym, rule: v.rule, before, after };
}

// 结构目标: 指数下限 / 个股合计上限 / 单只默认上限 / 观察仓合计上限(都是百分比)
const ALLOC_FIELDS = {
  indexTargetPct: "指数下限",
  stockCapPct: "个股合计上限",
  singleCapPct: "单只个股默认上限",
  observationCapPct: "观察仓合计上限",
};
function currentAllocation(plan) {
  const ta = plan.targetAllocation || {}, ch = plan.channels || {};
  return {
    indexTargetPct: ta.indexTargetPct ?? ta.indexTarget ?? null,
    stockCapPct: ta.stockCapPct ?? ch.stockBucketCapPct ?? null,
    singleCapPct: ta.singleCapPct ?? null,
    observationCapPct: ch.observationCapPct ?? null,
  };
}
function validateAllocation(change) {
  const out = {};
  for (const k of Object.keys(ALLOC_FIELDS)) {
    if (change[k] === undefined || change[k] === null || change[k] === "") continue;
    const n = Number(change[k]);
    if (!(n >= 0 && n <= 100)) return { error: `${ALLOC_FIELDS[k]}需在 0–100 之间` };
    out[k] = n;
  }
  if (!Object.keys(out).length) return { error: "没有要改的结构目标" };
  return { change: out };
}
function applyAllocation(plan, rawChange, { reason = "", source = "page" } = {}) {
  const v = validateAllocation(rawChange || {});
  if (v.error) return { error: v.error };
  const cur = currentAllocation(plan);
  plan.targetAllocation = plan.targetAllocation || {};
  plan.channels = plan.channels || {};
  const parts = [];
  Object.entries(v.change).forEach(([k, n]) => {
    if (cur[k] === n) return;
    if (k === "observationCapPct") plan.channels.observationCapPct = n;
    else plan.targetAllocation[k] = n;
    if (k === "stockCapPct") plan.channels.stockBucketCapPct = n;   // 纪律页和「可加/封仓」签用同一个上限
    if (k === "indexTargetPct" && plan.targetAllocation.indexTarget !== undefined) plan.targetAllocation.indexTarget = n;
    parts.push(`${ALLOC_FIELDS[k]} ${cur[k] ?? "未设"}% → ${n}%`);
  });
  if (parts.length) pushChangelog(plan, parts.join("；"), reason, source);
  return { changed: parts.length > 0, summary: parts.join("；") };
}

module.exports = { validateRule, describeRule, applySymbolRule, validateAllocation, applyAllocation, currentAllocation, ALLOC_FIELDS, SYMBOL_RE };
