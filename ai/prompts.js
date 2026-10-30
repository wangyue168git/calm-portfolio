"use strict";
// AI 的立场和输出格式。和产品理念一致: 按自己的规则长期投资, 不预测、不择时、不鼓励频繁改规则。
const { validateRule, validateAllocation, describeRule, currentAllocation, ALLOC_FIELDS, SYMBOL_RE } = require("../plan-edit");

const SYSTEM_PROMPT = `你是「冷静持仓」看板里的投资纪律助手。用户用这个看板按自己写下的规则长期投资，不想天天盯盘。你的工作是帮用户看清自己的持仓和规则，而不是替用户做交易决定。

原则：
- 不预测短期涨跌，不给买卖时点，不推荐具体买哪只新股票。用户问"现在该不该买/卖"，就回到他的规则：规则怎么说、为什么这么说。
- 只依据下面「当前数据」里的事实。数字以数据为准，不要自己重新计算占比；需要推算时写清楚怎么算的。数据里没有的信息（比如最新新闻、财报）就直说不知道。
- 区分事实和看法。指出问题时说明它为什么重要、代价是什么。
- 用户自己的规则优先。可以指出规则之间的矛盾、遗漏、和实际持仓不一致的地方；建议改规则时要说明理由和代价，并提醒改规则宜慢不宜快，不要因为最近的涨跌改规则。
- 常见要看的点：结构是否偏离目标、单只或单一主题是否过度集中、个股和指数是否重复暴露（比如个股本身是纳指/标普的大权重成分股）、持有但没写规则的标的、观察仓是否超限。
- 用中文，简洁，先说结论；用短段落和列表，不要长篇大论。
- 结尾不需要每次都加免责声明（页面上已经有了）。

修改建议的格式：
只有当用户明确想调整规则，或你发现明显值得改的地方时，才在回答最后附一个代码块，语言标记写 calm-proposals，内容是 JSON 数组，最多 5 条。用户会逐条确认，确认前什么都不会改。可用的两种：
1. 单只标的规则：{"kind":"symbol","symbol":"AAPL","rule":{"type":"band","openBelowPct":8,"sealAtPct":10,"targetShares":20},"why":"一句话理由"}
   - type 只能是 open（一直可加）、seal（一直封仓）、band（看占比：低于 openBelowPct 可加，到 sealAtPct 封仓，targetShares 可选，买够即封）
   - rule 为 null 表示删除这条规则
   - 溢价、境外这类特殊规则不要改
2. 结构目标：{"kind":"allocation","indexTargetPct":60,"stockCapPct":30,"why":"一句话理由"}
   - 可用字段：indexTargetPct（指数下限）、stockCapPct（个股合计上限）、singleCapPct（单只个股默认上限）、observationCapPct（观察仓合计上限），只写要改的
代码块之外照常用文字解释。没有建议就不要附代码块。`;

const CHECKUP_PROMPT = "请给我的持仓做一次体检，按这几部分简要说：1) 结构：和目标比偏离多少；2) 集中度和重复暴露；3) 规则：有没有遗漏、矛盾、或和实际持仓对不上的；4) 最值得注意的 1–3 件事。如果有明显值得改的规则，按约定格式附上修改建议。";

function buildSystem(contextText) {
  return `${SYSTEM_PROMPT}\n\n# 当前数据\n${contextText}`;
}

// 从回答里取出 calm-proposals 代码块, 逐条校验, 附上「改前 → 改后」描述; 无效的丢掉
function extractProposals(text, plan) {
  const m = [...String(text || "").matchAll(/```calm-proposals\s*([\s\S]*?)```/g)].pop();
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return []; }
  return validateProposals(Array.isArray(arr) ? arr : [arr], plan);
}

// 校验一组建议(模型给的、或页面回传要应用的), 附上「改前 → 改后」描述; 无效的、和现状一样的丢掉
function validateProposals(arr, plan) {
  const out = [];
  const rules = ((plan && plan.channels) || {}).symbols || {};
  for (const p of arr.slice(0, 5)) {
    if (!p || typeof p !== "object") continue;
    const why = String(p.why || "").slice(0, 200);
    if (p.kind === "symbol") {
      const sym = String(p.symbol || "").trim().toUpperCase();
      if (!SYMBOL_RE.test(sym)) continue;
      const prev = rules[sym] || null;
      if (prev && !["open", "seal", "band"].includes(prev.type)) continue;
      const v = validateRule(p.rule === undefined ? null : p.rule);
      if (v.error) continue;
      const before = describeRule(prev), after = describeRule(v.rule);
      if (before === after) continue;
      out.push({ kind: "symbol", symbol: sym, rule: v.rule, why, summary: `${sym}：${before} → ${after}` });
    } else if (p.kind === "allocation") {
      const v = validateAllocation(p.change || p);
      if (v.error) continue;
      const cur = currentAllocation(plan || {});
      const parts = Object.entries(v.change).filter(([k, n]) => cur[k] !== n).map(([k, n]) => `${ALLOC_FIELDS[k]} ${cur[k] ?? "未设"}% → ${n}%`);
      if (!parts.length) continue;
      out.push({ kind: "allocation", change: v.change, why, summary: parts.join("；") });
    }
  }
  return out;
}

module.exports = { SYSTEM_PROMPT, CHECKUP_PROMPT, buildSystem, extractProposals, validateProposals };
