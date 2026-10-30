"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { parseCsv, detectColumns, extractRows, planImport } = require("../csv-import");
const { login, request, startServer } = require("./helpers/server-harness");

test("解析: BOM、引号里的逗号、千分位、前面有说明行的中文表头", () => {
  const csv = "﻿导出时间,2026-10-30\n\n证券代码,证券名称,股票余额,成本价(元),市值\r\nSH600519,贵州茅台,\"1,000\",\"1,650.50\",x\n000001,平安银行,200,10.2,y\n";
  const rows = parseCsv(csv);
  const { headerRow, columns } = detectColumns(rows);
  assert.equal(headerRow, 1);
  assert.deepEqual(columns, { symbol: 0, name: 1, qty: 2, cost: 3 });
  assert.deepEqual(extractRows(rows, headerRow, columns), [
    { symbol: "600519", name: "贵州茅台", qty: 1000, cost: 1650.5 },
    { symbol: "000001", name: "平安银行", qty: 200, cost: 10.2 },
  ]);
});

test("解析: 英文表头、制表符分隔、AAPL.US 后缀", () => {
  const rows = parseCsv("Symbol\tDescription\tQuantity\tAvg Cost\nAAPL.US\tApple\t10\t$180.5\n");
  const { headerRow, columns } = detectColumns(rows);
  assert.deepEqual(extractRows(rows, headerRow, columns), [{ symbol: "AAPL", name: "Apple", qty: 10, cost: 180.5 }]);
});

test("导入计划: 新增/有变化/没变化/文件里没有的(只提示); 港股补零", () => {
  const acc = { currency: "HKD", holdings: [{ symbol: "00700", name: "腾讯", shares: 100, costPrice: 380 }, { symbol: "09988", shares: 50, costPrice: 80 }, { symbol: "03690", shares: 10, costPrice: 120 }] };
  const plan = planImport(acc, [{ symbol: "700", qty: 200, cost: 390 }, { symbol: "9988", qty: 50, cost: 80 }, { symbol: "1810", name: "小米", qty: 1000, cost: 20 }]);
  assert.deepEqual(plan.map((x) => [x.status, x.symbol]), [["update", "00700"], ["same", "09988"], ["new", "01810"], ["missing", "03690"]]);
  assert.equal(plan[2].market, "hk");
});

test("接口: 需登录; 预览不写; 确认后只改有变化的并新建, 不删其它持仓", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const body = { accountIndex: 0, rows: [{ symbol: "TSLA", qty: 12, cost: 310 }, { symbol: "MSFT", name: "微软", qty: 3, cost: 400 }] };
  assert.equal((await request(server.baseUrl, "/api/import/positions", { method: "POST", body })).status, 401);
  const token = await login(server.baseUrl);
  const prev = await request(server.baseUrl, "/api/import/positions", { method: "POST", body, token });
  assert.deepEqual(prev.json.plan.map((x) => x.status), ["update", "new", "missing"]);
  let pf = (await request(server.baseUrl, "/api/portfolio", { token })).json;
  assert.equal(pf.accounts[0].holdings.find((h) => h.symbol === "TSLA").shares, 10, "预览不写");
  const ok = await request(server.baseUrl, "/api/import/positions", { method: "POST", body: { ...body, apply: true }, token });
  assert.equal(ok.json.applied, true);
  pf = (await request(server.baseUrl, "/api/portfolio", { token })).json;
  const hs = pf.accounts[0].holdings;
  assert.equal(hs.find((h) => h.symbol === "TSLA").shares, 12);
  assert.equal(hs.find((h) => h.symbol === "MSFT").market, "nasdaq");
  assert.ok(hs.find((h) => h.symbol === "000001"), "文件里没有的不删");
});
