const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { classifyLookThroughBucket, configureGroups } = require("./classify");
const { marketGroupForHolding, marketSession, pollDelayMs } = require("./market-schedule");
const { canCommitGeneration, evaluateQuoteHealth, quoteKey, serializeFreshness } = require("./quote-health");
const { createIbSync, shanghaiDay, parseExtras: parseIbExtras } = require("./ib-sync");

// 给所有 outbound https/http.get 加 timeout → destroy 兜底。
// 原因: Node 的 timeout 选项只发 'timeout' 事件、不会自动断请求；
// 不监听+destroy 的话，上游静默挂起会让 refreshPrices 永远 await，
// 配合 _refreshing 在途守卫会造成"价格不刷新、改持仓不更新"卡死。
// 这一处覆盖所有现有及未来的 .get 调用。
// 'timeout' 事件只在 socket 建立后空闲超时才触发,DNS/TCP-handshake 卡住时不触发。
// 加一层请求全生命周期 setTimeout 兜底,15s 不论卡在哪个阶段都强制 destroy。
// 15s 选值: 现有最长配置超时 ~8s(汇率),留 7s 余量;远低于 60s refreshPrices watchdog。
const REQUEST_LIFETIME_MS = 15000;
for (const _m of [https, http]) {
  const _orig = _m.get;
  _m.get = function (...args) {
    const req = _orig.apply(_m, args);
    if (req && typeof req.on === "function") {
      req.on("timeout", () => { try { req.destroy(); } catch (e) {} });
      const _life = setTimeout(() => { try { req.destroy(); } catch (e) {} }, REQUEST_LIFETIME_MS);
      if (_life.unref) _life.unref();
      const _clear = () => clearTimeout(_life);
      req.on("close", _clear);
      req.on("error", _clear);
    }
    return req;
  };
}

// ---- 统一出站 HTTP: 所有 JSON/文本 GET 走这里(超时/编码/HTTP状态码处理一处管) ----
// 失败一律 reject,由调用方决定回退源/默认值; 上面的全局 destroy 兜底不带 error 对象,靠 'close' 保证必然 settle。
function fetchBody(url, { headers = {}, timeout = 8000, gbk = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers }, timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); done(reject, new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (gbk) { try { return done(resolve, new TextDecoder("gbk").decode(buf)); } catch (e) {} }
        done(resolve, buf.toString("utf8"));
      });
    });
    req.on("error", (e) => done(reject, e));
    req.on("close", () => done(reject, new Error("connection closed")));
  });
}
async function fetchJson(url, opts) { return JSON.parse(await fetchBody(url, opts)); }

const PORT = process.env.PORT || 3457;
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.STOCK_DATA_DIR || path.join(__dirname, "data"));
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
// 演示模式: DEMO=1 且数据目录还没有持仓时, 用 examples/ 里的虚构持仓做初始数据
if (process.env.DEMO === "1" && !fs.existsSync(PORTFOLIO_FILE)) {
  try { fs.copyFileSync(path.join(__dirname, "examples", "portfolio.example.json"), PORTFOLIO_FILE); console.log("[calm-portfolio] 演示模式: 已载入示例持仓"); }
  catch (e) { console.error("示例持仓载入失败:", e.message); }
}
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const HISTORY_JOURNAL_FILE = path.join(DATA_DIR, "history.journal");
const PROCESS_STARTED_AT = Date.now();
const TEST_MODE = process.env.NODE_ENV === "test";

// 存储: 纯文件(portfolio/journal/history 均为本地 JSON)。
// 移除 MongoDB 路径: 只用文件存储。
const MARKET_MAP = { sh: "1", sz: "0", hk: "116", crypto: "crypto" };
const US_PREFIXES = ["105", "106", "107"]; // NASDAQ, NYSE, NYSE Arca

// Auto-detect correct market for A-shares based on symbol prefix
function fixMarket(holding) {
  // Skip reclassification for explicit non-A-share types (fund/crypto codes
  // can collide with A-share number patterns: the same 6-digit code may be
  // both an A-share stock and an off-exchange fund).
  if (holding.market === "fund" || holding.market === "crypto") return holding;

  const sym = holding.symbol;
  if (/^\d{6}$/.test(sym)) {
    // A-share: 6xxxxx=Shanghai, 0xxxxx/3xxxxx=Shenzhen
    if (sym.startsWith("6")) return { ...holding, market: "sh" };
    if (sym.startsWith("0") || sym.startsWith("3")) return { ...holding, market: "sz" };
  }
  return holding;
}

function roundNum(v, digits = 6) {
  return Number.isFinite(v) ? +v.toFixed(digits) : 0;
}

function normalizeTrade(trade) {
  if (!trade) throw new Error("交易记录不能为空");
  const type = ["buy", "sell", "sync"].includes(trade.type) ? trade.type : "buy";
  const shares = parseFloat(trade.shares);
  const price = parseFloat(trade.price);
  const rawDate = trade.date ? new Date(trade.date) : new Date();
  if (!Number.isFinite(shares) || shares <= 0) throw new Error("交易数量必须大于 0");
  if (!Number.isFinite(price) || price < 0) throw new Error("交易价格必须大于等于 0");
  if (Number.isNaN(rawDate.getTime())) throw new Error("交易日期无效");
  return {
    type,
    shares: roundNum(shares),
    price: roundNum(price),
    date: rawDate.toISOString(),
    note: trade.note ? String(trade.note).slice(0, 120) : "",
  };
}

function deriveHoldingFromTransactions(holding) {
  const txs = Array.isArray(holding.transactions) ? holding.transactions.map((t, idx) => {
    try {
      const nt = normalizeTrade(t);
      return { ...nt, _idx: idx };
    } catch {
      return null;
    }
  }).filter(Boolean) : [];

  if (!txs.length) {
    return {
      ...holding,
      shares: roundNum(parseFloat(holding.shares) || 0),
      costPrice: roundNum(parseFloat(holding.costPrice) || 0),
      realizedPnl: 0,
      transactions: [],
      transactionCount: 0,
      lastTradeAt: null,
    };
  }

  txs.sort((a, b) => new Date(a.date) - new Date(b.date) || a._idx - b._idx);

  let shares = 0;
  let costBasis = 0;
  let realizedPnl = 0;

  txs.forEach((t) => {
    if (t.type === "sync") {
      shares = t.shares;
      costBasis = t.shares * t.price;
      return;
    }
    if (t.type === "buy") {
      shares += t.shares;
      costBasis += t.shares * t.price;
      return;
    }
    if (t.type === "sell") {
      const qty = Math.min(t.shares, shares);
      if (qty <= 0) return;
      const avgCost = shares > 0 ? costBasis / shares : 0;
      realizedPnl += (t.price - avgCost) * qty;
      shares -= qty;
      costBasis -= avgCost * qty;
      if (shares <= 1e-8) {
        shares = 0;
        costBasis = 0;
      }
    }
  });

  return {
    ...holding,
    shares: roundNum(shares),
    costPrice: shares > 0 ? roundNum(costBasis / shares) : 0,
    realizedPnl: roundNum(realizedPnl, 2),
    transactions: txs.map(({ _idx, ...t }) => t),
    transactionCount: txs.length,
    lastTradeAt: txs[txs.length - 1]?.date || null,
  };
}

function appendTradeToHolding(holding, trade) {
  const normalizedTrade = normalizeTrade(trade);
  const current = deriveHoldingFromTransactions(holding);
  if (normalizedTrade.type === "sell" && normalizedTrade.shares - current.shares > 1e-8) {
    throw new Error("卖出数量不能超过当前持仓");
  }
  const next = deriveHoldingFromTransactions({
    ...holding,
    transactions: [...(holding.transactions || []), normalizedTrade],
  });
  return {
    ...holding,
    shares: next.shares,
    costPrice: next.costPrice,
    transactions: next.transactions,
  };
}

// portfolio.json 顶层 shares/costPrice 是 transactions 的物化快照。所有改动流水的路径
// 都必须经此函数回写，避免 API/备份直接读取文件时看到过期持仓。
function syncHoldingSnapshot(holding) {
  return deriveHoldingFromTransactions(holding);
}

// ====== 场外基金「申购在途」模型 ======
// 背景: 场外基金(尤其 QDII)下单时只知道「金额」,份额要 T+1/T+2 按确认日净值才确定。
// 设计: 申购单存在 holding.orders[](独立于 transactions,不动核心引擎);
//   pending -> 只贡献「在途金额/预估份额」,不进 shares/cost;
//   confirmed -> 追加一条标准 buy 交易(note 标 申购#id),份额/成本/市值自动走现有引擎。
let _orderSeq = 0;
function genOrderId() { return Date.now().toString(36) + (_orderSeq++).toString(36); }

// 把一张已确认的申购单落地成 transactions 里的 buy(I 类无申购费: cost=金额)。
// 已存在同 id 的 buy(重复校准)则就地替换,保证幂等。
function applyOrderConfirmation(holding, order, nav, shares) {
  const txs = Array.isArray(holding.transactions) ? holding.transactions.slice() : [];
  const tag = `申购#${order.id}`;
  const day = String(order.date).slice(0, 10);
  // buy 日期用「确认/结算时点」而非下单日: 场外基金份额 T+1/T+2 才到账,
  // 这样它必定排在任何历史 sync(绝对快照)之后,不会被旧 sync 清零;成本只取决于 price,与日期无关。
  const buyTx = {
    type: "buy",
    shares: roundNum(shares, 2),
    price: roundNum(nav, 4),
    date: order.confirmDate || (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T08:00:00.000Z` : order.date),
    note: tag,
  };
  const i = txs.findIndex((t) => t && t.note === tag);
  if (i >= 0) txs[i] = buyTx; else txs.push(buyTx);
  return syncHoldingSnapshot({ ...holding, transactions: txs });
}

function reconcilePortfolioSnapshots() {
  const portfolio = loadPortfolio();
  let changed = false;
  portfolio.accounts = (portfolio.accounts || []).map((account) => ({
    ...account,
    holdings: (account.holdings || []).map((holding) => {
      if (!Array.isArray(holding.transactions) || !holding.transactions.length) return holding;
      const synced = syncHoldingSnapshot(holding);
      if (synced.shares !== holding.shares || synced.costPrice !== holding.costPrice) changed = true;
      return synced;
    }),
  }));
  if (!changed) return false;
  if (!savePortfolio(portfolio)) console.error("持仓快照校正未能保存");
  return true;
}

// 从天天基金历史净值接口取 { "YYYY-MM-DD": 单位净值 } 映射(需 eastmoney Referer)
async function fetchFundNavHistory(symbol) {
  const map = {};
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(symbol)}&pageIndex=1&pageSize=20`;
    const j = await fetchJson(url, { headers: { Referer: "https://fundf10.eastmoney.com/" }, timeout: 8000 });
    const list = j && j.Data && j.Data.LSJZList ? j.Data.LSJZList : [];
    list.forEach((row) => {
      const d = row.FSRQ; const nav = parseFloat(row.DWJZ);
      if (d && Number.isFinite(nav) && nav > 0) map[d] = nav;
    });
  } catch (e) { console.warn(`fetchFundNavHistory(${symbol}) 失败:`, e.message); }
  return map;
}

// 定时尝试用确认日净值把在途申购单自动落地(用户随后仍可手动校准覆盖)
let _autoConfirmRunning = false;
// 找某申购单对应的 buy 交易日期(没有则 null)
function orderBuyTxDate(holding, id) {
  const t = (holding.transactions || []).find((x) => x && x.note === `申购#${id}`);
  return t ? t.date : null;
}
async function autoConfirmSubscriptions() {
  if (_autoConfirmRunning) return;
  let portfolio = loadPortfolio();
  const hasPending = (portfolio.accounts || []).some((acc) =>
    (acc.holdings || []).some((h) => Array.isArray(h.orders) && h.orders.some((o) => o.status === "pending")));
  // 自愈对象: 已确认但 buy 交易日期 ≠ confirmDate(多半是早于历史 sync 被清零的遗留单)
  const needsHeal = (portfolio.accounts || []).some((acc) =>
    (acc.holdings || []).some((h) => Array.isArray(h.orders) && h.orders.some((o) =>
      o.status === "confirmed" && o.confirmDate && orderBuyTxDate(h, o.id) && orderBuyTxDate(h, o.id) !== o.confirmDate)));
  if (!hasPending && !needsHeal) return;
  _autoConfirmRunning = true;
  try {
    const navMaps = {};
    if (hasPending) {
      const symbols = new Set();
      portfolio.accounts.forEach((acc) => (acc.holdings || []).forEach((h) => {
        if (h.market === "fund" && Array.isArray(h.orders) && h.orders.some((o) => o.status === "pending")) symbols.add(h.symbol);
      }));
      for (const sym of symbols) { navMaps[sym] = await fetchFundNavHistory(sym); }
    }
    portfolio = loadPortfolio(); // 重新读,缩小与其它写入的覆盖窗口
    let changed = false;
    (portfolio.accounts || []).forEach((acc) => {
      (acc.holdings || []).forEach((h, hi) => {
        if (h.market !== "fund" || !Array.isArray(h.orders)) return;
        const navMap = navMaps[h.symbol];
        let holding = h;
        h.orders.forEach((o) => {
          // ① 在途确认(需净值)
          if (o.status === "pending" && navMap) {
            const day = String(o.date).slice(0, 10);
            let nav = 0;
            if (o.afterCutoff) {
              const next = Object.keys(navMap).filter((d) => d > day).sort()[0];
              if (next) nav = navMap[next];
            } else if (navMap[day]) {
              nav = navMap[day];
            } else {
              // 下单日无净值: QDII 净值按序发布,故"当日无净值但有更晚净值"⟹当日是非交易日(周末/节假日)
              // → 顺延到下一交易日净值(不会把"当日净值尚未发布"误判,因为那种情况更晚的也不会有)
              const next = Object.keys(navMap).filter((d) => d > day).sort()[0];
              if (next) nav = navMap[next];
            }
            if (nav > 0) {
              const shares = o.amount / nav; // I 类无申购费
              o.status = "confirmed"; o.nav = roundNum(nav, 4); o.shares = roundNum(shares, 2);
              o.confirmDate = new Date().toISOString(); o.auto = true; o.calibrated = false;
              holding = applyOrderConfirmation(holding, o, nav, shares);
              changed = true;
              return;
            }
          }
          // ② 自愈: 已确认但 buy 日期与 confirmDate 不符 → 用结算日重新落地(排到历史 sync 之后)
          if (o.status === "confirmed" && o.confirmDate) {
            const txDate = orderBuyTxDate(holding, o.id);
            if (txDate && txDate !== o.confirmDate && o.nav > 0 && o.shares > 0) {
              holding = applyOrderConfirmation(holding, o, o.nav, o.shares);
              changed = true;
            }
          }
        });
        acc.holdings[hi] = { ...holding, orders: h.orders };
      });
    });
    if (changed) {
      if (savePortfolio(portfolio)) console.log("autoConfirmSubscriptions: 已确认/自愈在途申购");
      else console.error("autoConfirmSubscriptions: 变更未能保存");
    }
  } catch (e) { console.error("autoConfirmSubscriptions error:", e.message); }
  finally { _autoConfirmRunning = false; }
}
if (!TEST_MODE || process.env.STOCK_TEST_AUTO_CONFIRM === "1") {
  setInterval(() => { autoConfirmSubscriptions().catch(() => {}); }, 30 * 60 * 1000);
  setTimeout(() => { autoConfirmSubscriptions().catch(() => {}); }, 15 * 1000);
}

// classifyLookThroughBucket 来自 ./classify.js(与 m.html 共享同一份白名单)

function buildLookThrough(result, rate) {
  loadPlan();   // 确保警戒/其他分组是最新规则
  const bucketColors = {
    "标普宽基": "bg-blue-500",
    "纳指/成长": "bg-indigo-500",
    "美股个股": "bg-amber-500",
    "中国/港股资产": "bg-emerald-500",
    "加密资产": "bg-fuchsia-500",
    "现金": "bg-slate-400",
    "其他": "bg-slate-500",
  };
  const bucketMap = {};
  let total = 0;
  result.accounts.forEach((acc) => {
    const cur = acc.currency || "CNY";
    const mul = cur === "USD" ? rate : cur === "HKD" ? rate / 7.8 : 1;
    (acc.holdings || []).forEach((h) => {
      const valueCNY = (h.marketValue || 0) * mul;
      if (valueCNY <= 0) return;
      total += valueCNY;
      const bucket = classifyLookThroughBucket(h);
      if (!bucketMap[bucket]) bucketMap[bucket] = { name: bucket, valueCNY: 0, count: 0, color: bucketColors[bucket] || bucketColors["其他"] };
      bucketMap[bucket].valueCNY += valueCNY;
      bucketMap[bucket].count += 1;
    });
    const cash = (acc.cash || 0) * mul;
    if (cash > 0) {
      total += cash;
      if (!bucketMap["现金"]) bucketMap["现金"] = { name: "现金", valueCNY: 0, count: 0, color: bucketColors["现金"] };
      bucketMap["现金"].valueCNY += cash;
    }
  });
  const buckets = Object.values(bucketMap)
    .map((b) => ({ ...b, valueCNY: roundNum(b.valueCNY, 2), weightPct: total > 0 ? roundNum(b.valueCNY / total * 100, 2) : 0 }))
    .sort((a, b) => b.valueCNY - a.valueCNY);
  return { buckets, totalValueCNY: roundNum(total, 2) };
}

// Auto-fetch exchange rate from open API
let cachedRate = null;
let rateLastFetch = 0;
const RATE_INTERVAL = 60 * 60 * 1000; // refresh every 1 hour

async function fetchExchangeRate() {
  try {
    const j = await fetchJson("https://open.er-api.com/v6/latest/USD", { timeout: 8000 }); // 8s 无响应即放弃，避免整轮 refreshPrices 被挂起
    if (j.rates && j.rates.CNY) {
      cachedRate = {
        USD_CNY: Math.round(j.rates.CNY * 10000) / 10000,
        USD_HKD: j.rates.HKD ? Math.round(j.rates.HKD * 10000) / 10000 : 7.82,
      };
      rateLastFetch = Date.now();
      // Save to portfolio.json
      const p = loadPortfolio();
      p.exchangeRate = { USD_CNY: cachedRate.USD_CNY };
      if (savePortfolio(p)) console.log(`Exchange rate updated: USD/CNY = ${cachedRate.USD_CNY}`);
      else console.error(`Exchange rate fetched but not saved: USD/CNY = ${cachedRate.USD_CNY}`);
    }
  } catch (e) { console.warn("汇率获取失败(沿用缓存):", e.message); }
  return cachedRate;
}

async function getExchangeRate() {
  if (TEST_MODE && process.env.STOCK_TEST_EXCHANGE_RATE) {
    const usdCny = parseFloat(process.env.STOCK_TEST_EXCHANGE_RATE);
    if (Number.isFinite(usdCny) && usdCny > 0) {
      cachedRate = { USD_CNY: usdCny, USD_HKD: 7.82 };
      rateLastFetch = Date.now();
      return cachedRate;
    }
  }
  if (!cachedRate || Date.now() - rateLastFetch > RATE_INTERVAL) {
    await fetchExchangeRate();
  }
  return cachedRate;
}

// ---- 个人规则(plan.json) ----
const PLAN_FILE = path.join(DATA_DIR, "plan.json");
const PLAN_EXAMPLE_FILE = path.join(__dirname, "plan.example.json");
const READ_APIS = new Set(["/plan.json", "/api/portfolio", "/api/history", "/api/data", "/api/journal", "/api/ib-sync"]);
let _planCache = { mtime: -1, file: "", doc: {} };
function loadPlan() {
  const file = fs.existsSync(PLAN_FILE) ? PLAN_FILE : PLAN_EXAMPLE_FILE;
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (_planCache.file !== file || _planCache.mtime !== mtime) {
      _planCache = { mtime, file, doc: JSON.parse(fs.readFileSync(file, "utf8")) };
      configureGroups(_planCache.doc.groups);   // 警戒/其他分组跟着规则走(穿透桶等服务端分类要用)
    }
  } catch (e) { console.error("plan.json 读取失败:", e.message); }
  return _planCache.doc;
}
loadPlan();

// ---- Auth ----
// 登录密码: 优先读环境变量 APP_PASSWORD; 没设置时, 首次启动自动生成一个随机密码打印到日志,
// 只把加盐哈希存进 DATA_DIR/auth.json(下次启动沿用)。想换密码: 设 APP_PASSWORD, 或删掉 auth.json 重启。
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const PUBLIC_READ = process.env.PUBLIC_READ === "1";   // 默认读取持仓也要登录; 设为 1 才允许匿名只读
const validTokens = new Set();
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const scryptHash = (pwd, salt) => crypto.scryptSync(String(pwd), salt, 32).toString("hex");
let AUTH = null;   // { salt, hash }
function initAuth() {
  const make = (pwd) => { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: scryptHash(pwd, salt) }; };
  if (TEST_MODE && process.env.STOCK_TEST_PASSWORD) { AUTH = make(process.env.STOCK_TEST_PASSWORD); return; }
  if (process.env.APP_PASSWORD) { AUTH = make(process.env.APP_PASSWORD); return; }
  try {
    const saved = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (saved && saved.salt && saved.hash) { AUTH = saved; return; }
  } catch (e) {}
  const pwd = crypto.randomBytes(9).toString("base64url");
  AUTH = make(pwd);
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(AUTH), { mode: 0o600 }); }
  catch (e) { console.error("auth.json 写入失败:", e.message); }
  console.log(`\n[calm-portfolio] 首次启动, 已生成登录密码: ${pwd}\n  只显示这一次。想自己指定密码: 设置环境变量 APP_PASSWORD 后重启。\n`);
}
initAuth();

function verifyPassword(pwd) {
  if (!AUTH || typeof pwd !== "string") return false;
  const a = Buffer.from(scryptHash(pwd, AUTH.salt), "hex"), b = Buffer.from(AUTH.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);
  return token;
}

function checkAuth(req) {
  const token = req.headers["x-auth-token"];
  return !!token && validTokens.has(token);
}

// ---- 登录限速 / 失败锁定 ----
const AUTH_MAX_FAILS = 5;              // 连续失败次数阈值
const AUTH_LOCK_MS = 5 * 60 * 1000;   // 触发后锁定 5 分钟
const AUTH_PRUNE_MS = 30 * 60 * 1000; // 空闲超过 30 分钟的条目清理掉
const authState = new Map();          // ip -> { fails, lockedUntil, lastSeen }

function clientIp(req) {
  const socketIp = req.socket.remoteAddress || "unknown";
  if (!TRUST_PROXY) return socketIp;
  return (req.headers["x-forwarded-for"] || socketIp).split(",")[0].trim();
}

// 公网读接口限流：固定窗口足够应对本项目的低并发场景；只覆盖会触发上游请求
// 或返回较大数据的接口，不限制 WebSocket 正常推送和普通静态资源。
const rateLimitBuckets = new Map();
function takeRateLimit(req, scope, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${clientIp(req)}`;
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + windowMs };
  if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (rateLimitBuckets.size > 2000) {
    for (const [k, value] of rateLimitBuckets) if (now >= value.resetAt) rateLimitBuckets.delete(k);
  }
  return 0;
}

function rejectRateLimited(res, retryAfter) {
  res.writeHead(429, {
    "Content-Type": "application/json",
    "Retry-After": String(retryAfter),
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ ok: false, error: "请求过于频繁，请稍后再试" }));
}
function authLocked(ip) { // 返回剩余锁定秒数，0 表示未锁
  const s = authState.get(ip);
  if (s && s.lockedUntil > Date.now()) return Math.ceil((s.lockedUntil - Date.now()) / 1000);
  return 0;
}
function authFail(ip) {
  const s = authState.get(ip) || { fails: 0, lockedUntil: 0, lastSeen: 0 };
  s.fails += 1;
  s.lastSeen = Date.now();
  if (s.fails >= AUTH_MAX_FAILS) { s.lockedUntil = Date.now() + AUTH_LOCK_MS; s.fails = 0; }
  authState.set(ip, s);
}
function authReset(ip) { authState.delete(ip); } // 验证成功即清零
// 定时清理已过期且空闲的条目，防止 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of authState) {
    if (s.lockedUntil < now && now - s.lastSeen > AUTH_PRUNE_MS) authState.delete(ip);
  }
}, 10 * 60 * 1000);

function loadPortfolioFile() {
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
  } catch (e) {
    // 文件不存在=首次启动正常; 其它(解析失败/权限)必须出声——此时返回空组合,后续任何写入都会覆盖原数据
    if (e.code !== "ENOENT") console.error("loadPortfolio 读取/解析失败(已返回空组合,写入将覆盖原文件!):", e.message);
    return { exchangeRate: { USD_CNY: 6.88 }, accounts: [] };
  }
}

function savePortfolioFile(data) {
  // 原子写: 先写 .tmp 再 rename,进程崩在写一半时不会留下损坏的 portfolio.json
  let saved = false;
  if (TEST_MODE && process.env.STOCK_TEST_FAIL_WRITES === "1") {
    console.error("savePortfolio 写入失败: 测试注入失败");
    return false;
  }
  try {
    const tmp = PORTFOLIO_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, PORTFOLIO_FILE);
    saved = true;
  } catch (e) { console.error("savePortfolio 写入失败:", e.message); }
  if (!saved) return false;
  _portfolioRevision += 1;
  triggerRefresh();
  return true;
}

// Debounced refresh trigger. Called after any mutation so clients see updates
// without waiting up to 5s for the next setInterval tick.
let _refreshInFlight = false;
let _refreshQueued = false;
let _portfolioRevision = 0;
let _analysisRevision = 0;
let _broadcastRevision = null;
function triggerRefresh() {
  if (_refreshInFlight || _refreshing) { _refreshQueued = true; return; }
  _refreshInFlight = true;
  setImmediate(async () => {
    try { await refreshPrices(); } catch {}
    _refreshInFlight = false;
    if (_refreshQueued) { _refreshQueued = false; triggerRefresh(); }
  });
}

// Sync wrappers for backward compatibility (used in non-async contexts)
function loadPortfolio() { return loadPortfolioFile(); }
function savePortfolio(data) { return savePortfolioFile(data); }

// IB 域名(ndcdyn/gdcdyn.interactivebrokers.com)在国内 DNS 被污染, 会解析到连不上的假 IP;
// 它们都 CNAME 到 Akamai 的 edgekey 域名, 后者解析正常 → 访问 IB 时改用它取 IP(只影响 IB 请求)
const IB_EDGE_HOST = "www.interactivebrokers.com.edgekey.net";
function ibLookup(hostname, opts, cb) {
  const host = /(^|\.)interactivebrokers\.com$/i.test(hostname) ? IB_EDGE_HOST : hostname;
  require("dns").lookup(host, { ...opts, family: 4 }, cb);
}
function fetchIb(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, lookup: ibLookup, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("连接 IB 超时")));   // 超时必须断开, 否则串行队列会卡住
    req.on("error", reject);
  });
}

// ---- IB Flex 自动同步: 令牌/查询编号只从环境变量读(环境变量 / .env), 不进仓库 ----
// 手动修改永远是兜底; 逻辑见 ib-sync.js。未配置令牌时整个功能不启用, 行为与之前完全一致。
const ibSync = createIbSync({
  token: process.env.IB_FLEX_TOKEN || "",
  positionsQuery: process.env.IB_FLEX_POSITIONS_QUERY || "",
  confirmsQuery: process.env.IB_FLEX_CONFIRMS_QUERY || "",
  accountName: process.env.IB_SYNC_ACCOUNT || "IB",
  dryRun: process.env.IB_SYNC_DRYRUN === "1",
  extras: parseIbExtras(process.env.IB_SYNC_EXTRA || ""),
  tokenExpires: process.env.IB_FLEX_TOKEN_EXPIRES || "",   // YYYY-MM-DD, 手机端到期前 30 天提醒
  stateFile: path.join(DATA_DIR, "ib-sync-state.json"),
  fetchText: fetchIb,
  loadPortfolio, savePortfolio,
  appendTrade: (h, t) => appendTradeToHolding(h, t),
});

// ---- History tracking ----
// In-memory history with file persistence as backup
let memHistory = { snapshots: [] };
let cachedRiskMetrics = null;

function loadHistory() {
  if (memHistory.snapshots.length > 0) return memHistory;
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    if (data.snapshots && data.snapshots.length > 0) {
      memHistory = data;
    }
  } catch (e) {}
  try {
    const journalSnapshots = [];
    fs.readFileSync(HISTORY_JOURNAL_FILE, "utf-8").split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try { journalSnapshots.push(JSON.parse(line)); }
      catch (e) { console.error(`history journal 第 ${index + 1} 行损坏，已跳过:`, e.message); }
    });
    if (journalSnapshots.length) {
      const byTime = new Map(memHistory.snapshots.map((s) => [s.t, s]));
      journalSnapshots.forEach((s) => { if (s && s.t) byTime.set(s.t, s); });
      memHistory.snapshots = compactHistory([...byTime.values()].sort((a, b) => new Date(a.t) - new Date(b.t)));
      scheduleHistoryCheckpoint();
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("history journal 读取失败:", e.message);
  }
  return memHistory;
}

let historyPersistChain = Promise.resolve();
let historyCheckpointTimer = null;
const HISTORY_CHECKPOINT_MS = 10 * 60 * 1000;

function queueHistoryTask(task) {
  historyPersistChain = historyPersistChain.then(task, task).catch((e) => {
    console.error("saveHistory 写入失败:", e.message);
  });
  return historyPersistChain;
}

function checkpointHistory() {
  if (historyCheckpointTimer) { clearTimeout(historyCheckpointTimer); historyCheckpointTimer = null; }
  return queueHistoryTask(async () => {
    // 先原子替换完整快照，再截断 journal。若中途崩溃，旧 journal 至多造成重复，
    // loadHistory 会按时间去重；不会出现 journal 已清空而主文件仍是旧版本的丢点窗口。
    const snapshotJson = JSON.stringify(memHistory);
    const tmp = HISTORY_FILE + ".tmp";
    await fs.promises.writeFile(tmp, snapshotJson);
    await fs.promises.rename(tmp, HISTORY_FILE);
    await fs.promises.writeFile(HISTORY_JOURNAL_FILE, "");
  });
}

function writeHistoryExport(res) {
  checkpointHistory().then(() => {
    const body = JSON.stringify(memHistory);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    res.end(body);
  }).catch((e) => {
    console.error("history export 失败:", e.message);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "history export failed" }));
  });
}

function validBackupToken(req) {
  const expected = process.env.BACKUP_TOKEN || process.env.STOCK_BACKUP_TOKEN || "";
  const supplied = String(req.headers["x-backup-token"] || "");
  if (!expected || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function scheduleHistoryCheckpoint() {
  if (historyCheckpointTimer) return;
  historyCheckpointTimer = setTimeout(() => checkpointHistory(), HISTORY_CHECKPOINT_MS);
  if (historyCheckpointTimer.unref) historyCheckpointTimer.unref();
}

function saveHistoryFile(snapshot) {
  // 每分钟只追加几十字节；完整 history.json 每 10 分钟原子归并一次。
  queueHistoryTask(() => fs.promises.appendFile(HISTORY_JOURNAL_FILE, JSON.stringify(snapshot) + "\n"));
  scheduleHistoryCheckpoint();
}

let lastSnapshotTime = 0;
const SNAPSHOT_INTERVAL = 60 * 1000; // 1 minute

// ---- 历史快照分层降采样: 近处细、远处粗,让收益曲线 ALL 真正长期可用 ----
// 旧方案 slice(-10000) 是 ~7 天滚动窗,第 8 天起每分钟都在永久丢长期数据。
// 现按数据年龄压缩: ≤48h 原始 1min; 2~60天 每 30min 取桶内最后一点(收盘); >60天 每 4h。
// 稳态 ~8k 点 + ~2.2k/年增速; HARD_CAP 仅防失控(≈20年)。降采样单向有损,只发生在跨入更老分层时。
const COMPACT_TIERS = [
  { olderThanMs: 60 * 86400000, bucketMs: 4 * 3600000 }, // >60天 → 4小时
  { olderThanMs: 2 * 86400000, bucketMs: 30 * 60000 },   // 2~60天 → 30分钟
];
const HISTORY_HARD_CAP = 50000;

function compactHistory(snapshots) {
  const now = Date.now();
  const out = [];
  let lastKey = null;
  for (const s of snapshots) {
    const ts = new Date(s.t).getTime();
    if (!Number.isFinite(ts)) continue;
    const age = now - ts;
    const tier = COMPACT_TIERS.find((t) => age > t.olderThanMs);
    if (!tier) { out.push(s); lastKey = null; continue; }
    const key = tier.bucketMs + ":" + Math.floor(ts / tier.bucketMs);
    if (key === lastKey) out[out.length - 1] = s; // 同桶覆盖 → 桶内最后一点
    else { out.push(s); lastKey = key; }
  }
  return out.length > HISTORY_HARD_CAP ? out.slice(-HISTORY_HARD_CAP) : out;
}

function recordSnapshot(totalCNY, totalCost, totalRealized) {
  const now = Date.now();
  if (now - lastSnapshotTime < SNAPSHOT_INTERVAL) return null;
  if (totalCNY <= 0) return null;
  // Guard: skip snapshot if value dropped >20% vs last snapshot (API failure indicator)
  const snaps = memHistory.snapshots;
  if (snaps.length > 0) {
    const lastV = snaps[snaps.length - 1].v;
    if (lastV > 0 && totalCNY < lastV * 0.8) return null;
  }
  lastSnapshotTime = now;
  const snapshot = {
    t: new Date().toISOString(),
    v: Math.round(totalCNY * 100) / 100,
    c: Math.round(totalCost * 100) / 100,
    r: Math.round((totalRealized || 0) * 100) / 100,   // 已实现盈亏(CNY)累计; 收益曲线 = v − c + r, 卖出不再让曲线凭空掉一块
  };
  memHistory.snapshots.push(snapshot);
  memHistory.snapshots = compactHistory(memHistory.snapshots);
  saveHistoryFile(snapshot);
  cachedRiskMetrics = calcRiskMetrics(memHistory.snapshots);
  return snapshot;
}

// Load history from file on startup
loadHistory();
if (memHistory.snapshots.length) {
  const lastTs = new Date(memHistory.snapshots[memHistory.snapshots.length - 1].t).getTime();
  if (Number.isFinite(lastTs)) lastSnapshotTime = lastTs;
  cachedRiskMetrics = calcRiskMetrics(memHistory.snapshots);
}

const HISTORY_RANGE_MS = {
  "1d": 86400000,
  "7d": 7 * 86400000,
  "1m": 30 * 86400000,
  "6m": 180 * 86400000,
  "1y": 365 * 86400000,
};

function historyRangeStart(range, now = Date.now()) {
  if (range === "ytd") return new Date(new Date(now).getFullYear(), 0, 1).getTime();
  return HISTORY_RANGE_MS[range] ? now - HISTORY_RANGE_MS[range] : -Infinity;
}

function sampleHistoryByTime(snapshots, maxPoints) {
  if (snapshots.length <= maxPoints) return snapshots;
  const firstTs = new Date(snapshots[0].t).getTime();
  const lastTs = new Date(snapshots[snapshots.length - 1].t).getTime();
  if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs) || lastTs <= firstTs) {
    const step = (snapshots.length - 1) / (maxPoints - 1);
    return Array.from({ length: maxPoints }, (_, i) => snapshots[Math.round(i * step)]);
  }
  const sampled = [snapshots[0]];
  let cursor = 1;
  for (let i = 1; i < maxPoints - 1; i++) {
    const target = firstTs + (lastTs - firstTs) * i / (maxPoints - 1);
    while (cursor < snapshots.length - 1 && new Date(snapshots[cursor].t).getTime() < target) cursor++;
    const prev = snapshots[Math.max(0, cursor - 1)];
    const next = snapshots[cursor];
    const prevDist = Math.abs(new Date(prev.t).getTime() - target);
    const nextDist = Math.abs(new Date(next.t).getTime() - target);
    const chosen = prevDist <= nextDist ? prev : next;
    if (sampled[sampled.length - 1] !== chosen) sampled.push(chosen);
  }
  const last = snapshots[snapshots.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function historyPayload(urlObj) {
  const range = urlObj.searchParams.get("range") || "all";
  const hasSince = urlObj.searchParams.has("since");
  const sinceTs = new Date(urlObj.searchParams.get("since") || 0).getTime();
  const cutoff = Math.max(historyRangeStart(range), Number.isFinite(sinceTs) ? sinceTs : -Infinity);
  const all = loadHistory().snapshots;
  const ranged = cutoff === -Infinity ? all : all.filter((s) => new Date(s.t).getTime() > cutoff);
  // 长时间停更/休市后打开短区间，仍给最近少量点，避免整张图空白；增量 since 查询不回退。
  const filtered = !hasSince && ranged.length < 2 && all.length ? all.slice(-30) : ranged;
  const requestedMax = parseInt(urlObj.searchParams.get("maxPoints"), 10);
  const maxPoints = Math.max(50, Math.min(Number.isFinite(requestedMax) ? requestedMax : 1200, 5000));
  const history = sampleHistoryByTime(filtered, maxPoints);
  const payload = {
    range,
    history,
    totalPoints: filtered.length,
    sampledPoints: history.length,
    lastSnapshotAt: all.length ? all[all.length - 1].t : null,
    riskMetrics: cachedRiskMetrics,
  };
  if (urlObj.searchParams.get("benchmarks") === "1") {
    payload.benchmarks = {};
    for (const [name, klines] of Object.entries(benchmarkCache)) {
      payload.benchmarks[name] = klines.map((k) => ({ date: k.date, close: k.c }));
    }
  }
  return payload;
}

// ---- 加密货币行情: 依序尝试 CryptoCompare → Coinbase → Binance → CoinGecko → Gate.io,首个有效价即采纳 ----
// 仅 Binance/Gate 提供 24h 涨跌字段,其余源只有现价(涨跌记 0)
function flatQuote(price, name) {
  return { price, changePercent: 0, change: 0, high: price, low: price, open: price, prevClose: price, name };
}

const CRYPTO_SOURCES = [
  async (sym) => { // CryptoCompare (works globally)
    const j = await fetchJson(`https://min-api.cryptocompare.com/data/price?fsym=${sym}&tsyms=USD`, { timeout: 5000 });
    const price = parseFloat(j.USD);
    return price > 0 ? flatQuote(price, sym) : null;
  },
  async (sym) => { // Coinbase
    const j = await fetchJson(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { timeout: 5000 });
    const price = parseFloat(j?.data?.amount);
    return price > 0 ? flatQuote(price, sym) : null;
  },
  async (sym) => { // Binance (完整 24h 行情字段)
    const j = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`, { timeout: 5000 });
    const price = parseFloat(j.lastPrice);
    if (!(price > 0)) return null;
    return {
      price,
      changePercent: parseFloat(j.priceChangePercent) || 0,
      change: parseFloat(j.priceChange) || 0,
      high: parseFloat(j.highPrice) || 0,
      low: parseFloat(j.lowPrice) || 0,
      open: parseFloat(j.openPrice) || 0,
      prevClose: parseFloat(j.prevClosePrice) || 0,
      name: sym,
    };
  },
  async (sym) => { // CoinGecko (仅支持映射表内币种)
    const idMap = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin" };
    const id = idMap[sym];
    if (!id) return null;
    const j = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { timeout: 5000 });
    const price = parseFloat(j?.[id]?.usd);
    return price > 0 ? flatQuote(price, sym) : null;
  },
  async (sym) => { // Gate.io (有 24h 涨跌)
    const arr = await fetchJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${sym}_USDT`, { timeout: 5000 });
    const item = Array.isArray(arr) ? arr[0] : null;
    const price = parseFloat(item?.last);
    if (!(price > 0)) return null;
    const changePercent = parseFloat(item?.change_percentage) || 0;
    const prevClose = changePercent ? price / (1 + changePercent / 100) : price;
    return {
      price,
      changePercent,
      change: price - prevClose,
      high: parseFloat(item?.high_24h) || price,
      low: parseFloat(item?.low_24h) || price,
      open: prevClose,
      prevClose,
      name: sym,
    };
  },
];

async function fetchCryptoPrices(symbols) {
  if (!symbols.length) return {};
  const results = {};
  await Promise.all(symbols.map(async (sym) => {
    for (const source of CRYPTO_SOURCES) {
      try {
        const q = await source(sym);
        if (q) { results[`crypto.${sym}`] = q; return; }
      } catch (e) { /* 换下一个源 */ }
    }
  }));
  return results;
}

// Convert holding to Sina API symbol format
function toSinaSymbol(h) {
  const isUS = (m) => m === "nasdaq" || m === "nyse";
  if (h.market === "sh") return `sh${h.symbol}`;
  if (h.market === "sz") return `sz${h.symbol}`;
  if (h.market === "hk") return `hk${h.symbol}`;
  if (h.market === "fund") return `f_${h.symbol}`;
  if (isUS(h.market)) return `gb_${h.symbol.toLowerCase()}`;
  return null;
}

// Fetch stock prices from Sina Finance API (works globally)
async function fetchStockPrices(holdings) {
  if (!holdings.length) return {};
  const symbolMap = {};
  const sinaSymbols = [];
  holdings.forEach((h) => {
    const ss = toSinaSymbol(h);
    if (ss) {
      sinaSymbols.push(ss);
      symbolMap[ss] = h;
    }
  });
  const url = `https://hq.sinajs.cn/list=${sinaSymbols.join(",")}`;

  let data;
  try {
    // Sina hq 接口返回 GBK 编码,中文名(如 VOO「标普500指数ETF」)按 UTF-8 拼接会乱码 → fetchBody gbk 解码
    data = await fetchBody(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://finance.sina.com.cn",
      },
      gbk: true,
    });
  } catch (e) {
    console.error("Sina API error:", e.message);
    return fetchStockPricesEastMoney(holdings);
  }
  try {
    const prices = {};
    const lines = data.split("\n").filter((l) => l.trim());
    lines.forEach((line) => {
      const match = line.match(/var hq_str_(\w+)="(.*)"/);
      if (!match || !match[2]) return;
      const sinaKey = match[1];
      const parts = match[2].split(",");
      const h = symbolMap[sinaKey];
      if (!h) return;

      const isUS = h.market === "nasdaq" || h.market === "nyse";
      const isHK = h.market === "hk";
      let price, open, high, low, prevClose, name;

      if (isUS) {
        // Sina US fields:
        // [0]name [1]price [2]changePct% [3]timestamp [4]change [5]open [6]high [7]low
        // [21]afterHoursPrice [22]ahChangePct% [23]ahChange [24]ahTime [25]closeTime [26]closePrice
        name = parts[0] || h.symbol;
        const regPrice = parseFloat(parts[1]) || 0;
        const regChangePct = parseFloat(parts[2]) || 0;
        const regChange = parseFloat(parts[4]) || 0;
        const ahPrice = parseFloat(parts[21]) || 0;
        const ahChangePct = parseFloat(parts[22]) || 0;
        const ahChange = parseFloat(parts[23]) || 0;
        const closePrice = parseFloat(parts[26]) || 0;

        // Detect pre-market: regPrice differs from closePrice, no after-hours price
        const isPreMarket = !ahPrice && closePrice > 0 && regPrice > 0 && Math.abs(regPrice - closePrice) > 0.001;

        // Use after-hours price if available, then check pre-market, otherwise regular price
        if (ahPrice > 0) {
          price = ahPrice;
          // After-hours change is relative to regular close
          prevClose = closePrice || (ahPrice - ahChange);
          const totalChange = price - prevClose;
          const totalChangePct = prevClose ? ((totalChange / prevClose) * 100) : 0;
          high = parseFloat(parts[6]) || price;
          low = parseFloat(parts[7]) || price;
          open = parseFloat(parts[5]) || price;
          const secid = `105.${h.symbol}`;
          if (h.market === "nasdaq") resolvedSecids[h.symbol] = `105.${h.symbol}`;
          else if (h.market === "nyse") resolvedSecids[h.symbol] = `106.${h.symbol}`;
          prices[resolvedSecids[h.symbol] || secid] = {
            price, changePercent: parseFloat(totalChangePct.toFixed(2)),
            change: parseFloat(totalChange.toFixed(4)), name,
            high, low, open, prevClose, afterHours: true,
          };
        } else if (isPreMarket) {
          price = regPrice;
          prevClose = closePrice;
          const totalChange = price - prevClose;
          const totalChangePct = prevClose ? ((totalChange / prevClose) * 100) : 0;
          high = parseFloat(parts[6]) || price;
          low = parseFloat(parts[7]) || price;
          open = parseFloat(parts[5]) || price;
          const secid = `105.${h.symbol}`;
          if (h.market === "nasdaq") resolvedSecids[h.symbol] = `105.${h.symbol}`;
          else if (h.market === "nyse") resolvedSecids[h.symbol] = `106.${h.symbol}`;
          prices[resolvedSecids[h.symbol] || secid] = {
            price, changePercent: parseFloat(totalChangePct.toFixed(2)),
            change: parseFloat(totalChange.toFixed(4)), name,
            high, low, open, prevClose, preMarket: true,
          };
        } else {
          price = regPrice;
          prevClose = price - regChange;
          high = parseFloat(parts[6]) || price;
          low = parseFloat(parts[7]) || price;
          open = parseFloat(parts[5]) || price;
          const secid = `105.${h.symbol}`;
          if (h.market === "nasdaq") resolvedSecids[h.symbol] = `105.${h.symbol}`;
          else if (h.market === "nyse") resolvedSecids[h.symbol] = `106.${h.symbol}`;
          prices[resolvedSecids[h.symbol] || secid] = {
            price, changePercent: regChangePct, change: regChange, name,
            high, low, open, prevClose,
          };
        }
      } else if (h.market === "fund") {
        // Fund: name,NAV,cumNAV,prevNAV,date,totalShares
        name = parts[0] || h.symbol;
        price = parseFloat(parts[1]) || 0;
        prevClose = parseFloat(parts[3]) || 0;
        const change = price - prevClose;
        const changePct = prevClose ? ((change / prevClose) * 100) : 0;
        prices[`fund.${h.symbol}`] = {
          price, changePercent: parseFloat(changePct.toFixed(2)),
          change: parseFloat(change.toFixed(4)), name,
          high: price, low: price, open: price, prevClose,
        };
      } else {
        // A-share: name,open,prevClose,price,high,low,...
        name = parts[0] || h.symbol;
        open = parseFloat(parts[1]) || 0;
        prevClose = parseFloat(parts[2]) || 0;
        price = parseFloat(parts[3]) || 0;
        high = parseFloat(parts[4]) || 0;
        low = parseFloat(parts[5]) || 0;
        const change = price - prevClose;
        const changePct = prevClose ? ((change / prevClose) * 100) : 0;
        const secid = `${MARKET_MAP[h.market]}.${h.symbol}`;
        prices[secid] = {
          price, changePercent: parseFloat(changePct.toFixed(2)),
          change: parseFloat(change.toFixed(4)), name,
          high, low, open, prevClose,
        };
      }
    });
    return prices;
  } catch (e) {
    console.error("Sina API parse error:", e.message);
    // Fallback to East Money API
    return fetchStockPricesEastMoney(holdings);
  }
}

// Fallback: East Money API (may not work from overseas)
async function fetchStockPricesEastMoney(holdings) {
  if (!holdings.length) return {};
  const isUS = (m) => m === "nasdaq" || m === "nyse";
  const secidList = [];
  holdings.forEach((h) => {
    if (isUS(h.market)) {
      US_PREFIXES.forEach((p) => secidList.push(`${p}.${h.symbol}`));
    } else {
      secidList.push(`${MARKET_MAP[h.market]}.${h.symbol}`);
    }
  });
  const secids = secidList.join(",");
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?ut=fa5fd1943c7b386f172d6893dbfba10b&invt=2&fltt=2&fields=f2,f3,f4,f12,f13,f14,f15,f16,f17,f18&secids=${secids}`;

  try {
    const json = await fetchJson(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://www.eastmoney.com",
      },
    });
    const prices = {};
    if (json.data && json.data.diff) {
      json.data.diff.forEach((item) => {
        prices[`${item.f13}.${item.f12}`] = {
          price: typeof item.f2 === "number" ? item.f2 : 0,
          changePercent: typeof item.f3 === "number" ? item.f3 : 0,
          change: typeof item.f4 === "number" ? item.f4 : 0,
          name: item.f14 || "",
          high: typeof item.f15 === "number" ? item.f15 : 0,
          low: typeof item.f16 === "number" ? item.f16 : 0,
          open: typeof item.f17 === "number" ? item.f17 : 0,
          prevClose: typeof item.f18 === "number" ? item.f18 : 0,
        };
      });
    }
    return prices;
  } catch (e) {
    console.warn("EastMoney 行情失败:", e.message);
    return {};
  }
}

// Fetch all prices (stocks + crypto)
// 场外基金: 从 fundgz 取干净 UTF-8 名字 + 单位净值 dwjz (Sina 返回 GBK,中文名会乱码)
// dwjz 是「上一交易日确认净值」,一天才变一次,故 1 小时抓一次足够(原来随主循环 10-15s 一抓纯属浪费);
// 基金的实时市值仍由批量 Sina f_ 报价每轮提供,本缓存只管名字+净值兜底,不影响刷新。
let _fundgzCache = {};
let _fundgzLastFetch = 0;
const FUNDGZ_INTERVAL = 60 * 60 * 1000; // 1h
function fetchFundgz(holdings) {
  const funds = holdings.filter((h) => h.market === "fund");
  if (!funds.length) return Promise.resolve({});
  // 命中缓存: 距上次成功抓取 <1h、且缓存已覆盖当前所有基金 → 直接返回,不发请求
  // (新增基金时 cache 未覆盖,会立即重抓;一轮全失败时回退旧缓存,不清空)
  const covered = funds.every((h) => _fundgzCache[h.symbol]);
  if (covered && Object.keys(_fundgzCache).length && Date.now() - _fundgzLastFetch < FUNDGZ_INTERVAL) {
    return Promise.resolve(_fundgzCache);
  }
  return Promise.all(funds.map(async (h) => {
    try {
      const d = await fetchBody(`https://fundgz.1234567.com.cn/js/${h.symbol}.js`, {
        headers: { Referer: "https://fund.eastmoney.com/" },
        timeout: 5000,
      });
      const m = d.match(/jsonpgz\((.*)\)/);  // JSONP 包装,非纯 JSON
      const j = m ? JSON.parse(m[1]) : null;
      return j && j.fundcode ? { symbol: j.fundcode, name: j.name, nav: parseFloat(j.dwjz) || 0 } : null;
    } catch { return null; }
  })).then((arr) => {
    const out = {};
    arr.filter(Boolean).forEach((x) => { out[x.symbol] = x; });
    if (Object.keys(out).length) { _fundgzCache = out; _fundgzLastFetch = Date.now(); } // 仅成功才刷新缓存与时间戳
    return Object.keys(out).length ? out : _fundgzCache;                                  // 本轮全失败 → 回退旧缓存
  });
}

// 上交所 ETF 实时参考净值(IOPV): 供前端算场内溢价(现价 ÷ IOPV − 1, 与同花顺口径一致)。
// 数据源=上交所官方行情 yunhq.sse.com.cn。
// 只针对 market=sh 的 ETF(5 开头); 每 60 秒最多抓一次; 失败静默、沿用上一轮缓存; 不影响任何取价路径。
let _iopvCache = {};
let _iopvLastFetch = 0;
const IOPV_INTERVAL = 60 * 1000;
async function fetchIopv(holdings) {
  const codes = [...new Set(holdings.filter((h) => h.market === "sh" && /^5\d{5}$/.test(String(h.symbol))).map((h) => h.symbol))];
  if (!codes.length) return {};
  if (Date.now() - _iopvLastFetch < IOPV_INTERVAL && codes.every((c) => _iopvCache[c])) return _iopvCache;
  const out = { ..._iopvCache };
  await Promise.all(codes.map(async (code) => {
    try {
      const j = await fetchJson(`https://yunhq.sse.com.cn:32042/v1/sh1/snap/${code}?select=iopv,time`, { timeout: 5000 });
      const snap = j && Array.isArray(j.snap) ? j.snap : null;
      const iopv = snap ? Number(snap[0]) : 0;
      if (iopv > 0) {
        const t = String(snap[1] || "").padStart(6, "0");
        out[code] = { iopv, time: `${t.slice(0, 2)}:${t.slice(2, 4)}`, date: String(j.date || ""), at: Date.now() };
      }
    } catch (e) { /* 静默: 沿用旧值 */ }
  }));
  _iopvCache = out; _iopvLastFetch = Date.now();
  return out;
}

async function fetchPrices(holdings) {
  if (TEST_MODE && process.env.STOCK_TEST_QUOTES) {
    const delay = parseInt(process.env.STOCK_TEST_QUOTE_DELAY_MS, 10);
    if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try { return JSON.parse(process.env.STOCK_TEST_QUOTES); }
    catch (e) { throw new Error(`STOCK_TEST_QUOTES 非法: ${e.message}`); }
  }
  const stockHoldings = holdings.filter((h) => h.market !== "crypto");  // includes fund
  const cryptoSymbols = holdings.filter((h) => h.market === "crypto").map((h) => h.symbol);
  const [stockPrices, cryptoPrices, fundgz, iopv] = await Promise.all([
    fetchStockPrices(stockHoldings),
    fetchCryptoPrices(cryptoSymbols),
    fetchFundgz(stockHoldings),
    fetchIopv(stockHoldings),
  ]);
  // 沪市 ETF 挂上 IOPV(仅附加字段, 不动价格)
  for (const code in iopv) {
    const key = `${MARKET_MAP.sh}.${code}`;   // 行情表键与 getData 取价一致: "1.513650"
    if (!stockPrices[key]) continue;
    stockPrices[key].iopv = iopv[code].iopv;
    stockPrices[key].iopvTime = iopv[code].time;
  }
  // 用 fundgz 干净名字覆盖基金名;并以 fundgz 的 dwjz(官方确认单位净值)为准——
  // Sina f_ 对部分基金(如 021000)返回的是错/估值净值,会把持仓市值算歪,故 fundgz 有值即覆盖。
  for (const code in fundgz) {
    const key = `fund.${code}`;
    if (!stockPrices[key]) stockPrices[key] = {};
    const p = stockPrices[key];
    if (fundgz[code].name) p.name = fundgz[code].name;
    if (fundgz[code].nav > 0) {
      p.price = fundgz[code].nav;
      const prev = p.prevClose || 0;
      p.change = prev > 0 ? +(p.price - prev).toFixed(4) : 0;
      p.changePercent = prev > 0 ? +((p.change / prev) * 100).toFixed(2) : 0;
      p.high = p.high || p.price; p.low = p.low || p.price; p.open = p.open || p.price;
    }
  }
  return { ...stockPrices, ...cryptoPrices };
}

// 仅公开浏览器实际需要的前端资源。禁止按扩展名泛化放行，避免 server.js、
// package.json、备份文件或未来新增的服务端文件被静态下载。
const PUBLIC_STATIC_FILES = {
  "/m.html": ["m.html", "text/html; charset=utf-8"],
  "/tailwind.css": ["tailwind.css", "text/css; charset=utf-8"],
  "/chart.umd.min.js": ["chart.umd.min.js", "application/javascript; charset=utf-8"],
  "/classify.js": ["classify.js", "application/javascript; charset=utf-8"],
  "/sw.js": ["sw.js", "application/javascript; charset=utf-8"],
  "/manifest.json": ["manifest.json", "application/manifest+json; charset=utf-8"],
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
};

const staticResponseCache = new Map();
function staticCacheControl(pathname, urlObj) {
  if (pathname === "/" || pathname.endsWith(".html") || pathname === "/sw.js") return "no-cache";
  if (urlObj.search) return "public, max-age=31536000, immutable";
  return "public, max-age=86400, stale-while-revalidate=604800";
}

function loadStaticAsset(relativePath) {
  const filePath = path.join(__dirname, relativePath);
  const stat = fs.statSync(filePath);
  const cached = staticResponseCache.get(relativePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const body = fs.readFileSync(filePath);
  const asset = {
    body,
    gzip: body.length >= 1024 ? zlib.gzipSync(body, { level: zlib.constants.Z_BEST_SPEED }) : null,
    etag: `"${crypto.createHash("sha256").update(body).digest("base64url").slice(0, 24)}"`,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
  staticResponseCache.set(relativePath, asset);
  return asset;
}

function sendStatic(req, res, urlObj, relativePath, contentType) {
  try {
    const asset = loadStaticAsset(relativePath);
    const useGzip = !!asset.gzip && /(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers["accept-encoding"] || "");
    const body = useGzip ? asset.gzip : asset.body;
    const etag = useGzip ? asset.etag.replace(/"$/, "-gzip\"") : asset.etag;
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": staticCacheControl(urlObj.pathname, urlObj),
      ETag: etag,
      Vary: "Accept-Encoding",
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (useGzip) headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (e) {
    console.error(`静态资源读取失败 ${relativePath}:`, e.message);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, "http://localhost");

  // 请求体大小限制：>64KB 直接拒绝，防超大 body 耗内存(应用层 DoS)
  if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
    let _bodyBytes = 0;
    req.on("data", (chunk) => {
      _bodyBytes += chunk.length;
      if (_bodyBytes > 64 * 1024 && !res.headersSent) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "请求体过大" }));
        req.destroy();
      }
    });
  }

  const noStoreJsonHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  };

  const persistenceError = () => {
    res.writeHead(500, noStoreJsonHeaders);
    res.end(JSON.stringify({ ok: false, error: "数据保存失败，请稍后重试" }));
  };
  const persistPortfolio = (portfolio) => {
    if (savePortfolio(portfolio)) return true;
    persistenceError();
    return false;
  };
  const persistJournal = (journal) => {
    if (saveJournalFile(journal)) return true;
    persistenceError();
    return false;
  };

  // 仅 NODE_ENV=test 可用，用于端到端测试验证全量和增量 WebSocket 推送；生产环境不存在该路由。
  if (TEST_MODE && urlObj.pathname === "/__test/refresh" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const groups = body ? JSON.parse(body).groups : null;
        const due = Array.isArray(groups) ? new Set(groups) : null;
        const successful = await refreshPrices(due);
        res.writeHead(200, noStoreJsonHeaders);
        res.end(JSON.stringify({ ok: true, successful: [...successful] }));
      } catch (e) {
        res.writeHead(500, noStoreJsonHeaders);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (urlObj.pathname === "/healthz" && req.method === "GET") {
    const now = Date.now();
    const freshness = serializeFreshness(quoteFreshness, marketFreshness, now);
    const status = evaluateQuoteHealth(freshness, {
      now,
      startedAt: PROCESS_STARTED_AT,
      refreshInFlight: _refreshing,
      refreshStartedAt: _refreshStartedAt,
      shuttingDown,
    });
    const body = {
      ...status,
      uptimeSeconds: Math.floor(process.uptime()),
      refresh: {
        inFlight: _refreshing,
        generation: _refreshGeneration,
        startedAt: _refreshStartedAt ? new Date(_refreshStartedAt).toISOString() : null,
        lastCompletedAt: _lastRefreshCompletedAt ? new Date(_lastRefreshCompletedAt).toISOString() : null,
      },
      freshness,
      history: {
        snapshots: memHistory.snapshots.length,
        checkpointPending: !!historyCheckpointTimer,
      },
      shuttingDown,
    };
    res.writeHead(status.healthy ? 200 : 503, noStoreJsonHeaders);
    res.end(JSON.stringify(body));
    return;
  }

  // 首页: 手机访问给手机页, 电脑访问给电脑页; 也可以直接打开 /m.html 或 /index.html
  if ((req.method === "GET" || req.method === "HEAD") && urlObj.pathname === "/") {
    const ua = String(req.headers["user-agent"] || "");
    const mobile = /iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone/i.test(ua);
    sendStatic(req, res, urlObj, mobile ? "m.html" : "index.html", "text/html; charset=utf-8");
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && urlObj.pathname === "/index.html") {
    sendStatic(req, res, urlObj, "index.html", "text/html; charset=utf-8");
    return;
  }

  const staticFile = PUBLIC_STATIC_FILES[urlObj.pathname];
  if (staticFile && (req.method === "GET" || req.method === "HEAD")) {
    const [relativePath, contentType] = staticFile;
    sendStatic(req, res, urlObj, relativePath, contentType);
    return;
  }

  // 读取持仓/规则/历史默认要登录(PUBLIC_READ=1 时放开只读)
  if (req.method === "GET" && READ_APIS.has(urlObj.pathname) && !PUBLIC_READ && !checkAuth(req)) {
    res.writeHead(401, noStoreJsonHeaders);
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // 个人规则: DATA_DIR/plan.json, 没有时用仓库里的 plan.example.json
  if (urlObj.pathname === "/plan.json" && req.method === "GET") {
    res.writeHead(200, noStoreJsonHeaders);
    res.end(JSON.stringify(loadPlan()));
    return;
  }

  // API: 设置/删除单只标的的买入规则(写 DATA_DIR/plan.json; 首次写入时以示例规则为底)
  // body: { symbol, rule }  rule=null 删除; rule={ type: open|seal|band, openBelowPct, sealAtPct, targetShares?, why? }
  if (urlObj.pathname === "/api/plan/symbol" && req.method === "PUT") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
      let args;
      try { args = JSON.parse(body || "{}"); } catch { res.writeHead(400); res.end("请求格式错误"); return; }
      const sym = String(args.symbol || "").trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,15}$/.test(sym)) { res.writeHead(400); res.end("标的代码不合法"); return; }
      let rule = null;
      if (args.rule !== null && args.rule !== undefined) {
        const r = args.rule, type = String(r.type || "");
        if (!["open", "seal", "band"].includes(type)) { res.writeHead(400); res.end("规则类型只能是 open / seal / band"); return; }
        rule = { type };
        if (type === "band") {
          const lo = Number(r.openBelowPct), hi = Number(r.sealAtPct);
          if (!(lo >= 0 && lo <= 100 && hi > 0 && hi <= 100 && lo <= hi)) { res.writeHead(400); res.end("占比需在 0–100 之间, 且「可加」不高于「封仓」"); return; }
          rule.openBelowPct = lo; rule.sealAtPct = hi;
          if (r.targetShares !== undefined && r.targetShares !== null && r.targetShares !== "") {
            const t = Number(r.targetShares);
            if (!(t > 0)) { res.writeHead(400); res.end("目标股数需大于 0"); return; }
            rule.targetShares = t;
          }
        }
        if (r.why) rule.why = String(r.why).slice(0, 200);
      }
      const plan = JSON.parse(JSON.stringify(loadPlan() || {}));
      plan.channels = plan.channels || {};
      plan.channels.symbols = plan.channels.symbols || {};
      if (rule) plan.channels.symbols[sym] = rule; else delete plan.channels.symbols[sym];
      try {
        const tmp = PLAN_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(plan, null, 1) + "\n");
        fs.renameSync(tmp, PLAN_FILE);
      } catch (e) { res.writeHead(500, noStoreJsonHeaders); res.end(JSON.stringify({ ok: false, error: "规则保存失败" })); return; }
      res.writeHead(200, noStoreJsonHeaders);
      res.end(JSON.stringify({ ok: true, symbol: sym, rule }));
    });
    return;
  }

  // API: get portfolio
  if (urlObj.pathname === "/api/portfolio" && req.method === "GET") {
    res.writeHead(200, noStoreJsonHeaders);
    res.end(JSON.stringify(loadPortfolio()));
    return;
  }

  // 可选的备份导出接口(需设置 BACKUP_TOKEN 并在请求头 X-Backup-Token 带上)：先把 journal 原子归并，再返回一致的 history.json 视图。
  if (urlObj.pathname === "/api/internal/history-export" && req.method === "GET") {
    const ip = req.socket.remoteAddress || "";
    const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!loopback && !validBackupToken(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "loopback only" }));
      return;
    }
    writeHistoryExport(res);
    return;
  }

  // 历史/基准按需读取，不再塞进每 10~15 秒一次的实时数据包。
  if (urlObj.pathname === "/api/history" && req.method === "GET") {
    const wantsBenchmarks = urlObj.searchParams.get("benchmarks") === "1";
    const retryAfter = takeRateLimit(req, wantsBenchmarks ? "history-benchmarks" : "history", wantsBenchmarks ? 6 : 30, 60 * 1000);
    if (retryAfter) { rejectRateLimited(res, retryAfter); return; }
    const send = () => {
      res.writeHead(200, noStoreJsonHeaders);
      res.end(JSON.stringify(historyPayload(urlObj)));
    };
    if (wantsBenchmarks) {
      refreshBenchmarks().catch(() => {}).then(send);
    } else {
      send();
    }
    return;
  }

  // API: get current dashboard state (history/benchmarks use /api/history)
  // API: IB 自动同步状态。不提供手动触发, 只按定时自动同步(避免频繁请求撞上 IB 限流)
  if (urlObj.pathname === "/api/ib-sync" && req.method === "GET") {
    res.writeHead(200, noStoreJsonHeaders);
    res.end(JSON.stringify(ibSync.status({ detailed: checkAuth(req) })));
    return;
  }
  // API: 一次性处理 IB 场外加数(看板某只股票另含 IB 之外的股数): 卖出后记一笔卖出并清零(需登录)
  if (urlObj.pathname === "/api/ib-sync/extra" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const retryAfter = takeRateLimit(req, "ib-extra", 5, 60 * 1000);
    if (retryAfter) { rejectRateLimited(res, retryAfter); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let args;
      try { args = JSON.parse(body || "{}"); } catch { res.writeHead(400); res.end("请求格式错误"); return; }
      ibSync.clearExtra(args.symbol, { mode: args.mode, price: args.price }).then((r) => {
        res.writeHead(200, noStoreJsonHeaders); res.end(JSON.stringify(r));
      }, (e) => { res.writeHead(400); res.end(e.message); });
    });
    return;
  }

  if (urlObj.pathname === "/api/data" && req.method === "GET") {
    const retryAfter = takeRateLimit(req, "data", 60, 60 * 1000);
    if (retryAfter) { rejectRateLimited(res, retryAfter); return; }
    res.writeHead(200, noStoreJsonHeaders);
    if (latestData) {
      res.end(JSON.stringify(latestData));
      return;
    }
    // 进程刚启动、首轮行情尚未完成时返回基础持仓；后台循环会自行刷新并通过 WS 推送。
    const portfolio = loadPortfolio();
    res.end(JSON.stringify({ exchangeRate: portfolio.exchangeRate, accounts: portfolio.accounts, timestamp: new Date().toISOString() }));
    return;
  }

  // API: auth
  if (urlObj.pathname === "/api/auth" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { password } = JSON.parse(body);
        const ip = clientIp(req);
        const wait = authLocked(ip);
        if (wait > 0) {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(wait) });
          res.end(JSON.stringify({ ok: false, error: `尝试过多，请 ${wait}s 后再试` }));
          return;
        }
        if (verifyPassword(password)) {
          authReset(ip);
          const token = generateToken();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, token }));
        } else {
          authFail(ip);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "密码错误" }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: add account (auth required)
  if (urlObj.pathname === "/api/account" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const acc = JSON.parse(body);
        const p = loadPortfolio();
        p.accounts.push({ name: acc.name, currency: acc.currency, holdings: [] });
        if (!persistPortfolio(p)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: add holding (auth required)
  if (urlObj.pathname === "/api/holding" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holding } = JSON.parse(body);
        const p = loadPortfolio();
        if (p.accounts[accountIndex]) {
          const nextHolding = { ...holding };
          if ((!nextHolding.transactions || !nextHolding.transactions.length) && nextHolding.shares > 0 && nextHolding.costPrice > 0) {
            nextHolding.transactions = [{
              type: "buy",
              shares: nextHolding.shares,
              price: nextHolding.costPrice,
              date: new Date().toISOString(),
            }];
          }
          const derivedHolding = deriveHoldingFromTransactions(nextHolding);
          p.accounts[accountIndex].holdings.push({
            ...nextHolding,
            shares: derivedHolding.shares,
            costPrice: derivedHolding.costPrice,
            transactions: derivedHolding.transactions,
          });
          if (!persistPortfolio(p)) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end("Invalid account");
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: update holding (auth required)
  if (urlObj.pathname === "/api/holding" && req.method === "PUT") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holdingIndex, shares, costPrice } = JSON.parse(body);
        const p = loadPortfolio();
        if (p.accounts[accountIndex] && p.accounts[accountIndex].holdings[holdingIndex]) {
          const h = p.accounts[accountIndex].holdings[holdingIndex];
          const nextHolding = appendTradeToHolding(h, {
            type: "sync",
            shares,
            price: costPrice,
            date: new Date().toISOString(),
          });
          p.accounts[accountIndex].holdings[holdingIndex] = nextHolding;
          if (!persistPortfolio(p)) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end("Not found");
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: append trade record (auth required)
  if (urlObj.pathname === "/api/trade" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holdingIndex, trade } = JSON.parse(body);
        const p = loadPortfolio();
        if (p.accounts[accountIndex] && p.accounts[accountIndex].holdings[holdingIndex]) {
          const h = p.accounts[accountIndex].holdings[holdingIndex];
          p.accounts[accountIndex].holdings[holdingIndex] = appendTradeToHolding(h, trade);
          if (!persistPortfolio(p)) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end("Not found");
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: delete trade record (auth required)
  if (urlObj.pathname === "/api/trade" && req.method === "DELETE") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holdingIndex, tradeIndex } = JSON.parse(body);
        const p = loadPortfolio();
        const h = p.accounts?.[accountIndex]?.holdings?.[holdingIndex];
        if (!h) {
          res.writeHead(400);
          res.end("Not found");
          return;
        }
        const trades = Array.isArray(h.transactions) ? [...h.transactions] : [];
        if (tradeIndex < 0 || tradeIndex >= trades.length) {
          res.writeHead(400);
          res.end("Trade not found");
          return;
        }
        trades.splice(tradeIndex, 1);
        const derivedHolding = deriveHoldingFromTransactions({ ...h, transactions: trades });
        p.accounts[accountIndex].holdings[holdingIndex] = {
          ...h,
          shares: derivedHolding.shares,
          costPrice: derivedHolding.costPrice,
          transactions: derivedHolding.transactions,
        };
        if (!persistPortfolio(p)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: 基金申购在途下单 (auth) — 只记金额+日期,份额待确认
  if (urlObj.pathname === "/api/fund/order" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holdingIndex, amount, date, afterCutoff } = JSON.parse(body);
        const p = loadPortfolio();
        const h = p.accounts?.[accountIndex]?.holdings?.[holdingIndex];
        if (!h) { res.writeHead(400); res.end("Not found"); return; }
        const amt = parseFloat(amount);
        if (!Number.isFinite(amt) || amt <= 0) { res.writeHead(400); res.end("金额必须大于 0"); return; }
        const day = (date && /^\d{4}-\d{2}-\d{2}/.test(date)) ? String(date).slice(0, 10) : new Date().toISOString().slice(0, 10);
        if (!Array.isArray(h.orders)) h.orders = [];
        h.orders.push({ id: genOrderId(), amount: roundNum(amt, 2), date: day, afterCutoff: !!afterCutoff, status: "pending", createdAt: new Date().toISOString() });
        if (!persistPortfolio(p)) return;
        if (!TEST_MODE || process.env.STOCK_TEST_AUTO_CONFIRM === "1") {
          autoConfirmSubscriptions().catch(() => {}); // 立即尝试确认: 回填历史单且净值已发布时秒确认
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  // API: 基金申购校准/确认 (auth) — 填实际净值或实际份额即锁定
  if (urlObj.pathname === "/api/fund/calibrate" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holdingIndex, orderId, nav, shares } = JSON.parse(body);
        const p = loadPortfolio();
        const h = p.accounts?.[accountIndex]?.holdings?.[holdingIndex];
        if (!h || !Array.isArray(h.orders)) { res.writeHead(400); res.end("Not found"); return; }
        const o = h.orders.find((x) => x.id === orderId);
        if (!o) { res.writeHead(400); res.end("Order not found"); return; }
        let navV = parseFloat(nav), shV = parseFloat(shares);
        if (Number.isFinite(shV) && shV > 0) {
          navV = (Number.isFinite(navV) && navV > 0) ? navV : o.amount / shV;
        } else if (Number.isFinite(navV) && navV > 0) {
          shV = o.amount / navV;
        } else { res.writeHead(400); res.end("需提供净值或实际份额"); return; }
        o.status = "confirmed"; o.nav = roundNum(navV, 4); o.shares = roundNum(shV, 2);
        o.confirmDate = new Date().toISOString(); o.auto = false; o.calibrated = true;
        const updated = applyOrderConfirmation(h, o, navV, shV);
        p.accounts[accountIndex].holdings[holdingIndex] = { ...updated, orders: h.orders };
        if (!persistPortfolio(p)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  // API: 删除基金申购单 (auth) — 已确认的连同关联 buy 交易一并移除
  if (urlObj.pathname === "/api/fund/order" && req.method === "DELETE") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { accountIndex, holdingIndex, orderId } = JSON.parse(body);
        const p = loadPortfolio();
        const h = p.accounts?.[accountIndex]?.holdings?.[holdingIndex];
        if (!h || !Array.isArray(h.orders)) { res.writeHead(400); res.end("Not found"); return; }
        const existed = h.orders.some((x) => x.id === orderId);
        h.orders = h.orders.filter((x) => x.id !== orderId);
        if (existed && Array.isArray(h.transactions)) {
          const tag = `申购#${orderId}`;
          h.transactions = h.transactions.filter((t) => !(t && t.note === tag));
        }
        p.accounts[accountIndex].holdings[holdingIndex] = syncHoldingSnapshot(h);
        if (!persistPortfolio(p)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  // API: delete holding (auth required)
  if (urlObj.pathname === "/api/holding" && req.method === "DELETE") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const ai = parseInt(urlObj.searchParams.get("account"));
    const hi = parseInt(urlObj.searchParams.get("index"));
    const p = loadPortfolio();
    if (p.accounts[ai] && p.accounts[ai].holdings[hi]) {
      p.accounts[ai].holdings.splice(hi, 1);
      if (!persistPortfolio(p)) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(400);
      res.end("Not found");
    }
    return;
  }

  // API: update cash position
  if (urlObj.pathname === "/api/cash" && req.method === "PUT") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { account, cash } = JSON.parse(body);
        const ai = parseInt(account);
        const p = loadPortfolio();
        if (p.accounts[ai]) {
          p.accounts[ai].cash = parseFloat(cash) || 0;
          if (!persistPortfolio(p)) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end("Account not found");
        }
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: update exchange rate
  if (urlObj.pathname === "/api/rate" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { rate } = JSON.parse(body);
        const p = loadPortfolio();
        p.exchangeRate = { USD_CNY: parseFloat(rate) };
        if (!persistPortfolio(p)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // API: journal CRUD
  if (urlObj.pathname === "/api/journal" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadJournal()));
    return;
  }

  if (urlObj.pathname === "/api/journal" && req.method === "POST") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const entry = JSON.parse(body);
        const list = loadJournalFile();
        entry.date = new Date().toISOString();
        list.unshift(entry);
        if (!persistJournal(list)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  if (urlObj.pathname === "/api/journal" && req.method === "PUT") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { index, entry } = JSON.parse(body);
        const list = loadJournalFile();
        if (index >= 0 && index < list.length) {
          entry.editDate = new Date().toISOString();
          entry.date = list[index].date;
          list[index] = entry;
          if (!persistJournal(list)) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400); res.end("Invalid index");
        }
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  if (urlObj.pathname === "/api/journal" && req.method === "DELETE") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { index } = JSON.parse(body);
        const list = loadJournalFile();
        if (index >= 0 && index < list.length) {
          list.splice(index, 1);
          if (!persistJournal(list)) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400); res.end("Invalid index");
        }
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ---- K-line & Technical Analysis ----
const klineCache = {};
let cachedCorrelation = null;
const KLINE_ACTIVE_INTERVAL = 10 * 60 * 1000;
const KLINE_CLOSED_INTERVAL = 6 * 60 * 60 * 1000;
const resolvedSecids = {}; // cache correct secid for US stocks
const klineLastFetchByGroup = new Map();

function fetchKline(secid) {
  // East Money 优先, 失败走腾讯兜底, 仍为空则返回 [] (K-line is best-effort)
  return fetchKlineAny(secid);
}

async function fetchKlineEastMoney(secid) {
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=120`;
    const j = await fetchJson(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", Referer: "https://www.eastmoney.com" },
      timeout: 8000,
    });
    if (!j.data || !j.data.klines) return [];
    return j.data.klines.map((k) => {
      const [date, open, close, high, low, vol] = k.split(",");
      return { date, o: +open, c: +close, h: +high, l: +low, v: +vol };
    });
  } catch (e) { return []; }
}

// 腾讯 K 线兜底: 东财 push2his 在部分网络环境下返回连接重置(基准指数/个股日K全部为空), 腾讯 ifzq 可达。
// secid → 腾讯代码: "1.513100"→sh513100, "0.000001"→sz000001, "105.GOOGL"→usGOOGL, "116.00700"→hk00700, "100.NDX"→usNDX
// 实测: 美股指数要写 us.INX / us.NDX(带点); 美股个股/ETF 要带交易所后缀 usGOOGL.OQ(纳斯达克) / usXXX.N(纽交所), 不带后缀只返回 1 天; 沪深 sh000300/sh513100 直接可用
function tencentCodesFromSecid(secid) {
  const [mkt, code] = String(secid).split(".");
  if (!code) return [];
  if (mkt === "1") return [`sh${code}`];
  if (mkt === "0") return [`sz${code}`];
  if (mkt === "116") return [`hk${code}`];
  if (mkt === "100") return [`us.${code === "SPX" ? "INX" : code}`];
  if (mkt === "105") return [`us${code}.OQ`, `us${code}.N`];
  if (mkt === "106" || mkt === "107") return [`us${code}.N`, `us${code}.OQ`];
  return [];
}
async function fetchKlineTencent(secid, n = 120) {
  for (const code of tencentCodesFromSecid(secid)) {
    try {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${n},qfq`;
      const j = await fetchJson(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
      const d = j && j.data && j.data[code];
      const rows = d && (d.qfqday || d.day);
      if (!Array.isArray(rows) || rows.length < 2) continue;   // 只返回 1 天 = 代码/后缀不对, 换下一个
      return rows.map((r) => ({ date: r[0], o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] })).filter((k) => Number.isFinite(k.c));
    } catch (e) { /* 试下一个代码 */ }
  }
  return [];
}
async function fetchKlineAny(secid) {
  const k = await fetchKlineEastMoney(secid);
  return k.length ? k : fetchKlineTencent(secid);
}

function calcTechnicals(klines, curPrice, costPrice) {
  if (!klines.length || !curPrice) return null;
  const closes = klines.map((k) => k.c);
  const highs = klines.map((k) => k.h);
  const lows = klines.map((k) => k.l);

  const ma = (arr, n) => arr.length >= n ? +(arr.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(4) : null;
  const ma5 = ma(closes, 5), ma10 = ma(closes, 10), ma20 = ma(closes, 20), ma60 = ma(closes, 60);

  const high60 = Math.max(...highs), low60 = Math.min(...lows);
  const high20 = Math.max(...highs.slice(-20)), low20 = Math.min(...lows.slice(-20));

  // Fibonacci retracement from 60-day range
  const range = high60 - low60;
  const fib236 = +(low60 + range * 0.236).toFixed(4);
  const fib382 = +(low60 + range * 0.382).toFixed(4);
  const fib500 = +(low60 + range * 0.5).toFixed(4);
  const fib618 = +(low60 + range * 0.618).toFixed(4);

  // Find local minimums as support (scan last 60 bars)
  const localMins = [];
  const scan = klines.slice(-60);
  for (let i = 2; i < scan.length - 2; i++) {
    if (scan[i].l < scan[i - 1].l && scan[i].l < scan[i - 2].l && scan[i].l < scan[i + 1].l && scan[i].l < scan[i + 2].l) {
      localMins.push(scan[i].l);
    }
  }

  // Collect support levels below current price
  const supSet = new Set();
  [ma5, ma10, ma20, ma60].forEach((m) => { if (m && m < curPrice && m > curPrice * 0.7) supSet.add(+m.toFixed(3)); });
  [fib382, fib500, fib236].forEach((f) => { if (f < curPrice && f > curPrice * 0.7) supSet.add(f); });
  localMins.forEach((m) => { if (m < curPrice && m > curPrice * 0.7) supSet.add(m); });
  if (low20 < curPrice) supSet.add(low20);
  const supports = [...supSet].sort((a, b) => b - a).slice(0, 4);

  // Resistance levels above current price
  const resSet = new Set();
  [ma5, ma10, ma20, ma60].forEach((m) => { if (m && m > curPrice && m < curPrice * 1.3) resSet.add(+m.toFixed(3)); });
  [fib618, fib500].forEach((f) => { if (f > curPrice && f < curPrice * 1.3) resSet.add(f); });
  if (high20 > curPrice) resSet.add(high20);
  const resistances = [...resSet].sort((a, b) => a - b).slice(0, 3);

  // Recommended entry levels: support levels below current price, plus -5% / -10% from cost if in loss
  const entries = [];
  supports.slice(0, 3).forEach((s) => entries.push({ price: s, reason: "支撑位" }));
  if (costPrice && curPrice < costPrice) {
    const avg = +(costPrice * 0.9).toFixed(4);
    if (avg < curPrice && !entries.find((e) => Math.abs(e.price - avg) / avg < 0.01)) {
      entries.push({ price: avg, reason: "成本-10%" });
    }
  }
  // Sort by price descending
  entries.sort((a, b) => b.price - a.price);

  return { ma5, ma10, ma20, ma60, high60, low60, high20, low20, fib382, fib500, fib618, supports, resistances, entries: entries.slice(0, 4) };
}

async function refreshKlines(prices) {
  const now = Date.now();
  const portfolio = loadPortfolio();
  const tasks = [];
  const dueGroups = new Set();
  const date = new Date(now);
  (portfolio.accounts || []).forEach((acc) => (acc.holdings || []).forEach((h) => {
    const group = marketGroupForHolding(fixMarket(h));
    if (group === "crypto" || group === "fund" || group === "other") return;
    const interval = !marketSession(group, date).active
      ? KLINE_CLOSED_INTERVAL
      : KLINE_ACTIVE_INTERVAL;
    if (now - (klineLastFetchByGroup.get(group) || 0) >= interval) dueGroups.add(group);
  }));
  if (!dueGroups.size) return;
  dueGroups.forEach((group) => klineLastFetchByGroup.set(group, now));
  console.log(`Refreshing K-line data (${[...dueGroups].join(",")})...`);

  portfolio.accounts.forEach((acc) => {
    acc.holdings.forEach((h) => {
      const fixed = fixMarket(h);
      if (!dueGroups.has(marketGroupForHolding(fixed))) return;
      let secid;
      const isUS = fixed.market === "nasdaq" || fixed.market === "nyse";
      if (isUS) {
        if (resolvedSecids[fixed.symbol]) {
          secid = resolvedSecids[fixed.symbol];
        } else {
          for (const pfx of US_PREFIXES) {
            if (prices[`${pfx}.${fixed.symbol}`]) {
              secid = `${pfx}.${fixed.symbol}`;
              resolvedSecids[fixed.symbol] = secid;
              break;
            }
          }
        }
      } else {
        secid = `${MARKET_MAP[fixed.market]}.${fixed.symbol}`;
      }
      if (secid) {
        tasks.push(fetchKline(secid).then((klines) => { klineCache[fixed.symbol] = klines; }));
      }
    });
  });
  await Promise.all(tasks);
  cachedCorrelation = calcCorrelationMatrix();
  _analysisRevision += 1; // 下一轮低频发一次完整包，带上新的技术指标/相关性
  console.log(`K-line data updated for ${tasks.length} stocks`);
}

// ---- Benchmarks ----
const BENCHMARKS = [
  { name: "沪深300", secid: "1.000300" },
  { name: "纳斯达克", secid: "100.NDX" },
  { name: "标普500", secid: "100.SPX" },
];
const benchmarkCache = {};
let bmLastFetch = 0;
let bmRefreshPromise = null;
let bmNextFetchAt = 0;

async function refreshBenchmarks() {
  const now = Date.now();
  if (now < bmNextFetchAt) return;
  if (bmRefreshPromise) return bmRefreshPromise;
  bmRefreshPromise = (async () => {
    let updated = 0;
    await Promise.all(BENCHMARKS.map((bm) =>
      fetchKlineAny(bm.secid).then((k) => {
        if (k.length) { benchmarkCache[bm.name] = k; updated += 1; }
      }).catch(() => {})
    ));
    bmLastFetch = Date.now();
    // 成功缓存 30 分钟；全部失败也冷却 1 分钟，避免公网请求连续打上游。
    bmNextFetchAt = bmLastFetch + (updated > 0 ? 30 * 60 * 1000 : 60 * 1000);
  })().finally(() => { bmRefreshPromise = null; });
  return bmRefreshPromise;
}

// ---- Risk Metrics ----
function calcRiskMetrics(snapshots) {
  if (!snapshots || snapshots.length < 5) return null;

  // Use snapshots directly (minute-level), sample every 5 points for smoothing
  const pts = snapshots.length > 100
    ? snapshots.filter((_, i) => i % 5 === 0 || i === snapshots.length - 1)
    : snapshots;
  if (pts.length < 3) return null;

  const returns = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].v > 0) returns.push((pts[i].v - pts[i - 1].v) / pts[i - 1].v);
  }
  if (returns.length < 2) return null;

  // Max Drawdown
  let peak = pts[0].v, maxDD = 0;
  pts.forEach((s) => { if (s.v > peak) peak = s.v; const dd = peak > 0 ? (peak - s.v) / peak : 0; if (dd > maxDD) maxDD = dd; });

  // Volatility - scale to annualized based on data frequency
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  // Estimate periods per year: if data spans < 1 day, use intraday scaling
  const spanMs = new Date(pts[pts.length - 1].t) - new Date(pts[0].t);
  const spanDays = Math.max(spanMs / 86400000, 0.01);
  const periodsPerYear = (returns.length / spanDays) * 252;
  const annualVol = Math.sqrt(variance) * Math.sqrt(periodsPerYear);

  // Returns: 年化需要 >= 30 天数据才有参考价值, 否则直接用累计收益, 避免短窗口外推产生天文数字
  const totalReturn = pts[0].v > 0 ? (pts[pts.length - 1].v - pts[0].v) / pts[0].v : 0;
  const annualReturn = spanDays >= 30
    ? Math.pow(1 + totalReturn, 365 / spanDays) - 1
    : totalReturn;

  return {
    maxDrawdown: +(maxDD * 100).toFixed(2),
    volatility: +(annualVol * 100).toFixed(2),
    annualReturn: +(annualReturn * 100).toFixed(2),
  };
}

// ---- Correlation Matrix ----
function calcCorrelationMatrix() {
  const symbols = Object.keys(klineCache).filter((s) => klineCache[s].length >= 10);
  if (symbols.length < 2) return null;
  const returnsMap = {};
  symbols.forEach((sym) => {
    returnsMap[sym] = {};
    const kl = klineCache[sym];
    for (let i = 1; i < kl.length; i++) {
      if (kl[i - 1].c > 0) returnsMap[sym][kl[i].date] = (kl[i].c - kl[i - 1].c) / kl[i - 1].c;
    }
  });

  // Get symbol names from portfolio
  const portfolio = loadPortfolio();
  const nameMap = {};
  portfolio.accounts.forEach((acc) => acc.holdings.forEach((h) => { nameMap[h.symbol] = h.name; }));

  const matrix = {};
  for (let i = 0; i < symbols.length; i++) {
    matrix[symbols[i]] = {};
    for (let j = 0; j < symbols.length; j++) {
      if (i === j) { matrix[symbols[i]][symbols[j]] = 1; continue; }
      const ra = [], rb = [];
      Object.keys(returnsMap[symbols[i]]).forEach((d) => {
        if (returnsMap[symbols[j]][d] !== undefined) { ra.push(returnsMap[symbols[i]][d]); rb.push(returnsMap[symbols[j]][d]); }
      });
      if (ra.length < 5) { matrix[symbols[i]][symbols[j]] = 0; continue; }
      const ma = ra.reduce((a, b) => a + b, 0) / ra.length;
      const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
      let cov = 0, va = 0, vb = 0;
      for (let k = 0; k < ra.length; k++) { cov += (ra[k] - ma) * (rb[k] - mb); va += (ra[k] - ma) ** 2; vb += (rb[k] - mb) ** 2; }
      matrix[symbols[i]][symbols[j]] = va > 0 && vb > 0 ? +(cov / Math.sqrt(va * vb)).toFixed(2) : 0;
    }
  }
  return { symbols, nameMap, matrix };
}

// ---- Journal ----
const JOURNAL_FILE = path.join(DATA_DIR, "journal.json");

function loadJournalFile() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf-8")); }
  catch (e) { return []; }
}

function saveJournalFile(list) {
  if (TEST_MODE && process.env.STOCK_TEST_FAIL_WRITES === "1") {
    console.error("saveJournal 写入失败: 测试注入失败");
    return false;
  }
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { console.error("saveJournal 写入失败:", e.message); return false; }
  triggerRefresh();
  return true;
}

function loadJournal() { return loadJournalFile(); }
function saveJournal(list) { return saveJournalFile(list); }

// WebSocket
// 浏览器仅接收服务端推送，不发送业务消息。限制入站帧并关闭压缩，进一步收紧资源消耗；
// ws 依赖本身固定在已修复微小分片内存耗尽 DoS 的版本。
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: false });
let latestData = null;
let lastKnownPrices = {}; // cache last valid prices to avoid API-failure zeros
const quoteFreshness = new Map();
const marketFreshness = new Map();

const REALTIME_HOLDING_FIELDS = [
  "currentPrice", "changePercent", "change", "marketValue", "pnl",
  "pnlPercent", "pendingEstShares",
];

function realtimePatch(result) {
  return {
    exchangeRate: result.exchangeRate,
    timestamp: result.timestamp,
    rateInfo: result.rateInfo,
    freshness: result.freshness,
    accounts: result.accounts.map((acc) => ({
      holdings: acc.holdings.map((h) => {
        const patch = { symbol: h.symbol, market: h.market };
        REALTIME_HOLDING_FIELDS.forEach((key) => { patch[key] = h[key]; });
        patch.quoteFreshness = h.quoteFreshness;
        return patch;
      }),
    })),
  };
}

function broadcastJson(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

// Persist lastKnownPrices to disk so cold restart shows last known prices
// instead of 0 while first refreshPrices() round completes.
const PRICES_CACHE_FILE = path.join(DATA_DIR, "prices_cache.json");
try {
  if (fs.existsSync(PRICES_CACHE_FILE)) {
    lastKnownPrices = JSON.parse(fs.readFileSync(PRICES_CACHE_FILE, "utf-8"));
    console.log(`Loaded ${Object.keys(lastKnownPrices).length} cached prices from disk`);
  }
} catch (e) { /* file missing/corrupt -> start with empty cache */ }

let _pricesCacheDirty = false;
function persistPricesCache() {
  if (!_pricesCacheDirty) return;
  _pricesCacheDirty = false;
  try { fs.writeFileSync(PRICES_CACHE_FILE, JSON.stringify(lastKnownPrices)); }
  catch (e) { console.error("pricesCache 写入失败:", e.message); }
}
// Flush at most once every 30s (writes are cheap but no need to spam)
setInterval(persistPricesCache, 30 * 1000);
let shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: flushing state before exit`);
  persistPricesCache();
  const exit = () => process.exit(exitCode);
  const forceExit = setTimeout(exit, 3000);
  if (forceExit.unref) forceExit.unref();
  if (historyCheckpointTimer) {
    checkpointHistory().finally(exit);
  } else {
    historyPersistChain.finally(exit);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

let _refreshing = false;
let _refreshGeneration = 0;
let _refreshStartedAt = 0;
let _lastRefreshCompletedAt = 0;

function quoteForHolding(prices, fixed) {
  if (fixed.market === "nasdaq" || fixed.market === "nyse") {
    return US_PREFIXES.map((prefix) => prices[`${prefix}.${fixed.symbol}`]).find((p) => p?.price > 0);
  }
  if (fixed.market === "crypto") return prices[`crypto.${fixed.symbol}`];
  if (fixed.market === "fund") return prices[`fund.${fixed.symbol}`];
  return prices[`${MARKET_MAP[fixed.market]}.${fixed.symbol}`];
}

async function refreshPrices(dueGroups = null) {
  if (_refreshing) return new Set(); // 上一轮未完则跳过，避免上游慢/挂起时多轮叠加堆积
  _refreshing = true;
  _refreshStartedAt = Date.now();
  const generation = ++_refreshGeneration;
  // 超时后使本轮失效并退出进程，由进程管理器(Docker restart / systemd)拉起干净实例。绝不提前释放锁，避免旧任务与新任务重叠。
  const _wd = setTimeout(() => {
    if (_refreshing && generation === _refreshGeneration) {
      _refreshGeneration += 1;
      console.error("refreshPrices watchdog: 60s 未完成，本轮作废并重启服务");
      shutdown("refreshPrices watchdog", 1);
    }
  }, 60000);
  if (_wd.unref) _wd.unref();
  try {
    await getExchangeRate();
    const portfolio = loadPortfolio();
    const portfolioRevision = _portfolioRevision;
    const allHoldings = [];
    portfolio.accounts.forEach((acc) => acc.holdings.forEach((h) => allHoldings.push(fixMarket(h))));
    const holdingsToFetch = dueGroups
      ? allHoldings.filter((h) => dueGroups.has(marketGroupForHolding(h)))
      : allHoldings;
    const freshPrices = holdingsToFetch.length ? await fetchPrices(holdingsToFetch) : {};
    if (!canCommitGeneration(generation, _refreshGeneration, shuttingDown)) return new Set();
    const attemptedAt = Date.now();
    const successfulGroups = new Set();
    const groupCounts = new Map();
    holdingsToFetch.forEach((h) => {
      const fixed = fixMarket(h);
      const group = marketGroupForHolding(fixed);
      const quote = quoteForHolding(freshPrices, fixed);
      const success = quote?.price > 0;
      const key = quoteKey(fixed);
      const previous = quoteFreshness.get(key) || {};
      quoteFreshness.set(key, {
        market: fixed.market,
        symbol: fixed.symbol,
        group,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: success ? attemptedAt : previous.lastSuccessAt || null,
        consecutiveFailures: success ? 0 : (previous.consecutiveFailures || 0) + 1,
        cached: !success && !!quoteForHolding(lastKnownPrices, fixed)?.price,
      });
      const counts = groupCounts.get(group) || { expected: 0, succeeded: 0 };
      counts.expected += 1;
      if (success) counts.succeeded += 1;
      groupCounts.set(group, counts);
    });
    for (const [group, counts] of groupCounts) {
      const complete = counts.expected === counts.succeeded;
      const previous = marketFreshness.get(group) || {};
      marketFreshness.set(group, {
        lastAttemptAt: attemptedAt,
        lastSuccessAt: counts.succeeded > 0 ? attemptedAt : previous.lastSuccessAt || null,
        lastCompleteSuccessAt: complete ? attemptedAt : previous.lastCompleteSuccessAt || null,
        consecutiveFailures: complete ? 0 : (previous.consecutiveFailures || 0) + 1,
        expected: counts.expected,
        succeeded: counts.succeeded,
        failed: counts.expected - counts.succeeded,
        nextAttemptAt: previous.nextAttemptAt || null,
      });
      if (complete) successfulGroups.add(group);
    }
    // Merge: keep last known price when fresh fetch returns 0 or missing
    const prices = { ...lastKnownPrices };
    for (const [k, v] of Object.entries(freshPrices)) {
      if (v && v.price > 0) {
        prices[k] = v;
        lastKnownPrices[k] = v;
        _pricesCacheDirty = true;
      }
    }
    // 此后到广播均为同步计算；记录分析缓存版本，避免 K 线在本轮中途更新时
    // 用旧 result 错误地确认了新版本，导致后续不再补发完整包。
    const analysisRevision = _analysisRevision;
    const freshness = serializeFreshness(quoteFreshness, marketFreshness);

    const result = {
      exchangeRate: portfolio.exchangeRate,
      accounts: portfolio.accounts.map((acc) => ({
        ...acc,
        holdings: acc.holdings.map((rawHolding) => {
          const h = deriveHoldingFromTransactions(rawHolding);
          const fixed = fixMarket(h);
          // For US stocks, match by symbol (since we try multiple prefixes)
          const isUS = fixed.market === "nasdaq" || fixed.market === "nyse";
          let p = {};
          if (isUS) {
            // Find by symbol across any US prefix
            for (const pfx of US_PREFIXES) {
              if (prices[`${pfx}.${fixed.symbol}`]) {
                p = prices[`${pfx}.${fixed.symbol}`];
                break;
              }
            }
          } else if (fixed.market === "crypto") {
            p = prices[`crypto.${fixed.symbol}`] || {};
          } else if (fixed.market === "fund") {
            p = prices[`fund.${fixed.symbol}`] || {};
          } else {
            p = prices[`${MARKET_MAP[fixed.market]}.${fixed.symbol}`] || {};
          }
          const price = p.price || 0;
          const mv = price * h.shares;
          const cv = h.costPrice * h.shares;
          const pnl = mv - cv;
          const pnlPct = cv > 0 ? (pnl / cv) * 100 : 0;
          // 场外基金在途申购: 只贡献「在途金额 + 按最新净值预估的份额」
          const pendingOrders = Array.isArray(h.orders) ? h.orders.filter((o) => o.status === "pending") : [];
          const pendingAmount = pendingOrders.reduce((s, o) => s + (parseFloat(o.amount) || 0), 0);
          const pendingEstShares = price > 0 ? pendingAmount / price : 0;
          const tech = klineCache[fixed.symbol] ? calcTechnicals(klineCache[fixed.symbol], price, h.costPrice) : null;
          return {
            ...h,
            name: (p.name && (!h.name || h.name === h.symbol)) ? p.name : h.name,
            currentPrice: price,
            changePercent: p.changePercent || 0,
            change: p.change || 0,
            high: p.high || 0,
            low: p.low || 0,
            open: p.open || 0,
            prevClose: p.prevClose || 0,
            marketValue: mv,
            costValue: cv,
            pnl,
            pnlPercent: pnlPct,
            realizedPnl: h.realizedPnl || 0,
            transactionCount: h.transactionCount || 0,
            lastTradeAt: h.lastTradeAt || null,
            orders: Array.isArray(h.orders) ? h.orders : [],
            pendingAmount: roundNum(pendingAmount, 2),
            pendingEstShares: roundNum(pendingEstShares, 2),
            afterHours: p.afterHours || false,
            preMarket: p.preMarket || false,
            iopv: p.iopv || 0,                                                                     // 沪市 ETF 实时参考净值(无则 0)
            iopvTime: p.iopvTime || null,
            premiumPct: (p.iopv > 0 && price > 0) ? roundNum((price / p.iopv - 1) * 100, 2) : null, // 场内溢价% = 现价 ÷ IOPV − 1
            tech,
            quoteFreshness: freshness.symbols[quoteKey(fixed)] || null,
          };
        }),
      })),
      timestamp: new Date().toISOString(),
      freshness,
    };

    // Calculate totals and record history
    const rate = portfolio.exchangeRate?.USD_CNY || 6.88;
    let totalCNY = 0, totalCost = 0, totalRealized = 0;
    result.accounts.forEach((acc) => {
      const cur = acc.currency || "CNY";
      acc.holdings.forEach((h) => {
        const mul = cur === "USD" ? rate : cur === "HKD" ? rate / 7.8 : 1;
        totalCNY += (h.marketValue || 0) * mul;
        totalCost += (h.costValue || 0) * mul;
        totalRealized += (h.realizedPnl || 0) * mul;
        // 在途申购资金: 计入总资产(成本=市值,不影响盈亏),避免确认前总额凭空跳水
        totalCNY += (h.pendingAmount || 0) * mul;
        totalCost += (h.pendingAmount || 0) * mul;
      });
    });
    const newSnapshot = recordSnapshot(totalCNY, totalCost, totalRealized);

    // Return Attribution
    const attribution = [];
    result.accounts.forEach((acc) => {
      const cur = acc.currency || "CNY";
      acc.holdings.forEach((h) => {
        const mul = cur === "USD" ? rate : cur === "HKD" ? rate / 7.8 : 1;
        const pnlCNY = (h.pnl || 0) * mul;
        const mvCNY = (h.marketValue || 0) * mul;
        const dayChgCNY = (h.change || 0) * h.shares * mul;
        attribution.push({
          symbol: h.symbol,
          name: h.name,
          pnlCNY: Math.round(pnlCNY * 100) / 100,
          dayChgCNY: Math.round(dayChgCNY * 100) / 100,
          contribution: totalCost > 0 ? Math.round(pnlCNY / totalCost * 10000) / 100 : 0,
          dayContribution: totalCNY > 0 ? Math.round(dayChgCNY / totalCNY * 10000) / 100 : 0,
          weight: totalCNY > 0 ? Math.round(mvCNY / totalCNY * 10000) / 100 : 0,
          pnlPercent: h.pnlPercent ? Math.round(h.pnlPercent * 100) / 100 : 0,
        });
      });
    });
    attribution.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    result.riskMetrics = cachedRiskMetrics;
    result.correlation = cachedCorrelation;
    const historySnapshots = loadHistory().snapshots;
    result.historyMeta = {
      lastSnapshotAt: historySnapshots.length ? historySnapshots[historySnapshots.length - 1].t : null,
    };
    result.attribution = attribution;
    result.lookThrough = buildLookThrough(result, rate);
    result.rateInfo = {
      USD_CNY: cachedRate?.USD_CNY || rate,
      USD_HKD: cachedRate?.USD_HKD || 7.82,
      lastUpdate: rateLastFetch ? new Date(rateLastFetch).toISOString() : null,
    };
    const dataRevision = `${portfolioRevision}:${analysisRevision}`;
    const sendFull = !latestData || dataRevision !== _broadcastRevision;
    latestData = result;
    if (sendFull) {
      _broadcastRevision = dataRevision;
      broadcastJson({ type: "portfolio", data: result });
    } else {
      broadcastJson({ type: "portfolio_patch", data: realtimePatch(result) });
    }
    if (newSnapshot) {
      broadcastJson({ type: "history_append", data: { snapshot: newSnapshot, riskMetrics: cachedRiskMetrics } });
    }
    _lastRefreshCompletedAt = Date.now();
    return successfulGroups;
  } catch (e) {
    console.error("Price fetch error:", e.message);
    return new Set();
  } finally {
    clearTimeout(_wd);
    if (generation === _refreshGeneration) {
      _refreshing = false;
      _refreshStartedAt = 0;
      // 刷新过程中发生的数据修改不能丢：当前轮使用的是修改前快照，结束后立即补发一轮。
      if (_refreshQueued && !_refreshInFlight) {
        _refreshQueued = false;
        triggerRefresh();
      }
    }
  }
}

// WebSocket 连接数上限：防海量连接耗内存/带宽(应用层 DoS)
const WS_MAX_TOTAL = 50;   // 全局并发连接上限
const WS_MAX_PER_IP = 8;   // 单 IP 上限
const wsPerIp = new Map();
wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  if (!PUBLIC_READ) {
    let token = "";
    try { token = new URL(req.url, "http://x").searchParams.get("token") || ""; } catch (e) {}
    if (!token || !validTokens.has(token)) { try { ws.close(4401, "unauthorized"); } catch (e) {} return; }
  }
  if (wss.clients.size >= WS_MAX_TOTAL || (wsPerIp.get(ip) || 0) >= WS_MAX_PER_IP) {
    try { ws.close(1013, "too many connections"); } catch (e) {}
    return;
  }
  wsPerIp.set(ip, (wsPerIp.get(ip) || 0) + 1);
  ws.on("message", () => {
    try { ws.close(1008, "client messages not supported"); } catch (e) {}
  });
  ws.on("close", () => {
    const c = (wsPerIp.get(ip) || 1) - 1;
    if (c <= 0) wsPerIp.delete(ip); else wsPerIp.set(ip, c);
  });
  if (latestData) ws.send(JSON.stringify({ type: "portfolio", data: latestData }));
});

// 未捕获异常意味着进程状态已不可证明可靠。尽力刷盘后以非 0 退出，交给进程管理器(Docker restart / systemd)拉起干净进程。
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e && e.stack ? e.stack : e);
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
  shutdown("unhandledRejection", 1);
});

// 硬超时包装: 无论内部 Promise 是否 settle,都在 ms 后让返回的 Promise resolve。
// 行情/K线看门狗会在更短时间内退出异常进程；这里仍保留为循环级兜底，避免未来调用方
// 在没有进程看门狗时因永不 settle 的 Promise 永久停止重排程。
function withHardTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    if (t.unref) t.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(t); resolve(value); },
      () => { clearTimeout(t); resolve(null); }
    );
  });
}

// Startup
(async () => {
  // 历史版本曾在基金申购确认后只写入交易流水、未更新顶层快照；启动时无损校正一次。
  reconcilePortfolioSnapshots();
  // 各市场独立到期：交易时段 10~15s，休市后 5min；加密货币保持 24x7。
  // 失败按市场指数退避，避免单个上游持续失败时仍高频轰炸；成功后恢复基础频率。
  const marketState = new Map();
  const knownGroups = ["cn", "hk", "us", "crypto", "fund", "other"];
  function groupsInPortfolio() {
    const groups = new Set();
    const p = loadPortfolio();
    (p.accounts || []).forEach((acc) => (acc.holdings || []).forEach((h) => groups.add(marketGroupForHolding(fixMarket(h)))));
    return groups;
  }
  function scheduleGroup(group, now, failed) {
    const state = marketState.get(group) || { failures: 0, nextAt: 0 };
    state.failures = failed ? state.failures + 1 : 0;
    const jitter = group === "crypto" || group === "cn" || group === "hk" || group === "us"
      ? Math.floor(Math.random() * 3000)
      : Math.floor(Math.random() * 30000);
    state.nextAt = now + pollDelayMs(group, new Date(now), state.failures) + jitter;
    marketState.set(group, state);
    const freshness = marketFreshness.get(group);
    if (freshness) freshness.nextAttemptAt = state.nextAt;
  }
  (async function refreshLoop() {
    const now = Date.now();
    const present = groupsInPortfolio();
    const due = new Set();
    for (const group of knownGroups) {
      if (!present.has(group)) continue;
      const state = marketState.get(group);
      if (!state || state.nextAt <= now) due.add(group);
    }
    if (!latestData && !due.size) present.forEach((group) => due.add(group));
    if (!latestData && !present.size) await withHardTimeout(refreshPrices(new Set()), 90000);
    if (due.size) {
      let successful = null;
      try { successful = await withHardTimeout(refreshPrices(due), 90000); }
      catch (e) { console.error("refreshLoop:", e.message); }
      const finishedAt = Date.now();
      due.forEach((group) => scheduleGroup(group, finishedAt, !(successful instanceof Set) || !successful.has(group)));
    }
    const nextAt = [...present].map((group) => marketState.get(group)?.nextAt || now).sort((a, b) => a - b)[0];
    const delay = Math.max(1000, Math.min(30000, (nextAt || now + 30000) - Date.now()));
    setTimeout(refreshLoop, delay);
  })();

  // K线独立循环: 每 60s 检查；交易时段每 10min，休市/基金每 6h 才真正抓取。
  // 摘出主 cycle 是为了避免它的 5-8s 并行抓取压到 60s watchdog 边界。
  // 启动延后 15s 让首轮 refreshPrices 把 lastKnownPrices 填好(refreshKlines 用它解析美股 secid)。
  let _refreshingKlines = false;
  async function refreshKlinesLoop() {
    if (!_refreshingKlines && Object.keys(lastKnownPrices).length > 0) {
      _refreshingKlines = true;
      const _wd = setTimeout(() => {
        if (_refreshingKlines) shutdown("refreshKlines watchdog", 1);
      }, 120 * 1000);
      if (_wd.unref) _wd.unref();
      // 硬超时 150s > 内部 120s watchdog: 同 refreshLoop, 防 refreshKlines 内部某个 fetch
      // 永不 settle 时 await 永久挂起、底部 setTimeout 重排程到不了导致 kline 循环停摆。
      try { await withHardTimeout(refreshKlines(lastKnownPrices), 150000); }
      catch (e) { console.error("refreshKlinesLoop:", e.message); }
      clearTimeout(_wd);
      _refreshingKlines = false;
    }
    setTimeout(refreshKlinesLoop, 60 * 1000);
  }
  if (!TEST_MODE || process.env.STOCK_TEST_KLINES === "1") setTimeout(refreshKlinesLoop, 15 * 1000);

  // IB 自动同步定时: 美股时段(含盘前盘后)每 10 分钟拉交易确认; 北京时间周二~周六 9 点后拉一次活动查询对账, 失败 10 分钟(硬错误 1 小时)重试
  if (ibSync.configured && !TEST_MODE) {
    let lastConfirmAt = 0, lastPosAttemptAt = 0;
    const ibTick = () => {
      const now = Date.now(), d = new Date(now);
      const kinds = [];
      if (marketSession("us", d).active && now - lastConfirmAt >= 10 * 60 * 1000) { kinds.push("confirms"); lastConfirmAt = now; }
      const bj = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(d)
        .reduce((o, x) => (o[x.type] = x.value, o), {});
      const st = ibSync.status({ detailed: true });
      const p = st.positions;
      const doneToday = p && p.ok && !p.stale && shanghaiDay(new Date(p.at)) === shanghaiDay(d);
      // 重试间隔: IB 报表还没出(stale) 4 小时; 令牌/IP 等硬错误 1 小时; 临时失败(限流/网络) 10 分钟
      const retryMin = p && p.stale ? 240 : p && p.hard ? 60 : 10;
      if (!["Sun", "Mon"].includes(bj.weekday) && +bj.hour >= 9 && !doneToday && now - lastPosAttemptAt >= retryMin * 60 * 1000) { kinds.push("positions"); lastPosAttemptAt = now; }
      if (kinds.length) ibSync.run(kinds).catch(() => {});
    };
    const t = setInterval(ibTick, 60 * 1000); if (t.unref) t.unref();
    setTimeout(ibTick, 20 * 1000);
    console.log(`IB 自动同步已启用${process.env.IB_SYNC_DRYRUN === "1" ? "(试运行)" : ""}`);
  }
  server.listen(PORT, () => {
    console.log(`Calm Portfolio running at http://localhost:${PORT}`);
    console.log("Storage: file only");
    if (typeof process.send === "function") process.send({ type: "listening", port: server.address().port });
  });
})();
