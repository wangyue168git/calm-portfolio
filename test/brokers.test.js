"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLongbridgeAdapter, toBoardSymbol } = require("../brokers/longbridge");
const { createBrokerSync, applyPositions } = require("../brokers/core");
const { buildBrokerSyncs } = require("../brokers");

const D = (n) => ({ toString: () => String(n) });   // 模拟 SDK 的 Decimal
const fakeSdk = ({ positions = [], execs = [], orders = [], fail } = {}) => ({
  Config: { fromApikey: (k, s, t) => ({ k, s, t }) },
  TradeContext: { new: async () => {
    if (fail) throw new Error(fail);
    return {
      stockPositions: async () => ({ channels: [{ accountChannel: "lb", positions }] }),
      todayExecutions: async () => execs,
      todayOrders: async () => orders,
    };
  } },
});
const appendTrade = (h, t) => {
  const tx = [...(h.transactions || []), t];
  let shares = h.shares || 0, cost = h.costPrice || 0;
  if (t.type === "sync") { shares = t.shares; cost = t.price; }
  else if (t.type === "buy") { cost = (shares * cost + t.shares * t.price) / (shares + t.shares); shares += t.shares; }
  else shares -= t.shares;
  return { ...h, shares, costPrice: cost, transactions: tx };
};

test("长桥代码转换: 美股/港股补零/沪深; 不支持的返回 null", () => {
  assert.deepEqual(toBoardSymbol("AAPL.US"), { symbol: "AAPL", market: "nasdaq", region: "us" });
  assert.deepEqual(toBoardSymbol("700.HK"), { symbol: "00700", market: "hk", region: "hk" });
  assert.equal(toBoardSymbol("600519.SH").market, "sh");
  assert.equal(toBoardSymbol("000001.SZ").market, "sz");
  assert.equal(toBoardSymbol("D05.SG"), null);
});

test("长桥适配器: 持仓/成交转换, 方向取自订单, 按市场分账户", async () => {
  const sdk = fakeSdk({
    positions: [
      { symbol: "AAPL.US", symbolName: "苹果", quantity: D(10), costPrice: D(180.5) },
      { symbol: "700.HK", symbolName: "腾讯", quantity: D(100), costPrice: D(380) },
      { symbol: "TSLA.US", symbolName: "特斯拉", quantity: D(0), costPrice: D(200) },
    ],
    execs: [
      { orderId: "o1", tradeId: "t1", symbol: "AAPL.US", tradeDoneAt: new Date("2026-10-30T14:00:00Z"), quantity: D(2), price: D(181) },
      { orderId: "o2", tradeId: "t2", symbol: "700.HK", tradeDoneAt: new Date("2026-10-30T02:00:00Z"), quantity: D(100), price: D(390) },
      { orderId: "o9", tradeId: "t9", symbol: "MSFT.US", tradeDoneAt: new Date(), quantity: D(1), price: D(400) },
    ],
    orders: [{ orderId: "o1", side: 1 }, { orderId: "o2", side: 2 }],
  });
  const a = createLongbridgeAdapter({ appKey: "k", appSecret: "s", accessToken: "t", accounts: { hk: "港股账户" }, loadSdk: () => sdk });
  assert.equal(a.configured, true);
  const { positions } = await a.fetchPositions();
  assert.equal(positions.length, 2, "0 股的不算");
  assert.deepEqual(positions.map((p) => [p.symbol, p.qty, p.cost, p.account]), [["AAPL", 10, 180.5, undefined], ["00700", 100, 380, "港股账户"]]);
  const confirms = await a.fetchConfirms();
  assert.deepEqual(confirms.map((c) => [c.id, c.symbol, c.side, c.qty, c.price]), [["t1", "AAPL", "buy", 2, 181], ["t2", "00700", "sell", 100, 390]], "找不到订单方向的成交跳过");
});

test("长桥适配器: 没装 SDK / 令牌错误 → 需要人处理的错误", async () => {
  const noSdk = createLongbridgeAdapter({ appKey: "k", appSecret: "s", accessToken: "t", loadSdk: () => { throw new Error("Cannot find module"); } });
  await assert.rejects(noSdk.fetchPositions(), (e) => e.hard && /npm install longport/.test(e.message));
  const bad = createLongbridgeAdapter({ appKey: "k", appSecret: "s", accessToken: "t", loadSdk: () => fakeSdk({ fail: "401 unauthorized token" }) });
  await assert.rejects(bad.fetchPositions(), (e) => e.hard && /令牌/.test(e.message));
});

test("通用对账: 持仓按 account 写进不同账户; 基线后才改; 新建持仓带市场和名称", () => {
  const portfolio = { accounts: [{ name: "长桥", currency: "USD", holdings: [] }, { name: "港股账户", currency: "HKD", holdings: [] }] };
  const positions = [
    { key: "a", symbol: "AAPL", qty: 10, cost: 180, market: "nasdaq", name: "苹果" },
    { key: "b", symbol: "00700", qty: 100, cost: 380, market: "hk", name: "腾讯", account: "港股账户" },
  ];
  const opts = { accountName: "长桥", appendTrade, tag: "LB#", reconNote: "长桥自动对账" };
  const base = applyPositions(portfolio, {}, positions, opts);
  assert.equal(base.actions[0].kind, "baseline");
  assert.equal(base.portfolio, portfolio, "首次只记基线");
  const r = applyPositions(portfolio, { positions: {} }, positions, opts);
  const hk = r.portfolio.accounts[1].holdings[0];
  assert.deepEqual([hk.symbol, hk.market, hk.name, hk.shares], ["00700", "hk", "腾讯", 100]);
  assert.equal(r.portfolio.accounts[0].holdings[0].transactions[0].note, "长桥自动对账");
  assert.equal(portfolio.accounts[1].holdings.length, 0, "不改原对象");
});

test("运行器 + 自定义适配器加载: 状态文件按 id 分开, 重名/缺 id 的拒绝", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brokers-"));
  fs.writeFileSync(path.join(dir, "my-broker.js"), `module.exports.create = (env) => ({
    id: "mybroker", label: "我的券商", configured: !!env.MYBROKER_KEY, markets: ["hk"], positionsDaily: false,
    fetchPositions: async () => ({ positions: [{ symbol: "AAPL", qty: 3, cost: 100 }] }),
  });`);
  fs.writeFileSync(path.join(dir, "bad.js"), `module.exports = { id: "ib", configured: true };`);
  const logs = [];
  let portfolio = { accounts: [{ name: "我的券商", currency: "USD", holdings: [] }] };
  const syncs = buildBrokerSyncs({
    env: { BROKER_ADAPTERS: "./my-broker.js, ./bad.js, ./missing.js", MYBROKER_KEY: "x" }, dataDir: dir, baseDir: dir, log: (m) => logs.push(m),
    deps: { loadPortfolio: () => portfolio, savePortfolio: (p) => { portfolio = p; return true; }, appendTrade },
  });
  assert.equal(syncs.length, 1);
  assert.equal(logs.filter((m) => /失败/.test(m)).length, 2);
  const s = syncs[0];
  assert.deepEqual([s.id, s.label, s.configured, s.markets[0], s.positionsDaily], ["mybroker", "我的券商", true, "hk", false]);
  await s.run(["positions"]);
  assert.equal(portfolio.accounts[0].holdings.length, 0, "首次只记基线");
  fs.writeFileSync(path.join(dir, "mybroker-sync-state.json"), JSON.stringify({ positions: {} }));
  await s.run(["positions", "confirms"]);
  assert.equal(portfolio.accounts[0].holdings[0].shares, 3);
  assert.equal(portfolio.accounts[0].holdings[0].transactions[0].note, "我的券商 自动对账");
  assert.equal(s.status().label, "我的券商");
});

test("示例适配器(读 CSV 文件)能被加载并对账", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brokers-csv-"));
  const csvPath = path.join(dir, "pos.csv");
  fs.writeFileSync(csvPath, "代码,名称,数量,成本价\nAAPL,苹果,5,170\n");
  let portfolio = { accounts: [{ name: "我的券商", currency: "USD", holdings: [] }] };
  const [s] = buildBrokerSyncs({
    env: { BROKER_ADAPTERS: path.join(__dirname, "..", "examples", "broker-adapter.example.js"), CSVFILE_PATH: csvPath, CSVFILE_SYNC_ACCOUNT: "我的券商" },
    dataDir: dir, deps: { loadPortfolio: () => portfolio, savePortfolio: (p) => { portfolio = p; return true; }, appendTrade },
  });
  assert.equal(s.id, "csvfile");
  await s.run(["positions"]);                                   // 基线
  fs.writeFileSync(csvPath, "代码,名称,数量,成本价\nAAPL,苹果,8,172\n");
  await s.run(["positions"]);
  assert.equal(portfolio.accounts[0].holdings[0].shares, 8);
});
