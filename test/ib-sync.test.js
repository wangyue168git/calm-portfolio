"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ib = require("../ib-sync");

// 极简的 appendTrade: 只追加并重算股数/均价(与 server.js 语义一致: sync=绝对值, buy 加, sell 按均价减)
function appendTrade(h, t) {
  const txs = [...(h.transactions || []), t];
  let shares = 0, cost = 0;
  txs.forEach((x) => {
    if (x.type === "sync") { shares = x.shares; cost = x.shares * x.price; }
    else if (x.type === "buy") { shares += x.shares; cost += x.shares * x.price; }
    else if (x.type === "sell") { if (x.shares > shares + 1e-8) throw new Error("卖出数量不能超过当前持仓"); const avg = cost / shares; shares -= x.shares; cost -= avg * x.shares; }
  });
  return { ...h, transactions: txs, shares: +shares.toFixed(6), costPrice: shares ? +(cost / shares).toFixed(6) : 0 };
}
const board = () => ({ accounts: [
  { name: "A股账户", holdings: [{ symbol: "513650", shares: 100, costPrice: 1, transactions: [] }] },
  { name: "IB", holdings: [
    { symbol: "QQQM", shares: 10, costPrice: 200, transactions: [{ type: "sync", shares: 10, price: 200, date: "2026-07-01T15:00:00.000Z" }] },
    { symbol: "AAPL", shares: 12, costPrice: 150, transactions: [{ type: "sync", shares: 12, price: 150, date: "2026-07-01T15:00:00.000Z" }] },
  ] },
] });
const opts = { accountName: "IB", appendTrade };

const CONFIRMS_XML = `<FlexQueryResponse queryName="example" type="TCF"><FlexStatements count="1"><FlexStatement accountId="U1"><TradeConfirms>
<TradeConfirm accountId="U1" currency="USD" assetCategory="STK" symbol="QQQM" conid="1" buySell="BUY" quantity="2" price="210" dateTime="20260713;101500" tradeID="T1" commission="-0.35" levelOfDetail="EXECUTION" />
<TradeConfirm accountId="U1" currency="USD" assetCategory="STK" symbol="VOO" conid="2" buySell="BUY" quantity="1" price="520" dateTime="20260713;101600" tradeID="T2" commission="-0.35" />
<TradeConfirm accountId="U1" currency="USD" assetCategory="OPT" symbol="X 1C" conid="3" buySell="BUY" quantity="1" price="1" dateTime="20260713;101600" tradeID="T3" />
</TradeConfirms></FlexStatement></FlexStatements></FlexQueryResponse>`;
const POS_XML = (aaplQty, qqqmQty) => `<FlexQueryResponse><FlexStatements><FlexStatement><OpenPositions>
<OpenPosition assetCategory="STK" symbol="AAPL" conid="265598" position="${aaplQty}" costBasisPrice="155" levelOfDetail="SUMMARY" />
<OpenPosition assetCategory="STK" symbol="QQQM" conid="1" position="${qqqmQty}" costBasisPrice="205" levelOfDetail="SUMMARY" />
</OpenPositions></FlexStatement></FlexStatements></FlexQueryResponse>`;

test("parse: 只取股票, 价格/佣金/时间(美东→UTC)", () => {
  const c = ib.parseConfirms(CONFIRMS_XML);
  assert.equal(c.length, 2);
  assert.equal(c[0].symbol, "QQQM"); assert.equal(c[0].side, "buy"); assert.equal(c[0].qty, 2); assert.equal(c[0].commission, 0.35);
  assert.equal(c[0].date.toISOString(), "2026-07-13T14:15:00.000Z");   // EDT = UTC-4
  assert.equal(ib.parseIbDateTime("20261215;093000").toISOString(), "2026-12-15T14:30:00.000Z"); // EST = UTC-5
  const p = ib.parsePositions(POS_XML(9, 12.01));
  assert.deepEqual(p.map((x) => [x.symbol, x.qty, x.cost]), [["AAPL", 9, 155], ["QQQM", 12.01, 205]]);
});

test("交易确认: 首次只记基线, 之后新成交写入, 已见过的不重复", () => {
  const c = ib.parseConfirms(CONFIRMS_XML);
  let st = ib.loadState("/nonexistent");
  let r = ib.applyConfirms(board(), st, c, opts);
  assert.equal(r.actions[0].kind, "baseline");
  assert.equal(r.portfolio.accounts[1].holdings[0].shares, 10);          // 未改
  st = { ...r.state, seen: [] };                                              // 模拟基线后才发生的成交
  r = ib.applyConfirms(board(), st, c, opts);
  const q = r.portfolio.accounts[1].holdings.find((h) => h.symbol === "QQQM");
  assert.equal(q.shares, 12);
  assert.match(q.transactions.at(-1).note, /^IB#T1$/);
  assert.ok(Math.abs(q.transactions.at(-1).price - (210 + 0.175)) < 1e-9);  // 佣金摊进成本
  assert.ok(r.portfolio.accounts[1].holdings.some((h) => h.symbol === "VOO" && h.shares === 1)); // 新标的自动建
  const again = ib.applyConfirms(r.portfolio, r.state, c, opts);
  assert.equal(again.actions.filter((a) => a.kind === "buy").length, 0);
  assert.equal(r.portfolio.accounts[0].holdings[0].shares, 100);             // 别的账户不动
});

test("交易确认: 用户已手动记过(成交后有手动记录)就跳过", () => {
  const b = board();
  b.accounts[1].holdings[0].transactions.push({ type: "sync", shares: 12, price: 205, date: "2026-07-13T15:00:00.000Z" });
  b.accounts[1].holdings[0].shares = 12;
  const r = ib.applyConfirms(b, { seen: [], confirmsBaseline: true }, ib.parseConfirms(CONFIRMS_XML), opts);
  assert.ok(r.actions.some((a) => a.kind === "skip-manual" && a.symbol === "QQQM"));
  assert.equal(r.portfolio.accounts[1].holdings[0].shares, 12);
});

test("持仓对账: 基线不写; IB 没变时尊重手改; IB 变了才写 sync", () => {
  let r = ib.applyPositions(board(), { positions: null }, ib.parsePositions(POS_XML(9, 10)), opts);
  assert.equal(r.actions[0].kind, "baseline");
  assert.equal(r.portfolio.accounts[1].holdings[1].shares, 12);               // AAPL 未被改成 9
  assert.deepEqual(r.diff.find((d) => d.symbol === "AAPL"), { symbol: "AAPL", ibQty: 9, ibCost: 155, boardQty: 12, boardCost: 150 });
  const st = r.state;
  r = ib.applyPositions(board(), st, ib.parsePositions(POS_XML(9, 10)), opts);
  assert.equal(r.actions.length, 0);                                           // IB 无变化 → 不动
  r = ib.applyPositions(board(), st, ib.parsePositions(POS_XML(9, 12.01)), opts);
  const q = r.portfolio.accounts[1].holdings[0];
  assert.equal(q.shares, 12.01); assert.equal(q.transactions.at(-1).type, "sync"); assert.equal(q.transactions.at(-1).note, "IB 自动对账");
  assert.equal(r.portfolio.accounts[1].holdings[1].shares, 12);               // AAPL 在 IB 没变, 看板不动
});

test("场外加数: AAPL = IB + 场外 3 股; IB 变了按合计写, 交易确认照常累加不被对账吃掉", () => {
  const extras = ib.parseExtras("AAPL:3:160, bad, X:0:1");
  assert.deepEqual(extras, { AAPL: { qty: 3, cost: 160 } });
  const o = { ...opts, extras };
  let r = ib.applyPositions(board(), { positions: null }, ib.parsePositions(POS_XML(9, 10)), o);
  assert.equal(r.diff.find((d) => d.symbol === "AAPL").extraQty, 3);
  const st = r.state;
  // 在 IB 买 1 股: 交易确认先把看板加到 13
  const buy = `<TradeConfirms><TradeConfirm assetCategory="STK" symbol="AAPL" conid="265598" buySell="BUY" quantity="1" price="165" dateTime="20260714;100000" tradeID="T9" commission="0" /></TradeConfirms>`;
  const c = ib.applyConfirms(board(), { seen: [], confirmsBaseline: true }, ib.parseConfirms(buy), o);
  const t1 = c.portfolio.accounts[1].holdings[1];
  assert.equal(t1.shares, 13);
  // 次日对账 IB=10 → 看板应为 13(10+3), 已一致则不写
  r = ib.applyPositions(c.portfolio, st, ib.parsePositions(POS_XML(10, 10)), o);
  const t2 = r.portfolio.accounts[1].holdings[1];
  assert.equal(t2.shares, 13);                                                  // 没被改成 10
  const sync = t2.transactions.at(-1);
  assert.equal(sync.type, "sync");                                               // 成本按 IB 口径纠正(含场外加权)
  assert.match(sync.note, /^IB 自动对账\(含场外 3 股\)$/);
  assert.ok(Math.abs(sync.price - (10 * 155 + 3 * 160) / 13) < 1e-4);
  // 带场外备注的对账记录仍算"自动", 不会让后续成交被当成手动跳过
  const later = `<TradeConfirms><TradeConfirm assetCategory="STK" symbol="AAPL" conid="265598" buySell="BUY" quantity="1" price="170" dateTime="20260715;100000" tradeID="T10" commission="0" /></TradeConfirms>`;
  const syncedEarlier = { ...r.portfolio };
  syncedEarlier.accounts[1].holdings[1].transactions.forEach((t) => { if (t.type === "sync" && /场外/.test(t.note || "")) t.date = "2026-07-16T00:00:00.000Z"; });
  const c2 = ib.applyConfirms(syncedEarlier, { seen: [], confirmsBaseline: true }, ib.parseConfirms(later), o);
  assert.ok(!c2.actions.some((a) => a.kind === "skip-manual"));
});

test("Flex 两段式: 1019 重试后取到报表; 失败抛出 IB 错误信息", async () => {
  const calls = [];
  let n = 0;
  const fetchText = async (url) => {
    calls.push(url);
    if (url.includes("SendRequest")) return "<FlexStatementResponse><Status>Success</Status><ReferenceCode>R1</ReferenceCode><Url>https://x/GetStatement</Url></FlexStatementResponse>";
    n += 1;
    return n === 1 ? "<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>in progress</ErrorMessage></FlexStatementResponse>" : POS_XML(9, 1);
  };
  const xml = await ib.fetchFlexStatement(fetchText, "TOK", "1234567", { sleep: async () => {} });
  assert.match(xml, /OpenPosition/);
  assert.match(calls[0], /q=1234567/); assert.match(calls[1], /q=R1/);
  const bad = async () => "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>";
  await assert.rejects(ib.fetchFlexStatement(bad, "T", "1"), /IB 令牌已过期.*\(1012\)/);
});

test("运行器: 试运行不写持仓; 正式运行写入并记状态", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibsync-"));
  let saved = null, pf = board();
  const fetchText = async (url) => url.includes("SendRequest")
    ? "<FlexStatementResponse><Status>Success</Status><ReferenceCode>R</ReferenceCode></FlexStatementResponse>" : CONFIRMS_XML;
  const mk = (dryRun) => ib.createIbSync({ token: "T", confirmsQuery: "7654321", stateFile: path.join(dir, "s.json"), dryRun, fetchText,
    loadPortfolio: () => pf, savePortfolio: (p) => { saved = p; pf = p; return true; }, appendTrade, log: () => {} });
  fs.writeFileSync(path.join(dir, "s.json"), JSON.stringify({ confirmsBaseline: true, seen: [] }));
  const dry = await mk(true).run(["confirms"]);
  assert.match(dry.confirms.msg, /试运行/); assert.equal(saved, null);
  const real = await mk(false).run(["confirms"]);
  assert.equal(real.confirms.ok, true); assert.ok(saved);
  const st = mk(false).status();
  assert.equal(st.enabled, true); assert.equal(st.confirms.ok, true); assert.equal(st.confirms.actions, undefined); // 未登录不给明细
  assert.ok(mk(false).status({ detailed: true }).confirms.actions.length >= 2);
});

test("错误码中文化 + 到期日透出", async () => {
  const fetchText = async () => "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>";
  await assert.rejects(ib.fetchFlexStatement(fetchText, "T", "1"), /IB 令牌已过期.*\(1012\)/);
  const f2 = async () => "<FlexStatementResponse><Status>Fail</Status><ErrorCode>9999</ErrorCode><ErrorMessage>odd</ErrorMessage></FlexStatementResponse>";
  await assert.rejects(ib.fetchFlexStatement(f2, "T", "1"), /IB SendRequest 9999: odd/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibx-"));
  const s = ib.createIbSync({ token: "t", positionsQuery: "1", stateFile: path.join(dir, "s.json"), tokenExpires: "2027-06-30" });
  assert.equal(s.status().tokenExpires, "2027-06-30");
  assert.equal(ib.createIbSync({ token: "t", positionsQuery: "1", stateFile: path.join(dir, "s.json"), tokenExpires: "明年" }).status().tokenExpires, null);
});

test("请求间隔: 连续请求至少隔 minGapMs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibg-"));
  const times = [];
  const fetchText = async (url) => {
    times.push(Date.now());
    if (url.includes("SendRequest")) return "<FlexStatementResponse><Status>Success</Status><ReferenceCode>R</ReferenceCode></FlexStatementResponse>";
    return "<FlexQueryResponse><OpenPositions></OpenPositions></FlexQueryResponse>";
  };
  const s = ib.createIbSync({ token: "t", positionsQuery: "1", confirmsQuery: "2", stateFile: path.join(dir, "s.json"), minGapMs: 150,
    fetchText, loadPortfolio: () => ({ accounts: [{ name: "IB", holdings: [] }] }), savePortfolio: () => true, appendTrade: (h) => h, log: () => {} });
  await s.run(["confirms", "positions"]);
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 140, `第 ${i} 次间隔 ${times[i] - times[i - 1]}ms`);
});

test("状态: 记上次成功时间; 硬错误/临时错误区分", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibs-"));
  let mode = "ok";
  const fetchText = async (url) => {
    if (mode === "hard") return "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode></FlexStatementResponse>";
    if (mode === "soft") return "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1018</ErrorCode></FlexStatementResponse>";
    if (url.includes("SendRequest")) return "<FlexStatementResponse><Status>Success</Status><ReferenceCode>R</ReferenceCode></FlexStatementResponse>";
    return "<FlexQueryResponse><OpenPositions></OpenPositions></FlexQueryResponse>";
  };
  const s = ib.createIbSync({ token: "t", positionsQuery: "1", stateFile: path.join(dir, "s.json"), minGapMs: 0,
    fetchText, loadPortfolio: () => ({ accounts: [{ name: "IB", holdings: [] }] }), savePortfolio: () => true, appendTrade: (h) => h, log: () => {} });
  await s.run(["positions"]);
  const okAt = s.status().lastOkAt;
  assert.ok(okAt);
  mode = "soft"; await s.run(["positions"]);
  assert.equal(s.status().positions.ok, false); assert.ok(!s.status().positions.hard); assert.equal(s.status().lastOkAt, okAt);
  mode = "hard"; await s.run(["positions"]);
  assert.equal(s.status().positions.hard, true); assert.equal(s.status().positions.code, "1012");
});

test("场外清零: 卖出记一笔 sell 并清零; 清零后重启不被环境变量恢复; 不再支持转入", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibe-"));
  const stateFile = path.join(dir, "s.json");
  let pf = board();
  const mk = () => ib.createIbSync({ token: "t", positionsQuery: "1", stateFile, extras: ib.parseExtras("AAPL:3:160"), minGapMs: 0,
    fetchText: async () => "", loadPortfolio: () => JSON.parse(JSON.stringify(pf)), savePortfolio: (p) => { pf = p; return true; }, appendTrade, log: () => {} });
  let s = mk();
  assert.deepEqual(s.status().extras, { AAPL: { qty: 3, cost: 160 } });
  await assert.rejects(s.clearExtra("AAPL", { mode: "sold" }), /卖出价/);
  await assert.rejects(s.clearExtra("AAPL", { mode: "transferred" }), /只能是 sold/);
  await assert.rejects(s.clearExtra("GOOGL", { mode: "sold", price: 1 }), /没有场外股数/);
  const r = await s.clearExtra("aapl", { mode: "sold", price: 170 });
  assert.equal(r.qty, 3);
  const t = pf.accounts[1].holdings.find((h) => h.symbol === "AAPL");
  assert.equal(t.shares, 9); assert.equal(t.transactions.at(-1).type, "sell"); assert.equal(t.transactions.at(-1).price, 170);
  assert.deepEqual(s.status().extras, {});
  s = mk();                                                                       // 模拟重启: 环境变量仍是 AAPL:3
  assert.deepEqual(s.status().extras, {});
  await assert.rejects(s.clearExtra("AAPL", { mode: "sold", price: 1 }), /没有场外股数/);
});

test("持仓报表没更新(日期不比上次新): 不写入、标 stale; 新日期才对账", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibd-"));
  let pf = board();
  let xml = "";
  const mkXml = (date, aaplQty) => `<FlexQueryResponse><FlexStatements count="1"><FlexStatement accountId="U1" fromDate="${date}" toDate="${date}" period="LastBusinessDay"><OpenPositions>
<OpenPosition symbol="AAPL" position="${aaplQty}" costBasisPrice="155" />
<OpenPosition symbol="QQQM" position="10" costBasisPrice="205" />
</OpenPositions></FlexStatement></FlexStatements></FlexQueryResponse>`;
  const fetchText = async (url) => url.includes("SendRequest") ? "<FlexStatementResponse><Status>Success</Status><ReferenceCode>R</ReferenceCode></FlexStatementResponse>" : xml;
  const s = ib.createIbSync({ token: "t", positionsQuery: "1", stateFile: path.join(dir, "s.json"), minGapMs: 0, extras: {},
    fetchText, loadPortfolio: () => JSON.parse(JSON.stringify(pf)), savePortfolio: (p) => { pf = p; return true; }, appendTrade, log: () => {} });
  assert.equal(ib.statementDate(mkXml("20260713", 9)), "20260713");
  xml = mkXml("20260713", 9); await s.run(["positions"]);               // 基线
  xml = mkXml("20260713", 30); let r = (await s.run(["positions"])).positions;   // 同一天的报表(哪怕内容不同)不处理
  assert.equal(r.stale, true); assert.equal(pf.accounts[1].holdings.find((h) => h.symbol === "AAPL").shares, 12);
  assert.equal(s.status().positions.stale, true);
  xml = mkXml("20260714", 11); r = (await s.run(["positions"])).positions;        // 新日期 → 正常对账
  assert.ok(!r.stale);
  assert.equal(pf.accounts[1].holdings.find((h) => h.symbol === "AAPL").shares, 11);
});
