"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateChannel } = require("../classify");

const cfg = {
  labels: { open: "可加", seal: "封仓" }, default: "seal",
  offshoreTargetCNY: 300000, offshoreRestartCNY: 250000, stockBucketCapPct: 40,
  symbols: {
    QQQM: { type: "open", why: "指数定投候选" },
    VOO: { type: "offshore", why: "示例" },
    MSFT: { type: "band", openBelowPct: 10, sealAtPct: 10, why: "10% 以下可加；到 10% 封" },
    NVDA: { type: "band", openBelowPct: 8, sealAtPct: 10, why: "8% 以下可加；回到 10% 封" },
    "513650": { type: "premium", maxPremiumPct: 3, why: "溢价 ≤3% 可加" },
    XYZ: { type: "seal", why: "示例：恒封" },
  },
};
const mem = () => { const m = new Map(); return { get: (k) => m.has(k) ? m.get(k) : null, set: (k, v) => m.set(k, v) }; };

test("open / seal / default", () => {
  assert.equal(evaluateChannel(cfg, "QQQM", {}).st, "open");
  assert.equal(evaluateChannel(cfg, "XYZ", {}).st, "seal");
  const r = evaluateChannel(cfg, "UNKNOWN", {});
  assert.equal(r.st, "seal"); assert.equal(r.label, "封仓"); assert.match(r.why, /未列入/);
});

test("band: MSFT pure threshold 10/10", () => {
  assert.equal(evaluateChannel(cfg, "MSFT", { weightPct: 8.7, stockPct: 30 }).st, "open");
  assert.equal(evaluateChannel(cfg, "MSFT", { weightPct: 10.0, stockPct: 30 }).st, "seal");
  assert.equal(evaluateChannel(cfg, "MSFT", { weightPct: 9.9, stockPct: 30 }).st, "open");
  // 个股桶满 → 一律封
  const r = evaluateChannel(cfg, "MSFT", { weightPct: 5, stockPct: 40 });
  assert.equal(r.st, "seal"); assert.match(r.why, /个股合计 40.0% ≥ 40%/);
});

test("band: NVDA hysteresis 8 open / 10 seal, keeps last in between", () => {
  const st = mem();
  assert.equal(evaluateChannel(cfg, "NVDA", { weightPct: 11, stockPct: 30 }, st).st, "seal");
  assert.match(evaluateChannel(cfg, "NVDA", { weightPct: 11, stockPct: 30 }, st).why, /未到 8%/);
  assert.equal(evaluateChannel(cfg, "NVDA", { weightPct: 9.0, stockPct: 30 }, st).st, "seal");    // 从上面掉进迟滞区: 保持封
  assert.equal(evaluateChannel(cfg, "NVDA", { weightPct: 7.9, stockPct: 30 }, st).st, "open");
  const mid = evaluateChannel(cfg, "NVDA", { weightPct: 9.2, stockPct: 30 }, st);
  assert.equal(mid.st, "open"); assert.match(mid.why, /在 8–10% 之间，保持可加/);
  assert.equal(evaluateChannel(cfg, "NVDA", { weightPct: 10.0, stockPct: 30 }, st).st, "seal");
  // 无历史、无 hystInitial 时迟滞区默认封
  assert.equal(evaluateChannel(cfg, "NVDA", { weightPct: 9.0, stockPct: 30 }, mem()).st, "seal");
});

test("offshore: target / restart hysteresis", () => {
  const st = mem();
  assert.equal(evaluateChannel(cfg, "VOO", { offshoreCNY: 120000 }, st).st, "open");
  assert.equal(evaluateChannel(cfg, "VOO", { offshoreCNY: 310000 }, st).st, "seal");
  assert.equal(evaluateChannel(cfg, "VOO", { offshoreCNY: 280000 }, st).st, "seal");   // 目标↔重启线之间保持上次(封)
  assert.equal(evaluateChannel(cfg, "VOO", { offshoreCNY: 240000 }, st).st, "open");
  assert.match(evaluateChannel(cfg, "VOO", { offshoreCNY: 120000 }, st).why, /境外托管 ¥12万 \/ ¥30万/);
});

test("premium: price vs IOPV, missing IOPV seals and flags needsIopv", () => {
  const miss = evaluateChannel(cfg, "513650", { price: 2.1 });
  assert.equal(miss.st, "seal"); assert.equal(miss.needsIopv, true); assert.match(miss.why, /取不到/);
  const hi = evaluateChannel(cfg, "513650", { price: 2.1, iopv: 2.0, iopvTime: "10:30" });
  assert.equal(hi.st, "seal"); assert.equal(hi.needsIopv, false); assert.match(hi.why, /溢价 5.0% > 3%/); assert.match(hi.why, /10:30/);
  const lo = evaluateChannel(cfg, "513650", { price: 2.05, iopv: 2.0 });
  assert.equal(lo.st, "open"); assert.match(lo.why, /溢价 2.5% ≤ 3%/);
});

test("offshore: USD target / restart", () => {
  const ucfg = { ...cfg, offshoreTargetCNY: undefined, offshoreRestartCNY: undefined, offshoreTargetUSD: 60000, offshoreRestartUSD: 50000 };
  const st = mem(), fx = 7;
  assert.equal(evaluateChannel(ucfg, "VOO", { offshoreCNY: 210000, usdCny: fx }, st).st, "open");   // $30k
  assert.equal(evaluateChannel(ucfg, "VOO", { offshoreCNY: 420000, usdCny: fx }, st).st, "seal");   // $60k
  assert.equal(evaluateChannel(ucfg, "VOO", { offshoreCNY: 385000, usdCny: fx }, st).st, "seal");   // $55k 迟滞区保持封
  assert.equal(evaluateChannel(ucfg, "VOO", { offshoreCNY: 343000, usdCny: fx }, st).st, "open");   // $49k < $50k
  assert.match(evaluateChannel(ucfg, "VOO", { offshoreCNY: 210000, usdCny: fx }, st).why, /境外托管 \$3万 \/ \$6万/);
  assert.equal(evaluateChannel(ucfg, "VOO", { offshoreCNY: 999999 }, mem()).st, "open");          // 无汇率且无历史: 不误封
});

test("股数目标: 买够即封仓(即使占比低于闸门); 没买够按占比闸门; why 带进度", () => {
  const cfg = { stockBucketCapPct: 40, symbols: { MSFT: { type: "band", openBelowPct: 10, sealAtPct: 10, targetShares: 40 } } };
  let r = evaluateChannel(cfg, "MSFT", { weightPct: 6, stockPct: 30, shares: 33 });
  assert.equal(r.st, "open"); assert.match(r.why, /33\/40 股，还差 7 股/);
  r = evaluateChannel(cfg, "MSFT", { weightPct: 9, stockPct: 30, shares: 40 });
  assert.equal(r.st, "seal"); assert.match(r.why, /已买够 40\/40 股/);
  r = evaluateChannel(cfg, "MSFT", { weightPct: 10.5, stockPct: 30, shares: 35 });
  assert.equal(r.st, "seal");                                                     // 没买够但超上限 → 封
  r = evaluateChannel(cfg, "MSFT", { weightPct: 6, stockPct: 30 });               // 不传股数 → 只看占比
  assert.equal(r.st, "open");
});
