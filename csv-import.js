// ===== CSV 导入持仓(任何券商都能用的兜底) =====
// 券商 App / 网页基本都能导出"持仓"表格; 另存为 CSV 后在电脑版「导入 CSV」里选文件即可。
// 列名自动识别(中英文常见叫法), 识别不了可以在页面上手动选列。浏览器和 server.js 共用这一个文件。
// 写入规则与自动同步一致: 只对"股数或成本有变化"的持仓追加一条 sync 记录(备注 CSV 导入), 不删任何持仓。
(function (root) {
  "use strict";

  // 识别列名: 统一去空格/括号内容/大小写后比较
  const ALIASES = {
    symbol: ["代码", "证券代码", "股票代码", "代號", "证券代号", "symbol", "ticker", "code", "stockcode"],
    name: ["名称", "证券名称", "股票名称", "名稱", "name", "description", "stockname", "security"],
    qty: ["数量", "持仓数量", "股票余额", "持有数量", "当前持仓", "股数", "持股数", "实际数量", "持仓", "quantity", "position", "shares", "qty", "units"],
    cost: ["成本价", "摊薄成本价", "持仓成本价", "参考成本价", "买入均价", "平均成本", "成本均价", "均价", "成本", "averagecost", "avgcost", "costbasisprice", "costprice", "averageprice", "avgprice", "cost"],
  };
  const norm = (h) => String(h || "").replace(/[（(].*?[)）]/g, "").replace(/[\s_\-:：]/g, "").toLowerCase();

  // 简单 CSV 解析: 支持引号、逗号/制表符/分号分隔、BOM、\r\n
  function parseCsv(text) {
    text = String(text || "").replace(/^﻿/, "");
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "";
    const delim = [",", "\t", ";"].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()));
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()));
    return rows;
  }

  // 在前几行里找表头(有些券商导出的文件前面有几行说明); 返回 { headerRow, columns: { symbol, name, qty, cost } }(列下标, 找不到为 -1)
  function detectColumns(rows) {
    let best = { headerRow: 0, columns: { symbol: -1, name: -1, qty: -1, cost: -1 }, score: -1 };
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const hs = rows[r].map(norm);
      const columns = {};
      Object.keys(ALIASES).forEach((k) => {
        let idx = -1;
        for (const a of ALIASES[k]) { idx = hs.findIndex((h) => h === norm(a)); if (idx >= 0) break; }
        if (idx < 0) for (const a of ALIASES[k]) { idx = hs.findIndex((h) => h && h.includes(norm(a))); if (idx >= 0) break; }
        columns[k] = idx;
      });
      const score = Object.values(columns).filter((x) => x >= 0).length;
      if (score > best.score) best = { headerRow: r, columns, score };
    }
    return { headerRow: best.headerRow, columns: best.columns };
  }

  const toNum = (v) => { const n = parseFloat(String(v || "").replace(/[,，\s$¥￥]|HK\$/g, "")); return Number.isFinite(n) ? n : NaN; };
  // 按列下标取出持仓行; 代码统一大写、去掉 "SH600519"/"600519.SH"/"AAPL.US" 这类前后缀
  function extractRows(rows, headerRow, columns) {
    const out = [];
    rows.slice(headerRow + 1).forEach((r) => {
      let sym = String(r[columns.symbol] || "").trim().toUpperCase().replace(/^="?|"$/g, "");
      sym = sym.replace(/^(SH|SZ|HK)(?=\d)/, "").replace(/\.(US|HK|SH|SZ|SS)$/, "");
      const qty = toNum(r[columns.qty]), cost = toNum(r[columns.cost]);
      if (!sym || !/^[A-Z0-9.\-]{1,15}$/.test(sym) || !(qty > 0) || !(cost >= 0)) return;
      out.push({ symbol: sym, name: columns.name >= 0 ? String(r[columns.name] || "").trim() : "", qty, cost });
    });
    return out;
  }

  // 纯函数: 算出导入计划(预览用), 不改 portfolio
  //   currency: 账户币种, 用来给新持仓猜市场(USD→美股, HKD→港股并补零到 5 位, CNY→6/5/9 开头沪市、其余深市)
  function planImport(account, rows) {
    const cur = (account && account.currency) || "CNY";
    const holdings = (account && account.holdings) || [];
    const fix = (sym) => (cur === "HKD" && /^\d{1,5}$/.test(sym) ? sym.padStart(5, "0") : sym);
    const marketOf = (sym) => cur === "USD" ? "nasdaq" : cur === "HKD" ? "hk" : (["6", "5", "9"].includes(sym[0]) ? "sh" : "sz");
    const seen = new Set();
    const items = rows.map((x) => {
      const symbol = fix(x.symbol);
      seen.add(symbol);
      const h = holdings.find((y) => String(y.symbol).toUpperCase() === symbol);
      if (!h) return { status: "new", symbol, name: x.name || symbol, market: marketOf(symbol), qty: x.qty, cost: x.cost };
      const same = Math.abs((h.shares || 0) - x.qty) <= 1e-6 && Math.abs((h.costPrice || 0) - x.cost) <= Math.max(1e-4, x.cost * 5e-4);
      return { status: same ? "same" : "update", symbol, name: h.name || x.name || symbol, qty: x.qty, cost: x.cost, oldQty: h.shares, oldCost: h.costPrice };
    });
    const missing = holdings.filter((h) => !seen.has(String(h.symbol).toUpperCase()) && (h.shares || 0) > 0)
      .map((h) => ({ status: "missing", symbol: h.symbol, name: h.name || h.symbol, oldQty: h.shares, oldCost: h.costPrice }));
    return [...items, ...missing];
  }

  const api = { parseCsv, detectColumns, extractRows, planImport, ALIASES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CsvImport = api;
})(typeof window !== "undefined" ? window : globalThis);
