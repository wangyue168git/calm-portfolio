"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildAiContext } = require("../ai/context");
const { extractProposals } = require("../ai/prompts");
const { aiConfigFromEnv, streamChat } = require("../ai/providers");
const { createPendingStore } = require("../ai/pending");
const { login, request, startServer } = require("./helpers/server-harness");

const data = {
  rateInfo: { USD_CNY: 7 }, timestamp: "2026-10-30T08:00:00Z",
  accounts: [{ name: "IB", currency: "USD", cash: 100, holdings: [
    { symbol: "QQQM", name: "纳指100", market: "nasdaq", shares: 50, costPrice: 180, currentPrice: 200, marketValue: 10000 },
    { symbol: "AAPL", name: "苹果", market: "nasdaq", shares: 10, costPrice: 150, currentPrice: 200, marketValue: 2000 },
    { symbol: "MSFT", name: "微软", market: "nasdaq", shares: 1, costPrice: 400, currentPrice: 400, marketValue: 400 },
  ] }],
};
const plan = {
  targetAllocation: { indexTargetPct: 60, stockCapPct: 40, singleCapPct: 10 },
  channels: { default: "seal", stockBucketCapPct: 40, symbols: {
    QQQM: { type: "open", why: "定投" },
    AAPL: { type: "band", openBelowPct: 8, sealAtPct: 10, targetShares: 20 },
    "513500": { type: "premium", maxPremiumPct: 3 },
  }, indexPlan: { symbols: ["QQQM"], monthlyCNY: 5000, passCNY: 3000 } },
};

test("给 AI 的数据: 默认只发比例(无金额/股数); 选择发金额时才带; 规则覆盖和目标完成度都算好", () => {
  const a = buildAiContext(data, plan).text;
  assert.doesNotMatch(a, /¥\d|总资产：|\d+ 股；/);
  assert.match(a, /每月指数定投：QQQM 任选，设了每月目标金额/);
  assert.match(a, /QQQM 纳指100；分组 纳指指数类；占比 80\.0%/);
  assert.match(a, /AAPL 苹果；分组 个股；占比 16\.0%；浮盈亏 \+33\.3%；规则：8% 以下可加、10% 封仓、设了目标股数；目标股数完成 50%；当前：封仓（目标股数完成 50%/);
  assert.match(a, /MSFT 微软；分组 观察仓/);
  assert.match(a, /持有但没写规则：MSFT/);
  assert.match(a, /写了规则但没持有：513500（看场内溢价）/);
  const b = buildAiContext(data, plan, { anonymize: false }).text;
  assert.match(b, /总资产：¥87,500/);
  assert.match(b, /10 股；市值 ¥14,000/);
});

test("建议解析: 只留合法的、和现状不同的; 溢价规则不让改", () => {
  const text = "好的。\n```calm-proposals\n" + JSON.stringify([
    { kind: "symbol", symbol: "aapl", rule: { type: "band", openBelowPct: 6, sealAtPct: 8 }, why: "和 QQQM 重叠" },
    { kind: "symbol", symbol: "QQQM", rule: { type: "open" }, why: "没变化" },
    { kind: "symbol", symbol: "513500", rule: { type: "open" }, why: "不许改溢价" },
    { kind: "symbol", symbol: "MSFT", rule: { type: "weird" } },
    { kind: "allocation", stockCapPct: 30, indexTargetPct: 60, why: "降个股" },
  ]) + "\n```";
  const p = extractProposals(text, plan);
  assert.deepEqual(p.map((x) => x.summary), ["AAPL：8% 以下可加、10% 封仓、目标 20 股 → 6% 以下可加、8% 封仓", "个股合计上限 40% → 30%"]);
  assert.deepEqual(extractProposals("没有代码块", plan), []);
  assert.deepEqual(extractProposals("```calm-proposals\n不是 JSON\n```", plan), []);
});

test("Claude: 用官方 SDK 流式取文字(指向本地模拟的 Messages 接口)", async (t) => {
  let got;
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      got = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "结构" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "正常。" } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const cfg = aiConfigFromEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "sk-test", AI_BASE_URL: `http://127.0.0.1:${srv.address().port}` });
  assert.equal(cfg.model, "claude-opus-5-5");
  let text = "";
  const r = await streamChat(cfg, { system: "S", messages: [{ role: "user", content: "体检" }], onText: (x) => (text += x) });
  assert.equal(text, "结构正常。");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(got.auth, "Bearer sk-test");
  assert.match(got.url, /\/v1\/messages/);
  assert.equal(got.body.model, "claude-opus-5-5");
  assert.equal(got.body.stream, true);
  assert.equal(got.body.system, "S");
  assert.deepEqual(got.body.output_config, { effort: "medium" });
});

test("OpenAI 兼容接口: 解析流式 SSE, 系统提示放第一条", async (t) => {
  let got;
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      got = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const cfg = aiConfigFromEnv({ AI_PROVIDER: "openai", AI_API_KEY: "k", AI_BASE_URL: `http://127.0.0.1:${srv.address().port}/v1`, AI_MODEL: "deepseek-chat" });
  let text = "";
  await streamChat(cfg, { system: "S", messages: [{ role: "user", content: "hi" }], onText: (x) => (text += x) });
  assert.equal(text, "你好，世界");
  assert.equal(got.url, "/v1/chat/completions");
  assert.equal(got.auth, "Bearer k");
  assert.deepEqual(got.body.messages[0], { role: "system", content: "S" });
  assert.equal(got.body.model, "deepseek-chat");
});

test("配置: 没填 provider 或 key 不启用; mock 只在测试环境可用", () => {
  assert.equal(aiConfigFromEnv({}).enabled, false);
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: "anthropic" }).enabled, false);
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: "mock" }).enabled, false);
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: "openai", AI_BASE_URL: "http://localhost:11434/v1" }).enabled, true, "本地 Ollama 不需要 key");
});

test("冷静期队列: 到期才取出, 可撤销", () => {
  const store = createPendingStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-")), "p.json"));
  const now = new Date("2026-10-30T00:00:00Z");
  const a = store.add({ proposals: [{ kind: "symbol" }], reason: "r", hours: 24, now });
  const b = store.add({ proposals: [{ kind: "symbol" }], reason: "r2", hours: 24, now });
  assert.deepEqual(store.takeDue(new Date("2026-10-30T12:00:00Z")), []);
  assert.equal(store.cancel(b.id), true);
  assert.deepEqual(store.takeDue(new Date("2026-10-31T00:00:01Z")).map((x) => x.id), [a.id]);
  assert.deepEqual(store.list(), []);
});

const MOCK = "AAPL 和 QQQM 有重叠。\n```calm-proposals\n" + JSON.stringify([{ kind: "symbol", symbol: "TSLA", rule: { type: "band", openBelowPct: 5, sealAtPct: 8 }, why: "补规则" }]) + "\n```";
async function readSse(server, token, body) {
  const res = await fetch(`${server.baseUrl}/api/ai/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Token": token }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
  return { status: res.status, events };
}

test("接口: 需登录; 未配置时只有 config; 对话流式返回并给出建议; 确认后写进 plan 并记 AI 来源", async (t) => {
  const off = await startServer();
  t.after(() => off.stop());
  assert.equal((await request(off.baseUrl, "/api/ai/config")).status, 401);
  const tok0 = await login(off.baseUrl);
  assert.equal((await request(off.baseUrl, "/api/ai/config", { token: tok0 })).json.enabled, false);
  assert.equal((await request(off.baseUrl, "/api/ai/context", { method: "POST", token: tok0, body: {} })).status, 404);

  const server = await startServer({ extraEnv: { AI_PROVIDER: "mock", AI_MOCK_REPLY: MOCK } });
  t.after(() => server.stop());
  const token = await login(server.baseUrl);
  const cfg = (await request(server.baseUrl, "/api/ai/config", { token })).json;
  assert.deepEqual([cfg.enabled, cfg.anonymizeDefault, cfg.cooldownHours], [true, true, 0]);
  const ctx = (await request(server.baseUrl, "/api/ai/context", { method: "POST", token, body: { anonymize: true } })).json;
  assert.match(ctx.text, /TSLA/);
  assert.equal((await readSse(server, token, { messages: [{ role: "assistant", content: "x" }] })).status, 400);
  const { events } = await readSse(server, token, { messages: [{ role: "user", content: "体检" }] });
  assert.equal(events.filter(([e]) => e === "delta").map(([, d]) => d.t).join(""), MOCK);
  const done = events.find(([e]) => e === "done")[1];
  assert.equal(done.proposals.length, 1);
  assert.match(done.proposals[0].summary, /TSLA：未设（按默认） → 5% 以下可加、8% 封仓/);
  const ap = (await request(server.baseUrl, "/api/ai/apply", { method: "POST", token, body: { proposals: done.proposals, reason: "同意" } })).json;
  assert.deepEqual([ap.ok, ap.pending, ap.results[0].ok], [true, false, true]);
  const saved = JSON.parse(fs.readFileSync(path.join(server.dir, "plan.json"), "utf8"));
  assert.equal(saved.channels.symbols.TSLA.sealAtPct, 8);
  const last = saved.changelog[saved.changelog.length - 1];
  assert.equal(last.source, "ai");
  assert.match(last.reason, /同意（AI 建议：补规则）/);
  assert.equal((await request(server.baseUrl, "/api/ai/apply", { method: "POST", token, body: { proposals: done.proposals } })).status, 400, "已经一样了");
});

test("接口: 设了冷静期时先存为待生效, 可撤销, plan 不变", async (t) => {
  const server = await startServer({ extraEnv: { AI_PROVIDER: "mock", AI_MOCK_REPLY: MOCK, AI_COOLDOWN_HOURS: "24" } });
  t.after(() => server.stop());
  const token = await login(server.baseUrl);
  const proposals = [{ kind: "allocation", change: { stockCapPct: 25 }, why: "降个股" }];
  const ap = (await request(server.baseUrl, "/api/ai/apply", { method: "POST", token, body: { proposals } })).json;
  assert.equal(ap.pending, true);
  const items = (await request(server.baseUrl, "/api/ai/pending", { token })).json.items;
  assert.equal(items.length, 1);
  assert.equal(fs.existsSync(path.join(server.dir, "plan.json")) && JSON.parse(fs.readFileSync(path.join(server.dir, "plan.json"), "utf8")).targetAllocation?.stockCapPct === 25, false);
  assert.equal((await request(server.baseUrl, `/api/ai/pending?id=${items[0].id}`, { method: "DELETE", token })).status, 200);
  assert.equal((await request(server.baseUrl, "/api/ai/pending", { token })).json.items.length, 0);
});
