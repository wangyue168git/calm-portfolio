"use strict";
// ===== 券商同步: 通用对账 =====
// 每家券商只需要一个"适配器"告诉我们两件事: 现在的持仓、新的成交; 怎么写进看板由这里统一处理。
// 原则(所有券商一致):
//   - 手动修改永远是兜底, 自动同步只是"代你点一次手动修改"
//   - 首次运行只记基线、不改持仓
//   - 持仓对比的是"上次从券商拿到的快照", 不是看板当前值 → 你手改过的数, 券商那边没有新变化前不会被改回去
//   - 新成交追加 buy/sell 记录(备注 <tag><成交编号>); 你已手动记过的不重复记
//   - 券商里清仓了、看板还有: 不自动删, 只提示
//   - 只读: 适配器只读持仓和成交, 不调用任何下单接口
//
// 适配器接口(内置的 IB / 长桥, 以及自己写的都一样, 见 docs/brokers/custom.md):
//   {
//     id: "ib",                 // 小写字母, 用于状态文件名、日志
//     label: "IB",              // 页面上显示的名字
//     tag: "IB#",               // 成交记录备注前缀, 用来识别"自动写入"的记录
//     reconNote: "IB 自动对账",  // 持仓纠偏记录的备注
//     configured: true,         // 必要的配置是否齐全; false 时整个同步不启用
//     tokenExpires: "2027-01-31", // 可选, 令牌到期日, 手机端到期前 30 天提醒
//     markets: ["us"],          // 可选, 在哪些市场的交易时段拉成交(us / hk / cn), 默认 ["us"]
//     positionsDaily: true,     // 可选, true = 持仓是日结报表(每天拉一次); false = 实时持仓(随成交一起拉)
//     fetchConfirms: async () => [{ id, symbol, side: "buy"|"sell", qty, price, commission?, date: Date, account?, market?, name? }],
//     fetchPositions: async () => ({ positions: [{ key?, symbol, qty, cost, account?, market?, name? }], statementDate?: "YYYYMMDD" }),
//   }
//   account(可选): 这条数据写进看板的哪个账户; 不填用该券商配置的默认账户
//   market(可选): 新建持仓时用的市场(nasdaq / nyse / hk / sh / sz ...), 不填默认 nasdaq

const fs = require("fs");

const SEEN_LIMIT = 800;
const WRITE_KINDS = ["buy", "sell", "sync", "new-holding"];

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

// ---------- 纯函数: 把券商数据套到 portfolio 上 ----------
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
function findAccount(portfolio, accountName) {
  return (portfolio.accounts || []).findIndex((a) => a && a.name === accountName);
}
function findHolding(account, symbol) {
  return (account.holdings || []).findIndex((h) => h && String(h.symbol).toUpperCase() === String(symbol).toUpperCase());
}
const autoTxTest = (tag, reconNote) => (t) => t && typeof t.note === "string" && (t.note.startsWith(tag) || t.note.startsWith(reconNote));

// 场外加数: 看板某只股票 = 券商股数 + 券商之外的部分(比如在别的平台持有的同一标的)。
// 配置 "AAPL:4:150.5,XYZ:1:10" → { AAPL: { qty: 4, cost: 150.5 } }
function parseExtras(spec) {
  const out = {};
  String(spec || "").split(",").map((x) => x.trim()).filter(Boolean).forEach((item) => {
    const [sym, q, c] = item.split(":").map((x) => x.trim());
    const qty = num(q), cost = num(c);
    if (sym && qty > 0 && cost > 0) out[sym.toUpperCase()] = { qty, cost };
  });
  return out;
}
function withExtra(x, extras) {
  const e = extras && extras[x.symbol.toUpperCase()];
  if (!e) return { qty: x.qty, cost: x.cost, extraQty: 0 };
  const qty = x.qty + e.qty;
  return { qty, cost: (x.qty * x.cost + e.qty * e.cost) / qty, extraQty: e.qty };
}

// 按账户名拿到可修改的账户副本(同一次调用里同一账户只复制一次)
function accountEditor(portfolio) {
  const p = { ...portfolio, accounts: (portfolio.accounts || []).slice() };
  const copied = new Set();
  return {
    portfolio: p,
    get(name) {
      const ai = findAccount(p, name);
      if (ai < 0) throw new Error(`找不到账户「${name}」`);
      if (!copied.has(ai)) { p.accounts[ai] = { ...p.accounts[ai], holdings: (p.accounts[ai].holdings || []).slice() }; copied.add(ai); }
      return p.accounts[ai];
    },
  };
}
const newHolding = (x) => ({ symbol: x.symbol, market: x.market || "nasdaq", name: x.name || x.symbol, transactions: [] });

// 返回 { portfolio, state, actions[] }; 不做 IO。appendTrade = server.js 的 appendTradeToHolding
function applyConfirms(portfolio, state, confirms, { accountName, appendTrade, tag = "IB#", reconNote = "IB 自动对账" }) {
  const seen = new Set(state.seen || []);
  const actions = [];
  if (!state.confirmsBaseline) {
    confirms.forEach((c) => seen.add(c.id));
    return { portfolio, state: { ...state, seen: [...seen].slice(-SEEN_LIMIT), confirmsBaseline: true }, actions: [{ kind: "baseline", count: confirms.length }] };
  }
  const isAutoTx = autoTxTest(tag, reconNote);
  const ed = accountEditor(portfolio);
  ed.get(accountName);   // 默认账户必须存在(与旧行为一致: 配错账户名直接报错)
  confirms.slice().sort((a, b) => a.date - b.date).forEach((c) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    let acc;
    try { acc = ed.get(c.account || accountName); } catch (e) { actions.push({ kind: "error", symbol: c.symbol, id: c.id, msg: e.message }); return; }
    let hi = findHolding(acc, c.symbol);
    if (hi >= 0) {
      // 用户已手动记过(成交之后有非自动的记录) → 不重复记
      const manualAfter = (acc.holdings[hi].transactions || []).some((t) => !isAutoTx(t) && t.date && new Date(t.date) >= c.date);
      if (manualAfter) { actions.push({ kind: "skip-manual", symbol: c.symbol, id: c.id }); return; }
    } else if (c.side === "buy") {
      acc.holdings.push(newHolding(c));
      hi = acc.holdings.length - 1;
      actions.push({ kind: "new-holding", symbol: c.symbol });
    } else { actions.push({ kind: "skip-unknown-sell", symbol: c.symbol, id: c.id }); return; }
    // 成本含佣金: 买入每股加佣金, 卖出每股减佣金
    const perShareFee = c.qty > 0 ? (c.commission || 0) / c.qty : 0;
    const price = c.side === "buy" ? c.price + perShareFee : Math.max(0, c.price - perShareFee);
    try {
      acc.holdings[hi] = appendTrade(acc.holdings[hi], { type: c.side, shares: c.qty, price, date: c.date.toISOString(), note: `${tag}${c.id}` });
      actions.push({ kind: c.side, symbol: c.symbol, qty: c.qty, price: +price.toFixed(4), id: c.id });
    } catch (e) { actions.push({ kind: "error", symbol: c.symbol, id: c.id, msg: e.message }); }
  });
  return { portfolio: ed.portfolio, state: { ...state, seen: [...seen].slice(-SEEN_LIMIT) }, actions };
}

function applyPositions(portfolio, state, positions, { accountName, appendTrade, extras = {}, reconNote = "IB 自动对账", now = new Date() }) {
  const keyOf = (x) => String(x.key || x.conid || x.symbol);
  const snap = {};
  positions.forEach((x) => { snap[keyOf(x)] = { symbol: x.symbol, qty: x.qty, cost: x.cost, ...(x.account ? { account: x.account } : {}) }; });
  const actions = [];
  if (findAccount(portfolio, accountName) < 0) throw new Error(`找不到账户「${accountName}」`);
  // 对照表(只读): 券商 vs 看板, 供页面/排查看
  const diff = positions.map((x) => {
    const ai = findAccount(portfolio, x.account || accountName);
    const acc0 = ai >= 0 ? portfolio.accounts[ai] : { holdings: [] };
    const hi = findHolding(acc0, x.symbol);
    const h = hi >= 0 ? acc0.holdings[hi] : null;
    const w = withExtra(x, extras);
    return { symbol: x.symbol, ibQty: x.qty, ibCost: x.cost, ...(w.extraQty ? { extraQty: w.extraQty } : {}), boardQty: h ? h.shares : null, boardCost: h ? h.costPrice : null };
  });
  if (!state.positions) {
    return { portfolio, state: { ...state, positions: snap }, actions: [{ kind: "baseline", count: positions.length }], diff };
  }
  const ed = accountEditor(portfolio);
  positions.forEach((x) => {
    const prev = state.positions[keyOf(x)];
    const changed = !prev || Math.abs(prev.qty - x.qty) > 1e-6 || Math.abs(prev.cost - x.cost) > Math.max(1e-6, x.cost * 1e-4);
    if (!changed) return;                          // 券商没变 → 尊重看板(含用户手改)
    const w = withExtra(x, extras);                // 看板应有 = 券商 + 场外部分
    let acc;
    try { acc = ed.get(x.account || accountName); } catch (e) { actions.push({ kind: "error", symbol: x.symbol, msg: e.message }); return; }
    let hi = findHolding(acc, x.symbol);
    if (hi >= 0) {
      const h = acc.holdings[hi];
      if (Math.abs((h.shares || 0) - w.qty) <= 1e-6 && Math.abs((h.costPrice || 0) - w.cost) <= Math.max(1e-4, w.cost * 5e-4)) return; // 已一致
    } else {
      acc.holdings.push(newHolding(x));
      hi = acc.holdings.length - 1;
      actions.push({ kind: "new-holding", symbol: x.symbol });
    }
    try {
      const note = w.extraQty ? `${reconNote}(含场外 ${w.extraQty} 股)` : reconNote;
      acc.holdings[hi] = appendTrade(acc.holdings[hi], { type: "sync", shares: +w.qty.toFixed(6), price: +w.cost.toFixed(6), date: now.toISOString(), note });
      actions.push({ kind: "sync", symbol: x.symbol, qty: +w.qty.toFixed(6), cost: +w.cost.toFixed(4), ...(w.extraQty ? { extraQty: w.extraQty } : {}) });
    } catch (e) { actions.push({ kind: "error", symbol: x.symbol, msg: e.message }); }
  });
  // 券商里已清仓、看板还有: 不自动删, 只提示(卖出应已由成交记过)
  Object.keys(state.positions).forEach((k) => {
    if (snap[k]) return;
    const old = state.positions[k];
    const ai = findAccount(ed.portfolio, old.account || accountName);
    if (ai < 0) return;
    const acc = ed.portfolio.accounts[ai];
    const hi = findHolding(acc, old.symbol);
    if (hi >= 0 && acc.holdings[hi].shares > 0) actions.push({ kind: "closed-in-ib", symbol: old.symbol });
  });
  return { portfolio: ed.portfolio, state: { ...state, positions: snap }, actions, diff };
}

function shanghaiDay(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ---------- 运行器(带 IO, server.js 注入依赖) ----------
function createBrokerSync({ adapter, accountName, stateFile, dryRun = false, extras = {}, loadPortfolio, savePortfolio, appendTrade, log = console.log }) {
  const id = adapter.id, label = adapter.label || id;
  const tag = adapter.tag || `${label}#`, reconNote = adapter.reconNote || `${label} 自动对账`;
  const configured = !!adapter.configured;
  // 场外加数: 配置只是初值; 状态文件里有 extrasOverride(含清零后的 {})就以它为准
  const effectiveExtras = (s) => (s && s.extrasOverride && typeof s.extrasOverride === "object") ? s.extrasOverride : extras;
  let running = null;

  function summarize(actions) {
    const c = actions.filter((a) => WRITE_KINDS.includes(a.kind)).length;
    const b = actions.find((a) => a.kind === "baseline");
    if (b) return `首次运行, 记录基线 ${b.count} 条, 未改持仓`;
    return c ? `更新 ${c} 处` : "无变化";
  }

  async function runOne(kind) {
    if (kind === "positions" ? !adapter.fetchPositions : !adapter.fetchConfirms) return null;
    const at = new Date().toISOString();
    let state = loadState(stateFile);
    try {
      let items, stmtDate = "";
      if (kind === "positions") {
        const r = await adapter.fetchPositions();
        items = (r && r.positions) || [];
        stmtDate = (r && r.statementDate) || "";
        // 日结报表可能还是旧的: 报表日期不比上次处理过的新 → 不写、不算完成, 稍后再查
        if (stmtDate && state.lastPositionsToDate && stmtDate <= state.lastPositionsToDate) {
          const result = { at, ok: true, stale: true, msg: `${label} 报表未更新(仍是 ${stmtDate.slice(4, 6)}/${stmtDate.slice(6, 8)}), 稍后再查` };
          state.lastOkAt = at;
          state.lastPositions = { ...result, diff: state.lastPositions && state.lastPositions.diff };
          saveState(stateFile, state);
          log(`[${id}-sync] positions: ${result.msg}`);
          return result;
        }
      } else {
        items = (await adapter.fetchConfirms()) || [];
      }
      // 拿到数据后同步地 读→改→写, 不与其它请求交错
      const portfolio = loadPortfolio();
      const opts = { accountName, appendTrade, extras: effectiveExtras(state), tag, reconNote };
      const r = kind === "positions" ? applyPositions(portfolio, state, items, opts) : applyConfirms(portfolio, state, items, opts);
      const wrote = r.portfolio !== portfolio && r.actions.some((a) => WRITE_KINDS.includes(a.kind));
      if (wrote && !dryRun && !savePortfolio(r.portfolio)) throw new Error("持仓写入失败");
      const result = { at, ok: true, dryRun, msg: (dryRun ? "[试运行] " : "") + summarize(r.actions), actions: r.actions.slice(0, 50), diff: r.diff };
      const next = dryRun ? state : r.state;
      next.lastOkAt = at;
      if (kind === "positions") {
        next.lastPositions = result;
        if (!dryRun) { next.lastPositionsDay = shanghaiDay(new Date()); if (stmtDate) next.lastPositionsToDate = stmtDate; }
      } else next.lastConfirms = result;
      saveState(stateFile, next);
      log(`[${id}-sync] ${kind}: ${result.msg}`);
      return result;
    } catch (e) {
      // Node 多地址连接失败时是 AggregateError, message 为空 → 用错误码
      const msg = e.message || e.code || (e.errors || []).map((x) => x.code).filter(Boolean).join("/") || String(e);
      const result = { at, ok: false, msg, hard: !!e.hard, code: e.ibCode || e.brokerCode || undefined };
      state = loadState(stateFile);
      if (kind === "positions") state.lastPositions = { ...(state.lastPositions || {}), ...result, diff: state.lastPositions && state.lastPositions.diff };
      else state.lastConfirms = result;
      try { saveState(stateFile, state); } catch {}
      log(`[${id}-sync] ${kind} 失败: ${msg}`);
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
    const te = adapter.tokenExpires || "";
    return { id, label, enabled: configured, dryRun, account: accountName, extras: effectiveExtras(s), lastOkAt: s.lastOkAt || null, tokenExpires: /^\d{4}-\d{2}-\d{2}$/.test(te) ? te : null, confirms: pick(s.lastConfirms), positions: pick(s.lastPositions) };
  }

  // 一次性处理场外部分: 场外已卖出 → 看板该股记一笔卖出 + 清零(入口消失)
  function clearExtra(symbol, { mode, price } = {}) {
    const job = (running || Promise.resolve()).then(() => {
      const sym = String(symbol || "").toUpperCase();
      const state = loadState(stateFile);
      const cur = effectiveExtras(state);
      const e = cur[sym];
      if (!e) throw new Error(`${sym} 没有场外股数`);
      if (mode !== "sold") throw new Error("mode 只能是 sold");
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
      const next = { ...cur }; delete next[sym];
      saveState(stateFile, { ...state, extrasOverride: next });
      log(`[${id}-sync] 场外 ${sym} ${e.qty} 股已清零(卖出 @ ${price})`);
      return { ok: true, symbol: sym, qty: e.qty, mode };
    });
    running = job.catch(() => {});
    return job;
  }

  return {
    id, label, configured, adapter,
    markets: Array.isArray(adapter.markets) && adapter.markets.length ? adapter.markets : ["us"],
    positionsDaily: adapter.positionsDaily !== false,
    run, status, clearExtra, _runOne: runOne,
  };
}

module.exports = { applyConfirms, applyPositions, createBrokerSync, parseExtras, loadState, saveState, shanghaiDay, withExtra };
