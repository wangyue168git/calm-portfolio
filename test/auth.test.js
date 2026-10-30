"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const WebSocket = require("ws");
const { login, request, startServer } = require("./helpers/server-harness");

test("默认读取也要登录: 未登录读持仓/规则返回 401, WebSocket 被拒; 登录后可读", async (t) => {
  const server = await startServer({ extraEnv: { PUBLIC_READ: "0" } });
  t.after(() => server.stop());

  for (const p of ["/api/data", "/api/portfolio", "/api/history", "/plan.json", "/api/journal", "/api/ib-sync", "/api/broker-sync"]) {
    const r = await request(server.baseUrl, p);
    assert.equal(r.status, 401, `${p} 未登录应返回 401`);
  }

  const wsUrl = server.baseUrl.replace(/^http/, "ws");
  const anon = new WebSocket(wsUrl);
  const [code] = await once(anon, "close");
  assert.equal(code, 4401);

  const token = await login(server.baseUrl);
  const data = await request(server.baseUrl, "/api/data", { token });
  assert.equal(data.status, 200);
  const plan = await request(server.baseUrl, "/plan.json", { token });
  assert.equal(plan.status, 200);
  assert.ok(plan.json && plan.json.channels, "没有 data/plan.json 时应返回示例规则");

  const authed = new WebSocket(`${wsUrl}/?token=${token}`);
  const [msg] = await once(authed, "message");
  assert.equal(JSON.parse(String(msg)).type, "portfolio");
  authed.close();
});

test("错误密码登录失败", async (t) => {
  const server = await startServer({ extraEnv: { PUBLIC_READ: "0" } });
  t.after(() => server.stop());
  const r = await request(server.baseUrl, "/api/auth", { method: "POST", body: { password: "wrong" } });
  assert.ok(!(r.json && r.json.ok), "错误密码不应登录成功");
});
