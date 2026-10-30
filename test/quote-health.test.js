"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canCommitGeneration, evaluateQuoteHealth, healthAfterMs, quoteKey, serializeFreshness, staleAfterMs,
} = require("../quote-health");

test("freshness keeps per-symbol partial failures visible", () => {
  const now = new Date("2026-07-13T02:00:00Z").getTime();
  const symbols = new Map([
    ["sh:600000", { market: "sh", symbol: "600000", group: "cn", lastAttemptAt: now, lastSuccessAt: now, consecutiveFailures: 0, cached: false }],
    ["sz:000001", { market: "sz", symbol: "000001", group: "cn", lastAttemptAt: now, lastSuccessAt: null, consecutiveFailures: 1, cached: true }],
  ]);
  const markets = new Map([["cn", { lastAttemptAt: now, lastSuccessAt: now, consecutiveFailures: 1, expected: 2, succeeded: 1, failed: 1 }]]);
  const result = serializeFreshness(symbols, markets, now);
  assert.equal(result.symbols["sh:600000"].stale, false);
  assert.equal(result.symbols["sz:000001"].stale, true);
  assert.equal(result.markets.cn.succeeded, 1);
  assert.equal(result.markets.cn.stale, true);
});

test("quote keys include market to avoid symbol collisions", () => {
  assert.notEqual(quoteKey({ market: "fund", symbol: "000001" }), quoteKey({ market: "sz", symbol: "000001" }));
});

test("late results from an invalidated refresh generation cannot commit", () => {
  assert.equal(canCommitGeneration(4, 5), false);
  assert.equal(canCommitGeneration(5, 5), true);
  assert.equal(canCommitGeneration(5, 5, true), false);
});

test("health tolerates startup but rejects severely stale active markets", () => {
  const now = new Date("2026-07-13T02:00:00Z").getTime();
  const freshness = { markets: { cn: { active: true, expected: 2, succeeded: 0, lastSuccessAt: now - 10 * 60 * 1000 } } };
  assert.equal(evaluateQuoteHealth(freshness, { now, startedAt: now - 30 * 1000 }).healthy, true);
  const health = evaluateQuoteHealth(freshness, { now, startedAt: now - 10 * 60 * 1000 });
  assert.equal(health.healthy, false);
  assert.deepEqual(health.unhealthyMarkets, ["cn"]);
});

test("one failed symbol degrades freshness without taking the service down", () => {
  const now = new Date("2026-07-13T02:00:00Z").getTime();
  const freshness = { markets: { cn: { active: true, expected: 2, succeeded: 1, failed: 1, lastSuccessAt: now } } };
  const health = evaluateQuoteHealth(freshness, { now, startedAt: now - 10 * 60 * 1000 });
  assert.equal(health.healthy, true);
});

test("health detects a stuck refresh", () => {
  const now = Date.now();
  const result = evaluateQuoteHealth({ markets: {} }, {
    now, startedAt: now - 10 * 60 * 1000, refreshInFlight: true, refreshStartedAt: now - 61 * 1000,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.stuckRefresh, true);
});

test("freshness thresholds expand outside market hours", () => {
  const active = new Date("2026-07-13T02:00:00Z");
  const weekend = new Date("2026-07-12T02:00:00Z");
  assert.equal(staleAfterMs("cn", active), 60 * 1000);
  assert.equal(staleAfterMs("cn", weekend), 15 * 60 * 1000);
  assert.equal(healthAfterMs("cn", active), 2 * 60 * 1000);
  assert.equal(healthAfterMs("cn", weekend), 50 * 60 * 1000);
});

test("shutting down is unhealthy even without quote failures", () => {
  const result = evaluateQuoteHealth({ markets: {} }, { shuttingDown: true });
  assert.equal(result.healthy, false);
});
