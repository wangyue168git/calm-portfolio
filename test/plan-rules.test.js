"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { login, request, startServer } = require("./helpers/server-harness");

test("单只标的规则: 需登录; 校验参数; 写入 data/plan.json 并能删除", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const put = (body, token) => request(server.baseUrl, "/api/plan/symbol", { method: "PUT", body, token });

  assert.equal((await put({ symbol: "MSFT", rule: { type: "open" } })).status, 401);
  const token = await login(server.baseUrl);

  assert.equal((await put({ symbol: "MSFT", rule: { type: "premium" } }, token)).status, 400);
  assert.equal((await put({ symbol: "MSFT", rule: { type: "band", openBelowPct: 12, sealAtPct: 10 } }, token)).status, 400);
  assert.equal((await put({ symbol: "bad symbol!", rule: { type: "open" } }, token)).status, 400);

  const ok = await put({ symbol: "msft", rule: { type: "band", openBelowPct: 8, sealAtPct: 10, targetShares: 20, why: "测试" } }, token);
  assert.equal(ok.status, 200);
  const planPath = path.join(server.dir, "plan.json");
  const saved = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.deepEqual(saved.channels.symbols.MSFT, { type: "band", openBelowPct: 8, sealAtPct: 10, targetShares: 20, why: "测试" });
  assert.ok(saved.channels.indexPlan, "首次写入以示例规则为底, 其他字段保留");

  const plan = await request(server.baseUrl, "/plan.json", { token });
  assert.equal(plan.json.channels.symbols.MSFT.targetShares, 20);

  assert.equal((await put({ symbol: "MSFT", rule: null }, token)).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(planPath, "utf8")).channels.symbols.MSFT, undefined);
});
