"use strict";
// ===== 长桥(Longbridge / LongPort) 适配器 =====
// 用官方 Node SDK `longport` 只读查询: 当前持仓(stockPositions) + 今日成交(todayExecutions, 买卖方向从 todayOrders 取)。
// SDK 带原生模块、体积较大, 不放进默认依赖: 要用时在项目目录运行 `npm install longport`(Docker 见 docs/brokers/longbridge.md)。
// 只用到查询接口, 不调用任何下单/撤单接口; 建议在长桥开放平台把应用权限设为只读。

// 长桥代码 → 看板代码 + 市场: AAPL.US → AAPL/nasdaq, 700.HK → 00700/hk, 600519.SH → 600519/sh, 000001.SZ → 000001/sz
function toBoardSymbol(lbSymbol) {
  const m = /^(.+)\.([A-Z]+)$/.exec(String(lbSymbol || "").trim().toUpperCase());
  if (!m) return null;
  const [, code, mk] = m;
  if (mk === "US") return { symbol: code, market: "nasdaq", region: "us" };
  if (mk === "HK") return { symbol: /^\d+$/.test(code) ? code.padStart(5, "0") : code, market: "hk", region: "hk" };
  if (mk === "SH") return { symbol: code, market: "sh", region: "cn" };
  if (mk === "SZ") return { symbol: code, market: "sz", region: "cn" };
  return null;   // 新加坡等暂不支持
}
const dec = (v) => (v === null || v === undefined ? NaN : Number(typeof v === "object" ? v.toString() : v));

// accounts: { us?, hk?, cn? } —— 各市场写进看板的哪个账户; 不填用默认账户
function createLongbridgeAdapter({ appKey, appSecret, accessToken, tokenExpires = "", accounts = {}, loadSdk = () => require("longport") }) {
  let ctxPromise = null;
  async function ctx() {
    if (!ctxPromise) {
      ctxPromise = (async () => {
        let sdk;
        try { sdk = loadSdk(); } catch (e) {
          const err = new Error("未安装长桥 SDK: 在项目目录运行 npm install longport 后重启");
          err.hard = true; throw err;
        }
        const config = sdk.Config.fromApikey(appKey, appSecret, accessToken);
        return await sdk.TradeContext.new(config);
      })();
      ctxPromise.catch(() => { ctxPromise = null; });   // 失败了下次重建
    }
    return ctxPromise;
  }
  const accountOf = (region) => accounts[region] || undefined;
  const wrapErr = (e) => {
    const msg = String((e && e.message) || e);
    const err = new Error(/token|auth|401|unauthori|expired/i.test(msg) ? `长桥令牌无效或已过期: ${msg}` : `长桥接口: ${msg}`);
    err.hard = /token|auth|401|unauthori|expired/i.test(msg) || !!(e && e.hard);
    return err;
  };

  return {
    id: "longbridge", label: "长桥", tag: "LB#", reconNote: "长桥自动对账",
    configured: !!(appKey && appSecret && accessToken),
    tokenExpires, markets: ["us", "hk", "cn"], positionsDaily: false,
    async fetchPositions() {
      try {
        const resp = await (await ctx()).stockPositions();
        const positions = [];
        (resp.channels || []).forEach((ch) => (ch.positions || []).forEach((p) => {
          const b = toBoardSymbol(p.symbol);
          const qty = dec(p.quantity), cost = dec(p.costPrice);
          if (!b || !(qty > 0) || !(cost > 0)) return;
          positions.push({ key: `${ch.accountChannel || ""}:${p.symbol}`, symbol: b.symbol, market: b.market, name: p.symbolName || b.symbol, qty, cost, account: accountOf(b.region) });
        }));
        return { positions };
      } catch (e) { throw e.hard ? e : wrapErr(e); }
    },
    async fetchConfirms() {
      try {
        const c = await ctx();
        const [execs, orders] = await Promise.all([c.todayExecutions(), c.todayOrders()]);
        const sideOf = new Map((orders || []).map((o) => [String(o.orderId), Number(o.side)]));   // 1=买 2=卖
        const out = [];
        (execs || []).forEach((x) => {
          const b = toBoardSymbol(x.symbol);
          const side = sideOf.get(String(x.orderId));
          const qty = dec(x.quantity), price = dec(x.price);
          if (!b || !(side === 1 || side === 2) || !(qty > 0) || !(price > 0)) return;
          const date = x.tradeDoneAt instanceof Date ? x.tradeDoneAt : new Date(x.tradeDoneAt);
          out.push({ id: String(x.tradeId || `${x.orderId}-${+date}`), symbol: b.symbol, market: b.market, side: side === 1 ? "buy" : "sell", qty, price, commission: 0, date, account: accountOf(b.region) });
        });
        return out;
      } catch (e) { throw e.hard ? e : wrapErr(e); }
    },
  };
}

module.exports = { createLongbridgeAdapter, toBoardSymbol };
