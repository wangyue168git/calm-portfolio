"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  connectWs,
  login,
  nextWsMessageOfType,
  request,
  startServer,
} = require("./helpers/server-harness");

test("portfolio and journal mutations report persistence failures", async (t) => {
  const server = await startServer({ failWrites: true });
  t.after(() => server.stop());
  const token = await login(server.baseUrl);
  const portfolioPath = path.join(server.dir, "portfolio.json");
  const journalPath = path.join(server.dir, "journal.json");
  const originalPortfolio = fs.readFileSync(portfolioPath, "utf8");
  const originalJournal = fs.readFileSync(journalPath, "utf8");

  const account = await request(server.baseUrl, "/api/account", {
    method: "POST",
    token,
    body: { name: "不应保存", currency: "CNY" },
  });
  assert.equal(account.status, 500);
  assert.deepEqual(account.json, { ok: false, error: "数据保存失败，请稍后重试" });
  assert.equal(fs.readFileSync(portfolioPath, "utf8"), originalPortfolio);

  const journal = await request(server.baseUrl, "/api/journal", {
    method: "POST",
    token,
    body: { title: "不应保存" },
  });
  assert.equal(journal.status, 500);
  assert.deepEqual(journal.json, { ok: false, error: "数据保存失败，请稍后重试" });
  assert.equal(fs.readFileSync(journalPath, "utf8"), originalJournal);
});

test("WebSocket sends patches for quotes and a full portfolio after mutations", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ws = await connectWs(server.baseUrl);
  t.after(() => ws.close());

  const initial = await nextWsMessageOfType(ws, "portfolio");
  assert.equal(initial.data.accounts[0].holdings[0].currentPrice, 400);

  const patchPromise = nextWsMessageOfType(ws, "portfolio_patch");
  const refresh = await request(server.baseUrl, "/__test/refresh", {
    method: "POST",
    body: { groups: ["us"] },
  });
  assert.equal(refresh.status, 200);
  assert.deepEqual(refresh.json.successful, ["us"]);
  const patch = await patchPromise;
  assert.equal(patch.data.accounts[0].holdings[0].currentPrice, 400);
  assert.equal("riskMetrics" in patch.data, false);

  const token = await login(server.baseUrl);
  const fullPromise = nextWsMessageOfType(ws, "portfolio");
  const mutation = await request(server.baseUrl, "/api/cash", {
    method: "PUT",
    token,
    body: { account: 0, cash: 321 },
  });
  assert.equal(mutation.status, 200);
  const full = await fullPromise;
  assert.equal(full.data.accounts[0].cash, 321);
});

test("a mutation during quote refresh queues a full WebSocket update", async (t) => {
  const server = await startServer({ extraEnv: { STOCK_TEST_QUOTE_DELAY_MS: "80" } });
  t.after(() => server.stop());
  const ws = await connectWs(server.baseUrl);
  t.after(() => ws.close());
  await nextWsMessageOfType(ws, "portfolio");

  const refreshPromise = request(server.baseUrl, "/__test/refresh", {
    method: "POST",
    body: { groups: ["us"] },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const token = await login(server.baseUrl);
  const fullPromise = nextWsMessageOfType(ws, "portfolio");
  const mutation = await request(server.baseUrl, "/api/cash", {
    method: "PUT",
    token,
    body: { account: 0, cash: 654 },
  });
  assert.equal(mutation.status, 200);
  assert.equal((await refreshPromise).status, 200);
  const full = await fullPromise;
  assert.equal(full.data.accounts[0].cash, 654);
});

test("WebSocket rejects client messages", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ws = await connectWs(server.baseUrl);
  ws.send("unexpected");
  const [code, reason] = await new Promise((resolve) => ws.once("close", (c, r) => resolve([c, String(r)])));
  assert.equal(code, 1008);
  assert.equal(reason, "client messages not supported");
});
