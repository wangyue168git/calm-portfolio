"use strict";
// ===== IB Flex 适配器 =====
// 本文件只管"从 IB 拿数据": Flex Web Service 请求 + XML 解析; 怎么写进看板见 brokers/core.js(所有券商共用)。
// 原则: 手动修改永远是兜底, 自动同步只是"代你点一次手动修改"。
//   - 交易确认查询(当天成交, 几分钟延迟): 新成交 → 追加 buy/sell 记录(备注 IB#tradeID)
//   - 活动查询(上一交易日收盘持仓): IB 的股数/成本相对"上次从 IB 拿到的快照"变了 → 追加一条 sync(绝对值)纠偏
//   - 首次运行只记基线、不写持仓; 对比对象是上次 IB 快照, 不是看板当前值 → 用户手改的数在 IB 没有新变化前不会被改回去
//   - 只读: Flex 令牌只能读报表, 本模块不调用任何交易接口
// 令牌/查询编号走环境变量(环境变量 / .env), 不进仓库。

const core = require("./brokers/core");

const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const AUTO_TAG = "IB#";            // 交易确认写入的 note 前缀
const RECON_NOTE = "IB 自动对账";   // 活动查询写入的 sync note

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

// ---------- IB 适配器 + 运行器 ----------
// 对账逻辑在 brokers/core.js; 这里保留旧的导出名(applyConfirms / applyPositions / createIbSync), 默认用 IB 的备注前缀
const applyConfirms = (portfolio, state, confirms, opts) => core.applyConfirms(portfolio, state, confirms, { tag: AUTO_TAG, reconNote: RECON_NOTE, ...opts });
const applyPositions = (portfolio, state, positions, opts) => core.applyPositions(portfolio, state, positions, { tag: AUTO_TAG, reconNote: RECON_NOTE, ...opts });

function createIbAdapter({ token, positionsQuery, confirmsQuery, tokenExpires = "", fetchText: rawFetch, minGapMs = 2000 }) {
  // IB 限 1 次/秒: 任意两次请求至少隔 minGapMs(同步是串行的, 不会并发)
  let lastReqAt = 0;
  const fetchText = async (url) => {
    const wait = lastReqAt + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReqAt = Date.now();
    return rawFetch(url);
  };
  return {
    id: "ib", label: "IB", tag: AUTO_TAG, reconNote: RECON_NOTE,
    configured: !!(token && (positionsQuery || confirmsQuery)),
    tokenExpires, markets: ["us"], positionsDaily: true,
    fetchConfirms: confirmsQuery ? async () => parseConfirms(await fetchFlexStatement(fetchText, token, confirmsQuery)) : null,
    fetchPositions: positionsQuery ? async () => {
      const xml = await fetchFlexStatement(fetchText, token, positionsQuery);
      return { positions: parsePositions(xml), statementDate: statementDate(xml) };
    } : null,
  };
}

function createIbSync(deps) {
  const { accountName = "IB", stateFile, dryRun = false, extras = {}, loadPortfolio, savePortfolio, appendTrade, log = console.log } = deps;
  return core.createBrokerSync({ adapter: createIbAdapter(deps), accountName, stateFile, dryRun, extras, loadPortfolio, savePortfolio, appendTrade, log });
}

const { parseExtras, loadState, shanghaiDay } = core;

module.exports = {
  parseElements, parseConfirms, parsePositions, parseIbDateTime, fetchFlexStatement, parseExtras, statementDate,
  applyConfirms, applyPositions, createIbSync, createIbAdapter, loadState, shanghaiDay, AUTO_TAG, RECON_NOTE,
};
