"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  classifyAllocationBucket,
  classifyLookThroughBucket,
  deriveCategory,
  sampleByTime,
  tradingDaySnapshots,
} = require("../classify");

test("allocation classification covers symbol, name, crypto and unknown assets", () => {
  assert.equal(classifyAllocationBucket({ symbol: "qqq", market: "nasdaq" }), "纳指指数类");
  assert.equal(classifyAllocationBucket({ symbol: "X", name: "NASDAQ 100" }), "纳指指数类");
  assert.equal(classifyAllocationBucket({ symbol: "SPY", market: "nyse" }), "标普");
  assert.equal(classifyAllocationBucket({ symbol: "BTC", market: "crypto" }), "加密资产");
  assert.equal(classifyAllocationBucket({ symbol: "BABA", market: "nyse" }), null);
});

test("look-through classification assigns every supported asset class", () => {
  assert.equal(classifyLookThroughBucket({ __isCash: true }), "现金");
  assert.equal(classifyLookThroughBucket({ symbol: "ETH", market: "crypto" }), "加密资产");
  assert.equal(classifyLookThroughBucket({ symbol: "VUG", market: "nyse" }), "纳指/成长");
  assert.equal(classifyLookThroughBucket({ symbol: "VTI", market: "nyse" }), "标普宽基");
  assert.equal(classifyLookThroughBucket({ symbol: "TSLA", market: "nasdaq" }), "美股个股");
  assert.equal(classifyLookThroughBucket({ symbol: "600000", market: "sh" }), "中国/港股资产");
  assert.equal(classifyLookThroughBucket({ symbol: "X", market: "fund" }), "其他");
});

test("category derivation preserves explicit values and recognizes index funds", () => {
  assert.equal(deriveCategory({ symbol: "X", category: "自定义" }), "自定义");
  assert.equal(deriveCategory({ symbol: "021000" }), "指数");
  assert.equal(deriveCategory({ symbol: "X" }), null);
});

test("time sampling keeps bucket closes and handles degenerate timelines", () => {
  const points = Array.from({ length: 10 }, (_, i) => ({ t: new Date(i * 1000).toISOString(), v: i }));
  const sampled = sampleByTime(points, 3);
  assert.ok(sampled.length <= 3);
  assert.equal(sampled.at(-1).v, 9);
  assert.equal(sampleByTime(points, 20), points);
  const sameTime = points.map((p) => ({ ...p, t: points[0].t }));
  assert.deepEqual(sampleByTime(sameTime, 3), sameTime.slice(-3));
});

test("trading day snapshots keep the US Friday close and omit the remaining Beijing weekend", () => {
  const points = [
    { t: "2026-08-07T01:00:00.000Z", v: 1 }, // Friday morning in Beijing
    { t: "2026-08-07T12:00:00.000Z", v: 2 }, // Friday evening in Beijing
    { t: "2026-08-07T23:59:00.000Z", v: 3 }, // Saturday Beijing, Friday 19:59 in New York
    { t: "2026-08-08T00:30:00.000Z", v: 4 }, // After the New York extended session
    { t: "2026-08-08T04:00:00.000Z", v: 5 }, // Saturday in both Beijing and New York
    { t: "2026-08-10T01:00:00.000Z", v: 6 }, // Monday morning in Beijing
    { t: "2026-08-10T12:00:00.000Z", v: 7 }, // Monday evening in Beijing
  ];
  assert.deepEqual(tradingDaySnapshots(points).map((p) => p.v), [3, 7]);
});
