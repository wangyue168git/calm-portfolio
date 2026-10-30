"use strict";

const { fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "../..");

function quote(price, name) {
  return { price, name, changePercent: 1.25, change: 1, high: price + 1, low: price - 1, open: price - 0.5, prevClose: price - 1 };
}

function fixturePortfolio() {
  return {
    exchangeRate: { USD_CNY: 7 },
    accounts: [
      {
        name: "美元账户", currency: "USD", cash: 100, holdings: [
          { symbol: "TSLA", name: "特斯拉", market: "nasdaq", shares: 10, costPrice: 300, transactions: [{ type: "sync", shares: 10, price: 300, date: "2026-01-01T00:00:00.000Z" }] },
          { symbol: "000001", name: "测试基金", market: "fund", shares: 100, costPrice: 1, transactions: [{ type: "sync", shares: 100, price: 1, date: "2026-01-01T00:00:00.000Z" }], orders: [] },
        ],
      },
      {
        name: "人民币账户", currency: "CNY", cash: 200, holdings: [
          { symbol: "600000", name: "浦发银行", market: "sh", shares: 100, costPrice: 9, transactions: [{ type: "sync", shares: 100, price: 9, date: "2026-01-01T00:00:00.000Z" }] },
          { symbol: "ETH", name: "以太坊", market: "crypto", shares: 1, costPrice: 2000, transactions: [{ type: "sync", shares: 1, price: 2000, date: "2026-01-01T00:00:00.000Z" }] },
        ],
      },
    ],
  };
}

function fixtureQuotes() {
  return {
    "105.TSLA": quote(400, "Tesla"),
    "fund.000001": quote(1.2, "测试基金"),
    "1.600000": quote(10, "浦发银行"),
    "crypto.ETH": quote(2500, "ETH"),
  };
}

function writeFixtures(dir, portfolio = fixturePortfolio()) {
  fs.writeFileSync(path.join(dir, "portfolio.json"), JSON.stringify(portfolio));
  fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify({ snapshots: [
    { t: "2026-01-01T00:00:00.000Z", v: 1000, c: 900 },
    { t: "2026-01-02T00:00:00.000Z", v: 1010, c: 900 },
    { t: "2026-01-03T00:00:00.000Z", v: 1020, c: 900 },
    { t: "2026-01-04T00:00:00.000Z", v: 1030, c: 900 },
    { t: "2026-01-05T00:00:00.000Z", v: 1040, c: 900 },
  ] }));
  fs.writeFileSync(path.join(dir, "history.journal"), "");
  fs.writeFileSync(path.join(dir, "journal.json"), "[]");
  fs.writeFileSync(path.join(dir, "prices_cache.json"), "{}");
}

async function startServer({ quotes = fixtureQuotes(), failWrites = false, portfolio, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calm-portfolio-test-"));
  writeFixtures(dir, portfolio);
  const child = fork(path.join(ROOT, "server.js"), [], {
    cwd: ROOT,
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: "0",
      STOCK_DATA_DIR: dir,
      STOCK_TEST_PASSWORD: "test-password",
      STOCK_TEST_EXCHANGE_RATE: "7",
      STOCK_TEST_QUOTES: JSON.stringify(quotes),
      STOCK_TEST_FAIL_WRITES: failWrites ? "1" : "0",
      PUBLIC_READ: "1",   // 大部分测试关注业务逻辑, 放开匿名只读; 登录保护单独在 auth.test.js 里测
      ...extraEnv,
    },
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [{ port }] = await once(child, "message");
  clearTimeout(timer);
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    dir, child, baseUrl, stderr,
    async stop() {
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function request(baseUrl, pathname, { method = "GET", token, body, headers = {} } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { "X-Auth-Token": token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, headers: response.headers, text, json };
}

function readPortfolio(server) {
  return JSON.parse(fs.readFileSync(path.join(server.dir, "portfolio.json"), "utf8"));
}

async function login(baseUrl, password = "test-password") {
  const result = await request(baseUrl, "/api/auth", { method: "POST", body: { password } });
  if (result.status !== 200) throw new Error(`login failed: ${result.status} ${result.text}`);
  return result.json.token;
}

function connectWs(baseUrl) {
  const ws = new WebSocket(baseUrl.replace(/^http/, "ws"));
  return once(ws, "open").then(() => ws);
}

function nextWsMessage(ws, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WebSocket message timed out")), timeout);
    ws.once("message", (buffer) => {
      clearTimeout(t);
      resolve(JSON.parse(String(buffer)));
    });
  });
}

async function nextWsMessageOfType(ws, type, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const message = await nextWsMessage(ws, deadline - Date.now());
    if (message.type === type) return message;
  }
  throw new Error(`WebSocket message ${type} timed out`);
}

module.exports = {
  connectWs, fixturePortfolio, fixtureQuotes, login, nextWsMessage, nextWsMessageOfType,
  readPortfolio, request, startServer,
};
