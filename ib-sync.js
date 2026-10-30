"use strict";
// ===== IB Flex 自动同步 =====
// 原则: 手动修改永远是兜底, 自动同步只是"代你点一次手动修改"。
//   - 交易确认查询(当天成交, 几分钟延迟): 新成交 → 追加 buy/sell 记录(备注 IB#tradeID)
//   - 活动查询(上一交易日收盘持仓): IB 的股数/成本相对"上次从 IB 拿到的快照"变了 → 追加一条 sync(绝对值)纠偏
//   - 首次运行只记基线、不写持仓; 对比对象是上次 IB 快照, 不是看板当前值 → 用户手改的数在 IB 没有新变化前不会被改回去
//   - 只读: Flex 令牌只能读报表, 本模块不调用任何交易接口
// 令牌/查询编号走环境变量(环境变量 / .env), 不进仓库。

const fs = require("fs");

const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const AUTO_TAG = "IB#";            // 交易确认写入的 note 前缀
const RECON_NOTE = "IB 自动对账";   // 活动查询写入的 sync note
const SEEN_LIMIT = 800;

// ---------- XML 解析(Flex 报表是扁平的自闭合元素, 不引依赖) ----------
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&");
}
function parseElements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\s([^>]*?)\\/?>`, "g");
  let m;
  while ((m = re.exec(String(xml)))) {
    const attrs = {};
    const ar = /([A-Za-z_][\w.-]*)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1]] = decodeXml(a[2]);
    out.push(attrs);
  }
  return out;
}
// 报表对应的日期(FlexStatement 的 toDate, 如 "20261028"); 取不到返回 ""
function statementDate(xml) {
  const m = /<FlexStatement\s[^>]*\btoDate="(\d{8})"/.exec(String(xml));
  return m ? m[1] : "";
}
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(String(xml));
  return m ? decodeXml(m[1].trim()) : "";
}

// IB 的 dateTime 是美东时间, 格式随报表设置: 20261027;143012 /;14:30:12 / 20261027 143012 ...
function nyOffsetMinutes(utcMs) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs)).forEach((p) => { if (p.type !== "literal") parts[p.type] = +p.value; });
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}
function parseIbDateTime(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length < 8) return null;
  const y = +d.slice(0, 4), mo = +d.slice(4, 6), da = +d.slice(6, 8);
  const h = d.length >= 10 ? +d.slice(8, 10) : 12, mi = d.length >= 12 ? +d.slice(10, 12) : 0, se = d.length >= 14 ? +d.slice(12, 14) : 0;
  const naive = Date.UTC(y, mo - 1, da, h, mi, se);
  if (!Number.isFinite(naive)) return null;
  // 两次迭代处理夏令时边界
  let utc = naive - nyOffsetMinutes(naive) * 60000;
  utc = naive - nyOffsetMinutes(utc) * 60000;
  return new Date(utc);
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };

function normalizeConfirm(a) {
  const qty = Math.abs(num(a.quantity));
  const price = num(a.tradePrice !== undefined ? a.tradePrice : a.price);
  const commission = Math.abs(num(a.ibCommission !== undefined ? a.ibCommission : a.commission)) || 0;
  const side = String(a.buySell || "").toUpperCase().startsWith("S") ? "sell" : "buy";
  const id = a.tradeID || a.execID || a.ibExecID || a.transactionID || "";
  const date = parseIbDateTime(a.dateTime || a.tradeDate);
  return {
    id: String(id), symbol: String(a.symbol || "").trim(), conid: String(a.conid || ""),
    assetCategory: String(a.assetCategory || "STK").toUpperCase(), currency: a.currency || "USD",
    side, qty, price, commission, date,
  };
}
function normalizePosition(a) {
  return {
    symbol: String(a.symbol || "").trim(), conid: String(a.conid || a.symbol || ""),
    assetCategory: String(a.assetCategory || "STK").toUpperCase(), currency: a.currency || "USD",
    qty: num(a.position), cost: num(a.costBasisPrice), level: String(a.levelOfDetail || "SUMMARY").toUpperCase(),
  };
}

function parseConfirms(xml) {
  // 交易确认查询的元素是 TradeConfirm; 兼容活动查询里的 Trade(只取逐笔 EXECUTION)
  const rows = [...parseElements(xml, "TradeConfirm"), ...parseElements(xml, "Trade").filter((t) => !t.levelOfDetail || /EXECUTION/i.test(t.levelOfDetail))];
  return rows.map(normalizeConfirm)
    .filter((c) => c.id && c.symbol && c.assetCategory === "STK" && c.qty > 0 && c.price > 0 && c.date);
}
function parsePositions(xml) {
  return parseElements(xml, "OpenPosition").map(normalizePosition)
    .filter((p) => p.symbol && p.assetCategory === "STK" && p.level !== "LOT" && Number.isFinite(p.qty) && p.qty > 0 && p.cost > 0);
}

// IB Flex 常见错误码 → 中文(状态行直接显示)
const IB_ERRORS = {
  "1012": "IB 令牌已过期, 请在 IB 后台重新生成",
  "1013": "IP 不在令牌允许范围内",
  "1014": "查询编号无效",
  "1015": "IB 令牌无效",
  "1018": "请求太频繁被 IB 限流, 稍后自动重试",
  "1019": "IB 报表生成中",
  "1020": "请求无效",
};
// 需要人处理的错误(重试没用): 令牌过期/IP/查询编号/令牌无效/请求无效; 其余(限流/生成中/网络)视为临时
const HARD_CODES = new Set(["1012", "1013", "1014", "1015", "1020"]);
function ibError(stage, xml) {
  const code = tagText(xml, "ErrorCode");
  const zh = IB_ERRORS[code];
  const e = new Error(zh ? `${zh}(${code})` : `IB ${stage} ${code || "?"}: ${tagText(xml, "ErrorMessage") || "失败"}`);
  e.ibCode = code; e.hard = HARD_CODES.has(code);
  return e;
}

// ---------- Flex Web Service 两段式请求 ----------
// fetchText(url) → Promise<string>; 1019 = 报表生成中, 等一下再取
async function fetchFlexStatement(fetchText, token, queryId, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 6 } = {}) {
  const sendXml = await fetchText(`${FLEX_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
  if (tagText(sendXml, "Status") !== "Success") {
    throw ibError("SendRequest", sendXml);
  }
  const ref = tagText(sendXml, "ReferenceCode");
  // IB 回给的取报表地址(常是 gdcdyn)在部分国内网络连不上, 固定走 ndcdyn, 同一令牌/参考号通用
  const base = `${FLEX_BASE}/GetStatement`;
  for (let i = 0; i <= retries; i++) {
    const xml = await fetchText(`${base}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(ref)}&v=3`);
    if (/<FlexQueryResponse/.test(xml)) return xml;
    const code = tagText(xml, "ErrorCode");
    if ((code === "1019" || code === "1018") && i < retries) { await sleep(code === "1018" ? 10000 : 5000); continue; }
    throw ibError("GetStatement", xml);
  }
  throw new Error("IB GetStatement 超过重试次数");
}

// ---------- 状态文件 ----------
function emptyState() {
  return { positions: null, seen: [], confirmsBaseline: false, lastConfirms: null, lastPositions: null, lastPositionsDay: "" };
}
function loadState(file) {
  try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return emptyState(); }
}
function saveState(file, state) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

// ---------- 纯函数: 把 IB 数据套到 portfolio 上 ----------
function findAccount(portfolio, accountName) {
  return (portfolio.accounts || []).findIndex((a) => a && a.name === accountName);
}
function findHolding(account, symbol) {
  return (account.holdings || []).findIndex((h) => h && String(h.symbol).toUpperCase() === symbol.toUpperCase());
}
const isAutoTx = (t) => t && typeof t.note === "string" && (t.note.startsWith(AUTO_TAG) || t.note.startsWith(RECON_NOTE));

// 场外加数: 看板某只股票 = IB 股数 + IB 之外的部分(比如在别的平台持有的同一标的)。
// 配置 "AAPL:4:150.5,XYZ:1:10" → { AAPL: { qty: 4, cost: 150.5 } }; 场外部分并入 IB 后要删掉, 否则重复算
function parseExtras(spec) {
  const out = {};
  String(spec || "").split(",").map((x) => x.trim()).filter(Boolean).forEach((item) => {
    const [sym, q, c] = item.split(":").map((x) => x.trim());
    const qty = num(q), cost = num(c);
    if (sym && qty > 0 && cost > 0) out[sym.toUpperCase()] = { qty, cost };
  });
  return out;
}
// IB 持仓 + 场外部分 → 看板应有的股数/加权成本
function withExtra(x, extras) {
  const e = extras && extras[x.symbol.toUpperCase()];
  if (!e) return { qty: x.qty, cost: x.cost, extraQty: 0 };
  const qty = x.qty + e.qty;
  return { qty, cost: (x.qty * x.cost + e.qty * e.cost) / qty, extraQty: e.qty };
}

// 返回 { portfolio, state, actions[] }; 不做 IO。appendTrade = server.js 的 appendTradeToHolding
function applyConfirms(portfolio, state, confirms, { accountName, appendTrade }) {
  const seen = new Set(state.seen || []);
  const actions = [];
  if (!state.confirmsBaseline) {
    confirms.forEach((c) => seen.add(c.id));
    return { portfolio, state: { ...state, seen: [...seen].slice(-SEEN_LIMIT), confirmsBaseline: true }, actions: [{ kind: "baseline", count: confirms.length }] };
  }
  const ai = findAccount(portfolio, accountName);
  if (ai < 0) throw new Error(`找不到账户「${accountName}」`);
  const p = { ...portfolio, accounts: portfolio.accounts.slice() };
  const acc = { ...p.accounts[ai], holdings: (p.accounts[ai].holdings || []).slice() };
  p.accounts[ai] = acc;
  confirms.slice().sort((a, b) => a.date - b.date).forEach((c) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    let hi = findHolding(acc, c.symbol);
    if (hi >= 0) {
      // 用户已手动记过(成交之后有非自动的记录) → 不重复记
      const manualAfter = (acc.holdings[hi].transactions || []).some((t) => !isAutoTx(t) && t.date && new Date(t.date) >= c.date);
      if (manualAfter) { actions.push({ kind: "skip-manual", symbol: c.symbol, id: c.id }); return; }
    } else if (c.side === "buy") {
      acc.holdings.push({ symbol: c.symbol, market: "nasdaq", name: c.symbol, transactions: [] });
      hi = acc.holdings.length - 1;
      actions.push({ kind: "new-holding", symbol: c.symbol });
    } else { actions.push({ kind: "skip-unknown-sell", symbol: c.symbol, id: c.id }); return; }
    // 成本含佣金: 买入每股加佣金, 卖出每股减佣金
    const perShareFee = c.qty > 0 ? c.commission / c.qty : 0;
    const price = c.side === "buy" ? c.price + perShareFee : Math.max(0, c.price - perShareFee);
    try {
      acc.holdings[hi] = appendTrade(acc.holdings[hi], { type: c.side, shares: c.qty, price, date: c.date.toISOString(), note: `${AUTO_TAG}${c.id}` });
      actions.push({ kind: c.side, symbol: c.symbol, qty: c.qty, price: +price.toFixed(4), id: c.id });
    } catch (e) { actions.push({ kind: "error", symbol: c.symbol, id: c.id, msg: e.message }); }
  });
  return { portfolio: p, state: { ...state, seen: [...seen].slice(-SEEN_LIMIT) }, actions };
}

function applyPositions(portfolio, state, positions, { accountName, appendTrade, extras = {}, now = new Date() }) {
  const snap = {};
  positions.forEach((x) => { snap[x.conid] = { symbol: x.symbol, qty: x.qty, cost: x.cost }; });
  const actions = [];
  const ai = findAccount(portfolio, accountName);
  if (ai < 0) throw new Error(`找不到账户「${accountName}」`);
  const acc0 = portfolio.accounts[ai];
  // 对照表(只读): IB vs 看板, 供页面/排查看
  const diff = positions.map((x) => {
    const hi = findHolding(acc0, x.symbol);
    const h = hi >= 0 ? acc0.holdings[hi] : null;
    const w = withExtra(x, extras);
    return { symbol: x.symbol, ibQty: x.qty, ibCost: x.cost, ...(w.extraQty ? { extraQty: w.extraQty } : {}), boardQty: h ? h.shares : null, boardCost: h ? h.costPrice : null };
  });
  if (!state.positions) {
    return { portfolio, state: { ...state, positions: snap }, actions: [{ kind: "baseline", count: positions.length }], diff };
  }
  const p = { ...portfolio, accounts: portfolio.accounts.slice() };
  const acc = { ...acc0, holdings: (acc0.holdings || []).slice() };
  p.accounts[ai] = acc;
  positions.forEach((x) => {
    const prev = state.positions[x.conid];
    const changed = !prev || Math.abs(prev.qty - x.qty) > 1e-6 || Math.abs(prev.cost - x.cost) > Math.max(1e-6, x.cost * 1e-4);
    if (!changed) return;                          // IB 没变 → 尊重看板(含用户手改)
    const w = withExtra(x, extras);                // 看板应有 = IB + 场外部分
    let hi = findHolding(acc, x.symbol);
    if (hi >= 0) {
      const h = acc.holdings[hi];
      if (Math.abs((h.shares || 0) - w.qty) <= 1e-6 && Math.abs((h.costPrice || 0) - w.cost) <= Math.max(1e-4, w.cost * 5e-4)) return; // 已一致
    } else {
      acc.holdings.push({ symbol: x.symbol, market: "nasdaq", name: x.symbol, transactions: [] });
      hi = acc.holdings.length - 1;
      actions.push({ kind: "new-holding", symbol: x.symbol });
    }
    try {
      const note = w.extraQty ? `${RECON_NOTE}(含场外 ${w.extraQty} 股)` : RECON_NOTE;
      acc.holdings[hi] = appendTrade(acc.holdings[hi], { type: "sync", shares: +w.qty.toFixed(6), price: +w.cost.toFixed(6), date: now.toISOString(), note });
      actions.push({ kind: "sync", symbol: x.symbol, qty: +w.qty.toFixed(6), cost: +w.cost.toFixed(4), ...(w.extraQty ? { extraQty: w.extraQty } : {}) });
    } catch (e) { actions.push({ kind: "error", symbol: x.symbol, msg: e.message }); }
  });
  // IB 里已清仓、看板还有: 不自动删, 只提示(卖出应已由交易确认记过)
  Object.keys(state.positions).forEach((conid) => {
    if (snap[conid]) return;
    const sym = state.positions[conid].symbol;
    const hi = findHolding(acc, sym);
    if (hi >= 0 && acc.holdings[hi].shares > 0) actions.push({ kind: "closed-in-ib", symbol: sym });
  });
  return { portfolio: p, state: { ...state, positions: snap }, actions, diff };
}

// ---------- 运行器(带 IO, server.js 注入依赖) ----------
function createIbSync(deps) {
  const {
    token, positionsQuery, confirmsQuery, accountName = "IB", stateFile, dryRun = false, extras = {}, tokenExpires = "",
    fetchText: rawFetch, loadPortfolio, savePortfolio, appendTrade, log = console.log, minGapMs = 2000,
  } = deps;
  // IB 限 1 次/秒: 任意两次请求至少隔 minGapMs(run 是串行的, 不会并发)
  let lastReqAt = 0;
  const fetchText = async (url) => {
    const wait = lastReqAt + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReqAt = Date.now();
    return rawFetch(url);
  };
  const configured = !!(token && (positionsQuery || confirmsQuery));
  // 场外加数: 环境变量只是初值; 状态文件里有 extrasOverride(含清零后的 {})就以它为准, 重启也不会被初值恢复
  const effectiveExtras = (s) => (s && s.extrasOverride && typeof s.extrasOverride === "object") ? s.extrasOverride : extras;
  let running = null;

  function summarize(actions) {
    const c = actions.filter((a) => ["buy", "sell", "sync", "new-holding"].includes(a.kind)).length;
    const b = actions.find((a) => a.kind === "baseline");
    if (b) return `首次运行, 记录基线 ${b.count} 条, 未改持仓`;
    return c ? `更新 ${c} 处` : "无变化";
  }

  async function runOne(kind) {
    const queryId = kind === "positions" ? positionsQuery : confirmsQuery;
    if (!queryId) return null;
    const at = new Date().toISOString();
    let state = loadState(stateFile);
    try {
      const xml = await fetchFlexStatement(fetchText, token, queryId);
      // 持仓报表可能还是旧的(北京早上 IB 的日结常常没出, 会给再前一天的): 报表日期不比上次处理过的新 → 不写、不算完成, 稍后再查
      const stmtDate = kind === "positions" ? statementDate(xml) : "";
      if (kind === "positions" && stmtDate && state.lastPositionsToDate && stmtDate <= state.lastPositionsToDate) {
        const result = { at, ok: true, stale: true, msg: `IB 报表未更新(仍是 ${stmtDate.slice(4, 6)}/${stmtDate.slice(6, 8)}), 稍后再查` };
        state.lastOkAt = at;
        state.lastPositions = { ...result, diff: state.lastPositions && state.lastPositions.diff };
        saveState(stateFile, state);
        log(`[ib-sync] positions: ${result.msg}`);
        return result;
      }
      // 拿到数据后同步地 读→改→写, 不与其它请求交错
      const portfolio = loadPortfolio();
      const opts = { accountName, appendTrade, extras: effectiveExtras(state) };
      const r = kind === "positions"
        ? applyPositions(portfolio, state, parsePositions(xml), opts)
        : applyConfirms(portfolio, state, parseConfirms(xml), opts);
      const wrote = r.portfolio !== portfolio && r.actions.some((a) => ["buy", "sell", "sync", "new-holding"].includes(a.kind));
      if (wrote && !dryRun && !savePortfolio(r.portfolio)) throw new Error("持仓写入失败");
      const result = { at, ok: true, dryRun, msg: (dryRun ? "[试运行] " : "") + summarize(r.actions), actions: r.actions.slice(0, 50), diff: r.diff };
      const next = dryRun ? state : r.state;
      next.lastOkAt = at;
      if (kind === "positions") {
        next.lastPositions = result;
        if (!dryRun) { next.lastPositionsDay = shanghaiDay(new Date()); if (stmtDate) next.lastPositionsToDate = stmtDate; }
      }
      else next.lastConfirms = result;
      saveState(stateFile, next);
      log(`[ib-sync] ${kind}: ${result.msg}`);
      return result;
    } catch (e) {
      // Node 多地址连接失败时是 AggregateError, message 为空 → 用错误码
      const msg = e.message || e.code || (e.errors || []).map((x) => x.code).filter(Boolean).join("/") || String(e);
      const result = { at, ok: false, msg, hard: !!e.hard, code: e.ibCode || undefined };
      state = loadState(stateFile);
      if (kind === "positions") state.lastPositions = { ...(state.lastPositions || {}), ...result, diff: state.lastPositions && state.lastPositions.diff };
      else state.lastConfirms = result;
      try { saveState(stateFile, state); } catch {}
      log(`[ib-sync] ${kind} 失败: ${msg}`);
      return result;
    }
  }

  // 串行: 同一时间只跑一个, 避免两次请求交错
  function run(kinds) {
    const chain = (running || Promise.resolve()).then(async () => {
      const out = {};
      for (const k of kinds) out[k] = await runOne(k);
      return out;
    });
    running = chain.catch(() => {});
    return chain;
  }

  function status({ detailed = false } = {}) {
    const s = loadState(stateFile);
    const pick = (r) => r && (detailed ? r : { at: r.at, ok: r.ok, msg: r.msg, ...(r.hard ? { hard: true } : {}), ...(r.stale ? { stale: true } : {}), ...(r.code ? { code: r.code } : {}) });
    return { enabled: configured, dryRun, account: accountName, extras: effectiveExtras(s), lastOkAt: s.lastOkAt || null, tokenExpires: /^\d{4}-\d{2}-\d{2}$/.test(tokenExpires) ? tokenExpires : null, confirms: pick(s.lastConfirms), positions: pick(s.lastPositions) };
  }

  // 一次性处理场外部分(手机端修改弹窗入口; 清零后入口消失):
  //   sold        = 场外已卖出 → 看板该股记一笔卖出(场外股数 @ 卖出价, 保留已实现盈亏) + 清零
  //   (场外部分通常无法直接转进 IB, 换仓=卖出再到 IB 买, 所以只支持"已卖出")
  // 排进同步队列串行执行; 先写持仓再写状态, 持仓写失败则什么都不改
  function clearExtra(symbol, { mode, price } = {}) {
    const job = (running || Promise.resolve()).then(() => {
      const sym = String(symbol || "").toUpperCase();
      const state = loadState(stateFile);
      const cur = effectiveExtras(state);
      const e = cur[sym];
      if (!e) throw new Error(`${sym} 没有场外股数`);
      if (mode !== "sold") throw new Error("mode 只能是 sold");
      if (mode === "sold") {
        const px = Number(price);
        if (!(px > 0)) throw new Error("请填写卖出价");
        const portfolio = loadPortfolio();
        const ai = findAccount(portfolio, accountName);
        if (ai < 0) throw new Error(`找不到账户「${accountName}」`);
        const acc = portfolio.accounts[ai];
        const hi = findHolding(acc, sym);
        if (hi < 0) throw new Error(`看板里没有 ${sym}`);
        acc.holdings[hi] = appendTrade(acc.holdings[hi], { type: "sell", shares: e.qty, price: px, date: new Date().toISOString(), note: `场外 ${e.qty} 股卖出` });
        if (!savePortfolio(portfolio)) throw new Error("持仓写入失败");
      }
      const next = { ...cur }; delete next[sym];
      saveState(stateFile, { ...state, extrasOverride: next });
      log(`[ib-sync] 场外 ${sym} ${e.qty} 股已清零(卖出 @ ${price})`);
      return { ok: true, symbol: sym, qty: e.qty, mode };
    });
    running = job.catch(() => {});
    return job;
  }

  return { configured, run, status, clearExtra, _runOne: runOne };
}

function shanghaiDay(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

module.exports = {
  parseElements, parseConfirms, parsePositions, parseIbDateTime, fetchFlexStatement, parseExtras, statementDate,
  applyConfirms, applyPositions, createIbSync, loadState, shanghaiDay, AUTO_TAG, RECON_NOTE,
};
