"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  basePollIntervalMs,
  marketGroupForHolding,
  marketSession,
  pollDelayMs,
  zonedClock,
} = require("../market-schedule");

test("holding markets map to independent scheduler groups", () => {
  assert.equal(marketGroupForHolding({ market: "sh" }), "cn");
  assert.equal(marketGroupForHolding({ market: "hk" }), "hk");
  assert.equal(marketGroupForHolding({ market: "nasdaq" }), "us");
  assert.equal(marketGroupForHolding({ market: "crypto" }), "crypto");
  assert.equal(marketGroupForHolding({ market: "fund" }), "fund");
  assert.equal(marketGroupForHolding({ market: "unknown" }), "other");
  assert.equal(marketGroupForHolding(null), "other");
});

test("fund and other groups use low-frequency schedules", () => {
  const fundWindow = new Date("2026-07-13T11:00:00Z"); // 19:00 CST
  const weekend = new Date("2026-07-12T02:00:00Z");
  assert.equal(marketSession("fund", fundWindow).active, true);
  assert.equal(marketSession("other", fundWindow).active, false);
  assert.equal(basePollIntervalMs("fund", fundWindow), 30 * 60 * 1000);
  assert.equal(basePollIntervalMs("fund", weekend), 4 * 60 * 60 * 1000);
  assert.equal(basePollIntervalMs("other", weekend), 30 * 60 * 1000);
  assert.equal(pollDelayMs("fund", weekend, 8), 12 * 60 * 60 * 1000);
});

test("zoned clocks return local weekday and minute", () => {
  assert.deepEqual(zonedClock(new Date("2026-07-13T02:30:00Z"), "Asia/Shanghai"), {
    weekday: "Mon",
    minuteOfDay: 10 * 60 + 30,
  });
});

test("China and Hong Kong sessions respect lunch breaks", () => {
  assert.equal(marketSession("cn", new Date("2026-07-13T02:00:00Z")).active, true); // 周一 10:00 CST
  assert.equal(marketSession("cn", new Date("2026-07-13T04:00:00Z")).active, false); // 12:00 lunch
  assert.equal(marketSession("hk", new Date("2026-07-13T06:00:00Z")).active, true); // 14:00 CST
});

test("US session follows New York time across daylight saving", () => {
  assert.equal(marketSession("us", new Date("2026-07-13T14:00:00Z")).active, true); // 10:00 EDT
  assert.equal(marketSession("us", new Date("2026-01-12T15:00:00Z")).active, true); // 10:00 EST
  assert.equal(marketSession("us", new Date("2026-07-12T14:00:00Z")).active, false); // Sunday
});

test("closed markets slow down while crypto stays live", () => {
  const weekend = new Date("2026-07-12T02:00:00Z");
  assert.equal(basePollIntervalMs("cn", weekend), 5 * 60 * 1000);
  assert.equal(basePollIntervalMs("crypto", weekend), 12 * 1000);
});

test("failures back off independently with an active-session cap", () => {
  const active = new Date("2026-07-13T02:00:00Z");
  assert.equal(pollDelayMs("cn", active, 0), 12 * 1000);
  assert.equal(pollDelayMs("cn", active, 2), 48 * 1000);
  assert.equal(pollDelayMs("cn", active, 8), 2 * 60 * 1000);
});
