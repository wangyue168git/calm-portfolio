"use strict";
// 给 AI 的"当前数据": 数字全部在这里算好(占比、偏离、离目标还差多少、可加/封仓及原因), AI 只负责解读, 不让它自己算。
// anonymize=true(默认, "只发比例"): 不发总资产、金额、股数、成本价, 只发占比、盈亏%、目标完成度。
const { classifyPieGroup, classifyAllocationBucket, evaluateChannel, configureGroups } = require("../classify");
const { describeRule, currentAllocation } = require("../plan-edit");

const NON_STOCK_GROUPS = new Set(["纳指指数类", "标普", "加密资产", "其他"]);
const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : "—");
const fmtCny = (n) => `¥${Math.round(n).toLocaleString("en-US")}`;
const fmtCap = (n) => (n === null || n === undefined ? "未设" : `${n}%`);
// 只发比例时, 把判断说明里的股数、金额换成完成度(规则说明是用户自己写的文字, 预览里能看到)
function scrubAmounts(s) {
  return String(s || "")
    .replace(/已买够 [\d.]+\/[\d.]+ 股/g, "已买够目标股数")
    .replace(/([\d.]+)\/([\d.]+) 股，还差 [\d.]+ 股/g, (_, a, b) => `目标股数完成 ${Math.round((a / b) * 100)}%`)
    .replace(/境外托管 ([$¥])([\d.]+)万 \/ [$¥]([\d.]+)万/g, (_, c, a, b) => `境外托管完成 ${Math.round((a / b) * 100)}%`)
    .replace(/、目标 [\d.]+ 股/g, "、设了目标股数");
}

function buildAiContext(data, plan, { anonymize = true, now = new Date() } = {}) {
  plan = plan || {};
  if (typeof configureGroups === "function") configureGroups(plan.groups);
  const ch = plan.channels || {};
  const symRules = ch.symbols || {};
  const rate = Number((data && (data.rateInfo || data.exchangeRate) || {}).USD_CNY) || 7;
  const mul = (cur) => (cur === "USD" ? rate : cur === "HKD" ? rate / 7.8 : 1);

  // ---- 汇总每只持仓(同一代码跨账户合并) ----
  let total = 0, cash = 0;
  const bySym = new Map();
  ((data && data.accounts) || []).forEach((acc) => {
    const m = mul(acc.currency || "CNY");
    cash += (Number(acc.cash) || 0) * m;
    (acc.holdings || []).forEach((h) => {
      const v = ((Number(h.marketValue) || 0) + (Number(h.pendingAmount) || 0)) * m;
      if (!(v > 0) && !(h.shares > 0)) return;
      const key = String(h.symbol || "").toUpperCase();
      const x = bySym.get(key) || { h, symbol: key, name: h.name || key, valueCNY: 0, costCNY: 0, shares: 0, price: h.currentPrice || 0, currency: acc.currency || "CNY" };
      x.valueCNY += v; x.costCNY += (Number(h.costPrice) || 0) * (Number(h.shares) || 0) * m; x.shares += Number(h.shares) || 0;
      bySym.set(key, x);
    });
  });
  const rows = [...bySym.values()];
  total = rows.reduce((s, x) => s + x.valueCNY, 0) + cash;
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);

  rows.forEach((x) => {
    x.weight = pct(x.valueCNY);
    x.rule = symRules[x.symbol] || null;
    x.group = classifyPieGroup(x.h, x.weight, x.rule);
    x.bucket = classifyAllocationBucket(x.h);
    x.isStock = !NON_STOCK_GROUPS.has(x.group);
    x.pnlPct = x.costCNY > 0 ? ((x.valueCNY - x.costCNY) / x.costCNY) * 100 : null;
  });
  const sumBy = (f) => rows.filter(f).reduce((s, x) => s + x.valueCNY, 0);
  const nasdaq = pct(sumBy((x) => x.bucket === "纳指指数类"));
  const sp = pct(sumBy((x) => x.bucket === "标普"));
  const stock = pct(sumBy((x) => x.isStock));
  const observation = pct(sumBy((x) => x.group === "观察仓"));
  const crypto = pct(sumBy((x) => x.bucket === "加密资产"));
  const cashPct = pct(cash);

  // ---- 可加/封仓(与页面同一套判断) ----
  const offAcc = new Set(ch.offshoreAccounts || []);
  const offshoreCNY = ((data && data.accounts) || []).filter((a) => offAcc.has(a.name))
    .reduce((s, a) => s + (a.holdings || []).filter((h) => h.market !== "crypto").reduce((t, h) => t + (Number(h.marketValue) || 0) * mul(a.currency || "CNY"), 0), 0);
  rows.forEach((x) => {
    const r = evaluateChannel(ch, x.symbol, { weightPct: x.weight, stockPct: stock, offshoreCNY, usdCny: rate, price: x.price, iopv: x.h.iopv || 0, shares: x.shares });
    x.channel = r ? `${r.label}（${anonymize ? scrubAmounts(r.why) : r.why}）` : "—";
  });

  const alloc = currentAllocation(plan);
  const L = [];
  L.push(`数据时间：${(data && data.timestamp) || now.toISOString()}`);
  L.push(anonymize ? "（用户选择只发比例：没有金额、股数和成本价）" : `总资产：${fmtCny(total)}；现金 ${fmtCny(cash)}`);
  L.push("");
  L.push("## 结构（占总资产，含现金）");
  L.push(`- 指数合计 ${fmtPct(nasdaq + sp)}（纳指 ${fmtPct(nasdaq)} + 标普 ${fmtPct(sp)}）；目标下限 ${fmtCap(alloc.indexTargetPct)}`);
  L.push(`- 个股合计 ${fmtPct(stock)}；上限 ${fmtCap(alloc.stockCapPct)}；单只默认上限 ${fmtCap(alloc.singleCapPct)}`);
  L.push(`- 其中观察仓（占比<5% 且没设建仓规则的小仓个股）${fmtPct(observation)}；观察仓合计上限 ${fmtCap(alloc.observationCapPct)}`);
  L.push(`- 加密 ${fmtPct(crypto)}；现金 ${fmtPct(cashPct)}`);
  L.push("");
  L.push("## 持仓（按占比从高到低）");
  rows.sort((a, b) => b.weight - a.weight).forEach((x) => {
    const parts = [`${x.symbol} ${x.name !== x.symbol ? x.name : ""}`.trim(), `分组 ${x.group === x.name ? "个股" : x.group}`, `占比 ${fmtPct(x.weight)}`];
    if (x.pnlPct !== null) parts.push(`浮盈亏 ${x.pnlPct >= 0 ? "+" : ""}${x.pnlPct.toFixed(1)}%`);
    if (!anonymize) parts.push(`${+x.shares.toFixed(4)} 股`, `市值 ${fmtCny(x.valueCNY)}`);
    const ruleText = x.rule ? (anonymize ? scrubAmounts(describeRule(x.rule)) : describeRule(x.rule)) : "";
    parts.push(`规则：${x.rule ? ruleText + (x.rule.type === "premium" ? `（溢价 ≤${x.rule.maxPremiumPct}%）` : "") : "未写（按默认 " + (ch.default === "open" ? "可加" : "封仓") + "）"}`);
    if (x.rule && x.rule.targetShares) parts.push(`目标股数完成 ${Math.min(999, (x.shares / x.rule.targetShares) * 100).toFixed(0)}%`);
    parts.push(`当前：${x.channel}`);
    if (x.rule && x.rule.why) parts.push(`规则说明：${x.rule.why}`);
    L.push(`- ${parts.join("；")}`);
  });
  const noRule = rows.filter((x) => !x.rule).map((x) => x.symbol);
  const unheld = Object.keys(symRules).filter((s) => !bySym.has(s));
  L.push("");
  L.push("## 规则覆盖");
  L.push(`- 持有但没写规则：${noRule.length ? noRule.join("、") : "无"}`);
  L.push(`- 写了规则但没持有：${unheld.length ? unheld.map((s) => `${s}（${anonymize ? scrubAmounts(describeRule(symRules[s])) : describeRule(symRules[s])}）`).join("、") : "无"}`);
  const ip = ch.indexPlan || {};
  if (ip.symbols) L.push(anonymize
    ? `- 每月指数定投：${ip.symbols.join("/")} 任选，设了每月目标金额`
    : `- 每月指数定投：${ip.symbols.join("/")} 任选，目标 ¥${ip.monthlyCNY || "?"}/月，买够 ¥${ip.passCNY || "?"} 算完成`);
  const creed = plan.creed && Array.isArray(plan.creed.lines) ? plan.creed.lines : [];
  if (creed.length || plan.rules) {
    L.push("");
    L.push("## 用户自己写的原则");
    creed.forEach((c) => L.push(`- ${c}`));
    Object.entries(plan.rules || {}).filter(([k]) => !k.startsWith("_")).forEach(([k, v]) => L.push(`- ${k}：${v}`));
  }
  const log = Array.isArray(plan.changelog) ? plan.changelog.slice(-5) : [];
  if (log.length) {
    L.push("");
    L.push("## 最近的规则修改");
    log.forEach((e) => L.push(`- ${e.version || ""}：${(e.changes || []).join("；")}${e.reason ? `（理由：${e.reason}）` : ""}`));
  }
  return { text: L.join("\n"), facts: { total, stockPct: stock, indexPct: nasdaq + sp, observationPct: observation, holdings: rows.length } };
}

module.exports = { buildAiContext };
