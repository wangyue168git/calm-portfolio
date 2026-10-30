"use strict";
// 根据环境变量组装要启用的券商同步(IB 由 server.js 单独创建, 保持旧配置不变)。
//   长桥: LONGBRIDGE_APP_KEY / LONGBRIDGE_APP_SECRET / LONGBRIDGE_ACCESS_TOKEN(见 docs/brokers/longbridge.md)
//   自定义: BROKER_ADAPTERS=./my-broker.js,./other.js —— 每个文件导出 create(env) 返回适配器(见 docs/brokers/custom.md)
const path = require("path");
const { createBrokerSync, parseExtras } = require("./core");
const { createLongbridgeAdapter } = require("./longbridge");

function buildBrokerSyncs({ env = process.env, dataDir, baseDir = process.cwd(), deps, log = console.log }) {
  const out = [];
  const make = (adapter, accountName) => createBrokerSync({
    adapter, accountName,
    stateFile: path.join(dataDir, `${adapter.id}-sync-state.json`),
    dryRun: env[`${adapter.id.toUpperCase()}_SYNC_DRYRUN`] === "1",
    extras: parseExtras(env[`${adapter.id.toUpperCase()}_SYNC_EXTRA`] || ""),
    ...deps, log,
  });

  if (env.LONGBRIDGE_APP_KEY || env.LONGBRIDGE_ACCESS_TOKEN) {
    const adapter = createLongbridgeAdapter({
      appKey: env.LONGBRIDGE_APP_KEY, appSecret: env.LONGBRIDGE_APP_SECRET, accessToken: env.LONGBRIDGE_ACCESS_TOKEN,
      tokenExpires: env.LONGBRIDGE_TOKEN_EXPIRES || "",
      accounts: { us: env.LONGBRIDGE_ACCOUNT_US || "", hk: env.LONGBRIDGE_ACCOUNT_HK || "", cn: env.LONGBRIDGE_ACCOUNT_CN || "" },
    });
    out.push(make(adapter, env.LONGBRIDGE_SYNC_ACCOUNT || "长桥"));
  }

  String(env.BROKER_ADAPTERS || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((file) => {
    try {
      const mod = require(path.resolve(baseDir, file));
      const adapter = typeof mod.create === "function" ? mod.create(env) : mod;
      if (!adapter || !/^[a-z][a-z0-9_-]{0,30}$/.test(adapter.id || "")) throw new Error("适配器缺少合法的 id(小写字母开头)");
      if (["ib", "longbridge"].includes(adapter.id)) throw new Error(`id「${adapter.id}」与内置券商重名`);
      out.push(make(adapter, adapter.accountName || env[`${adapter.id.toUpperCase()}_SYNC_ACCOUNT`] || adapter.label || adapter.id));
    } catch (e) { log(`[broker] 加载自定义适配器 ${file} 失败: ${e.message}`); }
  });
  return out;
}

module.exports = { buildBrokerSyncs };
