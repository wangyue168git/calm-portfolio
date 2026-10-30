"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { fixturePortfolio, login, readPortfolio, request, startServer } = require("./helpers/server-harness");

test("public resources, cache validation and private files follow the allowlist", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const home = await fetch(server.baseUrl + "/", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /text\/html/);
  assert.equal(home.headers.get("cache-control"), "no-cache");
  assert.match(await home.text(), /<!DOCTYPE html>/i);

  const asset = await fetch(server.baseUrl + "/classify.js?v=1", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const etag = asset.headers.get("etag");
  // fetch transparently decompresses response bodies while preserving the original header.
  const source = await asset.text();
  assert.match(source, /classifyLookThroughBucket/);

  const cached = await fetch(server.baseUrl + "/classify.js?v=1", { headers: { "If-None-Match": etag, "Accept-Encoding": "gzip" } });
  assert.equal(cached.status, 304);
  const head = await fetch(server.baseUrl + "/m.html", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.ok(Number(head.headers.get("content-length")) > 0);

  assert.equal((await fetch(server.baseUrl + "/server.js")).status, 404);
  assert.equal((await fetch(server.baseUrl + "/package.json")).status, 404);
  assert.equal((await fetch(server.baseUrl + "/missing")).status, 404);
});

test("authentication rejects bad credentials, locks repeated failures and protects mutations", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  assert.equal((await request(server.baseUrl, "/api/account", { method: "POST", body: { name: "x" } })).status, 401);
  assert.equal((await request(server.baseUrl, "/api/auth", { method: "POST", body: { password: "wrong" } })).status, 403);
  for (let i = 0; i < 4; i++) await request(server.baseUrl, "/api/auth", { method: "POST", body: { password: "wrong" } });
  const locked = await request(server.baseUrl, "/api/auth", { method: "POST", body: { password: "test-password" } });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
});

test("read APIs expose portfolio, dashboard, history, health and local history export", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const portfolio = await request(server.baseUrl, "/api/portfolio");
  assert.equal(portfolio.status, 200);
  assert.equal(portfolio.json.accounts.length, 2);
  assert.match(portfolio.headers.get("cache-control"), /no-store/);

  const data = await request(server.baseUrl, "/api/data");
  assert.equal(data.status, 200);
  assert.equal(data.json.accounts[0].holdings[0].currentPrice, 400);
  assert.ok(data.json.lookThrough.buckets.length > 0);

  const history = await request(server.baseUrl, "/api/history?range=all&maxPoints=50");
  assert.equal(history.status, 200);
  assert.equal(history.json.range, "all");
  assert.ok(history.json.history.length >= 5);
  assert.ok(history.json.riskMetrics);
  const since = await request(server.baseUrl, "/api/history?since=2099-01-01T00:00:00.000Z");
  assert.deepEqual(since.json.history, []);

  const health = await request(server.baseUrl, "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.json.healthy, true);
  assert.ok(health.json.refresh.lastCompletedAt);

  const exported = await request(server.baseUrl, "/api/internal/history-export");
  assert.equal(exported.status, 200);
  assert.ok(exported.json.snapshots.length >= 5);
});

test("startup reconciles stale holding snapshots from transaction history", async (t) => {
  const portfolio = fixturePortfolio();
  const fund = portfolio.accounts[0].holdings[1];
  fund.shares = 100;
  fund.costPrice = 1;
  fund.transactions.push({ type: "buy", shares: 100, price: 1.2, date: "2026-01-02T00:00:00.000Z", note: "申购#legacy" });
  const server = await startServer({ portfolio });
  t.after(() => server.stop());

  const saved = readPortfolio(server).accounts[0].holdings[1];
  assert.equal(saved.shares, 200);
  assert.equal(saved.costPrice, 1.1);
  assert.equal((await request(server.baseUrl, "/api/portfolio")).json.accounts[0].holdings[1].shares, 200);
});

test("account, holding and trade CRUD persists derived position values", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const token = await login(server.baseUrl);

  assert.equal((await request(server.baseUrl, "/api/account", { method: "POST", token, body: { name: "交易账户", currency: "CNY" } })).status, 200);
  assert.equal((await request(server.baseUrl, "/api/holding", { method: "POST", token, body: {
    accountIndex: 2, holding: { symbol: "000002", name: "测试", market: "sz", shares: 10, costPrice: 5 },
  } })).status, 200);
  let holding = readPortfolio(server).accounts[2].holdings[0];
  assert.equal(holding.shares, 10);
  assert.equal(holding.transactions.length, 1);

  assert.equal((await request(server.baseUrl, "/api/trade", { method: "POST", token, body: {
    accountIndex: 2, holdingIndex: 0, trade: { type: "buy", shares: 10, price: 7, date: "2026-01-02" },
  } })).status, 200);
  holding = readPortfolio(server).accounts[2].holdings[0];
  assert.equal(holding.shares, 20);
  assert.equal(holding.costPrice, 6);

  assert.equal((await request(server.baseUrl, "/api/trade", { method: "POST", token, body: {
    accountIndex: 2, holdingIndex: 0, trade: { type: "sell", shares: 5, price: 8, date: "2026-01-03" },
  } })).status, 200);
  const oversell = await request(server.baseUrl, "/api/trade", { method: "POST", token, body: {
    accountIndex: 2, holdingIndex: 0, trade: { type: "sell", shares: 999, price: 8 },
  } });
  assert.equal(oversell.status, 400);
  assert.match(oversell.text, /不能超过/);

  assert.equal((await request(server.baseUrl, "/api/trade", { method: "DELETE", token, body: { accountIndex: 2, holdingIndex: 0, tradeIndex: 2 } })).status, 200);
  assert.equal((await request(server.baseUrl, "/api/holding", { method: "PUT", token, body: { accountIndex: 2, holdingIndex: 0, shares: 30, costPrice: 9 } })).status, 200);
  holding = readPortfolio(server).accounts[2].holdings[0];
  assert.equal(holding.shares, 30);
  assert.equal(holding.costPrice, 9);

  assert.equal((await request(server.baseUrl, "/api/holding?account=2&index=0", { method: "DELETE", token })).status, 200);
  assert.equal(readPortfolio(server).accounts[2].holdings.length, 0);
  assert.equal((await request(server.baseUrl, "/api/holding?account=99&index=0", { method: "DELETE", token })).status, 400);
});

test("cash, exchange rate, fund orders and journal CRUD complete their lifecycle", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const token = await login(server.baseUrl);

  assert.equal((await request(server.baseUrl, "/api/cash", { method: "PUT", token, body: { account: 0, cash: 456.78 } })).status, 200);
  assert.equal((await request(server.baseUrl, "/api/rate", { method: "POST", token, body: { rate: 7.25 } })).status, 200);
  let portfolio = readPortfolio(server);
  assert.equal(portfolio.accounts[0].cash, 456.78);
  assert.equal(portfolio.exchangeRate.USD_CNY, 7.25);

  const orderResult = await request(server.baseUrl, "/api/fund/order", { method: "POST", token, body: {
    accountIndex: 0, holdingIndex: 1, amount: 120, date: "2026-07-10", afterCutoff: true,
  } });
  assert.equal(orderResult.status, 200);
  portfolio = readPortfolio(server);
  const order = portfolio.accounts[0].holdings[1].orders[0];
  assert.equal(order.status, "pending");
  assert.equal(order.afterCutoff, true);

  assert.equal((await request(server.baseUrl, "/api/fund/calibrate", { method: "POST", token, body: {
    accountIndex: 0, holdingIndex: 1, orderId: order.id, nav: 1.2,
  } })).status, 200);
  portfolio = readPortfolio(server);
  const fund = portfolio.accounts[0].holdings[1];
  assert.equal(fund.orders[0].status, "confirmed");
  assert.equal(fund.orders[0].shares, 100);
  assert.ok(fund.transactions.some((tx) => tx.note === `申购#${order.id}`));
  assert.equal(fund.shares, 200);
  assert.equal(fund.costPrice, 1.1);

  assert.equal((await request(server.baseUrl, "/api/fund/order", { method: "DELETE", token, body: {
    accountIndex: 0, holdingIndex: 1, orderId: order.id,
  } })).status, 200);
  portfolio = readPortfolio(server);
  assert.equal(portfolio.accounts[0].holdings[1].orders.length, 0);
  assert.equal(portfolio.accounts[0].holdings[1].transactions.some((tx) => tx.note === `申购#${order.id}`), false);
  assert.equal(portfolio.accounts[0].holdings[1].shares, 100);
  assert.equal(portfolio.accounts[0].holdings[1].costPrice, 1);

  assert.equal((await request(server.baseUrl, "/api/journal", { method: "POST", token, body: { title: "初稿", content: "a" } })).status, 200);
  let journal = (await request(server.baseUrl, "/api/journal")).json;
  assert.equal(journal[0].title, "初稿");
  const createdAt = journal[0].date;
  assert.equal((await request(server.baseUrl, "/api/journal", { method: "PUT", token, body: { index: 0, entry: { title: "修订", content: "b" } } })).status, 200);
  journal = (await request(server.baseUrl, "/api/journal")).json;
  assert.equal(journal[0].title, "修订");
  assert.equal(journal[0].date, createdAt);
  assert.ok(journal[0].editDate);
  assert.equal((await request(server.baseUrl, "/api/journal", { method: "DELETE", token, body: { index: 0 } })).status, 200);
  assert.deepEqual((await request(server.baseUrl, "/api/journal")).json, []);
});

test("invalid mutation inputs return client errors without changing files", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const token = await login(server.baseUrl);
  const before = fs.readFileSync(`${server.dir}/portfolio.json`, "utf8");
  assert.equal((await request(server.baseUrl, "/api/holding", { method: "POST", token, body: { accountIndex: 99, holding: {} } })).status, 400);
  assert.equal((await request(server.baseUrl, "/api/holding", { method: "PUT", token, body: { accountIndex: 99, holdingIndex: 0 } })).status, 400);
  assert.equal((await request(server.baseUrl, "/api/trade", { method: "DELETE", token, body: { accountIndex: 0, holdingIndex: 0, tradeIndex: 99 } })).status, 400);
  assert.equal((await request(server.baseUrl, "/api/fund/order", { method: "POST", token, body: { accountIndex: 0, holdingIndex: 1, amount: 0 } })).status, 400);
  assert.equal((await request(server.baseUrl, "/api/fund/calibrate", { method: "POST", token, body: { accountIndex: 0, holdingIndex: 1, orderId: "missing" } })).status, 400);
  assert.equal((await request(server.baseUrl, "/api/cash", { method: "PUT", token, body: { account: 99, cash: 1 } })).status, 400);
  assert.equal((await request(server.baseUrl, "/api/journal", { method: "PUT", token, body: { index: 9, entry: {} } })).status, 400);
  assert.equal((await request(server.baseUrl, "/api/journal", { method: "DELETE", token, body: { index: 9 } })).status, 400);
  assert.equal(fs.readFileSync(`${server.dir}/portfolio.json`, "utf8"), before);
});

test("request size limits and malformed JSON fail safely", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const malformed = await fetch(server.baseUrl + "/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  });
  assert.equal(malformed.status, 400);

  // The server may close the connection immediately after returning 413; accept either fetch outcome,
  // then verify the process remains healthy and responsive.
  try {
    const oversized = await fetch(server.baseUrl + "/api/auth", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "x".repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  } catch (error) {
    assert.match(String(error), /fetch failed|socket|terminated/i);
  }
  assert.equal((await request(server.baseUrl, "/healthz")).status, 200);
});
