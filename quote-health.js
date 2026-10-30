"use strict";

const { basePollIntervalMs, marketSession } = require("./market-schedule");

function quoteKey(holding) {
  return `${holding.market}:${holding.symbol}`;
}

function canCommitGeneration(candidate, current, shuttingDown = false) {
  return !shuttingDown && candidate === current;
}

function staleAfterMs(group, date = new Date()) {
  const base = basePollIntervalMs(group, date);
  if (marketSession(group, date).active) return Math.max(60 * 1000, base * 5);
  return Math.max(15 * 60 * 1000, base * 3);
}

function healthAfterMs(group, date = new Date()) {
  const base = basePollIntervalMs(group, date);
  return Math.max(2 * 60 * 1000, base * 10);
}

function serializeFreshness(symbolStates, marketStates, now = Date.now()) {
  const symbols = {};
  for (const [key, state] of symbolStates) {
    const ageMs = state.lastSuccessAt ? Math.max(0, now - state.lastSuccessAt) : null;
    symbols[key] = {
      ...state,
      ageMs,
      stale: ageMs === null || ageMs > staleAfterMs(state.group, new Date(now)),
    };
  }
  const markets = {};
  for (const [group, state] of marketStates) {
    const ageMs = state.lastSuccessAt ? Math.max(0, now - state.lastSuccessAt) : null;
    markets[group] = {
      ...state,
      ageMs,
      active: marketSession(group, new Date(now)).active,
      stale: state.failed > 0 || ageMs === null || ageMs > staleAfterMs(group, new Date(now)),
    };
  }
  return { updatedAt: new Date(now).toISOString(), markets, symbols };
}

function evaluateQuoteHealth(freshness, { now = Date.now(), startedAt = now, refreshInFlight = false,
  refreshStartedAt = 0, shuttingDown = false } = {}) {
  const startupGrace = now - startedAt < 90 * 1000;
  const stuckRefresh = refreshInFlight && refreshStartedAt > 0 && now - refreshStartedAt > 60 * 1000;
  const unhealthyMarkets = [];
  for (const [group, state] of Object.entries(freshness.markets || {})) {
    if (!state.active || state.expected === 0) continue;
    const ageMs = state.lastSuccessAt ? now - state.lastSuccessAt : Infinity;
    // 单个标的失败属于 degraded，由 freshness 明确展示；仅整个活跃市场长期无任何成功行情才返回 503。
    if (!startupGrace && state.succeeded === 0 && ageMs > healthAfterMs(group, new Date(now))) unhealthyMarkets.push(group);
  }
  const healthy = !shuttingDown && !stuckRefresh && unhealthyMarkets.length === 0;
  return { healthy, startupGrace, stuckRefresh, unhealthyMarkets };
}

module.exports = { canCommitGeneration, evaluateQuoteHealth, healthAfterMs, quoteKey, serializeFreshness, staleAfterMs };
